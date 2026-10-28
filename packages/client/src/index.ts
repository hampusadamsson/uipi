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
 *  - {@link SKILLS_PAGE} / {@link SETTINGS_PAGE} / {@link isPagePath} /
 *    {@link pageIdFromPath}  non-session page routes
 *
 * The Svelte app in `@uipi/web` is a thin adapter over this; a TUI would be
 * another adapter using exactly the same API.
 */

export { Conn, type SocketFactory, type WebSocketLike } from "./conn.js";

export {
  UipiClient,
  type AttachedSession,
  type ConfigConflictView,
  type SessionSummaryView,
  type RunState,
} from "./client.js";

export { deriveTranscript, type TranscriptEntry, type ToolCallView } from "./transcript.js";

export {
  hash8,
  pathFor,
  hashFromPath,
  isPagePath,
  pageIdFromPath,
  SKILLS_PAGE,
  SETTINGS_PAGE,
  type PageId,
} from "./route.js";
