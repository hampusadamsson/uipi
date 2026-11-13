<script lang="ts">
  import { ui, rolePickerItems } from "$lib/state.svelte";
  import * as Popover from "$lib/components/ui/popover/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import TagIcon from "@lucide/svelte/icons/tag";

  let { sessionId }: { sessionId: string } = $props();
  let open = $state(false);
  let names = $state<string[]>([]);
  let loading = $state(false);

  const cur = $derived(ui.roleOf(sessionId));
  const items = $derived(rolePickerItems(names, cur));

  // Ask on every open: the names come from the `/role` command's own argument
  // completions, so a hand-edited roles.json must not be cached in the client.
  $effect(() => {
    if (!open) return;
    let cancelled = false;
    names = []; // don't show a stale name the extension no longer offers
    loading = true;
    ui.roleNames(sessionId)
      .then((list) => {
        if (!cancelled) names = list;
      })
      .catch(() => {
        if (!cancelled) names = []; // picker still offers (none) + reload
      })
      .finally(() => {
        if (!cancelled) loading = false;
      });
    return () => {
      cancelled = true;
    };
  });

  function apply(role: string | null, reload = false) {
    ui.cmd({ type: "proto.setRole", sessionId, role, ...(reload ? { reload: true } : {}) });
    open = false;
    // the sidebar badge reads SessionSummary.role (server-side JSONL replay), so
    // pull a fresh list — otherwise the row keeps showing the previous role word
    void ui.refreshSessions();
  }

  function pick(item: (typeof items)[number]) {
    if (item.kind === "reload") apply(item.role, true);
    else apply(item.role);
  }
</script>

{#if cur}
  <Popover.Root bind:open>
    <Popover.Trigger>
      {#snippet child({ props })}
        <Button {...props} variant="outline" size="sm" class="text-xs font-normal shrink-0">
          <TagIcon class="size-3.5" />
          <span class="max-w-24 truncate sm:max-w-none">{cur}</span>
        </Button>
      {/snippet}
    </Popover.Trigger>
    <Popover.Content class="w-[min(20rem,calc(100vw-2rem))] p-2" align="end">
      <div class="text-[10px] text-muted-foreground px-1">role — a preset, not a lock</div>
      <div class="max-h-[min(18rem,50vh)] overflow-y-auto">
        {#each items as item (item.kind + item.label)}
          <button
            class="w-full text-left text-xs px-3 py-2 min-h-8 rounded-md hover:bg-accent hover:text-accent-foreground {item.current
              ? 'text-primary'
              : ''}"
            onclick={() => pick(item)}
          >
            {item.label}
          </button>
        {/each}
        {#if !loading && names.length === 0}
          <div class="text-xs text-muted-foreground px-3 py-2">no roles found</div>
        {/if}
      </div>
    </Popover.Content>
  </Popover.Root>
{/if}
