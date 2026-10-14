// Look B, "constellation": the team as a star map around the lead, messages as comets along its edges.

import type { ImageSource } from 'claude-code'
import { ago } from './core'

import { Canvas } from './pixels'
import { pngSource } from './png'
import { cardTitle } from './replay'
import type { AgentState, Scene, SceneAgent, SceneMessage } from './replay'
import {
  FLASH_MS,
  Grid,
  MODEL_GLYPH,
  agentColor,
  cardLinks,
  fade,
  mix,
  nameColor,
  palette,
  SKY_BUDGET,
  SKY_MIN_MS,
  CELL_PX,
  sends,
  spaced,
  stateIn,
  timeOfDay,
  touches,
  width,
} from './looks'
import type { Frame, ImageLayer, SkyScene, View } from './looks'

export const NEBULA = palette({
  name: 'Nebula',
  bg: '#07060E',
  panel: '#0E0C1F',
  rule: '#2A2547',
  text: '#EDE9FF',
  dim: '#6E6890',
  accent: '#FFE6A8',
  agents: ['#FF6FA3', '#FFC65C', '#5FE3E0', '#9D8CFF', '#7CF5A0', '#FF9D5C', '#5CA8FF', '#F2F07A'],
  state: { running: '#EDE9FF', idle: '#6E6890', waiting: '#5FE3E0', stalled: '#FF4F6D', quiet: '#2A2547', ended: '#6E6890' },
  status: { unclaimed: '#6E6890', open: '#9D8CFF', building: '#FFC65C', done: '#5FE3E0', approved: '#7CF5A0', blocked: '#FF4F6D' },
  model: { opus: '#C9B8FF', sonnet: '#8FD3FF', haiku: '#A8F0C0', fable: '#FFE6A8' },
})

const P = NEBULA
const LEAD = 'team-lead'
const MEMBRANE = 0x5a51a0
const STATE_GLYPH: Record<AgentState, string> = { running: '◉', idle: '○', waiting: '◌', stalled: '⊗', quiet: '·', ended: '○' }

type Node = { name: string; x: number; y: number; side: 'left' | 'right'; labelRow: number }

/**
 * Where each agent sits: evenly round an ellipse about the centre, turned a little off the axes so no two line up; in cell
 * units. An agent left of the centre has its label in the left margin, the rest in the right.
 */
function layout(agents: readonly SceneAgent[], cx: number, cy: number, rx: number, ry: number): Node[] {
  const n = agents.length
  const start = -Math.PI / 2 - Math.PI / Math.max(1, n) + 0.3
  return agents.map((a, k) => {
    const ang = start + (k * 2 * Math.PI) / Math.max(1, n)
    const x = cx + Math.cos(ang) * rx
    return { name: a.name, x, y: cy + Math.sin(ang) * ry, side: x < cx ? 'left' : 'right', labelRow: 0 }
  })
}

/** Spreads the label rows of one side so no two sit closer than `gap`, keeping them in order and inside [top, bottom]. */
function spreadLabels(nodes: Node[], top: number, bottom: number, gap: number) {
  for (const side of ['left', 'right'] as const) {
    const list = nodes.filter(n => n.side === side).sort((a, b) => a.y - b.y)
    let next = top
    for (const n of list) {
      n.labelRow = Math.max(next, Math.round(n.y))
      next = n.labelRow + gap
    }
    let last = bottom
    for (const n of [...list].reverse()) {
      n.labelRow = Math.min(n.labelRow, last)
      last = n.labelRow - gap
    }
  }
}

/** A smooth in-out easing of 0 → 1. */
function ease(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2
}

