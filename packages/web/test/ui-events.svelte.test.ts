// Regression tests for the "Role: architect" toast that kept coming back.
//
// Root cause: `UiState.uiEvents` is a Svelte `$state` array, so every element the
// component reads is a *proxy*, never the object `UipiClient` stores. The client
// drained the queue with `filter((e) => e !== event)`, which silently matched
// nothing; the adapter's `events.length !== this.uiEvents.length` guard then kept
// the stale (deep-equal, so visually identical) copy, so `UiEventModal`'s
// `$effect` found the same notification again on the next unrelated sync and
// re-toasted it — forever, on every message.
//
// Three independent contracts are pinned here:
//  1. draining is keyed on `UiEvent.id`, so a re-synced copy is still removable
//  2. the adapter notices a same-length content change (the guard)
//  3. one switch produces one notification, and confirmations for state the web
//     already renders (the role chip) are dropped without a toast.
import { describe, it, expect } from "vitest";
import { UiState, isQuietNotification } from "../src/lib/state.svelte.js";
import type { AttachedSession } from "@uipi/client";
import type { S2C, UiEvent, UiNotification } from "@uipi/protocol";

function session(id: string, over: Partial<AttachedSession> = {}): AttachedSession {
  return {
    sessionId: id,
    model: { provider: "p", modelId: "m1" },
    thinkingLevel: "off",
    tools: [],
    role: null,
    commands: [],
    statuses: {},
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
  activeId: string | null;
  handle: (m: S2C) => void;
};

function setup(over: Partial<AttachedSession> = {}) {
  const ui = new UiState();
  const c = ui.client as unknown as Internals;
  c.attachedSessions.set("s1", session("s1", over));
  c.activeId = "s1";
  sync(ui);
  return { ui, c };
}

function sync(ui: UiState): void {
  (ui as unknown as { sync: () => void }).sync();
}

function notification(over: Partial<UiNotification> = {}): UiNotification {
  return {
    id: "ev1",
    kind: "notification",
    sessionId: "s1",
    level: "info",
    message: "Role: architect",
    ...over,
  };
}

/** Feed one notification through the client and mirror it into the adapter. */
function deliver(ui: UiState, c: Internals, event: UiEvent): void {
  c.handle({ type: "ui.event", event } as S2C);
  sync(ui);
}

describe("UI event drain is keyed on id", () => {
  it("removes a re-synced copy of the same event", () => {
    const { ui, c } = setup();
    deliver(ui, c, notification());

    // what the component holds: a proxy/copy, *not* the client's object
    const held = ui.uiEvents[0];
    expect(held).not.toBe(ui.client.getUiEvents()[0]);

    ui.consumeUiEvent(held);
    sync(ui);

    expect(ui.client.getUiEvents()).toHaveLength(0);
    expect(ui.uiEvents).toHaveLength(0);
  });

  it("draining the same id twice does not resurrect the event", () => {
    const { ui, c } = setup();
    deliver(ui, c, notification());
    const held = ui.uiEvents[0];

    ui.consumeUiEvent(held);
    sync(ui);
    ui.consumeUiEvent(held);
    sync(ui);

    expect(ui.uiEvents).toHaveLength(0);
  });
});

describe("adapter observes content changes with equal length", () => {
  it("picks up a same-length replacement (one drained, one arrived)", () => {
    const { ui, c } = setup();
    deliver(ui, c, notification({ id: "ev1", message: "first" }));
    expect(ui.uiEvents.map((e) => e.id)).toEqual(["ev1"]);

    // one leaves, one arrives: the client array is a *different* event at the
    // same length. A length-only guard would keep showing "first".
    ui.client.consumeUiEvent(ui.client.getUiEvents()[0]);
    deliver(ui, c, notification({ id: "ev2", message: "second" }));

    expect(ui.uiEvents.map((e) => e.id)).toEqual(["ev2"]);
    expect(ui.uiEvents.map((e) => (e as UiNotification).message)).toEqual(["second"]);
  });

  it("keeps the same array reference when nothing changed", () => {
    const { ui, c } = setup();
    deliver(ui, c, notification());
    const before = ui.uiEvents;

    sync(ui); // unrelated sync

    expect(ui.uiEvents).toBe(before);
  });
});

describe("one role switch → one toastable notification", () => {
  /** Present queued notifications the way UiEventModal does, counting toasts. */
  function drain(ui: UiState): string[] {
    const toasted: string[] = [];
    while (ui.drainNotification((n) => toasted.push(n.message))) {
      /* keep draining */
    }
    return toasted;
  }

  it("produces exactly one notification in the web layer", () => {
    const { ui, c } = setup({ role: "work" });
    // server: `proto.setRole` → extension notifies once (tagged as uipi-initiated)
    deliver(ui, c, notification({ id: "ev1", origin: "setRole", message: "Role: architect" }));

    expect(ui.uiEvents.filter((e) => e.kind === "notification")).toHaveLength(1);
  });

  it("does not toast the confirmation, because the chip already shows the role", () => {
    const { ui, c } = setup();
    deliver(ui, c, notification({ id: "ev1", origin: "setRole", message: "Role: architect" }));
    c.handle({
      type: "proto.sessionState",
      sessionId: "s1",
      role: "architect",
      model: null,
      thinkingLevel: "off",
      tools: [],
      commands: [],
    } as S2C);
    sync(ui);

    expect(ui.roleOf("s1")).toBe("architect");
    expect(drain(ui)).toEqual([]); // acknowledgement, not a toast
    expect(ui.uiEvents).toHaveLength(0); // and it is still drained
  });

  it("a re-synced copy of that notification never toasts twice", () => {
    const { ui, c } = setup();
    deliver(ui, c, notification({ id: "ev1", origin: "setRole" }));
    const held = ui.uiEvents[0];

    expect(drain(ui)).toEqual([]);
    // a redundant re-sync of the very same event object/id
    sync(ui);
    ui.consumeUiEvent(held);
    sync(ui);

    expect(drain(ui)).toEqual([]);
    expect(ui.uiEvents).toHaveLength(0);
  });

  it("still toasts an extension's own warnings, e.g. a busy refusal", () => {
    const { ui, c } = setup({ role: "work" });
    deliver(
      ui,
      c,
      notification({
        id: "ev9",
        level: "error",
        message: "Agent busy — switch roles when idle",
      }),
    );

    expect(drain(ui)).toEqual(["Agent busy — switch roles when idle"]);
  });
});

describe("isQuietNotification", () => {
  it("only silences clean confirmations of a uipi-initiated switch", () => {
    expect(isQuietNotification(notification({ origin: "setRole" }))).toBe(true);
    // untagged: raised by the extension on its own initiative
    expect(isQuietNotification(notification())).toBe(false);
    // a warning/error carries a fact the chip cannot show
    expect(isQuietNotification(notification({ origin: "setRole", level: "warn" }))).toBe(false);
    expect(isQuietNotification(notification({ origin: "setRole", level: "error" }))).toBe(false);
    expect(
      isQuietNotification({
        id: "ev2",
        kind: "select",
        selectId: "ui1",
        sessionId: "s1",
        title: "pick",
        options: [],
      }),
    ).toBe(false);
  });
});
