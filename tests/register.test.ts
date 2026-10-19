import type { On } from 'claude-code'
import type { Engine, Mounted } from 'claude-code/testing'
import { expect, mock, test } from 'claude-code/testing'
import { ClaimBoard, hydrateClaims } from '../hooks/core'
import { Scene } from '../hooks/replay'
import { machineTime } from './zone'

const CWD = '/work'

type World = {
  clock: ReturnType<typeof mock.clock>
  submitted: string[]
  appended: string[]
  writes: Map<string, string>
  saved: Map<string, unknown>
  agents: { id: string; name?: string; type: string; status: string; description: string; teammateId?: string; parentId?: string }[]
  files: Map<string, string>
  toolResult: unknown
  sends: { to: unknown; text: string }[]
  mtimes: Map<string, number>
  refusesSends: boolean
  commands: string[]
  statuses: (string | undefined)[]
  toasts: string[]
  /** Each toast's timeoutMs, in the order of `toasts`. */
  toastMs: (number | undefined)[]
  /** The plugin that holds `/swarm` already, so registering it is refused. */
  swarmTakenBy?: string
  descriptions: Map<string, string>
  toolCalls: Record<string, unknown>[]
  tools: Record<string, unknown>[]
  /** TaskStop refusals by task id. */
  denyStop: Map<string, string>
  /** Each of the mod's own sends takes the next promise and stays in flight until it resolves. */
  holdModSends: Promise<void>[]
}

/** Stubs every mods API call the mod makes, so each test drives events only. */
function world(on: On): World {
  const w: World = { clock: mock.clock(on, { now: 1_000_000 }), submitted: [], appended: [], writes: new Map(), saved: new Map(), agents: [], files: new Map(), toolResult: 'sent', sends: [], mtimes: new Map(), refusesSends: false, commands: [], statuses: [], toasts: [], toastMs: [], descriptions: new Map(), toolCalls: [], tools: [], denyStop: new Map(), holdModSends: [] }
  on('session.start', () => ({ cwd: CWD }))
  on('session.cwd', () => ({ value: CWD }))
  on('session.id', () => ({ value: 'abcdef0123' }))
  on('env.get', () => ({ value: undefined }))
  on('fs.exists', ($, e) => ({ value: w.files.has(e.path) }))
  on('fs.read', ($, e) => ({ value: w.files.get(e.path) ?? '' }) as never)
  on('fs.write', ($, e) => {
    w.writes.set(e.path, e.text)
    return { value: undefined }
  })
  on('process.run', ($, e) => {
    if (e.argv[0] === 'tail') return { value: { exitCode: 0, stdout: w.files.get(e.argv[3] ?? '') ?? '', stderr: '' } } as never
    w.appended.push(e.init?.stdin ?? '')
    return { value: { exitCode: 0, stdout: '', stderr: '' } } as never
  })
  on('store.get', ($, e) => ({ value: w.saved.get(e.key) }))
  on('store.set', ($, e) => {
    w.saved.set(e.key, e.value)
    return { value: undefined }
  })
  on('command.register', ($, e) => {
    if (e.name === 'swarm' && w.swarmTakenBy !== undefined) return { deny: `"/swarm" refused: the plugin ${w.swarmTakenBy} registered it already` } as never
    w.commands.push(e.name)
    w.descriptions.set(e.name, e.description)
    return { value: undefined } as never
  })
  on('ui.log', () => ({ value: undefined }))
  on('ui.status', ($, e) => {
    w.statuses.push(e.text)
    return { value: undefined } as never
  })
  on('ui.toast', ($, e) => {
    w.toasts.push(e.text)
    w.toastMs.push(e.timeoutMs)
    return { value: undefined } as never
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('agent.list', () => ({ value: w.agents }) as never)
  on('prompt.submit', ($, e) => {
    w.submitted.push(e.text)
    return { text: e.text }
  })
  on('session.send', async ($, e) => {
    if (e.origin?.kind === 'plugin') await w.holdModSends.shift()
    w.sends.push({ to: e.to, text: e.text })
    return w.refusesSends ? { isDelivered: false, reason: 'gone' } : { isDelivered: true }
  })
  on('fs.stat', ($, e, next) => {
    const m = w.mtimes.get(e.path)
    if (m === undefined) return next(e)
    return { value: { kind: 'file', size: 1, mtimeMs: m, isLink: false } } as never
  })
  on('session.receive', ($, e) => ({ text: e.text }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('tool.call', ($, e) => {
    w.toolCalls.push(e as unknown as Record<string, unknown>)
    const denied = e.tool === 'TaskStop' ? w.denyStop.get(String((e as unknown as { task_id?: unknown }).task_id)) : undefined
    return (denied === undefined ? { result: w.toolResult } : { deny: denied }) as never
  })
  on('tool.register', ($, e) => {
    w.tools.push(e as unknown as Record<string, unknown>)
    return { value: { tool: 'mcp__agent-swarm__' + e.name } } as never
  })
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['drawn by Claude Code'] }))
  return w
}

async function start($: { session: { start: (e: never) => Promise<unknown> } }) {
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: CWD } as never)
}

const PANE = {
  plugin: 'agent-swarm',
  component: 'Pane',
  requestId: 'swarm',
  surface: 'terminal',
  viewport: { columns: 100, rows: 40 },
  props: { title: 'swarm', isFocused: true, bodyColumns: 60, placement: 'inline', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

/** Mounts the pane in its text list view: the live look draws first, its `list` key switches. */
async function listPane($: Engine, props: unknown): Promise<Mounted> {
  const ui = await $.ui.mount(props as never)
  if ((await ui.find({ type: 'Raster' })) !== undefined) await ui.press({ key: 'view-list' })
  return ui
}

function peer(teammate: string) {
  return { kind: 'peer', teammate, isVerified: true } as const
}

test('a teammate message is logged once and appended to .swarm/log.jsonl', async ($, on) => {
  const w = world(on)
  await start($)
  await $.session.send({ to: 'builder', text: '[PROPOSE] split it\nmore', agentId: 'a1' } as never)
  await $.session.receive({ origin: peer('a1'), text: '[PROPOSE] split it\nmore', agentId: 'b1' } as never)
  await w.clock.advance(1100)
  const lines = w.appended.join('').trim().split('\n').map(l => JSON.parse(l))
  expect(lines.length).toBe(1)
  expect(lines[0]).toMatchObject({ to: 'builder', summary: '[PROPOSE] split it', length: 23, type: 'PROPOSE', via: 'send' })
})

test('a message sent to a code name is logged to the teammate that took it', async ($, on) => {
  const w = world(on)
  on('agent.spawn', ($, e) => ({ model: 'haiku', agentId: 'a-' + (e as { name: string }).name, teammateId: (e as { name: string }).name + '@s' }))
  await start($)
  for (const n of ['h03', 'h15']) await $.agent.spawn({ prompt: 'p', name: n, isTeammate: true } as never)
  await $.session.send({ to: 'h15', text: '[PROPOSE] hello jaspis', agentId: 'a-h03' } as never)
  await $.session.send({ to: 'jaspis', text: 'reviewed jaspis-03', agentId: 'a-h15' } as never)
  await w.clock.advance(1100)
  const lines = w.appended.join('').trim().split('\n').map(l => JSON.parse(l)).filter(l => l.from === 'h15' && l.type !== 'JOIN')
  expect(lines.map(l => l.to)).toEqual(['h03'])
})

test('a code name two teammates took goes to the live one: messages and stop_swarm([\'Atlas\']) reach t2, not the ended t1', async ($, on) => {
  const w = world(on)
  on('agent.spawn', ($, e) => ({ model: 'haiku', agentId: 'a-' + (e as { name: string }).name, teammateId: (e as { name: string }).name + '@s' }))
  await start($)
  const row = (n: string, status: string) => ({ id: 'a-' + n, name: n, type: 'teammate', status, description: '', teammateId: n + '@s' })
  await $.agent.spawn({ prompt: 'p', name: 't2', isTeammate: true } as never)
  await w.clock.advance(1_000)
  await $.agent.spawn({ prompt: 'p', name: 't1', isTeammate: true } as never)
  await $.agent.spawn({ prompt: 'p', name: 't3', isTeammate: true } as never)
  await $.session.send({ to: 't3', text: '[PROPOSE] hello Atlas', agentId: 'a-t1' } as never)
  await $.session.send({ to: 't3', text: '[PROPOSE] hello Atlas', agentId: 'a-t2' } as never)
  w.agents = [row('t1', 'killed'), row('t2', 'idle'), row('t3', 'running')]
  await w.clock.advance(4_100)
  await $.session.send({ to: 'Atlas', text: 'over to you', agentId: 'a-t3' } as never)
  await w.clock.advance(1_100)
  const lines = w.appended.join('').trim().split('\n').map(l => JSON.parse(l)).filter(l => l.from === 't3' && l.type !== 'JOIN')
  expect(lines.map(l => l.to)).toEqual(['t2'])
  await $.tool.call({ tool: 'mcp__agent-swarm__stop_swarm', names: ['Atlas'] } as never)
  expect(w.toolCalls.filter(c => c.tool === 'TaskStop').map(c => c.task_id)).toEqual(['t2'])
})

test('SendMessage with no session.send behind it is logged from the tool call', async ($, on) => {
  const w = world(on)
  await start($)
  const out = await $.tool.call({ tool: 'SendMessage', to: 'critic', message: '[ASK] ok?', agentId: 'a1' } as never)
  expect(out).toEqual({ result: 'sent' })
  await w.clock.advance(1100)
  expect(w.appended.join('')).toContain('"summary":"[ASK] ok?"')
  expect(w.appended.join('')).toContain('"via":"tool"')
})

test('spawn and agent list build roster.json', async ($, on) => {
  const w = world(on)
  on('agent.spawn', () => ({ model: 'claude-haiku', agentId: 'a1', teammateId: 'scout@session-abcdef01' }))
  await start($)
  await $.agent.spawn({ prompt: 'p', name: 'scout', isTeammate: true, subagentType: 'teammate' } as never)
  w.agents = [{ id: 'a1', name: 'scout', type: 'teammate', status: 'running', description: '' }]
  await w.clock.advance(5200)
  const roster = JSON.parse(w.writes.get(CWD + '/.swarm/roster.json') ?? '{}')
  expect(roster.agents[0]).toMatchObject({ id: 'a1', name: 'scout', model: 'claude-haiku', status: 'running', isTeammate: true })
})

test('a subagent keeps the teammate that spawned it, from the spawn or from the agent list, in roster.json', async ($, on) => {
  const w = world(on)
  on('agent.spawn', ($, e) => ({ model: 'claude-haiku', agentId: e.isTeammate === true ? 'a1' : 's1', teammateId: e.isTeammate === true ? 'scout@session-abcdef01' : undefined }) as never)
  await start($)
  await $.agent.spawn({ prompt: 'p', name: 'scout', isTeammate: true, subagentType: 'teammate' } as never)
  await $.agent.spawn({ prompt: 'p', description: 'scan the repo', subagentType: 'Explore', parentAgentId: 'a1' } as never)
  w.agents = [
    { id: 'a1', name: 'scout', type: 'teammate', status: 'running', description: '' },
    { id: 's1', type: 'Explore', status: 'running', description: 'scan the repo' },
    { id: 's2', type: 'Explore', status: 'running', description: 'read the docs', parentId: 'a1' },
  ]
  await w.clock.advance(5200)
  const roster = JSON.parse(w.writes.get(CWD + '/.swarm/roster.json') ?? '{}') as { agents: { id: string; parentId?: string }[] }
  expect(roster.agents.map(a => [a.id, a.parentId])).toEqual([['a1', undefined], ['s1', 'a1'], ['s2', 'a1']])
})

test('mentions (default): a peer message naming @lead wakes the lead once', async ($, on) => {
  const w = world(on)
  await start($)
  await $.session.receive({ origin: peer('scout'), text: 'plain chat', agentId: 'b1' } as never)
  await $.session.receive({ origin: peer('scout'), text: 'tie on schema, @lead decide', agentId: 'b1' } as never)
  await $.session.receive({ origin: peer('builder'), text: 'to you directly', } as never)
  await w.clock.advance(6000)
  expect(w.submitted.length).toBe(1)
  expect(w.submitted[0]).toContain('scout → b1: tie on schema, @lead decide')
  expect(w.submitted[0]).not.toContain('plain chat')
  expect(w.submitted[0]).not.toContain('to you directly')
})

test('all: a burst is coalesced and held while the lead is mid-turn', async ($, on) => {
  const w = world(on)
  await start($)
  expect(await $.command.run({ command: 'swarm', args: 'wake all' } as never)).toEqual({ text: 'wake mode: all' })
  expect(w.saved.get('wakeMode')).toBe('all')
  await $.turn.start({ turnId: 't1', text: 'go' } as never)
  for (const t of ['one', 'two', 'three']) await $.session.receive({ origin: peer('scout'), text: t, agentId: 'b1' } as never)
  await w.clock.advance(20_000)
  expect(w.submitted).toEqual([])
  await $.turn.complete({ turnId: 't1', answer: '', durationMs: 1, isAborted: false, reason: 'answer', usage: null } as never)
  await w.clock.advance(500)
  expect(w.submitted.length).toBe(1)
  expect(w.submitted[0]).toMatch(/3 new message/)
})

test('a reload keeps the session\'s wake mode though another session stored another since; a new session starts with the stored one', async ($, on) => {
  const w = world(on)
  await start($)
  await $.command.run({ command: 'swarm', args: 'wake digest' } as never)
  w.saved.set('wakeMode', 'all')
  await start($)
  expect(((await $.command.run({ command: 'swarm', args: 'status' } as never)) as { text: string }).text).toContain('wake: digest')
  w.saved.delete('wakeMode@session-abcdef01')
  await start($)
  expect(((await $.command.run({ command: 'swarm', args: 'status' } as never)) as { text: string }).text).toContain('wake: all')
})

test('digest: one summary per minute', async ($, on) => {
  const w = world(on)
  w.saved.set('wakeMode', 'digest')
  await start($)
  await $.session.receive({ origin: peer('scout'), text: 'x', agentId: 'b1' } as never)
  await w.clock.advance(30_000)
  expect(w.submitted).toEqual([])
  await w.clock.advance(32_000)
  expect(w.submitted.length).toBe(1)
  expect(w.submitted[0]).toMatch(/digest\): 1 new/)
})

test('off: no wake at all', async ($, on) => {
  const w = world(on)
  await start($)
  await $.command.run({ command: 'swarm', args: 'wake off' } as never)
  await $.session.receive({ origin: peer('scout'), text: '@lead help', agentId: 'b1' } as never)
  await w.clock.advance(120_000)
  expect(w.submitted).toEqual([])
})

test('stall watchdog wakes once when agents are idle and the task list is unreadable', async ($, on) => {
  const w = world(on)
  await start($)
  w.agents = [{ id: 'a1', name: 'scout', type: 'teammate', status: 'idle', description: '' }]
  await $.command.run({ command: 'swarm', args: 'stall 1' } as never)
  await w.clock.advance(4_100)
  await $.session.send({ to: 'critic', text: 'notes are in', agentId: 'a1' } as never)
  await w.clock.advance(62_000)
  expect(w.submitted.filter(t => t.startsWith('swarm stalled')).length).toBe(1)
  await w.clock.advance(120_000)
  expect(w.submitted.filter(t => t.startsWith('swarm stalled')).length).toBe(1)
})

test('/swarm opens the pane, which shows roster and messages and switches wake mode', async ($, on) => {
  const w = world(on)
  await start($)
  expect(await $.command.run({ command: 'swarm', args: '' } as never)).toEqual({})
  await $.session.send({ to: 'critic', text: '[REVIEW] looks fine', agentId: 'a1' } as never)
  const ui = await listPane($, PANE)
  expect(await ui.find({ type: 'Text', text: /^swarm: 0 agents · 1 msg/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /→ critic: \[REVIEW\] looks fine/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /team-lead/ })).toBeDefined()
  await ui.press({ key: 'wake-digest' })
  expect(w.saved.get('wakeMode')).toBe('digest')
  await ui.unmount()
})

test('the text list fits the pane: 130 other agents show as the newest 5 under a "… N more" line, and the newest message and the controls stay within the rows', async ($, on) => {
  const w = world(on)
  on('agent.spawn', () => ({ model: 'sonnet', agentId: 'a-parity', teammateId: 'parity@s' }))
  await start($)
  await $.agent.spawn({ prompt: 'p', name: 'parity', isTeammate: true } as never)
  const done = Array.from({ length: 130 }, (_, i) => ({ id: 'x' + i, name: 'worker' + i, type: 'general-purpose', status: 'completed', description: '' }))
  w.agents = [...done, { id: 'a-parity', name: 'parity', type: 'teammate', status: 'running', description: '', teammateId: 'parity@s' }]
  await w.clock.advance(4_100)
  for (let i = 0; i < 12; i++) await $.session.send({ to: 'team-lead', text: `status ${i}`, agentId: 'a-parity' } as never)
  const ui = await listPane($, PANE)
  const texts = (await ui.findAll({ type: 'Text' })).map(t => String((t as { text?: string }).text ?? ''))
  const rows = texts.lastIndexOf(' ', texts.indexOf('wake:'))
  expect(rows).toBeGreaterThan(0)
  expect(rows).toBeLessThanOrEqual(PANE.props.scroll.bodyRows - 2)
  expect(await ui.find({ type: 'Text', text: /^ {2}… 125 more$/ })).toBeDefined()
  expect(await ui.findAll({ type: 'Text', text: /worker\d+/ })).toHaveLength(5)
  expect(await ui.find({ type: 'Text', text: /worker129/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /parity → team-lead: status 11/ })).toBeDefined()
  await ui.unmount()
})

test('the band shows a one-line summary once the swarm is active', async ($, on) => {
  world(on)
  await start($)
  await $.session.send({ to: 'critic', text: 'hi', agentId: 'a1' } as never)
  const band = await $.ui.mount({
    plugin: 'agent-swarm',
    component: 'AbovePrompt',
    surface: 'terminal',
    viewport: { columns: 100, rows: 40 },
    props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 80, scroll: { offset: 0, bodyRows: 10 }, view: {} },
  } as never)
  expect(await band.find({ type: 'Text', text: /^swarm: 0 agents · 1 msg · last \d+s · wake: mentions · wakes 0 · held 0$/ })).toBeDefined()
})

test('code names from `[PROPOSE] hello <Name>` reach roster.json and the band', async ($, on) => {
  const w = world(on)
  on('agent.spawn', ($, e) => ({ model: 'sonnet', agentId: 'a-' + (e as { name: string }).name }))
  await start($)
  await $.agent.spawn({ prompt: 'p', name: 't1', isTeammate: true } as never)
  await $.agent.spawn({ prompt: 'p', name: 't2', isTeammate: true } as never)
  await $.session.send({ to: 't2', text: '[PROPOSE] hello Atlas\nmodel: sonnet', agentId: 'a-t1' } as never)
  await $.session.receive({ origin: peer('t2'), text: '[PROPOSE] hello Sage', agentId: 'a-t1' } as never)
  await w.clock.advance(1100)
  const roster = JSON.parse(w.writes.get(CWD + '/.swarm/roster.json') ?? '{}')
  expect(roster.agents.map((a: { label?: string }) => a.label)).toEqual(['Atlas (t1)', 'Sage (t2)'])
  const band = await $.ui.mount({
    plugin: 'agent-swarm',
    component: 'AbovePrompt',
    surface: 'terminal',
    viewport: { columns: 140, rows: 40 },
    props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 10 }, view: {} },
  } as never)
  expect(await band.find({ type: 'Text', text: /wake: mentions · wakes 0 · held 0 · Atlas \(t1\), Sage \(t2\)$/ })).toBeDefined()
})

test('claim watchdog: research [DONE] with no builder claim wakes the lead once, coalesced', async ($, on) => {
  const w = world(on)
  on('agent.spawn', ($, e) => ({ model: 'sonnet', agentId: 'a-' + (e as { name: string }).name }))
  await start($)
  await $.agent.spawn({ prompt: 'Goal: g\nDeliverable: var/swarm-test/gaps.md', name: 't1', isTeammate: true } as never)
  await $.agent.spawn({ prompt: 'Goal: g\nDeliverable: var/swarm-test/gaps.md', name: 't3', isTeammate: true } as never)
  await $.turn.start({ turnId: 'L1', text: 'go' } as never)
  await $.session.send({ to: 't1', text: '[CLAIM] research group A', agentId: 'a-t3' } as never)
  await $.session.send({ to: 'team-lead', text: '[DONE] research slice A: var/cand-quill.md', agentId: 'a-t3' } as never)
  await $.session.send({ to: 't1', text: '[HANDOFF] candidates in var/cand-quill.md', agentId: 'a-t3' } as never)
  await w.clock.advance(4000)
  expect(w.submitted).toEqual([])
  await $.turn.complete({ turnId: 'L1', answer: '', durationMs: 1, isAborted: false, reason: 'answer', usage: null } as never)
  await w.clock.advance(4000)
  const wakes = w.submitted.filter(t => t.includes('no builder claimed'))
  expect(wakes.length).toBe(1)
  expect(wakes[0]).toContain('swarm: no builder claimed for var/swarm-test/gaps.md')
  await $.session.send({ to: 'team-lead', text: '[DONE] again', agentId: 'a-t3' } as never)
  await w.clock.advance(60_000)
  expect(w.submitted.filter(t => t.includes('no builder claimed')).length).toBe(1)
  const roster = JSON.parse(w.writes.get(CWD + '/.swarm/roster.json') ?? '{}')
  expect(roster.deliverables).toEqual(['var/swarm-test/gaps.md'])
  expect(roster.claims).toEqual([{ role: 'research', target: 'group', key: 'research group', by: ['t3'] }])
})

test('claim watchdog: a builder [CLAIM] before the [DONE] keeps the lead asleep; the pane shows claims', async ($, on) => {
  const w = world(on)
  await start($)
  await $.command.run({ command: 'swarm', args: 'deliverable var/gaps.md' } as never)
  await $.session.receive({ origin: peer('t1'), text: '[CLAIM] build gaps.md', agentId: 'a-t3' } as never)
  await $.session.receive({ origin: peer('t2'), text: '[CLAIM] build gaps.md', agentId: 'a-t3' } as never)
  await $.session.receive({ origin: peer('t3'), text: '[DONE] research', agentId: 'a-t1' } as never)
  await w.clock.advance(10_000)
  expect(w.submitted.filter(t => t.includes('no builder claimed'))).toEqual([])
  const ui = await listPane($, PANE)
  expect(await ui.find({ type: 'Text', text: /^var\/gaps\.md · build t1, t2 ⚠ duplicate$/ })).toBeDefined()
  await ui.unmount()
})

