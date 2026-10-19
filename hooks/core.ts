// Pure swarm state: message log, roster, wake policy and the text the pane
// and band draw. No mods API here, so every rule is unit-testable.

export type WakeMode = 'all' | 'mentions' | 'digest' | 'off'
export const WAKE_MODES: readonly WakeMode[] = ['all', 'mentions', 'digest', 'off']

export const LEAD = 'team-lead'
/** The `from` of the messages this plugin sends and logs. */
export const MOD = 'swarm'
/** Whether a logged sender is this plugin: its name, and also the names older logs use. */
export const isModName = (name: string): boolean => name === MOD || name === 'swarm-console'
/** Message types that report on a claim. */
export const REPORTS: readonly string[] = ['DONE', 'REVIEW', 'BLOCK']
export const COALESCE_MS = { all: 10_000, mentions: 3_000 } as const
export const DIGEST_MS = 60_000
/** How many recent sends a delivery is checked against: a delivery reaches a busy receiver only at its next turn or tool round. */
const SEND_MEMORY = 200
export const MEMORY_CAP = 500
export const DEFAULT_STALL_MIN = 5
/** The plugin a refused command registration names as holding the command (`… the plugin <name> registered it already`), else the refusal's text. */
export function commandHolder(refusal: string): string {
  return /the plugin (\S+) registered it/.exec(refusal)?.[1] ?? refusal.replace(/^\w*Error: /, '')
}
export const DEFAULT_CLAIM_MIN = 3
/** Minutes before the stall watchdog nudges the same teammate again. */
export const NUDGE_COOLDOWN_MIN = 10
/** Minutes without a message from its holder after which a claim shows as stale. */
const CLAIM_TTL_MIN = 10
const LABEL_MAX = 28
const EARLIER = '── earlier ──'
export const OTHER_AGENTS = '── other agents ──'
const STALE_MS = 10 * 60_000
/** How many rows the text list shows under `other agents` and under `earlier`, the newest; the rest as `… N more`. */
export const OTHERS_SHOWN = 5
/** Hours a teammate stays idle before the pane and the band show it as ended (see `Roster.isDormant`). */
export const IDLE_ENDED_H = 6
/** The statuses of an agent that has ended. */
export const ENDED: readonly string[] = ['completed', 'failed', 'killed']

const LEAD_ALIASES = new Set(['team-lead', 'main', 'lead', 'orchestrator'])
const MENTION = /(^|[^\w@])@(lead|orchestrator|main|team-lead)\b/i
const TYPE_TAG = /^\s*(?:swarm:\s*)?\[(PROPOSE|CLAIM|LOCK|WAIT|ASK|REVIEW|BLOCK|HANDOFF|DONE|RELEASE|WITHDRAW)\]/i
/** The order stamp line the mod puts before a teammate-to-teammate message (`#412 · 17:04:12`), after any envelope tag. */
const STAMP_LINE = /^(\s*(?:<[^>]*>\s*)?)#\d+ · \d\d:\d\d:\d\d[^\S\n]*\n/
const HELLO = /^(?:<[^>]*>\s*)?\[PROPOSE\]\s+hello\s+([A-Za-z][\w-]{0,23})\b/i
const NAME = '[\\"\'`“]?([A-Za-z][\\w-]{0,23})\\b'
const CAP_NAME = '([A-Z][\\w-]{0,23})\\b'
const SELF = "\\bI(?:'m)?\\b(?:\\s*\\([^)]*\\))?"
const RENAMES: readonly RegExp[] = [
  new RegExp(SELF + '\\s+(?:am\\s+|have\\s+)?(?:now\\s+)?renam(?:e|ed|ing)\\s+(?:myself\\s+)?(?:to\\s+|as\\s+)?' + NAME, 'i'),
  new RegExp('^renamed\\s+(?:to\\s+)?' + NAME, 'i'),
  new RegExp('\\(renamed(?:\\s+to)?\\s+' + NAME + '\\s*\\)', 'i'),
  new RegExp('\\([Nn]ow\\s+' + CAP_NAME + '\\s*\\)'),
  new RegExp('\\bcall\\s+me\\s+' + NAME, 'i'),
  new RegExp('\\bnow\\s+(?:called|named|known\\s+as|going\\s+by)\\s+' + NAME, 'i'),
  new RegExp("\\bI(?:'m|\\s+am)\\s+(?![\\w-]*ing\\b)" + NAME + '\\s+from\\s+now\\s+on', 'i'),
  new RegExp(SELF + '\\s+(?:am\\s+)?now\\s+' + CAP_NAME),
  new RegExp(SELF + '\\s+am\\s+' + CAP_NAME),
  new RegExp("\\bI'm\\s+" + CAP_NAME),
]
const NOT_NAMES = new Set(['to', 'as', 'me', 'myself', 'the', 'a', 'an', 'now', 'not', 'ok', 'okay', 'done', 'ready', 'busy', 'free', 'here', 'back',
  'also', 'still', 'idle', 'available', 'blocked', 'waiting', 'working', 'on', 'in', 'at', 'with', 'sure', 'going', 'it', 'this', 'that'])
const MODEL_FAMILIES = ['opus', 'sonnet', 'haiku', 'fable']

export type Via = 'send' | 'receive' | 'tool'

export type LogEntry = {
  ts: number
  from: string
  to: string
  summary: string
  length: number
  type?: string
  via: Via
  /** The order stamp the mod gave a teammate-to-teammate send. */
  stamp?: number
  /** On an ACT line: how many tool calls the teammate had made by then. */
  calls?: number
  idleReason?: string
  /** The claim the whole message made (see `claimOf`), also when it was not on the first line. */
  claim?: ClaimRef
  session?: string
  fromId?: string
  toId?: string
}

export type RosterEntry = {
  id: string
  name: string
  model?: string
  type?: string
  status: string
  isTeammate: boolean
  teammateId?: string
  description?: string
  /** When `agent.spawn` returned it. */
  spawnedAt?: number
  /** When its status last changed. */
  statusAt?: number
  /** When `$.agent.list()` first reported it, for an agent whose spawn this load did not see. */
  firstSeenAt?: number
  /** Whether `$.agent.list()` has reported it; one it then stops reporting has ended. */
  isListed?: boolean
  /** The Workflow run that started it (`wf_…`), for a workflow script's agent. */
  workflowRunId?: string
  /** The agent whose loop spawned it (`parentAgentId`); absent when the main loop did. */
  parentId?: string
}

/** Whether an agent was started by a workflow script: `agent.spawn`'s `workflow`, or the type the engine gives such agents. */
function isWorkflowAgent(a: RosterEntry): boolean {
  return a.workflowRunId !== undefined || a.type === 'workflow-subagent'
}

export type AgentRow = {
  id: string
  name?: string
  type: string
  status: string
  teammateId?: string
  description: string
  parentId?: string
}

/** The address without its `@team` suffix, lower-cased. */
export function bareName(address: string): string {
  return (address.split('@')[0] ?? '').trim().toLowerCase()
}

export function isLeadAddress(address: string): boolean {
  return LEAD_ALIASES.has(bareName(address))
}

/** Whether a message sent to `address` reaches the lead: `team-lead`, or `main`; `lead` and `orchestrator` name it only in a mention. */
export function isLeadRecipient(address: string): boolean {
  const name = bareName(address)
  return name === LEAD || name === 'main'
}

/** A message without the order stamp line the mod put before it. */
export function unstamped(text: string): string {
  return text.replace(STAMP_LINE, '$1')
}

/** `HH:MM:SS` in the local time zone: the one clock of the pane, the text list and the stamps. */
export function timeOfDay(ts: number): string {
  return new Date(ts - new Date(ts).getTimezoneOffset() * 60_000).toISOString().slice(11, 19)
}

/** The stamp line put before a teammate-to-teammate message: its order `n` in the session and the local time it was sent. */
export function stampLine(n: number, ts: number): string {
  return `#${n} · ${timeOfDay(ts)}`
}

export function firstLine(text: string, max = 160): string {
  const line = unstamped(text).split('\n').find(l => l.trim() !== '') ?? ''
  const trimmed = line.trim()
  return trimmed.length > max ? trimmed.slice(0, max - 1) + '…' : trimmed
}

export function typeOf(text: string): string | undefined {
  const m = TYPE_TAG.exec(unstamped(text))
  return m?.[1]?.toUpperCase()
}

export type IdleNotice = { from?: string; idleReason?: string }

/** The idle notification a delivery carries (a JSON body with `type: "idle_notification"`), or undefined. */
export function idleNotice(text: string): IdleNotice | undefined {
  if (!text.includes('idle_notification')) return undefined
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return undefined
  try {
    const o = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>
    if (o.type !== 'idle_notification') return undefined
    const notice: IdleNotice = {}
    if (typeof o.from === 'string') notice.from = o.from
    if (typeof o.idleReason === 'string') notice.idleReason = o.idleReason
    return notice
  } catch {
    return undefined
  }
}

/** The code name a teammate announces on the first line as `[PROPOSE] hello <Name>`. */
export function helloName(text: string): string | undefined {
  return HELLO.exec(firstLine(text))?.[1]
}

/**
 * The new code name a sender gives itself anywhere in a message: `I (t3) rename to kite`, `renamed Kite` at a line's start
 * (after its type tag), `(renamed kite)`, `(now Kite)`, `call me Kite`, `now called Kite`, `I am now Kite`, `I am Kite`, `I'm Kite`.
 * `(now Kite)` and the last three need a capitalised name. A name may be quoted, and `I'm kite from now on` renames to a name that does not end in `ing`.
 */
export function renameName(text: string): string | undefined {
  for (const raw of text.split('\n')) {
    const line = raw.replace(/^\s*(?:<[^>]*>\s*)?(?:\[[A-Za-z]+\]\s*)?/, '').trim()
    for (const re of RENAMES) {
      const name = re.exec(line)?.[1]
      if (name !== undefined && !NOT_NAMES.has(name.toLowerCase())) return name
    }
  }
  return undefined
}

/** A model id as family plus version: `claude-opus-5-5[1m]` → `opus 5.5`, `claude-3-5-sonnet-20241022` → `sonnet 3.5`; `–` when unknown. */
export function shortModel(id: string | undefined): string {
  if (id === undefined || id.trim() === '') return '–'
  const parts = id.trim().toLowerCase().replace(/\[[^\]]*\]$/, '').replace(/^(?:[\w.]+\.)?anthropic\./, '').replace(/^claude-/, '').replace(/-v\d+(?::\d+)?$/, '').split('-')
  const family = parts.find(p => MODEL_FAMILIES.includes(p)) ?? parts.find(p => /^[a-z]+$/.test(p))
  const version = parts.filter(p => /^\d{1,2}$/.test(p)).join('.')
  if (family === undefined) return id.trim()
  return version === '' ? family : `${family} ${version}`
}

/**
 * The run id and workflow name a Workflow tool call started, from its result (`runId`, `workflowName`, at any depth up to
 * three) or its input (`name`, else the script file's name before `-wf_`); undefined without a run id.
 */
