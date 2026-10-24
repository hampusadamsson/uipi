<script lang="ts">
  import { ui } from "../lib/state";

  function textOf(q: unknown): string {
    const s = typeof q === "string" ? q : (q as { text?: string; message?: string })?.text ?? (q as { message?: string })?.message ?? "";
    return String(s).slice(0, 60);
  }
  import type { SessionSummary } from "@uipi/protocol";

  let { sessionId }: { sessionId: string } = $props();

  let text = $state("");
  let ta: HTMLTextAreaElement | null = $state(null);
  let acIndex = $state(-1);
  let acItems = $state<string[]>([]);

  const attach = $derived(ui.attached.get(sessionId));
  const steering = $derived((attach?.steering as unknown[]) ?? []);
  const followUp = $derived((attach?.followUp as unknown[]) ?? []);

  const slashItems = $derived([
    "/compact", "/model", "/thinking", "/new", "/clear", "/quit",
  ]);

  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
      return;
    }
    if (e.key === "Escape") {
      acIndex = -1;
      acItems = [];
    }
    // autocomplete navigation handled in keyup for simplicity
  }

  function onInput() {
    const v = text;
    if (v.startsWith("/") && !v.includes(" ")) {
      acItems = slashItems.filter((s) => s.startsWith(v));
      acIndex = 0;
    } else {
      acItems = [];
      acIndex = -1;
    }
  }

  function acceptAc() {
    if (acIndex >= 0 && acItems[acIndex]) {
      text = acItems[acIndex] + " ";
      acItems = [];
      acIndex = -1;
    }
  }

  function send() {
    const v = text.trim();
    if (!v) return;
    if (v === "/compact") {
      ui.cmd({ type: "pi.compact", sessionId });
    } else {
      ui.cmd({ type: "pi.prompt", sessionId, text: v });
    }
    text = "";
    acItems = [];
    taskFocus();
  }

  function taskFocus() {
    requestAnimationFrame(() => ta?.focus());
  }
</script>

<div class="border-t border-zinc-800 px-3 py-2">
  {#if steering.length + followUp.length > 0}
    <div class="flex flex-wrap gap-1 mb-1">
      {#each steering as s, i}
        <span class="text-xs bg-amber-900/40 border border-amber-800 rounded px-2 py-0.5 flex items-center gap-1">
          steer: {textOf(s)}
          <button class="text-zinc-400 hover:text-white" onclick={() => ui.cmd({ type: "pi.cancelQueued", sessionId, kind: "steer", index: i })}>×</button>
        </span>
      {/each}
      {#each followUp as f, i}
        <span class="text-xs bg-sky-900/40 border border-sky-800 rounded px-2 py-0.5 flex items-center gap-1">
          followUp: {textOf(f)}
          <button class="text-zinc-400 hover:text-white" onclick={() => ui.cmd({ type: "pi.cancelQueued", sessionId, kind: "followUp", index: i })}>×</button>
        </span>
      {/each}
    </div>
  {/if}
  {#if acItems.length > 0}
    <div class="absolute bottom-16 left-72 bg-zinc-900 border border-zinc-700 rounded shadow-lg z-30">
      {#each acItems as s, i}
        <div
          class="text-xs px-3 py-1 cursor-pointer {i === acIndex ? 'bg-zinc-800' : ''}"
          onmouseenter={() => (acIndex = i)}
          onclick={acceptAc}
        >{s}</div>
      {/each}
    </div>
  {/if}
  <div class="flex gap-2 items-end">
    <textarea
      bind:this={ta}
      bind:value={text}
      onkeydown={onKeydown}
      oninput={onInput}
      rows="2"
      placeholder="Message ('/' for commands, @file to reference)  — Enter send, Shift+Enter newline"
      class="flex-1 resize-none bg-zinc-900 border border-zinc-700 rounded px-3 py-2 text-sm focus:outline-none focus:border-indigo-600"
      onfocus={taskFocus}
    ></textarea>
    <div class="flex flex-col gap-1">
      <button
        class="text-sm rounded bg-indigo-600 hover:bg-indigo-500 text-white px-4 py-2"
        onclick={send}
      >Send</button>
      {#if attach?.isStreaming}
        <button
          class="text-xs rounded border border-red-700 text-red-400 hover:bg-red-950 px-2 py-1"
          onclick={() => ui.cmd({ type: "pi.abort", sessionId })}
        >Stop</button>
      {/if}
    </div>
  </div>
</div>
