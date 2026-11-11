<script lang="ts">
  import type { TranscriptEntry } from "@uipi/client";
  import { ui } from "$lib/state.svelte";
  import { fmtCtx } from "$lib/format";
  import ToolCall from "./ToolCall.svelte";
  import { Card, CardContent } from "$lib/components/ui/card/index.js";
  import { Badge } from "$lib/components/ui/badge/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import * as Collapsible from "$lib/components/ui/collapsible/index.js";
  import { Separator } from "$lib/components/ui/separator/index.js";
  import ChevronRightIcon from "@lucide/svelte/icons/chevron-right";

  let { entry }: { entry: TranscriptEntry } = $props();
  let thinkOpen = $state(false);
  let bodyOpen = $state(false);

  const isUser = $derived(entry.role === "user");
  const isAssistant = $derived(entry.role === "assistant");
  // Sanitized in $lib/markdown.ts; null means "render the text as-is".
  const html = $derived(ui.entryHtml(entry));

  // Length test for collapsing a long reply, measured on the text the reader
  // sees: the markdown HTML has no tags or newlines worth counting, so fall
  // back to it stripped of markup only when there is no source text.
  const plainText = $derived(entry.text || (html ?? "").replace(/<[^>]*>/g, ""));
  const isLong = $derived(plainText.length > 800 || plainText.split("\n").length > 12);

  // Once this entry has been streaming, keep it expanded for good: a reply that
  // snaps shut the moment the stream ends would move the text out from under a
  // reader who is still scrolling through it.
  let wasStreaming = $state(false);
  $effect(() => {
    if (entry.thinkingActive) {
      wasStreaming = true;
      bodyOpen = true;
    }
  });

  // Formatted usage/timing, in display order; empty when nothing is known.
  const metaParts = $derived.by(() => {
    const m = entry.meta;
    if (!m) return [];
    const parts: string[] = [];
    if (m.durationMs !== undefined) {
      parts.push(
        m.durationMs < 1000
          ? `${Math.round(m.durationMs)}ms`
          : `${(m.durationMs / 1000).toFixed(1)}s`,
      );
    }
    if (m.tokensPerSecond !== undefined) parts.push(`${m.tokensPerSecond.toFixed(1)} t/s`);
    if (m.contextTokens !== undefined) parts.push(fmtCtx(m.contextTokens));
    return parts;
  });
  // Nothing while the reply is still being written: the numbers aren't final yet.
  const showMeta = $derived(metaParts.length > 0 && !entry.thinkingActive);
</script>

<div class="my-2">
  {#if isUser}
    <div class="flex justify-end">
      <Card class="max-w-[88%] bg-muted border-muted py-1 gap-1">
        <CardContent class="px-3 text-sm whitespace-pre-wrap break-words">{entry.text}</CardContent>
      </Card>
    </div>
  {:else if isAssistant || entry.toolCalls.length > 0}
    <div class="max-w-full md:max-w-[90%]">
      {#if entry.thinking}
        <Collapsible.Root bind:open={thinkOpen} class="mb-1">
          <Collapsible.Trigger
            class="w-full flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground min-h-8"
          >
            <ChevronRightIcon
              class="size-3 shrink-0 transition-transform {thinkOpen ? 'rotate-90' : ''}"
            />
            <Badge variant="outline" class="font-normal">
              {entry.thinkingActive ? "thinking…" : "thought for a bit"}
            </Badge>
            <span class="truncate flex-1 text-left opacity-60">
              {entry.thinking.slice(0, 60)}
            </span>
          </Collapsible.Trigger>
          <Collapsible.Content>
            <pre
              class="text-xs text-muted-foreground bg-muted/30 border border-border rounded-md px-2 py-1.5 mt-1 whitespace-pre-wrap break-words max-h-64 overflow-auto">{entry.thinking}</pre>
          </Collapsible.Content>
        </Collapsible.Root>
      {:else if entry.thinkingActive}
        <div class="text-xs text-muted-foreground animate-pulse my-1">thinking…</div>
      {/if}
      {#snippet body()}
        {#if html !== null}
          <!-- eslint-disable-next-line svelte/no-at-html-tags -- sanitized in $lib/markdown.ts -->
          <div class="md text-sm break-words">{@html html}</div>
        {:else if entry.text}
          <div class="text-sm whitespace-pre-wrap break-words">{entry.text}</div>
        {/if}
      {/snippet}
      {#if isLong && !wasStreaming}
        <Collapsible.Root bind:open={bodyOpen}>
          <Collapsible.Trigger>
            {#snippet child({ props })}
              <Button {...props} variant="ghost" size="xs" class="text-xs text-muted-foreground">
                {bodyOpen ? "show less" : "show full message"}
              </Button>
            {/snippet}
          </Collapsible.Trigger>
          <Collapsible.Content>
            {@render body()}
          </Collapsible.Content>
        </Collapsible.Root>
      {:else}
        {@render body()}
      {/if}
      {#each entry.toolCalls as tc (tc.id)}
        <ToolCall {tc} />
      {/each}
      {#if showMeta}
        <div
          class="mt-1 flex gap-1.5 items-center text-[11px] text-muted-foreground/70 select-none"
          data-testid="message-meta"
        >
          <span class="sr-only">message statistics:</span>
          {#each metaParts as part, i (part)}
            {#if i > 0}<span aria-hidden="true">·</span>{/if}
            <span>{part}</span>
          {/each}
        </div>
      {/if}
    </div>
  {:else}
    <div class="text-xs text-muted-foreground my-1 flex items-center gap-2">
      <Separator class="w-6" />
      {entry.text || entry.kind}
    </div>
  {/if}
</div>
