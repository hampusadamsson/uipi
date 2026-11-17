// The thinking-level picker must offer every level pi has, and must show the
// level the session actually holds rather than the one that was clicked.
//
// Two bugs this pins:
//
//  1. Two of pi's seven levels were missing (`off` and `max`), so a session
//     raised to `high` could never be turned back off from the UI.
//  2. The picker read the *attached* value only. pi clamps a request to what the
//     model supports, so between the click and the server's reply the chip would
//     snap back to the old level — and on a non-reasoning model it would never
//     move at all, with nothing explaining why.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mount, unmount, flushSync } from "svelte";
import ThinkingPicker from "../src/components/ThinkingPicker.svelte";
import { ui } from "../src/lib/state.svelte.js";
import type { AttachedSession } from "@uipi/client";
import type { ModelInfo } from "@uipi/protocol";

const SID = "s1";
let host: HTMLElement;
let component: ReturnType<typeof mount> | null = null;

function attach(over: Partial<AttachedSession> = {}): void {
  ui.attached.set(SID, {
    sessionId: SID,
    cwd: "/proj",
    model: { provider: "bifrost", modelId: "opencode-go/deepseek-v4.1-flash" },
    thinkingLevel: "medium",
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
    ...over,
  } as AttachedSession);
}

function model(over: Partial<ModelInfo> = {}): ModelInfo {
  return {
    provider: "bifrost",
    modelId: "opencode-go/deepseek-v4.1-flash",
    displayName: "Deepseek",
    reasoning: true,
    contextWindow: 1000,
    ...over,
  };
}

function render(): void {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(ThinkingPicker, { target: host, props: { sessionId: SID } });
  flushSync();
}

function open(): string[] {
  host.querySelector<HTMLButtonElement>("button")!.click();
  flushSync();
  return [...document.querySelectorAll<HTMLElement>('[data-slot="popover-content"] button')].map(
    (b) => (b.textContent ?? "").trim(),
  );
}

beforeEach(() => {
  ui.attached.clear();
  ui.pendingThinking.clear();
  ui.models = [];
  ui.activeId = SID;
});

afterEach(() => {
  if (component) unmount(component);
  component = null;
  host?.remove();
  document.body.innerHTML = "";
  ui.attached.clear();
  ui.pendingThinking.clear();
  ui.models = [];
});

describe("levels offered", () => {
  it("offers every level pi defines, including off and max", () => {
    attach();
    render();
    const labels = open();
    // off is a real level (a non-reasoning model reports exactly it); omitting it
    // made "turn thinking off again" unreachable. Capitalisation is CSS, so the
    // text content is the level itself.
    expect(labels).toEqual(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
  });

  it("shows the attached level as current", () => {
    attach({ thinkingLevel: "xhigh" });
    render();
    // the chip names the level in effect
    expect(host.querySelector("button")!.textContent).toContain("xhigh");
  });
});

describe("optimistic echo", () => {
  it("shows a pending level immediately, before the server replies", () => {
    attach({ thinkingLevel: "off" });
    ui.pendingThinking.set(SID, "high");
    render();
    expect(host.querySelector("button")!.textContent).toContain("high");
  });

  it("prefers the pending echo over the attached value while it exists", () => {
    // clicking `high` on a model that clamps: the echo shows `high` until the
    // broadcast replaces it with what the session really has
    attach({ thinkingLevel: "medium" });
    ui.pendingThinking.set(SID, "high");
    render();
    expect(host.querySelector("button")!.textContent).toContain("high");

    // the broadcast arrives: the echo is dropped and the real value wins
    ui.pendingThinking.delete(SID);
    attach({ thinkingLevel: "medium" });
    flushSync();
    expect(host.querySelector("button")!.textContent).toContain("medium");
  });
});

describe("explaining a level that will not take", () => {
  it("says so when the current model does not report reasoning", () => {
    ui.models = [model({ reasoning: false })];
    attach({ thinkingLevel: "off" });
    render();
    open();
    // otherwise the user clicks `high`, the chip stays "off", and nothing says why
    expect(document.body.textContent).toContain("does not report reasoning");
  });

  it("stays quiet for a reasoning model", () => {
    ui.models = [model({ reasoning: true })];
    attach({ thinkingLevel: "medium" });
    render();
    open();
    expect(document.body.textContent).not.toContain("does not report reasoning");
  });
});
