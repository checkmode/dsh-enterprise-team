# dsh-enterprise-team

A self-contained Agent Team runtime for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness):
explicit Teams with their own Leads, per-role model routes, a reviewable draft
flow, and a task board with submit / review / acceptance handoff.

It is a DSH **profile bundle**: it registers its own Loader row, ships a browser
half (conversation-header shortcut and a right-pane Team tab), and depends only
on core harness services (`ctx.tools`, `ctx.subagents`, `ctx.agents`,
`ctx.sessions`, `ctx.systemPrompt`, `ctx.sessionProjections`). No experimental
Team package is required.

## Features

- **Explicit Teams** — create several Teams per session, address them by name,
  archive instead of deleting. A Team may own a dedicated Lead agent on its own
  model route; the session that created it is its owner.
- **Per-role model routes** — every member carries `provider` / `model` /
  `reasoningEffort`; a role catalog supplies defaults, the panel can override.
- **Draft → review → create** — `plan_team` writes a reviewable draft (members,
  tasks, dependencies, acceptance criteria) and creates nothing. `create_team`
  only instantiates a reviewed draft. The panel shows drafts for editing,
  re-planning, or discard.
- **Handoff and acceptance** — `claim → submit(evidence) → review →
  accept | reject(note)`. The owner never accepts its own work; a reviewer (or
  the Team Lead) does. Completing a task wakes the owners of the tasks it
  unblocked.
- **Goal changes** — `assign_goal` updates the goal, abandons the previous open
  tasks, creates the new board, and briefs every owner.
- **Token accounting** — the panel folds each member session's
  `assistant/message` usage into a `role × model` table with totals.
- **Own state** — Teams, tasks, and drafts live under
  `${DSH_HOME}/enterprise-team/` as plain JSON, independent of session event
  schemas.

## Install

As a bundle in a profile:

```bash
cd "$DSH_HOME/profiles/desktop"     # or web
pnpm add -D "github:<owner>/dsh-enterprise-team"
```

Then add it to the profile manifest:

```json
{
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-enterprise-team"]
    }
  }
}
```

Restart (or reload the bundle from the Plugins page). The package ships its own
`cordis.patch.yml`; catalogs resolve relative to the package, so no absolute
paths are needed.

## Catalogs

- `roles.json` — role id → `provider`, `model`, `reasoningEffort`, `promptPrefix`.
- `teams.json` — canned team templates (members + task drafts).

Both are re-read on demand, so editing them applies without a reload.

## Tools

`create_team`, `plan_team`, `list_teams`, `list_drafts`, `discard_draft`,
`update_team`, `archive_team`, `assign_goal`, `spawn_member`, `respawn_member`,
`list_members`, `send_member_message`, `interrupt_member`, `wait_members`,
`team_status`, `task_create`, `task_list`, `task_get`, `task_update`.

## Layout

```
lib/index.js     host half: tools, projection, per-agent policy and identity
lib/client.js    browser half: header shortcut, right-pane tab, drafts, usage
lib/store.js     Teams, index, and drafts on disk
roles.json       role catalog
teams.json       team templates
cordis.patch.yml bundle row
```

## License

MIT
