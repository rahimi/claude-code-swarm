// Replay of a recorded run: the command's arguments, the runs a log holds, the playback schedule, and the Scene a pane look draws.

import {
  ClaimBoard,
  DEFAULT_STALL_MIN,
  isModName,
  bareName,
  claimOf,
  clauseOf,
  helloName,
  isHeldFromLead,
  isIdleLine,
  isToolLine,
  isLeadAddress,
  renameName,
  reviewOf,
  shortModel,
  sliceOf,
  typeOf,
  REPORTS,
} from './core'
import type { LogEntry, ReviewState } from './core'

export type Look = 'A' | 'B'
export type Level = 'basic' | 'rich'
const LOOKS: readonly Look[] = ['A', 'B']
const DEFAULT_SPEED = 30
/** The longest real pause between two replayed events: a quiet stretch of the run plays in at most this long. */
const MAX_GAP_MS = 1_500
/** Two teams founded this close together are one spawn burst: a peer line between them makes them one. */
export const BURST_MS = 15_000
/** A team silent between its own members this long starts over when its names talk again. */
const REUSE_GAP_MS = 30 * 60_000

/** `level` absent: the pane picks rich where the terminal draws images, else basic. */
export type ReplayArgs = { path: string; speed: number; look: Look; level?: Level; from?: number; to?: number }

/** The arguments after `replay`: `stop`, or a log path and its flags; an error text for anything it cannot read. */
export function parseReplayArgs(rest: string): { stop: true } | { args: ReplayArgs } | { error: string } {
  const words = rest.trim().split(/\s+/).filter(Boolean)
  if (words[0] === 'stop') return { stop: true }
  const out: ReplayArgs = { path: '', speed: DEFAULT_SPEED, look: 'A' }
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!
    const value = words[i + 1]
    if (w.startsWith('--') && value === undefined) return { error: `${w} needs a value` }
    if (w === '--speed') {
      const n = Number(value)
      if (!Number.isFinite(n) || n <= 0) return { error: '--speed takes a number above 0' }
      out.speed = n
      i++
    } else if (w === '--look') {
      const l = value!.toUpperCase()
      if (!(LOOKS as readonly string[]).includes(l)) return { error: '--look takes A or B' }
      out.look = l as Look
      i++
    } else if (w === '--level') {
      if (value !== 'basic' && value !== 'rich') return { error: '--level takes basic or rich' }
      out.level = value
      i++
    } else if (w === '--from' || w === '--to') {
      const t = Date.parse(value!)
      if (!Number.isFinite(t)) return { error: `${w} takes an ISO time, e.g. 2026-10-12T19:47:00Z` }
      out[w === '--from' ? 'from' : 'to'] = t
      i++
    } else if (w.startsWith('--')) return { error: 'unknown flag ' + w }
    else if (out.path === '') out.path = w
    else return { error: 'one log path only' }
  }
  if (out.path === '') return { error: 'usage: /swarm replay <log.jsonl> [--speed N] [--look A|B] [--level basic|rich] [--from <ISO>] [--to <ISO>] | replay stop' }
  return { args: out }
}

/** Whether an address is a teammate's: not the lead, this plugin, or an unnamed peer. */
export function isTeammateName(name: string): boolean {
  return name !== '' && !isLeadAddress(name) && !isModName(name) && name !== 'peer' && name !== 'coordinator'
}

export type Run = { from: number; to: number; count: number; names: string[] }

/** How long before a run's first teammate line the replay starts: the lead's own lines before it are its brief, not the run. */
export const LEAD_IN_MS = 30_000

/** A team: the teammates that message each other, from its first peer message to its last. */
export type Team = { names: string[]; firstAt: number; lastPeerAt: number }

/**
 * The teams a log holds, from teammate-to-teammate lines in time order. A peer line belongs to the team either end talked
 * in within `REUSE_GAP_MS`; a line between two names with no such team founds a new one. The other end joins on that line,
 * sender or receiver, unless it is still talking in another team; a line between two teams founded within `BURST_MS` of
 * each other merges them. A team's names come in the order each first sent a peer line, as the looks place them. Agents that only write to the lead are in no team.
 */
