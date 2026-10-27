// The Settings tab: the registry in App.svelte is the only place a page tab is
// declared, so this mounts the real app and drives the tab the way a click does
// — then checks that the URL, `ui.page` and the rendered page agree, and that
// browser back returns to the previous view.
import { describe, it, expect, afterEach, vi } from "vitest";
import { mount, unmount, flushSync } from "svelte";
import App from "../src/App.svelte";
import { ui } from "../src/lib/state.svelte.js";

let host: HTMLElement;
let component: ReturnType<typeof mount> | null = null;

/** mount the app on `path` with the popstate listener wired up (as main.ts does) */
function render(path: string) {
  history.replaceState(null, "", path);
  // init() only installs the URL listener here; the socket is out of scope
  vi.spyOn(ui.client, "attach").mockImplementation(() => {});
  ui.init();
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(App, { target: host });
  flushSync();
  return host;
}

function tabs(): HTMLButtonElement[] {
  return [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
}

afterEach(() => {
  if (component) unmount(component);
  component = null;
  host?.remove();
  vi.restoreAllMocks();
});

describe("settings tab", () => {
  it("is declared by the page registry alone, next to Skills", () => {
    render("/");

    expect(tabs().map((t) => t.textContent?.trim())).toEqual(["Sessions", "Skills", "Settings"]);
  });

  it("clicking it pushes /settings, sets ui.page and renders the settings page", async () => {
    render("/");

    tabs()
      .find((t) => t.textContent?.trim() === "Settings")!
      .click();
    flushSync();

    expect(ui.page).toBe("settings");
    expect(location.pathname).toBe("/settings");
    // a section of SettingsPage, not chat and not the skills grid
    expect(host.textContent).toContain("Advanced");
  });

  it("browser back returns to the previous view", async () => {
    render("/");

    tabs()
      .find((t) => t.textContent?.trim() === "Settings")!
      .click();
    flushSync();
    expect(ui.page).toBe("settings");

    history.back();
    // popstate is dispatched asynchronously by the environment
    await new Promise((r) => setTimeout(r, 20));
    flushSync();

    expect(ui.page).toBe("sessions");
    expect(location.pathname).toBe("/");
    expect(host.textContent).not.toContain("Advanced");
  });
});
