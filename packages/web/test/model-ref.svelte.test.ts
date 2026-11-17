// Model *references* are provider + model id, and the picker must say so.
//
// The bug this file pins: the picker compared a row to the session's current
// model by `modelId` alone. Bifrost serves every upstream through one provider
// (`bifrost`) and prefixes each id with the upstream it routes to, so a list
// that carries native `opencode-go` models alongside bifrost ones holds two
// rows with the same id — and the single-id comparison ticked both. The chip
// showed only the id too, which hid the difference entirely.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mount, unmount, flushSync } from "svelte";
import ModelPicker from "../src/components/ModelPicker.svelte";
import { ui } from "../src/lib/state.svelte.js";
import {
  modelLabel,
  modelRefKey,
  modelSubtitle,
  sameModelRef,
  upstreamPrefix,
} from "../src/lib/models.js";
import type { AttachedSession } from "@uipi/client";
import type { ModelInfo } from "@uipi/protocol";

let host: HTMLElement;
let component: ReturnType<typeof mount> | null = null;

const SID = "s1";

function attachSession(model: { provider: string; modelId: string } | null): void {
  ui.attached.set(SID, {
    sessionId: SID,
    cwd: "/proj",
    model,
    thinkingLevel: "off",
    tools: [],
    role: null,
    commands: [],
    statuses: {},
    isStreaming: false,
    steering: [],
    followUp: [],
    sessionFile: null,
    messages: [],
    events: [],
  } as AttachedSession);
}

/** the picker's own "this row is the current model" tick — Command.Item ships
 *  a second, always-present check icon, so select by its class, not by `svg`. */
function isTicked(el: HTMLElement): boolean {
  return el.querySelector('svg[class*="size-4 shrink-0"]') !== null;
}

function model(provider: string, modelId: string, displayName = modelId): ModelInfo {
  return { provider, modelId, displayName, reasoning: false, contextWindow: 1000 };
}

beforeEach(() => {
  ui.attached.clear();
  ui.error = null;
  ui.models = [];
  ui.activeId = SID;
});

afterEach(() => {
  if (component) unmount(component);
  component = null;
  host?.remove();
  document.body.innerHTML = "";
  ui.attached.clear();
  ui.models = [];
  ui.activeId = null;
});

describe("model identity is provider + id", () => {
  it("does not treat two providers with the same id as the same model", () => {
    expect(sameModelRef({ provider: "a", modelId: "m" }, { provider: "b", modelId: "m" })).toBe(
      false,
    );
    expect(sameModelRef({ provider: "a", modelId: "m" }, { provider: "a", modelId: "m" })).toBe(
      true,
    );
  });

  it("never matches on absence: no current model marks no row current", () => {
    expect(sameModelRef(null, { provider: "a", modelId: "m" })).toBe(false);
    expect(sameModelRef(undefined, undefined)).toBe(false);
  });

  it("keys rows by provider and id, so same-id rows cannot collide", () => {
    expect(modelRefKey({ provider: "bifrost", modelId: "opencode-go/x" })).toBe(
      "bifrost/opencode-go/x",
    );
    expect(modelRefKey({ provider: "opencode-go", modelId: "x" })).toBe("opencode-go/x");
  });
});

describe("model labels", () => {
  it("keeps a bare reference's full id, including its routing prefix", () => {
    // an attached session has no displayName; dropping the prefix here would
    // print a different model than the one in effect
    expect(modelLabel({ provider: "bifrost", modelId: "opencode-go/deepseek-v4.1-flash" })).toBe(
      "opencode-go/deepseek-v4.1-flash",
    );
  });

  it("strips the routing prefix when the id doubles as the name", () => {
    // Bifrost reports no metadata for a local upstream, so name === id
    expect(modelLabel(model("bifrost", "lmstudio/qwen3.8-27b"))).toBe("qwen3.8-27b");
  });

  it("uses the reported display name when there is one", () => {
    expect(modelLabel(model("bifrost", "opencode-go/glm-5.3", "Glm 5.3"))).toBe("Glm 5.3");
  });

  it("reads the upstream prefix, and reports none for a bare id", () => {
    expect(upstreamPrefix("opencode-go/x")).toBe("opencode-go");
    expect(upstreamPrefix("m")).toBeNull();
  });

  it("says which upstream a bifrost model routes to, not just `bifrost`", () => {
    expect(modelSubtitle({ provider: "bifrost", modelId: "opencode-go/glm-5.3" })).toBe(
      "bifrost · opencode-go",
    );
    // no prefix to add: the provider is the whole story
    expect(modelSubtitle({ provider: "anthropic", modelId: "claude" })).toBe("anthropic");
  });
});

describe("model picker marks exactly the current row", () => {
  it("ticks only the row whose provider *and* id match", () => {
    ui.models = [
      model("bifrost", "deepseek-v4.1-flash", "Deepseek (bifrost)"),
      model("opencode-go", "deepseek-v4.1-flash", "Deepseek (native)"),
    ];
    attachSession({ provider: "opencode-go", modelId: "deepseek-v4.1-flash" });

    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(ModelPicker, { target: host, props: { sessionId: SID } });
    flushSync();
    host.querySelector<HTMLButtonElement>("button")!.click();
    flushSync();

    const items = [...document.querySelectorAll<HTMLElement>('[data-slot="command-item"]')];
    expect(items, "both rows render").toHaveLength(2);
    const checked = items.filter(isTicked);
    expect(checked, "exactly one row is current").toHaveLength(1);
    // the native one, which is what the session actually has
    expect(checked[0].textContent).toContain("native");
  });

  it("shows the current model's id on the trigger, not a bare model name", () => {
    ui.models = [model("bifrost", "opencode-go/glm-5.3", "Glm 5.3")];
    attachSession({ provider: "bifrost", modelId: "opencode-go/glm-5.3" });

    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(ModelPicker, { target: host, props: { sessionId: SID } });
    flushSync();

    // the id carries its route; the trigger must not silently drop it
    expect(host.querySelector("button")!.textContent).toContain("opencode-go/glm-5.3");
  });

  it("filters on the provider and the upstream, not just the display name", () => {
    ui.models = [
      model("bifrost", "opencode-go/glm-5.3", "Glm 5.3"),
      model("bifrost", "lmstudio/qwen3.8-27b", "qwen3.8-27b"),
    ];
    attachSession({ provider: "bifrost", modelId: "opencode-go/glm-5.3" });

    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(ModelPicker, { target: host, props: { sessionId: SID } });
    flushSync();
    host.querySelector<HTMLButtonElement>("button")!.click();
    flushSync();

    const input = document.querySelector<HTMLInputElement>('[data-slot="command-input"]')!;
    input.value = "lmstudio";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();

    const visible = [...document.querySelectorAll<HTMLElement>('[data-slot="command-item"]')];
    expect(visible).toHaveLength(1);
    expect(visible[0].textContent).toContain("qwen3.8-27b");
  });
});
