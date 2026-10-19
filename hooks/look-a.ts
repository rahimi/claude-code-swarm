// Look A, "mission control": agent cards with a state-coloured activity bar on one time axis, the claims board, lead wakes and the message list.

import { ago, clauseOf, timeOfDay } from './core'
import { Canvas } from './pixels'
import { cardTitle } from './replay'
import type { AgentState, Card, Scene, SceneAgent } from './replay'
import {
  FLASH_MS,
  Grid,
  PULSE_MS,
  STATUS_WORD,
  agentColor,
  clock,
  fade,
  cardLinks,
  histogram,
  inFlight,
  mix,
  movesNote,
  nameColor,
  palette,
  pixelScale,
  slotMs,
  spaced,
  stateIn,
  touches,
  width,
} from './looks'
import type { Frame, ImageLayer, View } from './looks'

export const FLIGHT = palette({
  name: 'Flight',
  bg: '#0A0E14',
  panel: '#121A24',
  rule: '#1E2A38',
  text: '#CAD5E2',
  dim: '#5E6E80',
  accent: '#FFB547',
  agents: ['#4FD6FF', '#FF7AB6', '#3DDC97', '#B18CFF', '#F4E04D', '#FF8F5A', '#7AA2FF', '#9BE564'],
  state: { running: '#3DDC97', idle: '#5E6E80', waiting: '#4FD6FF', stalled: '#FF5C6C', quiet: '#2A3646', ended: '#5E6E80' },
  status: { unclaimed: '#5E6E80', open: '#7AA2FF', building: '#FFB547', done: '#4FD6FF', approved: '#3DDC97', blocked: '#FF5C6C' },
  model: { opus: '#D9A6FF', sonnet: '#7FC8FF', haiku: '#9BE5A0', fable: '#FFD27A' },
})

const TYPE_COLOR: Record<string, string> = {
  PROPOSE: '#7AA2FF',
  CLAIM: '#FFB547',
  REVIEW: '#B18CFF',
  DONE: '#3DDC97',
  BLOCK: '#FF5C6C',
  REFUSED: '#FF5C6C',
  HANDOFF: '#4FD6FF',
  ASK: '#FF7AB6',
  WAIT: '#4FD6FF',
  LOCK: '#FFB547',
}

const P = FLIGHT

function typeColor(type: string | undefined): number {
  const c = type === undefined ? undefined : TYPE_COLOR[type]
  return c === undefined ? P.text : parseInt(c.slice(1), 16)
}

/** The header bar: title, the note and who joined or left, run, replay clock and speed. */
function header(g: Grid, scene: Scene, v: View, narrow: boolean) {
  g.fill(0, 0, g.cols, 1, ' ', P.text, P.panel)
  const speed = v.isEnded === true ? '■ ended' : v.speed === undefined ? '● live' : (v.isPaused ? '❚❚ ' : '▶ ') + v.speed + '×'
  let r = g.textRight(g.cols - 1, 0, speed, P.accent)
  r = g.textRight(r - 2, 0, timeOfDay(v.now), P.text)
  if (!narrow) r = g.textRight(r - 2, 0, 'T+' + clock(v.now - v.runFrom) + ' / ' + clock(v.runTo - v.runFrom), P.dim)
  let x = g.text(1, 0, '◉', P.accent)
  x = g.text(x + 1, 0, narrow ? 'SWARM' : spaced('SWARM'), P.text)
  const title = v.isEnded === true ? `ENDED · ${v.title} · ran ${ago(v.runTo - v.runFrom)}` : (v.speed === undefined ? 'LIVE · ' : 'REPLAY · ') + v.title
  x = g.text(x + 2, 0, narrow ? v.title : title, P.dim, undefined, r - x - 4)
  const note = [v.note, movesNote(scene, v)].filter(n => n !== undefined).join(' · ')
  if (note !== '') g.text(x + 2, 0, note, P.dim, undefined, r - x - 4)
}

