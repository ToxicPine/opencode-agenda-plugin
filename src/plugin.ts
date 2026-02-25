/**
 * OpenCode plugin entry point.
 *
 * Project-scoped: one scheduler per project directory. All sessions within
 * the project share the schedule and event bus.
 *
 * - Registers schedule/list/cancel + bus_emit/bus_events tools
 * - Runs two polling loops:
 *     1. Time trigger loop: fires due time-based schedules
 *     2. Event match loop: checks for newly emitted bus events that match
 *        pending event-triggered schedules, and expires stale ones
 * - Emits toast notifications on every lifecycle transition
 * - Injects schedule + bus context into compaction prompts
 */

import type { Plugin } from "@opencode-ai/plugin"
import { EventStore, type ScheduleEntry } from "./event-store.js"
import { createTools } from "./tools.js"
import { DEFAULT_SAFETY, shouldFire, type SafetyConfig } from "./safety.js"

const POLL_INTERVAL_MS = 5_000

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Fire a command into a session, creating a new session if sessionId is "new". */
async function dispatchCommand(
  client: any,
  entry: ScheduleEntry,
): Promise<string> {
  let targetSessionId = entry.sessionId

  if (targetSessionId === "new") {
    const session = await client.session.create({
      body: { title: `Scheduled: /${entry.command} ${entry.arguments}`.trim() },
    })
    // The SDK returns the session object; extract its ID
    targetSessionId =
      session?.data?.id ?? session?.id ?? (session as any)?.data?.id
    if (!targetSessionId) {
      throw new Error("Failed to create new session")
    }
  }

  await client.session.command({
    path: { id: targetSessionId },
    body: {
      command: entry.command,
      arguments: entry.arguments,
    },
  })

  return targetSessionId
}

