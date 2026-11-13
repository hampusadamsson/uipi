<script lang="ts">
  import { Dialog as DialogPrimitive } from "bits-ui";
  import XIcon from "@lucide/svelte/icons/x";
  import ChevronLeftIcon from "@lucide/svelte/icons/chevron-left";
  import { cn } from "$lib/utils.js";
  import type { Snippet } from "svelte";

  /**
   * A modal surface for the mobile layout: a bottom sheet by default, a
   * left-hand drawer when `side="left"` (the session list).
   *
   * Built on the same bits-ui Dialog primitive the desktop dialogs use, so it
   * inherits what a hand-rolled overlay does not: a focus trap, Escape to
   * dismiss, a backdrop that actually blocks the page, `aria-modal`, and a
   * labelled title. Only the presentation differs — edge-anchored, rounded,
   * safe-area aware, and tall enough to read a list in.
   *
   * The sheet owns no open state: callers pass `open` and react to
   * `onOpenChange`, so Esc, the backdrop, the X and the Android back gesture all
   * funnel through one place.
   */
  let {
    open = $bindable(false),
    onOpenChange,
    title,
    description,
    /** a back chevron in the header, for sub-views that return instead of close */
    onBack,
    /** take nearly the whole viewport: for pages that scroll on their own */
    full = false,
    /** pad the body; off by default so a page can own its own spacing */
    padded = false,
    side = "bottom",
    /** the caller draws its own header (the sidebar): keep the title sr-only */
    showHeader = true,
    /** accessible name of the close control */
    closeLabel = "Close",
    footer,
    children,
  }: {
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
    title: string;
    description?: string;
    onBack?: () => void;
    full?: boolean;
    padded?: boolean;
    side?: "bottom" | "left";
    showHeader?: boolean;
    closeLabel?: string;
    footer?: Snippet;
    children: Snippet;
  } = $props();
</script>

<DialogPrimitive.Root bind:open onOpenChange={(next) => onOpenChange?.(next)}>
  <DialogPrimitive.Portal>
    <DialogPrimitive.Overlay
      data-slot="sheet-overlay"
      class="data-open:animate-in data-closed:animate-out data-open:fade-in-0 data-closed:fade-out-0 fixed inset-0 z-50 bg-black/60 duration-200"
    />
    <DialogPrimitive.Content
      data-slot="sheet-content"
      data-side={side}
      class={cn(
        // The base Dialog classes centre a floating card; a sheet is anchored
        // to an edge and edge to edge, so those are overridden here.
        "fixed z-50 flex max-w-none translate-x-0 translate-y-0 flex-col overflow-hidden border-border bg-background text-foreground shadow-2xl outline-none",
        "data-open:animate-in data-closed:animate-out data-open:fade-in-0 data-closed:fade-out-0 duration-200",
        side === "bottom"
          ? cn(
              "inset-x-0 bottom-0 w-full rounded-t-2xl border-t",
              "data-open:slide-in-from-bottom data-closed:slide-out-to-bottom",
              full ? "h-[92dvh]" : "max-h-[92dvh]",
            )
          : cn(
              "inset-y-0 left-0 w-[min(21rem,85vw)] rounded-r-2xl border-r",
              "data-open:slide-in-from-left data-closed:slide-out-to-left",
              "h-full",
            ),
      )}
    >
      {#if showHeader}
        <!-- A real title bar, not a fake drag handle: dragging is not
             implemented, and a pill that looks draggable but isn't is worse
             than no pill. -->
        <div
          class="flex shrink-0 items-center gap-1.5 border-b border-border px-3 pt-[max(0.5rem,env(safe-area-inset-top))] pb-2"
        >
          {#if onBack}
            <button
              type="button"
              aria-label="Back"
              class="-ml-1 grid size-11 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
              onclick={onBack}
            >
              <ChevronLeftIcon class="size-5" />
            </button>
          {/if}
          <div class="min-w-0 flex-1">
            <DialogPrimitive.Title data-slot="dialog-title" class="truncate text-sm font-semibold">
              {title}
            </DialogPrimitive.Title>
            {#if description}
              <DialogPrimitive.Description
                data-slot="dialog-description"
                class="truncate text-xs text-muted-foreground"
              >
                {description}
              </DialogPrimitive.Description>
            {:else}
              <DialogPrimitive.Description data-slot="dialog-description" class="sr-only">
                {title}
              </DialogPrimitive.Description>
            {/if}
          </div>
          <DialogPrimitive.Close
            aria-label={closeLabel}
            class="-mr-1.5 grid size-11 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
          >
            <XIcon class="size-4" />
          </DialogPrimitive.Close>
        </div>
      {:else}
        <DialogPrimitive.Title data-slot="dialog-title" class="sr-only">{title}</DialogPrimitive.Title>
        <DialogPrimitive.Description data-slot="dialog-description" class="sr-only">
          {description ?? title}
        </DialogPrimitive.Description>
      {/if}

      <!-- `full` bodies own their scroller (a page component); a plain sheet's
           body scrolls, so a list taller than the sheet is still reachable. -->
      <div
        class={cn(
          "flex min-h-0 flex-1 flex-col",
          full ? "overflow-hidden" : "overflow-y-auto overscroll-contain",
          side === "bottom" && "pb-[env(safe-area-inset-bottom)]",
          padded && "p-3",
        )}
      >
        {@render children()}
      </div>

      {#if footer}
        <div
          class="flex shrink-0 items-center gap-2 border-t border-border bg-muted/30 px-3 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]"
        >
          {@render footer()}
        </div>
      {/if}
    </DialogPrimitive.Content>
  </DialogPrimitive.Portal>
</DialogPrimitive.Root>
