import type { AgentSpawnInput, ElementConstructor, EngineInterface, InputProps, On, PluginOptions } from 'claude-code'

import {
  MEMORY_CAP,
  ClaimBoard,
  commandHolder,
  DEFAULT_CLAIM_MIN,
  DEFAULT_STALL_MIN,
  ENDED,
  IDLE_ENDED_H,
  LEAD,
  MOD,
  NUDGE_COOLDOWN_MIN,
  MessageLog,
  REPORTS,
  Roster,
  WAKE_MODES,
  WakePolicy,
  actionOf,
  ago,
  bandText,
  bareName,
  claimAlerts,
  claimOf,
  claimOfLine,
  claimWakeText,
  deliverablesOf,
  fileOf,
  firstLine,
  hydrateClaims,
  hydrateLog,
  idleNotice,
  isLeadAddress,
  isHeldFromLead,
  mentionsTarget,
  targetMatches,
  isStalled,
  jsonl,
  messageText,
  namesText,
  nudgeText,
  openTaskCount,
  paneRows,
  parseLog,
  parseTasks,
  workflowRunOf,
  isWaitDue,
  waitPathOf,
  waitTimeText,
  waitUntilOf,
  waitWakeText,
  reviewOf,
  sameTarget,
  shortModel,
  stallText,
  stampLine,
  timeOfDay,
  typeOf,
  writtenPath,
} from './core'
import type { AgentRow, Claim, ClaimRef, LogEntry, RosterEntry, UnclaimedWorker, Via, Wait, WakeMode } from './core'
import { PANE, COMPOSE_KEY, buttonsOf, isReplaying, setStopAll, liveActivity, ownSky, paneClosed, skyStatus, liveEvent, liveFilter, liveView, renderLive, renderReplay, replayCommand, setLevel, showView } from './pane'
import { setSkyPython } from './sidecar'
import { STOP_ALL_KEY, stopControls, viewControls } from './pane-draw'
import type { LevelSetting, LiveSource } from './pane'
import { LiveScene, isTeammateName, runTitle } from './replay'
import type { ModelFamily, Team } from './replay'

const TICK_MS = 2_000
const LIST_EVERY_TICKS = 2
const TASKS_EVERY_TICKS = 15
const FLUSH_MS = 1_000
const STALE_TURN_MS = 60 * 60_000
const MAX_TASK_FILES = 200
const WAIT_EVERY_TICKS = 5
/** A read of a file the teammate read this recently shows live but writes no FILE line. */
const READ_LOG_MS = 5 * 60_000
/** How long after a swarm's teammate ended its idle notices still count as the swarm's for the lead filter. */
const STOPPED_GRACE_MS = 60_000
/** How long after a teammate's message reached the lead its idle notice is held as a duplicate of that message. */
const REPORT_GRACE_MS = 60_000
/** The least time between two ACT lines of one teammate; a call in between is shown when that time is up. */
const ACT_EVERY_MS = 2_000
/** How long the stand-down toast stays; the default 4 s ends before a lead back from its stop_swarm turn looks. */
const STAND_DOWN_TOAST_MS = 20_000
/** How long a writer is not warned again about the same claimed file. */
const OVERWRITE_WARN_MS = 2 * 60_000
const LEVELS: readonly LevelSetting[] = ['auto', 'basic', 'rich']
/** The tool the lead calls to stop the swarm: `stop_swarm` as the model sees it, `mcp__<plugin>__stop_swarm`. */
const STOP_TOOL = 'stop_swarm'
/** The full name `$.tool.register` gave the stop tool, `mcp__<plugin>__stop_swarm`. */
let stopToolId = 'mcp__agent-swarm__' + STOP_TOOL
const STOP_THEM = 'Stop them'
/** The store key of one session's wake mode, before its session name; the plugin's store is shared by every session. */
const WAKE_KEY = 'wakeMode@'
/** The command's names: `/swarm`, and `/swarmctl` for sessions where another mod also registers `/swarm`. */
const COMMANDS = ['swarm', 'swarmctl'] as const

const roster = new Roster()
const log = new MessageLog()
const policy = new WakePolicy()
const board = new ClaimBoard()
board.isLive = name => !roster.hasTeammate(name) || roster.isLiveTeammate(name)
roster.isHeld = name => waits.has(name) || board.openClaims(name).length > 0

let cwd: string | null = null
let session = ''
let isHydrated = false
let unwritten: LogEntry[] = []
let isFlushScheduled = false
let isRosterDirty = false
let ticks = 0
let lastActivityAt = 0
/** When this load's session started. */
let loadedAt = 0
let stallMin = DEFAULT_STALL_MIN
/** Whether the lead filter holds idle notices and protocol traffic back from the lead. */
let quiet = true
/** When the current team was last seen to be a swarm. */
let swarmSeenAt = -Infinity
/** When each sender's latest message other than an idle notice reached the lead. */
const reachedLeadAt = new Map<string, number>()
/** The team whose end last cleared the claims board, as `@<first peer message>/<latest spawn of its names>`. */
let clearedTeam: string | undefined
/** The status line last pinned, undefined while none is. */
let shownStatus: string | undefined
/** The swarm being watched for its stand-down: its names, start, last peer message, and the lead's wakes and held deliveries when it began. */
let standing: { key: string; names: string[]; from: number; lastPeerAt: number; wakes: number; held: number } | undefined
/** The key of the last swarm whose stand-down was toasted, so a teammate of it restarted later does not toast it again; cleared when a teammate is spawned. */
let stoodDown: string | undefined
let hasStallFired = false
/** The open claims the stall watchdog has nudged, as `<holder> <claim key> <when it was sent>`; a re-sent claim is a new one. */
const nudged = new Set<string>()
/** When the stall watchdog last nudged each teammate, by bare team name. */
const nudgedAt = new Map<string, number>()
let openTasks: number | null = null
let claimMin = DEFAULT_CLAIM_MIN
let sawDoneOrHandoff = false
/** When each teammate last sent a `[DONE]`, to anyone, by bare team name. */
const doneAt = new Map<string, number>()
/** When each teammate last sent a `[CLAIM]`, by bare team name. */
const claimAt = new Map<string, number>()
const firedClaimAlerts = new Set<string>()
/** When the claim board was last cleared because its team ended; logged claims before it are not replayed. */
let claimsSince = -Infinity
/** Each teammate's latest `[WAIT]`, a path or a time, by bare team name. */
const waits = new Map<string, Wait>()
const openTurns = new Map<string, number>()
/** The plugin holding `/swarm` when this plugin's registration of it was refused. */
let swarmTakenBy: string | undefined
/** Whether the user is still to be asked this session how to live with the other `/swarm`. */
let isConflictAskDue = false
const KEEP_BOTH = "Keep both: I'll use /swarmctl"
const SHOW_REMOVE = 'Show me how to remove the other plugin'
const ASK_AGAIN = 'Ask me again next session'
const sendsBy = new Map<string, number>()
/** The texts of this plugin's own sends still in flight, with how many of each. */
const modSending = new Map<string, number>()
const scene = new LiveScene()
/** The file each teammate last showed, by bare team name. */
const lastFile = new Map<string, string>()
/** When each teammate's read of a file was last logged, by `<name> <shown>`. */
const readLoggedAt = new Map<string, number>()
/** The order stamp of the session's latest teammate-to-teammate send. */
let lastStamp = 0
/** Later claimants already told a target is taken, as `<name> <claim key>`. */
const askedTaken = new Set<string>()
/** Claimants already told a build or research slice is theirs, as `<name> <role> <target>`. */
const ackedClaims = new Set<string>()
/** Releases already applied or answered, as `<name> <claim key>`: a copy of the same release to another teammate is not answered. */
const releasedBy = new Set<string>()
/** The teammates whose leaving is logged (or had ended before this load), by agent id. */
const leftLogged = new Set<string>()
/** Each teammate's tool calls, by bare team name: how many, when its last ACT line went out, and the one waiting to. */
const acts = new Map<string, { calls: number; at: number; pending?: LogEntry }>()
/** The transcript tail shown for the agent the live pane is filtered to, by agent id: when it was read and its lines. */
const transcripts = new Map<string, { at: number; lines: string[] }>()
/** Transcripts being read now, by agent id. */
const readingTranscript = new Set<string>()
/** How many transcript lines the live pane shows under the stage. */
const TRANSCRIPT_LINES = 6
/** How long a shown transcript stands before it is read again. */
const TRANSCRIPT_MS = 2_000
/** When each writer was last warned about each claimed file, by `<writer> <path>`. */
const warnedWrite = new Map<string, number>()

/** Whether a name can be a teammate's: a teammate the roster knows, or a name it knows no agent by. */
function isMate(name: string): boolean {
  return roster.hasTeammate(name) || ![...roster.agents.values()].some(a => bareName(a.name) === name)
}

/** What the team rules read from the roster: each agent's name, teammate flag, status and spawn. */
function rosterVersion(): string {
  let out = ''
  for (const a of roster.agents.values()) out += a.name + (a.isTeammate ? '+' : '-') + a.status + (a.spawnedAt ?? '') + ';'
  return out
}

/** Whether every teammate going by `name` had ended at `at`; false when none goes by it or one is live. */
function wasStoppedAt(name: string, at: number): boolean {
  const mates = [...roster.agents.values()].filter(a => a.isTeammate && bareName(a.name) === name)
  return mates.length > 0 && mates.every(a => ENDED.includes(a.status) && (a.statusAt ?? -Infinity) <= at)
}

