// Composer behaviour: what a keystroke actually sends.
//
// InputBox reads the shared `ui` singleton directly, so it is mounted for real
// and the outbound commands are intercepted at the adapter boundary
// (`vi.spyOn(ui, ...)`) — the assertions are about what a user's keypress does,
// not about the component's internals.
//
// `/new` is the interesting branch: the component intercepts it *client-side*
// and turns it into `ui.newSession(cwd)`, so it must never reach `sendPrompt`
// (pi has no `/new` command). It also needs the attached session's cwd to have
// anywhere to create the session in.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mount, unmount, flushSync } from "svelte";
import InputBox from "../src/components/InputBox.svelte";
import { ui } from "../src/lib/state.svelte.js";
import type { AttachedSession } from "@uipi/client";

const SID = "s1";
const CWD = "/proj";

let host: HTMLElement;
let component: ReturnType<typeof mount> | null = null;

function attachSession(overrides: Partial<AttachedSession> = {}): void {
  ui.attached.set(SID, {
    sessionId: SID,
    cwd: CWD,
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
    messages: [],
    events: [],
    ...overrides,
  });
}

function render(): void {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(InputBox, { target: host, props: { sessionId: SID } });
  flushSync();
}

function textarea(): HTMLTextAreaElement {
  const el = host.querySelector<HTMLTextAreaElement>("textarea");
  expect(el).not.toBeNull();
  return el!;
}

/** Type into the bound textarea the way a keystroke would land in it. */
function type(value: string): void {
  const el = textarea();
  el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  flushSync();
}

function key(name: string, init: KeyboardEventInit = {}): void {
  textarea().dispatchEvent(
    new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...init }),
  );
  flushSync();
}

function button(label: string): HTMLButtonElement {
  // The submit/stop controls are icon-only now: the word lives in `aria-label`
  // (and `title`), not in the button's text.
  const el = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => (b.getAttribute("aria-label") ?? b.textContent ?? "").trim() === label,
  );
  expect(el, `no button labelled ${label}`).toBeDefined();
  return el!;
}

beforeEach(() => {
  // shared singleton: leave nothing from a previous file (or test) behind
  ui.attached.clear();
  ui.runState.clear();
  ui.error = null;
  ui.sessions = [];
  ui.recentDirs = [];
  ui.activeId = null;
  attachSession();
});

afterEach(() => {
  if (component) unmount(component);
  component = null;
  host?.remove();
  ui.attached.clear();
  ui.runState.clear();
  ui.error = null;
  ui.activeId = null;
  vi.restoreAllMocks();
});

describe("composer send", () => {
  it("Enter trims the text, sends it to this session, and clears the box", () => {
    const send = vi.spyOn(ui, "sendPrompt").mockImplementation(() => {});
    render();

    type(" hi ");
    key("Enter");

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(SID, "hi");
    expect(textarea().value).toBe("");
  });

  it("Shift+Enter does not send (it is a newline)", () => {
    const send = vi.spyOn(ui, "sendPrompt").mockImplementation(() => {});
    render();

    type("hi");
    key("Enter", { shiftKey: true });

    expect(send).not.toHaveBeenCalled();
    expect(textarea().value).toBe("hi");
  });

  it("Enter on an empty or whitespace-only box sends nothing", () => {
    const send = vi.spyOn(ui, "sendPrompt").mockImplementation(() => {});
    render();

    type("   ");
    key("Enter");

    expect(send).not.toHaveBeenCalled();
  });

  it("clicking Send (not Enter) sends the trimmed text to this session and clears the box", () => {
    const send = vi.spyOn(ui, "sendPrompt").mockImplementation(() => {});
    render();

    type(" hi ");
    button("Send").click();
    flushSync();

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(SID, "hi");
    expect(textarea().value).toBe("");
  });

  it("the submit control is an icon inside the field, disabled while empty", () => {
    vi.spyOn(ui, "sendPrompt").mockImplementation(() => {});
    render();

    const send = button("Send");
    // a symbol, not the word: no text label and a glyph child
    expect(send.textContent!.trim()).toBe("");
    expect(send.querySelector("svg")).not.toBeNull();
    expect(send.getAttribute("title")).toBe("Send");

    // it lives inside the field's wrapper, not beside it, and the field
    // reserves room so text cannot run under it
    const field = textarea();
    expect(field.parentElement!.contains(send)).toBe(true);
    expect(field.className).toContain("pr-12");

    // empty box: nothing to send, so the control is inert
    expect(button("Send").disabled).toBe(true);
    type("hi");
    expect(button("Send").disabled).toBe(false);
  });
});

