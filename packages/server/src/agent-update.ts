// The pi agent config as a git checkout, and the only place that runs git.
//
// "Check for updates" / "Update now" in Settings pull the user's pi config
// (roles.json, skills/, extensions/, prompts/, settings.json, ...) from the repo
// it lives in. Two rules shape everything here:
//
//  1. **The remote and branch are the deployment's, never the request's.** They
//     come from the server's own configuration and are validated once, then
//     used as fixed argv entries. A browser cannot name a URL, a ref or a path,
//     so this cannot be turned into "run git against something of my choosing".
//  2. **No shell, ever.** `execFile` with an argv array means a ref like
//     `--upload-pack=...` is an argument, not a command; nothing is interpolated
//     into a string that a shell later parses.
//
// Destructive operations are cautious: the pull is `--ff-only` because the config
// repo is a mirror of the source, never a place to merge, and a pull that would
// overwrite a local edit is left to git to refuse (its message names the file).
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { AgentConfigSource } from "@uipi/protocol";

const run = promisify(execFile);

/** git stdout for a bound argv, or a thrown Error carrying git's stderr. */
async function git(cwd: string, args: string[], timeoutMs = 20_000): Promise<string> {
  try {
    const { stdout } = await run("git", args, {
      cwd,
      timeout: timeoutMs,
      // A network fetch must never block on an interactive credential prompt:
      // the server has no tty, and a hung `git fetch` would hold a request open
      // until the transport timed out with no explanation.
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "true" },
      maxBuffer: 4 * 1024 * 1024,
    });
    return stdout.trim();
  } catch (e) {
    const err = e as { stderr?: string; message?: string; killed?: boolean };
    const detail = (err.stderr || err.message || "").trim();
    throw new Error(err.killed ? "git timed out" : detail || "git failed", { cause: e });
  }
}

/** How the server was told to reach the config repo. */
export interface UpdateConfig {
  /** remote URL to pull from; defaults to the checkout's own `origin` */
  remote?: string;
  /** branch to track; defaults to the current branch, else `main` */
  branch?: string;
}

/** Resolved, validated view of {@link UpdateConfig} for one agent dir. */
export interface ResolvedUpdate {
  agentDir: string;
  /** the remote to fetch, or null when the dir is not a git checkout */
  remote: string | null;
  branch: string | null;
}

/**
 * A ref we are willing to hand to git.
 *
 * Belt-and-braces, not the primary defence (an argv array already stops
 * injection): it keeps an operator mistake like `--force` or a ref with a space
 * out of the command entirely.
 */
function safeRef(ref: string): string {
  if (!/^[A-Za-z0-9._/-]+$/.test(ref) || ref.startsWith("-")) {
    throw new Error(`refusing to use unsafe git ref: ${ref}`);
  }
  return ref;
}

/** A remote URL we are willing to fetch. */
function safeRemote(remote: string): string {
  const t = remote.trim();
  if (t.startsWith("-") || /\s/.test(t)) {
    throw new Error(`refusing to use unsafe git remote: ${remote}`);
  }
  return t;
}

/** Whether `dir` is the root of a git work tree. */
export function isGitCheckout(dir: string): boolean {
  return existsSync(join(dir, ".git"));
}

/**
 * Resolve the configured remote/branch against a checkout.
 *
 * Declared configuration wins, so a deployment can point at a fork or a branch;
 * when it is absent the checkout answers for itself, which keeps a plain
 * `git clone`d agent dir working with no configuration at all.
 */
