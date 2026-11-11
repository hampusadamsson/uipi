// The typographic shape of a transcript row: the assistant role marker, the
// plain user bubble (no card), the faint statistics row still being mounted,
// and the two collapses that must survive any restyling.
//
// Deliberately assertion-light on classes: what matters is that the structure
// and the text a reader gets did not change. Mounted with `mount` against the
// shared `ui` singleton (Message reads it for markdown rendering), like
// message-meta.svelte.test.ts.
import { describe, it, expect, afterEach } from "vitest";
import { mount, unmount, flushSync } from "svelte";
import Message from "../src/components/Message.svelte";
import ToolCall from "../src/components/ToolCall.svelte";
import type { ToolCallView, TranscriptEntry } from "@uipi/client";

function entry(over: Partial<TranscriptEntry> = {}): TranscriptEntry {
  return {
    kind: "message",
    role: "assistant",
    text: "hello",
    thinking: "",
    thinkingActive: false,
    toolCalls: [],
    raw: null,
    id: "e1",
    ...over,
  };
}

function toolCall(over: Partial<ToolCallView> = {}): ToolCallView {
  return {
    id: "tc1",
    name: "bash",
    argsPreview: '{"cmd":"ls -la"}',
    output: "",
    done: true,
    isError: false,
    ...over,
  };
}

/** ~1400 characters: comfortably past the 800-char long-message threshold. */
const LONG = "lorem ipsum dolor sit amet ".repeat(50);

let host: HTMLElement;
let component: ReturnType<typeof mount> | null = null;

function renderMessage(e: TranscriptEntry): void {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(Message, { target: host, props: { entry: e } });
  flushSync();
}

afterEach(() => {
  if (component) unmount(component);
  component = null;
  host?.remove();
});

describe("assistant role marker", () => {
  it("anchors the text with a decorative glyph that is not read out", () => {
    renderMessage(entry({ text: "done — see `x.ts`" }));

    const marker = host.querySelector<HTMLElement>('[aria-hidden="true"]');
    expect(marker).not.toBeNull();
    expect(marker!.textContent).toBe("▍");
    // decorative only: the message text is still the whole story
    expect(host.textContent).not.toContain("▍!");
    expect(host.querySelector(".md")!.textContent).toContain("done — see");
  });

  it("does not leak the glyph into a verbatim (non-markdown) body", () => {
    renderMessage(entry({ text: "", toolCalls: [toolCall()] }));

    // no body at all: the glyph belongs to the text, not to the tool block
    expect(host.querySelector(".md")).toBeNull();
    expect(host.textContent).not.toContain("▍");
  });
});

describe("user message bubble", () => {
  it("renders as plain text, not as a card, and keeps the typed text verbatim", () => {
    renderMessage(entry({ role: "user", text: "**not bold**\nand a second line" }));

    expect(host.querySelector("[data-slot=card]")).toBeNull();
    const text = host.textContent ?? "";
    expect(text).toContain("**not bold**");
    expect(text).toContain("and a second line");
  });
});

describe("statistics row", () => {
  it("stays mounted with its values (hidden until hover, not removed)", () => {
    renderMessage(entry({ meta: { durationMs: 12345, tokensPerSecond: 12.3 } }));

    const row = host.querySelector<HTMLElement>("[data-testid=message-meta]");
    expect(row).not.toBeNull();
    expect(row!.textContent).toContain("12.3s");
    expect(row!.textContent).toContain("12.3 t/s");
  });
});

describe("collapses survive restyling", () => {
  it("still hides a long assistant reply behind its toggle", () => {
    renderMessage(entry({ text: LONG }));

    const toggle = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => (b.textContent ?? "").trim() === "show full message",
    );
    expect(toggle).toBeDefined();
    const md = host.querySelector<HTMLElement>(".md")!;
    expect(md.closest("[hidden]")).not.toBeNull();
    expect(md.textContent).toContain("lorem ipsum");
  });

  it("still hides long tool output behind its toggle", () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(ToolCall, {
      target: host,
      props: {
        tc: toolCall({ output: Array.from({ length: 6 }, (_, i) => `line ${i}`).join("\n") }),
      },
    });
    flushSync();

    const toggle = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => (b.textContent ?? "").trim() === "show output",
    );
    expect(toggle).toBeDefined();
    expect(host.querySelector("pre")!.closest("[hidden]")).not.toBeNull();
  });

  it("keeps the tool header as plain text: name plus args preview", () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(ToolCall, { target: host, props: { tc: toolCall() } });
    flushSync();

    expect(host.querySelector("[data-slot=badge]")).toBeNull();
    expect(host.textContent).toContain("bash");
    expect(host.textContent).toContain('{"cmd":"ls -la"}');
  });
});
