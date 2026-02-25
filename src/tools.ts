/**
 * Custom tools exposed to the LLM via the OpenCode plugin tool API.
 *
 * Project-scoped: all tools operate on the project-wide schedule and event
 * bus. Commands can target any session within the project, or "new" to
 * create a fresh session when the command fires.
 *
 * Tool surface:
 *   schedule          -- create a schedule (time or event triggered)
 *   schedule_list     -- view schedules across the project
 *   schedule_cancel   -- cancel a pending schedule
 *   schedule_reschedule -- change execution time (time-triggered only)
 *   bus_emit          -- emit a project event (may trigger event-based schedules)
 *   bus_events        -- list recent project bus events
 */

import { tool } from "@opencode-ai/plugin"
import { EventStore, generateId, type Trigger } from "./event-store.js"
import {
  validateSchedule,
  validateBusEmit,
  type SafetyConfig,
} from "./safety.js"

export function createTools(store: EventStore, safetyConfig: SafetyConfig) {
  // -----------------------------------------------------------------------
  // schedule
  // -----------------------------------------------------------------------
  const schedule = tool({
    description:
      "Schedule a slash command to execute in this project. " +
      "Trigger can be time-based (fires at a wall-clock time) or " +
      "event-based (fires when a matching project event is emitted). " +
      "The command can target the current session, a specific session ID, " +
      'or "new" to create a fresh session when it fires.',
    args: {
      command: tool.schema
        .string()
        .describe("Slash command name without / (e.g. 'test', 'build')"),
      arguments: tool.schema
        .string()
        .optional()
        .describe("Arguments to pass to the command"),
      triggerType: tool.schema
        .enum(["time", "event"])
        .describe("'time' to fire at a specific time, 'event' to fire on a project bus event"),
      executeAt: tool.schema
        .string()
        .optional()
        .describe("ISO 8601 timestamp (required if triggerType='time')"),
      eventKind: tool.schema
        .string()
        .optional()
        .describe("Event kind to listen for (required if triggerType='event')"),
      expiresAt: tool.schema
        .string()
        .optional()
        .describe("ISO 8601 expiry for event-triggered schedules (optional)"),
      targetSession: tool.schema
        .string()
        .optional()
        .describe(
          'Session ID to execute in. Omit for current session. ' +
          'Use "new" to create a fresh session when the command fires.',
        ),
      reason: tool.schema
        .string()
        .optional()
        .describe("Why this is being scheduled (recorded in event log)"),
    },
    async execute(args, context) {
      const cmdArgs = args.arguments ?? ""
      const sessionId = args.targetSession ?? context.sessionID

      // Build trigger
      let trigger: Trigger
      if (args.triggerType === "time") {
        if (!args.executeAt) {
          return "ERROR: executeAt is required for time-triggered schedules."
        }
        trigger = { type: "time", executeAt: args.executeAt }
      } else {
        if (!args.eventKind) {
          return "ERROR: eventKind is required for event-triggered schedules."
        }
        trigger = {
          type: "event",
          eventKind: args.eventKind,
          expiresAt: args.expiresAt,
        }
      }

      // Safety check
      const violation = await validateSchedule(
        store,
        sessionId,
        args.command,
        cmdArgs,
        trigger,
        safetyConfig,
      )
      if (violation) {
        return `BLOCKED [${violation.rule}]: ${violation.message}`
      }

      const scheduleId = generateId("sch")
      await store.append({
        type: "schedule.created",
        payload: {
          scheduleId,
          sessionId,
          command: args.command,
          arguments: cmdArgs,
          trigger,
          reason: args.reason ?? "",
          createdBy: "assistant",
        },
      })

      if (trigger.type === "time") {
        const delta = new Date(trigger.executeAt).getTime() - Date.now()
        const mins = Math.round(delta / 60000)
        return (
          `Scheduled /${args.command} ${cmdArgs} ` +
          `for ${trigger.executeAt} (~${mins}m from now) ` +
          `in session ${sessionId === "new" ? "[new session]" : sessionId}\n` +
          `Schedule ID: ${scheduleId}`
        )
      } else {
        return (
          `Scheduled /${args.command} ${cmdArgs} ` +
          `on event "${trigger.eventKind}" ` +
          (trigger.expiresAt ? `(expires ${trigger.expiresAt}) ` : "") +
          `in session ${sessionId === "new" ? "[new session]" : sessionId}\n` +
          `Schedule ID: ${scheduleId}`
        )
      }
    },
  })

  // -----------------------------------------------------------------------
  // schedule_list
  // -----------------------------------------------------------------------
  const list = tool({
    description:
      "List all schedules in this project. Shows pending, executed, " +
      "cancelled, expired, and failed entries across all sessions.",
    args: {
      sessionOnly: tool.schema
        .boolean()
        .optional()
        .describe("If true, only show schedules targeting the current session"),
      statusFilter: tool.schema
        .string()
        .optional()
        .describe("Filter by status: pending, executed, cancelled, failed, expired"),
      triggerTypeFilter: tool.schema
        .string()
        .optional()
        .describe("Filter by trigger type: time, event"),
    },
    async execute(args, context) {
      let entries = await store.materialize()

      if (args.sessionOnly) {
        entries = entries.filter((e) => e.sessionId === context.sessionID)
      }
      if (args.statusFilter) {
        entries = entries.filter((e) => e.status === args.statusFilter)
      }
      if (args.triggerTypeFilter) {
        entries = entries.filter(
          (e) => e.trigger.type === args.triggerTypeFilter,
        )
      }

      if (entries.length === 0) return "No schedules found."

      const now = Date.now()
      const lines = entries.map((e) => {
        let triggerLabel: string
        if (e.trigger.type === "time") {
          const deltaMs = new Date(e.trigger.executeAt).getTime() - now
          const deltaMins = Math.round(deltaMs / 60000)
          triggerLabel =
            e.status === "pending"
              ? deltaMs > 0
                ? `@ ${e.trigger.executeAt} (in ${deltaMins}m)`
                : `@ ${e.trigger.executeAt} (OVERDUE by ${Math.abs(deltaMins)}m)`
              : `@ ${e.trigger.executeAt}`
        } else {
          triggerLabel = `on "${e.trigger.eventKind}"` +
            (e.trigger.expiresAt ? ` (expires ${e.trigger.expiresAt})` : "")
        }

        const sessionLabel =
          e.sessionId === "new"
            ? "[new session]"
            : e.sessionId.slice(0, 12)

        return (
          `[${e.scheduleId}] /${e.command} ${e.arguments}`.trimEnd() +
          `  ${triggerLabel}  [${e.status}]` +
          `  session:${sessionLabel}` +
          (e.reason ? `  -- ${e.reason}` : "")
        )
      })

      return lines.join("\n")
    },
  })

  // -----------------------------------------------------------------------
  // schedule_cancel
  // -----------------------------------------------------------------------
  const cancel = tool({
    description:
      "Cancel a pending schedule by its ID. Only pending schedules can be cancelled.",
    args: {
      scheduleId: tool.schema
        .string()
        .describe("The schedule ID to cancel (e.g. sch_a1b2c3d4)"),
      reason: tool.schema
        .string()
        .optional()
        .describe("Why this is being cancelled"),
    },
    async execute(args) {
      const entries = await store.materialize()
      const entry = entries.find((e) => e.scheduleId === args.scheduleId)
      if (!entry) return `Schedule ${args.scheduleId} not found.`
      if (entry.status !== "pending")
        return `Schedule ${args.scheduleId} is already ${entry.status}, cannot cancel.`

      await store.append({
        type: "schedule.cancelled",
        payload: {
          scheduleId: args.scheduleId,
          reason: args.reason ?? "",
        },
      })

      return `Cancelled /${entry.command} ${entry.arguments} (${args.scheduleId})`
    },
  })

  // -----------------------------------------------------------------------
  // schedule_reschedule
  // -----------------------------------------------------------------------
  const reschedule = tool({
    description:
      "Change the execution time of a pending time-triggered schedule.",
    args: {
      scheduleId: tool.schema
        .string()
        .describe("The schedule ID to reschedule"),
      newExecuteAt: tool.schema
        .string()
        .describe("New ISO 8601 execution time"),
      reason: tool.schema
        .string()
        .optional()
        .describe("Why this is being rescheduled"),
    },
    async execute(args) {
      const entries = await store.materialize()
      const entry = entries.find((e) => e.scheduleId === args.scheduleId)
      if (!entry) return `Schedule ${args.scheduleId} not found.`
      if (entry.status !== "pending")
        return `Schedule ${args.scheduleId} is already ${entry.status}, cannot reschedule.`
      if (entry.trigger.type !== "time")
        return `Schedule ${args.scheduleId} is event-triggered. Cancel and re-create instead.`

      await store.append({
        type: "schedule.rescheduled",
        payload: {
          scheduleId: args.scheduleId,
          executeAt: args.newExecuteAt,
          reason: args.reason ?? "",
        },
      })

      return `Rescheduled ${args.scheduleId} to ${args.newExecuteAt}`
    },
  })

  // -----------------------------------------------------------------------
  // bus_emit
  // -----------------------------------------------------------------------
  const busEmit = tool({
    description:
      "Emit a project-scoped event on the event bus. Any event-triggered " +
      "schedules matching this kind will fire. Other sessions in this " +
      "project can listen for these events.",
    args: {
      kind: tool.schema
        .string()
        .describe("Event kind string (e.g. 'tests.passed', 'deploy.ready', 'review.needed')"),
      message: tool.schema
        .string()
        .describe("Human-readable message describing what happened"),
    },
    async execute(args, context) {
      // Safety check
      const violation = await validateBusEmit(
        store,
        context.sessionID,
        safetyConfig,
      )
      if (violation) {
        return `BLOCKED [${violation.rule}]: ${violation.message}`
      }

      const eventId = generateId("bus")
      await store.append({
        type: "bus.emitted",
        payload: {
          eventId,
          kind: args.kind,
          message: args.message,
          sessionId: context.sessionID,
        },
      })

      // Check how many schedules this will trigger
      const matching = await store.matchingSchedules(args.kind)
      const triggerCount = matching.length

      return (
        `Emitted event "${args.kind}": ${args.message}\n` +
        `Event ID: ${eventId}\n` +
        (triggerCount > 0
          ? `${triggerCount} schedule(s) will be triggered.`
          : `No schedules are listening for this event kind.`)
      )
    },
  })

  // -----------------------------------------------------------------------
  // bus_events
  // -----------------------------------------------------------------------
  const busEvents = tool({
    description:
      "List recent project bus events. Useful for seeing what events " +
      "have been emitted across sessions in this project.",
    args: {
      limit: tool.schema
        .number()
        .optional()
        .describe("Max events to return (default 20, most recent first)"),
      kindFilter: tool.schema
        .string()
        .optional()
        .describe("Filter by event kind"),
    },
    async execute(args) {
      let events = await store.busEvents()

      if (args.kindFilter) {
        events = events.filter((e) => e.kind === args.kindFilter)
      }

      // Most recent first
      events.reverse()
      const limit = args.limit ?? 20
      events = events.slice(0, limit)

      if (events.length === 0) return "No bus events found."

      const lines = events.map(
        (e) =>
          `[${e.eventId}] "${e.kind}" -- ${e.message}  ` +
          `(session:${e.sessionId.slice(0, 12)}, ${e.timestamp})`,
      )

      return lines.join("\n")
    },
  })

  return { schedule, list, cancel, reschedule, busEmit, busEvents }
}
