// Which transcript rows the chat renders as markdown, and which stay verbatim.
//
// The rendering itself is pinned in markdown.test.ts; this pins the *decision*
// (and the fact that it lives in the adapter, so a future frontend can reuse it
// rather than re-deriving the rule from pi events).
import { describe, it, expect } from "vitest";
import { UiState } from "../src/lib/state.svelte.js";
import type { TranscriptEntry } from "@uipi/client";

function entry(over: Partial<TranscriptEntry> = {}): TranscriptEntry {
  return {
    kind: "message",
    role: "assistant",
    text: "",
    thinking: "",
    thinkingActive: false,
    toolCalls: [],
    raw: null,
    id: "e1",
    ...over,
  };
}

const ui = new UiState();

describe("entryHtml", () => {
  it("renders an assistant message as markdown", () => {
    const html = ui.entryHtml(entry({ text: "**done** — see `x.ts`" }));
    expect(html).toContain("<strong>done</strong>");
    expect(html).toContain("<code>x.ts</code>");
  });

  it("leaves a user message alone, so it looks exactly as typed", () => {
    // a user writing `**not bold**` must not be reinterpreted back at them
    expect(ui.entryHtml(entry({ role: "user", text: "**not bold**" }))).toBeNull();
  });

  it("leaves system rows alone (role switches, compaction)", () => {
    expect(ui.entryHtml(entry({ kind: "system", text: "role → architect" }))).toBeNull();
    expect(ui.entryHtml(entry({ kind: "compaction", text: "compacted · x" }))).toBeNull();
  });

  it("returns null for empty assistant text (filler rows)", () => {
    expect(ui.entryHtml(entry({ text: "" }))).toBeNull();
  });

  it("renders sanitized html, never raw model output", () => {
    const html = ui.entryHtml(entry({ text: "<img src=x onerror=alert(1)>" }));
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });

  it("renders a fenced code block with highlighting", () => {
    const html = ui.entryHtml(entry({ text: "```ts\nconst a: number = 1;\n```" }));
    expect(html).toContain('class="hljs"');
    expect(html).toContain("hljs-keyword");
  });
});
