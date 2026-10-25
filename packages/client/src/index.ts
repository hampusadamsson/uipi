/**
 * @uipi/client — the UI-agnostic frontend layer.
 *
 * Everything a frontend needs to talk to a uipi server and project pi events
 * into view models, with no framework or DOM dependency:
 *
 *  - {@link Conn}        transport (request/response + push, injected socket factory)
 *  - {@link UipiClient}  session store, pi-event reducer, commands
 *  - {@link deriveTranscript} pi events → renderable transcript entries
 *  - {@link pathFor} / {@link hash8} / {@link hashFromPath}  `/s/<hash>` routing
 *
 * The Svelte app in `@uipi/web` is a thin adapter over this; a TUI would be
 * another adapter using exactly the same API.
 */

export {
  Conn,
  SOCKET_OPEN,
  type ConnOptions,
  type SocketFactory,
  type WebSocketLike,
} from "./conn.js";

export {
  UipiClient,
  type AttachedSession,
  type SessionSummaryView,
  type RunState,
} from "./client.js";

export { deriveTranscript, type TranscriptEntry, type ToolCallView } from "./transcript.js";

export { hash8, pathFor, hashFromPath } from "./route.js";
