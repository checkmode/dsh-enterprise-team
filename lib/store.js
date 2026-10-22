/**
 * Durable Team state for the `enterprise-team` plugin.
 *
 * A Team is an explicit object: several Teams may share one Lead Session, so
 * every Team owns its own document under `teams/` and an index maps a Lead to
 * its Team ids. Nothing here depends on another package's event schemas, so the
 * state never needs a versioned replay parser.
 *
 * @module dsh-enterprise-team/store
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

/** DSH home directory, mirroring the harness default. */
function dshHome() {
  return process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
}

/** Root directory holding every Team document and the Lead index. */
export function rootDir() {
  return path.join(dshHome(), 'enterprise-team')
}

/** Directory holding one document per Team. */
export function teamsDir() {
  return path.join(rootDir(), 'teams')
}

/** Directory holding reviewed-but-uncreated Team drafts. */
export function draftsDir() {
  return path.join(rootDir(), 'drafts')
}

/** Index mapping a Lead agent id to its Team ids. */
export function indexPath() {
  return path.join(rootDir(), 'index.json')
}

/** Legacy single-document layout written before Teams became explicit. */
export function legacyPath(leadId) {
  return path.join(rootDir(), `${leadId}.json`)
}

/** One Team document path. */
export function teamPath(teamId) {
  return path.join(teamsDir(), `${teamId}.json`)
}

/** Read JSON, returning `undefined` for a missing or corrupt file. */
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

/** Write JSON atomically with private permissions. */
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  fs.renameSync(tmp, file)
}

/** A brand-new Team document. */
export function newTeam({ id, ownerId, leadId, name, goal, template }) {
  return {
    version: 4,
    id,
    ownerId: ownerId ?? leadId,
    leadId: leadId ?? ownerId,
    lead: null,
    name,
    goal: goal ?? null,
    template: template ?? null,
    status: 'active',
    createdAt: Date.now(),
    revision: 1,
    nextTaskNumber: 1,
    usedNames: [],
    members: [],
    tasks: [],
  }
}

/** Generate a Team id that is stable and readable. */
export function newTeamId() {
  return `team-${Math.random().toString(36).slice(2, 8)}`
}

/** Read the Lead → Team ids index. */
export function loadIndex() {
  return readJson(indexPath()) ?? {}
}

/** Persist the Lead → Team ids index. */
export function saveIndex(index) {
  writeJson(indexPath(), index)
}

/** Read one Team, or `undefined` when the document is missing. */
export function loadTeam(teamId) {
  return readJson(teamPath(teamId))
}

/** Persist one Team document and keep the Lead index in step. */
export function saveTeam(team) {
  team.revision = (team.revision ?? 0) + 1
  writeJson(teamPath(team.id), team)
  const index = loadIndex()
  const ids = new Set(index[team.leadId] ?? [])
  ids.add(team.id)
  index[team.leadId] = [...ids]
  saveIndex(index)
  return team
}

/** Apply one mutation to a Team document and persist it. */
export function mutateTeam(teamId, mutator) {
  const team = loadTeam(teamId)
  if (team === undefined) throw new Error(`unknown team "${teamId}"`)
  const result = mutator(team)
  saveTeam(team)
  return result
}

/** Every Team id owned by one Lead. */
export function teamIdsOf(leadId) {
  return [...(loadIndex()[leadId] ?? [])]
}

/** Every Team document owned by one Lead, newest first. */
export function teamsOf(leadId) {
  return teamIdsOf(leadId)
    .map((id) => loadTeam(id))
    .filter((team) => team !== undefined)
    .sort((a, b) => b.createdAt - a.createdAt)
}

/**
 * Resolve one Team by id, by name, or the newest active Team.
 * @param leadId - the Team Lead agent id.
 * @param ref - Team id, Team name, or undefined for the newest active Team.
 * @returns the Team document.
 */
export function resolveTeam(leadId, ref) {
  const teams = teamsOf(leadId)
  if (ref !== undefined && ref !== null && ref !== '') {
    const wanted = String(ref).trim().toLowerCase()
    const found = teams.find((team) => team.id === ref || team.name.toLowerCase() === wanted)
    if (found === undefined) throw new Error(`unknown team "${ref}"`)
    return found
  }
  const active = teams.find((team) => team.status === 'active')
  if (active === undefined) throw new Error('no active team yet; create one with create_team first')
  return active
}

/** Find which Lead and Team own one child agent. */
export function findTeamOfChild(childId) {
  let files
  try {
    files = fs.readdirSync(teamsDir())
  } catch {
    return undefined
  }
  for (const file of files) {
    if (!file.endsWith('.json')) continue
    const team = readJson(path.join(teamsDir(), file))
    if (team?.members?.some((member) => member.childId === childId)) {
      return { leadId: team.leadId, teamId: team.id, role: 'member', ownerId: team.ownerId ?? team.leadId }
    }
    if (team?.leadId === childId && team?.leadId !== (team?.ownerId ?? team?.leadId)) {
      return { leadId: team.leadId, teamId: team.id, role: 'lead', ownerId: team.ownerId ?? team.leadId }
    }
  }
  return undefined
}

/**
 * Import the single-document layout written before Teams became explicit.
 * Runs at most once per Lead: the legacy file is renamed after import.
 * @param leadId - the Team Lead agent id.
 * @returns the imported Team, or undefined when there is nothing to import.
 */
export function migrateLegacy(leadId) {
  const file = legacyPath(leadId)
  const legacy = readJson(file)
  if (legacy?.members === undefined) return undefined
  const team = newTeam({ id: newTeamId(), ownerId: leadId, leadId, name: 'default', goal: null, template: null })
  team.members = legacy.members ?? []
  team.tasks = legacy.tasks ?? []
  team.usedNames = legacy.usedNames ?? []
  team.nextTaskNumber = legacy.nextTaskNumber ?? 1
  saveTeam(team)
  try {
    fs.renameSync(file, `${file}.imported`)
  } catch {
    /* the index already points at the new document */
  }
  return team
}

/** Public member view for notices and the projection. */
export function memberView(member) {
  return {
    target: member.name,
    role: member.role ?? 'teammate',
    phase: member.phase,
    status:
      member.phase === 'failed' ? 'failed' : member.phase === 'provisioning' ? 'provisioning' : member.status,
    description: member.description,
    provider: member.provider,
    model: member.model,
    context: member.context,
    ...(member.error === undefined ? {} : { diagnostics: [member.error] }),
  }
}

/** One draft document path. */
export function draftPath(draftId) {
  return path.join(draftsDir(), `${draftId}.json`)
}

/** Generate a draft id. */
export function newDraftId() {
  return `draft-${Math.random().toString(36).slice(2, 8)}`
}

/** Persist one draft. */
export function saveDraft(draft) {
  writeJson(draftPath(draft.id), draft)
  return draft
}

/** Read one draft, or undefined when absent. */
export function loadDraft(draftId) {
  return readJson(draftPath(draftId))
}

/** Delete one draft; returns whether it existed. */
export function deleteDraft(draftId) {
  try {
    fs.unlinkSync(draftPath(draftId))
    return true
  } catch {
    return false
  }
}

/** Every draft owned by one Lead, newest first. */
export function draftsOf(leadId) {
  let files
  try {
    files = fs.readdirSync(draftsDir())
  } catch {
    return []
  }
  return files
    .filter((file) => file.endsWith('.json'))
    .map((file) => readJson(path.join(draftsDir(), file)))
    .filter((draft) => draft !== undefined && draft.leadId === leadId)
    .sort((a, b) => b.createdAt - a.createdAt)
}
