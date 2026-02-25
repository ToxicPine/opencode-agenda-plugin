/**
 * Tools exposed to the LLM.
 *
 * Tool surface:
 *   schedule        -- create a schedule (trigger + action)
 *   schedule_list   -- view schedules across the project
 *   schedule_cancel -- cancel a pending schedule
 *   bus_emit        -- emit a project bus event
 *   bus_events      -- list recent bus events
 */

import { tool } from "@opencode-ai/plugin"
import {
  EventStore,
  generateId,
  type Trigger,
  type Action,
} from "./event-store.js"
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
      "Create a schedule: a trigger paired with an action. " +
      "Triggers: 'time' (wall-clock) or 'event' (bus event, with any/all convergence). " +
      "Actions: 'command' (invoke a slash command in a session), " +
      "'emit' (emit a bus event, zero LLM cost), " +
      "'cancel' (cancel another schedule, zero LLM cost), " +
      "'schedule' (create a new schedule, zero LLM cost).",
    args: {
      // -- trigger --
      triggerType: tool.schema
        .enum(["time", "event"])
        .describe("Trigger type"),
      executeAt: tool.schema
        .string()
        .optional()
        .describe("ISO 8601 timestamp (required for triggerType='time')"),
      eventKind: tool.schema
        .string()
        .optional()
        .describe("Single event kind (for triggerType='event'). Use eventKinds for multiple."),
      eventKinds: tool.schema
        .array(tool.schema.string())
        .optional()
        .describe("Array of event kinds for convergence (triggerType='event')"),
      matchMode: tool.schema
        .enum(["any", "all"])
        .optional()
        .describe("'any' fires on first match (default), 'all' waits for every kind"),
      expiresAt: tool.schema
        .string()
        .optional()
        .describe("ISO 8601 expiry for event triggers (optional)"),
      // -- action --
      actionType: tool.schema
        .enum(["command", "emit", "cancel", "schedule"])
        .describe("Action type to execute when trigger fires"),
      // command action fields
      command: tool.schema
        .string()
        .optional()
        .describe("Slash command name without / (for actionType='command')"),
      arguments: tool.schema
        .string()
        .optional()
        .describe("Arguments for the command (for actionType='command')"),
      targetSession: tool.schema
        .string()
        .optional()
        .describe("Session ID, or 'new' (for actionType='command'). Omit for current session."),
      // emit action fields
      emitKind: tool.schema
        .string()
        .optional()
        .describe("Event kind to emit (for actionType='emit')"),
      emitMessage: tool.schema
        .string()
        .optional()
        .describe("Event message (for actionType='emit')"),
      // cancel action fields
      cancelScheduleId: tool.schema
        .string()
        .optional()
        .describe("Schedule ID to cancel (for actionType='cancel')"),
      cancelReason: tool.schema
        .string()
        .optional()
        .describe("Reason for cancellation (for actionType='cancel')"),
      // schedule action fields (nested)
      nestedAction: tool.schema
        .string()
        .optional()
        .describe("JSON-encoded Action object (for actionType='schedule')"),
      nestedTrigger: tool.schema
        .string()
        .optional()
        .describe("JSON-encoded Trigger object (for actionType='schedule')"),
      nestedReason: tool.schema
        .string()
        .optional()
        .describe("Reason for nested schedule (for actionType='schedule')"),
      // -- metadata --
      reason: tool.schema
        .string()
        .optional()
        .describe("Why this schedule is being created"),
    },
    async execute(args, context) {
      // Build trigger
      let trigger: Trigger
      if (args.triggerType === "time") {
        if (!args.executeAt) return "ERROR: executeAt required for time trigger."
        trigger = { type: "time", executeAt: args.executeAt }
      } else {
        const kinds = args.eventKinds ?? (args.eventKind ? [args.eventKind] : null)
        if (!kinds || kinds.length === 0)
          return "ERROR: eventKind or eventKinds required for event trigger."
        trigger = {
          type: "event",
          eventKind: kinds.length === 1 ? kinds[0] : kinds,
          matchMode: args.matchMode,
          expiresAt: args.expiresAt,
        }
      }

      // Build action
      let action: Action
      switch (args.actionType) {
        case "command":
          if (!args.command) return "ERROR: command required for command action."
          action = {
            type: "command",
            command: args.command,
            arguments: args.arguments ?? "",
            sessionId: args.targetSession ?? context.sessionID,
          }
          break
        case "emit":
          if (!args.emitKind || !args.emitMessage)
            return "ERROR: emitKind and emitMessage required for emit action."
          action = { type: "emit", kind: args.emitKind, message: args.emitMessage }
          break
        case "cancel":
          if (!args.cancelScheduleId)
            return "ERROR: cancelScheduleId required for cancel action."
          action = {
            type: "cancel",
            scheduleId: args.cancelScheduleId,
            reason: args.cancelReason ?? "",
          }
          break
        case "schedule":
          if (!args.nestedAction || !args.nestedTrigger)
            return "ERROR: nestedAction and nestedTrigger required for schedule action."
          try {
            action = {
              type: "schedule",
              action: JSON.parse(args.nestedAction) as Action,
              trigger: JSON.parse(args.nestedTrigger) as Trigger,
              reason: args.nestedReason ?? "",
            }
          } catch {
            return "ERROR: failed to parse nestedAction or nestedTrigger JSON."
          }
          break
      }

      // Safety
      const violation = await validateSchedule(store, action, trigger, safetyConfig)
      if (violation) return `BLOCKED [${violation.rule}]: ${violation.message}`

      const scheduleId = generateId("sch")
      await store.append({
        type: "schedule.created",
        payload: {
          scheduleId,
          trigger,
          action,
          reason: args.reason ?? "",
          createdBy: "assistant",
        },
      })

      // Format response
      const actionLabel =
        action.type === "command"
          ? `/${action.command} ${action.arguments}`.trimEnd() +
            ` in ${action.sessionId === "new" ? "[new session]" : action.sessionId}`
          : action.type === "emit"
            ? `emit "${action.kind}"`
            : action.type === "cancel"
              ? `cancel ${action.scheduleId}`
              : `schedule (nested)`

      let triggerLabel: string
      if (trigger.type === "time") {
        const mins = Math.round(
          (new Date(trigger.executeAt).getTime() - Date.now()) / 60000,
        )
        triggerLabel = `at ${trigger.executeAt} (~${mins}m)`
      } else {
        const kinds = Array.isArray(trigger.eventKind)
          ? trigger.eventKind
          : [trigger.eventKind]
        const mode = trigger.matchMode ?? "any"
        triggerLabel = `on ${mode}(${kinds.map((k) => `"${k}"`).join(", ")})` +
          (trigger.expiresAt ? ` expires ${trigger.expiresAt}` : "")
      }

      return `Scheduled: ${actionLabel} ${triggerLabel}\nSchedule ID: ${scheduleId}`
    },
  })

  // -----------------------------------------------------------------------
  // schedule_list
  // -----------------------------------------------------------------------
  const list = tool({
    description: "List all schedules in this project.",
    args: {
      statusFilter: tool.schema.string().optional()
        .describe("Filter: pending, executed, cancelled, failed, expired"),
      triggerTypeFilter: tool.schema.string().optional()
        .describe("Filter: time, event"),
      actionTypeFilter: tool.schema.string().optional()
        .describe("Filter: command, emit, cancel, schedule"),
    },
    async execute(args) {
      let entries = await store.materialize()
      if (args.statusFilter)
        entries = entries.filter((e) => e.status === args.statusFilter)
      if (args.triggerTypeFilter)
        entries = entries.filter((e) => e.trigger.type === args.triggerTypeFilter)
      if (args.actionTypeFilter)
        entries = entries.filter((e) => e.action.type === args.actionTypeFilter)

      if (entries.length === 0) return "No schedules found."

      const now = Date.now()
      return entries
        .map((e) => {
          // Trigger label
          let trig: string
          if (e.trigger.type === "time") {
            const d = new Date(e.trigger.executeAt).getTime() - now
            trig = e.status === "pending"
              ? d > 0 ? `@ ${e.trigger.executeAt} (in ${Math.round(d / 60000)}m)` : `@ OVERDUE`
              : `@ ${e.trigger.executeAt}`
          } else {
            const kinds = Array.isArray(e.trigger.eventKind) ? e.trigger.eventKind : [e.trigger.eventKind]
            const mode = e.trigger.matchMode ?? "any"
            trig = `on ${mode}(${kinds.join(", ")})`
            if (e.trigger.expiresAt) trig += ` exp:${e.trigger.expiresAt}`
          }

          // Action label
          let act: string
          switch (e.action.type) {
            case "command":
              act = `/${e.action.command} ${e.action.arguments}`.trimEnd() + ` sess:${e.action.sessionId === "new" ? "new" : e.action.sessionId.slice(0, 8)}`
              break
            case "emit": act = `emit "${e.action.kind}"`; break
            case "cancel": act = `cancel ${e.action.scheduleId}`; break
            case "schedule": act = `schedule (nested)`; break
          }

          return `[${e.scheduleId}] ${act}  ${trig}  [${e.status}]` +
            (e.reason ? `  -- ${e.reason}` : "")
        })
        .join("\n")
    },
  })

  // -----------------------------------------------------------------------
  // schedule_cancel
  // -----------------------------------------------------------------------
  const cancel = tool({
    description: "Cancel a pending schedule by ID.",
    args: {
      scheduleId: tool.schema.string().describe("Schedule ID to cancel"),
      reason: tool.schema.string().optional().describe("Why"),
    },
    async execute(args) {
      const entries = await store.materialize()
      const entry = entries.find((e) => e.scheduleId === args.scheduleId)
      if (!entry) return `Schedule ${args.scheduleId} not found.`
      if (entry.status !== "pending")
        return `Schedule ${args.scheduleId} is ${entry.status}, cannot cancel.`

      await store.append({
        type: "schedule.cancelled",
        payload: { scheduleId: args.scheduleId, reason: args.reason ?? "" },
      })

      return `Cancelled ${args.scheduleId}`
    },
  })

  // -----------------------------------------------------------------------
  // bus_emit
  // -----------------------------------------------------------------------
  const busEmit = tool({
    description: "Emit a project bus event. Matching event-triggered schedules will fire.",
    args: {
      kind: tool.schema.string().describe("Event kind"),
      message: tool.schema.string().describe("Human-readable message"),
    },
    async execute(args, context) {
      const violation = await validateBusEmit(store, context.sessionID, safetyConfig)
      if (violation) return `BLOCKED [${violation.rule}]: ${violation.message}`

      await store.append({
        type: "bus.emitted",
        payload: {
          eventId: generateId("bus"),
          kind: args.kind,
          message: args.message,
          sessionId: context.sessionID,
        },
      })

      const matching = await store.matchingSchedules(args.kind)
      return (
        `Emitted "${args.kind}": ${args.message}\n` +
        (matching.length > 0
          ? `${matching.length} schedule(s) will fire.`
          : `No schedules listening.`)
      )
    },
  })

  // -----------------------------------------------------------------------
  // bus_events
  // -----------------------------------------------------------------------
  const busEvents = tool({
    description: "List recent project bus events.",
    args: {
      limit: tool.schema.number().optional().describe("Max events (default 20)"),
      kindFilter: tool.schema.string().optional().describe("Filter by kind"),
    },
    async execute(args) {
      let events = await store.busEvents()
      if (args.kindFilter) events = events.filter((e) => e.kind === args.kindFilter)
      events.reverse()
      events = events.slice(0, args.limit ?? 20)
      if (events.length === 0) return "No bus events found."
      return events
        .map((e) => `[${e.eventId}] "${e.kind}" -- ${e.message}  (${e.timestamp})`)
        .join("\n")
    },
  })

  return { schedule, list, cancel, busEmit, busEvents }
}