export function teamsOf(lines: readonly LogEntry[], isMate: (name: string) => boolean = isTeammateName): Team[] {
  const out: Team[] = []
  const seen = new Map<string, { team: Team; at: number }>()
  const firstSent = new Map<Team, Map<string, number>>()
  for (const e of [...lines].sort((a, b) => a.ts - b.ts)) {
    if (isIdleLine(e) || isToolLine(e)) continue
    const from = bareName(e.from)
    const to = bareName(e.to)
    if (from === to || !isTeammateName(from) || !isTeammateName(to) || !isMate(from) || !isMate(to)) continue
    const teamOf = (n: string) => {
      const last = seen.get(n)
      return last !== undefined && e.ts - last.at <= REUSE_GAP_MS ? last.team : undefined
    }
    let team = teamOf(from) ?? teamOf(to)
    const other = teamOf(to)
    if (team !== undefined && other !== undefined && other !== team && Math.abs(other.firstAt - team.firstAt) <= BURST_MS) {
      for (const n of other.names) if (!team.names.includes(n)) team.names.push(n)
      team.firstAt = Math.min(team.firstAt, other.firstAt)
      for (const [n, last] of seen) if (last.team === other) seen.set(n, { team, at: last.at })
      out.splice(out.indexOf(other), 1)
      const mine = firstSent.get(team) ?? new Map<string, number>()
      for (const [n, at] of firstSent.get(other) ?? []) mine.set(n, Math.min(at, mine.get(n) ?? Infinity))
      firstSent.set(team, mine)
    }
    if (team === undefined) {
      team = { names: [from, to], firstAt: e.ts, lastPeerAt: e.ts }
      out.push(team)
    } else {
      team.lastPeerAt = e.ts
      for (const n of [from, to]) if (!team.names.includes(n) && teamOf(n) === undefined) team.names.push(n)
    }
    for (const n of [from, to]) if (team.names.includes(n)) seen.set(n, { team, at: e.ts })
    if (!firstSent.has(team)) firstSent.set(team, new Map())
    if (!firstSent.get(team)!.has(from)) firstSent.get(team)!.set(from, e.ts)
  }
  for (const t of out) {
    const sent = firstSent.get(t) ?? new Map<string, number>()
    t.names.sort((a, b) => (sent.get(a) ?? Infinity) - (sent.get(b) ?? Infinity))
  }
  return out
}

/**
 * The runs a log holds, one per team: from `LEAD_IN_MS` before its first peer message to the last line from or to one of
 * its members before a later team that shares a name starts.
 */
export function splitRuns(lines: readonly LogEntry[]): Run[] {
  const sorted = [...lines].sort((a, b) => a.ts - b.ts)
  const teams = teamsOf(sorted)
  return teams.map((t, i) => {
    const next = teams.slice(i + 1).find(n => n.names.some(x => t.names.includes(x)))
    const end = next?.firstAt ?? Infinity
    const from = t.firstAt - LEAD_IN_MS
    let to = t.lastPeerAt
    for (const e of sorted) if (e.ts >= t.firstAt && e.ts < end && (t.names.includes(bareName(e.from)) || t.names.includes(bareName(e.to)))) to = Math.max(to, e.ts)
    return { from, to, count: sorted.filter(e => e.ts >= from && e.ts <= to).length, names: t.names }
  })
}

/** The lines inside a window, in time order. */
export function windowOf(lines: readonly LogEntry[], from: number, to: number): LogEntry[] {
  return lines.filter(e => e.ts >= from && e.ts <= to).sort((a, b) => a.ts - b.ts)
}

/** When each line plays, in real milliseconds from the start: the recorded gap over `speed`, at most `maxGapMs`. */
export function schedule(lines: readonly LogEntry[], speed: number, maxGapMs = MAX_GAP_MS): number[] {
  const out: number[] = []
  let at = 0
  for (let i = 0; i < lines.length; i++) {
    if (i > 0) at += Math.min((lines[i]!.ts - lines[i - 1]!.ts) / speed, maxGapMs)
    out.push(at)
  }
  return out
}

