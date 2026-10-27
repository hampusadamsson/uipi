<script lang="ts">
  import { ui } from "$lib/state.svelte";
  import * as Popover from "$lib/components/ui/popover/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Badge } from "$lib/components/ui/badge/index.js";
  import BrainIcon from "@lucide/svelte/icons/brain";
  import type { Attachment } from "@uipi/protocol";

  let { sessionId }: { sessionId: string } = $props();
  let open = $state(false);

  const attach = $derived(
    ui.attached.get(sessionId) as (Attachment & { thinkingLevel?: string }) | undefined,
  );
  const cur = $derived(attach?.thinkingLevel ?? "");

  // pi thinking levels, standard order
  const levels = ["minimal", "low", "medium", "high", "xhigh"];

  function pick(level: string) {
    ui.cmd({ type: "pi.setThinkingLevel", sessionId, level });
    open = false;
  }
</script>

<Popover.Root bind:open>
  <Popover.Trigger>
    {#snippet child({ props })}
      <Button {...props} variant="outline" size="sm" class="text-xs font-normal">
        <BrainIcon class="size-3.5" />
        {cur || "thinking"}
      </Button>
    {/snippet}
  </Popover.Trigger>
  <Popover.Content class="w-40 p-1" align="end">
    {#each levels as level (level)}
      <button
        class="w-full text-left text-xs px-3 py-2 rounded-md hover:bg-accent hover:text-accent-foreground {cur ===
        level
          ? 'text-primary'
          : ''}"
        onclick={() => pick(level)}
      >
        {level}{#if cur === level}<Badge variant="outline" class="ml-2">current</Badge>{/if}
      </button>
    {/each}
  </Popover.Content>
</Popover.Root>
