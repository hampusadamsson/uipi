<script lang="ts">
  import { onMount, type Snippet } from "svelte";
  import { ui, type ConfigId } from "$lib/state.svelte";
  import type { ReloadWhat } from "@uipi/protocol";
  import { Button } from "$lib/components/ui/button/index.js";
  import ReloadStrip from "./ReloadStrip.svelte";

  /**
   * Pi takes these documents on mid-session; `sandbox`/`mcp` have no reload of
   * their own (pi reads them at session start), so they get a note instead of a
   * strip.
   */
  const RELOADABLE: Partial<Record<ConfigId, ReloadWhat>> = {
    settings: "settings",
    roles: "roles",
  };

  let {
    docId,
    children,
  }: {
    docId: ConfigId;
    /** the section's form, rendered with the current draft and a setter for it */
    children: Snippet<[Record<string, unknown>, (next: Record<string, unknown>) => void]>;
  } = $props();

  /** the editor buffer; `baseline` is what the last load/save agreed on */
  let text = $state("");
  let baseline = $state("");
  let phase = $state<"loading" | "ready" | "missing">("loading");
  let saving = $state(false);
  /**
   * The post-save strip is open until the reload succeeds or the next save
   * starts: it describes one save, so it must not outlive its relevance.
   */
  let reloadOpen = $state(false);

  const reloadWhat = $derived(RELOADABLE[docId]);

  const conflict = $derived(ui.configConflicts.get(docId));
  const dirty = $derived(text !== baseline);

  /**
   * The draft handed to `children`. Invalid JSON degrades to `{}` rather than
   * throwing, so a half-typed buffer cannot blank the form out.
   */
  const parsed = $derived.by((): Record<string, unknown> => {
    try {
      const v: unknown = JSON.parse(text);
      return v !== null && typeof v === "object" && !Array.isArray(v)
        ? (v as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  });

  /**
   * Replace the draft wholesale: copy the parsed object, let the section's own
   * fields win, and re-serialize. Spreading `parsed` is what keeps unknown keys
   * a hand-written config may carry.
   */
  function set(next: Record<string, unknown>): void {
    text = JSON.stringify({ ...parsed, ...next }, null, 2);
  }

  function seed(value: string): void {
    text = value;
    baseline = value;
  }

  async function load(): Promise<void> {
    try {
      await ui.loadConfig(docId);
    } catch {
      phase = "missing";
      return;
    }
    const loaded = ui.configDocs.get(docId);
    if (!loaded) {
      phase = "missing";
      return;
    }
    seed(loaded.text);
    phase = "ready";
  }

  async function save(): Promise<void> {
    if (!dirty || saving) return;
    const attempted = text;
    saving = true;
    reloadOpen = false;
    try {
      await ui.saveConfig(docId, attempted);
    } finally {
      saving = false;
    }
    // the reply carries the doc as re-read after the write; adopt it as the new
    // baseline so a normalizing server doesn't leave the form permanently dirty.
    // A lost race keeps the edit: the conflict banner offers the reload instead.
    const saved = ui.configDocs.get(docId);
    if (saved && !ui.configConflicts.has(docId) && text === attempted) {
      seed(saved.text);
      // a save never touches a running session by itself — offer the reload
      if (reloadWhat) reloadOpen = true;
    }
  }

  function revert(): void {
    text = baseline;
  }

  onMount(() => {
    void load();
  });
</script>

{#if phase === "loading"}
  <p class="text-xs text-muted-foreground">loading…</p>
{:else if phase === "missing"}
  <p class="text-xs text-muted-foreground">not found</p>
{:else}
  <div class="flex flex-col gap-3">
    {#if conflict}
      <div
        class="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive flex items-center gap-2 flex-wrap"
      >
        <span class="min-w-0 flex-1">
          This document changed on disk since it was loaded — your edits were not written.
        </span>
        <Button variant="destructive" size="sm" class="text-xs" onclick={() => void load()}>
          Reload from disk
        </Button>
      </div>
    {/if}

    {@render children(parsed, set)}

    {#if reloadWhat}
      <ReloadStrip what={reloadWhat} open={reloadOpen} ondone={() => (reloadOpen = false)} />
    {:else}
      <p class="text-xs text-muted-foreground">
        pi reads {docId}.json at session start, so a new session picks up this change.
      </p>
    {/if}

    <!-- The save bar sticks to the bottom of the mobile sheet: a long Roles
         form otherwise hides Save a screenful above the thumb, and a settings
         page you cannot save without hunting is not a settings page. From lg
         up it is an ordinary row at the end of the form. -->
    <div
      class="sticky bottom-0 z-10 -mx-3 flex items-center gap-2 flex-wrap border-t border-border bg-background/95 px-3 py-2 backdrop-blur lg:static lg:mx-0 lg:border-0 lg:bg-transparent lg:p-0 lg:backdrop-blur-none"
    >
      <Button
        variant="outline"
        size="sm"
        class="text-xs max-lg:min-h-11"
        disabled={!dirty || saving}
        onclick={revert}
      >
        Revert
      </Button>
      <Button
        size="sm"
        class="text-xs max-lg:min-h-11"
        disabled={!dirty || saving}
        onclick={() => void save()}
      >
        {saving ? "Saving…" : "Save"}
      </Button>
      <span class="text-xs text-muted-foreground max-lg:hidden">
        a .bak of the previous version is kept
      </span>
      <div class="flex-1"></div>
      <span class="text-xs text-muted-foreground">{dirty ? "unsaved changes" : "saved"}</span>
    </div>
  </div>
{/if}
