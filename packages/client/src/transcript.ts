/**
 * Rebuild the transcript view model from pi session events after attachment.
 * Strategy: maintain a rolling projection keyed by message id when possible,
 * falling back to append for unknown events.
 */
import { contextTokensOf } from "./usage.js";

export interface TranscriptEntry {
  kind: "message" | "compaction" | "system";
  role?: string;
  text: string;
  thinking: string;
  thinkingActive: boolean;
  toolCalls: ToolCallView[];
  raw: unknown;
  id: string;
  /** Raw usage/timing numbers for assistant messages; the UI formats them. */
  meta?: TranscriptEntryMeta;
  /**
   * Why the turn produced nothing, when pi gave up on it.
   *
   * An assistant message that failed (`stopReason: "error"`) has no content at
   * all: pi reports the reason out of band in `errorMessage`. Without carrying
   * it here the turn renders as a user prompt followed by nothing — the whole
   * exchange silently disappears, which reads as "the UI hung".
   */
  error?: string;
}

/**
 * Per-assistant-message usage and timing, kept as raw numbers: formatting
 * belongs to the UI. Only present when at least one field is known, so user
 * messages and legacy assistant messages (no `durationMs`) stay `meta`-less
 * when they carry no usage.
 */
export interface TranscriptEntryMeta {
  /** whole response duration; absent on legacy/deferred messages */
  durationMs?: number;
  outputTokens?: number;
  /** input + cacheRead + cacheWrite, matching the client's session counter */
  contextTokens?: number;
  tokensPerSecond?: number;
}

export interface ToolCallView {
  id: string;
  name: string;
  argsPreview: string;
  output: string;
  done: boolean;
  isError: boolean;
}

/**
 * A pi custom session entry (`{ type: "custom", customType, data }`) as it
 * reaches the client: from a snapshot or from an `entry_appended` event.
 */
export interface CustomEntryView {
  type: "custom";
  customType: string;
  data?: unknown;
  id?: string;
  timestamp?: string;
}

/**
 * Renders one custom session entry into a transcript entry, or `null` to drop
 * it. `index` is the entry's position in the projection, for deterministic ids.
 */
export type CustomEntryRenderer = (entry: CustomEntryView, index: number) => TranscriptEntry | null;

/**
 * Extension point for custom session entries: `customType` → renderer.
 * Anything not registered here renders nothing, so unknown extension state
 * never leaks into the transcript as noise. A frontend or a later feature adds
 * a custom type by registering a renderer (e.g. `subagents`, todos).
 */
export const customEntryRenderers = new Map<string, CustomEntryRenderer>();

/**
 * Register (or replace) the renderer for one custom entry type. Replacing an
 * existing customType is allowed; the latest registration wins.
 */
export function registerCustomEntryRenderer(
  customType: string,
  renderer: CustomEntryRenderer,
): void {
  customEntryRenderers.set(customType, renderer);
}

/**
 * Project a session snapshot plus the live events since attach into renderable
 * transcript entries. Snapshot messages come first, optimistic sent messages
 * fill in until the server echoes a user message, then live events are folded
 * on top. Custom session entries go through {@link customEntryRenderers}, and
 * any that precede the first user message are dropped (startup state is not an
 * event).
 */
export function deriveTranscript(attach: {
  messages: unknown[];
  events: unknown[];
  sentMessages?: string[];
}): TranscriptEntry[] {
  const out: TranscriptEntry[] = [];
  // 1. snapshot messages (history at attach time); a snapshot is normally
  // model-context messages, but custom entries are tolerated in place so the
  // startup-suppression rule stays positionally correct
  for (const m of attach.messages ?? []) {
    const entry = fromSnapshot(m, out.length);
    if (entry) out.push(entry);
  }
  // 2. optimistic user messages only while the server hasn't echoed any user message yet
  const hasUserEcho = out.some((e) => e.role === "user");
  if (!hasUserEcho) {
    for (const s of attach.sentMessages ?? []) {
      out.push({
        kind: "message",
        role: "user",
        text: s,
        thinking: "",
        thinkingActive: false,
        toolCalls: [],
        raw: null,
        id: `sent-${s.slice(0, 20)}-${s.length}`,
      });
    }
  }
  // 3. fold live events on top
  for (const ev of attach.events ?? []) {
    applyEvent(out, ev);
  }
  // 4. entries before the first user message are initial state, not events
  return coalesce(suppressBeforeFirstUser(out));
}

