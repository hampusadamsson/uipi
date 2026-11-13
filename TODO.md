# uipi — TODO

Web UI harness over the pi coding agent SDK. Local, single-user, no auth.
Personal daily driver. One config, two frontends: uipi never defines what pi
already defines.

## Shipped (v1)

Protocol / client / server / web split — `@uipi/protocol` (wire types only) →
`@uipi/client` (transport, session store, reducer, transcript projection) →
`@uipi/web` (Svelte adapter) + `@uipi/server` (Node, in-process pi SDK).

- Multi-session sidebar, attach/re-attach, sessions live while browser is closed
- Per-session URLs (`/s/<hash8>`), durable deep links, refresh/back-button rehydration
- Streaming chat, tool-call cards with streamed bash output and diffs
- Model + thinking-level pickers, `/compact`, `@file` passthrough
- 127.0.0.1 only, pi-native JSONL persistence, pi's own auth
- 339 tests across 36 files, CI (typecheck/lint/format/test/build)

## Decided — pages in the web UI (skills)

**Invariant:** the skills page lists pi's skills. Discovery is pi's
`loadSkills`, invocation is pi's `/skill:<name>` expansion. uipi reads and
triggers — it never parses SKILL.md, never installs, never maps a skill to a
model.

- **Tabs, not a nav.** The header carries `Tabs` (Sessions | Skills) driven by a
  `pages` registry array in `App.svelte`; adding the second page is a data
  change plus one branch, not a layout rewrite.
- **The URL owns the page.** `/skills` is a real route (`SKILLS_PAGE`,
  `isPagePath` in `@uipi/client`'s route module), so the active tab is _derived_
  from `location.pathname` — no tab state variable to drift from the URL.
  `goToPage` / `goToSessionsPage` push history; `syncUrl` refuses to rewrite a
  page URL, so starting or attaching a session cannot silently kick you off the
  page.
- **Scope is a cwd, not a session.** The page lists what pi discovers for the
  **active session's cwd**: user skills from the agent dir plus project skills
  from `<cwd>/.pi/skills`, via pi's own `loadSkills` (`includeDefaults: true`).
  Fetched at startup (and on attach/reconnect) and re-fetched only when that cwd
  changes; a Refresh button re-runs discovery for the cwd on screen.
- **Cards.** Alphabetical by name, name plus description clamped to 3 lines, a
  muted `project` badge on project-scope cards only. Every discovered skill is
  shown, `disable-model-invocation` ones included — the page is a catalog, not a
  model-facing menu.
- **One click starts work.** A click creates a session in that cwd and
  immediately sends `/skill:<name>` as an ordinary prompt; pi expands it into the
  skill block server-side. So there is no draft/prefill step, no second config
  file, and no per-skill model mapping.
- **States.** No cwd → cards render disabled with a hint; empty list → "no skills
  found for `<cwd>`"; failures toast and leave the last good list in place.

### Protocol

```ts
// C2S — new. Same discriminant as the reply; only the reply carries `skills`.
| { type: "proto.skills"; cwd: string; agentDir?: string }

// S2C — new
| { type: "proto.skills"; skills: SkillInfo[] }

export interface SkillInfo {
  name: string;
  description: string;
  scope: "user" | "project";
}
```

### Shipped with skills (v1.2)

- Protocol: `proto.skills` request and reply, `SkillInfo`
- Server: `discoverSkills` answers from pi's `loadSkills` (agent dir +
  `<cwd>/.pi/skills`), collapses scope to `user` / `project`, sorted, display-only
  so a broken scan yields `[]` instead of an error
- Client: `refreshSkills`, `skillsCwd` tracking, re-fetch on cwd change at
  attach/reconnect, `proto.skills` reply folded into store state
- Web: `SkillsPage` (cards, project badge, count, Refresh, busy spinner), header
  `Tabs` with a `pages` registry, `SKILLS_PAGE` / `isPagePath` routing with the
  tab derived from the URL, `startSkill` = new session + `/skill:<name>` prompt
