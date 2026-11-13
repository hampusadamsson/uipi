<script lang="ts">
  import type { Component } from "svelte";
  import { SvelteSet } from "svelte/reactivity";
  import ConfigSection from "./settings/ConfigSection.svelte";
  import SkillsSection from "./settings/SkillsSection.svelte";
  import JsonEditor from "./JsonEditor.svelte";
  import { Button } from "$lib/components/ui/button/index.js";
  import * as Collapsible from "$lib/components/ui/collapsible/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import { Label } from "$lib/components/ui/label/index.js";
  import { Badge } from "$lib/components/ui/badge/index.js";
  import { Textarea } from "$lib/components/ui/textarea/index.js";
  import SlidersHorizontalIcon from "@lucide/svelte/icons/sliders-horizontal";
  import UsersIcon from "@lucide/svelte/icons/users";
  import BoxIcon from "@lucide/svelte/icons/box";
  import PlugIcon from "@lucide/svelte/icons/plug";
  import WrenchIcon from "@lucide/svelte/icons/wrench";
  import SparklesIcon from "@lucide/svelte/icons/sparkles";
  import EyeIcon from "@lucide/svelte/icons/eye";
  import EyeOffIcon from "@lucide/svelte/icons/eye-off";

  /** one config document as handed to a section snippet by {@link ConfigSection} */
  type Doc = Record<string, unknown>;
  /** write a partial draft back into the document buffer */
  type Setter = (next: Doc) => void;

  type SectionId = "general" | "roles" | "sandbox" | "mcp" | "advanced" | "skills";

  const nav: { id: SectionId; label: string; icon: Component }[] = [
    { id: "general", label: "General", icon: SlidersHorizontalIcon },
    { id: "roles", label: "Roles", icon: UsersIcon },
    { id: "sandbox", label: "Sandbox", icon: BoxIcon },
    { id: "mcp", label: "MCP", icon: PlugIcon },
    { id: "advanced", label: "Advanced", icon: WrenchIcon },
    { id: "skills", label: "Skills", icon: SparklesIcon },
  ];

  let section = $state<SectionId>("general");
  /**
   * The scrolling pane, so a section switch starts at its top. Jumping from a
   * long section (roles) to a short one (advanced) would otherwise land mid-way
   * down the new section on a phone, where the pane is the whole viewport.
   */
  let pane = $state<HTMLElement | null>(null);
  $effect(() => {
    void section;
    if (pane) pane.scrollTop = 0;
  });
  /** General's form/raw swap */
  let generalRaw = $state(false);
  /**
   * Sandbox and MCP are raw-JSON-only, so their editors start collapsed: the
   * document is not what those sections are for, and a wall of JSON is a poor
   * first impression. The two toggles are deliberately separate state — opening
   * one section must not open the other.
   *
   * General has no such flag: its raw view is chosen explicitly with the
   * Form/Raw button, and a second collapse trigger there could disagree with it.
   */
  let sandboxOpen = $state(false);
  let mcpOpen = $state(false);
  /** role picked in the Roles section; null falls back to the first name */
  let selectedRole = $state<string | null>(null);
  /** revealed MCP env values, keyed `server/key` */
  const revealed = new SvelteSet<string>();

  /**
   * A raw JSON buffer around a draft.
   *
   * The draft is the source of truth, so the editor shows
   * `JSON.stringify(draft, null, 2)` — except while the user's own text is not
   * parseable, where it would otherwise snap back on every keystroke. `typed`
   * only survives as long as it was typed against the current draft; as soon as
   * the draft changes from elsewhere (a valid parse, or Revert) it is dropped.
   */
  class RawDoc {
    typed = $state<string | null>(null);
    typedFor = $state<string | null>(null);

    text(draft: Doc): string {
      const snapshot = JSON.stringify(draft, null, 2);
      return this.typed !== null && this.typedFor === snapshot ? this.typed : snapshot;
    }

    edit(text: string, draft: Doc, set: Setter): void {
      this.typed = text;
      this.typedFor = JSON.stringify(draft, null, 2);
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return; // JsonEditor already shows the parse error
      }
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return;
      set(parsed as Doc);
    }

    reset(): void {
      this.typed = null;
      this.typedFor = null;
    }
  }

  const generalDoc = new RawDoc();
  const sandboxDoc = new RawDoc();
  const mcpDoc = new RawDoc();

  function toggleReveal(id: string): void {
    if (revealed.has(id)) revealed.delete(id);
    else revealed.add(id);
  }

  // ---- reading loosely-typed draft fields --------------------------------

  function str(v: unknown): string {
    if (typeof v === "string") return v;
    if (v === null || v === undefined) return "";
    return String(v);
  }

  function num(v: unknown): string {
    return typeof v === "number" ? String(v) : str(v);
  }

  function bool(v: unknown): boolean {
    return v === true;
  }

  function obj(v: unknown): Doc {
    return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Doc) : {};
  }

  function list(v: unknown): string {
    return Array.isArray(v) ? v.map((x) => str(x)).join(", ") : "";
  }

  function parseList(v: string): string[] {
    return v
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }

  /**
   * Patch one role in place. The map and the role are both spread, so unknown
   * per-role fields a hand-written config may carry survive the edit, and
   * `draft.active` is never part of the patch — switching roles is the roles
   * extension's business, not this page's.
   */
  function setRole(draft: Doc, set: Setter, name: string | null, patch: Doc): void {
    if (name === null) return;
    const roles = obj(draft.roles);
    set({ roles: { ...roles, [name]: { ...obj(roles[name]), ...patch } } });
  }

  /** a timeout field is only written back once it parses to a number */
  function setTimeoutMs(v: string, set: Setter): void {
    const n = Number(v);
    if (v.trim() !== "" && Number.isFinite(n)) set({ httpIdleTimeoutMs: n });
  }
