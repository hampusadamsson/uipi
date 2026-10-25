<script lang="ts">
  import { ui } from "$lib/state.svelte";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Textarea } from "$lib/components/ui/textarea/index.js";
  import { Badge } from "$lib/components/ui/badge/index.js";

  let { sessionId }: { sessionId: string } = $props();

  let text = $state("");
  let ta: HTMLTextAreaElement | undefined = $state(undefined);
  let acIndex = $state(-1);
  let acItems = $state<string[]>([]);

  const attach = $derived(
    ui.attached.get(sessionId) as
      | { isStreaming?: boolean; steering?: unknown[]; followUp?: unknown[] }
      | undefined
  );
  const runState = $derived(ui.stateOf(sessionId));
  const steering = $derived(attach?.steering ?? []);
  const followUp = $derived(attach?.followUp ?? []);

  const slashItems = $derived(["/compact", "/new"]);

  function textOf(q: unknown): string {
    const s =
      typeof q === "string"
        ? q
        : (q as { text?: string; message?: string })?.text ??
          (q as { message?: string })?.message ??
          "";
    return String(s).slice(0, 60);
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey && !("ontouchstart" in window || navigator.maxTouchPoints > 0)) {
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

  function autosize() {
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 160) + "px";
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
    // optimistic run state; pi events will settle to idle when done
    if (v === "/compact") {
      ui.runState.set(sessionId, "thinking");
      ui.cmd({ type: "pi.compact", sessionId });
    } else if (attach && attach.isStreaming) {
      // steering a live run — no state change, queue it
      ui.cmd({ type: "pi.steer", sessionId, text: v });
    } else {
      ui.sendPrompt(sessionId, v);
    }
    text = "";
    if (ta) ta.style.height = "auto";
    refocus();
  }

  function refocus() {
    requestAnimationFrame(() => ta?.focus());
  }
</script>

<div class="border-t border-border px-3 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
  {#if steering.length + followUp.length > 0}
    <div class="flex flex-wrap gap-1 mb-1">
      {#each steering as s, i}
        <Badge variant="outline" class="text-amber-500 gap-1 max-w-full">
          <span class="truncate">steer: {textOf(s)}</span>
          <button
            class="text-muted-foreground hover:text-foreground shrink-0 px-1"
            aria-label="Cancel steering message"
            onclick={() => ui.cmd({ type: "pi.cancelQueued", sessionId, kind: "steer", index: i })}>×</button
          >
        </Badge>
      {/each}
      {#each followUp as f, i}
        <Badge variant="outline" class="text-sky-500 gap-1 max-w-full">
          <span class="truncate">followUp: {textOf(f)}</span>
          <button
            class="text-muted-foreground hover:text-foreground shrink-0 px-1"
            aria-label="Cancel follow-up message"
            onclick={() => ui.cmd({ type: "pi.cancelQueued", sessionId, kind: "followUp", index: i })}>×</button
          >
        </Badge>
      {/each}
    </div>
  {/if}
  {#if acItems.length > 0}
    <div class="rounded-md border border-border bg-popover text-popover-foreground shadow-md z-30 mb-1">
      {#each acItems as s, i}
        <div
          class="text-xs px-3 py-2 cursor-pointer min-h-9 {i === acIndex ? 'bg-accent' : ''}"
          onmouseenter={() => (acIndex = i)}
          onclick={acceptAc}
        >{s}</div>
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
      placeholder={runState === "idle" ? "Message ('/' for commands, @file to reference)" : "…agent is working — send to steer"}
      class="min-h-11 max-h-40 resize-none text-base md:text-sm"
    ></Textarea>
    <div class="flex flex-col gap-1 shrink-0">
      {#if runState === "idle"}
        <Button class="min-h-11 px-5" onclick={send}>Send</Button>
      {:else}
        <Button
          variant="destructive"
          class="min-h-11 px-5"
          onclick={() => ui.cmd({ type: "pi.abort", sessionId })}>Stop</Button
        >
      {/if}
    </div>
  </div>
</div>
