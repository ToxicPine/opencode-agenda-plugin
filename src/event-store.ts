/**
 * Append-only event store backed by a JSONL file.
 *
 * Project-scoped: one event log per project directory. All sessions
 * share the same schedule and event bus.
 *
 * Triggers:
 *   - "time"  : fires at a wall-clock time
 *   - "event" : fires on matching bus event(s), with any/all convergence
 *
 * Actions:
 *   - "command"  : invoke a slash command in a session
 *   - "emit"     : emit a bus event (zero LLM cost)
 *   - "cancel"   : cancel another pending schedule (zero LLM cost)
 *   - "schedule" : create a new schedule (zero LLM cost)
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
  /** Single kind or array of kinds. */
  eventKind: string | string[]
  /** "any" fires on first match; "all" waits for every kind. Default "any". */
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

interface ScheduleCreatedEvent {
  id: string
  type: "schedule.created"
  timestamp: string
  payload: {
    scheduleId: string
    trigger: Trigger
    action: Action
    reason: string
    createdBy: string
  }
}

interface ScheduleCancelledEvent {
  id: string
  type: "schedule.cancelled"
  timestamp: string
  payload: {
    scheduleId: string
    reason: string
  }
}

interface ScheduleExecutedEvent {
  id: string
  type: "schedule.executed"
  timestamp: string
  payload: {
    scheduleId: string
    result: string
    triggeredByEvent?: string
    actualSessionId?: string
  }
}

interface ScheduleFailedEvent {
  id: string
  type: "schedule.failed"
  timestamp: string
  payload: {
    scheduleId: string
    error: string
    triggeredByEvent?: string
  }
}

interface ScheduleExpiredEvent {
  id: string
  type: "schedule.expired"
  timestamp: string
  payload: {
    scheduleId: string
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
  | ScheduleCreatedEvent
  | ScheduleCancelledEvent
  | ScheduleExecutedEvent
  | ScheduleFailedEvent
  | ScheduleExpiredEvent
  | BusEmittedEvent

export type StoreEventType = StoreEvent["type"]

export type StoreEventInput =
  | Omit<ScheduleCreatedEvent, "id" | "timestamp">
  | Omit<ScheduleCancelledEvent, "id" | "timestamp">
  | Omit<ScheduleExecutedEvent, "id" | "timestamp">
  | Omit<ScheduleFailedEvent, "id" | "timestamp">
  | Omit<ScheduleExpiredEvent, "id" | "timestamp">
  | Omit<BusEmittedEvent, "id" | "timestamp">

// ---------------------------------------------------------------------------
// Types -- materialized schedule entry
// ---------------------------------------------------------------------------

export type ScheduleStatus =
  | "pending"
  | "executed"
  | "cancelled"
  | "failed"
  | "expired"

export interface ScheduleEntry {
  scheduleId: string
  trigger: Trigger
  action: Action
  status: ScheduleStatus
  reason?: string
  createdAt: string
}

// ---------------------------------------------------------------------------
// Types -- materialized bus event
// ---------------------------------------------------------------------------

export interface BusEvent {
  eventId: string
  kind: string
  message: string
  sessionId: string
  timestamp: string
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function generateId(prefix: string): string {
  return `${prefix}_${randomUUID().slice(0, 8)}`
}

/** Normalize eventKind to always be an array. */
function normalizeKinds(trigger: EventTrigger): string[] {
  return Array.isArray(trigger.eventKind)
    ? trigger.eventKind
    : [trigger.eventKind]
}

// ---------------------------------------------------------------------------
// Event store
// ---------------------------------------------------------------------------

export class EventStore {
  private eventsPath: string

  constructor(projectRoot: string) {
    this.eventsPath = path.join(
      projectRoot,
      ".opencode",
      "scheduler",
      "events.jsonl",
    )
  }

  async init(): Promise<void> {
    await mkdir(path.dirname(this.eventsPath), { recursive: true })
  }

  async append(event: StoreEventInput): Promise<StoreEvent> {
    await this.init()
    const full = {
      id: generateId("evt"),
      timestamp: new Date().toISOString(),
      ...event,
    } as StoreEvent
    await appendFile(this.eventsPath, JSON.stringify(full) + "\n")
    return full
  }

  async readAll(): Promise<StoreEvent[]> {
    try {
      const content = await readFile(this.eventsPath, "utf-8")
      return content
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as StoreEvent)
    } catch {
      return []
    }
  }

  // -----------------------------------------------------------------------
  // Materialization -- schedules
  // -----------------------------------------------------------------------

  async materialize(): Promise<ScheduleEntry[]> {
    const events = await this.readAll()
    const map = new Map<string, ScheduleEntry>()

    for (const evt of events) {
      switch (evt.type) {
        case "schedule.created":
          map.set(evt.payload.scheduleId, {
            scheduleId: evt.payload.scheduleId,
            trigger: evt.payload.trigger,
            action: evt.payload.action,
            status: "pending",
            reason: evt.payload.reason || undefined,
            createdAt: evt.timestamp,
          })
          break
        case "schedule.cancelled": {
          const e = map.get(evt.payload.scheduleId)
          if (e) e.status = "cancelled"
          break
        }
        case "schedule.executed": {
          const e = map.get(evt.payload.scheduleId)
          if (e) e.status = "executed"
          break
        }
        case "schedule.failed": {
          const e = map.get(evt.payload.scheduleId)
          if (e) e.status = "failed"
          break
        }
        case "schedule.expired": {
          const e = map.get(evt.payload.scheduleId)
          if (e) e.status = "expired"
          break
        }
        case "bus.emitted":
          break
      }
    }
    return [...map.values()]
  }

  async pending(byType?: Trigger["type"]): Promise<ScheduleEntry[]> {
    const all = await this.materialize()
    const p = all.filter((e) => e.status === "pending")
    if (byType) return p.filter((e) => e.trigger.type === byType)
    return p
  }

  // -----------------------------------------------------------------------
  // Materialization -- bus events
  // -----------------------------------------------------------------------

  async busEvents(): Promise<BusEvent[]> {
    const events = await this.readAll()
    const out: BusEvent[] = []
    for (const e of events) {
      if (e.type === "bus.emitted") {
        out.push({
          eventId: e.payload.eventId,
          kind: e.payload.kind,
          message: e.payload.message,
          sessionId: e.payload.sessionId,
          timestamp: e.timestamp,
        })
      }
    }
    return out
  }

  // -----------------------------------------------------------------------
  // Event matching
  // -----------------------------------------------------------------------

  /**
   * Find pending event-triggered schedules that should fire given
   * a newly emitted event kind.
   *
   * - "any" mode: fires if the new kind matches any required kind.
   * - "all" mode: fires only if every required kind has been emitted
   *   at least once since the schedule was created.
   */
  async matchingSchedules(newKind: string): Promise<ScheduleEntry[]> {
    const pending = await this.pending("event")
    const busHistory = await this.busEvents()
    const matched: ScheduleEntry[] = []

    for (const entry of pending) {
      if (entry.trigger.type !== "event") continue
      const kinds = normalizeKinds(entry.trigger)
      const mode = entry.trigger.matchMode ?? "any"

      if (mode === "any") {
        if (kinds.includes(newKind)) matched.push(entry)
      } else {
        // "all" mode: check that every required kind has a bus event
        // with timestamp >= schedule createdAt
        if (!kinds.includes(newKind)) continue
        const allSatisfied = kinds.every((k) =>
          busHistory.some(
            (b) => b.kind === k && b.timestamp >= entry.createdAt,
          ),
        )
        if (allSatisfied) matched.push(entry)
      }
    }
    return matched
  }
}
