// Regression tests for the Svelte adapter's change-detection contract.
//
// The bug: changing the model in the UI did not update anything until a page
// refresh. Two causes, both fixed:
//
//  1. reads (`stateOf`, `modelOf`) went to `this.client.*`. The client is a
//     plain object, so a $derived over those reads never invalidated.
//  2. `proto.sessionState` mutated the attached-session object in place. Svelte's
//     SvelteMap only notifies when the stored VALUE changes identity
//     (`prev_res !== value`), so re-setting the same object was a no-op.
//
// These tests pin the invariants that make the UI update without a refresh —
// they do not need a live Svelte effect to be meaningful.
import { describe, it, expect } from "vitest";
import { UiState } from "../src/lib/state.svelte.js";
import type { AttachedSession } from "@uipi/client";
import type { S2C } from "@uipi/protocol";

function session(id: string, over: Partial<AttachedSession> = {}): AttachedSession {
  return {
    sessionId: id,
    model: { provider: "p", modelId: "m1" },
    thinkingLevel: "off",
    tools: [],
    role: null,
    cwd: "/proj",
    isStreaming: false,
    steering: [],
    followUp: [],
    sessionFile: "/tmp/s.jsonl",
    messages: [],
    events: [],
    ...over,
  } as AttachedSession;
}

type Internals = {
  attachedSessions: Map<string, AttachedSession>;
  runStateById: Map<string, string>;
  activeId: string | null;
  handle: (m: S2C) => void;
};

/** Build an adapter with one attached session, mirrors already synced. */
function setup() {
  const ui = new UiState();
  const c = ui.client as unknown as Internals;
  c.attachedSessions.set("s1", session("s1"));
  c.activeId = "s1";
  sync(ui);
  return { ui, c };
}

function sync(ui: UiState): void {
  (ui as unknown as { sync: () => void }).sync();
}

describe("UiState model change without refresh", () => {
  it("modelOf reads the reactive mirror, not the raw client", () => {
    const { ui, c } = setup();
    expect(ui.modelOf("s1")?.modelId).toBe("m1");

    // server confirms a different model
    c.attachedSessions.set("s1", session("s1", { model: { provider: "p", modelId: "m2" } }));
    sync(ui);

    expect(ui.modelOf("s1")?.modelId).toBe("m2");
  });

  it("a confirmed model replaces the attached object with a NEW reference", () => {
    const { ui, c } = setup();
    const before = ui.attached.get("s1");
    expect(before).toBeDefined();

    // this is what the client now does on proto.sessionState
    c.handle({
      type: "proto.sessionState",
      sessionId: "s1",
      role: null,
      model: { provider: "p", modelId: "m2" },
      thinkingLevel: "off",
      tools: [],
      commands: [],
    } as S2C);
    sync(ui);

    const after = ui.attached.get("s1");
    // identity must change, or SvelteMap.set() is a silent no-op
    expect(after).not.toBe(before);
    expect(after?.model).toEqual({ provider: "p", modelId: "m2" });
    expect(ui.modelOf("s1")?.modelId).toBe("m2");
  });

  it("does not mutate the attached session in place", () => {
    const { c } = setup();
    const before = c.attachedSessions.get("s1")!;
    const modelBefore = before.model;
    c.handle({
      type: "proto.sessionState",
      sessionId: "s1",
      role: null,
      model: { provider: "p", modelId: "m2" },
      thinkingLevel: "off",
      tools: [],
      commands: [],
    } as S2C);
    // the original object keeps its old value → callers holding it can't be
    // silently mutated, and reference equality is meaningful
    expect(before.model).toBe(modelBefore);
    expect(c.attachedSessions.get("s1")).not.toBe(before);
  });

  it("shows the optimistic pick immediately, then settles", () => {
    const { ui, c } = setup();
    ui.cmd({ type: "pi.setModel", sessionId: "s1", provider: "p", modelId: "m9" });
    sync(ui);
    expect(ui.modelOf("s1")?.modelId).toBe("m9"); // instant

    c.handle({
      type: "proto.sessionState",
      sessionId: "s1",
      role: null,
      model: { provider: "p", modelId: "m9" },
      thinkingLevel: "off",
      tools: [],
      commands: [],
    } as S2C);
    sync(ui);
    expect(ui.pendingModel.has("s1")).toBe(false);
    expect(ui.modelOf("s1")?.modelId).toBe("m9");
  });
});

describe("UiState run state without refresh", () => {
  it("stateOf reads the reactive mirror", () => {
    const { ui, c } = setup();
    expect(ui.stateOf("s1")).toBe("idle");

    c.runStateById.set("s1", "thinking");
    sync(ui);
    expect(ui.stateOf("s1")).toBe("thinking");

    c.runStateById.set("s1", "idle");
    sync(ui);
    expect(ui.stateOf("s1")).toBe("idle");
  });

  it("returns idle for unknown or missing sessions", () => {
    const { ui } = setup();
    expect(ui.stateOf(null)).toBe("idle");
    expect(ui.stateOf("nope")).toBe("idle");
    expect(ui.modelOf(null)).toBeUndefined();
  });
});
