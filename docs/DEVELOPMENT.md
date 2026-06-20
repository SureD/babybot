# Development

## Repository Setup

Install the Babybot workspace with Node.js 24.15 or newer:

```sh
npx --yes pnpm@10.33.0 install
```

Copy `.env.example` to `.env`. Pi is the default agent backend and stores its
isolated credentials, model configuration, and sessions under `.babybot/pi`.
Override that directory with `BABYBOT_PI_HOME`.

The temporary kimi-code rollback adapter remains available during migration:

```sh
BABYBOT_AGENT_BACKEND=kimi-code
KIMI_CODE_SDK_PATH=../Dev/kimi-code/packages/node-sdk/src/index.ts
```

Only the rollback path requires the adjacent kimi-code checkout or `pnpm
kimi:*` commands.

## First-Run Setup

When Pi has no configured provider, the Web app opens setup before showing
projects:

1. Select DeepSeek or OpenRouter.
2. Enter an API key and load the provider's current model list.
3. Select a tool-capable model and save it as the Pi default.

Babybot stores API keys in `.babybot/pi/auth.json` with owner-only file mode.
Keys are never stored in SQLite or returned by the HTTP API. Model metadata is
stored in `.babybot/pi/models.json`; the selected provider and model are stored
in `.babybot/pi/babybot.json`.

Each project has a persistent Pi session under `.babybot/pi/sessions/<project-id>`.
Changing provider or model clears Babybot's saved `pi` session references, so
the next task creates a new session. Existing project files, tasks, and traces
remain intact.

`BABYBOT_PI_MODEL` locks the effective model for deployments. Leave it empty
for normal Web setup.

## Agent Runtime and Tools

`@babybot/pi-backend` embeds Pi and translates Pi events into the stable Core
event protocol. One runtime is retained per project session and reused across
tasks. The default project tools are resolved by `@babybot/tool-runtime`:

- `read`;
- `write`;
- `edit`; and
- `bash`;
- `web_fetch`; and
- `web_search` when `BABYBOT_TAVILY_API_KEY` is configured.

`@babybot/agent-harness` renders the default general-purpose Babybot profile.
The prompt includes the project identity, workspace, and exact resolved tool
names. Pi also loads applicable project `AGENTS.md` files as scoped context.

These tools run without per-call approval because the workspace belongs to the
project. The current implementation is a trusted-local runtime, not a security
sandbox: Pi's `cwd` scopes normal operation but does not prevent Bash from
accessing other host paths. Future isolation belongs behind a project runtime
boundary.

Native executable tools are represented in the Core contract and translated
to Pi custom tools by `@babybot/pi-backend`. Generated and MCP tool loading and
ChatGPT OAuth remain outside the current migration scope.

Pi still loads `AGENTS.md` files from the project hierarchy. Automatic Pi
extension, skill, prompt-template, and theme discovery is disabled so all
executable tools remain controlled by the Babybot Tool Runtime.

## Commands

```sh
pnpm dev
pnpm debug:server
pnpm debug:task
pnpm debug:task -- <task-id> [--json]
pnpm test
pnpm check
```

If pnpm is not installed globally, prefix commands with
`npx --yes pnpm@10.33.0`.

## Debugging

Use these breakpoints to follow one request:

1. `apps/server/src/app.ts`: task creation and dependency composition.
2. `packages/core/src/task-orchestrator.ts`: routing, session reuse, trace
   persistence, and completion.
3. `packages/pi-backend/src/index.ts`: Pi runtime creation and event
   translation.
4. `packages/agent-harness/src/index.ts`: agent profiles and system prompts.
5. `packages/tool-runtime/src/index.ts`: enabled project tools and execution.

Babybot stores tasks and translated events in `.babybot/babybot.sqlite`.

```sh
pnpm debug:task -- <task-id> --json | jq '.trace[] | .event'
```

Trace records can contain prompts, model output, tool arguments, tool results,
thinking deltas, and local paths. Keep the database and `.babybot/pi` local,
and remove secrets before sharing diagnostics.

## Failure Isolation

```sh
pnpm test
pnpm typecheck
pnpm debug:task -- <task-id>
```

- No task record: inspect the Web request and Fastify route.
- Pending or running without events: inspect Pi configuration and session
  creation.
- Pi events exist but the trace is incomplete: inspect `translatePiEvent`.
- Tool failure: inspect the `tool.started`, `tool.progress`, and
  `tool.completed` trace sequence.
- Provider failure: use the direct chat diagnostic to separate account/API
  errors from Pi runtime errors.

## Integration Boundary

`@babybot/core` defines provider-neutral `AgentBackend`, `AgentSession`,
`AgentEvent`, and `AgentToolRuntime` contracts. Pi and tool-specific types stay
inside their adapters. Contract changes require tests for event translation,
session reuse, cancellation, token accounting, and resolved tools.
