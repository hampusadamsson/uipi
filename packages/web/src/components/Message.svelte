<script lang="ts">
  import { ui } from "../lib/state.svelte";
  import type { TranscriptEntry } from "../lib/transcript.js";

  let { entry }: { entry: TranscriptEntry } = $props();
  let expanded = $state(true);

  const isUser = $derived(entry.role === "user");
  const isAssistant = $derived(entry.role === "assistant");
</script>

<div class="my-2">
  {#if isUser}
    <div class="flex justify-end">
      <div class="max-w-[80%] bg-indigo-900/40 border border-indigo-800/50 rounded-lg px-3 py-2 text-sm whitespace-pre-wrap">{entry.text}</div>
    </div>
  {:else if isAssistant || entry.toolCalls.length > 0}
    <div class="max-w-[90%]">
      {#if entry.text}
        {@render Md(entry.text)}
      {/if}
      {#each entry.toolCalls as tc, i (i)}
        <details class="mt-1 border border-zinc-800 rounded" open={expanded}>
          <summary class="cursor-pointer text-xs px-2 py-1 flex gap-2 items-center">
            <span class="font-mono {tc.isError ? 'text-red-400' : 'text-emerald-400'}">{tc.name}</span>
            <span class="text-zinc-500 truncate flex-1">{tc.argsPreview}</span>
            {#if !tc.done}<span class="text-zinc-500 animate-pulse">running…</span>{/if}
          </summary>
          <pre class="text-xs bg-zinc-950 border-t border-zinc-800 px-2 py-1 max-h-64 overflow-auto whitespace-pre-wrap">{tc.output || "…"}</pre>
        </details>
      {/each}
    </div>
  {:else}
    <div class="text-xs text-zinc-500 my-1">— {entry.text || entry.kind} —</div>
  {/if}
</div>

{#snippet Md(text: string)}
  <div class="text-sm prose prose-invert prose-sm max-w-none">{text}</div>
{/snippet}
