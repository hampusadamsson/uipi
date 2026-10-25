// The web-mode UI host must be safe for extensions written against terminal UI.
// Regression: ctx.ui.theme was undefined, so extensions that style text (e.g.
// the roles extension calling ctx.ui.theme.fg("accent", ...)) threw and the
// command silently did nothing.
import { describe, it, expect } from "vitest";
import { UiHost } from "../src/uihost.js";

function host() {
  const frames: unknown[] = [];
  const h = new UiHost(() => "sess", "rpc");
  h.attachSend((m) => frames.push(m));
  return { h, frames };
}

describe("UiHost theme", () => {
  it("exposes a theme whose style helpers return text unchanged", () => {
    const { h } = host();
    const theme = h.ui.theme;
    expect(theme).toBeDefined();
    // extensions call these with a token + text
    expect(theme.fg("accent", "◆ work")).toBe("◆ work");
    expect(theme.fg("muted", "x")).toBe("x");
    expect(theme.bold("hi")).toBe("hi");
    expect(theme.italic("hi")).toBe("hi");
    expect(theme.underline("hi")).toBe("hi");
  });

  it("does not throw when called with no text", () => {
    const { h } = host();
    expect(() => h.ui.theme.fg("accent", undefined as never)).not.toThrow();
  });

  it("reports an appearance and colors for extensions that read them", () => {
    const { h } = host();
    expect(h.ui.theme.appearance).toBe("dark");
    expect(h.ui.theme.colors).toEqual({});
  });
});

describe("UiHost notifications", () => {
  it("frames a notification to the client", () => {
    const { h, frames } = host();
    h.ui.notify("hello", "warning");
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({
      type: "ui.event",
      event: { kind: "notification", level: "warn", message: "hello", sessionId: "sess" },
    });
  });

  it("maps notify types to protocol levels", () => {
    const { h, frames } = host();
    h.ui.notify("a", "info");
    h.ui.notify("b", "error");
    h.ui.notify("c");
    const levels = (frames as { event: { level: string } }[]).map((f) => f.event.level);
    expect(levels).toEqual(["info", "error", "info"]);
  });
});