/** A deterministic pseudo-random 0..1 for a position: the star field never flickers between frames. */
function hash(x: number, y: number): number {
  let h = (x * 374761393 + y * 668265263) ^ 0x5bd1e995
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

type Geometry = { gx: number; gy: number; gw: number; gh: number; cx: number; cy: number; membrane: number; nodes: Node[] }

function geometry(scene: Scene, v: View, wide: boolean): Geometry {
  const margin = wide ? Math.min(18, Math.floor(v.cols * 0.2)) : 0
  const legend = wide ? 0 : Math.ceil(scene.agents.size / 2)
  const gx = margin
  const gy = 1
  const gw = v.cols - 2 * margin
  const gh = Math.max(6, v.rows - 5 - legend)
  const cx = Math.floor(gx + gw / 2) + 0.5
  const cy = Math.floor(gy + gh / 2) + 0.5
  const rx = Math.max(4, gw / 2 - 4)
  const ry = Math.max(2, gh / 2 - 1.2)
  const nodes = layout(scene.order(), cx, cy, rx, ry).map(n => ({ ...n, x: Math.floor(n.x) + 0.5, y: Math.floor(n.y) + 0.5 }))
  spreadLabels(nodes, gy, gy + gh - 2, 2)
  return { gx, gy, gw, gh, cx, cy, membrane: Math.max(2.5, Math.min(rx, ry * 2) * 0.24), nodes }
}

function pos(geo: Geometry, name: string): { x: number; y: number } | undefined {
  if (name === LEAD || name === 'main' || name === 'lead') return { x: geo.cx, y: geo.cy }
  return geo.nodes.find(n => n.name === name)
}

/** The weight of each edge, both directions together, as 0..1 of the busiest. */
function edgeWeights(scene: Scene): Map<string, { a: string; b: string; w: number }> {
  const out = new Map<string, { a: string; b: string; w: number }>()
  for (const [key, n] of scene.edges) {
    const [a, b] = key.split('>') as [string, string]
    const k = a < b ? a + '|' + b : b + '|' + a
    const e = out.get(k) ?? { a, b, w: 0 }
    e.w += n
    out.set(k, e)
  }
  const peak = Math.max(1, ...[...out.values()].map(e => e.w))
  for (const e of out.values()) e.w /= peak
  return out
}

/** Where a message travels: sender to receiver, stopping at the membrane (`stop` < 1) for one the lead filter holds back. */
function pathOf(geo: Geometry, from: string, to: string, held: boolean | undefined) {
  const a = pos(geo, from)
  const b = pos(geo, to)
  if (a === undefined || b === undefined) return undefined
  if (held !== true) return { a, b, stop: 1 }
  const len = Math.hypot((b.x - a.x) * 2, (b.y - a.y) * 4)
  return { a, b, stop: Math.max(0.1, 1 - (geo.membrane * 2) / Math.max(1, len)) }
}

/** Colour channels are rounded to this step before a basic-sky cell is written, so a frame stays under the Raster's 1024 colour pairs. */
const QUANT = 8
/** The most labelled flights at once on the basic sky. */
export const WORDS_MAX = 6
/** How long a held comet's splash on the membrane and a delivered comet's flare at its receiver last, in real ms. */
const SPLASH_MS = 400
const FLARE_MS = 300
/** The pixels of a comet's trail on the basic sky: a few cells, one pixel thick. */
const TRAIL = 6

function quant(c: number): number {
  const q = (s: number) => Math.min(255, Math.round(((c >> s) & 255) / QUANT) * QUANT)
  return (q(16) << 16) | (q(8) << 8) | q(0)
}

function luma(c: number): number {
  return 0.3 * ((c >> 16) & 255) + 0.59 * ((c >> 8) & 255) + 0.11 * (c & 255)
}

/** A point of the quadratic curve a → b bent toward `c` by `bend`. */
function curveAt(a: { x: number; y: number }, b: { x: number; y: number }, c: { x: number; y: number }, t: number, bend = 0.18): { x: number; y: number } {
  const mx = (a.x + b.x) / 2
  const my = (a.y + b.y) / 2
  const qx = mx + (c.x - mx) * bend
  const qy = my + (c.y - my) * bend
  return { x: (1 - t) * (1 - t) * a.x + 2 * (1 - t) * t * qx + t * t * b.x, y: (1 - t) * (1 - t) * a.y + 2 * (1 - t) * t * qy + t * t * b.y }
}

/** The fraction of a flight (0 → 1) at which its eased head reaches `stop`. */
function arrivalT(stop: number): number {
  let lo = 0
  let hi = 1
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2
    if (ease(mid) < stop) lo = mid
    else hi = mid
  }
  return hi
}

/** The word a message flies as: its type, else the bracketed tag of its summary, else `msg`. */
function wordOf(m: SceneMessage): string {
  return (m.type ?? /^\s*\[([A-Z]+)\]/.exec(m.summary)?.[1] ?? 'msg').toLowerCase()
}

/**
 * Look B's basic sky: the sky as a bitmap of half cells, `▀` with a 24-bit colour above and below, glow from
 * the colour of an area; braille only for curved edges and the membrane. Each message flies as a comet with its type
 * riding quietly behind the head, a burst (one sender, one word) bundled as `claim ×5`, at most `WORDS_MAX` words at
 * once. Its edge lights up behind it, a pair's first edge growing with its first comet. A comet the lead filter holds
 * stops at the membrane with a splash; one that lands flares its receiver. Returns how long, in real ms, the cells still
 * move by themselves.
 */
