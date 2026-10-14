import { describe, expect, test } from 'claude-code/testing'

import {
  COALESCE_MS,
  ClaimBoard,
  hydrateClaims,
  claimAlerts,
  commandHolder,
  claimLines,
  claimOf,
  deliverablesOf,
  fileOf,
  parseTasks,
  sameTarget,
  targetMatches,
  DIGEST_MS,
  MessageLog,
  Roster,
  WakePolicy,
  bandText,
  firstLine,
  helloName,
  hydrateLog,
  OTHER_AGENTS,
  paneRows,
  renameName,
  reviewOf,
  shortModel,
  workflowRunOf,
  isWaitDue,
  isHeldFromLead,
  stampLine,
  unstamped,
  waitPathOf,
  waitUntilOf,
  waitWakeText,
  idleNotice,
  isLeadAddress,
  isStalled,
  jsonl,
  mentionsLead,
  messageText,
  namesText,
  openTaskCount,
  typeOf,
} from '../hooks/core'
import { isTeammateName } from '../hooks/replay'

const T0 = 1_000_000

/** The pane's lines, each at most `cols` cells. */
function paneLines(...args: Parameters<typeof paneRows>): string[] {
  return paneRows(...args).map(r => r.text)
}

function msg(log: MessageLog, ts: number, from: string, to: string, text: string, via: 'send' | 'receive' | 'tool' = 'send') {
  return log.record({ ts, from, to, text, via })
}

describe('message log', () => {
  test('records from, to, first line, length and type', () => {
    const log = new MessageLog()
    const e = msg(log, T0, 'scout', 'builder', '\n[PROPOSE] split the parser\nbody line')
    expect(e).toEqual({ ts: T0, from: 'scout', to: 'builder', summary: '[PROPOSE] split the parser', length: 37, type: 'PROPOSE', via: 'send' })
    expect(log.total).toBe(1)
    expect(log.sent.get('scout')).toBe(1)
    expect(log.received.get('builder')).toBe(1)
    expect(log.lastAt).toBe(T0)
  })

  test('a receive that echoes a recent send is not logged twice', () => {
    const log = new MessageLog()
    msg(log, T0, 'scout', 'builder', '[ASK] which schema?')
    expect(msg(log, T0 + 50, 'scout', 'builder', '<teammate-message from="scout">[ASK] which schema?</teammate-message>', 'receive')).toBeUndefined()
    expect(log.total).toBe(1)
  })

  test('a receive with no matching send is logged', () => {
    const log = new MessageLog()
    msg(log, T0, 'scout', 'builder', 'one thing')
    expect(msg(log, T0 + 50, 'critic', 'team-lead', 'another thing', 'receive')).toBeDefined()
    expect(log.total).toBe(2)
  })

  test('a delivery taken long after its send is still its echo; one older than the last 200 sends is logged', () => {
    const log = new MessageLog()
    msg(log, T0, 'scout', 'builder', '[ASK] which schema?')
    expect(msg(log, T0 + 30 * 60_000, 'scout', 'builder', '[ASK] which schema?', 'receive')).toBeUndefined()
    for (let i = 0; i < 200; i++) msg(log, T0 + i, 'a', 'b', 'm' + i)
    expect(msg(log, T0 + 31 * 60_000, 'scout', 'builder', '[ASK] which schema?', 'receive')).toBeDefined()
  })

  test('memory keeps the newest 500, the count keeps everything', () => {
    const log = new MessageLog()
    for (let i = 0; i < 520; i++) msg(log, T0 + i * 20_000, 'a', 'b', 'm' + i)
    expect(log.entries.length).toBe(500)
    expect(log.total).toBe(520)
    expect(log.entries[0]?.summary).toBe('m20')
  })

  test('jsonl writes one JSON object per line', () => {
    const log = new MessageLog()
    msg(log, T0, 'a', 'b', 'x')
    msg(log, T0 + 1, 'b', 'a', 'y')
    const lines = jsonl(log.entries).trim().split('\n').map(l => JSON.parse(l))
    expect(lines.map(l => l.summary)).toEqual(['x', 'y'])
    expect(jsonl([])).toBe('')
  })

  test('helpers: first line, type tag, mention, lead address, protocol message', () => {
    expect(firstLine('a'.repeat(200)).length).toBe(160)
    expect(typeOf('[block] no')).toBe('BLOCK')
    expect(typeOf('BLOCK no')).toBeUndefined()
    expect(mentionsLead('tie here, @orchestrator please')).toBe(true)
    expect(mentionsLead('mail@lead.com')).toBe(false)
    expect(isLeadAddress('team-lead@session-1234')).toBe(true)
    expect(isLeadAddress('main')).toBe(true)
    expect(isLeadAddress('builder')).toBe(false)
    expect(messageText({ type: 'shutdown_request' })).toBe('[shutdown_request]')
  })
})

describe('roster', () => {
  test('spawn captures name, model and teammate flag; list merges status', () => {
    const r = new Roster()
    r.spawned({ name: 'scout', model: 'haiku', subagentType: 'teammate', isTeammate: true }, { agentId: 'a1', model: 'claude-haiku', teammateId: 'scout@s' })
    expect(r.agents.get('a1')).toMatchObject({ name: 'scout', model: 'claude-haiku', isTeammate: true, status: 'pending', teammateId: 'scout@s' })
    expect(r.merge([{ id: 'a1', name: 'scout', type: 'teammate', status: 'running', description: 'd' }])).toBe(true)
    expect(r.merge([{ id: 'a1', name: 'scout', type: 'teammate', status: 'running', description: 'd' }])).toBe(false)
    expect(r.agents.get('a1')?.status).toBe('running')
    expect(r.agents.get('a1')?.model).toBe('claude-haiku')
    expect(r.activeCount()).toBe(1)
  })

  test('a denied spawn records nothing; unknown ids fall back to a short id', () => {
    const r = new Roster()
    expect(r.spawned({ name: 'x' }, {})).toBeUndefined()
    expect(r.nameOf(undefined)).toBe('team-lead')
    expect(r.nameOf('abcdef0123456')).toBe('abcdef01')
  })

  test('roster.json lists the lead and the agents', () => {
    const r = new Roster()
    r.merge([{ id: 'a2', name: 'critic', type: 'teammate', status: 'idle', description: '' }])
    const json = r.toJSON(T0)
    expect(json.lead).toEqual({ name: 'team-lead', status: 'idle' })
    expect(json.agents.map(a => a.name)).toEqual(['critic'])
    expect(r.liveCount()).toBe(1)
    expect(r.activeCount()).toBe(0)
  })
})