test('claim watchdog: two teammates working unclaimed for N minutes wake the lead once', async ($, on) => {
  const w = world(on)
  await start($)
  w.agents = [
    { id: 'a1', name: 't1', type: 'teammate', status: 'running', description: '', teammateId: 't1@s' },
    { id: 'a2', name: 't2', type: 'teammate', status: 'running', description: '', teammateId: 't2@s' },
  ]
  await w.clock.advance(4_100)
  await $.session.send({ to: 't2', text: 'starting', agentId: 'a1' } as never)
  await w.clock.advance(146_000)
  expect(w.submitted).toEqual([])
  await w.clock.advance(40_000)
  const wakes = w.submitted.filter(t => t.includes('without a [CLAIM]'))
  expect(wakes.length).toBe(1)
  expect(wakes[0]).not.toContain('no builder')
  await w.clock.advance(300_000)
  expect(w.submitted.filter(t => t.includes('without a [CLAIM]')).length).toBe(1)
})

test('idle notifications are counted, logged as IDLE, delivered unchanged with the lead filter off and never a message or a wake', async ($, on) => {
  const w = world(on)
  await start($)
  await $.command.run({ command: 'swarm', args: 'wake all' } as never)
  await $.command.run({ command: 'swarm', args: 'quiet off' } as never)
  const body = '{"type":"idle_notification","from":"t3","idleReason":"available","summary":"[to t1] @lead [HANDOFF] x"}'
  const out = await $.session.receive({ origin: peer('t3'), text: body } as never)
  await $.session.receive({ origin: peer('t3'), text: body, agentId: 'a-t1' } as never)
  expect(out).toEqual({ text: body })
  await w.clock.advance(15_000)
  expect(w.submitted).toEqual([])
  const lines = w.appended.join('').trim().split('\n').map(l => JSON.parse(l))
  expect(lines.map(l => [l.type, l.from, l.idleReason])).toEqual([['IDLE', 't3', 'available'], ['IDLE', 't3', 'available']])
  const ui = await listPane($, PANE)
  expect(await ui.find({ type: 'Text', text: /^swarm: 0 agents · 0 msgs/ })).toBeDefined()
  await ui.unmount()
})

const GERMAN = /[äöüÄÖÜß„“]|\b(früher|und|nicht|keine?|oder|für|mit|Nachrichten?|Agenten|Aufgaben?|Fehler|wartet|letzte|Rolle|unbeansprucht)\b/i

test('every text the mod draws, replies or submits is English', async ($, on) => {
  const w = world(on)
  on('agent.spawn', ($, e) => ({ model: 'sonnet', agentId: 'a-' + ((e as { name?: string }).name ?? 'x') }))
  w.files.set(CWD + '/.swarm/log.jsonl', JSON.stringify({ ts: 1, from: 't9', to: 't8', summary: '[ASK] old thread', length: 16, via: 'send' }) + '\n')
  await start($)
  await $.agent.spawn({ prompt: 'Deliverable: out.md', name: 't1', isTeammate: true } as never)
  await $.agent.spawn({ prompt: 'p', name: 't2', isTeammate: true } as never)
  await $.session.send({ to: 't2', text: '[PROPOSE] hello Atlas', agentId: 'a-t1' } as never)
  await $.session.send({ to: 't1', text: '[CLAIM] research slice a', agentId: 'a-t2' } as never)
  await $.session.send({ to: 't2', text: '[CLAIM] research slice a', agentId: 'a-t1' } as never)
  await $.session.send({ to: 'team-lead', text: '[DONE] slice a', agentId: 'a-t2' } as never)
  await $.session.receive({ origin: peer('t2'), text: '{"type":"idle_notification","from":"t2","idleReason":"failed"}' } as never)
  w.agents = [{ id: 'a-t1', name: 't1', type: 'teammate', status: 'idle', description: '' }, { id: 'a-t2', name: 't2', type: 'teammate', status: 'idle', description: '' }]
  const replies: unknown[] = []
  for (const args of ['status', 'wake digest', 'wake bogus', 'stall 1', 'stall x', 'claim 2', 'claim x', 'deliverable', 'deliverable b.md', 'stall 0', 'claim 0', 'stall 1', 'claim 2']) {
    replies.push(await $.command.run({ command: 'swarm', args } as never))
  }
  await w.clock.advance(200_000)
  const pane = await listPane($, PANE)
  const band = await $.ui.mount({
    plugin: 'agent-swarm', component: 'AbovePrompt', surface: 'terminal', viewport: { columns: 200, rows: 40 },
    props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 200, scroll: { offset: 0, bodyRows: 10 }, view: {} },
  } as never)
  const drawn = [...(await pane.findAll({ type: 'Text' })), ...(await band.findAll({ type: 'Text' })), ...(await pane.findAll({ type: 'Button' }))]
    .map(t => t.text).filter(t => t !== 'drawn by Claude Code')
  const texts = [...drawn, ...replies.map(r => JSON.stringify(r)), ...w.submitted]
  expect(drawn.some(t => t.includes('earlier'))).toBe(true)
  expect(w.submitted.some(t => t.startsWith('swarm stalled'))).toBe(true)
  expect(w.submitted.some(t => t.includes('no builder claimed'))).toBe(true)
  expect(texts.filter(t => GERMAN.test(t))).toEqual([])
})

test('a reload restores the log tail and roster.json; a previous session shows dimmed under earlier', async ($, on) => {
  const w = world(on)
  const now = 'session-abcdef01'
  const line = (o: object) => JSON.stringify({ length: 1, via: 'send', ...o })
  w.files.set(CWD + '/.swarm/log.jsonl', [
    line({ ts: 1, from: 't1', to: 't2', summary: '[PROPOSE] hello Atlas', type: 'PROPOSE' }),
    line({ ts: 2, from: 't3', to: 'team-lead', summary: '{"type":"idle_notification","from":"t3"}', type: 'IDLE', via: 'receive' }),
    line({ ts: 900_000, from: 'a6bcbcbf', to: 'team-lead', summary: '[DONE] this session', type: 'DONE', session: now }),
    line({ ts: 900_001, from: 'a6bcbcbf', to: 'team-lead', summary: '{"type":"idle_notification"}', type: 'IDLE', session: now }),
  ].join('\n') + '\n')
  w.files.set(CWD + '/.swarm/roster.json', JSON.stringify({ session: now, agents: [
    { id: 'a6bcbcbf869b1bcd9', name: 'a6bcbcbf', model: 'claude-opus-5-5[1m]', status: 'running', isTeammate: false, description: 'Bench A: builder' },
  ] }))
  await start($)
  const ui = await listPane($, { ...PANE, props: { ...PANE.props, bodyColumns: 100 } })
  expect(await ui.find({ type: 'Text', text: /^swarm: 1 agent · 1 msg \(1 earlier\)/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^. Bench A: builder\s+opus 5\.5\s+running\s+1\/0 · waits 1 · 1m ago$/ })).toBeDefined()
  const earlier = await ui.find({ type: 'Text', text: /t1 → t2: \[PROPOSE\] hello Atlas$/ })
  expect(earlier?.props.dimColor).toBe(true)
  expect(await ui.find({ type: 'Text', text: /^── earlier ──$/ })).toBeDefined()
  const current = await ui.find({ type: 'Text', text: /Bench A: builder → team-lead: \[DONE\] this session$/ })
  expect(current?.props.dimColor).not.toBe(true)
  expect(await ui.findAll({ type: 'Text', text: /idle_notification/ })).toEqual([])
  await $.session.send({ to: 'x', text: 'new', agentId: 'a6bcbcbf869b1bcd9' } as never)
  w.agents = [{ id: 'a6bcbcbf869b1bcd9', type: 'general-purpose', status: 'idle', description: 'Bench A: builder' }]
  await w.clock.advance(6000)
  expect(JSON.parse(w.appended.join('').trim().split('\n')[0] ?? '{}').session).toBe(now)
  expect(JSON.parse(w.writes.get(CWD + '/.swarm/roster.json') ?? '{}').session).toBe(now)
})

test('an unnamed agent shows its spawn description; a model the spawn did not give shows –', async ($, on) => {
  const w = world(on)
  on('agent.spawn', () => ({ model: 'claude-haiku', agentId: 'a4c0c5ce99' }))
  await start($)
  await $.agent.spawn({ prompt: 'p', description: 'Bench A: builder' } as never)
  w.agents = [
    { id: 'a4c0c5ce99', type: 'general-purpose', status: 'running', description: 'Bench A: builder' },
    { id: 'a7777777aa', type: 'general-purpose', status: 'running', description: 'Spawned before load' },
    { id: 'a8888888bb', type: 'general-purpose', status: 'running', description: '' },
  ]
  await w.clock.advance(4100)
  const ui = await listPane($, { ...PANE, props: { ...PANE.props, bodyColumns: 100 } })
  expect(await ui.find({ type: 'Text', text: /^. Bench A: builder\s+haiku\s+running/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^. Spawned before load\s+–\s+running/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^. a8888888\s+–\s+running/ })).toBeDefined()
  await $.session.send({ to: 'a4c0c5ce99', text: 'by full id' } as never)
  expect(await ui.find({ type: 'Text', text: /team-lead → Bench A: builder: by full id$/ })).toBeDefined()
})

test('claim watchdog: measured from each teammate spawn, not from when the swarm or the mod started', async ($, on) => {
  const w = world(on)
  on('agent.spawn', ($, e) => ({ model: 'claude-opus-5-5[1m]', agentId: 'a-' + ((e as { name?: string }).name ?? 'x'), teammateId: ((e as { name?: string }).name ?? 'x') + '@session-6036d038' }))
  await start($)
  await $.agent.spawn({ prompt: 'p', description: 'Bench A: builder' } as never)
  await w.clock.advance(10 * 60_000)
  for (const n of ['t1', 't2', 't3']) await $.agent.spawn({ prompt: 'p', name: n, isTeammate: true } as never)
  await $.session.send({ to: 't2', text: '[PROPOSE] hello ridge', agentId: 'a-t1' } as never)
  await $.session.send({ to: 't1', text: '[PROPOSE] hello Kestrel (t2)', agentId: 'a-t2' } as never)
  await $.session.send({ to: 't1', text: '[PROPOSE] hello kestrel', agentId: 'a-t3' } as never)
  await w.clock.advance(22_000)
  expect(w.submitted.filter(t => t.includes('without a [CLAIM]'))).toEqual([])
  await w.clock.advance(3 * 60_000)
  expect(w.submitted.filter(t => t.includes('without a [CLAIM]')).length).toBe(1)
})

test('a reload restores claims, deliverables and fired alerts: live claims keep the watchdog quiet', async ($, on) => {
  const w = world(on)
  const now = 'session-abcdef01'
  const line = (o: object) => JSON.stringify({ length: 1, via: 'send', session: now, ...o })
  w.files.set(CWD + '/.swarm/log.jsonl', [
    line({ ts: 1, from: 't2', to: 't3', summary: '[CLAIM] build #155 (cache bug #418 on /search). Kestrel.', type: 'CLAIM' }),
    line({ ts: 2, from: 't3', to: 't1', summary: '[CLAIM] build #141', type: 'CLAIM' }),
    line({ ts: 3, from: 't1', to: 't2', summary: "[CLAIM] final gate — ack, you review #141. ridge runs the full gate after #141's approve", type: 'CLAIM' }),
  ].join('\n') + '\n')
  const teammate = (n: string) => ({ id: 'a-' + n, name: n, status: 'running', isTeammate: true, teammateId: n + '@session-6036d038', spawnedAt: 0 })
  w.files.set(CWD + '/.swarm/roster.json', JSON.stringify({ session: now, agents: ['t1', 't2', 't3'].map(teammate),
    deliverables: ['repo#158', 'repo#155', 'repo#141'],
    claims: [{ role: 'build', target: '#158 (chart label fit)', key: 'build #158 (chart label fit)', by: ['t1'] }],
    firedAlerts: ['no-builder the deliverable'] }))
  w.agents = ['t1', 't2'].map(n => ({ id: 'a-' + n, name: n, type: 'teammate', status: 'running', description: '', teammateId: n + '@session-6036d038' }))
  await start($)
  await w.clock.advance(5 * 60_000)
  expect(w.submitted).toEqual([])
  const roster = JSON.parse(w.writes.get(CWD + '/.swarm/roster.json') ?? '{}')
  expect(roster.claims.map((c: { by: string[] }) => c.by[0]).sort()).toEqual(['t1', 't2', 't3'])
  expect(roster.firedAlerts).toEqual(['no-builder the deliverable'])
})

test('a teammate renaming itself in a later message relabels it in roster.json and the pane', async ($, on) => {
  const w = world(on)
  on('agent.spawn', ($, e) => ({ model: 'claude-opus-5-5[1m]', agentId: 'a-' + (e as { name: string }).name, teammateId: (e as { name: string }).name + '@s' }))
  await start($)
  for (const n of ['t2', 't3']) await $.agent.spawn({ prompt: 'p', name: n, isTeammate: true } as never)
  await $.session.send({ to: 't1', text: '[PROPOSE] hello Kestrel (t2)', agentId: 'a-t2' } as never)
  await $.session.send({ to: 't1', text: '[PROPOSE] hello kestrel', agentId: 'a-t3' } as never)
  const ui = await listPane($, { ...PANE, props: { ...PANE.props, bodyColumns: 100 } })
  expect(await ui.find({ type: 'Text', text: /^. Kestrel \(t2\) ⚠ dup\s+opus 5\.5/ })).toBeDefined()
  await $.session.send({ to: 't2', text: '[PROPOSE] name clash + review rotation\nI (t3) rename to kite (t2 also picked kestrel).', agentId: 'a-t3' } as never)
  await $.session.receive({ origin: peer('t3'), text: '[PROPOSE] hello kestrel', agentId: 'a-t1' } as never)
  await w.clock.advance(1100)
  const roster = JSON.parse(w.writes.get(CWD + '/.swarm/roster.json') ?? '{}')
  expect(roster.agents.map((a: { label?: string }) => a.label)).toEqual(['Kestrel (t2)', 'kite (t3)'])
  expect(await ui.findAll({ type: 'Text', text: /⚠ dup/ })).toEqual([])
  expect(await ui.find({ type: 'Text', text: /^. kite \(t3\)\s+opus 5\.5/ })).toBeDefined()
})

test('workflow agents: named from the Workflow call, settled by their turn.complete, one ✓ line in the pane', async ($, on) => {
  const w = world(on)
  const RUN = 'wf_bc5e3b69-3d9'
  on('agent.spawn', ($, e) => ({ model: 'claude-sonnet-5-5', agentId: 'wf-' + (e as { description: string }).description }))
  w.toolResult = { status: 'async_launched', taskType: 'local_workflow', workflowName: 'dev-team', runId: RUN }
  await start($)
  await $.tool.call({ tool: 'Workflow', name: 'dev-team', args: {} } as never)
  for (const d of ['decompose', 'impl:a', 'integrate']) {
    await $.agent.spawn({ prompt: 'p', description: d, subagentType: 'workflow-subagent', workflow: { runId: RUN, agentIndex: 1 } } as never)
  }
  const ui = await listPane($, { ...PANE, props: { ...PANE.props, bodyColumns: 100 } })
  expect(await ui.find({ type: 'Text', text: /^● workflow dev-team · 3 agents · 0 running · 3 pending$/ })).toBeDefined()
  for (const d of ['decompose', 'impl:a', 'integrate']) {
    await $.turn.complete({ turnId: 'x-' + d, agentId: 'wf-' + d, answer: '', durationMs: 1, isAborted: false, reason: 'answer', usage: null } as never)
  }
  await w.clock.advance(1100)
  const done = await ui.find({ type: 'Text', text: /^✓ workflow dev-team · 3 agents$/ })
  expect(done?.props.dimColor).toBe(true)
  expect(await ui.findAll({ type: 'Text', text: /impl:a/ })).toEqual([])
  expect(JSON.parse(w.writes.get(CWD + '/.swarm/roster.json') ?? '{}').workflows).toEqual({ [RUN]: 'dev-team' })
})

test('[WAIT] <path>: an idle teammate is sent [ASK] <path> changed once per change, a change earlier in the turn included; a wait sent to the lead is not delivered', async ($, on) => {
  const w = world(on)
  const { sends, mtimes } = w
  on('agent.spawn', ($, e) => ({ model: 'claude-opus-5-5', agentId: 'a-' + (e as { name: string }).name, teammateId: (e as { name: string }).name + '@s' }))
  await start($)
  await $.agent.spawn({ prompt: 'Goal: g', name: 't1', isTeammate: true } as never)
  await $.agent.spawn({ prompt: 'Goal: g', name: 't2', isTeammate: true } as never)
  const f1 = '/wt/one/out/verdict.json'
  const f2 = '/wt/two/test.log'
  w.files.set(f1, JSON.stringify({ verdict: 'RED', failed: 2 }, null, 2))
  w.files.set(f2, 'ok 12 tests\n' + 'x'.repeat(300))
  mtimes.set(f1, w.clock.now() - 1000)
  await w.clock.advance(500)
  mtimes.set(f2, w.clock.now())
  await w.clock.advance(500)
  expect(await $.session.send({ to: 'team-lead', text: `[WAIT] ${f1}`, agentId: 'a-t1' } as never)).toMatchObject({ isDelivered: false })
  expect(await $.session.send({ to: 't1', text: `[WAIT] ${f2}\nrunning the suite`, agentId: 'a-t2' } as never)).toEqual({ isDelivered: true })
  expect(sends.map(x => x.text)).toEqual([`#1 · ${machineTime(1_001_000)}\n[WAIT] ${f2}\nrunning the suite`])
  await $.session.receive({ origin: peer('t1'), text: '{"type":"idle_notification","from":"t1","idleReason":"available"}' } as never)
  await $.session.receive({ origin: peer('t2'), text: '{"type":"idle_notification","from":"t2","idleReason":"available"}' } as never)
  await w.clock.advance(12_000)
  const asks = () => sends.filter(x => x.text.startsWith('swarm: [ASK] /wt/'))
  const t2Ask = { to: 'a-t2', text: `swarm: [ASK] ${f2} changed: ok 12 tests ${'x'.repeat(188)}` }
  expect(asks()).toEqual([t2Ask])
  mtimes.set(f1, w.clock.now() + 1)
  mtimes.set(f2, w.clock.now() + 1)
  await w.clock.advance(12_000)
  expect(asks()).toEqual([t2Ask, { to: 'a-t1', text: `swarm: [ASK] ${f1} changed: { "verdict": "RED", "failed": 2 }` }, t2Ask])
  await w.clock.advance(30_000)
  expect(asks().length).toBe(3)
  await $.session.send({ to: 't2', text: '[ASK] rerunning', agentId: 'a-t1' } as never)
  mtimes.set(f1, w.clock.now() + 1)
  await w.clock.advance(12_000)
  expect(asks().length).toBe(3)
  await w.clock.advance(1100)
  expect(JSON.parse(w.writes.get(CWD + '/.swarm/roster.json') ?? '{}').waits.t2).toMatchObject({ path: f2, wokenFor: expect.any(Number) })
})

test('the claims of a team that reused an ended team\'s names within 30 min are cleared when it ends, though a teammate outside it is still live', async ($, on) => {
  const w = world(on)
  let n = 0
  on('agent.spawn', ($, e) => ({ model: 'claude-opus-5-5', agentId: `a-${(e as { name: string }).name}-${++n}`, teammateId: (e as { name: string }).name + '@s' }))
  await start($)
  const row = (id: string, status: string) => ({ id, name: id.split('-')[1]!, type: 'teammate', status, description: '', teammateId: id.split('-')[1] + '@s' })
  for (const name of ['t1', 't2', 'x']) await $.agent.spawn({ prompt: 'Goal: g', name, isTeammate: true } as never)
  w.agents = [row('a-t1-1', 'running'), row('a-t2-2', 'running'), row('a-x-3', 'running')]
  await $.session.send({ to: 't2', text: '[CLAIM] build #7', agentId: 'a-t1-1' } as never)
  await w.clock.advance(4100)
  w.agents = [row('a-t1-1', 'killed'), row('a-t2-2', 'killed'), row('a-x-3', 'running')]
  await w.clock.advance(4100)
  for (const name of ['t1', 't2']) await $.agent.spawn({ prompt: 'Goal: g', name, isTeammate: true } as never)
  w.agents = [row('a-t1-1', 'killed'), row('a-t2-2', 'killed'), row('a-x-3', 'running'), row('a-t1-4', 'running'), row('a-t2-5', 'running')]
  await $.session.send({ to: 't2', text: '[CLAIM] build #8', agentId: 'a-t1-4' } as never)
  await w.clock.advance(4100)
  const claims = () => JSON.parse(w.writes.get(CWD + '/.swarm/roster.json') ?? '{}').claims.map((c: { key: string }) => c.key)
  expect(claims()).toEqual(['build #8'])
  w.agents = [row('a-t1-1', 'killed'), row('a-t2-2', 'killed'), row('a-x-3', 'running'), row('a-t1-4', 'killed'), row('a-t2-5', 'killed')]
  await w.clock.advance(5200)
  expect(claims()).toEqual([])
})

test('a claimant hears "is yours" once per slice, however it spells the target again', async ($, on) => {
  const w = world(on)
  on('agent.spawn', ($, e) => ({ model: 'claude-haiku', agentId: 'a-' + (e as { name: string }).name, teammateId: (e as { name: string }).name + '@s' }))
  await start($)
  for (const n of ['t1', 't2']) await $.agent.spawn({ prompt: 'p', name: n, isTeammate: true } as never)
  await $.session.send({ to: 't2', text: '[CLAIM] build docs/design.md', agentId: 'a-t1' } as never)
  await $.session.send({ to: 't2', text: '[CLAIM] build design.md', agentId: 'a-t1' } as never)
  expect(w.sends.filter(s => s.text.endsWith('is yours.'))).toEqual([{ to: 'a-t1', text: 'swarm: build docs/design.md is yours.' }])
})

test('a hello whose code name another teammate uses is answered once with a request for another; the first keeps it', async ($, on) => {
  const w = world(on)
  on('agent.spawn', ($, e) => ({ model: 'claude-opus-5-5', agentId: 'a-' + (e as { name: string }).name, teammateId: (e as { name: string }).name + '@s' }))
  await start($)
  for (const n of ['t1', 't2']) await $.agent.spawn({ prompt: 'p', name: n, isTeammate: true } as never)
  await $.session.send({ to: 't3', text: '[PROPOSE] hello kestrel', agentId: 'a-t1' } as never)
  await $.session.send({ to: 't3', text: '[PROPOSE] hello Kestrel', agentId: 'a-t2' } as never)
  const asks = w.sends.filter(s => s.text.includes('code name'))
  expect(asks.map(s => s.to)).toEqual(['a-t2'])
  expect(asks[0]?.text).toContain('already used by kestrel (t1)')
  await $.session.send({ to: 't3', text: '[PROPOSE] hello marten', agentId: 'a-t2' } as never)
  expect(w.sends.filter(s => s.text.includes('code name')).length).toBe(1)
})

