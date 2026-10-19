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
  releaseOf,
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
  nudgeText,
} from '../hooks/core'
import { isTeammateName } from '../hooks/replay'
import { setZone } from './zone'

// The fixtures' times read as UTC: the pane's clock is local time, set here to UTC.
setZone(0)

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
  const base = { now: T0 + 6 * 60_000, lastActivityAt: T0, stallMs: 5 * 60_000, activeAgents: 0, liveAgents: 2, openTasks: 3, openClaims: 0, leadBusy: false, alreadyFired: false }

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

  test('an open claim is work remaining though the task list is empty (run 3: no tasks, the pane showed the holder stalled)', () => {
    expect(isStalled({ ...base, openTasks: 0, openClaims: 1 })).toBe(true)
    expect(isStalled({ ...base, openTasks: 0, openClaims: 1, activeAgents: 1 })).toBe(false)
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
  test('a claim target that starts with a path is the path alone; only [RELEASE]/[WITHDRAW] <target>, a first clause "[<name>:] I release|withdraw|drop my claim on <target>", "I drop my <target> claim", "Yielding <target> to", a sentence "The <target> claim is released to", or "[CLAIM] <target> is withdrawn" (no claim) releases', () => {
    expect(claimOf('[CLAIM] research architecture/05-enrichment-and-capture.md (h14). Output: swarm-haiku/h14-05.md')).toEqual({ role: 'research', target: 'architecture/05-enrichment-and-capture.md' })
    const ordinary = [
      'I handed the draft of x.ts to h04 for review',
      'vendor released v2 of x.ts yesterday',
      '[REVIEW] withdrawn finding #3 on x.ts',
      '[CLAIM] build x.ts — released lock issue fixed',
      'commit lock released on x.ts',
      'Note: we both used the name Basalt; I drop it. [CLAIM] research x.ts',
      'I release the mutex in x.ts so you can run the tests',
      'I withdraw my objection, x.ts looks fine',
      'x.ts is released to review',
      'h11: I am withdrawing my [REVIEW] request for x.ts.',
      'h06: Withdraw from that review on x.ts if you are busy',
    ]
    for (const t of ordinary) {
      expect(releaseOf(t)).toBeUndefined()
      const b = new ClaimBoard()
      b.claim('h1', { role: 'build', target: 'x.ts' })
      const own = claimOf(t)
      if (own !== undefined) b.claim('h1', own)
      expect(b.release('h1', t)).toBe(false)
      expect(b.all().some(c => c.target === 'x.ts' && c.by.includes('h1'))).toBe(true)
    }
    expect(claimOf('[CLAIM] build x.ts — released lock issue fixed')).toEqual({ role: 'build', target: 'x.ts' })
    const b = new ClaimBoard()
    for (const [by, t] of [['h03', 'docs/user/03-accounts.md'], ['h03', 'docs/user/admin-4.md'], ['h04', 'docs/user/03-accounts.md'], ['h10', 'docs/architecture/06-web-app.md'], ['h05', 'docs/c.md'], ['h06', 'docs/d.md'], ['h07', 'docs/user/07-profil.md'], ['h14', 'docs/architecture/05-enrichment-and-capture.md'], ['h09', 'docs/user/09-x.md']] as const) b.claim(by, { role: 'research', target: t })
    b.claim('h06', { role: 'build', target: 'docs/d.md' })
    expect(b.release('h03', '[RELEASE] docs/user/03-accounts.md, h04 keeps it')).toBe(true)
    expect(b.release('h10', '[WITHDRAW] 06-web-app (h08 first)')).toBe(true)
    expect(b.release('h05', 'I release docs/c.md. h02 takes it.')).toBe(true)
    expect(b.release('h06', 'I drop my claim on docs/d.md')).toBe(true)
    expect(b.release('h04', '[WITHDRAW] docs/user/admin-4.md')).toBe(false)
    expect(b.release('h07', 'Yielding 07 to you: your claim came first by stamp.')).toBe(true)
    expect(b.release('h14', 'h14: I drop my 05-enrichment-and-capture claim (h13 claimed first at 18:03:14).')).toBe(true)
    expect(b.release('h09', '[CLAIM] research docs/user/admin-4.md (h09). The 09 claim is released to h04.')).toBe(true)
    const handedOver = '[CLAIM] research docs/user/07-profil-erfassen.md is withdrawn: I drop it, you keep it (the lead confirmed your first claim). The file swarm-haiku/basalt-07-pro…'
    expect(claimOf(handedOver)).toBeUndefined()
    b.claim('h08', { role: 'research', target: 'docs/user/07-profil-erfassen.md' })
    expect(b.release('h08', handedOver)).toBe(true)
    expect(b.all().map(c => [c.key, c.by])).toEqual([['research docs/user/03-accounts.md', ['h04']], ['research docs/user/admin-4.md', ['h03']]])
    b.addDeliverables(['docs/user/03-accounts.md', 'docs/user/05-offen.md', 'docs/user/08-diktat.md', 'docs/user/09-x.md', 'docs/user/10-y.md'])
    expect(b.unclaimed().slice(0, 3)).toEqual(['docs/user/05-offen.md', 'docs/user/08-diktat.md', 'docs/user/09-x.md'])
  })
  test('claimOf reads role and target from the first line', () => {
    expect(claimOf('[CLAIM] build var/swarm-test/gaps.md\nbody')).toEqual({ role: 'build', target: 'var/swarm-test/gaps.md' })
    expect(claimOf('[claim] Builder of `gaps.md`.')).toEqual({ role: 'build', target: 'gaps.md' })
    expect(claimOf('[CLAIM] research group A (capture-*)')).toEqual({ role: 'research', target: 'group' })
    expect([claimOf('[CLAIM] research "group A" (capture-*)'), claimOf('[CLAIM] research `group B`')]).toEqual([{ role: 'research', target: 'group a' }, { role: 'research', target: 'group b' }])
    expect(sameTarget('group a', 'group b')).toBe(false)
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
    expect(claimOf('[CLAIM] build docs/x.md, reviewers please hold')).toEqual({ role: 'build', target: 'docs/x.md' })
    expect(claimOf('[CLAIM] build (docs/x.md)')).toEqual({ role: 'build', target: 'docs/x.md' })
    expect(claimOf('[CLAIM] build #155 (hydration fix)')).toEqual({ role: 'build', target: '#155' })
  })

  test('a claim target is its target token: trailing prose never joins it (10-17 log l.11, l.20, l.330, l.969, l.1593)', () => {
    const u1 = claimOf('[CLAIM] research core-aa (u1, sonnet)')
    const u2 = claimOf('[CLAIM] research core-aa (u2, code name Ivy)')
    expect([u1, u2]).toEqual([{ role: 'research', target: 'core-aa' }, { role: 'research', target: 'core-aa' }])
    expect(claimOf('[CLAIM] research int-ai (u16, Lark, haiku). Starting now.')).toEqual({ role: 'research', target: 'int-ai' })
    const prose = 'int-aa is mine: my [CLAIM] research int-aa is #29 (08:56:25), yours is #39, and the lead confirmed it to me. Please take another free slice (not int-aa).'
    expect(claimOf(prose)).toBeUndefined()
    expect(claimOf('[CLAIM] research researchAgent.test.ts (gap-fill for int-ai). Per lead: I take researchAgent.test.ts in full')).toEqual({ role: 'research', target: 'researchagent.test.ts' })
    const b = new ClaimBoard()
    b.claim('u1', u1!, true, { stamp: 1 })
    b.claim('u2', u2!, true, { stamp: 4 })
    expect(b.all().map(c => [c.key, c.by])).toEqual([['research core-aa', ['u1', 'u2']]])
    expect(b.heldBefore('u2', u2!)).toMatchObject({ holder: 'u1', stamp: 1 })
  })

  test('a later [CLAIM] counts unless it is quoted or follows a possessive or a word that reports another claim (run-2 l.1722, l.738; older log l.3317, l.374, l.1506, l.2722)', () => {
    expect(claimOf('[ASK] findings.md builder is r3 Lanz — they sent [CLAIM] build /work/swarm-review/findings.md earlier; please don\'t claim it.')).toBeUndefined()
    expect(claimOf('Stamps show my claim came first: my [CLAIM] research docs/user/03-accounts-und-briefs.md went out at #59–#61 (17:52:21)')).toBeUndefined()
    for (const t of ['[PROPOSE] hello Quill — [CLAIM] research web-af', '[PROPOSE] hello Quill (sonnet) [CLAIM] research web-af', '**[CLAIM] research web-af**', '| [CLAIM] research web-af |', 'Quill here and [CLAIM] research web-af']) {
      expect(claimOf(t)).toEqual({ role: 'research', target: 'web-af' })
    }
    expect(claimOf('[CLAIM] review hooks/*.ts')).toEqual({ role: 'review', target: 'hooks/*.ts' })
    expect(claimOf("int-ai is taken: v18's [CLAIM] research int-ai (#349, 12:17:12) came before yours (#382). Findings are already written to out/v18-int-ai.md and are with v8 for…")).toBeUndefined()
    expect(claimOf('[ASK] music.md: please confirm [CLAIM] build music.md. Spec from design.md: 172 BPM')).toBeUndefined()
    expect(claimOf('web-ac is claimed by v8 first: "[RELEASE] web-ab ... [CLAIM] research web-ac" (log ts 1792231922782)')).toBeUndefined()
    expect(claimOf('[RELEASE] web-ab (Mote/v8). [CLAIM] research web-ac')).toEqual({ role: 'research', target: 'web-ac' })
    expect(claimOf('[PROPOSE] hello Granit (h08, Haiku 5.5). Strengths: code-to-doc claim checks, UI string tracing. [CLAIM] research docs/architecture/06-web-app.md. Output: swar…')).toEqual({ role: 'research', target: 'docs/architecture/06-web-app.md' })
    expect(claimOf('[PROPOSE] hello Quill, [CLAIM] research web-af')).toEqual({ role: 'research', target: 'web-af' })
    expect(claimOf('[PROPOSE] hello Juniper\nHaiku, read-only audit.\n[CLAIM] research web-af')).toEqual({ role: 'research', target: 'web-af' })
  })

  test('a release names every own claim its text names before its first sentence end or [CLAIM] (older-log [WITHDRAW] lines; run-2 l.738)', () => {
    const b = new ClaimBoard()
    const own = (by: string, ...targets: string[]) => { for (const t of targets) b.claim(by, { role: 'research', target: t }) }
    own('h10', 'docs/architecture/06-web-app.md', 'docs/architecture/04-ingest.md')
    own('v13', 'web-ab', 'web-ac', 'web-ad')
    own('v8', 'web-ab', 'web-ac')
    expect(b.release('h10', '[WITHDRAW] h10 withdraws the 06-web-app claim (h08 first).')).toBe(true)
    expect(b.release('h10', '[WITHDRAW] h10 withdraws its 04-ingest claim')).toBe(true)
    expect(b.release('v13', '[RELEASE] web-ab, web-ac')).toBe(true)
    expect(b.release('v13', '[RELEASE] my web-ad claim')).toBe(true)
    own('v13', 'web-ac')
    expect(b.release('v13', '[RELEASE] v13 releases web-ac')).toBe(true)
    expect(b.release('v8', '[RELEASE] web-ab (Mote/v8). [CLAIM] research web-ac')).toBe(true)
    expect(b.all().map(c => [c.key, c.by])).toEqual([['research web-ac', ['v8']]])
  })

  test('the mod\'s own [ASK] keeps its type behind the swarm: prefix; the stall nudge reads swarm: [ASK] quiet', () => {
    expect(typeOf('swarm: [ASK] web-ac is already claimed by v8 (v8, since 12:12:02, #164). Talk to them, split it, or pick another slice.')).toBe('ASK')
    expect(nudgeText(5, [{ role: 'build', target: 'x.md', key: 'build x.md', by: ['t1'] }], new Map(), n => n)).toBe('[ASK] quiet 5 min: you hold build x.md; nobody has reported. Continue, or send [DONE]/[BLOCK].')
  })

  test('a first line [CLAIM] <target> is (already) taken|held, is already claimed or claimed|held|taken by … reports who holds it and is no claim, also when an older log stored one; is mine now and is claimed: starting are claims (run 3 l.229, l.457, l.506, l.713, l.977, l.1230; l.234)', () => {
    const reports = [
      "[CLAIM] research arch-06-web-app is already taken: Lantern (w6) claimed it at #47, before your #52. Pick another slice; I have no claim on it either.",
      "[CLAIM] research arch-06-web-app is mine: the lead confirmed it (\"swarm: research arch-06-web-app is yours\", 13:12). Please pick another slice, e.g. user-01-er…",
      "[CLAIM] research user-02-heute-und-anlaesse is already taken: Halyard (w10) claimed it at #79, before your #88. Pick another slice.",
      "[CLAIM] research user-03-accounts-und-briefs is already taken: w1 claimed it at #106, before your #116. Pick another slice.",
      "[CLAIM] research user-06-assistent is already taken: w11 claimed it at #148, before your #160. Pick another slice.",
      "[CLAIM] research user-09-dokumente-und-wissen is already taken: w15 claimed it at #219, before your #234. Pick another slice.",
      "[CLAIM] research user-admin-3-budgets-und-credits is already taken: w17 claimed it at #302, before your #319. Pick another slice.",
    ]
    const lantern = reports.splice(1, 1)[0]!
    for (const t of reports) expect(claimOf(t)).toBeUndefined()
    for (const t of ['[CLAIM] research x is held by w2', '[CLAIM] build docs/a.md is claimed by w1', '[CLAIM] research x taken by w4']) expect(claimOf(t)).toBeUndefined()
    expect(claimOf(lantern)).toEqual({ role: 'research', target: 'arch-06-web-app' })
    expect(claimOf('[CLAIM] build docs/x.md is mine now, starting')).toEqual({ role: 'build', target: 'docs/x.md' })
    expect(claimOf('[CLAIM] research web-ab is claimed: starting now')).toEqual({ role: 'research', target: 'web-ab' })
    expect(claimOf('[CLAIM] research arch-06-web-app (Lantern, w6)')).toEqual({ role: 'research', target: 'arch-06-web-app' })
    const line = (from: string, summary: string) => ({ ts: T0, from, to: 'w1', summary, length: 1, via: 'send' as const, session: 's', claim: { role: 'research', target: 'arch-06-web-app' } })
    const b = new ClaimBoard()
    hydrateClaims(b, [line('w6', '[CLAIM] research arch-06-web-app (Lantern, w6)'), line('w3', reports[0]!), line('w6', lantern)], 's')
    expect(b.all().map(c => [c.key, c.by])).toEqual([['research arch-06-web-app', ['w6']]])
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
    expect(b.missingBuilders()).toEqual([])
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
    expect(renameName('Note: g3 renames to vireo.')).toBeUndefined()
    expect(renameName("I'm reviewing from now on")).toBeUndefined()
    expect(renameName("clash with d1, I'm heron from now on")).toBe('heron')
    expect(renameName('I rename to "sedge"')).toBe('sedge')
    expect(renameName('I work from now on in the worktree')).toBeUndefined()
    expect(renameName('[HANDOFF] slice done\n- claim: prompts/tools/brief/ingest_document.md no longer says "of its account" (now true).')).toBeUndefined()
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

  test('a reload restores no JOIN or LEFT line as a message', () => {
    const log = new MessageLog()
    const move = (type: string, ts: number) => ({ ts, from: 't1', to: '', summary: type === 'JOIN' ? 'joined' : 'completed', length: 0, via: 'tool' as const, type, session: 'session-x' })
    hydrateLog(log, new Roster(), [move('JOIN', T0), move('LEFT', T0 + 1000)], 'session-x')
    expect([log.entries.length, log.earlier.length]).toEqual([0, 0])
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

  test('a running subagent a teammate spawned shows right under that teammate; once ended, under other agents', () => {
    const r = new Roster()
    for (const n of ['t1', 't2']) r.spawned({ name: n, isTeammate: true }, { agentId: 'a' + n, teammateId: n + '@session-6036d038' }, T0)
    r.spawned({ description: 'scan the repo', subagentType: 'Explore', parentAgentId: 'at1' }, { agentId: 'a5c0ffee00000001' }, T0)
    r.merge([{ id: 'a5c0ffee00000001', type: 'Explore', status: 'running', description: 'scan the repo' }, { id: 'abeef00000000002', type: 'Explore', status: 'running', description: 'read the docs', parentId: 'at2' }], T0 + 1000)
    const text = (now: number) => paneRows(r, new MessageLog(), new WakePolicy(), now, 80, 10).map(x => x.text)
    const live = text(T0 + 2000)
    expect(live.slice(4, 8).map(l => l.trim().slice(0, 18))).toEqual(['◌ t1', '└ ● scan the repo', '◌ t2', '└ ● read the docs'].map(l => l.padEnd(18)))
    expect(live).not.toContain(OTHER_AGENTS)
    r.merge([{ id: 'a5c0ffee00000001', type: 'Explore', status: 'completed', description: 'scan the repo' }, { id: 'abeef00000000002', type: 'Explore', status: 'running', description: 'read the docs', parentId: 'at2' }], T0 + 3000)
    const after = text(T0 + 4000)
    expect(after.filter(l => l.includes('└')).map(l => l.trim().slice(0, 17))).toEqual(['└ ● read the docs'])
    expect(after.slice(after.indexOf(OTHER_AGENTS) + 1).some(l => l.includes('scan the repo'))).toBe(true)
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
    expect(claimOf(hello)?.target).toBe('#158')
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

  test('a reload: a restored teammate the agent list never reports again has ended (builder-mod stayed idle)', () => {
    const r = new Roster()
    r.hydrate({ session: 's', agents: [
      { id: 'builder-mod', name: 'builder-mod', type: 'teammate', status: 'idle', isTeammate: true, teammateId: 'builder-mod@team', spawnedAt: T0, statusAt: T0 },
      { id: 'h1', name: 'h1', type: 'teammate', status: 'idle', isTeammate: true, teammateId: 'h1@team', spawnedAt: T0, statusAt: T0 },
    ] }, 's', T0 + 1000)
    r.merge([{ id: 'h1', name: 'h1', type: 'teammate', status: 'idle', teammateId: 'h1@team', description: '' }], T0 + 2000)
    expect(r.agents.get('builder-mod')?.status).toBe('completed')
    expect(r.agents.get('h1')?.status).toBe('idle')
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

  test('a teammate idle for over 6 h is dormant, shown as ended (under other agents, not counted) but still live for the team; busy again, holding a wait or claim, or a message since, it is not', () => {
    const r = team()
    const H = 3_600_000
    const at = (now: number, statuses: Record<string, string>) =>
      r.merge(Object.entries(statuses).map(([n, status]) => ({ id: 'a' + n, name: n, type: 'teammate', status, teammateId: n + '@session-6036d038', description: '' })), now)
    at(T0 + 500, { t1: 'running', t2: 'idle', t3: 'idle' })
    at(T0 + 5 * H, { t1: 'running', t2: 'idle', t3: 'idle' })
    const dormant = () => ['t1', 't2', 't3'].map(n => r.isDormant(r.agents.get('a' + n)!))
    expect(dormant()).toEqual([false, false, false])
    r.noteMessage('t3', T0 + 2 * H)
    at(T0 + 6 * H + 1000, { t1: 'running', t2: 'idle', t3: 'idle' })
    expect(dormant()).toEqual([false, true, false])
    expect([r.isLiveTeammate('t2'), r.liveCount(), r.isTeamEnded()]).toEqual([true, 3, false])
    const lines = paneLines(r, new MessageLog(), new WakePolicy(), T0 + 6 * H + 1000, 100, 5)
    expect(lines[0]).toMatch(/^swarm: 2 agents ·/)
    expect(lines.indexOf(OTHER_AGENTS)).toBeGreaterThan(lines.findIndex(l => l.includes(' t3 ')))
    expect(lines.indexOf(OTHER_AGENTS)).toBeLessThan(lines.findIndex(l => l.includes(' t2 ')))
    r.isHeld = n => n === 't2'
    expect(dormant()).toEqual([false, false, false])
    r.isHeld = () => false
    at(T0 + 6 * H + 3000, { t1: 'running', t2: 'running', t3: 'idle' })
    expect(dormant()).toEqual([false, false, false])
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
  test('a holder that ended or reported [DONE] on its claim holds nothing: the next claimant gets no holder and no ⚠; a [REVIEW] keeps a research claim, a [BLOCK] a build claim', () => {
    const b = new ClaimBoard()
    const ended = new Set(['t5'])
    b.isLive = n => !ended.has(n)
    b.claim('t1', { role: 'build', target: 'x.md' }, true, { stamp: 1 })
    b.report('t1', 'DONE')
    b.claim('t2', { role: 'build', target: 'x.md' }, true, { stamp: 2 })
    expect(b.heldBefore('t2', { role: 'build', target: 'x.md' })).toBeUndefined()
    b.claim('t3', { role: 'research', target: 'y.md' }, true, { stamp: 3 })
    b.report('t3', 'REVIEW', true, '[REVIEW] #7 approve')
    b.claim('t4', { role: 'research', target: 'y.md' }, true, { stamp: 4 })
    expect(b.heldBefore('t4', { role: 'research', target: 'y.md' })?.holder).toBe('t3')
    b.report('t3', 'DONE', true, '[DONE] y.md')
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

  test('a report closes claims per slice: a [DONE] naming one slice leaves the holder\'s other claims open, a [REVIEW] closes the review claims only, a [BLOCK] none, a [DONE] naming none all', () => {
    const b = new ClaimBoard()
    b.claim('t1', { role: 'build', target: 'x.md' }, true, { stamp: 1 })
    b.claim('t1', { role: 'build', target: 'y.md' }, true, { stamp: 2 })
    b.claim('t1', { role: 'review', target: 'z.md' }, true, { stamp: 3 })
    b.report('t1', 'REVIEW', true, '[REVIEW] z.md approve\nmeasured: x.md and y.md untouched')
    expect(b.openClaims('t1').map(c => c.key)).toEqual(['build x.md', 'build y.md'])
    b.claim('t1', { role: 'review', target: 'w.md' }, true, { stamp: 4 })
    b.report('t1', 'REVIEW', true, '[REVIEW] x.md pin added at 7aa34b1, see the handoff thread')
    b.report('t1', 'DONE', true, '[DONE] x.md\nshipped; y.md next')
    expect(b.openClaims('t1').map(c => c.key)).toEqual(['build y.md', 'review w.md'])
    b.claim('t2', { role: 'build', target: 'y.md' }, true, { stamp: 4 })
    expect(b.heldBefore('t2', { role: 'build', target: 'y.md' })?.holder).toBe('t1')
    b.claim('t3', { role: 'build', target: 'x.md' }, true, { stamp: 5 })
    expect(b.heldBefore('t3', { role: 'build', target: 'x.md' })).toBeUndefined()
    b.report('t1', 'BLOCK', true, '[BLOCK] y.md tests red')
    expect(b.openClaims('t1').map(c => c.key)).toEqual(['build y.md', 'review w.md'])
    b.report('t1', 'DONE', true, '[DONE] all shipped')
    expect(b.openClaims('t1')).toEqual([])
  })

  test('a later claim (one that found a holder) lapses at its sender\'s next claim of another slice or next report, of any type; the first holder keeps its claim', () => {
    const b = new ClaimBoard()
    b.claim('t1', { role: 'build', target: 'x.md' }, true, { stamp: 1 })
    b.claim('t2', { role: 'build', target: 'x.md' }, true, { stamp: 2 })
    expect(b.duplicates().map(c => c.by)).toEqual([['t1', 't2']])
    b.claim('t2', { role: 'build', target: 'x.md' }, true, { stamp: 3 })
    expect(b.openClaims('t2').map(c => c.key)).toEqual(['build x.md'])
    b.claim('t2', { role: 'build', target: 'y.md' }, true, { stamp: 4 })
    expect(b.openClaims('t2').map(c => c.key)).toEqual(['build y.md'])
    expect(b.duplicates()).toEqual([])
    expect(b.openClaims('t1').map(c => c.key)).toEqual(['build x.md'])
    b.claim('t3', { role: 'build', target: 'x.md' }, true, { stamp: 5 })
    b.report('t3', 'BLOCK', true, '[BLOCK] #4 tests red')
    expect(b.openClaims('t3')).toEqual([])
    b.claim('t4', { role: 'build', target: 'x.md' }, true, { stamp: 6 })
    b.report('t4', 'REVIEW', true, '[REVIEW] #4 approve')
    expect(b.openClaims('t4')).toEqual([])
    expect(b.heldBefore('t5', { role: 'build', target: 'x.md' })?.holder).toBe('t1')
    b.release('t1', '[RELEASE] x.md')
    b.claim('t4', { role: 'build', target: 'x.md' }, true, { stamp: 7 })
    b.report('t4', 'REVIEW', true, '[REVIEW] #5 approve')
    expect(b.openClaims('t4').map(c => c.key)).toEqual(['build x.md'])
    b.claim('t5', { role: 'review', target: 'x.md' }, true, { stamp: 8 })
    b.claim('t6', { role: 'review', target: 'x.md' }, true, { stamp: 9 })
    b.claim('t6', { role: 'review', target: 'y.md' }, true, { stamp: 10 })
    expect(b.openClaims('t6').map(c => c.key)).toEqual(['review y.md'])
    expect(b.openClaims('t5').map(c => c.key)).toEqual(['review x.md'])
  })

  test('a live task-list owner holds its task\'s target against a message claimant, unless the claimant owns it too; an ended owner or a completed task holds nothing', () => {
    const b = new ClaimBoard()
    const ended = new Set(['t9'])
    b.isLive = n => !ended.has(n)
    b.setTasks([
      { subject: 'build docs/a.md', owner: 't1', status: 'in_progress' },
      { subject: 'slice-b', owner: 't2', status: 'in_progress' },
      { subject: 'build c.md', owner: 't9', status: 'in_progress' },
      { subject: 'build d.md', owner: 't2', status: 'completed' },
    ], n => n)
    b.claim('t3', { role: 'build', target: 'a.md' }, true, { stamp: 1 })
    expect(b.heldBefore('t3', { role: 'build', target: 'a.md' })).toEqual({ key: 'build a.md', target: 'a.md', holder: 't1' })
    b.claim('t1', { role: 'build', target: 'docs/a.md' }, true, { stamp: 2 })
    expect(b.heldBefore('t1', { role: 'build', target: 'docs/a.md' })).toBeUndefined()
    b.claim('t4', { role: 'research', target: 'slice-b' }, true, { stamp: 3 })
    expect(b.heldBefore('t4', { role: 'research', target: 'slice-b' })?.holder).toBe('t2')
    b.claim('t5', { role: 'build', target: 'c.md' }, true, { stamp: 4 })
    expect(b.heldBefore('t5', { role: 'build', target: 'c.md' })).toBeUndefined()
    b.claim('t6', { role: 'build', target: 'd.md' }, true, { stamp: 5 })
    expect(b.heldBefore('t6', { role: 'build', target: 'd.md' })).toBeUndefined()
  })
})

test('a refusal without a plugin name is kept as its text', () => {
  expect(commandHolder('Error: "/swarm" refused: the plugin swarm registered it already')).toBe('swarm')
  expect(commandHolder('Error: "/swarm" refused: a built-in')).toBe('"/swarm" refused: a built-in')
})
