# opencode-scheduler-plugin

An OpenCode plugin that lets agents schedule their own future work. An agent in a conversation can set actions to fire later -- after a delay, or when another agent emits a signal -- enabling autonomous multi-step workflows without a human re-prompting at each stage.

Everything is **project-scoped**: one shared schedule and event bus across all sessions. Agents can dispatch work to existing sessions, or spin up new ones.

## What it enables

- **Self-directed iteration**: an agent works a step, then schedules a command to continue later with fresh context.
- **Event-driven pipelines**: one agent emits "tests.passed"; a deploy command, waiting on that event, fires immediately.
- **Convergence**: a schedule waits for *all* of ["auth.done", "users.done", "gateway.done"] before firing integration tests.
- **Zero-cost trigger chains**: a timeout fires an emit, which cancels a rollback schedule -- no LLM invocations in the chain.
- **Parallel delegation**: schedule commands into new sessions, converge with an `all`-mode event trigger.
- **Sagas and rollbacks**: schedule compensating actions on failure events, cancel them on success.

All state lives in an append-only event log (`.opencode/scheduler/events.jsonl`). The schedule is always derivable by replaying the log.

## Tools

| Tool | What it does |
|---|---|
| `schedule` | Create a trigger+action pair |
| `schedule_list` | List schedules, filterable by status, trigger type, action type |
| `schedule_cancel` | Cancel a pending schedule |
| `bus_emit` | Emit a named event on the project bus |
| `bus_events` | List recent bus events |

## Triggers

**Time**: fires at a wall-clock ISO 8601 timestamp.

**Event**: fires on a bus event kind. Supports `any` (fire on first match) or `all` (wait for every listed kind). Optional `expiresAt` for auto-expiry.

## Actions

| Action | Effect | LLM cost |
|---|---|---|
| `command` | Invoke a slash command in a session (or create a new one) | Yes |
| `emit` | Emit a bus event | Zero |
| `cancel` | Cancel another pending schedule | Zero |
| `schedule` | Create a new schedule | Zero |

Non-command actions run directly in the scheduler. Combined with event triggers, this enables arbitrarily complex trigger chains at zero token cost, with a cascade depth cap (default 8) preventing runaway chains.

## Safety rails

- Max 10 pending per session, 30 per project
- Min 60s between time triggers
- Max 5 pending per event kind
- Doom loop: same command blocked after 4 recent failures
- Bus emission capped at 30 per session per hour
- Cascade depth capped at 8
- Global pause via `/schedule-pause`

## User-facing commands

Copy `commands/` into `.opencode/commands/`:

- `/schedule` -- show all schedules and recent events
- `/schedule-clear` -- cancel everything pending
- `/schedule-pause` -- stop the scheduler from firing

## Notifications

Toasts on every lifecycle event: scheduled, cancelled, executed, failed, expired, emitted. Schedule context injected into compaction prompts so the model retains awareness across context resets.

## Teaching agents to use it

The companion **[opencode-scheduler-skill](https://github.com/ToxicPine/opencode-scheduler-skill)** teaches agents how to self-orchestrate effectively -- creating commands, structuring task files, and applying patterns like Ralph Loops, event pipelines, convergence, sagas, and evaluator-optimizer loops.

## Install

Add to `.opencode/package.json` and reference `SchedulerPlugin` in plugin config, or copy `src/` into `.opencode/plugins/`.

## License

MIT