/**
 * Whether a teammate joins a team on a peer line it receives at `at`: not when it had stopped by then, nor when it was
 * dormant: started over `IDLE_ENDED_H` hours before and without a message of its own in those hours.
 */
function canJoinByReceiving(name: string, at: number): boolean {
  if (wasStoppedAt(name, at)) return false
  const started = roster.startedAt(name)
  const window = IDLE_ENDED_H * 3_600_000
  return started === undefined || at - started <= window || (roster.lastMessageAt.get(name) ?? -Infinity) >= at - window
}

/** Whether a teammate going by `name` had started and not yet ended at `at`. */
function wasLiveAt(name: string, at: number): boolean {
  return [...roster.agents.values()].some(a => a.isTeammate && bareName(a.name) === name && (a.spawnedAt ?? a.firstSeenAt ?? -Infinity) <= at
    && (!ENDED.includes(a.status) || (a.statusAt ?? Infinity) > at))
}

/**
 * The current team: the latest whose teammates messaged each other (see `teamsOf`), joined by every teammate spawned after
 * it formed while one of its teammates was live, in spawn order, though it only writes to the lead.
 */
function currentTeam(): Team | undefined {
  const team = scene.team(isMate, rosterVersion(), canJoinByReceiving)
  if (team === undefined) return undefined
  const joiners = [...roster.agents.values()]
    .filter(a => a.isTeammate && a.spawnedAt !== undefined && a.spawnedAt > team.firstAt && !team.names.includes(bareName(a.name))
      && team.names.some(n => wasLiveAt(n, a.spawnedAt!)))
    .sort((a, b) => a.spawnedAt! - b.spawnedAt!)
    .map(a => bareName(a.name))
  return joiners.length === 0 ? team : { ...team, names: [...team.names, ...new Set(joiners)] }
}

/** Whether the current team is a swarm: its teammates have messaged each other and one of them has not ended. */
function isSwarm(): boolean {
  return currentTeam()?.names.some(n => roster.isLiveTeammate(n)) === true
}

/** The latest status of the teammate going by `name` (bare team name), or undefined. */
function statusOf(name: string): string | undefined {
  return [...roster.agents.values()].filter(a => a.isTeammate && bareName(a.name) === name).pop()?.status
}

/** Whether the teammate going by `name` sent a `[DONE]` since its latest spawn and no `[CLAIM]` after it. */
function sentDone(name: string): boolean {
  const spawnedAt = [...roster.agents.values()].filter(a => a.isTeammate && bareName(a.name) === name).pop()?.spawnedAt ?? -Infinity
  const at = doneAt.get(name)
  return at !== undefined && at >= spawnedAt && !((claimAt.get(name) ?? -Infinity) >= at)
}

/**
 * The status line while the current team is a swarm: `◇ swarm 3 live · 1 done`, live counting its teammates that have not
 * ended, done those that sent a `[DONE]` and no `[CLAIM]` after it (live or not), with `· 1 failed` when any failed.
 */
function swarmStatus(): string | undefined {
  if (!isSwarm()) return undefined
  let live = 0
  let done = 0
  let failed = 0
  for (const n of teamNames()) {
    if (roster.isLiveTeammate(n)) live++
    else if (statusOf(n) === 'failed') failed++
    if (sentDone(n)) done++
  }
  return `◇ swarm ${live} live · ${done} done${failed > 0 ? ` · ${failed} failed` : ''}`
}

/** Pins the swarm's status line, or clears it, when it changed. */
function showStatus($: EngineInterface) {
  const text = swarmStatus()
  if (text === shownStatus) return
  shownStatus = text
  $.ui.status(text)
}

/**
 * When a team started: the first spawn of its teammates, each the latest of its name spawned by the team's last activity
 * (a name an earlier swarm used counts from its new spawn, also one spawned after the first peer message), and never later
 * than that first peer message.
 */
function teamStart(team: Team): number {
  const until = lastActivityOf(team.names, team.lastPeerAt)
  const starts = team.names.map(n => {
    const at = [...roster.agents.values()].filter(a => a.isTeammate && bareName(a.name) === n).map(a => a.spawnedAt ?? a.firstSeenAt).filter((t): t is number => t !== undefined && t <= until)
    return at.length > 0 ? Math.max(...at) : team.firstAt
  })
  return Math.min(team.firstAt, ...starts)
}

/**
 * Follows the current swarm and, once its last teammate has ended, toasts its totals once:
 * `swarm stood down: 4 agents · 52 messages · 12m · lead woken 3 (0.8/agent), held 18`; the mod's own messages are not counted.
 * Its time runs from the team's start (see `teamStart`) to its last activity, the span the ENDED header shows as `ran`.
 */
function watchStandDown($: EngineInterface) {
  const team = currentTeam()
  if (isSwarm() && team !== undefined) {
    const key = '@' + team.firstAt
    if (key === stoodDown) return
    if (standing?.key !== key) standing = { key, names: team.names, from: teamStart(team), lastPeerAt: team.lastPeerAt, wakes: policy.wakes, held: policy.held }
    standing.names = team.names
    standing.lastPeerAt = team.lastPeerAt
    return
  }
  const s = standing
  if (s === undefined || s.names.some(n => roster.isLiveTeammate(n))) return
  standing = undefined
  stoodDown = s.key
  const messages = log.entries.filter(e => e.ts >= s.from && e.from !== MOD && (s.names.includes(e.from) || s.names.includes(e.to))).length
  const wakes = policy.wakes - s.wakes
  $.ui.toast(`swarm stood down: ${s.names.length} agents · ${messages} messages · ${ago(lastActivityOf(s.names, s.lastPeerAt) - s.from)} · lead woken ${wakes} (${(wakes / s.names.length).toFixed(1)}/agent), held ${policy.held - s.held}`, { timeoutMs: STAND_DOWN_TOAST_MS })
}

/**
 * The team the pane shows: the current team, unless every one of its teammates has ended and a live teammate outside it is
 * running, pending or waiting, or started after its last peer message; then none, so the live teammates show as a new team.
 */
function shownTeam(): Team | undefined {
  const team = currentTeam()
  if (team === undefined || !isTeamOver()) return team
  const isNew = (a: RosterEntry) => a.isTeammate && !team.names.includes(bareName(a.name)) && !roster.isShownEnded(a)
    && (a.status === 'running' || a.status === 'pending' || a.status === 'waiting' || (roster.startedAt(a.name) ?? -Infinity) > team.lastPeerAt)
  return [...roster.agents.values()].some(isNew) ? undefined : team
}

/** The current team's names: the shown team's, else the teammates that have not ended. */
function teamNames(): string[] {
  const team = shownTeam()
  if (team !== undefined) return team.names
  const names = [...roster.agents.values()].filter(a => a.isTeammate && !roster.isShownEnded(a)).map(a => bareName(a.name))
  return [...new Set(names)]
}

/** The model family of the live agent going by `name`. */
function modelOf(name: string): ModelFamily | undefined {
  const family = shortModel(roster.liveEntry(name)?.model).split(' ')[0]
  return family === 'opus' || family === 'sonnet' || family === 'haiku' || family === 'fable' ? family : undefined
}

/** Whether the current team (the latest whose teammates messaged each other) exists and every one of its teammates has ended. */
function isTeamOver(): boolean {
  const team = currentTeam()
  return team !== undefined && team.names.every(n => roster.hasTeammate(n) && !roster.isLiveTeammate(n))
}

/** The current team's last activity: its last peer message, or a later message or idle notice from one of its teammates. */
function lastActivityOf(names: readonly string[], lastPeerAt: number): number {
  return Math.max(lastPeerAt, ...names.map(n => Math.max(roster.lastMessageAt.get(n) ?? -Infinity, roster.idle.get(n)?.lastAt ?? -Infinity)))
}

/**
 * What the live pane draws: the shown team from its start (see `teamStart`), else the live teammates from their start; a
 * team whose teammates have all ended with its clock held at its last activity.
 */
function liveSource(): LiveSource {
  const team = shownTeam()
  const names = teamNames()
  const starts = names.map(n => roster.startedAt(n)).filter((t): t is number => t !== undefined)
  const from = team !== undefined ? teamStart(team) : starts.length > 0 ? Math.min(...starts) : loadedAt
  const ended = team !== undefined && isTeamOver() ? { endedAt: lastActivityOf(team.names, team.lastPeerAt) } : {}
  return { scene: scene.scene(names, from, modelOf, stallMin * 60_000), title: names.length > 0 ? runTitle(names) : 'no team yet', from, ...ended }
}

function logPath(): string | null {
  return cwd === null ? null : cwd + '/.swarm/log.jsonl'
}

function rosterPath(): string | null {
  return cwd === null ? null : cwd + '/.swarm/roster.json'
}

/** A receiver's bare team name; a code name no agent goes by as its team name is read as the teammate that took it. */
function addressOf(to: string): string {
  const name = bareName(to) || to
  return [...roster.agents.values()].some(a => bareName(a.name) === name) ? name : roster.resolve(name)
}

