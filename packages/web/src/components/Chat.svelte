<script lang="ts">
  import { ui } from "$lib/state.svelte";
  import { deriveTranscript, type TranscriptEntry } from "$lib/transcript.js";
  import Message from "./Message.svelte";
  import InputBox from "./InputBox.svelte";
  import * as ScrollArea from "$lib/components/ui/scroll-area/index.js";

  let { sessionId }: { sessionId: string } = $props();

  const attach = $derived(ui.attached.get(sessionId));
  const entries = $derived<TranscriptEntry[]>(
    attach ? deriveTranscript({ messages: attach.messages ?? [], events: attach.events ?? [] }) : []
  );
  const isStreaming = $derived(bind(attach));

  let scroller: HTMLElement | null = $state(null);
  $effect(() => {
    entries.length;
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  });

  function bind(a: unknown): boolean {
    return Boolean(a && (a as { isStreaming?: boolean }).isStreaming);
  }
</script>

<div
  bind:this={scroller}
  class="flex-1 overflow-y-auto px-4 py-3"
>
  {#each entries as e, i (e.id + ":" + i)}
    <Message entry={e} />
  {/each}
  {#if isStreaming}
    <div class="text-xs text-muted-foreground animate-pulse my-2">working…</div>
  {/if}
</div>
<InputBox {sessionId} />
