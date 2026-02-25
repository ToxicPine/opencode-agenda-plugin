/**
 * Append-only event store backed by a JSONL file.
 *
 * Every mutation to the schedule is recorded as an immutable event.
 * The current schedule state is always derivable by replaying from the start.
 */

import { appendFile, readFile, mkdir } from "fs/promises"
import { randomUUID } from "crypto"
import path from "path"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type EventType =
  | "command.scheduled"
  | "command.cancelled"
  | "command.executed"
  | "command.failed"
  | "command.rescheduled"

export interface SchedulerEvent {
  id: string
  type: EventType
  timestamp: string
  payload: Record<string, unknown>
}

export type ScheduleStatus = "pending" | "executed" | "cancelled" | "failed"

export interface ScheduleEntry {
  scheduleId: string
  sessionId: string
  command: string
  arguments: string
  executeAt: string
  status: ScheduleStatus
  reason?: string
  createdAt: string
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
    event: Omit<SchedulerEvent, "id" | "timestamp">,
  ): Promise<SchedulerEvent> {
    await this.init()
    const full: SchedulerEvent = {
      id: generateId("evt"),
      timestamp: new Date().toISOString(),
      ...event,
    }
    await appendFile(this.eventsPath, JSON.stringify(full) + "\n")
    return full
  }

  /** Read every event from the log. */
  async readAll(): Promise<SchedulerEvent[]> {
    try {
      const content = await readFile(this.eventsPath, "utf-8")
      return content
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as SchedulerEvent)
    } catch {
      return []
    }
  }

  /** Replay events into the current materialized schedule. */
  async materialize(): Promise<ScheduleEntry[]> {
    const events = await this.readAll()
    const map = new Map<string, ScheduleEntry>()

    for (const evt of events) {
      const sid = evt.payload.scheduleId as string
      switch (evt.type) {
        case "command.scheduled":
          map.set(sid, {
            scheduleId: sid,
            sessionId: evt.payload.sessionId as string,
            command: evt.payload.command as string,
            arguments: (evt.payload.arguments as string) ?? "",
            executeAt: evt.payload.executeAt as string,
            status: "pending",
            reason: (evt.payload.reason as string) ?? undefined,
            createdAt: evt.timestamp,
          })
          break
        case "command.cancelled":
          if (map.has(sid)) map.get(sid)!.status = "cancelled"
          break
        case "command.executed":
          if (map.has(sid)) map.get(sid)!.status = "executed"
          break
        case "command.failed":
          if (map.has(sid)) map.get(sid)!.status = "failed"
          break
        case "command.rescheduled":
          if (map.has(sid))
            map.get(sid)!.executeAt = evt.payload.executeAt as string
          break
      }
    }
    return [...map.values()]
  }

  /** Return only entries that are still pending. */
  async pending(): Promise<ScheduleEntry[]> {
    const all = await this.materialize()
    return all.filter((e) => e.status === "pending")
  }
}
