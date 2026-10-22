/**
 * `enterprise-team`: a self-contained Agent Team runtime.
 *
 * A Team is an explicit object that can be created from a template or from a
 * goal, and one Lead Session may own several Teams. Members carry their own
 * model route, coordinate through a shared task board with dependencies and
 * write scopes, and are driven with message, wait, and interrupt.
 *
 * Everything here is built on core harness services (`ctx.subagents`,
 * `ctx.agents`, `ctx.tools`, `ctx.systemPrompt`, `ctx.sessionProjections`) and
 * imports no other package, so no experimental Team bundle has to exist, be
 * maintained, or stay compatible.
 *
 * @module dsh-enterprise-team
 */

import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  deleteDraft,
  draftsOf,
  findTeamOfChild,
  loadDraft,
  loadTeam,
  newDraftId,
  saveDraft,
  memberView,
  migrateLegacy,
  mutateTeam,
  newTeam,
  newTeamId,
  resolveTeam,
  saveTeam,
  teamsOf,
} from './store.js'

/** Cordis plugin name. */
export const name = 'enterprise-team'

/** Services required before tools register. */
export const inject = ['tools', 'subagents', 'agents', 'sessions']

/** One shared coordination policy injected as a system-prompt section. */
const POLICY = `Enterprise Team is available in this session.

A Team is an explicit object. Create one with create_team (from a template, from
a goal, or by listing members) and address it by name in every later call. A Team
may have its own Lead agent on a dedicated model; that Lead owns the roster and
the board, while the session that created the Team is its owner. The
Lead and every member share this working directory and filesystem, so edits are
immediately visible to everyone.

Coordination rules:
- Only the Lead creates Teams and members, and only the Lead interrupts members.
- Any member may message any other member and use the task board, but only the Lead may message "lead".
- Record owner, write scopes, and dependencies on the task; hand work off through artifacts plus a one-line summary, not pasted transcripts.
- Pass the revision you read back to task_update; a stale revision is rejected instead of overwriting newer work.
- "inactive" means no turn is executing. It does not mean a task finished; read the artifact or the task board.
- Changing a Team's goal means calling assign_goal: it updates the goal, abandons the open tasks of the previous goal, creates the new board, and briefs the owners.
- Handoff is board-driven: claim a task, do it, then task_update action "submit" with concrete evidence. Acceptance is a different person's job.
- The task owner never accepts its own work. A reviewer (or the Team Lead when the team has no reviewer) calls "accept", or "reject" with a note naming the defect.
- A completed or accepted task wakes the owners of the tasks it unblocked; do not poll them yourself.
- "abandoned" tasks are cancelled work, not finished work. Never claim one is done.
- Before reporting completion, verify the work yourself: run the tests and read the diff.`

/** Name grammar for teammates. */
const MEMBER_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u

/** Read one JSON catalog file, or an empty object when unreadable. */
function readCatalog(file) {
  if (file === undefined) return {}
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return {}
  }
}

/** Render one tool result as a single text block. */
function text(value) {
  return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }]
}

/** Shared output schema: one text field holding compact JSON or prose. */
const TEXT_OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['text'],
    properties: { text: { type: 'string' } },
  },
  render: (_args, value) => text(value.text),
}

/** The calling agent, or a rejection when the tool has no agent. */
function callerOf(exec, tool) {
  if (exec.agent === undefined) throw new Error(`${tool} requires a calling agent`)
  return exec.agent
}

/** Render a roster as a markdown table. */
function rosterTable(rows) {
  const header = '| team | member | role | model | effort | context | status |\n|---|---|---|---|---|---|---|'
  const body = rows
    .map(
      (row) =>
        `| ${row.team} | ${row.target} | ${row.role ?? ''} | ${row.model ?? ''} | ${row.effort ?? ''} | ${row.context ?? ''} | ${row.status} |`,
    )
    .join('\n')
  return `${header}\n${body}`
}

/** Statuses that keep a task off the open board. */
const CLOSED_STATUSES = new Set(['completed', 'abandoned'])

/** Statuses that count as resolved for dependency purposes. */
const RESOLVED_STATUSES = new Set(['completed', 'abandoned'])

/** Human labels for the board headings. */
const STATUS_LABELS = {
  pending: 'pending',
  in_progress: 'in progress',
  review: 'awaiting review',
  completed: 'completed',
  abandoned: 'abandoned',
}

/** Whether a task still belongs on the open board. */
function isOpen(task) {
  return !CLOSED_STATUSES.has(task.status)
}

/** Render a task board as a markdown table. */
function taskTable(tasks) {
  if (tasks.length === 0) return '_no tasks_'
  const header = '| id | status | owner | subject | blocked by | scopes |\n|---|---|---|---|---|---|'
  const body = tasks
    .map(
      (task) =>
        `| ${task.id} | ${task.status} | ${task.owner ?? ''} | ${task.subject} | ${task.blockedBy.join(',')} | ${task.writeScopes.join(',')} |`,
    )
    .join('\n')
  return `${header}\n${body}`
}

/**
 * Cordis entry point.
 * @param ctx - the plugin context.
 * @param config - loader configuration.
 */
