/**
 * Offline parity test for the explicit-Team runtime: templates, multi-Team
 * isolation, per-member model routes, provisioning failures, and the task
 * board's ownership, dependency, and revision rules.
 */

import assert from 'node:assert/strict'
import path from 'node:path'
import { apply } from '../lib/index.js'

process.env.DSH_HOME = `/tmp/enterprise-team-smoke-${process.pid}`

const sections = []
const contexts = []
const handlers = new Map()
const registered = new Map()
const started = []
const sent = []
const interrupted = []
const idle = new Set()

const ctx = {
  tools: { register: (definition) => registered.set(definition.name, definition) },
  systemPrompt: {},
  on: (event, handler) => {
    handlers.set(event, handler)
    return () => handlers.delete(event)
  },
  subagents: {
    async startActivation(spec) {
      if (spec.request.prompt[0].text.includes('FAIL_ME')) throw new Error('provider rejected the route')
      const childId = `child-${started.length + 1}`
      started.push({ childId, spec })
      return { childId, messageId: `msg-${started.length}` }
    },
    async sendMessage(sender, target, message, options) {
      sent.push({ sender: sender.id, target, text: message[0].text, hasSignal: options?.signal !== undefined })
      return 'message-1'
    },
    interrupt(target) {
      interrupted.push(target)
    },
  },
  agents: {
    list: () => [],
    get(id) {
      return idle.has(id) ? { id, status: 'idle' } : { id, status: 'running' }
    },
  },
}

/** One agent whose scoped system prompt records what a plugin registers. */
function agentWithPrompt(id) {
  return {
    id,
    ctx: {
      systemPrompt: {
        section: (entry) => {
          sections.push({ id, ...entry })
          return () => {}
        },
        context: (entry) => {
          contexts.push({ id, ...entry })
          return () => {}
        },
        getSectionOrder: () => undefined,
      },
    },
  }
}

const leadAgent = agentWithPrompt('lead-1')
const config = {
  rolesFile: path.join(import.meta.dirname, '..', 'roles.json'),
  teamsFile: path.join(import.meta.dirname, '..', 'teams.json'),
  freshProvider: 'spawn',
  forkProvider: 'fork',
  maxMembers: 8,
  maxTeams: 10,
  maxTasks: 256,
}
apply(ctx, config)

/** Invoke one tool by name with a calling agent. */
async function call(name, args, agent = leadAgent) {
  const tool = registered.get(name)
  assert.equal(typeof tool.execute, 'function', `missing tool ${name}`)
  return (await tool.execute(args, { agent, signal: undefined })).text
}

/** Decode the JSON payload that follows a rendered table. */
function tail(value) {
  const index = value.lastIndexOf('\n\n')
  return JSON.parse(index === -1 ? value : value.slice(index + 2))
}

/** Invoke and decode JSON output. */
async function json(name, args, agent) {
  return tail(await call(name, args, agent))
}

assert.deepEqual([...registered.keys()], [
  'create_team',
  'list_teams',
  'archive_team',
  'plan_team',
  'list_drafts',
  'discard_draft',
  'update_team',
  'assign_goal',
  'respawn_member',
  'spawn_member',
  'list_members',
  'send_member_message',
  'interrupt_member',
  'wait_members',
  'team_status',
  'task_create',
  'task_list',
  'task_get',
  'task_update',
])

// 1. Template instantiation creates the Team, its members, and its task board.
const squad = await json('create_team', { name: 'dev', template: 'dev-squad', goal: 'ship feature X' })
assert.equal(squad.name, 'dev')
assert.equal(squad.goal, 'ship feature X')
assert.deepEqual(squad.members.map((m) => m.target), ['architect', 'implementer', 'reviewer'])
assert.equal(squad.members[0].model, 'gpt-6-luna')
assert.equal(squad.members[1].model, 'deepseek-flash')
assert.deepEqual(squad.tasks.map((t) => [t.id, t.subject, t.owner]), [
  [1, '设计接口与拆分', 'architect'],
  [2, '实现', 'implementer'],
  [3, '评审并给出结论', 'reviewer'],
])
assert.equal(started.length, 3)
assert.equal(started[1].spec.request.agentOptions.model, 'deepseek-flash')
assert.match(started[0].spec.request.prompt[0].text, /You are the architect/)

// 2. A second Team is isolated: its roster and board are its own.
const review = await json('create_team', { name: 'review', template: 'review-squad' })
assert.equal(review.members.length, 2)
const reviewRoster = await json('list_members', { team: 'review' })
assert.deepEqual(reviewRoster.members.map((m) => m.target), ['lead', 'reviewer', 'scout'])
const devRoster = await json('list_members', { team: 'dev' })
assert.equal(devRoster.members.length, 4)