describe('code names', () => {
  test('helloName reads `[PROPOSE] hello <Name>` on the first line only', () => {
    expect(helloName('[PROPOSE] hello Atlas\nbody')).toBe('Atlas')
    expect(helloName('\n[propose] Hello Sage (Sonnet 5.5; strengths: …)')).toBe('Sage')
    expect(helloName('<teammate-message from="t3">[PROPOSE] hello Quill</teammate-message>')).toBe('Quill')
    expect(helloName('[PROPOSE] roles resolved\n[PROPOSE] hello Atlas')).toBeUndefined()
    expect(helloName('[ASK] hello Atlas')).toBeUndefined()
  })

  test('an announcement labels the sender as `Atlas (t1)` in roster.json, the pane and the names line', () => {
    const r = new Roster()
    const log = new MessageLog()
    r.spawned({ name: 't1', isTeammate: true }, { agentId: 'a1' })
    r.spawned({ name: 't2', isTeammate: true }, { agentId: 'a2' })
    expect(r.announce('t1', '[PROPOSE] hello Atlas\nstrengths')).toBe(true)
    expect(r.announce('t1', '[PROPOSE] hello Atlas')).toBe(false)
    expect(r.announce('team-lead', '[PROPOSE] hello Boss')).toBe(false)
    expect(r.label('t1')).toBe('Atlas (t1)')
    expect(r.label('t2')).toBe('t2')
    expect(r.resolve('atlas')).toBe('t1')
    expect(r.toJSON(T0).agents[0]).toMatchObject({ name: 't1', codeName: 'Atlas', label: 'Atlas (t1)' })
    expect(r.toJSON(T0).agents[1]).not.toHaveProperty('codeName')
    expect(namesText(r, ['t1', 't2'])).toBe('Atlas (t1)')
    expect(namesText(r, ['t2'])).toBe('')
    msg(log, T0, 't1', 't2', '[PROPOSE] hello Atlas')
    const lines = paneLines(r, log, new WakePolicy(), T0, 80, 10)
    expect(lines.some(l => /^. Atlas \(t1\)\s/.test(l))).toBe(true)
    expect(lines.some(l => l.includes('Atlas (t1) → t2: [PROPOSE] hello Atlas'))).toBe(true)
  })
})

describe('wake policy', () => {
  function entry(log: MessageLog, ts: number, from: string, to: string, text: string) {
    const e = msg(log, ts, from, to, text)
    if (!e) throw new Error('not logged')
    return e
  }

  test('all: a burst inside the window becomes one wake', () => {
    const log = new MessageLog()
    const p = new WakePolicy()
    p.setMode('all', T0)
    expect(p.offer(entry(log, T0, 'scout', 'builder', 'one'), 'one')).toBe(true)
    expect(p.offer(entry(log, T0 + 4000, 'builder', 'scout', 'two'), 'two')).toBe(true)
    expect(p.due(T0 + COALESCE_MS.all - 1, false)).toBeNull()
    const text = p.due(T0 + COALESCE_MS.all, false)
    expect(text).toMatch(/2 new message/)
    expect(text).toContain('scout → builder: one')
    expect(text).toContain('builder → scout: two')
    expect(p.due(T0 + COALESCE_MS.all + 1, false)).toBeNull()
  })

  test('messages to the lead or from it never wake: the mailbox already delivers them', () => {
    const log = new MessageLog()
    const p = new WakePolicy()
    p.setMode('all', T0)
    expect(p.offer(entry(log, T0, 'scout', 'team-lead', 'hi'), 'hi')).toBe(false)
    expect(p.offer(entry(log, T0, 'team-lead', 'scout', 'go'), 'go')).toBe(false)
    expect(p.pending).toEqual([])
  })

  test('mentions: only peer messages naming @lead or @orchestrator', () => {
    const log = new MessageLog()
    const p = new WakePolicy()
    p.setMode('mentions', T0)
    expect(p.offer(entry(log, T0, 'scout', 'builder', 'plain'), 'plain')).toBe(false)
    expect(p.offer(entry(log, T0, 'scout', 'builder', 'tie, @lead decide'), 'tie, @lead decide')).toBe(true)
    expect(p.due(T0 + COALESCE_MS.mentions, false)).toMatch(/mention you/)
  })

  test('digest: one wake per period, none when nothing is new', () => {
    const log = new MessageLog()
    const p = new WakePolicy()
    p.setMode('digest', T0)
    p.offer(entry(log, T0 + 1000, 'a', 'b', 'x'), 'x')
    p.offer(entry(log, T0 + 2000, 'b', 'a', 'y'), 'y')
    expect(p.due(T0 + DIGEST_MS - 1, false)).toBeNull()
    expect(p.due(T0 + DIGEST_MS, false)).toMatch(/digest\): 2 new/)
    expect(p.due(T0 + 2 * DIGEST_MS, false)).toBeNull()
  })

  test('off queues nothing; a busy lead or an in-flight wake holds the queue', () => {
    const log = new MessageLog()
    const p = new WakePolicy()
    p.setMode('off', T0)
    expect(p.offer(entry(log, T0, 'a', 'b', 'x'), 'x')).toBe(false)
    p.setMode('all', T0)
    p.offer(entry(log, T0, 'a', 'b', 'x'), 'x')
    expect(p.due(T0 + 60_000, true)).toBeNull()
    p.inFlight = true
    expect(p.due(T0 + 60_000, false)).toBeNull()
    p.inFlight = false
    expect(p.due(T0 + 60_000, false)).toMatch(/1 new message/)
  })
})

describe('stall watchdog', () => {
  const base = { now: T0 + 6 * 60_000, lastActivityAt: T0, stallMs: 5 * 60_000, activeAgents: 0, liveAgents: 2, openTasks: 3, leadBusy: false, alreadyFired: false }

  test('fires when quiet, nobody running and tasks remain', () => {
    expect(isStalled(base)).toBe(true)
  })

  test('holds for activity, a running agent, a busy lead, no open tasks, or once fired', () => {
    expect(isStalled({ ...base, now: T0 + 60_000 })).toBe(false)
    expect(isStalled({ ...base, activeAgents: 1 })).toBe(false)
    expect(isStalled({ ...base, leadBusy: true })).toBe(false)
    expect(isStalled({ ...base, openTasks: 0 })).toBe(false)
    expect(isStalled({ ...base, alreadyFired: true })).toBe(false)
    expect(isStalled({ ...base, openTasks: null })).toBe(true)
    expect(isStalled({ ...base, openTasks: null, liveAgents: 0 })).toBe(false)
  })

  test('task files count as open unless completed', () => {
    expect(openTaskCount(['{"status":"completed"}', '{"status":"in_progress"}', '{"status":"pending"}', 'not json'])).toBe(3)
  })
})

describe('pane text', () => {
  test('fits every line to the body width and shows roster, counts and messages', () => {
    const r = new Roster()
    const log = new MessageLog()
    const p = new WakePolicy()
    r.spawned({ name: 'a-very-long-teammate-name', model: 'sonnet', isTeammate: true }, { agentId: 'a1', model: 'sonnet' })
    msg(log, T0, 'a-very-long-teammate-name', 'builder', '[REVIEW] ' + 'x'.repeat(200))
    const lines = paneLines(r, log, p, T0 + 8000, 40, 10)
    expect(lines.filter(l => l.length > 40)).toEqual([])
    expect(lines[0]).toMatch(/^swarm: 1 agent · 1 msg · last 8s/)
    expect(lines.some(l => l.includes('team-lead'))).toBe(true)
    expect(paneLines(r, log, p, T0 + 8000, 80, 10).some(l => l.includes('→ builder: [REVIEW]'))).toBe(true)
  })

  test('band reads agents, messages and time since the last one', () => {
    const r = new Roster()
    const log = new MessageLog()
    expect(bandText(r, log, T0)).toBe('swarm: 0 agents · 0 msgs · last —')
    msg(log, T0, 'a', 'b', 'x')
    expect(bandText(r, log, T0 + 125_000)).toBe('swarm: 0 agents · 1 msg · last 2m')
  })
})

