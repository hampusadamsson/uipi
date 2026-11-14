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

  it("carries usage and timing meta for an assistant message from the snapshot", () => {
    const entries = deriveTranscript({
      messages: [
        userMsg,
        {
          ...finalA,
          timestamp: 1_700_000_000_000,
          durationMs: 2000,
          usage: { input: 100, output: 50, cacheRead: 20, cacheWrite: 5, totalTokens: 175 },
        },
      ],
      events: [],
    });
    const asst = entries.find((e) => e.role === "assistant");
    expect(asst!.meta).toEqual({
      durationMs: 2000,
      outputTokens: 50,
      contextTokens: 125,
      tokensPerSecond: 25,
    });
  });

  it("carries usage and timing meta on the message_end fold", () => {
    const entries = deriveTranscript({
      messages: [],
      events: [
        { type: "message_start", message: partialA },
        {
          type: "message_end",
          message: {
            ...finalA,
            timestamp: 1_700_000_000_000,
            durationMs: 1500,
            usage: { input: 40, output: 10, cacheRead: 2, cacheWrite: 3, totalTokens: 55 },
          },
        },
      ],
    });
    const asst = entries.find((e) => e.role === "assistant");
    expect(asst!.meta).toEqual({
      durationMs: 1500,
      outputTokens: 10,
      contextTokens: 45,
      tokensPerSecond: 6.7,
    });
  });

  it("omits durationMs and tokensPerSecond when durationMs is absent", () => {
    const entries = deriveTranscript({
      messages: [
        userMsg,
        {
          ...finalA,
          timestamp: 1_700_000_000_000,
          usage: { input: 7, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 10 },
        },
      ],
      events: [],
    });
    const asst = entries.find((e) => e.role === "assistant");
    expect(asst!.meta).toEqual({ outputTokens: 3, contextTokens: 7 });
    expect(asst!.meta!.durationMs).toBeUndefined();
    expect(asst!.meta!.tokensPerSecond).toBeUndefined();
  });

  it("gives a user message no meta", () => {
    const entries = deriveTranscript({ messages: [userMsg], events: [] });
    expect(entries[0].role).toBe("user");
    expect(entries[0].meta).toBeUndefined();
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

describe("tool result projection", () => {
  const toolResult = {
    role: "toolResult",
    id: "tr1",
    toolCallId: "tc1",
    toolName: "ls",
    content: [{ type: "text", text: "file-a\nfile-b" }],
    details: {},
    isError: false,
    durationMs: 12,
    timestamp: 1_700_000_000_000,
  };
  const calledAssistant = {
    ...finalA,
    content: [{ type: "toolCall", id: "tc1", name: "ls", args: { path: "/tmp" } }],
  };
  const callEvents = [
    { type: "tool_execution_start", toolCallId: "tc1", toolName: "ls", args: { path: "/tmp" } },
    {
      type: "tool_execution_end",
      toolCallId: "tc1",
      result: { content: [{ type: "text", text: "file-a\nfile-b" }], isError: false },
    },
  ];

  // pi persists every tool result as its own `role: "toolResult"` message, and
  // the assistant's tool card already renders that output: projecting the
  // message too would show the same text twice.
  it("renders a toolResult only once, inside the assistant's tool card", () => {
    const entries = deriveTranscript({
      messages: [userMsg, calledAssistant, toolResult],
      events: callEvents,
    });
    const withTool = entries.filter((e) => e.toolCalls.length > 0);
    expect(withTool).toHaveLength(1);
    expect(withTool[0].role).toBe("assistant");
    expect(withTool[0].toolCalls.map((tc) => tc.id)).toEqual(["tc1"]);
    // the output is still there, just not also as a bubble
    expect(withTool[0].toolCalls[0].output).toContain("file-a\nfile-b");
    expect(entries.some((e) => e.role === "toolResult")).toBe(false);
    expect(entries.filter((e) => e.text.includes("file-a"))).toHaveLength(0);
    // projection only: the surviving entry keeps its untouched raw message
    expect(withTool[0].raw).toBe(calledAssistant);
  });

  // Accepted trade-off: an orphan result has no tool card to carry its text,
  // so it stays out of the transcript rather than rendering as a bubble.
  it("drops a toolResult that has no matching assistant tool call", () => {
    const entries = deriveTranscript({
      messages: [userMsg, { ...toolResult, toolCallId: "orphan" }],
      events: [],
    });
    expect(entries.some((e) => e.role === "toolResult")).toBe(false);
    expect(entries.some((e) => e.text.includes("file-a"))).toBe(false);
    expect(entries.filter((e) => e.role === "user")).toHaveLength(1);
  });

  it("drops a live toolResult message_start the same way", () => {
    const entries = deriveTranscript({
      messages: [userMsg],
      events: [{ type: "message_start", message: toolResult }],
    });
    expect(entries.some((e) => e.role === "toolResult")).toBe(false);
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
    expect(system[0].text).toBe("role → architect");
    expect(system[0].text.split("\n")).toHaveLength(1);
    expect(system[0].id).toBe("role-e1");
  });

  it("renders a role-switch present in the messages snapshot", () => {
    const entries = deriveTranscript({
      messages: [userMsg, roleSwitch("architect")],
      events: [],
    });
    expect(entries.some((e) => e.text === "role → architect")).toBe(true);
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

  // The seam between the two rules: the snapshot's startup entry is stale state
  // (drop it), while a switch that arrives later as a live event is something
  // that happened (show it). Position, not `customType`, decides.
  it("drops the snapshot's startup entry but keeps a later live role-switch", () => {
    const startup = { ...roleSwitch("work"), id: "startup" };
    const entries = deriveTranscript({
      messages: [startup, userMsg],
      events: [{ type: "entry_appended", entry: { ...roleSwitch("architect"), id: "live-1" } }],
    });
    const system = entries.filter((e) => e.kind === "system");
    expect(system.map((e) => e.text)).toEqual(["role → architect"]);
    expect(system[0].id).toBe("role-live-1");
    expect(entries.some((e) => e.id === "role-startup")).toBe(false);
    // the user message that separates the two is still there
    expect(entries.filter((e) => e.role === "user")).toHaveLength(1);
  });

  // Same rule with no snapshot user row at all: the optimistic prompt is the
  // user row, so a switch made right after sending it is still announced.
  it("renders a live switch that follows only an optimistic user message", () => {
    const entries = deriveTranscript({
      messages: [{ ...roleSwitch("work"), id: "startup" }],
      events: [{ type: "entry_appended", entry: { ...roleSwitch("architect"), id: "live-2" } }],
      sentMessages: ["switch me"],
    });
    const system = entries.filter((e) => e.kind === "system");
    expect(system.map((e) => e.text)).toEqual(["role → architect"]);
    expect(entries.some((e) => e.role === "user" && e.text === "switch me")).toBe(true);
  });

  it("renders a null role as none", () => {
    const entries = deriveTranscript({
      messages: [userMsg],
      events: [{ type: "entry_appended", entry: roleSwitch(null) }],
    });
    const system = entries.find((e) => e.kind === "system");
    expect(system!.text).toBe("role → none");
  });

  it("renders nothing for an unknown customType", () => {
    const entries = deriveTranscript({
      messages: [userMsg],
      events: [{ type: "entry_appended", entry: { type: "custom", customType: "nope", data: {} } }],
    });
    expect(entries.some((e) => e.kind === "system")).toBe(false);
    expect(entries).toHaveLength(1);
  });

  // A failed turn is an assistant message with NO content and `stopReason:
  // "error"`; pi reports the reason out of band in `errorMessage`. Dropping it
  // as an "empty filler" made an exhausted retry render as a prompt followed by
  // nothing at all, which reads exactly like the UI having hung.
  describe("a failed turn", () => {
    const failed = {
      role: "assistant",
      id: "a-fail",
      stopReason: "error",
      errorMessage: "Request timed out.",
      content: [],
    };

    it("survives coalescing and carries pi's reason", () => {
      const entries = deriveTranscript({ messages: [userMsg, failed], events: [] });
      const assistant = entries.find((e) => e.role === "assistant");
      expect(assistant).toBeDefined();
      expect(assistant!.text).toBe("");
      expect(assistant!.error).toBe("Request timed out.");
    });

    it("is carried from a live message_end, not just the snapshot", () => {
      const entries = deriveTranscript({
        messages: [userMsg],
        events: [
          { type: "message_start", message: { ...failed, content: [] } },
          { type: "message_end", message: failed },
        ],
      });
      expect(entries.find((e) => e.role === "assistant")!.error).toBe("Request timed out.");
    });

    it("appears even when the failed turn streamed nothing before failing", () => {
      // no message_start at all: the failure arrives as a lone message_end
      const entries = deriveTranscript({
        messages: [userMsg],
        events: [{ type: "message_end", message: failed }],
      });
      expect(entries.find((e) => e.role === "assistant")!.error).toBe("Request timed out.");
    });

    it("collapses the superseded attempts of one failing turn", () => {
      const attempt = (id: string) => [
        { type: "message_start", message: { role: "assistant", id, content: [] } },
        {
          type: "message_end",
          message: {
            role: "assistant",
            id,
            stopReason: "error",
            errorMessage: "boom",
            content: [],
          },
        },
      ];
      const entries = deriveTranscript({
        messages: [userMsg],
        events: [...attempt("a1"), ...attempt("a2"), ...attempt("a3")],
      });
      const failures = entries.filter((e) => e.role === "assistant");
      expect(failures).toHaveLength(1);
      expect(failures[0].error).toBe("boom");
    });

    it("still says something when pi reports no reason at all", () => {
      const entries = deriveTranscript({
        messages: [userMsg, { role: "assistant", id: "a2", stopReason: "error", content: [] }],
        events: [],
      });
      expect(entries.find((e) => e.role === "assistant")!.error).toBe("the model request failed");
    });

    it("leaves a successful turn without an error", () => {
      const entries = deriveTranscript({ messages: [userMsg, finalA], events: [] });
      expect(entries.find((e) => e.role === "assistant")!.error).toBeUndefined();
    });
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
