<script lang="ts">
  import type { Attachment } from "@uipi/protocol";
  import { ui, type RunState, type PageId } from "./lib/state.svelte";
  import { fmtCtx } from "./lib/format";
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
  import * as Tabs from "$lib/components/ui/tabs/index.js";
  import MenuIcon from "@lucide/svelte/icons/menu";
  import { toast } from "svelte-sonner";

  // top-level tabs besides Sessions: an id here is also the page id selectTab
  // routes to, so a row and its route can't disagree
  const pages = [
    { id: "skills", label: "Skills" },
    { id: "schedules", label: "Schedules" },
    { id: "settings", label: "Settings" },
  ] as const;

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

  let sidebarOpen = $state(false);

  function toggleSidebar() {
    sidebarOpen = !sidebarOpen;
  }
  function closeSidebar() {
    sidebarOpen = false;
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
</script>

<div class="flex h-[100dvh] bg-background text-foreground overflow-hidden">
  {#if sidebarOpen}
    <button
      class="fixed inset-0 bg-black/60 z-30 lg:hidden"
      aria-label="Close menu"
      onclick={closeSidebar}
    ></button>
  {/if}
  <!-- The drawer stays a drawer until lg: at md a permanent 288px sidebar left
       the content only 480px, narrower than a phone, so the header and the forms
       were worse off at 768px than at 640px. -->
  <div
    class="fixed inset-y-0 left-0 z-40 transition-transform duration-200 lg:relative lg:translate-x-0
           {sidebarOpen ? 'translate-x-0' : '-translate-x-full'}"
  >
    <Sidebar onAfterSelect={closeSidebar} />
  </div>

  <main class="flex flex-1 flex-col min-w-0">
    <!-- Wraps instead of scrolling as a whole: below lg the tabs get the first
         line and the session controls get the second; from lg up it is one row.
         Inside each line the *strips* scroll, and Stop always stays outside the
         picker scroller — a control you must scroll sideways to find is a bug. -->
    <header
      class="flex flex-wrap items-center gap-x-2 gap-y-1.5 border-b border-border px-3 md:px-4 py-2 pt-[max(0.5rem,env(safe-area-inset-top))]"
    >
      <Button
        variant="ghost"
        size="icon-sm"
        class="lg:hidden shrink-0"
        aria-label="Menu"
        onclick={toggleSidebar}><MenuIcon /></Button
      >
      <!-- `basis-0` here is load-bearing: with an `auto` basis a scroll strip's
           min-content width (the full row of tabs inside it) sets the page's
           min-content width, and a phone browser then widens the layout viewport
           past the device — the whole page scrolls sideways. A zero basis lets
           the strip shrink and scroll inside its own box. -->
      <div
        class="min-w-0 basis-0 grow shrink overflow-x-auto overscroll-x-contain lg:grow-0 lg:shrink-0 lg:basis-auto lg:overflow-visible"
      >
        <Tabs.Root value={activeTab} onValueChange={selectTab}>
          <Tabs.List class="h-8 text-xs md:h-7">
            <Tabs.Trigger value="sessions" class="text-xs px-2.5">Sessions</Tabs.Trigger>
            {#each pages as p (p.id)}
              <Tabs.Trigger value={p.id} class="text-xs px-2.5">{p.label}</Tabs.Trigger>
            {/each}
          </Tabs.List>
        </Tabs.Root>
      </div>
      {#if attach && !onPage}
        <!-- The session's identity, from lg up: the cwd always, the rest once
             there is room. It is `flex-1` (a zero basis) for two reasons — it
             absorbs the leftover width so the controls sit right-aligned, and in
             a wrapping flex container a content-sized item makes the *line* wrap
             rather than shrink, which pushed the controls to a second row at
             1280px. `overflow-hidden` stops a long cwd forcing the row wider. -->
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
            <Badge variant="outline" class="text-[10px] shrink-0 font-normal hidden xl:inline-flex">
              {fmtCtx(ui.contextTokens.get(attach.sessionId) ?? 0)}
            </Badge>
          {/if}
        </div>
        <!-- The control group: its own full-width line below lg, content-sized
             from lg up. -->
        <div class="flex w-full min-w-0 items-center gap-2 lg:w-auto lg:shrink-0">
          <Badge
            variant="secondary"
            class="text-[10px] shrink-0 {run === 'idle' ? '' : 'animate-pulse'}"
            >{runLabel[run]}</Badge
          >
          <!-- Scrolls at every width rather than going `overflow-visible` at
               lg: a wide session's chips can still overrun a 1024px header, and
               restoring visible overflow there clipped the pickers away. It is
               content-sized (`basis-auto`) so it only scrolls when the chips
               really have run out of room. Stop stays outside this box, so it
               is always reachable. -->
          <div
            class="flex min-w-0 shrink basis-auto items-center gap-1.5 overflow-x-auto overscroll-x-contain"
            aria-label="Session controls"
          >
            <RolePicker sessionId={attach.sessionId} />
            <ThinkingPicker sessionId={attach.sessionId} />
            <ModelPicker sessionId={attach.sessionId} />
          </div>
          {#if run !== "idle"}
            <Button
              variant="destructive"
              size="sm"
              class="text-xs shrink-0"
              onclick={() => ui.abort(attach.sessionId)}>Stop</Button
            >
          {/if}
        </div>
      {:else}
        <div class="flex-1"></div>
      {/if}
    </header>
    {#if onSkills}
      <SkillsPage />
    {:else if onSchedules}
      <SchedulesPage />
    {:else if onSettings}
      <SettingsPage />
    {:else if attach}
      <Chat sessionId={attach.sessionId} />
    {:else}
      <div class="flex-1 grid place-items-center text-muted-foreground p-4">
        <div class="text-center">
          <div class="text-lg font-semibold mb-2">uipi</div>
          <div class="text-sm mb-4">no session attached</div>
          <Button onclick={() => (ui.wantNew = true)}>New session</Button>
        </div>
      </div>
    {/if}
  </main>
</div>

<NewSessionModal />
<UiEventModal />
<Toaster position="top-center" richColors />
