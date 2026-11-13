<script lang="ts">
	import { Dialog as DialogPrimitive } from "bits-ui";
	import XIcon from '@lucide/svelte/icons/x';
	import { Button } from "$lib/components/ui/button/index.js";
	import { cn, type WithoutChildrenOrChild } from "$lib/utils.js";
	import * as Dialog from "./index.js";
	import DialogPortal from "./dialog-portal.svelte";
	import type { Snippet } from "svelte";
	import type { ComponentProps } from "svelte";

	let {
		ref = $bindable(null),
		class: className,
		portalProps,
		children,
		showCloseButton = true,
		...restProps
	}: WithoutChildrenOrChild<DialogPrimitive.ContentProps> & {
		portalProps?: WithoutChildrenOrChild<ComponentProps<typeof DialogPortal>>;
		children: Snippet;
		showCloseButton?: boolean;
	} = $props();
</script>

<DialogPortal {...portalProps}>
	<Dialog.Overlay />
	<DialogPrimitive.Content
		bind:ref
		data-slot="dialog-content"
		class={cn(
			"bg-popover text-popover-foreground data-open:animate-in data-closed:animate-out data-closed:fade-out-0 data-open:fade-in-0 data-closed:zoom-out-95 data-open:zoom-in-95 ring-foreground/10 grid gap-4 rounded-xl p-4 text-sm ring-1 duration-200",
			// A phone gets a bottom sheet, not a floating card: full width, bottom
			// anchored, rounded only at the top, and tall enough that a keyboard
			// does not push the primary action off screen. The centring classes
			// are overridden below `lg`; from `lg` up this is the same dialog it
			// has always been. One primitive, so every dialog in the app (new
			// session, UI events, delete confirmations) gets the mobile form.
			"fixed inset-x-0 bottom-0 z-50 w-full max-w-none translate-x-0 translate-y-0 rounded-b-none rounded-t-2xl max-h-[92dvh] overflow-y-auto overscroll-contain pb-[max(1rem,env(safe-area-inset-bottom))]",
			// A card that fades in the middle of a phone screen reads as a glitch;
			// the same dialog sliding up from the edge reads as "opened".
			"max-lg:data-open:slide-in-from-bottom max-lg:data-closed:slide-out-to-bottom max-lg:data-open:zoom-in-100 max-lg:data-closed:zoom-out-100",
			"lg:inset-x-auto lg:bottom-auto lg:top-1/2 lg:left-1/2 lg:w-full lg:max-w-[calc(100%_-_2rem)] lg:-translate-x-1/2 lg:-translate-y-1/2 lg:rounded-b-xl lg:overflow-visible lg:pb-4",
			"outline-none",
			className
		)}
		{...restProps}
	>
		{@render children?.()}
		{#if showCloseButton}
			<DialogPrimitive.Close data-slot="dialog-close">
				{#snippet child({ props })}
					<Button
						variant="ghost"
						class="absolute top-2 right-2 max-lg:top-1.5 max-lg:size-11"
						size="icon-sm"
						{...props}
					>
						<XIcon  />
						<span class="sr-only">Close</span>
					</Button>
				{/snippet}
			</DialogPrimitive.Close>
		{/if}
	</DialogPrimitive.Content>
</DialogPortal>
