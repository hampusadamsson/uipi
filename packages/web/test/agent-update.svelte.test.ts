// Settings → Update: the card that pulls the agent config.
//
// The behaviours worth pinning are the ones a user would notice going wrong:
//  1. Check and Update are separate — checking only inspects, and Update is not
//     offered when there is nothing to apply.
//  2. A refused pull (dirty checkout, diverged history) shows git's reason
//     instead of silently looking successful.
//  3. Digits tell the truth: "up to date" only when the server compared and found
//     nothing behind, never when the check could not reach the remote.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mount, unmount, flushSync } from "svelte";
import AgentUpdateSection from "../src/components/settings/AgentUpdateSection.svelte";
import { ui } from "../src/lib/state.svelte.js";
import type { AgentConfigSource } from "@uipi/protocol";

let host: HTMLElement;
let component: ReturnType<typeof mount> | null = null;

function source(over: Partial<AgentConfigSource> = {}): AgentConfigSource {
  return {
    agentDir: "/home/uipi/.pi/agent",
    remote: "https://github.com/hampusadamsson/pi.git",
    branch: "home",
    commit: "abc1234",
    remoteCommit: "abc1234",
    behind: 0,
    dirty: false,
    error: null,
    ...over,
  };
}

function render(): void {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(AgentUpdateSection, { target: host });
  flushSync();
}

function button(text: string): HTMLButtonElement {
  const el = [...host.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes(text));
  if (!el) throw new Error(`no button "${text}"`);
  return el as HTMLButtonElement;
}

function note(): string | null {
  return host.querySelector("[data-update-note]")?.textContent?.trim() ?? null;
}

beforeEach(() => {
  ui.agentSource = null;
  ui.error = null;
});

afterEach(() => {
  if (component) unmount(component);
  component = null;
  host?.remove();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("before checking", () => {
  it("says it has not checked and offers no update", () => {
    render();
    expect(host.textContent).toContain("Not checked yet");
    // Update needs a known-behind count, so it starts disabled
    expect(button("Update now").disabled).toBe(true);
  });

  it("checking fetches the remote and reports what it found", async () => {
    const check = vi.spyOn(ui, "checkAgentUpdate").mockImplementation(async () => {
      const s = source({ behind: 2, remoteCommit: "def5678" });
      ui.agentSource = s;
      return s;
    });
    render();

    button("Check for updates").click();
    await vi.waitFor(() => expect(note()).toContain("2 new commits"));

    // a check consults the network: that is the whole point of the button
    expect(check).toHaveBeenCalledWith(true);
    expect(button("Update now").disabled).toBe(false);
  });

  it("says up to date only when the server actually compared", async () => {
    vi.spyOn(ui, "checkAgentUpdate").mockImplementation(async () => {
      const s = source({ behind: 0 });
      ui.agentSource = s;
      return s;
    });
    render();

    button("Check for updates").click();
    await vi.waitFor(() => expect(note()).toBe("already up to date"));
  });
});

describe("applying an update", () => {
  it("reports how many live sessions took the new config", async () => {
    ui.agentSource = source({ behind: 1, remoteCommit: "def5678" });
    vi.spyOn(ui, "applyAgentUpdate").mockResolvedValue({
      applied: true,
      reloaded: ["s1", "s2"],
      source: source({ behind: 0, commit: "def5678", remoteCommit: "def5678" }),
    });
    render();

    button("Update now").click();
    await vi.waitFor(() => expect(note()).toContain("2 live sessions reloaded"));
  });

  it("says so when there was nothing running to reload", async () => {
    ui.agentSource = source({ behind: 1 });
    vi.spyOn(ui, "applyAgentUpdate").mockResolvedValue({
      applied: true,
      reloaded: [],
      source: source(),
    });
    render();

    button("Update now").click();
    await vi.waitFor(() => expect(note()).toContain("no live sessions to reload"));
  });

  it("shows git's reason when the pull was refused", async () => {
    ui.agentSource = source({ behind: 1 });
    vi.spyOn(ui, "applyAgentUpdate").mockResolvedValue({
      applied: false,
      reloaded: [],
      source: source({ error: "agent config has local changes; not pulling over them" }),
    });
    render();

    button("Update now").click();
    // the reason is visible rather than the update looking successful
    await vi.waitFor(() => expect(note()).toContain("local changes"));
  });
});

describe("states the card must not misrepresent", () => {
  it("marks a dirty checkout and explains why updating is refused", () => {
    ui.agentSource = source({ behind: 0, dirty: true });
    render();
    expect(host.textContent).toContain("local changes");
    expect(host.textContent).toContain("would discard them");
  });

  it("shows the unreachable-remote error beside the commit it is still on", () => {
    ui.agentSource = source({ behind: null, error: "could not resolve host" });
    render();
    expect(host.textContent).toContain("could not resolve host");
    expect(host.textContent).toContain("abc1234");
    // and it must not claim to be up to date
    expect(host.textContent).not.toContain("up to date");
  });

  it("does not claim up to date from a `0` that means 'not compared'", () => {
    // `behind: 0` with no remote commit is "we could not compare", which is not
    // the same as "in sync". Only a compared, genuinely-equal pair gets the
    // badge; otherwise a network failure would read as a clean bill of health.
    ui.agentSource = source({ behind: 0, remoteCommit: null, commit: "abc1234" });
    render();
    expect(host.textContent).not.toContain("up to date");
  });

  it("explains that a plain directory has nothing to pull", () => {
    ui.agentSource = source({ remote: null, branch: null, commit: null });
    render();
    expect(host.textContent).toContain("not a git checkout");
    expect(button("Update now").disabled).toBe(true);
  });
});