function isCustomEntry(v: unknown): v is CustomEntryView {
  if (!v || typeof v !== "object") return false;
  const e = v as { type?: unknown; customType?: unknown };
  return e.type === "custom" && typeof e.customType === "string";
}

/** Render a snapshot item: a custom entry goes through the registry, anything
 *  else is treated as a message. Returns null when the entry renders nothing. */
function fromSnapshot(m: unknown, index: number): TranscriptEntry | null {
  if (!isCustomEntry(m)) return fromMessage(m, `snap${index}`);
  return renderCustomEntry(m, index);
}

/** Run one custom entry through the registry. Unknown types render nothing. */
function renderCustomEntry(entry: CustomEntryView, index: number): TranscriptEntry | null {
  const renderer = customEntryRenderers.get(entry.customType);
  return renderer ? renderer(entry, index) : null;
}

/**
 * Drop custom-entry rows that precede the first user message: a session's
 * startup state (the default role, initial todos, …) is an initial condition,
 * not something that happened. Generic — keyed on position, not on customType.
 */
function suppressBeforeFirstUser(entries: TranscriptEntry[]): TranscriptEntry[] {
  const firstUser = entries.findIndex((e) => e.role === "user");
  if (firstUser === 0) return entries;
  return entries.filter((e, i) => {
    if (!isCustomEntry(e.raw)) return true;
    // keep custom entries only once a user message precedes them
    return firstUser >= 0 && i > firstUser;
  });
}

/** role-switch: `role → architect`. One line, no role → `none`. */
function roleSwitchEntry(entry: CustomEntryView, index: number): TranscriptEntry {
  const role = (entry.data as { role?: string | null } | undefined)?.role ?? "none";
  return {
    kind: "system",
    text: `role → ${role}`,
    thinking: "",
    thinkingActive: false,
    toolCalls: [],
    raw: entry,
    id: `role-${entry.id ?? index}`,
  };
}

registerCustomEntryRenderer("role-switch", roleSwitchEntry);

function roleOf(m: unknown): string | undefined {
  if (!m || typeof m !== "object") return undefined;
  return (m as { role?: string }).role;
}

/**
 * pi's own failure reason for a message, or `undefined` when it succeeded.
 *
 * `errorMessage` is what pi writes on a failed assistant message; `error` is
 * accepted too because the raw provider error is sometimes surfaced under that
 * name. An empty result is treated as absent so it cannot render an empty row.
 */
function errorOf(m: unknown): string | undefined {
  if (!m || typeof m !== "object") return undefined;
  const mm = m as { errorMessage?: unknown; error?: unknown; stopReason?: unknown };
  const raw = mm.errorMessage ?? mm.error;
  if (typeof raw === "string" && raw.trim() !== "") return raw.trim();
  if (raw && typeof raw === "object") {
    const message = (raw as { message?: unknown }).message;
    if (typeof message === "string" && message.trim() !== "") return message.trim();
    return JSON.stringify(raw);
  }
  // an `error` stop with no reason still failed: say so rather than showing nothing
  if (mm.stopReason === "error") return "the model request failed";
  return undefined;
}

function textOf(m: unknown): string {
  const mm = m as { content?: unknown };
  if (!mm) return "";
  if (typeof mm.content === "string") return mm.content;
  if (Array.isArray(mm.content)) {
    return mm.content
      .map((c) => (typeof c === "string" ? c : ((c as { text?: string })?.text ?? "")))
      .join("");
  }
  return "";
}

