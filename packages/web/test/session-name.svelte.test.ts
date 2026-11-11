// Session-name plumbing for the sidebar: the row label must prefer the *live*
// name a `proto.sessionName` push carries, then the summary's `displayName`
// (which already prefers `info.name` but only refreshes with the list), then the
// session file's name — so a `/name foo` shows up instantly, no refresh.
//
// Mount-based, against the shared `ui` singleton like sidebar.svelte.test.ts:
// the name travels the real path (client `handle` → `onChange` → `sync()`), and
// only the socket is absent.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mount, unmount, flushSync } from "svelte";
import Sidebar from "../src/components/Sidebar.svelte";
import { ui } from "../src/lib/state.svelte.js";
import type { AttachedSession } from "@uipi/client";
import type { S2C, SessionSummary } from "@uipi/protocol";

type Internals = {
  attachedSessions: Map<string, AttachedSession>;
  sessionNameById: Map<string, string>;
  activeId: string | null;
  handle: (m: S2C) => void;
};

const client = () => ui.client as unknown as Internals;

function attached(sessionId: string): AttachedSession {
  return {
    sessionId,
    model: null,
    thinkingLevel: "off",
    tools: [],
    role: null,
    commands: [],
    statuses: {},
    cwd: "/proj",
    isStreaming: false,
    steering: [],
    followUp: [],
    sessionFile: "/tmp/s1.jsonl",
    messages: [],
    events: [],
  } as AttachedSession;
}

function summary(over: Partial<SessionSummary> = {}): SessionSummary {
  return {
    sessionId: "s1",
    sessionFile: "/tmp/s1.jsonl",
    displayName: "summary label",
    firstMessage: "hi",
    mtime: 0,
    live: true,
    cwd: "/proj",
    role: null,
    ...over,
  };
}

let host: HTMLElement;
let component: ReturnType<typeof mount> | null = null;

function render(): HTMLElement {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(Sidebar, { target: host });
  flushSync();
  return host;
}

/** the label line of the first session row (the live dot contributes no text) */
function label(): string {
  const rows = [...host.querySelectorAll<HTMLButtonElement>("button")].filter((b) =>
    b.className.includes("min-h-11"),
  );
  return (rows[0]?.firstElementChild?.textContent ?? "").trim();
}

/** one server push, through the client and the adapter sync it triggers */
function push(m: S2C): void {
  client().handle(m);
  flushSync();
}

function setName(name: string | null): void {
  push({ type: "proto.sessionName", sessionId: "s1", name } as S2C);
}

beforeEach(() => {
  ui.sessions = [summary()];
  ui.error = null;
  // the singleton's client keeps per-session state across tests: reset it, then
  // attach the one session the sidebar row renders
  client().attachedSessions.clear();
  client().sessionNameById.clear();
  client().attachedSessions.set("s1", attached("s1"));
  client().activeId = "s1";
  push({ type: "proto.sessions", sessions: ui.sessions } as S2C);
});

afterEach(() => {
  if (component) unmount(component);
  component = null;
  host?.remove();
  vi.restoreAllMocks();
  client().attachedSessions.clear();
  client().sessionNameById.clear();
  client().activeId = null;
});

describe("sidebar session row label", () => {
  it("falls back to the summary's displayName when the session is unnamed", () => {
    render();
    expect(label()).toContain("summary label");
  });

  it("renders the pushed name, ahead of the summary's displayName", () => {
    render();
    setName("deploy helper");

    expect(label()).toContain("deploy helper");
    expect(label()).not.toContain("summary label");
  });

  it("updates in place when the name changes again", () => {
    render();
    setName("deploy helper");
    expect(label()).toContain("deploy helper");

    setName("release notes");
    expect(label()).toContain("release notes");
    expect(label()).not.toContain("deploy helper");
  });

  it("falls back to the summary again once the name is cleared", () => {
    render();
    setName("deploy helper");
    expect(label()).toContain("deploy helper");

    setName(null);
    expect(label()).toContain("summary label");
    expect(label()).not.toContain("deploy helper");
  });

  it("follows the rename of a row that is not the active session", () => {
    ui.sessions = [summary({ sessionId: "s2", sessionFile: "/tmp/s2.jsonl", live: false })];
    client().attachedSessions.set("s2", attached("s2"));
    push({ type: "proto.sessions", sessions: ui.sessions } as S2C);
    render();

    push({ type: "proto.sessionName", sessionId: "s2", name: "background rename" } as S2C);
    expect(label()).toContain("background rename");
  });

  it("the summary's own name still wins over the file name", () => {
    // displayName already prefers pi's `info.name`; a refresh is what carries it
    ui.sessions = [summary({ displayName: "from summary", sessionFile: "/tmp/abc123.jsonl" })];
    push({ type: "proto.sessions", sessions: ui.sessions } as S2C);
    render();

    expect(label()).toContain("from summary");
    expect(label()).not.toContain("abc123.jsonl");
  });
});

describe("adapter name read", () => {
  it("sessionNameOf mirrors the client's per-session name", () => {
    expect(ui.sessionNameOf(null)).toBeNull();
    expect(ui.sessionNameOf("s1")).toBeNull();

    setName("deploy helper");
    expect(ui.sessionNameOf("s1")).toBe("deploy helper");

    setName("");
    expect(ui.sessionNameOf("s1")).toBeNull();
  });

  it("setSessionName forwards to the client and adopts the resulting name", async () => {
    const spy = vi
      .spyOn(ui.client, "setSessionName")
      .mockImplementation(async (sessionId: string, name: string) => {
        client().sessionNameById.set(sessionId, name);
      });

    await ui.setSessionName("s1", "deploy helper");

    expect(spy).toHaveBeenCalledWith("s1", "deploy helper");
    expect(ui.sessionNameOf("s1")).toBe("deploy helper");
  });
});
