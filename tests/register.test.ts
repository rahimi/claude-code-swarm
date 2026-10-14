import type { On } from 'claude-code'
import type { Engine, Mounted } from 'claude-code/testing'
import { expect, mock, test } from 'claude-code/testing'

const CWD = '/work'

type World = {
  clock: ReturnType<typeof mock.clock>
  submitted: string[]
  appended: string[]
  writes: Map<string, string>
  saved: Map<string, unknown>
  agents: { id: string; name?: string; type: string; status: string; description: string; teammateId?: string }[]
  files: Map<string, string>
  toolResult: unknown
  sends: { to: unknown; text: string }[]
  mtimes: Map<string, number>
  refusesSends: boolean
  commands: string[]
  statuses: (string | undefined)[]
  toasts: string[]
  /** The plugin that holds `/swarm` already, so registering it is refused. */
  swarmTakenBy?: string
  descriptions: Map<string, string>
}

/** Stubs every mods API call the mod makes, so each test drives events only. */
function world(on: On): World {
  const w: World = { clock: mock.clock(on, { now: 1_000_000 }), submitted: [], appended: [], writes: new Map(), saved: new Map(), agents: [], files: new Map(), toolResult: 'sent', sends: [], mtimes: new Map(), refusesSends: false, commands: [], statuses: [], toasts: [], descriptions: new Map() }
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
    return { value: undefined } as never
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('agent.list', () => ({ value: w.agents }) as never)
  on('prompt.submit', ($, e) => {
    w.submitted.push(e.text)
    return { text: e.text }
  })
  on('session.send', ($, e) => {
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
  on('tool.call', () => ({ result: w.toolResult }) as never)
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
  expect(roster.claims).toEqual([{ role: 'research', target: 'group a', key: 'research group a', by: ['t3'] }])
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
  expect(wakes[0]).toContain('swarm: no builder claimed for the deliverable')
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
  w.agents = ['t1', 't2', 't3'].map(n => ({ id: 'a-' + n, name: n, type: 'teammate', status: 'running', description: '', teammateId: n + '@session-6036d038' }))
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
  expect(sends.map(x => x.text)).toEqual([`#1 · 00:16:41\n[WAIT] ${f2}\nrunning the suite`])
  await $.session.receive({ origin: peer('t1'), text: '{"type":"idle_notification","from":"t1","idleReason":"available"}' } as never)
  await $.session.receive({ origin: peer('t2'), text: '{"type":"idle_notification","from":"t2","idleReason":"available"}' } as never)
  await w.clock.advance(12_000)
  const asks = () => sends.filter(x => x.text.startsWith('[ASK] /wt/'))
  const t2Ask = { to: 'a-t2', text: `[ASK] ${f2} changed: ok 12 tests ${'x'.repeat(188)}` }
  expect(asks()).toEqual([t2Ask])
  mtimes.set(f1, w.clock.now() + 1)
  mtimes.set(f2, w.clock.now() + 1)
  await w.clock.advance(12_000)
  expect(asks()).toEqual([t2Ask, { to: 'a-t1', text: `[ASK] ${f1} changed: { "verdict": "RED", "failed": 2 }` }, t2Ask])
  await w.clock.advance(30_000)
  expect(asks().length).toBe(3)
  await $.session.send({ to: 't2', text: '[ASK] rerunning', agentId: 'a-t1' } as never)
  mtimes.set(f1, w.clock.now() + 1)
  await w.clock.advance(12_000)
  expect(asks().length).toBe(3)
  await w.clock.advance(1100)
  expect(JSON.parse(w.writes.get(CWD + '/.swarm/roster.json') ?? '{}').waits.t2).toMatchObject({ path: f2, wokenFor: expect.any(Number) })
})

test('claims of an ended team are cleared: a later team sees no stale claim or duplicate', async ($, on) => {
  const w = world(on)
  on('agent.spawn', ($, e) => ({ model: 'claude-opus-5-5', agentId: 'a-' + (e as { name: string }).name, teammateId: (e as { name: string }).name + '@s' }))
  await start($)
  for (const n of ['t1', 't2']) await $.agent.spawn({ prompt: 'Goal: g\nDeliverable: repo#155', name: n, isTeammate: true } as never)
  w.agents = ['t1', 't2'].map(n => ({ id: 'a-' + n, name: n, type: 'teammate', status: 'running', description: '', teammateId: n + '@s' }))
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
  const nudges = () => w.sends.filter(x => x.text.startsWith('[ASK] swarm quiet'))
  const stalls = () => w.submitted.filter(t => t.startsWith('swarm stalled'))
  await w.clock.advance(62_000)
  expect(nudges()).toEqual([{ to: 'a-t1', text: '[ASK] swarm quiet 1 min: you hold build #7; reported: t2 REVIEW, t3 DONE. Continue, or send [DONE]/[BLOCK].' }])
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
  expect(w.sends.filter(x => x.text.startsWith('[ASK] /wt/'))).toEqual([])
  w.agents = [{ id: 'a-t1', name: 't1', type: 'teammate', status: 'idle', description: '', teammateId: 't1@s' }]
  await w.clock.advance(12_000)
  expect(w.sends.filter(x => x.text.startsWith('[ASK] /wt/')).length).toBe(1)
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
  expect(w.sends.filter(x => x.text.startsWith('[ASK] swarm quiet')).length).toBe(1)
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
  const mine = w.sends.filter(x => x.text.startsWith('[ASK]'))
  expect(mine.map(x => x.to)).toEqual(['a-t1-3', 'a-t1-3'])
  expect(mine.map(x => x.text.split(':')[0])).toEqual(['[ASK] /wt/new.json changed', '[ASK] swarm quiet 1 min'])
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
  const asks = () => w.sends.filter(x => x.text.startsWith('[ASK] /wt/'))
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
  expect(asks().map(x => x.text)).toEqual([`[ASK] ${f} changed: run1`, `[ASK] ${f} changed: run2`])
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
  expect(own.map(l => [l.to, l.summary.split(':')[0]])).toEqual([['t1', '[ASK] /wt/out.json changed'], ['t1', '[ASK] swarm quiet 1 min']])
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
  const asks = () => w.sends.filter(x => x.text.startsWith('[ASK]'))
  await w.clock.advance(50_000)
  expect(asks()).toEqual([])
  await w.clock.advance(12_000)
  expect(asks()).toEqual([{ to: 'a-t1', text: `[ASK] ${at} reached: the time your [WAIT] named` }])
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
  expect(w.sends.filter(x => x.text.startsWith('[ASK] swarm quiet 12 min: you hold build #7')).length).toBe(1)
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
  expect(w.submitted.filter(t => t.startsWith('swarm: no builder claimed')).length).toBe(1)
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
  const at = new Date(1_000_000).toISOString().slice(11, 19)
  expect(w.sends.map(s => s.text)).toEqual([`#8 · ${at}\n[CLAIM] build docs/design.md`, '[DONE] notes', `#9 · ${at}\n[ASK] which part?`, 'from the mod', '[PROPOSE] to everyone'])
  await w.clock.advance(1100)
  const lines = w.appended.join('').trim().split('\n').map(l => JSON.parse(l))
  expect(lines.map(l => [l.summary, l.type, l.stamp])).toEqual([['[CLAIM] build docs/design.md', 'CLAIM', 8], ['[DONE] notes', 'DONE', undefined], ['[ASK] which part?', 'ASK', 9], ['from the mod', undefined, undefined], ['[PROPOSE] to everyone', 'PROPOSE', undefined]])
  expect(JSON.parse(w.writes.get(CWD + '/.swarm/roster.json') ?? '{}').stamp).toBe(9)
  await $.session.receive({ origin: peer('t1'), text: `#8 · ${at}\n[CLAIM] build docs/design.md`, agentId: 'a-t2' } as never)
  const roster = JSON.parse(w.writes.get(CWD + '/.swarm/roster.json') ?? '{}')
  expect(roster.claims.map((c: { key: string; by: string[] }) => [c.key, c.by])).toEqual([['build docs/design.md', ['t1']]])
})

test('a later claim on a held target gets an [ASK] from the mod, once, and is still recorded; a write to a file another teammate builds warns the writer and its holder, once per 2 min, and goes through', async ($, on) => {
  const w = world(on)
  on('agent.spawn', ($, e) => ({ model: 'claude-haiku', agentId: 'a-' + (e as { name: string }).name, teammateId: (e as { name: string }).name + '@s' }))
  await start($)
  for (const n of ['t1', 't2', 't3']) await $.agent.spawn({ prompt: 'p', name: n, isTeammate: true } as never)
  w.agents = ['t1', 't2', 't3'].map(n => ({ id: 'a-' + n, name: n, type: 'teammate', status: 'running', description: '', teammateId: n + '@s' }))
  await w.clock.advance(4100)
  await $.session.send({ to: 't2', text: '[PROPOSE] hello Atlas', agentId: 'a-t1' } as never)
  await $.session.send({ to: 't2', text: '[CLAIM] build docs/design.md', agentId: 'a-t1' } as never)
  await w.clock.advance(1000)
  const asks = () => w.sends.filter(s => s.text.startsWith('[ASK]'))
  expect(await $.session.send({ to: 't1', text: '[CLAIM] build design.md', agentId: 'a-t2' } as never)).toEqual({ isDelivered: true })
  await $.session.send({ to: 't3', text: '[CLAIM] build /work/docs/design.md', agentId: 'a-t2' } as never)
  await $.session.send({ to: 't1', text: '[CLAIM] review docs/design.md', agentId: 'a-t3' } as never)
  const at = new Date(1_004_100).toISOString().slice(11, 19)
  expect(asks()).toEqual([{ to: 'a-t2', text: `[ASK] design.md is already claimed by Atlas (t1, since ${at}, #2). Talk to them, split it, or pick another slice.` }])
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
    { to: 'a-t3', text: `[ASK] you wrote ${CWD}/docs/design.md, claimed by Atlas (t1). Settle it with them.` },
    { to: 'a-t1', text: `[ASK] t3 (t3) wrote ${CWD}/docs/design.md, which you claimed. Settle it with them.` },
  ]
  expect(asks()).toEqual(warned)
  await w.clock.advance(119_000)
  await $.tool.call({ tool: 'Edit', file_path: CWD + '/docs/design.md', old_string: 'x', new_string: 'y', agentId: 'a-t3' } as never)
  expect(asks()).toEqual(warned)
  await w.clock.advance(2_000)
  await $.tool.call({ tool: 'Edit', file_path: CWD + '/docs/design.md', old_string: 'x', new_string: 'y', agentId: 'a-t3' } as never)
  expect(asks()).toEqual([...warned, ...warned])
})

