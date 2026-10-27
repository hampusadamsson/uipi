<script lang="ts">
  import { ui } from "$lib/state.svelte";
  import type { ReloadWhat } from "@uipi/protocol";
  import { Button } from "$lib/components/ui/button/index.js";

  /**
   * Post-save affordance: pi reads its config at session start, so a save
   * changes what the *next* session sees but leaves every running one on the old
   * values. Reloading is therefore a separate, explicit step — it changes a
   * running agent mid-conversation, which is not something a save may do to the
   * user silently. The parent owns `open`: it raises the strip after a
   * successful save and clears it on reload success or the next save.
   */
  let {
    what,
    open,
    ondone,
  }: {
    what: ReloadWhat;
    open: boolean;
    /** called once the reload succeeded, so the parent can clear the strip */
    ondone: () => void;
  } = $props();

  let reloading = $state(false);

  async function reload(): Promise<void> {
    if (reloading) return;
    reloading = true;
    try {
      // null means the reload failed (the client already raised `error`, which
      // the app toasts): keep the strip so the action can be retried. An empty
      // id list is a success — nothing was running to be out of date.
      if ((await ui.reloadConfig(what)) !== null) ondone();
    } finally {
      reloading = false;
    }
  }
</script>

{#if open}
  <div
    class="rounded-md border border-border bg-muted/40 px-2 py-1.5 text-xs flex items-center gap-2 flex-wrap"
    data-reload-strip={what}
  >
    <span class="min-w-0 flex-1 text-muted-foreground">
      saved — running sessions still use the old values
    </span>
    <Button
      variant="outline"
      size="sm"
      class="text-xs shrink-0"
      disabled={reloading}
      onclick={() => void reload()}
    >
      {reloading ? "Reloading…" : "Reload sessions"}
    </Button>
  </div>
{/if}
