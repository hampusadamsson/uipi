<script lang="ts">
  import { ui } from "$lib/state.svelte";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Textarea } from "$lib/components/ui/textarea/index.js";
  import { Badge } from "$lib/components/ui/badge/index.js";
  import XIcon from "@lucide/svelte/icons/x";
  import ArrowUpIcon from "@lucide/svelte/icons/arrow-up";
  import SquareIcon from "@lucide/svelte/icons/square";

  let { sessionId }: { sessionId: string } = $props();

  let text = $state("");
  let ta = $state<{ ref?: HTMLTextAreaElement | null; $$bindings?: string } | undefined>(undefined);
  const taEl = $derived(ta?.ref as HTMLTextAreaElement | undefined);

  function autosize() {
    if (!taEl) return;
    taEl.style.height = "auto";
    taEl.style.height = Math.min(taEl.scrollHeight, 160) + "px";
  }
  let acIndex = $state(-1);
  let acItems = $state<string[]>([]);
  let acPanel = $state<HTMLElement | undefined>(undefined);

  // keep the keyboard cursor visible inside the (height-capped) panel
  $effect(() => {
    const idx = acIndex;
    const count = acItems.length;
    if (idx < 0 || count === 0) return;
    const active = acPanel?.querySelector<HTMLElement>('[data-active="true"]');
    active?.scrollIntoView?.({ block: "nearest" });
  });

  const attach = $derived(
    ui.attached.get(sessionId) as
      | { isStreaming?: boolean; cwd?: string; steering?: unknown[]; followUp?: unknown[] }
      | undefined,
  );
  const runState = $derived(ui.stateOf(sessionId));
  const steering = $derived(attach?.steering ?? []);
  const followUp = $derived(attach?.followUp ?? []);

  const slashItems = $derived(ui.slashItems(sessionId));

  /**
   * A queued message's chip text: the first few words only. A queued steer or
   * follow-up is a reminder of what is waiting, not something to read — the
   * composer is a one-line strip and a full prompt would push the field down.
   * The chip truncates with CSS on top of this cap, so it never wraps either.
   */
  function textOf(q: unknown): string {
    const s =
      typeof q === "string"
        ? q
        : ((q as { text?: string; message?: string })?.text ??
          (q as { message?: string })?.message ??
          "");
    const clean = String(s).replace(/\s+/g, " ").trim();
    const LIMIT = 20;
    if (clean.length <= LIMIT) return clean;
    // cut on a word boundary when there is one, so the chip reads as a phrase
    // instead of a chopped syllable
    const cut = clean.slice(0, LIMIT);
    const space = cut.lastIndexOf(" ");
    return `${(space > 0 ? cut.slice(0, space) : cut).trimEnd()}…`;
  }

  function onKeydown(e: KeyboardEvent) {
    if (
      e.key === "Enter" &&
      !e.shiftKey &&
      !("ontouchstart" in window || navigator.maxTouchPoints > 0)
    ) {
      // desktop: Enter sends
      e.preventDefault();
      send();
      return;
    }
    if (e.key === "Escape") {
      acIndex = -1;
      acItems = [];
    }
  }

  function onInput() {
    const v = text;
    if (v.startsWith("/") && !v.includes(" ")) {
      acItems = slashItems.filter((s) => s.startsWith(v));
      acIndex = 0;
    } else {
      acItems = [];
      acIndex = -1;
    }
    autosize();
  }

  function acceptAc() {
    if (acIndex >= 0 && acItems[acIndex]) {
      text = acItems[acIndex] + " ";
      acItems = [];
      acIndex = -1;
    }
  }

  function send() {
    const v = text.trim();
    if (!v) return;
    // slash commands are local actions, never prompt text
    if (v === "/new") {
      const cwd = attach?.cwd;
      text = "";
      if (taEl) taEl.style.height = "auto";
      if (cwd) void ui.newSession(cwd);
      refocus();
      return;
    }
    // optimistic run state; pi events will settle to idle when done
    if (v === "/compact") {
      ui.beginLocalCompaction(sessionId);
      ui.cmd({ type: "pi.compact", sessionId });
    } else {
      // always queue: sendPrompt is queued server-side when a run is in flight,
      // so submitting mid-run never fails and never interrupts the current turn
      ui.sendPrompt(sessionId, v);
    }
    text = "";
    if (taEl) taEl.style.height = "auto";
    refocus();
  }

  function refocus() {
    requestAnimationFrame(() => taEl?.focus());
  }
