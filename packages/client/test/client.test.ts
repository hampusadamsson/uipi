// Headless end-to-end test of the client abstraction.
//
// No Svelte, no DOM, no browser globals — this is exactly what a TUI (or any
// other frontend) would drive. It proves the protocol store is UI-independent.
import { describe, it, expect, beforeEach } from "vitest";
import { UipiClient } from "../src/client.js";
import { Conn, type WebSocketLike, type SocketFactory } from "../src/conn.js";
import { deriveTranscript } from "../src/transcript.js";
import { pathFor, hash8 } from "../src/route.js";
import type { S2C, SkillInfo, UiEvent } from "@uipi/protocol";

/** A fake server that answers commands like the real one does. */
class FakeServer {
  readonly sockets: FakeSocket[] = [];
  readonly factory: SocketFactory = (url) => {
    const s = new FakeSocket(url, this);
    this.sockets.push(s);
    return s;
  };
  sessionFile = "/home/u/.pi/agent/sessions/--proj--/abc.jsonl";
  sessionId = "sess-1";
  /** runtime state the fake server paints into attach / sessionState */
  role: string | null = null;
  model: { provider: string; modelId: string } | null = { provider: "p", modelId: "m" };
  thinkingLevel = "medium";
  tools = ["read"];
  statuses: Record<string, string> = {};
  /** skills the fake server discovers for any cwd */
  skills: SkillInfo[] = [
    { name: "commit", description: "Write a commit message", scope: "user" },
    { name: "deploy", description: "Deploy the project", scope: "project" },
  ];
  private roleSwitchSeq = 0;

  respond(socket: FakeSocket, msg: Record<string, unknown>): void {
    const reply = (m: S2C) =>
      socket.deliver({ ...m, ...(msg.id !== undefined ? { id: msg.id } : {}) } as S2C);

    switch (msg.type) {
      case "proto.listSessions":
        reply({
          type: "proto.sessions",
          sessions: [
            {
              sessionId: this.sessionId,
              sessionFile: this.sessionFile,
              displayName: "proj",
              firstMessage: "hi",
              mtime: 1,
              live: true,
              cwd: "/proj",
            },
          ],
        } as S2C);
        break;
      case "proto/listModels":
        reply({
          type: "proto.models",
          models: [
            { provider: "p", modelId: "m", displayName: "M", reasoning: true, contextWindow: 1000 },
          ],
        } as S2C);
        break;
      case "proto/recentDirs":
        reply({ type: "proto.recentDirs", dirs: [{ path: "/proj" }] } as S2C);
        break;
      case "proto.skills":
        reply({ type: "proto.skills", skills: this.skills } as S2C);
        break;
      case "proto.newSession":
      case "proto.openSession":
      case "proto.attach":
        reply({
          type: "proto.attached",
          sessionId: this.sessionId,
          messages: [{ role: "user", id: "u0", content: "earlier" }],
          model: this.model,
          thinkingLevel: this.thinkingLevel,
          tools: this.tools,
          role: this.role,
          commands: [{ name: "role", description: "Switch agent role" }],
          statuses: this.statuses,
          cwd: "/proj",
          isStreaming: false,
          steering: [],
          followUp: [],
          sessionFile: this.sessionFile,
        } as S2C);
        break;
      case "proto.setRole": {
        // real server: translate into the roles extension's own slash command,
        // which appends a `role-switch` entry (a pi.evt) and paints its status
        // slot; then re-read *all* runtime state from history and broadcast it.
        const role = (msg.role ?? null) as string | null;
        this.role = role;
        this.statuses = role ? { role: `◆ ${role}` } : {};
        socket.push({
          type: "pi.evt",
          sessionId: this.sessionId,
          event: {
            type: "entry_appended",
            entry: {
              type: "custom",
              customType: "role-switch",
              data: { role },
              id: `rs-${++this.roleSwitchSeq}`,
            },
          },
        });
        socket.push({ type: "proto.statuses", sessionId: this.sessionId, statuses: this.statuses });
        if (role) {
          // a role is an opinionated preset: model / thinking / tools move too
          this.model = { provider: "p", modelId: "m2" };
          this.thinkingLevel = "high";
          this.tools = ["read", "bash", "edit"];
        }
        socket.push({
          type: "proto.sessionState",
          sessionId: this.sessionId,
          role,
          model: this.model,
          thinkingLevel: this.thinkingLevel,
          tools: this.tools,
          commands: [{ name: "role", description: "Switch agent role" }],
        } as S2C);
        break;
      }
      case "proto.roleNames":
        // the real server answers from `/role`'s argument completions, reserved
        // words already filtered out
        reply({
          type: "proto.roleNames",
          sessionId: this.sessionId,
          names: ["work", "architect"],
        } as S2C);
        break;
      case "pi.prompt": {
        // real server: user echo, then streaming assistant text, then settle
        socket.push({ type: "pi.evt", sessionId: this.sessionId, event: { type: "agent_start" } });
        socket.push({
          type: "pi.evt",
          sessionId: this.sessionId,
          event: {
            type: "message_start",
            message: { role: "user", content: String(msg.text) },
          },
        });
        socket.push({
          type: "pi.evt",
          sessionId: this.sessionId,
          event: {
            type: "message_update",
            message: { role: "assistant", content: "hel" },
            assistantMessageEvent: { type: "text_delta", delta: "hel" },
          },
        });
        socket.push({
          type: "pi.evt",
          sessionId: this.sessionId,
          event: {
            type: "message_end",
            message: {
              role: "assistant",
              id: "a1",
              content: "hello!",
              stopReason: "stop",
              usage: { input: 100, cacheRead: 20, cacheWrite: 5 },
            },
          },
        });
        socket.push({
          type: "pi.evt",
          sessionId: this.sessionId,
          event: { type: "agent_settled" },
        });
        break;
      }
      case "pi.compact":
        socket.push({
          type: "pi.evt",
          sessionId: this.sessionId,
          event: { type: "compaction_end", summary: "condensed history" },
        });
        break;
      default:
        break;
    }
  }
}

