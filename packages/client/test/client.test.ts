// Headless end-to-end test of the client abstraction.
//
// No Svelte, no DOM, no browser globals — this is exactly what a TUI (or any
// other frontend) would drive. It proves the protocol store is UI-independent.
import { describe, it, expect, beforeEach } from "vitest";
import { UipiClient } from "../src/client.js";
import { Conn, type WebSocketLike, type SocketFactory } from "../src/conn.js";
import { deriveTranscript } from "../src/transcript.js";
import { pathFor, hash8 } from "../src/route.js";
import type { S2C } from "@uipi/protocol";

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
      case "proto.newSession":
      case "proto.openSession":
      case "proto.attach":
        reply({
          type: "proto.attached",
          sessionId: this.sessionId,
          messages: [{ role: "user", id: "u0", content: "earlier" }],
          model: { provider: "p", modelId: "m" },
          thinkingLevel: "medium",
          tools: ["read"],
          cwd: "/proj",
          isStreaming: false,
          steering: [],
          followUp: [],
          sessionFile: this.sessionFile,
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
});
