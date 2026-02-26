# @toxicpine/opencode-agenda-plugin

An OpenCode plugin that lets agents schedule their own future work. An agent in a conversation can set actions to fire later -- after a delay, or when another agent emits a signal -- enabling autonomous multi-step workflows without a human re-prompting at each stage.

Everything is **project-scoped**: one shared agenda and event bus across all sessions. Agents can dispatch work to existing sessions, or spin up new ones.

## What it enables

- **Self-directed iteration**: an agent works a step, then schedules a command to continue later with fresh context.
- **Event-driven pipelines**: one agent emits "tests.passed"; a deploy command, waiting on that event, fires immediately.
- **Convergence**: an item waits for *all* of ["auth.done", "users.done", "gateway.done"] before firing integration tests.
- **Zero-cost trigger chains**: a timeout fires an emit, which cancels a rollback item -- no LLM invocations in the chain.
- **Parallel delegation**: schedule commands into new sessions, converge with an `all`-mode event trigger.
- **Sagas and rollbacks**: schedule compensating actions on failure events, cancel them on success.

All state lives in an append-only event log (`.opencode/agenda/events.jsonl`). The agenda is always derivable by replaying the log.

## Tools

| Tool | What it does |
|---|---|
| `agenda_create` | Create a trigger+action pair |
| `agenda_list` | List items, filterable by status, trigger type, action type |
| `agenda_cancel` | Cancel a pending item |
| `agenda_emit` | Emit a named event on the project bus |
| `agenda_events` | List recent bus events |
| `agenda_pause` | Pause the agenda (persisted across restarts) |
| `agenda_resume` | Resume the agenda |

## Triggers

**Time**: fires at a wall-clock ISO 8601 timestamp.

**Event**: fires on a bus event kind. Supports `any` (fire on first match) or `all` (wait for every listed kind). Optional `expiresAt` for auto-expiry.

## Actions

| Action | Effect | LLM cost | Blocking? |
|---|---|---|---|
| `command` | Invoke a slash command in a session (or create a new one) | Yes | Yes (sync) |
| `subtask` | Spawn an async child session via `promptAsync` with `SubtaskPartInput` | Yes | No (fire-and-forget) |
| `emit` | Emit a bus event | Zero | No |
| `cancel` | Cancel another pending item | Zero | No |
| `schedule` | Create a new agenda item | Zero | No |

`command` blocks the poll loop until the LLM responds. `subtask` dispatches immediately and returns — the session runs in the background. Both check the SDK's `{ data, error }` response and record `agenda.failed` on errors.

Zero-cost actions (`emit`, `cancel`, `schedule`) run directly in the plugin. Combined with event triggers, this enables arbitrarily complex trigger chains at zero token cost, with a cascade depth cap (default 8) preventing runaway chains.

## Safety rails

- Max 10 pending per session, 30 per project
- Min 60s between time triggers
- Max 5 pending per event kind
- Bus emission capped at 30 per session per hour
- Cascade depth capped at 8
- Global pause/resume via `agenda_pause` / `agenda_resume` tools

## User-facing commands

Copy `commands/` into `.opencode/commands/`:

- `/agenda` -- show all items and recent events
- `/agenda-clear` -- cancel everything pending
- `/agenda-pause` -- pause the agenda
- `/agenda-resume` -- resume the agenda

## Notifications

Toasts on every lifecycle event: created, cancelled, executed, failed, expired, emitted. Agenda context injected into compaction prompts so the model retains awareness across context resets.

## Teaching agents to use it

The companion **[opencode-agenda-skill](https://github.com/ToxicPine/opencode-agenda-skill)** teaches agents how to self-orchestrate effectively -- creating commands, structuring task files, and applying patterns like Ralph Loops, event pipelines, convergence, sagas, and evaluator-optimizer loops.

## Install

Requires [Bun](https://bun.sh) (OpenCode uses it to load plugins).

### From npm

Add the package name to the `plugin` array in your project's `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@toxicpine/opencode-agenda-plugin"]
}
```

OpenCode installs the package automatically at startup.

### From local files

Clone this repo somewhere on disk. Add it as a dependency in `.opencode/package.json`:

```json
{
  "dependencies": {
    "@toxicpine/opencode-agenda-plugin": "file:../path/to/opencode-agenda-plugin"
  }
}
```

Then add it to the `plugin` array in `opencode.json` as above. OpenCode runs `bun install` at startup to resolve the local dependency.

### Commands

Copy the `commands/` directory into `.opencode/commands/` to get the `/agenda`, `/agenda-clear`, `/agenda-pause`, and `/agenda-resume` user commands.

## License

MIT
