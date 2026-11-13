// Collapsing a long assistant reply behind a "show full message" toggle: when
// the toggle appears, what it says, and the two cases that must never hide the
// text again (a reply that streamed, and a user's own message).
//
// Mounted with `mount` against the shared `ui` singleton (Message reads it for
// markdown rendering), like message-meta.svelte.test.ts. The entry is passed
// through `proxy` so a test can re-render the same instance with a new entry —
// that is what "thinkingActive went false in a later render" means, and a
// remount would lose the component's own memory of it.
import { describe, it, expect, afterEach } from "vitest";
import { mount, unmount, flushSync } from "svelte";
import Message from "../src/components/Message.svelte";
import type { TranscriptEntry } from "@uipi/client";

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

/** ~1400 characters: comfortably past the 800-char threshold. */
const LONG = "lorem ipsum dolor sit amet ".repeat(50);

let host: HTMLElement;
let component: ReturnType<typeof mount> | null = null;

type Rendered = {
  /** re-render the same component instance with a different entry */
  update: (e: TranscriptEntry) => void;
  /** the "show full message" / "show less" toggle, if the body is collapsible */
  toggle: () => HTMLButtonElement | null;
  /** the rendered body (markdown or verbatim text), whether or not it is shown */
  body: () => HTMLElement | null;
  /** whether that body is actually on screen (collapsible content is hidden, not unmounted) */
  bodyVisible: () => boolean;
};

function render(e: TranscriptEntry): Rendered {
  host = document.createElement("div");
  document.body.appendChild(host);
  const props = $state({ entry: e });
  component = mount(Message, { target: host, props });
  flushSync();
  return {
    update(next) {
      props.entry = next;
      flushSync();
    },
    toggle() {
      const found = [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) =>
        ["show full message", "show less"].includes((b.textContent ?? "").trim()),
      );
      return found ?? null;
    },
    body() {
      return host.querySelector<HTMLElement>(".md, .whitespace-pre-wrap");
    },
    bodyVisible() {
      const el = host.querySelector<HTMLElement>(".md, .whitespace-pre-wrap");
      return el !== null && el.closest("[hidden]") === null;
    },
  };
}

afterEach(() => {
  if (component) unmount(component);
  component = null;
  host?.remove();
});

describe("long assistant message", () => {
  it("renders a short message exactly as before, with no toggle", () => {
    const r = render(entry({ text: "all done — see `x.ts`" }));

    expect(r.toggle()).toBeNull();
    expect(host.textContent).not.toContain("show full message");
    expect(host.querySelector("[data-slot=collapsible]")).toBeNull();
    // still the plain markdown body, unwrapped
    expect(r.body()!.className).toBe("md text-chat break-words");
    expect(r.body()!.textContent).toContain("all done");
    expect(r.bodyVisible()).toBe(true);
  });

  it("collapses the body behind a toggle, which reveals it", () => {
    const r = render(entry({ text: LONG }));

    const toggle = r.toggle();
    expect(toggle).not.toBeNull();
    expect(toggle!.textContent!.trim()).toBe("show full message");
    // collapsed: the body is present but hidden
    expect(r.body()).not.toBeNull();
    expect(r.bodyVisible()).toBe(false);
    expect(host.querySelector("[data-slot=collapsible]")!.getAttribute("data-state")).toBe(
      "closed",
    );

    toggle!.click();
    flushSync();

    expect(r.bodyVisible()).toBe(true);
    expect(r.body()!.textContent).toContain("lorem ipsum");
    expect(r.toggle()!.textContent!.trim()).toBe("show less");
  });

  it("treats many lines as long even when short in characters", () => {
    const r = render(entry({ text: Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n") }));

    expect(r.toggle()).not.toBeNull();
    expect(r.bodyVisible()).toBe(false);
  });

  it("stays visible while streaming, with no collapse", () => {
    const r = render(entry({ text: LONG, thinkingActive: true }));

    expect(r.toggle()).toBeNull();
    expect(r.body()).not.toBeNull();
    expect(r.body()!.textContent).toContain("lorem ipsum");
    expect(r.bodyVisible()).toBe(true);
  });

  it("stays expanded after streaming ends, and never collapses again", () => {
    const r = render(entry({ text: LONG, thinkingActive: true }));
    expect(r.bodyVisible()).toBe(true);

    r.update(entry({ text: LONG, thinkingActive: false }));

    expect(r.toggle()).toBeNull();
    expect(r.body()).not.toBeNull();
    expect(r.body()!.textContent).toContain("lorem ipsum");
    expect(r.bodyVisible()).toBe(true);
    expect(host.textContent).not.toContain("show full message");
  });
});

describe("user message", () => {
  it("never gets a toggle, however long", () => {
    const r = render(entry({ role: "user", text: LONG }));

    expect(r.toggle()).toBeNull();
    expect(host.textContent).not.toContain("show full message");
    expect(host.textContent).toContain("lorem ipsum");
  });
});
