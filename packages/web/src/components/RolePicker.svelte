<script lang="ts">
  import { ui } from "$lib/state.svelte";
  import * as Popover from "$lib/components/ui/popover/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Input } from "$lib/components/ui/input/index.js";

  let { sessionId }: { sessionId: string } = $props();
  let open = $state(false);
  let name = $state("");

  const cur = $derived(ui.roleOf(sessionId));
  const chip = $derived(ui.roleChip(sessionId));

  // NOTE: role NAMES are not on the wire. `commands` carries { name, description }
  // only, and there is no getArgumentCompletions request in the protocol, so the
  // picker cannot list roles: it takes a typed name instead.
  function apply(role: string | null, reload = false) {
    ui.cmd({ type: "proto.setRole", sessionId, role, ...(reload ? { reload: true } : {}) });
    open = false;
    // the sidebar badge reads SessionSummary.role (server-side JSONL replay), so
    // pull a fresh list — otherwise the row keeps showing the previous role word
    void ui.refreshSessions();
  }

  function submit() {
    const v = name.trim();
    if (!v) return;
    name = "";
    apply(v);
  }
</script>

{#if chip}
  <Popover.Root bind:open>
    <Popover.Trigger>
      {#snippet child({ props })}
        <Button {...props} variant="outline" size="sm" class="text-xs font-normal shrink-0">
          {chip}
        </Button>
      {/snippet}
    </Popover.Trigger>
    <Popover.Content class="w-[min(20rem,calc(100vw-2rem))] p-2" align="end">
      <div class="text-[10px] text-muted-foreground px-1">role — a preset, not a lock</div>
      <div class="flex gap-1">
        <Input
          class="h-8 text-xs"
          placeholder="role name…"
          bind:value={name}
          onkeydown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submit();
            }
          }}
        />
        <Button variant="secondary" size="sm" class="text-xs shrink-0" onclick={submit}>set</Button>
      </div>
      <div class="text-[10px] text-muted-foreground px-1">
        server exposes no role list — type the name
      </div>
      <button
        class="w-full text-left text-xs px-3 py-2 rounded-md hover:bg-accent hover:text-accent-foreground"
        onclick={() => apply(null)}
      >
        (none)
      </button>
      <button
        class="w-full text-left text-xs px-3 py-2 rounded-md hover:bg-accent hover:text-accent-foreground"
        onclick={() => apply(cur, true)}
      >
        reload roles.json, keep “{cur}”
      </button>
    </Popover.Content>
  </Popover.Root>
{/if}
