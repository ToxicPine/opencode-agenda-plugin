# opencode-scheduler-plugin

An OpenCode plugin that lets agents schedule their own future work. An agent in a conversation can set slash commands to fire later -- after a delay, or when another agent emits a signal -- enabling autonomous multi-step workflows without a human re-prompting at each stage.

Everything is **project-scoped**: one shared schedule and event bus across all sessions in the project. Agents can dispatch work to existing sessions, or spin up new ones.

## What it enables

- **Self-directed iteration**: an agent breaks a task into steps, does the first, and schedules a command to continue later with fresh context.
- **Event-driven pipelines**: one agent emits "tests.passed"; a deploy command, waiting on that event, fires immediately in another session.
- **Parallel delegation**: schedule several commands into new sessions to run concurrently, with a checkpoint command that verifies everything landed.
- **Autonomous supervision**: schedule a future audit that checks progress and cancels remaining work if the task is stuck.

All state is recorded in an append-only event log (`.opencode/scheduler/events.jsonl`). The current schedule is always derivable by replaying the log. Nothing is mutated or deleted.

## Tools exposed to the model

| Tool | What it does |
|---|---|
| `schedule` | Create a time-triggered or event-triggered schedule targeting any session (or `"new"`) |
| `schedule_list` | List schedules across the project, filterable by status, trigger type, or session |
| `schedule_cancel` | Cancel a pending schedule (to reschedule: cancel + create a new one) |
| `bus_emit` | Emit a named event on the project bus -- fires any matching event-triggered schedules |
| `bus_events` | List recent bus events across sessions |

## Triggers

**Time**: fires when wall-clock time passes a given ISO 8601 timestamp.

**Event**: fires when any session in the project emits a bus event with a matching `kind` string. Supports an optional `expiresAt` so the schedule auto-expires if the event never arrives.

## Safety rails

Hard limits enforced at schedule-creation time:

- Max 10 pending per session, 30 per project
- Min 60s between any two time-triggered schedules
- Max 5 pending schedules per event kind
- Doom loop detection: blocks if the same command has been scheduled 4+ times in the last hour without executing
- Bus emission capped at 30 per session per hour
- Global pause via `/schedule-pause`

## User-facing commands

Copy the `commands/` directory into your project's `.opencode/commands/`:

- `/schedule` -- show all schedules and recent bus events
- `/schedule-clear` -- cancel everything pending
- `/schedule-pause` -- stop the scheduler from firing

## Notifications

The plugin toasts the user on every lifecycle event: scheduled, cancelled, executed, failed, expired, and event emitted. When a session goes idle with pending schedules, it notifies. Schedule context is injected into compaction prompts so the model retains awareness across context resets.

## Teaching agents to use it

The companion **[opencode-scheduler-skill](https://github.com/ToxicPine/opencode-scheduler-skill)** is a Claude skill that teaches agents how to self-orchestrate effectively using this plugin -- including how to create custom commands as schedule targets, structure task files for cross-context persistence, and apply patterns like iterative loops, event-driven pipelines, and self-supervision.

## Install

Add to your project's `.opencode/package.json` dependencies and reference `SchedulerPlugin` in your plugin config, or copy the `src/` files directly into `.opencode/plugins/`.

## License

MIT
