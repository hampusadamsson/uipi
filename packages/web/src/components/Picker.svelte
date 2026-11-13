<script lang="ts">
  import type { Snippet } from "svelte";
  import * as Popover from "$lib/components/ui/popover/index.js";
  import { Sheet } from "$lib/components/ui/sheet/index.js";
  import { isDesktop } from "$lib/viewport.svelte";

  /**
   * One picker, two presentations.
   *
   * From `lg` up a picker is a popover anchored to its chip: compact, and the
   * chat stays readable behind it. On a phone that same popover is a 320px card
   * floating over a 390px screen with the keyboard pushed under it, so it
   * becomes a bottom sheet instead — full width, scrollable, titled, and with
   * nothing tiny left to tap.
   *
   * The trigger and the body are snippets, so both layouts render the *same*
   * controls and cannot drift: only the chrome around them changes.
   */
  let {
    open = $bindable(false),
    title,
    description,
    trigger,
    children,
    contentClass = "w-[min(20rem,calc(100vw-2rem))] p-0",
  }: {
    open?: boolean;
    title: string;
    description?: string;
    /** receives props (event handlers) to spread onto the caller's Button */
    trigger: Snippet<[Record<string, unknown>]>;
    children: Snippet;
    contentClass?: string;
  } = $props();
</script>

{#if isDesktop.current}
  <Popover.Root bind:open>
    <Popover.Trigger>
      {#snippet child({ props })}
        {@render trigger(props as Record<string, unknown>)}
      {/snippet}
    </Popover.Trigger>
    <Popover.Content class={contentClass} align="end">
      {@render children()}
    </Popover.Content>
  </Popover.Root>
{:else}
  {@render trigger({ onclick: () => (open = true) })}
  <Sheet bind:open {title} {description} padded>
    {@render children()}
  </Sheet>
{/if}
