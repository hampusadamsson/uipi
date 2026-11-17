// The update endpoint over the protocol: what a *request* is allowed to affect.
//
// The security property, stated as a test: nothing in the incoming message can
// become a git remote, ref or path. The server resolves those from its own
// configuration and the checkout, so an attacker with a websocket can ask to
// check or to pull — and nothing else. These tests drive `handle()` with a
// message carrying hostile extra fields and assert the git target is unchanged.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionService } from "../src/sessions.js";
import type { S2C } from "@uipi/protocol";

let root: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@e", ...args], {
    cwd,
    encoding: "utf8",
  }).trim();
}

/** A bare remote with one commit on `home`, plus a clone of it. */
function makeCheckout(): { remote: string; work: string } {
  const remote = join(root, "remote.git");
  mkdirSync(remote);
  git(remote, "init", "--bare", "--initial-branch=home");
  const seed = join(root, "seed");
  mkdirSync(seed);
  git(seed, "init", "--initial-branch=home");
  writeFileSync(join(seed, "roles.json"), '{"active":"work"}\n');
  git(seed, "add", "-A");
  git(seed, "commit", "-m", "initial");
  git(seed, "remote", "add", "origin", remote);
  git(seed, "push", "-u", "origin", "home");
  const work = join(root, "work");
  execFileSync("git", ["clone", "--branch", "home", remote, work], { encoding: "utf8" });
  return { remote, work };
}

/** Send one message and collect the reply frames. */
async function handle(svc: SessionService, msg: Record<string, unknown>): Promise<S2C[]> {
  const sent: S2C[] = [];
  await svc.handle(msg as never, (m) => sent.push(m), { send: () => {} });
  return sent;
}

type UpdateReply = Extract<S2C, { type: "proto.agentUpdate" }>;

function updateReply(frames: S2C[]): UpdateReply {
  const got = frames.find((f) => f.type === "proto.agentUpdate");
  if (!got) throw new Error(`no proto.agentUpdate in ${JSON.stringify(frames)}`);
  return got as UpdateReply;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "uipi-proto-update-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("proto.agentUpdateCheck", () => {
  it("describes the deployment's checkout, not anything the request names", async () => {
    const { work, remote } = makeCheckout();
    const svc = new SessionService(undefined as never, { cwd: root, agentDir: work });

    const frames = await handle(svc, {
      type: "proto.agentUpdateCheck",
      fetch: false,
      // a hostile client trying to redirect git
      remote: "/etc/passwd",
      branch: "--upload-pack=touch /tmp/pwned",
      agentDir: "/",
      path: "/tmp",
    });

    const reply = updateReply(frames);
    // the server's own checkout answered
    expect(reply.source.agentDir).toBe(work);
    expect(reply.source.remote).toBe(remote);
    expect(reply.source.branch).toBe("home");
    expect(reply.applied).toBe(false);
  });

  it("reports a non-checkout agent dir as having no remote, without failing", async () => {
    const plain = join(root, "plain");
    mkdirSync(plain);
    const svc = new SessionService(undefined as never, { cwd: plain, agentDir: plain });

    const reply = updateReply(await handle(svc, { type: "proto.agentUpdateCheck" }));
    expect(reply.source.remote).toBeNull();
    expect(reply.source.commit).toBeNull();
  });
});

describe("proto.agentUpdateApply", () => {
  it("pulls the configured branch and reports that it applied", async () => {
    const { work, remote } = makeCheckout();
    // the source repo moves on
    const other = join(root, "other");
    execFileSync("git", ["clone", "--branch", "home", remote, other], { encoding: "utf8" });
    writeFileSync(join(other, "roles.json"), '{"active":"architect"}\n');
    git(other, "commit", "-am", "roles");
    git(other, "push", "origin", "home");

    const svc = new SessionService(undefined as never, { cwd: work, agentDir: work });
    const reply = updateReply(await handle(svc, { type: "proto.agentUpdateApply" }));

    expect(reply.applied).toBe(true);
    expect(reply.source.error).toBeNull();
    expect(reply.source.behind).toBe(0);
    // an update with no live sessions reloads nothing, and says so
    expect(reply.reloaded).toEqual([]);
  });

  it("refuses to apply over a conflicting local edit and returns git's reason, not a protocol error", async () => {
    const { work, remote } = makeCheckout();
    writeFileSync(join(work, "roles.json"), '{"active":"mine"}\n');
    // the incoming commit changes the same file
    const other = join(root, "other");
    execFileSync("git", ["clone", "--branch", "home", remote, other], { encoding: "utf8" });
    writeFileSync(join(other, "roles.json"), '{"active":"theirs"}\n');
    git(other, "commit", "-am", "roles");
    git(other, "push", "origin", "home");

    const svc = new SessionService(undefined as never, { cwd: work, agentDir: work });
    const frames = await handle(svc, { type: "proto.agentUpdateApply" });
    // the answer is a normal reply carrying the reason: the UI shows it beside
    // the version it is still on
    expect(frames.some((f) => f.type === "proto.error")).toBe(false);
    const reply = updateReply(frames);
    expect(reply.applied).toBe(false);
    expect(reply.source.error).toBeTruthy();
  });

  it("ignores a request that tries to name its own remote", async () => {
    const { work, remote } = makeCheckout();
    const svc = new SessionService(undefined as never, { cwd: work, agentDir: work });

    const reply = updateReply(
      await handle(svc, {
        type: "proto.agentUpdateApply",
        remote: "https://evil.invalid/repo.git",
        branch: "main",
      }),
    );

    // still the deployment's remote and branch
    expect(reply.source.remote).toBe(remote);
    expect(reply.source.branch).toBe("home");
  });
});
