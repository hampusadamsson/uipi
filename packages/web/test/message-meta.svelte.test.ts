// The faint statistics line under an assistant message: when it renders, what
// it says, and that it stays off for everything else.
//
// Mounted with `mount` against the shared `ui` singleton (Message reads it for
// markdown rendering), like skills-page.svelte.test.ts.
import { describe, it, expect, afterEach } from "vitest";
import { mount, unmount, flushSync } from "svelte";
import Message from "../src/components/Message.svelte";
import type { TranscriptEntry, TranscriptEntryMeta } from "@uipi/client";

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

let host: HTMLElement;
let component: ReturnType<typeof mount> | null = null;

function render(e: TranscriptEntry): HTMLElement {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(Message, { target: host, props: { entry: e } });
  flushSync();
  return host;
}

function metaRow(): HTMLElement | null {
  return host.querySelector<HTMLElement>("[data-testid=message-meta]");
}

function metaPartsText(): string[] {
  const row = metaRow();
  if (!row) return [];
  return [...row.querySelectorAll("span:not(.sr-only)")]
    .filter((s) => s.getAttribute("aria-hidden") !== "true")
    .map((s) => (s.textContent ?? "").trim());
}

afterEach(() => {
  if (component) unmount(component);
  component = null;
  host?.remove();
});

describe("message meta line", () => {
  it("renders duration, rate and context in the faint row", () => {
    const meta: TranscriptEntryMeta = {
      durationMs: 12345,
      outputTokens: 152,
      contextTokens: 12_400,
      tokensPerSecond: 12.3,
    };
    render(entry({ meta }));

    const row = metaRow();
    expect(row).not.toBeNull();
    expect(row!.textContent).toContain("message statistics");
    expect(metaPartsText()).toEqual(["12.3s", "12.3 t/s", "12k ctx"]);
    // one middot between the values
    const separators = [...row!.querySelectorAll('span[aria-hidden="true"]')].map(
      (s) => s.textContent,
    );
    expect(separators).toEqual(["·", "·"]);
    // supporting detail styling: small, faint, non-selectable
    expect(row!.className).toContain("text-[11px]");
    expect(row!.className).toContain("text-muted-foreground/70");
    expect(row!.className).toContain("select-none");
    // no icons, borders or hover affordances
    expect(row!.querySelector("svg")).toBeNull();
    expect(row!.className).not.toMatch(/border|hover|shadow/);
  });

  it("omits missing values", () => {
    render(entry({ meta: { tokensPerSecond: 7.25 } }));

    expect(metaPartsText()).toEqual(["7.3 t/s"]);
  });

  it("renders no row without meta", () => {
    render(entry());
    expect(metaRow()).toBeNull();
  });

  it("renders no row for a user message, even with meta", () => {
    render(entry({ role: "user", text: "hi", meta: { durationMs: 900 } }));
    expect(metaRow()).toBeNull();
  });

  it("renders no row while the message is still thinking", () => {
    render(entry({ thinkingActive: true, meta: { durationMs: 900 } }));
    expect(metaRow()).toBeNull();
  });

  it("keeps small contexts exact instead of rounding them to 0k", () => {
    render(entry({ meta: { contextTokens: 850 } }));

    const parts = metaPartsText();
    expect(parts).toEqual(["850 ctx"]);
    expect(metaRow()!.textContent).not.toContain("0k ctx");
    expect(metaRow()!.textContent).not.toContain("1k ctx");
  });

  it("rounds contexts of a thousand and up to Nk", () => {
    render(entry({ meta: { contextTokens: 12_400 } }));

    expect(metaPartsText()).toEqual(["12k ctx"]);
  });

  it("formats sub-second durations as ms and longer ones as N.Ns", () => {
    render(entry({ meta: { durationMs: 850 } }));
    expect(metaPartsText()).toEqual(["850ms"]);
    unmount(component!);
    component = null;
    host.remove();

    render(entry({ meta: { durationMs: 12345 } }));
    expect(metaPartsText()).toEqual(["12.3s"]);
  });
});
