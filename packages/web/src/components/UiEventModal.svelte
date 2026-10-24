<script lang="ts">
  import { ui } from "$lib/state.svelte";
  import * as Dialog from "$lib/components/ui/dialog/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import type { UiSelectRequest, UiDialogRequest } from "@uipi/protocol";

  const current = $derived(ui.uiEvents.at(0)!);
  let open = $derived(ui.uiEvents.length > 0);

  function dismiss() {
    ui.uiEvents = ui.uiEvents.slice(1);
  }

  function cancel() {
    if (!current) return;
    if (isSelect(current)) resolveSelect(current, null);
    else if (isDialog(current)) resolveDialog(current, false);
    else dismiss();
  }

  function resolveSelect(req: UiSelectRequest, index: number | null) {
    ui.cmd({ type: "ui.selectResponse", sessionId: req.sessionId, selectId: req.selectId, index });
    dismiss();
  }

  function resolveDialog(req: UiDialogRequest, value: unknown) {
    ui.cmd({ type: "ui.dialogResponse", sessionId: req.sessionId, dialogId: req.dialogId, value });
    dismiss();
  }

  function isSelect(e: { kind?: string }): e is UiSelectRequest & { options: unknown[] } {
    return e.kind === "select" && Array.isArray((e as UiSelectRequest).options);
  }
  function isDialog(e: { kind?: string }): e is UiDialogRequest {
    return e.kind === "dialog";
  }
  function labelOf(o: unknown): string {
    if (typeof o === "string") return o;
    const oo = o as { label?: string };
    return oo?.label ?? JSON.stringify(o);
  }
</script>

<Dialog.Root {open} onOpenChange={(o) => { if (!o) cancel(); }}>
  <Dialog.Content class="sm:max-w-[28rem]">
    {#if current}
      {#if isSelect(current)}
        <Dialog.Header>
          <Dialog.Title>{current.title}</Dialog.Title>
        </Dialog.Header>
        <div class="flex flex-col gap-1 max-h-96 overflow-y-auto">
          {#each current.options as opt, i}
            <Button variant="outline" class="justify-start text-sm font-normal" onclick={() => resolveSelect(current, i)}>
              {labelOf(opt)}
            </Button>
          {/each}
        </div>
        <Dialog.Footer>
          <Button variant="ghost" onclick={() => resolveSelect(current, null)}>Cancel</Button>
        </Dialog.Footer>
      {:else if isDialog(current)}
        <Dialog.Header>
          <Dialog.Title>{current.title}</Dialog.Title>
        </Dialog.Header>
        <pre class="text-xs text-muted-foreground whitespace-pre-wrap max-h-64 overflow-auto">{JSON.stringify(current.payload, null, 2)}</pre>
        <Dialog.Footer>
          <Button variant="outline" onclick={() => resolveDialog(current, false)}>Dismiss</Button>
          <Button onclick={() => resolveDialog(current, true)}>OK</Button>
        </Dialog.Footer>
      {:else}
        <Dialog.Header>
          <Dialog.Title>{current.kind}</Dialog.Title>
          <Dialog.Description class={current.level === "error" ? "text-destructive" : current.level === "warn" ? "text-amber-500" : ""}>
            {current.message}
          </Dialog.Description>
        </Dialog.Header>
        <Dialog.Footer>
          <Button variant="outline" onclick={dismiss}>Close</Button>
        </Dialog.Footer>
      {/if}
    {/if}
  </Dialog.Content>
</Dialog.Root>
