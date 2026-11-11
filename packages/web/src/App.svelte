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
      class="fixed inset-0 bg-black/60 z-30 md:hidden"
      aria-label="Close menu"
      onclick={closeSidebar}
    ></button>
  {/if}
  <div
    class="fixed inset-y-0 left-0 z-40 transition-transform duration-200 md:relative md:translate-x-0
           {sidebarOpen ? 'translate-x-0' : '-translate-x-full'}"
  >
    <Sidebar onAfterSelect={closeSidebar} />
  </div>

  <main class="flex-1 flex flex-col min-w-0">
    <header class="flex items-center gap-2 border-b border-border px-3 md:px-4 py-2">
      <Button
        variant="ghost"
        size="icon-sm"
        class="md:hidden shrink-0"
        aria-label="Menu"
        onclick={toggleSidebar}><MenuIcon /></Button
      >
      <Tabs.Root value={activeTab} onValueChange={selectTab} class="shrink-0">
        <Tabs.List class="h-7 text-xs">
          <Tabs.Trigger value="sessions" class="text-xs px-2">Sessions</Tabs.Trigger>
          {#each pages as p (p.id)}
            <Tabs.Trigger value={p.id} class="text-xs px-2">{p.label}</Tabs.Trigger>
          {/each}
        </Tabs.List>
      </Tabs.Root>
      {#if attach && !onPage}
        <span class="text-sm font-semibold truncate hidden sm:inline">{attach.cwd}</span>
        <span class="text-xs text-muted-foreground truncate sm:hidden">
          {attach.cwd.split("/").pop()}
        </span>
        <Badge
          variant="secondary"
          class="text-[10px] shrink-0 {run === 'idle' ? '' : 'animate-pulse'}"
          >{runLabel[run]}</Badge
        >
        {#if sessionName}
          <span class="text-xs font-medium truncate max-w-40 md:max-w-64 shrink" title={sessionName}
            >{sessionName}</span
          >
        {/if}
        <span class="text-xs text-muted-foreground hidden lg:inline">
          {modelShown?.provider}/{modelShown?.modelId} · {attach.thinkingLevel}
        </span>
        {#if ui.contextTokens.get(attach.sessionId)}
          <Badge variant="outline" class="text-[10px] shrink-0 font-normal">
            {fmtCtx(ui.contextTokens.get(attach.sessionId) ?? 0)}
          </Badge>
        {/if}
        <div class="flex-1"></div>
        <RolePicker sessionId={attach.sessionId} />
        <ThinkingPicker sessionId={attach.sessionId} />
        <ModelPicker sessionId={attach.sessionId} />
        {#if run !== "idle"}
          <Button
            variant="destructive"
            size="sm"
            class="text-xs shrink-0"
            onclick={() => ui.abort(attach.sessionId)}>Stop</Button
          >
        {/if}
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
