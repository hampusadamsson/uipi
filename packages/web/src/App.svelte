<script lang="ts">
  import type { Component } from "svelte";
  import type { Attachment } from "@uipi/protocol";
  import { ui, type RunState, type PageId } from "./lib/state.svelte";
  import { fmtCtx } from "./lib/format";
  import { isDesktop } from "./lib/viewport.svelte";
  import Sidebar from "./components/Sidebar.svelte";
  import Chat from "./components/Chat.svelte";
  import SkillsPage from "./components/SkillsPage.svelte";
  import SchedulesPage from "./components/SchedulesPage.svelte";
  import SettingsPage from "./components/SettingsPage.svelte";
  import NewSessionModal from "./components/NewSessionModal.svelte";
  import UiEventModal from "./components/UiEventModal.svelte";
  import ModelPicker from "./components/ModelPicker.svelte";
  import ThinkingPicker from "./components/ThinkingPicker.svelte";
  import RolePicker from "./components/RolePicker.svelte";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Badge } from "$lib/components/ui/badge/index.js";
  import { Toaster } from "$lib/components/ui/sonner/index.js";
  import { Sheet } from "$lib/components/ui/sheet/index.js";
  import * as Tabs from "$lib/components/ui/tabs/index.js";
  import MenuIcon from "@lucide/svelte/icons/menu";
  import EllipsisIcon from "@lucide/svelte/icons/ellipsis";
  import MessageSquareIcon from "@lucide/svelte/icons/message-square";
  import SparklesIcon from "@lucide/svelte/icons/sparkles";
  import CalendarClockIcon from "@lucide/svelte/icons/calendar-clock";
  import SettingsIcon from "@lucide/svelte/icons/settings";
  import ChevronRightIcon from "@lucide/svelte/icons/chevron-right";
  import CheckIcon from "@lucide/svelte/icons/check";
  import PlusIcon from "@lucide/svelte/icons/plus";
  import { toast } from "svelte-sonner";

  // top-level tabs besides Sessions: an id here is also the page id selectTab
  // routes to, so a row and its route can't disagree
  const pages = [
    { id: "skills", label: "Skills", hint: "discovered for this project" },
    { id: "schedules", label: "Schedules", hint: "cron sessions" },
    { id: "settings", label: "Settings", hint: "general, roles, sandbox, mcp" },
  ] as const;

  /** the same destinations as a mobile list, with the icons a sheet row needs */
  const views: { id: "sessions" | PageId; label: string; hint: string; icon: Component }[] = [
    { id: "sessions", label: "Sessions", hint: "browse and create", icon: MessageSquareIcon },
    ...pages.map((p) => ({ id: p.id, label: p.label, hint: p.hint, icon: pageIcon(p.id) })),
  ];

  function pageIcon(id: PageId): Component {
    if (id === "skills") return SparklesIcon;
    if (id === "schedules") return CalendarClockIcon;
    return SettingsIcon;
  }

  // the URL owns the selection: no separate tab state to drift from ui.page
  const activeTab = $derived(ui.page);
  const onSkills = $derived(ui.page === "skills");
  const onSchedules = $derived(ui.page === "schedules");
  const onSettings = $derived(ui.page === "settings");
  // any page route (not a session view) hides the session-only header controls
  const onPage = $derived(ui.page !== "sessions");

  function selectTab(value: string) {
    if (value === "sessions") ui.goToSessionsPage();
    else ui.goToPage(value as PageId);
  }

  $effect(() => {
    if (ui.error) {
      toast.error(ui.error);
      // surface once, then clear at the source so a re-render can't re-toast
      ui.clearError();
    }
  });

  // schedules are server state the tabs don't load for us: fetch them as soon as
  // the socket is up (which on mount means "on mount"), so the Schedules tab has
  // the list and its next-run times ready without a manual Refresh
  $effect(() => {
    if (!ui.connected) return;
    void ui.refreshSchedules().catch(() => {
      /* a failed load is already surfaced by the client's error toast */
    });
  });

  // ---------------------------------------------------------------- mobile
  //
  // Below `lg` the desktop chrome cannot fit (a rail + tabs + chips + Stop on a
  // 390px screen), so everything moves into two modal surfaces:
  //
  //   * the sessions drawer (left sheet) — the mobile form of the rail
  //   * the navigation sheet (bottom sheet) — a *drill-down*: a list of views,
  //     then the chosen view in place, with a back chevron to the list
  //
  // Drill-down rather than a sheet per page: stacking modals is how mobile apps
  // get the "which close button closes what" problem, and a back chevron inside
  // one sheet is the pattern a phone user already knows.
  //
  // The URL still owns *which page* is showing. `navOpen` only says whether the
  // sheet is up; `screen` says whether it shows the list or a page, and a page
  // is showing exactly when the route names one.
  let drawerOpen = $state(false);
  let navOpen = $state(false);
  const pageScreen = $derived(!isDesktop.current && ui.page !== "sessions");
  const navSheetOpen = $derived(navOpen || pageScreen);
  const navLabel = $derived(pages.find((p) => p.id === ui.page)?.label ?? "");
  const navHint = $derived(pages.find((p) => p.id === ui.page)?.hint ?? "");

  // The mobile surfaces are unmounted at `lg`, so their open flags would
  // otherwise survive a rotation and pop a sheet open unasked when the window
  // narrows again. Reset them at the moment the layouts swap.
  let wasDesktop = $state(isDesktop.current);
  $effect(() => {
    const now = isDesktop.current;
    if (now && !wasDesktop) {
      drawerOpen = false;
      navOpen = false;
    }
    wasDesktop = now;
  });

  /**
   * A sheet closed by Esc, by the backdrop, by the X or by the Android back
   * gesture means "leave whatever is on screen". On a page that is a
   * navigation, and it *replaces* the history entry: closing must not leave the
   * page behind for the back gesture to reopen.
   */
  function closeNav(open: boolean) {
    if (open) {
      navOpen = true;
      return;
    }
    navOpen = false;
    if (ui.page !== "sessions") ui.goToSessionsPage(true);
  }

  /** the chevron inside a page: back to the list, sheet stays up */
  function navBackToList() {
    if (ui.page !== "sessions") ui.goToSessionsPage(true);
    navOpen = true;
  }

  function pickView(id: "sessions" | PageId) {
    if (id === "sessions") {
      // the sessions *list* is the drawer: this row opens it, so the navigation
      // sheet has to get out of the way first
      closeNav(false);
      drawerOpen = true;
      return;
    }
    // stay in the sheet: the chosen view replaces the list in place
    navOpen = true;
    ui.goToPage(id);
  }

  const attach = $derived(
    ui.activeId
      ? (ui.attached.get(ui.activeId) as
          (Attachment & { model?: { provider: string; modelId: string } | null }) | undefined)
      : undefined,
  );
  const modelShown = $derived(ui.modelOf(ui.activeId));
  // the active session's own name, or nothing: no placeholder when unnamed
  const sessionName = $derived(ui.sessionNameOf(ui.activeId));
  const run = $derived<RunState>(ui.stateOf(ui.activeId));
  const runLabel = $derived<Record<RunState, string>>({
    idle: "idle",
    thinking: "thinking…",
    streaming: "responding…",
    tooling: "using tools…",
  });
  /** the mobile title bar: the session's own name, else the project, else "uipi" */
  const mobileTitle = $derived(
    attach ? (sessionName ?? attach.cwd.split("/").pop() ?? attach.cwd) : (sessionName ?? "uipi"),
  );
  const mobileSubtitle = $derived(attach ? attach.cwd : "no session attached");