export type ModelFamily = 'opus' | 'sonnet' | 'haiku' | 'fable'

/**
 * The model family per teammate name from a roster.json, for a run starting at `at`: the latest entry of that name spawned
 * by then (with a minute's grace), else its only entry; undefined when the roster does not say.
 */
export function modelsOf(rosterJson: unknown): (name: string, at: number) => ModelFamily | undefined {
  const agents = (rosterJson as { agents?: unknown } | null)?.agents
  const rows = Array.isArray(agents) ? (agents as { name?: unknown; model?: unknown; spawnedAt?: unknown }[]) : []
  return (name, at) => {
    const mine = rows.filter(r => typeof r.name === 'string' && bareName(r.name) === name && typeof r.model === 'string')
    const before = mine.filter(r => typeof r.spawnedAt === 'number' && r.spawnedAt <= at + 60_000).sort((a, b) => (b.spawnedAt as number) - (a.spawnedAt as number))
    const pick = before[0] ?? (mine.length === 1 ? mine[0] : undefined)
    const family = pick === undefined ? undefined : shortModel(pick.model as string).split(' ')[0]
    return family === 'opus' || family === 'sonnet' || family === 'haiku' || family === 'fable' ? family : undefined
  }
}

export type LaneState = 'running' | 'idle' | 'waiting'
export type AgentState = LaneState | 'stalled' | 'quiet' | 'ended'
export type Segment = { state: LaneState; from: number; holdsClaim: boolean }

export type SceneAgent = {
  name: string
  code?: string
  model?: ModelFamily
  /** Its place in first-seen order: the index of its colour. */
  index: number
  sent: number
  received: number
  /** When it sent each message. */
  sends: number[]
  segments: Segment[]
  /** The file it last edited, wrote or read, as the log's FILE line gives it: `✎ hooks/core.ts`. */
  file?: string
  /** Its last tool call in plain words, as the log's ACT line gives it: `Running npm test`. */
  action?: string
  /** How many tool calls it had made by its latest ACT line. */
  calls?: number
}

export type MessageKind = 'send' | 'receive' | 'idle'

export type SceneMessage = {
  ts: number
  from: string
  to: string
  type?: string
  summary: string
  kind: MessageKind
  /** For a delivery to the lead: whether the lead filter holds it back. */
  held?: boolean
}

export type CardStatus = 'unclaimed' | 'open' | 'building' | 'done' | 'approved' | 'blocked'
export type Card = {
  slice: string
  builders: string[]
  reviewers: { name: string; state?: ReviewState }[]
  others: string[]
  status: CardStatus
  isDuplicate: boolean
  /** The last claim, verdict or report on it. */
  at: number
  /** A path it names, for a link. */
  path?: string
}

/** What a look draws at one moment of a replay: built line by line from the log, never from live state. */
export class Scene {
  readonly agents = new Map<string, SceneAgent>()
  readonly messages: SceneMessage[] = []
  readonly edges = new Map<string, number>()
  readonly wakes: { ts: number; held: boolean }[] = []
  readonly board = new ClaimBoard()
  private readonly cardAt = new Map<string, number>()
  private readonly paths = new Map<string, string>()
  private readonly done = new Map<string, number>()
  /** The seeded team; once set, no other name becomes an agent and lines between non-members are left out. */
  private members: Set<string> | undefined
  startedAt: number | undefined
  now = 0

  constructor(
    private readonly models: (name: string, at: number) => ModelFamily | undefined = () => undefined,
    readonly stallMs = DEFAULT_STALL_MIN * 60_000,
  ) {}

  get delivered(): number {
    return this.wakes.filter(w => !w.held).length
  }

  get held(): number {
    return this.wakes.filter(w => w.held).length
  }

  /** The teammates in first-seen order. */
  order(): SceneAgent[] {
    return [...this.agents.values()].sort((a, b) => a.index - b.index)
  }