export function workflowRunOf(input: unknown, result: unknown): { runId: string; name: string } | undefined {
  const find = (o: unknown, key: string, depth = 0): string | undefined => {
    if (depth > 3 || o === null || typeof o !== 'object') return undefined
    const v = (o as Record<string, unknown>)[key]
    if (typeof v === 'string' && v !== '') return v
    for (const child of Object.values(o as Record<string, unknown>)) {
      const found = find(child, key, depth + 1)
      if (found !== undefined) return found
    }
    return undefined
  }
  const text = typeof result === 'string' ? result : JSON.stringify(result ?? null)
  const runId = find(result, 'runId') ?? /\bRun ID:\s*(wf_[\w-]+)/.exec(text)?.[1] ?? /"runId"\s*:\s*"(wf_[\w-]+)"/.exec(text)?.[1]
  if (runId === undefined) return undefined
  const i = (input ?? {}) as { name?: unknown; scriptPath?: unknown }
  const script = typeof i.scriptPath === 'string' ? /([\w.-]+?)-wf_[\w-]+\.js$/.exec(i.scriptPath)?.[1] : undefined
  const name = find(result, 'workflowName') ?? (typeof i.name === 'string' && i.name !== '' ? i.name : undefined) ?? script ?? runId
  return { runId, name }
}

export function mentionsLead(text: string): boolean {
  return MENTION.test(text)
}

/** Text of a SendMessage `message` argument, which may be a structured protocol object. */
export function messageText(message: unknown): string {
  if (typeof message === 'string') return message
  if (message && typeof message === 'object' && 'type' in message) {
    return '[' + String((message as { type: unknown }).type) + ']'
  }
  return ''
}

export class Roster {
  readonly agents = new Map<string, RosterEntry>()
  /** Code names by the agent's bare team name. */
  readonly codeNames = new Map<string, string>()
  /** Idle notifications by the agent's bare team name, with the last reason given. */
  readonly idle = new Map<string, { count: number; lastReason?: string; lastAt?: number }>()
  /** When each agent, by bare team name, was first seen sending a message. */
  readonly firstMessageAt = new Map<string, number>()
  /** When each agent, by bare team name, last sent a message. */
  readonly lastMessageAt = new Map<string, number>()
  /** Workflow names by run id, from the Workflow tool's calls. */
  readonly workflowNames = new Map<string, string>()
  /** Agents from a previous session's roster.json, shown under `earlier`. */
  earlier: RosterEntry[] = []
  /** Whether the lead is in a turn. */
  leadBusy = false
  /** The time of the latest `merge` or `hydrate` that gave one, against which an idle teammate's age is read. */
  private seenAt = -Infinity
  /** Whether a teammate (bare team name) holds a registered wait or an open claim; such a teammate is never dormant. */
  isHeld: (name: string) => boolean = () => false

  /**
   * Whether a teammate is dormant: reported `idle`, holding no wait or open claim, and without a status change, message or
   * idle notice for over `IDLE_ENDED_H` hours at `now`. Display only: the pane and the band show it as ended; the team,
   * claims, waits and watchdogs still count it live.
   */
  isDormant(a: RosterEntry, now = this.seenAt): boolean {
    if (!a.isTeammate || a.status !== 'idle' || a.statusAt === undefined) return false
    const name = bareName(a.name)
    const lastSeen = Math.max(a.statusAt, this.lastMessageAt.get(name) ?? -Infinity, this.idle.get(name)?.lastAt ?? -Infinity)
    return now - lastSeen > IDLE_ENDED_H * 3_600_000 && !this.isHeld(name)
  }

  /** Whether the pane and the band show an agent as ended: completed, failed or killed, or dormant. */
  isShownEnded(a: RosterEntry, now = this.seenAt): boolean {
    return ENDED.includes(a.status) || this.isDormant(a, now)
  }

  /** Counts one idle notification from `sender`, received at `ts`. */
  noteIdle(sender: string, reason?: string, ts?: number) {
    const name = bareName(sender)
    const prior = this.idle.get(name)
    const lastAt = ts === undefined ? prior?.lastAt : Math.max(ts, prior?.lastAt ?? ts)
    this.idle.set(name, { count: (prior?.count ?? 0) + 1, lastReason: reason ?? prior?.lastReason, lastAt })
  }

  /** Records that `sender` sent a message at `ts`; keeps the earliest and the latest. */
  noteMessage(sender: string, ts: number) {
    const name = bareName(sender)
    if (name === '') return
    const prior = this.firstMessageAt.get(name)
    if (prior === undefined || ts < prior) this.firstMessageAt.set(name, ts)
    if (ts > (this.lastMessageAt.get(name) ?? -Infinity)) this.lastMessageAt.set(name, ts)
  }

  /** The latest agent going by `name` (bare team name) that has not ended, or undefined. */
  liveEntry(name: string): RosterEntry | undefined {
    const n = bareName(name)
    return [...this.agents.values()].filter(a => bareName(a.name) === n && !ENDED.includes(a.status)).pop()
  }

  /** When `name` went idle: its last idle notice, while it has sent nothing since and its live agent is not running; else undefined. */
  idleSince(name: string): number | undefined {
    const n = bareName(name)
    const at = this.idle.get(n)?.lastAt
    if (at === undefined || (this.lastMessageAt.get(n) ?? -Infinity) > at) return undefined
    const entry = this.liveEntry(n)
    return entry === undefined || entry.status === 'running' ? undefined : at
  }

  /**
   * Stores the code name `sender` gives itself, with its casing as written: a first-line `[PROPOSE] hello <Name>` or a rename
   * (see `renameName`). A received message sets a name only while the sender has none, since deliveries can arrive after a
   * later rename. Returns whether it changed. The lead has none.
   */
  announce(sender: string, text: string, via: Via = 'send'): boolean {
    const name = bareName(sender)
    if (name === '' || isLeadAddress(name) || name === 'peer') return false
    const code = helloName(text) ?? renameName(text)
    if (code === undefined) return false
    if (via === 'receive' && this.codeNames.has(name)) return false
    if (this.codeNames.get(name) === code) return false
    this.codeNames.set(name, code)
    return true
  }

  /** The bare team name of another current agent that uses `name`'s code name (any case), or undefined. */
  clashWith(name: string): string | undefined {
    const n = bareName(name)
    const code = this.codeNames.get(n)?.toLowerCase()
    if (code === undefined) return undefined
    return [...this.agents.values()].filter(a => !this.isShownEnded(a)).map(a => bareName(a.name)).find(o => o !== n && this.codeNames.get(o)?.toLowerCase() === code)
  }

  /** Bare team names of current agents whose code name another current agent also uses, case-insensitively. */
  duplicateCodes(): Set<string> {
    const byCode = new Map<string, string[]>()
    for (const a of this.agents.values()) {
      if (this.isShownEnded(a)) continue
      const name = bareName(a.name)
      const code = this.codeNames.get(name)?.toLowerCase()
      if (code === undefined) continue
      const names = byCode.get(code) ?? []
      if (!names.includes(name)) names.push(name)
      byCode.set(code, names)
    }
    const out = new Set<string>()
    for (const names of byCode.values()) if (names.length > 1) for (const n of names) out.add(n)
    return out
  }

  /** The team of the most recently added teammate (the part after `@` of its teammate id), or undefined without teammates. */
  currentTeam(): string | undefined {
    let team: string | undefined
    for (const a of this.agents.values()) if (a.isTeammate) team = a.teammateId?.split('@')[1] ?? ''
    return team
  }

  /**
   * Whether an agent belongs under `other agents`: outside the current team while a team exists, shown as ended (see `isShownEnded`),
   * or pending for more than `STALE_MS`.
   */
  isOther(a: RosterEntry, now: number): boolean {
    const team = this.currentTeam()
    if (team !== undefined && (!a.isTeammate || (a.teammateId?.split('@')[1] ?? '') !== team)) return true
    if (this.isShownEnded(a, now)) return true
    return a.status === 'pending' && a.statusAt !== undefined && now - a.statusAt > STALE_MS
  }

  /** When an agent started: its spawn, else its first message, else when the agent list first reported it; undefined when none was seen. */
  startedAt(name: string): number | undefined {
    const n = bareName(name)
    const entry = [...this.agents.values()].find(a => bareName(a.name) === n)
    return entry?.spawnedAt ?? this.firstMessageAt.get(n) ?? entry?.firstSeenAt
  }

  /**
   * `Atlas (t1)` once t1 announced Atlas; for an agent without a name of its own
   * (named by its id prefix) its spawn description, also when addressed by its full id; else the name itself.
   */
  label(name: string): string {
    const code = this.codeNames.get(bareName(name))
    if (code !== undefined) return code.toLowerCase() === bareName(name) ? `${name} (no code name)` : `${code} (${name})`
    const entry = [...this.agents.values(), ...this.earlier].find(a => a.name === name || a.id === name)
    if (entry !== undefined && entry.name === entry.id.slice(0, 8) && entry.description) return clip(entry.description.trim(), LABEL_MAX)
    return name
  }

  /**
   * Restores a roster.json: this session's agents rejoin the roster, a previous session's go to `earlier`. A restored agent
   * of this session that has not ended counts as listed, so the next `merge` that does not report it marks it completed.
   */
  hydrate(json: unknown, session: string, now?: number) {
    if (now !== undefined) this.seenAt = Math.max(this.seenAt, now)
    if (!json || typeof json !== 'object') return
    const j = json as { session?: unknown; agents?: unknown }
    if (!Array.isArray(j.agents)) return
    const isCurrent = j.session === session
    for (const raw of j.agents) {
      if (!raw || typeof raw !== 'object' || typeof (raw as RosterEntry).id !== 'string') continue
      const a = raw as RosterEntry & { codeName?: unknown; idleNotices?: unknown; lastIdleReason?: unknown; lastIdleAt?: unknown }
      const entry: RosterEntry = {
        id: a.id,
        name: typeof a.name === 'string' ? a.name : a.id.slice(0, 8),
        model: typeof a.model === 'string' ? a.model : undefined,
        type: typeof a.type === 'string' ? a.type : undefined,
        status: isCurrent && typeof a.status === 'string' ? a.status : 'earlier',
        isTeammate: a.isTeammate === true,
        teammateId: typeof a.teammateId === 'string' ? a.teammateId : undefined,
        description: typeof a.description === 'string' ? a.description : undefined,
        spawnedAt: typeof a.spawnedAt === 'number' ? a.spawnedAt : undefined,
        statusAt: isCurrent && typeof a.statusAt === 'number' ? a.statusAt : undefined,
        workflowRunId: typeof a.workflowRunId === 'string' ? a.workflowRunId : undefined,
      }
      if (isCurrent && now !== undefined && isWorkflowAgent(entry) && !ENDED.includes(entry.status) && (entry.statusAt === undefined || now - entry.statusAt > STALE_MS)) {
        entry.status = 'completed'
        entry.statusAt = now
      }
      if (isCurrent && !isWorkflowAgent(entry) && !ENDED.includes(entry.status)) entry.isListed = true
      if (typeof a.codeName === 'string' && !this.codeNames.has(bareName(entry.name))) this.codeNames.set(bareName(entry.name), a.codeName)
      if (isCurrent) {
        if (!this.agents.has(entry.id)) this.agents.set(entry.id, entry)
        if (typeof a.idleNotices === 'number') {
          this.idle.set(bareName(entry.name), {
            count: a.idleNotices,
            lastReason: typeof a.lastIdleReason === 'string' ? a.lastIdleReason : undefined,
            lastAt: typeof a.lastIdleAt === 'number' ? a.lastIdleAt : undefined,
          })
        }
      } else if (!this.earlier.some(e => e.id === entry.id)) {
        this.earlier.push(entry)
      }
    }
  }

