<script lang="ts">
  import { ui } from "$lib/state.svelte";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Textarea } from "$lib/components/ui/textarea/index.js";
  import { Badge } from "$lib/components/ui/badge/index.js";
  import XIcon from "@lucide/svelte/icons/x";

  let { sessionId }: { sessionId: string } = $props();

  let text = $state("");
  let ta = $state<{ ref?: HTMLTextAreaElement | null; $$bindings?: string } | undefined>(undefined);
  const taEl = $derived(ta?.ref as HTMLTextAreaElement | undefined);

  function autosize() {
    if (!taEl) return;
    taEl.style.height = "auto";
    taEl.style.height = Math.min(taEl.scrollHeight, 160) + "px";
  }
  let acIndex = $state(-1);
  let acItems = $state<string[]>([]);
  let acPanel = $state<HTMLElement | undefined>(undefined);

  // keep the keyboard cursor visible inside the (height-capped) panel
  $effect(() => {
    const idx = acIndex;
    const count = acItems.length;
    if (idx < 0 || count === 0) return;
    const active = acPanel?.querySelector<HTMLElement>('[data-active="true"]');
    active?.scrollIntoView?.({ block: "nearest" });
  });

  const attach = $derived(
    ui.attached.get(sessionId) as
      | { isStreaming?: boolean; cwd?: string; steering?: unknown[]; followUp?: unknown[] }
      | undefined,
  );
  const runState = $derived(ui.stateOf(sessionId));
  const steering = $derived(attach?.steering ?? []);
  const followUp = $derived(attach?.followUp ?? []);

  const slashItems = $derived(ui.slashItems(sessionId));

  function textOf(q: unknown): string {
    const s =
      typeof q === "string"
        ? q
        : ((q as { text?: string; message?: string })?.text ??
          (q as { message?: string })?.message ??
          "");
    return String(s).slice(0, 60);
  }

  function onKeydown(e: KeyboardEvent) {
    if (
      e.key === "Enter" &&
      !e.shiftKey &&
      !("ontouchstart" in window || navigator.maxTouchPoints > 0)
    ) {
      // desktop: Enter sends
      e.preventDefault();
      send();
      return;
    }
    if (e.key === "Escape") {
      acIndex = -1;
      acItems = [];
    }
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
    autosize();
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
    // slash commands are local actions, never prompt text
    if (v === "/new") {
      const cwd = attach?.cwd;
      text = "";
      if (taEl) taEl.style.height = "auto";
      if (cwd) void ui.newSession(cwd);
      refocus();
      return;
    }
    // optimistic run state; pi events will settle to idle when done
    if (v === "/compact") {
      ui.beginLocalCompaction(sessionId);
      ui.cmd({ type: "pi.compact", sessionId });
    } else {
      // always queue: sendPrompt is queued server-side when a run is in flight,
      // so submitting mid-run never fails and never interrupts the current turn
      ui.sendPrompt(sessionId, v);
    }
    text = "";
    if (taEl) taEl.style.height = "auto";
    refocus();
  }

  function refocus() {
    requestAnimationFrame(() => taEl?.focus());
  }
</script>

<div class="border-t border-border px-3 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
  {#if steering.length + followUp.length > 0}
    <div class="flex flex-wrap gap-1 mb-1">
      {#each steering as s, i (i)}
        <Badge variant="outline" class="text-amber-500 gap-1 max-w-full">
          <span class="truncate">steer: {textOf(s)}</span>
          <button
            class="text-muted-foreground hover:text-foreground shrink-0 px-1"
            aria-label="Cancel steering message"
            onclick={() => ui.cmd({ type: "pi.cancelQueued", sessionId, kind: "steer", index: i })}
          >
            <XIcon class="size-3" />
          </button>
        </Badge>
      {/each}
      {#each followUp as f, i (i)}
        <Badge variant="outline" class="text-sky-500 gap-1 max-w-full">
          <span class="truncate">followUp: {textOf(f)}</span>
          <button
            class="text-muted-foreground hover:text-foreground shrink-0 px-1"
            aria-label="Cancel follow-up message"
            onclick={() =>
              ui.cmd({ type: "pi.cancelQueued", sessionId, kind: "followUp", index: i })}
          >
            <XIcon class="size-3" />
          </button>
        </Badge>
      {/each}
    </div>
  {/if}
  {#if acItems.length > 0}
    <div
      bind:this={acPanel}
      class="rounded-md border border-border bg-popover text-popover-foreground shadow-md z-30 mb-1 max-h-56 overflow-y-auto overscroll-contain"
    >
      {#each acItems as s, i (s)}
        <button
          data-active={i === acIndex ? "true" : "false"}
          class="w-full text-left text-xs px-3 py-2 cursor-pointer min-h-9 {i === acIndex
            ? 'bg-accent'
            : ''}"
          onmouseenter={() => (acIndex = i)}
          onclick={acceptAc}
        >
          {s}
        </button>
      {/each}
    </div>
  {/if}
  <div class="flex gap-2 items-end">
    <Textarea
      bind:this={ta}
      bind:value={text}
      onkeydown={onKeydown}
      oninput={onInput}
      rows={2}
      enterkeyhint="send"
      autocomplete="off"
      placeholder={runState === "idle"
        ? "Message ('/' for commands, @file to reference)"
        : "…agent is working — send to steer"}
      class="min-h-11 max-h-40 resize-none text-base md:text-sm"
    ></Textarea>
    <div class="flex flex-col gap-1 shrink-0">
      {#if runState === "idle"}
        <Button class="min-h-11 px-5" onclick={send}>Send</Button>
      {:else}
        <Button variant="destructive" class="min-h-11 px-5" onclick={() => ui.abort(sessionId)}
          >Stop</Button
        >
      {/if}
    </div>
  </div>
</div>
