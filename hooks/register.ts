import type { EngineInterface, On, PluginOptions } from 'claude-code'

import {
  MEMORY_CAP,
  ClaimBoard,
  commandHolder,
  DEFAULT_CLAIM_MIN,
  DEFAULT_STALL_MIN,
  ENDED,
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
  claimWakeText,
  deliverablesOf,
  fileOf,
  firstLine,
  hydrateClaims,
  hydrateLog,
  idleNotice,
  isLeadAddress,
  isHeldFromLead,
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
  typeOf,
  writtenPath,
} from './core'
import type { AgentRow, ClaimRef, LogEntry, UnclaimedWorker, Via, Wait, WakeMode } from './core'
import { PANE, buttonsOf, isReplaying, liveActivity, ownSky, paneClosed, setSkyMaxDrawMs, skyStatus, liveEvent, liveView, renderLive, renderReplay, replayCommand, setLevel, showView } from './pane'
import { viewControls } from './pane-draw'
import type { LevelSetting, LiveSource } from './pane'
import { LEAD_IN_MS, LiveScene, isTeammateName, runTitle } from './replay'
import type { ModelFamily } from './replay'

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
/** How long a writer is not warned again about the same claimed file. */
const OVERWRITE_WARN_MS = 2 * 60_000
const LEVELS: readonly LevelSetting[] = ['auto', 'basic', 'rich']
/** The command's names: `/swarm`, and `/swarmctl` for sessions where another mod also registers `/swarm`. */
const COMMANDS = ['swarm', 'swarmctl'] as const

const roster = new Roster()
const log = new MessageLog()
const policy = new WakePolicy()
const board = new ClaimBoard()
board.isLive = name => !roster.hasTeammate(name) || roster.isLiveTeammate(name)

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
/** The team whose end last cleared the claims board, as `<names>@<first peer message>`. */
let clearedTeam: string | undefined
/** The status line last pinned, undefined while none is. */
let shownStatus: string | undefined
/** The swarm being watched for its stand-down: its names, start, and the lead's wakes and held deliveries when it began. */
let standing: { key: string; names: string[]; from: number; wakes: number; held: number } | undefined
let hasStallFired = false
/** The open claims the stall watchdog has nudged, as `<holder> <claim key> <when it was sent>`; a re-sent claim is a new one. */
const nudged = new Set<string>()
/** When the stall watchdog last nudged each teammate, by bare team name. */
const nudgedAt = new Map<string, number>()
let openTasks: number | null = null
let claimMin = DEFAULT_CLAIM_MIN
let sawDoneOrHandoff = false
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
const scene = new LiveScene()
/** The file each teammate last showed, by bare team name. */
const lastFile = new Map<string, string>()
/** When each teammate's read of a file was last logged, by `<name> <shown>`. */
const readLoggedAt = new Map<string, number>()
/** The order stamp of the session's latest teammate-to-teammate send. */
let lastStamp = 0
/** Later claimants already told a target is taken, as `<name> <claim key>`. */
const askedTaken = new Set<string>()
/** Each teammate's tool calls, by bare team name: how many, when its last ACT line went out, and the one waiting to. */
const acts = new Map<string, { calls: number; at: number; pending?: LogEntry }>()
/** When each writer was last warned about each claimed file, by `<writer> <path>`. */
const warnedWrite = new Map<string, number>()

/** Whether a name can be a teammate's: a teammate the roster knows, or a name it knows no agent by. */
function isMate(name: string): boolean {
  return roster.hasTeammate(name) || ![...roster.agents.values()].some(a => bareName(a.name) === name)
}

/** What the mate rule reads from the roster: each agent's name and teammate flag. */
function rosterVersion(): string {
  let out = ''
  for (const a of roster.agents.values()) out += a.name + (a.isTeammate ? '+' : '-')
  return out
}

/** Whether the current team is a swarm: its teammates have messaged each other and one of them has not ended. */
function isSwarm(): boolean {
  return scene.team(isMate, rosterVersion())?.names.some(n => roster.isLiveTeammate(n)) === true
}

