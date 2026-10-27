// `proto.reloadConfig` is the explicit half of the post-save affordance: a save
// writes the file, but pi reads its config at session start, so every *running*
// session keeps the old values until it is told to re-read. Reload is never
// implicit precisely because it changes a live agent mid-conversation.
//
// The three properties pinned here:
//
//  1. `roles` is the roles extension's own `/role reload` on *every* live
//     session, and each of them re-broadcasts its full runtime state with the
//     same builder `proto.setRole` uses (one source).
//  2. `settings` / `skills` go through pi's own managers, not through uipi.
//  3. One failing session does not abort the rest, and only a request whose
//     every target failed answers `proto.error`; zero live sessions is a
//     success with an empty id list (nothing to do).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { SessionService } from "../src/sessions.js";
import { UiHost } from "../src/uihost.js";
import type { Subscriber } from "../src/types.js";
import type { S2C } from "@uipi/protocol";

type States = Extract<S2C, { type: "proto.sessionState" }>;
type Reloaded = Extract<S2C, { type: "proto.reloadConfig" }>;

/**
 * A live session whose config surfaces record what was asked of them. `fail`
 * makes that session's reload throw, the way a broken file or a disposed
 * runtime would.
 */
function fakeLive(id: string, opts: { fail?: boolean } = {}) {
  const calls: string[] = [];
  const session = {
    isIdle: true,
    thinkingLevel: "medium",
    messages: [],
    model: { provider: "p", id: "m" },
    sessionManager: { getBranch: () => [] },
    getActiveToolNames: () => ["read"],
    getSteeringMessages: () => [],
    getFollowUpMessages: () => [],
    settingsManager: {
      reload: () => {
        calls.push("settings");
        return opts.fail
          ? Promise.reject(new Error(`settings reload failed for ${id}`))
          : Promise.resolve();
      },
    },
    resourceLoader: {
      reload: () => {
        calls.push("skills");
        return opts.fail
          ? Promise.reject(new Error(`skills reload failed for ${id}`))
          : Promise.resolve();
      },
    },
    prompt: (text: string) => {
      calls.push(text);
      return opts.fail ? Promise.reject(new Error(`prompt failed for ${id}`)) : Promise.resolve();
    },
  };
  const uiHost = new UiHost(() => id, "rpc");
  return {
    id,
    cwd: "/tmp",
    agentDir: mkdtempSync(join(tmpdir(), "uipi-reload-")),
    sessionFile: undefined,
    session,
    uiHost,
    subscribers: new Map<Subscriber, true>(),
    calls,
  };
}

/** Service with the given live sessions, each with one recording subscriber. */
function setup(lives: ReturnType<typeof fakeLive>[]) {
  const svc = new SessionService(undefined as never);
  const sentBySession = new Map<string, S2C[]>();
  for (const live of lives) {
    const frames: S2C[] = [];
    live.subscribers.set({ send: (m) => frames.push(m as S2C) }, true);
    sentBySession.set(live.id, frames);
    (svc as unknown as { live: Map<string, unknown> }).live.set(live.id, live);
  }
  const replies: S2C[] = [];
  const run = (what: "settings" | "roles" | "skills") =>
    svc.handle({ type: "proto.reloadConfig", what }, (m) => replies.push(m), {
      send: () => {},
    });
  const statesOf = (id: string) =>
    (sentBySession.get(id) ?? []).filter((m) => m.type === "proto.sessionState") as States[];
  const errors = () => replies.filter((m) => m.type === "proto.error") as { message: string }[];
  const reloaded = () => replies.filter((m) => m.type === "proto.reloadConfig") as Reloaded[];
  return { svc, run, replies, statesOf, errors, reloaded };
}