describe('claims', () => {
  test('claimOf reads role and target from the first line', () => {
    expect(claimOf('[CLAIM] build var/swarm-test/gaps.md\nbody')).toEqual({ role: 'build', target: 'var/swarm-test/gaps.md' })
    expect(claimOf('[claim] Builder of `gaps.md`.')).toEqual({ role: 'build', target: 'gaps.md' })
    expect(claimOf('[CLAIM] research group A (capture-*)')).toEqual({ role: 'research', target: 'group a (capture-*)' })
    expect(claimOf('[CLAIM] the parser')).toBeUndefined()
    expect(claimOf('Slice: [CLAIM] came first, so w2 takes another slice')).toBeUndefined()
    expect(claimOf('[CLAIM] Review #7')).toEqual({ role: 'review', target: '#7' })
    expect(claimOf('[PROPOSE] t1 builds gaps.md')).toBeUndefined()
  })

  test('a claim whose target is a sentence fragment is no claim: judged on the target token, a quoted or bracketed one unwrapped', () => {
    expect(claimOf('[CLAIM] build (they missed yours). please confirm to w4 that you keep it')).toBeUndefined()
    expect(claimOf('[CLAIM] build out/findings.md" before your claim')).toBeUndefined()
    expect(claimOf('[CLAIM] please take the parser')).toBeUndefined()
    expect(claimOf('[CLAIM] build "docs/x.md"')).toEqual({ role: 'build', target: 'docs/x.md' })
    expect(claimOf('[CLAIM] build docs/x.md, reviewers please hold')).toEqual({ role: 'build', target: 'docs/x.md, reviewers please hold' })
    expect(claimOf('[CLAIM] build (docs/x.md)')).toEqual({ role: 'build', target: '(docs/x.md)' })
    expect(claimOf('[CLAIM] build #155 (hydration fix)')).toEqual({ role: 'build', target: '#155 (hydration fix)' })
  })

  test('a file tool call shows as a mark and the path from the working directory', () => {
    expect(fileOf('Edit', { file_path: '/work/hooks/core.ts' }, '/work')).toBe('✎ hooks/core.ts')
    expect(fileOf('Write', { file_path: '/work/a.md' }, '/work')).toBe('✎ a.md')
    expect(fileOf('NotebookEdit', { notebook_path: '/work/n.ipynb' }, '/work')).toBe('✎ n.ipynb')
    expect(fileOf('Read', { file_path: '/work/README.md' }, '/work')).toBe('◦ README.md')
    expect(fileOf('Read', { file_path: '/elsewhere/deep/dir/x.ts' }, '/work')).toBe('◦ …/dir/x.ts')
    expect(fileOf('Bash', { command: 'ls' }, '/work')).toBeUndefined()
    expect(fileOf('Edit', {}, '/work')).toBeUndefined()
  })

  test('deliverables come from `Deliverable:` lines of a brief', () => {
    expect(deliverablesOf('Goal: x\n- **Deliverable**: `var/gaps.md`\nDone when: y')).toEqual(['var/gaps.md'])
    expect(deliverablesOf('Deliverables: a.md, b.md; a.md')).toEqual(['a.md', 'b.md'])
    expect(deliverablesOf('no brief here')).toEqual([])
  })

  test('a build claim names a deliverable by path or file name', () => {
    expect(targetMatches('gaps.md', 'var/swarm-test/gaps.md')).toBe(true)
    expect(targetMatches('var/swarm-test/gaps.md (merge)', 'gaps.md')).toBe(true)
    expect(targetMatches('', 'gaps.md')).toBe(true)
    expect(targetMatches('a', 'gaps.md')).toBe(false)
    expect(targetMatches('report.md', 'gaps.md')).toBe(false)
  })

  test('board: duplicates, missing builders, task owners and unclaimed tasks', () => {
    const b = new ClaimBoard()
    expect(b.missingBuilders()).toEqual(['the deliverable'])
    b.addDeliverables(['var/gaps.md'])
    expect(b.missingBuilders()).toEqual(['var/gaps.md'])
    expect(b.claim('t3', { role: 'research', target: 'group a' })).toBe(true)
    expect(b.claim('t3', { role: 'research', target: 'group a' })).toBe(false)
    b.claim('t1', { role: 'build', target: 'gaps.md' })
    expect(b.missingBuilders()).toEqual([])
    b.setTasks([
      { subject: 'Build gaps.md', owner: 'Quill', status: 'in_progress' },
      { subject: 'Review gaps.md', status: 'pending' },
      { subject: 'old', status: 'deleted', owner: 'x' },
    ], o => (o === 'Quill' ? 't3' : o))
    expect(b.duplicates().map(c => [c.key, c.by])).toEqual([['build var/gaps.md', ['t1', 't3']]])
    expect(b.unclaimedTasks).toEqual(['Review gaps.md'])
    expect([...b.claimants()].sort()).toEqual(['t1', 't3'])
    const lines = claimLines(b, n => n.toUpperCase())
    expect(lines).toContain('var/gaps.md · build T1, T3 ⚠ duplicate')
    expect(lines).toContain('group a · research T3')
    expect(lines).toContain('task Review gaps.md · unclaimed')
  })

  test('task files: subject/title, owner/assignee, malformed files skipped', () => {
    expect(parseTasks(['{"subject":"a","owner":"t1","status":"in_progress"}', '{"title":"b","assignee":" "}', 'x'])).toEqual([
      { subject: 'a', owner: 't1', status: 'in_progress' },
      { subject: 'b', owner: undefined, status: 'pending' },
    ])
  })

  test('watchdog: a [DONE] or [HANDOFF] with no builder, or 2+ unclaimed workers after N minutes', () => {
    const workers = [{ label: 'Atlas (t1)', startedAt: T0 }, { label: 'Sage (t2)', startedAt: T0 }]
    const base = { now: T0 + 60_000, claimMs: 3 * 60_000, sawDoneOrHandoff: false, missingBuilders: ['gaps.md'], unclaimedWorkers: workers }
    expect(claimAlerts(base)).toEqual([])
    expect(claimAlerts({ ...base, sawDoneOrHandoff: true })).toEqual([{ key: 'no-builder gaps.md', text: 'swarm: no builder claimed for gaps.md' }])
    expect(claimAlerts({ ...base, now: T0 + 3 * 60_000 }).map(a => a.key)).toEqual(['no-builder gaps.md', 'unclaimed-work'])
    expect(claimAlerts({ ...base, now: T0 + 3 * 60_000, unclaimedWorkers: workers.slice(0, 1) })).toEqual([])
    expect(claimAlerts({ ...base, sawDoneOrHandoff: true, missingBuilders: [] })).toEqual([])
    expect(claimAlerts({ ...base, sawDoneOrHandoff: true, claimMs: 0 })).toEqual([])
  })
})