test('claims of an ended team are cleared: a later team sees no stale claim or duplicate', async ($, on) => {
  const w = world(on)
  on('agent.spawn', ($, e) => ({ model: 'claude-opus-5-5', agentId: 'a-' + (e as { name: string }).name, teammateId: (e as { name: string }).name + '@s' }))
  await start($)
  for (const n of ['t1', 't2']) await $.agent.spawn({ prompt: 'Goal: g\nDeliverable: repo#155', name: n, isTeammate: true } as never)
  w.agents = ['t1', 't2', 't3'].map(n => ({ id: 'a-' + n, name: n, type: 'teammate', status: 'running', description: '', teammateId: n + '@s' }))
  await $.session.send({ to: 't2', text: '[CLAIM] build #155', agentId: 'a-t1' } as never)
  await $.session.send({ to: 't1', text: '[CLAIM] review #155', agentId: 'a-t2' } as never)
  await $.session.send({ to: 't1', text: '[REVIEW] #155 approve', agentId: 'a-t2' } as never)
  await w.clock.advance(4100)
  const ui = await listPane($, { ...PANE, props: { ...PANE.props, bodyColumns: 100 } })
  expect(await ui.find({ type: 'Text', text: /^#155 · build t1 · review t2 ✓approve$/ })).toBeDefined()
  w.agents = [{ id: 'a-t1', name: 't1', type: 'teammate', status: 'killed', description: '', teammateId: 't1@s' }]
  await w.clock.advance(4100)
  expect(await ui.findAll({ type: 'Text', text: /^#155 · / })).toHaveLength(0)
  await w.clock.advance(1100)
  const roster = JSON.parse(w.writes.get(CWD + '/.swarm/roster.json') ?? '{}')
  expect(roster.claims).toEqual([])
  expect(roster.deliverables).toEqual([])
  expect(typeof roster.claimsSince).toBe('number')
  await $.agent.spawn({ prompt: 'Goal: g\nDeliverable: repo#155', name: 'u1', isTeammate: true } as never)
  await $.agent.spawn({ prompt: 'Goal: g\nDeliverable: repo#155', name: 'u2', isTeammate: true } as never)
  w.agents = ['u1', 'u2'].map(n => ({ id: 'a-' + n, name: n, type: 'teammate', status: 'running', description: '', teammateId: n + '@s' }))
  await $.session.send({ to: 'u2', text: '[CLAIM] build #155', agentId: 'a-u1' } as never)
  await w.clock.advance(4100)
  expect(await ui.find({ type: 'Text', text: /^#155 · build u1$/ })).toBeDefined()
  expect(await ui.findAll({ type: 'Text', text: /^#155 · .*(t1|t2|duplicate)/ })).toHaveLength(0)
  await ui.unmount()
})

test('a reload after a team ended replays only the claims logged since', async ($, on) => {
  const w = world(on)
  const now = 'session-abcdef01'
  const line = (o: object) => JSON.stringify({ length: 1, via: 'send', session: now, ...o })
  w.files.set(CWD + '/.swarm/log.jsonl', [
    line({ ts: 990_001, from: 't1', to: 't2', summary: '[CLAIM] build #155', type: 'CLAIM' }),
    line({ ts: 990_005, from: 'u1', to: 'u2', summary: '[CLAIM] build #158', type: 'CLAIM' }),
  ].join('\n') + '\n')
  const teammate = (n: string, status: string) => ({ id: 'a-' + n, name: n, status, isTeammate: true, teammateId: n + '@s', spawnedAt: 0 })
  w.files.set(CWD + '/.swarm/roster.json', JSON.stringify({ session: now, agents: [teammate('t1', 'completed'), teammate('u1', 'running')], claims: [], claimsSince: 990_003 }))
  w.agents = [{ id: 'a-u1', name: 'u1', type: 'teammate', status: 'running', description: '', teammateId: 'u1@s' }]
  await start($)
  await w.clock.advance(4100)
  const ui = await listPane($, { ...PANE, props: { ...PANE.props, bodyColumns: 100 } })
  expect(await ui.find({ type: 'Text', text: /^#158 · build u1$/ })).toBeDefined()
  expect(await ui.findAll({ type: 'Text', text: /^#155 · / })).toHaveLength(0)
  await ui.unmount()
})

test('a teammate joining and leaving is logged once each, as a JOIN and a LEFT line; a teammate that ended before a reload logs none', async ($, on) => {
  const w = world(on)
  const now = 'session-abcdef01'
  const teammate = (n: string, status: string) => ({ id: 'a-' + n, name: n, status, isTeammate: true, teammateId: n + '@s', spawnedAt: 0 })
  w.files.set(CWD + '/.swarm/roster.json', JSON.stringify({ session: now, agents: [teammate('t1', 'completed')], claims: [] }))
  on('agent.spawn', ($, e) => ({ model: 'haiku', agentId: 'a-' + (e as { name: string }).name, teammateId: (e as { name: string }).name + '@s' }))
  await start($)
  const row = (n: string, status: string) => ({ id: 'a-' + n, name: n, type: 'teammate', status, description: '', teammateId: n + '@s' })
  await $.agent.spawn({ prompt: 'p', name: 't2', isTeammate: true } as never)
  await $.agent.spawn({ prompt: 'p', name: 'scout' } as never)
  w.agents = [row('t2', 'running')]
  await w.clock.advance(4_100)
  w.agents = [row('t2', 'completed')]
  await w.clock.advance(8_200)
  const lines = w.appended.join('').trim().split('\n').map(l => JSON.parse(l)).filter(l => l.type === 'JOIN' || l.type === 'LEFT')
  expect(lines.map(l => [l.type, l.from, l.summary, l.via])).toEqual([['JOIN', 't2', 'joined', 'tool'], ['LEFT', 't2', 'completed', 'tool']])
})

test('live, a teammate spawned after its team formed shows at once: its card slides in and the header says it joined', async ($, on) => {
  const w = world(on)
  on('agent.spawn', ($, e) => ({ model: 'haiku', agentId: 'a-' + (e as { name: string }).name, teammateId: (e as { name: string }).name + '@s' }))
  await start($)
  const row = (n: string) => ({ id: 'a-' + n, name: n, type: 'teammate', status: 'running', description: '', teammateId: n + '@s' })
  for (const n of ['t1', 't2']) await $.agent.spawn({ prompt: 'p', name: n, isTeammate: true } as never)
  w.agents = [row('t1'), row('t2')]
  await $.session.send({ to: 't2', text: '[PROPOSE] hello Finch', agentId: 'a-t1' } as never)
  await $.session.send({ to: 't1', text: '[PROPOSE] hello Wren', agentId: 'a-t2' } as never)
  await w.clock.advance(60_000)
  const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: 100 } } as never)
  await $.agent.spawn({ prompt: 'p', name: 't3', isTeammate: true } as never)
  w.agents = [row('t1'), row('t2'), row('t3')]
  await w.clock.advance(300)
  const sliding = await rasterText(ui)
  expect(sliding.split('\n')[0]).toContain('+ joined t3')
  expect(sliding.split('\n').find(r => r.includes('QUIET'))?.indexOf('▌')).toBeGreaterThan(1)
  await w.clock.advance(1_000)
  await $.session.send({ to: 't2', text: 'next', agentId: 'a-t1' } as never)
  expect((await rasterText(ui)).split('\n').find(r => r.includes('QUIET'))?.indexOf('▌')).toBe(1)
  await ui.unmount()
})

test('stall watchdog: nudges each open claim once, a teammate at most once per 10 min (the lead wake waits for it), wakes the lead when still quiet M min after, chatter or not', async ($, on) => {
  const w = world(on)
  on('agent.spawn', ($, e) => ({ model: 'claude-opus-5-5', agentId: 'a-' + (e as { name: string }).name, teammateId: (e as { name: string }).name + '@s' }))
  await start($)
  for (const n of ['t1', 't2', 't3']) await $.agent.spawn({ prompt: 'Goal: g', name: n, isTeammate: true } as never)
  w.agents = ['t1', 't2', 't3'].map(n => ({ id: 'a-' + n, name: n, type: 'teammate', status: 'idle', description: '', teammateId: n + '@s' }))
  await $.command.run({ command: 'swarm', args: 'stall 1' } as never)
  await $.session.send({ to: 't2', text: '[CLAIM] build #7', agentId: 'a-t1' } as never)
  await $.session.send({ to: 't1', text: '[CLAIM] review #7', agentId: 'a-t2' } as never)
  await $.session.send({ to: 't1', text: '[REVIEW] #7 approve', agentId: 'a-t2' } as never)
  await $.session.send({ to: 't1', text: '[CLAIM] research prior art', agentId: 'a-t3' } as never)
  await $.session.send({ to: 't1', text: '[DONE] prior art in notes.md', agentId: 'a-t3' } as never)
  const nudges = () => w.sends.filter(x => x.text.startsWith('swarm: [ASK] quiet'))
  const stalls = () => w.submitted.filter(t => t.startsWith('swarm stalled'))
  await w.clock.advance(62_000)
  expect(nudges()).toEqual([{ to: 'a-t1', text: 'swarm: [ASK] quiet 1 min: you hold build #7; reported: t2 REVIEW, t3 DONE. Continue, or send [DONE]/[BLOCK].' }])
  expect(stalls()).toEqual([])
  await w.clock.advance(62_000)
  expect(stalls().length).toBe(1)
  await w.clock.advance(120_000)
  expect(nudges().length).toBe(1)
  expect(stalls().length).toBe(1)
  for (let i = 0; i < 4; i++) {
    await $.session.send({ to: 't2', text: '[ASK] still on #7?', agentId: 'a-t1' } as never)
    await w.clock.advance(62_000)
  }
  expect(nudges().length).toBe(1)
  expect(stalls().length).toBe(5)
  await $.session.send({ to: 't2', text: '[CLAIM] build #7', agentId: 'a-t1' } as never)
  await w.clock.advance(62_000)
  expect(nudges().length).toBe(1)
  expect(stalls().length).toBe(5)
  await w.clock.advance(120_000)
  expect(nudges().length).toBe(2)
  expect(stalls().length).toBe(5)
  await w.clock.advance(62_000)
  expect(stalls().length).toBe(6)
})

test('one @lead mention between teammates wakes the lead once, even when the receiver takes it after the wake', async ($, on) => {
  const w = world(on)
  on('agent.spawn', ($, e) => ({ model: 'claude-opus-5-5', agentId: 'a-' + (e as { name: string }).name, teammateId: (e as { name: string }).name + '@s' }))
  await start($)
  for (const n of ['t1', 't2']) await $.agent.spawn({ prompt: 'Goal: g', name: n, isTeammate: true } as never)
  const text = '[ASK] tie on the schema, @lead decide'
  await $.session.send({ to: 't2', text, agentId: 'a-t1' } as never)
  await w.clock.advance(6000)
  expect(w.submitted.length).toBe(1)
  await w.clock.advance(60_000)
  await $.session.receive({ origin: peer('t1'), text, agentId: 'a-t2' } as never)
  await w.clock.advance(6000)
  expect(w.submitted.length).toBe(1)
})

test('one @lead mention from a teammate the roster has no name for yet wakes the lead once', async ($, on) => {
  const w = world(on)
  on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: 'a-t2-0123456789', teammateId: 't2@s' }))
  await start($)
  await $.agent.spawn({ prompt: 'Goal: g', name: 't2', isTeammate: true } as never)
  const text = '[ASK] tie on the schema, @lead decide'
  await $.session.send({ to: 't2', text, agentId: 'a-t1-0123456789' } as never)
  await $.session.receive({ origin: peer('t1'), text, agentId: 'a-t2-0123456789' } as never)
  await w.clock.advance(6000)
  expect(w.submitted.length).toBe(1)
  expect(w.submitted[0]).toContain('1 message(s)')
})

test('[WAIT]: a teammate whose status is running gets no ask when its file changes', async ($, on) => {
  const w = world(on)
  on('agent.spawn', ($, e) => ({ model: 'claude-opus-5-5', agentId: 'a-' + (e as { name: string }).name, teammateId: (e as { name: string }).name + '@s' }))
  await start($)
  await $.agent.spawn({ prompt: 'Goal: g', name: 't1', isTeammate: true } as never)
  const f = '/wt/one/out.json'
  w.files.set(f, 'done')
  await $.session.send({ to: 'team-lead', text: `[WAIT] ${f}`, agentId: 'a-t1' } as never)
  await $.session.receive({ origin: peer('t1'), text: '{"type":"idle_notification","from":"t1","idleReason":"available"}' } as never)
  w.agents = [{ id: 'a-t1', name: 't1', type: 'teammate', status: 'running', description: '', teammateId: 't1@s' }]
  w.mtimes.set(f, w.clock.now() + 1)
  await w.clock.advance(12_000)
  expect(w.sends.filter(x => x.text.startsWith('swarm: [ASK] /wt/'))).toEqual([])
  w.agents = [{ id: 'a-t1', name: 't1', type: 'teammate', status: 'idle', description: '', teammateId: 't1@s' }]
  await w.clock.advance(12_000)
  expect(w.sends.filter(x => x.text.startsWith('swarm: [ASK] /wt/')).length).toBe(1)
})

test('stall watchdog: an undelivered nudge does not count, so the lead is woken in the same quiet period', async ($, on) => {
  const w = world(on)
  on('agent.spawn', ($, e) => ({ model: 'claude-opus-5-5', agentId: 'a-' + (e as { name: string }).name, teammateId: (e as { name: string }).name + '@s' }))
  await start($)
  await $.agent.spawn({ prompt: 'Goal: g', name: 't1', isTeammate: true } as never)
  w.agents = [{ id: 'a-t1', name: 't1', type: 'teammate', status: 'idle', description: '', teammateId: 't1@s' }]
  await $.command.run({ command: 'swarm', args: 'stall 1' } as never)
  await $.session.send({ to: 't2', text: '[CLAIM] build #7', agentId: 'a-t1' } as never)
  w.refusesSends = true
  await w.clock.advance(62_000)
  expect(w.sends.filter(x => x.text.startsWith('swarm: [ASK] quiet')).length).toBe(1)
  expect(w.submitted.filter(t => t.startsWith('swarm stalled')).length).toBe(1)
})

test('a name reused by a later team: asks and nudges go to the live agent only; the ended team\'s waits are dropped', async ($, on) => {
  const w = world(on)
  let n = 0
  on('agent.spawn', ($, e) => ({ model: 'claude-opus-5-5', agentId: `a-${(e as { name: string }).name}-${++n}`, teammateId: (e as { name: string }).name + '@s' }))
  await start($)
  const row = (id: string, status: string) => ({ id, name: id.split('-')[1]!, type: 'teammate', status, description: '', teammateId: id.split('-')[1] + '@s' })
  await $.agent.spawn({ prompt: 'Goal: g', name: 't1', isTeammate: true } as never)
  await $.agent.spawn({ prompt: 'Goal: g', name: 't3', isTeammate: true } as never)
  w.agents = [row('a-t1-1', 'running'), row('a-t3-2', 'running')]
  await $.session.send({ to: 'team-lead', text: '[WAIT] /wt/old.json', agentId: 'a-t1-1' } as never)
  await $.session.send({ to: 'team-lead', text: '[WAIT] /wt/old3.json', agentId: 'a-t3-2' } as never)
  await $.session.send({ to: 't2', text: '[CLAIM] build #7', agentId: 'a-t1-1' } as never)
  await w.clock.advance(4100)
  w.agents = [row('a-t1-1', 'killed'), row('a-t3-2', 'killed')]
  await w.clock.advance(4100)
  await $.agent.spawn({ prompt: 'Goal: g', name: 't1', isTeammate: true } as never)
  await $.agent.spawn({ prompt: 'Goal: g', name: 't3', isTeammate: true } as never)
  w.agents = [row('a-t1-1', 'killed'), row('a-t3-2', 'killed'), row('a-t1-3', 'idle'), row('a-t3-4', 'idle')]
  await $.command.run({ command: 'swarm', args: 'stall 1' } as never)
  await w.clock.advance(1000)
  await $.session.send({ to: 'team-lead', text: '[WAIT] /wt/new.json', agentId: 'a-t1-3' } as never)
  await $.session.send({ to: 't2', text: '[CLAIM] build #8', agentId: 'a-t1-3' } as never)
  await $.session.receive({ origin: peer('t1'), text: '{"type":"idle_notification","from":"t1","idleReason":"available"}' } as never)
  await $.session.receive({ origin: peer('t3'), text: '{"type":"idle_notification","from":"t3","idleReason":"available"}' } as never)
  w.mtimes.set('/wt/old3.json', w.clock.now() + 1)
  w.mtimes.set('/wt/old.json', w.clock.now() + 1)
  w.mtimes.set('/wt/new.json', w.clock.now() + 1)
  await w.clock.advance(62_000)
  const mine = w.sends.filter(x => x.text.startsWith('swarm: [ASK]'))
  expect(mine.map(x => x.to)).toEqual(['a-t1-3', 'a-t1-3'])
  expect(mine.map(x => x.text.split(':').slice(0, 2).join(':'))).toEqual(['swarm: [ASK] /wt/new.json changed', 'swarm: [ASK] quiet 1 min'])
})

test('a [WAIT] to the lead without an absolute path is refused and asks for one', async ($, on) => {
  world(on)
  await start($)
  for (const text of ['[WAIT] out/verdict.json', '[WAIT] ~/out.json', '[WAIT]']) {
    const r = await $.session.send({ to: 'team-lead', text, agentId: 'a-t1' } as never) as { isDelivered: boolean; reason?: string }
    expect(r.isDelivered).toBe(false)
    expect(r.reason).toContain('use an absolute path')
  }
})

test('[WAIT] re-registered on the same path: a change already asked about never fires again', async ($, on) => {
  const w = world(on)
  on('agent.spawn', ($, e) => ({ model: 'claude-opus-5-5', agentId: 'a-' + (e as { name: string }).name, teammateId: (e as { name: string }).name + '@s' }))
  await start($)
  await $.agent.spawn({ prompt: 'Goal: g', name: 't1', isTeammate: true } as never)
  const f = '/wt/one/out.json'
  const idle = () => $.session.receive({ origin: peer('t1'), text: '{"type":"idle_notification","from":"t1","idleReason":"available"}' } as never)
  const asks = () => w.sends.filter(x => x.text.startsWith('swarm: [ASK] /wt/'))
  w.files.set(f, 'run1')
  await $.session.send({ to: 'team-lead', text: `[WAIT] ${f}`, agentId: 'a-t1' } as never)
  await idle()
  w.mtimes.set(f, w.clock.now() + 1)
  await w.clock.advance(12_000)
  expect(asks().length).toBe(1)
  await $.session.send({ to: 'team-lead', text: `[WAIT] ${f}`, agentId: 'a-t1' } as never)
  await idle()
  await w.clock.advance(30_000)
  expect(asks().length).toBe(1)
  w.files.set(f, 'run2')
  w.mtimes.set(f, w.clock.now() + 1)
  await w.clock.advance(12_000)
  expect(asks().map(x => x.text)).toEqual([`swarm: [ASK] ${f} changed: run1`, `swarm: [ASK] ${f} changed: run2`])
})

test('the mod logs its own nudges and wait asks to .swarm/log.jsonl as from swarm', async ($, on) => {
  const w = world(on)
  on('agent.spawn', ($, e) => ({ model: 'claude-opus-5-5', agentId: 'a-' + (e as { name: string }).name, teammateId: (e as { name: string }).name + '@s' }))
  await start($)
  await $.agent.spawn({ prompt: 'Goal: g', name: 't1', isTeammate: true } as never)
  w.agents = [{ id: 'a-t1', name: 't1', type: 'teammate', status: 'idle', description: '', teammateId: 't1@s' }]
  await $.command.run({ command: 'swarm', args: 'stall 1' } as never)
  w.files.set('/wt/out.json', '[CLAIM] build quoted')
  await $.session.send({ to: 'team-lead', text: '[WAIT] /wt/out.json', agentId: 'a-t1' } as never)
  await $.session.send({ to: 't2', text: '[CLAIM] build #7', agentId: 'a-t1' } as never)
  await $.session.receive({ origin: peer('t1'), text: '{"type":"idle_notification","from":"t1","idleReason":"available"}' } as never)
  w.mtimes.set('/wt/out.json', w.clock.now() + 1)
  await w.clock.advance(63_100)
  const own = w.appended.join('').trim().split('\n').map(l => JSON.parse(l)).filter(l => l.from === 'swarm')
  expect(own.map(l => [l.to, l.summary.split(':').slice(0, 2).join(':')])).toEqual([['t1', 'swarm: build #7 is yours.'], ['t1', 'swarm: [ASK] /wt/out.json changed'], ['t1', 'swarm: [ASK] quiet 1 min']])
  const roster = JSON.parse(w.writes.get(CWD + '/.swarm/roster.json') ?? '{}')
  expect(roster.claims.map((c: { key: string }) => c.key)).toEqual(['build #7'])
})

test('lead filter (default on): idle notices and protocol traffic to the lead are logged and held; asks, blocks, @lead, errors and any [DONE] reach it', async ($, on) => {
  const w = world(on)
  on('agent.spawn', ($, e) => ({ model: 'claude-opus-5-5', agentId: 'a-' + (e as { name: string }).name, teammateId: (e as { name: string }).name + '@s' }))
  await start($)
  const toLead = (from: string, text: string) => $.session.receive({ origin: peer(from), text } as never) as Promise<{ text?: string; consumed?: string }>
  const held = async (from: string, text: string) => expect((await toLead(from, text)).consumed).toBe('swarm quiet: held from the lead')
  const passed = async (from: string, text: string) => expect(await toLead(from, text)).toEqual({ text })
  for (const n of ['t1', 't2']) await $.agent.spawn({ prompt: 'Goal: g\nDeliverable: docs/report.md', name: n, isTeammate: true } as never)
  await $.session.send({ to: 't2', text: 'starting', agentId: 'a-t1' } as never)
  await held('t1', '{"type":"idle_notification","from":"t1","idleReason":"available"}')
  await held('t1', '{"type":"idle_notification","from":"t1"}')
  await held('t1', '[PROPOSE] hello Atlas')
  await held('t1', '[CLAIM] build the report')
  await held('t2', '[HANDOFF] docs/report.md')
  await held('t2', '<teammate-message from="t2">[REVIEW] #1 approve')
  await passed('t1', '{"type":"idle_notification","from":"t1","idleReason":"error"}')
  await passed('t2', '[CLAIM] review docs/report.md, @lead please confirm')
  await passed('t2', '[CLAIM] review docs/report.md\n[ASK] lead: which template?')
  await passed('t2', '[REVIEW] #1 notes\n[BLOCK] fails the gate')
  await passed('t2', '[ASK] which schema?')
  await passed('t2', '[BLOCK] #1 fails the gate')
  await passed('t2', '[DONE] research notes')
  await passed('t1', '[DONE] docs/report.md')
  await w.clock.advance(1100)
  const roster = JSON.parse(w.writes.get(CWD + '/.swarm/roster.json') ?? '{}')
  expect(roster.claims.map((c: { key: string }) => c.key)).toContain('build report')
  expect(roster.agents[0].idleNotices).toBe(3)
  expect((await $.command.run({ command: 'swarm', args: 'status' } as never) as { text: string }).text).toContain('wakes 8 · held 6')
  expect(await $.command.run({ command: 'swarm', args: 'quiet off' } as never)).toEqual({ text: 'lead filter: off' })
  expect(w.saved.get('quiet')).toBe(false)
  await passed('t1', '[PROPOSE] hello again')
})

test('[WAIT] until <ISO-8601 time>: kept from the lead; the idle teammate is woken once at that time', async ($, on) => {
  const w = world(on)
  on('agent.spawn', ($, e) => ({ model: 'claude-opus-5-5', agentId: 'a-' + (e as { name: string }).name, teammateId: (e as { name: string }).name + '@s' }))
  await start($)
  await $.agent.spawn({ prompt: 'Goal: g', name: 't1', isTeammate: true } as never)
  const at = new Date(w.clock.now() + 60_000).toISOString()
  expect(await $.session.send({ to: 'team-lead', text: `[WAIT] until ${at}`, agentId: 'a-t1' } as never)).toMatchObject({ isDelivered: false })
  expect((await $.session.send({ to: 'team-lead', text: '[WAIT] until soon', agentId: 'a-t1' } as never) as { reason: string }).reason).toContain('until <ISO-8601 time>')
  await $.session.receive({ origin: peer('t1'), text: '{"type":"idle_notification","from":"t1","idleReason":"available"}' } as never)
  const asks = () => w.sends.filter(x => x.text.startsWith('swarm: [ASK]'))
  await w.clock.advance(50_000)
  expect(asks()).toEqual([])
  await w.clock.advance(12_000)
  expect(asks()).toEqual([{ to: 'a-t1', text: `swarm: [ASK] ${at} reached: the time your [WAIT] named` }])
  await w.clock.advance(60_000)
  expect(asks().length).toBe(1)
})

test('claim TTL: a stale claim shows as stale and the stall nudge still covers it', async ($, on) => {
  const w = world(on)
  on('agent.spawn', ($, e) => ({ model: 'claude-opus-5-5', agentId: 'a-' + (e as { name: string }).name, teammateId: (e as { name: string }).name + '@s' }))
  await start($)
  await $.agent.spawn({ prompt: 'Goal: g', name: 't1', isTeammate: true } as never)
  w.agents = [{ id: 'a-t1', name: 't1', type: 'teammate', status: 'idle', description: '', teammateId: 't1@s' }]
  await $.command.run({ command: 'swarm', args: 'stall 12' } as never)
  await $.session.send({ to: 't2', text: '[CLAIM] build #7', agentId: 'a-t1' } as never)
  await w.clock.advance(12 * 60_000 + 4000)
  const ui = await listPane($, { ...PANE, props: { ...PANE.props, bodyColumns: 100 } })
  expect(await ui.find({ type: 'Text', text: /^#7 · build t1 stale$/ })).toBeDefined()
  await ui.unmount()
  expect(w.sends.filter(x => x.text.startsWith('swarm: [ASK] quiet 12 min: you hold build #7')).length).toBe(1)
})

test('the pane marks a teammate idle past the set stall minutes with an open claim as stalled', async ($, on) => {
  const w = world(on)
  on('agent.spawn', ($, e) => ({ model: 'claude-opus-5-5', agentId: 'a-' + (e as { name: string }).name, teammateId: (e as { name: string }).name + '@s' }))
  await start($)
  await $.agent.spawn({ prompt: 'Goal: g', name: 't1', isTeammate: true } as never)
  w.agents = [{ id: 'a-t1', name: 't1', type: 'teammate', status: 'idle', description: '', teammateId: 't1@s' }]
  await $.command.run({ command: 'swarm', args: 'stall 1' } as never)
  await $.session.send({ to: 't2', text: '[CLAIM] build #7', agentId: 'a-t1' } as never)
  await $.session.receive({ origin: peer('t1'), text: '{"type":"idle_notification","from":"t1","idleReason":"available"}' } as never)
  await w.clock.advance(70_000)
  const ui = await listPane($, { ...PANE, props: { ...PANE.props, bodyColumns: 100 } })
  expect(await ui.find({ type: 'Text', text: /^! t1\s+opus 5\.5\s+stalled/ })).toBeDefined()
  await ui.unmount()
})

test('lead filter: deliveries from another session or from an agent outside the current team pass untouched', async ($, on) => {
  world(on)
  on('agent.spawn', ($, e) => ({ model: 'claude-opus-5-5', agentId: 'a-' + (e as { name: string }).name, teammateId: (e as { name: string }).name + '@s' }))
  await start($)
  await $.agent.spawn({ prompt: 'Goal: g', name: 't1', isTeammate: true } as never)
  await $.session.send({ to: 't2', text: 'starting', agentId: 'a-t1' } as never)
  for (const origin of [{ kind: 'peer' }, peer('x9')]) {
    expect(await $.session.receive({ origin, text: '[CLAIM] build elsewhere' } as never)).toEqual({ text: '[CLAIM] build elsewhere' })
  }
  expect(await $.session.receive({ origin: peer('t1'), text: '[CLAIM] build here' } as never)).toMatchObject({ consumed: expect.any(String) })
})

test('lead filter: a stored quiet off is restored on load', async ($, on) => {
  const w = world(on)
  on('agent.spawn', ($, e) => ({ model: 'claude-opus-5-5', agentId: 'a-' + (e as { name: string }).name, teammateId: (e as { name: string }).name + '@s' }))
  w.saved.set('quiet', false)
  await start($)
  await $.agent.spawn({ prompt: 'Goal: g', name: 't1', isTeammate: true } as never)
  expect(await $.session.receive({ origin: peer('t1'), text: '[CLAIM] build here' } as never)).toEqual({ text: '[CLAIM] build here' })
})

/** The glyphs every Raster of a mounted pane shows, rows joined. */
async function rasterText(ui: Mounted): Promise<string> {
  const out: string[] = []
  for (const r of await ui.findAll({ type: 'Raster' })) {
    const bytes = Uint8Array.from(atob(String(r.props.cells)), ch => ch.charCodeAt(0))
    const words = new Uint32Array(bytes.buffer)
    const cols = Number(r.props.columns)
    for (let i = 0; i < words.length; i += 3 * cols) {
      let line = ''
      for (let k = i; k < i + 3 * cols; k += 3) line += String.fromCharCode(words[k]!)
      out.push(line)
    }
  }
  return out.join('\n')
}

test('the live pane draws look A: each card shows its teammate\'s last action, one FILE line per file change; look B on its key', async ($, on) => {
  const w = world(on)
  on('agent.spawn', ($, e) => ({ model: 'claude-opus-5-5', agentId: 'a-' + (e as { name: string }).name, teammateId: (e as { name: string }).name + '@s' }))
  await start($)
  for (const n of ['t1', 't2']) await $.agent.spawn({ prompt: 'Goal: g', name: n, isTeammate: true } as never)
  await $.session.send({ to: 't2', text: '[PROPOSE] hello Finch', agentId: 'a-t1' } as never)
  await $.tool.call({ tool: 'Edit', file_path: CWD + '/hooks/core.ts', old_string: 'a', new_string: 'b', agentId: 'a-t1' } as never)
  await $.tool.call({ tool: 'Edit', file_path: CWD + '/hooks/core.ts', old_string: 'b', new_string: 'c', agentId: 'a-t1' } as never)
  await $.tool.call({ tool: 'Read', file_path: CWD + '/README.md', agentId: 'a-t2' } as never)
  await $.tool.call({ tool: 'Read', file_path: CWD + '/lead-only.md' } as never)
  await w.clock.advance(1100)
  const files = w.appended.join('').trim().split('\n').map(l => JSON.parse(l)).filter(l => l.type === 'FILE')
  expect(files.map(l => [l.from, l.summary])).toEqual([['t1', '✎ hooks/core.ts'], ['t2', '◦ README.md']])
  const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: 100 } } as never)
  const cells = await rasterText(ui)
  expect(cells).toContain('LIVE · t1–t2')
  expect(cells).toMatch(/Finch t1 .*\n.*Editing hooks\/core\.ts/)
  expect(cells).toContain('Reading README.md')
  expect((await ui.find({ type: 'Box', key: 'views' }))?.props.display).toBe('none')
  expect((await ui.findAll({ type: 'Button' })).filter(b => b.key?.startsWith('view-')).map(b => [b.key, b.props.hotkey])).toEqual([['view-list', 'l'], ['view-A', '1'], ['view-B', '2']])
  await ui.press({ key: 'view-B' })
  expect(await rasterText(ui)).toContain('LEAD')
  await ui.press({ key: 'view-list' })
  expect(await ui.find({ type: 'Raster' })).toBeUndefined()
  expect((await ui.findAll({ type: 'Button' })).filter(b => b.key?.startsWith('view-')).map(b => b.key)).toEqual(['view-list', 'view-A', 'view-B'])
  expect((await ui.find({ type: 'Box', key: 'views' }))?.props.display).toBe('none')
  await ui.press({ key: 'view-A' })
  expect(await rasterText(ui)).toContain('LIVE · t1–t2')
  await ui.unmount()
})

test('named agents that only report to the lead are no swarm: no stall wake, no claim wake, nothing held, until two of them message each other', async ($, on) => {
  const w = world(on)
  on('agent.spawn', ($, e) => ({ model: 'claude-opus-5-5', agentId: 'a-' + (e as { name: string }).name, teammateId: (e as { name: string }).name + '@s' }))
  await start($)
  for (const n of ['builder-x', 'checker-y']) await $.agent.spawn({ prompt: 'Goal: g', name: n, isTeammate: true } as never)
  w.agents = ['builder-x', 'checker-y'].map(n => ({ id: 'a-' + n, name: n, type: 'teammate', status: 'idle', description: '', teammateId: n + '@s' }))
  await $.command.run({ command: 'swarm', args: 'stall 1' } as never)
  expect(await $.session.receive({ origin: peer('builder-x'), text: '[DONE] parser built' } as never)).toEqual({ text: '[DONE] parser built' })
  expect(await $.session.receive({ origin: peer('checker-y'), text: '[PROPOSE] plan' } as never)).toEqual({ text: '[PROPOSE] plan' })
  await w.clock.advance(5 * 60_000)
  expect(w.submitted).toEqual([])
  await $.session.send({ to: 'checker-y', text: 'over to you', agentId: 'a-builder-x' } as never)
  expect(await $.session.receive({ origin: peer('checker-y'), text: '[PROPOSE] plan' } as never)).toMatchObject({ consumed: expect.any(String) })
  await w.clock.advance(3 * 60_000)
  expect(w.submitted.filter(t => t.startsWith('swarm: 2 teammates working without a [CLAIM]')).length).toBe(1)
  expect(w.submitted.filter(t => t.startsWith('swarm stalled')).length).toBe(1)
})

test('the band lists only the current team: an ended team\'s code names drop out', async ($, on) => {
  const w = world(on)
  on('agent.spawn', ($, e) => ({ model: 'sonnet', agentId: 'a-' + (e as { name: string }).name, teammateId: (e as { name: string }).name + '@s' }))
  await start($)
  for (const n of ['t1', 't2']) await $.agent.spawn({ prompt: 'p', name: n, isTeammate: true } as never)
  await $.session.send({ to: 't2', text: '[PROPOSE] hello Atlas', agentId: 'a-t1' } as never)
  await $.session.send({ to: 't1', text: '[PROPOSE] hello Sage', agentId: 'a-t2' } as never)
  w.agents = ['t1', 't2'].map(n => ({ id: 'a-' + n, name: n, type: 'teammate', status: 'killed', description: '', teammateId: n + '@s' }))
  await w.clock.advance(5 * 60_000)
  for (const n of ['u1', 'u2']) await $.agent.spawn({ prompt: 'p', name: n, isTeammate: true } as never)
  await $.session.send({ to: 'u2', text: '[PROPOSE] hello Kite', agentId: 'a-u1' } as never)
  const band = await $.ui.mount({
    plugin: 'agent-swarm',
    component: 'AbovePrompt',
    surface: 'terminal',
    viewport: { columns: 140, rows: 40 },
    props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 10 }, view: {} },
  } as never)
  expect(await band.find({ type: 'Text', text: /held 0 · Kite \(u1\)$/ })).toBeDefined()
})

test('FILE lines: every change of an edited file is logged; a read only when the teammate has not read that file in the last 5 min', async ($, on) => {
  const w = world(on)
  on('agent.spawn', ($, e) => ({ model: 'claude-opus-5-5', agentId: 'a-' + (e as { name: string }).name, teammateId: (e as { name: string }).name + '@s' }))
  await start($)
  await $.agent.spawn({ prompt: 'Goal: g', name: 't1', isTeammate: true } as never)
  const call = (tool: string, file: string) => $.tool.call({ tool, file_path: CWD + '/' + file, agentId: 'a-t1' } as never)
  for (const f of ['a.md', 'b.md', 'a.md']) await call('Read', f)
  for (const f of ['c.ts', 'd.ts', 'c.ts']) await call('Write', f)
  await w.clock.advance(6 * 60_000)
  await call('Read', 'a.md')
  await w.clock.advance(1100)
  const files = w.appended.join('').trim().split('\n').map(l => JSON.parse(l)).filter(l => l.type === 'FILE')
  expect(files.map(l => l.summary)).toEqual(['◦ a.md', '◦ b.md', '✎ c.ts', '✎ d.ts', '✎ c.ts', '◦ a.md'])
})

test('live team activity during a replay shows a [ live ] button and a note; pressing it ends the replay', async ($, on) => {
  const w = world(on)
  on('agent.spawn', ($, e) => ({ model: 'sonnet', agentId: 'a-' + (e as { name: string }).name, teammateId: (e as { name: string }).name + '@s' }))
  const at = (ms: number, from: string, to: string, summary: string) => JSON.stringify({ ts: 1_000_000 + ms, from, to, summary, length: summary.length, via: 'send' })
  w.files.set(CWD + '/old/log.jsonl', [at(0, 'v1', 'v2', 'hi'), at(1_000, 'v2', 'v1', 'hi'), at(400_000, 'v1', 'v2', 'late')].join('\n') + '\n')
  await start($)
  await $.command.run({ command: 'swarm', args: 'replay old/log.jsonl --speed 1' } as never)
  const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: 100 } } as never)
  await w.clock.advance(200)
  expect(await ui.find({ type: 'Button', key: 'live' })).toBeUndefined()
  for (const n of ['t1', 't2']) await $.agent.spawn({ prompt: 'p', name: n, isTeammate: true } as never)
  await $.session.send({ to: 't2', text: 'starting', agentId: 'a-t1' } as never)
  const live = await ui.find({ type: 'Button', key: 'live' })
  expect(live?.props.hotkey).toBe('0')
  expect(await rasterText(ui)).toContain('live swarm running')
  expect(await ui.find({ type: 'Button', key: 'stop' })).toBeDefined()
  await ui.press({ key: 'live' })
  expect(await ui.find({ type: 'Button', key: 'stop' })).toBeUndefined()
  expect(await rasterText(ui)).toContain('LIVE · t1–t2')
  await ui.unmount()
})

test('order stamps: each teammate-to-teammate send carries #n · HH:MM:SS on its first line, n counted on across a reload; sends to the lead, broadcasts and the mod\'s own carry none', async ($, on) => {
  const w = world(on)
  on('agent.spawn', ($, e) => ({ model: 'claude-haiku', agentId: 'a-' + (e as { name: string }).name, teammateId: (e as { name: string }).name + '@s' }))
  w.files.set(CWD + '/.swarm/roster.json', JSON.stringify({ session: 'session-abcdef01', stamp: 6, agents: [] }))
  w.files.set(CWD + '/.swarm/log.jsonl', JSON.stringify({ ts: 1, from: 't1', to: 't2', summary: '[PROPOSE] hi', length: 12, via: 'send', session: 'session-abcdef01', stamp: 7 }) + '\n')
  await start($)
  for (const n of ['t1', 't2']) await $.agent.spawn({ prompt: 'p', name: n, isTeammate: true } as never)
  await $.session.send({ to: 't2', text: '[CLAIM] build docs/design.md', agentId: 'a-t1' } as never)
  await $.session.send({ to: 'team-lead', text: '[DONE] notes', agentId: 'a-t1' } as never)
  await $.session.send({ to: 't1', text: '[ASK] which part?', agentId: 'a-t2' } as never)
  await $.session.send({ to: 't1', text: 'from the mod', agentId: 'a-t2', origin: { kind: 'plugin', name: 'agent-swarm' } } as never)
  await $.session.send({ to: '*', text: '[PROPOSE] to everyone', agentId: 'a-t2' } as never)
  const at = machineTime(1_000_000)
  expect(w.sends.map(s => s.text)).toEqual(['swarm: build docs/design.md is yours.', `#8 · ${at}\n[CLAIM] build docs/design.md`, '[DONE] notes', `#9 · ${at}\n[ASK] which part?`, 'from the mod', '[PROPOSE] to everyone'])
  await w.clock.advance(1100)
  const lines = w.appended.join('').trim().split('\n').map(l => JSON.parse(l)).filter(l => l.type !== 'JOIN')
  expect(lines.map(l => [l.summary, l.type, l.stamp])).toEqual([['[CLAIM] build docs/design.md', 'CLAIM', 8], ['swarm: build docs/design.md is yours.', undefined, undefined], ['[DONE] notes', 'DONE', undefined], ['[ASK] which part?', 'ASK', 9], ['from the mod', undefined, undefined], ['[PROPOSE] to everyone', 'PROPOSE', undefined]])
  expect(JSON.parse(w.writes.get(CWD + '/.swarm/roster.json') ?? '{}').stamp).toBe(9)
  await $.session.receive({ origin: peer('t1'), text: `#8 · ${at}\n[CLAIM] build docs/design.md`, agentId: 'a-t2' } as never)
  const roster = JSON.parse(w.writes.get(CWD + '/.swarm/roster.json') ?? '{}')
  expect(roster.claims.map((c: { key: string; by: string[] }) => [c.key, c.by])).toEqual([['build docs/design.md', ['t1']]])
})

test('a first build or research claim is answered once as the claimant\'s, a review claim not; a later claim on a held target gets an [ASK] from the mod, once, and is still recorded; a write to a file another teammate builds warns the writer and its holder, once per 2 min, and goes through', async ($, on) => {
  const w = world(on)
  on('agent.spawn', ($, e) => ({ model: 'claude-haiku', agentId: 'a-' + (e as { name: string }).name, teammateId: (e as { name: string }).name + '@s' }))
  await start($)
  for (const n of ['t1', 't2', 't3']) await $.agent.spawn({ prompt: 'p', name: n, isTeammate: true } as never)
  w.agents = ['t1', 't2', 't3'].map(n => ({ id: 'a-' + n, name: n, type: 'teammate', status: 'running', description: '', teammateId: n + '@s' }))
  await w.clock.advance(4100)
  await $.session.send({ to: 't2', text: '[PROPOSE] hello Atlas', agentId: 'a-t1' } as never)
  await $.session.send({ to: 't2', text: '[CLAIM] build docs/design.md', agentId: 'a-t1' } as never)
  await w.clock.advance(1000)
  const asks = () => w.sends.filter(s => s.text.startsWith('swarm: [ASK]'))
  expect(await $.session.send({ to: 't1', text: '[CLAIM] build design.md', agentId: 'a-t2' } as never)).toEqual({ isDelivered: true })
  await $.session.send({ to: 't3', text: '[CLAIM] build /work/docs/design.md', agentId: 'a-t2' } as never)
  await $.session.send({ to: 't1', text: '[CLAIM] review docs/design.md', agentId: 'a-t3' } as never)
  await $.session.send({ to: 't3', text: '[CLAIM] build docs/design.md', agentId: 'a-t1' } as never)
  expect(w.sends.filter(s => !s.text.startsWith('#') && !s.text.startsWith('swarm: [ASK]'))).toEqual([{ to: 'a-t1', text: 'swarm: build docs/design.md is yours.' }])
  const at = machineTime(1_004_100)
  expect(asks()).toEqual([{ to: 'a-t2', text: `swarm: [ASK] design.md is already claimed by Atlas (t1, since ${at}, #2). Talk to them, split it, or pick another slice.\nIf you wait instead, the mod tells you when it passes to you.` }])
  await $.command.run({ command: 'swarm', args: 'deliverable docs/a.md' } as never)
  for (const d of ['docs/b.md', 'docs/c.md', 'docs/d.md', 'docs/design.md']) await $.command.run({ command: 'swarm', args: 'deliverable ' + d } as never)
  await $.session.send({ to: 't1', text: '[CLAIM] build docs/design.md', agentId: 'a-t3' } as never)
  expect(asks().at(-1)).toEqual({ to: 'a-t3', text: `swarm: [ASK] docs/design.md is already claimed by Atlas (t1, since ${at}, #2). Talk to them, split it, or pick another slice: docs/a.md, docs/b.md, docs/c.md.\nIf you wait instead, the mod tells you when it passes to you.` })
  w.sends.length = 0
  await $.session.send({ to: 't1', text: '[WITHDRAW] build docs/design.md', agentId: 'a-t3' } as never)
  await w.clock.advance(1100)
  const roster = JSON.parse(w.writes.get(CWD + '/.swarm/roster.json') ?? '{}')
  expect(roster.claims.map((c: { key: string; by: string[] }) => [c.key, c.by])).toEqual([['build docs/design.md', ['t1', 't2']], ['review docs/design.md', ['t3']]])
  const ui = await listPane($, { ...PANE, props: { ...PANE.props, bodyColumns: 100 } })
  expect(await ui.find({ type: 'Text', text: /build Atlas \(t1\), t2 ⚠ duplicate/ })).toBeDefined()
  await ui.unmount()

  w.sends.length = 0
  expect(await $.tool.call({ tool: 'Write', file_path: CWD + '/docs/design.md', content: 'x', agentId: 'a-t3' } as never)).toEqual({ result: 'sent' })
  await $.tool.call({ tool: 'Edit', file_path: CWD + '/docs/design.md', old_string: 'x', new_string: 'y', agentId: 'a-t3' } as never)
  await $.tool.call({ tool: 'Edit', file_path: CWD + '/docs/design.md', old_string: 'x', new_string: 'y', agentId: 'a-t1' } as never)
  await $.tool.call({ tool: 'Edit', file_path: CWD + '/docs/design.md', old_string: 'x', new_string: 'y' } as never)
  await $.tool.call({ tool: 'Write', file_path: CWD + '/notes.md', content: 'x', agentId: 'a-t3' } as never)
  await $.tool.call({ tool: 'Read', file_path: CWD + '/docs/design.md', agentId: 'a-t3' } as never)
  const warned = [
    { to: 'a-t3', text: `swarm: [ASK] you wrote ${CWD}/docs/design.md, claimed by Atlas (t1). Settle it with them.` },
    { to: 'a-t1', text: `swarm: [ASK] t3 (t3) wrote ${CWD}/docs/design.md, which you claimed. Settle it with them.` },
  ]
  expect(asks()).toEqual(warned)
  await w.clock.advance(119_000)
  await $.tool.call({ tool: 'Edit', file_path: CWD + '/docs/design.md', old_string: 'x', new_string: 'y', agentId: 'a-t3' } as never)
  expect(asks()).toEqual(warned)
  await w.clock.advance(2_000)
  await $.tool.call({ tool: 'Edit', file_path: CWD + '/docs/design.md', old_string: 'x', new_string: 'y', agentId: 'a-t3' } as never)
  expect(asks()).toEqual([...warned, ...warned])
})

test('the mod\'s own message is logged once, as from swarm, though Claude Code also runs it as a SendMessage call on the lead\'s loop while it is in flight; two identical ones in flight are both skipped', async ($, on) => {
  const w = world(on)
  const lands: (() => void)[] = []
  w.holdModSends = [0, 1].map(() => new Promise<void>(r => { lands.push(r) }))
  on('agent.spawn', ($, e) => ({ model: 'claude-haiku', agentId: 'a-' + (e as { name: string }).name, teammateId: (e as { name: string }).name + '@s' }))
  await start($)
  for (const n of ['t1', 't2', 't3']) await $.agent.spawn({ prompt: 'p', name: n, isTeammate: true } as never)
  await $.session.send({ to: 't2', text: '[CLAIM] build docs/design.md', agentId: 'a-t1' } as never)
  await $.session.send({ to: 't1', text: '[CLAIM] build docs/design.md', agentId: 'a-t2' } as never)
  await $.session.send({ to: 't1', text: '[CLAIM] build docs/design.md', agentId: 'a-t3' } as never)
  const ask = `swarm: [ASK] docs/design.md is already claimed by t1 (t1, since ${machineTime(1_000_000)}, #1). Talk to them, split it, or pick another slice.\nIf you wait instead, the mod tells you when it passes to you.`
  await $.tool.call({ tool: 'SendMessage', to: 'a-t2', message: ask } as never)
  lands[0]!()
  await w.clock.advance(10)
  await $.tool.call({ tool: 'SendMessage', to: 'a-t3', message: ask } as never)
  lands[1]!()
  await w.clock.advance(1100)
  const lines = w.appended.join('').trim().split('\n').map(l => JSON.parse(l))
  expect(lines.filter(l => l.summary === ask.split('\n')[0]).map(l => [l.from, l.to, l.via]).sort()).toEqual([['swarm', 't2', 'send'], ['swarm', 't3', 'send']])
})

test('lead filter: an idle notice from a swarm the lead stopped is held, however late it comes; other deliveries pass', async ($, on) => {
  const w = world(on)
  on('agent.spawn', ($, e) => ({ model: 'sonnet', agentId: 'a-' + (e as { name: string }).name, teammateId: (e as { name: string }).name + '@s' }))
  await start($)
  for (const n of ['t1', 't2']) await $.agent.spawn({ prompt: 'p', name: n, isTeammate: true } as never)
  await $.session.send({ to: 't2', text: '[PROPOSE] hello Atlas', agentId: 'a-t1' } as never)
  const toLead = (text: string) => $.session.receive({ origin: peer('t1'), text } as never) as Promise<{ text?: string; consumed?: string }>
  const idle = '{"type":"idle_notification","from":"t1","idleReason":"available"}'
  w.agents = ['t1', 't2'].map(n => ({ id: 'a-' + n, name: n, type: 'teammate', status: 'running', description: '', teammateId: n + '@s' }))
  await w.clock.advance(4_100)
  expect((await toLead(idle)).consumed).toBe('swarm quiet: held from the lead')
  w.agents = ['t1', 't2'].map(n => ({ id: 'a-' + n, name: n, type: 'teammate', status: 'killed', description: '', teammateId: n + '@s' }))
  await w.clock.advance(4_000)
  expect((await toLead(idle)).consumed).toBe('swarm quiet: held from the lead')
  expect(await toLead('[DONE] report.md')).toEqual({ text: '[DONE] report.md' })
  await w.clock.advance(3 * 3_600_000)
  expect((await toLead(idle)).consumed).toBe('swarm quiet: held from the lead')
  expect(await toLead('{"type":"idle_notification","from":"t1","idleReason":"failed"}')).toEqual({ text: '{"type":"idle_notification","from":"t1","idleReason":"failed"}' })
})

test('wake all: the messages a stopped team queued while the lead was busy wake nobody once it has ended, and stay logged', async ($, on) => {
  const w = world(on)
  on('agent.spawn', ($, e) => ({ model: 'sonnet', agentId: 'a-' + (e as { name: string }).name, teammateId: (e as { name: string }).name + '@s' }))
  await start($)
  await $.command.run({ command: 'swarm', args: 'wake all' } as never)
  for (const n of ['t1', 't2']) await $.agent.spawn({ prompt: 'p', name: n, isTeammate: true } as never)
  w.agents = ['t1', 't2'].map(n => ({ id: 'a-' + n, name: n, type: 'teammate', status: 'running', description: '', teammateId: n + '@s' }))
  await w.clock.advance(4_100)
  await $.turn.start({ turnId: 'L1', text: 'go' } as never)
  for (let i = 0; i < 5; i++) await $.session.send({ to: i % 2 ? 't1' : 't2', text: `[REVIEW] README.md pass ${i}`, agentId: i % 2 ? 'a-t2' : 'a-t1' } as never)
  await w.clock.advance(10_000)
  await $.tool.call({ tool: 'mcp__agent-swarm__stop_swarm' } as never)
  w.agents = w.agents.map(a => ({ ...a, status: 'killed' }))
  await $.turn.complete({ turnId: 'L1', answer: '', durationMs: 1, isAborted: false, reason: 'answer', usage: null } as never)
  await w.clock.advance(60_000)
  expect(w.submitted.filter(t => t.includes('new message(s)'))).toEqual([])
  expect(w.appended.join('').match(/\[REVIEW\] README\.md pass/g)?.length).toBe(5)
})

test('work done: once every deliverable has a [DONE], no claim or [BLOCK] is open and every teammate is idle, the lead is woken once; a new message re-arms it; nothing is stopped', async ($, on) => {
  const w = world(on)
  on('agent.spawn', ($, e) => ({ model: 'sonnet', agentId: 'a-' + (e as { name: string }).name, teammateId: (e as { name: string }).name + '@s' }))
  await start($)
  for (const n of ['t1', 't2']) await $.agent.spawn({ prompt: 'Goal: g\nDeliverable: docs/a.md', name: n, isTeammate: true } as never)
  const status = async (s: string) => {
    w.agents = ['t1', 't2'].map(n => ({ id: 'a-' + n, name: n, type: 'teammate', status: s, description: '', teammateId: n + '@s' }))
    if (s === 'idle') for (const n of ['t1', 't2']) await $.session.receive({ origin: peer(n), text: `{"type":"idle_notification","from":"${n}","idleReason":"available"}` } as never)
  }
  const said = (from: string, to: string, text: string) => $.session.send({ to, text, agentId: 'a-' + from } as never)
  const done = () => w.submitted.filter(t => t.startsWith('swarm: all deliverables done'))
  await status('running')
  await said('t1', 't2', '[CLAIM] build docs/a.md')
  await said('t2', 't1', '[CLAIM] review docs/a.md')
  await said('t1', 'team-lead', '[DONE] docs/a.md')
  await said('t2', 't1', '[BLOCK] #1 docs/a.md: the table is wrong')
  await w.clock.advance(10_000)
  await status('idle')
  await w.clock.advance(10_000)
  expect(done()).toEqual([])
  await status('running')
  await said('t1', 'team-lead', '[DONE] docs/a.md table fixed')
  await said('t2', 't1', '[REVIEW] #1 docs/a.md approve')
  await w.clock.advance(10_000)
  expect(done()).toEqual([])
  await status('idle')
  await w.clock.advance(10_000)
  expect(done()).toEqual(['swarm: all deliverables done, no open claims or blocks, every teammate idle; start the final review (protocol §3, phase 6) unless it ran, else stop_swarm when you agree.'])
  await w.clock.advance(60_000)
  expect(done().length).toBe(1)
  await said('t2', 't1', 'one more look at the intro?')
  await w.clock.advance(10_000)
  expect(done().length).toBe(1)
  await status('idle')
  await w.clock.advance(10_000)
  expect(done().length).toBe(2)
  expect(w.toolCalls.filter(c => c.tool === 'TaskStop')).toEqual([])
})

test('work done with no deliverable: every build and research claim needs a [DONE], and an open [BLOCK] holds the wake', async ($, on) => {
  const w = world(on)
  on('agent.spawn', ($, e) => ({ model: 'sonnet', agentId: 'a-' + (e as { name: string }).name, teammateId: (e as { name: string }).name + '@s' }))
  await start($)
  for (const n of ['t1', 't2']) await $.agent.spawn({ prompt: 'Goal: g', name: n, isTeammate: true } as never)
  w.agents = ['t1', 't2'].map(n => ({ id: 'a-' + n, name: n, type: 'teammate', status: 'idle', description: '', teammateId: n + '@s' }))
  const said = (from: string, to: string, text: string) => $.session.send({ to, text, agentId: 'a-' + from } as never)
  const idle = (n: string) => $.session.receive({ origin: peer(n), text: `{"type":"idle_notification","from":"${n}","idleReason":"available"}` } as never)
  await said('t1', 't2', '[CLAIM] research parser')
  await said('t2', 't1', '[CLAIM] research lexer')
  await said('t1', 'team-lead', '[DONE] parser: 3 findings')
  await w.clock.advance(1_000)
  await idle('t1')
  await idle('t2')
  await w.clock.advance(10_000)
  expect(w.submitted.filter(t => t.includes(' done, no open claims'))).toEqual([])
  await said('t1', 'team-lead', '[BLOCK] the parser fixtures need a key')
  await said('t2', 'team-lead', '[DONE] lexer: 1 finding')
  await w.clock.advance(1_000)
  await idle('t1')
  await idle('t2')
  await w.clock.advance(10_000)
  expect(w.submitted.filter(t => t.includes(' done, no open claims'))).toEqual([])
  await said('t1', 'team-lead', '[DONE] parser: key found, 3 findings')
  await w.clock.advance(1_000)
  await idle('t1')
  await w.clock.advance(10_000)
  expect(w.submitted.filter(t => t.includes(' done, no open claims'))).toEqual(['swarm: every build and research claim done, no open claims or blocks, every teammate idle; start the final review (protocol §3, phase 6) unless it ran, else stop_swarm when you agree.'])
})

test('work done: a review claim on a slice no build names does not hold the wake once every build is done and its holder sent a [DONE] naming the builds', async ($, on) => {
  const w = world(on)
  on('agent.spawn', ($, e) => ({ model: 'sonnet', agentId: 'a-' + (e as { name: string }).name, teammateId: (e as { name: string }).name + '@s' }))
  await start($)
  for (const n of ['t1', 't2', 't3']) await $.agent.spawn({ prompt: 'Goal: g', name: n, isTeammate: true } as never)
  w.agents = ['t1', 't2', 't3'].map(n => ({ id: 'a-' + n, name: n, type: 'teammate', status: 'idle', description: '', teammateId: n + '@s' }))
  const said = (from: string, to: string, text: string) => $.session.send({ to, text, agentId: 'a-' + from } as never)
  const idle = (n: string) => $.session.receive({ origin: peer(n), text: `{"type":"idle_notification","from":"${n}","idleReason":"available"}` } as never)
  await said('t1', 't2', '[CLAIM] build pt-4')
  await said('t3', 't2', '[CLAIM] build notes-reach')
  await said('t2', 't1', '[CLAIM] review rr-all-slices')
  await said('t2', 't1', '[REVIEW] pt-4 approve')
  await said('t1', 'team-lead', '[DONE] pt-4 (ingest)')
  await said('t3', 'team-lead', '[DONE] notes-reach')
  await said('t2', 'team-lead', '[DONE] pt-4 and notes-reach reviewed, report written')
  await w.clock.advance(1_000)
  for (const n of ['t1', 't2', 't3']) await idle(n)
  await w.clock.advance(10_000)
  expect(w.submitted.filter(t => t.includes(' done, no open claims'))).toEqual(['swarm: every build and research claim done, no open claims or blocks, every teammate idle; start the final review (protocol §3, phase 6) unless it ran, else stop_swarm when you agree.'])
})

test('lead filter: an idle notice from a teammate whose message reached the lead within 60 s is held, swarm or not', async ($, on) => {
  const w = world(on)
  on('agent.spawn', ($, e) => ({ model: 'sonnet', agentId: 'a-' + (e as { name: string }).name, teammateId: (e as { name: string }).name + '@s' }))
  await start($)
  for (const n of ['t1', 't2']) await $.agent.spawn({ prompt: 'p', name: n, isTeammate: true } as never)
  w.agents = ['t1', 't2'].map(n => ({ id: 'a-' + n, name: n, type: 'teammate', status: 'running', description: '', teammateId: n + '@s' }))
  await w.clock.advance(4_100)
  const toLead = (from: string, text: string) => $.session.receive({ origin: peer(from), text } as never) as Promise<{ text?: string; consumed?: string }>
  const idle = (from: string) => `{"type":"idle_notification","from":"${from}","idleReason":"available"}`
  expect(await toLead('t1', '[DONE] report.md')).toEqual({ text: '[DONE] report.md' })
  await w.clock.advance(59_000)
  expect((await toLead('t1', idle('t1'))).consumed).toBe('swarm quiet: held from the lead')
  expect(await toLead('t2', idle('t2'))).toEqual({ text: idle('t2') })
  await w.clock.advance(2_000)
  expect(await toLead('t1', idle('t1'))).toEqual({ text: idle('t1') })
  await toLead('t1', 'another report')
  await $.command.run({ command: 'swarm', args: 'quiet off' } as never)
  expect(await toLead('t1', idle('t1'))).toEqual({ text: idle('t1') })
})

test('a claim on a target whose holder has ended gets no [ASK] and shows no ⚠', async ($, on) => {
  const w = world(on)
  on('agent.spawn', ($, e) => ({ model: 'claude-haiku', agentId: 'a-' + (e as { name: string }).name, teammateId: (e as { name: string }).name + '@s' }))
  await start($)
  for (const n of ['t1', 't2', 't3']) await $.agent.spawn({ prompt: 'p', name: n, isTeammate: true } as never)
  await $.session.send({ to: 't2', text: '[CLAIM] build notes.md', agentId: 'a-t1' } as never)
  w.agents = ['t1', 't2', 't3'].map(n => ({ id: 'a-' + n, name: n, type: 'teammate', status: n === 't1' ? 'failed' : 'running', description: '', teammateId: n + '@s' }))
  await w.clock.advance(4_100)
  await $.session.send({ to: 't3', text: '[CLAIM] build notes.md', agentId: 'a-t2' } as never)
  expect(w.sends.filter(s => s.text.startsWith('swarm: [ASK]'))).toEqual([])
  const ui = await listPane($, { ...PANE, props: { ...PANE.props, bodyColumns: 100 } })
  expect(await ui.find({ type: 'Text', text: /build t1, t2$/ })).toBeDefined()
  await ui.unmount()
})

test('a reload keeps which claimants were answered (told a target is theirs or taken), and the holder\'s time and stamp from the log', async ($, on) => {
  const w = world(on)
  on('agent.spawn', ($, e) => ({ model: 'claude-haiku', agentId: 'a-' + (e as { name: string }).name, teammateId: (e as { name: string }).name + '@s' }))
  const session = 'session-abcdef01'
  const claim = (ts: number, from: string, stamp: number) => JSON.stringify({ ts, from, to: 'tx', summary: '[CLAIM] build notes.md', length: 22, type: 'CLAIM', via: 'send', session, stamp })
  w.files.set(CWD + '/.swarm/log.jsonl', [claim(900_000, 't1', 3), claim(901_000, 't2', 4)].join('\n') + '\n')
  w.files.set(CWD + '/.swarm/roster.json', JSON.stringify({ session, stamp: 4, askedTaken: ['t2 build notes.md'], ackedClaims: ['t1 build notes.md'], claims: [{ role: 'build', target: 'notes.md', key: 'build notes.md', by: ['t1', 't2'] }], agents: [] }))
  await start($)
  for (const n of ['t1', 't2', 't3']) await $.agent.spawn({ prompt: 'p', name: n, isTeammate: true } as never)
  await $.session.send({ to: 't1', text: '[CLAIM] build notes.md', agentId: 'a-t2' } as never)
  await $.session.send({ to: 't1', text: '[CLAIM] build notes.md', agentId: 'a-t3' } as never)
  await $.session.send({ to: 't2', text: '[CLAIM] build notes.md', agentId: 'a-t1' } as never)
  await $.session.send({ to: 't2', text: '[CLAIM] build other.md', agentId: 'a-t3' } as never)
  expect(w.sends.filter(s => s.text.startsWith('swarm: [ASK]'))).toEqual([{ to: 'a-t3', text: `swarm: [ASK] notes.md is already claimed by t1 (t1, since ${machineTime(900_000)}, #3). Talk to them, split it, or pick another slice.\nIf you wait instead, the mod tells you when it passes to you.` }])
  expect(w.sends.filter(s => s.text.endsWith('is yours.'))).toEqual([{ to: 'a-t3', text: 'swarm: build other.md is yours.' }])
  await w.clock.advance(1100)
  const roster = JSON.parse(w.writes.get(CWD + '/.swarm/roster.json') ?? '{}')
  expect([roster.askedTaken, roster.ackedClaims]).toEqual([['t2 build notes.md', 't3 build notes.md'], ['t1 build notes.md', 't3 build other.md']])
})

test('the overwrite warning names only a live holder: a write to a file whose builder ended warns nobody', async ($, on) => {
  const w = world(on)
  on('agent.spawn', ($, e) => ({ model: 'claude-haiku', agentId: 'a-' + (e as { name: string }).name, teammateId: (e as { name: string }).name + '@s' }))
  await start($)
  for (const n of ['t1', 't2']) await $.agent.spawn({ prompt: 'p', name: n, isTeammate: true } as never)
  await $.session.send({ to: 't2', text: '[CLAIM] build notes.md', agentId: 'a-t1' } as never)
  w.agents = ['t1', 't2'].map(n => ({ id: 'a-' + n, name: n, type: 'teammate', status: n === 't1' ? 'killed' : 'running', description: '', teammateId: n + '@s' }))
  await w.clock.advance(4_100)
  await $.tool.call({ tool: 'Write', file_path: CWD + '/notes.md', content: 'x', agentId: 'a-t2' } as never)
  expect(w.sends.filter(s => s.text.startsWith('swarm: [ASK]'))).toEqual([])
})

test('/swarmctl is a second name for /swarm: both are registered and /swarmctl status answers', async ($, on) => {
  const w = world(on)
  await start($)
  expect(w.commands).toEqual(['swarm', 'swarmctl'])
  const r = (await $.command.run({ command: 'swarmctl', args: 'status' } as never)) as { text: string }
  expect(r.text).toMatch(/^swarm: .* · quiet: on · /)
})

test('status line: ◇ swarm N live · M done (· K failed) while the team is a swarm, done counting the teammates that sent a [DONE] and no [CLAIM] since, live or not; pinned only when it changes, cleared when the team ends', async ($, on) => {
  const w = world(on)
  on('agent.spawn', ($, e) => ({ model: 'sonnet', agentId: 'a-' + (e as { name: string }).name, teammateId: (e as { name: string }).name + '@s' }))
  await start($)
  const rows = (states: Record<string, string>) => Object.entries(states).map(([n, status]) => ({ id: 'a-' + n, name: n, type: 'teammate', status, description: '', teammateId: n + '@s' }))
  for (const n of ['t1', 't2', 't3']) await $.agent.spawn({ prompt: 'p', name: n, isTeammate: true } as never)
  w.agents = rows({ t1: 'running', t2: 'running', t3: 'running' })
  await w.clock.advance(4_100)
  expect(w.statuses).toEqual([])
  await $.session.send({ to: 't2', text: '[PROPOSE] hello Atlas', agentId: 'a-t1' } as never)
  await $.session.send({ to: 't3', text: '[PROPOSE] hello Atlas', agentId: 'a-t1' } as never)
  await $.session.send({ to: 't1', text: '[PROPOSE] hello Sage', agentId: 'a-t3' } as never)
  await w.clock.advance(10_000)
  expect(w.statuses).toEqual(['◇ swarm 3 live · 0 done'])
  await $.session.send({ to: 't1', text: '[DONE] slice-a', agentId: 'a-t3' } as never)
  await $.session.receive({ origin: peer('t2'), text: '[DONE] slice-b', agentId: 'a-lead' } as never)
  await w.clock.advance(2_100)
  expect(w.statuses).toEqual(['◇ swarm 3 live · 0 done', '◇ swarm 3 live · 2 done'])
  await $.session.send({ to: 't1', text: '[PROPOSE] next\n[CLAIM] research slice-c', agentId: 'a-t3' } as never)
  await w.clock.advance(2_100)
  expect(w.statuses).toEqual(['◇ swarm 3 live · 0 done', '◇ swarm 3 live · 2 done', '◇ swarm 3 live · 1 done'])
  await $.session.send({ to: 't1', text: '[DONE] slice-c', agentId: 'a-t3' } as never)
  await w.clock.advance(2_100)
  expect(w.statuses.slice(3)).toEqual(['◇ swarm 3 live · 2 done'])
  w.agents = rows({ t1: 'completed', t2: 'failed', t3: 'running' })
  await w.clock.advance(4_100)
  expect(w.statuses.slice(4)).toEqual(['◇ swarm 1 live · 2 done · 1 failed'])
  w.agents = rows({ t1: 'completed', t2: 'failed', t3: 'killed' })
  await w.clock.advance(4_100)
  expect(w.statuses.slice(4)).toEqual(['◇ swarm 1 live · 2 done · 1 failed', undefined])
})

test('status line after a reload: a [DONE] in this session\'s log still counts as done; one from before the teammate\'s spawn, or followed by a [CLAIM] (inside a hello too), does not', async ($, on) => {
  const w = world(on)
  const session = 'session-abcdef01'
  const entry = (ts: number, from: string, to: string, summary: string) => JSON.stringify({ ts, from, to, summary, length: summary.length, via: 'send', session, ...(summary.startsWith('[DONE]') ? { type: 'DONE' } : {}) })
  const agent = (n: string, spawnedAt: number) => ({ id: 'a-' + n, name: n, type: 'teammate', status: 'running', isTeammate: true, teammateId: n + '@s', spawnedAt })
  w.files.set(CWD + '/.swarm/log.jsonl', [entry(700_000, 't2', 'team-lead', '[DONE] old'), entry(850_000, 't1', 't2', 'hello'), entry(851_000, 't2', 't1', 'hello'), entry(860_000, 't1', 'team-lead', '[DONE] slice-a'), entry(870_000, 't2', 't1', '[DONE] slice-b'), entry(880_000, 't2', 't1', '[PROPOSE] hello Wren, [CLAIM] research slice-c')].join('\n') + '\n')
  w.files.set(CWD + '/.swarm/roster.json', JSON.stringify({ session, agents: [agent('t1', 800_000), agent('t2', 800_000)] }))
  w.agents = ['t1', 't2'].map(n => ({ id: 'a-' + n, name: n, type: 'teammate', status: 'running', description: '', teammateId: n + '@s' }))
  await start($)
  await w.clock.advance(4_100)
  expect(w.statuses).toEqual(['◇ swarm 2 live · 1 done'])
})

test('stand-down toast: once, when a swarm\'s last teammate ends, with agents, messages (the mod\'s own not counted), its time from the first spawn to its last activity, the lead\'s wakes with wakes per agent and held deliveries; none for agents that never formed a swarm', async ($, on) => {
  const w = world(on)
  on('agent.spawn', ($, e) => ({ model: 'sonnet', agentId: 'a-' + (e as { name: string }).name, teammateId: (e as { name: string }).name + '@s' }))
  await start($)
  const rows = (names: string[], status: string) => names.map(n => ({ id: 'a-' + n, name: n, type: 'teammate', status, description: '', teammateId: n + '@s' }))
  for (const n of ['r1', 'r2']) await $.agent.spawn({ prompt: 'p', name: n, isTeammate: true } as never)
  await $.session.send({ to: 'team-lead', text: '[DONE] solo report', agentId: 'a-r1' } as never)
  w.agents = rows(['r1', 'r2'], 'completed')
  await w.clock.advance(4_100)
  expect(w.toasts).toEqual([])
  for (const n of ['t1', 't2']) await $.agent.spawn({ prompt: 'p', name: n, isTeammate: true } as never)
  w.agents = rows(['t1', 't2'], 'running')
  await $.session.send({ to: 't2', text: '[PROPOSE] hello Atlas', agentId: 'a-t1' } as never)
  const lands: (() => void)[] = []
  w.holdModSends = [0, 1].map(() => new Promise<void>(r => { lands.push(r) }))
  const since = machineTime(w.clock.now())
  await $.session.send({ to: 't1', text: '[CLAIM] build x.md', agentId: 'a-t2' } as never)
  await $.session.send({ to: 't2', text: '[CLAIM] build x.md', agentId: 'a-t1' } as never)
  const mine = 'swarm: build x.md is yours.'
  const ask = `swarm: [ASK] x.md is already claimed by t2 (t2, since ${since}, #2). Talk to them, split it, or pick another slice.\nIf you wait instead, the mod tells you when it passes to you.`
  await $.tool.call({ tool: 'SendMessage', to: 't2', message: mine } as never)
  await $.tool.call({ tool: 'SendMessage', to: 't1', message: ask } as never)
  for (const land of lands) land()
  await w.clock.advance(10)
  expect(w.sends.map(s => s.text).filter(t => t === mine || t === ask)).toEqual([mine, ask])
  await w.clock.advance(12 * 60_000)
  await $.session.receive({ origin: peer('t1'), text: '[PROPOSE] hello lead' } as never)
  await $.session.receive({ origin: peer('t2'), text: '[ASK] which file?' } as never)
  await w.clock.advance(7 * 60_000)
  expect(w.toasts).toEqual([])
  w.agents = rows(['t1', 't2'], 'completed')
  await w.clock.advance(4_100)
  await w.clock.advance(10_000)
  expect(w.toasts).toEqual(['swarm stood down: 2 agents · 5 messages · 12m · lead woken 1 (0.5/agent), held 1'])
})

test('stand-down toast: a stopped teammate that a message restarts and that ends again does not stand its team down a second time', async ($, on) => {
  const w = world(on)
  on('agent.spawn', ($, e) => ({ model: 'sonnet', agentId: 'a-' + (e as { name: string }).name, teammateId: (e as { name: string }).name + '@s' }))
  await start($)
  const rows = (status: Record<string, string>) => Object.entries(status).map(([n, st]) => ({ id: 'a-' + n, name: n, type: 'teammate', status: st, description: '', teammateId: n + '@s' }))
  for (const n of ['t1', 't2']) await $.agent.spawn({ prompt: 'p', name: n, isTeammate: true } as never)
  w.agents = rows({ t1: 'running', t2: 'running' })
  await $.session.send({ to: 't2', text: '[PROPOSE] hello Atlas', agentId: 'a-t1' } as never)
  await w.clock.advance(4_100)
  w.agents = rows({ t1: 'killed', t2: 'killed' })
  await w.clock.advance(4_100)
  expect(w.toasts.filter(t => t.startsWith('swarm stood down'))).toHaveLength(1)
  await $.session.send({ to: 't1', text: 'one more thing', agentId: 'a-t2' } as never)
  w.agents = rows({ t1: 'idle', t2: 'killed' })
  await w.clock.advance(4_100)
  w.agents = rows({ t1: 'killed', t2: 'killed' })
  await w.clock.advance(4_100)
  expect(w.toasts.filter(t => t.startsWith('swarm stood down'))).toHaveLength(1)
})

test('stand-down toast: a new swarm that reuses the names of one that stood down minutes before stands down with its own toast', async ($, on) => {
  const w = world(on)
  let swarm = 1
  on('agent.spawn', ($, e) => ({ model: 'sonnet', agentId: `a${swarm}-` + (e as { name: string }).name, teammateId: (e as { name: string }).name + '@s' }))
  await start($)
  const rows = (status: string) => ['t1', 't2'].map(n => ({ id: `a${swarm}-` + n, name: n, type: 'teammate', status, description: '', teammateId: n + '@s' }))
  for (const round of [1, 2]) {
    swarm = round
    for (const n of ['t1', 't2']) await $.agent.spawn({ prompt: 'p', name: n, isTeammate: true } as never)
    w.agents = rows('running')
    await $.session.send({ to: 't2', text: '[PROPOSE] hello Atlas', agentId: `a${swarm}-t1` } as never)
    await w.clock.advance(4_100)
    w.agents = rows('completed')
    await w.clock.advance(4_100)
    await w.clock.advance(5 * 60_000)
  }
  expect(w.toasts.filter(t => t.startsWith('swarm stood down'))).toHaveLength(2)
})

test('current action: each teammate tool call in plain words on its look A card with a call count, dim when idle; ACT lines at most one per teammate per 2 s, the latest call shown when that time is up; a replay shows them', async ($, on) => {
  const w = world(on)
  on('agent.spawn', ($, e) => ({ model: 'claude-opus-5-5', agentId: 'a-' + (e as { name: string }).name, teammateId: (e as { name: string }).name + '@s' }))
  await start($)
  for (const n of ['t1', 't2']) await $.agent.spawn({ prompt: 'Goal: g', name: n, isTeammate: true } as never)
  await $.session.send({ to: 't2', text: '[PROPOSE] hello Finch', agentId: 'a-t1' } as never)
  await $.tool.call({ tool: 'Bash', command: 'npm test -- --run\nsecond line', agentId: 'a-t1' } as never)
  await $.tool.call({ tool: 'Grep', pattern: 'claimOf', agentId: 'a-t1' } as never)
  await $.tool.call({ tool: 'Read', file_path: CWD + '/README.md', agentId: 'a-t1' } as never)
  await $.tool.call({ tool: 'SendMessage', to: 't2', message: 'hi', agentId: 'a-t2' } as never)
  await $.tool.call({ tool: 'Read', file_path: CWD + '/lead-only.md' } as never)
  await w.clock.advance(1_000)
  const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: 100 } } as never)
  expect(await rasterText(ui)).toMatch(/Finch t1 +1× +↑\d ↓\d.*\n.*Running npm test -- --…/)
  await w.clock.advance(1_100)
  const cells = await rasterText(ui)
  expect(cells).toMatch(/Finch t1 +3× +↑\d ↓\d.*\n.*Reading README\.md/)
  expect(cells).toMatch(/t2 +1× +↑\d ↓\d.*\n.*Messaging t2/)
  await w.clock.advance(1_100)
  const acts = w.appended.join('').trim().split('\n').map(l => JSON.parse(l)).filter(l => l.type === 'ACT')
  expect(acts.map(l => [l.from, l.summary, l.calls])).toEqual([['t1', 'Running npm test -- --run', 1], ['t2', 'Messaging t2', 1], ['t1', 'Reading README.md', 3]])
  await ui.unmount()
  const lines = w.appended.join('').trim().split('\n')
  w.files.set(CWD + '/old/log.jsonl', lines.join('\n') + '\n')
  await $.command.run({ command: 'swarm', args: 'replay old/log.jsonl --speed 1 --level basic' } as never)
  const replay = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: 100 } } as never)
  await w.clock.advance(5_000)
  expect(await rasterText(replay)).toMatch(/Finch t1 +3× .*\n.*Reading README\.md/)
  await replay.unmount()
})

test('a refused spawn is logged as a REFUSED line from its spawner, the lead or a teammate, and look A\'s message list shows it, live and in a replay; it is no message', async ($, on) => {
  const w = world(on)
  on('agent.spawn', ($, e) => {
    const s = e as { name?: string; description: string }
    if (s.name === 'lark') return { deny: 'teammate limit reached\nsecond line' }
    if (s.name === 'kite') return { deny: 'no Explore here' }
    return { model: 'claude-opus-5-5', agentId: 'a-' + s.name, teammateId: s.name + '@s' }
  })
  await start($)
  for (const n of ['t1', 't2']) await $.agent.spawn({ prompt: 'Goal: g', name: n, isTeammate: true } as never)
  await $.session.send({ to: 't2', text: '[PROPOSE] hello Finch', agentId: 'a-t1' } as never)
  await $.agent.spawn({ prompt: 'p', name: 'lark', isTeammate: true } as never).catch(() => undefined)
  await $.agent.spawn({ prompt: 'p', name: 'kite', description: 'scan docs', parentAgentId: 'a-t1' } as never).catch(() => undefined)
  await w.clock.advance(2_100)
  const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: 100 } } as never)
  const cells = await rasterText(ui)
  expect(cells.split('\n')[0]).toMatch(/LIVE · t1–t2 /)
  expect(cells).toMatch(/Finch +→ +kite +REFUSED +no Explore here/)
  expect(cells).toMatch(/team-lead +→ +lark +REFUSED +teammate limit reached\s/)
  expect(cells).toMatch(/1 msgs/)
  await ui.unmount()
  const lines = w.appended.join('').trim().split('\n')
  const refused = lines.map(l => JSON.parse(l)).filter(l => l.type === 'REFUSED')
  expect(refused.map(l => [l.from, l.to, l.summary, l.via])).toEqual([['team-lead', 'lark', 'teammate limit reached', 'tool'], ['t1', 'kite', 'no Explore here', 'tool']])
  w.files.set(CWD + '/old/log.jsonl', lines.join('\n') + '\n')
  await $.command.run({ command: 'swarm', args: 'replay old/log.jsonl --speed 1 --level basic' } as never)
  const replay = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: 100 } } as never)
  await w.clock.advance(5_000)
  const played = await rasterText(replay)
  expect(played).toMatch(/→ +lark +REFUSED/)
  expect(played.split('\n')[0]).toMatch(/t1–t2 /)
  expect(played).toMatch(/→ +kite +REFUSED/)
  await replay.unmount()
})

