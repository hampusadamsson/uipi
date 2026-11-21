// The end of a conversation is never collapsed: whatever the final reply is, a
// reader sees it in full without clicking "show full message". Earlier long
// replies still collapse, so the transcript stays scannable.
//
// Chat reads the shared `ui` singleton for its transcript, so the messages are
// seeded on `ui.attached` and the component mounted for real, like
// input-box.svelte.test.ts.
import { describe, it, expect, afterEach } from "vitest";
import { mount, unmount, flushSync } from "svelte";
import Chat from "../src/components/Chat.svelte";
import { ui } from "../src/lib/state.svelte.js";
import type { AttachedSession } from "@uipi/client";

const SID = "s1";
/** ~1400 characters: comfortably past the 800-char long-message threshold. */
const LONG = "lorem ipsum dolor sit amet ".repeat(50);

let host: HTMLElement;
let component: ReturnType<typeof mount> | null = null;

function message(role: string, text: string, id: string): unknown {
  return { role, content: text, id };
}

function attach(messages: unknown[]): void {
  ui.attached.set(SID, {
    sessionId: SID,
    cwd: "/proj",
    model: null,
    thinkingLevel: "off",
    tools: [],
    role: null,
    commands: [],
    statuses: {},
    isStreaming: false,
    steering: [],
    followUp: [],
    sessionFile: null,
    messages,
    events: [],
  } as AttachedSession);
}

function render(messages: unknown[]): void {
  attach(messages);
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(Chat, { target: host, props: { sessionId: SID } });
  flushSync();
}

function toggles(): HTMLButtonElement[] {
  return [...host.querySelectorAll<HTMLButtonElement>("button")].filter((b) =>
    ["show full message", "show less"].includes((b.textContent ?? "").trim()),
  );
}

/** Markdown bodies, in transcript order. */
function bodies(): HTMLElement[] {
  return [...host.querySelectorAll<HTMLElement>(".md")];
}

afterEach(() => {
  if (component) unmount(component);
  component = null;
  host?.remove();
  ui.attached.delete(SID);
});

describe("final transcript message", () => {
  it("shows the last reply in full, with no collapse toggle", () => {
    render([message("user", "please explain", "u1"), message("assistant", LONG, "a1")]);

    expect(toggles()).toEqual([]);
    const body = bodies().at(-1)!;
    expect(body.closest("[hidden]")).toBeNull();
    expect(body.textContent).toContain("lorem ipsum");
  });

  it("still collapses an earlier long reply", () => {
    render([
      message("user", "first", "u1"),
      message("assistant", LONG, "a1"),
      message("user", "second", "u2"),
      message("assistant", "short and final", "a2"),
    ]);

    const toggle = toggles();
    expect(toggle).toHaveLength(1);
    expect(toggle[0].textContent!.trim()).toBe("show full message");
    // the earlier reply is the hidden one; the last is on screen
    expect(bodies()[0].closest("[hidden]")).not.toBeNull();
    expect(bodies().at(-1)!.closest("[hidden]")).toBeNull();
  });
});