// 3. Team addressing by id also works, and unknown names are rejected.
const byId = await json('list_members', { team: squad.id })
assert.equal(byId.members.length, 4)
await assert.rejects(() => call('list_members', { team: 'nope' }), /unknown team/)

// 4. Members created later join an existing Team with an explicit route.
await call('spawn_member', {
  team: 'dev',
  name: 'scout',
  description: 'collect evidence',
  prompt: 'trace the failing path',
  provider: 'openai-codex',
  model: 'gpt-6-sol',
  context: 'fork',
})
const last = started[started.length - 1]
assert.equal(last.spec.provider, 'fork')
assert.equal(last.spec.request.agentOptions.model, 'gpt-6-sol')

// 5. A failed activation leaves a failed row and burns the name.
await assert.rejects(
  () => call('spawn_member', { team: 'dev', name: 'ghost', description: 'never starts', prompt: 'FAIL_ME' }),
  /provider rejected the route/,
)
await assert.rejects(
  () => call('spawn_member', { team: 'dev', name: 'ghost', description: 'retry', prompt: 'hello' }),
  /was already used/,
)
const devRows = await json('list_members', { team: 'dev' })
assert.equal(devRows.members.find((m) => m.target === 'ghost').status, 'failed')

// 6. Messaging resolves within one Team.
await call('send_member_message', { team: 'dev', target: 'implementer', message: 'status?' })
assert.equal(sent[0].target, started[1].childId)
await call('send_member_message', { team: 'dev', target: 'lead', message: 'done' })
assert.equal(sent[1].target, 'lead-1')

// 7. A teammate may not create Teams.
const memberAgent = { id: started[0].childId }
await assert.rejects(() => call('create_team', { name: 'x' }, memberAgent), /only the session owner may create Teams/)

// 8. Task board: ownership validation, dependencies, claim, stale revision.
await assert.rejects(
  () => call('task_create', { team: 'review', subject: 'x', owner: 'nobody' }),
  /not a member/,
)
const task = await json('task_create', { team: 'dev', subject: 'fix bug', owner: 'implementer', write_scopes: ['src/'] })
assert.equal(task.id, 4)
await assert.rejects(() => call('task_create', { team: 'dev', subject: 'y', blocked_by: [99] }), /no task 99/)
const claimed = await json('task_update', {
  team: 'dev',
  id: task.id,
  revision: task.revision,
  action: 'claim',
  owner: 'implementer',
})
assert.equal(claimed.status, 'in_progress')
await assert.rejects(
  () => call('task_update', { team: 'dev', id: task.id, revision: task.revision, action: 'complete' }),
  /stale revision/,
)
const done = await json('task_update', { team: 'dev', id: task.id, revision: claimed.revision, action: 'complete' })
assert.equal(done.status, 'completed')

// 9. Archive flips the Team status and hides it from the default selection.
await call('archive_team', { team: 'review' })
const teams = await json('list_teams', {})
assert.equal(teams.teams.find((t) => t.name === 'review').status, 'archived')
const defaultRoster = await json('list_members', {})
assert.equal(defaultRoster.members.length, 6, 'the newest active Team (dev: lead + 5 rows) is the default')