/** Best-effort toast. Silently fails if no TUI is running. */
async function toast(
  client: any,
  title: string,
  message: string,
  variant: string,
): Promise<void> {
  try {
    await client.tui.showToast({ body: { title, message, variant } })
  } catch {
    // TUI may not be running (headless / web / SDK-only)
  }
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export const SchedulerPlugin: Plugin = async ({ client, directory }) => {
  const store = new EventStore(directory)
  await store.init()

  const safetyConfig: SafetyConfig = { ...DEFAULT_SAFETY }
  const tools = createTools(store, safetyConfig)

  // Track which bus events we've already processed so we don't re-trigger
  let lastProcessedBusEventTimestamp = new Date().toISOString()

  // -----------------------------------------------------------------------
  // Time trigger loop
  // -----------------------------------------------------------------------
  setInterval(async () => {
    const fireCheck = shouldFire(safetyConfig)
    if (fireCheck) return

    const pending = await store.pending("time")
    const now = Date.now()

    for (const entry of pending) {
      if (
        entry.trigger.type !== "time" ||
        new Date(entry.trigger.executeAt).getTime() > now
      )
        continue

      try {
        const actualSession = await dispatchCommand(client, entry)
        await store.append({
          type: "schedule.executed",
          payload: {
            scheduleId: entry.scheduleId,
            result: "success",
            actualSessionId: actualSession,
          },
        })
        await toast(
          client,
          "Scheduled Command Executed",
          `/${entry.command} ${entry.arguments} (${entry.scheduleId})`,
          "success",
        )
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        await store.append({
          type: "schedule.failed",
          payload: { scheduleId: entry.scheduleId, error: message },
        })
        await toast(
          client,
          "Scheduled Command Failed",
          `/${entry.command} ${entry.arguments}: ${message}`,
          "error",
        )
      }
    }
  }, POLL_INTERVAL_MS)

  // -----------------------------------------------------------------------
  // Event trigger loop -- match new bus events to pending event schedules,
  // and expire stale event-triggered schedules
  // -----------------------------------------------------------------------
  setInterval(async () => {
    const fireCheck = shouldFire(safetyConfig)
    if (fireCheck) return

    const now = new Date()

    // 1. Expire stale event-triggered schedules
    const pendingEvent = await store.pending("event")
    for (const entry of pendingEvent) {
      if (
        entry.trigger.type === "event" &&
        entry.trigger.expiresAt &&
        new Date(entry.trigger.expiresAt).getTime() <= now.getTime()
      ) {
        await store.append({
          type: "schedule.expired",
          payload: { scheduleId: entry.scheduleId },
        })
        await toast(
          client,
          "Schedule Expired",
          `/${entry.command} ${entry.arguments} (${entry.scheduleId}) -- event "${entry.trigger.eventKind}" never arrived`,
          "warning",
        )
      }
    }

    // 2. Find new bus events since last check
    const allBusEvents = await store.busEvents()
    const newEvents = allBusEvents.filter(
      (e) => e.timestamp > lastProcessedBusEventTimestamp,
    )
    if (newEvents.length === 0) return

    // Update watermark
    lastProcessedBusEventTimestamp = newEvents[newEvents.length - 1].timestamp

    // 3. For each new bus event, find matching pending schedules and fire them
    for (const busEvt of newEvents) {
      const matching = await store.matchingSchedules(busEvt.kind)
      for (const entry of matching) {
        // Double-check it's still pending (may have been expired above)
        const current = await store.pending()
        if (!current.find((e) => e.scheduleId === entry.scheduleId)) continue

        try {
          const actualSession = await dispatchCommand(client, entry)
          await store.append({
            type: "schedule.executed",
            payload: {
              scheduleId: entry.scheduleId,
              result: "success",
              triggeredByEvent: busEvt.eventId,
              actualSessionId: actualSession,
            },
          })
          await toast(
            client,
            "Event-Triggered Command Executed",
            `/${entry.command} ${entry.arguments} on "${busEvt.kind}" (${entry.scheduleId})`,
            "success",
          )
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err)
          await store.append({
            type: "schedule.failed",
            payload: {
              scheduleId: entry.scheduleId,
              error: message,
              triggeredByEvent: busEvt.eventId,
            },
          })
          await toast(
            client,
            "Event-Triggered Command Failed",
            `/${entry.command} ${entry.arguments}: ${message}`,
            "error",
          )
        }
      }
    }
  }, POLL_INTERVAL_MS)

  // -----------------------------------------------------------------------
  // Plugin hooks
  // -----------------------------------------------------------------------
  return {
    tool: {
      schedule: tools.schedule,
      schedule_list: tools.list,
      schedule_cancel: tools.cancel,
      bus_emit: tools.busEmit,
      bus_events: tools.busEvents,
    },

    // Toast on tool invocations so the user sees scheduling activity
    "tool.execute.after": async (input, output) => {
      if (input.tool === "schedule") {
        await toast(
          client,
          "Command Scheduled",
          String(output.result).split("\n")[0],
          "info",
        )
      }
      if (input.tool === "schedule_cancel") {
        await toast(
          client,
          "Schedule Cancelled",
          String(output.result),
          "warning",
        )
      }
      if (input.tool === "bus_emit") {
        await toast(
          client,
          "Event Emitted",
          String(output.result).split("\n")[0],
          "info",
        )
      }
    },

    // Inject active schedule + recent bus events into compaction context
    "experimental.session.compacting": async (_input, output) => {
      const pending = await store.pending()
      if (pending.length > 0) {
        const timeEntries = pending.filter((s) => s.trigger.type === "time")
        const eventEntries = pending.filter((s) => s.trigger.type === "event")

        let ctx = `## Active Project Schedule\n\n`
        if (timeEntries.length > 0) {
          ctx += `### Time-Triggered (${timeEntries.length})\n`
          ctx += timeEntries
            .map(
              (s) =>
                `- [${s.scheduleId}] /${s.command} ${s.arguments} at ${(s.trigger as any).executeAt} session:${s.sessionId}` +
                (s.reason ? ` -- ${s.reason}` : ""),
            )
            .join("\n")
          ctx += "\n\n"
        }
        if (eventEntries.length > 0) {
          ctx += `### Event-Triggered (${eventEntries.length})\n`
          ctx += eventEntries
            .map(
              (s) =>
                `- [${s.scheduleId}] /${s.command} ${s.arguments} on "${(s.trigger as any).eventKind}" session:${s.sessionId}` +
                (s.reason ? ` -- ${s.reason}` : ""),
            )
            .join("\n")
          ctx += "\n\n"
        }
        ctx +=
          "Use schedule_list / schedule_cancel / bus_emit / bus_events tools to interact."
        output.context.push(ctx)
      }
    },

    // Notify user when session goes idle and there are pending schedules
    event: async ({ event }) => {
      if (event.type === "session.idle") {
        const pending = await store.pending()
        if (pending.length > 0) {
          await toast(
            client,
            "Pending Schedules",
            `${pending.length} schedule(s) active in this project`,
            "info",
          )
        }
      }
    },
  }
}
