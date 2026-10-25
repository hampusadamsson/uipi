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

describe("UiHost status slots", () => {
  it("broadcasts proto.statuses when the roles extension paints its ◆ slot", () => {
    const { h, frames } = host();
    // what the roles extension does: ctx.ui.setStatus("role", theme.fg("accent", `◆ work`))
    h.ui.setStatus("role", h.ui.theme.fg("accent", "◆ work"));

    expect(frames).toHaveLength(1);
    expect(frames[0]).toEqual({
      type: "proto.statuses",
      sessionId: "sess",
      statuses: { role: "◆ work" },
    });
    expect(h.statuses()).toEqual({ role: "◆ work" });
  });

  it("replaces the whole map, so a second slot does not drop the first", () => {
    const { h, frames } = host();
    h.ui.setStatus("role", "◆ work");
    h.ui.setStatus("ctx", "42%");
    expect(frames.at(-1)).toMatchObject({ statuses: { role: "◆ work", ctx: "42%" } });
  });

  it("setStatus(key, undefined) clears the slot and re-broadcasts", () => {
    const { h, frames } = host();
    h.ui.setStatus("role", "◆ work");
    h.ui.setStatus("role", undefined as never);
    expect(frames.at(-1)).toMatchObject({ statuses: {} });

    // clearing an absent slot is not worth a frame
    const before = frames.length;
    h.ui.setStatus("role", undefined as never);
    expect(frames.length).toBe(before);
  });

  it("an unchanged value is not re-broadcast", () => {
    const { h, frames } = host();
    h.ui.setStatus("role", "◆ work");
    h.ui.setStatus("role", "◆ work");
    expect(frames).toHaveLength(1);
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