describe('idle notifications', () => {
  test('idleNotice reads the JSON body; anything else is not one', () => {
    const body = '{"type":"idle_notification","from":"t3","timestamp":"2026-10-12T13:03:29.356Z","idleReason":"available","summary":"[to t2] [HANDOFF] x"}'
    expect(idleNotice(body)).toEqual({ from: 't3', idleReason: 'available' })
    expect(idleNotice('<teammate-message>' + body + '</teammate-message>')).toEqual({ from: 't3', idleReason: 'available' })
    expect(idleNotice('[DONE] mentions idle_notification in prose')).toBeUndefined()
    expect(idleNotice('{"type":"shutdown_request","note":"idle_notification"}')).toBeUndefined()
  })

  test('the pane counts them per agent and shows a reason other than available', () => {
    const r = new Roster()
    r.spawned({ name: 't1', isTeammate: true }, { agentId: 'a1' })
    r.noteIdle('t1', 'available')
    r.noteIdle('t1@session-1', 'failed')
    const lines = paneLines(r, new MessageLog(), new WakePolicy(), T0, 80, 10)
    expect(lines.some(l => /t1 .*0\/0 · waits 2 \(failed\)$/.test(l))).toBe(true)
    expect(r.toJSON(T0).agents[0]).toMatchObject({ idleNotices: 2, lastIdleReason: 'failed' })
  })
})

const CLASH_TO_T2 = '[PROPOSE] name clash + review rotation\nBoth t2 and t3 said "kestrel"; I (t3) rename to kite. Probe: not using it, go ahead. Rotation: take t2\'s: t2 reviews #158, t1 (ridge) reviews #141, t3 (kite) reviews #155. Builders unchanged: ridge #158, t2 #155, kite #141.'
const CLASH_TO_T1 = '[PROPOSE] name clash + review rotation\nI (t3) rename to kite (t2 also picked kestrel). Rotation: t2\'s version, so ridge reviews #141 (mine), t2 reviews #158, kite reviews #155. OK?'

function team() {
  const r = new Roster()
  for (const n of ['t1', 't2', 't3']) r.spawned({ name: n, model: 'claude-opus-5-5[1m]', isTeammate: true }, { agentId: 'a' + n, teammateId: n + '@session-6036d038' }, T0)
  return r
}

describe('roster display', () => {
  test('models show family and version, never cut', () => {
    expect(shortModel('claude-opus-5-5[1m]')).toBe('opus 5.5')
    expect(shortModel('claude-opus-5-5')).toBe('opus 5.5')
    expect(shortModel('claude-sonnet-5-5')).toBe('sonnet 5.5')
    expect(shortModel('claude-haiku-5-5')).toBe('haiku 5.5')
    expect(shortModel('claude-fable-5-1')).toBe('fable 5.1')
    expect(shortModel('claude-3-5-sonnet-20241022')).toBe('sonnet 3.5')
    expect(shortModel('claude-haiku')).toBe('haiku')
    expect(shortModel(undefined)).toBe('–')
    const r = team()
    const lines = paneLines(r, new MessageLog(), new WakePolicy(), T0, 60, 10)
    expect(lines.filter(l => /\bt[123]\)?\s/.test(l) && l.includes('opus 5.5')).length).toBe(3)
    expect(lines.some(l => l.includes('claude-op'))).toBe(false)
  })

  test('renames: the live wording renames t3; prose that only mentions a name does not', () => {
    expect(renameName(CLASH_TO_T2)).toBe('kite')
    expect(renameName(CLASH_TO_T1)).toBe('kite')
    expect(renameName('[PROPOSE] renamed Kite')).toBe('Kite')
    expect(renameName('ok (renamed kite), building #141')).toBe('kite')
    expect(renameName('t3 here (now Kite)')).toBe('Kite')
    expect(renameName('call me Kite from now on')).toBe('Kite')
    expect(renameName('I am Kite.')).toBe('Kite')
    expect(renameName('I am now Kite.')).toBe('Kite')
    expect(renameName('[PROPOSE] ack: you build gaps.md. I now research chat-research + copy-publisher')).toBeUndefined()
    expect(renameName('[REVIEW] #158 approve (stands, now with live evidence) — shot confirms 7 board boxes')).toBeUndefined()
    expect(renameName("[REVIEW] #155 ack — ridge reviews #155; I told kite to stay on #141 and I'll review #141 instead.")).toBeUndefined()
    expect(renameName('[REVIEW] request #155 — rotation confirmed: kite reviews #155')).toBeUndefined()
    expect(renameName('I am idle, I am not blocked')).toBeUndefined()
  })

  test('a later message renames; a late delivery of an old hello does not revert it; duplicates are flagged with casing kept', () => {
    const r = team()
    r.announce('t1', '[PROPOSE] hello ridge\nOpus.', 'send')
    r.announce('t2', '[PROPOSE] hello Kestrel (t2)\nOpus.', 'send')
    r.announce('t3', '[PROPOSE] hello kestrel\nOpus 5.5.', 'send')
    expect([r.label('t2'), r.label('t3')]).toEqual(['Kestrel (t2)', 'kestrel (t3)'])
    expect([...r.duplicateCodes()].sort()).toEqual(['t2', 't3'])
    let lines = paneLines(r, new MessageLog(), new WakePolicy(), T0, 80, 10)
    expect(lines.filter(l => l.includes('⚠ dup')).map(l => l.slice(2, 20).trim())).toEqual(['Kestrel (t2) ⚠ dup', 'kestrel (t3) ⚠ dup'])
    expect(r.announce('t3', CLASH_TO_T2, 'send')).toBe(true)
    expect(r.announce('t3', '[PROPOSE] hello kestrel\nOpus 5.5.', 'receive')).toBe(false)
    expect(r.label('t3')).toBe('kite (t3)')
    expect(r.duplicateCodes().size).toBe(0)
    lines = paneLines(r, new MessageLog(), new WakePolicy(), T0, 80, 10)
    expect(lines.some(l => l.includes('⚠ dup'))).toBe(false)
    expect(lines.some(l => /^. kite \(t3\)\s/.test(l))).toBe(true)
    expect(r.announce('t3', '[PROPOSE] hello Kite', 'send')).toBe(true)
    expect(r.label('t3')).toBe('Kite (t3)')
  })

  test('the wait counter reads `waits N · <age> ago`, and a reload does not double it', () => {
    const r = team()
    for (let i = 0; i < 5; i++) r.noteIdle('t1', 'available', T0 + i * 1000)
    const lines = paneLines(r, new MessageLog(), new WakePolicy(), T0 + 4000 + 40_000, 80, 10)
    expect(lines.some(l => /t1\).*0\/0 · waits 5 · 40s ago$/.test(l) || /t1 .*0\/0 · waits 5 · 40s ago$/.test(l))).toBe(true)
    expect(lines.some(l => /\bidle \d/.test(l))).toBe(false)
    const reloaded = new Roster()
    reloaded.hydrate(r.toJSON(T0, 'session-x'), 'session-x')
    const idleLine = (ts: number) => ({ ts, from: 't1', to: 'team-lead', summary: '{"type":"idle_notification"}', length: 1, via: 'receive' as const, type: 'IDLE', session: 'session-x' })
    hydrateLog(new MessageLog(), reloaded, [0, 1, 2, 3, 4].map(i => idleLine(T0 + i * 1000)), 'session-x')
    expect(reloaded.idle.get('t1')).toMatchObject({ count: 5, lastAt: T0 + 4000 })
  })

  test('agents outside the current team, ended, or pending over 10 min, show dimmed under other agents after the active teammates', () => {
    const r = new Roster()
    r.spawned({ name: 'integrate', model: 'claude-opus-5-5[1m]', subagentType: 'workflow-subagent' }, { agentId: 'w1' }, T0)
    r.spawned({ description: 'delta:report-export-timeout:r1', model: 'claude-sonnet-5-5' }, { agentId: 'a4c7f2b93cb6dac5c' }, T0)
    for (const n of ['t1', 't2', 't3']) r.spawned({ name: n, isTeammate: true }, { agentId: 'a' + n, teammateId: n + '@session-6036d038' }, T0)
    r.spawned({ name: 't4', isTeammate: true }, { agentId: 'at4', teammateId: 't4@session-6036d038' }, T0)
    r.merge([{ id: 'at4', name: 't4', type: 'teammate', status: 'completed', description: '' }], T0 + 1000)
    r.merge([{ id: 'at1', name: 't1', type: 'teammate', status: 'running', description: '' }], T0 + 1000)
    const at = (now: number) => paneRows(r, new MessageLog(), new WakePolicy(), now, 80, 10)
    const names = (rows: ReturnType<typeof at>) => {
      const sep = rows.findIndex(x => x.text === OTHER_AGENTS)
      const end = rows.findIndex((x, i) => i > sep && x.text === '')
      return { active: rows.slice(3, sep).map(x => x.text.slice(2).split(' ')[0]), other: rows.slice(sep + 1, end).map(x => [x.text.slice(2).split(/\s/)[0], x.dim]) }
    }
    expect(names(at(T0 + 60_000))).toEqual({ active: ['team-lead', 't1', 't2', 't3'], other: [['workflow', true], ['delta:report-export-tim…', true], ['t4', true]] })
    const late = names(at(T0 + 11 * 60_000))
    expect(late.active).toEqual(['team-lead', 't1'])
    expect(late.other.map(o => o[0])).toEqual(['workflow', 'delta:report-export-tim…', 't2', 't3', 't4'])
  })

  test('messages run newest first; a previous session follows under earlier at the bottom', () => {
    const r = team()
    const log = new MessageLog()
    log.earlier.push({ ts: T0 - 5000, from: 'x', to: 'y', summary: 'old one', length: 1, via: 'send' })
    msg(log, T0, 't1', 't2', 'first')
    msg(log, T0 + 20_000, 't2', 't1', 'second')
    msg(log, T0 + 40_000, 't3', 't1', 'newest')
    const rows = paneRows(r, log, new WakePolicy(), T0 + 50_000, 80, 10)
    const head = rows.findIndex(x => x.text.startsWith('MESSAGES'))
    expect(rows[head + 1]?.text).toMatch(/t3 → t1: newest$/)
    expect(rows.slice(head + 1).map(x => x.text.split(': ').pop())).toEqual(['newest', 'second', 'first', '── earlier ──', 'old one'])
    expect(rows[rows.length - 1]?.dim).toBe(true)
  })
})

