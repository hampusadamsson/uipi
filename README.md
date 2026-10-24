# uipi

Web UI harness over the [pi coding agent](https://github.com/earendil-works/pi) SDK —
use pi agents (models, tools, slash commands, extensions, skills) from a browser,
with multi-session support. Local, single-user, no auth.

## Architecture

- `packages/protocol` — shared WS message types (UI-agnostic; a TUI client can be added later)
- `packages/server` — Node server, in-process pi SDK (`createAgentSessionRuntime`),
  pi-native JSONL session persistence
- `packages/web` — Svelte 5 + Vite + Tailwind 4 client

## Run

```sh
pnpm install
pnpm dev           # server on :8787 (tsx watch) + vite on :5173 (proxies /ws)
# open http://localhost:5173
```

Production:

```sh
pnpm build         # builds server (tsc) and web (vite → packages/web/dist)
pnpm start         # serves UI + WS from http://127.0.0.1:8787
```

`pnpm test` — server protocol tests (vitest).

## Credentials

Uses pi's own auth: run `pi` and `/login` once (or set provider env vars).
Server binds to 127.0.0.1 only.

## v1 feature map

- Multi-session: sidebar list (pi session dirs per cwd), attach/re-attach,
  sessions live while browser is closed
- Streaming chat with tool-call cards (collapsed, streamed bash output, diffs)
- Model & thinking-level picker, `/compact` + header button
- Slash-command autocomplete, `@file` passthrough, Enter send / Shift+Enter newline
- steer/followUp queued chips with cancel, Stop (abort)
- Extension dialogs/selects as web modals
