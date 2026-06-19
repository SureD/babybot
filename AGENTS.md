# Repository Guidelines

## Project Structure & Module Organization

The repository is a pnpm workspace:

- `apps/server` contains the Fastify local server and composition root.
- `apps/web` contains the React/Vite browser interface.
- `packages/core` contains use cases and the provider-neutral agent protocol.
- `packages/storage` owns SQLite persistence and project directories.
- `packages/pi-backend` embeds the Pi agent runtime and translates Pi events.
- `packages/tool-runtime` owns the provider-neutral project tool registry.
- `packages/kimi-code-backend` is a temporary rollback adapter during migration.
- `packages/contracts` contains shared schemas and API types.
- `packages/capability-runtime` contains the capability execution boundary.
- `docs` contains product, architecture, and development documentation.

Babybot owns the Web app, local server, project and task state, orchestration,
tool and capability runtimes, project workspaces, and storage. Pi owns the
agent loop, model transport, session history, compaction, and built-in coding
tool implementations. Keep Pi types inside `packages/pi-backend`.

Each project has one persistent Pi session and a project-owned workspace. The
default tools are `read`, `write`, `edit`, and `bash`. They are intentionally
available without per-call approval inside the project runtime. A working
directory is not a security boundary: do not describe the current trusted-local
runtime as sandboxed, and route future isolation through a project runtime
boundary instead of provider-specific checks.

Tool sources are `builtin`, `native`, `generated`, and `mcp`. New tools must
enter through the provider-neutral Tool Runtime rather than importing Pi into
Core. Generated tools remain untrusted until validation is implemented. MCP,
WebSearch, WebFetch, generated-tool loading, and ChatGPT OAuth are explicitly
out of scope for the current Pi migration. Pi may load project `AGENTS.md`
context, but automatic extension, skill, prompt-template, and theme discovery
must remain disabled until Babybot owns their lifecycle and trust policy.

Place tests under the owning module's `test/` directory. Avoid new cross-module
dependencies without updating `docs/ARCHITECTURE.md`.

## Build, Test, and Development Commands

```sh
pnpm dev
pnpm test
pnpm typecheck
pnpm lint
pnpm build
pnpm check
```

Set `BABYBOT_AGENT_BACKEND=kimi-code` only when exercising the temporary
rollback adapter. Its `pnpm kimi:*` commands remain available during migration.
See `docs/DEVELOPMENT.md` for debugging.

## Coding Style & Naming Conventions

Use two-space indentation and single quotes in TypeScript. Use `PascalCase` for
types and classes, `camelCase` for functions and variables, and `kebab-case` for
packages and directories. Keep provider-specific code inside its adapter.
Run oxlint and TypeScript before submitting changes.

## Testing Guidelines

Tests use Vitest and end in `.test.ts`. Cover business behavior in
`packages/core`, persistence in `packages/storage`, and API integration in
`apps/server`. Agent protocol changes require contract tests for event
translation, session reuse, cancellation, token accounting, and resolved
project tools.

## Commit & Pull Request Guidelines

Use short, imperative, scoped commit subjects, following the existing style:
`docs: define babybot product and architecture`. Examples include
`docs: clarify capability lifecycle` and `server: add project endpoint`.

Pull requests should explain the behavior or decision changed, list verification
performed, and link relevant issues. Include screenshots for Web UI changes and
call out architecture changes explicitly. Keep each pull request focused and
avoid unrelated formatting or refactoring.

## Security & Configuration

Never commit credentials, model API keys, personal project data, or local
machine paths. Treat generated capabilities as untrusted until verified, and
preserve clear permission boundaries between Babybot, coding backends, and
project workspaces.
