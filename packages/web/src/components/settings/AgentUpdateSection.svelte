<script lang="ts">
  import { ui } from "$lib/state.svelte";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Badge } from "$lib/components/ui/badge/index.js";
  import DownloadIcon from "@lucide/svelte/icons/download";
  import RefreshCwIcon from "@lucide/svelte/icons/refresh-cw";

  /**
   * Settings → Update: pull the pi agent config (roles, skills, extensions,
   * prompts, settings) from the git repo it lives in.
   *
   * Two deliberate properties:
   *
   *  - **Check is separate from apply.** Checking fetches the remote and costs a
   *    network round trip; applying moves the checkout and disturbs every running
   *    agent. Collapsing them into one button would mean "look at the version"
   *    and "change every running agent" were the same click.
   *  - **A failed pull is shown, not raised.** git refuses a dirty checkout or a
   *    diverged history, and the reasons matter to a user staring at a stale role
   *    list. The server returns them in `source.error` so they render here beside
   *    the commit the checkout is still on.
   */
  let checking = $state(false);
  let applying = $state(false);
  /** the outcome line, kept after the request so the user can read it */
  let note = $state<string | null>(null);

  const source = $derived(ui.agentSource);
  /** an update exists only when the server could compare and found commits behind */
  const behind = $derived(source?.behind ?? 0);
  /**
   * "up to date" is a claim about a *comparison*, so it needs both a known
   * remote commit and a zero distance. A `behind: 0` with no remote commit means
   * "could not compare" — showing the badge then would turn a network failure
   * into a clean bill of health.
   */
  const upToDate = $derived(
    source !== null &&
      source.commit !== null &&
      source.remoteCommit !== null &&
      source.behind === 0,
  );

  async function check(): Promise<void> {
    if (checking) return;
    checking = true;
    note = null;
    try {
      const s = await ui.checkAgentUpdate(true);
      if (s?.error) note = s.error;
      else if (s && s.behind !== null && s.behind > 0) {
        note = `${s.behind} new commit${s.behind === 1 ? "" : "s"} available`;
      } else if (s) note = "already up to date";
    } finally {
      checking = false;
    }
  }

  async function apply(): Promise<void> {
    if (applying) return;
    applying = true;
    note = null;
    try {
      const res = await ui.applyAgentUpdate();
      if (!res) return; // the client raised `error`, the app toasts it
      if (!res.applied) {
        note = res.source.error ?? "nothing to apply";
        return;
      }
      const n = res.reloaded.length;
      note =
        n === 0
          ? "updated — no live sessions to reload"
          : `updated — ${n} live session${n === 1 ? "" : "s"} reloaded`;
    } finally {
      applying = false;
    }
  }
</script>

<div class="flex flex-col gap-2">
  <div class="flex items-center gap-2 flex-wrap">
    <h2 class="text-sm font-semibold">Agent config</h2>
    <div class="flex-1"></div>
    <Button
      variant="outline"
      size="sm"
      class="text-xs"
      disabled={checking || applying}
      onclick={() => void check()}
    >
      <RefreshCwIcon class="size-3" />
      {checking ? "Checking…" : "Check for updates"}
    </Button>
    <Button
      size="sm"
      class="text-xs"
      disabled={applying || checking || !source?.remote || behind === 0}
      onclick={() => void apply()}
    >
      <DownloadIcon class="size-3" />
      {applying ? "Updating…" : "Update now"}
    </Button>
  </div>

  <p class="text-xs text-muted-foreground">
    The pi config in this deployment — roles, skills, extensions, prompts and settings — is a git
    checkout. Updating pulls it and reloads every live session so the UI shows the new roles and
    commands.
  </p>

  {#if source === null}
    <p class="text-xs text-muted-foreground">
      Not checked yet. Checking asks the remote for its current commit.
    </p>
  {:else if !source.remote}
    <p class="text-xs text-muted-foreground">
      This agent dir is not a git checkout, so there is nothing to pull.
    </p>
  {:else}
    <div class="rounded-md border border-border p-2 flex flex-col gap-1.5 text-xs">
      <div class="flex items-center gap-2 min-w-0">
        <span class="text-muted-foreground shrink-0">remote</span>
        <span class="font-mono truncate min-w-0">{source.remote}</span>
      </div>
      {#if source.branch}
        <div class="flex items-center gap-2 min-w-0">
          <span class="text-muted-foreground shrink-0">branch</span>
          <span class="font-mono truncate min-w-0">{source.branch}</span>
        </div>
      {/if}
      <div class="flex items-center gap-2 flex-wrap">
        <span class="text-muted-foreground shrink-0">commit</span>
        <span class="font-mono">{source.commit ?? "unknown"}</span>
        {#if source.remoteCommit && source.remoteCommit !== source.commit}
          <span class="text-muted-foreground">→ {source.remoteCommit}</span>
        {/if}
        {#if behind > 0}
          <Badge variant="secondary" class="text-[10px] font-normal shrink-0">
            {behind} behind
          </Badge>
        {:else if upToDate}
          <Badge variant="outline" class="text-[10px] font-normal shrink-0">up to date</Badge>
        {/if}
        {#if source.dirty}
          <Badge variant="destructive" class="text-[10px] font-normal shrink-0">
            local changes
          </Badge>
        {/if}
      </div>
      {#if source.dirty}
        <p class="text-muted-foreground">
          This checkout has uncommitted changes, so an update is refused — it would discard them.
          Commit or discard them in the checkout first.
        </p>
      {/if}
      {#if source.error}
        <p class="text-destructive break-words">{source.error}</p>
      {/if}
    </div>
  {/if}

  {#if note}
    <p class="text-xs text-muted-foreground" data-update-note>{note}</p>
  {/if}
</div>
