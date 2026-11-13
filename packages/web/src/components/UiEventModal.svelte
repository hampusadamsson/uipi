<script lang="ts">
  import { ui } from "$lib/state.svelte";
  import * as Dialog from "$lib/components/ui/dialog/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { toast } from "svelte-sonner";
  import type { UiSelectRequest, UiDialogRequest } from "@uipi/protocol";

  const current = $derived(ui.uiEvents.find((e) => e.kind !== "notification"));
  let open = $derived(current !== undefined);

  // non-blocking notifications → toasts, popped from the queue. Drain goes
  // through the adapter: it removes by event id, so a re-synced copy of the
  // same event can never be toasted a second time.
  $effect(() => {
    ui.drainNotification((n) => {
      if (n.level === "error") toast.error(n.message);
      else if (n.level === "warn") toast.warning(n.message);
      else toast.info(n.message);
    });
  });

  function cancel() {
    if (!current) return;
    if (isSelect(current)) resolveSelect(current, null);
    else if (isDialog(current)) resolveDialog(current, false);
  }

  function resolveSelect(req: UiSelectRequest, index: number | null) {
    ui.respondUi({ kind: "select", sessionId: req.sessionId, selectId: req.selectId }, index);
  }

  function resolveDialog(req: UiDialogRequest, value: unknown) {
    ui.respondUi({ kind: "dialog", sessionId: req.sessionId, dialogId: req.dialogId }, value);
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

<Dialog.Root
  {open}
  onOpenChange={(o) => {
    if (!o) cancel();
  }}
>
  <Dialog.Content class="lg:max-w-[28rem]">
    {#if current}
      {#if isSelect(current)}
        <Dialog.Header>
          <Dialog.Title>{current.title}</Dialog.Title>
        </Dialog.Header>
        <div class="flex flex-col gap-1 max-h-96 overflow-y-auto">
          {#each current.options as opt, i (i)}
            <Button
              variant="outline"
              class="justify-start text-sm font-normal"
              onclick={() => resolveSelect(current, i)}
            >
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
        <pre
          class="text-xs text-muted-foreground whitespace-pre-wrap max-h-64 overflow-auto">{JSON.stringify(
            current.payload,
            null,
            2,
          )}</pre>
        <Dialog.Footer>
          <Button variant="outline" onclick={() => resolveDialog(current, false)}>Dismiss</Button>
          <Button onclick={() => resolveDialog(current, true)}>OK</Button>
        </Dialog.Footer>
      {/if}
    {/if}
  </Dialog.Content>
</Dialog.Root>
