<script lang="ts">
  import { ui } from "$lib/state.svelte";
  import Picker from "./Picker.svelte";
  import * as Command from "$lib/components/ui/command/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import CheckIcon from "@lucide/svelte/icons/check";
  import type { ModelInfo } from "@uipi/protocol";

  let { sessionId }: { sessionId: string } = $props();
  let open = $state(false);
  let filter = $state("");

  const cur = $derived(ui.modelOf(sessionId));
  const all = $derived(ui.models.length <= 50);
  // Filtering and truncation stay ours (the badge count and the "filter to
  // narrow" hint depend on it), so the Command list is rendered unfiltered and
  // only supplies selection + keyboard navigation.
  const visible = $derived.by(() => {
    const q = filter.trim().toLowerCase();
    const list = q
      ? ui.models.filter((m) =>
          `${m.provider}/${m.modelId} ${m.displayName}`.toLowerCase().includes(q),
        )
      : ui.models;
    return list.slice(0, all ? 100 : 300);
  });

  function pick(m: ModelInfo) {
    ui.cmd({ type: "pi.setModel", sessionId, provider: m.provider, modelId: m.modelId });
    open = false;
  }
</script>

<Picker bind:open title="Model" description="provider and model for this session">
  {#snippet trigger(props)}
    <Button
      {...props}
      variant="outline"
      size="sm"
      class="text-xs font-normal gap-1 max-w-40 max-lg:min-h-9 sm:max-w-none"
    >
      <span class="truncate">{cur?.modelId ?? "model"}</span>
    </Button>
  {/snippet}

  <Command.Root shouldFilter={false}>
    <Command.Input placeholder="filter (e.g. claude, gpt)…" bind:value={filter} />
    <!-- Its own scroller at every size, with a hard ceiling: inside a sheet
         the parent is content-sized, so "fill the space" would mean "however
         tall the list is" — i.e. no ceiling at all. -->
    <Command.List class="max-h-[min(24rem,50vh)] max-lg:max-h-[55dvh]">
      {#each visible as m (m.provider + m.modelId)}
        <Command.Item
          value="{m.provider}/{m.modelId}"
          class="min-h-10 {cur?.modelId === m.modelId ? 'text-primary' : ''}"
          onSelect={() => pick(m)}
        >
          <span class="flex min-w-0 flex-1 flex-col items-start gap-0.5">
            <span class="truncate font-medium">{m.displayName}</span>
            <span class="truncate text-muted-foreground">
              {m.provider}{m.reasoning ? " · reasoning" : ""}</span
            >
          </span>
          {#if cur?.modelId === m.modelId}
            <CheckIcon class="size-4 shrink-0" />
          {/if}
        </Command.Item>
      {/each}
      <Command.Empty>no models match</Command.Empty>
      {#if ui.models.length > visible.length}
        <div class="text-[10px] text-muted-foreground px-3 py-1">
          {ui.models.length} total — filter to narrow
        </div>
      {/if}
    </Command.List>
  </Command.Root>
</Picker>