test('lead filter: an idle notice from a swarm the lead just stopped is held for a minute after it ended; later ones and other deliveries pass', async ($, on) => {
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
  await w.clock.advance(61_000)
  expect(await toLead(idle)).toEqual({ text: idle })
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
  expect(w.sends.filter(s => s.text.startsWith('[ASK]'))).toEqual([])
  const ui = await listPane($, { ...PANE, props: { ...PANE.props, bodyColumns: 100 } })
  expect(await ui.find({ type: 'Text', text: /build t1, t2$/ })).toBeDefined()
  await ui.unmount()
})

test('a reload keeps which later claimants were told a target is taken, and the holder\'s time and stamp from the log', async ($, on) => {
  const w = world(on)
  on('agent.spawn', ($, e) => ({ model: 'claude-haiku', agentId: 'a-' + (e as { name: string }).name, teammateId: (e as { name: string }).name + '@s' }))
  const session = 'session-abcdef01'
  const claim = (ts: number, from: string, stamp: number) => JSON.stringify({ ts, from, to: 'tx', summary: '[CLAIM] build notes.md', length: 22, type: 'CLAIM', via: 'send', session, stamp })
  w.files.set(CWD + '/.swarm/log.jsonl', [claim(900_000, 't1', 3), claim(901_000, 't2', 4)].join('\n') + '\n')
  w.files.set(CWD + '/.swarm/roster.json', JSON.stringify({ session, stamp: 4, askedTaken: ['t2 build notes.md'], claims: [{ role: 'build', target: 'notes.md', key: 'build notes.md', by: ['t1', 't2'] }], agents: [] }))
  await start($)
  for (const n of ['t1', 't2', 't3']) await $.agent.spawn({ prompt: 'p', name: n, isTeammate: true } as never)
  await $.session.send({ to: 't1', text: '[CLAIM] build notes.md', agentId: 'a-t2' } as never)
  await $.session.send({ to: 't1', text: '[CLAIM] build notes.md', agentId: 'a-t3' } as never)
  expect(w.sends.filter(s => s.text.startsWith('[ASK]'))).toEqual([{ to: 'a-t3', text: '[ASK] notes.md is already claimed by t1 (t1, since 00:15:00, #3). Talk to them, split it, or pick another slice.' }])
  await w.clock.advance(1100)
  expect(JSON.parse(w.writes.get(CWD + '/.swarm/roster.json') ?? '{}').askedTaken).toEqual(['t2 build notes.md', 't3 build notes.md'])
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
  expect(w.sends.filter(s => s.text.startsWith('[ASK]'))).toEqual([])
})

