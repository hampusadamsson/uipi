<script lang="ts">
  import type { ToolCallView } from "@uipi/client";
  import { Button } from "$lib/components/ui/button/index.js";
  import * as Collapsible from "$lib/components/ui/collapsible/index.js";

  let { tc }: { tc: ToolCallView } = $props();
  let outOpen = $state(false);

  // Only a long output is worth hiding; the header always stays visible so a
  // reader can see which tool ran without opening anything. `tc.done` plays no
  // part in this: a running call with short output shows it too.
  const lineCount = $derived(tc.output.split("\n").length);
  const collapsible = $derived(lineCount >= 5);
</script>

<div class="mt-1">
  <div
    class="flex gap-2 items-center min-h-7 rounded-md border border-border px-2 py-1 text-[11px]"
  >
    <span class="shrink-0 font-mono {tc.isError ? 'text-destructive' : 'text-emerald-500'}"
      >{tc.name}</span
    >
    <span class="text-muted-foreground/60 truncate flex-1 text-left">{tc.argsPreview}</span>
    {#if !tc.done}<span class="text-muted-foreground animate-pulse shrink-0">…</span>{/if}
  </div>
  {#if collapsible}
    <Collapsible.Root bind:open={outOpen}>
      <Collapsible.Trigger>
        {#snippet child({ props })}
          <Button {...props} variant="ghost" size="xs" class="text-xs text-muted-foreground">
            {outOpen ? "hide output" : "show output"}
          </Button>
        {/snippet}
      </Collapsible.Trigger>
      <Collapsible.Content>
        <pre
          class="text-xs bg-muted/50 border-t border-border rounded-b-md px-2 py-1 max-h-64 overflow-auto whitespace-pre-wrap break-words">{tc.output ||
            "…"}</pre>
      </Collapsible.Content>
    </Collapsible.Root>
  {:else}
    <pre
      class="text-xs bg-muted/50 border-t border-border rounded-b-md px-2 py-1 max-h-64 overflow-auto whitespace-pre-wrap break-words">{tc.output ||
        "…"}</pre>
  {/if}
</div>