function drawBasicSky(g: Grid, scene: Scene, v: View, geo: Geometry, wide: boolean): number {
  const W = geo.gw
  const H = geo.gh * 2
  const pt = (p: { x: number; y: number }) => ({ x: p.x - geo.gx, y: (p.y - geo.gy) * 2 })
  const centre = pt({ x: geo.cx, y: geo.cy })
  const c = new Canvas(W, H, P.bg)
  c.glow(centre.x, centre.y, Math.min(W, H) * 0.5, 0x120f2e, 1.0)
  const hs = Math.max(0.65, Math.min(1, geo.gw / 64))

  type Fly = { m: SceneMessage; age: number; a: { x: number; y: number }; b: { x: number; y: number }; stop: number; color: number }
  const flying: Fly[] = []
  let motion = 0
  for (let i = scene.messages.length - 1; i >= 0; i--) {
    const m = scene.messages[i]!
    const age = v.age(m.ts)
    if (age >= FLIGHT_MS + ARRIVAL_MS) break
    if (m.kind !== 'send' || age < 0) continue
    const path = pathOf(geo, m.from, m.to, m.held)
    if (path === undefined) continue
    motion = Math.max(motion, FLIGHT_MS + ARRIVAL_MS - age)
    flying.push({ m, age, a: path.a, b: path.b, stop: path.stop, color: nameColor(P, scene, m.from) })
  }
  flying.reverse()
  const word = new Map<SceneMessage, string>()
  const bursts: { from: string; w: string; ts: number; n: number; lead: SceneMessage }[] = []
  for (const f of flying) {
    const w = wordOf(f.m)
    const b = bursts.find(x => x.from === f.m.from && x.w === w && f.m.ts - x.ts < BURST_MS)
    if (b === undefined) bursts.push({ from: f.m.from, w, ts: f.m.ts, n: 1, lead: f.m })
    else {
      b.n++
      if (f.m.to === LEAD || f.m.to === 'main') b.lead = f.m
    }
  }
  for (const b of bursts.sort((x, y) => y.ts - x.ts).slice(0, WORDS_MAX)) word.set(b.lead, b.w + (b.n > 1 ? ' ×' + b.n : ''))

  const flare = new Map<string, number>()
  type Head = { x: number; y: number; dir: number; word: string; color: number }
  const heads: Head[] = []
  const rests: { x: number; y: number; word: string; color: number; k: number }[] = []
  for (const f of flying) {
    const A = pt(f.a)
    const B = pt(f.b)
    const t = Math.min(1, f.age / FLIGHT_MS)
    const tLand = arrivalT(f.stop)
    const head = Math.min(f.stop, ease(t))
    const landedFor = f.age - tLand * FLIGHT_MS
    if (landedFor < 0) {
      const p = curveAt(A, B, centre, head)
      // One pixel of head with a faint halo under a cell; a one-pixel trail of at most TRAIL pixels, fading fast.
      const length = Math.max(1, Math.hypot(B.x - A.x, B.y - A.y))
      for (let k = TRAIL; k >= 1; k--) {
        const tt = head - k / length
        if (tt < 0.02) continue
        const q = curveAt(A, B, centre, tt)
        c.blend(Math.floor(q.x), Math.floor(q.y), f.color, 0.75 * (1 - k / (TRAIL + 1)) ** 2)
      }
      c.glow(p.x, p.y, 0.6, f.color, 0.35)
      c.blend(Math.floor(p.x), Math.floor(p.y), mix(f.color, 0xffffff, 0.7), 1)
      heads.push({ x: p.x, y: p.y, dir: Math.sign(B.x - A.x) || 1, word: word.get(f.m) ?? '', color: f.color })
    } else if (f.m.held === true) {
      if (landedFor < SPLASH_MS) {
        const k = 1 - landedFor / SPLASH_MS
        const p = curveAt(A, B, centre, f.stop)
        c.glow(p.x, p.y, 0.6 + 0.6 * (1 - k), mix(MEMBRANE, 0xffffff, 0.5 * k), 0.9 * k)
      }
    } else {
      if (landedFor < FLARE_MS) flare.set(f.m.to === 'main' ? LEAD : f.m.to, Math.max(flare.get(f.m.to) ?? 0, 1 - landedFor / FLARE_MS))
      const w = word.get(f.m)
      if (!wide && w !== undefined && landedFor < ARRIVAL_MS) rests.push({ x: B.x, y: B.y, word: w, color: f.color, k: 1 - landedFor / ARRIVAL_MS })
    }
  }

  const sun = flare.get(LEAD) ?? 0
  // At rest the lead is one calm pixel with a faint halo under a cell; a delivered wake flares it, within two cells, for FLARE_MS.
  c.glow(centre.x, centre.y, 0.6 + 1.0 * sun, P.accent, 0.25 + 0.65 * sun)
  if (sun > 0) c.blend(Math.floor(centre.x), Math.floor(centre.y), mix(P.accent, 0xffffff, 0.5), sun)
  const halos: { n: Node; state: AgentState; color: number; lit: number; bump: number }[] = []
  for (const n of geo.nodes) {
    const a = scene.agents.get(n.name)!
    const state = stateIn(scene, a.name, v)
    const color = state === 'stalled' ? P.state.stalled : agentColor(P, a)
    const lit = v.filter !== undefined && v.filter !== n.name ? 0.3 : 1
    const seg = a.segments[a.segments.length - 1]
    const bump = Math.max(seg === undefined ? 0 : fade(v.age(seg.from), FLASH_MS), flare.get(n.name) ?? 0)
    halos.push({ n, state, color, lit, bump })
    if (state === 'quiet') continue
    const p = pt(n)
    const r = state === 'running' ? 1.15 : state === 'stalled' ? 1.25 : state === 'waiting' ? 0.85 : 0.65
    const a0 = state === 'idle' || state === 'ended' ? 0.2 : state === 'waiting' ? 0.35 : 0.5
    c.glow(p.x, p.y, (r + 0.4 * bump) * hs, color, (a0 + 0.3 * bump) * lit)
    if (state === 'running' || bump > 0) c.blend(Math.floor(p.x), Math.floor(p.y), mix(color, 0xffffff, 0.5 + 0.5 * bump), lit)
  }

  const rgb = c.rgb()
  const at = (x: number, y: number) => {
    const i = (y * W + x) * 3
    return quant((rgb[i]! << 16) | (rgb[i + 1]! << 8) | rgb[i + 2]!)
  }
  const bright = new Uint8Array(W * geo.gh)
  for (let y = 0; y < geo.gh; y++) for (let x = 0; x < W; x++) {
    const top = at(x, 2 * y)
    const bot = at(x, 2 * y + 1)
    if (top === bot) g.put(geo.gx + x, geo.gy + y, ' ', top, top)
    else g.put(geo.gx + x, geo.gy + y, '▀', top, bot)
    if (Math.max(luma(top), luma(bot)) > 60) bright[y * W + x] = 1
  }
  const cellBg = (x: number, y: number) => g.bg[y * g.cols + x]!
  const isBright = (x: number, y: number) => x < geo.gx || y < geo.gy || x >= geo.gx + W || y >= geo.gy + geo.gh || bright[(y - geo.gy) * W + (x - geo.gx)] === 1
  const dot = (dx: number, dy: number, color: number, k: number) => {
    const x = Math.floor(dx) >> 1
    const y = Math.floor(dy) >> 2
    if (!isBright(x, y)) g.dot(dx, dy, quant(mix(cellBg(x, y), color, k)))
  }

  for (let y = geo.gy; y < geo.gy + geo.gh; y++) for (let x = geo.gx; x < geo.gx + geo.gw; x++) {
    const r = hash(x, y)
    if (r < 0.03) dot(x * 2 + ((r * 100) % 2), y * 4 + ((r * 1000) % 4), P.text, 0.2 + r * 10)
  }
  const rm = geo.membrane * 2
  const ring = Math.max(12, Math.ceil(rm * 6))
  for (let k = 0; k < ring; k++) {
    if (Math.floor(k / 3) % 2 === 1) continue
    const a = (k / ring) * Math.PI * 2
    dot(geo.cx * 2 + Math.cos(a) * rm, geo.cy * 4 + Math.sin(a) * rm, mix(MEMBRANE, P.text, 0.25), 1)
  }

  // Edges as braille curves; a pair's edge whose first comet still flies shows only as far as that comet got.
  const norm = (n: string) => (n === 'main' || n === 'lead' ? LEAD : n)
  const pairOf = (x: string, y: string) => [norm(x), norm(y)].sort().join('|')
  const first = new Map<string, SceneMessage>()
  for (const m of scene.messages) if (m.kind === 'send' && !first.has(pairOf(m.from, m.to))) first.set(pairOf(m.from, m.to), m)
  const sweep = (pa: { x: number; y: number }, pb: { x: number; y: number }, from: number, to: number, color: (t: number) => number, k: number) => {
    const steps = Math.ceil(Math.hypot((pb.x - pa.x) * 2, (pb.y - pa.y) * 4)) + 4
    for (let i = 0; i <= steps; i++) {
      const t = i / steps
      if (t < Math.max(0.06, from) || t > Math.min(0.94, to)) continue
      const p = curveAt(pa, pb, { x: geo.cx, y: geo.cy }, t)
      dot(p.x * 2, p.y * 4, color(t), k)
    }
  }
  for (const e of edgeWeights(scene).values()) {
    const m = first.get(pairOf(e.a, e.b))
    const age = m === undefined ? Infinity : v.age(m.ts)
    const young = age >= 0 && age < FLIGHT_MS
    const [from, to] = young && norm(m!.from) !== e.a ? [e.b, e.a] : [e.a, e.b]
    const pa = pos(geo, from)
    const pb = pos(geo, to)
    if (pa === undefined || pb === undefined) continue
    const ca = nameColor(P, scene, from)
    const cb = nameColor(P, scene, to)
    const lit = touches(v.filter, e.a, e.b) ? 1 : 0.25
    sweep(pa, pb, 0, young ? ease(age / FLIGHT_MS) : 1, t => mix(ca, cb, t), (0.4 + 0.6 * e.w) * lit)
  }
  // The edge behind a comet in flight lights up in the sender's colour, from the sender to the head.
  for (const f of flying) {
    const t = f.age / FLIGHT_MS
    if (t >= 1) continue
    sweep(f.a, f.b, 0, Math.min(f.stop, ease(t)), () => mix(f.color, 0xffffff, 0.25), 0.95)
  }

  if (geo.gx > 0) {
    for (const n of geo.nodes) {
      const color = agentColor(P, scene.agents.get(n.name))
      const ink = v.filter !== undefined && v.filter !== n.name ? mix(color, P.bg, 0.6) : color
      const edge = n.side === 'left' ? geo.gx * 2 : (geo.gx + geo.gw) * 2 - 1
      const knee = n.side === 'left' ? n.x * 2 - 6 : n.x * 2 + 8
      g.line(edge, n.labelRow * 4 + 2, knee, n.labelRow * 4 + 2, quant(mix(P.bg, ink, 0.3)))
      g.line(knee, n.labelRow * 4 + 2, n.x * 2 + (n.side === 'left' ? -2 : 2), n.y * 4, quant(mix(P.bg, ink, 0.3)))
    }
  }

  const sx = Math.floor(geo.cx)
  const sy = Math.floor(geo.cy)
  g.put(sx, sy, '◉', quant(mix(P.accent, 0xffffff, sun)), cellBg(sx, sy))
  leadWakes(g, scene, v, sx, sy)
  for (const h of halos) {
    const x = Math.floor(h.n.x)
    const y = Math.floor(h.n.y)
    const fg = h.state === 'quiet' ? P.rule : mix(mix(h.color, 0xffffff, h.state === 'running' ? 0.6 : 0.2), 0xffffff, 0.5 * h.bump)
    g.put(x, y, STATE_GLYPH[h.state], quant(h.state === 'quiet' ? P.rule : mix(P.bg, fg, h.lit)), cellBg(x, y))
  }

  // Words: quiet, behind the head; with no label margins, a landed word rests under its receiver.
  const write = (x0: number, y: number, text: string, fg: (x: number) => number) => {
    if (y < geo.gy || y >= geo.gy + geo.gh) return
    for (let i = 0; i < width(text); i++) {
      const x = x0 + i
      if (x < geo.gx || x >= geo.gx + geo.gw) continue
      const ch = g.ch[y * g.cols + x]!
      if (ch === 0x2580 || ch === 32 || (ch >= 0x2800 && ch <= 0x28ff)) g.put(x, y, text[i]!, quant(fg(x)), cellBg(x, y))
    }
  }
  for (const h of heads) {
    if (h.word === '') continue
    const hx = Math.floor(h.x) + geo.gx
    const hy = Math.floor(h.y / 2) + geo.gy
    const x0 = Math.max(geo.gx, Math.min(geo.gx + geo.gw - width(h.word), h.dir > 0 ? hx - 1 - width(h.word) : hx + 2))
    write(x0, hy, h.word, x => mix(cellBg(x, hy), mix(h.color, P.text, 0.4), 0.55))
  }
  for (const r of rests) {
    const hx = Math.floor(r.x) + geo.gx
    const y = Math.floor(r.y / 2) + geo.gy + 1
    write(Math.max(geo.gx, hx - (width(r.word) >> 1)), y, r.word, x => mix(cellBg(x, y), mix(r.color, P.text, 0.4), 0.6 * r.k))
  }
  return motion
}

