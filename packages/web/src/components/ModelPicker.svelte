<script lang="ts">
  import { ui } from "../lib/state.svelte";
  import type { ModelInfo } from "@uipi/protocol";

  let { sessionId }: { sessionId: string } = $props();
  let open = $state(false);

  const attach = $derived(ui.attached.get(sessionId) as { model?: { provider: string; modelId: string } } | undefined);
  const cur = $derived(attach?.model);

  function pick(m: ModelInfo) {
    ui.cmd({ type: "pi.setModel", sessionId, provider: m.provider, modelId: m.modelId });
    open = false;
  }
</script>

<div class="relative">
  <button class="text-xs text-zinc-400 hover:text-zinc-200 border border-zinc-700 rounded px-2 py-0.5" onclick={() => (open = !open)}>
    ⚙ model
  </button>
  {#if open}
    <div class="absolute right-0 mt-1 max-h-96 overflow-y-auto w-80 bg-zinc-900 border border-zinc-700 rounded shadow-lg z-40">
      {#each ui.models as m (m.provider + m.modelId)}
        <button
          class="w-full text-left text-xs px-3 py-1.5 hover:bg-zinc-800 {cur?.modelId === m.modelId ? 'text-indigo-400' : ''}"
          onclick={() => pick(m)}
        >
          <span class="font-medium">{m.displayName}</span>
          <span class="text-zinc-500"> {m.provider} · {m.reasoning ? "reasoning" : ""}</span>
        </button>
      {:else}
        <div class="text-xs text-zinc-600 px-3 py-2">no models listed</div>
      {/each}
    </div>
  {/if}
</div>
