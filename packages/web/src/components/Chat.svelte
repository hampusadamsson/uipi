<script lang="ts">
  import { ui } from "$lib/state.svelte";
  import type { TranscriptEntry } from "@uipi/client";
  import Message from "./Message.svelte";
  import InputBox from "./InputBox.svelte";
  import { Button } from "$lib/components/ui/button/index.js";
  import ArrowDownIcon from "@lucide/svelte/icons/arrow-down";

  let { sessionId }: { sessionId: string } = $props();

  const entries = $derived<TranscriptEntry[]>(ui.transcript(sessionId));
  const run = $derived(ui.stateOf(sessionId));
  // A failed request pi is retrying: the run stays "thinking" for the whole
  // backoff, so name the reason or it reads as a hang.
  const retry = $derived(ui.retry.get(sessionId));

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
    void entries.length;
    void ui.liveEvents.get(sessionId)?.length;
    void ui.sentMessages.get(sessionId)?.length;
    if (scroller && pinned) scroller.scrollTop = scroller.scrollHeight;
  });
</script>

<div class="relative flex-1 min-h-0">
  <div
    bind:this={scroller}
    onscroll={onScroll}
    class="h-full overflow-y-auto overscroll-contain px-3 lg:px-4 py-3"
    role="log"
    aria-live="polite"
  >
    {#each entries as e, i (e.id + ":" + i)}
      <Message entry={e} />
    {/each}
    {#if run !== "idle"}
      <div class="my-1.5 flex items-center gap-1.5">
        <span class="inline-block w-1.5 h-1.5 rounded-full bg-primary animate-ping"></span>
        {#if retry}
          <span class="text-[11px] text-destructive" data-testid="retry-notice">
            retrying {retry.attempt}/{retry.maxAttempts} — {retry.message}
          </span>
        {:else}
          <span class="text-[11px] text-muted-foreground">
            assistant · {run === "thinking"
              ? "thinking"
              : run === "tooling"
                ? "running tools"
                : "responding"}
          </span>
        {/if}
      </div>
    {/if}
  </div>
  {#if !pinned}
    <Button
      variant="outline"
      size="icon-sm"
      class="absolute bottom-3 right-3 shadow-md rounded-full"
      aria-label="Scroll to latest"
      onclick={scrollToBottom}><ArrowDownIcon /></Button
    >
  {/if}
</div>
<InputBox {sessionId} />
