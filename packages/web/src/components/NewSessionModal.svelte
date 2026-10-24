<script lang="ts">
  import { ui } from "../lib/state";

  let cwd = $state("");
  let agentDir = $state("");
  let busy = $state(false);

  async function create() {
    if (!cwd.trim()) return;
    busy = true;
    try {
      await ui.newSession(cwd.trim(), agentDir.trim() || undefined);
      ui.wantNew = false;
    } catch {
      /* error shown globally */
    } finally {
      busy = false;
    }
  }
</script>

<div class="fixed inset-0 bg-black/60 grid place-items-center z-50">
  <div class="bg-zinc-900 border border-zinc-700 rounded-lg p-6 w-[32rem]">
    <h2 class="font-semibold mb-3">New session</h2>
    <label class="block text-xs text-zinc-400 mb-1" for="cwd">Project directory (cwd)</label>
    <input
      id="cwd"
      class="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1 mb-1 text-sm"
      bind:value={cwd}
      placeholder="/path/to/project"
    />
    {#if ui.recentDirs.length > 0}
      <div class="flex flex-wrap gap-1 mb-3">
        {#each ui.recentDirs.slice(0, 6) as d}
          <button
            class="text-xs text-zinc-400 border border-zinc-700 rounded px-2 py-0.5 hover:bg-zinc-800"
            onclick={() => (cwd = d)}
          >{d}</button>
        {/each}
      </div>
    {:else}
      <div class="mb-3"></div>
    {/if}
    <label class="block text-xs text-zinc-400 mb-1" for="agentdir">Config dir (default: ~/.pi/agent)</label>
    <input
      id="agentdir"
      class="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1 mb-4 text-sm"
      bind:value={agentDir}
      placeholder="~/.pi/agent"
    />
    <div class="flex justify-end gap-2">
      <button class="text-sm px-3 py-1 rounded border border-zinc-700" onclick={() => (ui.wantNew = false)}>Cancel</button>
      <button
        class="text-sm px-3 py-1 rounded bg-indigo-600 hover:bg-indigo-500 text-white disabled:opacity-50"
        disabled={busy}
        onclick={create}
      >{busy ? "creating…" : "Create"}</button>
    </div>
  </div>
</div>
