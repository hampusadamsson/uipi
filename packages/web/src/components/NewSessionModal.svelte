<script lang="ts">
  import { ui } from "$lib/state.svelte";
  import * as Dialog from "$lib/components/ui/dialog/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import { Label } from "$lib/components/ui/label/index.js";
  import { Badge } from "$lib/components/ui/badge/index.js";

  let cwd = $state("");
  let agentDir = $state("");
  let busy = $state(false);
  let open = $derived(ui.wantNew);

  async function create() {
    if (!cwd.trim()) return;
    busy = true;
    try {
      await ui.newSession(cwd.trim(), agentDir.trim() || undefined);
      ui.wantNew = false;
    } catch {
      /* error surfaced as toast */
    } finally {
      busy = false;
    }
  }
</script>

<Dialog.Root bind:open>
  <Dialog.Content class="sm:max-w-[32rem]">
    <Dialog.Header>
      <Dialog.Title>New session</Dialog.Title>
      <Dialog.Description>Create a pi agent session bound to a project directory.</Dialog.Description>
    </Dialog.Header>
    <div class="grid gap-3 py-2">
      <div class="grid gap-1.5">
        <Label for="cwd">Project directory (cwd)</Label>
        <Input id="cwd" bind:value={cwd} placeholder="/path/to/project" />
        {#if ui.recentDirs.length > 0}
          <div class="flex flex-wrap gap-1 mt-1">
            {#each ui.recentDirs.slice(0, 6) as d}
              <Badge variant="outline" class="cursor-pointer" onclick={() => (cwd = d)}>{d}</Badge>
            {/each}
          </div>
        {/if}
      </div>
      <div class="grid gap-1.5">
        <Label for="agentdir">Config dir</Label>
        <Input id="agentdir" bind:value={agentDir} placeholder="~/.pi/agent" />
        <p class="text-xs text-muted-foreground">Defaults to ~/.pi/agent (shared with terminal pi).</p>
      </div>
    </div>
    <Dialog.Footer>
      <Button variant="outline" onclick={() => (ui.wantNew = false)}>Cancel</Button>
      <Button onclick={create} disabled={busy}>
        {#if busy}Creating…{:else}Create{/if}
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