test('a team the lead stopped shows as ended: header ENDED · names · ran, every agent ended in the header and cards, no live badge, idle clocks and claims frozen or cleared, stand-down toast; another idle teammate of the lead does not keep it live', async ($, on) => {
  const w = world(on)
  on('agent.spawn', ($, e) => ({ model: 'sonnet', agentId: 'a-' + (e as { name: string }).name, teammateId: (e as { name: string }).name + '@s' }))
  await start($)
  const row = (n: string, status: string) => ({ id: 'a-' + n, name: n, type: 'teammate', status, description: '', teammateId: n + '@s' })
  for (const n of ['helper', 'f1', 'f2']) await $.agent.spawn({ prompt: 'p', name: n, isTeammate: true } as never)
  await $.session.send({ to: 'team-lead', text: '[DONE] side job', agentId: 'a-helper' } as never)
  w.agents = [row('helper', 'idle'), row('f1', 'running'), row('f2', 'running')]
  await $.session.send({ to: 'f2', text: '[PROPOSE] hello Atlas', agentId: 'a-f1' } as never)
  await $.session.send({ to: 'f1', text: '[CLAIM] build parts/music.wav', agentId: 'a-f2' } as never)
  await w.clock.advance(26 * 60_000)
  await $.session.receive({ origin: peer('f1'), text: '{"type":"idle_notification","from":"f1","idleReason":"available"}' } as never)
  const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: 120 } } as never)
  let cells = await rasterText(ui)
  expect(cells).toContain('LIVE · f1–f2')
  expect(cells).toMatch(/music\.wav ─+ BUILDING/)
  w.agents = [row('helper', 'idle'), row('f1', 'killed')]
  await w.clock.advance(4_100)
  cells = await rasterText(ui)
  expect(cells).toContain('ENDED · f1–f2 · ran 26m')
  expect(cells).toContain('■ ended')
  expect(cells).not.toContain('● live')
  expect(cells).not.toMatch(/music\.wav ─+ BUILDING/)
  expect(cells).toContain('claims cleared: the team ended')
  expect(cells).toContain('2 · 2 ended')
  expect(cells.match(/● ENDED \d+:\d\d/g)?.length).toBe(2)
  expect(cells).not.toMatch(/running|RUNNING|IDLE/)
  expect(w.toasts).toEqual([expect.stringMatching(/^swarm stood down: 2 agents · /)])
  await w.clock.advance(60_000)
  expect(await rasterText(ui)).toBe(cells)
  expect(JSON.parse(w.writes.get(CWD + '/.swarm/roster.json') ?? '{}').claims).toEqual([])
  await ui.unmount()
})

