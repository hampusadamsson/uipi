// Pulling the agent config: the guards that make it safe, and the states the
// Settings card has to be able to tell apart.
//
// The security property is the important one. The update endpoint runs git in a
// directory the *server* chose, against a remote and branch the *deployment*
// configured. A request carries no URL, ref or path — so these tests pin that
// nothing in the request can become a git argument, and that a hostile value in
// the server's own config is rejected before it reaches argv.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  describeSource,
  isGitCheckout,
  pullSource,
  resolveUpdate,
  __test,
} from "../src/agent-update.js";

const { safeRef, safeRemote } = __test;

let root: string;

/** Run git for test setup, with an identity so commits work in CI. */
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
    cwd,
    encoding: "utf8",
  }).trim();
}

/** A bare "remote" plus a clone of it — the shape of the real deployment. */
function makePair(): { remote: string; work: string } {
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

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "uipi-update-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("git argument guards", () => {
  it("accepts an ordinary branch name", () => {
    expect(safeRef("home")).toBe("home");
    expect(safeRef("release/2026-01")).toBe("release/2026-01");
  });

  it("refuses a ref that would be read as an option", () => {
    // `git fetch origin --upload-pack=...` is how a ref becomes a command
    expect(() => safeRef("--upload-pack=touch /tmp/x")).toThrow(/unsafe git ref/);
    expect(() => safeRef("-f")).toThrow(/unsafe git ref/);
  });

  it("refuses refs with shell-ish or whitespace content", () => {
    expect(() => safeRef("a b")).toThrow(/unsafe git ref/);
    expect(() => safeRef("a;rm -rf /")).toThrow(/unsafe git ref/);
    expect(() => safeRef("$(id)")).toThrow(/unsafe git ref/);
  });

  it("refuses a remote that starts with a dash or contains whitespace", () => {
    expect(() => safeRemote("--upload-pack=x")).toThrow(/unsafe git remote/);
    expect(() => safeRemote("https://x/y z")).toThrow(/unsafe git remote/);
  });
});

describe("isGitCheckout", () => {
  it("is false for a plain directory and true for a clone", () => {
    const plain = join(root, "plain");
    mkdirSync(plain);
    expect(isGitCheckout(plain)).toBe(false);
    const { work } = makePair();
    expect(isGitCheckout(work)).toBe(true);
  });
});

describe("resolveUpdate", () => {
  it("reads the checkout's own origin and branch when nothing is configured", async () => {
    const { work, remote } = makePair();
    const r = await resolveUpdate(work);
    expect(r.remote).toBe(remote);
    expect(r.branch).toBe("home");
  });

  it("lets declared config win over the checkout", async () => {
    const { work } = makePair();
    const r = await resolveUpdate(work, {
      remote: "https://example.invalid/pi.git",
      branch: "from-config",
    });
    expect(r.remote).toBe("https://example.invalid/pi.git");
    expect(r.branch).toBe("from-config");
  });

  it("reports no remote for a directory that is not a checkout", async () => {
    const plain = join(root, "plain2");
    mkdirSync(plain);
    const r = await resolveUpdate(plain);
    expect(r.remote).toBeNull();
    expect(r.branch).toBeNull();
  });

  it("rejects an unsafe configured remote instead of running git with it", async () => {
    const { work } = makePair();
    await expect(resolveUpdate(work, { remote: "--upload-pack=x" })).rejects.toThrow(
      /unsafe git remote/,
    );
  });
});