export async function resolveUpdate(
  agentDir: string,
  config: UpdateConfig = {},
): Promise<ResolvedUpdate> {
  if (!isGitCheckout(agentDir)) return { agentDir, remote: null, branch: null };

  let remote = config.remote ? safeRemote(config.remote) : "";
  if (!remote) {
    remote = await git(agentDir, ["config", "--get", "remote.origin.url"]).catch(() => "");
  }

  let branch = config.branch ? safeRef(config.branch) : "";
  if (!branch) {
    branch = await git(agentDir, ["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => "");
    // a detached HEAD has no branch to compare against; use the default
    if (!branch || branch === "HEAD") branch = "main";
    branch = safeRef(branch);
  }

  return { agentDir, remote: remote || null, branch };
}

/**
 * Fetch the branch and return the fetched commit.
 *
 * `git fetch <remote> <branch>` writes `FETCH_HEAD` even when the remote is a
 * plain URL with no configured name, so the commit is read back from
 * `FETCH_HEAD` instead of guessed from a remote-tracking ref that may not exist.
 * That is what lets any reusable remote work.
 */
async function fetchCommit(resolved: ResolvedUpdate): Promise<string | null> {
  if (!resolved.remote || !resolved.branch) return null;
  await git(resolved.agentDir, ["fetch", resolved.remote, resolved.branch], 120_000);
  return (await git(resolved.agentDir, ["rev-parse", "FETCH_HEAD"]).catch(() => "")) || null;
}

/**
 * Describe the checkout: HEAD, the remote's commit, how far behind it is.
 *
 * `fetch` is what makes "check for updates" mean anything — without it the
 * answer can only describe local refs, which already agree with themselves.
 * It is opt-in because it is the only networked part.
 *
 * Every git failure is captured into `error` rather than thrown: a server that
 * is offline, or a dir with no remote, should still render a card that says so.
 */
export async function describeSource(
  resolved: ResolvedUpdate,
  opts: { fetch?: boolean } = {},
): Promise<AgentConfigSource> {
  const base: AgentConfigSource = {
    agentDir: resolved.agentDir,
    remote: resolved.remote,
    branch: resolved.branch,
    commit: null,
    remoteCommit: null,
    behind: null,
    dirty: false,
    error: null,
  };
  if (!resolved.remote) return base;

  try {
    base.commit =
      (await git(resolved.agentDir, ["rev-parse", "--short=7", "HEAD"]).catch(() => "")) || null;

    // Only *tracked* modifications count. The agent dir is also pi's live state
    // directory — pi writes recent-dirs.json, sessions/, models-store.json there
    // during ordinary use — so counting untracked files would mark every real
    // deployment permanently dirty and block updates forever.
    base.dirty =
      (
        await git(resolved.agentDir, ["status", "--porcelain", "--untracked-files=no"]).catch(
          () => "",
        )
      ).length > 0;

    let remoteSha: string | null = null;
    if (resolved.branch) {
      remoteSha = opts.fetch
        ? await fetchCommit(resolved)
        : // a previous fetch leaves FETCH_HEAD behind, which is enough for a
          // no-network comparison against whatever the last check saw
          (await git(resolved.agentDir, ["rev-parse", "FETCH_HEAD"]).catch(() => "")) || null;
    }

    if (remoteSha) {
      base.remoteCommit = remoteSha.slice(0, 7);
      const counts = await git(resolved.agentDir, [
        "rev-list",
        "--left-right",
        "--count",
        `HEAD...${remoteSha}`,
      ]).catch(() => "");
      // `--left-right --count A...B` prints "<A-only>\t<B-only>". HEAD is A and
      // the remote is B, so the *second* field is how far behind HEAD is — the
      // first is how far ahead, which is a different (and non-updatable) state.
      const [, behind] = counts.split(/\s+/).map((n) => Number.parseInt(n, 10));
      if (Number.isFinite(behind)) base.behind = behind;
    }
  } catch (e) {
    base.error = e instanceof Error ? e.message : String(e);
  }
  return base;
}

/**
 * Pull the config and report the resulting state.
 *
 * The pull is attempted even when the checkout has tracked modifications, and
 * git decides: a fast-forward that does not touch the modified files succeeds,
 * and one that would overwrite them is aborted with a message naming them.
 * Refusing up front on *any* local change would be wrong here — the agent dir is
 * pi's live state directory too, so it is usually dirty, and an update almost
 * always still applies cleanly.
 *
 * Returns the post-pull description plus whether HEAD moved, which is what
 * decides whether live sessions need a reload.
 */
export async function pullSource(
  resolved: ResolvedUpdate,
): Promise<{ source: AgentConfigSource; moved: boolean }> {
  const before = await describeSource(resolved);
  if (!resolved.remote || !resolved.branch) return { source: before, moved: false };

  try {
    // Deliberately not `git pull`: modern git runs an implicit autostash, and a
    // conflicting local edit comes back as conflict markers written *into the
    // config file* with a zero exit status. Fetch + `merge --ff-only` instead:
    // it refuses outright, leaves the file alone, and exits non-zero, so the
    // user's config is never silently rewritten with markers.
    const sha = await fetchCommit(resolved);
    if (!sha) throw new Error("could not resolve the remote branch");
    await git(resolved.agentDir, ["merge", "--ff-only", sha], 180_000);
  } catch (e) {
    return {
      source: { ...before, error: e instanceof Error ? e.message : String(e) },
      moved: false,
    };
  }

  const after = await describeSource(resolved);
  return { source: after, moved: before.commit !== after.commit };
}

/** Exported for tests: the argv-level ref/remote guards. */
export const __test = { safeRef, safeRemote };
