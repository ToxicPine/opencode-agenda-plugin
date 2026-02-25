/**
 * Safety rails for the scheduler.
 *
 * All limits are project-scoped (not per-session), because the event store
 * and schedule are project-wide resources shared across sessions.
 */

import type { EventStore, Trigger } from "./event-store.js"

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface SafetyConfig {
  /** Max pending schedules per session (default 10). */
  maxPendingPerSession: number
  /** Max pending schedules across the whole project (default 30). */
  maxPendingProject: number
  /** Minimum seconds between any two time-triggered executions (default 60). */
  minIntervalSeconds: number
  /** If the same command+args has been scheduled this many times in the
   *  trailing window without a successful execution, block it (default 4). */
  doomLoopThreshold: number
  /** Trailing window in ms for doom loop detection (default 1 hour). */
  doomLoopWindowMs: number
  /** Max pending event-triggered schedules per event kind (default 5). */
  maxPendingPerEventKind: number
  /** Max bus events emitted per session per hour (default 30). */
  maxBusEmitsPerSessionPerHour: number
  /** When true, the scheduler will not fire any commands. */
  paused: boolean
}

export const DEFAULT_SAFETY: SafetyConfig = {
  maxPendingPerSession: 10,
  maxPendingProject: 30,
  minIntervalSeconds: 60,
  doomLoopThreshold: 4,
  doomLoopWindowMs: 60 * 60 * 1000,
  maxPendingPerEventKind: 5,
  maxBusEmitsPerSessionPerHour: 30,
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
// Checks -- run before accepting a schedule.created event
// ---------------------------------------------------------------------------

export async function validateSchedule(
  store: EventStore,
  sessionId: string,
  command: string,
  args: string,
  trigger: Trigger,
  config: SafetyConfig = DEFAULT_SAFETY,
): Promise<SafetyViolation | null> {
  const pending = await store.pending()

  // 1. Project-wide cap
  if (pending.length >= config.maxPendingProject) {
    return {
      rule: "max_pending_project",
      message: `Project pending limit reached (${config.maxPendingProject}). Cancel existing schedules first.`,
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

  // 3. Trigger-specific checks
  if (trigger.type === "time") {
    // Minimum interval between time-triggered commands
    const targetMs = new Date(trigger.executeAt).getTime()
    for (const entry of pending) {
      if (entry.trigger.type !== "time") continue
      const diff = Math.abs(
        new Date(entry.trigger.executeAt).getTime() - targetMs,
      )
      if (diff < config.minIntervalSeconds * 1000) {
        return {
          rule: "min_interval",
          message: `Another command is scheduled within ${config.minIntervalSeconds}s of this time. Space them out.`,
        }
      }
    }
  }

  if (trigger.type === "event") {
    // Cap per event kind
    const kindPending = pending.filter(
      (e) =>
        e.trigger.type === "event" &&
        e.trigger.eventKind === trigger.eventKind,
    )
    if (kindPending.length >= config.maxPendingPerEventKind) {
      return {
        rule: "max_pending_event_kind",
        message: `Too many pending schedules for event kind "${trigger.eventKind}" (${config.maxPendingPerEventKind}). Cancel some first.`,
      }
    }
  }

  // 4. Doom loop detection (applies to all trigger types)
  const events = await store.readAll()
  const windowStart = Date.now() - config.doomLoopWindowMs
  const recentSchedules = events.filter(
    (evt): evt is Extract<typeof evt, { type: "schedule.created" }> =>
      evt.type === "schedule.created" &&
      new Date(evt.timestamp).getTime() > windowStart &&
      evt.payload.command === command &&
      evt.payload.arguments === args,
  )
  const recentExecutions = events.filter(
    (evt): evt is Extract<typeof evt, { type: "schedule.executed" }> =>
      evt.type === "schedule.executed" &&
      new Date(evt.timestamp).getTime() > windowStart,
  )
  const executedIds = new Set(
    recentExecutions.map((e) => e.payload.scheduleId),
  )
  const unexecutedRecent = recentSchedules.filter(
    (e) => !executedIds.has(e.payload.scheduleId),
  )
  if (unexecutedRecent.length >= config.doomLoopThreshold) {
    return {
      rule: "doom_loop",
      message: `Doom loop detected: /${command} ${args} scheduled ${unexecutedRecent.length} times recently without success. Aborting.`,
    }
  }

  return null
}

// ---------------------------------------------------------------------------
// Checks -- run before accepting a bus.emitted event
// ---------------------------------------------------------------------------

export async function validateBusEmit(
  store: EventStore,
  sessionId: string,
  config: SafetyConfig = DEFAULT_SAFETY,
): Promise<SafetyViolation | null> {
  const events = await store.readAll()
  const hourAgo = Date.now() - 60 * 60 * 1000
  const recentEmits = events.filter(
    (e): e is Extract<typeof e, { type: "bus.emitted" }> =>
      e.type === "bus.emitted" &&
      e.payload.sessionId === sessionId &&
      new Date(e.timestamp).getTime() > hourAgo,
  )
  if (recentEmits.length >= config.maxBusEmitsPerSessionPerHour) {
    return {
      rule: "max_bus_emits",
      message: `Session has emitted ${recentEmits.length} events in the last hour (limit ${config.maxBusEmitsPerSessionPerHour}). Slow down.`,
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
