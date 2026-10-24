<script lang="ts">
  import { ui } from "$lib/state.svelte";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Separator } from "$lib/components/ui/separator/index.js";

  let { onAfterSelect }: { onAfterSelect?: () => void } = $props();

  function select(id: string) {
    void ui.attach(id);
    onAfterSelect?.();
  }

  async function openFile(file: string) {
    await ui.openSession(file);
    onAfterSelect?.();
  }
</script>

<aside class="w-72 max-w-[85vw] h-full border-r border-border flex flex-col bg-sidebar text-sidebar-foreground">
  <div class="px-3 py-2 flex items-center justify-between">
    <span class="font-semibold text-sm text-primary">uipi</span>
    <Button size="sm" onclick={() => (ui.wantNew = true)}>＋ New</Button>
  </div>
  <Separator />
  {#if !ui.connected}
    <div class="text-xs text-amber-500 px-3 py-1">connecting…</div>
  {/if}
  <div class="flex-1 overflow-y-auto overscroll-contain p-1">
    {#each ui.sessions as s (s.sessionFile)}
      <button
        class="w-full min-h-11 text-left rounded-md px-3 py-2 hover:bg-accent hover:text-accent-foreground {ui.activeId === s.sessionId ? 'bg-accent' : ''}"
        onclick={() => {
          if (s.live) select(s.sessionId);
          else if (s.sessionFile) void openFile(s.sessionFile);
        }}
      >
        <div class="text-sm truncate flex items-center gap-1.5">
          {#if s.live}
            <span class="inline-block w-2 h-2 rounded-full bg-green-500"></span>
          {/if}
          {s.displayName || s.sessionFile.split("/").pop()}
        </div>
        <div class="text-xs text-muted-foreground truncate">{s.cwd}</div>
      </button>
    {:else}
      <div class="text-xs text-muted-foreground px-3 py-2">no sessions yet</div>
    {/each}
  </div>
</aside>