/** The shared time axis of the agent bars: `slots` slots of `slot` ms from the run's start, and the busiest slot's count. */
type Axis = { from: number; slot: number; slots: number; peak: number }

function axisOf(scene: Scene, v: View, slots: number): Axis {
  const slot = slotMs(Math.max(1, v.runTo - v.runFrom), slots)
  const peak = Math.max(1, ...scene.order().flatMap(a => histogram([...a.sends, ...a.callTimes], v.runFrom, slot, slots)))
  return { from: v.runFrom, slot, slots, peak }
}

/** One slot of an agent's bar: its tool calls and sends then (`count` is both) and its state at the slot's end (or now); undefined after now. */
type Slot = { count: number; sends: number; calls: number; state: AgentState } | undefined

function slotsOf(scene: Scene, a: SceneAgent, v: View, ax: Axis): Slot[] {
  const sends = histogram(a.sends, ax.from, ax.slot, ax.slots)
  const calls = histogram(a.callTimes, ax.from, ax.slot, ax.slots)
  return sends.map((n, i) => {
    const start = ax.from + i * ax.slot
    if (start > v.now) return undefined
    return { count: n + calls[i]!, sends: n, calls: calls[i]!, state: scene.stateAt(a.name, Math.min(v.now, start + ax.slot - 1)) }
  })
}

/** A slot's colour, lifted toward white when it holds a message and tool calls were counted: the message shows as a brighter tick. */
function brightIf(s: NonNullable<Slot>, color: number): number {
  return s.sends > 0 && s.calls > 0 ? mix(color, 0xffffff, 0.5) : color
}

/** What a bar shows, as a string: each slot's state, count and message mark, the axis peak, and whether the agent is dimmed. */
function barSig(slots: readonly Slot[], ax: Axis, isDim: boolean): string {
  return slots.map(s => (s === undefined ? '-' : s.state[0]! + s.count + (s.sends > 0 && s.calls > 0 ? '+' : ''))).join(',') + '/' + ax.peak + (isDim ? 'd' : '')
}

/** The file line of a card: the mark and the path's end, cut from the left to `w` cells. */
function fileText(file: string, w: number): string {
  const chars = [...file]
  if (chars.length <= w) return file
  return chars[0] + ' …' + chars.slice(chars.length - Math.max(1, w - 3)).join('')
}

/**
 * One agent card: full name (`⚠ dup` when another agent took its code name in any case), tool calls, message counts and model; state, time in it and its last action (dim unless
 * running), else its file; its bar on the shared axis.
 */