export function apply(ctx, config) {
  const maxMembers = config.maxMembers ?? 8
  const maxTeams = config.maxTeams ?? 10
  const maxTasks = config.maxTasks ?? 256
  const freshProvider = config.freshProvider ?? 'spawn'
  const forkProvider = config.forkProvider ?? 'fork'

  // Catalogs are re-read per call so edits apply without reloading the plugin.
  // They default to this package's own files, so a profile bundle needs no paths.
  const rolesFile = config.rolesFile ?? fileURLToPath(new URL('../roles.json', import.meta.url))
  const teamsFile = config.teamsFile ?? fileURLToPath(new URL('../teams.json', import.meta.url))
  const roles = () => readCatalog(rolesFile)?.roles ?? {}
  const templates = () => readCatalog(teamsFile)?.templates ?? {}

  /** Resolve the Team a caller addresses, defaulting to its newest active Team. */
  function teamOf(agent, ref) {
    migrateLegacy(agent.id)
    return resolveTeam(agent.id, ref)
  }

  /** Resolve a Team from an exact caller: its own Team when it is a member or Lead. */
  function ownTeam(agent) {
    const owner = findTeamOfChild(agent.id)
    if (owner !== undefined) {
      const team = loadTeam(owner.teamId)
      if (team !== undefined) return team
    }
    return teamOf(agent, undefined)
  }

  /** Whether the caller may coordinate this Team: its owner or its own Lead. */
  function canCoordinate(agent, team) {
    return agent.id === team.ownerId || agent.id === team.leadId
  }

  /** The roster row that stands for this Team's Lead. */
  function leadRow(team) {
    const model = team.lead?.model ?? 'this session'
    const status =
      team.leadId === team.ownerId ? 'running' : team.lead?.phase === 'failed' ? 'failed' : running(team.leadId) ? 'running' : 'inactive'
    return {
      team: team.name,
      target: 'lead',
      role: 'lead',
      model,
      effort: leadEffort(team),
      context: team.lead?.context ?? '—',
      status,
    }
  }

  /**
   * Resolve the Team a caller works on. A member may address its own Team by
   * name; anything else is rejected so one Team cannot be steered by another's
   * member.
   */
  function teamFor(caller, ref) {
    const owner = findTeamOfChild(caller.id)
    if (owner === undefined) return ref === undefined ? teamOf(caller, undefined) : teamOf(caller, ref)
    const own = loadTeam(owner.teamId)
    if (ref === undefined) return own
    const wanted = String(ref).trim().toLowerCase()
    if (own.id === ref || own.name.toLowerCase() === wanted) return own
    throw new Error(`you are not a member of team "${ref}"`)
  }

  /** Whether a live child agent is still running. */
  function running(childId) {
    return ctx.agents.get(childId)?.status === 'running'
  }

  /**
   * Token totals for one agent, folded from its own session events.
   * Returns undefined when the session is not live (a cold child), so the view
   * can show "—" instead of a misleading zero.
   */
  function usageOf(agentId) {
    if (agentId === undefined) return undefined
    try {
      return usageOfLive(agentId)
    } catch {
      // Usage is a best-effort view; it must never break the projection.
      return undefined
    }
  }

  /** The live read behind {@link usageOf}. */
  function usageOfLive(agentId) {
    const agent = ctx.agents.get(agentId)
    const session = agent?.session ?? ctx.sessions?.get?.(agentId)
    if (session === undefined || typeof session.snapshotEvents !== 'function') return undefined
    let input = 0
    let output = 0
    let cached = 0
    let calls = 0
    let model = null
    for (const event of session.snapshotEvents(0)) {
      if (event.type !== 'assistant/message') continue
      const usage = event.data?.usage
      if (usage !== undefined) {
        input += usage.inputTokens ?? 0
        output += usage.outputTokens ?? 0
        cached += usage.cacheReadTokens ?? 0
        calls += 1
      }
      model = event.data?.message?.source?.model ?? model
    }
    return { model, input, output, cached, total: input + output, calls }
  }

  /** Reasoning effort of one member: live agent options, else the stored value. */
  function effortOf(member) {
    const live = member.childId === undefined ? undefined : ctx.agents.get(member.childId)
    return live?.options?.reasoningEffort ?? member.reasoningEffort ?? null
  }

  /** Reasoning effort of a Team's own Lead agent, when it has one. */
  function leadEffort(team) {
    if (team.leadId === team.ownerId) return null
    return ctx.agents.get(team.leadId)?.options?.reasoningEffort ?? team.lead?.reasoningEffort ?? null
  }

  /** Availability of one roster row: phase wins over live state. */
  function statusOf(member) {
    if (member.phase === 'failed') return 'failed'
    if (member.phase === 'provisioning') return 'provisioning'
    return running(member.childId) ? 'running' : 'inactive'
  }

  /** Resolve one member by model-facing name. */
  function memberOf(team, target) {
    const found = team.members.find((candidate) => candidate.name === target)
    if (found === undefined) throw new Error(`team "${team.name}" has no member "${target}"`)
    return found
  }

  /** Resolve one task by id. */
  function taskOf(team, id) {
    const task = team.tasks.find((candidate) => candidate.id === id)
    if (task === undefined) throw new Error(`team "${team.name}" has no task ${id}`)
    return task
  }

  /** Compose the initial prompt from an optional role prefix and the task. */
  function composePrompt(role, prompt) {
    return role?.promptPrefix === undefined ? prompt : `${role.promptPrefix}\n\n${prompt}`
  }

  /**
   * Start one member inside an existing Team document.
   * The member is persisted as `provisioning` first, so a crash mid-spawn leaves
   * a visible failed row instead of a phantom teammate.
   */
  async function startMember(caller, team, spec, signal) {
    if (!MEMBER_NAME.test(spec.name) || spec.name.length > 64 || spec.name === 'lead') {
      throw new Error('teammate name must be lower-kebab-case, at most 64 characters, and not "lead"')
    }
    if (team.usedNames.includes(spec.name)) throw new Error(`teammate name "${spec.name}" was already used in this team`)
    if (team.members.length >= maxMembers) throw new Error(`Team member limit ${maxMembers} reached`)
    const catalog = roles()
    const role = spec.role === undefined ? undefined : catalog[spec.role]
    if (spec.role !== undefined && role === undefined) throw new Error(`unknown role "${spec.role}"`)
    const provider = spec.provider ?? role?.provider
    const model = spec.model ?? role?.model
    const reasoningEffort = spec.reasoningEffort ?? role?.reasoningEffort
    const contextMode = spec.context ?? 'fresh'

    const record = {
      name: spec.name,
      role: spec.role ?? null,
      description: spec.description ?? `member ${spec.name}`,
      provider: provider ?? 'inherit',
      model: model ?? 'inherit',
      reasoningEffort: reasoningEffort ?? null,
      context: contextMode,
      phase: 'provisioning',
      childId: undefined,
      error: undefined,
      createdAt: Date.now(),
    }
    mutateTeam(team.id, (current) => {
      current.usedNames.push(spec.name)
      current.members.push(record)
    })

    const prompt =
      spec.prompt ??
      `You are "${spec.name}"${spec.role === undefined ? '' : ` (role: ${spec.role})`} on team "${team.name}". ` +
        'Wait for the Lead\'s instructions; use list_members and task_list to orient yourself, then reply READY and stop.'

    const agentOptions = {}
    if (provider !== undefined) agentOptions.provider = provider
    if (model !== undefined) agentOptions.model = model
    if (reasoningEffort !== undefined) agentOptions.reasoningEffort = reasoningEffort

    let started
    try {
      started = await ctx.subagents.startActivation({
        delivery: 'parent',
        provider: contextMode === 'fork' ? forkProvider : freshProvider,
        label: record.description,
        request: {
          prompt: [{ type: 'text', text: composePrompt(role, prompt) }],
          parent: caller,
          ...(Object.keys(agentOptions).length === 0 ? {} : { agentOptions }),
        },
        signal,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      mutateTeam(team.id, (current) => {
        const failed = current.members.find((candidate) => candidate.name === spec.name)
        failed.phase = 'failed'
        failed.error = message
      })
      throw error
    }

    mutateTeam(team.id, (current) => {
      const active = current.members.find((candidate) => candidate.name === spec.name)
      active.phase = 'active'
      active.childId = started.childId
    })
    return `"${spec.name}" (${provider ?? 'inherit'}/${model ?? 'inherit'})`
  }

  /** Create tasks from a template or explicit list, wiring blocked_by ids. */
  function createTasks(team, specs) {
    if (specs === undefined || specs.length === 0) return []
    return mutateTeam(team.id, (current) => {
      const idOf = (index) => current.tasks[index - 1]?.id ?? index
      const created = []
      for (const spec of specs) {
        if (current.tasks.length >= maxTasks) throw new Error(`Task limit ${maxTasks} reached`)
        for (const ownerName of [spec.owner].filter(Boolean)) {
          if (!current.members.some((member) => member.name === ownerName)) {
            throw new Error(`task owner "${ownerName}" is not a member of this team`)
          }
        }
        const task = {
          id: current.nextTaskNumber++,
          subject: spec.subject,
          description: spec.description ?? '',
          owner: spec.owner ?? null,
          status: 'pending',
          blockedBy: (spec.blocked_by ?? []).map(idOf),
          writeScopes: spec.write_scopes ?? [],
          revision: 1,
          createdAt: Date.now(),
        }
        current.tasks.push(task)
        created.push(task)
      }
      return created
    })
  }

  /** Model-facing name of one agent inside a Team, or "lead". */
  function nameOf(team, agent) {
    if (agent.id === team.leadId) return 'lead'
    const member = team.members.find((candidate) => candidate.childId === agent.id)
    return member?.name ?? 'lead'
  }

  /**
   * Who reviews this task: its own reviewer, else the team's reviewer role,
   * else the team's dedicated Lead. The session owner has no child session, so
   * it reviews in place and gets no message.
   */
  function reviewerOf(team, task) {
    if (task.reviewer !== null && task.reviewer !== undefined) {
      const named = team.members.find((candidate) => candidate.name === task.reviewer)
      if (named?.childId !== undefined) return { name: named.name, childId: named.childId }
    }
    const byRole = team.members.find((candidate) => candidate.role === 'reviewer' && candidate.childId !== undefined)
    if (byRole !== undefined) return { name: byRole.name, childId: byRole.childId }
    if (team.leadId !== team.ownerId) return { name: 'lead', childId: team.leadId }
    return undefined
  }

  /** Tell the reviewer a submission is waiting, with the evidence inline. */
  async function notifyReviewer(caller, team, task) {
    const reviewer = reviewerOf(team, task)
    if (reviewer === undefined) return undefined
    const excerpt = task.evidence.length > 500 ? `${task.evidence.slice(0, 500)}…` : task.evidence
    const lines = [
      `【待验收】#${task.id} ${task.subject}`,
      `提交人：${task.submittedBy ?? 'unknown'}`,
      task.acceptance === '' ? '验收标准：（未填写）' : `验收标准：${task.acceptance}`,
      '',
      `证据：${excerpt}`,
      '',
      `请先 task_get({ id: ${task.id} }) 读全量，再自己核对工作区（读文件、跑测试、看 diff），不要只相信文字。`,
      `通过：task_update({ id: ${task.id}, revision: <你读到的>, action: "accept" })`,
      `打回：task_update({ id: ${task.id}, revision: <你读到的>, action: "reject", note: "<缺陷与缺失证据>" })`,
    ]
    try {
      await ctx.subagents.sendMessage(caller, reviewer.childId, [{ type: 'text', text: lines.join('\n') }], {})
      return reviewer.name
    } catch {
      return undefined
    }
  }

  /**
   * Wake the owners of tasks that just became runnable.
   * A task runs once every blocker is resolved; each owner gets one message so
   * a completion propagates through the chain without the Lead polling.
   */
  async function wakeDependents(caller, team, resolvedIds) {
    const resolved = new Set(
      team.tasks.filter((task) => RESOLVED_STATUSES.has(task.status)).map((task) => task.id),
    )
    const announced = []
    for (const task of team.tasks) {
      if (task.status !== 'pending' || task.blockedBy.length === 0) continue
      if (!task.blockedBy.some((id) => resolvedIds.includes(id))) continue
      if (!task.blockedBy.every((id) => resolved.has(id))) continue
      if (task.owner === null) continue
      const member = team.members.find((candidate) => candidate.name === task.owner)
      if (member?.childId === undefined) continue
      try {
        await ctx.subagents.sendMessage(
          caller,
          member.childId,
          [
            {
              type: 'text',
              text:
                `前置任务已完成：${task.blockedBy.map((id) => '#' + id).join('、')}。\n` +
                `你的任务 #${task.id} ${task.subject} 现在可以开工。\n` +
                (task.acceptance === '' ? '' : `验收标准：${task.acceptance}\n`) +
                '完成后用 task_update({ action: "submit", evidence: "..." }) 提交验收。',
            },
          ],
          {},
        )
        announced.push({ task: task.id, owner: task.owner })
      } catch {
        /* a failed wake must not roll back the completion */
      }
    }
    return announced
  }

  /**
   * Validate one Team plan without creating anything. The result is a reviewable
   * draft: members on their model routes, tasks with owners, dependencies, and
   * acceptance criteria. Nothing is spawned here.
   */
  function buildDraft(caller, args) {
    const goal = typeof args.goal === 'string' ? args.goal.trim() : ''
    if (goal === '') throw new Error('plan_team requires a goal')
    const catalog = roles()
    const members = (args.members ?? []).map((member) => {
      const name = String(member.name ?? '').trim()
      if (!MEMBER_NAME.test(name) || name.length > 64 || name === 'lead') {
        throw new Error(`invalid member name "${name}"`)
      }
      const role = member.role === undefined ? undefined : catalog[member.role]
      if (member.role !== undefined && role === undefined) throw new Error(`unknown role "${member.role}"`)
      return {
        name,
        role: member.role ?? null,
        description: member.description ?? `member ${name}`,
        provider: member.provider ?? role?.provider ?? null,
        model: member.model ?? role?.model ?? null,
        reasoningEffort: member.reasoningEffort ?? role?.reasoningEffort ?? null,
        prompt: member.prompt ?? null,
      }
    })
    if (members.length === 0) throw new Error('plan_team requires at least one member')
    if (members.length > maxMembers) throw new Error(`Team member limit ${maxMembers} reached`)
    if (new Set(members.map((member) => member.name)).size !== members.length) {
      throw new Error('member names must be unique inside one draft')
    }
    const names = new Set(members.map((member) => member.name))
    const tasks = (args.tasks ?? []).map((task, index) => {
      const subject = String(task.subject ?? '').trim()
      if (subject === '') throw new Error(`task ${index + 1} needs a subject`)
      const acceptance = String(task.acceptance ?? '').trim()
      if (acceptance === '') throw new Error(`task ${index + 1} ("${subject}") needs acceptance criteria`)
      if (task.owner !== undefined && task.owner !== null && !names.has(task.owner)) {
        throw new Error(`task ${index + 1} owner "${task.owner}" is not a member of this draft`)
      }
      for (const ref of task.blocked_by ?? []) {
        if (!Number.isInteger(ref) || ref < 1 || ref > index) {
          throw new Error(`task ${index + 1} blocked_by must reference an earlier task (1-based)`)
        }
      }
      return {
        subject,
        description: task.description ?? '',
        owner: task.owner ?? null,
        blocked_by: task.blocked_by ?? [],
        write_scopes: task.write_scopes ?? [],
        acceptance,
      }
    })
    const lead = args.lead ?? null
    if (lead !== null) {
      if (lead.role !== undefined && catalog[lead.role] === undefined) throw new Error(`unknown lead role "${lead.role}"`)
      const leadRole = lead.role === undefined ? undefined : catalog[lead.role]
      lead.provider = lead.provider ?? leadRole?.provider ?? null
      lead.model = lead.model ?? leadRole?.model ?? null
      lead.reasoningEffort = lead.reasoningEffort ?? leadRole?.reasoningEffort ?? null
    }
    const name = String(args.name ?? goal.split('\n')[0]).trim().slice(0, 60)
    return {
      id: newDraftId(),
      leadId: caller.id,
      name,
      goal,
      lead,
      members,
      tasks,
      notes: args.notes ?? '',
      createdAt: Date.now(),
    }
  }

  /** Register one tool definition. */
  const register = (definition) => ctx.tools.register(definition)

  register({
    name: 'create_team',
    description:
      'Create an explicit Team and optionally instantiate its members and task board in one call. Lead only. Pass template for a canned composition, members to override or extend it, and goal for a goal-driven Team. Each member may name a role from the role catalog and override provider/model.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: { type: 'string', description: 'Unique Team name inside this session; defaults from the goal.' },
        draft_id: { type: 'string', description: 'Instantiate a reviewed draft produced by plan_team.' },
        goal: { type: 'string', description: 'What this Team is responsible for.' },
        template: { type: 'string', description: 'Template id from the Team catalog.' },
        lead: {
          type: 'object',
          additionalProperties: false,
          description:
            'Give the Team its own Lead agent on a chosen model route. It owns the roster and board; the caller only operates it.',
          properties: {
            role: { type: 'string', description: 'Role id from the role catalog for the Lead persona.' },
            provider: { type: 'string' },
            model: { type: 'string' },
            reasoningEffort: { type: 'string' },
            prompt: { type: 'string', description: 'Extra operating instructions appended to the Lead briefing.' },
          },
        },
        members: {
          type: 'array',
          description: 'Members to instantiate; replaces the template member list when provided.',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['name'],
            properties: {
              name: { type: 'string' },
              role: { type: 'string', description: 'Role id from the role catalog.' },
              description: { type: 'string' },
              prompt: { type: 'string', description: 'Initial task; omitted means the member waits for instructions.' },
              provider: { type: 'string' },
              model: { type: 'string' },
              reasoningEffort: { type: 'string' },
            },
          },
        },
        tasks: {
          type: 'array',
          description: 'Tasks to create; replaces the template task list when provided.',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['subject'],
            properties: {
              subject: { type: 'string' },
              description: { type: 'string' },
              owner: { type: 'string' },
              blocked_by: { type: 'array', items: { type: 'integer' }, description: '1-based indexes of earlier tasks in this list.' },
              write_scopes: { type: 'array', items: { type: 'string' } },
            },
          },
        },
      },
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      const caller = callerOf(exec, 'create_team')
      if (findTeamOfChild(caller.id) !== undefined) throw new Error('only the session owner may create Teams')
      let draft
      if (args.draft_id !== undefined) {
        draft = loadDraft(args.draft_id)
        if (draft === undefined) throw new Error(`unknown draft "${args.draft_id}"`)
        if (draft.leadId !== caller.id) throw new Error('that draft belongs to another session')
        args = {
          name: args.name ?? draft.name,
          goal: draft.goal,
          lead: draft.lead ?? undefined,
          members: draft.members,
          tasks: draft.tasks,
        }
      }
      const teamName = String(args.name ?? args.goal ?? 'team').trim().slice(0, 60)
      const existing = teamsOf(caller.id)
      if (existing.filter((team) => team.status === 'active').length >= maxTeams) {
        throw new Error(`active Team limit ${maxTeams} reached; archive one first`)
      }
      if (existing.some((team) => team.name.toLowerCase() === teamName.toLowerCase())) {
        throw new Error(`team name "${teamName}" already used in this session`)
      }
      const template = args.template === undefined ? undefined : templates()[args.template]
      if (args.template !== undefined && template === undefined) throw new Error(`unknown template "${args.template}"`)

      const team = newTeam({
        id: newTeamId(),
        ownerId: caller.id,
        leadId: caller.id,
        name: teamName,
        goal: args.goal ?? null,
        template: args.template ?? null,
      })
      saveTeam(team)
      if (draft !== undefined) deleteDraft(draft.id)
      // The owner earns its coordination policy the moment it owns a Team.
      maybeInstall(caller)

      const memberSpecs = args.members ?? template?.members ?? []
      const taskSpecs = args.tasks ?? template?.tasks ?? []

      // ── Team-owned Lead ────────────────────────────────────────────────
      // The owner hands the plan to a dedicated Lead agent on its own model
      // route. That agent spawns the members itself, so the child lineage
      // (Lead → members) matches the authority the Lead needs to steer them.
      if (args.lead !== undefined) {
        const catalog = roles()
        const leadRole = args.lead.role === undefined ? undefined : catalog[args.lead.role]
        if (args.lead.role !== undefined && leadRole === undefined) throw new Error(`unknown role "${args.lead.role}"`)
        const leadProvider = args.lead.provider ?? leadRole?.provider
        const leadModel = args.lead.model ?? leadRole?.model
        const briefing = [
          `You are the Lead of team "${team.name}".`,
          args.goal === undefined ? '团队目标由 owner 后续给出。' : `团队目标：${args.goal}`,
          '',
          memberSpecs.length === 0
            ? '没有预置成员：按目标自行决定需要哪些成员。'
            : '请用 spawn_member 创建这些成员（name / role / description 如下，可微调）：\n' +
              JSON.stringify(memberSpecs, null, 2),
          taskSpecs.length === 0
            ? '成员就绪后，用 task_create 建立任务板并派活。'
            : '并创建这些任务（blocked_by 用 1-based 序号引用本列表中的前序任务）：\n' + JSON.stringify(taskSpecs, null, 2),
          '',
          '协调规则：只有你能创建和中断成员；成员通过任务板认领工作。',
          '完成后用 send_member_message({ target: "owner", message: "..." }) 向 owner 汇报团队构成与任务板。',
          args.lead.prompt ?? '',
        ]
          .filter((line) => line !== '')
          .join('\n')
        let leadStarted
        try {
          leadStarted = await ctx.subagents.startActivation({
            delivery: 'parent',
            provider: freshProvider,
            label: `team "${team.name}" lead`,
            request: {
              prompt: [{ type: 'text', text: composePrompt(leadRole, briefing) }],
              parent: caller,
              ...(leadProvider === undefined && leadModel === undefined
                ? {}
                : {
                    agentOptions: {
                      ...(leadProvider === undefined ? {} : { provider: leadProvider }),
                      ...(leadModel === undefined ? {} : { model: leadModel }),
                      ...(args.lead.reasoningEffort === undefined
                        ? {}
                        : { reasoningEffort: args.lead.reasoningEffort }),
                    },
                  }),
            },
            signal: exec.signal,
          })
        } catch (error) {
          mutateTeam(team.id, (current) => {
            current.status = 'archived'
          })
          throw error
        }
        mutateTeam(team.id, (current) => {
          current.leadId = leadStarted.childId
          current.lead = {
            role: args.lead.role ?? null,
            provider: leadProvider ?? 'inherit',
            model: leadModel ?? 'inherit',
            reasoningEffort: args.lead.reasoningEffort ?? null,
            context: 'fresh',
            phase: 'active',
            childId: leadStarted.childId,
            createdAt: Date.now(),
          }
        })
        return {
          text: JSON.stringify({
            id: team.id,
            name: team.name,
            goal: team.goal,
            lead: { target: 'lead', model: leadModel ?? 'inherit', status: 'provisioning' },
            plan: { members: memberSpecs.map((member) => member.name), tasks: taskSpecs.map((task) => task.subject) },
            note: 'The Team Lead is instantiating the plan; call list_members/task_list shortly to see it.',
          }),
        }
      }

      const started = []
      const failed = []
      for (const spec of memberSpecs) {
        try {
          started.push(await startMember(caller, team, spec, exec.signal))
        } catch (error) {
          failed.push(`${spec.name}: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      let tasks = []
      try {
        tasks = createTasks(team, taskSpecs)
      } catch (error) {
        failed.push(`tasks: ${error instanceof Error ? error.message : String(error)}`)
      }
      const current = loadTeam(team.id)
      return {
        text: JSON.stringify({
          id: current.id,
          name: current.name,
          goal: current.goal,
          members: current.members.map((member) => ({ target: member.name, model: member.model, status: statusOf(member) })),
          tasks: tasks.map((task) => ({ id: task.id, subject: task.subject, owner: task.owner })),
          ...(failed.length === 0 ? {} : { failures: failed }),
        }),
      }
    },
  })

  register({
    name: 'list_teams',
    description: 'List the Teams owned by this session: name, id, goal, status, member count, and open task count.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: TEXT_OUTPUT,
    execute(args, exec) {
      const caller = callerOf(exec, 'list_teams')
      migrateLegacy(caller.id)
      const rows = teamsOf(caller.id).map((team) => ({
        id: team.id,
        name: team.name,
        goal: team.goal,
        status: team.status,
        template: team.template,
        members: team.members.length,
        openTasks: team.tasks.filter(isOpen).length,
      }))
      return { text: JSON.stringify({ teams: rows }) }
    },
  })

  register({
    name: 'archive_team',
    description: 'Archive one Team: interrupt its running members and hide it from the default roster. Its records stay readable.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['team'],
      properties: { team: { type: 'string', description: 'Team id or name.' } },
    },
    output: TEXT_OUTPUT,
    execute(args, exec) {
      const caller = callerOf(exec, 'archive_team')
      const team = teamOf(caller, args.team)
      if (!canCoordinate(caller, team)) throw new Error('only the owner or the Team Lead may archive this Team')
      for (const member of team.members) {
        if (member.phase === 'active' && running(member.childId)) {
          ctx.subagents.interrupt(member.childId, { kind: 'ancestor', agent: caller })
        }
      }
      mutateTeam(team.id, (current) => {
        current.status = 'archived'
      })
      return { text: JSON.stringify({ archived: team.name, id: team.id }) }
    },
  })

  register({
    name: 'plan_team',
    description:
      'Draft a Team from a goal without creating anything: members on model routes plus a task board with owners, dependencies, and acceptance criteria. The draft is reviewable and editable; create_team({ draft_id }) instantiates it after approval.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['goal'],
      properties: {
        goal: { type: 'string', description: 'What this Team must achieve.' },
        name: { type: 'string', description: 'Proposed Team name; defaults to the first line of the goal.' },
        notes: { type: 'string', description: 'Why this roster, split, and model tiers were chosen.' },
        lead: {
          type: 'object',
          additionalProperties: false,
          description: 'Give the Team its own Lead agent. Omit to keep the session owner as Lead.',
          properties: {
            role: { type: 'string' },
            provider: { type: 'string' },
            model: { type: 'string' },
            reasoningEffort: { type: 'string' },
            prompt: { type: 'string' },
          },
        },
        members: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['name'],
            properties: {
              name: { type: 'string' },
              role: { type: 'string' },
              description: { type: 'string' },
              provider: { type: 'string' },
              model: { type: 'string' },
              reasoningEffort: { type: 'string' },
            },
          },
        },
        tasks: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['subject', 'acceptance'],
            properties: {
              subject: { type: 'string' },
              description: { type: 'string' },
              owner: { type: 'string' },
              blocked_by: { type: 'array', items: { type: 'integer' } },
              write_scopes: { type: 'array', items: { type: 'string' } },
              acceptance: { type: 'string', description: 'Required: how the work is judged done.' },
            },
          },
        },
      },
    },
    output: TEXT_OUTPUT,
    execute(args, exec) {
      const caller = callerOf(exec, 'plan_team')
      if (findTeamOfChild(caller.id) !== undefined) throw new Error('only the session owner may plan Teams')
      const draft = buildDraft(caller, args)
      saveDraft(draft)
      return {
        text: JSON.stringify({
          draftId: draft.id,
          name: draft.name,
          goal: draft.goal,
          lead: draft.lead === null ? 'session-owner' : draft.lead.model,
          members: draft.members.map((member) => `${member.name}:${member.role ?? '-'}:${member.model ?? 'inherit'}`),
          tasks: draft.tasks.length,
          next: 'Review or edit the draft, then call create_team({ draft_id }) to instantiate it.',
        }),
      }
    },
  })

  register({
    name: 'list_drafts',
    description: 'List Team drafts awaiting review: id, name, goal, member and task counts.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: TEXT_OUTPUT,
    execute(args, exec) {
      const caller = callerOf(exec, 'list_drafts')
      const drafts = draftsOf(caller.id).map((draft) => ({
        draftId: draft.id,
        name: draft.name,
        goal: draft.goal,
        members: draft.members.length,
        tasks: draft.tasks.length,
      }))
      return { text: JSON.stringify({ drafts }) }
    },
  })

  register({
    name: 'discard_draft',
    description: 'Delete one Team draft without creating anything.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['draft_id'],
      properties: { draft_id: { type: 'string' } },
    },
    output: TEXT_OUTPUT,
    execute(args, exec) {
      const caller = callerOf(exec, 'discard_draft')
      const draft = loadDraft(args.draft_id)
      if (draft === undefined || draft.leadId !== caller.id) throw new Error(`unknown draft "${args.draft_id}"`)
      deleteDraft(args.draft_id)
      return { text: JSON.stringify({ discarded: args.draft_id }) }
    },
  })

  register({
    name: 'update_team',
    description: 'Change the name or goal of an existing Team without touching its members or board. Lead only.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['team'],
      properties: {
        team: { type: 'string' },
        name: { type: 'string' },
        goal: { type: 'string' },
      },
    },
    output: TEXT_OUTPUT,
    execute(args, exec) {
      const caller = callerOf(exec, 'update_team')
      const team = teamOf(caller, args.team)
      if (!canCoordinate(caller, team)) throw new Error('only the owner or the Team Lead may update this Team')
      const others = teamsOf(caller.id).filter((candidate) => candidate.id !== team.id)
      if (args.name !== undefined && others.some((candidate) => candidate.name.toLowerCase() === args.name.trim().toLowerCase())) {
        throw new Error(`team name "${args.name}" already used in this session`)
      }
      const updated = mutateTeam(team.id, (current) => {
        if (args.name !== undefined) current.name = args.name.trim()
        if (args.goal !== undefined) current.goal = args.goal
        return { id: current.id, name: current.name, goal: current.goal }
      })
      return { text: JSON.stringify(updated) }
    },
  })

  register({
    name: 'assign_goal',
    description:
      'Give an existing Team a new goal in one call: update the goal, abandon the open tasks of the previous goal, create the new task board, and brief each task owner with its mission and tasks. Lead only.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['team', 'goal'],
      properties: {
        team: { type: 'string' },
        goal: { type: 'string', description: 'The new one-line objective.' },
        tasks: {
          type: 'array',
          description: 'The new task board. Omit to leave the board empty and brief nobody.',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['subject'],
            properties: {
              subject: { type: 'string' },
              description: { type: 'string' },
              owner: { type: 'string' },
              blocked_by: { type: 'array', items: { type: 'integer' } },
              write_scopes: { type: 'array', items: { type: 'string' } },
            },
          },
        },
        abandon_open: { type: 'boolean', description: 'Abandon open tasks from the previous goal. Defaults to true.' },
        announce: { type: 'boolean', description: 'Brief each new task owner by message. Defaults to true.' },
      },
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      const caller = callerOf(exec, 'assign_goal')
      const team = teamOf(caller, args.team)
      if (!canCoordinate(caller, team)) throw new Error('only the owner or the Team Lead may reassign this goal')
      const previousGoal = team.goal
      const abandoned = mutateTeam(team.id, (current) => {
        current.goal = args.goal
        const ids = []
        if (args.abandon_open !== false) {
          for (const task of current.tasks) {
            if (isOpen(task)) {
              task.status = 'abandoned'
              task.revision += 1
              ids.push(task.id)
            }
          }
        }
        return ids
      })
      let created = []
      let failures = []
      try {
        created = createTasks(team, args.tasks)
      } catch (error) {
        failures.push(`tasks: ${error instanceof Error ? error.message : String(error)}`)
      }
      const announced = []
      if (args.announce !== false && created.length > 0) {
        const byOwner = new Map()
        for (const task of created) {
          if (task.owner === null) continue
          byOwner.set(task.owner, [...(byOwner.get(task.owner) ?? []), task])
        }
        const current = loadTeam(team.id)
        for (const [ownerName, tasks] of byOwner) {
          const member = current.members.find((candidate) => candidate.name === ownerName)
          if (member === undefined || member.childId === undefined) {
            failures.push(`announce ${ownerName}: member has no session`)
            continue
          }
          const lines = [
            '【团队目标变更】',
            `新目标：${args.goal}`,
            previousGoal === null ? '旧目标：（无）' : `旧目标：${previousGoal}`,
            '',
            '你的任务：',
            ...tasks.map((task) => `- #${task.id} ${task.subject}${task.blockedBy.length === 0 ? '' : `（依赖：${task.blockedBy.map((id) => '#' + id).join('、')}）`}`),
            '',
            abandoned.length === 0
              ? '没有需要作废的旧任务。'
              : `已作废任务：${abandoned.map((id) => '#' + id).join('、')}，不要继续。`,
            '请：先 task_get 读详情 → 领任务 → 完成后 task_update（带上你读到的 revision）回报。',
          ]
          try {
            await ctx.subagents.sendMessage(caller, member.childId, [{ type: 'text', text: lines.join('\n') }], { signal: exec.signal })
            announced.push(ownerName)
          } catch (error) {
            failures.push(`announce ${ownerName}: ${error instanceof Error ? error.message : String(error)}`)
          }
        }
      }
      return {
        text: JSON.stringify({
          team: team.name,
          goal: args.goal,
          abandoned,
          created: created.map((task) => ({ id: task.id, subject: task.subject, owner: task.owner })),
          announced,
          ...(failures.length === 0 ? {} : { failures }),
        }),
      }
    },
  })

  register({
    name: 'respawn_member',
    description:
      'Replace one member with a fresh session under the same name, role, provider, and model, keeping its board tasks. Lead only. Use it when a member carries stale context from a previous goal.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['target'],
      properties: {
        team: { type: 'string' },
        target: { type: 'string' },
        context: { type: 'string', enum: ['fresh', 'fork'], description: 'Context mode for the new session. Defaults to fresh.' },
      },
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      const caller = callerOf(exec, 'respawn_member')
      const team = teamOf(caller, args.team)
      if (!canCoordinate(caller, team)) throw new Error('only the owner or the Team Lead may respawn members')
      const member = memberOf(team, args.target)
      if (member.childId !== undefined && running(member.childId)) {
        ctx.subagents.interrupt(member.childId, { kind: 'ancestor', agent: caller })
      }
      const previousChild = member.childId
      mutateTeam(team.id, (current) => {
        const target = current.members.find((candidate) => candidate.name === args.target)
        target.phase = 'provisioning'
        target.history = [...(target.history ?? []), previousChild].filter((id) => id !== undefined)
        target.error = undefined
      })
      const contextMode = args.context ?? 'fresh'
      const prompt =
        `You are "${member.name}"${member.role === null ? '' : ` (role: ${member.role})`} on team "${team.name}", restarted with a clean session. ` +
        `Read list_members({}) and task_list({}) to see the roster and your work, then reply READY and stop.`
      let started
      try {
        started = await ctx.subagents.startActivation({
          delivery: 'parent',
          provider: contextMode === 'fork' ? forkProvider : freshProvider,
          label: member.description,
          request: {
            prompt: [{ type: 'text', text: composePrompt(roles()[member.role ?? ''] ?? undefined, prompt) }],
            parent: caller,
            ...(member.provider === 'inherit' && member.model === 'inherit'
              ? {}
              : { agentOptions: { provider: member.provider, model: member.model } }),
          },
          signal: exec.signal,
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        mutateTeam(team.id, (current) => {
          const target = current.members.find((candidate) => candidate.name === args.target)
          target.phase = 'failed'
          target.error = message
        })
        throw error
      }
      const childId = started.childId
      mutateTeam(team.id, (current) => {
        const target = current.members.find((candidate) => candidate.name === args.target)
        target.phase = 'active'
        target.childId = childId
        target.context = contextMode
        target.respawnedAt = Date.now()
      })
      return { text: JSON.stringify({ respawned: args.target, previousChild, childId, context: contextMode }) }
    },
  })

  register({
    name: 'spawn_member',
    description:
      'Add one member to an existing Team. Lead only. The member shares this working directory; "fresh" starts empty, "fork" seeds completed Lead turns. Pass role for the catalog persona and default model route, and provider/model to override it for this member.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['name', 'description', 'prompt'],
      properties: {
        team: { type: 'string', description: 'Team id or name; defaults to the newest active Team.' },
        name: { type: 'string' },
        description: { type: 'string' },
        prompt: { type: 'string' },
        role: { type: 'string' },
        context: { type: 'string', enum: ['fresh', 'fork'] },
        provider: { type: 'string' },
        model: { type: 'string' },
        reasoningEffort: { type: 'string' },
      },
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      const caller = callerOf(exec, 'spawn_member')
      const team = teamOf(caller, args.team)
      if (!canCoordinate(caller, team)) throw new Error('only the owner or the Team Lead may spawn members')
      const started = await startMember(caller, team, args, exec.signal)
      return { text: `started teammate ${started} on team "${team.name}"` }
    },
  })

  register({
    name: 'list_members',
    description:
      'List the roster of one Team: the Lead row plus every member with target, role, model route, context mode, and availability.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { team: { type: 'string', description: 'Team id or name; defaults to the newest active Team.' } },
    },
    output: TEXT_OUTPUT,
    execute(args, exec) {
      const caller = callerOf(exec, 'list_members')
      const team = teamOf(caller, args.team)
      const rows = [
        leadRow(team),
        ...team.members.map((member) => ({
          team: team.name,
          target: member.name,
          role: member.role ?? 'teammate',
          model: member.model,
          effort: effortOf(member),
          context: member.context,
          status: statusOf(member),
        })),
      ]
      return { text: `${rosterTable(rows)}\n\n${JSON.stringify({ members: rows })}` }
    },
  })

  register({
    name: 'send_member_message',
    description:
      'Send one message to a teammate or to "lead". A running target receives it at its next step boundary; an inactive target resumes with it. Delivery does not wait for processing.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['target', 'message'],
      properties: {
        team: { type: 'string', description: 'Team id or name; defaults to the newest active Team.' },
        target: { type: 'string', description: 'Member name, "lead" (the Team Lead), or "owner" (the session).' },
        message: { type: 'string' },
      },
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      const caller = callerOf(exec, 'send_member_message')
      const team = teamFor(caller, args.team)
      const target =
        args.target === 'lead'
          ? team.leadId
          : args.target === 'owner'
            ? team.ownerId
            : memberOf(team, args.target).childId
      const messageId = await ctx.subagents.sendMessage(
        caller,
        target,
        [{ type: 'text', text: args.message }],
        { signal: exec.signal },
      )
      return { text: JSON.stringify({ sent: true, messageId }) }
    },
  })

  register({
    name: 'interrupt_member',
    description: 'Ask a teammate to stop its current turn. Lead only. The member keeps its session and can be resumed with a message.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['target'],
      properties: {
        team: { type: 'string', description: 'Team id or name; defaults to the newest active Team.' },
        target: { type: 'string' },
      },
    },
    output: TEXT_OUTPUT,
    execute(args, exec) {
      const caller = callerOf(exec, 'interrupt_member')
      const team = teamOf(caller, args.team)
      if (!canCoordinate(caller, team)) throw new Error('only the owner or the Team Lead may interrupt members')
      ctx.subagents.interrupt(memberOf(team, args.target).childId, { kind: 'ancestor', agent: caller })
      return { text: `interrupt requested for ${args.target}` }
    },
  })

  register({
    name: 'wait_members',
    description:
      'Wait up to timeout_ms for every running member of one Team to stop, then report the roster. Returns noProgress immediately when no member is running.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        team: { type: 'string' },
        timeout_ms: { type: 'integer' },
      },
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      const caller = callerOf(exec, 'wait_members')
      const team = teamFor(caller, args.team)
      const anyRunning = () => team.members.some((member) => member.phase === 'active' && running(member.childId))
      if (!anyRunning()) {
        return {
          text: JSON.stringify({
            noProgress: true,
            members: team.members.map((member) => ({ target: member.name, status: statusOf(member) })),
          }),
        }
      }
      const deadline = Date.now() + (args.timeout_ms ?? 30000)
      while (anyRunning() && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 400))
      }
      return {
        text: JSON.stringify({
          members: team.members.map((member) => ({ target: member.name, status: statusOf(member) })),
        }),
      }
    },
  })

  register({
    name: 'team_status',
    description:
      'Show one Team as two readable tables: its roster and its open task board. Omit team for the newest active Team.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { team: { type: 'string' } },
    },
    output: TEXT_OUTPUT,
    execute(args, exec) {
      const caller = callerOf(exec, 'team_status')
      const team = teamFor(caller, args.team)
      const rows = [
        leadRow(team),
        ...team.members.map((member) => ({
          team: team.name,
          target: member.name,
          role: member.role ?? 'teammate',
          model: member.model,
          effort: effortOf(member),
          context: member.context,
          status: statusOf(member),
        })),
      ]
      const open = team.tasks.filter(isOpen)
      const head = `${team.name}${team.goal === null ? '' : ` — ${team.goal}`} (${team.status})`
      return { text: `### ${head}\n\n${rosterTable(rows)}\n\n### Open tasks\n\n${taskTable(open)}` }
    },
  })

  register({
    name: 'task_create',
    description: 'Add one task to a Team board, optionally owned, blocked by earlier tasks, and limited to workspace-relative write scopes.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['subject'],
      properties: {
        team: { type: 'string' },
        subject: { type: 'string' },
        description: { type: 'string' },
        owner: { type: 'string' },
        blocked_by: { type: 'array', items: { type: 'integer' } },
        write_scopes: { type: 'array', items: { type: 'string' } },
        acceptance: { type: 'string', description: 'How the work is judged done: artifact paths, commands to run, evidence to paste.' },
        reviewer: { type: 'string', description: 'Member who accepts this task. Omit to use the team reviewer role, then the Team Lead.' },
      },
    },
    output: TEXT_OUTPUT,
    execute(args, exec) {
      const caller = callerOf(exec, 'task_create')
      const team = teamFor(caller, args.team)
      const scopes = args.write_scopes ?? []
      for (const scope of scopes) {
        if (scope.startsWith('/') || scope.includes('..')) throw new Error(`write scope must be workspace-relative: ${scope}`)
      }
      const created = mutateTeam(team.id, (current) => {
        if (current.tasks.length >= maxTasks) throw new Error(`Task limit ${maxTasks} reached`)
        for (const id of args.blocked_by ?? []) taskOf(current, id)
        if (args.owner !== undefined && !current.members.some((member) => member.name === args.owner)) {
          throw new Error(`task owner "${args.owner}" is not a member of this team`)
        }
        const task = {
          id: current.nextTaskNumber++,
          subject: args.subject,
          description: args.description ?? '',
          owner: args.owner ?? null,
          status: 'pending',
          blockedBy: args.blocked_by ?? [],
          writeScopes: scopes,
          acceptance: args.acceptance ?? '',
          reviewer: args.reviewer ?? null,
          evidence: '',
          reviewNote: '',
          submittedBy: null,
          reviewedBy: null,
          reviewedAt: null,
          revision: 1,
          createdAt: Date.now(),
        }
        current.tasks.push(task)
        return task
      })
      return { text: JSON.stringify(created) }
    },
  })

  register({
    name: 'task_list',
    description: 'List tasks on one Team board with status, owner, blockers, and write scopes.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        team: { type: 'string' },
        status: { type: 'string', enum: ['pending', 'in_progress', 'review', 'completed', 'abandoned'] },
        owner: { type: 'string' },
      },
    },
    output: TEXT_OUTPUT,
    execute(args, exec) {
      const caller = callerOf(exec, 'task_list')
      const team = teamFor(caller, args.team)
      const tasks = team.tasks.filter(
        (task) =>
          (args.status === undefined || task.status === args.status) &&
          (args.owner === undefined || task.owner === args.owner),
      )
      return { text: `${taskTable(tasks)}\n\n${JSON.stringify({ tasks })}` }
    },
  })

  register({
    name: 'task_get',
    description: 'Read one task by id from a Team board.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['id'],
      properties: {
        team: { type: 'string' },
        id: { type: 'integer' },
      },
    },
    output: TEXT_OUTPUT,
    execute(args, exec) {
      const caller = callerOf(exec, 'task_get')
      const team = teamFor(caller, args.team)
      return { text: JSON.stringify(taskOf(team, args.id)) }
    },
  })

  register({
    name: 'task_update',
    description:
      'Change one task. Pass the revision you read; a stale revision is rejected. Actions: claim, complete, reopen, edit, set_dependencies.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'revision', 'action'],
      properties: {
        team: { type: 'string' },
        id: { type: 'integer' },
        revision: { type: 'integer' },
        action: { type: 'string', enum: ['claim', 'submit', 'accept', 'reject', 'complete', 'reopen', 'abandon', 'edit', 'set_dependencies'] },
        evidence: { type: 'string', description: 'What proves the work is done: changed paths, commands run, results.' },
        note: { type: 'string', description: 'Why a submission is rejected, or a free-form note.' },
        reviewer: { type: 'string', description: 'Assign the reviewer for this task.' },
        owner: { type: 'string' },
        subject: { type: 'string' },
        description: { type: 'string' },
        write_scopes: { type: 'array', items: { type: 'string' } },
        blocked_by: { type: 'array', items: { type: 'integer' } },
      },
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      const caller = callerOf(exec, 'task_update')
      const team = teamFor(caller, args.team)
      const updated = mutateTeam(team.id, (current) => {
        const task = taskOf(current, args.id)
        if (task.revision !== args.revision) throw new Error(`stale revision ${args.revision}; current is ${task.revision}`)
        switch (args.action) {
          case 'claim': {
            if (task.status === 'completed') throw new Error(`task ${task.id} is already completed`)
            task.owner = args.owner ?? task.owner
            if (task.owner === null) throw new Error('claim requires an owner')
            task.status = 'in_progress'
            break
          }
          case 'submit': {
            if (task.status !== 'in_progress') throw new Error(`task ${task.id} is not in progress`)
            const evidence = (args.evidence ?? '').trim()
            if (evidence === '') throw new Error('submit requires evidence: changed paths, commands run, and their result')
            task.evidence = evidence
            task.submittedBy = nameOf(current, caller)
            task.status = 'review'
            break
          }
          case 'accept':
            if (task.status !== 'review') throw new Error(`task ${task.id} is not awaiting review`)
            task.status = 'completed'
            task.reviewNote = args.note ?? ''
            task.reviewedBy = nameOf(current, caller)
            task.reviewedAt = Date.now()
            break
          case 'reject':
            if (task.status !== 'review') throw new Error(`task ${task.id} is not awaiting review`)
            task.status = 'in_progress'
            task.reviewNote = args.note ?? 'rejected without a stated reason'
            task.reviewedBy = nameOf(current, caller)
            task.reviewedAt = Date.now()
            break
          case 'complete':
            task.status = 'completed'
            break
          case 'reopen':
            task.status = 'pending'
            break
          case 'abandon':
            task.status = 'abandoned'
            break
          case 'edit':
            if (args.subject !== undefined) task.subject = args.subject
            if (args.description !== undefined) task.description = args.description
            if (args.owner !== undefined) task.owner = args.owner
            if (args.write_scopes !== undefined) task.writeScopes = args.write_scopes
            if (args.acceptance !== undefined) task.acceptance = args.acceptance
            if (args.reviewer !== undefined) task.reviewer = args.reviewer
            break
          case 'set_dependencies':
            for (const id of args.blocked_by ?? []) {
              if (id === task.id) throw new Error(`task ${task.id} cannot block itself`)
              taskOf(current, id)
            }
            task.blockedBy = args.blocked_by ?? []
            break
          default:
            throw new Error(`unknown action ${args.action}`)
        }
        task.revision += 1
        return task
      })
      let announced = []
      let reviewer
      if (args.action === 'submit') {
        reviewer = await notifyReviewer(caller, loadTeam(team.id), updated)
      }
      if (args.action === 'complete' || args.action === 'accept') {
        announced = await wakeDependents(caller, loadTeam(team.id), [updated.id])
      }
      return {
        text: JSON.stringify({
          ...updated,
          ...(announced.length === 0 ? {} : { woke: announced }),
          ...(args.action !== 'submit'
            ? {}
            : reviewer === undefined
              ? { reviewer: null, note: 'no reviewer session: review this submission yourself' }
              : { reviewer }),
        }),
      }
    },
  })

  // ── Client projection ────────────────────────────────────────────────────
  // Every Team of the Lead is published per Lead Session so the browser can
  // render a Team switcher without any host RPC of its own.
  const projections = (ctx.root ?? ctx).sessionProjections
  if (projections !== undefined && typeof projections.register === 'function') {
    let publishedRevision = -1
    let published
    const view = () => {
      const leadId = published?.leadId
      const catalog = {
        roles: Object.entries(roles()).map(([id, role]) => ({
          id,
          provider: role.provider ?? null,
          model: role.model ?? null,
          reasoningEffort: role.reasoningEffort ?? null,
          description: role.description ?? null,
        })),
        templates: Object.entries(templates()).map(([id, template]) => ({
          id,
          name: template.name ?? id,
          description: template.description ?? null,
          members: (template.members ?? []).map((member) => ({ name: member.name, role: member.role ?? null })),
          tasks: (template.tasks ?? []).map((task) => ({ subject: task.subject, owner: task.owner ?? null })),
        })),
      }
      const draftView = (draft) => ({
        id: draft.id,
        name: draft.name,
        goal: draft.goal,
        notes: draft.notes,
        lead: draft.lead === null ? null : { role: draft.lead.role ?? null, model: draft.lead.model ?? null, effort: draft.lead.reasoningEffort ?? null },
        members: draft.members.map((member) => ({
          name: member.name,
          role: member.role,
          model: member.model,
          effort: member.reasoningEffort ?? null,
        })),
        tasks: draft.tasks.map((task) => ({
          subject: task.subject,
          owner: task.owner,
          blocked_by: task.blocked_by,
          acceptance: task.acceptance,
        })),
      })
      if (leadId === undefined) return { teams: [], drafts: [], ...catalog }
      return {
        ...catalog,
        drafts: draftsOf(leadId).map(draftView),
        teams: teamsOf(leadId).map((team) => ({
          id: team.id,
          name: team.name,
          goal: team.goal,
          status: team.status,
          template: team.template,
          members: [
            {
              name: 'lead',
              role: 'lead',
              model: team.lead?.model ?? 'this session',
              effort: leadEffort(team),
              context: team.lead?.context ?? '—',
              status:
                team.leadId === team.ownerId
                  ? 'running'
                  : team.lead?.phase === 'failed'
                    ? 'failed'
                    : running(team.leadId)
                      ? 'running'
                      : 'inactive',
              phase: 'active',
              usage: usageOf(team.leadId === team.ownerId ? undefined : team.leadId),
            },
            ...team.members.map((member) => ({
              ...memberView(member),
              status: statusOf(member),
              effort: effortOf(member),
              usage: usageOf(member.childId),
            })),
          ],
          tasks: team.tasks.map((task) => ({
            id: task.id,
            subject: task.subject,
            status: task.status,
            owner: task.owner,
            blockedBy: task.blockedBy,
            writeScopes: task.writeScopes,
            revision: task.revision,
          })),
        })),
      }
    }
    let disposeProjection
    try {
      projections.register({
      key: 'enterpriseTeam',
      stateVersion: 2,
      stateSchema: { parse: (value) => value },
      init: (header) => ({ leadId: header.id, revision: 0 }),
      apply: (state) => {
        const teams = teamsOf(state.leadId)
        const revision = teams.reduce((sum, team) => sum + (team.revision ?? 0), 0)
        if (revision === publishedRevision && published !== undefined) return published
        publishedRevision = revision
        published = { leadId: state.leadId, revision }
        return published
      },
      wire: {
        viewSchema: { parse: (value) => value },
        view: () => view(),
      },
    })
    } catch (error) {
      // A hot reload may find the previous registration still mounted; a failed
      // optional projection must not take the tools down with it.
      console.error('enterprise-team: projection registration failed', error)
    }
    if (typeof disposeProjection === 'function') ctx.on?.('dispose', disposeProjection)
  }

  // ── Per-agent policy and identity ────────────────────────────────────────
  const installed = new Map()
  const maybeInstall = (agent) => {
    if (installed.has(agent)) return
    const scoped = agent.ctx?.systemPrompt
    if (scoped?.section === undefined) return
    const membership = findTeamOfChild(agent.id)
    migrateLegacy(agent.id)
    const leads = teamsOf(agent.id).length > 0
    if (membership === undefined && !leads) return
    const disposers = []
    disposers.push(
      scoped.section({
        name: 'enterprise-team:policy',
        ...(scoped.getSectionOrder?.('TEAM_POLICY') === undefined
          ? {}
          : { order: scoped.getSectionOrder('TEAM_POLICY') }),
        text: POLICY,
      }),
    )
    if (membership !== undefined && scoped.context !== undefined) {
      const team = loadTeam(membership.teamId)
      const member = team?.members.find((candidate) => candidate.childId === agent.id)
      const identityText =
        membership.role === 'lead'
          ? `You are the Lead of team "${team?.name ?? 'unknown'}"${team?.goal ? ` — goal: ${team.goal}` : ''}.\n` +
            `You own this Team's roster and task board: create members with spawn_member, brief them, and coordinate through the board. ` +
            `The session that created the Team is its owner; report to it with send_member_message({ target: "owner", message: "..." }). ` +
            `Use list_teams({}) and team_status({}) to inspect state.`
          : `You are teammate "${member?.name ?? 'unknown'}" on team "${team?.name ?? 'unknown'}"${member?.role ? ` (role: ${member.role})` : ''}.\n` +
            `Your Team Lead is named "lead". Use send_member_message({ target: "lead", message: "..." }) to reach the Lead, ` +
            `list_members({}) for the roster, plan a task first, then work task-first and board-driven.`
      disposers.push(
        scoped.context({
          name: 'enterprise-team:identity',
          required: true,
          text: () => identityText,
        }),
      )
    }
    installed.set(agent, () => {
      for (const dispose of disposers) if (typeof dispose === 'function') dispose()
    })
  }
  for (const agent of ctx.agents.list?.() ?? []) maybeInstall(agent)
  ctx.on?.('agent/created', ({ agent }) => maybeInstall(agent))
  ctx.on?.('agent/disposed', ({ agent }) => {
    installed.get(agent)?.()
    installed.delete(agent)
  })
  ctx.on?.('dispose', () => {
    for (const dispose of installed.values()) dispose()
    installed.clear()
  })
}
