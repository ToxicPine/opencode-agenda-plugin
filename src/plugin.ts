/**
 * OpenCode plugin entry point.
 *
 * Runs two polling loops (time triggers + event matching/expiry).
 * Executes actions directly: command (LLM), emit/cancel/schedule (no LLM).
 * Cascades within a tick up to maxCascadeDepth.
 *
 * A per-tick mutex prevents overlapping poll cycles from processing the
 * same entry twice. Interval IDs are tracked for defensive cleanup.
 */

import type { Plugin, PluginInput } from "@opencode-ai/plugin"
import { readFile } from "fs/promises"
import path from "path"
import {
  EventStore,
  generateId,
  type AgendaEntry,
  type Action,
  type TimeTrigger,
  type EventTrigger,
} from "./event-store.js"
import { createTools } from "./tools.js"
import { DEFAULT_SAFETY, pauseViolation, type SafetyConfig } from "./safety.js"

const POLL_INTERVAL_MS = 5_000

type Client = PluginInput["client"]

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const toast = async (
  client: Client,
  title: string,
  message: string,
  variant: "success" | "info" | "warning" | "error",
): Promise<void> => {
  try {
    await client.tui.showToast({ body: { title, message, variant } })
  } catch {
    // TUI may not be available (headless, tests)
  }
}

// ---------------------------------------------------------------------------
// Action executor
// ---------------------------------------------------------------------------

