<script lang="ts">
  import { untrack } from "svelte";
  import { ui } from "$lib/state.svelte";
  import * as Dialog from "$lib/components/ui/dialog/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import { Label } from "$lib/components/ui/label/index.js";
  import { Badge } from "$lib/components/ui/badge/index.js";

  let cwd = $state("");
  let agentDir = $state("");
  let busy = $state(false);
  /**
   * `open` is real writable state (not a `$derived`): the dialog has to be able
   * to close itself, and every close route — Esc, overlay click, the header X,
   * Cancel — must reset `ui.wantNew` too, otherwise the flag stays `true` while
   * the dialog is visually closed and the next `ui.wantNew = true` is a no-op.
   */
  let open = $state(ui.wantNew);
  /** open-state seen by the prefill effect, so it fires on each opening only */
  let wasOpen = false;

  // `ui.wantNew` stays the trigger the rest of the app uses (Sidebar/App set it,
  // create() clears it): pull external changes into `open`, never the reverse.
  $effect(() => {
    const want = ui.wantNew;
    untrack(() => {
      if (open !== want) open = want;
    });
  });

  /** single funnel for a dialog-driven open/close: keep `ui.wantNew` in sync */
  function setOpen(next: boolean) {
    open = next;
    if (ui.wantNew !== next) ui.wantNew = next;
  }

  // Prefill on every opening, not at creation: a cancel must drop whatever was
  // typed, and the defaults may only have arrived after the component mounted.
  $effect(() => {
    if (open === wasOpen) return;
    wasOpen = open;
    if (!open) return;
    cwd = ui.defaults?.cwd ?? "";
    agentDir = ui.defaults?.agentDir ?? "";
  });

  async function create() {
    if (!cwd.trim()) return;
    busy = true;
    try {
      await ui.newSession(cwd.trim(), agentDir.trim() || undefined);
      setOpen(false);
    } catch {
      /* error surfaced as toast */
    } finally {
      busy = false;
    }
  }
</script>

<Dialog.Root {open} onOpenChange={setOpen}>
  <Dialog.Content class="sm:max-w-[32rem]">
    <Dialog.Header>
      <Dialog.Title>New session</Dialog.Title>
      <Dialog.Description
        >Create a pi agent session bound to a project directory.</Dialog.Description
      >
    </Dialog.Header>
    <div class="grid gap-3 py-2">
      <div class="grid gap-1.5">
        <Label for="cwd">Project directory (cwd)</Label>
        <Input id="cwd" bind:value={cwd} placeholder="/path/to/project" />
        {#if ui.recentDirs.length > 0}
          <div class="flex flex-wrap gap-1 mt-1">
            {#each ui.recentDirs.slice(0, 6) as d (d)}
              <Badge variant="outline" class="cursor-pointer" onclick={() => (cwd = d)}>{d}</Badge>
            {/each}
          </div>
        {/if}
      </div>
      <div class="grid gap-1.5">
        <Label for="agentdir">Config dir</Label>
        <Input id="agentdir" bind:value={agentDir} placeholder="~/.pi/agent" />
        <p class="text-xs text-muted-foreground">
          Defaults to the server's --agent-dir / UIPI_AGENT_DIR, else ~/.pi/agent.
        </p>
      </div>
    </div>
    <Dialog.Footer>
      <Button variant="outline" onclick={() => setOpen(false)}>Cancel</Button>
      <Button onclick={create} disabled={busy}>
        {#if busy}Creating…{:else}Create{/if}
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
