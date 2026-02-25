/**
 * OpenCode plugin entry point.
 *
 * Runs two polling loops (time triggers + event matching/expiry).
 * Executes actions directly: command (LLM), emit/cancel/schedule (no LLM).
 * Cascades within a tick up to maxCascadeDepth.
 */

import type { Plugin } from "@opencode-ai/plugin"
import {
  EventStore,
  generateId,
  type ScheduleEntry,
  type Action,
  type TimeTrigger,
  type EventTrigger,
} from "./event-store.js"
import { createTools } from "./tools.js"
import { DEFAULT_SAFETY, shouldFire, type SafetyConfig } from "./safety.js"

const POLL_INTERVAL_MS = 5_000

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function toast(
  client: any,
  title: string,
  message: string,
  variant: string,
): Promise<void> {
  try {
    await client.tui.showToast({ body: { title, message, variant } })
  } catch {}
}

// ---------------------------------------------------------------------------
// Action executor
// ---------------------------------------------------------------------------

async function executeAction(
  client: any,
  store: EventStore,
  entry: ScheduleEntry,
  safetyConfig: SafetyConfig,
  triggeredByEvent: string | undefined,
  depth: number,
  processEmit: (kind: string, depth: number) => Promise<void>,
): Promise<void> {
  const action = entry.action

  try {
    switch (action.type) {
      case "command": {
        let sessionId = action.sessionId
        if (sessionId === "new") {
          const session = await client.session.create({
            body: { title: `Scheduled: /${action.command} ${action.arguments}`.trim() },
          })
          sessionId = session?.data?.id ?? session?.id ?? (session as any)?.data?.id
          if (!sessionId) throw new Error("Failed to create new session")
        }
        await client.session.command({
          path: { id: sessionId },
          body: { command: action.command, arguments: action.arguments },
        })
        await store.append({
          type: "schedule.executed",
          payload: {
            scheduleId: entry.scheduleId,
            result: "success",
            triggeredByEvent,
            actualSessionId: sessionId,
          },
        })
        await toast(client, "Command Executed", `/${action.command} ${action.arguments} (${entry.scheduleId})`, "success")
        break
      }

      case "emit": {
        await store.append({
          type: "bus.emitted",
          payload: {
            eventId: generateId("bus"),
            kind: action.kind,
            message: action.message,
            sessionId: "scheduler",
          },
        })
        await store.append({
          type: "schedule.executed",
          payload: { scheduleId: entry.scheduleId, result: "emitted", triggeredByEvent },
        })
        await toast(client, "Event Emitted (scheduled)", `"${action.kind}": ${action.message}`, "info")
        // Cascade: process the newly emitted event
        await processEmit(action.kind, depth + 1)
        break
      }

      case "cancel": {
        const targets = await store.materialize()
        const target = targets.find((e) => e.scheduleId === action.scheduleId)
        if (target && target.status === "pending") {
          await store.append({
            type: "schedule.cancelled",
            payload: { scheduleId: action.scheduleId, reason: action.reason },
          })
          await toast(client, "Schedule Cancelled (scheduled)", `${action.scheduleId}: ${action.reason}`, "warning")
        }
        await store.append({
          type: "schedule.executed",
          payload: { scheduleId: entry.scheduleId, result: "cancelled-target", triggeredByEvent },
        })
        break
      }

      case "schedule": {
        const newId = generateId("sch")
        await store.append({
          type: "schedule.created",
          payload: {
            scheduleId: newId,
            trigger: action.trigger,
            action: action.action,
            reason: action.reason,
            createdBy: "scheduler",
          },
        })
        await store.append({
          type: "schedule.executed",
          payload: { scheduleId: entry.scheduleId, result: `created-${newId}`, triggeredByEvent },
        })
        await toast(client, "Schedule Created (scheduled)", `${newId}: ${action.reason}`, "info")
        break
      }
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    await store.append({
      type: "schedule.failed",
      payload: { scheduleId: entry.scheduleId, error: message, triggeredByEvent },
    })
    await toast(client, "Schedule Failed", `${entry.scheduleId}: ${message}`, "error")
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

  let lastBusTimestamp = new Date().toISOString()

  /** Process a newly emitted event kind -- find matching schedules, execute, cascade. */
  async function processEmit(kind: string, depth: number): Promise<void> {
    if (depth >= safetyConfig.maxCascadeDepth) return

    const matching = await store.matchingSchedules(kind)
    for (const entry of matching) {
      // Re-check still pending
      const current = await store.pending()
      if (!current.find((e) => e.scheduleId === entry.scheduleId)) continue
      await executeAction(client, store, entry, safetyConfig, kind, depth, processEmit)
    }
  }

  // Time trigger loop
  setInterval(async () => {
    if (shouldFire(safetyConfig)) return
    const pending = await store.pending("time")
    const now = Date.now()

    for (const entry of pending) {
      if (entry.trigger.type !== "time" || new Date(entry.trigger.executeAt).getTime() > now)
        continue
      await executeAction(client, store, entry, safetyConfig, undefined, 0, processEmit)
    }
  }, POLL_INTERVAL_MS)

  // Event trigger loop (expiry + new bus events)
  setInterval(async () => {
    if (shouldFire(safetyConfig)) return
    const now = Date.now()

    // Expire stale
    const pendingEvent = await store.pending("event")
    for (const entry of pendingEvent) {
      if (
        entry.trigger.type === "event" &&
        entry.trigger.expiresAt &&
        new Date(entry.trigger.expiresAt).getTime() <= now
      ) {
        await store.append({
          type: "schedule.expired",
          payload: { scheduleId: entry.scheduleId },
        })
        await toast(client, "Schedule Expired", entry.scheduleId, "warning")
      }
    }

    // Process new bus events
    const allBus = await store.busEvents()
    const newEvents = allBus.filter((e) => e.timestamp > lastBusTimestamp)
    if (newEvents.length === 0) return
    lastBusTimestamp = newEvents[newEvents.length - 1].timestamp

    for (const busEvt of newEvents) {
      await processEmit(busEvt.kind, 0)
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

    "tool.execute.after": async (input, output) => {
      if (input.tool === "schedule")
        await toast(client, "Scheduled", String(output.result).split("\n")[0], "info")
      if (input.tool === "schedule_cancel")
        await toast(client, "Cancelled", String(output.result), "warning")
      if (input.tool === "bus_emit")
        await toast(client, "Event Emitted", String(output.result).split("\n")[0], "info")
    },

    "experimental.session.compacting": async (_input, output) => {
      const pending = await store.pending()
      if (pending.length === 0) return

      const timeEntries = pending.filter(
        (s): s is ScheduleEntry & { trigger: TimeTrigger } => s.trigger.type === "time",
      )
      const eventEntries = pending.filter(
        (s): s is ScheduleEntry & { trigger: EventTrigger } => s.trigger.type === "event",
      )

      let ctx = `## Active Project Schedule\n\n`
      if (timeEntries.length > 0) {
        ctx += `### Time-Triggered (${timeEntries.length})\n`
        ctx += timeEntries.map((s) => {
          const act = s.action.type === "command" ? `/${s.action.command}` : s.action.type
          return `- [${s.scheduleId}] ${act} at ${s.trigger.executeAt}` + (s.reason ? ` -- ${s.reason}` : "")
        }).join("\n") + "\n\n"
      }
      if (eventEntries.length > 0) {
        ctx += `### Event-Triggered (${eventEntries.length})\n`
        ctx += eventEntries.map((s) => {
          const act = s.action.type === "command" ? `/${s.action.command}` : s.action.type
          const kinds = Array.isArray(s.trigger.eventKind) ? s.trigger.eventKind : [s.trigger.eventKind]
          const mode = s.trigger.matchMode ?? "any"
          return `- [${s.scheduleId}] ${act} on ${mode}(${kinds.join(", ")})` + (s.reason ? ` -- ${s.reason}` : "")
        }).join("\n") + "\n\n"
      }
      output.context.push(ctx)
    },

    event: async ({ event }) => {
      if (event.type === "session.idle") {
        const pending = await store.pending()
        if (pending.length > 0)
          await toast(client, "Pending Schedules", `${pending.length} active in project`, "info")
      }
    },
  }
}
