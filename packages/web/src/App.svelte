<script lang="ts">
  import type { Attachment } from "@uipi/protocol";
import { ui } from "./lib/state.svelte";
  import Sidebar from "./components/Sidebar.svelte";
  import Chat from "./components/Chat.svelte";
  import NewSessionModal from "./components/NewSessionModal.svelte";
  import UiEventModal from "./components/UiEventModal.svelte";
  import ModelPicker from "./components/ModelPicker.svelte";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Separator } from "$lib/components/ui/separator/index.js";
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

  const attach = $derived(
    ui.activeId
      ? (ui.attached.get(ui.activeId) as
          | (Attachment & { model?: { provider: string; modelId: string } | null })
          | undefined)
      : undefined
  );
</script>

<div class="flex h-screen bg-background text-foreground">
  <Sidebar />
  <main class="flex-1 flex flex-col min-w-0">
    {#if attach}
      <header class="flex items-center gap-3 border-b border-border px-4 py-2">
        <span class="text-sm font-semibold truncate">{attach.cwd}</span>
        <span class="text-xs text-muted-foreground">
          {attach.model?.provider}/{attach.model?.modelId} · {attach.thinkingLevel}
        </span>
        <div class="flex-1"></div>
        <ModelPicker sessionId={attach.sessionId} />
        <Button variant="outline" size="sm" class="text-xs" onclick={() => ui.cmd({ type: "pi.compact", sessionId: attach.sessionId })}>
          Compact
        </Button>
      </header>
      <Chat sessionId={attach.sessionId} />
    {:else}
      <div class="flex-1 grid place-items-center text-muted-foreground">
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
<Toaster position="bottom-right" richColors />
