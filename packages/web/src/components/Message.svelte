<script lang="ts">
  import type { TranscriptEntry } from "@uipi/client";
  import ToolCall from "./ToolCall.svelte";
  import { Card, CardContent } from "$lib/components/ui/card/index.js";
  import { Badge } from "$lib/components/ui/badge/index.js";
  import * as Collapsible from "$lib/components/ui/collapsible/index.js";
  import { Separator } from "$lib/components/ui/separator/index.js";

  let { entry }: { entry: TranscriptEntry } = $props();
  let thinkOpen = $state(false);

  const isUser = $derived(entry.role === "user");
  const isAssistant = $derived(entry.role === "assistant");
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
            <span class="{thinkOpen ? 'rotate-90' : ''} transition-transform">▶</span>
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
      {#if entry.text}
        <div class="text-sm whitespace-pre-wrap break-words">{entry.text}</div>
      {/if}
      {#each entry.toolCalls as tc (tc.id)}
        <ToolCall {tc} />
      {/each}
    </div>
  {:else}
    <div class="text-xs text-muted-foreground my-1 flex items-center gap-2">
      <Separator class="w-6" />
      {entry.text || entry.kind}
    </div>
  {/if}
</div>