class FakeSocket implements WebSocketLike {
  readyState = 1;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((err?: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  constructor(
    public url: string,
    private server: FakeServer,
  ) {}
  send(data: string): void {
    // deliver asynchronously, like a real socket
    const msg = JSON.parse(data);
    queueMicrotask(() => this.server.respond(this, msg));
  }
  close(): void {
    this.readyState = 3;
  }
  deliver(m: S2C): void {
    queueMicrotask(() => this.onmessage?.({ data: JSON.stringify(m) }));
  }
  push(m: S2C): void {
    this.deliver(m);
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0));

let server: FakeServer;
let client: UipiClient;

beforeEach(async () => {
  server = new FakeServer();
  client = new UipiClient(new Conn({ url: "ws://test/ws", createSocket: server.factory }));
  client.attach();
  server.sockets[0].onopen?.();
  await flush();
  await flush();
});

describe("UipiClient headless", () => {
  it("loads sessions, models and recent dirs on connect", () => {
    expect(client.connected).toBe(true);
    expect(client.sessions).toHaveLength(1);
    expect(client.models).toHaveLength(1);
    expect(client.recentDirs).toEqual(["/proj"]);
  });

  it("attaches to a new session and exposes its snapshot", async () => {
    await client.newSession("/proj");
    expect(client.activeId).toBe("sess-1");
    expect(client.active?.cwd).toBe("/proj");
    expect(client.active?.messages).toHaveLength(1);
    expect(client.effectiveModel("sess-1")).toEqual({ provider: "p", modelId: "m" });
  });

  it("drives run state from the pi event stream: thinking → streaming → idle", async () => {
    await client.newSession("/proj");
    const seen: string[] = [];
    client.onChange(() => {
      const s = client.stateOf("sess-1");
      if (seen.at(-1) !== s) seen.push(s);
    });

    client.sendPrompt("sess-1", "hello");
    await flush();
    await flush();

    expect(seen).toContain("thinking");
    expect(seen).toContain("streaming");
    expect(client.stateOf("sess-1")).toBe("idle");
  });

  it("records context tokens from assistant usage on message_end", async () => {
    await client.newSession("/proj");
    client.sendPrompt("sess-1", "hello");
    await flush();
    await flush();
    expect(client.contextTokens("sess-1")).toBe(125); // 100 + 20 + 5
  });

  it("renders the same transcript the web UI shows, with no framework", async () => {
    await client.newSession("/proj");
    client.sendPrompt("sess-1", "hello");
    await flush();
    await flush();

    const entries = deriveTranscript({
      messages: client.active!.messages,
      events: client.liveEvents("sess-1"),
      sentMessages: client.sentMessages("sess-1"),
    });
    const texts = entries.map((e) => e.text);
    expect(texts).toContain("earlier"); // snapshot
    expect(texts.join(" ")).toContain("hello!"); // final assistant text
    // the optimistic user message is settled by the authoritative echo
    expect(client.sentMessages("sess-1")).toHaveLength(0);
  });

  it("echoes a model pick instantly, then clears it when the server confirms", async () => {
    await client.newSession("/proj");
    client.cmd({ type: "pi.setModel", sessionId: "sess-1", provider: "p", modelId: "m2" });
    expect(client.pendingModel("sess-1")).toEqual({ provider: "p", modelId: "m2" });
    expect(client.effectiveModel("sess-1")).toEqual({ provider: "p", modelId: "m2" });

    server.sockets[0].deliver({
      type: "proto.sessionState",
      sessionId: "sess-1",
      role: null,
      model: { provider: "p", modelId: "m2" },
      thinkingLevel: "off",
      tools: [],
      commands: [],
    } as S2C);
    await flush();
    expect(client.pendingModel("sess-1")).toBeUndefined();
    expect(client.active?.model).toEqual({ provider: "p", modelId: "m2" });
  });

  it("surfaces server errors and clears them on demand", async () => {
    await client.newSession("/proj");
    server.sockets[0].deliver({ type: "proto.error", message: "boom" } as S2C);
    await flush();
    expect(client.error).toBe("boom");
    client.clearError();
    expect(client.error).toBeNull();
  });

  it("queues extension UI events and resolves them through the client", async () => {
    await client.newSession("/proj");
    server.sockets[0].deliver({
      type: "ui.event",
      event: { kind: "select", selectId: "ui1", sessionId: "sess-1", title: "pick", options: [] },
    } as S2C);
    await flush();
    const ev = client.getUiEvents()[0];
    expect(ev.kind).toBe("select");

    const sent: unknown[] = [];
    server.sockets[0].send = (d: string) => sent.push(JSON.parse(d));
    client.respondUi({ kind: "select", sessionId: "sess-1", selectId: "ui1" }, 2);
    expect(sent).toEqual([
      {
        type: "ui.selectResponse",
        sessionId: "sess-1",
        selectId: "ui1",
        index: 2,
      },
    ]);
    expect(client.getUiEvents()).toHaveLength(0);
  });

  it("drains a UI event by id, not by object identity", async () => {
    await client.newSession("/proj");
    server.sockets[0].deliver({
      type: "ui.event",
      event: {
        id: "ev1",
        kind: "notification",
        sessionId: "sess-1",
        level: "info",
        message: "Role: architect",
      },
    } as S2C);
    await flush();

    // what a reactive frontend hands back: a copy of the event, not the object
    // this store holds (a Svelte $state array wraps every element in a proxy)
    const copy = JSON.parse(JSON.stringify(client.getUiEvents()[0])) as UiEvent;
    expect(copy).not.toBe(client.getUiEvents()[0]);

    client.consumeUiEvent(copy);

    expect(client.getUiEvents()).toHaveLength(0);
  });

  it("consuming an already-drained event is a no-op that does not notify", async () => {
    await client.newSession("/proj");
    const ev: UiEvent = {
      id: "ev1",
      kind: "notification",
      sessionId: "sess-1",
      level: "info",
      message: "hi",
    };
    server.sockets[0].deliver({ type: "ui.event", event: ev } as S2C);
    await flush();
    client.consumeUiEvent(ev);

    let changes = 0;
    client.onChange(() => changes++);
    client.consumeUiEvent(ev);
    expect(changes).toBe(0);
  });

  it("a notification survives a re-sync as exactly one queue entry", async () => {
    await client.newSession("/proj");
    const ev: UiEvent = {
      id: "ev1",
      kind: "notification",
      sessionId: "sess-1",
      level: "info",
      message: "Role: architect",
    };
    server.sockets[0].deliver({ type: "ui.event", event: ev } as S2C);
    await flush();
    // unrelated traffic must not duplicate or resurrect the entry
    server.sockets[0].deliver({ type: "proto.sessions", sessions: [] } as S2C);
    await flush();

    expect(client.getUiEvents()).toHaveLength(1);
    client.consumeUiEvent(client.getUiEvents()[0]);
    expect(client.getUiEvents()).toHaveLength(0);
  });

  it("resolves a /s/<hash> path to the matching session", async () => {
    const path = pathFor(server.sessionFile);
    expect(path).toBe(`/s/${hash8(server.sessionFile)}`);
    const opened = await client.openPath(path);
    expect(opened).toBe(true);
    expect(client.activeId).toBe("sess-1");
    expect(client.activePath()).toBe(path);
  });

  it("calls onReady after connecting, once sessions are available", async () => {
    // simulate a fresh load: a new client, nothing attached yet
    const srv = new FakeServer();
    const c = new UipiClient(new Conn({ url: "ws://test/ws", createSocket: srv.factory }));
    let sessionsAtReady = -1;
    let pathAtReady = "";
    c.onReady = async (cl) => {
      // the frontend must be able to resolve a URL here — sessions are loaded
      sessionsAtReady = cl.sessions.length;
      pathAtReady = pathFor(cl.sessions[0].sessionFile);
      await cl.openPath(pathAtReady);
    };
    c.attach();
    srv.sockets[0].onopen?.();
    await flush();
    await flush();
    await flush();

    expect(sessionsAtReady).toBe(1);
    expect(c.activeId).toBe("sess-1");
    expect(c.activePath()).toBe(pathAtReady);
  });

  it("restores the URL session on reconnect, not just first connect", async () => {
    const srv = new FakeServer();
    const c = new UipiClient(new Conn({ url: "ws://test/ws", createSocket: srv.factory }));
    const readyPaths: string[] = [];
    c.onReady = async (cl) => {
      const p = pathFor(srv.sessionFile);
      readyPaths.push(p);
      await cl.openPath(p);
    };
    c.attach();
    srv.sockets[0].onopen?.();
    await flush();
    await flush();

    // drop the connection and let it come back — the frontend re-hydrates again
    srv.sockets[0].onclose?.();
    await new Promise((r) => setTimeout(r, 1200));
    srv.sockets.at(-1)!.onopen?.();
    await flush();
    await flush();

    expect(readyPaths.length).toBeGreaterThanOrEqual(2);
    expect(c.activeId).toBe("sess-1");
  });

  it("reports false for an unknown /s/<hash> path", async () => {
    expect(await client.openPath("/s/00000000")).toBe(false);
    expect(await client.openPath("/not-a-session")).toBe(false);
  });

  it("resolves role names from the correlated proto.roleNames reply", async () => {
    await client.newSession("/proj");
    await expect(client.roleNames("sess-1")).resolves.toEqual(["work", "architect"]);
  });

  it("asks for role names with the session id and correlates by request id", async () => {
    await client.newSession("/proj");
    const sent: Record<string, unknown>[] = [];
    const socket = server.sockets[0];
    const original = socket.send.bind(socket);
    socket.send = (d: string) => {
      sent.push(JSON.parse(d));
      original(d);
    };

    await client.roleNames("sess-1");

    const req = sent.find((m) => m.type === "proto.roleNames");
    expect(req).toMatchObject({ type: "proto.roleNames", sessionId: "sess-1" });
    // a request is always correlated, so the reply never lands in onMessage
    expect(typeof req?.id).toBe("string");
  });

  it("tracks a compaction entry in the transcript", async () => {
    await client.newSession("/proj");
    client.cmd({ type: "pi.compact", sessionId: "sess-1" });
    await flush();
    await flush();
    const entries = deriveTranscript({
      messages: client.active!.messages,
      events: client.liveEvents("sess-1"),
    });
    const compaction = entries.find((e) => e.kind === "compaction");
    expect(compaction?.text).toContain("condensed history");
  });

  // A role switch is one server round-trip that changes *everything* about the
  // session: role, model, thinking level and tool set. Before `sessionState`
  // folded those together, a switch left the header painting the old model /
  // thinking / tools (the deleted `proto.modelSet` only carried the model).
  // This drives the whole path headlessly: attach → setRole → one message.
  describe("role switch end to end", () => {
    it("attach reflects the session's role", async () => {
      server.role = "work";
      await client.newSession("/proj");
      expect(client.active?.role).toBe("work");
      expect(client.active?.tools).toEqual(["read"]);
      expect(client.active?.thinkingLevel).toBe("medium");
    });

    it("one sessionState updates role, model, thinkingLevel and tools together", async () => {
      server.role = "work";
      await client.newSession("/proj");
      expect(client.active).toMatchObject({
        role: "work",
        model: { provider: "p", modelId: "m" },
        thinkingLevel: "medium",
        tools: ["read"],
      });

      const sent: Record<string, unknown>[] = [];
      const socket = server.sockets[0];
      const originalSend = socket.send.bind(socket);
      socket.send = (d: string) => {
        sent.push(JSON.parse(d));
        originalSend(d);
      };

      // the picker's only write path: no local echo, the server is the truth
      client.cmd({ type: "proto.setRole", sessionId: "sess-1", role: "architect" });
      await flush();
      await flush();

      expect(sent.find((m) => m.type === "proto.setRole")).toEqual({
        type: "proto.setRole",
        sessionId: "sess-1",
        role: "architect",
      });

      // all four fields come from the same message — no stale header state
      expect(client.active?.role).toBe("architect");
      expect(client.active?.model).toEqual({ provider: "p", modelId: "m2" });
      expect(client.active?.thinkingLevel).toBe("high");
      expect(client.active?.tools).toEqual(["read", "bash", "edit"]);
      expect(client.effectiveModel("sess-1")).toEqual({ provider: "p", modelId: "m2" });
    });

    it("a switch also clears a stale optimistic model echo from an earlier pick", async () => {
      server.role = "work";
      await client.newSession("/proj");

      // an optimistic pick the server never confirmed (e.g. it was refused)
      client.cmd({ type: "pi.setModel", sessionId: "sess-1", provider: "p", modelId: "m9" });
      expect(client.pendingModel("sess-1")).toEqual({ provider: "p", modelId: "m9" });
      expect(client.effectiveModel("sess-1")).toEqual({ provider: "p", modelId: "m9" });

      // the role switch's sessionState is authoritative for the model too
      client.cmd({ type: "proto.setRole", sessionId: "sess-1", role: "architect" });
      await flush();
      await flush();

      expect(client.pendingModel("sess-1")).toBeUndefined();
      expect(client.effectiveModel("sess-1")).toEqual({ provider: "p", modelId: "m2" });
    });

    it("renders role → architect after the extension's entry_appended", async () => {
      server.role = "work";
      await client.newSession("/proj");
      client.cmd({ type: "proto.setRole", sessionId: "sess-1", role: "architect" });
      await flush();
      await flush();

      const events = client.liveEvents("sess-1") as { type?: string; entry?: unknown }[];
      expect(events.some((e) => e.type === "entry_appended")).toBe(true);

      const entries = deriveTranscript({
        messages: client.active!.messages,
        events,
      });
      const system = entries.filter((e) => e.kind === "system");
      expect(system).toHaveLength(1);
      expect(system[0].text).toBe("role → architect");
    });

    it("a sessionState with role: null clears the role (chip) state", async () => {
      server.role = "work";
      await client.newSession("/proj");
      expect(client.active?.role).toBe("work");

      const sent: Record<string, unknown>[] = [];
      const socket = server.sockets[0];
      const originalSend = socket.send.bind(socket);
      socket.send = (d: string) => {
        sent.push(JSON.parse(d));
        originalSend(d);
      };

      // the picker's `(none)` row: the null must survive the wire as a null,
      // not be dropped (undefined) or stringified
      client.cmd({ type: "proto.setRole", sessionId: "sess-1", role: null });
      await flush();
      await flush();

      expect(sent.find((m) => m.type === "proto.setRole")).toEqual({
        type: "proto.setRole",
        sessionId: "sess-1",
        role: null,
      });
      expect(client.active?.role).toBeNull();
    });

    it("an extension refusal paints the role the session has, not the requested one", async () => {
      server.role = "work";
      await client.newSession("/proj");
      // the extension refuses ("Agent busy") and re-reads history: same role
      server.sockets[0].deliver({
        type: "proto.sessionState",
        sessionId: "sess-1",
        role: "work",
        model: { provider: "p", modelId: "m" },
        thinkingLevel: "medium",
        tools: ["read"],
        commands: [],
      } as S2C);
      await flush();
      expect(client.active?.role).toBe("work");
      expect(client.active?.model).toEqual({ provider: "p", modelId: "m" });
      expect(client.active?.thinkingLevel).toBe("medium");
      expect(client.active?.tools).toEqual(["read"]);
    });

    it("a proto.statuses message carries the extension's ◆ <role> slot", async () => {
      server.role = "work";
      server.statuses = { role: "◆ work" };
      await client.newSession("/proj");
      // the attach snapshot already carries the extension's status slots
      expect(client.active?.statuses).toEqual({ role: "◆ work" });

      server.sockets[0].deliver({
        type: "proto.statuses",
        sessionId: "sess-1",
        statuses: { role: "◆ work", ctx: "42%" },
      } as S2C);
      await flush();

      expect(client.active?.statuses).toEqual({ role: "◆ work", ctx: "42%" });

      // a cleared slot disappears from the map (the map is replaced wholesale)
      server.sockets[0].deliver({
        type: "proto.statuses",
        sessionId: "sess-1",
        statuses: {},
      } as S2C);
      await flush();
      expect(client.active?.statuses).toEqual({});
    });
  });
  it("populates skills from the correlated proto.skills reply", async () => {
    await client.newSession("/proj");
    await client.refreshSkills("/proj");
    expect(client.skills).toEqual([
      { name: "commit", description: "Write a commit message", scope: "user" },
      { name: "deploy", description: "Deploy the project", scope: "project" },
    ]);
  });

  // The C2S request and the S2C reply share the `proto.skills` discriminant, so
  // the handler has to narrow on the payload instead of dropping the frame.
  it("applies a broadcast proto.skills reply instead of erroring", async () => {
    const skills: SkillInfo[] = [
      { name: "broadcast", description: "Pushed by the server", scope: "project" },
    ];
    server.sockets[0].push({ type: "proto.skills", skills } as S2C);
    await flush();

    expect(client.skills).toEqual(skills);
    expect(client.error).toBeNull();
  });
});
