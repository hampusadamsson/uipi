<script lang="ts">
  import { ui, sessionRoleText } from "$lib/state.svelte";
  import { fmtCtx } from "$lib/format";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import { Separator } from "$lib/components/ui/separator/index.js";
  import PlusIcon from "@lucide/svelte/icons/plus";
  import TagIcon from "@lucide/svelte/icons/tag";
  import type { SessionSummary } from "@uipi/protocol";

  let { onAfterSelect }: { onAfterSelect?: () => void } = $props();

  /** one project's rows: the server's order (newest first) is preserved */
  type Group = { cwd: string; label: string; sessions: SessionSummary[]; mtime: number };

  /**
   * Open/collapsed choice per project cwd, page session only (no storage): a
   * missing key means "not chosen yet", so the default below applies and the
   * group still follows the active session.
   */
  const openChoice = $state<Record<string, boolean>>({});

  /** free-text session filter; empty means "no filtering at all" */
  let query = $state("");

  /** the project's own name: the last path segment ("/" for the root itself) */
  function basename(path: string): string {
    const parts = path.split("/").filter((p) => p !== "");
    return parts.pop() ?? path;
  }

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

  /** whether a query is active at all (drives auto-open and the empty text) */
  const filtering = $derived(terms.length > 0);

  /** case-insensitive substring match on the fields a user might search by */
  function matches(s: SessionSummary): boolean {
    const haystack = [rowLabel(s), s.displayName, s.firstMessage, s.cwd, sessionRoleText(s) ?? ""]
      .join("\n")
      .toLowerCase();
    return terms.every((t) => haystack.includes(t));
  }

  /** the rows to group: the whole list, or only the matching sessions */
  const visible = $derived.by((): SessionSummary[] =>
    filtering ? ui.sessions.filter(matches) : ui.sessions,
  );

  /**
   * Rows grouped by project, newest project first. The newest session mtime in
   * a group decides the group's position; rows inside a group keep the order
   * the server sent them in. Filtering happens before grouping, so a group
   * without matches disappears and its count is the number of matches.
   */
  const groups = $derived.by((): Group[] => {
    const out: Group[] = [];
    for (const s of visible) {
      const g = out.find((it) => it.cwd === s.cwd);
      if (!g) {
        out.push({ cwd: s.cwd, label: basename(s.cwd), sessions: [s], mtime: s.mtime });
        continue;
      }
      g.sessions.push(s);
      g.mtime = Math.max(g.mtime, s.mtime);
    }
    // stable sort: equal mtimes keep the server's order of first appearance
    return out.sort((a, b) => b.mtime - a.mtime);
  });

  /**
   * The active session, lifted out of the project groups so it stays visible
   * even when its group is collapsed. Only pinned when it survives the filter:
   * a row the query hides must not come back as a "pinned" special case.
   */
  const pinned = $derived(visible.find((s) => s.sessionId === ui.activeId) ?? null);

  /**
   * A group's rows without the pinned session. The header keeps its place even
   * when this list is empty, so a project whose only session is the active one
   * does not vanish from the sidebar (it renders with count 0).
   */
  function groupRows(g: Group): SessionSummary[] {
    return pinned ? g.sessions.filter((s) => s.sessionId !== pinned.sessionId) : g.sessions;
  }

  /**
   * Default: the first (most recent) group and the group holding the active
   * session start open, the rest collapsed — a click overrides that for the
   * page session. `g.sessions` is the unfiltered membership here: the active
   * row is pinned above, but its project still opens on its behalf.
   */
  function isOpen(g: Group, index: number): boolean {
    // while searching, every surviving group is open: results hidden behind a
    // collapsed header would look like a broken search
    if (filtering) return true;
    const chosen = openChoice[g.cwd];
    if (chosen !== undefined) return chosen;
    if (index === 0) return true;
    return g.sessions.some((s) => s.sessionId === ui.activeId);
  }

  function toggle(g: Group, index: number): void {
    openChoice[g.cwd] = !isOpen(g, index);
  }

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
  class="w-72 max-w-[85vw] h-full border-r border-border flex flex-col bg-sidebar text-sidebar-foreground pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]"
>
  <div class="px-3 py-2 flex items-center justify-between">
    <span class="font-semibold text-sm text-primary">uipi</span>
    <Button size="sm" onclick={() => (ui.wantNew = true)}><PlusIcon /> New</Button>
  </div>
  <Separator />
  {#if !ui.connected}
    <div class="text-xs text-amber-500 px-3 py-1">connecting…</div>
  {/if}
  <div class="px-2 pb-1">
    <Input
      bind:value={query}
      class="h-7 text-xs"
      placeholder="Filter sessions…"
      aria-label="Filter sessions"
    />
  </div>
  <div class="flex-1 overflow-y-auto overscroll-contain p-1">
    {#if pinned}
      <div class="mb-1">
        <div class="text-[10px] text-muted-foreground px-2" data-active-caption>active</div>
        {#key pinned.sessionId}
          {@render sessionRow(pinned)}
        {/key}
      </div>
    {/if}
    {#each groups as g, i (g.cwd)}
      {@const open = isOpen(g, i)}
      {@const groupSessions = groupRows(g)}
      <div class="mb-1">
        <button
          class="w-full text-left rounded-md px-2 py-1.5 flex items-center gap-1 hover:bg-accent hover:text-accent-foreground"
          title={g.cwd}
          aria-expanded={open}
          data-group={g.cwd}
          onclick={() => toggle(g, i)}
        >
          <span class="text-[10px] w-2.5 shrink-0 opacity-60">{open ? "▾" : "▸"}</span>
          <span class="text-xs font-medium truncate">{g.label}</span>
          <span class="ml-auto text-[10px] text-muted-foreground shrink-0" title="sessions"
            >{groupSessions.length}</span
          >
        </button>
        {#if open}
          {#each groupSessions as s (s.sessionFile)}
            {@render sessionRow(s)}
          {/each}
        {/if}
      </div>
    {:else}
      <div class="text-xs text-muted-foreground px-3 py-2">
        {filtering ? "no sessions match" : "no sessions yet"}
      </div>
    {/each}
  </div>
</aside>