/** The wakes beside the lead: `▲ n` delivered on its left, `▽ n` held on its right, each lit as one lands, and `LEAD` below. */
function leadWakes(g: Grid, scene: Scene, v: View, sx: number, sy: number) {
  const last = (held: boolean) => scene.wakes.filter(w => w.held === held).at(-1)
  const lit = (held: boolean) => {
    const w = last(held)
    return w === undefined ? 0 : fade(v.age(w.ts), 1200)
  }
  g.textRight(sx, sy, ' ▲ ' + scene.delivered + ' ', mix(P.accent, 0xffffff, lit(false)))
  g.text(sx + 1, sy, ' ▽ ' + scene.held + ' ', mix(P.dim, P.text, lit(true)))
  g.text(sx - 1, sy + 1, 'LEAD', P.accent)
}

/** How long a message lights its edge on the rich sky, in real ms: three sky redraws, a step dimmer each. */
export const LIT_MS = 3 * SKY_MIN_MS

type Lit = { from: string; to: string; held?: boolean; level: number; age: number }

/** The edges messages light now, by `from>to`: level 3 for one sent in the last sky interval, 2 and 1 for older; at most the newest per edge. */
function litEdges(scene: Scene, v: View): { lit: Map<string, Lit>; fadeMs: number } {
  const lit = new Map<string, Lit>()
  let fadeMs = 0
  for (let i = scene.messages.length - 1; i >= 0; i--) {
    const m = scene.messages[i]!
    const age = v.age(m.ts)
    if (age >= LIT_MS) break
    if (m.kind !== 'send' || age < 0) continue
    fadeMs = Math.max(fadeMs, LIT_MS - age)
    const key = m.from + '>' + m.to
    const level = 3 - Math.floor(age / SKY_MIN_MS)
    if ((lit.get(key)?.level ?? 0) < level) lit.set(key, { from: m.from, to: m.to, ...(m.held === undefined ? {} : { held: m.held }), level, age })
  }
  return { lit, fadeMs }
}

