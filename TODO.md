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
- 236 tests across 24 files, CI (typecheck/lint/format/test/build)

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

## Next (v2, not yet designed)

- Extension custom-widget portals (iframe/containers)
- Image/file upload from browser
- Usage/token cost display
- Browser-side directory tree picker for cwd
- Generic custom-entry rendering (`subagents`, todos, …) via the entry-renderer
  registry
- TUI or alternative client on the shared protocol
