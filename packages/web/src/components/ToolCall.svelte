<script lang="ts">
  import type { ToolCallView } from "@uipi/client";
  import { Badge } from "$lib/components/ui/badge/index.js";
  import * as Collapsible from "$lib/components/ui/collapsible/index.js";

  let { tc }: { tc: ToolCallView } = $props();
  let open = $state(false);
</script>

<Collapsible.Root bind:open class="mt-1">
  <Collapsible.Trigger
    class="w-full flex gap-2 items-center min-h-10 rounded-md border border-border px-2 py-1 text-xs hover:bg-accent hover:text-accent-foreground"
  >
    <Badge variant="outline" class="{tc.isError ? 'text-destructive' : 'text-emerald-500'} shrink-0"
      >{tc.name}</Badge
    >
    <span class="text-muted-foreground truncate flex-1 text-left">{tc.argsPreview}</span>
    {#if !tc.done}<span class="text-muted-foreground animate-pulse shrink-0">…</span>{/if}
  </Collapsible.Trigger>
  <Collapsible.Content>
    <pre
      class="text-xs bg-muted/50 border-t border-border rounded-b-md px-2 py-1 max-h-64 overflow-auto whitespace-pre-wrap break-words">{tc.output ||
        "…"}</pre>
  </Collapsible.Content>
</Collapsible.Root>