test('/swarmctl is a second name for /swarm: both are registered and /swarmctl status answers', async ($, on) => {
  const w = world(on)
  await start($)
  expect(w.commands).toEqual(['swarm', 'swarmctl'])
  const r = (await $.command.run({ command: 'swarmctl', args: 'status' } as never)) as { text: string }
  expect(r.text).toMatch(/^swarm: .* · quiet: on · /)
})

test('status line: ◇ swarm N live · M done (· K failed) while the team is a swarm, pinned only when it changes, cleared when the team ends', async ($, on) => {
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
  w.agents = rows({ t1: 'completed', t2: 'failed', t3: 'running' })
  await w.clock.advance(4_100)
  expect(w.statuses).toEqual(['◇ swarm 3 live · 0 done', '◇ swarm 1 live · 1 done · 1 failed'])
  w.agents = rows({ t1: 'completed', t2: 'failed', t3: 'killed' })
  await w.clock.advance(4_100)
  expect(w.statuses).toEqual(['◇ swarm 3 live · 0 done', '◇ swarm 1 live · 1 done · 1 failed', undefined])
})

test('stand-down toast: once, when a swarm\'s last teammate ends, with agents, messages, wall time and the lead\'s wakes and held deliveries; none for agents that never formed a swarm', async ($, on) => {
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
  await $.session.send({ to: 't1', text: '[CLAIM] build x.md', agentId: 'a-t2' } as never)
  await w.clock.advance(4_000)
  await $.session.receive({ origin: peer('t1'), text: '[PROPOSE] hello lead' } as never)
  await $.session.receive({ origin: peer('t2'), text: '[ASK] which file?' } as never)
  await w.clock.advance(12 * 60_000)
  expect(w.toasts).toEqual([])
  w.agents = rows(['t1', 't2'], 'completed')
  await w.clock.advance(4_100)
  await w.clock.advance(10_000)
  expect(w.toasts).toEqual(['swarm stood down: 2 agents · 4 messages · 12m · lead woken 1, held 1'])
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
  const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: 100 } } as never)
  expect(await rasterText(ui)).toMatch(/Finch t1 +1× +↑\d ↓\d.*\n.*Running npm test -- --…/)
  await w.clock.advance(2_100)
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
  await w.clock.advance(60 * 60_000)
  expect(await rasterText(ui)).toBe(cells)
  expect(JSON.parse(w.writes.get(CWD + '/.swarm/roster.json') ?? '{}').claims).toEqual([])
  await ui.unmount()
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
