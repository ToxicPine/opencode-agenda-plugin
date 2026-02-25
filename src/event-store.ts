/**
 * Append-only event store backed by a JSONL file.
 *
 * Project-scoped: one event log per project directory. All sessions within
 * the project share the same schedule and event bus.
 *
 * Supports two trigger types:
 *   - "time"  : fires when a wall-clock time is reached
 *   - "event" : fires when a matching project event is emitted
 *
 * Event-triggered schedules can optionally expire.
 */

import { appendFile, readFile, mkdir } from "fs/promises"
import { randomUUID } from "crypto"
import path from "path"

// ---------------------------------------------------------------------------
// Types -- trigger
// ---------------------------------------------------------------------------

/** Time-based trigger: fires when wall clock >= executeAt. */
export interface TimeTrigger {
  type: "time"
  executeAt: string // ISO 8601
}

/** Event-based trigger: fires when a project bus event with matching kind
 *  is emitted. Optional expiresAt after which the schedule auto-expires. */
export interface EventTrigger {
  type: "event"
  eventKind: string // matched against bus.emitted events
  expiresAt?: string // ISO 8601, optional
}

export type Trigger = TimeTrigger | EventTrigger

// ---------------------------------------------------------------------------
// Types -- store events (discriminated union with typed payloads)
// ---------------------------------------------------------------------------

interface ScheduleCreatedEvent {
  id: string
  type: "schedule.created"
  timestamp: string
  payload: {
    scheduleId: string
    sessionId: string
    command: string
    arguments: string
    trigger: Trigger
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

/** Input type for append(): id and timestamp are generated automatically. */
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
  /** Session to execute the command in. "new" means create a new session. */
  sessionId: string
  command: string
  arguments: string
  trigger: Trigger
  status: ScheduleStatus
  reason?: string
  createdAt: string
}

// ---------------------------------------------------------------------------
// Types -- project bus event (materialized from bus.emitted)
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

  /** Ensure the parent directory exists. */
  async init(): Promise<void> {
    await mkdir(path.dirname(this.eventsPath), { recursive: true })
  }

  /** Append a single event to the log. */
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

  /** Read every event from the log. */
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
  // Materialization -- schedule entries
  // -----------------------------------------------------------------------

  /** Replay events into the current materialized schedule. */
  async materialize(): Promise<ScheduleEntry[]> {
    const events = await this.readAll()
    const map = new Map<string, ScheduleEntry>()

    for (const evt of events) {
      switch (evt.type) {
        case "schedule.created":
          map.set(evt.payload.scheduleId, {
            scheduleId: evt.payload.scheduleId,
            sessionId: evt.payload.sessionId,
            command: evt.payload.command,
            arguments: evt.payload.arguments,
            trigger: evt.payload.trigger,
            status: "pending",
            reason: evt.payload.reason || undefined,
            createdAt: evt.timestamp,
          })
          break
        case "schedule.cancelled": {
          const entry = map.get(evt.payload.scheduleId)
          if (entry) entry.status = "cancelled"
          break
        }
        case "schedule.executed": {
          const entry = map.get(evt.payload.scheduleId)
          if (entry) entry.status = "executed"
          break
        }
        case "schedule.failed": {
          const entry = map.get(evt.payload.scheduleId)
          if (entry) entry.status = "failed"
          break
        }
        case "schedule.expired": {
          const entry = map.get(evt.payload.scheduleId)
          if (entry) entry.status = "expired"
          break
        }
        case "bus.emitted":
          // Bus events don't affect schedule materialization
          break
      }
    }
    return [...map.values()]
  }

  /** Return entries that are still pending, optionally filtered by trigger type. */
  async pending(byType?: Trigger["type"]): Promise<ScheduleEntry[]> {
    const all = await this.materialize()
    const p = all.filter((e) => e.status === "pending")
    if (byType) return p.filter((e) => e.trigger.type === byType)
    return p
  }

  // -----------------------------------------------------------------------
  // Materialization -- bus events
  // -----------------------------------------------------------------------

  /** Replay all bus.emitted events into a list. */
  async busEvents(): Promise<BusEvent[]> {
    const events = await this.readAll()
    const busEvents: BusEvent[] = []
    for (const e of events) {
      if (e.type === "bus.emitted") {
        busEvents.push({
          eventId: e.payload.eventId,
          kind: e.payload.kind,
          message: e.payload.message,
          sessionId: e.payload.sessionId,
          timestamp: e.timestamp,
        })
      }
    }
    return busEvents
  }

  /** Find pending event-triggered schedules that match a given bus event kind. */
  async matchingSchedules(kind: string): Promise<ScheduleEntry[]> {
    const pending = await this.pending("event")
    return pending.filter(
      (e) => e.trigger.type === "event" && e.trigger.eventKind === kind,
    )
  }
}
