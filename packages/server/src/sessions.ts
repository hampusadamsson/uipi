import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type { C2S, S2C, SessionSummary } from "@uipi/protocol";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  createAgentSessionRuntime,
  SessionManager,
  type AgentSession,
  type AgentSessionRuntime,
} from "@earendil-works/pi-coding-agent";
import type { Model as PiModel } from "@earendil-works/pi-ai";
import type { Send, Subscriber } from "./types.js";

export type CreateRuntimeFn = typeof createAgentSessionRuntime;

interface LiveSession {
  id: string;
  cwd: string;
  sessionFile: string | undefined;
  runtime: AgentSessionRuntime;
  session: AgentSession;
  subscribers: Map<Subscriber, true>;
  unsubscribe: () => void;
  createdAt: number;
}

/**
 * Owns live pi sessions and maps protocol ids to them.
 * Sessions persist via pi's own SessionManager JSONL files.
 */
export class SessionService {
  private live = new Map<string, LiveSession>();
  private byFile = new Map<string, string>();
  private recentDirs: string[] = [];
  private createRuntime: CreateRuntimeFn;

  constructor(createRuntime: CreateRuntimeFn = createAgentSessionRuntime) {
    this.createRuntime = createRuntime;
  }

  async handle(msg: C2S, reply: Send, _sub: Subscriber): Promise<void> {
    switch (msg.type) {
      case "proto.listSessions": {
        await this.replySessions(reply);
        break;
      }
      case "proto/recentDirs": {
        reply({ type: "proto.recentDirs", dirs: this.recentDirs.map((d) => ({ path: d })) });
        break;
      }
      case "proto.newSession": {
        await this.newSession(msg.cwd, msg.agentDir, reply);
        break;
      }
      case "proto.openSession": {
        await this.openSessionFile(msg.sessionFilePath, reply);
        break;
      }
      case "proto.attach": {
        await this.attach(msg.sessionId, reply, _sub);
        break;
      }
      case "proto.detach": {
        this.detach(msg.sessionId, _sub, reply);
        break;
      }
      case "proto/listModels": {
        const first = [...this.live.values()][0];
        if (!first) {
          reply({ type: "proto.models", models: [] });
          break;
        }
        reply({ type: "proto.models", models: listSessionModels(first.session) });
        break;
      }
      default:
        reply({ type: "proto.error", message: `unknown message ${(msg as { type?: string }).type}` });
    }
  }

  async handleSessionCmd(msg: C2S & { sessionId: string }, reply: Send): Promise<void> {
    const s = this.live.get(msg.sessionId);
    if (!s) {
      reply({ type: "proto.error", message: `no such live session ${msg.sessionId}` });
      return;
    }
    switch (msg.type) {
      case "pi.prompt":
        s.session.prompt(msg.text).catch((e: unknown) =>
          reply({ type: "proto.error", message: String(e) })
        );
        break;
      case "pi.steer":
        s.session.steer(msg.text);
        break;
      case "pi.followUp":
        s.session.followUp(msg.text);
        break;
      case "pi.abort":
        await s.session.abort();
        break;
      case "pi.setModel": {
        try {
          const model = s.session.modelRuntime.getModel(msg.provider, msg.modelId);
          if (!model) {
            reply({ type: "proto.error", message: `unknown model ${msg.provider}/${msg.modelId}` });
            break;
          }
          await s.session.setModel(model);
        } catch (e) {
          reply({ type: "proto.error", message: String(e) });
        }
        break;
      }
      case "pi.setThinkingLevel":
        try {
          s.session.setThinkingLevel(msg.level as never);
        } catch (e) {
          reply({ type: "proto.error", message: String(e) });
        }
        break;
      case "pi.compact":
        s.session.compact().catch((e: unknown) =>
          reply({ type: "proto.error", message: String(e) })
        );
        break;
      case "pi.cancelQueued": {
        const list =
          msg.kind === "steer" ? [...s.session.getSteeringMessages()] : [...s.session.getFollowUpMessages()];
        if (!list[msg.index]) {
          reply({ type: "proto.error", message: "no such queued message" });
          break;
        }
        // pi exposes queue-clearing only wholesale; cancel any = clear both queues
        s.session.clearQueue();
        break;
      }
      default:
        reply({ type: "proto.error", message: "not a session command" });
    }
  }

  private async newSession(cwd: string, agentDir: string | undefined, reply: Send) {
    try {
      const live = await this.materialize(cwd, undefined, agentDir);
      this.pushRecentDir(cwd);
      this.pushRecentDir(cwd);
      reply(await attachPayload(live));
      await this.replySessions(reply);
    } catch (e) {
      reply({ type: "proto.error", message: String(e) });
    }
  }

  private async openSessionFile(file: string, reply: Send) {
    try {
      const cwd = inferCwdFromSessionFile(file) ?? process.cwd();
      const live = await this.materialize(cwd, file, undefined);
      reply(await attachPayload(live));
      await this.replySessions(reply);
    } catch (e) {
      reply({ type: "proto.error", message: String(e) });
    }
  }

  private async listAllSessions(): Promise<SessionSummary[]> {
    const set = new Map<string, SessionSummary>();
    for (const info of await SessionManager.list(process.cwd())) {
      set.set(info.path, summary(info, this));
    }
    const extraCwds = new Set(this.byOfLive());
    for (const cwd of extraCwds) {
      if (cwd === process.cwd()) continue;
      try {
        for (const info of await SessionManager.list(cwd)) {
          set.set(info.path, summary(info, this));
        }
      } catch {
        /* skip inaccessible */
      }
    }
    return [...set.values()].sort((a, b) => b.mtime - a.mtime);
  }