  /** Adds the run's teammates up front, in this order, so the layout holds still while they start. */
  seed(names: readonly string[], at: number) {
    this.startedAt ??= at
    this.members = new Set(names)
    for (const n of names) this.agent(n, at, true)
  }

  /** The agent of a name; a teammate not yet seen is added when `create` (it sent a line), else undefined. */
  private agent(name: string, ts: number, create: boolean): SceneAgent | undefined {
    if (!isTeammateName(name) || (this.members !== undefined && !this.members.has(name))) return undefined
    let a = this.agents.get(name)
    if (a === undefined) {
      if (!create) return undefined
      a = { name, index: this.agents.size, sent: 0, received: 0, sends: [], segments: [] }
      const model = this.models(name, this.startedAt ?? ts)
      if (model !== undefined) a.model = model
      this.agents.set(name, a)
    }
    return a
  }

  private enter(a: SceneAgent, state: LaneState, ts: number) {
    const last = a.segments[a.segments.length - 1]
    if (last?.state === state) return
    a.segments.push({ state, from: ts, holdsClaim: this.board.openClaims(a.name).length > 0 })
  }

  /** Whether a line repeats the previous one of the same sender and text within 3 s (a tool call and its send). */
  private isRepeat(e: LogEntry, from: string, to: string): boolean {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const m = this.messages[i]!
      if (e.ts - m.ts > 3_000) return false
      if (m.kind === 'send' && m.from === from && m.to === to && m.summary === e.summary) return true
    }
    return false
  }

  /** Applies one log line. */
  apply(e: LogEntry) {
    this.startedAt ??= e.ts
    this.now = Math.max(this.now, e.ts)
    const from = bareName(e.from) || e.from
    const to = bareName(e.to) || e.to
    if (this.members !== undefined && !this.members.has(from) && !this.members.has(to)) return
    if (e.type === 'FILE') {
      const a = this.agent(from, e.ts, true)
      if (a !== undefined) {
        a.file = e.summary
        this.enter(a, 'running', e.ts)
      }
      return
    }
    if (e.type === 'ACT') {
      const a = this.agent(from, e.ts, true)
      if (a !== undefined) {
        a.action = e.summary
        a.calls = e.calls ?? (a.calls ?? 0) + 1
        this.enter(a, 'running', e.ts)
      }
      return
    }
    if (isIdleLine(e)) {
      const a = this.agent(from, e.ts, true)
      if (a !== undefined) this.enter(a, 'idle', e.ts)
      if (isLeadAddress(to)) this.wakes.push({ ts: e.ts, held: isHeldFromLead('', { idleReason: e.idleReason }) })
      this.messages.push({ ts: e.ts, from, to, type: 'IDLE', summary: e.idleReason ?? 'idle', kind: 'idle' })
      return
    }
    const isSend = e.via !== 'receive'
    if (isSend && this.isRepeat(e, from, to)) return
    const sender = this.agent(from, e.ts, isSend)
    const receiver = this.agent(to, e.ts, false)
    const type = e.type ?? typeOf(e.summary)
    const m: SceneMessage = { ts: e.ts, from, to, summary: e.summary, kind: isSend ? 'send' : 'receive' }
    if (type !== undefined) m.type = type
    if (isLeadAddress(to) && sender !== undefined) {
      m.held = isHeldFromLead(e.summary, undefined)
      if (isSend || !this.messages.some(x => x.kind === 'send' && x.from === from && isLeadAddress(x.to) && x.summary === e.summary)) this.wakes.push({ ts: e.ts, held: m.held })
    }
    this.messages.push(m)
    if (sender !== undefined) {
      const code = helloName(e.summary) ?? renameName(e.summary)
      if (code !== undefined && isSend) sender.code = code
      this.claims(sender.name, e, isSend)
    }
    if (isSend) {
      if (sender !== undefined) {
        sender.sent++
        sender.sends.push(e.ts)
        this.enter(sender, type === 'WAIT' ? 'waiting' : 'running', e.ts)
      }
      if (receiver !== undefined) receiver.received++
      if ((sender !== undefined || isLeadAddress(from)) && (receiver !== undefined || isLeadAddress(to))) {
        const key = (isLeadAddress(from) ? 'team-lead' : from) + '>' + (isLeadAddress(to) ? 'team-lead' : to)
        this.edges.set(key, (this.edges.get(key) ?? 0) + 1)
      }
    }
  }

  private claims(by: string, e: LogEntry, isSend: boolean) {
    const ref = claimOf(e.summary)
    const touch = (target: string) => {
      const slice = sliceOf(target, this.board.deliverables)
      this.cardAt.set(slice, e.ts)
      const path = /(?:^|\s)((?:\/|~\/|[\w.-]+\/)[\w./-]*\w|[\w-]+\.(?:md|ts|tsx|json|py|sql))\b/.exec(e.summary.replace(/^.*?\[CLAIM\]\s*\S+\s*/i, ''))?.[1]
      if (path !== undefined && !this.paths.has(slice)) this.paths.set(slice, path)
    }
    if (ref !== undefined) {
      const path = ref.role === 'build' ? /(?:^|\s)(\/\S+\/[^\s/]+\.\w+)/.exec(ref.target)?.[1] : undefined
      if (path !== undefined) this.board.addDeliverables([path])
      if (this.board.claim(by, ref, isSend) || isSend) touch(ref.target)
    }
    const verdict = reviewOf(e.summary)
    if (verdict !== undefined && this.board.review(by, verdict)) this.cardAt.set(verdict.slice, e.ts)
    const type = typeOf(e.summary)
    if (type !== undefined && REPORTS.includes(type) && this.board.report(by, type, isSend) && type === 'DONE') this.done.set(by, e.ts)
  }

  /** An agent's state at `t`: its segment then, `stalled` once idle past the stall time while it held a claim, `quiet` before its first line. */
  stateAt(name: string, t = this.now): AgentState {
    const a = this.agents.get(name)
    const seg = a === undefined ? undefined : [...a.segments].reverse().find(s => s.from <= t)
    if (seg === undefined) return 'quiet'
    if (seg.state === 'idle' && seg.holdsClaim && t - seg.from >= this.stallMs) return 'stalled'
    return seg.state
  }

  /** How long, in ms, an agent has been in its state at `t`. */
  stateFor(name: string, t = this.now): number {
    const a = this.agents.get(name)
    const seg = a === undefined ? undefined : [...a.segments].reverse().find(s => s.from <= t)
    return seg === undefined ? 0 : t - seg.from
  }

  /** An agent's code name, with its team name when another agent of the run took the same one; the name itself for anyone else. */
  label(name: string): string {
    const code = this.agents.get(name)?.code
    if (code === undefined) return name
    const clash = [...this.agents.values()].some(a => a.name !== name && a.code?.toLowerCase() === code.toLowerCase())
    return clash ? `${code}·${name}` : code
  }

  /** The claims board: one card per slice, newest activity first. */
  cards(): Card[] {
    const slices = new Map<string, Card>()
    const at = (slice: string): Card => {
      let c = slices.get(slice)
      if (c === undefined) {
        c = { slice, builders: [], reviewers: [], others: [], status: 'open', isDuplicate: false, at: this.cardAt.get(slice) ?? 0 }
        const path = this.paths.get(slice)
        if (path !== undefined) c.path = path
        slices.set(slice, c)
      }
      return c
    }
    const holding = new Map<Card, Set<string>>()
    for (const cl of this.board.all()) {
      const card = at(sliceOf(cl.target, this.board.deliverables))
      const list = cl.role === 'build' ? card.builders : cl.role === 'review' ? undefined : card.others
      for (const b of cl.by) {
        if (list !== undefined && !list.includes(b)) list.push(b)
        if (cl.role === 'build' || cl.role === 'research') {
          const held = holding.get(card) ?? new Set<string>()
          holding.set(card, held)
          if (this.board.isActive(cl, b)) held.add(cl.role + ' ' + b)
        }
        if (cl.role === 'review' && !card.reviewers.some(r => r.name === b)) card.reviewers.push({ name: b })
      }
    }
    for (const [slice, states] of this.board.reviews) {
      const card = at(slice)
      for (const [by, state] of states) {
        const r = card.reviewers.find(x => x.name === by)
        if (r !== undefined) r.state = state
        else if (!card.builders.includes(by)) card.reviewers.push({ name: by, state })
      }
    }
    for (const card of slices.values()) {
      const held = [...(holding.get(card) ?? [])]
      card.isDuplicate = held.filter(h => h.startsWith('build ')).length > 1 || held.filter(h => h.startsWith('research ')).length > 1
      const states = card.reviewers.map(r => r.state)
      if (states.includes('block') || card.isDuplicate) card.status = 'blocked'
      else if (states.includes('approve')) card.status = 'approved'
      else if (card.builders.some(b => (this.done.get(b) ?? 0) >= card.at)) card.status = 'done'
      else if (card.builders.length > 0) card.status = 'building'
      else if (card.reviewers.length === 0 && card.others.length === 0) card.status = 'unclaimed'
    }
    return [...slices.values()].sort((a, b) => b.at - a.at)
  }
}