describe('claim watchdog timing and live claims', () => {
  test('unclaimed work counts from each teammate\'s own start', () => {
    const workers = [{ label: 'ridge (t1)', startedAt: T0 }, { label: 'Kestrel (t2)', startedAt: T0 }, { label: 'kite (t3)', startedAt: T0 }]
    const base = { claimMs: 3 * 60_000, sawDoneOrHandoff: false, missingBuilders: [], unclaimedWorkers: workers }
    expect(claimAlerts({ ...base, now: T0 + 22_000 })).toEqual([])
    expect(claimAlerts({ ...base, now: T0 + 3 * 60_000 }).map(a => a.text)).toEqual(['swarm: 3 teammates working without a [CLAIM]: ridge (t1), Kestrel (t2), kite (t3)'])
    expect(claimAlerts({ ...base, now: T0 + 3 * 60_000, unclaimedWorkers: [workers[0]!, { label: 'kite (t3)', startedAt: T0 + 60_000 }] })).toEqual([])
    expect(claimAlerts({ ...base, now: T0 + 3 * 60_000, unclaimedWorkers: [workers[0]!, { label: 'x', startedAt: undefined }] })).toEqual([])
  })

  test('the live claims cover the live deliverables', () => {
    const hello = '[PROPOSE] hello ridge\nOpus. Strengths: frontend layout/geometry math, test pins.\nSlice wanted: [CLAIM] build #158 (chart label fit). Suggest t2 -> #155, t3 -> #141'
    expect(claimOf(hello)).toMatchObject({ role: 'build' })
    expect(claimOf(hello)?.target.startsWith('#158 (chart label fit)')).toBe(true)
    expect(targetMatches('#155 (cache bug #418 on /search). kestrel', 'repo#155')).toBe(true)
    expect(targetMatches('#141', 'repo#141')).toBe(true)
    expect(targetMatches('#14', 'repo#141')).toBe(false)
    expect(targetMatches('#1555', 'repo#155')).toBe(false)
    const b = new ClaimBoard()
    b.addDeliverables(['repo#158', 'repo#155', 'repo#141'])
    b.claim('t2', claimOf('[CLAIM] build #155 (cache bug #418 on /search). Kestrel.')!)
    b.claim('t3', claimOf('[CLAIM] build #141')!)
    expect(b.missingBuilders()).toEqual(['repo#158'])
    b.claim('t1', claimOf(hello)!)
    expect(b.missingBuilders()).toEqual([])
    expect(claimOf("[CLAIM] final gate — ack, you review #141. ridge runs the full gate after #141's approve")).toBeUndefined()
    expect(claimOf('[CLAIM] probe — ridge takes the probe now (~8 min)')).toBeUndefined()
  })
})

