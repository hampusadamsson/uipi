// Long tool output collapses behind a "show output" toggle while the card
// header (tool name + args preview) always stays visible.
//
// Mounted with `mount` directly against ToolCall, like message-collapse.svelte.test.ts
// mounts Message: no `ui` singleton is needed here because ToolCall only reads
// its `tc` prop.
import { describe, it, expect, afterEach } from "vitest";
import { mount, unmount, flushSync } from "svelte";
import ToolCall from "../src/components/ToolCall.svelte";
import type { ToolCallView } from "@uipi/client";

function toolCall(over: Partial<ToolCallView> = {}): ToolCallView {
  return {
    id: "tc1",
    name: "bash",
    argsPreview: '{"cmd":"ls -la"}',
    output: "",
    done: true,
    isError: false,
    ...over,
  };
}

/** n lines of plain output. */
function lines(n: number): string {
  return Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n");
}

let host: HTMLElement;
let component: ReturnType<typeof mount> | null = null;

type Rendered = {
  /** the "show output" / "hide output" toggle, if the output is collapsible */
  toggle: () => HTMLButtonElement | null;
  /** the rendered <pre> output, whether or not it is shown */
  output: () => HTMLElement | null;
  /** whether that output is actually on screen (collapsible content is hidden, not unmounted) */
  outputVisible: () => boolean;
};

function render(tc: ToolCallView): Rendered {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(ToolCall, { target: host, props: { tc } });
  flushSync();
  return {
    toggle() {
      const found = [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) =>
        ["show output", "hide output"].includes((b.textContent ?? "").trim()),
      );
      return found ?? null;
    },
    output() {
      return host.querySelector<HTMLElement>("pre");
    },
    outputVisible() {
      const el = host.querySelector<HTMLElement>("pre");
      return el !== null && el.closest("[hidden]") === null;
    },
  };
}

afterEach(() => {
  if (component) unmount(component);
  component = null;
  host?.remove();
});

describe("long tool output", () => {
  it("keeps the header visible, hides the output, and reveals it on click", () => {
    const r = render(toolCall({ output: lines(6) }));

    // header is always there
    expect(host.textContent).toContain("bash");
    expect(host.textContent).toContain('{"cmd":"ls -la"}');

    // output collapsed by default, trigger present
    const toggle = r.toggle();
    expect(toggle).not.toBeNull();
    expect(toggle!.textContent!.trim()).toBe("show output");
    expect(r.output()).not.toBeNull();
    expect(r.outputVisible()).toBe(false);
    expect(host.querySelector("[data-slot=collapsible]")!.getAttribute("data-state")).toBe(
      "closed",
    );

    toggle!.click();
    flushSync();

    expect(r.outputVisible()).toBe(true);
    expect(r.output()!.textContent).toContain("line 6");
    expect(r.toggle()!.textContent!.trim()).toBe("hide output");
  });

  it("collapses at exactly five lines", () => {
    const r = render(toolCall({ output: lines(5) }));

    expect(r.toggle()).not.toBeNull();
    expect(r.toggle()!.textContent!.trim()).toBe("show output");
    expect(r.output()).not.toBeNull();
    expect(r.outputVisible()).toBe(false);
  });
});

describe("short tool output", () => {
  it("shows the output with no toggle at all", () => {
    const r = render(toolCall({ output: lines(2) }));

    expect(r.toggle()).toBeNull();
    expect(host.querySelector("[data-slot=collapsible]")).toBeNull();
    expect(r.output()).not.toBeNull();
    expect(r.output()!.textContent).toContain("line 2");
    expect(r.outputVisible()).toBe(true);
  });
});

describe("tool call header", () => {
  it("stays visible while the output is collapsed", () => {
    const r = render(toolCall({ output: lines(8) }));
    expect(r.outputVisible()).toBe(false);

    expect(host.textContent).toContain("bash");
    expect(host.textContent).toContain('{"cmd":"ls -la"}');
  });

  it("stays visible once the output is expanded", () => {
    const r = render(toolCall({ output: lines(8) }));
    r.toggle()!.click();
    flushSync();

    expect(r.outputVisible()).toBe(true);
    expect(host.textContent).toContain("bash");
    expect(host.textContent).toContain('{"cmd":"ls -la"}');
  });
});