/** Records one message, queues it for the file and the wake policy, and asks for a redraw. */
async function note($: EngineInterface, m: { from: string; to: string; text: string; via: Via; fromId?: string; toId?: string; stamp?: number }) {
  const ts = await $.clock.now()
  if (roster.announce(m.from, m.text, m.via)) {
    markRosterDirty($)
    const other = roster.clashWith(m.from)
    if (other !== undefined && m.fromId !== undefined && m.via !== 'receive') void tellClash($, bareName(m.from), m.fromId, other)
  }
  roster.noteMessage(m.from, ts)
  const claim = claimOf(m.text)
  const waitPath = waitPathOf(m.text)
  const until = waitUntilOf(m.text)
  if ((waitPath !== undefined || until !== undefined) && m.via !== 'receive' && !isLeadAddress(m.from)) {
    const name = bareName(m.from)
    const since = Math.max(roster.idle.get(name)?.lastAt ?? -Infinity, roster.liveEntry(name)?.spawnedAt ?? -Infinity)
    const prior = waits.get(name)
    const wokenFor = prior?.path === waitPath && prior?.until === until ? prior?.wokenFor : undefined
    waits.set(name, { ...(waitPath === undefined ? { until, since: 0 } : { path: waitPath, since: since > -Infinity ? since : ts }), ...(wokenFor === undefined ? {} : { wokenFor }) })
    markRosterDirty($)
  }
  const entry = log.record({ ...m, from: bareName(m.from) || m.from, to: addressOf(m.to), ts })
  if (!entry) return
  noteClaims($, m, claim, ts)
  if (session) entry.session = session
  if (m.stamp !== undefined) entry.stamp = m.stamp
  if (claim !== undefined && !isLeadAddress(m.from) && bareName(m.from) !== MOD) entry.claim = claim
  if ((entry.type === 'DONE' || entry.type === 'HANDOFF') && !isLeadAddress(entry.from)) sawDoneOrHandoff = true
  if (entry.type === 'DONE') doneAt.set(entry.from, entry.ts)
  if (claim !== undefined) claimAt.set(entry.from, entry.ts)
  lastActivityAt = ts
  hasStallFired = false
  unwritten.push(entry)
  scene.push(entry)
  policy.offer(entry, m.text)
  scheduleFlush($)
  $.ui.invalidate('ui.render')
  void liveEvent($)
  if (entry.from !== entry.to && [entry.from, entry.to].every(n => isTeammateName(n) && isMate(n))) liveActivity($)
}

/**
 * Applies a logged message's claim, release, verdict and report to the claims board, as the looks apply its log line; a
 * delivery of a send already logged applies nothing, so a broadcast `[CLAIM]` taken late never undoes a release. A release
 * also forgets that its sender was told those slices were its, so claiming one again is answered again; a release hands its
 * slices on (see `handOver`), a report never does. A release naming a slice others hold and its sender does not is answered once: it
 * released nothing.
 * A report or review claim that ends its sender's wait on a slice it was told is taken (see `ClaimBoard.isActive`) is answered.
 */
function noteClaims($: EngineInterface, m: { from: string; text: string; via: Via; fromId?: string; stamp?: number }, claim: ClaimRef | undefined, ts: number) {
  if (isLeadAddress(m.from) || bareName(m.from) === MOD) return
  const name = bareName(m.from)
  const waiting = board.openClaims(name).filter(c => askedTaken.has(name + ' ' + c.key))
  if (claim !== undefined) {
    if (board.claim(m.from, claim, m.via !== 'receive', { stamp: m.stamp, at: ts })) markRosterDirty($)
    releasedBy.delete(name + ' ' + claim.role + ' ' + board.canonical(claim).target)
    if (m.via !== 'receive' && m.fromId !== undefined) void tellTaken($, m.from, m.fromId, claim)
  }
  const released = board.releasing(m.from, m.text)
  if (released.length > 0) {
    for (const k of [...ackedClaims]) {
      if (released.some(c => k.startsWith(`${name} ${c.role} `) && sameTarget(k.slice(name.length + c.role.length + 2), c.target))) ackedClaims.delete(k)
    }
    for (const c of released) releasedBy.add(name + ' ' + c.key)
    handOver($, released)
    markRosterDirty($)
  } else if (m.via !== 'receive' && m.fromId !== undefined) {
    for (const c of board.heldByOthers(m.from, m.text)) {
      if (releasedBy.has(name + ' ' + c.key)) continue
      releasedBy.add(name + ' ' + c.key)
      const holder = c.by.find(n => board.isActive(c, n) && board.heldBefore(n, c) === undefined) ?? c.by[0]!
      void sendTo($, m.fromId, name, `[ASK] you hold no ${c.key}: ${opened(holder)}) does. Your release released nothing.`)
    }
  }
  const verdict = reviewOf(m.text)
  if (verdict !== undefined && board.review(m.from, verdict)) markRosterDirty($)
  const type = typeOf(m.text)
  if (type !== undefined && REPORTS.includes(type) && board.report(m.from, type, m.via !== 'receive', m.text)) markRosterDirty($)
  for (const c of waiting) {
    if (released.includes(c) || (claim !== undefined && claim.role !== 'review') || board.openClaims(name).some(o => o.key === c.key) || m.via === 'receive' || m.fromId === undefined) continue
    askedTaken.delete(name + ' ' + c.key)
    void sendTo($, m.fromId, name, `[ASK] you no longer wait for ${c.key}: a report ends a wait. Claim it again to wait.`)
  }
}

/**
 * Tells the claimant who now holds each `released` build or research slice first that it is theirs, once; who was told that
 * slice was taken is forgotten, so a later claim on it is answered again.
 */
function handOver($: EngineInterface, released: readonly Claim[]) {
  for (const c of released) {
    if (c.role !== 'build' && c.role !== 'research') continue
    const next = board.handOff(c)
    const entry = next === undefined ? undefined : roster.liveEntry(next)
    if (next === undefined || entry === undefined || ackedClaims.has(next + ' ' + c.key)) continue
    ackedClaims.add(next + ' ' + c.key)
    for (const k of [...askedTaken]) if (k.endsWith(' ' + c.key)) askedTaken.delete(k)
    void sendTo($, entry.id, next, `${c.key} is yours.`)
  }
}

/** Counts an idle notification and writes it to the log file as `type: "IDLE"`; it is no message and wakes nobody. */
async function noteIdle($: EngineInterface, from: string, to: string, reason: string | undefined, text: string) {
  const ts = await $.clock.now()
  const name = bareName(from) || from
  roster.noteIdle(name, reason, ts)
  const entry: LogEntry = { ts, from: name, to: bareName(to) || to, summary: firstLine(text), length: text.length, type: 'IDLE', via: 'receive' }
  if (reason !== undefined) entry.idleReason = reason
  if (session) entry.session = session
  unwritten.push(entry)
  scene.push(entry)
  markRosterDirty($)
  void liveEvent($)
}

/**
 * Shows a teammate's file tool call on its card when the file changes, and logs it as one `type: "FILE"` line: an edit or
 * write always, a read only when the teammate has not read that file in the last `READ_LOG_MS`.
 */
async function noteFile($: EngineInterface, agentId: string, shown: string) {
  const a = roster.agents.get(agentId)
  if (a === undefined || !a.isTeammate) return
  const name = bareName(a.name)
  if (lastFile.get(name) === shown) return
  lastFile.set(name, shown)
  const ts = await $.clock.now()
  const entry: LogEntry = { ts, from: name, to: '', summary: shown, length: 0, type: 'FILE', via: 'tool' }
  if (session) entry.session = session
  scene.push(entry)
  const key = name + ' ' + shown
  if (!shown.startsWith('◦') || ts - (readLoggedAt.get(key) ?? -Infinity) >= READ_LOG_MS) {
    if (shown.startsWith('◦')) readLoggedAt.set(key, ts)
    unwritten.push(entry)
    scheduleFlush($)
  }
  $.ui.invalidate('ui.render')
}

/**
 * Counts a teammate's tool call and shows it on its card as an ACT line (logged too), at most one per `ACT_EVERY_MS`; a call
 * inside that time waits for its end, the latest one winning.
 */
async function noteAction($: EngineInterface, agentId: string, action: string) {
  const a = roster.agents.get(agentId)
  if (a === undefined || !a.isTeammate) return
  const name = bareName(a.name)
  const ts = await $.clock.now()
  const s = acts.get(name) ?? { calls: 0, at: -Infinity }
  acts.set(name, s)
  s.calls++
  const entry: LogEntry = { ts, from: name, to: '', summary: action, length: 0, type: 'ACT', via: 'tool', calls: s.calls }
  if (session) entry.session = session
  if (ts - s.at >= ACT_EVERY_MS) return sendAction($, s, entry)
  if (s.pending === undefined) {
    $.clock.after(s.at + ACT_EVERY_MS - ts, () => {
      const next = s.pending
      s.pending = undefined
      if (next !== undefined) sendAction($, s, next)
    })
  }
  s.pending = entry
}

/**
 * Logs a refused spawn as one `type: "REFUSED"` line from its spawner (the lead, or the teammate whose loop spawned it) to
 * the agent's name or description, the reason's first line as its summary; look A's message list shows it.
 */
async function noteRefusal($: EngineInterface, e: AgentSpawnInput, deny: string) {
  const parent = e.parentAgentId === undefined ? undefined : roster.agents.get(e.parentAgentId)
  if (e.parentAgentId !== undefined && parent?.isTeammate !== true) return
  const entry: LogEntry = { ts: await $.clock.now(), from: parent === undefined ? LEAD : bareName(parent.name), to: e.name || e.description, summary: firstLine(deny), length: deny.length, type: 'REFUSED', via: 'tool' }
  if (session) entry.session = session
  scene.push(entry)
  unwritten.push(entry)
  scheduleFlush($)
  $.ui.invalidate('ui.render')
}

/** Logs a teammate joining or leaving as one `type: "JOIN"` or `"LEFT"` line; the looks show it, it is no message. */
async function noteMove($: EngineInterface, name: string, type: 'JOIN' | 'LEFT', summary: string) {
  const entry: LogEntry = { ts: await $.clock.now(), from: name, to: '', summary, length: 0, type, via: 'tool' }
  if (session) entry.session = session
  scene.push(entry)
  unwritten.push(entry)
  scheduleFlush($)
  $.ui.invalidate('ui.render')
  void liveEvent($)
}

