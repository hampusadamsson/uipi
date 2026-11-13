<script lang="ts">
  import { describeCron } from "@uipi/client";
  import type { Schedule, ScheduleRun } from "@uipi/protocol";
  import { ui } from "$lib/state.svelte";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Badge } from "$lib/components/ui/badge/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import { Label } from "$lib/components/ui/label/index.js";
  import { Textarea } from "$lib/components/ui/textarea/index.js";
  import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
  } from "$lib/components/ui/card/index.js";
  import * as Dialog from "$lib/components/ui/dialog/index.js";
  import RefreshIcon from "@lucide/svelte/icons/refresh-cw";
  import LoaderCircleIcon from "@lucide/svelte/icons/loader-circle";
  import PlusIcon from "@lucide/svelte/icons/plus";
  import PlayIcon from "@lucide/svelte/icons/play";
  import Trash2Icon from "@lucide/svelte/icons/trash-2";
  import PowerIcon from "@lucide/svelte/icons/power";
  import ChevronRightIcon from "@lucide/svelte/icons/chevron-right";
  import ChevronDownIcon from "@lucide/svelte/icons/chevron-down";
  import ClockIcon from "@lucide/svelte/icons/clock";

  /**
   * Preset cron expressions, labelled with the phrase `describeCron` prints for
   * them — the button text is what the card will say, never a friendlier guess.
   */
  const PRESETS: { label: string; cron: string }[] = [
    { label: "Every 15 minutes", cron: "*/15 * * * *" },
    { label: "Every hour", cron: "0 * * * *" },
    { label: "Every day at 09:00", cron: "0 9 * * *" },
    { label: "Weekdays at 08:30", cron: "30 8 * * 1-5" },
    { label: "Every Monday at 06:00", cron: "0 6 * * 1" },
    { label: "Monthly on the 1st at 00:00", cron: "0 0 1 * *" },
  ];

  /** schedules are listed by name so the order does not move under the user */
  const sorted = $derived([...ui.schedules].sort((a, b) => a.name.localeCompare(b.name)));

  /** id of the schedule whose history is open; only one at a time */
  let expandedId = $state<string | null>(null);
  /** id of the schedule whose "run now" is in flight */
  let runningId = $state<string | null>(null);
  let refreshing = $state(false);
  let saving = $state(false);

  /**
   * The form's target: null when it is closed, "new" for a fresh draft, else the
   * id of the schedule being edited (whose id travels back in the input).
   */
  let editing = $state<"new" | string | null>(null);
  let name = $state("");
  let cron = $state("");
  let prompt = $state("");
  let role = $state("");
  let cwd = $state("");
  let enabled = $state(true);
  /** set on the first save attempt, so empty fields only complain once asked */
  let attempted = $state(false);
  /** the server's own message when a save throws */
  let saveError = $state<string | null>(null);
  /** the schedule waiting for the delete confirmation */
  let deleting = $state<Schedule | null>(null);

  /**
   * A clock for the relative labels ("in 12m"). Ticking every 30 s keeps the
   * countdown honest without re-rendering on every frame.
   */
  let now = $state(Date.now());
  $effect(() => {
    const id = setInterval(() => (now = Date.now()), 30_000);
    return () => clearInterval(id);
  });

  /** Where a new schedule runs by default: the session's cwd, else the newest dir. */
  function defaultCwd(): string {
    return ui.attached.get(ui.activeId ?? "")?.cwd ?? ui.recentDirs[0] ?? "";
  }

  function openNew(): void {
    editing = "new";
    name = "";
    cron = "";
    prompt = "";
    role = "";
    cwd = defaultCwd();
    enabled = true;
    attempted = false;
    saveError = null;
  }

  /**
   * Load a schedule into the draft. Editing happens inside the row itself, so
   * this only ever fills the fields — `toggleEdit` decides whether to show them.
   */
  function openEdit(s: Schedule): void {
    editing = s.id;
    name = s.name;
    cron = s.cron;
    prompt = s.prompt;
    role = s.role ?? "";
    cwd = s.cwd;
    enabled = s.enabled;
    attempted = false;
    saveError = null;
  }

  /** Clicking a row header opens that row's inline editor, clicking it again closes it. */
  function toggleEdit(s: Schedule): void {
    if (editing === s.id) {
      closeForm();
      return;
    }
    openEdit(s);
  }

  function closeForm(): void {
    editing = null;
    attempted = false;
    saveError = null;
  }

  // client-side checks: the cheap ones only, the server owns cron parsing
  const nameError = $derived(attempted && name.trim() === "" ? "name is required" : "");
  const cronError = $derived(attempted && cron.trim() === "" ? "cron is required" : "");
  const promptError = $derived(attempted && prompt.trim() === "" ? "prompt is required" : "");
  const cwdError = $derived(attempted && cwd.trim() === "" ? "cwd is required" : "");
  const valid = $derived(
    name.trim() !== "" && cron.trim() !== "" && prompt.trim() !== "" && cwd.trim() !== "",
  );

  async function refresh(): Promise<void> {
    refreshing = true;
    try {
      await ui.refreshSchedules();
    } catch (e) {
      ui.error = "could not load schedules: " + (e instanceof Error ? e.message : String(e));
    } finally {
      refreshing = false;
    }
  }

  async function save(): Promise<void> {
    if (saving) return;
    attempted = true;
    saveError = null;
    if (!valid) return;
    saving = true;
    try {
      await ui.saveSchedule({
        id: editing === "new" || editing === null ? undefined : editing,
        name: name.trim(),
        cron: cron.trim(),
        prompt,
        role: role.trim() === "" ? null : role.trim(),
        cwd: cwd.trim(),
        enabled,
      });
      closeForm();
    } catch (e) {
      // the server's wording is the useful one: it knows why the cron is bad
      saveError = e instanceof Error ? e.message : String(e);
    } finally {
      saving = false;
    }
  }

  /** Enable/disable is a save of the same schedule with one field flipped. */
  async function toggleEnabled(s: Schedule): Promise<void> {
    try {
      await ui.saveSchedule({
        id: s.id,
        name: s.name,
        cron: s.cron,
        prompt: s.prompt,
        role: s.role,
        cwd: s.cwd,
        agentDir: s.agentDir,
        enabled: !s.enabled,
      });
    } catch (e) {
      ui.error = "could not update schedule: " + (e instanceof Error ? e.message : String(e));
    }
  }

  async function runNow(s: Schedule): Promise<void> {
    if (runningId !== null) return;
    runningId = s.id;
    try {
      await ui.runScheduleNow(s.id);
      expandedId = s.id;
    } catch (e) {
      ui.error = "could not run schedule: " + (e instanceof Error ? e.message : String(e));
    } finally {
      runningId = null;
    }
  }

  async function confirmDelete(): Promise<void> {
    const target = deleting;
    if (!target || saving) return;
    saving = true;
    try {
      await ui.deleteSchedule(target.id);
      deleting = null;
      if (editing === target.id) closeForm();
    } catch (e) {
      ui.error = "could not delete schedule: " + (e instanceof Error ? e.message : String(e));
    } finally {
      saving = false;
    }
  }

  /**
   * Open a run's session. `syncUrl()` deliberately leaves page routes alone, so
   * the chat view has to be navigated to explicitly (as `startSkill` does).
   */
  async function openRun(run: ScheduleRun): Promise<void> {
    if (!run.sessionFile) return;
    try {
      await ui.openSession(run.sessionFile);
      ui.goToSessionsPage();
    } catch (e) {
      ui.error = "could not open session: " + (e instanceof Error ? e.message : String(e));
    }
  }

  function toggleHistory(id: string): void {
    expandedId = expandedId === id ? null : id;
  }

  function fmtSpan(ms: number): string {
    const minutes = Math.round(ms / 60_000);
    if (minutes < 1) return "<1m";
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours}h`;
    return `${Math.round(hours / 24)}d`;
  }

  /** `in 12m` / `3h ago`; "never" for a missing timestamp. */
  function fmtRelative(at: number | null): string {
    if (at === null) return "never";
    const delta = at - now;
    return delta >= 0 ? `in ${fmtSpan(delta)}` : `${fmtSpan(-delta)} ago`;
  }

  function fmtAbsolute(at: number | null): string {
    return at === null ? "never" : new Date(at).toLocaleString();
  }

  /** newest first, whatever order the server's capped history is in */
  function historyOf(s: Schedule): ScheduleRun[] {
    return [...s.history].sort((a, b) => b.at - a.at);
  }
</script>

{#snippet formFields()}
  <div class="flex flex-col gap-1">
    <Label for="schedule-name" class="text-xs font-normal text-muted-foreground">Name</Label>
    <Input
      id="schedule-name"
      class="text-xs"
      value={name}
      aria-invalid={nameError !== ""}
      placeholder="nightly review"
      oninput={(e) => (name = e.currentTarget.value)}
    />
    {#if nameError}
      <p class="text-xs text-destructive">{nameError}</p>
    {/if}
  </div>

  <div class="flex flex-col gap-1">
    <Label for="schedule-cron" class="text-xs font-normal text-muted-foreground">Cron</Label>
    <Input
      id="schedule-cron"
      class="text-xs font-mono"
      value={cron}
      aria-invalid={cronError !== ""}
      placeholder="30 8 * * 1-5"
      oninput={(e) => (cron = e.currentTarget.value)}
    />
    {#if cronError}
      <p class="text-xs text-destructive">{cronError}</p>
    {:else if cron.trim() !== ""}
      <p class="text-xs text-muted-foreground">{describeCron(cron)}</p>
    {/if}
    <div class="flex items-center gap-1.5 flex-wrap pt-1">
      {#each PRESETS as preset (preset.cron)}
        <Button
          variant="outline"
          size="sm"
          class="text-[11px] h-6 px-2"
          data-preset={preset.cron}
          onclick={() => (cron = preset.cron)}>{preset.label}</Button
        >
      {/each}
    </div>
  </div>

  <div class="flex flex-col gap-1">
    <Label for="schedule-prompt" class="text-xs font-normal text-muted-foreground">Prompt</Label>
    <Textarea
      id="schedule-prompt"
      class="text-xs font-mono min-h-24"
      value={prompt}
      aria-invalid={promptError !== ""}
      placeholder="what the session should do"
      oninput={(e) => (prompt = e.currentTarget.value)}
    />
    {#if promptError}
      <p class="text-xs text-destructive">{promptError}</p>
    {/if}
  </div>

  <div class="flex flex-col gap-1">
    <Label for="schedule-role" class="text-xs font-normal text-muted-foreground"
      >Role (optional)</Label
    >
    <Input
      id="schedule-role"
      class="text-xs font-mono"
      value={role}
      placeholder="(none)"
      oninput={(e) => (role = e.currentTarget.value)}
    />
  </div>

  <div class="flex flex-col gap-1">
    <Label for="schedule-cwd" class="text-xs font-normal text-muted-foreground">Cwd</Label>
    <Input
      id="schedule-cwd"
      class="text-xs font-mono"
      value={cwd}
      aria-invalid={cwdError !== ""}
      placeholder="/path/to/project"
      oninput={(e) => (cwd = e.currentTarget.value)}
    />
    {#if cwdError}
      <p class="text-xs text-destructive">{cwdError}</p>
    {/if}
  </div>

  <Label for="schedule-enabled" class="text-xs font-normal">
    <input
      id="schedule-enabled"
      type="checkbox"
      class="size-3.5 accent-primary"
      checked={enabled}
      onchange={(e) => (enabled = e.currentTarget.checked)}
    />
    Enabled
  </Label>

  {#if saveError}
    <p class="text-xs text-destructive break-words">{saveError}</p>
  {/if}

  <div class="flex items-center gap-2">
    <Button size="sm" class="text-xs" disabled={saving} onclick={() => void save()}>
      {#if saving}
        <LoaderCircleIcon class="size-3.5 animate-spin" />
      {/if}
      {saving ? "Saving…" : "Save"}
    </Button>
    <Button variant="ghost" size="sm" class="text-xs" disabled={saving} onclick={closeForm}
      >Cancel</Button
    >
  </div>
{/snippet}

<div class="flex-1 overflow-y-auto overscroll-contain p-3 lg:p-4">
  <div class="flex items-center gap-2 flex-wrap">
    <!-- Below lg the page is a sheet whose header already names it, so the
       in-page heading is redundant; the count and the actions stay. -->
    <h1 class="max-lg:sr-only text-sm font-semibold">Schedules</h1>
    <span class="text-xs text-muted-foreground shrink-0">
      {ui.schedules.length}
      {ui.schedules.length === 1 ? "schedule" : "schedules"}
    </span>
    <div class="flex-1"></div>
    <Button
      variant="outline"
      size="sm"
      class="text-xs shrink-0 min-h-8"
      disabled={refreshing}
      onclick={() => void refresh()}
    >
      {#if refreshing}
        <LoaderCircleIcon class="size-3.5 animate-spin" />
      {:else}
        <RefreshIcon class="size-3.5" />
      {/if}
      Refresh
    </Button>
    <Button size="sm" class="text-xs shrink-0 min-h-8" onclick={openNew}>
      <PlusIcon class="size-3.5" />
      New
    </Button>
  </div>

  {#if editing === "new"}
    <Card class="mt-3">
      <CardHeader>
        <CardTitle class="text-sm">New schedule</CardTitle>
        <CardDescription class="text-xs">
          a run creates a session in <span class="font-mono">{cwd || "the cwd below"}</span> and sends
          the prompt
        </CardDescription>
      </CardHeader>
      <CardContent class="flex flex-col gap-3">
        {@render formFields()}
      </CardContent>
    </Card>
  {/if}

  {#if sorted.length === 0}
    <p class="mt-4 text-xs text-muted-foreground">no schedules yet — create one with New</p>
  {:else}
    <div class="mt-3 flex flex-col gap-2">
      {#each sorted as s (s.id)}
        {@const runs = historyOf(s)}
        <Card data-schedule={s.id}>
          <CardHeader class="gap-2">
            <button
              type="button"
              class="w-full text-left cursor-pointer rounded-md -m-1 p-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              data-action="expand"
              aria-expanded={editing === s.id}
              aria-label="Edit {s.name}"
              onclick={() => toggleEdit(s)}
            >
              <div class="flex items-center gap-2 min-w-0 flex-wrap">
                <CardTitle class="text-sm truncate">{s.name}</CardTitle>
                <Badge
                  variant={s.enabled ? "secondary" : "outline"}
                  class="text-[10px] font-normal shrink-0"
                >
                  {s.enabled ? "enabled" : "disabled"}
                </Badge>
                {#if s.role}
                  <Badge variant="outline" class="text-[10px] font-normal shrink-0">{s.role}</Badge>
                {/if}
                {#if runningId === s.id}
                  <LoaderCircleIcon
                    class="size-3.5 animate-spin text-muted-foreground"
                    aria-label="Running"
                  />
                {/if}
              </div>
              <CardDescription class="text-xs">
                {describeCron(s.cron)}
                <span class="font-mono text-muted-foreground">({s.cron})</span>
              </CardDescription>
              <div class="flex items-center gap-2 text-[11px] text-muted-foreground flex-wrap">
                <span class="font-mono truncate min-w-0" title={s.cwd}>{s.cwd}</span>
                <span class="shrink-0" title={fmtAbsolute(s.nextRunAt)}>
                  next {fmtRelative(s.nextRunAt)}
                </span>
                <span class="shrink-0" title={fmtAbsolute(s.lastRunAt)}>
                  last {fmtRelative(s.lastRunAt)}
                </span>
              </div>
            </button>
          </CardHeader>
          <CardContent class="flex flex-col gap-2">
            {#if editing === s.id}
              {@render formFields()}
            {:else}
              <div class="flex items-center gap-1.5 flex-wrap">
                <Button
                  variant="outline"
                  size="sm"
                  class="text-[11px] h-7"
                  data-action="toggle"
                  onclick={() => void toggleEnabled(s)}
                >
                  <PowerIcon class="size-3" />
                  {s.enabled ? "Disable" : "Enable"}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  class="text-[11px] h-7"
                  data-action="run"
                  disabled={runningId !== null}
                  onclick={() => void runNow(s)}
                >
                  <PlayIcon class="size-3" />
                  Run now
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  class="text-[11px] h-7"
                  data-action="history"
                  aria-expanded={expandedId === s.id}
                  onclick={() => toggleHistory(s.id)}
                >
                  <ClockIcon class="size-3" />
                  History
                  {#if expandedId === s.id}
                    <ChevronDownIcon class="size-3" />
                  {:else}
                    <ChevronRightIcon class="size-3" />
                  {/if}
                </Button>
                <div class="flex-1"></div>
                <Button
                  variant="destructive"
                  size="sm"
                  class="text-[11px] h-7"
                  data-action="delete"
                  onclick={() => (deleting = s)}
                >
                  <Trash2Icon class="size-3" />
                  Delete
                </Button>
              </div>
            {/if}

            {#if expandedId === s.id}
              <div class="rounded-md border border-border p-2 flex flex-col gap-1">
                {#if runs.length === 0}
                  <p class="text-xs text-muted-foreground">no runs yet</p>
                {:else}
                  {#each runs as run, i (i)}
                    <div class="flex items-start gap-2 text-[11px] min-w-0 flex-wrap">
                      <span class="shrink-0 text-muted-foreground" title={fmtRelative(run.at)}>
                        {fmtAbsolute(run.at)}
                      </span>
                      <Badge
                        variant={run.status === "ok" ? "secondary" : "destructive"}
                        class="text-[10px] font-normal shrink-0"
                      >
                        {run.status}
                      </Badge>
                      {#if run.status === "error" && run.error}
                        <span class="text-destructive break-words min-w-0">{run.error}</span>
                      {/if}
                      <div class="flex-1"></div>
                      {#if run.sessionFile}
                        <Button
                          variant="ghost"
                          size="sm"
                          class="text-[11px] h-6 px-2 shrink-0"
                          data-action="open-run"
                          onclick={() => void openRun(run)}>Open</Button
                        >
                      {/if}
                    </div>
                  {/each}
                {/if}
              </div>
            {/if}
          </CardContent>
        </Card>
      {/each}
    </div>
  {/if}
</div>

<Dialog.Root open={deleting !== null} onOpenChange={(o) => !o && (deleting = null)}>
  <Dialog.Content class="lg:max-w-[32rem]">
    <Dialog.Header>
      <Dialog.Title>Delete schedule {deleting?.name ?? ""}?</Dialog.Title>
      <Dialog.Description class="text-xs">
        Past runs are kept on disk, but the schedule stops firing. This cannot be undone from here.
      </Dialog.Description>
    </Dialog.Header>
    <Dialog.Footer>
      <Button variant="outline" size="sm" class="text-xs" onclick={() => (deleting = null)}>
        Cancel
      </Button>
      <Button
        variant="destructive"
        size="sm"
        class="text-xs"
        disabled={saving}
        data-action="confirm-delete"
        onclick={() => void confirmDelete()}
      >
        Delete
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
