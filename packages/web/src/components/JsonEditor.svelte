<script lang="ts">
  let {
    value,
    onchange,
    onvalid,
    readonly = false,
    label,
  }: {
    /** current JSON text; the parent owns it and writes back through `onchange` */
    value: string;
    /** called on every keystroke with the textarea's new contents */
    onchange: (v: string) => void;
    /** validity of `value`, reported on every change */
    onvalid?: (ok: boolean) => void;
    readonly?: boolean;
    label?: string;
  } = $props();

  // validity follows the prop, so external resets/reverts are reflected too,
  // not just the user's own keystrokes
  const error = $derived(parseError(value));

  $effect(() => {
    onvalid?.(error === null);
  });

  function parseError(text: string): string | null {
    try {
      JSON.parse(text);
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  }
</script>

<div class="flex flex-col gap-1">
  {#if label}
    <div class="text-xs text-muted-foreground">{label}</div>
  {/if}
  <textarea
    {value}
    {readonly}
    spellcheck="false"
    autocapitalize="off"
    autocomplete="off"
    aria-invalid={error !== null}
    class="font-mono text-xs min-h-64 w-full resize-y rounded-md border border-border bg-muted/30 p-2 outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50 {readonly
      ? 'opacity-70'
      : ''}"
    oninput={(e) => onchange(e.currentTarget.value)}></textarea>
  {#if error}
    <p class="text-xs text-destructive">{error}</p>
  {/if}
</div>
