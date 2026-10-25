import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { C2S, S2C, SessionSummary } from "@uipi/protocol";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  createAgentSessionRuntime,
  getAgentDir,
  SessionManager,
  type AgentSession,
  type AgentSessionRuntime,
} from "@earendil-works/pi-coding-agent";
import type { Model as PiModel } from "@earendil-works/pi-ai";
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
      case "proto.setRole": {
        // a session command that happens to live in the proto.* namespace
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
          if (msg.reload) await s.session.prompt("/role reload");
          await s.session.prompt(msg.role === null ? "/role none" : `/role ${msg.role}`);
          // Echo the state the session *has*, not the one that was requested: the
          // extension may have refused (unknown role, or busy). Re-read the
          // history after prompt() so a refusal can't show a role that never applied.
          const role = mirrorActiveRole(s.session, s.agentDir);
          for (const s2 of s.subscribers.keys()) {
            try {
              s2.send({
                type: "proto.sessionState",
                sessionId: s.id,
                role,
                model: sessionModelRef(s.session),
                thinkingLevel: String(s.session.thinkingLevel ?? ""),
                tools: [...s.session.getActiveToolNames()],
                commands: discoverCommands(s.session),
              });
            } catch {
              /* dead */
            }
          }
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
          const m = s.session.model as unknown as { provider?: string; id?: string } | undefined;
          const modelRef = m?.provider && m?.id ? { provider: m.provider, modelId: m.id } : null;
          for (const s2 of s.subscribers.keys()) {
            try {
              s2.send({
                type: "proto.sessionState",
                sessionId: s.id,
                role: mirrorActiveRole(s.session, s.agentDir),
                model: modelRef,
                thinkingLevel: String(s.session.thinkingLevel ?? ""),
                tools: [...s.session.getActiveToolNames()],
                commands: discoverCommands(s.session),
              });
            } catch {
              /* dead */
            }
          }
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
    // brand-new live sessions have a session file path but no file on disk yet
    for (const live of this.live.values()) {
      const file = live.sessionFile;
      if (!file || set.has(file)) continue;
      set.set(file, {
        sessionId: live.id,
        sessionFile: file,
        displayName: "new session",
        firstMessage: "",
        mtime: live.createdAt,
        live: true,
        cwd: live.cwd,
      });
    }
    return [...set.values()].sort((a, b) => b.mtime - a.mtime);
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
