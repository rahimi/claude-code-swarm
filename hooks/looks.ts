// What every pane look shares: the view it draws, the frame it returns, palettes, badges and small drawing helpers.

import { Grid, hex, mix } from './grid'

import type { Canvas } from './pixels'
import type { AgentState, Card, CardStatus, Level, ModelFamily, Scene, SceneAgent, SceneMessage } from './replay'

/** An agent's state in the view: `ended` for every agent once the team has ended, else its state at the view's time. */
export function stateIn(scene: Scene, name: string, v: View): AgentState {
  return v.isEnded === true ? 'ended' : scene.stateAt(name, v.now)
}

/** How long a message travels sender → receiver on screen, in real ms. */
export const PULSE_MS = 700
/** How long a state change or a card change glows, in real ms. */
export const FLASH_MS = 900

export type View = {
  cols: number
  rows: number
  level: Level
  /** The run's time now: the replayed time, or the clock live. */
  now: number
  runFrom: number
  /** The run's end; live, the time now. */
  runTo: number
  title: string
  /** The replay speed; absent live. */
  speed?: number
  /** Live, once every teammate of the team has ended: `now` and `runTo` hold at its last activity. */
  isEnded?: boolean
  isPaused: boolean
  /** Real ms since the event of run time `ts` reached the pane; Infinity for one it never played. */
  age: (ts: number) => number
  /** The agent whose threads the person picked; the rest draw dim. */
  filter?: string
  /** A short dim note for the header: `replay finished`, `live swarm running`. */
  note?: string
}

type XY = [number, number]
type RGB = [number, number, number]

/** A message on the sky, in the picture's pixels: from `a` bent toward `q` to `b`, `stop` of the way; `age`, real ms since it was sent. */
export type SkyLine = { a: XY; q: XY; b: XY; stop: number; rgb: RGB; age: number; held?: boolean; lead?: boolean }

/**
 * Everything the sky renderer paints, in the picture's pixels: the backdrop's colours, the membrane, edges with their
 * weights, leader lines, the lead's rays and beads, the lit edges and comets, the agents; `u` and `nu` scale strokes and
 * marks.
 */
export type SkyScene = {
  w: number
  h: number
  u: number
  nu: number
  centre: XY
  membrane: number
  ground: RGB
  haze: RGB
  star: RGB
  membraneRgb: RGB
  accent: RGB
  dim: RGB
  rule: RGB
  stalled: RGB
  /** `age`, while the first message between the two is still on its way: the edge grows behind it. */
  edges: { a: XY; q: XY; b: XY; w: number; rgb: RGB; lit: number; age?: number }[]
  leaders: { pts: XY[]; rgb: RGB; lit: number }[]
  rays: number
  /** The lead's delivered wakes once the rays are capped, drawn as a number in the ring; 0 below the cap. */
  count: number
  beads: number
  lit: SkyLine[]
  comets: SkyLine[]
  nodes: { x: number; y: number; rgb: RGB; state: string; lit: number }[]
  litMs: number
  flightMs: number
  landMs: number
}

/**
 * A picture over a box of cells: `sig` names everything it draws from, so a pane sends it again only when `sig` changes,
 * at most once per `IMAGE_MIN_MS`. `draw` makes the pixels, sent raw within `IMAGE_BUDGET`.
 */
export type ImageLayer = {
  key: string
  x: number
  y: number
  cols: number
  rows: number
  sig: string
  draw: () => Canvas
  /** The colour of the cells under the picture, where a terminal that fits it inside its box leaves them bare. */
  ground?: number
  /** Set where a renderer process may paint this picture instead: the scene it paints. */
  stream?: SkyScene
  alt: string
}

/**
 * A drawn frame; `fadeMs`, the real ms its images still change by themselves (a lit edge fading), and `motionMs`, the
 * real ms its cells still move by themselves (a comet flying), when they do.
 */
export type Frame = { grid: Grid; images: ImageLayer[]; links: { label: string; href: string }[]; fadeMs?: number; motionMs?: number }
export type LookFn = (scene: Scene, view: View) => Frame

export type Palette = {
  name: string
  bg: number
  panel: number
  rule: number
  text: number
  dim: number
  accent: number
  agents: readonly number[]
  state: Record<AgentState, number>
  status: Record<CardStatus, number>
  model: Record<ModelFamily, number>
}

export function palette(p: {
  name: string
  bg: string
  panel: string
  rule: string
  text: string
  dim: string
  accent: string
  agents: readonly string[]
  state: Record<AgentState, string>
  status: Record<CardStatus, string>
  model: Record<ModelFamily, string>
}): Palette {
  const map = <K extends string>(r: Record<K, string>) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, hex(v as string)])) as Record<K, number>
  return { ...p, bg: hex(p.bg), panel: hex(p.panel), rule: hex(p.rule), text: hex(p.text), dim: hex(p.dim), accent: hex(p.accent), agents: p.agents.map(hex), state: map(p.state), status: map(p.status), model: map(p.model) }
}

export const MODEL_GLYPH: Record<ModelFamily, string> = { opus: '◆', sonnet: '●', haiku: '▲', fable: '✦' }
export const STATUS_WORD: Record<CardStatus, string> = { unclaimed: 'UNCLAIMED', open: 'OPEN', building: 'BUILDING', done: 'DONE', approved: 'APPROVED', blocked: 'BLOCKED' }

export function agentColor(p: Palette, a: SceneAgent | undefined): number {
  return a === undefined ? p.text : p.agents[a.index % p.agents.length]!
}

