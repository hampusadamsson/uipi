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
- 56 tests across 10 files, CI (typecheck/lint/format/test/build)

## Decided — roles in the web UI

**Invariant:** roles are pi's roles. Single source of truth is the existing
`~/.pi/agent/roles.json` + `roles/<name>.json` + project `.pi/roles.json`, read by
the existing `roles` extension (`~/.pi/agent/extensions/roles/index.ts`). uipi
lists, switches and displays them — it never re-implements what a role does.

- **Scope:** session-scoped, as pi does it. A switch is a `role-switch` custom
  session entry; `roles.json → active` is only the fresh-session default.
  New session = configured default; reopening a session restores its own role.
- **Permissions = tool exposure only.** The extension's allow/deny narrowing the
  active tool set. No per-call approval gates, no per-role OS confinement;
  `sandbox.json` stays global.
- **Overrides are allowed and sticky.** Model and thinking pickers win and keep
  winning while the rest of the role (tools, skills, prompt) stays applied.
  A role is an opinionated preset, not a lock. No drift warning, no re-apply
  button — the chip names the role, the pickers state reality.
- **Chip is a pure indicator:** one job. Always shows the true active role, even
  if `hidden: true`. Renders nothing when roleless.
- **Picker:** all role names from `/role` argument completions (hidden roles
  included — completions can't distinguish them), name only, plus `(none)` and an
  explicit reload action. No cycling shortcut; picker only.
- **Slash commands:** real discovery (`extensionRunner.getCommands()`,
  `promptTemplates`, skills) replaces the hardcoded `["/compact", "/new"]`.
  `/new` stays the only client-side special case. pi builtins with no web
  equivalent (`/model`, `/session`, `/help`, `/theme`, `/mcp`…) are hidden from
  autocomplete and refused with `proto.error` — never sent to the model.
- **Transcript:** `role-switch` renders as `◆ role → architect` through a small
  custom-entry renderer registry (so generic custom entries are a later 20-line
  addition). Entries preceding the first user message are suppressed, so a
  session's startup default is not announced as an event.
- **Sidebar:** one muted role word per row, nothing when roleless, backfilled
  from each session JSONL and cached by `(path, mtimeMs, size)`.

### Protocol

```ts
// C2S — new
| { type: "proto.setRole"; sessionId: string; role: string | null; reload?: boolean }

// S2C — new, replaces proto.modelSet
| { type: "proto.sessionState";
    sessionId: string;
    role: string | null;
    model: { provider: string; modelId: string } | null;
    thinkingLevel: string;
    tools: string[];
    commands: { name: string; description?: string }[];
  }
| { type: "proto.statuses"; sessionId: string; statuses: Record<string, string> }
```

`proto.attached` gains `role`, `commands`, `statuses`. `proto.modelSet` is
deleted — folding it into `sessionState` also fixes pre-existing staleness of
thinking level and tool set after a change.

### Work order

1. [ ] **Extension patch** (separate repo `~/.pi/agent`): `session_start` always
       `appendEntry("role-switch", { role })`, including the quiet
       `config.defaultRole` path. Commit there.
2. [ ] **Protocol:** add `proto.setRole`, `proto.sessionState`,
       `proto.statuses`; add `role` / `commands` / `statuses` to
       `proto.attached`; delete `proto.modelSet`.
3. [ ] **Server — `setRole`:** translate to `session.prompt("/role <name>")`,
       `"/role none"` for null, `"/role reload"` first when reload is set.
       Unknown role → `proto.error`.
4. [ ] **Server — busy dispatch:** text matching a registered extension command
       (or `/compact`) goes through `prompt()` immediately even mid-run;
       everything else queues as a follow-up. This is what makes `/role` usable
       while the agent is thinking and lets the extension's own busy-refusal
       produce the toast.
5. [ ] **Server — builtin refusal:** refuse pi builtins with no web equivalent
       instead of feeding them to the model as literal text.
6. [ ] **Server — role mirror:** active role = last `role-switch` entry in
       session history, falling back to `roles.json → active`. Display-only,
       fails soft (blank rather than guessed).
7. [ ] **Server — command discovery:** `extensionRunner.getCommands()` +
       `promptTemplates` + skills into `attached` / `sessionState`.
8. [ ] **Server — sidebar badges:** join role into `SessionSummary` by replaying
       `role-switch` from each JSONL; cache by `(path, mtimeMs, size)`; read in
       parallel off the request path.
9. [ ] **Server — `setStatus` capture:** stop discarding it in `UiHost`;
       broadcast `proto.statuses`. Generic extension surface, not the role's
       source of truth.
10. [ ] **Client:** `sessionState` reducer (replacing `modelSet`), `role` on
        `AttachedSession`, entry-renderer registry + startup-row suppression in
        `deriveTranscript`.
11. [ ] **Web:** header chip + popover picker with `(none)` and reload; sidebar
        role badge; slash discovery replacing the hardcoded list.
12. [ ] **Tests** at every existing seam: server `setRole` → `prompt("/role x")` + state broadcast; client `sessionState` mapping; transcript suppression
        rule; headless e2e (`client.test.ts`) extended with a role switch.

### Known limits (accepted)

- Hidden roles (`local`, `small`, `retriever`) appear in the picker.
- Picker is stale after a hand-edit of `roles.json` until the reload action.
- No cycling shortcut — the TUI's `ctrl+h` has no browser equivalent.
- Role config stays hand-edited JSON in a git-tracked repo.
- Without the extension patch, a fresh session's chip stays blank until the
  first switch (the `active` fallback covers it).

## Next (v2, not yet designed)

- Extension custom-widget portals (iframe/containers)
- Image/file upload from browser
- Usage/token cost display
- Settings/config editor UI
- Browser-side directory tree picker for cwd
- Generic custom-entry rendering (`subagents`, todos, …) via the registry above
- TUI or alternative client on the shared protocol
