# Architecture

This document describes the internal architecture of `opencode-agenda-plugin`.

---

## Module Dependency Graph

```mermaid
graph TD
    A["agenda.ts<br/>(entry point)"] --> P["src/plugin.ts<br/>(AgendaPlugin)"]
    P --> T["src/tools.ts<br/>(createTools)"]
    P --> E["src/event-store.ts<br/>(EventStore, types)"]
    P --> S["src/safety.ts<br/>(pauseViolation)"]
    T --> E
    T --> S
    I["src/index.ts<br/>(barrel, npm only)"] --> P
    I --> E
    I --> T
    I --> S

    style A fill:#e8f5e9,stroke:#2e7d32
    style I fill:#fff3e0,stroke:#e65100
```

**Two entry points exist by design:**

| Entry point | Consumer | What it exports |
|---|---|---|
| `agenda.ts` | OpenCode plugin loader (local file install) and `dist/agenda.js` (npm `main`) | Only `AgendaPlugin` |
| `src/index.ts` | npm consumers who import types or internals (`dist/src/index.js`) | Everything: plugin, store, tools, safety, all types |

OpenCode's plugin loader calls every export of a plugin file as a plugin function. If `index.ts` (which also exports `EventStore`, `createTools`, etc.) were the entry point, the loader would break. This is why `agenda.ts` exists as a minimal re-export.

---

## Type Hierarchy (Discriminated Unions)

All domain types use **discriminated unions** on the `type` field. No `Record<string, unknown>` payloads, no `as` casts on payload fields.

```mermaid
graph TD
    subgraph Trigger ["Trigger (discriminated on type)"]
        TT["TimeTrigger<br/>type: 'time'<br/>executeAt: string"]
        ET["EventTrigger<br/>type: 'event'<br/>eventKind: string | string[]<br/>matchMode?: 'any' | 'all'<br/>expiresAt?: string"]
    end

    subgraph Action ["Action (discriminated on type)"]
        CA["CommandAction<br/>type: 'command'<br/>command, arguments, sessionId"]
        EA["EmitAction<br/>type: 'emit'<br/>kind, message"]
        XA["CancelAction<br/>type: 'cancel'<br/>scheduleId, reason"]
        SA["ScheduleAction<br/>type: 'schedule'<br/>action: Action, trigger: Trigger, reason"]
    end

    subgraph StoreEvent ["StoreEvent (discriminated on type)"]
        SE1["agenda.created<br/>→ agendaId, trigger, action, reason, createdBy"]
        SE2["agenda.cancelled<br/>→ agendaId, reason"]
        SE3["agenda.executed<br/>→ agendaId, result, triggeredByEvent?, actualSessionId?"]
        SE4["agenda.failed<br/>→ agendaId, error, triggeredByEvent?"]
        SE5["agenda.expired<br/>→ agendaId"]
        SE6["bus.emitted<br/>→ eventId, kind, message, sessionId"]
    end
```

`ScheduleAction` is recursive: it embeds both `Action` and `Trigger`, enabling cascading schedule creation without LLM involvement.

---

## Event-Sourcing Data Flow

The system is fully event-sourced. All state is derived from an append-only JSONL log.

```mermaid
flowchart LR
    subgraph Writes
        Tool["LLM Tool Call<br/>(agenda_create, agenda_emit, ...)"]
        Executor["Action Executor<br/>(poll tick)"]
    end

    Tool --> Append["EventStore.append()"]
    Executor --> Append

    Append --> Disk["Append to<br/>.opencode/agenda/events.jsonl"]
    Append --> Cache["Update in-memory<br/>agendaMap + busLog"]

    subgraph Reads ["All reads from cache"]
        List["store.entries()"]
        Pending["store.pending()"]
        Bus["store.busEvents()"]
        Match["store.matchingEntries()"]
    end

    Cache --> List
    Cache --> Pending
    Cache --> Bus
    Cache --> Match
```

**Key property:** Disk is read once at `init()`. Every subsequent `append()` writes one line to disk and updates the in-memory cache. Reads never touch disk. This avoids full-file replay on every 5-second poll tick.

The only `as` cast in the store is `as StoreEvent` at the `JSON.parse` boundary during init replay — this is the accepted JSON deserialization boundary.

