<script lang="ts">
  import { ui } from "$lib/state.svelte";
  import type { SkillInfo } from "@uipi/protocol";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Badge } from "$lib/components/ui/badge/index.js";
  import { Card, CardDescription, CardHeader, CardTitle } from "$lib/components/ui/card/index.js";
  import RefreshIcon from "@lucide/svelte/icons/refresh-cw";
  import LoaderCircleIcon from "@lucide/svelte/icons/loader-circle";

  /** the skill whose session is being started; disables every card meanwhile */
  let busyName = $state<string | null>(null);
  let refreshing = $state(false);

  // skills belong to a cwd, not a session: the discovered one wins, a recent dir
  // covers the case where nothing has been discovered yet
  const cwd = $derived(ui.currentSkillsCwd());
  const noCwd = $derived(cwd === null);
  const sorted = $derived([...ui.skills].sort((a, b) => a.name.localeCompare(b.name)));
  const disabled = $derived(noCwd || busyName !== null);

  async function refresh() {
    refreshing = true;
    try {
      await ui.refreshSkills(cwd ?? undefined);
    } catch {
      /* error surfaces as a toast from App's effect */
    } finally {
      refreshing = false;
    }
  }

  async function pick(skill: SkillInfo) {
    if (disabled) return;
    busyName = skill.name;
    try {
      await ui.startSkill(skill);
    } catch (e) {
      ui.error = "could not start skill: " + (e instanceof Error ? e.message : String(e));
    } finally {
      busyName = null;
    }
  }
</script>

<div class="flex-1 overflow-y-auto overscroll-contain p-3 md:p-4">
  <div class="flex items-center gap-2 flex-wrap">
    <h1 class="text-sm font-semibold">Skills</h1>
    {#if cwd}
      <span class="text-xs text-muted-foreground truncate min-w-0">{cwd}</span>
    {/if}
    <span class="text-xs text-muted-foreground shrink-0">
      {ui.skills.length}
      {ui.skills.length === 1 ? "skill" : "skills"}
    </span>
    <div class="flex-1"></div>
    <Button
      variant="outline"
      size="sm"
      class="text-xs shrink-0 min-h-8"
      disabled={refreshing}
      onclick={refresh}
    >
      {#if refreshing}
        <LoaderCircleIcon class="size-3.5 animate-spin" />
      {:else}
        <RefreshIcon class="size-3.5" />
      {/if}
      Refresh
    </Button>
  </div>

  {#if noCwd}
    <p class="mt-4 text-xs text-muted-foreground">attach or create a session first</p>
  {:else if sorted.length === 0}
    <p class="mt-4 text-xs text-muted-foreground">no skills found for {cwd}</p>
  {/if}

  {#if sorted.length > 0}
    <div class="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
      {#each sorted as skill (skill.name)}
        <button
          type="button"
          data-skill={skill.name}
          class="group w-full text-left rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-60 disabled:pointer-events-none"
          {disabled}
          onclick={() => void pick(skill)}
        >
          <Card class="h-full min-h-24 transition-colors group-hover:bg-accent/40">
            <CardHeader>
              <div class="flex items-center gap-2 min-w-0">
                <CardTitle class="text-sm truncate">{skill.name}</CardTitle>
                {#if skill.scope === "project"}
                  <Badge
                    variant="outline"
                    class="text-[10px] font-normal text-muted-foreground shrink-0">project</Badge
                  >
                {/if}
                {#if busyName === skill.name}
                  <LoaderCircleIcon
                    class="size-3.5 animate-spin shrink-0 text-muted-foreground"
                    aria-label="Starting"
                  />
                {/if}
              </div>
              <CardDescription class="text-xs line-clamp-3">{skill.description}</CardDescription>
            </CardHeader>
          </Card>
        </button>
      {/each}
    </div>
  {/if}
</div>