  /**
   * The bare team name an agent goes by, given its team name or its code name. A code name several agents took goes to the
   * one that has not ended, else to the latest started.
   */
  resolve(nameOrCode: string): string {
    const n = bareName(nameOrCode)
    const holders = [...this.codeNames].filter(([, code]) => code.toLowerCase() === n).map(([name]) => name)
    if (holders.length === 0) return n
    const live = holders.filter(h => this.liveEntry(h) !== undefined && [...this.agents.values()].some(a => bareName(a.name) === h))
    const pool = live.length > 0 ? live : holders
    return pool.reduce((best, h) => ((this.startedAt(h) ?? -Infinity) >= (this.startedAt(best) ?? -Infinity) ? h : best))
  }

  /** Records an `agent.spawn` once `next` answered with the started agent. */
  spawned(input: { name?: string; model?: string; subagentType?: string; isTeammate?: boolean; description?: string; workflow?: { runId?: string }; parentAgentId?: string },
          result: { agentId?: string; model?: string; teammateId?: string }, now?: number): RosterEntry | undefined {
    if (!result.agentId) return undefined
    const prior = this.agents.get(result.agentId)
    const entry: RosterEntry = {
      id: result.agentId,
      name: input.name ?? prior?.name ?? result.agentId.slice(0, 8),
      model: result.model ?? input.model ?? prior?.model,
      type: input.subagentType ?? prior?.type,
      status: prior?.status ?? 'pending',
      isTeammate: input.isTeammate === true,
      teammateId: result.teammateId ?? prior?.teammateId,
      description: input.description ?? prior?.description,
      spawnedAt: prior?.spawnedAt ?? now,
      statusAt: prior?.statusAt ?? now,
      workflowRunId: input.workflow?.runId || prior?.workflowRunId,
      parentId: input.parentAgentId ?? prior?.parentId,
    }
    this.agents.set(entry.id, entry)
    return entry
  }

  /** Merges `$.agent.list()` rows seen at `now`; returns whether anything changed. */
  merge(rows: readonly AgentRow[], now?: number): boolean {
    if (now !== undefined) this.seenAt = Math.max(this.seenAt, now)
    let changed = false
    const seen = new Set(rows.map(r => r.id))
    for (const a of this.agents.values()) {
      if (a.isListed === true && !seen.has(a.id) && !ENDED.includes(a.status)) {
        this.agents.set(a.id, { ...a, status: 'completed', statusAt: now })
        changed = true
      }
    }
    for (const row of rows) {
      const prior = this.agents.get(row.id)
      const next: RosterEntry = {
        ...prior,
        isListed: true,
        id: row.id,
        name: row.name ?? prior?.name ?? row.id.slice(0, 8),
        model: prior?.model,
        type: prior?.type ?? row.type,
        status: row.status,
        isTeammate: prior?.isTeammate ?? (row.teammateId !== undefined || row.type === 'teammate'),
        teammateId: row.teammateId ?? prior?.teammateId,
        description: prior?.description ?? row.description,
        parentId: prior?.parentId ?? row.parentId,
        spawnedAt: prior?.spawnedAt,
        firstSeenAt: prior === undefined ? now : prior.firstSeenAt,
        statusAt: prior !== undefined && prior.status === row.status ? prior.statusAt : now,
      }
      if (!prior || JSON.stringify(prior) !== JSON.stringify(next)) changed = true
      this.agents.set(row.id, next)
    }
    return changed
  }

  /** Marks a workflow agent whose turn completed as completed; returns whether it changed. */
  settle(agentId: string, now?: number): boolean {
    const a = this.agents.get(agentId)
    if (a === undefined || !isWorkflowAgent(a) || ENDED.includes(a.status)) return false
    this.agents.set(agentId, { ...a, status: 'completed', statusAt: now })
    return true
  }

  nameOf(agentId: string | undefined): string {
    if (agentId === undefined) return LEAD
    return this.agents.get(agentId)?.name ?? agentId.slice(0, 8)
  }

  /** Agents whose loop is doing or about to do work. */
  activeCount(): number {
    let n = 0
    for (const a of this.agents.values()) if (a.status === 'running' || a.status === 'pending' || a.status === 'waiting') n++
    return n
  }

  /** Whether teammates were spawned and every one has ended. */
  isTeamEnded(): boolean {
    const mates = [...this.agents.values()].filter(a => a.isTeammate)
    return mates.length > 0 && mates.every(a => ENDED.includes(a.status))
  }

  /** Whether a teammate ever went by `name` (bare team name). */
  hasTeammate(name: string): boolean {
    const n = bareName(name)
    return [...this.agents.values()].some(a => a.isTeammate && bareName(a.name) === n)
  }

  /** Whether a teammate that goes by `name` (bare team name) ended at `since` or later and none by that name is live. */
  hasStoppedSince(name: string, since: number): boolean {
    const n = bareName(name)
    const mates = [...this.agents.values()].filter(a => a.isTeammate && bareName(a.name) === n)
    return mates.length > 0 && mates.every(a => ENDED.includes(a.status)) && mates.some(a => (a.statusAt ?? -Infinity) >= since)
  }

  /** Whether a teammate that goes by `name` (bare team name) has not ended. */
  isLiveTeammate(name: string): boolean {
    const n = bareName(name)
    return [...this.agents.values()].some(a => a.isTeammate && bareName(a.name) === n && !ENDED.includes(a.status))
  }

  /** Agents not ended (completed, failed, killed). */
  liveCount(): number {
    let n = 0
    for (const a of this.agents.values()) if (!ENDED.includes(a.status)) n++
    return n
  }

  toJSON(now: number, session?: string) {
    return {
      updatedAt: new Date(now).toISOString(),
      ...(session === undefined ? {} : { session }),
      lead: { name: LEAD, status: this.leadBusy ? 'running' : 'idle' },
      agents: [...this.agents.values()].map(a => {
        const codeName = this.codeNames.get(bareName(a.name))
        const idle = this.idle.get(bareName(a.name))
        return {
          ...a,
          ...(codeName === undefined ? {} : { codeName, label: this.label(a.name) }),
          ...(idle === undefined ? {} : { idleNotices: idle.count, lastIdleReason: idle.lastReason, lastIdleAt: idle.lastAt }),
        }
      }),
    }
  }
}

export class MessageLog {
  readonly entries: LogEntry[] = []
  /** Messages from a previous session's log file, newest last. */
  earlier: LogEntry[] = []
  total = 0
  lastAt: number | null = null
  readonly sent = new Map<string, number>()
  readonly received = new Map<string, number>()
  private recentSends: { from: string; to: string; text: string }[] = []
  /** The texts of this plugin's own sends not yet delivered, by bare recipient name, at most `SEND_MEMORY` each. */
  private readonly modUndelivered = new Map<string, string[]>()

  /** Records one message; returns the entry, or undefined when it is the delivery of a recorded send. */
  record(m: { ts: number; from: string; to: string; text: string; via: Via; fromId?: string; toId?: string }): LogEntry | undefined {
    if (m.via === 'receive' && (this.isModDelivery(m.to, m.text) || this.isEchoOfSend(m.from, m.to, m.text))) return undefined
    if (m.via !== 'receive' && isModName(m.from) && m.text.trim() !== '') {
      const pending = this.modUndelivered.get(bareName(m.to)) ?? []
      pending.push(m.text.trim())
      if (pending.length > SEND_MEMORY) pending.splice(0, pending.length - SEND_MEMORY)
      this.modUndelivered.set(bareName(m.to), pending)
    }
    if (m.via !== 'receive') {
      this.recentSends.push({ from: m.from, to: m.to, text: m.text })
      if (this.recentSends.length > SEND_MEMORY) this.recentSends.splice(0, this.recentSends.length - SEND_MEMORY)
    }
    const entry: LogEntry = {
      ts: m.ts,
      from: m.from,
      to: m.to,
      summary: firstLine(m.text),
      length: m.text.length,
      via: m.via,
    }
    const type = typeOf(m.text)
    if (type) entry.type = type
    if (m.fromId) entry.fromId = m.fromId
    if (m.toId) entry.toId = m.toId
    this.entries.push(entry)
    if (this.entries.length > MEMORY_CAP) this.entries.splice(0, this.entries.length - MEMORY_CAP)
    this.total++
    this.lastAt = m.ts
    this.sent.set(m.from, (this.sent.get(m.from) ?? 0) + 1)
    this.received.set(m.to, (this.received.get(m.to) ?? 0) + 1)
    return entry
  }

  /** Restores a logged line of this session as if it had just been recorded, without dedupe. */
  restore(e: LogEntry) {
    this.entries.push(e)
    if (this.entries.length > MEMORY_CAP) this.entries.splice(0, this.entries.length - MEMORY_CAP)
    this.total++
    this.lastAt = this.lastAt === null ? e.ts : Math.max(this.lastAt, e.ts)
    this.sent.set(e.from, (this.sent.get(e.from) ?? 0) + 1)
    this.received.set(e.to, (this.received.get(e.to) ?? 0) + 1)
  }

  /** Whether a delivery to `to` carries the text of one of this plugin's own sends to it not yet delivered; that send then counts as delivered. */
  private isModDelivery(to: string, text: string): boolean {
    const pending = this.modUndelivered.get(bareName(to))
    const t = text.trim()
    const i = t === '' || pending === undefined ? -1 : pending.findIndex(st => t.includes(st) || st.includes(t))
    if (i < 0) return false
    pending!.splice(i, 1)
    return true
  }

  /** Whether a delivery carries a recorded send's text, from the same sender or to the same recipient. */
  private isEchoOfSend(from: string, to: string, text: string): boolean {
    const t = text.trim()
    if (t === '') return false
    return this.recentSends.some(s => {
      const st = s.text.trim()
      if (st === '') return false
      const sameEnd = bareName(s.from) === bareName(from) || bareName(s.to) === bareName(to) || from === 'peer' || from === 'coordinator'
      return sameEnd && (t.includes(st) || st.includes(t))
    })
  }

  last(n: number): LogEntry[] {
    return this.entries.slice(-n)
  }
}

/** Whether a logged line is an idle notification. */
export function isIdleLine(e: LogEntry): boolean {
  return e.type === 'IDLE'
}

/** Whether a logged line records a tool call (`FILE`, `ACT`, a refused spawn `REFUSED`) or a teammate joining or leaving (`JOIN`, `LEFT`), not a message. */
export function isToolLine(e: LogEntry): boolean {
  return e.type === 'FILE' || e.type === 'ACT' || e.type === 'REFUSED' || e.type === 'JOIN' || e.type === 'LEFT'
}

const WRITE_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']

/**
 * What a FILE line shows for a file tool call: `✎ <path>` for Edit, Write, MultiEdit and NotebookEdit, `◦ <path>` for Read,
 * relative to `cwd` when inside it, else its last two segments after `…/`; undefined for any other call.
 */
export function fileOf(tool: string, input: unknown, cwd: string | null): string | undefined {
  const mark = tool === 'Read' ? '◦' : WRITE_TOOLS.includes(tool) ? '✎' : undefined
  const path = pathOf(input)
  if (mark === undefined || path === undefined) return undefined
  return `${mark} ${shownPath(path, cwd)}`
}

/** A path as a card shows it: relative to `cwd` when inside it, else its last two segments after `…/`. */
function shownPath(path: string, cwd: string | null): string {
  if (cwd !== null && path.startsWith(cwd + '/')) return path.slice(cwd.length + 1)
  const parts = path.split('/').filter(Boolean)
  return `${parts.length > 2 ? '…/' : ''}${parts.slice(-2).join('/')}`
}

