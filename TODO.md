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

## Next (v2, not yet designed)

- Extension custom-widget portals (iframe/containers)
- Image/file upload from browser
- Usage/token cost display
- Settings/config editor UI
- Browser-side directory tree picker for cwd
- Generic custom-entry rendering (`subagents`, todos, …) via the entry-renderer
  registry
- TUI or alternative client on the shared protocol
