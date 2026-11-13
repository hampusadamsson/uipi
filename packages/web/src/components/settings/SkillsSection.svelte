<script lang="ts">
  import { ui } from "$lib/state.svelte";
  import type { SkillInfo } from "@uipi/protocol";
  import { Button } from "$lib/components/ui/button/index.js";
  import ReloadStrip from "./ReloadStrip.svelte";
  import { Badge } from "$lib/components/ui/badge/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import { Label } from "$lib/components/ui/label/index.js";
  import { Textarea } from "$lib/components/ui/textarea/index.js";
  import * as Dialog from "$lib/components/ui/dialog/index.js";
  import PlusIcon from "@lucide/svelte/icons/plus";
  import SaveIcon from "@lucide/svelte/icons/save";
  import CopyIcon from "@lucide/svelte/icons/copy";
  import Trash2Icon from "@lucide/svelte/icons/trash-2";
  import LoaderCircleIcon from "@lucide/svelte/icons/loader-circle";
  import TriangleAlertIcon from "@lucide/svelte/icons/triangle-alert";

  /** the server's own slug rule, mirrored so a bad name is caught before the write */
  const SKILL_NAME = /^[a-z0-9][a-z0-9._-]*$/;
  /** the one frontmatter line the checkbox stands for */
  const DISABLE_MODEL_INVOCATION = /^disable-model-invocation:\s*true\s*$/m;

  const BODY_NOTE =
    "could not read this skill's file — its body and extra frontmatter keys are kept on save, but the values above may not match what is on disk";
  const PROJECT_NOTE = "project skill — edit it in its project directory";

  const sorted = $derived([...ui.skills].sort((a, b) => a.name.localeCompare(b.name)));

  /** One top-level frontmatter value, unquoted; the first match wins. */
  function frontmatterValue(frontmatter: string, key: string): string | undefined {
    for (const line of frontmatter.split("\n")) {
      const colon = line.indexOf(":");
      if (colon === -1 || line.slice(0, colon).trim() !== key) continue;
      const value = line
        .slice(colon + 1)
        .trim()
        .replace(/^(['"])(.*)\1$/, "$2");
      if (value !== "") return value;
    }
    return undefined;
  }

  /** name of the selected skill; null while nothing (or a draft) is selected */
  let selectedName = $state<string | null>(null);
  /** true while the form is a blank draft that is not on disk yet */
  let draftMode = $state(false);

  let name = $state("");
  let description = $state("");
  let disableModelInvocation = $state(false);
  /**
   * Body and checkbox come from the real file; while `fileLoaded` is false the
   * form holds guessed values (the list's description, an empty body) and the
   * "not loaded" note says so.
   */
  let body = $state("");
  let fileLoaded = $state(false);

  /** a write is in flight: every action button is disabled meanwhile */
  let saving = $state(false);
  /**
   * Post-write reload strip. pi discovers skills at session start, so a written
   * SKILL.md only reaches a running session once the resource loader is told to
   * re-read it — which is a separate, explicit step.
   */
  let reloadOpen = $state(false);
  let deleteOpen = $state(false);
  let emptyBodyOpen = $state(false);
  let duplicateOpen = $state(false);
  let duplicateName = $state("");

  const selected = $derived(sorted.find((s) => s.name === selectedName) ?? null);
  const hasSelection = $derived(draftMode || selected !== null);
  const projectScope = $derived(!draftMode && selected?.scope === "project");
  /** a missing-on-disk selection (deleted elsewhere) cannot be written to */
  const lost = $derived(!draftMode && selected === null);

  const nameError = $derived(
    name === "" ? "" : SKILL_NAME.test(name) ? "" : "must match ^[a-z0-9][a-z0-9._-]*$",
  );
  const duplicateNameError = $derived(
    duplicateName === ""
      ? ""
      : SKILL_NAME.test(duplicateName)
        ? ""
        : "must match ^[a-z0-9][a-z0-9._-]*$",
  );

  const canSave = $derived(
    !draftMode && selected !== null && !projectScope && nameError === "" && !saving,
  );
  const canCreate = $derived(draftMode && name !== "" && nameError === "" && !saving);
  const canDelete = $derived(!draftMode && selected !== null && !projectScope && !saving);
  const canStartDuplicate = $derived(!draftMode && selected !== null && !projectScope && !saving);
  const canDuplicate = $derived(
    canStartDuplicate && duplicateName !== "" && duplicateNameError === "",
  );

  /**
   * The frontmatter text handed to the server, always with all three keys:
   * emitting `disable-model-invocation` even when false is what lets the
   * checkbox clear a value that is already on disk.
   */
  function frontmatterFor(skillName: string): string {
    return `name: ${skillName}\ndescription: ${description}\ndisable-model-invocation: ${disableModelInvocation}`;
  }

  /**
   * Load an existing skill's real file into the form. Until the read lands (and
   * if it fails) the form shows the guessed state and the note explains it.
   *
   * A late reply is dropped when the user has selected something else meanwhile.
   */
  async function pick(skill: SkillInfo): Promise<void> {
    selectedName = skill.name;
    draftMode = false;
    name = skill.name;
    description = skill.description;
    disableModelInvocation = false;
    body = "";
    fileLoaded = false;
    closeDuplicate();

    const target = skill.name;
    const file = await ui.readSkill(target).catch(() => undefined);
    if (draftMode || selectedName !== target) return;
    if (!file) return;
    description = frontmatterValue(file.frontmatter, "description") ?? skill.description;
    disableModelInvocation = DISABLE_MODEL_INVOCATION.test(file.frontmatter);
    body = file.body;
    fileLoaded = true;
  }

  function newDraft(): void {
    selectedName = null;
    draftMode = true;
    name = "";
    description = "";
    disableModelInvocation = false;
    body = "";
    fileLoaded = false;
    closeDuplicate();
  }

  function clear(): void {
    selectedName = null;
    draftMode = false;
    name = "";
    description = "";
    disableModelInvocation = false;
    body = "";
    fileLoaded = false;
    closeDuplicate();
  }

  function startDuplicate(): void {
    if (!canStartDuplicate) return;
    duplicateName = `${name}-copy`;
    duplicateOpen = true;
  }

  function closeDuplicate(): void {
    duplicateOpen = false;
    duplicateName = "";
  }

  /** Save asks first: an empty body means "keep the body on disk", not "erase it". */
  function save(): void {
    if (!canSave || saving) return;
    if (body.trim() === "") {
      emptyBodyOpen = true;
      return;
    }
    void writeUpdate(body);
  }

  async function writeUpdate(nextBody: string | undefined): Promise<void> {
    const target = name;
    saving = true;
    reloadOpen = false;
    try {
      await ui.writeSkill("update", target, frontmatterFor(target), nextBody);
      reloadOpen = true;
    } catch {
      /* the error surfaces as a toast from App's effect */
    } finally {
      saving = false;
    }
  }

  async function create(): Promise<void> {
    if (!canCreate || saving) return;
    const target = name;
    saving = true;
    let ok = false;
    reloadOpen = false;
    try {
      await ui.writeSkill("create", target, frontmatterFor(target), body);
      ok = true;
      reloadOpen = true;
    } catch {
      /* the error surfaces as a toast from App's effect */
    } finally {
      saving = false;
    }
    // the refreshed mirror now holds it, so the form becomes an edit of it
    if (ok) await pick({ name: target, description, scope: "user" });
  }

  async function duplicate(): Promise<void> {
    if (!canDuplicate || saving) return;
    const target = duplicateName;
    saving = true;
    let ok = false;
    reloadOpen = false;
    try {
      await ui.writeSkill("create", target, frontmatterFor(target), body);
      ok = true;
      reloadOpen = true;
    } catch {
      /* the error surfaces as a toast from App's effect */
    } finally {
      saving = false;
    }
    // the duplicated skill stays selected; the copy is in the refreshed list
    if (ok) closeDuplicate();
  }

  async function remove(): Promise<void> {
    if (!canDelete || saving) return;
    const target = name;
    saving = true;
    let ok = false;
    reloadOpen = false;
    try {
      await ui.writeSkill("delete", target);
      ok = true;
      reloadOpen = true;
    } catch {
      /* the error surfaces as a toast from App's effect */
    } finally {
      saving = false;
    }
    if (ok) {
      deleteOpen = false;
      clear();
    }
  }
</script>

<!-- Below md the page pane is the scroller (one thumb-scroll, no nested
     scroll traps); from md up each column scrolls on its own. -->
<div class="flex min-h-0 flex-col gap-3 lg:h-full lg:flex-row">
  <div class="flex min-h-0 shrink-0 flex-col gap-2 lg:w-40 lg:border-r lg:border-border lg:pr-2">
    <Button
      variant="outline"
      size="sm"
      class="text-xs shrink-0"
      disabled={saving}
      onclick={newDraft}
    >
      <PlusIcon class="size-3.5" />
      New skill
    </Button>

    <!-- lg: a vertical rail beside the form. Below lg it would be half the
         width, so the same rows become one scroll strip above the form. -->
    <div
      class="flex flex-col gap-0.5 lg:flex-1 lg:min-h-0 lg:overflow-y-auto lg:overscroll-contain max-lg:flex-row max-lg:overflow-x-auto max-lg:overscroll-x-contain max-lg:pb-1"
      aria-label="Skills"
      role="group"
    >
      {#if sorted.length === 0}
        <p class="text-xs text-muted-foreground whitespace-nowrap">no skills found</p>
      {/if}
      {#each sorted as skill (skill.name)}
        <button
          type="button"
          data-skill={skill.name}
          aria-current={!draftMode && selectedName === skill.name ? "true" : undefined}
          class="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs text-left transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 max-lg:shrink-0 max-lg:min-h-11 max-lg:border max-lg:border-border {!draftMode &&
          selectedName === skill.name
            ? 'bg-accent text-accent-foreground font-medium'
            : 'text-muted-foreground'}"
          onclick={() => void pick(skill)}
        >
          <span class="truncate min-w-0">{skill.name}</span>
          {#if skill.scope === "project"}
            <Badge variant="outline" class="text-[10px] font-normal shrink-0 text-muted-foreground"
              >project</Badge
            >
          {/if}
        </button>
      {/each}
    </div>
  </div>

  <div
    class="flex min-w-0 flex-col gap-3 lg:flex-1 lg:min-h-0 lg:overflow-y-auto lg:overscroll-contain"
  >
    <ReloadStrip what="skills" open={reloadOpen} ondone={() => (reloadOpen = false)} />

    {#if !hasSelection}
      <p class="text-xs text-muted-foreground">
        {lost ? "this skill is no longer in the list" : "select a skill or start a new one"}
      </p>
    {:else}
      <div class="flex items-center gap-2 flex-wrap">
        <h2 class="text-sm font-semibold">{draftMode ? "New skill" : name}</h2>
        {#if projectScope}
          <Badge variant="outline" class="text-[10px] font-normal text-muted-foreground"
            >project</Badge
          >
        {/if}
        {#if saving}
          <LoaderCircleIcon
            class="size-3.5 animate-spin text-muted-foreground"
            aria-label="Writing"
          />
        {/if}
      </div>

      {#if projectScope}
        <p class="text-xs text-muted-foreground">{PROJECT_NOTE}</p>
      {/if}

      <div class="flex flex-col gap-1">
        <Label for="skill-name" class="text-xs font-normal text-muted-foreground">Name</Label>
        <Input
          id="skill-name"
          class="text-xs font-mono"
          value={name}
          readonly={!draftMode}
          aria-invalid={nameError !== ""}
          placeholder="my-skill"
          oninput={(e) => (name = e.currentTarget.value)}
        />
        {#if nameError}
          <p class="text-xs text-destructive">{nameError}</p>
        {/if}
      </div>

      <div class="flex flex-col gap-1">
        <Label for="skill-description" class="text-xs font-normal text-muted-foreground"
          >Description</Label
        >
        <Input
          id="skill-description"
          class="text-xs"
          value={description}
          placeholder="what this skill does"
          oninput={(e) => (description = e.currentTarget.value)}
        />
      </div>

      <Label for="skill-disable-model-invocation" class="text-xs font-normal">
        <input
          id="skill-disable-model-invocation"
          type="checkbox"
          class="size-3.5 accent-primary"
          checked={disableModelInvocation}
          onchange={(e) => (disableModelInvocation = e.currentTarget.checked)}
        />
        Disable model invocation
      </Label>

      <div class="flex flex-col gap-1">
        <Label for="skill-body" class="text-xs font-normal text-muted-foreground">Body</Label>
        <Textarea
          id="skill-body"
          class="text-xs font-mono min-h-40"
          value={body}
          placeholder={draftMode ? "instructions the model follows" : ""}
          oninput={(e) => (body = e.currentTarget.value)}
        />
        {#if !draftMode && !fileLoaded}
          <p class="text-xs text-muted-foreground">{BODY_NOTE}</p>
        {/if}
      </div>

      {#if !draftMode && duplicateOpen}
        <div class="flex flex-col gap-1 rounded-md border border-border p-2">
          <Label for="skill-duplicate-name" class="text-xs font-normal text-muted-foreground"
            >Copy to a new skill</Label
          >
          <div class="flex items-center gap-2">
            <Input
              id="skill-duplicate-name"
              class="text-xs font-mono"
              value={duplicateName}
              aria-invalid={duplicateNameError !== ""}
              oninput={(e) => (duplicateName = e.currentTarget.value)}
            />
            <Button
              size="sm"
              class="text-xs shrink-0"
              disabled={!canDuplicate}
              onclick={() => void duplicate()}
            >
              <CopyIcon class="size-3.5" />
              Duplicate
            </Button>
            <Button
              variant="ghost"
              size="sm"
              class="text-xs shrink-0"
              disabled={saving}
              onclick={closeDuplicate}
            >
              Cancel
            </Button>
          </div>
          {#if duplicateNameError}
            <p class="text-xs text-destructive">{duplicateNameError}</p>
          {/if}
        </div>
      {/if}

      <div class="flex items-center gap-2 flex-wrap">
        {#if draftMode}
          <Button size="sm" class="text-xs" disabled={!canCreate} onclick={() => void create()}>
            {#if saving}
              <LoaderCircleIcon class="size-3.5 animate-spin" />
            {:else}
              <PlusIcon class="size-3.5" />
            {/if}
            {saving ? "Creating…" : "Create"}
          </Button>
        {:else}
          <Button size="sm" class="text-xs" disabled={!canSave} onclick={save}>
            {#if saving}
              <LoaderCircleIcon class="size-3.5 animate-spin" />
            {:else}
              <SaveIcon class="size-3.5" />
            {/if}
            {saving ? "Saving…" : "Save"}
          </Button>
          <Button
            variant="outline"
            size="sm"
            class="text-xs"
            disabled={!canStartDuplicate}
            onclick={startDuplicate}
          >
            <CopyIcon class="size-3.5" />
            Duplicate
          </Button>
          <div class="flex-1"></div>
          <Button
            variant="destructive"
            size="sm"
            class="text-xs"
            disabled={!canDelete}
            onclick={() => (deleteOpen = true)}
          >
            <Trash2Icon class="size-3.5" />
            Delete
          </Button>
        {/if}
      </div>
    {/if}
  </div>
</div>

<Dialog.Root bind:open={emptyBodyOpen}>
  <Dialog.Content class="lg:max-w-[32rem]">
    <Dialog.Header>
      <Dialog.Title>Save with an empty body?</Dialog.Title>
      <Dialog.Description class="text-xs">
        Saving with an empty body will not change the existing body. Continue?
      </Dialog.Description>
    </Dialog.Header>
    <Dialog.Footer>
      <Button variant="outline" size="sm" class="text-xs" onclick={() => (emptyBodyOpen = false)}>
        Cancel
      </Button>
      <Button
        size="sm"
        class="text-xs"
        onclick={() => {
          emptyBodyOpen = false;
          void writeUpdate(undefined);
        }}
      >
        Continue
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>

<Dialog.Root bind:open={deleteOpen}>
  <Dialog.Content class="lg:max-w-[32rem]">
    <Dialog.Header>
      <Dialog.Title>Delete skill {name}?</Dialog.Title>
      <Dialog.Description class="text-xs">
        This removes <span class="font-mono break-all">~/.pi/agent/skills/{name}/SKILL.md</span>
        from disk. It cannot be undone from here.
      </Dialog.Description>
    </Dialog.Header>
    <Dialog.Footer>
      <Button
        variant="outline"
        size="sm"
        class="text-xs"
        disabled={saving}
        onclick={() => (deleteOpen = false)}
      >
        Cancel
      </Button>
      <Button
        variant="destructive"
        size="sm"
        class="text-xs"
        disabled={saving}
        onclick={() => void remove()}
      >
        {#if saving}
          <LoaderCircleIcon class="size-3.5 animate-spin" />
        {:else}
          <TriangleAlertIcon class="size-3.5" />
        {/if}
        Delete
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
