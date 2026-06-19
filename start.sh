#!/usr/bin/env bash

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

WEB_URL="http://127.0.0.1:5173"
PNPM=(npx --yes pnpm@10.33.0)

open_browser() {
  if command -v open >/dev/null 2>&1; then
    open "$WEB_URL"
  else
    printf 'Open %s in your browser.\n' "$WEB_URL"
  fi
}

listener_pids() {
  {
    lsof -tiTCP:5173 -sTCP:LISTEN 2>/dev/null || true
    lsof -tiTCP:8787 -sTCP:LISTEN 2>/dev/null || true
  } | sort -u
}

service_root_pid() {
  local candidate="$1"
  local parent
  local parent_command

  while true; do
    parent="$(ps -o ppid= -p "$candidate" 2>/dev/null | tr -d ' ')"
    if [[ -z "$parent" || "$parent" == "0" || "$parent" == "1" ]]; then
      break
    fi

    parent_command="$(ps -o command= -p "$parent" 2>/dev/null || true)"
    if [[ "$parent_command" == *"$ROOT_DIR"* ||
      "$parent_command" == *pnpm*dev* ||
      "$parent_command" == *node*--watch*src/index.ts* ]]; then
      candidate="$parent"
      continue
    fi
    break
  done

  printf '%s\n' "$candidate"
}

process_tree_pids() {
  local pid="$1"
  local child

  printf '%s\n' "$pid"
  while read -r child; do
    [[ -n "$child" ]] && process_tree_pids "$child"
  done < <(pgrep -P "$pid" 2>/dev/null || true)
}

stop_existing_services() {
  local listeners
  local roots
  local targets
  local remaining
  local pid

  listeners="$(listener_pids)"
  [[ -z "$listeners" ]] && return

  printf 'Stopping the existing Babybot services...\n'
  roots="$(
    while read -r pid; do
      [[ -n "$pid" ]] && service_root_pid "$pid"
    done <<< "$listeners"
  )"
  roots="$(printf '%s\n' "$roots" | sort -u)"
  targets="$(
    while read -r pid; do
      [[ -n "$pid" && "$pid" != "$$" ]] && process_tree_pids "$pid"
    done <<< "$roots"
  )"
  targets="$(printf '%s\n' "$targets" | sort -u)"

  if [[ -n "$targets" ]]; then
    # Word splitting is intentional: kill receives one argument per PID.
    kill -TERM $targets 2>/dev/null || true
  fi

  for _ in {1..40}; do
    [[ -z "$(listener_pids)" ]] && return
    sleep 0.25
  done

  printf 'Existing services did not stop cleanly; forcing shutdown...\n'
  remaining="$(listener_pids)"
  if [[ -n "$remaining" ]]; then
    # Word splitting is intentional: kill receives one argument per PID.
    kill -KILL $remaining 2>/dev/null || true
  fi
}

stop_existing_services

if ! command -v node >/dev/null 2>&1; then
  printf 'Node.js 24.15.0 or newer is required.\n' >&2
  exit 1
fi

if ! node -e '
  const [major, minor, patch] = process.versions.node.split(".").map(Number);
  process.exit(major > 24 || (major === 24 && (minor > 15 || (minor === 15 && patch >= 0))) ? 0 : 1);
'; then
  printf 'Node.js 24.15.0 or newer is required; found %s.\n' "$(node --version)" >&2
  exit 1
fi

if [[ ! -f .env ]]; then
  cp .env.example .env
  printf 'Created .env from .env.example.\n'
fi

# Older .env files used a blank value that kimi-code interpreted as a path.
if grep --extended-regexp --quiet '^[[:space:]]*KIMI_CODE_HOME=[[:space:]]*$' .env; then
  export KIMI_CODE_HOME="$HOME/.kimi-code"
fi

if [[ ! -d node_modules ]]; then
  printf 'Installing Babybot dependencies...\n'
  "${PNPM[@]}" install
fi

KIMI_REPO="${KIMI_CODE_REPO:-../Dev/kimi-code}"
if [[ ! -d "$KIMI_REPO" ]]; then
  printf 'kimi-code was not found at %s. Set KIMI_CODE_REPO and run again.\n' "$KIMI_REPO" >&2
  exit 1
fi

if [[ ! -d "$KIMI_REPO/node_modules" ]]; then
  printf 'Installing kimi-code dependencies...\n'
  "${PNPM[@]}" kimi:install
fi

(
  for _ in {1..60}; do
    if curl --silent --fail "$WEB_URL" >/dev/null 2>&1; then
      open_browser
      exit 0
    fi
    sleep 1
  done
) &

printf 'Starting Babybot at %s\n' "$WEB_URL"
exec "${PNPM[@]}" dev
