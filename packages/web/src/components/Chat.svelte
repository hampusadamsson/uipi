<script lang="ts">
  import { ui } from "$lib/state.svelte";
  import { deriveTranscript, type TranscriptEntry } from "$lib/transcript.js";
  import Message from "./Message.svelte";
  import InputBox from "./InputBox.svelte";
  import { Button } from "$lib/components/ui/button/index.js";

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
  let pinned = $state(true);

  function nearBottom(el: HTMLElement): boolean {
    return el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }

  function onScroll() {
    if (scroller) pinned = nearBottom(scroller);
  }

  function scrollToBottom() {
    if (scroller) {
      scroller.scrollTop = scroller.scrollHeight;
      pinned = true;
    }
  }

  $effect(() => {
    // track reactive deps: lengths change on every push
    const n = entries.length;
    void live.length;
    void sent.length;
    if (scroller && pinned) scroller.scrollTop = scroller.scrollHeight;
  });
</script>

<div class="relative flex-1 min-h-0">
  <div
    bind:this={scroller}
    onscroll={onScroll}
    class="h-full overflow-y-auto overscroll-contain px-3 md:px-4 py-3"
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
  {#if !pinned}
    <Button
      variant="outline"
      size="icon-sm"
      class="absolute bottom-3 right-3 shadow-md rounded-full"
      aria-label="Scroll to latest"
      onclick={scrollToBottom}
    >↓</Button>
  {/if}
</div>
<InputBox {sessionId} />
