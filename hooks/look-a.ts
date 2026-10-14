// Look A, "mission control": agent cards with a state-coloured activity bar on one time axis, the claims board, lead wakes and the message list.

import { ago } from './core'
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
  nameColor,
  palette,
  pixelScale,
  sends,
  slotMs,
  spaced,
  stateIn,
  timeOfDay,
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

/** The header bar: title, run, replay clock and speed. */
function header(g: Grid, v: View, narrow: boolean) {
  g.fill(0, 0, g.cols, 1, ' ', P.text, P.panel)
  const speed = v.isEnded === true ? '■ ended' : v.speed === undefined ? '● live' : (v.isPaused ? '❚❚ ' : '▶ ') + v.speed + '×'
  let r = g.textRight(g.cols - 1, 0, speed, P.accent)
  r = g.textRight(r - 2, 0, timeOfDay(v.now), P.text)
  if (!narrow) r = g.textRight(r - 2, 0, 'T+' + clock(v.now - v.runFrom) + ' / ' + clock(v.runTo - v.runFrom), P.dim)
  let x = g.text(1, 0, '◉', P.accent)
  x = g.text(x + 1, 0, narrow ? 'SWARM' : spaced('SWARM'), P.text)
  const title = v.isEnded === true ? `ENDED · ${v.title} · ran ${ago(v.runTo - v.runFrom)}` : (v.speed === undefined ? 'LIVE · ' : 'REPLAY · ') + v.title
  x = g.text(x + 2, 0, narrow ? v.title : title, P.dim, undefined, r - x - 4)
  if (v.note !== undefined) g.text(x + 2, 0, v.note, P.dim, undefined, r - x - 4)
}

/** The shared time axis of the agent bars: `slots` slots of `slot` ms from the run's start, and the busiest slot's count. */
type Axis = { from: number; slot: number; slots: number; peak: number }

function axisOf(scene: Scene, v: View, slots: number): Axis {
  const slot = slotMs(Math.max(1, v.runTo - v.runFrom), slots)
  const peak = Math.max(1, ...scene.order().flatMap(a => histogram(a.sends, v.runFrom, slot, slots)))
  return { from: v.runFrom, slot, slots, peak }
}

/** One slot of an agent's bar: its sends then and its state at the slot's end (or now); undefined after now. */
type Slot = { count: number; state: AgentState } | undefined

function slotsOf(scene: Scene, a: SceneAgent, v: View, ax: Axis): Slot[] {
  const counts = histogram(a.sends, ax.from, ax.slot, ax.slots)
  return counts.map((count, i) => {
    const start = ax.from + i * ax.slot
    if (start > v.now) return undefined
    return { count, state: scene.stateAt(a.name, Math.min(v.now, start + ax.slot - 1)) }
  })
}

/** The file line of a card: the mark and the path's end, cut from the left to `w` cells. */
function fileText(file: string, w: number): string {
  const chars = [...file]
  if (chars.length <= w) return file
  return chars[0] + ' …' + chars.slice(chars.length - Math.max(1, w - 3)).join('')
}

/**
 * One agent card: full name, tool calls, message counts and model; state, time in it and its last action (dim unless
 * running), else its file; its bar on the shared axis.
 */
function agentCard(g: Grid, scene: Scene, v: View, a: SceneAgent, x: number, y: number, w: number, ax: Axis, images: ImageLayer[]) {
  const color = agentColor(P, a)
  const isDim = v.filter !== undefined && v.filter !== a.name
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
  const cx = g.text(x + 2, y, a.code ?? a.name, ink(color), undefined, right - x - 2)
  if (a.code !== undefined && a.code !== a.name) g.text(cx + 1, y, a.name, ink(P.dim), undefined, right - cx - 1)
  let sx = g.text(x + 2, y + 1, '●', ink(mix(P.state[state], 0xffffff, 0.6 * flash)))
  sx = g.text(sx + 1, y + 1, state.toUpperCase(), ink(P.state[state]))
  sx = g.text(sx + 1, y + 1, clock(scene.stateFor(a.name, v.now)), ink(P.dim))
  if (a.action !== undefined) g.text(sx + 2, y + 1, a.action, ink(state === 'running' ? P.text : P.dim), undefined, x + w - sx - 3)
  else if (a.file !== undefined) g.text(sx + 2, y + 1, fileText(a.file, x + w - sx - 3), ink(P.text))
  const slots = slotsOf(scene, a, v, ax)
  if (v.level === 'rich') {
    const sig = slots.map(s => (s === undefined ? '-' : s.state[0]! + s.count)).join(',') + '/' + ax.peak + (isDim ? 'd' : '')
    const still = mix(P.panel, color, 0.06)
    images.push({ key: 'bar-' + a.name, x: x + 2, y: y + 2, cols: ax.slots, rows: 1, sig: sig + '/' + still, draw: () => richBar(slots, ax, ink, still), alt: ' ' })
    return
  }
  slots.forEach((s, i) => {
    const cx = x + 2 + i
    if (s === undefined) g.put(cx, y + 2, '·', mix(P.panel, P.dim, 0.35))
    else if (s.state === 'quiet') return
    else {
      const n = s.count === 0 ? 1 : Math.max(2, Math.round((s.count / ax.peak) * 8))
      g.put(cx, y + 2, String.fromCharCode(0x2580 + n), ink(P.state[s.state]))
    }
  })
}