- Also in this pass: emoji swapped for lucide icons throughout the chrome, and
  model output in the transcript rendered as sanitized markdown (raw HTML
  escaped, link/image URLs vetted, GFM + `breaks: true`)
- Tests: `skills.test.ts` (discovery and scope collapse), `skills.svelte.test.ts`
  (adapter), `skills-page.svelte.test.ts` (cards, badge, click, no-cwd hint),
  markdown renderer + `Message` rendering

### Known limits (accepted)

- User skills are per-agent-dir, so a large collection floods the grid. No
  filter/search box yet — sorting and the cwd label are the only affordances.
- The one intermediate list ("Pages → Skills") is collapsed to a direct tab until
  a second page exists; the `pages` registry is ready for it.
- The first transcript row after a click is the full expanded SKILL.md body, not
  a chip. Collapsing it into `◆ skill: <name>` is a recorded follow-up.
- No per-skill arguments prompt: a skill that expects arguments opens the session
  and lets you type the follow-up yourself.
- Scope collapses to two buckets. `temporary` skills (`--skill` paths) and
  anything else read as `user`, because the UI has no third chip.

## Decided — settings and config editing

**Invariant:** uipi never defines what pi already defines. pi exports no roles,
sandbox or MCP config API, so this feature bends that rule once, deliberately,
and pays for it with an id allowlist and an mtime check.