---

## Poll Loop & Task Queue

A single `setInterval` loop runs every 5 seconds. Each tick follows a three-phase pipeline: **expire → enqueue → drain**.

An idempotent task queue (`Map<agendaId, triggeredByEvent>`) sits between trigger detection and execution. Multiple sources can enqueue the same ID — the second call is a no-op. This eliminates the need for a mutex or any coordination between trigger types.

```mermaid
flowchart TD
    Start["Plugin init"] --> Init["EventStore.init()<br/>(replay JSONL → cache)"]
    Init --> RestorePause["Read config.json<br/>→ restore paused state"]
    RestorePause --> Loop["Start setInterval (5s)"]

    Loop --> Tick["tick()"]
    Tick --> Paused{"paused?"}
    Paused -- yes --> Skip["skip"]
    Paused -- no --> Phase1

    subgraph Phase1 ["Phase 1: Expire"]
        Expire["For each pending event trigger<br/>where expiresAt ≤ now:<br/>append agenda.expired"]
    end

    Phase1 --> Phase2

    subgraph Phase2 ["Phase 2: Enqueue"]
        EnqTime["Time triggers where<br/>executeAt ≤ now<br/>→ enqueue(agendaId)"]
        EnqBus["New bus events since<br/>lastBusTimestamp<br/>→ enqueueMatchingEntries(kind)"]
    end

    Phase2 --> Phase3

    subgraph Phase3 ["Phase 3: Drain"]
        DrainLoop{"queue.size > 0<br/>AND depth < maxCascadeDepth?"}
        DrainLoop -- no --> Done["tick complete"]
        DrainLoop -- yes --> Batch["Take batch = [...queue]<br/>queue.clear()"]
        Batch --> ExecLoop["For each agendaId in batch:<br/>skip if not pending,<br/>executeAction()"]
        ExecLoop --> Cascade["Emit actions return kind →<br/>enqueueMatchingEntries(kind)"]
        Cascade --> Depth["depth++"]
        Depth --> DrainLoop
    end
```

**Why a Map, not a Set:** The map value tracks `triggeredByEvent` — the bus event kind that caused the enqueue — which gets recorded in the `agenda.executed` event for audit. The idempotency property comes from the key: if an agendaId is already in the map, `enqueue()` is a no-op.

---

## Cascade Execution

Cascade is what happens when an action's side effect triggers another pending item. Instead of recursive function calls, cascade emerges naturally from the drain loop:

1. `executeAction()` for an emit action returns `["tests.passed"]`
2. `enqueueMatchingEntries("tests.passed")` adds matching pending items to the queue
3. The drain loop iterates again, picking up the newly enqueued items
4. Repeat until the queue is empty or `maxCascadeDepth` (default 8) drain iterations reached

This is **breadth-first** — all items from one wave execute before the next wave's items. No recursive calls, no depth parameter threaded through functions.

```mermaid
sequenceDiagram
    participant Tick as tick()
    participant Queue as Queue (Map)
    participant Drain as drain()
    participant Exec as executeAction()
    participant Store as EventStore

    Tick->>Queue: enqueue ready time triggers
    Tick->>Queue: enqueue bus-event matches
    Tick->>Drain: drain()

    loop depth < maxCascadeDepth AND queue not empty
        Drain->>Queue: batch = [...queue], queue.clear()
        loop For each agendaId in batch
            Drain->>Store: lookup entry, skip if not pending
            Drain->>Exec: executeAction(entry)
            Exec->>Store: append events (executed, bus.emitted, etc.)
            Exec-->>Drain: return emitted kinds []

            alt emitted kinds not empty
                Drain->>Store: matchingEntries(kind)
                Drain->>Queue: enqueue matching entries
            end
        end
        Note over Drain: depth++, loop back to check queue
    end
```

**Zero-cost actions** (`emit`, `cancel`, `schedule`) execute directly in the plugin process — no LLM tokens consumed. Only `command` actions invoke slash commands in sessions, which cost tokens.

The pending guard (`entry.status !== "pending"`) at drain time prevents double-execution — if a cancel action in the same batch already consumed an entry, it's skipped.

---

## OpenCode Integration Points