function fromMessage(m: unknown, fallbackId: string): TranscriptEntry | null {
  // pi persists every tool result as its own `role: "toolResult"` message, and
  // the assistant's tool card already renders that output; projecting the
  // message as well would show the same text twice.
  if (roleOf(m) === "toolResult") return null;
  const mm = m as { role?: string; id?: string };
  const entry: TranscriptEntry = {
    kind: "message",
    role: mm.role ?? "user",
    text: textOf(m),
    thinking: "",
    thinkingActive: false,
    toolCalls: [],
    raw: m,
    id: mm.id ?? fallbackId,
  };
  const meta = metaOf(m);
  if (meta) entry.meta = meta;
  const error = errorOf(m);
  if (error) entry.error = error;
  return entry;
}

/**
 * Derive raw usage/timing for a message, or `undefined` when nothing is known.
 * `durationMs` is only ever the message's own value: a missing value stays
 * missing rather than being back-computed from the timestamp.
 */
function metaOf(m: unknown): TranscriptEntryMeta | undefined {
  const mm = m as {
    durationMs?: unknown;
    usage?: { input?: unknown; output?: unknown; cacheRead?: unknown; cacheWrite?: unknown };
  };
  if (!mm || typeof mm !== "object") return undefined;
  const num = (v: unknown): number | undefined =>
    typeof v === "number" && Number.isFinite(v) ? v : undefined;
  const durationMs = num(mm.durationMs);
  const output = num(mm.usage?.output);
  const input = num(mm.usage?.input);
  const cacheRead = num(mm.usage?.cacheRead);
  const cacheWrite = num(mm.usage?.cacheWrite);
  const contextTokens =
    input === undefined && cacheRead === undefined && cacheWrite === undefined
      ? undefined
      : contextTokensOf({ input, cacheRead, cacheWrite });
  const tokensPerSecond =
    durationMs !== undefined && durationMs > 0 && output !== undefined && output > 0
      ? Math.round((output / (durationMs / 1000)) * 10) / 10
      : undefined;
  const meta: TranscriptEntryMeta = {};
  if (durationMs !== undefined) meta.durationMs = durationMs;
  if (output !== undefined) meta.outputTokens = output;
  if (contextTokens !== undefined) meta.contextTokens = contextTokens;
  if (tokensPerSecond !== undefined) meta.tokensPerSecond = tokensPerSecond;
  return Object.keys(meta).length > 0 ? meta : undefined;
}

/**
 * Drop a trailing failed attempt that a new one supersedes.
 *
 * pi retries a failed request, and every attempt begins with its own
 * `message_start` and ends with its own errored assistant message. Left alone
 * that stacks one identical "no response" row per try. Only the outcome of the
 * whole turn is worth showing, and the composer's retry counter already reports
 * the attempts in between, so a failure that produced no text is replaced by
 * the attempt that follows it.
 */