/** How long a comet takes from sender to receiver, in real ms. */
export const FLIGHT_MS = 1_000
/** How long a burst of messages animates the sky at most, in real ms: the flight and a short landing. */
export const BURST_MS = 1_200
type Flight = { t: number; comets: SceneMessage[] }

/**
 * The burst in flight now: messages played within `BURST_MS` of the burst's first, which started less than `BURST_MS`
 * ago; all its comets fly together, `t` of the way (0 → 1 over `FLIGHT_MS`). Undefined when none flies.
 */
function flightOf(scene: Scene, v: View): Flight | undefined {
  const recent: { m: SceneMessage; age: number }[] = []
  for (let i = scene.messages.length - 1; i >= 0; i--) {
    const m = scene.messages[i]!
    const age = v.age(m.ts)
    if (age >= 5 * BURST_MS) break
    if (m.kind === 'send' && age >= 0) recent.push({ m, age })
  }
  let start: number | undefined
  let comets: SceneMessage[] = []
  for (const r of recent.reverse()) {
    if (start === undefined || start - r.age >= BURST_MS) {
      start = r.age
      comets = []
    }
    comets.push(r.m)
  }
  if (start === undefined || start >= BURST_MS) return undefined
  return { t: Math.min(1, start / FLIGHT_MS), comets }
}

/** What the PNG sky is drawn again for: the agents and their states, edge weights in quarters, the filter; lit edges and wakes wait for those. */
function skySig(scene: Scene, v: View, geo: Geometry): string {
  const states = scene.order().map(a => a.name + ':' + stateIn(scene, a.name, v)).join(',')
  const edges = [...edgeWeights(scene).entries()].map(([k, e]) => k + Math.ceil(e.w * 4)).sort().join(',')
  return [geo.gw, geo.gh, states, edges, v.filter ?? ''].join('/')
}

/** The least real time between two PNG skies, the fallback without the renderer: each costs the mod tens of ms. */
export const FALLBACK_SKY_MS = 10_000

/** The most pixels a sky is drawn with: a pane larger than about 1100 × 900 pixels gets a scaled-down sky. */
const SKY_MAX_PX = 1_000_000

let kept: { key: string; canvas: Canvas } | undefined

/** The sky's still backdrop, its glow and stars, kept for the last size and centre. */
function backdrop(W: number, H: number, ccx: number, ccy: number, u: number): Canvas {
  const key = [W, H, ccx, ccy, u].join('/')
  if (kept?.key === key) return kept.canvas
  const c = new Canvas(W, H, P.bg)
  c.glow(ccx, ccy, Math.min(W, H) * 0.45, 0x120f2e, 0.9)
  for (let i = 0; i < (W * H) / (900 * u * u); i++) {
    const b = hash(i, 29)
    c.disc(hash(i, 7) * W, hash(i, 13) * H, (0.35 + b * 0.5) * u, mix(P.bg, P.text, 0.15 + b * 0.45))
  }
  kept = { key, canvas: c }
  return c
}