</script>

<div class="border-t border-border px-3 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
  {#if steering.length + followUp.length > 0}
    <div class="flex flex-wrap gap-1 mb-1">
      {#each steering as s, i (i)}
        <Badge variant="outline" class="text-amber-500 gap-1 max-w-full">
          <span class="truncate">steer: {textOf(s)}</span>
          <button
            class="text-muted-foreground hover:text-foreground shrink-0 px-1"
            aria-label="Cancel steer"
            onclick={() => ui.cmd({ type: "pi.cancelQueued", sessionId, kind: "steer", index: i })}
          >
            <XIcon class="size-3" />
          </button>
        </Badge>
      {/each}
      {#each followUp as f, i (i)}
        <Badge variant="outline" class="text-sky-500 gap-1 max-w-full">
          <span class="truncate">followUp: {textOf(f)}</span>
          <button
            class="text-muted-foreground hover:text-foreground shrink-0 px-1"
            aria-label="Cancel follow-up"
            onclick={() =>
              ui.cmd({ type: "pi.cancelQueued", sessionId, kind: "followUp", index: i })}
          >
            <XIcon class="size-3" />
          </button>
        </Badge>
      {/each}
    </div>
  {/if}
  {#if acItems.length > 0}
    <div
      bind:this={acPanel}
      class="rounded-md border border-border bg-popover text-popover-foreground shadow-md z-30 mb-1 max-h-56 overflow-y-auto overscroll-contain"
    >
      {#each acItems as s, i (s)}
        <button
          data-active={i === acIndex ? "true" : "false"}
          class="w-full text-left text-xs px-3 py-2 cursor-pointer min-h-9 {i === acIndex
            ? 'bg-accent'
            : ''}"
          onmouseenter={() => (acIndex = i)}
          onclick={acceptAc}
        >
          {s}
        </button>
      {/each}
    </div>
  {/if}
  <div class="relative">
    <!-- The submit control sits inside the field, bottom-right: one surface
         instead of a field plus a button beside it, so the composer is shorter
         and the eye never travels to a second box. `pr-12` reserves the strip
         the button occupies — 48px covers the 44px touch target the coarse
         pointer rule gives an icon button — so text never runs under it. -->
    <Textarea
      bind:this={ta}
      bind:value={text}
      onkeydown={onKeydown}
      oninput={onInput}
      rows={2}
      enterkeyhint="send"
      autocomplete="off"
      placeholder="…"
      class="min-h-11 max-h-40 resize-none text-chat pr-12"
    ></Textarea>
    <!-- Vertically centered against the field rather than pinned to a corner:
         the coarse-pointer floor makes the button 44px tall, exactly the
         field's own min-height, so any `bottom-*` offset would poke out of the
         top. `inset-y-0` + `items-center` cannot. -->
    <div class="pointer-events-none absolute inset-y-0 right-1 flex items-center">
      {#if runState === "idle"}
        <!-- A symbol, not the word: at this size the glyph is unambiguous and
             the label would be wider than the field's own margin. -->
        <Button
          size="icon-sm"
          class="pointer-events-auto"
          aria-label="Send"
          title="Send"
          onclick={send}
          disabled={text.trim() === ""}
        >
          <ArrowUpIcon />
        </Button>
      {:else}
        <Button
          variant="destructive"
          size="icon-sm"
          class="pointer-events-auto"
          aria-label="Stop"
          title="Stop"
          onclick={() => ui.abort(sessionId)}
        >
          <SquareIcon class="fill-current" />
        </Button>
      {/if}
    </div>
  </div>
</div>
