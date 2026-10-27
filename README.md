# uipi

Web UI harness over the [pi coding agent](https://github.com/earendil-works/pi) SDK —
use pi agents (models, tools, slash commands, extensions, skills) from a browser,
with multi-session support. Local, single-user, no auth.

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
  pi-native JSONL session persistence, extension UI host bridge.
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

`pnpm test` — runs every package's tests (`@uipi/client`, `@uipi/server`).
`pnpm lint` / `pnpm format` — ESLint + Prettier.

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
- Skills page — pi's own skills for the active cwd; one click starts a session
  running that skill
