<script lang="ts">
  import type { Attachment } from "@uipi/protocol";
  import { ui } from "./lib/state.svelte";
  import Sidebar from "./components/Sidebar.svelte";
  import Chat from "./components/Chat.svelte";
  import NewSessionModal from "./components/NewSessionModal.svelte";
  import UiEventModal from "./components/UiEventModal.svelte";
  import ModelPicker from "./components/ModelPicker.svelte";
  import ThinkingPicker from "./components/ThinkingPicker.svelte";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Toaster } from "$lib/components/ui/sonner/index.js";
  import { toast } from "svelte-sonner";

  let lastError = $state<string | null>(null);
  $effect(() => {
    if (ui.error && ui.error !== lastError) {
      lastError = ui.error;
      toast.error(ui.error);
    }
    if (!ui.error) lastError = null;
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
          | (Attachment & { model?: { provider: string; modelId: string } | null })
          | undefined)
      : undefined
  );
</script>

<div class="flex h-[100dvh] bg-background text-foreground overflow-hidden">
  <!-- mobile drawer + backdrop -->
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
    {#if attach}
      <header class="flex items-center gap-2 border-b border-border px-3 md:px-4 py-2">
        <Button
          variant="ghost"
          size="icon-sm"
          class="md:hidden shrink-0"
          aria-label="Menu"
          onclick={toggleSidebar}
        >☰</Button>
        <span class="text-sm font-semibold truncate hidden sm:inline">{attach.cwd}</span>
        <span class="text-xs text-muted-foreground truncate sm:hidden">
          {attach.cwd.split("/").pop()}
        </span>
        <span class="text-xs text-muted-foreground hidden lg:inline">
          {attach.model?.provider}/{attach.model?.modelId} · {attach.thinkingLevel}
        </span>
        <div class="flex-1"></div>
        <ThinkingPicker sessionId={attach.sessionId} />
        <ModelPicker sessionId={attach.sessionId} />
        <Button
          variant="outline"
          size="sm"
          class="text-xs hidden md:inline-flex"
          onclick={() => ui.cmd({ type: "pi.compact", sessionId: attach.sessionId })}
        >Compact</Button>
      </header>
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