function agentCard(g: Grid, scene: Scene, v: View, a: SceneAgent, x0: number, y: number, w0: number, ax: Axis, images: ImageLayer[]) {
  const slide = Math.round(fade(v.age(a.joinedAt), FLASH_MS) * w0)
  const x = x0 + slide
  const w = w0 - slide
  const color = agentColor(P, a)
  const isDim = (v.filter !== undefined && v.filter !== a.name) || (a.leftAt !== undefined && a.leftAt <= v.now)
  const state = stateIn(scene, a.name, v)
  const seg = a.segments[a.segments.length - 1]
  const flash = seg === undefined ? 0 : fade(v.age(seg.from), FLASH_MS)
  const pulse = inFlight(scene, v).find(p => p.m.from === a.name || p.m.to === a.name)
  const ink = (c: number) => (isDim ? mix(c, P.bg, 0.65) : c)
  const panel = mix(P.panel, color, 0.06 + 0.22 * flash)
  g.shade(x, y, w, 3, panel)
  const barGlow = pulse === undefined ? 0 : pulse.m.from === a.name ? 1 - pulse.t : pulse.t
  for (let r = 0; r < 3; r++) g.put(x, y + r, '▌', ink(mix(color, 0xffffff, 0.5 * barGlow)), panel)
  let right = x + w - 1
  if (a.model !== undefined) {
    const chip = ' ' + a.model + ' '
    right = g.textRight(right, y, chip, ink(P.bg), ink(P.model[a.model])) - 1
  }
  right = g.textRight(right, y, `↑${a.sent} ↓${a.received}`, ink(P.dim)) - 1
  if (a.calls !== undefined) right = g.textRight(right - 1, y, `${a.calls}×`, ink(P.dim)) - 1
  let cx = g.text(x + 2, y, a.code ?? a.name, ink(color), undefined, right - x - 2)
  if (a.code !== undefined && a.code !== a.name) cx = g.text(cx + 1, y, a.name, ink(P.dim), undefined, right - cx - 1)
  if (scene.isDuplicateCode(a.name)) g.text(cx + 1, y, '⚠ dup', ink(P.status.blocked), undefined, right - cx - 1)
  let sx = g.text(x + 2, y + 1, '●', ink(mix(P.state[state], 0xffffff, 0.6 * flash)))
  sx = g.text(sx + 1, y + 1, state.toUpperCase(), ink(P.state[state]))
  sx = g.text(sx + 1, y + 1, clock(scene.stateFor(a.name, v.now)), ink(P.dim))
  if (a.action !== undefined) g.text(sx + 2, y + 1, a.action, ink(state === 'running' ? P.text : P.dim), undefined, x + w - sx - 3)
  else if (a.file !== undefined) g.text(sx + 2, y + 1, fileText(a.file, x + w - sx - 3), ink(P.text))
  const slots = slotsOf(scene, a, v, ax)
  if (v.level === 'rich' && slide === 0) {
    const sig = barSig(slots, ax, isDim)
    const still = mix(P.panel, color, 0.06)
    images.push({ key: 'bar-' + a.name, x: x + 2, y: y + 2, cols: ax.slots, rows: 1, sig: sig + '/' + still, draw: () => richBar(slots, ax, ink, still), alt: ' ' })
    return
  }
  slots.forEach((s, i) => {
    const cx = x + 2 + i
    if (cx >= x + w) return
    if (s === undefined) g.put(cx, y + 2, '·', mix(P.panel, P.dim, 0.35))
    else if (s.state === 'quiet') return
    else {
      const n = s.count === 0 ? 1 : Math.max(2, Math.round((s.count / ax.peak) * 8))
      g.put(cx, y + 2, String.fromCharCode(0x2580 + n), ink(brightIf(s, P.state[s.state])))
    }
  })
}

const LINE_BAR = 16

/** The bar of an agent line at rich: `LINE_BAR` cells at the line's end, fewer on a narrow line, none under 6. */
function lineBarWidth(v: View, w: number): number {
  const cells = Math.min(LINE_BAR, w - 26)
  return v.level === 'rich' && cells >= 6 ? cells : 0
}

/**
 * One agent on one line: its colour bar, state dot, name (`⚠` on a duplicate code name), state and time in it, then its last action
 * (cut first, left out under 8 cells); at rich its bar on the lines' shared axis `ax` at the line's end.
 */
function agentLine(g: Grid, scene: Scene, v: View, a: SceneAgent, x: number, y: number, w: number, ax: Axis | undefined, images: ImageLayer[]) {
  const color = agentColor(P, a)
  const isDim = (v.filter !== undefined && v.filter !== a.name) || (a.leftAt !== undefined && a.leftAt <= v.now)
  const ink = (c: number) => (isDim ? mix(c, P.bg, 0.65) : c)
  const state = stateIn(scene, a.name, v)
  const end = x + w - (ax === undefined ? 0 : ax.slots + 1)
  g.put(x, y, '▌', ink(color))
  let cx = g.text(x + 1, y, '●', ink(P.state[state]))
  cx = g.text(cx + 1, y, (a.code ?? a.name) + (scene.isDuplicateCode(a.name) ? ' ⚠' : ''), ink(color), undefined, end - cx - 1)
  if (a.code !== undefined && a.code !== a.name) cx = g.text(cx + 1, y, a.name, ink(P.dim), undefined, end - cx - 1)
  cx = g.text(cx + 1, y, state.toUpperCase(), ink(P.state[state]), undefined, end - cx - 1)
  cx = g.text(cx + 1, y, clock(scene.stateFor(a.name, v.now)), ink(P.dim), undefined, end - cx - 1)
  if (a.action !== undefined && end - cx - 2 >= 8) g.text(cx + 2, y, a.action, ink(state === 'running' ? P.text : P.dim), undefined, end - cx - 2)
  if (ax === undefined) return
  const slots = slotsOf(scene, a, v, ax)
  const sig = barSig(slots, ax, isDim)
  images.push({ key: 'bar-' + a.name, x: x + w - ax.slots, y, cols: ax.slots, rows: 1, sig: sig + '/' + P.bg, draw: () => richBar(slots, ax, ink, P.bg), alt: ' ' })
}