/** How many of this session's lines the live scene keeps. */
const LIVE_LINES = 5_000

/**
 * The live pane's scene, from this session's lines: built again when its team changes, else fed the lines since. Teams
 * are worked out from the messages alone, kept apart from the FILE lines so a flood of those never pushes a team out.
 */
export class LiveScene {
  private readonly lines: LogEntry[] = []
  private readonly talk: LogEntry[] = []
  private built: { key: string; scene: Scene; applied: number } | undefined
  private teams: { key: string; team: Team | undefined } | undefined

  push(e: LogEntry) {
    if (!isToolLine(e) && !isIdleLine(e)) {
      this.talk.push(e)
      if (this.talk.length > LIVE_LINES) this.talk.splice(0, this.talk.length - LIVE_LINES)
    }
    this.lines.push(e)
    if (this.lines.length > LIVE_LINES) {
      this.lines.splice(0, this.lines.length - LIVE_LINES)
      this.built = undefined
    }
  }

  /** The current team: the latest whose members messaged each other; worked out again when a line or `version` changed. */
  team(isMate: (name: string) => boolean, version = ''): Team | undefined {
    const key = `${this.talk.length}:${this.talk.at(-1)?.ts}:${version}`
    if (this.teams?.key !== key) this.teams = { key, team: teamsOf(this.talk, isMate).at(-1) }
    return this.teams.team
  }