test('an ended team never wins over a new team: teammates spawned after it, reporting only to the lead, show live on the cards', async ($, on) => {
  const w = world(on)
  on('agent.spawn', ($, e) => ({ model: 'sonnet', agentId: 'a-' + (e as { name: string }).name, teammateId: (e as { name: string }).name + '@s' }))
  await start($)
  const row = (n: string, status: string) => ({ id: 'a-' + n, name: n, type: 'teammate', status, description: '', teammateId: n + '@s' })
  for (const n of ['f1', 'f2']) await $.agent.spawn({ prompt: 'p', name: n, isTeammate: true } as never)
  w.agents = [row('f1', 'running'), row('f2', 'running')]
  await $.session.send({ to: 'f2', text: '[PROPOSE] hello Lyra', agentId: 'a-f1' } as never)
  await $.session.send({ to: 'f1', text: '[CLAIM] build film.mp4', agentId: 'a-f2' } as never)
  await w.clock.advance(9 * 60_000)
  w.agents = [row('f1', 'completed'), row('f2', 'completed')]
  await w.clock.advance(4_100)
  const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: 120 } } as never)
  expect(await rasterText(ui)).toContain('ENDED · f1–f2')
  await w.clock.advance(60_000)
  for (const n of ['parity', 'undo']) await $.agent.spawn({ prompt: 'p', name: n, isTeammate: true } as never)
  w.agents = [row('f1', 'completed'), row('f2', 'completed'), row('parity', 'running'), row('undo', 'idle')]
  await $.session.send({ to: 'team-lead', text: '[CLAIM] build parity', agentId: 'a-parity' } as never)
  await $.session.send({ to: 'team-lead', text: '[CLAIM] build undo', agentId: 'a-undo' } as never)
  await w.clock.advance(4_100)
  const cells = await rasterText(ui)
  expect(cells).not.toContain('ENDED')
  expect(cells).toContain('LIVE · parity undo')
  expect(cells).toMatch(/parity/)
  expect(cells).not.toMatch(/\bf1\b/)
  await ui.unmount()
})

