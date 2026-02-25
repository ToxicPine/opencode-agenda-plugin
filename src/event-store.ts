/**
 * Append-only event store backed by a JSONL file.
 *
 * Project-scoped: one event log per project directory. All sessions
 * share the same agenda and event bus.
 *
 * The store maintains an in-memory cache of all events and materialized
 * state. Disk is read once at init; subsequent appends update both disk
 * and cache. This avoids full-file replay on every poll tick.
 */

import { appendFile, readFile, mkdir } from "fs/promises"
import { randomUUID } from "crypto"
import path from "path"

// ---------------------------------------------------------------------------
// Types -- trigger
// ---------------------------------------------------------------------------

export interface TimeTrigger {
  type: "time"
  executeAt: string
}

export interface EventTrigger {
  type: "event"
  eventKind: string | string[]
  matchMode?: "any" | "all"
  expiresAt?: string
}

export type Trigger = TimeTrigger | EventTrigger

// ---------------------------------------------------------------------------
// Types -- action
// ---------------------------------------------------------------------------

export interface CommandAction {
  type: "command"
  command: string
  arguments: string
  sessionId: string
}

export interface EmitAction {
  type: "emit"
  kind: string
  message: string
}

export interface CancelAction {
  type: "cancel"
  scheduleId: string
  reason: string
}

export interface ScheduleAction {
  type: "schedule"
  action: Action
  trigger: Trigger
  reason: string
}

export type Action = CommandAction | EmitAction | CancelAction | ScheduleAction

// ---------------------------------------------------------------------------
// Types -- store events (discriminated union)
// ---------------------------------------------------------------------------

interface AgendaCreatedEvent {
  id: string
  type: "agenda.created"
  timestamp: string
  payload: {
    agendaId: string
    trigger: Trigger
    action: Action
    reason: string
    createdBy: string
  }
}

interface AgendaCancelledEvent {
  id: string
  type: "agenda.cancelled"
  timestamp: string
  payload: {
    agendaId: string
    reason: string
  }
}

interface AgendaExecutedEvent {
  id: string
  type: "agenda.executed"
  timestamp: string
  payload: {
    agendaId: string
    result: string
    triggeredByEvent?: string
    actualSessionId?: string
  }
}

interface AgendaFailedEvent {
  id: string
  type: "agenda.failed"
  timestamp: string
  payload: {
    agendaId: string
    error: string
    triggeredByEvent?: string
  }
}

interface AgendaExpiredEvent {
  id: string
  type: "agenda.expired"
  timestamp: string
  payload: {
    agendaId: string
  }
}

interface BusEmittedEvent {
  id: string
  type: "bus.emitted"
  timestamp: string
  payload: {
    eventId: string
    kind: string
    message: string
    sessionId: string
  }
}

export type StoreEvent =
  | AgendaCreatedEvent
  | AgendaCancelledEvent
  | AgendaExecutedEvent
  | AgendaFailedEvent
  | AgendaExpiredEvent
  | BusEmittedEvent

export type StoreEventType = StoreEvent["type"]

export type StoreEventInput =
  | Omit<AgendaCreatedEvent, "id" | "timestamp">
  | Omit<AgendaCancelledEvent, "id" | "timestamp">
  | Omit<AgendaExecutedEvent, "id" | "timestamp">
  | Omit<AgendaFailedEvent, "id" | "timestamp">
  | Omit<AgendaExpiredEvent, "id" | "timestamp">
  | Omit<BusEmittedEvent, "id" | "timestamp">

// ---------------------------------------------------------------------------
// Types -- materialized
// ---------------------------------------------------------------------------

export type AgendaStatus =
  | "pending"
  | "executed"
  | "cancelled"
  | "failed"
  | "expired"

export interface AgendaEntry {
  agendaId: string
  trigger: Trigger
  action: Action
  status: AgendaStatus
  reason?: string
  createdAt: string
}

export interface BusEvent {
  eventId: string
  kind: string
  message: string
  sessionId: string
  timestamp: string
}

// ---------------------------------------------------------------------------
// Pure functions
// ---------------------------------------------------------------------------