/** The sky as a still picture: stars, edges, the membrane, the lead with its wakes as rays (delivered) and beads (held), the agents. */
function drawRichSky(scene: Scene, v: View, geo: Geometry, lit: Map<string, Lit>, scale = 1): Canvas {
  const kx = CELL_PX.w * scale
  const ky = CELL_PX.h * scale
  /** Pixel lengths below are given at 6 pixels a column; `u` scales them to this picture. */
  const u = Math.max(0.4, kx / 6)
  /** Nodes and the lead keep a size they read at. */
  const nu = Math.max(0.75, u)
  const W = geo.gw * kx
  const H = geo.gh * ky
  const px = (x: number) => (x - geo.gx) * kx
  const py = (y: number) => (y - geo.gy) * ky
  const ccx = px(Math.floor(geo.cx) + 0.5)
  const ccy = py(Math.floor(geo.cy) + 0.5)
  const c = backdrop(W, H, ccx, ccy, u).clone()
  const rm = geo.membrane * kx
  c.circle(ccx, ccy, rm, 0.7 * u, MEMBRANE, 0.9)
  const node = (p: { x: number; y: number }) => ({ x: px(Math.floor(p.x) + 0.5), y: py(Math.floor(p.y) + 0.5) })
  const bend = (a: { x: number; y: number }, b: { x: number; y: number }) => {
    const mx = (a.x + b.x) / 2
    const my = (a.y + b.y) / 2
    return { x: mx + (ccx - mx) * 0.18, y: my + (ccy - my) * 0.18 }
  }
  for (const e of edgeWeights(scene).values()) {
    const pa = pos(geo, e.a)
    const pb = pos(geo, e.b)
    if (pa === undefined || pb === undefined) continue
    const a = node(pa)
    const b = node(pb)
    const lit = touches(v.filter, e.a, e.b) ? 1 : 0.2
    const q = bend(a, b)
    c.curve(a.x, a.y, q.x, q.y, b.x, b.y, (0.5 + 1.6 * e.w) * u, mix(nameColor(P, scene, e.a), nameColor(P, scene, e.b), 0.5), (0.08 + 0.3 * e.w) * lit, 0, 1, true)
  }
  if (geo.gx > 0) {
    for (const n of geo.nodes) {
      const color = agentColor(P, scene.agents.get(n.name))
      const lit = v.filter !== undefined && v.filter !== n.name ? 0.3 : 1
      const ex = n.side === 'left' ? 0 : W
      const ey = py(n.labelRow + 0.5)
      const p = node(n)
      const kn = n.side === 'left' ? p.x - 2 * kx : p.x + 2 * kx
      c.line(ex, ey, kn, ey, 0.45 * u, color, 0.35 * lit)
      c.line(kn, ey, p.x, p.y, 0.45 * u, color, 0.35 * lit)
    }
  }
  const rays = Math.min(scene.delivered, 24)
  for (let i = 0; i < rays; i++) {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / 24
    c.line(ccx + Math.cos(a) * rm * 0.45, ccy + Math.sin(a) * rm * 0.45, ccx + Math.cos(a) * rm * 0.8, ccy + Math.sin(a) * rm * 0.8, 0.5 * u, P.accent, 0.9)
  }
  const beads = Math.min(scene.held, 24)
  for (let i = 0; i < beads; i++) {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / 24
    c.disc(ccx + Math.cos(a) * rm, ccy + Math.sin(a) * rm, 1.1 * u, P.dim)
  }
  for (const l of lit.values()) {
    const path = pathOf(geo, l.from, l.to, l.held)
    if (path === undefined) continue
    const color = nameColor(P, scene, l.from)
    const a = node(path.a)
    const b = node(path.b)
    const q = bend(a, b)
    c.curve(a.x, a.y, q.x, q.y, b.x, b.y, 1.2 * u, color, 0.3, 0, path.stop, true)
    const t = Math.min(path.stop, 0.9)
    const hx = (1 - t) * (1 - t) * a.x + 2 * (1 - t) * t * q.x + t * t * b.x
    const hy = (1 - t) * (1 - t) * a.y + 2 * (1 - t) * t * q.y + t * t * b.y
    c.glow(hx, hy, 6 * nu, color, 0.8)
    c.disc(hx, hy, 1.6 * nu, 0xffffff)
  }
  c.glow(ccx, ccy, 9 * nu, P.accent, 0.7)
  c.disc(ccx, ccy, 2.6 * nu, 0xffffff)
  for (const n of geo.nodes) {
    const a = scene.agents.get(n.name)!
    const state = stateIn(scene, a.name, v)
    const color = state === 'stalled' ? P.state.stalled : agentColor(P, a)
    const lit = v.filter !== undefined && v.filter !== n.name ? 0.3 : 1
    const { x: nx, y: ny } = node(n)
    if (state === 'quiet') {
      c.circle(nx, ny, 3 * nu, 0.5 * nu, P.rule)
      continue
    }
    const halo = state === 'running' ? 9 : state === 'stalled' ? 8 : 5
    c.glow(nx, ny, halo * nu, color, (state === 'idle' || state === 'ended' ? 0.25 : 0.6) * lit)
    if (state === 'waiting') {
      for (let k = 0; k < 12; k += 2) {
        const a0 = (k * Math.PI) / 6
        const a1 = ((k + 1) * Math.PI) / 6
        c.line(nx + Math.cos(a0) * 7 * nu, ny + Math.sin(a0) * 7 * nu, nx + Math.cos(a1) * 7 * nu, ny + Math.sin(a1) * 7 * nu, 0.6 * nu, color, lit)
      }
    }
    if (state === 'stalled') c.circle(nx, ny, 7 * nu, 0.9 * nu, P.state.stalled, lit)
    if (state === 'idle' || state === 'ended') c.circle(nx, ny, 4 * nu, 0.7 * nu, color, 0.8 * lit)
    else c.disc(nx, ny, 3 * nu, mix(color, 0xffffff, 0.55), lit)
  }
  return c
}

/**
 * The sky as a PNG at a cell's pixel size, at most `SKY_MAX_PX` pixels; one past `SKY_BUDGET` is drawn again at the
 * scale its size says fits, a tenth under, until it fits. Never skipped.
 */
function skySource(scene: Scene, v: View, geo: Geometry, lit: Map<string, Lit>): ImageSource {
  let scale = Math.min(1, Math.sqrt(SKY_MAX_PX / (geo.gw * CELL_PX.w * geo.gh * CELL_PX.h)))
  for (;;) {
    const c = drawRichSky(scene, v, geo, lit, scale)
    const src = pngSource(c.rgb(), c.w, c.h)
    if (src.png.length <= SKY_BUDGET || c.w * c.h <= 64) return src
    scale *= Math.sqrt(SKY_BUDGET / src.png.length) * 0.9
  }
}

const rgbOf = (c: number): [number, number, number] => [(c >> 16) & 255, (c >> 8) & 255, c & 255]