</script>

{#snippet pageContent()}
  {#if onSkills}
    <SkillsPage />
  {:else if onSchedules}
    <SchedulesPage />
  {:else if onSettings}
    <SettingsPage />
  {/if}
{/snippet}

{#snippet sessionContent()}
  {#if attach}
    <Chat sessionId={attach.sessionId} />
  {:else}
    <div class="flex-1 grid place-items-center text-muted-foreground p-4">
      <div class="text-center">
        <div class="text-lg font-semibold mb-2">uipi</div>
        <div class="text-sm mb-4">no session attached</div>
        <div class="flex flex-col items-stretch gap-2">
          <Button onclick={() => (ui.wantNew = true)}>
            <PlusIcon class="size-4" />
            New session
          </Button>
          <Button variant="outline" onclick={() => (drawerOpen = true)}>
            <MessageSquareIcon class="size-4" />
            Browse sessions
          </Button>
        </div>
      </div>
    </div>
  {/if}
{/snippet}

{#snippet sessionControls()}
  <!-- Chips first, then Stop outside them: a control you must hunt for is a
       bug. The chips themselves may scroll when a long role name meets a long
       model id on a 320px screen — never the page, and never Stop. -->
  <div
    class="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto overscroll-x-contain lg:basis-auto lg:gap-1.5"
    aria-label="Session controls"
  >
    <RolePicker sessionId={attach!.sessionId} />
    <ThinkingPicker sessionId={attach!.sessionId} />
    <ModelPicker sessionId={attach!.sessionId} />
  </div>
  {#if run !== "idle"}
    <Button
      variant="destructive"
      size="sm"
      class="shrink-0 text-xs max-lg:min-h-9"
      onclick={() => ui.abort(attach!.sessionId)}>Stop</Button
    >
  {/if}
{/snippet}

{#if isDesktop.current}
  <div class="flex h-[100dvh] bg-background text-foreground overflow-hidden">
    <!-- The sidebar is a permanent rail from lg up. -->
    <div class="relative flex shrink-0">
      <Sidebar />
    </div>

    <main class="flex flex-1 flex-col min-w-0">
      <header
        class="flex flex-wrap items-center gap-x-2 gap-y-1.5 border-b border-border px-3 lg:px-4 py-2 pt-[max(0.5rem,env(safe-area-inset-top))]"
      >
        <div class="min-w-0 shrink-0">
          <Tabs.Root value={activeTab} onValueChange={selectTab}>
            <Tabs.List class="h-8 text-xs">
              <Tabs.Trigger value="sessions" class="text-xs px-2.5">Sessions</Tabs.Trigger>
              {#each pages as p (p.id)}
                <Tabs.Trigger value={p.id} class="text-xs px-2.5">{p.label}</Tabs.Trigger>
              {/each}
            </Tabs.List>
          </Tabs.Root>
        </div>
        {#if attach && !onPage}
          <div class="hidden min-w-0 flex-1 overflow-hidden items-center gap-2 lg:flex">
            <span class="text-sm font-semibold truncate min-w-0" title={attach.cwd}>
              {attach.cwd.split("/").pop() || attach.cwd}
            </span>
            <span class="text-xs text-muted-foreground truncate min-w-0 hidden xl:inline">
              {modelShown?.provider}/{modelShown?.modelId} · {attach.thinkingLevel}
            </span>
            {#if sessionName}
              <span
                class="text-xs font-medium truncate min-w-0 max-w-40 shrink hidden xl:inline"
                title={sessionName}>{sessionName}</span
              >
            {/if}
            {#if ui.contextTokens.get(attach.sessionId)}
              <Badge
                variant="outline"
                class="text-[10px] shrink-0 font-normal hidden xl:inline-flex"
              >
                {fmtCtx(ui.contextTokens.get(attach.sessionId) ?? 0)}
              </Badge>
            {/if}
          </div>
          <div class="flex w-full min-w-0 items-center gap-2 lg:w-auto lg:shrink-0">
            <Badge
              variant="secondary"
              class="text-[10px] shrink-0 {run === 'idle' ? '' : 'animate-pulse'}"
              >{runLabel[run]}</Badge
            >
            {@render sessionControls()}
          </div>
        {:else}
          <div class="flex-1"></div>
        {/if}
      </header>

      {#if onPage}
        {@render pageContent()}
      {:else}
        {@render sessionContent()}
      {/if}
    </main>
  </div>
{:else}
  <div class="flex h-[100dvh] bg-background text-foreground overflow-hidden">
    <main class="flex flex-1 flex-col min-w-0">
      <!-- Mobile title bar: identity on the first line, session chips on the
           second. There is no tab strip — four tabs plus the chips do not fit a
           phone, and a sideways-scrolling tab row hides the page you want. -->
      <header
        class="shrink-0 border-b border-border px-1.5 pt-[max(0.5rem,env(safe-area-inset-top))] pb-2"
      >
        <div class="flex min-w-0 items-center gap-0.5">
          <Button
            variant="ghost"
            size="icon-sm"
            class="shrink-0"
            aria-label="Sessions"
            onclick={() => (drawerOpen = true)}
          >
            <MenuIcon />
          </Button>
          <div class="min-w-0 flex-1 px-1">
            <div class="flex min-w-0 items-center gap-1.5">
              <span class="truncate text-sm font-semibold">{mobileTitle}</span>
              {#if run !== "idle" && !onPage}
                <Badge variant="secondary" class="shrink-0 animate-pulse text-[10px]"
                  >{runLabel[run]}</Badge
                >
              {/if}
            </div>
            <div class="truncate text-[10px] text-muted-foreground" title={mobileSubtitle}>
              {mobileSubtitle}
            </div>
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            class="shrink-0"
            aria-label="Views and settings"
            onclick={() => (navOpen = true)}
          >
            <EllipsisIcon />
          </Button>
        </div>

        {#if attach && !onPage}
          <div class="mt-1.5 flex min-w-0 items-center gap-1">
            {@render sessionControls()}
          </div>
        {/if}
      </header>

      {@render sessionContent()}
    </main>
  </div>

  <!-- Sessions: a full-height drawer, the mobile form of the desktop rail. -->
  <Sheet side="left" title="Sessions" showHeader={false} bind:open={drawerOpen}>
    <Sidebar onAfterSelect={() => (drawerOpen = false)} onClose={() => (drawerOpen = false)} />
  </Sheet>

  <!-- Navigation: one sheet, two screens — the view list, or the picked view. -->
  <Sheet
    full={pageScreen}
    title={pageScreen ? navLabel : "uipi"}
    description={pageScreen ? navHint : "views and settings"}
    onBack={pageScreen ? navBackToList : undefined}
    padded={!pageScreen}
    open={navSheetOpen}
    onOpenChange={closeNav}
  >
    {#if pageScreen}
      {@render pageContent()}
    {:else}
      <div class="flex flex-col gap-1">
        {#each views as v (v.id)}
          {@const Current = v.icon}
          {@const current = v.id === ui.page}
          <button
            type="button"
            data-view={v.id}
            aria-current={current ? "page" : undefined}
            class="flex min-h-14 w-full items-center gap-2.5 rounded-lg px-3 text-left transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none {current
              ? 'bg-accent/60'
              : ''}"
            onclick={() => pickView(v.id)}
          >
            <Current class="size-4 shrink-0 {current ? 'text-primary' : 'text-muted-foreground'}" />
            <span class="min-w-0 flex-1">
              <span class="block truncate text-sm {current ? 'font-medium' : ''}">{v.label}</span>
              <span class="block truncate text-[10px] text-muted-foreground">{v.hint}</span>
            </span>
            {#if current}
              <CheckIcon class="size-4 shrink-0 text-primary" />
            {:else}
              <ChevronRightIcon class="size-4 shrink-0 text-muted-foreground" />
            {/if}
          </button>
        {/each}
      </div>
      <div class="mt-3 border-t border-border pt-3">
        <Button
          class="w-full min-h-11"
          onclick={() => {
            closeNav(false);
            ui.wantNew = true;
          }}
        >
          <PlusIcon class="size-4" />
          New session
        </Button>
      </div>
    {/if}
  </Sheet>
{/if}

<NewSessionModal />
<UiEventModal />
<Toaster position="top-center" richColors />
