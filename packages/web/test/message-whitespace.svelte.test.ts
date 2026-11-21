// A tool-calling step must render its tool card, never a blank body.
//
// The bug this pins: pi records a tool-calling assistant step as `thinking` +
// `toolCall` parts, often with a whitespace-only text part (`"\n\n"`). Replayed
// from history the step projected to a message with an empty-ish text, so the
// transcript showed a statistics line — "22.0s · 8.1 t/s · 2k ctx" — and
// nothing else: no tool card, no reasoning, no reply. It read as the agent
// having done nothing at all.
import { describe, it, expect, afterEach } from "vitest";
import { mount, unmount, flushSync } from "svelte";
import Message from "../src/components/Message.svelte";
import type { TranscriptEntry } from "@uipi/client";

let host: HTMLElement;
let component: ReturnType<typeof mount> | null = null;

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

function render(e: TranscriptEntry): HTMLElement {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(Message, { target: host, props: { entry: e } });
  flushSync();
  return host;
}

/** The chat body anchor: one glyph per run of assistant prose. */
function bodyAnchors(): HTMLElement[] {
  return [...host.querySelectorAll<HTMLElement>('span[aria-hidden="true"]')].filter(
    (s) => (s.textContent ?? "").trim() === "▍",
  );
}

afterEach(() => {
  if (component) unmount(component);
  component = null;
  host?.remove();
});

describe("whitespace-only assistant text", () => {
  const toolCall = {
    id: "tc1",
    name: "hypa_ls",
    argsPreview: '{"path":"."}',
    output: "a\nb",
    done: true,
    isError: false,
  };

  it("renders no prose body for a text part that is only newlines", () => {
    render(entry({ text: "\n\n", toolCalls: [toolCall] }));
    expect(bodyAnchors()).toHaveLength(0);
    // and no empty markdown paragraph either
    expect(host.querySelector(".md")).toBeNull();
  });

  it("still renders the tool card, which is the step's actual output", () => {
    render(entry({ text: "\n\n", toolCalls: [toolCall] }));
    expect(host.textContent).toContain("hypa_ls");
    expect(host.textContent).toContain("a\nb");
  });

  it("keeps the statistics row beside the card", () => {
    render(entry({ text: "\n\n", toolCalls: [toolCall], meta: { durationMs: 22000 } }));
    expect(host.querySelector("[data-testid=message-meta]")).not.toBeNull();
  });

  it("renders a reasoning row when the step carried only thinking", () => {
    render(entry({ text: "\n\n", thinking: "let me look at the tree" }));
    expect(host.textContent).toContain("thought for a bit");
    expect(bodyAnchors()).toHaveLength(0);
  });
});