- **A page, not a dialog.** `/settings` is a real route (`SETTINGS_PAGE`,
  `pageIdFromPath` in `@uipi/client`'s route module) rendered as a
  `SettingsPage` with a left sub-nav: General, Roles, Skills, Sandbox, MCP,
  Advanced. The tab comes from the same `pages` registry in `App.svelte` the
  skills page uses, so adding a page stays a data row plus one branch.
- **One list, two layouts.** Below `md` the 144px section rail would be half a
  phone, so the same six sections become a `Select` picker above the pane; the
  rail stays in the DOM (`hidden` until `md`) because it is the page's only nav
  landmark and the existing tests drive its buttons. This is one example of the
  rule in _Mobile_ below: a narrow screen gets a strip or a picker, never a
  fixed side rail on a form.
- **Deliberate exception to "pi defines it".** pi exports no roles/sandbox/mcp
  API — zero hits for those filenames in pi's `dist`, and `roles.json` is read by
  the user's own extension — so uipi **does** edit those files. But only against
  the documented schema, and a save always preserves unknown keys (the form
  spreads the parsed document, the skill writer merges raw frontmatter lines), so
  an extension that grows a field is not silently deleted from. `settings.json`
  is read and written the same way (opaque text, so pi's own normalisation cannot
  drop a key uipi did not understand), and is re-read through pi's own
  `settingsManager.reload()` where a session exists.
- **Allowlist: an id, never a path.** The browser names a `ConfigId`
  (`settings | roles | sandbox | mcp`). `CONFIG_FILES` is the only id → filename
  map and `configPath` the only producer of a path, `Object.hasOwn` guarded, so
  `auth.json`, `mcp-auth.json` and `sessions/` are unreachable by construction —
  not by a check someone has to remember.
- **Concurrency: echo the mtime.** Every load carries the document's `mtimeMs`;
  a save echoes it, and a file changed underneath answers `proto.configConflict`
  with the on-disk text instead of clobbering a hand edit (the form keeps the
  user's draft and offers a reload). Writes are atomic (tmp + rename) with a
  single `.bak`, taken before the replace.
- **Skills CRUD: user scope, slug only.** Create/update/delete/duplicate on user
  skills; the name is validated as a lowercase slug and the resolved path must
  stay inside `<agentDir>/skills/`. Delete names the exact file in a confirmation
  and removes only a skill dir it emptied. Project-scope skills are listed
  read-only: `proto.skillWrite` is user-scope only, and a same-named user skill
  would otherwise be written over.
- **Reload is explicit, never automatic.** A post-save strip offers "Reload
  sessions": `settingsManager.reload` for settings, the roles extension's own
  `/role reload` plus a `proto.sessionState` re-broadcast for roles,
  `resourceLoader.reload` for skills. `sandbox`/`mcp` get a note that pi reads
  them at session start instead. A save never reloads: that changes a running
  agent mid-conversation.
- **Advanced is read-only.** `zentui.json`, `subagents.json` and
  `web-search.json` are extension-owned; the section says so and edits nothing.

### Protocol

```ts
// C2S — new. Each request shares its reply's discriminant: the request names a
// document, the reply carries it.
| { type: "proto.configList" }
| { type: "proto.configGet"; docId: ConfigId }
| { type: "proto.configUpdate"; docId: ConfigId; mtimeMs: number; text: string }
| { type: "proto.reloadConfig"; what: ReloadWhat }
| {
    type: "proto.skillWrite";
    op: "create" | "update" | "delete";
    name: string;
    frontmatter?: string;
    body?: string;
  }
| { type: "proto.skillGet"; name: string }

// S2C — new
| { type: "proto.configList"; docs: { id: ConfigId; mtimeMs: number }[] }
| { type: "proto.configGet"; doc: ConfigDoc }
| { type: "proto.configUpdate"; doc: ConfigDoc }
| { type: "proto.configConflict"; docId: ConfigId; mtimeMs: number; text: string }
| { type: "proto.reloadConfig"; what: string; sessions: string[] }
| { type: "proto.skillWrite"; name: string }
| { type: "proto.skillGet"; name: string; frontmatter: string; body: string }

type ConfigId = "settings" | "roles" | "sandbox" | "mcp";
type ReloadWhat = "settings" | "roles" | "skills";

// `docId`, not `id`: S2CBase.id is the transport's correlation id and
// Conn.request stamps it onto the outgoing frame.
interface ConfigDoc {
  docId: ConfigId;
  mtimeMs: number;
  text: string;
}
```

### Shipped with settings (v1.3)

- Protocol: `ConfigId`, `ReloadWhat`, `ConfigDoc`, config/skill/reload messages
- Server: `config.ts` (id allowlist, list/read/write, shared
  `atomicWriteWithBackup`), `skills-write.ts` (slug + containment, create /
  update / delete / read, raw-line frontmatter merge), `reloadConfig` per live
  session with `broadcastSessionState` as one source for `proto.sessionState`
- Client: `configDocs` / `configConflicts` maps, `loadConfig` / `saveConfig` /
  `reloadConfig`, `writeSkill` / `readSkill` plus a forced skills re-fetch,
  `SETTINGS_PAGE` / `pageIdFromPath` / `PageId`
- Web: `SettingsPage` with sub-nav and per-section forms over one JSON draft,
  `JsonEditor` raw fallback, `ConfigSection` (load / save / revert / conflict
  banner), `SkillsSection` (list, edit, new, duplicate, delete, project read-only),
  `ReloadStrip`
- Tests: `config.test.ts` (allowlist, validation-before-write, conflict, backup),
  `config-transport.test.ts` (a correlated frame still resolves the named doc),
  `reload-config.test.ts` (per-target reload, one failure does not abort the
  rest), `skills-write.test.ts` (slug rule, preconditions, key preservation),
  client config/skill/reload cases, `settings-nav.svelte.test.ts`,
  `reload-strip.svelte.test.ts`

### Known limits (accepted)

- A skill's **body** is loaded on demand via `proto.skillGet`; the list is still
  pi's discovery output, so the editor shows guessed values until the read lands.
- `sandbox` and `mcp` are raw-JSON only — their nested per-tool maps have no form
  that covers them.
- No project-skill editing: project scope is listed, never written.
- No rename. A rename is delete + create, done by hand.

## Decided — mobile layout

**Invariant:** a narrow screen is not a squeezed desktop. Nothing scrolls
sideways, no control is unreachable, and every list keeps its state while it
changes shape — one `section` / `selectedRole` / `selectedName` variable, two
layouts.

- **No fixed side rail on a form.** A 144–160px rail beside a form is fine at
  `lg`+ and fatal on a phone: at `md` the Roles fields measured 60px wide. The
  section rail, the roles list and the skills list all become a horizontal
  scroll strip above their form below `lg`, and a column at `lg`. The strip
  scroller declares `max-lg:flex-row max-lg:overflow-x-auto` and every row
  `max-lg:min-h-11`.
- **The header wraps; the strips inside it scroll.** Below `lg` the tabs take
  the first line and the session controls take the second; from `lg` up it is
  one row. A single row cannot hold tabs + identity + pickers + Stop on a phone,
  and scrolling the _header_ to reach them hides controls — so the header wraps
  and only the individual strips scroll. Stop and the run-state badge sit
  _outside_ the picker scroller, because a control you must scroll sideways to
  find is broken.
- **`basis-0` on the tab strip is load-bearing.** With an `auto` basis the
  strip's min-content width (the full row of tabs inside it) becomes the page's
  min-content width, and a mobile browser then widens the layout viewport past
  the device — measured: a 320px phone reporting `innerWidth` 371 and scrolling
  the whole app sideways. The picker strip is the opposite: content-sized
  (`basis-auto`) with the identity chips on a zero basis, so the pickers never
  scroll on a screen that has room for them. Those chips also carry
  `overflow-hidden` — in a wrapping flex container a content-sized item makes
  the _line_ wrap rather than shrink, which pushed the controls to a second row
  at 1280px.
- **Touch, not pointer.** `@media (pointer: coarse)` sets a 44px floor on every
  control and 16px text on every field. 16px is the only thing that stops iOS
  zooming the page on focus and never zooming back; the floor is applied to
  `button` elements rather than `[data-slot="button"]`, because a picker's
  `Button` is a bits-ui trigger and carries `popover-trigger` as its slot.
- **Pinch-zoom stays.** `maximum-scale=1.0` was removed from the viewport meta;
  suppressing zoom-on-focus via that tag is not an accessibility trade worth
  making. Safe-area insets pad the header, the drawer and the input box.
- **Density is a desktop affair.** The 21–28px controls at `md`+ are deliberate
  and untested for touch; the unit tests therefore pin the _classes_ and leave
  the phone measurements to the browser checks below.

Shipped with it: `settings-mobile-nav.svelte.test.ts` (picker ↔ rail drive one
`section`, all six entries offered, scroll reset) and
`mobile-layout.svelte.test.ts` (rail-becomes-strip in settings/roles/skills,
Stop outside the picker scroller, the header's wrap rule, `basis-0`/`basis-auto`
pins). Verified in Chromium at 320/360/390/414/480/640/768/1024/1280/1440/1600px
across settings × 4 sections, skills, schedules and chat: no document overflow
at any width, no control under 40px on a coarse pointer, and the pickers fit
without scrolling from 640px up.

## Decided — per-message usage meta (v1.4)

**Invariant:** the numbers are the ones pi recorded on the message. uipi formats
and rounds them; it never estimates, back-fills or extrapolates.

- **A faint line, not a badge.** One row under each assistant message —
  `12.3s · 12.3 t/s · 12k ctx` — at `text-[11px]`,
  `text-muted-foreground/70`, `select-none`, no icon, border or hover. Data you
  can ignore, not a control. It only appears in the assistant branch, so a user
  message never shows one.
- **Duration is pi's, whole.** `durationMs` is `AssistantMessage.durationMs`:
  request start to response end, measured by pi with a monotonic clock, set on
  the stream's final message. It includes time-to-first-token and every pause
  between chunks.
- **tokens/sec is `output / durationMs`, because that is all pi gives.** pi
  exports no TTFT and no decode-time split (`Usage` carries counts, no timing),
  so a true decode rate is not derivable. Accepted consequence: on a long prompt
  the row reads low — it is end-to-end throughput, not generation speed.
- **Context is `input + cacheRead + cacheWrite`.** One helper,
  `contextTokensOf` in `@uipi/client`, sums it for both the transcript's
  `metaOf` and the session-wide counter, so the row and the header cannot
  disagree by construction. Missing fields count as zero; a message with all
  three missing has no context number.
- **Absent stays absent.** No `durationMs` → no duration and no t/s, never
  back-computed from `timestamp`; legacy and deferred messages show only what
  they carry. The row is also suppressed while the message streams, because the
  numbers are not final yet.
- `fmtCtx` (`packages/web/src/lib/format.ts`) keeps counts below 1k exact, so a
  small context cannot render as `0k ctx`.

## Audit round (v1.4)

### Audited and fixed

- **Dead fork deleted.** `packages/web/src/lib/conn.ts` was a hand-copied `Conn`
  with no importer (the adapter uses `@uipi/client`), so it is gone and the
  client package's export list is the single surface.
- **One context formatter, three call sites.** `fmtCtx` replaces the inline
  formatters in `Message.svelte`, `Sidebar.svelte` and `App.svelte`. Kept
  because the < 1000 exact-count form is the better behaviour and one helper is
  one place to change — not a bug fix: the two header/sidebar call sites are
  guarded on a nonzero count, so neither ever rendered `0k ctx`.
- **One token sum.** `contextTokensOf` (`packages/client/src/usage.ts`) replaces
  the duplicated `input + cacheRead + cacheWrite` in `metaOf` and in
  `UipiClient`'s context counter.
- **No silent dead clicks.** A sidebar row's rejected `attach` / `openSession`
  now lands on `ui.error` (what `App.svelte` toasts) instead of an unhandled
  promise that looked like a dead row.
- **New tests:** `input-box.svelte.test.ts` (send + clear, Shift+Enter, empty
  box, `/new`, `/compact`, Stop vs Send), `sidebar.svelte.test.ts` (live vs
  archived row, both rejection paths), `config-conflict.svelte.test.ts` (banner,
  draft kept on conflict, reload clears it, another document untouched),
  `format.test.ts`.
- **Two tests that proved less than their names claimed were made real** (both
  mutation-checked: each now fails when its production line is broken):
  - `queued-chips.test.ts` "broadcasts to every subscriber" recorded only the
    first subscriber, so the claim was never tested. Both subscribers now record
    and their `proto.queues` frames must match.
  - the queue-clear case called `broadcastQueues` directly instead of going
    through its trigger. It now drives the production path: `proto.newSession` →
    `materialize()` → pi's `message_start` for the delivered user message.

### Deliberately not changed

- **The unimported `ui/` kit dirs are a kit, not dead code.**
  `alert-dialog`, `dropdown-menu`, `scroll-area`, `select`, `spinner`, `switch`
  and `tooltip` under `packages/web/src/lib/components/ui/` have no importer
  today. They are the vendored shadcn-svelte kit new work starts from; deleting
  them only means re-running the generator.
- **The styling assertions in `message-meta.svelte.test.ts` are regression
  pins.** `text-[11px]`, `text-muted-foreground/70`, `select-none`, and no
  border/hover/shadow _are_ the contract "faint line you can ignore"; loosening
  them lets a later refactor make the row loud.
- **The state-identity assertions in `state-adapter.svelte.test.ts` are pins
  too.** They assert the identity change that makes Svelte's `SvelteMap`
  notify — the original bug was a silent no-update-until-refresh, which equal
  values would not catch.

## Next (v2, not yet designed)

- Extension custom-widget portals (iframe/containers)
- Image/file upload from browser
- Usage cost display (per-message duration / t/s / context shipped in v1.4;
  per-message cost not)
- Browser-side directory tree picker for cwd
- Generic custom-entry rendering (`subagents`, todos, …) via the entry-renderer
  registry
- TUI or alternative client on the shared protocol
