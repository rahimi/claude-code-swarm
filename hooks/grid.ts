// A cell grid for the terminal's Raster: glyph, foreground and background per cell, with text, braille dots and half-block pixels.

/** The terminal's own colour in a Raster cell. */
const DEFAULT = 0x01000000

/** `#rrggbb` as `0xRRGGBB`. */
export function hex(s: string): number {
  return parseInt(s.replace('#', ''), 16) & 0xffffff
}

/** The colour `t` of the way from `a` to `b`, per channel; `t` is clamped to 0..1. */
export function mix(a: number, b: number, t: number): number {
  const k = Math.max(0, Math.min(1, t))
  const ch = (s: number) => Math.round(((a >> s) & 255) * (1 - k) + ((b >> s) & 255) * k)
  return (ch(16) << 16) | (ch(8) << 8) | ch(0)
}

/** `0xRRGGBB` as `#rrggbb`. */
export function css(c: number): string {
  return '#' + (c & 0xffffff).toString(16).padStart(6, '0')
}

const BRAILLE_BIT = [
  [0x01, 0x08],
  [0x02, 0x10],
  [0x04, 0x20],
  [0x40, 0x80],
]

export class Grid {
  readonly cols: number
  readonly rows: number
  readonly ch: Uint32Array
  readonly fg: Uint32Array
  readonly bg: Uint32Array
  /** The braille dots set per cell (bits as U+2800 counts them); a cell with dots draws as braille. */
  private readonly dots: Uint8Array

  constructor(cols: number, rows: number, bg = DEFAULT) {
    this.cols = Math.max(1, Math.floor(cols))
    this.rows = Math.max(1, Math.floor(rows))
    const n = this.cols * this.rows
    this.ch = new Uint32Array(n).fill(32)
    this.fg = new Uint32Array(n).fill(DEFAULT)
    this.bg = new Uint32Array(n).fill(bg)
    this.dots = new Uint8Array(n)
  }

  private at(x: number, y: number): number {
    if (x < 0 || y < 0 || x >= this.cols || y >= this.rows) return -1
    return y * this.cols + x
  }

  /** Sets one cell; an undefined colour keeps the cell's. */
  put(x: number, y: number, ch: string | number, fg?: number, bg?: number) {
    const i = this.at(Math.floor(x), Math.floor(y))
    if (i < 0) return
    const cp = typeof ch === 'number' ? ch : (ch.codePointAt(0) ?? 32)
    this.ch[i] = cp > 0xffff || cp < 32 ? 0x3f : cp
    this.dots[i] = 0
    if (fg !== undefined) this.fg[i] = fg
    if (bg !== undefined) this.bg[i] = bg
  }

  fill(x: number, y: number, w: number, h: number, ch: string, fg?: number, bg?: number) {
    for (let r = y; r < y + h; r++) for (let c = x; c < x + w; c++) this.put(c, r, ch, fg, bg)
  }

  /** Paints the background of a rectangle, keeping glyphs. */
  shade(x: number, y: number, w: number, h: number, bg: number) {
    for (let r = y; r < y + h; r++) for (let c = x; c < x + w; c++) {
      const i = this.at(c, r)
      if (i >= 0) this.bg[i] = bg
    }
  }

  /** Writes text from `x`, cut to `max` cells with `…`; returns the column after it. */
  text(x: number, y: number, s: string, fg?: number, bg?: number, max = Infinity): number {
    const chars = [...s].filter(c => (c.codePointAt(0) ?? 0) <= 0xffff)
    const room = Math.min(max, this.cols - x)
    if (room <= 0) return x
    const shown = chars.length > room ? [...chars.slice(0, Math.max(0, room - 1)), '…'] : chars
    shown.forEach((c, k) => this.put(x + k, y, c, fg, bg))
    return x + shown.length
  }

  /** Writes text so that it ends at column `right` (exclusive). */
  textRight(right: number, y: number, s: string, fg?: number, bg?: number): number {
    const x = Math.max(0, right - [...s].length)
    this.text(x, y, s, fg, bg, right - x)
    return x
  }

  /** Sets one braille dot at sub-cell position (2 per column, 4 per row); its colour wins the cell's foreground. */
  dot(dx: number, dy: number, fg: number) {
    const x = Math.floor(dx)
    const y = Math.floor(dy)
    if (x < 0 || y < 0) return
    const i = this.at(x >> 1, y >> 2)
    if (i < 0) return
    this.dots[i]! |= BRAILLE_BIT[y & 3]![x & 1]!
    this.ch[i] = 0x2800 + this.dots[i]!
    this.fg[i] = fg
  }

  /** A braille line between two dot positions. */
  line(x0: number, y0: number, x1: number, y1: number, fg: number | ((t: number) => number), from = 0, to = 1) {
    const n = Math.max(1, Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0))))
    for (let k = Math.floor(n * from); k <= Math.ceil(n * to); k++) {
      const t = k / n
      if (t < from || t > to) continue
      this.dot(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, typeof fg === 'number' ? fg : fg(t))
    }
  }

  /** The glyphs of one row, trailing spaces kept. */
  rowText(y: number): string {
    let s = ''
    for (let x = 0; x < this.cols; x++) s += String.fromCharCode(this.ch[y * this.cols + x]!)
    return s
  }

  /** The cells of a rectangle as a Raster's `cells`: base64 of u32 triplets, little-endian. */
  cells(x = 0, y = 0, w = this.cols, h = this.rows): string {
    const words = new Uint32Array(w * h * 3)
    let k = 0
    for (let r = y; r < y + h; r++) for (let c = x; c < x + w; c++) {
      const i = this.at(c, r)
      words[k++] = i < 0 ? 32 : this.ch[i]!
      words[k++] = i < 0 ? DEFAULT : this.fg[i]!
      words[k++] = i < 0 ? DEFAULT : this.bg[i]!
    }
    return base64(new Uint8Array(words.buffer))
  }
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** Standard padded base64 of bytes. */
export function base64(bytes: Uint8Array): string {
  const parts: string[] = []
  const CHUNK = 3 * 4096
  for (let start = 0; start < bytes.length; start += CHUNK) {
    const end = Math.min(bytes.length, start + CHUNK)
    const codes: number[] = []
    for (let i = start; i < end; i += 3) {
      const a = bytes[i]!
      const b = i + 1 < end ? bytes[i + 1]! : 0
      const c = i + 2 < end ? bytes[i + 2]! : 0
      codes.push(B64.charCodeAt(a >> 2), B64.charCodeAt(((a & 3) << 4) | (b >> 4)))
      codes.push(i + 1 < end ? B64.charCodeAt(((b & 15) << 2) | (c >> 6)) : 61)
      codes.push(i + 2 < end ? B64.charCodeAt(c & 63) : 61)
    }
    parts.push(String.fromCharCode(...codes))
  }
  return parts.join('')
}
