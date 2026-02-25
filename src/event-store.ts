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
// Types -- store events (the immutable log entries)
// ---------------------------------------------------------------------------

export type StoreEventType =
  // schedule lifecycle
  | "schedule.created"
  | "schedule.cancelled"
  | "schedule.executed"
  | "schedule.failed"
  | "schedule.expired"
  // project event bus
  | "bus.emitted"

export interface StoreEvent {
  id: string
  type: StoreEventType
  timestamp: string
  payload: Record<string, unknown>
}

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
  async append(
    event: Omit<StoreEvent, "id" | "timestamp">,
  ): Promise<StoreEvent> {
    await this.init()
    const full: StoreEvent = {
      id: generateId("evt"),
      timestamp: new Date().toISOString(),
      ...event,
    }
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
      const sid = evt.payload.scheduleId as string | undefined
      if (!sid) continue

      switch (evt.type) {
        case "schedule.created": {
          const triggerRaw = evt.payload.trigger as Trigger
          map.set(sid, {
            scheduleId: sid,
            sessionId: evt.payload.sessionId as string,
            command: evt.payload.command as string,
            arguments: (evt.payload.arguments as string) ?? "",
            trigger: triggerRaw,
            status: "pending",
            reason: (evt.payload.reason as string) ?? undefined,
            createdAt: evt.timestamp,
          })
          break
        }
        case "schedule.cancelled":
          if (map.has(sid)) map.get(sid)!.status = "cancelled"
          break
        case "schedule.executed":
          if (map.has(sid)) map.get(sid)!.status = "executed"
          break
        case "schedule.failed":
          if (map.has(sid)) map.get(sid)!.status = "failed"
          break
        case "schedule.expired":
          if (map.has(sid)) map.get(sid)!.status = "expired"
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
    return events
      .filter((e) => e.type === "bus.emitted")
      .map((e) => ({
        eventId: e.id,
        kind: e.payload.kind as string,
        message: e.payload.message as string,
        sessionId: e.payload.sessionId as string,
        timestamp: e.timestamp,
      }))
  }

  /** Find pending event-triggered schedules that match a given bus event kind. */
  async matchingSchedules(kind: string): Promise<ScheduleEntry[]> {
    const pending = await this.pending("event")
    return pending.filter(
      (e) => e.trigger.type === "event" && e.trigger.eventKind === kind,
    )
  }
}
