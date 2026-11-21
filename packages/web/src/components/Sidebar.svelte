<script lang="ts">
  import { ui, sessionRoleText } from "$lib/state.svelte";
  import { fmtCtx } from "$lib/format";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import { Separator } from "$lib/components/ui/separator/index.js";
  import PlusIcon from "@lucide/svelte/icons/plus";
  import TagIcon from "@lucide/svelte/icons/tag";
  import XIcon from "@lucide/svelte/icons/x";
  import type { SessionSummary } from "@uipi/protocol";

  let { onAfterSelect, onClose }: { onAfterSelect?: () => void; onClose?: () => void } = $props();

  /** free-text session filter; empty means "no filtering at all" */
  let query = $state("");

  /**
   * The query split into terms: an all-whitespace query is empty, so it filters
   * nothing. Every term must match somewhere (AND across terms, OR across
   * fields).
   */
  const terms = $derived(
    query
      .trim()
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t !== ""),
  );

  /** whether a query is active at all (drives the empty-result text) */
  const filtering = $derived(terms.length > 0);

  /** case-insensitive substring match on the fields a user might search by */
  function matches(s: SessionSummary): boolean {
    const haystack = [rowLabel(s), s.displayName, s.firstMessage, s.cwd, sessionRoleText(s) ?? ""]
      .join("\n")
      .toLowerCase();
    return terms.every((t) => haystack.includes(t));
  }

  /**
   * The rows to show: the whole list, or only the matching sessions, newest
   * first. Sessions are one flat list ordered by when they were last used — no
   * project headings, no collapsible groups. A sidebar is a "what was I doing"
   * list, and where a session ran is already on its own row (`s.cwd`), so
   * grouping by folder only adds a second way to scan the same list.
   */
  const visible = $derived.by((): SessionSummary[] => {
    const rows = filtering ? ui.sessions.filter(matches) : ui.sessions;
    // stable sort: equal mtimes keep the server's order, and a sorted copy
    // leaves `ui.sessions` untouched
    return [...rows].sort((a, b) => b.mtime - a.mtime);
  });

  /**
   * A row click switches the chat, so it must also leave a page route.
   *
   * `syncUrl()` leaves page routes alone *by design* (a reconnect or a
   * background attach must never kick the user off /skills or /schedules), so
   * `attach`/`openSession` update `activeId` without touching `page`. Like
   * `startSkill()`, a successful switch therefore navigates explicitly. Only
   * after the await: a rejected switch keeps the user where they were and
   * surfaces the error instead of stranding them on a page with no chat.
   */
  function select(id: string) {
    ui.attach(id)
      .then(() => ui.goToSessionsPage())
      .catch((e: unknown) => {
        ui.error = "could not open session: " + (e instanceof Error ? e.message : String(e));
      });
    // the drawer closes on the click itself, not after the round-trip: the menu
    // is dismissed synchronously either way, and the navigation above happens
    // later without needing it
    onAfterSelect?.();
  }

  async function openFile(file: string) {
    try {
      await ui.openSession(file);
    } catch (e) {
      ui.error = "could not open session: " + (e instanceof Error ? e.message : String(e));
      return;
    }
    // the switch landed: show the chat, then let the caller close the drawer
    ui.goToSessionsPage();
    onAfterSelect?.();
  }

  function newSession(): void {
    // the drawer must get out of the way: the dialog opens over it, and the
    // last thing a phone needs is two stacked close buttons
    onClose?.();
    ui.wantNew = true;
  }

  function fmtDate(mtime: number): string {
    const d = new Date(mtime);
    const now = new Date();
    if (d.toDateString() === now.toDateString()) {
      return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    }
    const days = (now.getTime() - mtime) / 86400000;
    if (days < 7) return d.toLocaleDateString([], { weekday: "short" });
    return d.toLocaleDateString([], { month: "short", day: "numeric" });
  }

  /**
   * Row label: the live name first, so a rename shows instantly, then the
   * summary's displayName (which already prefers `info.name`, but only refreshes
   * with the list), then the session file's own name.
   */
  function rowLabel(s: SessionSummary): string {
    return ui.sessionNameOf(s.sessionId) ?? (s.displayName || s.sessionFile.split("/").pop() || "");
  }
</script>

{#snippet sessionRow(s: SessionSummary)}
  {@const role = sessionRoleText(s)}
  <button
    class="w-full min-h-11 text-left rounded-md px-3 py-2 hover:bg-accent hover:text-accent-foreground {ui.activeId ===
    s.sessionId
      ? 'bg-accent'
      : ''}"
    data-session={s.sessionId}
    onclick={() => {
      if (s.live) select(s.sessionId);
      else if (s.sessionFile) void openFile(s.sessionFile);
    }}
  >
    <div class="text-sm truncate flex items-center gap-1.5">
      {#if s.live}
        {@const st = ui.stateOf(s.sessionId)}
        <span
          class="inline-block w-2 h-2 rounded-full shrink-0 {st === 'idle'
            ? 'bg-green-500'
            : st === 'thinking'
              ? 'bg-amber-400 animate-pulse'
              : st === 'tooling'
                ? 'bg-blue-400 animate-pulse'
                : 'bg-violet-400 animate-pulse'}"
          title={st}
        ></span>
      {:else}
        <span class="inline-block w-2 h-2 rounded-full shrink-0 bg-zinc-600" title="archived"
        ></span>
      {/if}
      {rowLabel(s)}
    </div>
    <div class="text-xs text-muted-foreground truncate flex items-center gap-1">
      <span class="shrink-0">{fmtDate(s.mtime)}</span>
      <span class="truncate">{s.cwd}</span>
      {#if role}
        <span class="shrink-0 text-[10px] opacity-70 inline-flex items-center gap-0.5" title="role"
          ><TagIcon class="size-2.5" />{role}</span
        >
      {/if}
      {#if ui.contextTokens.get(s.sessionId)}
        <span class="shrink-0">· {fmtCtx(ui.contextTokens.get(s.sessionId) ?? 0)}</span>
      {/if}
    </div>
  </button>
{/snippet}

<aside
  class="w-full lg:w-72 h-full border-r border-border flex flex-col bg-sidebar text-sidebar-foreground pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]"
>
  <div class="px-3 py-2 flex items-center gap-2">
    <span class="font-semibold text-sm text-primary">uipi</span>
    <div class="flex-1"></div>
    <Button size="sm" class="max-lg:min-h-9" onclick={newSession}><PlusIcon /> New</Button>
    {#if onClose}
      <Button
        variant="ghost"
        size="icon-sm"
        class="lg:hidden"
        aria-label="Close sessions"
        onclick={onClose}
      >
        <XIcon />
      </Button>
    {/if}
  </div>
  <Separator />
  {#if !ui.connected}
    <div class="text-xs text-amber-500 px-3 py-1">connecting…</div>
  {/if}
  <div class="px-2 pb-1">
    <Input
      bind:value={query}
      class="h-7 text-xs max-lg:h-11"
      placeholder="Filter sessions…"
      aria-label="Filter sessions"
    />
  </div>
  <div class="flex-1 overflow-y-auto overscroll-contain p-1">
    {#each visible as s (s.sessionFile)}
      {@render sessionRow(s)}
    {:else}
      <div class="text-xs text-muted-foreground px-3 py-2">
        {filtering ? "no sessions match" : "no sessions yet"}
      </div>
    {/each}
  </div>
</aside>