export const generateId = (prefix: string): string =>
  `${prefix}_${randomUUID().slice(0, 8)}`

const normalizeKinds = (trigger: EventTrigger): string[] =>
  Array.isArray(trigger.eventKind)
    ? trigger.eventKind
    : [trigger.eventKind]

/** Apply a single event to mutable agenda + bus maps. */
const applyEvent = (
  agendaMap: Map<string, AgendaEntry>,
  busLog: BusEvent[],
  evt: StoreEvent,
): void => {
  switch (evt.type) {
    case "agenda.created":
      agendaMap.set(evt.payload.agendaId, {
        agendaId: evt.payload.agendaId,
        trigger: evt.payload.trigger,
        action: evt.payload.action,
        status: "pending",
        reason: evt.payload.reason || undefined,
        createdAt: evt.timestamp,
      })
      break
    case "agenda.cancelled": {
      const e = agendaMap.get(evt.payload.agendaId)
      if (e) e.status = "cancelled"
      break
    }
    case "agenda.executed": {
      const e = agendaMap.get(evt.payload.agendaId)
      if (e) e.status = "executed"
      break
    }
    case "agenda.failed": {
      const e = agendaMap.get(evt.payload.agendaId)
      if (e) e.status = "failed"
      break
    }
    case "agenda.expired": {
      const e = agendaMap.get(evt.payload.agendaId)
      if (e) e.status = "expired"
      break
    }
    case "bus.emitted":
      busLog.push({
        eventId: evt.payload.eventId,
        kind: evt.payload.kind,
        message: evt.payload.message,
        sessionId: evt.payload.sessionId,
        timestamp: evt.timestamp,
      })
      break
  }
}

/** Find pending event-triggered entries that match a newly emitted kind. */
export const findMatchingEntries = (
  pending: AgendaEntry[],
  busHistory: BusEvent[],
  newKind: string,
): AgendaEntry[] =>
  pending.filter((entry) => {
    if (entry.trigger.type !== "event") return false
    const kinds = normalizeKinds(entry.trigger)
    const mode = entry.trigger.matchMode ?? "any"

    if (mode === "any") return kinds.includes(newKind)

    // "all": every required kind must have a bus event >= createdAt
    if (!kinds.includes(newKind)) return false
    return kinds.every((k) =>
      busHistory.some((b) => b.kind === k && b.timestamp >= entry.createdAt),
    )
  })

// ---------------------------------------------------------------------------
// Event store (stateful, in-memory cached)
// ---------------------------------------------------------------------------

export class EventStore {
  private readonly eventsPath: string
  private readonly agendaMap = new Map<string, AgendaEntry>()
  private readonly busLog: BusEvent[] = []
  private initialized = false

  constructor(projectRoot: string) {
    this.eventsPath = path.join(
      projectRoot,
      ".opencode",
      "agenda",
      "events.jsonl",
    )
  }

  async init(): Promise<void> {
    if (this.initialized) return
    await mkdir(path.dirname(this.eventsPath), { recursive: true })
    try {
      const content = await readFile(this.eventsPath, "utf-8")
      const events = content
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as StoreEvent)
      for (const evt of events) {
        applyEvent(this.agendaMap, this.busLog, evt)
      }
    } catch {
      // File doesn't exist yet — start empty
    }
    this.initialized = true
  }

  async append(event: StoreEventInput): Promise<StoreEvent> {
    const full = {
      id: generateId("evt"),
      timestamp: new Date().toISOString(),
      ...event,
    } as StoreEvent
    await appendFile(this.eventsPath, JSON.stringify(full) + "\n")
    applyEvent(this.agendaMap, this.busLog, full)
    return full
  }

  entries(): AgendaEntry[] {
    return [...this.agendaMap.values()]
  }

  pending(byType?: Trigger["type"]): AgendaEntry[] {
    const p = this.entries().filter((e) => e.status === "pending")
    return byType ? p.filter((e) => e.trigger.type === byType) : p
  }

  busEvents(): BusEvent[] {
    return [...this.busLog]
  }

  matchingEntries(newKind: string): AgendaEntry[] {
    return findMatchingEntries(this.pending("event"), this.busLog, newKind)
  }
}