function dropSupersededFailure(out: TranscriptEntry[]): void {
  const last = out.at(-1);
  if (
    last &&
    last.kind === "message" &&
    last.role === "assistant" &&
    last.error !== undefined &&
    last.text === "" &&
    last.toolCalls.length === 0
  ) {
    out.pop();
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function applyEvent(out: TranscriptEntry[], ev: any): void {
  if (!ev || typeof ev !== "object") return;
  switch (ev.type) {
    case "message_start": {
      const msg = fromMessage(ev.message, `msg${out.length}`);
      if (!msg) break;
      // dedupe: snapshot may already contain this message (e.g. replayed history)
      if (out.some((e) => e.id === msg.id)) break;
      if (msg.role === "assistant") dropSupersededFailure(out);
      out.push(msg);
      break;
    }
    case "message_update": {
      const last = out.at(-1);
      const role = ev.message?.role;
      const ae = ev.assistantMessageEvent || {};
      if (last && last.role === role) {
        if (ae.type === "thinking_delta") {
          last.thinking += ae.delta || "";
          last.thinkingActive = true;
        } else if (ae.type === "thinking_end") {
          last.thinkingActive = false;
        } else if (ae.type === "text_delta") {
          last.text = textOf(ev.message);
          last.thinkingActive = false;
        } else {
          last.text = textOf(ev.message);
        }
      } else {
        const m = fromMessage(ev.message, `msg${out.length}`);
        if (!m) break;
        if (m.role === "assistant" && ae.type === "thinking_delta") {
          m.thinking = ae.delta || "";
          m.thinkingActive = true;
        }
        out.push(m);
      }
      break;
    }
    case "message_end": {
      const last = out.at(-1);
      if (last && last.role === ev.message?.role) {
        last.text = textOf(ev.message);
        last.raw = ev.message;
        last.thinkingActive = false;
        const meta = metaOf(ev.message);
        if (meta) last.meta = meta;
        else delete last.meta;
        const error = errorOf(ev.message);
        if (error) last.error = error;
        else delete last.error;
      } else if (ev.message?.role === "assistant" && errorOf(ev.message)) {
        // A failure can arrive as a lone `message_end` with no preceding
        // `message_start`; it still has to reach the transcript.
        const msg = fromMessage(ev.message, `msg${out.length}`);
        if (msg) out.push(msg);
      }
      break;
    }
    case "tool_execution_start":
    case "tool_execution_update":
    case "tool_execution_end": {
      upsertToolCall(out, ev);
      break;
    }
    case "entry_appended": {
      const entry = ev.entry;
      if (isCustomEntry(entry)) {
        const rendered = renderCustomEntry(entry, out.length);
        // an `entry_appended` for an entry the snapshot already rendered
        if (rendered && !out.some((e) => e.id === rendered.id)) out.push(rendered);
      }
      break;
    }
    case "compaction_start":
    case "compaction_end": {
      const label =
        ev.type === "compaction_end"
          ? `compacted · ${((ev as { summary?: string }).summary ?? "context condensed").slice(0, 120)}`
          : "compacting context…";
      out.push({
        kind: "compaction",
        text: label,
        thinking: "",
        thinkingActive: false,
        toolCalls: [],
        raw: ev,
        id: `c${out.length}`,
      });
      break;
    }
    default:
      break;
  }
}

function upsertToolCall(out: TranscriptEntry[], ev: Record<string, unknown>): void {
  const callId = String(ev.toolCallId ?? ev.id ?? "");
  const entry = ensureAssistantEntry(out, callId);
  let tc: ToolCallView | undefined = entry.toolCalls.find((t) => t.id === callId);
  if (!tc) {
    tc = {
      id: callId,
      name: String(ev.toolName ?? "tool"),
      argsPreview: JSON.stringify(ev.args ?? {}).slice(0, 200),
      output: "",
      done: false,
      isError: false,
    } as ToolCallView & { id: string };
    entry.toolCalls.push(tc);
  }
  if (ev.type === "tool_execution_update" && ev.partialOutput) {
    tc.output = String(ev.partialOutput).slice(-8000);
  }
  if (ev.type === "tool_execution_end") {
    tc.done = true;
    const r = ev.result as { content?: unknown[]; isError?: boolean };
    if (Array.isArray(r?.content)) {
      tc.output = r.content
        .map((c) => (typeof c === "string" ? c : ((c as { text?: string })?.text ?? "")))
        .join("");
    } else if (typeof r === "string") tc.output = r;
    tc.isError = Boolean(r?.isError);
  }
}

function ensureAssistantEntry(out: TranscriptEntry[], callId: string): TranscriptEntry {
  // pi associates tool_call ids to assistant message; approximate: last assistant entry
  const lastAssistant = [...out].reverse().find((e) => e.role === "assistant");
  if (lastAssistant) return lastAssistant;
  const e: TranscriptEntry = {
    kind: "message",
    role: "assistant",
    text: "",
    thinking: "",
    thinkingActive: false,
    toolCalls: [],
    raw: null,
    id: callId,
  };
  out.push(e);
  return e;
}

function coalesce(entries: TranscriptEntry[]): TranscriptEntry[] {
  // Drop empty filler entries, except those that carry something a reader must
  // see: tool calls, or a failure. An errored turn has no text at all, so
  // filtering it out is what made a failed run vanish from the transcript.
  return entries.filter(
    (e) =>
      e.kind !== "message" || e.text.length > 0 || e.toolCalls.length > 0 || e.error !== undefined,
  );
}
