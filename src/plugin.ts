/**
 * OpenCode plugin entry point.
 *
 * - Registers the schedule/list/cancel/reschedule tools
 * - Runs a polling scheduler that fires due commands via the SDK
 * - Emits toast notifications on schedule/cancel/execute/fail events
 * - Injects schedule context into compaction prompts
 */

import type { Plugin } from "@opencode-ai/plugin"
import { EventStore } from "./event-store.js"
import { createTools } from "./tools.js"
import { DEFAULT_SAFETY, shouldFire, type SafetyConfig } from "./safety.js"

const POLL_INTERVAL_MS = 5_000

export const SchedulerPlugin: Plugin = async ({
  client,
  directory,
}) => {
  const store = new EventStore(directory)
  await store.init()

  // Safety config -- could later be loaded from .opencode/scheduler/config.json
  const safetyConfig: SafetyConfig = { ...DEFAULT_SAFETY }

  const tools = createTools(store, safetyConfig)

  // -----------------------------------------------------------------------
  // Scheduler polling loop
  // -----------------------------------------------------------------------
  const interval = setInterval(async () => {
    const fireCheck = shouldFire(safetyConfig)
    if (fireCheck) return // paused

    const pending = await store.pending()
    const now = Date.now()

    for (const entry of pending) {
      if (new Date(entry.executeAt).getTime() > now) continue

      // Time to fire
      try {
        await client.session.command({
          path: { id: entry.sessionId },
          body: {
            command: entry.command,
            arguments: entry.arguments,
          },
        })

        await store.append({
          type: "command.executed",
          payload: {
            scheduleId: entry.scheduleId,
            result: "success",
          },
        })

        // Toast: command executed
        try {
          await client.tui.showToast({
            body: {
              title: "Scheduled Command Executed",
              message: `/${entry.command} ${entry.arguments} (${entry.scheduleId})`,
              variant: "success",
            },
          })
        } catch {
          // TUI may not be running
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        await store.append({
          type: "command.failed",
          payload: {
            scheduleId: entry.scheduleId,
            error: message,
          },
        })

        try {
          await client.tui.showToast({
            body: {
              title: "Scheduled Command Failed",
              message: `/${entry.command} ${entry.arguments}: ${message}`,
              variant: "error",
            },
          })
        } catch {
          // TUI may not be running
        }
      }
    }
  }, POLL_INTERVAL_MS)

  // -----------------------------------------------------------------------
  // Plugin hooks
  // -----------------------------------------------------------------------
  return {
    // Expose tools to the model
    tool: {
      schedule: tools.schedule,
      schedule_list: tools.list,
      schedule_cancel: tools.cancel,
      schedule_reschedule: tools.reschedule,
    },

    // Toast on tool invocations so the user sees scheduling activity
    "tool.execute.after": async (input, output) => {
      if (input.tool === "schedule") {
        try {
          await client.tui.showToast({
            body: {
              title: "Command Scheduled",
              message: String(output.result).split("\n")[0],
              variant: "info",
            },
          })
        } catch {
          // TUI may not be running
        }
      }
      if (input.tool === "schedule_cancel") {
        try {
          await client.tui.showToast({
            body: {
              title: "Schedule Cancelled",
              message: String(output.result),
              variant: "warning",
            },
          })
        } catch {
          // TUI may not be running
        }
      }
    },

    // Inject active schedule into compaction context so the model
    // retains awareness of pending work across context resets
    "experimental.session.compacting": async (_input, output) => {
      const pending = await store.pending()
      if (pending.length > 0) {
        output.context.push(
          `## Active Scheduled Commands\n\n` +
            `The following commands are scheduled for future execution:\n\n` +
            pending
              .map(
                (s) =>
                  `- [${s.scheduleId}] /${s.command} ${s.arguments} at ${s.executeAt}` +
                  (s.reason ? ` -- ${s.reason}` : ""),
              )
              .join("\n") +
            `\n\nUse the schedule_list tool to see the full schedule, ` +
            `or schedule_cancel to cancel entries.`,
        )
      }
    },

    // Notify user when session goes idle and there are pending schedules
    event: async ({ event }) => {
      if (event.type === "session.idle") {
        const pending = await store.pending()
        const sessionPending = pending.filter(
          (e) => e.sessionId === (event.properties as Record<string, unknown>)?.sessionID,
        )
        if (sessionPending.length > 0) {
          try {
            await client.tui.showToast({
              body: {
                title: "Pending Schedules",
                message: `${sessionPending.length} command(s) scheduled in this session`,
                variant: "info",
              },
            })
          } catch {
            // TUI may not be running
          }
        }
      }
    },
  }
}