describe('claims view (live wording)', () => {
  test('one line per deliverable with builder, reviewer and verdict; one other line with each teammate\'s latest', () => {
    const r = team()
    r.announce('t1', '[PROPOSE] hello ridge')
    r.announce('t2', '[PROPOSE] hello Kestrel (t2)')
    r.announce('t3', '[PROPOSE] hello kite')
    const b = new ClaimBoard()
    b.addDeliverables(['repo#158', 'repo#155', 'repo#141'])
    const send = (by: string, text: string) => {
      const ref = claimOf(text)
      if (ref) b.claim(by, ref)
      const v = reviewOf(text)
      if (v) b.review(by, v)
    }
    send('t2', '[CLAIM] build #155 (cache bug #418 on /search). Kestrel.')
    send('t3', '[CLAIM] build #141')
    send('t1', '[PROPOSE] hello ridge\nOpus.\nSlice wanted: [CLAIM] build #158 (chart label fit). Suggest t2 -> #155, t3 -> #141')
    send('t1', '[CLAIM] probe + commit #158')
    send('t1', '[REVIEW] request #158')
    send('t2', '[CLAIM] commit #155 — Kestrel commits now (git commit --only on src/ui/kit.ts + test/kit.test.ts; your staged/unstaged files untouched).')
    send('t2', '[CLAIM] commit #155 — Kestrel commits now (git commit --only on src/ui/kit.ts; your files incl. report.test.ts untouched).')
    send('t1', '[CLAIM] probe — ridge takes the probe now (~8 min) for the live #158 staging check; will announce stop.')
    send('t2', '[CLAIM] review #158 — Kestrel reviews 1a2b3c4d now. #155 committed 5e6f7a8b (commit lock released)')
    send('t2', '[REVIEW] #158 approve — 1a2b3c4d (Kestrel)')
    send('t1', '[CLAIM] probe released — ridge stopped the probe. Ready to review #141 when you send it.')
    send('t1', "[CLAIM] review #155 — ridge reviews 5e6f7a8b now (I'm idle, you're building #141).")
    send('t1', '[REVIEW] #155 approve — 5e6f7a8b (ridge)')
    send('t1', "[CLAIM] final gate — ack, you review #141. ridge runs the full gate after #141's approve and sends [DONE]")
    expect(claimLines(b, n => r.label(n))).toEqual([
      '#158 · build ridge (t1) · review Kestrel (t2) ✓approve',
      '#155 · build Kestrel (t2) · review ridge (t1) ✓approve',
      '#141 · build kite (t3)',
    ])
    expect(b.duplicates()).toEqual([])
    expect(reviewOf('[BLOCK] #141 timeout still flaky under load')).toEqual({ slice: '#141', state: 'block' })
    expect(reviewOf('[REVIEW] request #155 — rotation confirmed')).toBeUndefined()
    expect(claimOf('[CLAIM] probe — ridge takes the probe')).toBeUndefined()
    b.review('t3', reviewOf('[BLOCK] #141: permission denials stop the investigation (kite/t3)')!)
    b.review('t2', reviewOf('[REVIEW] #141 approve as a not-reproduced finding (Kestrel)')!)
    expect(claimLines(b, n => r.label(n))[2]).toBe('#141 · build kite (t3) ✗block · review Kestrel (t2) ✓approve')
  })
})

describe('workflow agents', () => {
  const RUN = 'wf_bc5e3b69-3d9'
  const STEPS = ['decompose', 'setup-worktrees', 'impl:chart-label-fit', 'impl:search-cache-418', 'lens:correctness', 'lens:test-integrity',
    'fix:chart-label-fit:r1', 'delta:chart-label-fit:r1', 'lens:correctness', 'lens:test-integrity', 'impl:report-timeout',
    'lens:correctness', 'lens:test-integrity', 'fix:report-timeout:r1', 'delta:report-timeout:r1', 'integrate']

  test('a run\'s agents collapse to one line, done (✓) once each turn completed, dimmed under other agents', () => {
    const r = team()
    STEPS.forEach((d, i) => r.spawned({ description: d, subagentType: 'workflow-subagent', model: 'claude-sonnet-5-5', workflow: { runId: RUN } }, { agentId: 'wf' + i }, T0))
    r.workflowNames.set(RUN, 'dev-team')
    let rows = paneRows(r, new MessageLog(), new WakePolicy(), T0 + 1000, 80, 10)
    expect(rows.some(x => /impl:|lens:/.test(x.text))).toBe(false)
    expect(rows.find(x => x.text.includes('workflow'))?.text).toBe('● workflow dev-team · 16 agents · 0 running · 16 pending')
    STEPS.forEach((_, i) => r.settle('wf' + i, T0 + 2000))
    expect(r.settle('at1', T0)).toBe(false)
    rows = paneRows(r, new MessageLog(), new WakePolicy(), T0 + 3000, 80, 10)
    const sep = rows.findIndex(x => x.text === OTHER_AGENTS)
    const line = rows.findIndex(x => x.text === '✓ workflow dev-team · 16 agents')
    expect(sep).toBeGreaterThan(0)
    expect(line).toBeGreaterThan(sep)
    expect(rows[line]?.dim).toBe(true)
    expect(r.activeCount()).toBe(3)
  })

  test('a reload settles workflow agents left pending; an agent the list stops reporting has ended', () => {
    const r = new Roster()
    r.hydrate({ session: 's', agents: [
      { id: 'a96a4a28d14d1b368', name: 'a96a4a28', model: 'claude-opus-5-5[1m]', type: 'workflow-subagent', status: 'pending', isTeammate: false, description: 'integrate' },
      { id: 'a3cd381eed610c950', name: 'a3cd381e', type: 'general-purpose', status: 'running', isTeammate: false, description: 'Bench A: checker A correctness' },
    ] }, 's', T0)
    expect(r.agents.get('a96a4a28d14d1b368')?.status).toBe('completed')
    r.merge([{ id: 'a3cd381eed610c950', type: 'general-purpose', status: 'running', description: 'x' }], T0)
    expect(r.agents.get('a3cd381eed610c950')?.status).toBe('running')
    r.merge([], T0 + 1000)
    expect(r.agents.get('a3cd381eed610c950')?.status).toBe('completed')
  })

  test('the Workflow call gives the run id and name, from its result or its input', () => {
    const result = { status: 'async_launched', taskId: 'w3i23hrkc', taskType: 'local_workflow', workflowName: 'dev-team', runId: RUN }
    expect(workflowRunOf({ name: 'dev-team', args: { title: 'bench B' } }, result)).toEqual({ runId: RUN, name: 'dev-team' })
    expect(workflowRunOf({ name: 'dev-team' }, { result: { runId: RUN } })).toEqual({ runId: RUN, name: 'dev-team' })
    expect(workflowRunOf({ scriptPath: '/x/workflows/scripts/dev-team-wf_bc5e3b69-3d9.js' }, `Run ID: ${RUN}\nTo resume`)).toEqual({ runId: RUN, name: 'dev-team' })
    expect(workflowRunOf({ name: 'dev-team' }, { status: 'failed' })).toBeUndefined()
  })
})

