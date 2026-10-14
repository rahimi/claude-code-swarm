// The pane's drawing without the mods API: the look per letter, the control rows, the frame cut into bands of Rasters and
// Images, and each Image's source kept by its signature.

import { lookA } from './look-a'
import { lookB } from './look-b'
import { agentColor } from './looks'
import type { Frame, ImageLayer, LookFn } from './looks'
import { FLIGHT } from './look-a'
import { NEBULA } from './look-b'
import type { Look, Scene } from './replay'
import { css } from './grid'
import type { ImageSource } from 'claude-code'

export const LOOK_FNS: Record<Look, LookFn> = { A: lookA, B: lookB }
const PALETTES = { A: FLIGHT, B: NEBULA }

/** One button of the control row: an agent to filter by, or an action; a `hidden` one is only its hotkey. */
export type Control = { key: string; label: string; color?: string; dim?: boolean; plain?: boolean; hotkey?: string; hidden?: boolean }

/** One button per agent, in its colour; pressed, it filters to that agent's threads. */
export function agentControls(scene: Scene, filter: string | undefined, look: Look): Control[] {
  const p = PALETTES[look]
  return scene.order().map(a => ({
    key: 'agent-' + a.name,
    label: a.code ?? a.name,
    color: css(agentColor(p, a)),
    dim: filter !== undefined && filter !== a.name,
    plain: true,
  }))
}

/** The view controls: live, a `[ list ]` button (`l`), drawn bright while shown; looks A and B as hidden keys `1` and `2`. */
export function viewControls(shown: Look | 'list', withList: boolean): Control[] {
  return [
    ...(withList ? [{ key: 'view-list', label: 'list', hotkey: 'l', dim: shown !== 'list' }] : []),
    { key: 'view-A', label: 'A', hotkey: '1', hidden: true },
    { key: 'view-B', label: 'B', hotkey: '2', hidden: true },
  ]
}

/** The replay's control row: `[ live ]` while a live swarm waits, each agent, the views, then nudge, pause and stop. */
export function controlsOf(scene: Scene, filter: string | undefined, look: Look, isPaused = false, liveWaiting = false): Control[] {
  return [
    ...(liveWaiting ? [{ key: 'live', label: 'live', hotkey: '0' }] : []),
    ...agentControls(scene, filter, look),
    ...viewControls(look, false),
    { key: 'nudge', label: 'nudge', hotkey: 'n' },
    { key: 'pause', label: isPaused ? 'play' : 'pause', hotkey: 'p' },
    { key: 'stop', label: 'stop', hotkey: 's' },
  ]
}

/** A horizontal band of the stage: rows [y, y + rows), cut at its images' columns into raster and image pieces. */
export type Band = { y: number; rows: number; pieces: ({ kind: 'raster'; key: string; x: number; cols: number } | { kind: 'image'; layer: ImageLayer })[] }

/**
 * The frame as bands top to bottom: rows no image covers form raster-only bands; images sharing rows form one band, the
 * cells beside them rasters of their own. Images in one band must share their rows; one that does not is dropped.
 */
export function bandsOf(frame: Frame): Band[] {
  const { grid, images } = frame
  const groups = new Map<number, ImageLayer[]>()
  for (const im of images) {
    if (im.y < 0 || im.y + im.rows > grid.rows || im.x < 0 || im.x + im.cols > grid.cols) continue
    const list = groups.get(im.y) ?? []
    if (list.length > 0 && list[0]!.rows !== im.rows) continue
    list.push(im)
    groups.set(im.y, list)
  }
  const starts = [...groups.keys()].sort((a, b) => a - b)
  const out: Band[] = []
  let y = 0
  for (const s of starts) {
    if (s < y) continue
    const layers = groups.get(s)!.sort((a, b) => a.x - b.x).filter((im, i, arr) => i === 0 || im.x >= arr[i - 1]!.x + arr[i - 1]!.cols)
    if (s > y) out.push({ y, rows: s - y, pieces: [{ kind: 'raster', key: `r${y}`, x: 0, cols: grid.cols }] })
    const rows = layers[0]!.rows
    const pieces: Band['pieces'] = []
    let x = 0
    for (const im of layers) {
      if (im.x > x) pieces.push({ kind: 'raster', key: `r${s}x${x}`, x, cols: im.x - x })
      pieces.push({ kind: 'image', layer: im })
      x = im.x + im.cols
    }
    if (x < grid.cols) pieces.push({ kind: 'raster', key: `r${s}x${x}`, x, cols: grid.cols - x })
    out.push({ y: s, rows, pieces })
    y = s + rows
  }
  if (y < grid.rows) out.push({ y, rows: grid.rows - y, pieces: [{ kind: 'raster', key: `r${y}`, x: 0, cols: grid.cols }] })
  return out
}

/** A string that changes when the bands' shape does: same shape, the pane repaints by blit; another, it draws again. */
export function shapeOf(bands: readonly Band[]): string {
  return bands.map(b => `${b.y}+${b.rows}:` + b.pieces.map(p => (p.kind === 'raster' ? `${p.key}/${p.cols}` : `${p.layer.key}@${p.layer.x}/${p.layer.cols}`)).join(',')).join(';')
}

/** The least real time between two sources of one Image: a change sooner waits, and changes in between merge into it. */
export const IMAGE_MIN_MS = 1_000

/** The source each Image key shows, its sig and when it was made; a new one waits the shorter of the kept and the new layer's `minMs`. */
export class ImageShelf {
  private readonly held = new Map<string, { sig: string; source: ImageSource; at: number; minMs: number }>()

  /** The source to show for the layer at real time `now`, and whether it is a new one to send. */
  take(layer: ImageLayer, now: number): { source: ImageSource; isNew: boolean } {
    const kept = this.held.get(layer.key)
    const minMs = layer.minMs ?? IMAGE_MIN_MS
    if (kept !== undefined && (kept.sig === layer.sig || now - kept.at < Math.min(minMs, kept.minMs))) return { source: kept.source, isNew: false }
    const source = layer.source?.() ?? layer.draw().source()
    this.held.set(layer.key, { sig: layer.sig, source, at: now, minMs })
    return { source, isNew: true }
  }

  /** Drops a key's source, so the next `take` makes and sends it again. */
  forget(key: string) {
    this.held.delete(key)
  }
}