</script>

<div class="flex flex-col lg:flex-row flex-1 min-h-0">
  <!-- Below lg the 144px rail is too much of the width (and below lg the whole
       page lives inside a sheet), so the sections become a horizontally
       scrolling chip strip above the content. A `<Select>` would mean a
       popover *inside* a sheet, with a listbox fighting the sheet for the
       bottom of the screen; chips are one tap, always visible, and show where
       you are without opening anything. The wrapper keeps the nav landmark
       (it is a `role="navigation"` div, not a second `<nav>`), because below lg
       the rail is `hidden` and would otherwise leave the page without one. -->
  <div
    data-slot="settings-sections-mobile"
    class="lg:hidden shrink-0 border-b border-border"
    role="navigation"
    aria-label="Settings sections"
  >
    <div
      class="flex gap-1 overflow-x-auto overscroll-x-contain px-2 py-2"
      role="group"
      aria-label="Settings sections"
    >
      {#each nav as item (item.id)}
        <button
          type="button"
          data-section={item.id}
          aria-current={section === item.id ? "page" : undefined}
          class="flex min-h-11 shrink-0 items-center gap-1.5 rounded-md border px-3 text-xs transition-colors focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none {section ===
          item.id
            ? 'border-transparent bg-accent font-medium text-accent-foreground'
            : 'border-border text-muted-foreground'}"
          onclick={() => (section = item.id)}
        >
          <item.icon class="size-3.5 shrink-0" />
          <span class="whitespace-nowrap">{item.label}</span>
        </button>
      {/each}
    </div>
  </div>

  <nav
    aria-label="Settings sections"
    class="hidden lg:flex w-36 shrink-0 border-r border-border overflow-y-auto overscroll-contain p-2 flex-col gap-0.5"
  >
    {#each nav as item (item.id)}
      <button
        type="button"
        aria-current={section === item.id ? "page" : undefined}
        class="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs text-left transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 {section ===
        item.id
          ? 'bg-accent text-accent-foreground font-medium'
          : 'text-muted-foreground'}"
        onclick={() => (section = item.id)}
      >
        <item.icon class="size-3.5 shrink-0" />
        <span class="truncate">{item.label}</span>
      </button>
    {/each}
  </nav>

  <div
    bind:this={pane}
    class="flex-1 min-w-0 min-h-0 overflow-y-auto overscroll-contain p-3 lg:p-4"
  >
    {#if section === "general"}
      <ConfigSection docId="settings">
        {#snippet children(draft: Doc, set: Setter)}
          <div class="flex items-center gap-2 flex-wrap">
            <h2 class="text-sm font-semibold">General</h2>
            <div class="flex-1"></div>
            <Button
              variant="outline"
              size="sm"
              class="text-xs"
              onclick={() => {
                generalDoc.reset();
                generalRaw = !generalRaw;
              }}
            >
              {generalRaw ? "Form" : "Raw JSON"}
            </Button>
          </div>

          {#if generalRaw}
            <JsonEditor
              value={generalDoc.text(draft)}
              onchange={(text) => generalDoc.edit(text, draft, set)}
            />
          {:else}
            <div class="grid gap-3 sm:grid-cols-2">
              <div class="flex flex-col gap-1">
                <Label for="settings-defaultModel" class="text-xs font-normal text-muted-foreground"
                  >Default model</Label
                >
                <Input
                  id="settings-defaultModel"
                  class="text-xs"
                  value={str(draft.defaultModel)}
                  oninput={(e) => set({ defaultModel: e.currentTarget.value })}
                />
              </div>
              <div class="flex flex-col gap-1">
                <Label
                  for="settings-defaultProvider"
                  class="text-xs font-normal text-muted-foreground">Default provider</Label
                >
                <Input
                  id="settings-defaultProvider"
                  class="text-xs"
                  value={str(draft.defaultProvider)}
                  oninput={(e) => set({ defaultProvider: e.currentTarget.value })}
                />
              </div>
              <div class="flex flex-col gap-1">
                <Label for="settings-theme" class="text-xs font-normal text-muted-foreground"
                  >Theme</Label
                >
                <Input
                  id="settings-theme"
                  class="text-xs"
                  value={str(draft.theme)}
                  oninput={(e) => set({ theme: e.currentTarget.value })}
                />
              </div>
              <div class="flex flex-col gap-1">
                <Label
                  for="settings-defaultThinkingLevel"
                  class="text-xs font-normal text-muted-foreground">Default thinking level</Label
                >
                <Input
                  id="settings-defaultThinkingLevel"
                  class="text-xs"
                  value={str(draft.defaultThinkingLevel)}
                  oninput={(e) => set({ defaultThinkingLevel: e.currentTarget.value })}
                />
              </div>
              <div class="flex flex-col gap-1">
                <Label
                  for="settings-httpIdleTimeoutMs"
                  class="text-xs font-normal text-muted-foreground">HTTP idle timeout (ms)</Label
                >
                <Input
                  id="settings-httpIdleTimeoutMs"
                  type="number"
                  class="text-xs"
                  value={num(draft.httpIdleTimeoutMs)}
                  oninput={(e) => setTimeoutMs(e.currentTarget.value, set)}
                />
              </div>
              <div class="flex flex-col gap-2 justify-center">
                <Label for="settings-hideThinkingBlock" class="text-xs font-normal">
                  <input
                    id="settings-hideThinkingBlock"
                    type="checkbox"
                    class="size-3.5 shrink-0 accent-primary max-lg:size-5"
                    checked={bool(draft.hideThinkingBlock)}
                    onchange={(e) => set({ hideThinkingBlock: e.currentTarget.checked })}
                  />
                  Hide thinking block
                </Label>
                <Label for="settings-enableInstallTelemetry" class="text-xs font-normal">
                  <input
                    id="settings-enableInstallTelemetry"
                    type="checkbox"
                    class="size-3.5 shrink-0 accent-primary max-lg:size-5"
                    checked={bool(draft.enableInstallTelemetry)}
                    onchange={(e) => set({ enableInstallTelemetry: e.currentTarget.checked })}
                  />
                  Enable install telemetry
                </Label>
              </div>
            </div>
          {/if}
        {/snippet}
      </ConfigSection>
    {:else if section === "roles"}
      <ConfigSection docId="roles">
        {#snippet children(draft: Doc, set: Setter)}
          {@const roles = obj(draft.roles)}
          {@const names = Object.keys(roles).sort((a, b) => a.localeCompare(b))}
          {@const active = str(draft.active)}
          {@const name =
            selectedRole !== null && names.includes(selectedRole)
              ? selectedRole
              : (names[0] ?? null)}
          {@const role = name !== null ? obj(roles[name]) : {}}

          <h2 class="text-sm font-semibold">Roles</h2>

          {#if names.length === 0}
            <p class="text-xs text-muted-foreground">no roles defined</p>
          {:else}
            <!-- A 160px rail plus a two-column form does not fit until lg: at md
                 the fields ended up 60px wide. Below lg the rows are a horizontal
                 scroll strip above the form; from lg up they are the rail. One
                 list, two layouts, one selection state. -->
            <div class="flex flex-col gap-3 lg:flex-row lg:items-start">
              <div
                class="shrink-0 flex flex-col gap-0.5 max-lg:w-full max-lg:flex-row max-lg:overflow-x-auto max-lg:overscroll-x-contain max-lg:pb-2 lg:w-40"
                role="group"
                aria-label="Roles"
              >
                {#each names as n (n)}
                  <button
                    type="button"
                    class="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs text-left transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 max-lg:shrink-0 max-lg:min-h-11 max-lg:border max-lg:border-border {n ===
                    name
                      ? 'bg-accent text-accent-foreground font-medium'
                      : 'text-muted-foreground'}"
                    onclick={() => (selectedRole = n)}
                  >
                    <span class="truncate min-w-0">{n}</span>
                    {#if n === active}
                      <Badge variant="secondary" class="text-[10px] font-normal shrink-0"
                        >active</Badge
                      >
                    {/if}
                  </button>
                {/each}
              </div>

              <div class="flex-1 min-w-0 flex flex-col gap-3">
                <div class="grid gap-3 sm:grid-cols-2">
                  <div class="flex flex-col gap-1">
                    <Label for="role-description" class="text-xs font-normal text-muted-foreground"
                      >Description</Label
                    >
                    <Input
                      id="role-description"
                      class="text-xs"
                      value={str(role.description)}
                      oninput={(e) =>
                        setRole(draft, set, name, {
                          description: e.currentTarget.value,
                        })}
                    />
                  </div>
                  <div class="flex flex-col gap-1">
                    <Label for="role-model" class="text-xs font-normal text-muted-foreground"
                      >Model</Label
                    >
                    <Input
                      id="role-model"
                      class="text-xs"
                      value={str(role.model)}
                      oninput={(e) => setRole(draft, set, name, { model: e.currentTarget.value })}
                    />
                  </div>
                  <div class="flex flex-col gap-1">
                    <Label
                      for="role-thinkingLevel"
                      class="text-xs font-normal text-muted-foreground">Thinking level</Label
                    >
                    <Input
                      id="role-thinkingLevel"
                      class="text-xs"
                      value={str(role.thinkingLevel)}
                      oninput={(e) =>
                        setRole(draft, set, name, { thinkingLevel: e.currentTarget.value })}
                    />
                  </div>
                  <div class="flex flex-col gap-1">
                    <Label for="role-promptMode" class="text-xs font-normal text-muted-foreground"
                      >Prompt mode</Label
                    >
                    <Input
                      id="role-promptMode"
                      class="text-xs"
                      value={str(role.promptMode)}
                      oninput={(e) =>
                        setRole(draft, set, name, { promptMode: e.currentTarget.value })}
                    />
                  </div>
                </div>

                <div class="flex flex-col gap-1">
                  <Label for="role-systemPrompt" class="text-xs font-normal text-muted-foreground"
                    >System prompt</Label
                  >
                  <Textarea
                    id="role-systemPrompt"
                    class="text-xs font-mono min-h-32"
                    value={str(role.systemPrompt)}
                    oninput={(e) =>
                      setRole(draft, set, name, { systemPrompt: e.currentTarget.value })}
                  ></Textarea>
                </div>

                <div class="grid gap-3 sm:grid-cols-2">
                  <div class="flex flex-col gap-1">
                    <Label
                      for="role-systemPromptFile"
                      class="text-xs font-normal text-muted-foreground">System prompt file</Label
                    >
                    <Input
                      id="role-systemPromptFile"
                      class="text-xs"
                      value={str(role.systemPromptFile)}
                      oninput={(e) =>
                        setRole(draft, set, name, {
                          systemPromptFile: e.currentTarget.value,
                        })}
                    />
                  </div>
                  <div class="flex flex-col gap-1">
                    <Label for="role-skills" class="text-xs font-normal text-muted-foreground"
                      >Skills (comma-separated)</Label
                    >
                    <Input
                      id="role-skills"
                      class="text-xs"
                      value={list(role.skills)}
                      oninput={(e) =>
                        setRole(draft, set, name, {
                          skills: parseList(e.currentTarget.value),
                        })}
                    />
                  </div>
                  <div class="flex flex-col gap-1">
                    <Label for="role-toolsAllow" class="text-xs font-normal text-muted-foreground"
                      >Tools allow (comma-separated)</Label
                    >
                    <Input
                      id="role-toolsAllow"
                      class="text-xs"
                      value={list(obj(role.tools).allow)}
                      oninput={(e) =>
                        setRole(draft, set, name, {
                          tools: {
                            ...obj(role.tools),
                            allow: parseList(e.currentTarget.value),
                          },
                        })}
                    />
                  </div>
                  <div class="flex flex-col gap-1">
                    <Label for="role-toolsDeny" class="text-xs font-normal text-muted-foreground"
                      >Tools deny (comma-separated)</Label
                    >
                    <Input
                      id="role-toolsDeny"
                      class="text-xs"
                      value={list(obj(role.tools).deny)}
                      oninput={(e) =>
                        setRole(draft, set, name, {
                          tools: {
                            ...obj(role.tools),
                            deny: parseList(e.currentTarget.value),
                          },
                        })}
                    />
                  </div>
                </div>

                <Label for="role-hidden" class="text-xs font-normal">
                  <input
                    id="role-hidden"
                    type="checkbox"
                    class="size-3.5 shrink-0 accent-primary max-lg:size-5"
                    checked={bool(role.hidden)}
                    onchange={(e) => setRole(draft, set, name, { hidden: e.currentTarget.checked })}
                  />
                  Hidden
                </Label>
              </div>
            </div>
          {/if}
        {/snippet}
      </ConfigSection>
    {:else if section === "sandbox"}
      <ConfigSection docId="sandbox">
        {#snippet children(draft: Doc, set: Setter)}
          <Collapsible.Root bind:open={sandboxOpen} class="flex flex-col gap-2">
            <div class="flex items-center gap-2 flex-wrap">
              <h2 class="text-sm font-semibold">Sandbox</h2>
              <div class="flex-1"></div>
              <Collapsible.Trigger>
                {#snippet child({ props })}
                  <Button {...props} variant="ghost" size="sm" class="text-xs">
                    {sandboxOpen ? "hide raw JSON" : "show raw JSON"}
                  </Button>
                {/snippet}
              </Collapsible.Trigger>
            </div>
            <Collapsible.Content>
              <JsonEditor
                value={sandboxDoc.text(draft)}
                onchange={(text) => sandboxDoc.edit(text, draft, set)}
              />
            </Collapsible.Content>
          </Collapsible.Root>
        {/snippet}
      </ConfigSection>
    {:else if section === "mcp"}
      <ConfigSection docId="mcp">
        {#snippet children(draft: Doc, set: Setter)}
          {@const servers = obj(draft.mcpServers)}
          {@const serverNames = Object.keys(servers).sort((a, b) => a.localeCompare(b))}

          <Collapsible.Root bind:open={mcpOpen} class="flex flex-col gap-2">
            <div class="flex items-center gap-2 flex-wrap">
              <h2 class="text-sm font-semibold">MCP</h2>
              <div class="flex-1"></div>
              <Collapsible.Trigger>
                {#snippet child({ props })}
                  <Button {...props} variant="ghost" size="sm" class="text-xs">
                    {mcpOpen ? "hide raw JSON" : "show raw JSON"}
                  </Button>
                {/snippet}
              </Collapsible.Trigger>
            </div>
            <Collapsible.Content>
              <JsonEditor
                value={mcpDoc.text(draft)}
                onchange={(text) => mcpDoc.edit(text, draft, set)}
              />
            </Collapsible.Content>
          </Collapsible.Root>

          {#if serverNames.length === 0}
            <p class="text-xs text-muted-foreground">no MCP servers configured</p>
          {:else}
            <div class="rounded-md border border-border p-2 flex flex-col gap-2">
              {#each serverNames as server (server)}
                {@const env = obj(obj(servers[server]).env)}
                {@const envKeys = Object.keys(env).sort((a, b) => a.localeCompare(b))}
                <div class="flex flex-col gap-1">
                  <div class="flex items-center gap-2 min-w-0">
                    <span class="text-xs font-medium truncate min-w-0">{server}</span>
                    <Badge variant="outline" class="text-[10px] font-normal shrink-0">
                      {envKeys.length}
                      {envKeys.length === 1 ? "env var" : "env vars"}
                    </Badge>
                  </div>
                  {#each envKeys as key (key)}
                    <div class="flex items-center gap-2 text-xs min-w-0">
                      <span class="font-mono text-muted-foreground truncate min-w-0">{key}</span>
                      <span class="font-mono truncate min-w-0">
                        {revealed.has(`${server}/${key}`) ? str(env[key]) : "••••"}
                      </span>
                      <div class="flex-1"></div>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        aria-label={revealed.has(`${server}/${key}`)
                          ? `hide ${key}`
                          : `reveal ${key}`}
                        onclick={() => toggleReveal(`${server}/${key}`)}
                      >
                        {#if revealed.has(`${server}/${key}`)}
                          <EyeOffIcon class="size-3" />
                        {:else}
                          <EyeIcon class="size-3" />
                        {/if}
                      </Button>
                    </div>
                  {/each}
                </div>
              {/each}
            </div>
          {/if}
        {/snippet}
      </ConfigSection>
    {:else if section === "skills"}
      <SkillsSection />
    {:else}
      <div class="flex flex-col gap-2">
        <h2 class="text-sm font-semibold">Advanced</h2>
        <p class="text-xs text-muted-foreground">
          zentui.json, subagents.json and web-search.json are extension-owned and edited in the
          terminal, not here.
        </p>
      </div>
    {/if}
  </div>
</div>