/** A colour for an address: the agent's, the accent for the lead, the dim text for anything else. */
export function nameColor(p: Palette, scene: Scene, name: string): number {
  const a = scene.agents.get(name)
  if (a !== undefined) return agentColor(p, a)
  return name === 'team-lead' || name === 'main' || name === 'lead' ? p.text : p.dim
}

/** Whether a message is one of the filtered agent's threads; every message is without a filter. */
export function touches(filter: string | undefined, from: string, to: string): boolean {
  return filter === undefined || from === filter || to === filter
}

/** `mm:ss` (or `h:mm:ss`) of a duration. */
export function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

/** The most base64 characters an Image source may carry (about 75 KB of RGBA pixels), so a redraw never stalls the console. */
export const IMAGE_BUDGET = 100_000

/** The least real time between two sky sources. */
export const SKY_MIN_MS = 2_000
/** Pixels per terminal cell, across and down: the types give a mod no cell size, so the common one. */
export const CELL_PX = { w: 10, h: 20 }

/** Pixels per cell column for an image of `cols` × `rows` cells (a cell twice as tall as wide) inside the budget, at most `max`. */
export function pixelScale(cols: number, rows: number, max = 8): number {
  const pixels = Math.floor((IMAGE_BUDGET * 3) / 4 / 4)
  return Math.min(max, Math.floor(Math.sqrt(pixels / Math.max(1, cols * rows * 2)) * 100) / 100)
}

const STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200].map(s => s * 1000)

/** A round slot length so `slots` of them cover `span` ms: the slots hold still while a live run grows. */
export function slotMs(span: number, slots: number): number {
  const want = span / Math.max(1, slots)
  return STEPS.find(s => s >= want) ?? Math.ceil(want / 3_600_000) * 3_600_000
}

/** The messages the look tells as events: sends and the mod's own, newest last. */
export function sends(scene: Scene): SceneMessage[] {
  return scene.messages.filter(m => m.kind === 'send')
}

/** Spells a word with a space between letters, for titles. */
export function spaced(s: string): string {
  return [...s].join(' ')
}

/** A brightness bump for an event `age` real ms old: full at once, gone after `ms`. */
export function fade(age: number, ms = FLASH_MS): number {
  return age < 0 || age >= ms ? 0 : (1 - age / ms) ** 2
}

/** A left agent's light once its fade-out ends. */
const LEFT_LIT = 0.35
/** How long, in real ms, the header names an agent that joined or left. */
export const MOVE_NOTE_MS = 10_000

/** An agent's light, 0 → 1: rising over `FLASH_MS` after it joined; once it left, falling over `FLASH_MS` to `LEFT_LIT`. */
export function presence(a: SceneAgent, v: View): number {
  if (a.leftAt !== undefined && a.leftAt <= v.now) return LEFT_LIT + (1 - LEFT_LIT) * fade(v.age(a.leftAt))
  return 1 - fade(v.age(a.joinedAt))
}

/** The header's note on the agents that joined or left in the last `MOVE_NOTE_MS`: `+ joined Kite · − left w2`. */
export function movesNote(scene: Scene, v: View): string | undefined {
  const isRecent = (t: number | undefined) => t !== undefined && t <= v.now && v.age(t) >= 0 && v.age(t) < MOVE_NOTE_MS
  const hasLeft = (a: SceneAgent) => a.leftAt !== undefined && a.leftAt <= v.now
  const joined = scene.order().filter(a => isRecent(a.joinedAt) && !hasLeft(a)).map(a => scene.label(a.name))
  const left = scene.order().filter(a => isRecent(a.leftAt)).map(a => scene.label(a.name))
  const parts = [...(joined.length > 0 ? [`+ joined ${joined.join(', ')}`] : []), ...(left.length > 0 ? [`− left ${left.join(', ')}`] : [])]
  return parts.length > 0 ? parts.join(' · ') : undefined
}

/** The messages in flight now, each with how far it has travelled (0 → 1). */
export function inFlight(scene: Scene, view: View): { m: SceneMessage; t: number }[] {
  const out: { m: SceneMessage; t: number }[] = []
  for (let i = scene.messages.length - 1; i >= 0; i--) {
    const m = scene.messages[i]!
    const age = view.age(m.ts)
    if (age >= PULSE_MS) break
    if (m.kind === 'send' && age >= 0) out.push({ m, t: age / PULSE_MS })
  }
  return out.reverse()
}

/** The display width of a string in cells, counting each BMP code point as one. */
export function width(s: string): number {
  return [...s].length
}

/** Counts per slot of `slot` ms from `from`, `slots` of them. */
export function histogram(times: readonly number[], from: number, slot: number, slots: number): number[] {
  const out = new Array<number>(Math.max(1, slots)).fill(0)
  for (const t of times) {
    const i = Math.floor((t - from) / slot)
    if (i >= 0 && i < out.length) out[i]!++
  }
  return out
}

/** The absolute paths the claim cards name, as `file://` links, newest first. */
export function cardLinks(cards: readonly Card[], max = 4): { label: string; href: string }[] {
  const out: { label: string; href: string }[] = []
  for (const c of cards) {
    if (c.path === undefined || !c.path.startsWith('/') || out.some(l => l.href === 'file://' + c.path)) continue
    out.push({ label: c.path.split('/').pop() ?? c.path, href: 'file://' + c.path })
  }
  return out.slice(0, max)
}

export { Grid, mix }