describe('wait wake', () => {
  test('a first-line [WAIT] names an absolute path', () => {
    expect(waitPathOf('[WAIT] /wt/one/out/verdict.json\nrunning')).toBe('/wt/one/out/verdict.json')
    expect(waitPathOf('[WAIT] `/tmp/run.log`')).toBe('/tmp/run.log')
    expect(waitPathOf('[WAIT] out/verdict.json')).toBeUndefined()
    expect(waitPathOf('[WAIT] ~/out.json')).toBeUndefined()
    expect(waitPathOf('[WAIT] /wt/v.json (gate verdict)')).toBe('/wt/v.json')
    expect(waitPathOf('[WAIT] `/tmp/a b/out.json` (suite output)\nmore')).toBe('/tmp/a b/out.json')
    expect(waitPathOf('[WAIT] /tmp/x')).toBe('/tmp/x')
    expect(waitPathOf('[ASK] ok?\n[WAIT] /tmp/x')).toBeUndefined()
    expect(waitWakeText('/tmp/x', 'GREEN\n  12 passed\n')).toBe('[ASK] /tmp/x changed: GREEN 12 passed')
  })

  test('a first-line [WAIT] until <ISO-8601 time> names a time', () => {
    expect(waitUntilOf('[WAIT] until 2026-10-14T09:30:00Z\nthe gate')).toBe(Date.parse('2026-10-14T09:30:00Z'))
    expect(waitUntilOf('[WAIT] until 09:30')).toBeUndefined()
    expect(waitUntilOf('[WAIT] /tmp/x')).toBeUndefined()
  })

  test('a wake is due once per change after registration while the teammate is idle', () => {
    const w = { path: '/tmp/x', since: T0 }
    expect(isWaitDue(w, T0 + 5, T0 + 1)).toBe(true)
    expect(isWaitDue({ ...w, wokenFor: T0 + 1 }, T0 + 5, T0 + 1)).toBe(false)
    expect(isWaitDue(w, T0 + 5, T0 - 1)).toBe(false)
    expect(isWaitDue(w, undefined, T0 + 1)).toBe(false)
    expect(isWaitDue(w, T0 + 5, undefined)).toBe(false)
  })

  test('a teammate is idle from its last idle notice until it sends again, while its live agent is not running', () => {
    const r = new Roster()
    r.spawned({ name: 't1', isTeammate: true }, { agentId: 'a1' }, T0)
    r.noteMessage('t1', T0)
    expect(r.idleSince('t1')).toBeUndefined()
    r.noteIdle('t1', 'available', T0 + 10)
    expect(r.idleSince('t1')).toBe(T0 + 10)
    r.merge([{ id: 'a1', name: 't1', type: 'teammate', status: 'running', description: '' }], T0 + 15)
    expect(r.idleSince('t1')).toBeUndefined()
    r.merge([{ id: 'a1', name: 't1', type: 'teammate', status: 'idle', description: '' }], T0 + 16)
    expect(r.idleSince('t1')).toBe(T0 + 10)
    r.noteMessage('t1', T0 + 20)
    expect(r.idleSince('t1')).toBeUndefined()
  })
})

describe('claims replay', () => {
  test('the mod\'s own logged asks never replay as claims, even when they quote a [CLAIM]', () => {
    const b = new ClaimBoard()
    const line = (from: string, summary: string) => ({ ts: T0, from, to: 't1', summary, length: 1, via: 'send' as const, session: 's' })
    hydrateClaims(b, [line('swarm', '[ASK] /wt/out.json changed: [CLAIM] build quoted'), line('t2', '[CLAIM] build #7')], 's')
    expect(b.all().map(c => c.key)).toEqual(['build #7'])
  })

  test('a log written under the plugin\'s earlier name swarm-console reads its lines as the mod\'s', () => {
    const b = new ClaimBoard()
    const line = (from: string, summary: string) => ({ ts: T0, from, to: 't1', summary, length: 1, via: 'send' as const, session: 's' })
    hydrateClaims(b, [line('swarm-console', '[ASK] /wt/out.json changed: [CLAIM] build quoted'), line('t2', '[CLAIM] build #7')], 's')
    expect(b.all().map(c => c.key)).toEqual(['build #7'])
    expect([isTeammateName('swarm'), isTeammateName('swarm-console'), isTeammateName('t2')]).toEqual([false, false, true])
  })
})

describe('pane: current team', () => {
  const rows = (r: Roster) => paneLines(r, new MessageLog(), new WakePolicy(), T0 + 1000, 100, 5)
  const listed = (r: Roster, statuses: Record<string, string>) =>
    r.merge(Object.entries(statuses).map(([n, status]) => ({ id: 'a' + n, name: n, type: 'teammate', status, teammateId: n + '@session-6036d038', description: '' })), T0 + 500)

  test('⚠ dup only among live agents; a killed namesake does not count', () => {
    const r = team()
    r.announce('t2', '[PROPOSE] hello Kestrel')
    r.announce('t3', '[PROPOSE] hello kestrel')
    listed(r, { t1: 'running', t2: 'killed', t3: 'running' })
    expect(rows(r).filter(l => l.includes('⚠ dup'))).toEqual([])
  })

  test('the header counts the current team; a completed agent moves under other agents at once', () => {
    const r = team()
    listed(r, { t1: 'running', t2: 'idle', t3: 'completed' })
    const lines = rows(r)
    expect(lines[0]).toMatch(/^swarm: 2 agents ·/)
    expect(lines.indexOf(OTHER_AGENTS)).toBeLessThan(lines.findIndex(l => l.includes(' t3 ')))
    expect(lines.indexOf(OTHER_AGENTS)).toBeGreaterThan(lines.findIndex(l => l.includes(' t2 ')))
  })

  test('a teammate whose hello keeps its placeholder shows (no code name)', () => {
    const r = team()
    r.announce('t1', '[PROPOSE] hello t1')
    expect(r.label('t1')).toBe('t1 (no code name)')
    expect(r.label('t2')).toBe('t2')
  })
})

describe('claim TTL', () => {
  test('a claim whose holder has sent nothing for 10 min shows as stale', () => {
    const r = team()
    const b = new ClaimBoard()
    r.noteMessage('t1', T0)
    b.claim('t1', claimOf('[CLAIM] build src/parser.ts')!)
    const claims = (now: number) => paneLines(r, new MessageLog(), new WakePolicy(), now, 100, 5, b).filter(l => l.startsWith('src/parser.ts'))
    expect(claims(T0 + 9 * 60_000)).toEqual(['src/parser.ts · build t1'])
    expect(claims(T0 + 11 * 60_000)).toEqual(['src/parser.ts · build t1 stale'])
  })
})

describe('stalled label', () => {
  test('a teammate idle past the stall minutes while holding an open claim shows as stalled', () => {
    const r = team()
    const b = new ClaimBoard()
    r.merge(['t1', 't2'].map(n => ({ id: 'a' + n, name: n, type: 'teammate', status: 'idle', teammateId: n + '@session-6036d038', description: '' })), T0)
    r.noteMessage('t1', T0)
    b.claim('t1', claimOf('[CLAIM] build src/parser.ts')!)
    r.noteIdle('t1', 'available', T0 + 1000)
    r.noteIdle('t2', 'available', T0 + 1000)
    const status = (now: number, n: string) => paneLines(r, new MessageLog(), new WakePolicy(), now, 100, 5, b, 5 * 60_000).find(l => l.includes(` ${n} `))?.split(/\s+/)[4]
    expect(status(T0 + 4 * 60_000, 't1')).toBe('idle')
    expect(status(T0 + 6 * 60_000, 't1')).toBe('stalled')
    expect(status(T0 + 6 * 60_000, 't2')).toBe('idle')
  })
})