describe("describeSource", () => {
  it("reports the commit, a clean tree and nothing to pull when in sync", async () => {
    const { work } = makePair();
    const r = await resolveUpdate(work);
    const s = await describeSource(r, { fetch: true });
    expect(s.commit).toMatch(/^[0-9a-f]{7}$/);
    expect(s.behind).toBe(0);
    expect(s.dirty).toBe(false);
    expect(s.error).toBeNull();
    // in sync means remote and local agree
    expect(s.remoteCommit).toBe(s.commit);
  });

  it("notices commits pushed after the clone and counts them", async () => {
    const { work, remote } = makePair();
    // push a new commit through a second clone, the way the source repo moves
    const other = join(root, "other");
    execFileSync("git", ["clone", "--branch", "home", remote, other], { encoding: "utf8" });
    writeFileSync(join(other, "roles.json"), '{"active":"architect"}\n');
    git(other, "commit", "-am", "update roles");
    git(other, "push", "origin", "home");

    const s = await describeSource(await resolveUpdate(work), { fetch: true });
    expect(s.behind).toBe(1);
    expect(s.error).toBeNull();
  });

  it("counts commits behind, not commits ahead", async () => {
    // `rev-list --left-right --count HEAD...REMOTE` prints "<ahead>\t<behind>".
    // Reading the first field makes a remote that moved report "0 behind", so
    // the card says "up to date" when it is not. This pins the field order by
    // making the two numbers differ.
    const { work, remote } = makePair();
    // one local-only commit (ahead = 1)
    git(work, "commit", "--allow-empty", "-m", "local only");
    // two remote-only commits (behind = 2)
    const other = join(root, "other-diverged");
    execFileSync("git", ["clone", "--branch", "home", remote, other], { encoding: "utf8" });
    for (const n of [1, 2]) {
      writeFileSync(join(other, "roles.json"), `{"active":"r${n}"}\n`);
      git(other, "commit", "-am", `remote ${n}`);
    }
    git(other, "push", "origin", "home");

    const s = await describeSource(await resolveUpdate(work), { fetch: true });
    expect(s.behind, "behind is the remote-only count").toBe(2);
  });

  it("flags tracked modifications, but not the files pi writes while running", async () => {
    const { work } = makePair();
    // pi writes its own state into the agent dir during normal use; counting
    // untracked files would mark every real deployment dirty forever
    writeFileSync(join(work, "recent-dirs.json"), '{"dirs":[]}\n');
    const untracked = await describeSource(await resolveUpdate(work), { fetch: true });
    expect(untracked.dirty, "an untracked pi-state file is not a config edit").toBe(false);

    // a tracked config file edited by hand *is* one
    writeFileSync(join(work, "roles.json"), '{"active":"hand-edited"}\n');
    const edited = await describeSource(await resolveUpdate(work), { fetch: true });
    expect(edited.dirty).toBe(true);
  });

  it("turns an unreachable remote into `error`, not a thrown exception", async () => {
    const { work } = makePair();
    const r = await resolveUpdate(work, {
      remote: join(root, "does-not-exist.git"),
      branch: "home",
    });
    const s = await describeSource(r, { fetch: true });
    // the card still renders: it shows the commit it is on and the reason
    expect(s.commit).not.toBeNull();
    expect(s.error).toBeTruthy();
  });
});

describe("pullSource", () => {
  it("fast-forwards the checkout and reports that HEAD moved", async () => {
    const { work, remote } = makePair();
    const other = join(root, "other2");
    execFileSync("git", ["clone", "--branch", "home", remote, other], { encoding: "utf8" });
    writeFileSync(join(other, "roles.json"), '{"active":"architect"}\n');
    git(other, "commit", "-am", "update roles");
    git(other, "push", "origin", "home");

    const r = await resolveUpdate(work);
    const before = await describeSource(r, { fetch: true });
    expect(before.behind).toBe(1);

    const { source, moved } = await pullSource(r);
    expect(moved).toBe(true);
    expect(source.error).toBeNull();
    expect(source.behind).toBe(0);
    // the file really changed on disk
    expect(await describeSource(await resolveUpdate(work), { fetch: true })).toMatchObject({
      behind: 0,
    });
  });

  it("does not move when already up to date", async () => {
    const { work } = makePair();
    const { moved, source } = await pullSource(await resolveUpdate(work));
    expect(moved).toBe(false);
    expect(source.error).toBeNull();
  });

  it("still pulls when only untracked pi state is present", async () => {
    // the real deployment case: pi has written sessions/ and recent-dirs.json,
    // and the update must not be blocked by them
    const { work, remote } = makePair();
    writeFileSync(join(work, "recent-dirs.json"), "{}\n");

    const other = join(root, "other-untracked");
    execFileSync("git", ["clone", "--branch", "home", remote, other], { encoding: "utf8" });
    writeFileSync(join(other, "roles.json"), '{"active":"architect"}\n');
    git(other, "commit", "-am", "roles");
    git(other, "push", "origin", "home");

    const { moved, source } = await pullSource(await resolveUpdate(work));
    expect(source.error).toBeNull();
    expect(moved).toBe(true);
    // and the untracked file survived the pull
    expect(existsSync(join(work, "recent-dirs.json"))).toBe(true);
  });

  it("lets git refuse when the pull would overwrite a local edit, and reports its reason", async () => {
    const { work, remote } = makePair();
    // edit a tracked file that the incoming commit also changes
    writeFileSync(join(work, "roles.json"), '{"active":"mine"}\n');

    const other = join(root, "other-conflict");
    execFileSync("git", ["clone", "--branch", "home", remote, other], { encoding: "utf8" });
    writeFileSync(join(other, "roles.json"), '{"active":"theirs"}\n');
    git(other, "commit", "-am", "roles");
    git(other, "push", "origin", "home");

    const { moved, source } = await pullSource(await resolveUpdate(work));
    expect(moved).toBe(false);
    // git's own message, naming what it would have overwritten
    expect(source.error).toMatch(/roles\.json/);
    // and the local edit is untouched — never rewritten with conflict markers,
    // which is what `git pull`'s implicit autostash would have done
    expect(readFileSync(join(work, "roles.json"), "utf8")).toContain("mine");
    expect(readFileSync(join(work, "roles.json"), "utf8")).not.toContain("<<<<<<<");
  });
});