describe("composer slash commands", () => {
  it("/new creates a session in the attached cwd and is never sent as a prompt", () => {
    const send = vi.spyOn(ui, "sendPrompt").mockImplementation(() => {});
    const created = vi.spyOn(ui, "newSession").mockResolvedValue(undefined);
    render();

    type("/new");
    key("Enter");

    expect(created).toHaveBeenCalledWith(CWD);
    expect(send).not.toHaveBeenCalled();
    expect(textarea().value).toBe("");
  });

  it("/new with no cwd on the attached session does nothing at all", () => {
    ui.attached.clear();
    attachSession({ cwd: "" });
    const send = vi.spyOn(ui, "sendPrompt").mockImplementation(() => {});
    const created = vi.spyOn(ui, "newSession").mockResolvedValue(undefined);
    render();

    type("/new");
    key("Enter");

    expect(created).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("/compact is a local compaction, not prompt text", () => {
    const send = vi.spyOn(ui, "sendPrompt").mockImplementation(() => {});
    const compacting = vi.spyOn(ui, "beginLocalCompaction").mockImplementation(() => {});
    const cmd = vi.spyOn(ui, "cmd").mockImplementation(() => {});
    render();

    type("/compact");
    key("Enter");

    expect(compacting).toHaveBeenCalledWith(SID);
    expect(cmd).toHaveBeenCalledWith({ type: "pi.compact", sessionId: SID });
    expect(send).not.toHaveBeenCalled();
    expect(textarea().value).toBe("");
  });
});

describe("composer stop control", () => {
  it("a running session shows Stop, and clicking it aborts that session", () => {
    const abort = vi.spyOn(ui, "abort").mockImplementation(() => {});
    ui.runState.set(SID, "streaming");
    render();

    // no Send while a run is in flight — Stop replaces it
    expect(host.querySelector('[aria-label="Send"]')).toBeNull();
    const stop = button("Stop");
    // the same icon treatment as Send, with a filled square glyph
    expect(stop.textContent!.trim()).toBe("");
    expect(stop.querySelector("svg")).not.toBeNull();
    stop.click();
    flushSync();

    expect(abort).toHaveBeenCalledTimes(1);
    expect(abort).toHaveBeenCalledWith(SID);
  });

  it("an idle session shows Send instead of Stop", () => {
    render();

    expect(host.querySelector('[aria-label="Send"]')).not.toBeNull();
    expect(host.querySelector('[aria-label="Stop"]')).toBeNull();
  });
});

describe("composer placeholder", () => {
  it("is just an ellipsis, idle or busy", () => {
    render();
    expect(textarea().placeholder).toBe("…");
    unmount(component!);
    component = null;
    host.remove();

    ui.runState.set(SID, "thinking");
    render();
    expect(textarea().placeholder).toBe("…");
  });
});

describe("composer queued-message chips", () => {
  it("shortens a long steer to a short chip label and a short cancel label", () => {
    ui.attached.set(SID, {
      ...ui.attached.get(SID)!,
      steering: ["please also refactor the whole parser while you are in there"],
    });
    render();

    const chip = host.querySelector<HTMLElement>(".truncate")!;
    expect(chip.textContent!.trim()).toBe("steer: please also…");
    const cancel = host.querySelector<HTMLButtonElement>('[aria-label="Cancel steer"]');
    expect(cancel).not.toBeNull();
  });

  it("collapses newlines so a multi-line prompt stays one short chip", () => {
    ui.attached.set(SID, {
      ...ui.attached.get(SID)!,
      followUp: ["first line\n\nsecond line\tand more"],
    });
    render();

    expect(host.querySelector<HTMLElement>(".truncate")!.textContent!.trim()).toBe(
      "followUp: first line second…",
    );
    expect(host.querySelector('[aria-label="Cancel follow-up"]')).not.toBeNull();
  });
});

describe("composer typography", () => {
  it("sizes the input like the transcript, not a step larger", () => {
    render();

    // The composer carries `text-chat`, the same token the message bodies use.
    // A bare `textarea`/`md:text-sm` would leave it at 14–16px above 13px
    // messages; the class is what lets app.css pin both to one size.
    const ta = textarea();
    expect(ta.className).toContain("text-chat");

    // and the token is the chat size, not a form-field size (class pin:
    // happy-dom does no layout, so the value itself is asserted in app.css)
    // vitest runs with the package root as cwd
    const css = readFileSync(resolve(process.cwd(), "src/app.css"), "utf8");
    expect(css).toMatch(/--text-chat:\s*0\.75rem/);
    // one unlayered rule owns the composer, so the touch 16px floor cannot
    // win outside iOS
    expect(css).toMatch(/textarea\.text-chat\s*\{\s*font-size:\s*var\(--text-chat\)/);
    // the iOS exception is nested inside a coarse-pointer query: macOS Safari
    // implements the same WebKit property and must keep the chat size
    expect(css).toMatch(/@supports \(-webkit-touch-callout: none\)/);
    expect(css).toMatch(/@media \(hover: none\) and \(pointer: coarse\)/);
    expect(css).toMatch(/font-size: 16px/);
  });
});
