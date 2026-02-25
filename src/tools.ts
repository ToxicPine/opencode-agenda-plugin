/**
 * Custom tools exposed to the LLM via the OpenCode plugin tool API.
 *
 * These give the model the ability to schedule, list, cancel, and
 * reschedule slash commands for future execution.
 */

import { tool } from "@opencode-ai/plugin"
import { EventStore, generateId } from "./event-store.js"
import { validateSchedule, type SafetyConfig, DEFAULT_SAFETY } from "./safety.js"

// The store and config are injected at plugin init time via createTools().

export function createTools(store: EventStore, safetyConfig: SafetyConfig) {
  const schedule = tool({
    description:
      "Schedule a slash command to execute at a future time in this session. " +
      "Use ISO 8601 timestamps for executeAt. The command fires automatically " +
      "when the time arrives. Returns the schedule ID for tracking or cancellation.",
    args: {
      command: tool.schema
        .string()
        .describe("Slash command name without the leading / (e.g. 'test', 'build')"),
      arguments: tool.schema
        .string()
        .optional()
        .describe("Arguments to pass to the command"),
      executeAt: tool.schema
        .string()
        .describe(
          "ISO 8601 timestamp for when to execute (e.g. '2026-02-25T15:00:00Z')",
        ),
      reason: tool.schema
        .string()
        .optional()
        .describe("Why this command is being scheduled (recorded in event log)"),
    },
    async execute(args, context) {
      const sessionId = context.sessionID
      const cmdArgs = args.arguments ?? ""

      // Safety check
      const violation = await validateSchedule(
        store,
        sessionId,
        args.command,
        cmdArgs,
        args.executeAt,
        safetyConfig,
      )
      if (violation) {
        return `BLOCKED [${violation.rule}]: ${violation.message}`
      }

      const scheduleId = generateId("sch")
      await store.append({
        type: "command.scheduled",
        payload: {
          scheduleId,
          sessionId,
          command: args.command,
          arguments: cmdArgs,
          executeAt: args.executeAt,
          reason: args.reason ?? "",
          createdBy: "assistant",
        },
      })

      const delta = new Date(args.executeAt).getTime() - Date.now()
      const mins = Math.round(delta / 60000)
      return (
        `Scheduled /${args.command} ${cmdArgs} ` +
        `for ${args.executeAt} (~${mins}m from now)\n` +
        `Schedule ID: ${scheduleId}`
      )
    },
  })

  const list = tool({
    description:
      "List all scheduled commands. Shows pending, executed, cancelled, " +
      "and failed entries. Use sessionOnly=true to filter to this session.",
    args: {
      sessionOnly: tool.schema
        .boolean()
        .optional()
        .describe("If true, only show commands for the current session"),
      statusFilter: tool.schema
        .string()
        .optional()
        .describe("Filter by status: pending, executed, cancelled, failed"),
    },
    async execute(args, context) {
      let entries = await store.materialize()

      if (args.sessionOnly) {
        entries = entries.filter((e) => e.sessionId === context.sessionID)
      }
      if (args.statusFilter) {
        entries = entries.filter((e) => e.status === args.statusFilter)
      }

      if (entries.length === 0) return "No scheduled commands found."

      const now = Date.now()
      const lines = entries.map((e) => {
        const deltaMs = new Date(e.executeAt).getTime() - now
        const deltaMins = Math.round(deltaMs / 60000)
        const timeLabel =
          e.status === "pending"
            ? deltaMs > 0
              ? `in ${deltaMins}m`
              : `OVERDUE by ${Math.abs(deltaMins)}m`
            : e.status
        return (
          `[${e.scheduleId}] /${e.command} ${e.arguments}`.trimEnd() +
          `  @ ${e.executeAt} (${timeLabel})` +
          (e.reason ? `  -- ${e.reason}` : "")
        )
      })

      return lines.join("\n")
    },
  })

  const cancel = tool({
    description:
      "Cancel a previously scheduled command by its schedule ID. " +
      "Only pending commands can be cancelled.",
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
        type: "command.cancelled",
        payload: {
          scheduleId: args.scheduleId,
          reason: args.reason ?? "",
        },
      })

      return `Cancelled /${entry.command} ${entry.arguments} (${args.scheduleId})`
    },
  })

  const reschedule = tool({
    description:
      "Change the execution time of a pending scheduled command.",
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

      await store.append({
        type: "command.rescheduled",
        payload: {
          scheduleId: args.scheduleId,
          executeAt: args.newExecuteAt,
          reason: args.reason ?? "",
        },
      })

      return `Rescheduled ${args.scheduleId} to ${args.newExecuteAt}`
    },
  })

  return { schedule, list, cancel, reschedule }
}