  private byOfLive(): string[] {
    return [...this.live.values()].map((l) => l.cwd);
  }

  private async replySessions(reply: Send) {
    reply({ type: "proto.sessions", sessions: await this.listAllSessions() });
  }

  private async materialize(cwd: string, sessionFile: string | undefined, agentDir: string | undefined): Promise<LiveSession> {
    const effectiveAgentDir = agentDir && agentDir.trim() ? agentDir.trim().replace(/^~(?=\/)/, `${process.env.HOME ?? "~"}`) : undefined;
    if (effectiveAgentDir && !existsSync(effectiveAgentDir)) {
      throw new Error(`agent dir does not exist: ${effectiveAgentDir}`);
    }
    const services = await createAgentSessionServices({ cwd, agentDir: effectiveAgentDir });
    const runtime = await this.createRuntime(
      async ({ cwd: _c }) => {
        const services = await createAgentSessionServices({ cwd: _c, agentDir: effectiveAgentDir });
        return {
          ...(await createAgentSessionFromServices({
            services,
            sessionManager: sessionFile ? SessionManager.open(sessionFile) : SessionManager.create(_c),
          })),
          services,
        } as never;
      },
      {
        cwd,
        sessionManager: sessionFile ? SessionManager.open(sessionFile) : SessionManager.create(cwd),
      } as never
    );
    const session: AgentSession = (runtime as unknown as { session: AgentSession }).session;
    const id = randomUUID();
    const live: LiveSession = {
      id,
      cwd,
      sessionFile: session.sessionFile,
      runtime: runtime as unknown as AgentSessionRuntime,
      session,
      subscribers: new Map(),
      unsubscribe: () => {},
      createdAt: Date.now(),
    };
    this.live.set(id, live);
    if (session.sessionFile) this.byFile.set(session.sessionFile, id);
    await session.bindExtensions({});
    live.unsubscribe = session.subscribe((event) => {
      for (const sub of live.subscribers.keys()) {
        try {
          sub.send({ type: "pi.evt", sessionId: id, event });
        } catch {
          /* dead subscriber */
        }
      }
    });
    return live;
  }

  private async attach(sessionId: string, reply: Send, sub: Subscriber) {
    const live = this.live.get(sessionId);
    if (!live) {
      reply({ type: "proto.error", message: `no such session ${sessionId}` });
      return;
    }
    live.subscribers.set(sub, true);
    reply(await attachPayload(live));
  }

  private detach(sessionId: string, sub: Subscriber, reply: Send): void {
    const live = this.live.get(sessionId);
    if (live) live.subscribers.delete(sub);
    reply({ type: "proto.detached", sessionId });
  }

  private pushRecentDir(dir: string): void {
    this.recentDirs = [dir, ...this.recentDirs.filter((d) => d !== dir)].slice(0, 20);
  }

  async shutdown(): Promise<void> {
    for (const live of this.live.values()) {
      try {
        if (!live.session.isIdle) await live.session.abort();
      } catch {
        /* keep going */
      }
      live.unsubscribe();
      try {
        live.session.dispose();
      } catch {
        /* ignore */
      }
    }
    this.live.clear();
  }
}

function summary(
  info: {
    path: string;
    id: string;
    name?: string;
    firstMessage: string;
    modified: Date;
    cwd: string;
  },
  service: SessionService
): SessionSummary {
  const liveId = service["byFile"].get(info.path);
  return {
    sessionId: liveId ?? info.id,
    sessionFile: info.path,
    displayName: info.name ?? info.firstMessage.slice(0, 60),
    firstMessage: info.firstMessage,
    mtime: info.modified.getTime(),
    live: Boolean(liveId && service["live"].has(liveId)),
    cwd: info.cwd || process.cwd(),
  };
}

async function attachPayload(live: LiveSession): Promise<S2C> {
  return {
    type: "proto.attached",
    sessionId: live.id,
    messages: [...live.session.messages],
    model: sessionModelRef(live.session),
    thinkingLevel: String(live.session.thinkingLevel ?? ""),
    tools: [...live.session.getActiveToolNames()],
    cwd: live.cwd,
    isStreaming: live.session.isIdle === false,
    steering: [...live.session.getSteeringMessages()],
    followUp: [...live.session.getFollowUpMessages()],
  } satisfies S2C;
}

function sessionModelRef(session: AgentSession) {
  const m = session.model as { provider?: string; id?: string } | undefined;
  return m?.provider && m?.id ? { provider: m.provider, modelId: m.id } : null;
}

function listSessionModels(session: AgentSession) {
  // Only models usable per pi config (auth-configured providers + scoped models),
  // mirroring terminal pi's model list — not the full registry.
  const raw = session.modelRuntime.getAvailableSnapshot() as unknown as PiModel<never>[];
  return raw.map((m) => ({
    provider: String(m.provider),
    modelId: String(m.id),
    displayName: String(m.name),
    reasoning: Boolean((m as unknown as { reasoning?: boolean }).reasoning),
    contextWindow: Number((m as unknown as { contextWindow?: number }).contextWindow ?? 0),
  }));
}

function inferCwdFromSessionFile(file: string): string | undefined {
  const marker = "/sessions/";
  const i = file.lastIndexOf(marker);
  if (i === -1) return undefined;
  const dirName = file.slice(i + marker.length).split("/")[0];
  // pi encodes abs path with "/"→"--" and leading/trailing "--"
  const decoded = dirName.replace(/^-+/, "").replace(/-+$/, "").split("--").join("/");
  return decoded || undefined;
}
