<script lang="ts">
  import { ui } from "./lib/state.svelte";
  import type { Attachment } from "@uipi/protocol";
  import Sidebar from "./components/Sidebar.svelte";
  import Chat from "./components/Chat.svelte";
  import NewSessionModal from "./components/NewSessionModal.svelte";
  import UiEventModal from "./components/UiEventModal.svelte";
  import ModelPicker from "./components/ModelPicker.svelte";

  type AttachmentModelOptions = { model?: { provider: string; modelId: string } | null };
  const attach = $derived(ui.activeId ? ui.attached.get(ui.activeId) as (Attachment & AttachmentModelOptions) | undefined : undefined);
</script>

<div class="flex h-screen">
  <Sidebar />
  <main class="flex-1 flex flex-col min-w-0">
    {#if attach}
      <header class="flex items-center gap-3 border-b border-zinc-800 px-4 py-2">
        <span class="text-sm font-semibold">{attach.cwd}</span>
        <span class="text-xs text-zinc-500">
          {attach.model?.provider}/{attach.model?.modelId} · {attach.thinkingLevel}
        </span>
        <ModelPicker sessionId={attach.sessionId} />
        <button
          class="text-xs text-zinc-400 hover:text-zinc-200 border border-zinc-700 rounded px-2 py-0.5"
          onclick={() => ui.cmd({ type: "pi.compact", sessionId: attach.sessionId })}
        >Compact</button>
      </header>
      <Chat sessionId={attach.sessionId} />
    {:else}
      <div class="flex-1 grid place-items-center text-zinc-600">
        <div class="text-center">
          <div class="text-lg mb-2">uipi</div>
          <div class="text-sm">no session attached</div>
          <button
            class="mt-4 rounded bg-indigo-600 hover:bg-indigo-500 text-white text-sm px-4 py-2"
            onclick={() => (ui.wantNew = true)}
          >New session</button>
        </div>
      </div>
    {/if}
  </main>
</div>

{#if ui.wantNew}
  <NewSessionModal />
{/if}
{#if ui.uiEvents.length > 0}
  <UiEventModal />
{/if}
{#if ui.error}
  <div class="fixed bottom-3 right-3 bg-red-900/90 text-red-100 text-xs rounded px-3 py-2 max-w-md">
    {ui.error}
  </div>
{/if}
