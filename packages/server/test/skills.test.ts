// `proto.skills` lists pi's own skills for a cwd — uipi only ever displays them.
//
// The loader is pi's (`loadSkills`), so the list matches what the terminal would
// show: user skills from the agent dir (`<agentDir>/skills`) plus project skills
// from `<cwd>/.pi/skills`, defaults included. Scope collapses to the protocol's
// two buckets: only a real project skill is "project"; everything else (temporary
// explicit paths, other) reads as "user".
//
// Tested at the helper, not over the wire: the mapping/sorting is the logic worth
// pinning, and the switch case is a one-line `reply(...)` around it.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it, expect } from "vitest";
import { discoverSkills } from "../src/sessions.js";

const dirs: string[] = [];

/** A throwaway directory, removed again in afterEach. */
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/** Write a SKILL.md with the given frontmatter under `<root>/<sub>/SKILL.md`. */
function writeSkill(root: string, name: string, description: string): void {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\nBody.\n`,
  );
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("discoverSkills", () => {
  it("finds a project skill under <cwd>/.pi/skills and marks it project", () => {
    const cwd = tempDir("uipi-skills-cwd-");
    const agentDir = tempDir("uipi-skills-agent-");
    writeSkill(join(cwd, ".pi", "skills"), "demo", "Demo project skill");

    const skills = discoverSkills(cwd, agentDir);

    expect(skills).toEqual([{ name: "demo", description: "Demo project skill", scope: "project" }]);
  });

  it("finds a user skill under <agentDir>/skills and marks it user", () => {
    const cwd = tempDir("uipi-skills-cwd-");
    const agentDir = tempDir("uipi-skills-agent-");
    writeSkill(join(agentDir, "skills"), "glob", "Global user skill");

    const skills = discoverSkills(cwd, agentDir);

    expect(skills).toEqual([{ name: "glob", description: "Global user skill", scope: "user" }]);
  });

  it("merges both scopes and sorts by name", () => {
    const cwd = tempDir("uipi-skills-cwd-");
    const agentDir = tempDir("uipi-skills-agent-");
    writeSkill(join(agentDir, "skills"), "zeta", "User skill");
    writeSkill(join(cwd, ".pi", "skills"), "alpha", "Project skill");
    writeSkill(join(agentDir, "skills"), "mike", "Another user skill");

    const skills = discoverSkills(cwd, agentDir);

    expect(skills).toEqual([
      { name: "alpha", description: "Project skill", scope: "project" },
      { name: "mike", description: "Another user skill", scope: "user" },
      { name: "zeta", description: "User skill", scope: "user" },
    ]);
  });

  it("returns [] instead of throwing when the directories do not exist", () => {
    const cwd = join(tempDir("uipi-skills-cwd-"), "missing");
    const agentDir = join(tempDir("uipi-skills-agent-"), "missing");

    expect(discoverSkills(cwd, agentDir)).toEqual([]);
  });
});
