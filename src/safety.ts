/**
 * Safety rails for the scheduler.
 *
 * All limits are project-scoped.
 */

import type { EventStore, Trigger, Action } from "./event-store.js"

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface SafetyConfig {
  maxPendingPerSession: number
  maxPendingProject: number
  minIntervalSeconds: number
  doomLoopThreshold: number
  doomLoopWindowMs: number
  maxPendingPerEventKind: number
  maxBusEmitsPerSessionPerHour: number
  /** Max cascade depth for action chains within a single tick. */
  maxCascadeDepth: number
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
  maxCascadeDepth: 8,
  paused: false,
}

// ---------------------------------------------------------------------------
// Violation
// ---------------------------------------------------------------------------

export interface SafetyViolation {
  rule: string
  message: string
}

// ---------------------------------------------------------------------------
// Schedule validation
// ---------------------------------------------------------------------------

export async function validateSchedule(
  store: EventStore,
  action: Action,
  trigger: Trigger,
  config: SafetyConfig = DEFAULT_SAFETY,
): Promise<SafetyViolation | null> {
  const pending = await store.pending()

  // 1. Project cap
  if (pending.length >= config.maxPendingProject) {
    return {
      rule: "max_pending_project",
      message: `Project pending limit reached (${config.maxPendingProject}).`,
    }
  }

  // 2. Per-session cap (only for command actions)
  if (action.type === "command") {
    const sessionPending = pending.filter(
      (e) => e.action.type === "command" && e.action.sessionId === action.sessionId,
    )
    if (sessionPending.length >= config.maxPendingPerSession) {
      return {
        rule: "max_pending_session",
        message: `Session pending limit reached (${config.maxPendingPerSession}).`,
      }
    }
  }

  // 3. Time trigger interval
  if (trigger.type === "time") {
    const targetMs = new Date(trigger.executeAt).getTime()
    for (const entry of pending) {
      if (entry.trigger.type !== "time") continue
      const diff = Math.abs(
        new Date(entry.trigger.executeAt).getTime() - targetMs,
      )
      if (diff < config.minIntervalSeconds * 1000) {
        return {
          rule: "min_interval",
          message: `Another schedule is within ${config.minIntervalSeconds}s of this time.`,
        }
      }
    }
  }

  // 4. Event trigger kind cap
  if (trigger.type === "event") {
    const kinds = Array.isArray(trigger.eventKind)
      ? trigger.eventKind
      : [trigger.eventKind]
    for (const kind of kinds) {
      const kindPending = pending.filter(
        (e) =>
          e.trigger.type === "event" &&
          (Array.isArray(e.trigger.eventKind)
            ? e.trigger.eventKind.includes(kind)
            : e.trigger.eventKind === kind),
      )
      if (kindPending.length >= config.maxPendingPerEventKind) {
        return {
          rule: "max_pending_event_kind",
          message: `Too many pending schedules for event kind "${kind}" (${config.maxPendingPerEventKind}).`,
        }
      }
    }
  }

  // 5. Doom loop detection (command actions only)
  if (action.type === "command") {
    const events = await store.readAll()
    const windowStart = Date.now() - config.doomLoopWindowMs
    const recentSchedules = events.filter(
      (evt): evt is Extract<typeof evt, { type: "schedule.created" }> =>
        evt.type === "schedule.created" &&
        new Date(evt.timestamp).getTime() > windowStart &&
        evt.payload.action.type === "command" &&
        evt.payload.action.command === action.command &&
        evt.payload.action.arguments === action.arguments,
    )
    const recentExecutions = events.filter(
      (evt): evt is Extract<typeof evt, { type: "schedule.executed" }> =>
        evt.type === "schedule.executed" &&
        new Date(evt.timestamp).getTime() > windowStart,
    )
    const executedIds = new Set(
      recentExecutions.map((e) => e.payload.scheduleId),
    )
    const unexecuted = recentSchedules.filter(
      (e) => !executedIds.has(e.payload.scheduleId),
    )
    if (unexecuted.length >= config.doomLoopThreshold) {
      return {
        rule: "doom_loop",
        message: `Doom loop: /${action.command} ${action.arguments} scheduled ${unexecuted.length} times recently without success.`,
      }
    }
  }

  return null
}

// ---------------------------------------------------------------------------
// Bus emit validation
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
      message: `Session emitted ${recentEmits.length} events in the last hour (limit ${config.maxBusEmitsPerSessionPerHour}).`,
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Firing check
// ---------------------------------------------------------------------------

export function shouldFire(config: SafetyConfig): SafetyViolation | null {
  if (config.paused) {
    return { rule: "paused", message: "Scheduler is paused." }
  }
  return null
}