// 10. Human-facing status renders both tables for the addressed Team.
const status = await call('team_status', { team: 'dev' })
assert.match(status, /### dev — ship feature X \(active\)/)
assert.match(status, /\| team \| member \| role \| model \| effort \| context \| status \|/)
assert.match(status, /### Open tasks/)

// 11. A teammate identity context names its Team.
const memberCtxAgent = agentWithPrompt(started[0].childId)
handlers.get('agent/created')({ agent: memberCtxAgent })
const identity = contexts.find((entry) => entry.id === started[0].childId)
assert.ok(identity, 'member receives identity context')
assert.match(identity.text(), /team "dev"/)
assert.equal(sections.filter((entry) => entry.id === 'lead-1').length, 1)
assert.match(sections[0].text, /never accepts its own work/)
assert.match(sections[0].text, /action "submit" with concrete evidence/)

// The role catalog carries the same acceptance contract into member prompts.
const roles = JSON.parse((await import('node:fs')).readFileSync(new URL('../roles.json', import.meta.url), 'utf8'))
assert.match(roles.roles.implementer.promptPrefix, /never call \"accept\"/)
assert.match(roles.roles.reviewer.promptPrefix, /acceptance owner/)
assert.match(roles.roles.architect.promptPrefix, /close acceptance/)

// 12. update_team renames and re-goals without touching members or the board.
const renamed = await json('update_team', { team: 'dev', name: 'dev-x', goal: 'ship feature Y' })
assert.equal(renamed.name, 'dev-x')
assert.equal(renamed.goal, 'ship feature Y')
await assert.rejects(() => call('update_team', { team: 'dev-x', name: 'review' }), /already used/)

// 13. assign_goal abandons the previous open board, creates the new one, and briefs owners.
const messagesBefore = sent.length
const assigned = await json('assign_goal', {
  team: 'dev-x',
  goal: 'ship feature Z',
  tasks: [
    { subject: 'design Z', owner: 'architect' },
    { subject: 'build Z', owner: 'implementer', blocked_by: [1] },
  ],
})
assert.ok(assigned.abandoned.length >= 1, 'open tasks of the previous goal are abandoned')
assert.deepEqual(assigned.created.map((task) => task.subject), ['design Z', 'build Z'])
assert.deepEqual(assigned.announced.sort(), ['architect', 'implementer'])
const brief = sent[sent.length - 1].text
assert.match(brief, /【团队目标变更】/)
assert.match(brief, /新目标：ship feature Z/)
assert.match(brief, /已作废任务：#/)
const openOnly = await json('task_list', { team: 'dev-x', status: 'abandoned' })
assert.ok(openOnly.tasks.length >= 1)
const board = await json('task_list', { team: 'dev-x' })
assert.equal(board.tasks.filter((task) => task.status !== 'completed' && task.status !== 'abandoned').length, 2)
assert.ok(sent.length > messagesBefore, 'owners were briefed')

// 14. respawn_member replaces the session while keeping name, role, and board.
const beforeRespawn = started.length
const respawned = await json('respawn_member', { team: 'dev-x', target: 'implementer' })
assert.equal(started.length, beforeRespawn + 1)
assert.notEqual(respawned.childId, respawned.previousChild)
const rosterAfter = await json('list_members', { team: 'dev-x' })
const implementer = rosterAfter.members.find((member) => member.target === 'implementer')
assert.equal(implementer.status, 'running')
assert.equal(implementer.model, 'deepseek-flash')

// 15. A Team can own a dedicated Lead agent on its own model route.
const ledStarted = started.length
const ledTeam = await json('create_team', {
  name: 'led',
  goal: 'run itself',
  lead: { role: 'architect', model: 'gpt-6-sol' },
  members: [{ name: 'worker', role: 'implementer' }],
  tasks: [{ subject: 'do it', owner: 'worker' }],
})
assert.equal(ledTeam.lead.target, 'lead')
assert.equal(ledTeam.lead.model, 'gpt-6-sol')
assert.deepEqual(ledTeam.plan.members, ['worker'])
const leadActivation = started[ledStarted]
assert.ok(leadActivation, 'the Lead agent was spawned')
assert.equal(leadActivation.spec.request.agentOptions.model, 'gpt-6-sol')
assert.match(leadActivation.spec.request.prompt[0].text, /You are the Lead of team "led"/)
assert.match(leadActivation.spec.request.prompt[0].text, /spawn_member/)
assert.match(leadActivation.spec.request.prompt[0].text, /target: "owner"/)

// The roster shows the Team's own Lead model, not the session model.
const ledRoster = await json('list_members', { team: 'led' })
assert.equal(ledRoster.members[0].model, 'gpt-6-sol')

// The owner (session) still coordinates; a teammate of another Team does not.
await assert.rejects(
  () => call('spawn_member', { team: 'led', name: 'x', description: 'x', prompt: 'x' }, memberAgent),
  /unknown team|only the owner or the Team Lead/,
)

// The Team Lead may spawn members itself; they report under the same Team.
const teamLeadAgent = { id: leadActivation.childId }
await call('spawn_member', { team: 'led', name: 'helper', description: 'help', prompt: 'assist' }, teamLeadAgent)
const ledRows = await json('list_members', { team: 'led' })
assert.deepEqual(ledRows.members.map((m) => m.target), ['lead', 'helper'])

// A teammate messages its Lead through "lead"; the Lead reaches the owner.
await call('send_member_message', { team: 'led', target: 'owner', message: 'team ready' }, teamLeadAgent)
assert.equal(sent[sent.length - 1].target, 'lead-1')

// Identity: the Lead agent is told it owns the roster, a member is told its Lead.
const leadCtxAgent = agentWithPrompt(leadActivation.childId)
handlers.get('agent/created')({ agent: leadCtxAgent })
const leadIdentity = contexts.find((entry) => entry.id === leadActivation.childId)
assert.ok(leadIdentity, 'the Team Lead receives identity context')
assert.match(leadIdentity.text(), /You are the Lead of team "led"/)

// 16. Handoff chain: claim → submit(evidence) → review → reject → resubmit → accept,
// with the dependent owner woken exactly when the blocker resolves.
const implTask = await json('task_create', {
  team: 'dev-x',
  subject: 'impl A',
  owner: 'implementer',
  acceptance: 'tests green, no new deps',
})
assert.equal(implTask.acceptance, 'tests green, no new deps')
const nextTask = await json('task_create', {
  team: 'dev-x',
  subject: 'impl B',
  owner: 'architect',
  blocked_by: [implTask.id],
})
const implementerAgent = { id: respawned.childId }
await json('task_update', { team: 'dev-x', id: implTask.id, revision: implTask.revision, action: 'claim', owner: 'implementer' }, implementerAgent)
await assert.rejects(
  () => call('task_update', { team: 'dev-x', id: implTask.id, revision: 2, action: 'submit' }),
  /requires evidence/,
)
const submitted = await json(
  'task_update',
  {
    team: 'dev-x',
    id: implTask.id,
    revision: 2,
    action: 'submit',
    evidence: 'src/a.ts changed; pnpm test green',
  },
  implementerAgent,
)
assert.equal(submitted.status, 'review')
assert.equal(submitted.reviewer, 'reviewer')
assert.equal(submitted.submittedBy, 'implementer')
const reviewRequest = sent[sent.length - 1]
assert.match(reviewRequest.text, /【待验收】#/)
assert.match(reviewRequest.text, /src\/a\.ts changed; pnpm test green/)
assert.match(reviewRequest.text, /action: "accept"/)
const rejected = await json('task_update', {
  team: 'dev-x',
  id: implTask.id,
  revision: submitted.revision,
  action: 'reject',
  note: 'missing rollback path',
})
assert.equal(rejected.status, 'in_progress')
assert.equal(rejected.reviewNote, 'missing rollback path')
const submittedAgain = await json('task_update', {
  team: 'dev-x',
  id: implTask.id,
  revision: rejected.revision,
  action: 'submit',
  evidence: 'src/a.ts + rollback; pnpm test green',
})
const accepted = await json('task_update', {
  team: 'dev-x',
  id: implTask.id,
  revision: submittedAgain.revision,
  action: 'accept',
})
assert.equal(accepted.status, 'completed')
assert.equal(accepted.reviewedBy, 'lead')
assert.equal(rejected.reviewedBy, 'lead')
assert.equal(accepted.woke.length, 1)
assert.equal(accepted.woke[0].task, nextTask.id)
assert.equal(accepted.woke[0].owner, 'architect')
const wakeMessage = sent[sent.length - 1].text
assert.match(wakeMessage, /现在可以开工/)
assert.match(wakeMessage, /submit/)

// 17. plan_team drafts a Team without creating one; create_team({draft_id}) instantiates it.
const planned = await json('plan_team', {
  goal: 'deliver the input-boundary refactor phase 2',
  name: 'draft-squad',
  lead: { role: 'architect', model: 'gpt-6-astra', reasoningEffort: 'max' },
  members: [
    { name: 'core-eng', role: 'core-engineer', model: 'gpt-6.1-sol', reasoningEffort: 'high' },
    { name: 'scribe-one', role: 'scribe' },
  ],
  tasks: [
    { subject: 'P1 baseline', owner: 'scribe-one', acceptance: 'records HEAD and dirty file count' },
    { subject: 'P1 callers', owner: 'core-eng', blocked_by: [1], acceptance: 'callers listed with file:line' },
  ],
})
assert.ok(planned.draftId.startsWith('draft-'))
const pendingDrafts = await json('list_drafts', {})
assert.equal(pendingDrafts.drafts.length, 1)
assert.equal(pendingDrafts.drafts[0].members, 2)
// A draft with a task missing acceptance is rejected.
await assert.rejects(
  () => call('plan_team', { goal: 'x', members: [{ name: 'a', role: 'scribe' }], tasks: [{ subject: 'no acceptance', owner: 'a' }] }),
  /needs acceptance criteria/,
)
// Instantiation consumes the draft and creates the Team.
const fromDraft = await json('create_team', { draft_id: planned.draftId })
assert.equal(fromDraft.name, 'draft-squad')
assert.equal(fromDraft.lead.model, 'gpt-6-astra')
const afterDrafts = await json('list_drafts', {})
assert.equal(afterDrafts.drafts.length, 0, 'the draft is consumed by creation')
await assert.rejects(() => call('create_team', { draft_id: planned.draftId }), /unknown draft/)

console.log(
  'explicit-team smoke ok:',
  registered.size,
  'tools,',
  teams.teams.length,
  'teams,',
  started.length,
  'members started',
)