describe('order stamps', () => {
  const stamped = (text: string) => stampLine(412, Date.UTC(2026, 9, 14, 17, 4, 12)) + '\n' + text

  test('the stamp line reads #n · HH:MM:SS, and every parser reads the line after it', () => {
    expect(stampLine(412, Date.UTC(2026, 9, 14, 17, 4, 12))).toBe('#412 · 17:04:12')
    expect(unstamped(stamped('[CLAIM] build docs/design.md'))).toBe('[CLAIM] build docs/design.md')
    expect(typeOf(stamped('[HANDOFF] rows.md'))).toBe('HANDOFF')
    expect(firstLine(stamped('[DONE] report.md\nmore'))).toBe('[DONE] report.md')
    expect(claimOf(stamped('[CLAIM] build docs/design.md'))).toEqual({ role: 'build', target: 'docs/design.md' })
    expect(waitPathOf(stamped('[WAIT] /abs/out.json'))).toBe('/abs/out.json')
    expect(waitUntilOf(stamped('[WAIT] until 2026-10-14T09:30:00Z'))).toBe(Date.parse('2026-10-14T09:30:00Z'))
    expect(reviewOf(stamped('[REVIEW] #3 approve'))).toEqual({ slice: '#3', state: 'approve' })
    expect(helloName(stamped('[PROPOSE] hello Atlas'))).toBe('Atlas')
    expect(isHeldFromLead(stamped('[PROPOSE] hello Atlas'), undefined)).toBe(true)
    expect(isHeldFromLead('<teammate-message from="t1">' + stamped('[CLAIM] build x.md'), undefined)).toBe(true)
    expect(isHeldFromLead(stamped('[CLAIM] build x.md, @lead see this'), undefined)).toBe(false)
    expect(mentionsLead(stamped('[ASK] @lead which one?'))).toBe(true)
  })

  test('a text that only looks like a stamp mid-message is left alone', () => {
    expect(unstamped('[ASK] see #12 · 10:00:00\nlater')).toBe('[ASK] see #12 · 10:00:00\nlater')
    expect(typeOf('#12 is done')).toBeUndefined()
  })
})

describe('claim conflicts', () => {
  test('sameTarget: #n, a path ending the other, a file name and a path ending in it; other words only when equal', () => {
    expect(sameTarget('design.md', 'design/design.md')).toBe(true)
    expect(sameTarget('design/design.md', 'swarms-builder/design/design.md')).toBe(true)
    expect(sameTarget('docs/design.md', '/work/docs/design.md')).toBe(true)
    expect(sameTarget('docs/design.md', 'design/design.md')).toBe(false)
    expect(sameTarget('docs/notes.md', 'src/notes.md')).toBe(false)
    expect(sameTarget('notes.md (draft)', 'notes.md')).toBe(true)
    expect(sameTarget('hooks/core', 'core')).toBe(false)
    expect(sameTarget('v0.2 parser', 'v0.2 tests')).toBe(false)
    expect(sameTarget('#155 (cache bug)', 'repo#155')).toBe(true)
    expect(sameTarget('#155', '#141')).toBe(false)
    expect(sameTarget('group a', 'group b')).toBe(false)
    expect(sameTarget('group a', 'group a')).toBe(true)
    expect(sameTarget('design.md', 'gaps.md')).toBe(false)
  })

  test('a later claim on the same target joins the first claim; the holder is the lowest stamp; both show ⚠', () => {
    const b = new ClaimBoard()
    b.claim('t2', { role: 'build', target: 'docs/design.md' }, true, { stamp: 4, at: 10 })
    b.claim('t1', { role: 'build', target: 'design.md' }, true, { stamp: 3, at: 5 })
    expect(b.all().map(c => [c.key, c.by])).toEqual([['build docs/design.md', ['t2', 't1']]])
    expect(b.heldBefore('t2', { role: 'build', target: 'design.md' })).toEqual({ key: 'build docs/design.md', target: 'docs/design.md', holder: 't1', stamp: 3, at: 5 })
    expect(b.heldBefore('t1', { role: 'build', target: 'design.md' })).toBeUndefined()
    expect(claimLines(b, n => n)).toEqual(['docs/design.md · build t2, t1 ⚠ duplicate'])
    b.claim('t3', { role: 'research', target: 'group a' })
    b.claim('t4', { role: 'research', target: 'group a' })
    expect(b.heldBefore('t4', { role: 'research', target: 'group a' })).toEqual({ key: 'research group a', target: 'group a', holder: 't3' })
    expect(claimLines(b, n => n)).toContain('group a · research t3, t4 ⚠ duplicate')
    b.claim('t5', { role: 'review', target: 'docs/design.md' })
    b.claim('t6', { role: 'review', target: 'docs/design.md' })
    expect(b.heldBefore('t6', { role: 'review', target: 'docs/design.md' })).toBeUndefined()
  })
})

describe('claim conflicts: inactive holders', () => {
  test('a holder that ended or reported [DONE] or [REVIEW] after its claim holds nothing: the next claimant gets no holder and no ⚠; a [BLOCK] keeps it', () => {
    const b = new ClaimBoard()
    const ended = new Set(['t5'])
    b.isLive = n => !ended.has(n)
    b.claim('t1', { role: 'build', target: 'x.md' }, true, { stamp: 1 })
    b.report('t1', 'DONE')
    b.claim('t2', { role: 'build', target: 'x.md' }, true, { stamp: 2 })
    expect(b.heldBefore('t2', { role: 'build', target: 'x.md' })).toBeUndefined()
    b.claim('t3', { role: 'research', target: 'y.md' }, true, { stamp: 3 })
    b.report('t3', 'REVIEW')
    b.claim('t4', { role: 'research', target: 'y.md' }, true, { stamp: 4 })
    expect(b.heldBefore('t4', { role: 'research', target: 'y.md' })).toBeUndefined()
    b.claim('t5', { role: 'build', target: 'z.md' }, true, { stamp: 5 })
    b.claim('t6', { role: 'build', target: 'z.md' }, true, { stamp: 6 })
    expect(b.heldBefore('t6', { role: 'build', target: 'z.md' })).toBeUndefined()
    expect(claimLines(b, n => n).filter(l => l.includes('⚠'))).toEqual([])
    expect(b.duplicates()).toEqual([])
    b.claim('t7', { role: 'build', target: 'w.md' }, true, { stamp: 7 })
    b.report('t7', 'BLOCK')
    b.claim('t8', { role: 'build', target: 'w.md' }, true, { stamp: 8 })
    expect(b.heldBefore('t8', { role: 'build', target: 'w.md' })?.holder).toBe('t7')
    expect(claimLines(b, n => n)).toContain('w.md · build t7, t8 ⚠ duplicate')
  })
})

test('a refusal without a plugin name is kept as its text', () => {
  expect(commandHolder('Error: "/swarm" refused: the plugin swarm registered it already')).toBe('swarm')
  expect(commandHolder('Error: "/swarm" refused: a built-in')).toBe('"/swarm" refused: a built-in')
})