/**
 * The sky as a scene for the renderer process, in the pixels of the still sky at the scale its PNG would start at: the
 * same edges, leader lines, rays, beads, agents and lit edges, and the burst in flight as comets that set off together.
 */
function skyScene(scene: Scene, v: View, geo: Geometry, lit: Map<string, Lit>, flight: Flight | undefined): SkyScene {
  const scale = Math.min(1, Math.sqrt(SKY_MAX_PX / (geo.gw * CELL_PX.w * geo.gh * CELL_PX.h)))
  const kx = CELL_PX.w * scale
  const ky = CELL_PX.h * scale
  const u = Math.max(0.4, kx / 6)
  const W = Math.max(1, Math.floor(geo.gw * kx))
  const H = Math.max(1, Math.floor(geo.gh * ky))
  const node = (p: { x: number; y: number }): [number, number] => [(Math.floor(p.x) + 0.5 - geo.gx) * kx, (Math.floor(p.y) + 0.5 - geo.gy) * ky]
  const centre = node({ x: geo.cx, y: geo.cy })
  const bend = (a: [number, number], b: [number, number]): [number, number] => {
    const mx = (a[0] + b[0]) / 2
    const my = (a[1] + b[1]) / 2
    return [mx + (centre[0] - mx) * 0.18, my + (centre[1] - my) * 0.18]
  }
  const line = (from: string, to: string, held: boolean | undefined, age: number) => {
    const path = pathOf(geo, from, to, held)
    if (path === undefined) return []
    const a = node(path.a)
    const b = node(path.b)
    const toLead = to === LEAD || to === 'main' || to === 'lead'
    return [{ a, q: bend(a, b), b, stop: path.stop, rgb: rgbOf(nameColor(P, scene, from)), age, ...(toLead ? { lead: true, held: held === true } : {}) }]
  }
  const norm = (n: string) => (n === 'main' || n === 'lead' ? LEAD : n)
  const pairOf = (x: string, y: string) => [norm(x), norm(y)].sort().join('|')
  const first = new Map<string, SceneMessage>()
  for (const m of scene.messages) if (m.kind === 'send' && !first.has(pairOf(m.from, m.to))) first.set(pairOf(m.from, m.to), m)
  const edges = [...edgeWeights(scene).values()].flatMap(e => {
    const m = first.get(pairOf(e.a, e.b))
    const age = m === undefined ? Infinity : v.age(m.ts)
    const young = age >= 0 && age < FLIGHT_MS
    const [from, to] = young && norm(m!.from) !== e.a ? [e.b, e.a] : [e.a, e.b]
    const pa = pos(geo, from)
    const pb = pos(geo, to)
    if (pa === undefined || pb === undefined) return []
    const a = node(pa)
    const b = node(pb)
    return [{ a, q: bend(a, b), b, w: Math.ceil(e.w * 4) / 4, rgb: rgbOf(mix(nameColor(P, scene, e.a), nameColor(P, scene, e.b), 0.5)), lit: touches(v.filter, e.a, e.b) ? 1 : 0.2, ...(young ? { age } : {}) }]
  })
  const dimmed = (name: string) => (v.filter !== undefined && v.filter !== name ? 0.3 : 1)
  const leaders = geo.gx === 0 ? [] : geo.nodes.map(n => {
    const p = node(n)
    const ey = (n.labelRow + 0.5 - geo.gy) * ky
    const kn = n.side === 'left' ? p[0] - 2 * kx : p[0] + 2 * kx
    return { pts: [[n.side === 'left' ? 0 : W, ey], [kn, ey], p] as [number, number][], rgb: rgbOf(agentColor(P, scene.agents.get(n.name))), lit: dimmed(n.name) }
  })
  const nodes = geo.nodes.map(n => {
    const state = stateIn(scene, n.name, v)
    const [x, y] = node(n)
    return { x, y, rgb: rgbOf(state === 'stalled' ? P.state.stalled : agentColor(P, scene.agents.get(n.name))), state, lit: dimmed(n.name) }
  })
  return {
    w: W,
    h: H,
    u,
    nu: Math.max(0.75, u),
    centre,
    membrane: geo.membrane * kx,
    ground: rgbOf(P.bg),
    haze: rgbOf(0x120f2e),
    star: rgbOf(P.text),
    membraneRgb: rgbOf(MEMBRANE),
    accent: rgbOf(P.accent),
    dim: rgbOf(P.dim),
    rule: rgbOf(P.rule),
    stalled: rgbOf(P.state.stalled),
    edges,
    leaders,
    rays: Math.min(scene.delivered, 24),
    beads: Math.min(scene.held, 24),
    lit: [...lit.values()].flatMap(l => line(l.from, l.to, l.held, l.age)),
    comets: (flight?.comets ?? []).flatMap(m => line(m.from, m.to, m.held, flight!.t * FLIGHT_MS)),
    nodes,
    litMs: LIT_MS,
    flightMs: FLIGHT_MS,
    landMs: BURST_MS,
  }
}

/** How long a landed message's type shows under its receiver's name, in real ms. */
export const ARRIVAL_MS = 1_500

/** The types of the messages that landed at `name` in the last `ARRIVAL_MS`, a burst bundled: `claim ×3 · handoff`. */
function arrivals(scene: Scene, v: View, name: string): string {
  const counts = new Map<string, number>()
  for (let i = scene.messages.length - 1; i >= 0; i--) {
    const m = scene.messages[i]!
    const age = v.age(m.ts)
    if (age >= 5 * BURST_MS + ARRIVAL_MS) break
    if (m.kind !== 'send' || m.to !== name || age < FLIGHT_MS || age >= FLIGHT_MS + ARRIVAL_MS) continue
    const type = (m.type ?? 'message').toLowerCase()
    counts.set(type, (counts.get(type) ?? 0) + 1)
  }
  return [...counts].reverse().map(([t, n]) => (n > 1 ? `${t} ×${n}` : t)).join(' · ')
}

