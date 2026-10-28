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
  const el = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => b.textContent?.trim() === label,
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
    expect(host.textContent).not.toContain("Send");
    button("Stop").click();
    flushSync();

    expect(abort).toHaveBeenCalledTimes(1);
    expect(abort).toHaveBeenCalledWith(SID);
  });

  it("an idle session shows Send instead of Stop", () => {
    render();

    expect(host.textContent).toContain("Send");
    expect(host.textContent).not.toContain("Stop");
  });
});
