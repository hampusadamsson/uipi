<script lang="ts">
  import { ui } from "$lib/state.svelte";
  import Picker from "./Picker.svelte";
  import { Button } from "$lib/components/ui/button/index.js";
  import BrainIcon from "@lucide/svelte/icons/brain";
  import CheckIcon from "@lucide/svelte/icons/check";
  import { sameModelRef } from "$lib/models";

  let { sessionId }: { sessionId: string } = $props();
  let open = $state(false);

  const cur = $derived(ui.thinkingLevelOf(sessionId) ?? "");

  //
  // pi's complete ThinkingLevel set, in escalating order. `off` and `max` are
  // real levels (off is what a non-reasoning model reports); omitting them left
  // two states unreachable from the UI, so a session that was off could never be
  // turned off again once raised.
  const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

  /**
   * The current model's own reasoning state, so the picker can say why a level
   * may not take: pi clamps the requested level to what the model supports, and
   * a non-reasoning model always reports `off`.
   */
  const modelReasons = $derived(
    ui.models.find((m) => sameModelRef(ui.modelOf(sessionId), m))?.reasoning ?? null,
  );

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
    {#if modelReasons === false}
      <p class="text-[10px] text-muted-foreground px-3 pt-1">
        this model does not report reasoning, so pi keeps the level at “off”
      </p>
    {/if}
  </div>
</Picker>