/** Logs a LEFT line for each teammate that has ended (completed, failed or killed) since its last check. */
async function noteLeaves($: EngineInterface) {
  for (const a of roster.agents.values()) {
    if (!a.isTeammate || !ENDED.includes(a.status) || leftLogged.has(a.id)) continue
    leftLogged.add(a.id)
    await noteMove($, bareName(a.name), 'LEFT', a.status)
  }
}

function sendAction($: EngineInterface, s: { at: number }, entry: LogEntry) {
  s.at = entry.ts
  scene.push(entry)
  unwritten.push(entry)
  scheduleFlush($)
  $.ui.invalidate('ui.render')
}

function scheduleFlush($: EngineInterface) {
  if (isFlushScheduled) return
  isFlushScheduled = true
  $.clock.after(FLUSH_MS, () => {
    isFlushScheduled = false
    void flush($)
  })
}

/** Appends unwritten entries to the JSONL file and rewrites roster.json when it changed. */
async function flush($: EngineInterface) {
  const path = logPath()
  if (path !== null && unwritten.length > 0) {
    const batch = unwritten
    unwritten = []
    try {
      const r = await $.process.run(
        ['/bin/sh', '-c', 'mkdir -p "$(dirname "$1")" && cat >> "$1"', 'swarm-log', path],
        { stdin: jsonl(batch), timeoutMs: 10_000 },
      )
      if (r.exitCode !== 0) $.ui.log('log append failed: ' + r.stderr.trim())
    } catch (err) {
      $.ui.log('log append failed: ' + String(err))
    }
  }
  const rpath = rosterPath()
  if (rpath !== null && isRosterDirty) {
    isRosterDirty = false
    try {
      const json = { ...roster.toJSON(await $.clock.now(), session || undefined), stamp: lastStamp, askedTaken: [...askedTaken], ackedClaims: [...ackedClaims], deliverables: board.deliverables, claims: board.all(), unclaimedTasks: board.unclaimedTasks, firedAlerts: [...firedClaimAlerts], ...(claimsSince > -Infinity ? { claimsSince } : {}), workflows: Object.fromEntries(roster.workflowNames), waits: Object.fromEntries(waits) }
      await $.fs.write(rpath, JSON.stringify(json, null, 2) + '\n')
    } catch (err) {
      $.ui.log('roster write failed: ' + String(err))
    }
  }
}

/** Reads the log file's tail and roster.json once per load, so the pane shows what came before a reload. */
async function hydrate($: EngineInterface) {
  if (isHydrated) return
  isHydrated = true
  const rpath = rosterPath()
  const lpath = logPath()
  try {
    if (rpath !== null && (await $.fs.exists(rpath))) {
      const json = JSON.parse(await $.fs.read(rpath)) as { session?: unknown; stamp?: unknown; askedTaken?: unknown; ackedClaims?: unknown; firedAlerts?: unknown; claimsSince?: unknown; workflows?: unknown; waits?: unknown }
      roster.hydrate(json, session, await $.clock.now())
      for (const a of roster.agents.values()) if (a.isTeammate && ENDED.includes(a.status)) leftLogged.add(a.id)
      if (json.session === session && json.workflows && typeof json.workflows === 'object') {
        for (const [id, name] of Object.entries(json.workflows)) if (typeof name === 'string') roster.workflowNames.set(id, name)
      }
      if (json.session === session) {
        if (typeof json.stamp === 'number') lastStamp = Math.max(lastStamp, json.stamp)
        if (Array.isArray(json.askedTaken)) for (const k of json.askedTaken) if (typeof k === 'string') askedTaken.add(k)
        if (Array.isArray(json.ackedClaims)) for (const k of json.ackedClaims) if (typeof k === 'string') ackedClaims.add(k)
        board.restore(json)
        if (typeof json.claimsSince === 'number') claimsSince = json.claimsSince
        if (Array.isArray(json.firedAlerts)) for (const k of json.firedAlerts) if (typeof k === 'string') firedClaimAlerts.add(k)
        if (json.waits && typeof json.waits === 'object') {
          for (const [n, w] of Object.entries(json.waits as Record<string, Partial<Wait>>)) if ((typeof w?.path === 'string' || typeof w?.until === 'number') && typeof w.since === 'number') waits.set(n, w as Wait)
        }
      }
    }
  } catch (err) {
    $.ui.log('roster read failed: ' + String(err))
  }
  try {
    if (lpath !== null && (await $.fs.exists(lpath))) {
      const r = await $.process.run(['tail', '-n', String(MEMORY_CAP), lpath], { timeoutMs: 10_000 })
      if (r.exitCode === 0) {
        const lines = parseLog(r.stdout)
        hydrateLog(log, roster, lines, session)
        hydrateClaims(board, lines, session, claimsSince)
        for (const e of lines) if (e.session === session) {
          scene.push(e)
          if (e.type === 'DONE') doneAt.set(e.from, e.ts)
          if (claimOfLine(e) !== undefined) claimAt.set(e.from, e.ts)
          if (typeof e.stamp === 'number') lastStamp = Math.max(lastStamp, e.stamp)
        }
      }
    }
  } catch (err) {
    $.ui.log('log read failed: ' + String(err))
  }
  $.ui.invalidate('ui.render')
}

function markRosterDirty($: EngineInterface) {
  isRosterDirty = true
  scheduleFlush($)
  $.ui.invalidate('ui.render')
}

/** Sets the wake mode and stores it twice: as this session's, which a reload restores, and as `wakeMode`, which a new session starts with. */
async function setWakeMode($: EngineInterface, mode: WakeMode) {
  policy.setMode(mode, await $.clock.now())
  await $.store.set('wakeMode', mode)
  await $.store.set(WAKE_KEY + session, mode)
}

/** Drops the queued messages of a current team whose teammates have all ended, then submits a queued wake when the policy says it is due and the lead is idle. */
async function tryWake($: EngineInterface) {
  const now = await $.clock.now()
  const team = currentTeam()
  if (team !== undefined && isTeamOver()) policy.pending = policy.pending.filter(e => !team.names.includes(e.from))
  const text = policy.due(now, roster.leadBusy)
  if (text === null) return
  submitWake($, text, now)
}

/** Starts a framed plugin prompt without awaiting it: it resolves only once the lead's turn starts. Counted as a wake at `now`, in the band and in the looks. */
function submitWake($: EngineInterface, text: string, now: number) {
  policy.inFlight = true
  policy.wakes++
  scene.wake(now)
  $.prompt.submit({ text }).then(
    () => {
      policy.inFlight = false
    },
    (err: unknown) => {
      policy.inFlight = false
      $.ui.log('wake not submitted: ' + String(err))
    },
  )
}

async function pollAgents($: EngineInterface) {
  try {
    const rows = await $.agent.list()
    const mapped: AgentRow[] = rows.map(r => ({
      id: r.id,
      name: r.name,
      type: r.type,
      status: r.status,
      teammateId: r.teammateId,
      description: r.description,
      parentId: r.parentId,
    }))
    if (roster.merge(mapped, await $.clock.now())) markRosterDirty($)
    await noteLeaves($)
  } catch (err) {
    $.ui.log('agent list failed: ' + String(err))
  }
}

/** Counts open tasks in this session's team task list; null when it cannot be read. */
async function refreshTasks($: EngineInterface) {
  try {
    const configDir = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? ((await $.env.get('HOME')) ?? '') + '/.claude'
    const id = await $.session.id()
    const dir = configDir + '/tasks/session-' + id.slice(0, 8)
    if (!(await $.fs.exists(dir))) {
      openTasks = null
      return
    }
    const files = (await $.fs.list(dir)).filter(f => f.kind === 'file' && f.name.endsWith('.json')).slice(0, MAX_TASK_FILES)
    const texts: string[] = []
    for (const f of files) texts.push(await $.fs.read(dir + '/' + f.name))
    openTasks = openTaskCount(texts)
    board.setTasks(parseTasks(texts), owner => {
      const name = roster.resolve(owner)
      return roster.isLiveTeammate(name) ? name : undefined
    })
  } catch {
    openTasks = null
  }
}

/** The periodic pass: agent status, tasks, stale turns, wakes, the stall watchdog and the clock in the band. */
async function tick($: EngineInterface) {
  ticks++
  const now = await $.clock.now()
  if (isSwarm()) swarmSeenAt = now
  if (ticks % LIST_EVERY_TICKS === 0) await pollAgents($)
  showStatus($)
  watchStandDown($)
  if (ticks % TASKS_EVERY_TICKS === 1) await refreshTasks($)
  for (const [id, at] of openTurns) if (now - at > STALE_TURN_MS) openTurns.delete(id)
  roster.leadBusy = openTurns.size > 0
  if (roster.activeCount() > 0) {
    lastActivityAt = now
    hasStallFired = false
  }
  await tryWake($)
  const openClaims = [...board.claimants()].filter(n => roster.isLiveTeammate(n)).reduce((sum, n) => sum + board.openClaims(n).length, 0)
  const stalled = isSwarm() && isStalled({
    now,
    lastActivityAt,
    stallMs: stallMin * 60_000,
    activeAgents: roster.activeCount(),
    liveAgents: roster.liveCount(),
    openTasks,
    openClaims,
    leadBusy: roster.leadBusy || policy.inFlight,
    alreadyFired: hasStallFired || stallMin <= 0,
  })
  if (stalled) {
    hasStallFired = true
    const nudges = await nudgeClaimHolders($)
    if (nudges.delivered > 0) lastActivityAt = now
    if (nudges.delivered > 0 || nudges.coolingDown > 0) hasStallFired = false
    else submitWake($, stallText(stallMin, openTasks, openClaims), now)
  }
  expireEndedTeam($, now)
  checkClaims($, now)
  checkWorkDone($, now)
  if (ticks % WAIT_EVERY_TICKS === 0) await checkWaits($)
  if (roster.agents.size > 0 || log.total > 0) $.ui.invalidate('ui.render')
}