/** One line of a tool call's input, at most `max` characters. */
function brief(value: unknown, max = 48): string {
  const line = (typeof value === 'string' ? value : '').split('\n')[0]!.replace(/\s+/g, ' ').trim()
  return line.length > max ? line.slice(0, max - 1) + '…' : line
}

/**
 * A tool call in plain words for a card: `Reading README.md`, `Editing hooks/core.ts`, `Running npm test`,
 * `Searching 'claimOf'`, `Messaging t2`; `Using <tool>` for a tool it has no words for.
 */
export function actionOf(tool: string, input: unknown, cwd: string | null): string {
  const i = (input ?? {}) as Record<string, unknown>
  const path = pathOf(input)
  const file = path === undefined ? '' : shownPath(path, cwd)
  switch (tool) {
    case 'Read': return `Reading ${file}`
    case 'Write': return `Writing ${file}`
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit': return `Editing ${file}`
    case 'Bash': return `Running ${brief(i.command)}`
    case 'Grep': return `Searching '${brief(i.pattern, 32)}'`
    case 'Glob': return `Finding ${brief(i.pattern, 32)}`
    case 'SendMessage': return `Messaging ${brief(i.to, 24)}`
    case 'WebFetch': return `Fetching ${/^\w+:\/\/([^/]+)/.exec(brief(i.url, 200))?.[1] ?? 'a page'}`
    case 'WebSearch': return `Searching the web for '${brief(i.query, 32)}'`
    case 'Agent':
    case 'Task': return 'Starting an agent'
    default: return /^Task/.test(tool) ? 'Updating tasks' : `Using ${tool}`
  }
}

/** The file a tool call names (`file_path`, else `notebook_path`), or undefined. */
function pathOf(input: unknown): string | undefined {
  const i = (input ?? {}) as { file_path?: unknown; notebook_path?: unknown }
  const path = typeof i.file_path === 'string' ? i.file_path : typeof i.notebook_path === 'string' ? i.notebook_path : undefined
  return path === '' ? undefined : path
}

/** The file an Edit, Write, MultiEdit or NotebookEdit call writes, or undefined for any other call. */
export function writtenPath(tool: string, input: unknown): string | undefined {
  return WRITE_TOOLS.includes(tool) ? pathOf(input) : undefined
}

/** Log lines from JSONL text; lines that are not entries are skipped. */
export function parseLog(text: string): LogEntry[] {
  const out: LogEntry[] = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      const e = JSON.parse(line) as LogEntry
      if (typeof e.ts === 'number' && typeof e.from === 'string' && typeof e.to === 'string' && typeof e.summary === 'string') out.push(e)
    } catch {
      continue
    }
  }
  return out
}

/**
 * Restores the log file's tail: this session's lines count as messages, a previous session's go to `earlier`. This session's
 * idle lines give each agent's wait count (the larger of roster.json's count and the lines') and the time of its last wait.
 */
export function hydrateLog(log: MessageLog, roster: Roster, lines: readonly LogEntry[], session: string) {
  const waits = new Roster()
  for (const e of lines) {
    if (isToolLine(e)) continue
    if (e.session === session) {
      if (isIdleLine(e)) waits.noteIdle(e.from, e.idleReason, e.ts)
      else {
        log.restore(e)
        roster.noteMessage(e.from, e.ts)
      }
    } else if (!isIdleLine(e)) {
      log.earlier.push(e)
    }
  }
  for (const [name, w] of waits.idle) {
    const prior = roster.idle.get(name)
    roster.idle.set(name, { count: Math.max(prior?.count ?? 0, w.count), lastReason: w.lastReason ?? prior?.lastReason, lastAt: Math.max(prior?.lastAt ?? 0, w.lastAt ?? 0) || undefined })
  }
  if (log.earlier.length > MEMORY_CAP) log.earlier = log.earlier.slice(-MEMORY_CAP)
}

export function jsonl(entries: readonly LogEntry[]): string {
  return entries.map(e => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : '')
}

export function ago(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return s + 's'
  const m = Math.floor(s / 60)
  if (m < 60) return m + 'm'
  return Math.floor(m / 60) + 'h' + String(m % 60).padStart(2, '0')
}

/**
 * Decides when the lead is woken. Messages addressed to the lead are already
 * delivered to it by the team mailbox, so they never cause a wake here.
 */
export class WakePolicy {
  mode: WakeMode = 'mentions'
  pending: LogEntry[] = []
  firstPendingAt: number | null = null
  lastDigestAt = 0
  inFlight = false
  /** Deliveries that reached the lead plus the mod's own wakes. */
  wakes = 0
  /** Deliveries the lead filter kept from the lead. */
  held = 0

  /** Considers one logged message; returns whether it was queued for a wake. */
  offer(entry: LogEntry, text: string): boolean {
    if (this.mode === 'off') return false
    if (entry.from === LEAD || isLeadAddress(entry.from)) return false
    if (isLeadAddress(entry.to)) return false
    if (this.mode === 'mentions' && !mentionsLead(text)) return false
    if (this.pending.length === 0) this.firstPendingAt = entry.ts
    this.pending.push(entry)
    return true
  }

  setMode(mode: WakeMode, now: number) {
    this.mode = mode
    this.pending = []
    this.firstPendingAt = null
    this.lastDigestAt = now
  }

  /** The wake text to submit now, or null; clears the queue when it returns text. */
  due(now: number, leadBusy: boolean): string | null {
    if (this.mode === 'off' || leadBusy || this.inFlight) return null
    if (this.mode === 'digest') {
      if (now - this.lastDigestAt < DIGEST_MS) return null
      this.lastDigestAt = now
      if (this.pending.length === 0) return null
    } else {
      if (this.pending.length === 0 || this.firstPendingAt === null) return null
      if (now - this.firstPendingAt < COALESCE_MS[this.mode]) return null
    }
    const text = wakeText(this.mode, this.pending)
    this.pending = []
    this.firstPendingAt = null
    return text
  }
}

const HELD_TYPES = ['PROPOSE', 'CLAIM', 'HANDOFF', 'REVIEW']

/**
 * Whether the lead filter keeps a teammate's delivery from the lead: an idle notice whose reason is `available` or absent;
 * else a `[PROPOSE]`, `[CLAIM]`, `[HANDOFF]` or `[REVIEW]` that neither mentions `@lead` nor has a line starting `[ASK]` or `[BLOCK]`.
 */
export function isHeldFromLead(text: string, idle: IdleNotice | undefined): boolean {
  if (idle !== undefined) return idle.idleReason === undefined || idle.idleReason === 'available'
  if (mentionsLead(text) || /^\s*(?:<[^>]*>\s*)?\[(?:ASK|BLOCK)\]/im.test(text)) return false
  const type = typeOf(text.replace(/^\s*<[^>]*>/, ''))
  return type !== undefined && HELD_TYPES.includes(type)
}

function wakeText(mode: WakeMode, entries: readonly LogEntry[]): string {
  const shown = entries.slice(-12)
  const lines = shown.map(e => `- ${e.from} → ${e.to}: ${e.summary}`)
  const more = entries.length > shown.length ? [`- … ${entries.length - shown.length} earlier`] : []
  const head = mode === 'mentions'
    ? `swarm: ${entries.length} message(s) between teammates mention you:`
    : `swarm (${mode}): ${entries.length} new message(s) between teammates:`
  return [head, ...more, ...lines,
    'Act only if a decision, a tie, a blocker or a budget call needs you; teammates coordinate the rest. Full log: .swarm/log.jsonl.'].join('\n')
}

/** The stall watchdog's nudge to a teammate holding open claims: what it holds and who has reported. */
export function nudgeText(minutes: number, claims: readonly Claim[], reports: ReadonlyMap<string, { type: string }>, label: (name: string) => string): string {
  const reported = [...reports].map(([name, r]) => `${label(name)} ${r.type}`)
  const who = reported.length > 0 ? 'reported: ' + reported.join(', ') : 'nobody has reported'
  return `[ASK] quiet ${minutes} min: you hold ${claims.map(c => c.key).join(', ')}; ${who}. Continue, or send [DONE]/[BLOCK].`
}

export function stallText(minutes: number, openTasks: number | null, openClaims = 0): string {
  const tasks = openTasks === null ? 'task list unreadable' : `${openTasks} task(s) still open`
  const claims = openClaims > 0 ? `, ${openClaims} claim(s) open` : ''
  return `swarm stalled: no message for ${minutes} min, no agent running, ${tasks}${claims}. Check .swarm/roster.json and the task list; reassign, unblock or end the swarm.`
}

export type StallInput = {
  now: number
  lastActivityAt: number
  stallMs: number
  activeAgents: number
  liveAgents: number
  openTasks: number | null
  /** Open message claims of live teammates: a `[CLAIM]` its holder has not released or reported on since (see `ClaimBoard.report`). */
  openClaims: number
  leadBusy: boolean
  alreadyFired: boolean
}

/** Whether the stall watchdog should act now: quiet, nobody running, and work remains (an open claim, or open tasks). */
export function isStalled(s: StallInput): boolean {
  if (s.alreadyFired || s.leadBusy || s.activeAgents > 0) return false
  if (s.now - s.lastActivityAt < s.stallMs) return false
  if (s.openClaims > 0) return true
  if (s.openTasks !== null) return s.openTasks > 0
  return s.liveAgents > 0
}

/** Counts open tasks in task files; a file whose status is not readable counts as open. */
export function openTaskCount(files: readonly string[]): number {
  let open = 0
  for (const text of files) {
    try {
      const task = JSON.parse(text) as { status?: unknown }
      if (task.status !== 'completed' && task.status !== 'deleted') open++
    } catch {
      open++
    }
  }
  return open
}

function pad(s: string, n: number): string {
  if (s.length > n) return s.slice(0, Math.max(0, n - 1)) + '…'
  return s.padEnd(n)
}

function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, Math.max(0, n - 1)) + '…' : s
}

/** The band's counts: agents of the current team that have not ended, messages, time since the last one. */
export function bandText(roster: Roster, log: MessageLog, now: number): string {
  const n = [...roster.agents.values()].filter(a => !roster.isOther(a, now)).length
  const last = log.lastAt === null ? '—' : ago(now - log.lastAt)
  const earlier = log.earlier.length ? ` (${log.earlier.length} earlier)` : ''
  return `swarm: ${n} agent${n === 1 ? '' : 's'} · ${log.total} msg${log.total === 1 ? '' : 's'}${earlier} · last ${last}`
}

/** The announced code names of `names` (bare team names) as `Atlas (t1), Sage (t2)`, or '' before any announcement. */
export function namesText(roster: Roster, names: readonly string[]): string {
  return names.filter(n => roster.codeNames.has(bareName(n))).map(n => roster.label(n)).join(', ')
}

/**
 * One line per workflow run for its agents: `✓ workflow dev-team · 16 agents` once all ended, else with the running and
 * pending counts. A run whose name the mod never saw shows its run id, or nothing.
 */
function workflowGroups(roster: Roster, agents: readonly RosterEntry[], now: number): { text: string; isOther: boolean }[] {
  const runs = new Map<string, RosterEntry[]>()
  for (const a of agents) {
    if (!isWorkflowAgent(a)) continue
    const key = a.workflowRunId ?? ''
    runs.set(key, [...(runs.get(key) ?? []), a])
  }
  return [...runs].map(([runId, list]) => {
    const name = roster.workflowNames.get(runId) ?? runId
    const isDone = list.every(a => ENDED.includes(a.status))
    const failed = list.filter(a => a.status === 'failed' || a.status === 'killed').length
    const running = list.filter(a => a.status === 'running').length
    const pending = list.filter(a => !ENDED.includes(a.status) && a.status !== 'running').length
    const head = `${isDone ? (failed ? '✗' : '✓') : '●'} workflow${name ? ' ' + name : ''} · ${list.length} agent${list.length === 1 ? '' : 's'}`
    const tail = isDone ? (failed ? ` · ${failed} failed` : '') : ` · ${running} running · ${pending} pending`
    return { text: head + tail, isOther: isDone || list.every(a => roster.isOther(a, now)) }
  })
}

