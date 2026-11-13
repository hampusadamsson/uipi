<script lang="ts">
	import { Dialog as DialogPrimitive } from "bits-ui";
	import { Button } from "$lib/components/ui/button/index.js";
	import { cn, type WithElementRef } from "$lib/utils.js";
	import type { HTMLAttributes } from "svelte/elements";

	let {
		ref = $bindable(null),
		class: className,
		children,
		showCloseButton = false,
		...restProps
	}: WithElementRef<HTMLAttributes<HTMLDivElement>> & {
		showCloseButton?: boolean;
	} = $props();
</script>

<!-- On a phone the actions are a full-width stack (primary last, so the thumb
     lands on it); only from lg up do they sit right-aligned in one row. -->
<div
	bind:this={ref}
	data-slot="dialog-footer"
	class={cn("bg-muted/50 -mx-4 -mb-4 rounded-b-xl border-t p-4 flex flex-col-reverse gap-2 pb-[max(1rem,env(safe-area-inset-bottom))] [&>[data-slot=button]]:w-full lg:flex-row lg:justify-end lg:pb-4 lg:[&>[data-slot=button]]:w-auto", className)}
	{...restProps}
>
	{@render children?.()}
	{#if showCloseButton}
		<DialogPrimitive.Close>
			{#snippet child({ props })}
				<Button variant="outline" {...props}>Close</Button>
			{/snippet}
		</DialogPrimitive.Close>
	{/if}
</div>
