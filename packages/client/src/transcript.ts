/**
 * Rebuild the transcript view model from pi session events after attachment.
 * Strategy: maintain a rolling projection keyed by message id when possible,
 * falling back to append for unknown events.
 */
export interface TranscriptEntry {
  kind: "message" | "compaction" | "system";
  role?: string;
  text: string;
  thinking: string;
  thinkingActive: boolean;
  toolCalls: ToolCallView[];
  raw: unknown;
  id: string;
}

export interface ToolCallView {
  id: string;
  name: string;
  argsPreview: string;
  output: string;
  done: boolean;
  isError: boolean;
}

export function deriveTranscript(attach: {
  messages: unknown[];
  events: unknown[];
  sentMessages?: string[];
}): TranscriptEntry[] {
  const out: TranscriptEntry[] = [];
  // 1. snapshot messages (history at attach time)
  for (const m of attach.messages ?? []) {
    out.push(fromMessage(m, `snap${out.length}`));
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
  return coalesce(out);
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

function fromMessage(m: unknown, fallbackId: string): TranscriptEntry {
  const mm = m as { role?: string; id?: string };
  return {
    kind: "message",
    role: mm.role ?? "user",
    text: textOf(m),
    thinking: "",
    thinkingActive: false,
    toolCalls: [],
    raw: m,
    id: mm.id ?? fallbackId,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function applyEvent(out: TranscriptEntry[], ev: any): void {
  if (!ev || typeof ev !== "object") return;
  switch (ev.type) {
    case "message_start": {
      const msg = fromMessage(ev.message, `msg${out.length}`);
      // dedupe: snapshot may already contain this message (e.g. replayed history)
      if (!out.some((e) => e.id === msg.id)) out.push(msg);
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
      }
      break;
    }
    case "tool_execution_start":
    case "tool_execution_update":
    case "tool_execution_end": {
      upsertToolCall(out, ev);
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
  // drop empty assistant filler entries except those with toolCalls
  return entries.filter((e) => e.kind !== "message" || e.text.length > 0 || e.toolCalls.length > 0);
}