const STATUS_MARK: Record<string, string> = {
  running: '●', pending: '◌', waiting: '◐', idle: '○', stalled: '!', completed: '✓', failed: '✗', killed: '✗',
}

export type PaneRow = { text: string; dim?: boolean; bold?: boolean }

/**
 * The pane's rows: the header bold; roster rows of active agents, then agents outside the current team or settled for
 * `STALE_MS` dimmed under `── other agents ──` and a previous session's agents under `── earlier ──`, each block its newest
 * `OTHERS_SHOWN` after a `… N more` line; messages newest first, a previous session's dimmed under `── earlier ──` at the bottom.
 */
export function paneRows(roster: Roster, log: MessageLog, policy: WakePolicy, now: number, cols: number, maxMessages: number, board?: ClaimBoard, stallMs = DEFAULT_STALL_MIN * 60_000): PaneRow[] {
  const w = Math.max(20, cols)
  const out: string[] = []
  const dim = new Set<number>()
  out.push(clip(`${bandText(roster, log, now)} · wake: ${policy.mode}${policy.pending.length ? ` (${policy.pending.length} queued)` : ''} · wakes ${policy.wakes} · held ${policy.held}`, w))
  out.push('')
  out.push(clip('ROSTER  name · model · status · sent/recv · waits', w))
  const nameW = Math.min(LABEL_MAX, Math.max(8, Math.floor(w * 0.3)))
  const models = [...roster.agents.values(), ...roster.earlier].map(a => shortModel(a.model))
  const modelW = w >= 48 ? Math.max(1, ...models.map(m => m.length)) : 0
  const statusW = 10
  const dups = roster.duplicateCodes()
  const nameCell = (name: string, isCurrent = true) => {
    const mark = isCurrent && dups.has(bareName(name)) ? ' ⚠ dup' : ''
    return pad(clip(roster.label(name), nameW - mark.length) + mark, nameW)
  }
  const row = (name: string, model: string, status: string) => {
    const idle = roster.idle.get(bareName(name))
    const reason = idle?.lastReason !== undefined && idle.lastReason !== 'available' ? ` (${idle.lastReason})` : ''
    const age = idle?.lastAt !== undefined ? ` · ${ago(now - idle.lastAt)} ago` : ''
    const counts = `${log.sent.get(name) ?? 0}/${log.received.get(name) ?? 0}${idle ? ` · waits ${idle.count}${reason}${age}` : ''}`
    const mark = STATUS_MARK[status] ?? '?'
    return clip(`${mark} ${nameCell(name)} ${modelW ? model.padEnd(modelW) + ' ' : ''}${pad(status, statusW)} ${counts}`, w)
  }
  out.push(row(LEAD, '', roster.leadBusy ? 'running' : 'idle'))
  const all = [...roster.agents.values()]
  const agents = all.filter(a => !isWorkflowAgent(a))
  const others = agents.filter(a => roster.isOther(a, now))
  const groups = workflowGroups(roster, all, now)
  const hasStalled = (name: string) => {
    const since = roster.idleSince(name)
    return stallMs > 0 && since !== undefined && now - since > stallMs && (board?.openClaims(name).length ?? 0) > 0
  }
  const shown = agents.filter(a => !others.includes(a))
  const nested = others.filter(c => c.parentId !== undefined && !roster.isShownEnded(c, now) && shown.some(a => a.id === c.parentId))
  for (const a of shown) {
    out.push(row(a.name, shortModel(a.model), hasStalled(a.name) ? 'stalled' : a.status))
    for (const c of nested) if (c.parentId === a.id) out.push(clip('  └ ' + row(c.name, shortModel(c.model), c.status), w))
  }
  for (const g of groups) if (!g.isOther) out.push(clip(g.text, w))
  const newest = (lines: readonly string[]) => {
    const more = lines.length - OTHERS_SHOWN
    for (const l of more > 0 ? [`  … ${more} more`, ...lines.slice(-OTHERS_SHOWN)] : lines) {
      dim.add(out.length)
      out.push(l)
    }
  }
  const otherLines = [...groups.filter(g => g.isOther).map(g => clip(g.text, w)), ...others.filter(a => !nested.includes(a)).map(a => row(a.name, shortModel(a.model), a.status))]
  if (otherLines.length > 0) {
    out.push(OTHER_AGENTS)
    newest(otherLines)
  }
  if (roster.earlier.length > 0) {
    out.push(EARLIER)
    newest(roster.earlier.map(a => clip(`  ${nameCell(a.name, false)} ${modelW ? shortModel(a.model).padEnd(modelW) + ' ' : ''}`.trimEnd(), w)))
  }
  if (board !== undefined) {
    out.push('')
    out.push('CLAIMS')
    const isStale = (n: string) => now - (roster.lastMessageAt.get(bareName(n)) ?? now) > CLAIM_TTL_MIN * 60_000
    const lines = claimLines(board, n => roster.label(n) + (isStale(n) ? ' stale' : ''))
    if (lines.length === 0) out.push('(none yet)')
    for (const l of lines) out.push(clip(l, w))
  }
  out.push('')
  const current = log.last(maxMessages)
  const earlier = log.earlier.slice(log.earlier.length - Math.max(0, maxMessages - current.length))
  out.push(clip(`MESSAGES  last ${current.length} of ${log.total}${log.earlier.length ? ` · ${log.earlier.length} earlier` : ''}`, w))
  const line = (e: LogEntry) => clip(`${timeOfDay(e.ts)} ${roster.label(e.from)} → ${roster.label(e.to)}: ${e.summary}`, w)
  if (current.length === 0 && earlier.length === 0) out.push('(none yet)')
  for (const e of [...current].reverse()) out.push(line(e))
  if (earlier.length > 0) {
    out.push(EARLIER)
    for (const e of [...earlier].reverse()) {
      dim.add(out.length)
      out.push(line(e))
    }
  }
  return out.map((text, i) => ({ text, ...(i === 0 ? { bold: true } : {}), ...(dim.has(i) ? { dim: true } : {}) }))
}

const CLAIM_TAG = /^(?:<[^>]*>\s*)?\[CLAIM\]\s*(.*)$/i
const ROLE_WORDS: Record<string, string> = {
  build: 'build', builder: 'build', builds: 'build', building: 'build',
  review: 'review', reviewer: 'review', reviews: 'review',
  research: 'research', researcher: 'research', researches: 'research',
}
const DELIVERABLE_LINE = /^[\s*_>-]*deliverables?[*_]*\s*:[*_]*\s*(.+)$/gim

export type ClaimRef = { role: string; target: string }
export type Claim = ClaimRef & { key: string; by: string[] }
export type TaskRow = { subject: string; owner?: string; status: string }

/** Whether a word names a file or a path: it holds a `/` or ends in a file extension. */
function isPathLike(word: string): boolean {
  return word.includes('/') || /\.[a-z][a-z0-9]{0,7}$/.test(word)
}

/**
 * Role and target of a claim subject: `build var/gaps.md` → { role: 'build', target: 'var/gaps.md' }. A target that starts
 * with a path or file name is that path alone: `research docs/05-x.md (h14). output: …` → `docs/05-x.md`.
 */