describe("proto.reloadConfig roles", () => {
  it("prompts every live session with /role reload and restates each one's state", async () => {
    const a = fakeLive("s1");
    const b = fakeLive("s2");
    const { run, statesOf, reloaded, errors } = setup([a, b]);

    await run("roles");

    // the roles extension owns roles.json: its own command, on every session
    expect(a.calls).toEqual(["/role reload"]);
    expect(b.calls).toEqual(["/role reload"]);

    // each reloaded session restates its full runtime state to its subscribers
    expect(statesOf("s1")).toHaveLength(1);
    expect(statesOf("s2")).toHaveLength(1);
    const state = statesOf("s1")[0]!;
    expect(state.sessionId).toBe("s1");
    expect(state.model).toEqual({ provider: "p", modelId: "m" });
    expect(state.thinkingLevel).toBe("medium");
    expect(state.tools).toEqual(["read"]);
    expect(state.role).toBeNull();

    // …and the reply names the sessions that were reached
    expect(errors()).toHaveLength(0);
    expect(reloaded()).toEqual([
      { type: "proto.reloadConfig", what: "roles", sessions: ["s1", "s2"] },
    ]);
  });

  it("does not tag the /role reload confirmation as uipi-initiated noise", async () => {
    const live = fakeLive("s1");
    const frames: S2C[] = [];
    live.uiHost.attachSend((m) => frames.push(m));
    const { run } = setup([live]);

    // the extension confirms a reload through ctx.ui.notify; a reload is genuine
    // information (the whole point of asking), so no origin tag may be set
    live.session.prompt = async () => {
      live.uiHost.ui.notify("Roles reloaded", "info");
    };

    await run("roles");

    const notes = frames
      .filter((f) => f.type === "ui.event")
      .map((f) => f.event as { kind: string; origin?: string });
    expect(notes).toHaveLength(1);
    expect(notes[0]!.kind).toBe("notification");
    expect(notes[0]!.origin).toBeUndefined();
  });
});

describe("proto.reloadConfig settings and skills", () => {
  it("reloads each session's settings manager", async () => {
    const a = fakeLive("s1");
    const b = fakeLive("s2");
    const { run, reloaded } = setup([a, b]);

    await run("settings");

    expect(a.calls).toEqual(["settings"]);
    expect(b.calls).toEqual(["settings"]);
    expect(reloaded()[0]!.sessions).toEqual(["s1", "s2"]);
  });

  it("reloads each session's resource loader for skills", async () => {
    const a = fakeLive("s1");
    const { run, reloaded } = setup([a]);

    await run("skills");

    expect(a.calls).toEqual(["skills"]);
    expect(reloaded()[0]!).toEqual({
      type: "proto.reloadConfig",
      what: "skills",
      sessions: ["s1"],
    });
  });
});

describe("proto.reloadConfig partial failure", () => {
  it("one failing session does not stop the others, and the reply lists the successes", async () => {
    const bad = fakeLive("bad", { fail: true });
    const good = fakeLive("good");
    const { run, reloaded, errors, statesOf } = setup([bad, good]);

    await run("roles");

    // the healthy session was still reloaded and restated
    expect(good.calls).toEqual(["/role reload"]);
    expect(statesOf("good")).toHaveLength(1);
    // a partial success is not an error
    expect(errors()).toHaveLength(0);
    expect(reloaded()).toEqual([{ type: "proto.reloadConfig", what: "roles", sessions: ["good"] }]);
  });

  it("answers proto.error only when every target failed", async () => {
    const a = fakeLive("s1", { fail: true });
    const b = fakeLive("s2", { fail: true });
    const { run, reloaded, errors } = setup([a, b]);

    await run("settings");

    expect(reloaded()).toHaveLength(0);
    expect(errors()).toHaveLength(1);
    expect(errors()[0]!.message).toMatch(/settings reload failed/);
  });
});

describe("proto.reloadConfig with nothing live", () => {
  it("replies with an empty id list rather than an error", async () => {
    const { run, reloaded, errors } = setup([]);

    await run("roles");

    // nothing was running, so nothing can be out of date: success, no work
    expect(errors()).toHaveLength(0);
    expect(reloaded()).toEqual([{ type: "proto.reloadConfig", what: "roles", sessions: [] }]);
  });
});