/**
 * The agents in `rows` rows from `y`: a 3-row card each (a blank row between when there is room), else one line each, else
 * one line each in two columns, the last cell `+N more` when even those do not fit; the lines' bars share one short axis.
 * Returns the row after the list.
 */
function agentList(g: Grid, scene: Scene, v: View, agents: readonly SceneAgent[], x: number, y: number, w: number, rows: number, ax: Axis, images: ImageLayer[]): number {
  if (3 * agents.length <= rows) {
    const gap = 4 * agents.length <= rows ? 1 : 0
    for (const a of agents) {
      agentCard(g, scene, v, a, x, y, w, ax, images)
      y += 3 + gap
    }
    return y
  }
  const cols = agents.length <= rows ? 1 : 2
  const cw = Math.floor((w - (cols - 1)) / cols)
  const slots = rows * cols
  const shown = agents.length <= slots ? agents : agents.slice(0, slots - 1)
  const perCol = Math.ceil(Math.min(agents.length, slots) / cols)
  const barW = lineBarWidth(v, cw)
  const lax = barW === 0 ? undefined : axisOf(scene, v, barW)
  shown.forEach((a, i) => agentLine(g, scene, v, a, x + Math.floor(i / perCol) * (cw + 1), y + (i % perCol), cw, lax, images))
  if (shown.length < agents.length) g.text(x + (cols - 1) * (cw + 1) + 1, y + perCol - 1, `+${agents.length - shown.length} more`, P.dim)
  return y + perCol + 1
}

/** An agent's bar as pixels: one rounded column per slot, its height the tool calls and sends, its colour the state; a thin line while quiet. */
function richBar(slots: readonly Slot[], ax: Axis, ink: (c: number) => number, bg: number): Canvas {
  const k = pixelScale(ax.slots, 1, 4)
  const h = 2 * k
  const c = new Canvas(ax.slots * k, h, bg)
  slots.forEach((s, i) => {
    if (s === undefined || s.state === 'quiet') return
    const color = ink(brightIf(s, P.state[s.state]))
    const top = s.count === 0 ? h - 1.2 : h - 1 - Math.max(2, (s.count / ax.peak) * (h - 2))
    c.rect(i * k + 0.5, top, Math.max(1, k - 1), h - top, color, 0.9)
  })
  return c
}

/** The lead's wakes: delivered vs held back, then a strip of the latest ones in order. */
function leadBlock(g: Grid, scene: Scene, v: View, x: number, y: number, w: number, images: ImageLayer[]) {
  g.shade(x, y, w, 2, P.panel)
  g.put(x, y, '▌', P.text, P.panel)
  g.put(x, y + 1, '▌', P.text, P.panel)
  let cx = g.text(x + 2, y, 'LEAD', P.text)
  cx = g.text(cx + 2, y, '▲ ' + scene.delivered + ' woken', P.accent)
  g.text(cx + 2, y, '▽ ' + scene.held + ' held back', P.dim)
  const sw = w - 3
  const last = scene.wakes.slice(-sw)
  if (v.level === 'rich') {
    const sig = last.map(wk => (wk.held ? 'h' : 'd')).join('')
    images.push({ key: 'wakes', x: x + 2, y: y + 1, cols: sw, rows: 1, sig, draw: () => richWakes(last, sw), alt: `lead wakes ${scene.delivered} delivered, ${scene.held} held` })
    return
  }
  last.forEach((wk, i) => {
    const glow = fade(v.age(wk.ts))
    g.put(x + 2 + i, y + 1, wk.held ? '·' : '▮', wk.held ? mix(P.dim, 0xffffff, glow) : mix(P.accent, 0xffffff, glow))
  })
}

