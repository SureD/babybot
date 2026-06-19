# Babybot

Babybot is a local, project-based personal assistant. It keeps persistent
project workspaces and uses reusable capabilities or a coding agent to complete
tasks. The first coding backend is the `SureD/kimi-code` SDK.

## Technology

- Node.js 24 and TypeScript for one runtime and one type system.
- pnpm workspaces for explicit module boundaries.
- Fastify for the local HTTP server.
- React and Vite for the browser interface.
- Node's built-in SQLite driver for local persistence.
- Vitest and oxlint for verification.

## Modules

| Module | Location | Responsibility |
| --- | --- | --- |
| Web | `apps/web` | Project list, workspace, task input, results |
| Server | `apps/server` | HTTP API and dependency composition |
| Contracts | `packages/contracts` | Shared API schemas and data types |
| Core | `packages/core` | Project services, orchestration, agent protocol |
| Storage | `packages/storage` | SQLite data and project directories |
| Capability runtime | `packages/capability-runtime` | Capability discovery and execution boundary |
| kimi-code backend | `packages/kimi-code-backend` | Agent sessions, event translation, cancellation, usage |

## Start

Prerequisites are Node.js `24.15.0+` and pnpm `10.33.0`.

```sh
./start.sh
```

The script creates `.env`, installs missing Babybot and kimi-code dependencies,
starts the local server and Web app, and opens the browser. Run `pnpm start` as
an equivalent package command. Press `Ctrl+C` to stop both services.

Open `http://127.0.0.1:5173`. The API runs on
`http://127.0.0.1:8787`. On first launch, Babybot asks for a DeepSeek or
OpenRouter API key and a default model. The setup flow validates the key,
loads tool-capable models, and writes the selected provider to kimi-code's
local configuration. OpenRouter defaults to free `:free` models and recommends
a coding-oriented option.

Run all verification:

```sh
npx --yes pnpm@10.33.0 check
```

See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) for kimi-code integration and
debugging.
