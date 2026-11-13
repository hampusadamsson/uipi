<script lang="ts">
  import { ui, rolePickerItems } from "$lib/state.svelte";
  import Picker from "./Picker.svelte";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Badge } from "$lib/components/ui/badge/index.js";
  import TagIcon from "@lucide/svelte/icons/tag";
  import CheckIcon from "@lucide/svelte/icons/check";

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
  <Picker bind:open title="Role" description="a preset, not a lock">
    {#snippet trigger(props)}
      <Button
        {...props}
        variant="outline"
        size="sm"
        class="text-xs font-normal shrink-0 max-lg:min-h-9"
        aria-label="Role: {cur}"
      >
        <TagIcon class="size-3.5" />
        <span class="max-w-24 truncate sm:max-w-none">{cur}</span>
      </Button>
    {/snippet}

    <div class="text-[10px] text-muted-foreground px-1 max-lg:hidden">
      role — a preset, not a lock
    </div>
    <div class="max-h-[min(18rem,50vh)] overflow-y-auto max-lg:max-h-[55dvh]">
      {#each items as item (item.kind + item.label)}
        <button
          type="button"
          class="flex min-h-10 w-full items-center gap-2 rounded-md px-3 py-2 text-left text-xs hover:bg-accent hover:text-accent-foreground {item.current
            ? 'text-primary'
            : ''}"
          onclick={() => pick(item)}
        >
          <span class="min-w-0 flex-1 truncate">{item.label}</span>
          {#if item.kind === "reload"}
            <Badge variant="outline" class="shrink-0 text-[10px] font-normal">reload</Badge>
          {:else if item.current}
            <CheckIcon class="size-4 shrink-0" />
          {/if}
        </button>
      {/each}
      {#if !loading && names.length === 0}
        <div class="text-xs text-muted-foreground px-3 py-2">no roles found</div>
      {/if}
    </div>
  </Picker>
{/if}