/** The band's line: counts, wake mode, then the current team's announced code names. */
function bandLine(now: number): string {
  const names = namesText(roster, teamNames())
  const dup = board.duplicates().map(c => c.target || c.role)
  const missing = sawDoneOrHandoff || board.deliverables.length > 0 ? board.missingBuilders() : []
  const warn = [...(missing.length ? ['no builder: ' + missing.join(', ')] : []), ...(dup.length ? ['dup claim: ' + dup.join(', ')] : [])]
  return `${bandText(roster, log, now)} · wake: ${policy.mode} · wakes ${policy.wakes} · held ${policy.held}${warn.length ? ' · ⚠ ' + warn.join(' · ') : ''}${names ? ' · ' + names : ''}`
}

/**
 * Teammates that are running or have sent a message, hold no claim, sent no `[CLAIM]` since their spawn (one released
 * since counts as claimed), and have not ended, each with when it started.
 */
function unclaimedWorkers(): UnclaimedWorker[] {
  const claimants = board.claimants()
  const out: UnclaimedWorker[] = []
  for (const a of roster.agents.values()) {
    if (!a.isTeammate || ENDED.includes(a.status)) continue
    const name = bareName(a.name)
    const working = a.status === 'running' || (log.sent.get(name) ?? 0) > 0
    const claimedAt = claimAt.get(name)
    const hasClaimed = claimants.has(name) || (claimedAt !== undefined && claimedAt >= (a.spawnedAt ?? -Infinity))
    if (working && !hasClaimed) out.push({ label: roster.label(a.name), startedAt: roster.startedAt(a.name) })
  }
  return out
}

/**
 * Once every teammate has ended, or once every teammate of the current team has (once per team), clears the claims,
 * verdicts, deliverables, nudges, waits and fired alerts.
 */
function expireEndedTeam($: EngineInterface, now: number) {
  const team = currentTeam()
  const key = team === undefined ? undefined : `@${team.firstAt}/${Math.max(...[...roster.agents.values()].filter(a => a.isTeammate && team.names.includes(bareName(a.name))).map(a => a.spawnedAt ?? 0))}`
  const teamOver = key !== undefined && key !== clearedTeam && isTeamOver()
  if (teamOver) clearedTeam = key
  if (!board.hasMessageClaims() || !(roster.isTeamEnded() || teamOver)) return
  board.clear()
  askedTaken.clear()
  ackedClaims.clear()
  releasedBy.clear()
  firedClaimAlerts.clear()
  nudged.clear()
  nudgedAt.clear()
  waits.clear()
  sawDoneOrHandoff = false
  claimsSince = now
  markRosterDirty($)
}

/** Wakes the lead once per claim condition, once the team is a swarm; conditions that hold together go out as one wake. */
function checkClaims($: EngineInterface, now: number) {
  if (!isSwarm()) return
  const alerts = claimAlerts({
    now,
    claimMs: claimMin * 60_000,
    sawDoneOrHandoff,
    missingBuilders: board.missingBuilders(),
    unclaimedWorkers: unclaimedWorkers(),
  }).filter(a => !firedClaimAlerts.has(a.key))
  if (alerts.length === 0 || roster.leadBusy || policy.inFlight) return
  for (const a of alerts) firedClaimAlerts.add(a.key)
  markRosterDirty($)
  submitWake($, claimWakeText(alerts, board.deliverables.length > 0), now)
}

/** Whether the `[DONE]` line `e` names `target`, or names none of its sender's build and research claims while one of them is on `target`. */
function doneNames(e: LogEntry, target: string): boolean {
  const subject = e.summary.replace(/^\s*\[DONE\]\s*/i, '')
  if (mentionsTarget(subject, target)) return true
  const mine = board.all().filter(c => c.by.includes(e.from) && (c.role === 'build' || c.role === 'research'))
  return !mine.some(c => mentionsTarget(subject, c.target)) && mine.some(c => targetMatches(c.target, target))
}

/**
 * Wakes the lead once the swarm's work is done: a `[DONE]` from the team names every deliverable (with none declared, every
 * build and research claim), no claim but a review claim is open, no teammate's latest report or review verdict is a `[BLOCK]`, and every live
 * teammate of the current team is idle (an idle notice after its last message). Once per last message (`firedAlerts` in roster.json), so a new claim or message re-arms it.
 */
function checkWorkDone($: EngineInterface, now: number) {
  const team = currentTeam()
  const key = 'work-done@' + log.lastAt
  if (team === undefined || !isSwarm() || firedClaimAlerts.has(key) || roster.leadBusy || policy.inFlight) return
  if (team.names.some(n => roster.isLiveTeammate(n) && (roster.idleSince(n) === undefined || board.openClaims(n).some(c => c.role !== 'review')))) return
  if ([...board.reports.values()].some(r => r.type === 'BLOCK') || [...board.reviews.values()].some(s => [...s.values()].includes('block'))) return
  const dones = log.entries.filter(e => e.type === 'DONE' && e.ts >= claimsSince && team.names.includes(e.from))
  const targets = board.deliverables.length > 0 ? board.deliverables : board.all().filter(c => c.role === 'build' || c.role === 'research').map(c => c.target)
  if (targets.length === 0 || !targets.every(t => dones.some(e => doneNames(e, t)))) return
  firedClaimAlerts.add(key)
  markRosterDirty($)
  submitWake($, `swarm: ${board.deliverables.length > 0 ? 'all deliverables' : 'every build and research claim'} done, no open claims or blocks, every teammate idle; start the final review (protocol §3, phase 6) unless it ran, else stop_swarm when you agree.`, now)
}

/**
 * Sends each idle teammate whose `[WAIT]` file changed after it registered the wait `[ASK] <path> changed: …`, once per
 * change, and one whose `[WAIT] until` time came `[ASK] <time> reached: …`.
 */
async function checkWaits($: EngineInterface) {
  for (const [name, w] of waits) {
    const a = roster.liveEntry(name)
    if (a === undefined || !a.isTeammate) continue
    const path = w.path
    const changedAt = path === undefined ? (w.until !== undefined && (await $.clock.now()) >= w.until ? w.until : undefined) : await $.fs.stat(path).then(st => st.mtimeMs, () => undefined)
    if (!isWaitDue(w, roster.idleSince(name), changedAt)) continue
    w.wokenFor = changedAt
    markRosterDirty($)
    await sendTo($, a.id, name, path === undefined ? waitTimeText(w.until!) : waitWakeText(path, await $.fs.read(path).catch(() => '')))
  }
}

/**
 * Sends each live teammate that holds an open claim not yet nudged one `swarm: [ASK] quiet …`, unless it was nudged in the last
 * `NUDGE_COOLDOWN_MIN`; returns how many were delivered and how many such teammates wait out their cooldown.
 */
async function nudgeClaimHolders($: EngineInterface): Promise<{ delivered: number; coolingDown: number }> {
  let delivered = 0
  let coolingDown = 0
  const now = await $.clock.now()
  for (const name of board.claimants()) {
    const a = roster.liveEntry(name)
    if (a === undefined || !a.isTeammate) continue
    const ids = new Map(board.openClaims(name).map(c => [`${name} ${c.key} ${board.sentAt(c.key, name)}`, c]))
    for (const id of ids.keys()) if (nudged.has(id)) ids.delete(id)
    if (ids.size === 0) continue
    if (now - (nudgedAt.get(name) ?? -Infinity) < NUDGE_COOLDOWN_MIN * 60_000) {
      coolingDown++
      continue
    }
    if (!(await sendTo($, a.id, name, nudgeText(stallMin, [...ids.values()], board.reports, n => roster.label(n))))) continue
    for (const id of ids.keys()) nudged.add(id)
    nudgedAt.set(name, now)
    delivered++
  }
  return { delivered, coolingDown }
}

/** What starts each of this plugin's own messages to a teammate, so its recipient does not read it as the lead's. */
const MOD_PREFIX = MOD + ': '

/**
 * Sends one message from this plugin to an agent, `swarm: ` before it, and logs it as from `swarm`; returns whether it
 * was delivered. A failure is logged, never thrown.
 */
async function sendTo($: EngineInterface, agentId: string, name: string, body: string): Promise<boolean> {
  const text = MOD_PREFIX + body
  modSending.set(text, (modSending.get(text) ?? 0) + 1)
  try {
    const r = await $.session.send({ to: { agentId }, text }).finally(() => {
      const n = (modSending.get(text) ?? 1) - 1
      if (n > 0) modSending.set(text, n)
      else modSending.delete(text)
    })
    const entry = log.record({ ts: await $.clock.now(), from: MOD, to: name, text, via: 'send' })
    if (entry !== undefined) {
      if (session) entry.session = session
      unwritten.push(entry)
      scene.push(entry)
      scheduleFlush($)
    }
    if (!r.isDelivered) $.ui.log(`message to ${name} not delivered: ${r.reason}`)
    return r.isDelivered
  } catch (err) {
    $.ui.log(`message to ${name} failed: ` + String(err))
    return false
  }
}

