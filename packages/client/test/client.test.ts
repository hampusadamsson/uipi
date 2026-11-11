// Headless end-to-end test of the client abstraction.
//
// No Svelte, no DOM, no browser globals — this is exactly what a TUI (or any
// other frontend) would drive. It proves the protocol store is UI-independent.
import { describe, it, expect, beforeEach } from "vitest";
import { UipiClient } from "../src/client.js";
import { Conn, type WebSocketLike, type SocketFactory } from "../src/conn.js";
import { deriveTranscript } from "../src/transcript.js";
import { pathFor, hash8 } from "../src/route.js";
import type { ConfigId, S2C, SkillInfo, UiEvent } from "@uipi/protocol";

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
  /** the session's own display name, as pi persists it */
  name: string | null = null;
  /** every proto.setSessionName frame the client sent, in order */
  sessionNames: { sessionId: string; name: string }[] = [];
  model: { provider: string; modelId: string } | null = { provider: "p", modelId: "m" };
  thinkingLevel = "medium";
  tools = ["read"];
  statuses: Record<string, string> = {};
  /** skills the fake server discovers for any cwd */
  skills: SkillInfo[] = [
    { name: "commit", description: "Write a commit message", scope: "user" },
    { name: "deploy", description: "Deploy the project", scope: "project" },
  ];
  /** skill files the fake server can hand back, keyed by slug */
  skillFiles = new Map<string, { frontmatter: string; body: string }>([
    ["commit", { frontmatter: "name: commit\ndisable-model-invocation: true", body: "Body.\n" }],
  ]);
  /** editable config documents, keyed by the server-owned id */
  configs = new Map<ConfigId, { mtimeMs: number; text: string }>([
    ["settings", { mtimeMs: 1000, text: '{\n  "model": "p/m"\n}\n' }],
    ["roles", { mtimeMs: 2000, text: '{\n  "work": {}\n}\n' }],
  ]);
  /** last proto.configUpdate the client sent, for mtime assertions */
  lastConfigUpdate: { docId: ConfigId; mtimeMs: number; text: string } | null = null;
  /** raw proto.configGet frames the fake server received, correlation id and all */
  configGetFrames: Record<string, unknown>[] = [];
  /** last proto.skillWrite the client sent */
  lastSkillWrite: {
    op: string;
    name: string;
    frontmatter?: string;
    body?: string;
  } | null = null;
  /** every proto.reloadConfig the client sent, in order */
  reloads: string[] = [];
  /** live session ids a reload reaches (the server reports what it applied to) */
  liveSessions: string[] = ["sess-1"];
  /** what a reload throws, or null when it succeeds */
  reloadError: string | null = null;
  private roleSwitchSeq = 0;

  /** Another editor touched a document: the next save must lose the race. */
  externalEdit(id: ConfigId, text: string): void {
    const cur = this.configs.get(id)!;
    this.configs.set(id, { mtimeMs: cur.mtimeMs + 500, text });
  }

  /** Push a conflict frame on the wire (uncorrelated), for broadcast handling. */
  emitConflict(id: ConfigId): void {
    const cur = this.configs.get(id)!;
    this.sockets[0]?.push({
      type: "proto.configConflict",
      docId: id,
      mtimeMs: cur.mtimeMs,
      text: cur.text,
    } as S2C);
  }

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
      case "proto.skillWrite": {
        // real server: resolve name → file itself, write, then ack the name
        this.lastSkillWrite = {
          op: String(msg.op),
          name: String(msg.name),
          ...(msg.frontmatter !== undefined ? { frontmatter: String(msg.frontmatter) } : {}),
          ...(msg.body !== undefined ? { body: String(msg.body) } : {}),
        };
        const name = String(msg.name);
        if (msg.op === "delete") this.skills = this.skills.filter((s) => s.name !== name);
        else if (!this.skills.some((s) => s.name === name)) {
          this.skills = [...this.skills, { name, description: "Written", scope: "project" }];
        }
        reply({ type: "proto.skillWrite", name } as S2C);
        break;
      }
      case "proto.skillGet": {
        // real server: resolve the slug itself, answer proto.error when missing
        const name = String(msg.name);
        const file = this.skillFiles.get(name);
        if (!file) {
          reply({ type: "proto.error", message: `skill ${name} does not exist` } as S2C);
          break;
        }
        reply({ type: "proto.skillGet", name, ...file } as S2C);
        break;
      }
      case "proto.configList":
        reply({
          type: "proto.configList",
          docs: [...this.configs].map(([id, d]) => ({ id, mtimeMs: d.mtimeMs })),
        } as S2C);
        break;
      case "proto.configGet": {
        this.configGetFrames.push(msg);
        const id = msg.docId as ConfigId;
        const cur = this.configs.get(id)!;
        reply({ type: "proto.configGet", doc: { docId: id, ...cur } } as S2C);
        break;
      }
      case "proto.reloadConfig": {
        // real server: re-read the document on every live session and reply with
        // the ids it reached — an empty list means there was nothing live
        this.reloads.push(String(msg.what));
        if (this.reloadError !== null) {
          reply({ type: "proto.error", message: this.reloadError } as S2C);
          break;
        }
        reply({
          type: "proto.reloadConfig",
          what: String(msg.what),
          sessions: [...this.liveSessions],
        } as S2C);
        break;
      }
      case "proto.configUpdate": {
        // real server: compare the echoed mtime, answer a conflict instead of
        // overwriting when it moved, otherwise re-read and reply with the new doc
        const id = msg.docId as ConfigId;
        this.lastConfigUpdate = {
          docId: id,
          mtimeMs: Number(msg.mtimeMs),
          text: String(msg.text),
        };
        const cur = this.configs.get(id)!;
        if (Number(msg.mtimeMs) !== cur.mtimeMs) {
          reply({
            type: "proto.configConflict",
            docId: id,
            mtimeMs: cur.mtimeMs,
            text: cur.text,
          } as S2C);
          break;
        }
        const next = { mtimeMs: cur.mtimeMs + 1, text: String(msg.text) };
        this.configs.set(id, next);
        reply({ type: "proto.configUpdate", doc: { docId: id, ...next } } as S2C);
        break;
      }
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
          name: this.name,
          commands: [{ name: "role", description: "Switch agent role" }],
          statuses: this.statuses,
          cwd: "/proj",
          isStreaming: false,
          steering: [],
          followUp: [],
          sessionFile: this.sessionFile,
        } as S2C);
        break;
      case "proto.setSessionName": {
        // real server: pi trims and persists the name itself (an empty name
        // clears it), then broadcasts it and replies with the same frame
        this.sessionNames.push({ sessionId: String(msg.sessionId), name: String(msg.name) });
        const name = String(msg.name).trim();
        this.name = name || null;
        socket.push({ type: "proto.sessionName", sessionId: this.sessionId, name: this.name });
        reply({ type: "proto.sessionName", sessionId: this.sessionId, name: this.name } as S2C);
        break;
      }
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
          name: this.name,
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
        // Real server, faithfully: a user turn is a *loop* of agent iterations.
        // Each iteration ends with `agent_end`, the session then continues (a
        // tool call, queued input, retry…), and only `agent_settled` means the
        // agent is idle and waiting for the user again. The UI must stay in
        // Stop for the whole span.
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
        // iteration boundary: the loop rolls on into a tool call
        socket.push({
          type: "pi.evt",
          sessionId: this.sessionId,
          event: { type: "agent_end", messages: [] },
        });
        socket.push({ type: "pi.evt", sessionId: this.sessionId, event: { type: "agent_start" } });
        socket.push({
          type: "pi.evt",
          sessionId: this.sessionId,
          event: { type: "tool_execution_start", toolCallId: "t1", toolName: "read", args: {} },
        });
        socket.push({
          type: "pi.evt",
          sessionId: this.sessionId,
          event: {
            type: "tool_execution_end",
            toolCallId: "t1",
            toolName: "read",
            result: "ok",
            isError: false,
          },
        });
        socket.push({
          type: "pi.evt",
          sessionId: this.sessionId,
          event: { type: "agent_end", messages: [] },
        });
        socket.push({
          type: "pi.evt",
          sessionId: this.sessionId,
          event: { type: "agent_settled", aborted: false },
        });
        break;
      }
      case "pi.compact":
        socket.push({
          type: "pi.evt",
          sessionId: this.sessionId,
          event: { type: "compaction_start", reason: "manual" },
        });
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

  // Regression: the send button flipped Stop↔Send between *agent iterations*.
  // pi's run is a loop — each iteration ends with `agent_end`, and the session
  // continues into the next one. Treating `agent_end`/`message_end` as "idle"
  // made the UI claim user input was expected mid-run.
  it("stays non-idle across agent-loop iterations until agent_settled", async () => {
    await client.newSession("/proj");
    const seen: string[] = [];
    client.onChange(() => {
      const s = client.stateOf("sess-1");
      if (seen.at(-1) !== s) seen.push(s);
    });

    client.sendPrompt("sess-1", "hello");
    await flush();
    await flush();

    // Drop the idle sample emitted before the prompt (attach/refresh emits) and
    // assert on the run itself: no idle blip between the two iterations.
    const run = seen.slice(seen.indexOf("thinking"));
    expect(run.filter((s) => s === "idle")).toHaveLength(1);
    expect(run.at(-1)).toBe("idle");
    // …and it did pass through a tool phase between them
    expect(run).toContain("tooling");
    // the tool phase came *between* the two iterations, never after settling
    expect(run.indexOf("tooling")).toBeLessThan(run.indexOf("idle"));
  });

  it("ignores agent_end and message_end as run enders", async () => {
    await client.newSession("/proj");
    // drive the events directly, so no fake prompt reply races them
    server.sockets[0].push({
      type: "pi.evt",
      sessionId: "sess-1",
      event: { type: "agent_start" },
    } as S2C);
    await flush();
    expect(client.stateOf("sess-1")).toBe("thinking");
    expect(client.runActive("sess-1")).toBe(true);

    for (const event of [
      { type: "agent_end", messages: [] },
      { type: "message_end", message: { role: "assistant", stopReason: "stop" } },
      { type: "agent_end", messages: [] },
    ]) {
      server.sockets[0].push({ type: "pi.evt", sessionId: "sess-1", event } as S2C);
      await flush();
      expect(client.stateOf("sess-1")).not.toBe("idle");
      expect(client.runActive("sess-1")).toBe(true);
    }

    server.sockets[0].push({
      type: "pi.evt",
      sessionId: "sess-1",
      event: { type: "agent_settled", aborted: false },
    } as S2C);
    await flush();
    expect(client.stateOf("sess-1")).toBe("idle");
    expect(client.runActive("sess-1")).toBe(false);
  });

  it("settles a manual compaction when no agent run wraps it", async () => {
    await client.newSession("/proj");
    client.beginLocalCompaction("sess-1");
    expect(client.stateOf("sess-1")).toBe("thinking");

    client.cmd({ type: "pi.compact", sessionId: "sess-1" });
    await flush();
    await flush();

    // compaction_end settles it: manual compaction runs while the agent is
    // idle, so no agent_settled follows
    expect(client.stateOf("sess-1")).toBe("idle");
    expect(client.runActive("sess-1")).toBe(false);
  });

  it("keeps the run open when auto-compaction will retry", async () => {
    await client.newSession("/proj");
    server.sockets[0].push({
      type: "pi.evt",
      sessionId: "sess-1",
      event: { type: "agent_start" },
    } as S2C);
    await flush();
    for (const event of [
      { type: "compaction_start", reason: "overflow" },
      { type: "compaction_end", reason: "overflow", willRetry: true },
    ]) {
      server.sockets[0].push({ type: "pi.evt", sessionId: "sess-1", event } as S2C);
      await flush();
      expect(client.stateOf("sess-1")).not.toBe("idle");
      expect(client.runActive("sess-1")).toBe(true);
    }
  });

  it("marks a prompt sent mid-run as active without downgrading the phase", async () => {
    await client.newSession("/proj");
    server.sockets[0].push({
      type: "pi.evt",
      sessionId: "sess-1",
      event: { type: "tool_execution_start", toolCallId: "t1", toolName: "read", args: {} },
    } as S2C);
    await flush();
    expect(client.stateOf("sess-1")).toBe("tooling");

    client.sendPrompt("sess-1", "steer me");
    // still tooling — a queued prompt must not repaint the live phase
    expect(client.stateOf("sess-1")).toBe("tooling");
    expect(client.runActive("sess-1")).toBe(true);
  });

  // A prompt the server rejects never becomes a run, so no `agent_settled`
  // arrives to end the optimistic state; the error path has to settle it.
  it("settles an optimistic run the server rejected", async () => {
    await client.newSession("/proj");
    client.sendPrompt("sess-1", "hello");
    expect(client.stateOf("sess-1")).toBe("thinking");

    server.sockets[0].deliver({ type: "proto.error", message: "boom" } as S2C);
    await flush();

    expect(client.stateOf("sess-1")).toBe("idle");
    expect(client.runActive("sess-1")).toBe(false);
  });

  it("does not settle a confirmed run on an unrelated error", async () => {
    await client.newSession("/proj");
    server.sockets[0].push({
      type: "pi.evt",
      sessionId: "sess-1",
      event: { type: "agent_start" },
    } as S2C);
    await flush();

    server.sockets[0].deliver({ type: "proto.error", message: "model failed" } as S2C);
    await flush();

    // pi is still running and will settle itself
    expect(client.stateOf("sess-1")).not.toBe("idle");
    expect(client.runActive("sess-1")).toBe(true);
  });

  it("abort settles a run pi never started", async () => {
    await client.newSession("/proj");
    client.sendPrompt("sess-1", "hello");
    expect(client.stateOf("sess-1")).toBe("thinking");

    client.abort("sess-1");
    await flush();
    expect(client.stateOf("sess-1")).toBe("idle");
    expect(client.runActive("sess-1")).toBe(false);
  });

  it("lets a confirmed run settle itself when aborted", async () => {
    await client.newSession("/proj");
    server.sockets[0].push({
      type: "pi.evt",
      sessionId: "sess-1",
      event: { type: "agent_start" },
    } as S2C);
    await flush();

    client.abort("sess-1");
    await flush();
    // pi reports the abort; guessing here would drop the Stop button while the
    // agent is still winding down
    expect(client.stateOf("sess-1")).not.toBe("idle");
    expect(client.runActive("sess-1")).toBe(true);

    server.sockets[0].push({
      type: "pi.evt",
      sessionId: "sess-1",
      event: { type: "agent_settled", aborted: true },
    } as S2C);
    await flush();
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
    const compaction = entries.filter((e) => e.kind === "compaction").at(-1);
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

  // A background attach (a session that is not the active one) must not repaint
  // the skills list with that session's cwd.
  it("ignores a non-active session's attach when syncing skills", async () => {
    await client.newSession("/proj");
    await client.refreshSkills("/proj");
    const loaded = client.skills;
    const loadedCwd = client.skillsCwd;
    expect(loadedCwd).toBe("/proj");

    // anything discovery would show for the other cwd, in case it runs at all
    server.skills = [{ name: "other", description: "Elsewhere", scope: "project" }];
    server.sockets[0].push({
      type: "proto.attached",
      sessionId: "sess-2",
      messages: [],
      model: null,
      thinkingLevel: "medium",
      tools: [],
      role: null,
      commands: [],
      statuses: {},
      cwd: "/other",
      isStreaming: false,
      steering: [],
      followUp: [],
      sessionFile: "/home/u/.pi/agent/sessions/--other--/def.jsonl",
    } as S2C);
    await flush();
    await flush();

    expect(client.skills).toEqual(loaded);
    expect(client.skillsCwd).toBe("/proj");
  });

  // -------------------------------------------------------- config editing

  describe("config editing", () => {
    it("lists the editable documents with their mtimes", async () => {
      const docs = await client.listConfigs();
      expect(docs).toEqual([
        { id: "settings", mtimeMs: 1000 },
        { id: "roles", mtimeMs: 2000 },
      ]);
    });

    it("loadConfig stores the doc and its mtime, and emits", async () => {
      let changes = 0;
      client.onChange(() => changes++);

      const doc = await client.loadConfig("settings");
      expect(doc).toEqual({
        docId: "settings",
        mtimeMs: 1000,
        text: server.configs.get("settings")!.text,
      });
      expect(client.configDocs.get("settings")).toEqual(doc);
      expect(client.configDocs.get("settings")?.mtimeMs).toBe(1000);
      expect(changes).toBeGreaterThan(0);
    });

    it("saveConfig echoes the mtime of the currently stored doc", async () => {
      await client.loadConfig("settings");
      await client.saveConfig("settings", '{ "model": "p/m2" }\n');

      expect(server.lastConfigUpdate).toEqual({
        docId: "settings",
        mtimeMs: 1000,
        text: '{ "model": "p/m2" }\n',
      });
      // the reply carries the re-read doc: its new mtime is what the next save uses
      const stored = client.configDocs.get("settings")!;
      expect(stored.mtimeMs).toBe(1001);
      expect(stored.text).toBe('{ "model": "p/m2" }\n');
    });

    it("a configUpdate reply updates the stored mtime", async () => {
      await client.loadConfig("roles");
      expect(client.configDocs.get("roles")?.mtimeMs).toBe(2000);

      await client.saveConfig("roles", "{}\n");
      expect(client.configDocs.get("roles")?.mtimeMs).toBe(2001);

      // a second save echoes that new mtime, not the original read
      await client.saveConfig("roles", "{ }\n");
      expect(server.lastConfigUpdate?.mtimeMs).toBe(2001);
    });

    it("a conflict reply records the conflict and does NOT update the stored doc", async () => {
      await client.loadConfig("settings");
      const before = client.configDocs.get("settings")!;

      // another editor moved the file on disk after we read it
      server.externalEdit("settings", '{ "model": "theirs" }\n');
      const theirs = server.configs.get("settings")!;

      await client.saveConfig("settings", '{ "model": "mine" }\n');

      // the stored doc is untouched: the UI still holds the user's dirty text
      expect(client.configDocs.get("settings")).toEqual(before);
      expect(client.configDocs.get("settings")?.text).not.toBe(theirs.text);
      // the on-disk version is recorded so the UI can diff or offer a reload
      expect(client.configConflicts.get("settings")).toEqual({
        mtimeMs: theirs.mtimeMs,
        text: theirs.text,
      });
    });

    it("records a broadcast configConflict and emits", async () => {
      await client.loadConfig("roles");
      const stored = client.configDocs.get("roles")!;
      let changes = 0;
      client.onChange(() => changes++);

      server.emitConflict("roles");
      await flush();

      expect(changes).toBeGreaterThan(0);
      expect(client.configConflicts.get("roles")).toEqual({
        mtimeMs: server.configs.get("roles")!.mtimeMs,
        text: server.configs.get("roles")!.text,
      });
      expect(client.configDocs.get("roles")).toEqual(stored);
    });

    it("a reload after a conflict clears it", async () => {
      await client.loadConfig("settings");
      server.externalEdit("settings", "{}\n");
      await client.saveConfig("settings", "mine\n");
      expect(client.configConflicts.has("settings")).toBe(true);

      const doc = await client.loadConfig("settings");
      expect(client.configConflicts.has("settings")).toBe(false);
      expect(client.configDocs.get("settings")).toEqual(doc);
    });

    it("refuses to save a document it never loaded", async () => {
      await expect(client.saveConfig("mcp", "{}")).rejects.toThrow(/not loaded/);
      expect(server.lastConfigUpdate).toBeNull();
    });

    // Regression: the transport stamps its correlation id onto the outgoing
    // frame. When the payload's document field was also called `id`, the stamp
    // overwrote it and the server read the wrong document (the client then
    // needed a bespoke correlator). The payload field is now `docId`, so a
    // correlated request must arrive with BOTH ids intact.
    it("carries a correlation id and the document id on the same frame", async () => {
      const doc = await client.loadConfig("roles");

      const frame = server.configGetFrames.at(-1)!;
      // the transport's correlation id …
      expect(frame.id).toBeTypeOf("string");
      // … and the document id it must not have clobbered
      expect(frame.docId).toBe("roles");
      // the promise resolved to the document the caller asked for
      expect(doc).toEqual({
        docId: "roles",
        mtimeMs: 2000,
        text: server.configs.get("roles")!.text,
      });
      expect(client.configDocs.get("roles")).toEqual(doc);
    });
  });

  describe("reloading after a save", () => {
    it("reloadConfig sends the document and returns the sessions it reached", async () => {
      const sessions = await client.reloadConfig("roles");

      expect(server.reloads).toEqual(["roles"]);
      expect(sessions).toEqual(["sess-1"]);
      expect(client.error).toBeNull();
    });

    it("an empty session list is a success, not an error", async () => {
      server.liveSessions = [];

      const sessions = await client.reloadConfig("settings");

      // nothing was running, so nothing can be out of date
      expect(sessions).toEqual([]);
      expect(client.error).toBeNull();
    });

    it("a failed reload surfaces as the client's error and resolves with null", async () => {
      server.reloadError = "settings reload failed";

      const sessions = await client.reloadConfig("settings");

      expect(sessions).toBeNull();
      expect(client.error).toBe("settings reload failed");
    });

    it("a save does not reload anything on its own", async () => {
      await client.loadConfig("settings");
      await client.saveConfig("settings", '{ "model": "p/m2" }\n');

      // writing the file must not touch a running session: that is the whole
      // reason the reload is a separate, explicit step
      expect(server.reloads).toEqual([]);
    });
  });

  describe("skill editing", () => {
    it("writeSkill sends the request and refreshes skills for the cwd", async () => {
      await client.newSession("/proj");
      expect(client.skills.map((s) => s.name)).toEqual(["commit", "deploy"]);

      await client.writeSkill("create", "review", "name: review", "Review the diff");

      expect(server.lastSkillWrite).toEqual({
        op: "create",
        name: "review",
        frontmatter: "name: review",
        body: "Review the diff",
      });
      // the list was re-fetched, so the new skill shows up without a manual refresh
      expect(client.skills.map((s) => s.name)).toContain("review");
    });

    it("writeSkill refreshes even when the cwd did not change", async () => {
      await client.newSession("/proj");
      expect(client.skills.map((s) => s.name)).toEqual(["commit", "deploy"]);

      await client.writeSkill("delete", "commit");

      // a same-cwd cache hit would leave the deleted skill in place
      expect(server.lastSkillWrite).toEqual({ op: "delete", name: "commit" });
      expect(client.skills.map((s) => s.name)).toEqual(["deploy"]);
    });

    it("readSkill returns the reply's frontmatter and body", async () => {
      await client.newSession("/proj");

      expect(await client.readSkill("commit")).toEqual({
        frontmatter: "name: commit\ndisable-model-invocation: true",
        body: "Body.\n",
      });
    });

    it("readSkill returns undefined when the server answers an error", async () => {
      await client.newSession("/proj");

      expect(await client.readSkill("nope")).toBeUndefined();
    });
  });
  describe("session names", () => {
    it("attach folds the session's name into sessionName()", async () => {
      server.name = "deploy helper";
      await client.newSession("/proj");
      expect(client.sessionName("sess-1")).toBe("deploy helper");
    });

    it("an unnamed session reports null, not an empty string", async () => {
      await client.newSession("/proj");
      expect(client.sessionName("sess-1")).toBeNull();
      expect(client.sessionName("never-seen")).toBeNull();
    });

    it("setSessionName sends the frame and adopts the reply's name", async () => {
      await client.newSession("/proj");
      await client.setSessionName("sess-1", "deploy helper");

      expect(server.sessionNames).toEqual([{ sessionId: "sess-1", name: "deploy helper" }]);
      expect(client.sessionName("sess-1")).toBe("deploy helper");
    });

    it("a pushed proto.sessionName updates the getter without a command", async () => {
      await client.newSession("/proj");
      server.sockets[0].push({
        type: "proto.sessionName",
        sessionId: "sess-1",
        name: "renamed externally",
      } as S2C);
      await flush();

      expect(client.sessionName("sess-1")).toBe("renamed externally");
    });

    it("a cleared name falls back to null", async () => {
      server.name = "deploy helper";
      await client.newSession("/proj");
      expect(client.sessionName("sess-1")).toBe("deploy helper");

      server.sockets[0].push({ type: "proto.sessionName", sessionId: "sess-1", name: "" } as S2C);
      await flush();
      expect(client.sessionName("sess-1")).toBeNull();
    });

    it("a proto.sessionState rehydrates the name (and clears a stale one)", async () => {
      server.name = "first name";
      await client.newSession("/proj");

      server.sockets[0].push({
        type: "proto.sessionState",
        sessionId: "sess-1",
        role: null,
        name: "second name",
        model: { provider: "p", modelId: "m" },
        thinkingLevel: "medium",
        tools: [],
        commands: [],
      } as S2C);
      await flush();
      expect(client.sessionName("sess-1")).toBe("second name");
    });

    it("a detached session's name is dropped with the rest of its state", async () => {
      server.name = "deploy helper";
      await client.newSession("/proj");
      client.detach("sess-1");
      await flush();
      expect(client.sessionName("sess-1")).toBeNull();
    });
  });
});
