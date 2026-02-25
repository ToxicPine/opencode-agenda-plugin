/**
 * Safety rails for the agenda.
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
  maxPendingPerEventKind: number
  maxBusEmitsPerSessionPerHour: number
  maxCascadeDepth: number
  paused: boolean
}

export const DEFAULT_SAFETY: SafetyConfig = {
  maxPendingPerSession: 10,
  maxPendingProject: 30,
  minIntervalSeconds: 60,
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
// Checks
// ---------------------------------------------------------------------------

/** Returns a violation if the agenda is paused, null otherwise. */
export const pauseViolation = (config: SafetyConfig): SafetyViolation | null =>
  config.paused
    ? { rule: "paused", message: "Agenda is paused." }
    : null

/** Validate that a new agenda item does not violate safety limits. */
export const validateCreate = (
  store: EventStore,
  action: Action,
  trigger: Trigger,
  config: SafetyConfig = DEFAULT_SAFETY,
): SafetyViolation | null => {
  const pending = store.pending()

  // 1. Project cap
  if (pending.length >= config.maxPendingProject) {
    return {
      rule: "max_pending_project",
      message: `Project pending limit reached (${config.maxPendingProject}).`,
    }
  }

  // 2. Per-session cap (command actions only)
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
          message: `Another item is within ${config.minIntervalSeconds}s of this time.`,
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
          message: `Too many pending items for event kind "${kind}" (${config.maxPendingPerEventKind}).`,
        }
      }
    }
  }

  return null
}

/** Validate that a session hasn't exceeded its bus emit rate limit. */
export const validateBusEmit = (
  store: EventStore,
  sessionId: string,
  config: SafetyConfig = DEFAULT_SAFETY,
): SafetyViolation | null => {
  const hourAgo = Date.now() - 60 * 60 * 1000
  const recentCount = store.busEvents().filter(
    (e) =>
      e.sessionId === sessionId &&
      new Date(e.timestamp).getTime() > hourAgo,
  ).length

  if (recentCount >= config.maxBusEmitsPerSessionPerHour) {
    return {
      rule: "max_bus_emits",
      message: `Session emitted ${recentCount} events in the last hour (limit ${config.maxBusEmitsPerSessionPerHour}).`,
    }
  }
  return null
}
