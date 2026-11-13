<script lang="ts">
  import { ui } from "$lib/state.svelte";
  import Picker from "./Picker.svelte";
  import { Button } from "$lib/components/ui/button/index.js";
  import BrainIcon from "@lucide/svelte/icons/brain";
  import CheckIcon from "@lucide/svelte/icons/check";
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

<Picker bind:open title="Thinking level" description="how hard the model reasons">
  {#snippet trigger(props)}
    <Button
      {...props}
      variant="outline"
      size="sm"
      class="text-xs font-normal shrink-0 max-lg:min-h-9"
      aria-label="Thinking level: {cur || 'default'}"
    >
      <BrainIcon class="size-3.5" />
      <!-- the brain already says "thinking"; below sm the word only costs width -->
      <span class="hidden sm:inline">{cur || "thinking"}</span>
    </Button>
  {/snippet}

  <div class="flex flex-col gap-1">
    {#each levels as level (level)}
      <button
        type="button"
        class="flex min-h-10 w-full items-center gap-2 text-left text-xs px-3 py-2 rounded-md hover:bg-accent hover:text-accent-foreground {cur ===
        level
          ? 'text-primary'
          : ''}"
        onclick={() => pick(level)}
      >
        <span class="flex-1 capitalize">{level}</span>
        {#if cur === level}
          <CheckIcon class="size-4 shrink-0" />
        {/if}
      </button>
    {/each}
  </div>
</Picker>
