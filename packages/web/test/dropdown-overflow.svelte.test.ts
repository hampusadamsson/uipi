// Dropdown overflow: no dropdown may grow past the viewport.
//
// Two separate mechanisms, both pinned by class here:
//  - the `/` slash autocomplete in InputBox is *in flow* above the textarea, so
//    without a height cap each matching command pushes the composer down. It
//    must carry `max-h-56` + `overflow-y-auto` (a class pin — happy-dom does no
//    layout, so "bounded" can only be asserted as the class string).
//  - ModelPicker's Command.List must adapt to short windows via
//    `max-h-[min(24rem,50vh)]` rather than a fixed `max-h-96`.
//
// Mount-based, same shared-`ui`-singleton setup as sidebar-search.svelte.test.ts.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mount, unmount, flushSync } from "svelte";
import InputBox from "../src/components/InputBox.svelte";
import ModelPicker from "../src/components/ModelPicker.svelte";
import { ui } from "../src/lib/state.svelte.js";
import type { AttachedSession } from "@uipi/client";
import type { ModelInfo } from "@uipi/protocol";

const SID = "s1";
const CWD = "/proj";

let host: HTMLElement;
let component: ReturnType<typeof mount> | null = null;

/** a long command list, so an uncapped panel would be several screens tall */
const COMMANDS = Array.from({ length: 40 }, (_, i) => ({
  name: `cmd${String(i).padStart(2, "0")}`,
}));

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

function models(): ModelInfo[] {
  return Array.from({ length: 30 }, (_, i) => ({
    provider: "p",
    modelId: `m${i}`,
    displayName: `model ${i}`,
    reasoning: false,
    contextWindow: 1000,
  }));
}

function render(comp: typeof InputBox | typeof ModelPicker, props: Record<string, unknown>): void {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(comp as typeof InputBox, { target: host, props });
  flushSync();
}

/** type into the composer's textarea the way a keystroke would land in it */
function type(value: string): void {
  const el = host.querySelector<HTMLTextAreaElement>("textarea");
  expect(el).not.toBeNull();
  el!.value = value;
  el!.dispatchEvent(new Event("input", { bubbles: true }));
  flushSync();
}

/** the slash autocomplete panel — the only popover-rounded div above the textarea */
function slashPanel(): HTMLElement {
  const el = host.querySelector<HTMLElement>("div.rounded-md.border");
  expect(el, "no slash autocomplete panel").not.toBeNull();
  return el!;
}

beforeEach(() => {
  ui.attached.clear();
  ui.runState.clear();
  ui.error = null;
  ui.sessions = [];
  ui.models = [];
  ui.activeId = null;
  attachSession({ commands: COMMANDS });
});

afterEach(() => {
  if (component) unmount(component);
  component = null;
  host?.remove();
  document.body.innerHTML = "";
  ui.attached.clear();
  ui.runState.clear();
  ui.error = null;
  ui.activeId = null;
  ui.models = [];
  vi.restoreAllMocks();
});

describe("slash autocomplete overflow", () => {
  it("typing '/' renders the panel with a capped height and its own scrollbar", () => {
    render(InputBox, { sessionId: SID });

    type("/");

    const panel = slashPanel();
    const cls = panel.className;
    expect(cls).toContain("max-h-56");
    expect(cls).toContain("overflow-y-auto");
    expect(panel.querySelectorAll("button").length).toBeGreaterThan(20);
  });

  it("the panel stays bounded regardless of how many commands match (class pin)", () => {
    render(InputBox, { sessionId: SID });

    type("/");

    // class pin: happy-dom lays nothing out, so the honest assertion is that
    // the panel carries a bounded-height class instead of a computed height
    // that would scale with the row count.
    const cls = slashPanel().className;
    expect(cls).toContain("max-h-56");
    expect(cls).not.toContain("max-h-96");
  });

  it("closing the panel (Escape) removes the capped element", () => {
    render(InputBox, { sessionId: SID });

    type("/");
    expect(host.querySelectorAll("div.rounded-md.border")).toHaveLength(1);

    host
      .querySelector("textarea")!
      .dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    flushSync();

    expect(host.querySelectorAll("div.rounded-md.border")).toHaveLength(0);
  });
});

describe("model picker overflow", () => {
  it("Command.List caps at min(24rem, 50vh) so it fits a short window", () => {
    ui.models = models();
    render(ModelPicker, { sessionId: SID });

    const trigger = host.querySelector<HTMLButtonElement>("button");
    expect(trigger).not.toBeNull();
    trigger!.click();
    flushSync();

    const list = document.querySelector<HTMLElement>('[data-slot="command-list"]');
    expect(list, "no command list (popover did not open)").not.toBeNull();
    expect(list!.className).toContain("max-h-[min(24rem,50vh)]");
  });
});
