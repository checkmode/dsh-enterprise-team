/**
 * Offline client-bundle test: runs lib/client.js under a fake module loader and
 * React, then renders the right-pane tab and the header shortcut against fake
 * session projections.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const source = fs.readFileSync(path.join(import.meta.dirname, '..', 'lib', 'client.js'), 'utf8')

let loaded
const fakeWindow = {
  __ModuleLoader__: {
    load: (entry) => {
      loaded = entry
    },
  },
}

/** Minimal React stand-in: hooks and element construction only. */
const react = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() }),
  useState: (initial) => [initial, () => {}],
  useEffect: () => {},
  useMemo: (factory) => factory(),
  useRef: (value) => ({ current: value }),
  Fragment: 'fragment',
}

new Function('window', source)(fakeWindow)
assert.equal(loaded.id, 'dsh-enterprise-team')

const exports_ = loaded.factory((specifier) => {
  assert.equal(specifier, 'react')
  return react
})
assert.deepEqual(exports_.inject, [
  'slots',
  'sessions',
  'locale',
  'sidebarRightTabs',
  'sidebarRight',
  'remote',
  'remote.session',
])

const tabTypes = []
const registrations = []
const dictionaries = []
const opened = []
exports_.apply({
  effect: (factory) => factory(),
  locale: { register: (ns, dicts) => dictionaries.push({ ns, dicts }) },
  sidebarRightTabs: { register: (definition) => tabTypes.push(definition) },
  sidebarRight: { openTab: (kind) => opened.push(kind) },
  slots: {
    inject: (_name, register) => register(),
    register: (definition, component) => registrations.push({ definition, component }),
  },
})

assert.equal(dictionaries.length, 1)
assert.equal(tabTypes.length, 1)
assert.equal(tabTypes[0].id, 'enterprise-team')
assert.equal(tabTypes[0].kind, 'enterprise-team')
assert.equal(tabTypes[0].guide[0].order, 25)

const header = registrations.find((entry) => entry.definition.name === 'conversation.session.header.actions')
const body = registrations.find((entry) => entry.definition.name === 'sidebar.right.pane.tab')
assert.ok(header && body)
assert.equal(body.definition.key, 'enterprise-team')

/** Depth-first text collection. */
function texts(node, out = []) {
  if (node === null || node === undefined) return out
  if (Array.isArray(node)) {
    for (const child of node) texts(child, out)
    return out
  }
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return out
  }
  for (const child of node.children ?? []) texts(child, out)
  return out
}

/** Depth-first tag search. */
function tags(node, name, out = []) {
  if (node === null || node === undefined) return out
  if (Array.isArray(node)) {
    for (const child of node) tags(child, name, out)
    return out
  }
  if (typeof node !== 'object') return out
  if (node.type === name) out.push(node)
  for (const child of node.children ?? []) tags(child, name, out)
  return out
}

const data = {
  roles: [{ id: 'architect', model: 'gpt-6-luna' }, { id: 'implementer', model: 'deepseek-flash' }],
  templates: [
    {
      id: 'dev-squad',
      name: '开发小队',
      description: '三角小队',
      members: [{ name: 'architect', role: 'architect' }],
      tasks: [],
    },
  ],
  drafts: [
    {
      id: 'draft-a1',
      name: 'draft-squad',
      goal: 'deliver phase 2',
      notes: 'chose astra for the lead',
      lead: { role: 'architect', model: 'gpt-6-astra', effort: 'max' },
      members: [
        { name: 'core-eng', role: 'core-engineer', model: 'gpt-6.1-sol', effort: 'high' },
        { name: 'scribe-one', role: 'scribe', model: 'deepseek-flash', effort: null },
      ],
      tasks: [
        { subject: 'P1 baseline', owner: 'scribe-one', blocked_by: [], acceptance: 'records HEAD' },
        { subject: 'P1 callers', owner: 'core-eng', blocked_by: [1], acceptance: 'file:line list' },
      ],
    },
  ],
  teams: [
    {
      id: 'team-a',
      name: 'dev',
      goal: 'ship feature X',
      status: 'active',
      members: [
        { name: 'lead', role: 'lead', model: 'this session', context: '—', status: 'running' },
        {
          name: 'architect',
          role: 'architect',
          model: 'gpt-6-luna',
          effort: 'high',
          context: 'fresh',
          status: 'inactive',
          usage: { model: 'gpt-6-luna', input: 1200, output: 300, cached: 800, total: 1500, calls: 4 },
        },
        {
          name: 'implementer',
          role: 'implementer',
          model: 'deepseek-flash',
          effort: 'medium',
          context: 'fork',
          status: 'running',
          usage: { model: 'deepseek-flash', input: 500, output: 100, cached: 0, total: 600, calls: 2 },
        },
      ],
      tasks: [
        { id: 1, subject: 'plan', status: 'completed', owner: 'architect', blockedBy: [], writeScopes: [] },
        { id: 2, subject: 'impl', status: 'in_progress', owner: 'implementer', blockedBy: [1], writeScopes: ['src/'] },
        { id: 3, subject: 'old-work', status: 'abandoned', owner: 'architect', blockedBy: [], writeScopes: [] },
        {
          id: 4,
          subject: 'auth refactor',
          status: 'review',
          owner: 'implementer',
          blockedBy: [2],
          writeScopes: ['src/auth/'],
          revision: 3,
          evidence: 'src/auth/jwt.ts + pnpm test auth green',
          acceptance: 'no session path left',
        },
      ],
    },
    { id: 'team-b', name: 'review', goal: null, status: 'archived', members: [], tasks: [] },
  ],
}

