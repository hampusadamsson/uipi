import { describe, it, expect, afterEach } from "vitest";
import {
  deriveTranscript,
  registerCustomEntryRenderer,
  customEntryRenderers,
} from "../src/transcript.js";
import type { TranscriptEntry } from "../src/transcript.js";

const userMsg = {
  role: "user",
  id: "u1",
  content: [{ type: "text", text: "say hi" }],
};
const partialA = {
  role: "assistant",
  id: "a1",
  content: [{ type: "text", text: "hello-stream" }],
};
const finalA = {
  role: "assistant",
  id: "a1",
  stopReason: "stop",
  content: [{ type: "text", text: "hello-stream done" }],
};

describe("deriveTranscript", () => {
  it("produces deterministic ids for messages without one", () => {
    const noId = { role: "user", content: [{ type: "text", text: "hi" }] };
    const a = deriveTranscript({ messages: [noId], events: [] });
    const b = deriveTranscript({ messages: [noId], events: [] });
    expect(a[0].id).toBe(b[0].id);
    expect(a[0].id).not.toBe("");
  });

  it("shows streamed text from message_update events", () => {
    const entries = deriveTranscript({
      messages: [userMsg],
      events: [
        { type: "message_start", message: partialA },
        { type: "message_update", message: partialA },
        { type: "message_end", message: finalA },
        { type: "agent_end", messages: [] },
        { type: "agent_settled" },
      ],
    });
    const asst = entries.find((e: TranscriptEntry) => e.role === "assistant");
    expect(asst).toBeDefined();
    expect(asst!.text).toContain("hello-stream");
  });

  it("shows optimistic sent message and folds the authoritative echo without duplication", () => {
    const base = { messages: [], events: [] as unknown[] };
    // optimistic
    let entries = deriveTranscript({ ...base, sentMessages: ["hi from user"] });
    expect(entries.some((e) => e.role === "user" && e.text === "hi from user")).toBe(true);
    // then echo arrives: message_start(user) — optimistic copy is cleared by caller before this call
    entries = deriveTranscript({
      messages: [userMsg],
      events: [{ type: "message_start", message: userMsg }],
    });
    expect(entries.filter((e) => e.role === "user")).toHaveLength(1);
  });

  it("captures thinking deltas into a block that ends on message_end", () => {
    const entries = deriveTranscript({
      messages: [],
      events: [
        {
          type: "message_update",
          message: { role: "assistant", id: "a1", content: [{ type: "text", text: "part" }] },
          assistantMessageEvent: { type: "thinking_delta", delta: "thinking hard" },
        },
        {
          type: "message_update",
          message: { role: "assistant", id: "a1", content: [{ type: "text", text: "part" }] },
          assistantMessageEvent: { type: "thinking_delta", delta: " about it" },
        },
        {
          type: "message_end",
          message: {
            role: "assistant",
            id: "a1",
            stopReason: "stop",
            content: [{ type: "text", text: "done" }],
          },
        },
      ],
    });
    const asst = entries.find((e) => e.role === "assistant");
    expect(asst).toBeDefined();
    expect(asst!.thinking).toBe("thinking hard about it");
    expect(asst!.thinkingActive).toBe(false);
  });

  it("keeps tool call cards from execution events", () => {
    const entries = deriveTranscript({
      messages: [userMsg],
      events: [
        {
          type: "tool_execution_start",
          toolCallId: "tc1",
          toolName: "ls",
          args: { path: "/tmp" },
        },
        {
          type: "tool_execution_update",
          toolCallId: "tc1",
          partialOutput: "file-a\nfile-b",
        },
        {
          type: "tool_execution_end",
          toolCallId: "tc1",
          result: { content: [{ type: "text", text: "file-a\nfile-b" }], isError: false },
        },
      ],
    });
    const withTool = entries.find((e) => e.toolCalls.length > 0);
    expect(withTool).toBeDefined();
    expect(withTool!.toolCalls[0].name).toBe("ls");
    expect(withTool!.toolCalls[0].output).toContain("file-a");
    expect(withTool!.toolCalls[0].done).toBe(true);
  });
});

describe("custom entry rendering", () => {
  const roleSwitch = (role: string | null) => ({
    type: "custom",
    customType: "role-switch",
    data: { role },
  });

  afterEach(() => {
    // the registry is module-level: don't leak ad-hoc renderers across tests
    customEntryRenderers.delete("test-todo");
  });

  it("renders a role-switch appended after a user message", () => {
    const entries = deriveTranscript({
      messages: [userMsg],
      events: [{ type: "entry_appended", entry: { ...roleSwitch("architect"), id: "e1" } }],
    });
    const system = entries.filter((e) => e.kind === "system");
    expect(system).toHaveLength(1);
    expect(system[0].text).toBe("◆ role → architect");
    expect(system[0].text.split("\n")).toHaveLength(1);
    expect(system[0].id).toBe("role-e1");
  });

  it("renders a role-switch present in the messages snapshot", () => {
    const entries = deriveTranscript({
      messages: [userMsg, roleSwitch("architect")],
      events: [],
    });
    expect(entries.some((e) => e.text === "◆ role → architect")).toBe(true);
  });

  it("suppresses a role-switch that precedes the first user message", () => {
    const entries = deriveTranscript({
      messages: [roleSwitch("architect"), userMsg],
      events: [],
    });
    expect(entries.some((e) => e.kind === "system")).toBe(false);
    expect(entries.some((e) => e.role === "user")).toBe(true);
  });

  it("suppresses a startup role-switch appended before any user message lands", () => {
    const entries = deriveTranscript({
      messages: [],
      events: [{ type: "entry_appended", entry: roleSwitch("architect") }],
    });
    expect(entries).toHaveLength(0);
  });

  it("renders a null role as none", () => {
    const entries = deriveTranscript({
      messages: [userMsg],
      events: [{ type: "entry_appended", entry: roleSwitch(null) }],
    });
    const system = entries.find((e) => e.kind === "system");
    expect(system!.text).toBe("◆ role → none");
  });

  it("renders nothing for an unknown customType", () => {
    const entries = deriveTranscript({
      messages: [userMsg],
      events: [{ type: "entry_appended", entry: { type: "custom", customType: "nope", data: {} } }],
    });
    expect(entries.some((e) => e.kind === "system")).toBe(false);
    expect(entries).toHaveLength(1);
  });

  it("renders other custom types through the registry, and replacing a renderer wins", () => {
    const todo = { type: "custom", customType: "test-todo", data: { title: "ship it" }, id: "t1" };
    const base = { messages: [userMsg], events: [{ type: "entry_appended", entry: todo }] };
    // unregistered → nothing
    expect(deriveTranscript(base).some((e) => e.kind === "system")).toBe(false);

    registerCustomEntryRenderer("test-todo", (entry) => ({
      kind: "system",
      text: `todo: ${(entry.data as { title: string }).title}`,
      thinking: "",
      thinkingActive: false,
      toolCalls: [],
      raw: entry,
      id: `todo-${entry.id}`,
    }));
    expect(deriveTranscript(base).find((e) => e.kind === "system")!.text).toBe("todo: ship it");

    registerCustomEntryRenderer("test-todo", (entry) => ({
      kind: "system",
      text: `TODO! ${(entry.data as { title: string }).title}`,
      thinking: "",
      thinkingActive: false,
      toolCalls: [],
      raw: entry,
      id: `todo-b-${entry.id}`,
    }));
    expect(deriveTranscript(base).find((e) => e.kind === "system")!.text).toBe("TODO! ship it");
  });
});
