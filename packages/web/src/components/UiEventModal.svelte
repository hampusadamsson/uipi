<script lang="ts">
  import { ui } from "../lib/state.svelte";
  import type { UiSelectRequest, UiDialogRequest } from "@uipi/protocol";

  const current = $derived(ui.uiEvents.at(0)!);

  function dismiss() {
    ui.uiEvents = ui.uiEvents.slice(1);
  }

  function resolveSelect(req: UiSelectRequest, index: number | null) {
    ui.cmd({ type: "ui.selectResponse", sessionId: req.sessionId, selectId: req.selectId, index });
    dismiss();
  }

  function resolveDialog(req: UiDialogRequest, value: unknown) {
    ui.cmd({ type: "ui.dialogResponse", sessionId: req.sessionId, dialogId: req.dialogId, value });
    dismiss();
  }
</script>

{#if current}
  <div class="fixed inset-0 bg-black/60 grid place-items-center z-50">
    <div class="bg-zinc-900 border border-zinc-700 rounded-lg p-6 w-[28rem]">
      {#if isSelect(current)}
        <h3 class="font-semibold mb-3">{current.title}</h3>
        <div class="flex flex-col gap-1">
          {#each optionsOf(current) as opt, i}
            <button
              class="text-left text-sm px-3 py-1.5 rounded hover:bg-zinc-800 border border-zinc-800"
              onclick={() => resolveSelect(current, i)}
            >{labelOf(opt)}</button>
          {/each}
          <button class="text-left text-sm text-zinc-500 px-3 py-1" onclick={() => resolveSelect(current, null)}>
            Cancel
          </button>
        </div>
      {:else if isDialog(current)}
        <h3 class="font-semibold mb-3">{current.title}</h3>
        <pre class="text-xs text-zinc-400 mb-3 whitespace-pre-wrap">{JSON.stringify(current.payload, null, 2)}</pre>
        <div class="flex justify-end gap-2">
          <button class="text-sm px-3 py-1 rounded border border-zinc-700" onclick={() => resolveDialog(current, false)}>Dismiss</button>
          <button class="text-sm px-3 py-1 rounded bg-indigo-600 text-white" onclick={() => resolveDialog(current, true)}>OK</button>
        </div>
      {:else}
        <div class="text-sm">
          <span class={levelClass(current.level)}>
            {current.message}
          </span>
        </div>
        <div class="flex justify-end mt-3">
          <button class="text-sm px-3 py-1 rounded border border-zinc-700" onclick={dismiss}>Close</button>
        </div>
      {/if}
    </div>
  </div>
{/if}

<script lang="ts" context="module">
  import type { UiEvent } from "@uipi/protocol";

  function isSelect(e: UiEvent): e is UiSelectRequest & { options: unknown[] } {
    return e.kind === "select" && Array.isArray((e as UiSelectRequest).options);
  }
  function isDialog(e: UiEvent): e is UiDialogRequest {
    return e.kind === "dialog";
  }
  function optionsOf(e: UiEvent): { label?: string }[] {
    return (e as UiSelectRequest).options ?? [];
  }
  function labelOf(o: unknown): string {
    if (typeof o === "string") return o;
    const oo = o as { label?: string };
    return oo?.label ?? JSON.stringify(o);
  }
  function levelClass(level: string): string {
    return level === "error" ? "text-red-400" : level === "warn" ? "text-amber-400" : "text-zinc-300";
  }
</script>