/** What `/swarm say` and the pane's compose field send: `text` to the live agent `who` names; the answer in one line. */
async function sayTo($: EngineInterface, who: string, text: string): Promise<string> {
  const name = roster.resolve(who)
  const a = roster.liveEntry(name)
  if (a === undefined) return `no live agent goes by ${who}`
  return (await sendTo($, a.id, name, 'the user says: ' + text)) ? `sent to ${roster.label(name)}` : `not delivered to ${roster.label(name)}`
}

/** One transcript message as pane lines: `› ` and the user's first line, `‹ ` and the agent's, `· <tool>` per tool call. */
function transcriptLines(m: { role: string; text: string; toolUses: readonly { tool: string }[] }): string[] {
  const first = m.text.trim().split('\n')[0] ?? ''
  return [...(first === '' ? [] : [(m.role === 'user' ? '› ' : '‹ ') + first]), ...m.toolUses.map(t => '· ' + t.tool)]
}

/** Reads an agent's transcript into `transcripts`, its last `TRANSCRIPT_LINES` lines, and redraws when they changed. */
async function readTranscript($: EngineInterface, agentId: string) {
  if (readingTranscript.has(agentId)) return
  readingTranscript.add(agentId)
  try {
    let lines: string[]
    try {
      const found = await $.session.messages({ agentId })
      lines = 'deny' in found ? ['transcript not readable: ' + found.deny] : found.flatMap(transcriptLines).slice(-TRANSCRIPT_LINES)
    } catch (err) {
      lines = ['transcript not readable: ' + String(err)]
    }
    const prior = transcripts.get(agentId)
    transcripts.set(agentId, { at: await $.clock.now(), lines })
    if (prior?.lines.join('\n') !== lines.join('\n')) $.ui.invalidate('ui.render')
  } finally {
    readingTranscript.delete(agentId)
  }
}

/** A teammate as `<code name> (<team name>`, or `<team name> (<team name>` without a code name, for the mod's asks. */
function opened(name: string): string {
  return `${roster.codeNames.get(name) ?? name} (${name}`
}

/** Tells a teammate whose new code name another teammate already uses to send a hello with another one. */
async function tellClash($: EngineInterface, name: string, agentId: string, other: string) {
  await sendTo($, agentId, name, `[ASK] code name ${roster.codeNames.get(name)} is already used by ${opened(other)}). Send a first-line \`[PROPOSE] hello <other name>\` to every teammate to take another.`)
}

/**
 * Answers a build or research claim once: the first claimant hears the slice is its, once however it spells the target; a later claimant who already holds
 * it and up to 3 unclaimed slices; nothing is refused.
 */
async function tellTaken($: EngineInterface, by: string, agentId: string, claim: ClaimRef) {
  const name = bareName(by)
  const held = board.heldBefore(name, claim)
  if (held === undefined) {
    const key = name + ' ' + claim.role + ' ' + board.canonical(claim).target
    if (claim.role === 'review' || ackedClaims.has(key)) return
    ackedClaims.add(key)
    markRosterDirty($)
    await sendTo($, agentId, name, `${claim.role} ${claim.target} is yours.`)
    return
  }
  if (askedTaken.has(name + ' ' + held.key)) return
  askedTaken.add(name + ' ' + held.key)
  markRosterDirty($)
  const since = held.at === undefined ? '' : ', since ' + timeOfDay(held.at)
  const stamp = held.stamp === undefined ? '' : `, #${held.stamp}`
  const free = board.unclaimed().slice(0, 3)
  await sendTo($, agentId, name, `[ASK] ${claim.target} is already claimed by ${opened(held.holder)}${since}${stamp}). Talk to them, split it, or pick another slice${free.length > 0 ? ': ' + free.join(', ') : ''}.\nIf you wait instead, the mod tells you when it passes to you.`)
}

/**
 * After a teammate wrote a file other live teammates hold a build claim on and it does not: tells the writer and, as a
 * copy, the first holder, at most once per writer and file per `OVERWRITE_WARN_MS`. The write itself is never refused.
 */
async function warnOverwrite($: EngineInterface, agentId: string, path: string) {
  const a = roster.agents.get(agentId)
  if (a === undefined || !a.isTeammate) return
  const writer = bareName(a.name)
  const claims = board.all().filter(c => c.role === 'build' && sameTarget(c.target, path))
  if (claims.some(c => c.by.includes(writer))) return
  const holder = claims.flatMap(c => c.by).find(h => roster.isLiveTeammate(h))
  if (holder === undefined) return
  const now = await $.clock.now()
  const key = writer + ' ' + path
  if (now - (warnedWrite.get(key) ?? -Infinity) < OVERWRITE_WARN_MS) return
  warnedWrite.set(key, now)
  await sendTo($, agentId, writer, `[ASK] you wrote ${path}, claimed by ${opened(holder)}). Settle it with them.`)
  const owner = roster.liveEntry(holder)
  if (owner !== undefined) await sendTo($, owner.id, holder, `[ASK] ${opened(writer)}) wrote ${path}, which you claimed. Settle it with them.`)
}

/** Records the deliverables a brief names and redraws when one is new. */
function noteDeliverables($: EngineInterface, list: readonly string[]) {
  if (board.addDeliverables(list)) markRosterDirty($)
}

/** Asks once, while the lead is not mid-turn, how to live with the plugin holding `/swarm`; `Keep both` is stored, a dismissed or `-p` ask stores nothing. */
async function askConflict($: EngineInterface) {
  if (!isConflictAskDue || roster.leadBusy || swarmTakenBy === undefined) return
  isConflictAskDue = false
  const answer = await $.ui.ask(`Another plugin (${swarmTakenBy}) already uses /swarm. How do you want to use this one?`, [KEEP_BOTH, SHOW_REMOVE, ASK_AGAIN]).catch(() => undefined)
  if (answer === KEEP_BOTH) await $.store.set('swarmConflict', 'keep')
  if (answer !== SHOW_REMOVE) return
  const enabled = (await $.settings.read().catch(() => ({}))) as { enabledPlugins?: Record<string, unknown> }
  const id = Object.keys(enabled.enabledPlugins ?? {}).find(k => k.startsWith(swarmTakenBy + '@'))
  $.ui.toast(`To remove ${swarmTakenBy}: ${id === undefined ? '/plugin, then uninstall it there' : '/plugin uninstall ' + id}, and restart Claude Code afterwards.`, { timeoutMs: 20_000 })
}

/** This session's live teammates: agents spawned as teammates that have not ended; never a subagent, never a workflow's agent. */
function liveTeammates(): RosterEntry[] {
  return [...roster.agents.values()].filter(a => a.isTeammate && a.workflowRunId === undefined && !ENDED.includes(a.status))
}

/**
 * Stops live teammates with TaskStop, through the permission check like any tool call: every live teammate, or those
 * `names` gives (team or code names). Never a subagent that is not a teammate. Each stopped one is marked killed at once,
 * so the team shows as ended. Returns one line per name, `stopped` or `failed` with the reason.
 */
async function stopTeammates($: EngineInterface, names?: readonly string[]): Promise<{ stopped: string[]; failed: { name: string; reason: string }[] }> {
  const live = liveTeammates()
  const out = { stopped: [] as string[], failed: [] as { name: string; reason: string }[] }
  const targets: RosterEntry[] = []
  for (const n of names ?? live.map(a => a.name)) {
    const name = roster.resolve(n)
    const a = live.find(x => bareName(x.name) === name)
    if (a === undefined) out.failed.push({ name: n, reason: roster.hasTeammate(name) ? 'already ended' : 'no teammate of this session goes by that name' })
    else if (!targets.includes(a)) targets.push(a)
  }
  for (const a of targets) {
    try {
      const r = (await $.tool.call({ tool: 'TaskStop', task_id: a.name } as never)) as { deny?: string; isError?: boolean; text?: string }
      if (r.deny !== undefined) out.failed.push({ name: a.name, reason: r.deny })
      else if (r.isError === true) out.failed.push({ name: a.name, reason: r.text ?? 'TaskStop failed' })
      else {
        out.stopped.push(a.name)
        roster.agents.set(a.id, { ...a, status: 'killed', statusAt: await $.clock.now() })
      }
    } catch (err) {
      out.failed.push({ name: a.name, reason: String(err) })
    }
  }
  if (out.stopped.length > 0) markRosterDirty($)
  await noteLeaves($)
  return out
}

/** A stop's outcome in one line: `stopped h01, h02 · failed h03 (denied)`, or that no live teammate was there. */
function stopText(r: { stopped: string[]; failed: { name: string; reason: string }[] }): string {
  const parts = [...(r.stopped.length > 0 ? [`stopped ${r.stopped.map(n => roster.label(n)).join(', ')}`] : []), ...(r.failed.length > 0 ? [`failed ${r.failed.map(f => `${f.name} (${f.reason})`).join(', ')}`] : [])]
  return parts.length > 0 ? 'swarm: ' + parts.join(' · ') : 'swarm: no live teammate to stop'
}

/** The pane's `[ stop all ]`: asks once, then stops every live teammate and toasts the outcome. */
async function confirmStopAll($: EngineInterface) {
  const live = liveTeammates()
  if (live.length === 0) return $.ui.toast('swarm: no live teammate to stop')
  const answer = await $.ui.ask(`Stop all ${live.length} live teammate${live.length === 1 ? '' : 's'} (${live.map(a => roster.label(a.name)).join(', ')})?`, [STOP_THEM, 'Cancel']).catch(() => undefined)
  if (answer !== STOP_THEM) return
  $.ui.toast(stopText(await stopTeammates($)))
  $.ui.invalidate('ui.render')
}