function parseClaimSubject(subject: string): ClaimRef {
  const words = subject.trim().replace(/\s+/g, ' ').split(' ')
  const head = (words[0] ?? '').toLowerCase().replace(/[:,]$/, '')
  const role = ROLE_WORDS[head]
  const rest = (role === undefined ? words : words.slice(1)).join(' ')
  const target = rest.toLowerCase().replace(/^(of|the|for)\s+/, '').replace(/[`"'„“”]/g, '').replace(/[.,;:!]+$/, '').trim()
  const path = /^[^\s,;()]+/.exec(target)?.[0]?.replace(/[.:!]+$/, '')
  return { role: role ?? 'other', target: path !== undefined && isPathLike(path) ? path : target }
}

/**
 * Whether a claim subject is a sentence fragment, not a target. Judged on its target token, the first word after the role
 * word, or the inside of a quoted or bracketed start: a fragment when that is empty, holds a `"`, says `please`, or holds a
 * space outside quotes (`"group A"` and `` `group A` `` name one slice of several words).
 */
function isFragment(subject: string): boolean {
  const rest = subject.trim().replace(/^(\S+)\s*/, (w, head: string) => (ROLE_WORDS[head.toLowerCase().replace(/[:,]$/, '')] === undefined ? w : ''))
  const wrapped = /^(?:"([^"]*)"|`([^`]*)`|\(([^)]*)\))/.exec(rest)
  const token = wrapped === null ? (rest.split(/\s/)[0] ?? '') : (wrapped[1] ?? wrapped[2] ?? wrapped[3] ?? '').trim()
  const isQuoted = wrapped !== null && wrapped[3] === undefined
  return token === '' || token.includes('"') || (/\s/.test(token) && !isQuoted) || /please/i.test(token)
}

/**
 * The rest of the line after the first `[CLAIM]` that is a claim's own tag: any one not inside quotes or backticks and not
 * right after a possessive (`v18's [CLAIM] …`) or after my, your, his, her, their, its, the, a, own, confirm, quote(d),
 * send, sends or sent, which quote or report another claim.
 */
function claimSubjectOf(text: string): string | undefined {
  for (const line of unstamped(text).split('\n')) {
    for (const m of line.matchAll(/\[CLAIM\]/gi)) {
      const before = line.slice(0, m.index)
      if (((before.match(/["`“”]/g)?.length ?? 0) % 2) === 1) continue
      if (/(?:['’]s|\b(?:my|your|his|her|their|its|the|a|own|confirm|quote|quoted|send|sends|sent))\s*$/i.test(before)) continue
      return line.slice(m.index + m[0].length).trim()
    }
  }
  return undefined
}

/**
 * The target token of a claim subject after its role word, lower-cased: the first word, or the inside of a quoted or
 * bracketed start, after a leading `of`, `the` or `for`; cut at a `,`, `;`, `(` or `|` and without quotes, a leading `*` or trailing `.:!)*`.
 * `research core-aa (u1, sonnet)` → `core-aa`, `build #155 (hydration fix)` → `#155`, `build (docs/x.md)` → `docs/x.md`.
 */
function claimTarget(rest: string): string {
  const r = rest.trim().replace(/^(?:of|the|for)\s+/i, '')
  const wrapped = /^(?:"([^"]*)"|`([^`]*)`|\(([^)]*)\))/.exec(r)
  const token = wrapped === null ? (r.split(/\s/)[0] ?? '') : (wrapped[1] ?? wrapped[2] ?? wrapped[3] ?? '').trim()
  return (token.toLowerCase().replace(/[`"'„“”]/g, '').replace(/^\*+/, '').split(/[,;(|]/)[0] ?? '').replace(/[.:!)*]+$/, '')
}

/**
 * The claim a message makes: `[CLAIM] <role> <target>` on its first line, else after the first `[CLAIM]` anywhere in it
 * (`Slice wanted: [CLAIM] build #158 (…)` inside a hello); the target is its target token (see `claimTarget`), never the
 * words after it. None when the subject is a fragment or its first word is no role (`build`, `review`, `research`), none
 * for a first line `[CLAIM] <target> is withdrawn|is released …`, which releases it, and none for a first line that reports
 * who holds it (`[CLAIM] <target> is already taken: …`, `… claimed by w2`; see `isClaimReport`).
 */
export function claimOf(text: string): ClaimRef | undefined {
  if (isClaimReport(firstLine(text, 400))) return undefined
  const subject = CLAIM_TAG.exec(firstLine(text, 400))?.[1] ?? claimSubjectOf(text)
  if (subject === undefined || isFragment(subject)) return undefined
  const words = subject.trim().split(/\s+/)
  const role = ROLE_WORDS[(words[0] ?? '').toLowerCase().replace(/[:,]$/, '')]
  if (role === undefined) return undefined
  const target = claimTarget(subject.trim().slice((words[0] ?? '').length))
  return target === '' ? undefined : { role, target }
}

const RELEASE_TAG = /^(?:<[^>]*>\s*)?\[(?:RELEASE|WITHDRAW)\]\s*(.+)$/i
const RELEASED = String.raw`(?!(?:the|my|a|an|it|this|that)\b)((?:(?:build|review|research)\s+)?[^\s,;:()]+)`
const RELEASE_SAID = new RegExp(String.raw`^(?:<[^>]*>\s*)?(?:\[[A-Za-z]+\]\s*)?(?:[\w-]+:\s*)?(?:I\s+(?:release|withdraw|drop\s+my\s+claim\s+on)\s+${RELEASED}|I\s+drop\s+my\s+${RELEASED}\s+claim\b|Yield(?:ing)?\s+${RELEASED}\s+to\s)`, 'i')
const CLAIM_RELEASED = new RegExp(String.raw`^(?:<[^>]*>\s*)?\[CLAIM\]\s*${RELEASED}\s+is\s+(?:withdrawn|released)\b`, 'i')
const CLAIM_REPORTED = new RegExp(String.raw`^(?:<[^>]*>\s*)?\[CLAIM\]\s*${RELEASED}\s+(?:is\s+(?:already\s+)?(?:taken|held)\b|is\s+already\s+claimed\b|(?:is\s+)?(?:already\s+)?(?:claimed|held|taken)\s+by\b)`, 'i')

/**
 * Whether a first line is `[CLAIM] <target> is withdrawn|released …`, or reports a holder: `[CLAIM] <target> is (already)
 * taken|held`, `is already claimed`, or `(is) claimed|held|taken by …`. No claim.
 */
function isClaimReport(line: string): boolean {
  return CLAIM_RELEASED.test(line) || CLAIM_REPORTED.test(line)
}
const RELEASED_TO = new RegExp(String.raw`^(?:the\s+)?${RELEASED}\s+claim\s+is\s+released\s+to\s`, 'i')

/**
 * What a message gives up, or undefined: the target after a first-line `[RELEASE] <target>` or `[WITHDRAW] <target>`; the
 * one word (after an optional role word) of a first clause, after an optional `<name>:`, `I release|withdraw|drop my claim
 * on <target>`, `I drop my <target> claim` or `Yielding <target> to …`; or of a first-line sentence `The <target> claim is
 * released to …`; or of a first line `[CLAIM] <target> is withdrawn|is released …`, which is no claim. A word that is `the`, `my`, `a`, `an`, `it`, `this` or `that` names no target. Nothing else is a release.
 */
export function releaseOf(text: string): string | undefined {
  const line = firstLine(text, 400)
  const said = RELEASE_SAID.exec(line.split(/\.\s|;|\s[—–-]\s/)[0] ?? '')
  const target = RELEASE_TAG.exec(line)?.[1] ?? CLAIM_RELEASED.exec(line)?.[1] ?? said?.slice(1).find(g => g !== undefined) ?? line.split(/\.\s|;\s*/).map(s => RELEASED_TO.exec(s.trim())?.[1]).find(g => g !== undefined)
  return target === undefined || target.trim() === '' ? undefined : target.trim()
}

/**
 * Whether a text names a claim target: its first word, that word's file name, the file name without its extension, or the
 * file name's leading number (`03` for `docs/03-accounts.md`), each as a whole word.
 */
export function mentionsTarget(text: string, target: string): boolean {
  const t = text.toLowerCase()
  const head = (target.toLowerCase().split(/[\s(,;]/)[0] ?? '').replace(/[.:!]+$/, '')
  const base = baseName(head)
  const words = [head, base, base.replace(/\.[a-z][a-z0-9]{0,7}$/, ''), /^(\d+)-/.exec(base)?.[1] ?? ''].filter(w => w.length >= 2)
  const esc = (w: string) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return words.some(w => new RegExp(`(^|[^\\w-])${esc(w)}($|[^\\w-])`).test(t))
}

/** The `Deliverable: <path>` lines of a brief; several split on `,` or `;`. */
export function deliverablesOf(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(DELIVERABLE_LINE)) {
    for (const part of (m[1] ?? '').split(/[;,]/)) {
      const d = part.replace(/[`*_]/g, '').trim()
      if (d !== '' && !out.includes(d)) out.push(d)
    }
  }
  return out
}

function baseName(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path
}

/**
 * Whether a claim target names a deliverable: same path, same file name, the target contains its file name, or the target's
 * first word is the deliverable's trailing segment or its `#<n>` (`#155 (cache bug …)` names `repo#155`). An empty target names any.
 */
export function targetMatches(target: string, deliverable: string): boolean {
  const t = target.toLowerCase().trim()
  const d = deliverable.toLowerCase().trim()
  if (t === '' || d === '') return t === ''
  if (t === d || baseName(t) === baseName(d) || t.includes(baseName(d))) return true
  const head = (t.split(/[\s(,;]/)[0] ?? '').replace(/[.:!]+$/, '')
  const issue = /#\d+$/.exec(d)?.[0]
  return head !== '' && (head === baseName(d) || head === issue)
}

/**
 * Whether two claim targets (or a target and a path) name the same thing, judged on their first words: equal targets; the
 * same `#<n>` (`#155`, `repo#155`); two paths where one ends the other at a segment boundary (`design/design.md`,
 * `/work/design/design.md`); a file name and a path ending in it (`notes.md`, `docs/notes.md`); or one file name. Other words
 * match only when the whole targets are equal.
 */
export function sameTarget(a: string, b: string): boolean {
  const x = a.toLowerCase().trim()
  const y = b.toLowerCase().trim()
  if (x === y) return x !== ''
  const head = (t: string) => (t.split(/[\s(,;]/)[0] ?? '').replace(/[.:!]+$/, '')
  const hx = head(x)
  const hy = head(y)
  if (hx === '' || hy === '') return false
  const ix = /#\d+$/.exec(hx)?.[0]
  const iy = /#\d+$/.exec(hy)?.[0]
  if (ix !== undefined || iy !== undefined) return ix === iy
  const isFile = (h: string) => /\.[a-z][a-z0-9]{0,7}$/.test(h)
  const ends = (long: string, short: string) => long === short || long.endsWith('/' + short.replace(/^\/+/, ''))
  if (hx.includes('/') && hy.includes('/')) return ends(hx, hy) || ends(hy, hx)
  if (hx.includes('/')) return isFile(hy) && ends(hx, hy)
  if (hy.includes('/')) return isFile(hx) && ends(hy, hx)
  return isFile(hx) && hx === hy
}

/** Task rows from task files; fields the format does not carry stay empty. */
export function parseTasks(files: readonly string[]): TaskRow[] {
  const out: TaskRow[] = []
  for (const text of files) {
    try {
      const t = JSON.parse(text) as Record<string, unknown>
      const subject = [t.subject, t.title, t.content].find(v => typeof v === 'string') as string | undefined
      const owner = [t.owner, t.assignee].find(v => typeof v === 'string' && v.trim() !== '') as string | undefined
      out.push({ subject: subject ?? '', owner, status: typeof t.status === 'string' ? t.status : 'pending' })
    } catch {
      continue
    }
  }
  return out
}

/** Who claimed which artefact or slice, from `[CLAIM]` messages and task-list owners. */
export class ClaimBoard {
  private readonly fromMessages = new Map<string, Claim>()
  private fromTasks = new Map<string, Claim>()
  /** The task-list claims of tasks not completed. */
  private openTasks = new Map<string, Claim>()
  unclaimedTasks: string[] = []
  deliverables: string[] = []

  /** Review states by slice, then reviewer: the last `[REVIEW] … approve` or `[BLOCK]` each sent. */
  readonly reviews = new Map<string, Map<string, ReviewState>>()
  /** When each claimant last sent each claim, by `key` then claimant, as a running count. */
  private readonly lastSent = new Map<string, Map<string, number>>()
  /** Whether a claimant (bare team name) is still on the team; one that ended holds no claim against a later claimant. */
  isLive: (name: string) => boolean = () => true
  /** Each claimant's first claim by `key`: its order stamp and time, where known. */
  private readonly since = new Map<string, Map<string, { stamp?: number; at?: number }>>()
  /** Each teammate's latest `[DONE]`, `[REVIEW]` or `[BLOCK]`: its type and the running count when sent. */
  readonly reports = new Map<string, { type: string; at: number }>()
  /** The running count at which each claimant last reported on each claim (see `report`), by `key` then claimant. */
  private readonly closed = new Map<string, Map<string, number>>()
  /** The later claimants of each claim, by `key`: those whose build or research claim found a holder (see `heldBefore`), or whose review claim found a live reviewer. */
  private readonly later = new Map<string, Set<string>>()
  private sent = 0

  private static put(map: Map<string, Claim>, by: string, ref: ClaimRef): boolean {
    const key = ref.role + ' ' + ref.target
    const claim = map.get(key) ?? { ...ref, key, by: [] }
    map.set(key, claim)
    if (claim.by.includes(by)) return false
    claim.by.push(by)
    return true
  }

  /** Records a review verdict for a slice; returns whether it changed. */
  review(by: string, verdict: { slice: string; state: ReviewState }): boolean {
    const name = bareName(by)
    const states = this.reviews.get(verdict.slice) ?? new Map<string, ReviewState>()
    this.reviews.set(verdict.slice, states)
    if (states.get(name) === verdict.state) return false
    states.set(name, verdict.state)
    return true
  }

  /** The running count at which `by` last sent the claim `key`; 0 for task-list claims. */
  sentAt(key: string, by: string): number {
    return this.lastSent.get(key)?.get(by) ?? 0
  }

  /** Restores a roster.json's `claims` and `deliverables`; returns whether anything was added. */
  restore(json: unknown): boolean {
    if (!json || typeof json !== 'object') return false
    const j = json as { claims?: unknown; deliverables?: unknown }
    let changed = false
    if (Array.isArray(j.claims)) {
      for (const c of j.claims as Partial<Claim>[]) {
        if (typeof c?.role !== 'string' || typeof c.target !== 'string' || !Array.isArray(c.by)) continue
        for (const by of c.by) if (typeof by === 'string' && this.claim(by, { role: c.role, target: c.target })) changed = true
      }
    }
    if (Array.isArray(j.deliverables)) changed = this.addDeliverables(j.deliverables.filter((d): d is string => typeof d === 'string')) || changed
    return changed
  }

  /** The claim already on the board with the same role and a target `sameTarget` matches, else `ref` itself. */
  canonical(ref: ClaimRef): ClaimRef {
    if (this.fromMessages.has(ref.role + ' ' + ref.target)) return ref
    const c = [...this.fromMessages.values()].find(x => x.role === ref.role && sameTarget(x.target, ref.target))
    return c === undefined ? ref : { role: c.role, target: c.target }
  }

  /**
   * Records a claim message under the claim with the same role and a matching target, if any; `isSend` false (a delivery
   * seen later) leaves its order as sent; `at` is its order stamp and time, renewed when `by` no longer held it. A build or research claim that finds a holder, or a
   * review claim on a slice a live teammate already reviews, is a later claim; the sender's later claims on other slices lapse
   * (see `isActive`). Returns whether it was new.
   */
  claim(by: string, given: ClaimRef, isSend = true, at: { stamp?: number; at?: number } = {}): boolean {
    const ref = this.canonical(given)
    const name = bareName(by)
    const key = ref.role + ' ' + ref.target
    const since = this.since.get(key) ?? new Map<string, { stamp?: number; at?: number }>()
    this.since.set(key, since)
    const prior = since.get(name)
    const held = this.fromMessages.get(key)
    const holds = held !== undefined && held.by.includes(name) && this.isActive(held, name)
    if (prior === undefined || (prior.stamp === undefined && prior.at === undefined) || (isSend && !holds)) since.set(name, at)
    const sent = this.lastSent.get(key) ?? new Map<string, number>()
    this.lastSent.set(key, sent)
    if (isSend || !sent.has(name)) sent.set(name, ++this.sent)
    const later = this.later.get(key) ?? new Set<string>()
    this.later.set(key, later)
    const isLater = ref.role === 'review' ? held !== undefined && held.by.some(n => n !== name && this.isActive(held, n)) : this.heldBefore(by, ref) !== undefined
    if (isLater) later.add(name)
    else later.delete(name)
    this.close(name, this.sent, c => c.key !== key && this.later.get(c.key)?.has(name) === true)
    return ClaimBoard.put(this.fromMessages, name, ref)
  }

  /** Closes, at count `at`, each message claim of `name` that `which` picks. */
  private close(name: string, at: number, which: (c: Claim) => boolean) {
    for (const c of this.fromMessages.values()) {
      if (!c.by.includes(name) || !which(c)) continue
      const closed = this.closed.get(c.key) ?? new Map<string, number>()
      this.closed.set(c.key, closed)
      closed.set(name, at)
    }
  }

  /**
   * Who held a build or research claim before `by` claimed the same target: a live owner of a task on that target not completed, of the
   * same role or with no role word, unless `by` owns one too; else, of the claimants by message that still hold it (see
   * `isActive`), the one with the lowest order stamp, or the first to claim when any claim has none; with when and as which
   * stamp. Undefined when `by` owns such a task, came first, or nobody else still holds it.
   */
  heldBefore(by: string, given: ClaimRef): { key: string; target: string; holder: string; stamp?: number; at?: number } | undefined {
    if (given.role !== 'build' && given.role !== 'research') return undefined
    const ref = this.canonical(given)
    const key = ref.role + ' ' + ref.target
    const name = bareName(by)
    const tasks = [...this.openTasks.values()].filter(c => (c.role === ref.role || c.role === 'other') && sameTarget(c.target, ref.target))
    if (tasks.some(c => c.by.includes(name))) return undefined
    const owner = tasks.flatMap(c => c.by).find(n => this.isLive(n))
    if (owner !== undefined) return { key, target: ref.target, holder: owner }
    const claim = this.fromMessages.get(key)
    if (claim === undefined) return undefined
    const since = this.since.get(key)
    const rivals = claim.by.filter(n => n === name || this.isActive(claim, n))
    const stamps = rivals.map(n => since?.get(n)?.stamp)
    const first = stamps.every(s => s !== undefined) ? rivals[stamps.indexOf(Math.min(...(stamps as number[])))] : rivals[0]
    if (first === undefined || first === name) return undefined
    return { key, target: ref.target, holder: first, ...since?.get(first) }
  }

  /**
   * Whether `name` still holds claim `c`: it is live and, for a message claim, has not reported on it since it last claimed it;
   * a later claim (one that found a holder) also lapses at its sender's next report or claim of another slice.
   */
  isActive(c: Claim, name: string): boolean {
    if (!this.isLive(name)) return false
    if (!this.fromMessages.get(c.key)?.by.includes(name)) return true
    return this.sentAt(c.key, name) > (this.closed.get(c.key)?.get(name) ?? 0)
  }

  /**
   * Records a `[DONE]`, `[REVIEW]` or `[BLOCK]` from `by` and closes its claims per slice: a `[DONE]` closes the claims of `by`
   * on the slices its first line names, a `[REVIEW]` the review claims of `by` on them; one naming no slice on the board closes
   * every claim of `by` (a `[DONE]`) or every review claim of `by` (a `[REVIEW]`); a `[BLOCK]` closes none. Every report closes
   * the later claims of `by`. Nothing else closes, so the other claims of `by` stay open. `isSend` false (a delivery seen later)
   * keeps an earlier report. Returns whether it changed.
   */
  report(by: string, type: string, isSend = true, text = ''): boolean {
    const name = bareName(by)
    if (!isSend && this.reports.has(name)) return false
    const at = ++this.sent
    this.reports.set(name, { type, at })
    const isLater = (c: Claim) => this.later.get(c.key)?.has(name) === true
    if (type === 'BLOCK') {
      this.close(name, at, isLater)
      return true
    }
    const subject = firstLine(text, 400).replace(/^(?:<[^>]*>\s*)?\[[A-Za-z]+\]\s*/, '')
    const named = [...this.fromMessages.values()].filter(c => mentionsTarget(subject, c.target))
    const pool = [...this.fromMessages.values()].filter(c => c.by.includes(name) && (type === 'DONE' || c.role === 'review'))
    const closing = named.length > 0 ? pool.filter(c => named.includes(c)) : pool
    this.close(name, at, c => closing.includes(c) || isLater(c))
    return true
  }

  /**
   * Takes `by` off its own message claims a release names (see `releaseOf`): each one whose target its text names before its
   * first sentence end or `[CLAIM]` (`[RELEASE] web-ab, web-ac`, `[WITHDRAW] h10 withdraws the 06-web-app claim`), of its role
   * when it starts with a role word (`[WITHDRAW] build docs/a.md`); a `[CLAIM]` of another slice on the same line releases
   * nothing. Returns whether any changed.
   */
  release(by: string, text: string): boolean {
    return this.releasing(by, text).length > 0
  }

  /** Does what `release` does; returns the claims `by` was taken off. */
  releasing(by: string, text: string): Claim[] {
    const what = releaseOf(text)
    if (what === undefined) return []
    const name = bareName(by)
    const head = what.trim().split(/\s+/)[0] ?? ''
    const role = ROLE_WORDS[head.toLowerCase().replace(/[:,]$/, '')]
    const named = (what.split(/\[CLAIM\]/i)[0] ?? '').split(/[.!?](?:\s|$)/)[0] ?? ''
    const gone = [...this.fromMessages.values()].filter(c => c.by.includes(name) && (role === undefined || role === c.role) && mentionsTarget(named, c.target))
    for (const c of gone) {
      c.by.splice(c.by.indexOf(name), 1)
      this.since.get(c.key)?.delete(name)
      this.lastSent.get(c.key)?.delete(name)
      if (c.by.length === 0) this.fromMessages.delete(c.key)
    }
    return gone
  }

  /**
   * The claimant who holds `c` first now that its holder released it: the active claimant `heldBefore` finds no holder for,
   * which no longer counts as a later claimant; undefined when nobody still holds it.
   */
  handOff(c: Claim): string | undefined {
    const next = this.fromMessages.get(c.key)?.by.find(n => this.isActive(c, n) && this.heldBefore(n, c) === undefined)
    if (next !== undefined) this.later.get(c.key)?.delete(next)
    return next
  }

  /** The message claims a release from `by` names (see `releasing`) that another teammate still holds and `by` does not. */
  heldByOthers(by: string, text: string): Claim[] {
    const what = releaseOf(text)
    if (what === undefined) return []
    const name = bareName(by)
    const named = (what.split(/\[CLAIM\]/i)[0] ?? '').split(/[.!?](?:\s|$)/)[0] ?? ''
    return [...this.fromMessages.values()].filter(c => !c.by.includes(name) && c.by.some(n => this.isActive(c, n)) && mentionsTarget(named, c.target))
  }

  /** Deliverables no build or research claim names, then unowned tasks: the slices a later claimant could take instead. */
  unclaimed(): string[] {
    const held = this.all().filter(c => c.role === 'build' || c.role === 'research')
    return [...this.deliverables.filter(d => !held.some(c => targetMatches(c.target, d))), ...this.unclaimedTasks]
  }

  /** The message claims `by` still holds (see `isActive`). */
  openClaims(by: string): Claim[] {
    const name = bareName(by)
    return [...this.fromMessages.values()].filter(c => c.by.includes(name) && this.isActive(c, name))
  }

  /** Replaces the task-list claims: an owned task claims its subject for its owner; an owner `resolve` maps to undefined claims nothing. */
  setTasks(tasks: readonly TaskRow[], resolve: (owner: string) => string | undefined) {
    const next = new Map<string, Claim>()
    const open = new Map<string, Claim>()
    const unclaimed: string[] = []
    for (const t of tasks) {
      if (t.status === 'deleted') continue
      if (t.owner !== undefined) {
        const owner = resolve(t.owner)
        if (owner !== undefined) ClaimBoard.put(next, owner, parseClaimSubject(t.subject))
        if (owner !== undefined && t.status !== 'completed') ClaimBoard.put(open, owner, parseClaimSubject(t.subject))
      }
      else if (t.status !== 'completed' && t.subject !== '') unclaimed.push(t.subject)
    }
    this.fromTasks = next
    this.openTasks = open
    this.unclaimedTasks = unclaimed
  }

  /** Whether any `[CLAIM]`, `[REVIEW]` or `[BLOCK]` message is on the board. */
  hasMessageClaims(): boolean {
    return this.fromMessages.size > 0 || this.reviews.size > 0
  }

  /** Drops every message claim, review verdict and deliverable; task-list claims stay until the next `setTasks`. */
  clear() {
    this.fromMessages.clear()
    this.reviews.clear()
    this.lastSent.clear()
    this.since.clear()
    this.reports.clear()
    this.closed.clear()
    this.later.clear()
    this.sent = 0
    this.deliverables = []
  }

  addDeliverables(list: readonly string[]): boolean {
    let changed = false
    for (const d of list) if (!this.deliverables.includes(d)) {
      this.deliverables.push(d)
      changed = true
    }
    return changed
  }

  /** Message and task claims merged by key, claimants in first-seen order. */
  all(): Claim[] {
    const merged = new Map<string, Claim>()
    for (const map of [this.fromMessages, this.fromTasks]) {
      for (const c of map.values()) {
        const m = merged.get(c.key) ?? { ...c, by: [] }
        for (const b of c.by) if (!m.by.includes(b)) m.by.push(b)
        merged.set(c.key, m)
      }
    }
    return [...merged.values()]
  }

  claimants(): Set<string> {
    const out = new Set<string>()
    for (const c of this.all()) for (const b of c.by) out.add(b)
    return out
  }

  /** Build claims on one slice still held (see `isActive`) by two or more teammates, merged per slice. */
  duplicates(): Claim[] {
    const bySlice = new Map<string, Claim>()
    for (const c of this.all()) {
      if (c.role !== 'build') continue
      const slice = sliceOf(c.target, this.deliverables)
      const m = bySlice.get(slice) ?? { role: 'build', target: slice, key: 'build ' + slice, by: [] }
      for (const b of c.by) if (!m.by.includes(b) && this.isActive(c, b)) m.by.push(b)
      bySlice.set(slice, m)
    }
    return [...bySlice.values()].filter(c => c.by.length > 1)
  }

  /** Deliverables no build claim names; none while no deliverable is known. */
  missingBuilders(): string[] {
    const builds = this.all().filter(c => c.role === 'build')
    return this.deliverables.filter(d => !builds.some(c => targetMatches(c.target, d)))
  }
}

/** A teammate working without a claim: its label and when it started (spawn, else first message; undefined when unknown). */
export type UnclaimedWorker = { label: string; startedAt: number | undefined }

export type ClaimWatchInput = {
  now: number
  claimMs: number
  sawDoneOrHandoff: boolean
  missingBuilders: readonly string[]
  unclaimedWorkers: readonly UnclaimedWorker[]
}

/**
 * The claim watchdog's conditions that hold now, each with a stable key so it fires once. Unclaimed work counts once 2+
 * teammates have each worked unclaimed for `claimMs` since their own start.
 */
export function claimAlerts(i: ClaimWatchInput): { key: string; text: string }[] {
  const out: { key: string; text: string }[] = []
  if (i.claimMs <= 0) return out
  const overdue = i.unclaimedWorkers.filter(u => u.startedAt !== undefined && i.now - u.startedAt >= i.claimMs).map(u => u.label)
  const late = overdue.length >= 2
  if (i.sawDoneOrHandoff || late) {
    for (const d of i.missingBuilders) out.push({ key: 'no-builder ' + d, text: `swarm: no builder claimed for ${d}` })
  }
  if (late) out.push({ key: 'unclaimed-work', text: `swarm: ${overdue.length} teammates working without a [CLAIM]: ${overdue.join(', ')}` })
  return out
}

/**
 * The claim a logged line made: its `claim` field, else for a line logged without one the claim its first line makes; none
 * when its first line releases or reports a claim (see `claimOf`), though an older log stored one.
 */
export function claimOfLine(e: LogEntry): ClaimRef | undefined {
  if (isClaimReport(e.summary)) return undefined
  const c = e.claim
  if (c !== undefined && typeof c.role === 'string' && typeof c.target === 'string') return { role: c.role, target: c.target }
  return claimOf(e.summary)
}

/** Replays this session's logged `[CLAIM]`, releases, `[DONE]`, `[REVIEW]` and `[BLOCK]` lines from teammates, sent at `since` or later, onto the board; returns whether any was new. */
export function hydrateClaims(board: ClaimBoard, lines: readonly LogEntry[], session: string, since = -Infinity): boolean {
  let changed = false
  for (const e of lines) {
    if (e.session !== session || e.ts < since || isLeadAddress(e.from) || isModName(e.from) || isIdleLine(e) || isToolLine(e)) continue
    const ref = claimOfLine(e)
    if (ref !== undefined && board.claim(e.from, ref, e.via !== 'receive', { stamp: e.stamp, at: e.ts })) changed = true
    if (board.release(e.from, e.summary)) changed = true
    const verdict = reviewOf(e.summary)
    if (verdict !== undefined && board.review(e.from, verdict)) changed = true
    const type = typeOf(e.summary)
    if (type !== undefined && REPORTS.includes(type) && board.report(e.from, type, e.via !== 'receive', e.summary)) changed = true
  }
  return changed
}

export type ReviewState = 'approve' | 'block'

/** The slice a claim target names: its first `#<n>`, else the deliverable it names, else its first clause. */
export function sliceOf(target: string, deliverables: readonly string[] = []): string {
  const issue = /#\d+/.exec(target)?.[0]
  if (issue !== undefined) return issue
  const d = target === '' ? undefined : deliverables.find(x => targetMatches(target, x))
  if (d !== undefined) return /#\d+$/.exec(d)?.[0] ?? d
  return clauseOf(target)
}

/** A claim target's first clause: `final gate — ack, you review #141` → `final gate`. */
export function clauseOf(target: string): string {
  return (target.split(/\s+[—–]\s+|\s+-\s+|\s*[(;,]|\.(?:\s|$)/)[0] ?? '').trim() || target
}

/** A first-line `[REVIEW] … approve` (not a request) or `[BLOCK] …` with the slice it names; undefined for any other message. */
export function reviewOf(text: string): { slice: string; state: ReviewState } | undefined {
  const line = firstLine(text, 400).replace(/^(?:<[^>]*>\s*)?/, '')
  const m = /^\[(REVIEW|BLOCK)\]\s*(.*)$/i.exec(line)
  if (!m) return undefined
  const rest = m[2] ?? ''
  const issue = /#\d+/.exec(rest)?.[0]
  if (issue === undefined) return undefined
  if (m[1]!.toUpperCase() === 'BLOCK' || /\b(block|blocked|blocking|reject|rejected)\b/i.test(rest.split(/\s[—–-]\s/)[0] ?? '')) return { slice: issue, state: 'block' }
  if (/\brequest\b/i.test(rest)) return undefined
  return /\bapprov(?:e|ed|es)\b/i.test(rest) ? { slice: issue, state: 'approve' } : undefined
}

/** The claim watchdog's wake: its alerts, then what to do; the builder line only when the swarm has deliverables. */
export function claimWakeText(alerts: readonly { text: string }[], hasDeliverables = true): string {
  const act = hasDeliverables
    ? 'Assign the builder now: set the task owner and tell the assignee to send [CLAIM] build <artefact>.'
    : 'Ask them to claim a slice with [CLAIM] <role> <slice>, or set a task owner.'
  return [...alerts.map(a => a.text), act + ' Claims: /swarm pane, .swarm/roster.json.'].join('\n')
}

const SLICE_ROLES = ['build', 'review', 'research'] as const
const STATE_MARK: Record<ReviewState, string> = { approve: '✓approve', block: '✗block' }

/**
 * The pane's CLAIMS lines: one per deliverable or slice (`#158 · build ridge (t1) · review Kestrel (t2) ✓approve`, a deliverable
 * without a builder as `build unclaimed`, two builders or researchers still holding it as `⚠ duplicate`, a builder's own `[BLOCK]` on its build), then one
 * `other` line with each teammate's latest other claims, then unowned tasks.
 */
export function claimLines(board: ClaimBoard, label: (name: string) => string): string[] {
  const slices = new Map<string, Record<(typeof SLICE_ROLES)[number], string[]>>()
  const at = (slice: string) => {
    const roles = slices.get(slice) ?? { build: [], review: [], research: [] }
    slices.set(slice, roles)
    return roles
  }
  for (const d of board.deliverables) at(sliceOf(d))
  const holding = new Map<string, Set<string>>()
  const others = new Map<string, { what: string; at: number }[]>()
  for (const c of board.all()) {
    const role = (SLICE_ROLES as readonly string[]).includes(c.role) ? (c.role as (typeof SLICE_ROLES)[number]) : undefined
    if (role !== undefined) {
      const slice = sliceOf(c.target, board.deliverables)
      const names = at(slice)[role]
      const held = holding.get(slice + ' ' + role) ?? new Set<string>()
      holding.set(slice + ' ' + role, held)
      for (const b of c.by) {
        if (!names.includes(b)) names.push(b)
        if (board.isActive(c, b)) held.add(b)
      }
      continue
    }
    const what = clauseOf(c.target) || c.role
    for (const b of c.by) {
      const list = others.get(b) ?? []
      others.set(b, list)
      const head = what.split(' ')[0]
      const sent = board.sentAt(c.key, b)
      const i = list.findIndex(o => o.what.split(' ')[0] === head)
      if (i < 0) list.push({ what, at: sent })
      else if (sent >= list[i]!.at) list[i] = { what, at: sent }
    }
  }
  for (const [slice, states] of board.reviews) for (const by of states.keys()) {
    const roles = at(slice)
    if (!roles.review.includes(by) && !roles.build.includes(by)) roles.review.push(by)
  }
  const out: string[] = []
  const isDuplicate = (slice: string, role: string) => (holding.get(slice + ' ' + role)?.size ?? 0) > 1
  for (const [slice, roles] of slices) {
    const states = board.reviews.get(slice)
    const parts = [slice]
    if (roles.build.length === 0 && board.deliverables.some(d => sliceOf(d) === slice)) parts.push('build unclaimed')
    const marked = (n: string) => label(n) + (states?.has(n) ? ' ' + STATE_MARK[states.get(n)!] : '')
    if (roles.build.length > 0) parts.push(`build ${roles.build.map(b => (states?.get(b) === 'block' ? marked(b) : label(b))).join(', ')}${isDuplicate(slice, 'build') ? ' ⚠ duplicate' : ''}`)
    if (roles.review.length > 0) parts.push('review ' + roles.review.filter(r => !roles.build.includes(r)).map(marked).join(', '))
    if (roles.research.length > 0) parts.push(`research ${roles.research.map(label).join(', ')}${isDuplicate(slice, 'research') ? ' ⚠ duplicate' : ''}`)
    out.push(parts.join(' · '))
  }
  if (others.size > 0) {
    const parts = [...others].map(([b, list]) => `${label(b)}: ${list.sort((x, y) => y.at - x.at).map(o => o.what).join(', ')}`)
    out.push('other · ' + parts.join(' · '))
  }
  for (const t of board.unclaimedTasks) out.push(`task ${t} · unclaimed`)
  return out
}

/** The absolute path a first-line `[WAIT] <path>` names: up to the first whitespace, or all of a backticked one; undefined if none. */
export function waitPathOf(text: string): string | undefined {
  const m = /^\[WAIT\]\s+(?:`(\/[^`]+)`|(\/\S+))/i.exec(firstLine(text, 400).replace(/^(?:<[^>]*>\s*)?/, ''))
  return m?.[1] ?? m?.[2]
}

/** The time a first-line `[WAIT] until <ISO-8601 time>` names, in ms, or undefined. */
export function waitUntilOf(text: string): number | undefined {
  const m = /^\[WAIT\]\s+until\s+(\d{4}-\d\d-\d\dT\S+)/i.exec(firstLine(text, 400).replace(/^(?:<[^>]*>\s*)?/, ''))
  const t = m === null ? NaN : Date.parse(m[1]!)
  return Number.isNaN(t) ? undefined : t
}

/**
 * A teammate's registered wait: a file or a time, when the turn that sent it started (its last idle notice, else its start;
 * 0 for a time), and the mtime or time it was last woken for.
 */
export type Wait = { path?: string; until?: number; since: number; wokenFor?: number }

/** Whether a wait is due: its teammate is idle, and the file changed (or the time came) after the wait's turn started and after the last wake. */
export function isWaitDue(w: Wait, idleSince: number | undefined, mtime: number | undefined): boolean {
  return idleSince !== undefined && mtime !== undefined && mtime > w.since && mtime !== w.wokenFor
}

/** The wake a waiting teammate gets: the path and the file's first 200 characters on one line. */
export function waitWakeText(path: string, content: string): string {
  return `[ASK] ${path} changed: ${content.replace(/\s+/g, ' ').trim().slice(0, 200)}`
}

/** The wake a teammate waiting for a time gets. */
export function waitTimeText(until: number): string {
  return `[ASK] ${new Date(until).toISOString()} reached: the time your [WAIT] named`
}
