import { randomUUID } from "node:crypto";
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { C2S, ReloadWhat, S2C, SessionSummary, SkillInfo } from "@uipi/protocol";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  createAgentSessionRuntime,
  getAgentDir,
  loadSkills,
  SessionManager,
  type AgentSession,
  type AgentSessionRuntime,
} from "@earendil-works/pi-coding-agent";
import type { Model as PiModel } from "@earendil-works/pi-ai";
import { ConfigConflictError, listConfigs, readConfig, writeConfig } from "./config.js";
import { readSkill, writeSkill } from "./skills-write.js";
import { UiHost } from "./uihost.js";
import type { Send, Subscriber } from "./types.js";

export type CreateRuntimeFn = typeof createAgentSessionRuntime;
interface LiveSession {
  id: string;
  cwd: string;
  /** agent dir pi resolved for this session (see resolveAgentDir) */
  agentDir: string;
  sessionFile: string | undefined;
  runtime: AgentSessionRuntime;
  session: AgentSession;
  uiHost: UiHost;
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
  /** set by transport: broadcast to all clients; the initiative's own subscribers are skipped via identity */
  broadcast: (msg: S2C, initiator?: unknown) => void = () => {};

  constructor(createRuntime: CreateRuntimeFn = createAgentSessionRuntime) {
    this.createRuntime = createRuntime;
  }