/** The wake strip as pixels: one per cell, delivered wakes as tall amber ticks, held ones as low dim dots. */
function richWakes(last: readonly { held: boolean }[], cols: number): Canvas {
  const k = pixelScale(cols, 1, 4)
  const h = 2 * k
  const c = new Canvas(cols * k, h, P.panel)
  last.forEach((wk, i) => {
    const x = i * k + k / 2
    if (wk.held) c.disc(x, h - k / 2, Math.max(0.6, k / 6), P.dim)
    else c.line(x, k / 3, x, h - k / 3, Math.max(0.5, k / 8), P.accent)
  })
  return c
}

/** One claim card: a rounded box in its status colour, the builders, the reviewers and their verdicts. */
function claimCard(g: Grid, scene: Scene, v: View, card: Card, x: number, y: number, w: number) {
  const sc = P.status[card.status]
  const glow = fade(v.age(card.at), FLASH_MS * 1.5)
  const isDim = v.filter !== undefined && ![...card.builders, ...card.reviewers.map(r => r.name), ...card.others].includes(v.filter)
  const ink = (c: number) => (isDim ? mix(c, P.bg, 0.65) : c)
  const edge = ink(mix(mix(sc, P.bg, 0.35), 0xffffff, 0.5 * glow))
  g.shade(x, y, w, 4, mix(P.bg, sc, 0.05 + 0.15 * glow))
  g.put(x, y, '╭', edge)
  g.put(x + w - 1, y, '╮', edge)
  g.put(x, y + 3, '╰', edge)
  g.put(x + w - 1, y + 3, '╯', edge)
  for (let i = 1; i < w - 1; i++) {
    g.put(x + i, y, '─', edge)
    g.put(x + i, y + 3, '─', edge)
  }
  for (let r = 1; r < 3; r++) {
    g.put(x, y + r, '│', edge)
    g.put(x + w - 1, y + r, '│', edge)
  }
  const word = STATUS_WORD[card.status]
  g.text(x + 2, y, ' ' + cardTitle(card.slice, w - width(word) - 8) + ' ', ink(P.text))
  g.textRight(x + w - 2, y, ' ' + word + ' ', ink(sc))
  let cx = x + 2
  if (card.builders.length > 0) {
    cx = g.text(cx, y + 1, 'build', ink(P.dim))
    for (const b of card.builders) cx = g.text(cx + 1, y + 1, scene.label(b), ink(nameColor(P, scene, b)), undefined, x + w - 2 - cx - 1)
  } else if (card.others.length > 0) {
    cx = g.text(cx, y + 1, 'research', ink(P.dim))
    for (const b of card.others) cx = g.text(cx + 1, y + 1, scene.label(b), ink(nameColor(P, scene, b)), undefined, x + w - 2 - cx - 1)
  } else g.text(cx, y + 1, 'no builder', ink(P.dim))
  if (card.isDuplicate) g.text(cx + 1, y + 1, '⚠ duplicate', ink(P.status.blocked), undefined, x + w - 2 - cx - 1)
  cx = x + 2
  if (card.reviewers.length > 0) {
    cx = g.text(cx, y + 2, 'review', ink(P.dim))
    for (const r of card.reviewers) {
      const mark = r.state === 'approve' ? '✓' : r.state === 'block' ? '✗' : '◦'
      cx = g.text(cx + 1, y + 2, mark, ink(r.state === 'approve' ? P.status.approved : r.state === 'block' ? P.status.blocked : P.dim), undefined, x + w - 2 - cx - 1)
      cx = g.text(cx, y + 2, scene.label(r.name), ink(nameColor(P, scene, r.name)), undefined, x + w - 2 - cx)
    }
  }
}