  /** The scene of `names` from `from`, with the lines since applied. */
  scene(names: readonly string[], from: number, models: (name: string, at: number) => ModelFamily | undefined, stallMs: number): Scene {
    const key = `${names.join(',')}@${from}/${stallMs}`
    if (this.built?.key !== key) {
      const scene = new Scene(models, stallMs)
      scene.seed(names, from)
      this.built = { key, scene, applied: 0 }
    }
    const b = this.built
    for (; b.applied < this.lines.length; b.applied++) {
      const e = this.lines[b.applied]!
      if (e.ts >= from) b.scene.apply(e)
    }
    return b.scene
  }
}

/** A short title for a run: its teammates as a range when they share a stem (`r1–r4`), else listed. */
export function runTitle(names: readonly string[]): string {
  const m = names.map(n => /^([a-z-]*?)(\d+)$/.exec(n))
  const stem = m[0]?.[1]
  if (names.length > 1 && m.every(x => x !== null && x[1] === stem)) {
    const nums = m.map(x => Number(x![2])).sort((a, b) => a - b)
    return `${stem}${nums[0]}–${stem}${nums[nums.length - 1]}`
  }
  return names.join(' ')
}

/** The clause a card shows for its slice: the first clause, at most `max` characters. */
export function cardTitle(slice: string, max: number): string {
  const s = clauseOf(slice).replace(/^\/.*\//, '')
  return s.length > max ? s.slice(0, Math.max(1, max - 1)) + '…' : s
}
