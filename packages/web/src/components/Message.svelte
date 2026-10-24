<script lang="ts">
  import { ui } from "$lib/state.svelte";
  import type { TranscriptEntry } from "$lib/transcript.js";
  import { Card, CardContent } from "$lib/components/ui/card/index.js";
  import { Badge } from "$lib/components/ui/badge/index.js";
  import * as Collapsible from "$lib/components/ui/collapsible/index.js";
  import { Separator } from "$lib/components/ui/separator/index.js";

  let { entry }: { entry: TranscriptEntry } = $props();
  let open = $state(false);

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
      {#if entry.text}
        <div class="text-sm whitespace-pre-wrap break-words">{entry.text}</div>
      {/if}
      {#each entry.toolCalls as tc, i (i)}
        <Collapsible.Root bind:open class="mt-1">
          <Collapsible.Trigger
            class="w-full flex gap-2 items-center min-h-10 rounded-md border border-border px-2 py-1 text-xs hover:bg-accent hover:text-accent-foreground"
          >
            <Badge variant="outline" class="{tc.isError ? 'text-destructive' : 'text-emerald-500'} shrink-0">{tc.name}</Badge>
            <span class="text-muted-foreground truncate flex-1 text-left">{tc.argsPreview}</span>
            {#if !tc.done}<span class="text-muted-foreground animate-pulse shrink-0">…</span>{/if}
          </Collapsible.Trigger>
          <Collapsible.Content>
            <pre class="text-xs bg-muted/50 border-t border-border rounded-b-md px-2 py-1 max-h-64 overflow-auto whitespace-pre-wrap break-words">{tc.output || "…"}</pre>
          </Collapsible.Content>
        </Collapsible.Root>
      {/each}
    </div>
  {:else}
    <div class="text-xs text-muted-foreground my-1 flex items-center gap-2">
      <Separator class="w-6" /> {entry.text || entry.kind}
    </div>
  {/if}
</div>