function statusText(now: number): string {
  const tasks = openTasks === null ? 'unknown' : String(openTasks)
  return `${swarmTakenBy === undefined ? '' : `/swarm is taken by ${swarmTakenBy}; use /swarmctl · `}${bandLine(now)} · swarm: ${isSwarm() ? 'yes' : 'no'} · sky renderer: ${skyStatus()} · quiet: ${quiet ? 'on' : 'off'} · stall: ${stallMin} min · claim watch: ${claimMin} min · open tasks: ${tasks} · log: ${logPath() ?? '(no cwd)'}`
}

export function register(on: On, options: PluginOptions) {
  setSkyPython(typeof options.skyPython === 'string' ? options.skyPython : '')
  on('session.start', async ($, e, next) => {
    try {
      cwd = await $.session.cwd()
      session = 'session-' + (await $.session.id()).slice(0, 8)
      await hydrate($)
      const now = await $.clock.now()
      lastActivityAt = now
      loadedAt = now
      const savedMode = (await $.store.get(WAKE_KEY + session)) ?? (await $.store.get('wakeMode'))
      if (typeof savedMode === 'string' && (WAKE_MODES as readonly string[]).includes(savedMode)) policy.setMode(savedMode as WakeMode, now)
      else policy.setMode('mentions', now)
      const savedStall = await $.store.get('stallMin')
      if (typeof savedStall === 'number' && savedStall >= 0) stallMin = savedStall
      const savedQuiet = await $.store.get('quiet')
      if (typeof savedQuiet === 'boolean') quiet = savedQuiet
      const savedClaim = await $.store.get('claimMin')
      if (typeof savedClaim === 'number' && savedClaim >= 0) claimMin = savedClaim
      const savedLevel = await $.store.get('level')
      if (typeof savedLevel === 'string' && (LEVELS as readonly string[]).includes(savedLevel)) setLevel(savedLevel as LevelSetting)
      $.clock.every(TICK_MS, () => {
        void tick($)
      })
      ownSky($)
      setStopAll(() => confirmStopAll($))
      await $.tool.register({
        name: STOP_TOOL,
        description: 'Stops the swarm: every live teammate of this session (agents spawned as teammates; never other subagents), or only the teammates `names` lists (team or code names), each with TaskStop. Call it once when the swarm\'s work is done (every [DONE] in, no open [BLOCK]) and before you spawn a new swarm. Returns which teammates stopped and which failed, with the reason.',
        inputSchema: { type: 'object', properties: { names: { type: 'array', items: { type: 'string' }, description: 'Teammates to stop; leave out to stop every live teammate.' } } },
        isDeferred: false,
      }).then(r => {
        stopToolId = r.tool
      }, (err: unknown) => $.ui.log('swarm: stop_swarm not registered: ' + String(err)))
      for (const name of COMMANDS) {
        await $.command.register({
          name,
          description: (swarmTakenBy === undefined ? '' : `/swarm is taken by ${swarmTakenBy}; use /swarmctl. `) + 'Swarm: open the pane, or set wake all|mentions|digest|off, quiet on|off, stall <min>, claim <min>, level auto|basic|rich, deliverable <path>, status; stop all|<name> stops teammates; say <agent> <text> messages an agent; replay <log.jsonl> plays a recorded run',
          argumentHint: '[wake all|mentions|digest|off | quiet on|off | stall <min> | claim <min> | level auto|basic|rich | deliverable <path> | status | stop all|<name> | say <agent> <text> | replay <log.jsonl> [--speed N] [--look A|B] [--level basic|rich] [--from <ISO>] [--to <ISO>] | replay stop]',
          immediate: true,
        }).catch((err: unknown) => {
          if (name === 'swarm') swarmTakenBy = commandHolder(err instanceof Error ? err.message : String(err))
          $.ui.log(`swarm: /${name} not registered: ${String(err)}`)
        })
      }
      isConflictAskDue = swarmTakenBy !== undefined && e.isInteractive && (await $.store.get('swarmConflict')) !== 'keep'
      if (isConflictAskDue) $.clock.after(1_000, () => void askConflict($).catch(() => undefined))
    } catch (err) {
      $.ui.log('swarm start: ' + String(err))
    }
    return next(e)
  })

  on('tool.call', { tool: /^mcp__.+__stop_swarm$/ }, async ($, e, next) => {
    if (e.tool !== stopToolId) return next(e)
    if (e.agentId !== undefined) return { result: "stop_swarm is the lead's: ask the lead to stop the swarm" } as never
    try {
      const names = (e as unknown as { names?: unknown }).names
      const list = Array.isArray(names) ? names.filter((n): n is string => typeof n === 'string' && n.trim() !== '') : []
      return { result: stopText(await stopTeammates($, list.length > 0 ? list : undefined)) } as never
    } catch (err) {
      $.ui.log('swarm stop_swarm: ' + String(err))
      return { result: 'swarm: stop_swarm failed; stop each teammate by name with TaskStop' } as never
    }
  })

  on('tool.call', { tool: 'SendMessage' }, async ($, e, next) => {
    const key = e.agentId ?? 'main'
    const before = sendsBy.get(key) ?? 0
    const result = await next(e)
    try {
      const refused = typeof result === 'object' && result !== null && 'deny' in result && result.deny !== undefined
      const input = e as unknown as { to?: unknown; message?: unknown }
      if (!refused && (sendsBy.get(key) ?? 0) === before && !modSending.has(messageText(input.message))) {
        await note($, {
          from: roster.nameOf(e.agentId),
          to: String(input.to ?? '?'),
          text: messageText(input.message),
          via: 'tool',
          fromId: e.agentId,
        })
      }
    } catch (err) {
      $.ui.log('swarm tool.call: ' + String(err))
    }
    return result
  }).catch(async ($, e, next) => next(e))

  on('tool.call', { tool: 'Workflow' }, async ($, e, next) => {
    const result = await next(e)
    try {
      const run = workflowRunOf(e, result)
      if (run !== undefined && roster.workflowNames.get(run.runId) !== run.name) {
        roster.workflowNames.set(run.runId, run.name)
        markRosterDirty($)
      }
    } catch (err) {
      $.ui.log('swarm Workflow call: ' + String(err))
    }
    return result
  }).catch(async ($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    try {
      const shown = e.agentId === undefined ? undefined : fileOf(e.tool, e, cwd)
      const refused = typeof result === 'object' && result !== null && 'deny' in result && result.deny !== undefined
      if (shown !== undefined && !refused) await noteFile($, e.agentId!, shown)
      if (e.agentId !== undefined && !refused) await noteAction($, e.agentId, actionOf(e.tool, e, cwd))
      const written = e.agentId === undefined || refused ? undefined : writtenPath(e.tool, e)
      if (written !== undefined) await warnOverwrite($, e.agentId!, written)
    } catch (err) {
      $.ui.log('swarm file call: ' + String(err))
    }
    return result
  }).catch(async ($, e, next) => next(e))

  on('session.send', async ($, e, next) => {
    let sent = e
    try {
      const key = e.agentId ?? 'main'
      sendsBy.set(key, (sendsBy.get(key) ?? 0) + 1)
      const isPeer = e.origin?.kind !== 'plugin' && e.agentId !== undefined && roster.agents.get(e.agentId)?.isTeammate === true && !isLeadAddress(e.to) && e.to.trim() !== '*' && bareName(e.to) !== MOD
      const stamp = isPeer ? ++lastStamp : undefined
      await note($, { from: roster.nameOf(e.agentId), to: e.to, text: e.text, via: 'send', fromId: e.agentId, ...(stamp === undefined ? {} : { stamp }) })
      if (stamp !== undefined) {
        markRosterDirty($)
        sent = { ...e, text: stampLine(stamp, await $.clock.now()) + '\n' + e.text }
      }
      if (e.agentId !== undefined && isLeadAddress(e.to) && typeOf(e.text) === 'WAIT') {
        const path = waitPathOf(e.text)
        const until = waitUntilOf(e.text)
        if (path === undefined && until === undefined) return { isDelivered: false, reason: `${MOD} could not read your [WAIT]: use an absolute path (e.g. [WAIT] /abs/dir/out.json) or until <ISO-8601 time> (e.g. [WAIT] until 2026-10-14T09:30:00Z).` }
        return { isDelivered: false, reason: `${MOD} registered your wait and kept it from the lead; you get [ASK] ${path === undefined ? new Date(until!).toISOString() + ' reached' : path + ' changed'}: … once it ${path === undefined ? 'comes' : 'changes'} while you are idle.` }
      }
    } catch (err) {
      $.ui.log('swarm session.send: ' + String(err))
    }
    return next(sent)
  }).catch(async ($, e, next) => next(e))

  on('session.receive', async ($, e, next) => {
    try {
      const o = e.origin
      if (o.kind === 'peer' || o.kind === 'coordinator' || o.kind === 'peer-send-message') {
        const from = 'teammate' in o ? o.teammate : o.kind === 'coordinator' ? LEAD : 'peer'
        const idle = idleNotice(e.text)
        if (idle !== undefined) await noteIdle($, idle.from ?? from, roster.nameOf(e.agentId), idle.idleReason, e.text)
        else await note($, { from, to: roster.nameOf(e.agentId), text: e.text, via: 'receive', toId: e.agentId })
        if (e.agentId === undefined) {
          $.ui.invalidate('ui.render')
          const now = await $.clock.now()
          if (isSwarm()) swarmSeenAt = now
          const sender = roster.liveEntry(idle?.from ?? from)
          const fromSwarm = isSwarm() && sender?.isTeammate === true && !roster.isOther(sender, now)
          const fromStopped = idle !== undefined && now - swarmSeenAt < STOPPED_GRACE_MS && roster.hasStoppedSince(idle.from ?? from, now - STOPPED_GRACE_MS)
          const afterReport = idle !== undefined && now - (reachedLeadAt.get(idle.from ?? from) ?? -Infinity) < REPORT_GRACE_MS
          const fromEndedTeam = idle !== undefined && isTeamOver() && currentTeam()!.names.includes(bareName(idle.from ?? from))
          if (quiet && (fromSwarm || fromStopped || afterReport || fromEndedTeam) && isHeldFromLead(e.text, idle)) {
            policy.held++
            return { consumed: 'swarm quiet: held from the lead' }
          }
          if (idle === undefined) reachedLeadAt.set(from, now)
          policy.wakes++
        }
      }
    } catch (err) {
      $.ui.log('swarm session.receive: ' + String(err))
    }
    return next(e)
  }).catch(async ($, e, next) => next(e))

  on('agent.spawn', async ($, e, next) => {
    const result = await next(e)
    try {
      if (result.deny !== undefined) await noteRefusal($, e, result.deny)
      const entry = result.deny === undefined ? roster.spawned(e, result, await $.clock.now()) : undefined
      if (entry !== undefined) markRosterDirty($)
      if (entry?.isTeammate === true) await noteMove($, bareName(entry.name), 'JOIN', 'joined')
      if (result.deny === undefined && e.isTeammate === true) noteDeliverables($, deliverablesOf(e.prompt ?? ''))
      if (result.deny === undefined && e.isTeammate === true) {
        stoodDown = undefined
        liveActivity($)
      }
    } catch (err) {
      $.ui.log('swarm agent.spawn: ' + String(err))
    }
    return result
  }).catch(async ($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    openTurns.set(e.turnId, await $.clock.now())
    roster.leadBusy = true
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined && roster.settle(e.agentId, await $.clock.now())) markRosterDirty($)
    if (e.agentId === undefined || openTurns.has(e.turnId)) {
      openTurns.delete(e.turnId)
      roster.leadBusy = openTurns.size > 0
      if (!roster.leadBusy) {
        $.clock.after(250, () => {
          void tryWake($)
          void askConflict($).catch(() => undefined)
        })
      }
    }
    return next(e)
  })

  for (const command of COMMANDS) on('command.run', { command }, async ($, e) => {
    const [verb, arg] = e.args.trim().split(/\s+/)
    if (verb === 'wake') {
      if (arg === undefined || !(WAKE_MODES as readonly string[]).includes(arg)) return { text: 'usage: /swarm wake all|mentions|digest|off' }
      await setWakeMode($, arg as WakeMode)
      $.ui.invalidate('ui.render')
      return { text: 'wake mode: ' + arg }
    }
    if (verb === 'stall') {
      const n = Number(arg)
      if (arg === undefined || !Number.isFinite(n) || n < 0) return { text: 'usage: /swarm stall <minutes>, 0 turns the watchdog off' }
      stallMin = n
      hasStallFired = false
      await $.store.set('stallMin', n)
      return { text: n === 0 ? 'stall watchdog off' : `stall watchdog: ${n} min` }
    }
    if (verb === 'claim') {
      const n = Number(arg)
      if (arg === undefined || !Number.isFinite(n) || n < 0) return { text: 'usage: /swarm claim <minutes>, 0 turns the claim watchdog off' }
      claimMin = n
      await $.store.set('claimMin', n)
      return { text: n === 0 ? 'claim watchdog off' : `claim watchdog: ${n} min` }
    }
    if (verb === 'quiet') {
      if (arg !== 'on' && arg !== 'off') return { text: 'usage: /swarm quiet on|off' }
      quiet = arg === 'on'
      await $.store.set('quiet', quiet)
      return { text: 'lead filter: ' + arg }
    }
    if (verb === 'level') {
      if (arg === undefined || !(LEVELS as readonly string[]).includes(arg)) return { text: 'usage: /swarm level auto|basic|rich' }
      setLevel(arg as LevelSetting)
      await $.store.set('level', arg)
      $.ui.invalidate('ui.render')
      return { text: 'pane level: ' + arg }
    }
    if (verb === 'deliverable') {
      const path = e.args.trim().slice('deliverable'.length).trim()
      if (path === '') return { text: 'usage: /swarm deliverable <path>' }
      noteDeliverables($, [path])
      return { text: 'deliverables: ' + board.deliverables.join(', ') }
    }
    if (verb === 'stop') {
      const rest = e.args.trim().slice('stop'.length).trim()
      if (rest === '') return { text: 'usage: /swarm stop all|<name>' }
      return { text: stopText(await stopTeammates($, rest === 'all' ? undefined : rest.split(/[\s,]+/))) }
    }
    if (verb === 'say') {
      const text = e.args.trim().slice('say'.length).trim().slice((arg ?? '').length).trim()
      if (arg === undefined || text === '') return { text: 'usage: /swarm say <agent> <text>' }
      return { text: await sayTo($, arg, text) }
    }
    if (verb === 'status') return { text: statusText(await $.clock.now()) }
    if (verb === 'replay') return replayCommand($, e.args.trim().slice('replay'.length))
    await $.ui.open({ id: PANE, title: 'swarm', focus: true, closeOnEscape: true })
    return {}
  })

  /** The compose field's last answer and the agent it went to. */
  let composed: { name: string; text: string } | undefined
  /** The compose field's text as typed and the agent it is for, drawn again on every render. */
  let draft = { name: '', text: '' }

  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANE) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const modeButton = (mode: WakeMode, hotkey: string) =>
      Button({
        key: 'wake-' + mode,
        label: mode,
        hotkey,
        plain: true,
        dimColor: policy.mode !== mode,
        onPress: async () => {
          await setWakeMode($, mode)
          $.ui.invalidate('ui.render')
        },
      })
    const wakeRow = (...first: ReturnType<typeof Button>[]) =>
      Box({
        flexDirection: 'row',
        columnGap: 2,
        children: [...first, Text({ dimColor: true, children: ['wake:'] }), modeButton('all', 'a'), modeButton('mentions', 'm'), modeButton('digest', 'd'), modeButton('off', 'o')],
      })
    /** Under the stage while the live pane is filtered to a live agent: a field that messages it, the field's last answer, and its transcript's last lines. */
    const detailRows = async (Input: ElementConstructor<InputProps>) => {
      const name = liveFilter()
      const a = name === undefined ? undefined : roster.liveEntry(name)
      if (name === undefined || a === undefined) return []
      const shown = transcripts.get(a.id)
      if (shown === undefined || (await $.clock.now()) - shown.at > TRANSCRIPT_MS) void readTranscript($, a.id)
      return [
        Input({
          key: COMPOSE_KEY,
          label: `to ${roster.label(name)}:`,
          value: draft.name === name ? draft.text : '',
          submitLabel: 'send',
          onInput: text => {
            draft = { name, text }
          },
          onSubmit: async text => {
            if (text.trim() === '') return
            draft = { name, text: '' }
            composed = { name, text: await sayTo($, name, text.trim()) }
            $.ui.invalidate('ui.render')
          },
        }),
        ...(composed?.name === name ? [Text({ dimColor: true, wrap: 'truncate-end', children: [composed.text] })] : []),
        Text({ dimColor: true, wrap: 'truncate-end', children: [`${roster.label(name)} · transcript`] }),
        ...(shown?.lines ?? []).map(l => Text({ wrap: 'truncate-end', children: [l] })),
      ]
    }
    if (e.surface === 'terminal') {
      if (isReplaying()) {
        const tree = await renderReplay($, e)
        if (tree !== undefined) return tree
      }
      if (liveView() !== 'list') return renderLive($, e, liveSource, [...(await detailRows($.ui.resolve(e).Input)), wakeRow()], liveTeammates().length > 0)
    }
    const now = await $.clock.now()
    const listRows = Math.max(1, e.props.scroll.bodyRows - 2)
    const fixedRows = paneRows(roster, log, policy, now, e.props.bodyColumns, 1, board, stallMin * 60_000).length - 1
    const maxMessages = Math.max(1, Math.min(40, listRows - fixedRows))
    const rows = paneRows(roster, log, policy, now, e.props.bodyColumns, maxMessages, board, stallMin * 60_000).slice(0, listRows)
    const back = e.surface === 'terminal'
      ? buttonsOf($, e, [...viewControls('list', true), ...stopControls(liveTeammates().length > 0)], key => (key === STOP_ALL_KEY ? confirmStopAll($) : showView($, key.slice('view-'.length) as 'A' | 'B' | 'list')))
      : []
    return Box({
      flexDirection: 'column',
      children: [
        ...rows.map(r => Text({ bold: r.bold === true, dimColor: r.dim === true, wrap: 'truncate-end', children: [r.text === '' ? ' ' : r.text] })),
        Text({ children: [' '] }),
        wakeRow(...back),
      ],
    })
  })

  on('ui.close', async ($, e, next) => {
    const result = await next(e)
    try {
      if (e.id === PANE) await paneClosed($)
    } catch (err) {
      $.ui.log('swarm ui.close: ' + String(err))
    }
    return result
  }).catch(async ($, e, next) => next(e))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (roster.agents.size === 0 && log.total === 0)) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const theirs = await next(e)
    const line = Text({ dimColor: true, wrap: 'truncate-end', children: [bandLine(await $.clock.now())] })
    return Box({ flexDirection: 'column', children: [line, theirs] })
  })
}