```mermaid
flowchart LR
    subgraph OpenCode ["OpenCode Runtime"]
        Loader["Plugin Loader"]
        LLM["LLM Session"]
        TUI["Toast UI"]
        Compact["Session Compaction"]
        Idle["session.idle event"]
    end

    subgraph Plugin ["AgendaPlugin"]
        Tools["7 Tools<br/>(agenda_*)"]
        Hook1["tool.execute.after"]
        Hook2["experimental.session.compacting"]
        Hook3["event handler"]
        Polls["Poll Loop"]
    end

    Loader -->|"loads agenda.ts"| Plugin
    LLM <-->|"tool calls"| Tools
    Hook1 -->|"toast on create/cancel/emit"| TUI
    Polls -->|"toast on execute/fail/expire"| TUI
    Compact -->|"injects pending items"| Hook2
    Idle -->|"reminder toast"| Hook3
    Polls -->|"session.command()"| LLM

    subgraph Persistence ["Project-Scoped Files"]
        JSONL[".opencode/agenda/events.jsonl"]
        Config[".opencode/agenda/config.json"]
    end

    Tools --> JSONL
    Polls --> JSONL
    Tools --> Config
    Hook3 -.->|"reads pending count"| Plugin
```

**Hooks used:**

| Hook | Purpose |
|---|---|
| `tool.execute.after` | Show toast notifications after LLM tool calls |
| `experimental.session.compacting` | Inject pending agenda summary into compacted context so the LLM doesn't lose track of scheduled items after compaction |
| `event` (`session.idle`) | Show a reminder toast when a session goes idle with pending items |

**Commands (markdown files in `commands/`):**

| Command | What it does |
|---|---|
| `/agenda` | Lists pending agenda items (user-facing, no LLM cost) |
| `/agenda-clear` | Cancels all pending items |
| `/agenda-pause` | Pauses execution |
| `/agenda-resume` | Resumes execution |

---

## Safety Rails

All safety checks are **synchronous pure functions** that read from the in-memory cache.

```mermaid
flowchart TD
    Create["agenda_create tool call"] --> VC["validateCreate()"]
    Emit["agenda_emit tool call"] --> VE["validateBusEmit()"]
    Tick["Poll tick start"] --> VP["pauseViolation()"]

    VC --> C1{"pending ≥ maxPendingProject<br/>(30)?"}
    C1 -- yes --> Block["BLOCKED"]
    C1 -- no --> C2{"command action:<br/>session pending ≥ 10?"}
    C2 -- yes --> Block
    C2 -- no --> C3{"time trigger:<br/>another item within 60s?"}
    C3 -- yes --> Block
    C3 -- no --> C4{"event trigger:<br/>kind pending ≥ 5?"}
    C4 -- yes --> Block
    C4 -- no --> OK["✓ Allowed"]

    VE --> R1{"session emits in<br/>last hour ≥ 30?"}
    R1 -- yes --> Block
    R1 -- no --> OK

    VP --> P1{"paused?"}
    P1 -- yes --> SkipTick["Skip tick"]
    P1 -- no --> RunTick["Run tick"]
```

Pause state persists to `.opencode/agenda/config.json` so it survives plugin restarts.

---

## File Layout

```
opencode-agenda-plugin/
├── agenda.ts                  # Entry point (single export: AgendaPlugin)
├── package.json               # npm metadata, build scripts
├── tsconfig.json              # rootDir: ".", outDir: "dist"
├── LICENSE                    # MIT
├── README.md                  # Install + usage docs
├── ARCHITECTURE.md            # This file
├── src/
│   ├── plugin.ts              # AgendaPlugin: hooks, poll loop, task queue, action executor
│   ├── event-store.ts         # EventStore class, all domain types, pure functions
│   ├── safety.ts              # SafetyConfig, validation functions
│   ├── tools.ts               # createTools() → 7 agenda_* tools
│   └── index.ts               # Barrel exports (npm consumers only)
├── commands/
│   ├── agenda.md              # /agenda command
│   ├── agenda-clear.md        # /agenda-clear command
│   ├── agenda-pause.md        # /agenda-pause command
│   └── agenda-resume.md       # /agenda-resume command
├── dist/                      # tsc output (gitignored)
└── .github/
    └── workflows/
        └── publish.yml        # npm publish on version bump
```