/** An agent's bar as pixels: one rounded column per slot, its height the sends, its colour the state; a thin line while quiet. */
function richBar(slots: readonly Slot[], ax: Axis, ink: (c: number) => number, bg: number): Canvas {
  const k = pixelScale(ax.slots, 1, 4)
  const h = 2 * k
  const c = new Canvas(ax.slots * k, h, bg)
  slots.forEach((s, i) => {
    if (s === undefined || s.state === 'quiet') return
    const color = ink(P.state[s.state])
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
    if (card.isDuplicate) g.text(cx + 1, y + 1, '⚠ dup', ink(P.status.blocked), undefined, x + w - 2 - cx - 1)
  } else if (card.others.length > 0) {
    cx = g.text(cx, y + 1, 'research', ink(P.dim))
    for (const b of card.others) cx = g.text(cx + 1, y + 1, scene.label(b), ink(nameColor(P, scene, b)), undefined, x + w - 2 - cx - 1)
  } else g.text(cx, y + 1, 'no builder', ink(P.dim))
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

/** The message list: newest first, the one in flight lit, names in full. */
function ticker(g: Grid, scene: Scene, v: View, x: number, y: number, w: number, rows: number) {
  g.text(x, y, spaced('MESSAGES'), P.dim)
  const all = sends(scene).filter(m => touches(v.filter, m.from, m.to))
  g.textRight(x + w, y, `${all.length} msgs${v.filter ? ' · ' + scene.label(v.filter) : ''}`, P.dim)
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

/** Look A at the view's size. */
export function lookA(scene: Scene, v: View): Frame {
  const g = new Grid(v.cols, v.rows, P.bg)
  const images: ImageLayer[] = []
  const narrow = v.cols < 72
  header(g, v, narrow)
  const agents = scene.order()
  const cards = v.isEnded === true ? [] : scene.cards()
  if (narrow) {
    let y = 2
    const w = g.cols - 2
    const ax = axisOf(scene, v, w - 3)
    for (const a of agents) {
      if (y + 2 > g.rows - 6) break
      agentCard(g, scene, v, a, 1, y, w, ax, images)
      y += 3
    }
    leadBlock(g, scene, v, 1, y, w, images)
    y += 3
    for (const c of cards.slice(0, 3)) {
      if (y >= g.rows - 4) break
      g.text(1, y, '■', P.status[c.status])
      const cx = g.text(3, y, cardTitle(c.slice, Math.floor(w / 2)), P.text)
      g.text(cx + 1, y, c.builders.map(b => scene.label(b)).join(' ') || STATUS_WORD[c.status].toLowerCase(), P.dim, undefined, w - cx)
      y++
    }
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
  const tickerRows = Math.max(5, Math.min(12, Math.floor(v.rows * 0.3)))
  const bodyBottom = v.rows - tickerRows - 1
  const gap = 3 + 3 * agents.length + 3 + agents.length <= bodyBottom ? 1 : 0
  let y = 3
  const ax = axisOf(scene, v, leftW - 3)
  for (const a of agents) {
    if (y + 3 > bodyBottom - 2) break
    agentCard(g, scene, v, a, 1, y, leftW, ax, images)
    y += 3 + gap
  }
  leadBlock(g, scene, v, 1, y, leftW, images)
  const cardCols = rightW >= 54 ? 2 : 1
  const cardW = Math.floor((rightW - (cardCols - 1)) / cardCols)
  let cy = 3
  let col = 0
  for (const c of cards) {
    if (cy + 4 > bodyBottom) break
    claimCard(g, scene, v, c, rightX + col * (cardW + 1), cy, cardW)
    col++
    if (col === cardCols) {
      col = 0
      cy += 4
    }
  }
  if (cards.length === 0) g.text(rightX, 3, v.isEnded === true ? 'claims cleared: the team ended' : 'no claims yet', P.dim)
  for (let x = 1; x < v.cols - 1; x++) g.put(x, bodyBottom, '─', P.rule)
  ticker(g, scene, v, 1, bodyBottom + 1, v.cols - 2, tickerRows)
  return { grid: g, images, links: cardLinks(cards) }
}