const useSessions = (selector) =>
  selector({ projectionsBySession: { 'session-1': { values: { enterpriseTeam: data } } } })

const injected = header.definition.inject()
injected.openTeam()
assert.deepEqual(opened, ['enterprise-team'])
const headerTree = header.component({ sessionId: 'session-1', useSessions, openTeam: injected.openTeam })
const headerText = texts(headerTree)
assert.ok(headerText.includes('Team'))
assert.ok(headerText.includes('2'), 'teammate count')

const bodyTree = body.component({
  sessionId: 'session-1',
  useSessions,
  inputActions: { insertText: () => {} },
})
const bodyText = texts(bodyTree)
assert.ok(bodyText.join('').includes('待审核草案'))
assert.ok(bodyText.join('').includes('draft-squad'))
assert.ok(bodyText.includes('确认创建'))
assert.ok(bodyText.join('').includes('records HEAD'))
assert.ok(bodyText.join('').includes('gpt-6-astra'))
assert.ok(bodyText.includes('dev'))
assert.ok(bodyText.includes('review（已归档）'))
assert.equal(tags(bodyTree, 'table').length, 5, 'draft tables plus team, usage, and board tables')
assert.ok(bodyText.includes('ship feature X'))
assert.ok(bodyText.includes('Members (2)'))
assert.ok(bodyText.join('').includes('待认领 / 进行中 (1)'))
assert.ok(bodyText.join('').includes('待验收 (1)'))
assert.ok(bodyText.join('').includes('已完成 / 已放弃 (2)'))
assert.ok(bodyText.join('').includes('1 abandoned'))
assert.ok(bodyText.includes('通过'))
assert.ok(bodyText.includes('打回'))
assert.ok(bodyText.join('').includes('src/auth/jwt.ts'))
assert.ok(bodyText.join('').includes('no session path left'))
assert.ok(bodyText.includes('gpt-6-luna'))
assert.ok(bodyText.includes('deepseek-flash'))
assert.ok(bodyText.includes('high'), 'member effort shown')
assert.ok(bodyText.join('').includes('Token 用量（role × model）'))
assert.ok(bodyText.includes('合计'))
assert.ok(bodyText.includes('architect'))
assert.ok(bodyText.includes('implementer'))
assert.ok(bodyText.includes('1500'), 'per-model total tokens')
assert.ok(bodyText.includes('600'), 'per-model total tokens')
assert.ok(bodyText.includes('medium'), 'member effort shown')
assert.ok(bodyText.includes('impl'))
assert.ok(!bodyText.includes('plan'))
assert.ok(!bodyText.includes('old-work'), 'abandoned tasks leave the open board')
assert.ok(bodyText.join('').includes('1 abandoned'), 'abandoned work is still counted')
assert.ok(bodyText.includes('换目标'), 'the goal control is present')

const emptySessions = (selector) =>
  selector({ projectionsBySession: { 'session-1': { values: { enterpriseTeam: { teams: [] } } } } })
const emptyTree = body.component({
  sessionId: 'session-1',
  useSessions: emptySessions,
  inputActions: { insertText: () => {} },
})
const emptyText = texts(emptyTree)
assert.ok(emptyText.includes('还没有团队'))
assert.ok(emptyText.includes('从模板创建'))

console.log('client bundle ok:', loaded.id, '-> tab', tabTypes[0].id, '| header', header.definition.id)
