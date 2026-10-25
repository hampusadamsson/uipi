<script lang="ts">
  import { ui } from "$lib/state.svelte";
  import * as Popover from "$lib/components/ui/popover/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import type { ModelInfo } from "@uipi/protocol";

  let { sessionId }: { sessionId: string } = $props();
  let open = $state(false);
  let filter = $state("");

  const attach = $derived(
    ui.attached.get(sessionId) as { model?: { provider: string; modelId: string } } | undefined,
  );
  const cur = $derived(ui.pendingModel.get(sessionId) ?? attach?.model ?? undefined);
  const all = $derived(ui.models.length <= 50);
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
    <div class="sticky top-0 bg-popover border-b border-border p-2">
      <Input class="h-8 text-xs" placeholder="filter (e.g. claude, gpt)…" bind:value={filter} />
    </div>
    <div class="max-h-96 overflow-y-auto">
      {#each visible as m (m.provider + m.modelId)}
        <button
          class="w-full text-left text-xs px-3 py-2 min-h-10 hover:bg-accent hover:text-accent-foreground {cur?.modelId ===
          m.modelId
            ? 'text-primary'
            : ''}"
          onclick={() => pick(m)}
        >
          <span class="font-medium">{m.displayName}</span>
          <span class="text-muted-foreground">
            {m.provider} · {m.reasoning ? "reasoning" : ""}</span
          >
        </button>
      {:else}
        <div class="text-xs text-muted-foreground px-3 py-2">no models match</div>
      {/each}
      {#if ui.models.length > visible.length}
        <div class="text-[10px] text-muted-foreground px-3 py-1">
          {ui.models.length} total — filter to narrow
        </div>
      {/if}
    </div>
  </Popover.Content>
</Popover.Root>
