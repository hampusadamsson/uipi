<script lang="ts">
  import { ui } from "$lib/state.svelte";
  import { deriveTranscript, type TranscriptEntry } from "$lib/transcript.js";
  import Message from "./Message.svelte";
  import InputBox from "./InputBox.svelte";

  let { sessionId }: { sessionId: string } = $props();

  const attach = $derived(ui.attached.get(sessionId));
  const live = $derived(ui.liveEvents.get(sessionId) ?? []);
  const sent = $derived(ui.sentMessages.get(sessionId) ?? []);
  const entries = $derived<TranscriptEntry[]>(
    attach
      ? deriveTranscript({ messages: attach.messages ?? [], events: live, sentMessages: sent })
      : []
  );
  const run = $derived(ui.stateOf(sessionId));

  let scroller: HTMLElement | null = $state(null);
  $effect(() => {
    // track reactive deps: array lengths change on every push
    const n = entries.length;
    void live.length; void sent.length;
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  });
</script>

<div
  bind:this={scroller}
  class="flex-1 overflow-y-auto overscroll-contain px-3 md:px-4 py-3"
  role="log"
  aria-live="polite"
>
  {#each entries as e, i (e.id + ":" + i)}
    <Message entry={e} />
  {/each}
  {#if run !== "idle"}
    <div class="text-xs text-muted-foreground animate-pulse my-2 flex items-center gap-2">
      <span class="inline-block w-1.5 h-1.5 rounded-full bg-primary animate-ping"></span>
      {run === "thinking"
        ? "thinking…"
        : run === "tooling"
          ? "running tools…"
          : "responding…"}
    </div>
  {/if}
</div>
<InputBox {sessionId} />
