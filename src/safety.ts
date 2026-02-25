/**
 * Safety rails for the scheduler.
 *
 * Prevents runaway self-scheduling, doom loops, and unbounded cost.
 */

import type { EventStore, ScheduleEntry, SchedulerEvent } from "./event-store.js"

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface SafetyConfig {
  /** Max pending commands per session (default 10). */
  maxPendingPerSession: number
  /** Max pending commands globally (default 30). */
  maxPendingGlobal: number
  /** Minimum seconds between any two scheduled execution times (default 60). */
  minIntervalSeconds: number
  /** If the same command+args has been scheduled this many times in the
   *  trailing window without a successful execution, block it (default 4). */
  doomLoopThreshold: number
  /** Trailing window in ms for doom loop detection (default 1 hour). */
  doomLoopWindowMs: number
  /** When true, the scheduler daemon will not fire any commands. */
  paused: boolean
}

export const DEFAULT_SAFETY: SafetyConfig = {
  maxPendingPerSession: 10,
  maxPendingGlobal: 30,
  minIntervalSeconds: 60,
  doomLoopThreshold: 4,
  doomLoopWindowMs: 60 * 60 * 1000,
  paused: false,
}

// ---------------------------------------------------------------------------
// Violation type
// ---------------------------------------------------------------------------

export interface SafetyViolation {
  rule: string
  message: string
}

// ---------------------------------------------------------------------------
// Checks – run before accepting a "command.scheduled" event
// ---------------------------------------------------------------------------

export async function validateSchedule(
  store: EventStore,
  sessionId: string,
  command: string,
  args: string,
  executeAt: string,
  config: SafetyConfig = DEFAULT_SAFETY,
): Promise<SafetyViolation | null> {
  const pending = await store.pending()

  // 1. Global cap
  if (pending.length >= config.maxPendingGlobal) {
    return {
      rule: "max_pending_global",
      message: `Global pending limit reached (${config.maxPendingGlobal}). Cancel existing schedules first.`,
    }
  }

  // 2. Per-session cap
  const sessionPending = pending.filter((e) => e.sessionId === sessionId)
  if (sessionPending.length >= config.maxPendingPerSession) {
    return {
      rule: "max_pending_session",
      message: `Session pending limit reached (${config.maxPendingPerSession}). Cancel existing schedules first.`,
    }
  }

  // 3. Minimum interval
  const targetMs = new Date(executeAt).getTime()
  for (const entry of pending) {
    const diff = Math.abs(new Date(entry.executeAt).getTime() - targetMs)
    if (diff < config.minIntervalSeconds * 1000) {
      return {
        rule: "min_interval",
        message: `Another command is scheduled within ${config.minIntervalSeconds}s of this time. Space them out.`,
      }
    }
  }

  // 4. Doom loop detection
  const events = await store.readAll()
  const windowStart = Date.now() - config.doomLoopWindowMs
  const recentSchedules = events.filter(
    (evt) =>
      evt.type === "command.scheduled" &&
      new Date(evt.timestamp).getTime() > windowStart &&
      evt.payload.command === command &&
      evt.payload.arguments === args,
  )
  const recentExecutions = events.filter(
    (evt) =>
      evt.type === "command.executed" &&
      new Date(evt.timestamp).getTime() > windowStart,
  )
  // Build set of schedule IDs that succeeded
  const executedIds = new Set(
    recentExecutions.map((e) => e.payload.scheduleId as string),
  )
  const unexecutedRecent = recentSchedules.filter(
    (e) => !executedIds.has(e.payload.scheduleId as string),
  )
  if (unexecutedRecent.length >= config.doomLoopThreshold) {
    return {
      rule: "doom_loop",
      message: `Doom loop detected: /${command} ${args} has been scheduled ${unexecutedRecent.length} times recently without successful execution. Aborting.`,
    }
  }

  return null
}

// ---------------------------------------------------------------------------
// Check before daemon fires a command
// ---------------------------------------------------------------------------

export function shouldFire(
  config: SafetyConfig,
): SafetyViolation | null {
  if (config.paused) {
    return {
      rule: "paused",
      message: "Scheduler is paused. Use /schedule-resume to unpause.",
    }
  }
  return null
}