test('the current team: a dormant teammate of an earlier swarm does not join by receiving a hello, a stopped one neither; a teammate spawned after the team formed joins though it only writes to the lead', { timeoutMs: 15_000 }, async ($, on) => {
  const w = world(on)
  on('agent.spawn', ($, e) => ({ model: 'claude-haiku-5-5', agentId: 'a-' + (e as { name: string }).name, teammateId: (e as { name: string }).name + '@s' }))
  await start($)
  const row = (n: string, status: string) => ({ id: 'a-' + n, name: n, type: 'teammate', status, description: '', teammateId: n + '@s' })
  for (const n of ['h1', 'h2', 'h3']) await $.agent.spawn({ prompt: 'p', name: n, isTeammate: true } as never)
  await $.session.send({ to: 'h2', text: '[PROPOSE] hello Marlin', agentId: 'a-h1' } as never)
  w.agents = [row('h1', 'idle'), row('h2', 'idle'), row('h3', 'running')]
  await w.clock.advance(60_000)
  await $.session.send({ to: 'team-lead', text: 'still here', agentId: 'a-h3' } as never)
  w.agents = [row('h1', 'idle'), row('h2', 'idle'), row('h3', 'killed')]
  for (let i = 0; i < 7 * 6; i++) await w.clock.advance(10 * 60_000)
  for (const n of ['h01', 'h02', 'h4']) await $.agent.spawn({ prompt: 'p', name: n, isTeammate: true } as never)
  w.agents = [row('h1', 'idle'), row('h2', 'idle'), row('h3', 'killed'), row('h01', 'running'), row('h02', 'running'), row('h4', 'killed')]
  await w.clock.advance(4_100)
  await $.session.send({ to: 'h02', text: '[PROPOSE] hello Quarz', agentId: 'a-h01' } as never)
  await $.session.send({ to: 'h1', text: '[PROPOSE] hello quill', agentId: 'a-h02' } as never)
  await $.session.send({ to: 'h3', text: '[PROPOSE] hello quill', agentId: 'a-h02' } as never)
  await $.session.send({ to: 'h4', text: '[PROPOSE] hello quill', agentId: 'a-h02' } as never)
  await w.clock.advance(60_000)
  await $.agent.spawn({ prompt: 'p', name: 'h17', isTeammate: true } as never)
  w.agents = [...w.agents, row('h17', 'running')]
  await w.clock.advance(4_100)
  await $.session.send({ to: 'team-lead', text: 'h17 done: spot-check appended', agentId: 'a-h17' } as never)
  const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: 120 } } as never)
  let cells = await rasterText(ui)
  expect(cells).toContain('LIVE · h01–h17')
  expect(cells).toMatch(/A G E N T S\s+3 · /)
  expect(cells).not.toMatch(/▌ (?:Marlin )?h[1234] /)
  await ui.press({ key: 'view-B' })
  cells = await rasterText(ui)
  expect(cells).toContain('h17')
  expect(cells).not.toMatch(/Marlin|\bh[1234]\b/)
  await ui.unmount()
})

test('look A with 20 live teammates: every one is on screen, and the stage leaves room for the wrapped agent buttons and the wake row', async ($, on) => {
  const w = world(on)
  on('agent.spawn', ($, e) => ({ model: 'claude-haiku-5-5', agentId: 'a-' + (e as { name: string }).name, teammateId: (e as { name: string }).name + '@s' }))
  await start($)
  const names = Array.from({ length: 20 }, (_, i) => 'h' + String(i + 1).padStart(2, '0'))
  for (const n of names) await $.agent.spawn({ prompt: 'p', name: n, isTeammate: true } as never)
  w.agents = names.map(n => ({ id: 'a-' + n, name: n, type: 'teammate', status: 'running', description: '', teammateId: n + '@s' }))
  for (const [i, n] of names.entries()) await $.session.send({ to: names[(i + 1) % 20]!, text: `[PROPOSE] hello Code${i + 1}`, agentId: 'a-' + n } as never)
  await w.clock.advance(4_100)
  const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: 100, scroll: { offset: 0, bodyRows: 34 } } } as never)
  const cells = await rasterText(ui)
  for (const n of names) expect(cells).toContain(n)
  const rows = (await ui.findAll({ type: 'Raster' })).reduce((n, r) => n + Number(r.props.rows), 0)
  expect(rows).toBeLessThanOrEqual(34 - 1 - 2)
  expect(await ui.find({ type: 'Button', key: 'wake-off' })).toBeDefined()
  await ui.unmount()
})

