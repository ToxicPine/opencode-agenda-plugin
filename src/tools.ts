/**
 * Tools exposed to the LLM.
 *
 * All tools are prefixed agenda_ to avoid namespace collisions.
 */

import { tool } from "@opencode-ai/plugin"
import { writeFile, mkdir } from "fs/promises"
import path from "path"
import {
  EventStore,
  generateId,
  type Trigger,
  type Action,
} from "./event-store.js"
import {
  validateCreate,
  validateBusEmit,
  type SafetyConfig,
} from "./safety.js"

export function createTools(store: EventStore, safetyConfig: SafetyConfig, projectRoot: string) {
  const configPath = path.join(projectRoot, ".opencode", "agenda", "config.json")

  const persistPauseState = async (paused: boolean): Promise<void> => {
    await mkdir(path.dirname(configPath), { recursive: true })
    await writeFile(configPath, JSON.stringify({ paused }, null, 2) + "\n")
  }

  // -----------------------------------------------------------------------
  // agenda_create
  // -----------------------------------------------------------------------
  const create = tool({
    description:
      "Create an agenda item: a trigger paired with an action. " +
      "Triggers: 'time' (wall-clock) or 'event' (bus event, with any/all convergence). " +
      "Actions: 'command' (invoke a slash command in a session), " +
      "'emit' (emit a bus event, zero LLM cost), " +
      "'cancel' (cancel another agenda item, zero LLM cost), " +
      "'schedule' (create a new agenda item, zero LLM cost).",
    args: {
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
      actionType: tool.schema
        .enum(["command", "emit", "cancel", "schedule"])
        .describe("Action type to execute when trigger fires"),
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
      emitKind: tool.schema
        .string()
        .optional()
        .describe("Event kind to emit (for actionType='emit')"),
      emitMessage: tool.schema
        .string()
        .optional()
        .describe("Event message (for actionType='emit')"),
      cancelAgendaId: tool.schema
        .string()
        .optional()
        .describe("Agenda item ID to cancel (for actionType='cancel')"),
      cancelReason: tool.schema
        .string()
        .optional()
        .describe("Reason for cancellation (for actionType='cancel')"),
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
        .describe("Reason for nested agenda item (for actionType='schedule')"),
      reason: tool.schema
        .string()
        .optional()
        .describe("Why this agenda item is being created"),
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
          if (!args.cancelAgendaId)
            return "ERROR: cancelAgendaId required for cancel action."
          action = {
            type: "cancel",
            scheduleId: args.cancelAgendaId,
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
      const violation = validateCreate(store, action, trigger, safetyConfig)
      if (violation) return `BLOCKED [${violation.rule}]: ${violation.message}`

      const agendaId = generateId("agn")
      await store.append({
        type: "agenda.created",
        payload: {
          agendaId,
          trigger,
          action,
          reason: args.reason ?? "",
          createdBy: "assistant",
        },
      })

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

      return `Created: ${actionLabel} ${triggerLabel}\nAgenda ID: ${agendaId}`
    },
  })

  // -----------------------------------------------------------------------
  // agenda_list
  // -----------------------------------------------------------------------
  const list = tool({
    description: "List all agenda items in this project.",
    args: {
      statusFilter: tool.schema.string().optional()
        .describe("Filter: pending, executed, cancelled, failed, expired"),
      triggerTypeFilter: tool.schema.string().optional()
        .describe("Filter: time, event"),
      actionTypeFilter: tool.schema.string().optional()
        .describe("Filter: command, emit, cancel, schedule"),
    },
    async execute(args) {
      let entries = store.entries()
      if (args.statusFilter)
        entries = entries.filter((e) => e.status === args.statusFilter)
      if (args.triggerTypeFilter)
        entries = entries.filter((e) => e.trigger.type === args.triggerTypeFilter)
      if (args.actionTypeFilter)
        entries = entries.filter((e) => e.action.type === args.actionTypeFilter)

      if (entries.length === 0) return "No agenda items found."

      const now = Date.now()
      return entries
        .map((e) => {
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

          let act: string
          switch (e.action.type) {
            case "command":
              act = `/${e.action.command} ${e.action.arguments}`.trimEnd() +
                ` sess:${e.action.sessionId === "new" ? "new" : e.action.sessionId.slice(0, 8)}`
              break
            case "emit": act = `emit "${e.action.kind}"`; break
            case "cancel": act = `cancel ${e.action.scheduleId}`; break
            case "schedule": act = `schedule (nested)`; break
          }

          return `[${e.agendaId}] ${act}  ${trig}  [${e.status}]` +
            (e.reason ? `  -- ${e.reason}` : "")
        })
        .join("\n")
    },
  })

  // -----------------------------------------------------------------------
  // agenda_cancel
  // -----------------------------------------------------------------------
  const cancel = tool({
    description: "Cancel a pending agenda item by ID.",
    args: {
      agendaId: tool.schema.string().describe("Agenda item ID to cancel"),
      reason: tool.schema.string().optional().describe("Why"),
    },
    async execute(args) {
      const entry = store.entries().find((e) => e.agendaId === args.agendaId)
      if (!entry) return `Agenda item ${args.agendaId} not found.`
      if (entry.status !== "pending")
        return `Agenda item ${args.agendaId} is ${entry.status}, cannot cancel.`

      await store.append({
        type: "agenda.cancelled",
        payload: { agendaId: args.agendaId, reason: args.reason ?? "" },
      })

      return `Cancelled ${args.agendaId}`
    },
  })

  // -----------------------------------------------------------------------
  // agenda_emit
  // -----------------------------------------------------------------------
  const emit = tool({
    description: "Emit a project bus event. Matching event-triggered agenda items will fire.",
    args: {
      kind: tool.schema.string().describe("Event kind"),
      message: tool.schema.string().describe("Human-readable message"),
    },
    async execute(args, context) {
      const violation = validateBusEmit(store, context.sessionID, safetyConfig)
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

      const matching = store.matchingEntries(args.kind)
      return (
        `Emitted "${args.kind}": ${args.message}\n` +
        (matching.length > 0
          ? `${matching.length} agenda item(s) will fire.`
          : `No agenda items listening.`)
      )
    },
  })

  // -----------------------------------------------------------------------
  // agenda_events
  // -----------------------------------------------------------------------
  const events = tool({
    description: "List recent project bus events.",
    args: {
      limit: tool.schema.number().optional().describe("Max events (default 20)"),
      kindFilter: tool.schema.string().optional().describe("Filter by kind"),
    },
    async execute(args) {
      let busEvents = store.busEvents()
      if (args.kindFilter) busEvents = busEvents.filter((e) => e.kind === args.kindFilter)
      busEvents.reverse()
      busEvents = busEvents.slice(0, args.limit ?? 20)
      if (busEvents.length === 0) return "No bus events found."
      return busEvents
        .map((e) => `[${e.eventId}] "${e.kind}" -- ${e.message}  (${e.timestamp})`)
        .join("\n")
    },
  })

  // -----------------------------------------------------------------------
  // agenda_pause
  // -----------------------------------------------------------------------
  const pause = tool({
    description: "Pause the agenda. Pending items remain queued but will not fire until resumed.",
    args: {},
    async execute() {
      safetyConfig.paused = true
      await persistPauseState(true)
      return "Agenda paused. Pending items will not fire until resumed."
    },
  })

  // -----------------------------------------------------------------------
  // agenda_resume
  // -----------------------------------------------------------------------
  const resume = tool({
    description: "Resume the agenda. Pending items will begin firing again.",
    args: {},
    async execute() {
      safetyConfig.paused = false
      await persistPauseState(false)
      return "Agenda resumed. Pending items will fire normally."
    },
  })

  return { create, list, cancel, emit, events, pause, resume }
}