const executeAction = async (
  client: Client,
  store: EventStore,
  entry: AgendaEntry,
  safetyConfig: SafetyConfig,
  triggeredByEvent: string | undefined,
  depth: number,
  processEmit: (kind: string, depth: number) => Promise<void>,
): Promise<void> => {
  const { action } = entry

  try {
    switch (action.type) {
      case "command": {
        let sessionId = action.sessionId
        if (sessionId === "new") {
          const session = await client.session.create({
            body: { title: `Agenda: /${action.command} ${action.arguments}`.trim() },
          })
          sessionId = (session as any)?.data?.id ?? (session as any)?.id
          if (!sessionId) throw new Error("Failed to create new session")
        }
        await client.session.command({
          path: { id: sessionId },
          body: { command: action.command, arguments: action.arguments },
        })
        await store.append({
          type: "agenda.executed",
          payload: {
            agendaId: entry.agendaId,
            result: "success",
            triggeredByEvent,
            actualSessionId: sessionId,
          },
        })
        await toast(client, "Command Executed", `/${action.command} ${action.arguments} (${entry.agendaId})`, "success")
        break
      }

      case "emit": {
        await store.append({
          type: "bus.emitted",
          payload: {
            eventId: generateId("bus"),
            kind: action.kind,
            message: action.message,
            sessionId: "agenda",
          },
        })
        await store.append({
          type: "agenda.executed",
          payload: { agendaId: entry.agendaId, result: "emitted", triggeredByEvent },
        })
        await toast(client, "Event Emitted (agenda)", `"${action.kind}": ${action.message}`, "info")
        await processEmit(action.kind, depth + 1)
        break
      }

      case "cancel": {
        const target = store.entries().find((e) => e.agendaId === action.scheduleId)
        if (target && target.status === "pending") {
          await store.append({
            type: "agenda.cancelled",
            payload: { agendaId: action.scheduleId, reason: action.reason },
          })
          await toast(client, "Agenda Cancelled (cascade)", `${action.scheduleId}: ${action.reason}`, "warning")
        }
        await store.append({
          type: "agenda.executed",
          payload: { agendaId: entry.agendaId, result: "cancelled-target", triggeredByEvent },
        })
        break
      }

      case "schedule": {
        const newId = generateId("agn")
        await store.append({
          type: "agenda.created",
          payload: {
            agendaId: newId,
            trigger: action.trigger,
            action: action.action,
            reason: action.reason,
            createdBy: "agenda",
          },
        })
        await store.append({
          type: "agenda.executed",
          payload: { agendaId: entry.agendaId, result: `created-${newId}`, triggeredByEvent },
        })
        await toast(client, "Agenda Created (cascade)", `${newId}: ${action.reason}`, "info")
        break
      }
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    await store.append({
      type: "agenda.failed",
      payload: { agendaId: entry.agendaId, error: message, triggeredByEvent },
    })
    await toast(client, "Agenda Failed", `${entry.agendaId}: ${message}`, "error")
  }
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export const AgendaPlugin: Plugin = async ({ client, directory }) => {
  const store = new EventStore(directory)
  await store.init()

  const safetyConfig: SafetyConfig = { ...DEFAULT_SAFETY }

  // Restore pause state from config file
  try {
    const configPath = path.join(directory, ".opencode", "agenda", "config.json")
    const raw = await readFile(configPath, "utf-8")
    const config = JSON.parse(raw)
    if (typeof config.paused === "boolean") {
      safetyConfig.paused = config.paused
    }
  } catch {
    // No config file or invalid JSON — use defaults
  }

  const tools = createTools(store, safetyConfig, directory)

  let lastBusTimestamp = new Date().toISOString()
  let processing = false

  /** Process a newly emitted event kind — find matching entries, execute, cascade. */
  const processEmit = async (kind: string, depth: number): Promise<void> => {
    if (depth >= safetyConfig.maxCascadeDepth) return

    const matching = store.matchingEntries(kind)
    for (const entry of matching) {
      // Re-check: entry may have been consumed by a prior iteration in this loop
      const current = store.pending()
      if (!current.find((e) => e.agendaId === entry.agendaId)) continue
      await executeAction(client, store, entry, safetyConfig, kind, depth, processEmit)
    }
  }

  // Time trigger tick
  const timeTick = async (): Promise<void> => {
    if (processing || pauseViolation(safetyConfig)) return
    processing = true
    try {
      const pending = store.pending("time")
      const now = Date.now()
      for (const entry of pending) {
        if (entry.trigger.type !== "time") continue
        if (new Date(entry.trigger.executeAt).getTime() > now) continue
        await executeAction(client, store, entry, safetyConfig, undefined, 0, processEmit)
      }
    } finally {
      processing = false
    }
  }

  // Event trigger tick (expiry + new bus events)
  const eventTick = async (): Promise<void> => {
    if (processing || pauseViolation(safetyConfig)) return
    processing = true
    try {
      const now = Date.now()

      // Expire stale event-triggered entries
      for (const entry of store.pending("event")) {
        if (
          entry.trigger.type === "event" &&
          entry.trigger.expiresAt &&
          new Date(entry.trigger.expiresAt).getTime() <= now
        ) {
          await store.append({
            type: "agenda.expired",
            payload: { agendaId: entry.agendaId },
          })
          await toast(client, "Agenda Expired", entry.agendaId, "warning")
        }
      }

      // Process new bus events since last tick
      const allBus = store.busEvents()
      const newEvents = allBus.filter((e) => e.timestamp > lastBusTimestamp)
      if (newEvents.length === 0) return
      lastBusTimestamp = newEvents[newEvents.length - 1].timestamp

      for (const busEvt of newEvents) {
        await processEmit(busEvt.kind, 0)
      }
    } finally {
      processing = false
    }
  }

  // Start polling loops (staggered to avoid simultaneous first tick)
  const timeInterval = setInterval(timeTick, POLL_INTERVAL_MS)
  const eventInterval = setInterval(eventTick, POLL_INTERVAL_MS)

  // -----------------------------------------------------------------------
  // Plugin hooks
  // -----------------------------------------------------------------------
  return {
    tool: {
      agenda_create: tools.create,
      agenda_list: tools.list,
      agenda_cancel: tools.cancel,
      agenda_emit: tools.emit,
      agenda_events: tools.events,
      agenda_pause: tools.pause,
      agenda_resume: tools.resume,
    },

    "tool.execute.after": async (input, output) => {
      if (input.tool === "agenda_create")
        await toast(client, "Agenda Created", String(output.output).split("\n")[0], "info")
      if (input.tool === "agenda_cancel")
        await toast(client, "Agenda Cancelled", String(output.output), "warning")
      if (input.tool === "agenda_emit")
        await toast(client, "Event Emitted", String(output.output).split("\n")[0], "info")
    },

    "experimental.session.compacting": async (_input, output) => {
      const pending = store.pending()
      if (pending.length === 0) return

      const timeEntries = pending.filter(
        (s): s is AgendaEntry & { trigger: TimeTrigger } => s.trigger.type === "time",
      )
      const eventEntries = pending.filter(
        (s): s is AgendaEntry & { trigger: EventTrigger } => s.trigger.type === "event",
      )

      let ctx = `## Active Project Agenda\n\n`
      if (timeEntries.length > 0) {
        ctx += `### Time-Triggered (${timeEntries.length})\n`
        ctx += timeEntries.map((s) => {
          const act = s.action.type === "command" ? `/${s.action.command}` : s.action.type
          return `- [${s.agendaId}] ${act} at ${s.trigger.executeAt}` + (s.reason ? ` -- ${s.reason}` : "")
        }).join("\n") + "\n\n"
      }
      if (eventEntries.length > 0) {
        ctx += `### Event-Triggered (${eventEntries.length})\n`
        ctx += eventEntries.map((s) => {
          const act = s.action.type === "command" ? `/${s.action.command}` : s.action.type
          const kinds = Array.isArray(s.trigger.eventKind) ? s.trigger.eventKind : [s.trigger.eventKind]
          const mode = s.trigger.matchMode ?? "any"
          return `- [${s.agendaId}] ${act} on ${mode}(${kinds.join(", ")})` + (s.reason ? ` -- ${s.reason}` : "")
        }).join("\n") + "\n\n"
      }
      output.context.push(ctx)
    },

    event: async ({ event }) => {
      if (event.type === "session.idle") {
        const pending = store.pending()
        if (pending.length > 0)
          await toast(client, "Pending Agenda", `${pending.length} item(s) active in project`, "info")
      }
    },
  }
}
