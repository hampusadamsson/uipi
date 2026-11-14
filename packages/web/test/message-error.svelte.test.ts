// A turn pi gave up on renders as an explicit failure, not as nothing.
//
// The bug this pins: an assistant message that failed has `content: []` and
// `stopReason: "error"`, with the reason in `errorMessage`. The transcript used
// to drop it as an empty filler, so the prompt stayed on screen and the answer
// silently never appeared — indistinguishable from the UI hanging.
import { describe, it, expect, afterEach } from "vitest";
import { mount, unmount, flushSync } from "svelte";
import Message from "../src/components/Message.svelte";
import type { TranscriptEntry } from "@uipi/client";
import { UiState } from "../src/lib/state.svelte.js";

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

let host: HTMLElement;
let component: ReturnType<typeof mount> | null = null;

function render(e: TranscriptEntry): HTMLElement {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(Message, { target: host, props: { entry: e } });
  flushSync();
  return host;
}

function errorRow(): HTMLElement | null {
  return host.querySelector<HTMLElement>("[data-testid=message-error]");
}

afterEach(() => {
  if (component) unmount(component);
  component = null;
  host?.remove();
});

describe("a failed turn", () => {
  it("renders the reason the request failed", () => {
    render(entry({ error: "Request timed out." }));
    const row = errorRow();
    expect(row).not.toBeNull();
    expect(row!.textContent).toContain("Request timed out.");
    // it must be announced, not just painted
    expect(row!.getAttribute("role")).toBe("alert");
  });

  it('says "no response" so an empty turn is never mistaken for a blank reply', () => {
    render(entry({ error: "no API key for bifrost/whatever" }));
    expect(errorRow()!.textContent).toContain("no response");
  });

  it("hides the statistics line, which describes a reply that never came", () => {
    render(entry({ error: "boom", meta: { durationMs: 10500, outputTokens: 0 } }));
    expect(host.querySelector("[data-testid=message-meta]")).toBeNull();
  });

  it("still renders the partial text that arrived before the failure", () => {
    render(entry({ error: "stream interrupted", text: "here is the half I wrote" }));
    expect(host.textContent).toContain("here is the half I wrote");
    expect(errorRow()).not.toBeNull();
  });

  it("renders nothing extra for a successful turn", () => {
    render(entry({ text: "all good" }));
    expect(errorRow()).toBeNull();
    expect(host.textContent).toContain("all good");
  });
});

describe("the retry mirror", () => {
  // The status line under the transcript says "retrying 2/3 — <reason>" while pi
  // retries. It reads `ui.retry`, so the adapter must mirror `client.retryOf`
  // into a reactive map — reading the client directly would never invalidate.
  it("mirrors the client's retry state into reactive state", () => {
    const ui = new UiState();
    const c = ui.client as unknown as {
      attachedSessions: Map<string, unknown>;
      retryById: Map<string, unknown>;
      retryOf: (id: string) => unknown;
    };
    c.attachedSessions.set("s1", { sessionId: "s1" });
    c.retryById.set("s1", { attempt: 2, maxAttempts: 3, message: "Request timed out." });
    (ui as unknown as { sync: () => void }).sync();
    expect(ui.retry.get("s1")).toEqual({
      attempt: 2,
      maxAttempts: 3,
      message: "Request timed out.",
    });

    c.retryById.delete("s1");
    (ui as unknown as { sync: () => void }).sync();
    expect(ui.retry.get("s1")).toBeUndefined();
  });
});