test('stop_swarm: the lead\'s tool stops every live teammate with TaskStop, never a subagent; names pick some; a refusal is reported; the team shows ended; /swarm stop and the pane\'s [ stop all ] do the same', async ($, on) => {
  const asked: string[] = []
  on('tool.call', { tool: 'AskUserQuestion' }, ($, e) => {
    const q = (e as unknown as { questions: { question: string }[] }).questions[0]!.question
    asked.push(q)
    return { result: { questions: [], answers: { [q]: 'Stop them' } } } as never
  })
  const w = world(on)
  on('agent.spawn', ($, e) => ({ model: 'claude-haiku-5-5', agentId: 'a-' + (e as { name?: string; description?: string }).name, ...((e as { isTeammate?: boolean }).isTeammate ? { teammateId: (e as { name: string }).name + '@s' } : {}) }))
  await start($)
  expect(w.tools.map(t => [t.name, t.isDeferred])).toEqual([['stop_swarm', false]])
  const row = (n: string, status: string, isMate = true) => ({ id: 'a-' + n, name: n, type: isMate ? 'teammate' : 'general-purpose', status, description: '', ...(isMate ? { teammateId: n + '@s' } : {}) })
  for (const n of ['t1', 't2', 't3', 't4']) await $.agent.spawn({ prompt: 'p', name: n, isTeammate: true } as never)
  await $.agent.spawn({ prompt: 'p', name: 'builder', description: 'builder' } as never)
  w.agents = [row('t1', 'running'), row('t2', 'idle'), row('t3', 'idle'), row('t4', 'completed'), row('builder', 'running', false)]
  await $.session.send({ to: 't2', text: '[PROPOSE] hello Atlas', agentId: 'a-t1' } as never)
  await w.clock.advance(4_100)
  const stops = () => w.toolCalls.filter(c => c.tool === 'TaskStop').map(c => c.task_id)

  expect(await $.tool.call({ tool: 'mcp__agent-swarm__stop_swarm', agentId: 'a-t2' } as never)).toEqual({ result: "stop_swarm is the lead's: ask the lead to stop the swarm" })
  expect(stops()).toEqual([])
  w.denyStop.set('t3', 'the user denied it')
  const one = await $.tool.call({ tool: 'mcp__agent-swarm__stop_swarm', names: ['Atlas', 't4', 'nobody'] } as never)
  expect(stops()).toEqual(['t1'])
  expect(one).toEqual({ result: 'swarm: stopped Atlas (t1) · failed t4 (already ended), nobody (no teammate of this session goes by that name)' })

  const all = await $.tool.call({ tool: 'mcp__agent-swarm__stop_swarm' } as never)
  expect(stops()).toEqual(['t1', 't2', 't3'])
  expect(all).toEqual({ result: 'swarm: stopped t2 · failed t3 (the user denied it)' })
  expect(w.toolCalls.some(c => c.task_id === 'builder')).toBe(false)

  w.denyStop.clear()
  expect(await $.command.run({ command: 'swarm', args: 'stop t3' } as never)).toEqual({ text: 'swarm: stopped t3' })
  expect(await $.command.run({ command: 'swarm', args: 'stop all' } as never)).toEqual({ text: 'swarm: no live teammate to stop' })
  const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: 120 } } as never)
  expect(await rasterText(ui)).toContain('ENDED · t1–t2')
  expect(await ui.find({ type: 'Button', key: 'stop-all' })).toBeUndefined()
  await ui.unmount()

  await $.agent.spawn({ prompt: 'p', name: 'u1', isTeammate: true } as never)
  w.agents = [row('t1', 'killed'), row('t2', 'killed'), row('t3', 'killed'), row('t4', 'completed'), row('builder', 'running', false), row('u1', 'running')]
  await w.clock.advance(4_100)
  const pane = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: 120 } } as never)
  expect((await pane.find({ type: 'Button', key: 'stop-all' }))?.props.hotkey).toBe('x')
  await pane.press({ key: 'stop-all' })
  expect(asked).toEqual(['Stop all 1 live teammate (u1)?'])
  expect(stops()).toEqual(['t1', 't2', 't3', 't3', 'u1'])
  expect(w.toasts.at(-1)).toBe('swarm: stopped u1')
  await pane.unmount()
})

test('a stopped teammate that a message restarts comes back under its agent id: the roster shows it live once, and stop_swarm, /swarm stop and [ stop all ] stop it again', async ($, on) => {
  on('tool.call', { tool: 'AskUserQuestion' }, ($, e) => {
    const q = (e as unknown as { questions: { question: string }[] }).questions[0]!.question
    return { result: { questions: [], answers: { [q]: 'Stop them' } } } as never
  })
  const w = world(on)
  on('agent.spawn', ($, e) => ({ model: 'claude-haiku-5-5', agentId: 'a-' + (e as { name: string }).name, teammateId: (e as { name: string }).name + '@s' }))
  await start($)
  const row = (n: string, status: string) => ({ id: 'a-' + n, name: n, type: 'teammate', status, description: '', teammateId: n + '@s' })
  for (const n of ['h1', 'h2']) await $.agent.spawn({ prompt: 'p', name: n, isTeammate: true } as never)
  w.agents = [row('h1', 'idle'), row('h2', 'idle')]
  await $.session.send({ to: 'h2', text: '[PROPOSE] hello Marlin', agentId: 'a-h1' } as never)
  await w.clock.advance(4_100)
  const stops = () => w.toolCalls.filter(c => c.tool === 'TaskStop').map(c => c.task_id)
  const restart = async () => {
    w.agents = [row('h1', 'completed'), row('h2', 'completed')]
    await w.clock.advance(4_100)
    await $.session.send({ to: 'h1', text: '[PROPOSE] hello quill', agentId: 'a-h2' } as never)
    w.agents = [row('h1', 'idle'), row('h2', 'completed')]
    await w.clock.advance(5_100)
    const h1 = JSON.parse(w.writes.get(CWD + '/.swarm/roster.json') ?? '{}').agents.filter((a: { name: string }) => a.name === 'h1')
    expect(h1.map((a: { id: string; status: string }) => [a.id, a.status])).toEqual([['a-h1', 'idle']])
  }
  expect(await $.tool.call({ tool: 'mcp__agent-swarm__stop_swarm' } as never)).toEqual({ result: 'swarm: stopped Marlin (h1), h2' })
  await restart()
  expect(await $.tool.call({ tool: 'mcp__agent-swarm__stop_swarm' } as never)).toEqual({ result: 'swarm: stopped Marlin (h1)' })
  await restart()
  expect(await $.command.run({ command: 'swarm', args: 'stop all' } as never)).toEqual({ text: 'swarm: stopped Marlin (h1)' })
  await restart()
  const pane = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: 120 } } as never)
  await pane.press({ key: 'stop-all' })
  expect(w.toasts.at(-1)).toBe('swarm: stopped Marlin (h1)')
  expect(stops()).toEqual(['h1', 'h2', 'h1', 'h1', 'h1'])
  await pane.unmount()
})

test('a [WAIT] past 6 h idle still fires and the idle teammates keep their claims: dormancy is display only', { timeoutMs: 15_000 }, async ($, on) => {
  const w = world(on)
  on('agent.spawn', ($, e) => ({ model: 'claude-opus-5-5', agentId: 'a-' + (e as { name: string }).name, teammateId: (e as { name: string }).name + '@s' }))
  await start($)
  for (const n of ['t1', 't2']) await $.agent.spawn({ prompt: 'Goal: g', name: n, isTeammate: true } as never)
  const row = (n: string, status: string) => ({ id: 'a-' + n, name: n, type: 'teammate', status, description: '', teammateId: n + '@s' })
  w.agents = [row('t1', 'running'), row('t2', 'running')]
  await $.session.send({ to: 't2', text: '[CLAIM] build x.ts', agentId: 'a-t1' } as never)
  await $.session.send({ to: 't1', text: '[CLAIM] review x.ts', agentId: 'a-t2' } as never)
  await w.clock.advance(5_000)
  const at = new Date(w.clock.now() + 8 * 3_600_000).toISOString()
  await $.session.send({ to: 'team-lead', text: `[WAIT] until ${at}`, agentId: 'a-t1' } as never)
  w.agents = [row('t1', 'idle'), row('t2', 'idle')]
  await $.session.receive({ origin: peer('t1'), text: '{"type":"idle_notification","from":"t1","idleReason":"available"}' } as never)
  for (let i = 0; i < 7 * 6; i++) await w.clock.advance(10 * 60_000)
  const claims = JSON.parse(w.writes.get(CWD + '/.swarm/roster.json') ?? '{}').claims
  expect(JSON.stringify(claims)).toContain('x.ts')
  expect(JSON.stringify(claims)).toContain('t1')
  const ui = await listPane($, PANE)
  const texts = (await ui.findAll({ type: 'Text' })).map(t => String((t as { text?: string }).text ?? ''))
  expect(texts.findIndex(t => / t1 /.test(t))).toBeLessThan(texts.indexOf('── other agents ──') === -1 ? Infinity : texts.indexOf('── other agents ──'))
  await ui.unmount()
  for (let i = 0; i < 6 + 1; i++) await w.clock.advance(10 * 60_000)
  expect(w.sends.filter(x => x.text.startsWith('swarm: [ASK]') && x.text.includes('reached'))).toHaveLength(1)
})

test('an agent pressed in the live pane shows its transcript\'s last lines under the stage, read again while shown, and a field that messages it; pressed again clears them; /swarm say messages a live agent', async ($, on) => {
  const w = world(on)
  on('agent.spawn', ($, e) => ({ model: 'claude-opus-5-5', agentId: 'a-' + (e as { name: string }).name, teammateId: (e as { name: string }).name + '@s' }))
  let said = 'Reading the brief'
  const reads: string[] = []
  on('session.messages', ($, e) => {
    const id = (e as { agentId?: string }).agentId ?? ''
    reads.push(id)
    if (id === 'a-t2') throw new Error('store gone')
    if (id !== 'a-t1') return { value: { deny: 'no transcript for ' + id } } as never
    return { value: [{ role: 'user', text: 'Goal: build x\nmore', toolUses: [] }, { role: 'assistant', text: said, toolUses: [{ tool_use_id: 'u1', tool: 'Read', input: {} }] }] } as never
  })
  await start($)
  for (const n of ['t1', 't2']) await $.agent.spawn({ prompt: 'Goal: g', name: n, isTeammate: true } as never)
  w.agents = ['t1', 't2'].map(n => ({ id: 'a-' + n, name: n, type: 'teammate', status: 'running', description: '', teammateId: n + '@s' }))
  await $.session.send({ to: 't2', text: '[PROPOSE] hello Atlas', agentId: 'a-t1' } as never)
  const ui = (await $.ui.mount(PANE as never)) as Mounted<'terminal'>
  const texts = async () => (await ui.findAll({ type: 'Text' })).map(t => String((t as { text?: string }).text ?? ''))
  expect((await texts()).some(t => t.includes('transcript'))).toBe(false)
  expect(reads).toEqual([])
  await ui.press({ key: 'agent-t1' })
  await w.clock.advance(100)
  expect((await texts()).filter(t => /transcript|^[›‹·] /.test(t))).toEqual(['Atlas (t1) · transcript', '› Goal: build x', '‹ Reading the brief', '· Read'])
  const field = await ui.find({ type: 'Input', key: 'compose' })
  expect([field?.props.label, field?.props.submitLabel]).toEqual(['to Atlas (t1):', 'send'])
  const sent = w.sends.length
  await ui.input({ key: 'compose', text: '   ' })
  expect(w.sends.length).toBe(sent)
  await ui.input({ key: 'compose', text: 'half typed', kind: 'change' })
  await w.clock.advance(2_100)
  expect((await ui.find({ type: 'Input', key: 'compose' }))?.props.value).toBe('half typed')
  await ui.input({ key: 'compose', text: 'rebase on main' })
  await w.clock.advance(100)
  expect(w.sends.slice(sent)).toEqual([{ to: 'a-t1', text: 'swarm: the user says: rebase on main' }])
  expect(await texts()).toContain('sent to Atlas (t1)')
  expect((await ui.find({ type: 'Input', key: 'compose' }))?.props.value).toBe('')
  said = 'Writing x.ts'
  await w.clock.advance(4_100)
  expect(await texts()).toContain('‹ Writing x.ts')
  await ui.press({ key: 'agent-t1' })
  await w.clock.advance(100)
  expect((await texts()).some(t => t.includes('transcript') || t.startsWith('‹ '))).toBe(false)
  const n = reads.length
  await w.clock.advance(4_100)
  expect(reads.length).toBe(n)
  await ui.press({ key: 'agent-t2' })
  await w.clock.advance(1_000)
  expect((await texts()).filter(t => t.startsWith('transcript not readable: '))).toHaveLength(1)
  expect(reads.filter(r => r === 'a-t2').length).toBe(1)
  await ui.unmount()
  expect(await $.command.run({ command: 'swarm', args: 'say Atlas please rebase now' } as never)).toEqual({ text: 'sent to Atlas (t1)' })
  expect(w.sends.at(-1)).toEqual({ to: 'a-t1', text: 'swarm: the user says: please rebase now' })
  expect(await $.command.run({ command: 'swarm', args: 'say nobody hi' } as never)).toEqual({ text: 'no live agent goes by nobody' })
  expect(await $.command.run({ command: 'swarm', args: 'say t1' } as never)).toEqual({ text: 'usage: /swarm say <agent> <text>' })
})

test('/swarm taken by another plugin: /swarmctl still registers and answers, start-up goes on, status and help name the holder', async ($, on) => {
  const w = world(on)
  w.swarmTakenBy = 'other-swarm'
  await start($)
  expect(w.commands).toEqual(['swarmctl'])
  expect(w.descriptions.get('swarmctl')).toMatch(/^\/swarm is taken by other-swarm; use \/swarmctl\. Swarm: open the pane/)
  expect((await $.command.run({ command: 'swarmctl', args: 'status' } as never)).text).toMatch(/^\/swarm is taken by other-swarm; use \/swarmctl · swarm: 0 agents/)
  await $.session.send({ to: 'builder', text: '[PROPOSE] split it', agentId: 'a1' } as never)
  await w.clock.advance(1100)
  expect(w.appended.join('')).toContain('[PROPOSE] split it')
})

/** Starts with `/swarm` held by `other`, answering the conflict question with `answer` (a function that throws stands for a dismissed or `-p` ask). */
async function conflictWorld($: Engine, on: On, answer: string | (() => never), interactive = true) {
  const asked: string[] = []
  on('tool.call', { tool: 'AskUserQuestion' }, ($, e) => {
    const q = (e as unknown as { questions: { question: string }[] }).questions[0]!.question
    asked.push(q)
    if (typeof answer === 'function') answer()
    return { result: { questions: [], answers: { [q]: answer } } } as never
  })
  on('settings.read', () => ({ value: { enabledPlugins: { 'other@onewave': true, 'agent-swarm@claude-code-swarm': true } } }) as never)
  const w = world(on)
  w.swarmTakenBy = 'other'
  await $.session.start({ surface: interactive ? 'terminal' : null, isInteractive: interactive, cwd: CWD } as never)
  await w.clock.advance(1_100)
  return { w, asked }
}

test('/swarm conflict: the user is asked once after start; Keep both is stored and never asked again', async ($, on) => {
  const { w, asked } = await conflictWorld($, on, "Keep both: I'll use /swarmctl")
  expect(asked).toEqual(['Another plugin (other) already uses /swarm. How do you want to use this one?'])
  expect(w.saved.get('swarmConflict')).toBe('keep')
  await $.turn.complete({ turnId: 'x', text: '' } as never)
  await w.clock.advance(1_000)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: CWD } as never)
  await w.clock.advance(1_100)
  expect(asked.length).toBe(1)
})

test('/swarm conflict: Show me how shows the uninstall command for the holder and stores nothing', async ($, on) => {
  const { w, asked } = await conflictWorld($, on, 'Show me how to remove the other plugin')
  expect(asked.length).toBe(1)
  expect(w.toasts).toEqual(['To remove other: /plugin uninstall other@onewave, and restart Claude Code afterwards.'])
  expect(w.saved.has('swarmConflict')).toBe(false)
})

test('/swarm conflict: Ask me again stores nothing and is not asked again this session', async ($, on) => {
  const { w, asked } = await conflictWorld($, on, 'Ask me again next session')
  await $.turn.complete({ turnId: 'x', text: '' } as never)
  await w.clock.advance(1_000)
  expect(asked.length).toBe(1)
  expect(w.saved.has('swarmConflict')).toBe(false)
  expect(w.toasts).toEqual([])
})

test('/swarm conflict: a dismissed ask stores nothing and start-up goes on', async ($, on) => {
  const { w, asked } = await conflictWorld($, on, () => {
    throw new Error('dismissed')
  })
  expect(asked.length).toBe(1)
  expect(w.saved.has('swarmConflict')).toBe(false)
  expect(w.commands).toEqual(['swarmctl'])
  expect((await $.command.run({ command: 'swarmctl', args: 'status' } as never)).text).toMatch(/^\/swarm is taken by other; use \/swarmctl · /)
})

test('/swarm conflict: a -p session is never asked', async ($, on) => {
  const { w, asked } = await conflictWorld($, on, "Keep both: I'll use /swarmctl", false)
  expect(asked).toEqual([])
  expect(w.saved.has('swarmConflict')).toBe(false)
})

test('claims are judged on their target token: a double claim with different trailing prose gets one "is yours" and one [ASK]; prose quoting a claim and a lead-addressed copy add no answer (10-17 log l.11–22, l.330, l.954/l.969)', async ($, on) => {
  const w = world(on)
  on('agent.spawn', ($, e) => ({ model: 'claude-haiku', agentId: 'a-' + (e as { name: string }).name, teammateId: (e as { name: string }).name + '@s' }))
  await start($)
  const names = ['u1', 'u2', 'u5', 'u6', 'u14', 'u15', 'u16']
  for (const n of names) await $.agent.spawn({ prompt: 'p', name: n, isTeammate: true } as never)
  const mod = (id: string) => w.sends.filter(s => s.to === 'a-' + id && !s.text.startsWith('#')).map(s => s.text.replace(/ \([^]*$/, ''))
  await $.session.send({ to: 'u2', text: '[CLAIM] research core-aa (u1, sonnet)', agentId: 'a-u1' } as never)
  await $.session.send({ to: 'u1', text: '[CLAIM] research core-aa (u2, code name Ivy)', agentId: 'a-u2' } as never)
  expect([mod('u1'), mod('u2')]).toEqual([['swarm: research core-aa is yours.'], ['swarm: [ASK] core-aa is already claimed by u1']])
  await $.session.send({ to: 'u14', text: '[CLAIM] research int-ai', agentId: 'a-u15' } as never)
  await $.session.send({ to: 'u15', text: '[PROPOSE] hello Lark\n[CLAIM] research int-ai', agentId: 'a-u16' } as never)
  await $.session.send({ to: 'team-lead', text: '[CLAIM] research int-ai (u16, Lark, haiku). Starting now.', agentId: 'a-u16' } as never)
  expect(mod('u16')).toEqual(['swarm: [ASK] int-ai is already claimed by u15'])
  await $.session.send({ to: 'u1', text: '[PROPOSE] hello Basil\n[CLAIM] research int-aa', agentId: 'a-u5' } as never)
  await $.session.send({ to: 'u5', text: '[CLAIM] research int-aa', agentId: 'a-u6' } as never)
  await $.session.send({ to: 'u6', text: 'int-aa is mine: my [CLAIM] research int-aa is #29 (08:56:25), yours is #39, and the lead confirmed it to me. Please take another free slice (not int-aa).', agentId: 'a-u5' } as never)
  expect(mod('u5')).toEqual(['swarm: research int-aa is yours.'])
  await w.clock.advance(1100)
  const roster = JSON.parse(w.writes.get(CWD + '/.swarm/roster.json') ?? '{}')
  expect(roster.claims.map((c: { key: string; by: string[] }) => [c.key, c.by])).toEqual([['research core-aa', ['u1', 'u2']], ['research int-ai', ['u15', 'u16']], ['research int-aa', ['u5', 'u6']]])
})

test('looks A and B show a claim made after a message\'s first line: inside a hello, and after a first-line [RELEASE]; the log line carries it, so a replay and a reload read it too (10-17 log l.30–32, l.1127–1128)', async ($, on) => {
  const w = world(on)
  on('agent.spawn', ($, e) => ({ model: 'claude-haiku', agentId: 'a-' + (e as { name: string }).name, teammateId: (e as { name: string }).name + '@s' }))
  await start($)
  for (const n of ['u1', 'u3', 'u9']) await $.agent.spawn({ prompt: 'p', name: n, isTeammate: true } as never)
  await $.session.send({ to: 'u1', text: '[PROPOSE] hello Juniper\nHaiku, read-only audit.\n[CLAIM] research web-af', agentId: 'a-u3' } as never)
  await $.session.send({ to: 'u1', text: '[CLAIM] research int-ad', agentId: 'a-u9' } as never)
  await $.session.send({ to: 'u1', text: '[RELEASE] int-ad\nu10 holds it.\n[CLAIM] research web-ad', agentId: 'a-u9' } as never)
  await w.clock.advance(1100)
  const lines = w.appended.join('').trim().split('\n').map(l => JSON.parse(l)).filter(l => l.from !== 'swarm' && l.type !== 'JOIN')
  expect(lines.map(l => [l.summary, l.claim])).toEqual([
    ['[PROPOSE] hello Juniper', { role: 'research', target: 'web-af' }],
    ['[CLAIM] research int-ad', { role: 'research', target: 'int-ad' }],
    ['[RELEASE] int-ad', { role: 'research', target: 'web-ad' }],
  ])
  const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: 100 } } as never)
  const a = await rasterText(ui)
  expect(a).toContain('─ web-af ─')
  expect(a).toContain('─ web-ad ─')
  expect(a).not.toContain('─ int-ad ─')
  await ui.press({ key: 'view-B' })
  const b = await rasterText(ui)
  expect(b).toContain('■ web-af')
  expect(b).toContain('■ web-ad')
  await ui.unmount()
  const replayed = new Scene()
  for (const l of lines) replayed.apply(l)
  expect(replayed.cards().map(c => c.slice).sort()).toEqual(['web-ad', 'web-af'])
  const reloaded = new ClaimBoard()
  hydrateClaims(reloaded, lines, lines[0].session)
  expect(reloaded.all().map(c => [c.key, c.by])).toEqual([['research web-af', ['u3']], ['research web-ad', ['u9']]])
})

test('a swarm with no deliverable has no builder to miss: a [DONE] wakes no "no builder claimed", and the band shows no ⚠ (10-17 log l.11, l.20, l.326)', async ($, on) => {
  const w = world(on)
  on('agent.spawn', ($, e) => ({ model: 'claude-haiku', agentId: 'a-' + (e as { name: string }).name, teammateId: (e as { name: string }).name + '@s' }))
  await start($)
  for (const n of ['u1', 'u2', 'u7']) await $.agent.spawn({ prompt: 'Goal: order-dependence audit, 21 slices', name: n, isTeammate: true } as never)
  w.agents = ['u1', 'u2', 'u7'].map(n => ({ id: 'a-' + n, name: n, type: 'teammate', status: 'running', description: '', teammateId: n + '@s' }))
  await w.clock.advance(4_100)
  await $.session.send({ to: 'u2', text: '[CLAIM] research core-aa (u1, sonnet)', agentId: 'a-u1' } as never)
  await $.session.send({ to: 'u1', text: '[CLAIM] research core-ab', agentId: 'a-u2' } as never)
  await $.session.send({ to: 'u1', text: '[CLAIM] research core-ad', agentId: 'a-u7' } as never)
  await $.session.send({ to: 'team-lead', text: '[DONE] core-ad 6 findings (0 HIGH)', agentId: 'a-u7' } as never)
  await w.clock.advance(10 * 60_000)
  expect(w.submitted.filter(t => t.includes('no builder'))).toEqual([])
  const status = (await $.command.run({ command: 'swarm', args: 'status' } as never)) as { text: string }
  expect(status.text).toContain('swarm: yes')
  expect(status.text).not.toContain('⚠')
  const roster = JSON.parse(w.writes.get(CWD + '/.swarm/roster.json') ?? '{}')
  expect([roster.deliverables, roster.firedAlerts]).toEqual([[], []])
})