/** One claim on one line, for a board too long for its boxes: a mark in its status colour, the slice (its file name for a path), its claimants (cut first), `⚠` on a double claim, its status. */
function claimLine(g: Grid, scene: Scene, v: View, card: Card, x: number, y: number, w: number) {
  const sc = P.status[card.status]
  const isDim = v.filter !== undefined && ![...card.builders, ...card.reviewers.map(r => r.name), ...card.others].includes(v.filter)
  const ink = (c: number) => (isDim ? mix(c, P.bg, 0.65) : c)
  const word = STATUS_WORD[card.status]
  let right = g.textRight(x + w - 1, y, word, ink(sc)) - 1
  if (card.isDuplicate) right = g.textRight(right, y, '⚠', ink(P.status.blocked)) - 1
  let cx = g.text(x, y, '■', ink(sc))
  cx = g.text(cx + 1, y, cardTitle(clauseOf(card.slice).replace(/^.*\//, ''), Math.max(4, Math.floor((right - cx) * 0.6))), ink(P.text), undefined, right - cx - 1)
  for (const n of [...card.builders, ...card.others]) cx = g.text(cx + 1, y, scene.label(n), ink(nameColor(P, scene, n)), undefined, right - cx - 1)
}

/** The message list: newest first, the one in flight lit, names in full; refused spawns among them. */
function ticker(g: Grid, scene: Scene, v: View, x: number, y: number, w: number, rows: number) {
  g.text(x, y, spaced('MESSAGES'), P.dim)
  const all = scene.messages.filter(m => (m.kind === 'send' || m.kind === 'refused') && touches(v.filter, m.from, m.to))
  g.textRight(x + w, y, `${all.filter(m => m.kind === 'send').length} msgs${v.filter ? ' · ' + scene.label(v.filter) : ''}`, P.dim)
  const shown = all.slice(-(rows - 1)).reverse()
  const nameW = Math.max(4, ...shown.flatMap(m => [width(scene.label(m.from)), width(scene.label(m.to))]))
  shown.forEach((m, i) => {
    const r = y + 1 + i
    const t = v.age(m.ts) / PULSE_MS
    const lit = t >= 0 && t < 1 ? 1 - t : 0
    if (lit > 0) g.shade(x - 1, r, w + 2, 1, mix(P.bg, mix(P.panel, P.accent, 0.25), lit))
    let cx = x
    if (w >= 60) cx = g.text(cx, r, timeOfDay(m.ts), mix(P.dim, P.text, lit)) + 2
    cx = g.text(cx, r, scene.label(m.from).padEnd(nameW), nameColor(P, scene, m.from))
    cx = g.text(cx + 1, r, '→', lit > 0 ? P.accent : P.dim)
    cx = g.text(cx + 2, r, scene.label(m.to).padEnd(nameW), nameColor(P, scene, m.to))
    const type = m.type ?? ''
    cx = g.text(cx + 1, r, type.padEnd(8).slice(0, 8), typeColor(m.type))
    g.text(cx, r, m.summary.replace(/^\s*\[[A-Z]+\]\s*/, ''), mix(P.dim, P.text, 0.55 + 0.45 * lit), undefined, x + w - cx)
  })
}

/** The first of `needs` (rows, in the order the forms are tried) that fits in `max` rows, else `max`. */
function firstFit(needs: readonly number[], max: number): number {
  return needs.find(n => n <= max) ?? max
}

/** Look A at the view's size. */
export function lookA(scene: Scene, v: View): Frame {
  const g = new Grid(v.cols, v.rows, P.bg)
  const images: ImageLayer[] = []
  const narrow = v.cols < 72
  header(g, scene, v, narrow)
  const agents = scene.order()
  const cards = v.isEnded === true ? [] : scene.cards()
  if (narrow) {
    const w = g.cols - 2
    const ax = axisOf(scene, v, w - 3)
    let y = agentList(g, scene, v, agents, 1, 2, w, Math.max(1, g.rows - 9), ax, images)
    leadBlock(g, scene, v, 1, y, w, images)
    y += 3
    const fit = Math.max(0, Math.min(3, g.rows - 4 - y))
    const shown = cards.length <= fit ? cards : cards.slice(0, Math.max(0, fit - 1))
    for (const c of shown) {
      g.text(1, y, '■', P.status[c.status])
      const cx = g.text(3, y, cardTitle(c.slice, Math.floor(w / 2)), P.text)
      g.text(cx + 1, y, c.builders.map(b => scene.label(b)).join(' ') || STATUS_WORD[c.status].toLowerCase(), P.dim, undefined, w - cx)
      y++
    }
    if (shown.length < cards.length && fit > 0) g.text(1, y++, `+${cards.length - shown.length} more`, P.dim)
    ticker(g, scene, v, 1, y + 1, w, g.rows - y - 1)
    return { grid: g, images, links: cardLinks(cards) }
  }
  const leftW = Math.max(34, Math.min(46, Math.floor(v.cols * 0.42)))
  const rightX = leftW + 3
  const rightW = v.cols - rightX - 1
  g.text(1, 2, spaced('AGENTS'), P.dim)
  const word = v.isEnded === true ? 'ended' : 'running'
  g.textRight(leftW + 1, 2, `${agents.length} · ${agents.filter(a => stateIn(scene, a.name, v) === word).length} ${word}`, P.dim)
  g.text(rightX, 2, spaced('CLAIMS'), P.dim)
  const cardCols = rightW >= 54 ? 2 : 1
  const cardW = Math.floor((rightW - (cardCols - 1)) / cardCols)
  const maxBottom = v.rows - 3 - 1
  const agentRows = firstFit([3 * agents.length, agents.length, Math.ceil(agents.length / 2)], maxBottom - 6)
  const claimLines = Math.min(Math.ceil(cards.length / cardCols), maxBottom - 3)
  const tickerRows = Math.max(3, Math.min(Math.max(5, Math.min(12, Math.floor(v.rows * 0.3))), v.rows - 1 - Math.max(agentRows + 6, claimLines + 3)))
  const bodyMax = v.rows - tickerRows - 1
  const ax = axisOf(scene, v, leftW - 3)
  const y = agentList(g, scene, v, agents, 1, 3, leftW, Math.max(1, bodyMax - 3 - 3), ax, images)
  leadBlock(g, scene, v, 1, Math.min(y, bodyMax - 2), leftW, images)
  const claimRows = bodyMax - 3
  let claimEnd = 4
  if (Math.ceil(cards.length / cardCols) * 4 <= claimRows) {
    cards.forEach((c, i) => claimCard(g, scene, v, c, rightX + (i % cardCols) * (cardW + 1), 3 + Math.floor(i / cardCols) * 4, cardW))
    claimEnd = 3 + Math.ceil(cards.length / cardCols) * 4
  } else {
    const slots = claimRows * cardCols
    const shown = cards.length <= slots ? cards : cards.slice(0, slots - 1)
    const perCol = Math.ceil(Math.min(cards.length, slots) / cardCols)
    shown.forEach((c, i) => claimLine(g, scene, v, c, rightX + Math.floor(i / perCol) * (cardW + 1), 3 + (i % perCol), cardW))
    if (shown.length < cards.length) g.text(rightX + (cardCols - 1) * (cardW + 1), 3 + perCol - 1, `+${cards.length - shown.length} more`, P.dim)
    claimEnd = 3 + perCol
  }
  if (cards.length === 0) g.text(rightX, 3, v.isEnded === true ? 'claims cleared: the team ended' : 'no claims yet', P.dim)
  // The rule sits right under the taller column; the message list takes the rows left.
  const bodyBottom = Math.min(bodyMax, Math.max(y + 2, claimEnd))
  for (let x = 1; x < v.cols - 1; x++) g.put(x, bodyBottom, '─', P.rule)
  ticker(g, scene, v, 1, bodyBottom + 1, v.cols - 2, v.rows - bodyBottom - 1)
  return { grid: g, images, links: cardLinks(cards) }
}

