<script lang="ts">
  import { ui } from "$lib/state.svelte";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Textarea } from "$lib/components/ui/textarea/index.js";
  import { Badge } from "$lib/components/ui/badge/index.js";

  let { sessionId }: { sessionId: string } = $props();

  let text = $state("");
  let ta: HTMLTextAreaElement | null = $state(null);
  let acIndex = $state(-1);
  let acItems = $state<string[]>([]);

  const attach = $derived(ui.attached.get(sessionId) as { isStreaming?: boolean; steering?: unknown[]; followUp?: unknown[] } | undefined);
  const steering = $derived(attach?.steering ?? []);
  const followUp = $derived(attach?.followUp ?? []);

  const slashItems = $derived(["/compact", "/model", "/thinking", "/new", "/clear", "/quit"]);

  function textOf(q: unknown): string {
    const s = typeof q === "string" ? q : (q as { text?: string; message?: string })?.text ?? (q as { message?: string })?.message ?? "";
    return String(s).slice(0, 60);
  }

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
    refocus();
  }

  function refocus() {
    requestAnimationFrame(() => ta?.focus());
  }
</script>

<div class="border-t border-border px-3 py-2">
  {#if steering.length + followUp.length > 0}
    <div class="flex flex-wrap gap-1 mb-1">
      {#each steering as s, i}
        <Badge variant="outline" class="text-amber-500 gap-1">
          steer: {textOf(s)}
          <button class="text-muted-foreground hover:text-foreground" onclick={() => ui.cmd({ type: "pi.cancelQueued", sessionId, kind: "steer", index: i })}>×</button>
        </Badge>
      {/each}
      {#each followUp as f, i}
        <Badge variant="outline" class="text-sky-500 gap-1">
          followUp: {textOf(f)}
          <button class="text-muted-foreground hover:text-foreground" onclick={() => ui.cmd({ type: "pi.cancelQueued", sessionId, kind: "followUp", index: i })}>×</button>
        </Badge>
      {/each}
    </div>
  {/if}
  {#if acItems.length > 0}
    <div class="absolute bottom-20 left-72 rounded-md border border-border bg-popover text-popover-foreground shadow-md z-30">
      {#each acItems as s, i}
        <div
          class="text-xs px-3 py-1 cursor-pointer {i === acIndex ? 'bg-accent' : ''}"
          onmouseenter={() => (acIndex = i)}
          onclick={acceptAc}
        >{s}</div>
      {/each}
    </div>
  {/if}
  <div class="flex gap-2 items-end">
    <Textarea
      bind:this={ta as never}
      bind:value={text}
      onkeydown={onKeydown}
      oninput={onInput}
      rows={2}
      placeholder="Message ('/' for commands, @file to reference) — Enter send, Shift+Enter newline"
      class="min-h-16 resize-none"
    ></Textarea>
    <div class="flex flex-col gap-1">
      <Button size="sm" onclick={send}>Send</Button>
      {#if attach?.isStreaming}
        <Button size="sm" variant="destructive" onclick={() => ui.cmd({ type: "pi.abort", sessionId })}>Stop</Button>
      {/if}
    </div>
  </div>
</div>