/** Look B at the view's size. */
export function lookB(scene: Scene, v: View): Frame {
  const g = new Grid(v.cols, v.rows, P.bg)
  const images: ImageLayer[] = []
  const wide = v.cols >= 72
  const geo = geometry(scene, v, wide)
  g.text(1, 0, '◎', P.accent)
  const badge = v.isEnded === true ? `■ ended · ran ${ago(v.runTo - v.runFrom)}` : v.speed === undefined ? '● live' : (v.isPaused ? '❚❚ ' : '▶ ') + v.speed + '×'
  const r = g.textRight(v.cols - 1, 0, badge, P.dim)
  const rt = g.textRight(r - 2, 0, timeOfDay(v.now), P.text)
  const tx = g.text(3, 0, spaced(v.title), P.text, undefined, Math.min(v.cols - 30, rt - 5))
  if (v.note !== undefined) g.text(tx + 2, 0, v.note, P.dim, undefined, rt - tx - 4)
  let fadeMs = 0
  const flight = v.level === 'rich' ? flightOf(scene, v) : undefined
  const lit = v.level === 'rich' ? litEdges(scene, v) : undefined
  const stream = lit === undefined ? undefined : skyScene(scene, v, geo, lit.lit, flight)
  if (lit !== undefined) {
    const sky = lit
    fadeMs = sky.fadeMs
    images.push({
      key: 'sky',
      x: geo.gx,
      y: geo.gy,
      cols: geo.gw,
      rows: geo.gh,
      sig: skySig(scene, v, geo),
      draw: () => drawRichSky(scene, v, geo, sky.lit),
      source: () => skySource(scene, v, geo, sky.lit),
      minMs: FALLBACK_SKY_MS,
      ground: P.bg,
      stream,
      alt: `star map of ${scene.agents.size} agents around the lead`,
    })
  } else fadeMs = drawBasicSky(g, scene, v, geo, wide)
  if (wide) {
    for (const n of geo.nodes) {
      const a = scene.agents.get(n.name)!
      const state = stateIn(scene, a.name, v)
      const isDim = v.filter !== undefined && v.filter !== n.name
      const ink = (c: number) => (isDim ? mix(c, P.bg, 0.6) : c)
      const name = (a.model === undefined ? '' : MODEL_GLYPH[a.model] + ' ') + (a.code ?? a.name)
      const landed = arrivals(scene, v, n.name)
      const sub = landed !== '' ? landed : `${a.code === undefined ? '' : a.name + ' · '}${state === 'quiet' ? 'not started' : state}`
      const w = geo.gx - 2
      const subInk = ink(landed !== '' ? P.accent : state === 'stalled' ? P.state.stalled : P.dim)
      if (n.side === 'left') {
        g.textRight(geo.gx - 1, n.labelRow, name.slice(0, w), ink(agentColor(P, a)))
        g.textRight(geo.gx - 1, n.labelRow + 1, sub.slice(0, w), subInk)
      } else {
        g.text(geo.gx + geo.gw + 1, n.labelRow, name, ink(agentColor(P, a)), undefined, w)
        g.text(geo.gx + geo.gw + 1, n.labelRow + 1, sub, subInk, undefined, w)
      }
    }
  }
  let y = geo.gy + geo.gh
  if (!wide) {
    const half = Math.floor(v.cols / 2)
    scene.order().forEach((a, i) => {
      const x = 1 + (i % 2) * half
      const row = y + Math.floor(i / 2)
      const state = stateIn(scene, a.name, v)
      const cx = g.text(x, row, STATE_GLYPH[state], state === 'stalled' ? P.state.stalled : agentColor(P, a))
      g.text(cx + 1, row, (a.model ? MODEL_GLYPH[a.model] + ' ' : '') + scene.label(a.name), agentColor(P, a), undefined, half - 3)
    })
    y += Math.ceil(scene.agents.size / 2)
  }
  const last = sends(scene).filter(m => touches(v.filter, m.from, m.to)).at(-1)
  if (last !== undefined) {
    const lit = fade(v.age(last.ts), 1200)
    const parts: [string, number][] = [
      [scene.label(last.from), nameColor(P, scene, last.from)],
      ['  →  ', P.dim],
      [scene.label(last.to), nameColor(P, scene, last.to)],
      ['   ' + (last.type ?? '') + '   ', mix(P.accent, 0xffffff, lit)],
      [last.summary.replace(/^\s*\[[A-Z]+\]\s*/, ''), mix(P.dim, P.text, 0.5 + 0.5 * lit)],
    ]
    const total = parts.reduce((n, [s]) => n + width(s), 0)
    let x = Math.max(1, Math.floor((v.cols - total) / 2))
    for (const [s, c] of parts) x = g.text(x, y + 1, s, c, undefined, v.cols - 1 - x)
  }
  let x = 1
  const cards = v.isEnded === true ? [] : scene.cards()
  for (const card of cards.slice(0, 6)) {
    const title = cardTitle(card.slice, 22)
    if (x + width(title) + 4 > v.cols - 1) break
    x = g.text(x, y + 2, '■', P.status[card.status])
    x = g.text(x + 1, y + 2, title, mix(P.text, P.bg, 0.15)) + 3
  }
  let wx = g.text(1, y + 3, 'lead', P.dim)
  wx = g.text(wx + 2, y + 3, '▲ ' + scene.delivered + ' woken', P.accent)
  g.text(wx + 2, y + 3, '▽ ' + scene.held + ' held at the membrane', P.dim)
  return { grid: g, images, links: cardLinks(cards), ...(fadeMs > 0 ? { fadeMs } : {}), ...(v.level === 'basic' && fadeMs > 0 ? { motionMs: fadeMs } : {}) }
}
