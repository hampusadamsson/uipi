<script lang="ts">
  import { ui } from "../lib/state";

  let open = $state(false);

  function select(id: string) {
    void ui.attach(id);
  }

  async function openFile(file: string) {
    await ui.openSession(file);
  }
</script>

<aside class="w-72 border-r border-zinc-800 flex flex-col bg-zinc-900/50">
  <div class="px-3 py-2 flex items-center justify-between">
    <span class="font-semibold text-sm text-indigo-400">uipi</span>
    <button
      class="text-xs rounded bg-indigo-600 hover:bg-indigo-500 px-2 py-1 text-white"
      onclick={() => (ui.wantNew = true)}
    >＋ New</button>
  </div>
  {#if !ui.connected}
    <div class="text-xs text-amber-500 px-3 py-1">connecting…</div>
  {/if}
  <div class="flex-1 overflow-y-auto">
    {#each ui.sessions as s (s.sessionFile)}
      <button
        class="w-full text-left px-3 py-2 hover:bg-zinc-800 {ui.activeId === s.sessionId ? 'bg-zinc-800' : ''}"
        onclick={() => {
          if (s.live) select(s.sessionId);
          else if (s.sessionFile) void openFile(s.sessionFile);
        }}
      >
        <div class="text-sm truncate">
          {#if s.live}<span class="inline-block w-2 h-2 rounded-full bg-green-500 mr-1"></span>{/if}
          {s.displayName || s.sessionFile.split("/").pop()}
        </div>
        <div class="text-xs text-zinc-500 truncate">{s.cwd}</div>
      </button>
    {:else}
      <div class="text-xs text-zinc-600 px-3 py-2">no sessions yet</div>
    {/each}
  </div>
</aside>
