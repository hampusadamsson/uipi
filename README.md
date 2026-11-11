# uipi

[![ci](https://github.com/hampusadamsson/uipi/actions/workflows/ci.yml/badge.svg)](https://github.com/hampusadamsson/uipi/actions/workflows/ci.yml)
[![docker](https://github.com/hampusadamsson/uipi/actions/workflows/docker.yml/badge.svg)](https://github.com/hampusadamsson/uipi/actions/workflows/docker.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Web UI harness over the [pi coding agent](https://github.com/earendil-works/pi) SDK —
use pi agents (models, tools, slash commands, extensions, skills) from a browser,
with multi-session support. Local, single-user, no auth.

If you already drive pi from a terminal, uipi lets you use the same agents, models,
tools and extensions from a browser instead. It is built for a single user running it
locally — there is no authentication, so it should not be exposed to the network.

## Architecture

Four packages, strictly layered — each depends only on the ones above it:

```
@uipi/protocol   wire types only          (no deps)
      ↓
@uipi/client     transport + session store (no DOM, no framework)
      ↓                      ↘
@uipi/web         Svelte adapter     (another adapter could be a TUI)
@uipi/server      Node + in-process pi SDK
```

- `packages/protocol` — shared WS message types. UI-agnostic; describes only what
  travels on the wire.
- `packages/client` — **the frontend abstraction**. `Conn` (transport with an
  injected socket factory, request correlation, capped-backoff reconnect),
  `UipiClient` (session store, pi-event → run-state reducer, every command),
  `deriveTranscript` (pi events → renderable entries) and `/s/<hash>` routing.
  No Svelte, no DOM, no browser globals. Page routes such as `/skills` live
  beside the session routes in the same route module.
- `packages/server` — Node server, in-process pi SDK (`createAgentSessionRuntime`),
  pi-native JSONL session persistence, extension UI host bridge. Config files are
  write-allowlisted by id (the browser names a document, never a path) and
  conflict-checked by mtime, so a hand edit is never silently clobbered.
- `packages/web` — Svelte 5 + Vite + Tailwind 4. A thin adapter: it mirrors
  `UipiClient` state into runes and renders shadcn-svelte components. It contains
  no protocol or reducer logic.

### Adding another frontend (e.g. a TUI)

Because `@uipi/client` owns the protocol, reducer and transcript projection, a new
frontend only supplies presentation:

```ts
import { Conn, UipiClient, deriveTranscript } from "@uipi/client";
import WebSocket from "ws"; // Node

const client = new UipiClient(
  new Conn({ url: "ws://127.0.0.1:8787/ws", createSocket: (u) => new WebSocket(u) as never }),
);

client.onChange(() => render()); // re-render on any state change
client.attach(); // connect (auto-reconnects)
await client.newSession("/my/project");
client.sendPrompt(client.activeId!, "hi");

render = () =>
  console.log(
    deriveTranscript({
      messages: client.active?.messages ?? [],
      events: client.liveEvents(client.activeId!),
    }),
  );
```

See `packages/client/test/client.test.ts` — a headless end-to-end test that drives
a full session (attach → prompt → streaming → settle → deep link) with no DOM.

## Requirements

- Node >= 22.19 (see `engines`; `.nvmrc` and CI pin the same version)
- pnpm 10+
- pi credentials in place — uipi reuses pi's own auth, so run `pi` and `/login`
  once (see [Credentials](#credentials))

## Run

```sh
nvm use            # Node 22, per .nvmrc (matches "engines" and CI)
pnpm install
pnpm dev           # server on :8787 (tsx watch) + vite on :5173 (proxies /ws)
# open http://localhost:5173
```

Production:

```sh
pnpm build         # builds server (tsc) and web (vite → packages/web/dist)
pnpm start         # serves UI + WS from http://127.0.0.1:8787
```

Container (the Dockerfile builds the workspace itself):

```sh
docker build -t uipi .
docker run -p 8787:8787 uipi
# open http://127.0.0.1:8787
```

The image serves the UI and `/ws` from the same port and already sets
`UIPI_HOST=0.0.0.0` (a container port must be reachable from the host), so the
publish flag is all you need. It runs as a non-root `uipi` user with a writable
`$HOME`, and pi credentials are _not_ baked in — mount them, e.g.
`docker run -p 8787:8787 -v ~/.pi:/home/uipi/.pi uipi`.

`pnpm test` — runs every package's tests (`@uipi/client`, `@uipi/server`, `@uipi/web`);
`@uipi/protocol` is type-only and has no tests of its own.
`pnpm lint` / `pnpm format` — ESLint + Prettier.

## Configuration

The server reads six environment variables (nothing auto-loads a `.env` file —
export them, or set them inline, e.g. `UIPI_PORT=9000 pnpm start`):

| Variable         | Default             | Purpose                                     |
| ---------------- | ------------------- | ------------------------------------------- |
| `UIPI_PORT`      | `8787`              | HTTP + WebSocket listen port.               |
| `UIPI_HOST`      | `127.0.0.1`         | Bind address; use `0.0.0.0` in a container. |
| `UIPI_STATIC`    | `packages/web/dist` | Built web assets to serve.                  |
| `UIPI_CWD`       | `process.cwd()`     | Default project directory for new sessions. |
| `UIPI_AGENT_DIR` | `~/.pi/agent`       | Default pi config dir for new sessions.     |
| `HOME`           | your home dir       | Expands a leading `~/` in the agent dir.    |

All are optional — the defaults are what `pnpm dev` and `pnpm start` use.

Every setting is also available as a CLI flag. Precedence is
**CLI flag > environment variable > default**:

| Flag                 | Env var          | Default             |
| -------------------- | ---------------- | ------------------- |
| `--cwd <path>`       | `UIPI_CWD`       | `process.cwd()`     |
| `--agent-dir <path>` | `UIPI_AGENT_DIR` | `~/.pi/agent`       |
| `--port <n>`         | `UIPI_PORT`      | `8787`              |
| `--host <addr>`      | `UIPI_HOST`      | `127.0.0.1`         |
| `--static <dir>`     | `UIPI_STATIC`    | `packages/web/dist` |
| `--help`, `-h`       | —                | print usage         |

Both `--flag value` and `--flag=value` are accepted; an unknown `--flag` exits `2`
and `--help` prints usage for all of the above. The new-session modal prefills its
cwd and agent dir from whichever value wins:

```sh
pnpm start -- --cwd ~/code/app --port 9000
```

## Credentials

Uses pi's own auth: run `pi` and `/login` once (or set provider env vars).
Server binds to 127.0.0.1 only (unless you set `UIPI_HOST`).

## v1 feature map

- Multi-session: sidebar list (pi session dirs per cwd), attach/re-attach,
  sessions live while browser is closed
- Streaming chat with tool-call cards (collapsed, streamed bash output, diffs)
- Model & thinking-level picker, `/compact` + header button
- Slash-command autocomplete, `@file` passthrough, Enter send / Shift+Enter newline
- steer/followUp queued chips with cancel, Stop (abort)
- Extension dialogs/selects as web modals
- Skills page — pi's own skills for the active cwd; one click starts a session
  running that skill
- Settings page (`/settings`) — General, Roles, Skills, Sandbox, MCP, Advanced:
  edits pi's own config files with unknown-key preservation, an mtime conflict
  check, a `.bak`, and an explicit post-save "Reload sessions"

## License

MIT — see [LICENSE](LICENSE). © Hampus Adamsson
