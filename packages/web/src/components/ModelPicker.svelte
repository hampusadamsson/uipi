<script lang="ts">
  import { ui } from "$lib/state.svelte";
  import * as Popover from "$lib/components/ui/popover/index.js";
  import * as Command from "$lib/components/ui/command/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
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

<Popover.Root bind:open>
  <Popover.Trigger>
    {#snippet child({ props })}
      <Button {...props} variant="outline" size="sm" class="text-xs font-normal gap-1">
        {cur?.modelId ?? "model"}
      </Button>
    {/snippet}
  </Popover.Trigger>
  <Popover.Content class="w-[min(20rem,calc(100vw-2rem))] p-0" align="end">
    <Command.Root shouldFilter={false}>
      <Command.Input placeholder="filter (e.g. claude, gpt)…" bind:value={filter} />
      <Command.List class="max-h-[min(24rem,50vh)]">
        {#each visible as m (m.provider + m.modelId)}
          <Command.Item
            value="{m.provider}/{m.modelId}"
            class="min-h-10 {cur?.modelId === m.modelId ? 'text-primary' : ''}"
            onSelect={() => pick(m)}
          >
            <span class="flex flex-col items-start gap-0.5">
              <span class="font-medium">{m.displayName}</span>
              <span class="text-muted-foreground">
                {m.provider}{m.reasoning ? " · reasoning" : ""}</span
              >
            </span>
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
  </Popover.Content>
</Popover.Root>
