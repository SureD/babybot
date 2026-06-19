# Repository Guidelines

## Project Structure & Module Organization

The repository is a pnpm workspace:

- `apps/server` contains the Fastify local server and composition root.
- `apps/web` contains the React/Vite browser interface.
- `packages/core` contains use cases and the provider-neutral agent protocol.
- `packages/storage` owns SQLite persistence and project directories.
- `packages/kimi-code-backend` is the only kimi-code SDK integration point.
- `packages/contracts` contains shared schemas and API types.
- `packages/capability-runtime` contains the capability execution boundary.
- `docs` contains product, architecture, and development documentation.

Keep Babybot separate from the kimi-code repository. Babybot owns the Web app,
local server, project and task state, orchestration, capability runtime, and
storage. Access kimi-code only through the Agent Backend Module and its SDK.

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

Use `pnpm kimi:build`, `pnpm kimi:typecheck`, and `pnpm kimi:test` for the
adjacent kimi-code repository. See `docs/DEVELOPMENT.md` for debugging.

## Coding Style & Naming Conventions

Use two-space indentation and single quotes in TypeScript. Use `PascalCase` for
types and classes, `camelCase` for functions and variables, and `kebab-case` for
packages and directories. Keep provider-specific code inside its adapter.
Run oxlint and TypeScript before submitting changes.

## Testing Guidelines

Tests use Vitest and end in `.test.ts`. Cover business behavior in
`packages/core`, persistence in `packages/storage`, and API integration in
`apps/server`. Agent protocol changes require contract tests for event
translation, session reuse, cancellation, and token accounting.

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