test('the mod\'s own send is logged once, as from swarm, also when its idle recipient takes it after 200 other sends (10-17 log l.316 = l.1069)', async ($, on) => {
  const w = world(on)
  on('agent.spawn', ($, e) => ({ model: 'claude-haiku', agentId: 'a-' + (e as { name: string }).name, teammateId: (e as { name: string }).name + '@s' }))
  await start($)
  for (const n of ['u7', 'u9', 'u10']) await $.agent.spawn({ prompt: 'p', name: n, isTeammate: true } as never)
  await $.session.send({ to: 'u7', text: '[CLAIM] research int-ad', agentId: 'a-u10' } as never)
  for (let i = 0; i < 210; i++) await $.session.send({ to: i % 2 ? 'u7' : 'u9', text: 'note ' + i, agentId: i % 2 ? 'a-u9' : 'a-u7' } as never)
  await w.clock.advance(8 * 60_000)
  await $.session.receive({ origin: { kind: 'coordinator' }, text: 'swarm: research int-ad is yours.', agentId: 'a-u10' } as never)
  await $.session.receive({ origin: { kind: 'coordinator' }, text: 'swarm: research int-ad is yours.', agentId: 'a-u10' } as never)
  await w.clock.advance(1100)
  const lines = w.appended.join('').trim().split('\n').map(l => JSON.parse(l))
  expect(lines.filter(l => l.summary === 'swarm: research int-ad is yours.').map(l => [l.from, l.to, l.via])).toEqual([['swarm', 'u10', 'send'], ['team-lead', 'u10', 'receive']])
})

test('one number per fact: look A\'s and look B\'s LEAD wakes equal the band\'s, the mod\'s own wakes included; the stand-down toast and the ENDED header\'s ran span the same time, first spawn to last activity', async ($, on) => {
  const w = world(on)
  on('agent.spawn', ($, e) => ({ model: 'sonnet', agentId: 'a-' + (e as { name: string }).name, teammateId: (e as { name: string }).name + '@s' }))
  await start($)
  const rows = (status: string) => ['t1', 't2'].map(n => ({ id: 'a-' + n, name: n, type: 'teammate', status, description: '', teammateId: n + '@s' }))
  for (const n of ['t1', 't2']) await $.agent.spawn({ prompt: 'p', name: n, isTeammate: true } as never)
  w.agents = rows('running')
  await w.clock.advance(90_000)
  await $.session.send({ to: 't2', text: '[PROPOSE] hello Atlas', agentId: 'a-t1' } as never)
  await $.session.send({ to: 't1', text: 'which template? @lead please decide', agentId: 'a-t2' } as never)
  await w.clock.advance(6_000)
  expect(w.submitted.filter(t => t.includes('mention you'))).toHaveLength(1)
  await $.session.receive({ origin: peer('t1'), text: '[DONE] x.md written' } as never)
  await $.session.receive({ origin: peer('t2'), text: '[CLAIM] build y.md' } as never)
  const band = ((await $.command.run({ command: 'swarm', args: 'status' } as never)) as { text: string }).text
  expect(band).toContain('wakes 2 · held 1')
  const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: 100 } } as never)
  expect(await rasterText(ui)).toContain('▲ 2 woken  ▽ 1 held back')
  await ui.press({ key: 'view-B' })
  expect(await rasterText(ui)).toContain('▲ 2 woken  ▽ 1 held at the membrane')
  await w.clock.advance(10 * 60_000)
  w.agents = rows('killed')
  await w.clock.advance(4_100)
  const ran = /ran (\S+)/.exec(await rasterText(ui))?.[1]
  await ui.press({ key: 'view-A' })
  expect(/ran (\S+)/.exec(await rasterText(ui))?.[1]).toBe(ran)
  expect(w.toasts).toEqual([`swarm stood down: 2 agents · 4 messages · ${ran} · lead woken 2 (1.0/agent), held 1`])
  expect(ran).toBe('1m')
  await ui.unmount()
})

test('a swarm reusing an earlier swarm\'s names, one of them spawned after its first peer message, runs from its own first spawn: the ENDED header\'s ran and the toast both say 5m', async ($, on) => {
  const w = world(on)
  let gen = 0
  on('agent.spawn', ($, e) => { const n = (e as { name: string }).name; return { model: 'sonnet', agentId: `a-${n}-${gen}`, teammateId: n + '@s' } })
  await start($)
  const rows = (names: string[], status: string) => names.map(n => ({ id: `a-${n}-${gen}`, name: n, type: 'teammate', status, description: '', teammateId: n + '@s' }))
  for (const n of ['t1', 't2', 't3']) await $.agent.spawn({ prompt: 'p', name: n, isTeammate: true } as never)
  w.agents = rows(['t1', 't2', 't3'], 'running')
  await $.session.send({ to: 't2', text: '[PROPOSE] hello A', agentId: 'a-t1-0' } as never)
  await $.session.send({ to: 't1', text: '[PROPOSE] hello B', agentId: 'a-t3-0' } as never)
  await w.clock.advance(60_000)
  w.agents = rows(['t1', 't2', 't3'], 'completed')
  await w.clock.advance(14_100)
  w.toasts.length = 0
  await w.clock.advance(60 * 60_000)
  gen = 1
  for (const n of ['t1', 't2']) await $.agent.spawn({ prompt: 'p', name: n, isTeammate: true } as never)
  w.agents = rows(['t1', 't2'], 'running')
  await $.session.send({ to: 't2', text: '[PROPOSE] hello C', agentId: 'a-t1-1' } as never)
  await w.clock.advance(60_000)
  await $.agent.spawn({ prompt: 'p', name: 't3', isTeammate: true } as never)
  w.agents = rows(['t1', 't2', 't3'], 'running')
  await $.session.send({ to: 't1', text: '[PROPOSE] hello D', agentId: 'a-t3-1' } as never)
  await w.clock.advance(4 * 60_000)
  await $.session.send({ to: 't3', text: '[DONE] x', agentId: 'a-t1-1' } as never)
  const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: 100 } } as never)
  w.agents = rows(['t1', 't2', 't3'], 'completed')
  await w.clock.advance(14_100)
  expect(/ran (\S+)/.exec(await rasterText(ui))?.[1]).toBe('5m')
  expect(w.toasts).toEqual([expect.stringMatching(/^swarm stood down: 3 agents · \d+ messages · 5m · /)])
  await ui.unmount()
})

test('stop_swarm on an idle swarm after a quiet stretch: one stand-down toast, shown long enough to be seen (10-17 run 2: 18 stopped at 12:26:30, toast missing)', async ($, on) => {
  const w = world(on)
  on('agent.spawn', ($, e) => ({ model: 'claude-haiku', agentId: 'a-' + (e as { name: string }).name, teammateId: (e as { name: string }).name + '@s' }))
  await start($)
  const names = Array.from({ length: 18 }, (_, i) => 'v' + (i + 1))
  for (const n of names) await $.agent.spawn({ prompt: 'p', name: n, isTeammate: true } as never)
  w.agents = names.map(n => ({ id: 'a-' + n, name: n, type: 'teammate', status: 'running', description: '', teammateId: n + '@s' }))
  await w.clock.advance(4_100)
  for (const [i, n] of names.entries()) await $.session.send({ to: names[(i + 1) % 18]!, text: `[CLAIM] research s${i}`, agentId: 'a-' + n } as never)
  for (const n of names) await $.session.send({ to: 'team-lead', text: `[DONE] s${n} 3 findings`, agentId: 'a-' + n } as never)
  w.agents = w.agents.map(a => ({ ...a, status: 'idle' }))
  await w.clock.advance(5.6 * 60_000)
  await $.turn.start({ turnId: 'L9', text: 'stop' } as never)
  expect((await $.tool.call({ tool: 'mcp__agent-swarm__stop_swarm' } as never)) as { result: string }).toMatchObject({ result: expect.stringMatching(/^swarm: stopped /) })
  w.agents = w.agents.map(a => ({ ...a, status: 'killed' }))
  await w.clock.advance(4_100)
  await $.turn.complete({ turnId: 'L9', answer: '', durationMs: 1, isAborted: false, reason: 'answer', usage: null } as never)
  await w.clock.advance(10_000)
  expect(w.toasts.filter(t => t.startsWith('swarm stood down'))).toEqual([expect.stringMatching(/^swarm stood down: 18 agents · /)])
  expect(w.toastMs[w.toasts.findIndex(t => t.startsWith('swarm stood down'))]).toBeGreaterThanOrEqual(20_000)
})

test('a [CLAIM] riding a first-line [RELEASE] is held: one "is yours", the later claimant gets "already claimed" (10-17 run 2 l.738–751)', async ($, on) => {
  const w = world(on)
  on('agent.spawn', ($, e) => ({ model: 'claude-haiku', agentId: 'a-' + (e as { name: string }).name, teammateId: (e as { name: string }).name + '@s' }))
  await start($)
  for (const n of ['v1', 'v2', 'v8', 'v10']) await $.agent.spawn({ prompt: 'p', name: n, isTeammate: true } as never)
  await $.session.send({ to: 'v1', text: '[CLAIM] research web-ab', agentId: 'a-v8' } as never)
  for (const to of ['v1', 'v2']) await $.session.send({ to, text: '[RELEASE] web-ab (Mote/v8). [CLAIM] research web-ac', agentId: 'a-v8' } as never)
  for (const to of ['v1', 'v2']) await $.session.send({ to, text: '[CLAIM] research web-ac', agentId: 'a-v10' } as never)
  const mod = (id: string) => w.sends.filter(s => s.to === 'a-' + id && !s.text.startsWith('#')).map(s => s.text.replace(/ \([^]*$/, ''))
  expect([mod('v8'), mod('v10')]).toEqual([['swarm: research web-ab is yours.', 'swarm: research web-ac is yours.'], ['swarm: [ASK] web-ac is already claimed by v8']])
  await w.clock.advance(1100)
  const roster = JSON.parse(w.writes.get(CWD + '/.swarm/roster.json') ?? '{}')
  expect(roster.claims.map((c: { key: string; by: string[] }) => [c.key, c.by])).toEqual([['research web-ac', ['v8', 'v10']]])
})

test('a release by a later claimant holds in roster.json, the text list and the looks alike, though its broadcast [CLAIM] reaches idle teammates after it (10-17 run 2 l.169–174, l.263)', async ($, on) => {
  const w = world(on)
  on('agent.spawn', ($, e) => ({ model: 'claude-haiku', agentId: 'a-' + (e as { name: string }).name, teammateId: (e as { name: string }).name + '@s' }))
  await start($)
  const names = ['v1', 'v3', 'v4', 'v5']
  for (const n of names) await $.agent.spawn({ prompt: 'p', name: n, isTeammate: true } as never)
  w.agents = names.map(n => ({ id: 'a-' + n, name: n, type: 'teammate', status: 'running', description: '', teammateId: n + '@s' }))
  await w.clock.advance(4_100)
  await $.session.send({ to: 'v1', text: '[CLAIM] research core-ad', agentId: 'a-v5' } as never)
  for (const to of ['v1', 'v4', 'v5']) await $.session.send({ to, text: '[CLAIM] research core-ad', agentId: 'a-v3' } as never)
  await $.session.send({ to: 'v5', text: '[RELEASE] core-ad', agentId: 'a-v3' } as never)
  const stamped = w.sends.filter(s => s.text.includes('[CLAIM] research core-ad') && s.text.startsWith('#'))
  for (const s of stamped) await $.session.receive({ origin: peer('v3'), text: s.text, agentId: 'a-' + String(s.to) } as never)
  await w.clock.advance(1100)
  const roster = JSON.parse(w.writes.get(CWD + '/.swarm/roster.json') ?? '{}')
  expect(roster.claims.map((c: { key: string; by: string[] }) => [c.key, c.by])).toEqual([['research core-ad', ['v5']]])
  const list = await listPane($, { ...PANE, props: { ...PANE.props, bodyColumns: 100 } })
  expect(await list.find({ type: 'Text', text: /^core-ad · research v5$/ })).toBeDefined()
  await list.press({ key: 'view-A' })
  expect(await rasterText(list)).toMatch(/─ core-ad ─/)
  expect(await rasterText(list)).not.toMatch(/research v5, v3|research v3/)
  await list.unmount()
})

test('claim watchdog: a teammate that claimed and then released is not working without a claim; with no deliverable the wake asks for slice claims, not a builder (10-17 run 2: v15 l.1195/l.1636, v17 l.1449/l.1758)', async ($, on) => {
  const w = world(on)
  on('agent.spawn', ($, e) => ({ model: 'claude-haiku', agentId: 'a-' + (e as { name: string }).name, teammateId: (e as { name: string }).name + '@s' }))
  await start($)
  const names = ['v14', 'v15', 'v16', 'v17']
  for (const n of names) await $.agent.spawn({ prompt: 'p', name: n, isTeammate: true } as never)
  w.agents = names.map(n => ({ id: 'a-' + n, name: n, type: 'teammate', status: 'running', description: '', teammateId: n + '@s' }))
  await w.clock.advance(4_100)
  await $.session.send({ to: 'v14', text: '[CLAIM] research int-ag', agentId: 'a-v16' } as never)
  await $.session.send({ to: 'v14', text: '[CLAIM] research int-ah', agentId: 'a-v14' } as never)
  await $.session.send({ to: 'v14', text: '[PROPOSE] hello Marlin\n[CLAIM] research int-ag', agentId: 'a-v15' } as never)
  await $.session.send({ to: 'v16', text: '[PROPOSE] hello Sorrel\n[CLAIM] research int-ah', agentId: 'a-v17' } as never)
  await $.session.send({ to: 'v14', text: '[RELEASE] int-ag', agentId: 'a-v15' } as never)
  await $.session.send({ to: 'team-lead', text: '[RELEASE] int-ah', agentId: 'a-v17' } as never)
  await w.clock.advance(10 * 60_000)
  expect(w.submitted.filter(t => t.includes('without a [CLAIM]'))).toEqual([])
  for (const n of ['v18', 'v19']) await $.agent.spawn({ prompt: 'p', name: n, isTeammate: true } as never)
  w.agents = [...w.agents, ...['v18', 'v19'].map(n => ({ id: 'a-' + n, name: n, type: 'teammate', status: 'running', description: '', teammateId: n + '@s' }))]
  await w.clock.advance(4 * 60_000)
  const wakes = w.submitted.filter(t => t.includes('without a [CLAIM]'))
  expect(wakes).toHaveLength(1)
  expect(wakes[0]).toContain('swarm: 2 teammates working without a [CLAIM]: v18, v19')
  expect(wakes[0]).not.toContain('builder')
  expect(wakes[0]).toContain('[CLAIM] <role> <slice>')
})

test('a holder\'s [DONE] then prose quoting its own [CLAIM] does not claim the slice again: the duplicate flag clears (10-17 run 2 l.1722)', async ($, on) => {
  const w = world(on)
  on('agent.spawn', ($, e) => ({ model: 'claude-haiku', agentId: 'a-' + (e as { name: string }).name, teammateId: (e as { name: string }).name + '@s' }))
  await start($)
  for (const n of ['v8', 'v17', 'v18']) await $.agent.spawn({ prompt: 'p', name: n, isTeammate: true } as never)
  await $.session.send({ to: 'v8', text: '[CLAIM] research int-ai', agentId: 'a-v18' } as never)
  await $.session.send({ to: 'v8', text: '[CLAIM] research int-ai', agentId: 'a-v17' } as never)
  await $.session.send({ to: 'team-lead', text: '[DONE] int-ai 14 findings (2 HIGH). File: out/v18-int-ai.md', agentId: 'a-v18' } as never)
  await $.session.send({ to: 'v17', text: "int-ai is taken: v18's [CLAIM] research int-ai (#349, 12:17:12) came before yours (#382). Findings are already written to out/v18-int-ai.md and are with v8 for…", agentId: 'a-v18' } as never)
  const list = await listPane($, { ...PANE, props: { ...PANE.props, bodyColumns: 100 } })
  expect(await list.find({ type: 'Text', text: /^int-ai · research v18, v17$/ })).toBeDefined()
  await list.unmount()
})

test('a teammate that released a slice and claims it again is told again that it is its (run-2 l.738: v8 released web-ab)', async ($, on) => {
  const w = world(on)
  on('agent.spawn', ($, e) => ({ model: 'claude-haiku', agentId: 'a-' + (e as { name: string }).name, teammateId: (e as { name: string }).name + '@s' }))
  await start($)
  for (const n of ['v1', 'v8']) await $.agent.spawn({ prompt: 'p', name: n, isTeammate: true } as never)
  await $.session.send({ to: 'v1', text: '[CLAIM] research web-ab', agentId: 'a-v8' } as never)
  await $.session.send({ to: 'v1', text: '[RELEASE] web-ab (Mote/v8). [CLAIM] research web-ac', agentId: 'a-v8' } as never)
  await $.session.send({ to: 'v1', text: '[CLAIM] research web-ab', agentId: 'a-v8' } as never)
  expect(w.sends.filter(s => s.to === 'a-v8').map(s => s.text)).toEqual(['swarm: research web-ab is yours.', 'swarm: research web-ac is yours.', 'swarm: research web-ab is yours.'])
})

test('a slice as a lock: a waiter hears "is yours" when the holder releases it, once for a broadcast release; the next contention is answered again; a release from a non-holder is answered and frees nothing (run 1 merge-lock, d5 23:52)', async ($, on) => {
  const w = world(on)
  on('agent.spawn', ($, e) => ({ model: 'claude-haiku', agentId: 'a-' + (e as { name: string }).name, teammateId: (e as { name: string }).name + '@s' }))
  await start($)
  for (const n of ['d1', 'd2', 'd5']) await $.agent.spawn({ prompt: 'p', name: n, isTeammate: true } as never)
  w.agents = ['d1', 'd2', 'd5'].map(n => ({ id: 'a-' + n, name: n, type: 'teammate', status: 'running', description: '', teammateId: n + '@s' }))
  await w.clock.advance(4_100)
  const toAll = async (from: string, text: string) => {
    for (const to of ['d1', 'd2', 'd5'].filter(n => n !== from)) await $.session.send({ to, text, agentId: 'a-' + from } as never)
    await w.clock.advance(10)
  }
  const mod = (id: string) => w.sends.filter(s => s.to === 'a-' + id && s.text.startsWith('swarm: ')).map(s => s.text.replace(/ \([^]*$/, ''))
  await toAll('d1', '[CLAIM] build merge-lock')
  await toAll('d2', '[CLAIM] build merge-lock')
  await toAll('d5', '[RELEASE] merge-lock')
  await toAll('d1', '[RELEASE] merge-lock')
  expect(mod('d1')).toEqual(['swarm: build merge-lock is yours.'])
  expect(mod('d2')).toEqual(['swarm: [ASK] merge-lock is already claimed by d1', 'swarm: build merge-lock is yours.'])
  expect(mod('d5')).toEqual(['swarm: [ASK] you hold no build merge-lock: d1'])
  await toAll('d2', '[RELEASE] merge-lock')
  await toAll('d1', '[CLAIM] build merge-lock')
  await toAll('d2', '[CLAIM] build merge-lock')
  await toAll('d1', '[RELEASE] merge-lock')
  expect(mod('d1')).toEqual(['swarm: build merge-lock is yours.', 'swarm: build merge-lock is yours.'])
  expect(mod('d2').slice(2)).toEqual(['swarm: [ASK] merge-lock is already claimed by d1', 'swarm: build merge-lock is yours.'])
  expect(mod('d5')).toHaveLength(1)
  await toAll('d1', '[CLAIM] build merge-lock')
  await toAll('d2', '[DONE] all merged')
  expect(mod('d1').slice(2)).toEqual(['swarm: [ASK] merge-lock is already claimed by d2'])
  await toAll('d1', '[CLAIM] build merge-lock')
  expect(mod('d1').slice(3)).toEqual(['swarm: build merge-lock is yours.'])
  await toAll('d2', '[CLAIM] build merge-lock')
  await toAll('d5', '[CLAIM] build merge-lock')
  await toAll('d2', '[REVIEW] names approve')
  await toAll('d2', '[CLAIM] build merge-lock')
  await toAll('d1', '[RELEASE] merge-lock')
  expect(mod('d2').slice(4)).toEqual(['swarm: [ASK] merge-lock is already claimed by d1', 'swarm: [ASK] you no longer wait for build merge-lock: a report ends a wait. Claim it again to wait.', 'swarm: [ASK] merge-lock is already claimed by d1'])
  expect(mod('d5').slice(1)).toEqual(['swarm: [ASK] merge-lock is already claimed by d1', 'swarm: build merge-lock is yours.'])
  await toAll('d2', '[CLAIM] build sky-python')
  await toAll('d1', '[CLAIM] build sky-python')
  await toAll('d2', '[DONE] sky-python merged at abc123')
  await toAll('d5', '[RELEASE] merge-lock')
  expect(mod('d1').slice(4)).toEqual(['swarm: [ASK] sky-python is already claimed by d2'])
})

test('stall watchdog with an empty, readable task list: an open claim is work remaining, so its holder is nudged and the lead hears swarm stalled M min later (run 3: all idle 6.9 min, no tasks)', async ($, on) => {
  const w = world(on)
  on('fs.list', () => ({ value: [] }) as never)
  w.files.set('/.claude/tasks/session-abcdef01', '')
  on('agent.spawn', ($, e) => ({ model: 'claude-haiku', agentId: 'a-' + (e as { name: string }).name, teammateId: (e as { name: string }).name + '@s' }))
  await start($)
  for (const n of ['w1', 'w2', 'w3']) await $.agent.spawn({ prompt: 'p', name: n, isTeammate: true } as never)
  w.agents = ['w1', 'w2', 'w3'].map(n => ({ id: 'a-' + n, name: n, type: 'teammate', status: 'idle', description: '', teammateId: n + '@s' }))
  await $.session.send({ to: 'w2', text: '[CLAIM] research user-01-start', agentId: 'a-w1' } as never)
  await $.session.send({ to: 'w1', text: '[CLAIM] research user-04-kalender', agentId: 'a-w2' } as never)
  await $.session.send({ to: 'w1', text: '[CLAIM] research user-07-profil-erfassen', agentId: 'a-w3' } as never)
  for (const n of ['w1', 'w2']) await $.session.send({ to: 'team-lead', text: '[DONE] slice covered', agentId: 'a-' + n } as never)
  await w.clock.advance(6.9 * 60_000)
  expect((await $.command.run({ command: 'swarm', args: 'status' } as never) as { text: string }).text).toContain('open tasks: 0')
  expect(w.sends.filter(s => s.text.startsWith('swarm: [ASK] quiet'))).toEqual([{ to: 'a-w3', text: 'swarm: [ASK] quiet 5 min: you hold research user-07-profil-erfassen; reported: w1 DONE, w2 DONE. Continue, or send [DONE]/[BLOCK].' }])
  expect(w.submitted.filter(t => t.startsWith('swarm stalled'))).toEqual([])
  await w.clock.advance(5.1 * 60_000)
  expect(w.submitted.filter(t => t.startsWith('swarm stalled'))).toEqual([expect.stringContaining('0 task(s) still open, 1 claim(s) open')])
})