  async handle(msg: C2S, reply: Send, _sub: Subscriber): Promise<void> {
    switch (msg.type) {
      case "ui.dialogResponse":
      case "ui.selectResponse": {
        const kind = msg.type === "ui.dialogResponse" ? "dialog" : "select";
        const id =
          msg.type === "ui.dialogResponse"
            ? (msg as { dialogId: string }).dialogId
            : (msg as { selectId: string }).selectId;
        const value =
          msg.type === "ui.dialogResponse"
            ? (msg as { value: unknown }).value
            : (msg as { index: number | null }).index;
        this.live.get(msg.sessionId)?.uiHost.response(kind, id, value);
        break;
      }
      case "proto.listSessions": {
        await this.replySessions(reply);
        break;
      }
      case "proto/recentDirs": {
        reply({ type: "proto.recentDirs", dirs: this.recentDirs.map((d) => ({ path: d })) });
        break;
      }
      case "proto.skills": {
        // same resolution as proto.skillGet/skillWrite/config*: the live session's
        // agent dir wins, `agentDir` is only the no-live-session fallback, so the
        // list and the editor can never address different directories
        reply({
          type: "proto.skills",
          skills: discoverSkills(msg.cwd, this.agentDir(msg.agentDir)),
        });
        break;
      }
      case "proto.reloadConfig": {
        await this.reloadConfig(msg.what, reply);
        break;
      }
      case "proto.skillWrite": {
        await this.replyWithAgentDir(reply, async (agentDir) => {
          await writeSkill(agentDir, msg.op, msg.name, msg.frontmatter, msg.body);
          return { type: "proto.skillWrite", name: msg.name };
        });
        break;
      }
      case "proto.skillGet": {
        await this.replyWithAgentDir(reply, async (agentDir) => {
          const { frontmatter, body } = await readSkill(agentDir, msg.name);
          return { type: "proto.skillGet", name: msg.name, frontmatter, body };
        });
        break;
      }
      case "proto.configList": {
        await this.replyWithAgentDir(reply, async (agentDir) => ({
          type: "proto.configList",
          docs: await listConfigs(agentDir),
        }));
        break;
      }
      case "proto.configGet": {
        await this.replyWithAgentDir(reply, async (agentDir) => ({
          type: "proto.configGet",
          doc: await readConfig(agentDir, msg.docId),
        }));
        break;
      }
      case "proto.configUpdate": {
        await this.replyWithAgentDir(reply, async (agentDir) => ({
          type: "proto.configUpdate",
          doc: await writeConfig(agentDir, msg.docId, msg.mtimeMs, msg.text),
        }));
        break;
      }
      case "proto.newSession": {
        await this.newSession(msg.cwd, msg.agentDir, reply, _sub);
        break;
      }
      case "proto.openSession": {
        await this.openSessionFile(msg.sessionFilePath, reply, _sub);
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
      case "proto.setRole":
      case "proto.roleNames": {
        // session commands that happen to live in the proto.* namespace
        await this.handleSessionCmd(msg, reply);
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
        reply({
          type: "proto.error",
          message: `unknown message ${(msg as { type?: string }).type}`,
        });
    }
  }

  /**
   * Re-read one config document on every live session.
   *
   * Explicit by design: pi reads its config at session start, so reloading is
   * never implicit on save — a silent reload would change a running agent
   * mid-conversation. One failing session must not abort the rest: the others
   * still get reloaded and are reported, and only a request where *every* target
   * failed answers `proto.error`.
   */
  private async reloadConfig(what: ReloadWhat, reply: Send): Promise<void> {
    const targets = [...this.live.values()];
    const reloaded: string[] = [];
    let lastError: unknown;
    for (const s of targets) {
      try {
        await this.reloadOne(s, what);
        reloaded.push(s.id);
      } catch (e) {
        lastError = e;
      }
    }
    if (targets.length > 0 && reloaded.length === 0) {
      reply({ type: "proto.error", message: String(lastError) });
      return;
    }
    reply({ type: "proto.reloadConfig", what, sessions: reloaded });
  }

  private async reloadOne(s: LiveSession, what: ReloadWhat): Promise<void> {
    switch (what) {
      case "settings":
        await s.session.settingsManager.reload();
        break;
      case "roles":
        // the roles extension owns roles.json: its own `/role reload` re-reads
        // the file and re-applies the active role, so uipi only asks.
        await s.session.prompt("/role reload");
        // the role (and the model/tools a role presets) may have moved: restate
        // the whole runtime state from history, exactly like a switch does
        this.broadcastSessionState(s);
        break;
      case "skills":
        await s.session.resourceLoader.reload();
        break;
    }
  }

  /** Full runtime state of one session, as `proto.sessionState` carries it. */
  private sessionStateMsg(s: LiveSession): S2C {
    return {
      type: "proto.sessionState",
      sessionId: s.id,
      role: mirrorActiveRole(s.session, s.agentDir),
      model: sessionModelRef(s.session),
      thinkingLevel: String(s.session.thinkingLevel ?? ""),
      tools: [...s.session.getActiveToolNames()],
      commands: discoverCommands(s.session),
    };
  }

  /** Restate one session's runtime state to its subscribers. */
  private broadcastSessionState(s: LiveSession): void {
    const msg = this.sessionStateMsg(s);
    for (const sub of s.subscribers.keys()) {
      try {
        sub.send(msg);
      } catch {
        /* dead subscriber */
      }
    }
  }

  /**
   * The agent dir the agent-dir routes work on.
   *
   * One resolution for `proto.skills`, `proto.skillGet`, `proto.skillWrite` and
   * `proto.config*`: the first live session's agent dir, falling back to the
   * request's optional `agentDir` and then to pi's default. Those routes carry no
   * sessionId, so `[...live.values()][0]` is the same "first live session" choice
   * `proto.listModels` makes. Returning one value here is what keeps the skills
   * list and the skill editor in agreement — resolving them separately is how
   * they drifted apart before.
   */
  private agentDir(requested?: string): string {
    return (
      [...this.live.values()][0]?.agentDir ??
      (requested && requested.trim() ? resolveAgentDir(requested) : getAgentDir())
    );
  }

  /**
   * Run one agent-dir operation against {@link agentDir}.
   *
   * Conflicts answer `proto.configConflict` (the UI can diff/reload) instead of
   * `proto.error`; every other failure is an ordinary error reply, so such a
   * request can never reject this `void`-invoked handler.
   */
  private async replyWithAgentDir(
    reply: Send,
    op: (agentDir: string) => Promise<S2C>,
  ): Promise<void> {
    const agentDir = this.agentDir();
    try {
      reply(await op(agentDir));
    } catch (e) {
      if (e instanceof ConfigConflictError) {
        reply({
          type: "proto.configConflict",
          docId: e.doc.docId,
          mtimeMs: e.doc.mtimeMs,
          text: e.doc.text,
        });
      } else {
        reply({ type: "proto.error", message: String(e) });
      }
    }
  }

  async handleSessionCmd(msg: C2S & { sessionId: string }, reply: Send): Promise<void> {
    const s = this.live.get(msg.sessionId);
    if (!s) {
      reply({ type: "proto.error", message: `no such live session ${msg.sessionId}` });
      return;
    }
    switch (msg.type) {
      case "pi.prompt": {
        // pi runs extension commands *immediately, even during streaming* (see
        // AgentSession.prompt → _tryExecuteExtensionCommand), and that is what the
        // TUI relies on for things like `/role architect` mid-run. followUp()
        // refuses them outright (_throwIfExtensionCommand), so routing a slash
        // command through the queue would fail instead of switching. Bypass the
        // queue for registered extension commands and `/compact`.
        if (msg.text.startsWith("/")) {
          const name = slashCommandName(msg.text);
          if (name === "compact") {
            // uipi implements /compact itself (mapped to pi.compact); never feed
            // the literal text to the model or queue it.
            try {
              await s.session.compact();
            } catch (e) {
              reply({ type: "proto.error", message: String(e) });
            }
            break;
          }
          if (isExtensionCommand(s.session, name)) {
            try {
              await s.session.prompt(msg.text);
            } catch (e) {
              reply({ type: "proto.error", message: String(e) });
            }
            break;
          }
          // TUI-only builtin: it would never run here, so refuse it instead of
          // letting the model answer the literal text as if it had.
          if (isWebUnavailableBuiltin(name)) {
            reply({ type: "proto.error", message: `${name} is not available in the web UI` });
            break;
          }
        }
        // Never reject a prompt just because the agent is busy: queue it instead.
        // A plain prompt submitted mid-run is a follow-up (wait for the current
        // turn), which is what users expect from "just send it".
        if (!s.session.isIdle) {
          s.session.followUp(msg.text);
          this.broadcastQueues(s, { followUp: msg.text });
          break;
        }
        s.session
          .prompt(msg.text)
          .catch((e: unknown) => reply({ type: "proto.error", message: String(e) }));
        break;
      }
      case "pi.steer":
        s.session.steer(msg.text);
        this.broadcastQueues(s, { steering: msg.text });
        break;
      case "pi.followUp":
        s.session.followUp(msg.text);
        this.broadcastQueues(s, { followUp: msg.text });
        break;
      case "pi.abort":
        await s.session.abort();
        break;
      case "proto.setRole": {
        try {
          // The pi roles extension owns switching; translate the request into its
          // own slash command and let the extension be the authority on role names.
          //
          // The extension confirms with a plain `ctx.ui.notify("Role: …")`, which
          // would be a toast on every switch in the web UI even though the header
          // chip already shows the role. pi's notify has no tag parameter, so the
          // server brackets the prompt with an origin tag the web layer can key
          // off — no text matching, and the extension stays untouched.
          const prevOrigin = s.uiHost.setNotificationOrigin("setRole");
          try {
            if (msg.reload) await s.session.prompt("/role reload");
            await s.session.prompt(msg.role === null ? "/role none" : `/role ${msg.role}`);
          } finally {
            s.uiHost.setNotificationOrigin(prevOrigin);
          }
          // Echo the state the session *has*, not the one that was requested: the
          // extension may have refused (unknown role, or busy). Re-read the
          // history after prompt() so a refusal can't show a role that never applied.
          this.broadcastSessionState(s);
        } catch (e) {
          reply({ type: "proto.error", message: String(e) });
        }
        break;
      }
      case "pi.setModel": {
        try {
          const model = s.session.modelRuntime.getModel(msg.provider, msg.modelId);
          if (!model) {
            reply({ type: "proto.error", message: `unknown model ${msg.provider}/${msg.modelId}` });
            break;
          }
          await s.session.setModel(model);
          // echo the new state to ALL subscribers of this session
          this.broadcastSessionState(s);
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
        s.session
          .compact()
          .catch((e: unknown) => reply({ type: "proto.error", message: String(e) }));
        break;
      case "proto.roleNames":
        // The roles extension owns the role list: reuse its own `/role` argument
        // completions instead of re-reading roles.json here. Fails soft — an
        // absent extension, a throwing completion or a missing accessor all mean
        // "no names", and the picker still offers `(none)` + reload.
        reply({
          type: "proto.roleNames",
          sessionId: s.id,
          names: await discoverRoleNames(s.session),
        });
        break;
      case "pi.cancelQueued": {
        const list =
          msg.kind === "steer"
            ? [...s.session.getSteeringMessages()]
            : [...s.session.getFollowUpMessages()];
        if (!list[msg.index]) {
          reply({ type: "proto.error", message: "no such queued message" });
          break;
        }
        // pi exposes queue-clearing only wholesale; cancel any = clear both queues
        s.session.clearQueue();
        this.broadcastQueues(s);
        break;
      }
      default:
        reply({ type: "proto.error", message: "not a session command" });
    }
  }

  private async newSession(
    cwd: string,
    agentDir: string | undefined,
    reply: Send,
    sub: Subscriber,
  ) {
    try {
      const live = await this.materialize(cwd, undefined, agentDir);
      this.pushRecentDir(cwd);
      // creator is implicitly attached — receives the live event stream from now on
      live.subscribers.set(sub, true);
      reply(await attachPayload(live));
      await this.replySessions(reply);
    } catch (e) {
      reply({ type: "proto.error", message: String(e) });
    }
  }

  private async openSessionFile(file: string, reply: Send, sub: Subscriber) {
    try {
      // already live? attach to the existing runtime instead of duplicating it
      const existingId = this.byFile.get(file);
      const existing = existingId ? this.live.get(existingId) : undefined;
      if (existing) {
        existing.subscribers.set(sub, true);
        reply(await attachPayload(existing));
        await this.replySessions(reply);
        return;
      }
      const cwd = inferCwdFromSessionFile(file) ?? process.cwd();
      const live = await this.materialize(cwd, file, undefined);
      // opener is implicitly attached — same as newSession
      live.subscribers.set(sub, true);
      reply(await attachPayload(live));
      await this.replySessions(reply);
    } catch (e) {
      reply({ type: "proto.error", message: String(e) });
    }
  }

  private async listAllSessions(): Promise<SessionSummary[]> {
    const infos = new Map<string, RawSessionInfo>();
    for (const info of await SessionManager.list(process.cwd())) {
      infos.set(info.path, info);
    }
    const extraCwds = new Set(this.byOfLive());
    for (const cwd of extraCwds) {
      if (cwd === process.cwd()) continue;
      try {
        for (const info of await SessionManager.list(cwd)) {
          infos.set(info.path, info);
        }
      } catch {
        /* skip inaccessible */
      }
    }
    const liveByFile = new Map<string, LiveSession>();
    for (const live of this.live.values()) {
      if (live.sessionFile) liveByFile.set(live.sessionFile, live);
    }
    // Roles are backfilled off the request path: every file is read at most once
    // per (path, mtimeMs, size), concurrently, and idle sessions are the common case.
    const entries = [...infos.entries()];
    const roles = await Promise.all(
      entries.map(([path]) => summaryRole(path, liveByFile.get(path))),
    );
    pruneSessionRoleCache(entries.map(([path]) => path));
    const out = entries.map(([, info], i) => summary(info, this, roles[i] ?? null));
    // brand-new live sessions have a session file path but no file on disk yet
    for (const live of this.live.values()) {
      const file = live.sessionFile;
      if (!file || infos.has(file)) continue;
      out.push({
        sessionId: live.id,
        sessionFile: file,
        displayName: "new session",
        firstMessage: "",
        mtime: live.createdAt,
        live: true,
        cwd: live.cwd,
        role: mirrorActiveRole(live.session, live.agentDir),
      });
    }
    return out.sort((a, b) => b.mtime - a.mtime);
  }

  private byOfLive(): string[] {
    return [...this.live.values()].map((l) => l.cwd);
  }

  private async replySessions(reply: Send) {
    const msg = { type: "proto.sessions" as const, sessions: await this.listAllSessions() };
    reply(msg);
    // broadcast to every other connected client so sidebars stay in sync
    this.broadcast?.(msg, reply);
  }

  private async materialize(
    cwd: string,
    sessionFile: string | undefined,
    agentDir: string | undefined,
  ): Promise<LiveSession> {
    const effectiveAgentDir = agentDir && agentDir.trim() ? resolveAgentDir(agentDir) : undefined;
    if (effectiveAgentDir && !existsSync(effectiveAgentDir)) {
      throw new Error(`agent dir does not exist: ${effectiveAgentDir}`);
    }
    const runtime = await this.createRuntime(
      async ({ cwd: _c }) => {
        const services = await createAgentSessionServices({ cwd: _c, agentDir: effectiveAgentDir });
        return {
          ...(await createAgentSessionFromServices({
            services,
            sessionManager: sessionFile
              ? SessionManager.open(sessionFile)
              : SessionManager.create(_c),
          })),
          services,
        } as never;
      },
      {
        cwd,
        sessionManager: sessionFile ? SessionManager.open(sessionFile) : SessionManager.create(cwd),
      } as never,
    );
    const session: AgentSession = (runtime as unknown as { session: AgentSession }).session;
    const id = randomUUID();
    const uiHost = new UiHost(() => live.id, "rpc");
    uiHost.attachSend((m) => {
      for (const s of live.subscribers.keys()) {
        try {
          s.send(m);
        } catch {
          /* dead subscriber */
        }
      }
    });
    const live: LiveSession = {
      id,
      cwd,
      agentDir: effectiveAgentDir ?? getAgentDir(),
      sessionFile: session.sessionFile,
      runtime: runtime as unknown as AgentSessionRuntime,
      session,
      uiHost,
      subscribers: new Map(),
      unsubscribe: () => {},
      createdAt: Date.now(),
    };
    this.live.set(id, live);
    if (session.sessionFile) this.byFile.set(session.sessionFile, id);
    await session.bindExtensions({
      uiContext: uiHost.ui,
      mode: "rpc",
      // surface extension failures as user-visible errors instead of swallowing
      // them: a broken/unsupported extension call would otherwise look like a
      // command that silently did nothing
      onError: (err) => {
        const detail = err as unknown as { error?: unknown; message?: string };
        const text = String(detail?.error ?? detail?.message ?? err);
        for (const sub of live.subscribers.keys()) {
          try {
            sub.send({ type: "proto.error", message: `extension error: ${text}` });
          } catch {
            /* dead subscriber */
          }
        }
      },
    });
    live.unsubscribe = session.subscribe((event) => {
      // A queued message becomes a real user message when pi delivers it: clear
      // the pending chip at that moment. Without this the UI keeps showing a
      // queued prompt that has already been consumed.
      const e = event as { type?: string; message?: { role?: string } };
      if (e?.type === "message_start" && e.message?.role === "user") {
        this.broadcastQueues(live);
      }
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

  /**
   * Push queue contents so the UI can show pending chips.
   *
   * pi drains its queues as soon as an item is picked up, so reading them back
   * right after enqueueing usually yields an empty list. `justQueued` therefore
   * carries the text that was accepted to make the chip appear, while the
   * read-back lists describe anything still genuinely waiting.
   */
  private broadcastQueues(
    s: LiveSession,
    justQueued?: { steering?: string; followUp?: string },
  ): void {
    const steering = [...s.session.getSteeringMessages()];
    const followUp = [...s.session.getFollowUpMessages()];
    if (justQueued?.steering && steering.length === 0) steering.push(justQueued.steering);
    if (justQueued?.followUp && followUp.length === 0) followUp.push(justQueued.followUp);
    const msg = {
      type: "proto.queues" as const,
      sessionId: s.id,
      steering,
      followUp,
    };
    for (const sub of s.subscribers.keys()) {
      try {
        sub.send(msg);
      } catch {
        /* dead subscriber */
      }
    }
  }

  private detach(sessionId: string, sub: Subscriber, reply: Send): void {
    const live = this.live.get(sessionId);
    if (live) live.subscribers.delete(sub);
    reply({ type: "proto.detached", sessionId });
  }

  /** socket closed — forget this subscriber everywhere so events stop fanning out to it */
  dropSubscriber(sub: Subscriber): void {
    for (const live of this.live.values()) live.subscribers.delete(sub);
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

type RawSessionInfo = Awaited<ReturnType<typeof SessionManager.list>>[number];

function summary(
  info: {
    path: string;
    id: string;
    name?: string;
    firstMessage: string;
    modified: Date;
    cwd: string;
  },
  service: SessionService,
  role: string | null,
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
    role,
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
    role: mirrorActiveRole(live.session, live.agentDir),
    commands: discoverCommands(live.session),
    statuses: live.uiHost.statuses(),
    cwd: live.cwd,
    isStreaming: live.session.isIdle === false,
    steering: [...live.session.getSteeringMessages()],
    followUp: [...live.session.getFollowUpMessages()],
    sessionFile: live.sessionFile ?? null,
  } satisfies S2C;
}

/** One discoverable slash command, as the protocol carries it. */
type CommandInfo = { name: string; description?: string };

/**
 * The slice of AgentSession command discovery touches. All three accessors are
 * optional so a fake (or an older pi) can omit any of them without a throw.
 */
type CommandDiscoverySource = {
  extensionRunner?: {
    getRegisteredCommands?: () => { name: string; invocationName?: string; description?: string }[];
  };
  promptTemplates?: ReadonlyArray<{ name: string; description?: string }>;
  resourceLoader?: {
    getSkills?: () => { skills?: { name: string; description?: string }[] };
  };
};

/**
 * Naming convention — ONE rule for every source: the name is what the user types
 * *without* the leading "/", because the client owns the slash (displays it,
 * inserts it). Sources:
 *
 *  - extension → `invocationName`, i.e. `/foo` or `/foo:2` when two extensions
 *    register the same command (pi resolves commands by invocationName),
 *  - prompt template → the template name, `/review`,
 *  - skill → `skill:<name>`, pi's own skill addressing, `/skill:<name>`.
 *
 * Deduped by name (first wins: extension → prompt → skill, pi's own precedence)
 * and sorted by name so the picker order is stable between attaches.
 *
 * pi's TUI builtins are not among them: `BUILTIN_SLASH_COMMANDS` are handled by
 * InteractiveMode, never registered as an extension command, template or skill,
 * so the picker only ever advertises commands that actually run in the web UI.
 *
 * Display-only: any failure yields `[]` — an empty picker beats a broken attach.
 */
export function discoverCommands(session: AgentSession): CommandInfo[] {
  try {
    const src = session as unknown as CommandDiscoverySource;
    const found: CommandInfo[] = [];
    const add = (name: unknown, description: unknown) => {
      if (typeof name !== "string" || name.length === 0) return;
      found.push(
        typeof description === "string" && description.length > 0
          ? { name, description }
          : { name },
      );
    };
    for (const command of src.extensionRunner?.getRegisteredCommands?.() ?? []) {
      add(command.invocationName ?? command.name, command.description);
    }
    for (const template of src.promptTemplates ?? []) add(template.name, template.description);
    for (const skill of src.resourceLoader?.getSkills?.().skills ?? []) {
      add(`skill:${skill.name}`, skill.description);
    }
    const seen = new Set<string>();
    return found
      .filter((c) => (seen.has(c.name) ? false : (seen.add(c.name), true)))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  } catch {
    // display-only: a broken discovery source must never break attach or a broadcast
    return [];
  }
}

/** One skill pi discovers for a cwd, as the protocol carries it. */
type SkillScope = SkillInfo["scope"];

/**
 * pi's own skills for one cwd, read through pi's loader so the web list matches
 * what the terminal would show: user skills from the agent dir plus project
 * skills from `<cwd>/.pi/skills` (`includeDefaults: true`).
 *
 * Scope collapses to the protocol's two buckets: only a genuine project skill is
 * "project"; `temporary` (explicit `--skill` paths) and anything else read as
 * "user", because the UI has no third chip for them.
 *
 * Sorted by name so the list order is stable between requests.
 *
 * `agentDir` is the resolved agent dir (a caller that already picked one — the
 * `proto.skills` handler does, via the same live-session-first resolution the
 * skill editor uses — passes it through untouched); omitted, it falls back to
 * pi's default, which is what the tests exercise directly.
 *
 * Display-only: any failure yields `[]` — an empty list beats a broken request.
 */
export function discoverSkills(cwd: string, agentDir?: string): SkillInfo[] {
  try {
    const { skills } = loadSkills({
      cwd,
      agentDir: agentDir && agentDir.trim() ? resolveAgentDir(agentDir) : getAgentDir(),
      skillPaths: [],
      includeDefaults: true,
    });
    return skills
      .map((skill) => ({
        name: skill.name,
        description: skill.description,
        scope: (skill.sourceInfo.scope === "project" ? "project" : "user") as SkillScope,
      }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  } catch {
    // display-only: a broken skills scan must never break the request
    return [];
  }
}

/** Slash command name parsed exactly as pi does: text after "/" up to the first space. */
function slashCommandName(text: string): string {
  const spaceIndex = text.indexOf(" ");
  return spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
}

/**
 * pi builtin slash commands that only the TUI implements.
 *
 * Source: `BUILTIN_SLASH_COMMANDS` in
 * @earendil-works/pi-coding-agent/dist/core/slash-commands.js (pi 1.4.0, 24
 * names). That module is *not* reachable from the package entry point:
 * dist/index.d.ts exports nothing from core/slash-commands, and package.json
 * "exports" declares only "." and "./rpc-entry", so importing the deep path
 * fails with ERR_PACKAGE_PATH_NOT_EXPORTED. Hence this explicit copy — re-diff
 * it against the file above when bumping pi.
 */
const PI_BUILTIN_SLASH_COMMANDS: ReadonlySet<string> = new Set([
  "settings",
  "model",
  "tree",
  "thinking",
  "scoped-models",
  "export",
  "import",
  "share",
  "bug",
  "copy",
  "name",
  "session",
  "changelog",
  "hotkeys",
  "fork",
  "clone",
  "trust",
  "login",
  "logout",
  "new",
  "compact",
  "resume",
  "reload",
  "quit",
]);

/**
 * Commands the web UI *does* implement, so they must never be refused.
 * `/new` is handled client-side (proto.newSession) and never reaches the
 * server; `/compact` and `/role` are dispatched above.
 */
const WEB_IMPLEMENTED_COMMANDS: ReadonlySet<string> = new Set(["new", "compact", "role"]);

/**
 * Whether `name` is a pi builtin with no web implementation.
 *
 * pi's builtins are TUI-only: their handlers live in InteractiveMode, not in
 * AgentSession.prompt(). `prompt()` finds no extension command for `/model opus`
 * and forwards the literal text to the model, which then confidently answers
 * about a command that never ran. Refuse these instead of prompting.
 */
function isWebUnavailableBuiltin(name: string): boolean {
  return PI_BUILTIN_SLASH_COMMANDS.has(name) && !WEB_IMPLEMENTED_COMMANDS.has(name);
}

/** The subset of ExtensionRunner we need, so fakes/tests can omit it. */
type CommandListProvider = {
  getRegisteredCommands?: () => { name: string; invocationName?: string }[];
};

/**
 * Whether `name` is a command registered by a loaded pi extension.
 * pi itself resolves commands by `invocationName` (ExtensionRunner.getCommand),
 * which falls back to the plain `name` for a single registration.
 */
function isExtensionCommand(session: AgentSession, name: string): boolean {
  try {
    const runner = session.extensionRunner as unknown as CommandListProvider | undefined;
    const commands = runner?.getRegisteredCommands?.() ?? [];
    return commands.some((command) => (command.invocationName ?? command.name) === name);
  } catch {
    // a broken extension runner must not break ordinary prompting
    return false;
  }
}

/**
 * Reserved argument words the roles extension defines on its own `/role`
 * command (`~/.pi/agent/extensions/roles/index.ts`, `RESERVED`): `none` also as
 * `off`, plus `reload` and `keys`. They are command affordances, never roles, so
 * the picker must not list them as role names — `(none)` and reload are its own.
 */
const RESERVED_ROLE_ARGS: ReadonlySet<string> = new Set(["none", "off", "reload", "keys"]);

/** The slice of a registered extension command this discovery touches. */
type CompletionProvider = {
  name?: string;
  invocationName?: string;
  getArgumentCompletions?: (
    argumentPrefix: string,
  ) => { value?: unknown }[] | null | Promise<{ value?: unknown }[] | null>;
};

/**
 * Role names as pi's own `/role` command would complete them.
 *
 * The single source of truth is the roles extension: its `getArgumentCompletions`
 * returns `{ value, label, description }` for every configured role plus the
 * reserved words (`none`, `reload`, `keys`). uipi only asks for them and strips
 * the reserved ones, so the wire list is role names and nothing else.
 *
 * Display-only: no `role` command (extension not installed), a throwing or
 * non-completing command, or a failing completion all yield `[]`. Hidden roles
 * cannot be told apart here — completions don't distinguish them — so they are
 * included, which is accepted.
 */
export async function discoverRoleNames(session: AgentSession): Promise<string[]> {
  try {
    const runner = session.extensionRunner as unknown as CommandListProvider | undefined;
    const commands = (runner?.getRegisteredCommands?.() ?? []) as CompletionProvider[];
    const roleCommand = commands.find(
      (command) => (command.invocationName ?? command.name) === "role",
    );
    if (typeof roleCommand?.getArgumentCompletions !== "function") return [];
    const items = await roleCommand.getArgumentCompletions("");
    const names: string[] = [];
    for (const item of items ?? []) {
      const name = item?.value;
      if (typeof name !== "string" || name.length === 0) continue;
      if (RESERVED_ROLE_ARGS.has(name)) continue;
      if (!names.includes(name)) names.push(name);
    }
    return names;
  } catch {
    // display-only: a broken extension must never break the picker request
    return [];
  }
}

/** Custom entry type the roles extension appends on every switch. */
const ROLE_ENTRY_TYPE = "role-switch";

/**
 * The last `role-switch` custom entry on the current branch, or `null`.
 *
 * `found` matters: an entry with `{ role: null }` (a `/role none`) is a real
 * answer — it must not fall back to the config default. Same replay rule as the
 * roles extension's own `restoreRoleFromSession`: last entry wins.
 */
function roleFromEntries(session: AgentSession): { found: boolean; role: string | null } {
  try {
    let found = false;
    let role: string | null = null;
    for (const entry of session.sessionManager.getBranch()) {
      if (entry.type !== "custom" || entry.customType !== ROLE_ENTRY_TYPE) continue;
      const data = entry.data as { role?: unknown } | undefined;
      role = typeof data?.role === "string" ? data.role : null;
      found = true;
    }
    return { found, role };
  } catch {
    // display-only: never let a broken/absent session manager break a payload
    return { found: false, role: null };
  }
}

/**
 * Unpatched-install fallback: with no `role-switch` entry in history the only
 * truth is `roles.json → active`, the fresh-session default the roles extension
 * would have applied. Read defensively — a missing file, bad JSON or a bad
 * `active` value all mean "roleless" (blank beats guessed).
 */
function activeFromConfig(agentDir: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(join(agentDir, "roles.json"), "utf8")) as {
      active?: unknown;
    };
    const active = parsed?.active;
    return typeof active === "string" && active.length > 0 ? active : null;
  } catch {
    return null;
  }
}

/**
 * Active role of a live session, display-only: history first, config default
 * second. uipi never interprets the name — it just echoes pi's answer.
 */
export function mirrorActiveRole(session: AgentSession, agentDir: string): string | null {
  const fromHistory = roleFromEntries(session);
  return fromHistory.found ? fromHistory.role : activeFromConfig(agentDir);
}

/**
 * The last `role-switch` role in a session JSONL file, or `null`.
 *
 * Streams the file line by line (`readline` over a `createReadStream`): a session
 * can be several MB of message lines, but only a handful of lines in the whole
 * corpus are role switches. Malformed lines are skipped, and any read error means
 * "roleless" — the sidebar badge is display-only and must never throw a listing.
 * No config fallback: an entry with `{ role: null }` is a real answer.
 */
export async function roleFromSessionFile(file: string): Promise<string | null> {
  let rl: ReturnType<typeof createInterface> | undefined;
  try {
    rl = createInterface({
      input: createReadStream(file, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });
    let found = false;
    let role: string | null = null;
    for await (const line of rl) {
      // Cheap prefilter: JSON.parse on every message line of a 7 MB file is the
      // one cost worth avoiding, and a role entry always carries its own marker.
      if (!line.includes(ROLE_ENTRY_TYPE)) continue;
      let entry: { type?: unknown; customType?: unknown; data?: { role?: unknown } };
      try {
        entry = JSON.parse(line) as typeof entry;
      } catch {
        continue; // truncated/hand-edited line: skip it, keep scanning
      }
      if (entry?.type !== "custom" || entry.customType !== ROLE_ENTRY_TYPE) continue;
      role = typeof entry.data?.role === "string" ? entry.data.role : null;
      found = true;
    }
    return found ? role : null;
  } catch {
    return null;
  } finally {
    rl?.close();
  }
}

/**
 * One cached file answer. Keyed by the stat triple: same path *and* same mtimeMs
 * *and* same size means the bytes cannot have changed, so the replay is reused and
 * a repeat `proto.sessions` broadcast opens nothing. `exists` is kept so a
 * brand-new live session (path known, file not written yet) can be told apart from
 * a roleless session and fall back to the live mirror instead.
 */
type SessionRoleEntry = { mtimeMs: number; size: number; exists: boolean; role: string | null };
const sessionRoleCache = new Map<string, SessionRoleEntry>();

export async function cachedSessionRole(
  file: string,
): Promise<{ exists: boolean; role: string | null }> {
  let mtimeMs: number;
  let size: number;
  try {
    const st = await stat(file);
    mtimeMs = st.mtimeMs;
    size = st.size;
  } catch {
    sessionRoleCache.delete(file);
    return { exists: false, role: null };
  }
  const hit = sessionRoleCache.get(file);
  if (hit && hit.exists && hit.mtimeMs === mtimeMs && hit.size === size) {
    return { exists: true, role: hit.role };
  }
  const role = await roleFromSessionFile(file);
  sessionRoleCache.set(file, { mtimeMs, size, exists: true, role });
  return { exists: true, role };
}

/** Bound the cache: forget every file that was not in the listing we just served. */
export function pruneSessionRoleCache(seen: Iterable<string>): void {
  const keep = new Set(seen);
  for (const path of sessionRoleCache.keys()) {
    if (!keep.has(path)) sessionRoleCache.delete(path);
  }
}

/**
 * Sidebar role for one summary: the JSONL when the file is on disk (the same
 * replay rule as `mirrorActiveRole`, minus the config default), otherwise the live
 * session's own mirror — a brand-new session has no file until its first message.
 */
async function summaryRole(path: string, live: LiveSession | undefined): Promise<string | null> {
  const read = await cachedSessionRole(path);
  if (read.exists) return read.role;
  return live ? mirrorActiveRole(live.session, live.agentDir) : null;
}

/** agentDir as materialize() resolves it: trimmed, `~` expanded, else pi's own default. */
function resolveAgentDir(agentDir: string): string {
  return agentDir.trim().replace(/^~(?=\/)/, `${process.env.HOME ?? "~"}`);
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