/** The latest status of the teammate going by `name` (bare team name), or undefined. */
function statusOf(name: string): string | undefined {
  return [...roster.agents.values()].filter(a => a.isTeammate && bareName(a.name) === name).pop()?.status
}

/** The status line while the current team is a swarm: `◇ swarm 3 live · 1 done`, with `· 1 failed` when any failed. */
function swarmStatus(): string | undefined {
  if (!isSwarm()) return undefined
  let live = 0
  let done = 0
  let failed = 0
  for (const n of teamNames()) {
    if (roster.isLiveTeammate(n)) live++
    else if (statusOf(n) === 'failed') failed++
    else done++
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
 * Follows the current swarm and, once its last teammate has ended, toasts its totals once:
 * `swarm stood down: 4 agents · 52 messages · 12m · lead woken 3, held 18`.
 */
function watchStandDown($: EngineInterface, now: number) {
  const team = scene.team(isMate, rosterVersion())
  if (isSwarm() && team !== undefined) {
    const key = team.names.join(',') + '@' + team.firstAt
    if (standing?.key !== key) {
      const starts = team.names.map(n => roster.startedAt(n)).filter((t): t is number => t !== undefined)
      standing = { key, names: team.names, from: Math.min(team.firstAt, ...starts), wakes: policy.wakes, held: policy.held }
    }
    standing.names = team.names
    return
  }
  const s = standing
  if (s === undefined || s.names.some(n => roster.isLiveTeammate(n))) return
  standing = undefined
  const messages = log.entries.filter(e => e.ts >= s.from && (s.names.includes(e.from) || s.names.includes(e.to))).length
  $.ui.toast(`swarm stood down: ${s.names.length} agents · ${messages} messages · ${ago(now - s.from)} · lead woken ${policy.wakes - s.wakes}, held ${policy.held - s.held}`)
}

/** The current team's names: the swarm's, else the teammates that have not ended. */
function teamNames(): string[] {
  const team = scene.team(isMate, rosterVersion())
  if (team !== undefined) return team.names
  const names = [...roster.agents.values()].filter(a => a.isTeammate && !ENDED.includes(a.status)).map(a => bareName(a.name))
  return [...new Set(names)]
}

/** The model family of the live agent going by `name`. */
function modelOf(name: string): ModelFamily | undefined {
  const family = shortModel(roster.liveEntry(name)?.model).split(' ')[0]
  return family === 'opus' || family === 'sonnet' || family === 'haiku' || family === 'fable' ? family : undefined
}

/** Whether the current team (the latest whose teammates messaged each other) exists and every one of its teammates has ended. */
function isTeamOver(): boolean {
  const team = scene.team(isMate, rosterVersion())
  return team !== undefined && team.names.every(n => roster.hasTeammate(n) && !roster.isLiveTeammate(n))
}

/** The current team's last activity: its last peer message, or a later message or idle notice from one of its teammates. */
function lastActivityOf(names: readonly string[], lastPeerAt: number): number {
  return Math.max(lastPeerAt, ...names.map(n => Math.max(roster.lastMessageAt.get(n) ?? -Infinity, roster.idle.get(n)?.lastAt ?? -Infinity)))
}

/**
 * What the live pane draws: the current team from its first peer message (less the lead-in), else the live teammates from
 * their start; a team whose teammates have all ended with its clock held at its last activity.
 */
function liveSource(): LiveSource {
  const team = scene.team(isMate, rosterVersion())
  const names = teamNames()
  const starts = names.map(n => roster.startedAt(n)).filter((t): t is number => t !== undefined)
  const from = team !== undefined ? team.firstAt - LEAD_IN_MS : starts.length > 0 ? Math.min(...starts) : loadedAt
  const ended = team !== undefined && isTeamOver() ? { endedAt: lastActivityOf(team.names, team.lastPeerAt) } : {}
  return { scene: scene.scene(names, from, modelOf, stallMin * 60_000), title: names.length > 0 ? runTitle(names) : 'no team yet', from, ...ended }
}

function logPath(): string | null {
  return cwd === null ? null : cwd + '/.swarm/log.jsonl'
}

function rosterPath(): string | null {
  return cwd === null ? null : cwd + '/.swarm/roster.json'
}

/** Records one message, queues it for the file and the wake policy, and asks for a redraw. */
async function note($: EngineInterface, m: { from: string; to: string; text: string; via: Via; fromId?: string; toId?: string; stamp?: number }) {
  const ts = await $.clock.now()
  if (roster.announce(m.from, m.text, m.via)) markRosterDirty($)
  roster.noteMessage(m.from, ts)
  const claim = claimOf(m.text)
  if (claim !== undefined && !isLeadAddress(m.from) && bareName(m.from) !== MOD) {
    if (board.claim(m.from, claim, m.via !== 'receive', { stamp: m.stamp, at: ts })) markRosterDirty($)
    if (m.via !== 'receive' && m.fromId !== undefined) void tellTaken($, m.from, m.fromId, claim)
  }
  const verdict = reviewOf(m.text)
  if (verdict !== undefined && !isLeadAddress(m.from) && board.review(m.from, verdict)) markRosterDirty($)
  const type = typeOf(m.text)
  if (type !== undefined && REPORTS.includes(type) && !isLeadAddress(m.from) && board.report(m.from, type, m.via !== 'receive')) markRosterDirty($)
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
  const entry = log.record({ ...m, from: bareName(m.from) || m.from, to: bareName(m.to) || m.to, ts })
  if (!entry) return
  if (session) entry.session = session
  if (m.stamp !== undefined) entry.stamp = m.stamp
  if ((entry.type === 'DONE' || entry.type === 'HANDOFF') && !isLeadAddress(entry.from)) sawDoneOrHandoff = true
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
      const json = { ...roster.toJSON(await $.clock.now(), session || undefined), stamp: lastStamp, askedTaken: [...askedTaken], deliverables: board.deliverables, claims: board.all(), unclaimedTasks: board.unclaimedTasks, firedAlerts: [...firedClaimAlerts], ...(claimsSince > -Infinity ? { claimsSince } : {}), workflows: Object.fromEntries(roster.workflowNames), waits: Object.fromEntries(waits) }
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
      const json = JSON.parse(await $.fs.read(rpath)) as { session?: unknown; stamp?: unknown; askedTaken?: unknown; firedAlerts?: unknown; claimsSince?: unknown; workflows?: unknown; waits?: unknown }
      roster.hydrate(json, session, await $.clock.now())
      if (json.session === session && json.workflows && typeof json.workflows === 'object') {
        for (const [id, name] of Object.entries(json.workflows)) if (typeof name === 'string') roster.workflowNames.set(id, name)
      }
      if (json.session === session) {
        if (typeof json.stamp === 'number') lastStamp = Math.max(lastStamp, json.stamp)
        if (Array.isArray(json.askedTaken)) for (const k of json.askedTaken) if (typeof k === 'string') askedTaken.add(k)
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

/** Submits a queued wake when the policy says it is due and the lead is idle. */
async function tryWake($: EngineInterface) {
  const text = policy.due(await $.clock.now(), roster.leadBusy)
  if (text === null) return
  submitWake($, text)
}

/** Starts a framed plugin prompt without awaiting it: it resolves only once the lead's turn starts. */
function submitWake($: EngineInterface, text: string) {
  policy.inFlight = true
  policy.wakes++
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
    }))
    if (roster.merge(mapped, await $.clock.now())) markRosterDirty($)
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
  watchStandDown($, now)
  if (ticks % TASKS_EVERY_TICKS === 1) await refreshTasks($)
  for (const [id, at] of openTurns) if (now - at > STALE_TURN_MS) openTurns.delete(id)
  roster.leadBusy = openTurns.size > 0
  if (roster.activeCount() > 0) {
    lastActivityAt = now
    hasStallFired = false
  }
  await tryWake($)
  const stalled = isSwarm() && isStalled({
    now,
    lastActivityAt,
    stallMs: stallMin * 60_000,
    activeAgents: roster.activeCount(),
    liveAgents: roster.liveCount(),
    openTasks,
    leadBusy: roster.leadBusy || policy.inFlight,
    alreadyFired: hasStallFired || stallMin <= 0,
  })
  if (stalled) {
    hasStallFired = true
    const nudges = await nudgeClaimHolders($)
    if (nudges.delivered > 0) lastActivityAt = now
    if (nudges.delivered > 0 || nudges.coolingDown > 0) hasStallFired = false
    else submitWake($, stallText(stallMin, openTasks))
  }
  expireEndedTeam($, now)
  checkClaims($, now)
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

/** Teammates that are running or have sent a message, hold no claim, and have not ended, each with when it started. */
function unclaimedWorkers(): UnclaimedWorker[] {
  const claimants = board.claimants()
  const out: UnclaimedWorker[] = []
  for (const a of roster.agents.values()) {
    if (!a.isTeammate || ENDED.includes(a.status)) continue
    const name = bareName(a.name)
    const working = a.status === 'running' || (log.sent.get(name) ?? 0) > 0
    if (working && !claimants.has(name)) out.push({ label: roster.label(a.name), startedAt: roster.startedAt(a.name) })
  }
  return out
}

/**
 * Once every teammate has ended, or once every teammate of the current team has (once per team), clears the claims,
 * verdicts, deliverables, nudges, waits and fired alerts.
 */
function expireEndedTeam($: EngineInterface, now: number) {
  const team = scene.team(isMate, rosterVersion())
  const key = team === undefined ? undefined : team.names.join(',') + '@' + team.firstAt
  const teamOver = key !== undefined && key !== clearedTeam && isTeamOver()
  if (teamOver) clearedTeam = key
  if (!board.hasMessageClaims() || !(roster.isTeamEnded() || teamOver)) return
  board.clear()
  askedTaken.clear()
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
  submitWake($, claimWakeText(alerts))
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
 * Sends each live teammate that holds an open claim not yet nudged one `[ASK] swarm quiet …`, unless it was nudged in the last
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

/** Sends one message from this plugin to an agent and logs it as from `swarm`; returns whether it was delivered. A failure is logged, never thrown. */
async function sendTo($: EngineInterface, agentId: string, name: string, text: string): Promise<boolean> {
  try {
    const r = await $.session.send({ to: { agentId }, text })
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

/** A teammate as `<code name> (<team name>`, or `<team name> (<team name>` without a code name, for the mod's asks. */
function opened(name: string): string {
  return `${roster.codeNames.get(name) ?? name} (${name}`
}

/** Tells a later claimant, once per claim, who already holds the build or research target it claimed; nothing is refused. */
async function tellTaken($: EngineInterface, by: string, agentId: string, claim: ClaimRef) {
  const name = bareName(by)
  const held = board.heldBefore(name, claim)
  if (held === undefined || askedTaken.has(name + ' ' + held.key)) return
  askedTaken.add(name + ' ' + held.key)
  markRosterDirty($)
  const since = held.at === undefined ? '' : ', since ' + new Date(held.at).toISOString().slice(11, 19)
  const stamp = held.stamp === undefined ? '' : `, #${held.stamp}`
  await sendTo($, agentId, name, `[ASK] ${claim.target} is already claimed by ${opened(held.holder)}${since}${stamp}). Talk to them, split it, or pick another slice.`)
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

function statusText(now: number): string {
  const tasks = openTasks === null ? 'unknown' : String(openTasks)
  return `${swarmTakenBy === undefined ? '' : `/swarm is taken by ${swarmTakenBy}; use /swarmctl · `}${bandLine(now)} · swarm: ${isSwarm() ? 'yes' : 'no'} · sky renderer: ${skyStatus()} · quiet: ${quiet ? 'on' : 'off'} · stall: ${stallMin} min · claim watch: ${claimMin} min · open tasks: ${tasks} · log: ${logPath() ?? '(no cwd)'}`
}

export function register(on: On, options: PluginOptions) {
  setSkyMaxDrawMs(typeof options.skyMaxDrawMs === 'number' ? options.skyMaxDrawMs : 50)
  on('session.start', async ($, e, next) => {
    try {
      cwd = await $.session.cwd()
      session = 'session-' + (await $.session.id()).slice(0, 8)
      await hydrate($)
      const now = await $.clock.now()
      lastActivityAt = now
      loadedAt = now
      const savedMode = await $.store.get('wakeMode')
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
      for (const name of COMMANDS) {
        await $.command.register({
          name,
          description: (swarmTakenBy === undefined ? '' : `/swarm is taken by ${swarmTakenBy}; use /swarmctl. `) + 'Swarm: open the pane, or set wake all|mentions|digest|off, quiet on|off, stall <min>, claim <min>, level auto|basic|rich, deliverable <path>, status; replay <log.jsonl> plays a recorded run',
          argumentHint: '[wake all|mentions|digest|off | quiet on|off | stall <min> | claim <min> | level auto|basic|rich | deliverable <path> | status | replay <log.jsonl> [--speed N] [--look A|B] [--level basic|rich] [--from <ISO>] [--to <ISO>] | replay stop]',
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

  on('tool.call', { tool: 'SendMessage' }, async ($, e, next) => {
    const key = e.agentId ?? 'main'
    const before = sendsBy.get(key) ?? 0
    const result = await next(e)
    try {
      const refused = typeof result === 'object' && result !== null && 'deny' in result && result.deny !== undefined
      if (!refused && (sendsBy.get(key) ?? 0) === before) {
        const input = e as unknown as { to?: unknown; message?: unknown }
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
          if (quiet && (fromSwarm || fromStopped || afterReport) && isHeldFromLead(e.text, idle)) {
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
      if (result.deny === undefined && roster.spawned(e, result, await $.clock.now())) markRosterDirty($)
      if (result.deny === undefined && e.isTeammate === true) noteDeliverables($, deliverablesOf(e.prompt ?? ''))
      if (result.deny === undefined && e.isTeammate === true) liveActivity($)
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
      policy.setMode(arg as WakeMode, await $.clock.now())
      await $.store.set('wakeMode', arg)
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
    if (verb === 'status') return { text: statusText(await $.clock.now()) }
    if (verb === 'replay') return replayCommand($, e.args.trim().slice('replay'.length))
    await $.ui.open({ id: PANE, title: 'swarm', focus: true, closeOnEscape: true })
    return {}
  })

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
          policy.setMode(mode, await $.clock.now())
          await $.store.set('wakeMode', mode)
          $.ui.invalidate('ui.render')
        },
      })
    const wakeRow = (...first: ReturnType<typeof Button>[]) =>
      Box({
        flexDirection: 'row',
        columnGap: 2,
        children: [...first, Text({ dimColor: true, children: ['wake:'] }), modeButton('all', 'a'), modeButton('mentions', 'm'), modeButton('digest', 'd'), modeButton('off', 'o')],
      })
    if (e.surface === 'terminal') {
      if (isReplaying()) {
        const tree = await renderReplay($, e)
        if (tree !== undefined) return tree
      }
      if (liveView() !== 'list') return renderLive($, e, liveSource, [wakeRow()])
    }
    const now = await $.clock.now()
    const claimRows = board.all().length + board.missingBuilders().length + board.unclaimedTasks.length + 3
    const fixedRows = roster.agents.size + roster.earlier.length + 12 + claimRows
    const maxMessages = Math.max(5, Math.min(40, e.props.scroll.bodyRows - fixedRows))
    const rows = paneRows(roster, log, policy, now, e.props.bodyColumns, maxMessages, board, stallMin * 60_000)
    const back = e.surface === 'terminal'
      ? buttonsOf($, e, viewControls('list', true), key => showView($, key.slice('view-'.length) as 'A' | 'B' | 'list'))
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
