# Development

## Repository Setup

Babybot and kimi-code remain separate repositories. By default, Babybot expects
kimi-code in the adjacent `../Dev/kimi-code` directory. Override this without
editing source files:

```sh
export KIMI_CODE_REPO=/path/to/kimi-code
```

Install both repositories:

```sh
npx --yes pnpm@10.33.0 install
npx --yes pnpm@10.33.0 kimi:install
```

Copy `.env.example` to `.env`. During joint development, point
`KIMI_CODE_SDK_PATH` at `packages/node-sdk/src/index.ts`. Babybot then executes
the SDK TypeScript source through `tsx`, so breakpoints work in both
repositories. For a built integration, run `pnpm kimi:build` and point the
variable at `packages/node-sdk/dist/index.mjs`.

Babybot reuses the normal kimi-code home and login by default. Set
`KIMI_CODE_HOME` only when an isolated config, session store, and credential
store are required.

DeepSeek is configured as a kimi-code provider and model alias. Set
`KIMI_CODE_MODEL` to that alias when Babybot should override kimi-code's default
model. Babybot does not call DeepSeek directly; model credentials and protocol
configuration remain inside kimi-code.

## First-Run Setup

When kimi-code has no supported default provider, the Web app opens setup before
showing projects:

1. Select DeepSeek or OpenRouter.
2. Enter an API key and load the provider's current model list.
3. Select a tool-capable model and save it as the kimi-code default.

OpenRouter setup enables **Free tool-capable models only** by default. Free
models are identified from OpenRouter's `:free` model IDs or zero pricing
metadata. Babybot recommends a coding-named model first, followed by models
with reasoning support, larger context, and larger output limits. This is a
compatibility recommendation, not a benchmark ranking.

Babybot sends the key only to its local server. The kimi-code SDK validates the
provider, writes its local `config.toml`, and returns only redacted setup status.
The key is not stored in Babybot's SQLite database or returned by the API.

Changing provider or model clears Babybot's persisted kimi-code session mapping,
so the next task creates a session with the new model. Existing project files,
tasks, and traces are retained.

`KIMI_CODE_MODEL` is a deployment override. When it is set, the setup screen
cannot change the effective model. Leave it empty for normal local use.

## Commands

```sh
pnpm dev             # server and Web app
pnpm debug:server    # server inspector on port 9229
pnpm debug:task      # list recent persisted tasks
pnpm debug:task -- <task-id> [--json]  # inspect one task and its trace
pnpm test            # Babybot tests
pnpm check           # lint, types, tests, and production builds
pnpm kimi:build      # build the local kimi-code Node SDK
pnpm kimi:typecheck  # type-check the local kimi-code Node SDK
pnpm kimi:test       # run the kimi-code SDK test project
```

If pnpm is not installed globally, prefix commands with
`npx --yes pnpm@10.33.0`.

## Debugging

Open `babybot.code-workspace` in VS Code for a two-repository workspace.

- **Babybot: Full stack with kimi-code source** starts the server, Vite, and a
  browser debugger.
- **Babybot: Server with kimi-code source** starts only the server with the SDK
  source entry. Breakpoints can be placed in either repository.
- **Kimi SDK: Current Test** runs the currently open SDK test under the Node
  debugger.
- **Kimi SDK: Prompt Demo** runs kimi-code's streaming prompt example using the
  existing local login.

For terminal debugging, run `pnpm debug:server`, attach a Node debugger to
`127.0.0.1:9229`, and start the Web app separately with `pnpm dev:web`.

Use these breakpoints to follow one request through the stack:

1. `apps/server/src/app.ts`: HTTP task creation and trace endpoints.
2. `packages/core/src/task-orchestrator.ts`: route selection, session reuse,
   event persistence, and task completion.
3. `packages/kimi-code-backend/src/index.ts`: SDK loading and event translation.
4. `packages/node-sdk/src/session.ts` in kimi-code: SDK prompt, event, status,
   and usage calls.
5. `packages/node-sdk/src/rpc.ts` in kimi-code: the SDK-to-agent-core RPC
   boundary.

The Web task card shows live status, model, context occupancy, total token and
cache usage, tool calls, retries, compaction, subagents, warnings, and raw
runtime events. The UI requests only trace events after the last known sequence.

Babybot persists tasks and translated events in `.babybot/babybot.sqlite`.
Inspect the latest tasks with `pnpm debug:task`, then inspect one execution with
`pnpm debug:task -- <task-id>`. The JSON form is suitable for `jq`:

```sh
pnpm debug:task -- <task-id> --json | jq '.trace[] | .event'
```

The task's `session_id` connects the Babybot trace to kimi-code. Kimi diagnostic
logs are under the active kimi-code home, normally `~/.kimi-code/logs/`.
Session files are under `~/.kimi-code/sessions/<workdir-key>/<session-id>/`,
including `wire.jsonl` and `logs/kimi-code.log`. Set `KIMI_LOG_LEVEL=debug` to
capture provider and runtime diagnostics.

Trace records can contain prompts, model output, tool arguments, tool results,
and thinking deltas. Keep the database and kimi-code session directory local,
and remove secrets before sharing debug bundles.

## Failure Isolation

Run the smallest failing layer first:

```sh
pnpm test                            # Babybot behavior
pnpm kimi:test                       # kimi-code SDK integration
pnpm kimi:typecheck                  # kimi-code SDK contract
pnpm debug:task -- <task-id>         # persisted Babybot execution
```

- No task record: inspect the Web request and Fastify route.
- Task is pending or running without events: inspect backend availability,
  session creation, and `Session.prompt`.
- Kimi events exist but Babybot trace is incomplete: inspect
  `translateEvent`.
- Trace is complete but the task result is wrong: inspect orchestration output
  aggregation and task persistence.
- Provider or authentication failure: inspect the session log and
  `wire.jsonl`.

## Integration Boundary

`@babybot/core` defines the provider-neutral `AgentBackend`, `AgentSession`, and
`AgentEvent` contracts. The current implementation is intentionally based only
on capabilities verified against kimi-code:

- streamed message, thinking, and tool events;
- persisted, ordered execution traces with incremental reads;
- persistent session creation and resumption;
- active-turn cancellation; and
- token and cache usage.

The kimi-code adapter dynamically loads the configured SDK, translates its
events into the Babybot event vocabulary, and keeps kimi-code types out of the
core and server modules. Approval handling, questions, and sandbox control are
not part of the stable contract yet because Babybot does not expose those flows.

Each Babybot project stores one agent session reference. Reusing that session
preserves working context and avoids repeated setup tokens. New backend
capabilities should be added only after they are implemented and exercised by
the kimi-code integration.
