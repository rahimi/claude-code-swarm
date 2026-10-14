// An RGBA pixel canvas for Image layers: anti-aliased lines, curves, discs and rings, additive glows.

import { base64 } from './grid'

export class Canvas {
  readonly w: number
  readonly h: number
  /** Linear-ish working buffer, 0..255 per channel, RGB; alpha is 255 everywhere. */
  private readonly px: Float32Array

  constructor(w: number, h: number, bg: number) {
    this.w = Math.max(1, Math.floor(w))
    this.h = Math.max(1, Math.floor(h))
    this.px = new Float32Array(this.w * this.h * 3)
    this.rect(0, 0, this.w, this.h, bg, 1)
  }

  /** A copy of this canvas. */
  clone(): Canvas {
    const c = new Canvas(this.w, this.h, 0)
    c.px.set(this.px)
    return c
  }

  /** Mixes a colour into one pixel at `a` (0..1) over what is there. */
  blend(x: number, y: number, c: number, a: number) {
    if (a <= 0 || x < 0 || y < 0 || x >= this.w || y >= this.h) return
    const i = (y * this.w + x) * 3
    const k = Math.min(1, a)
    this.px[i] = this.px[i]! * (1 - k) + ((c >> 16) & 255) * k
    this.px[i + 1] = this.px[i + 1]! * (1 - k) + ((c >> 8) & 255) * k
    this.px[i + 2] = this.px[i + 2]! * (1 - k) + (c & 255) * k
  }

  /** Adds a colour to one pixel at `a`, clamped at white: light on light gets brighter. */
  add(x: number, y: number, c: number, a: number) {
    if (a <= 0 || x < 0 || y < 0 || x >= this.w || y >= this.h) return
    const i = (y * this.w + x) * 3
    this.px[i] = Math.min(255, this.px[i]! + ((c >> 16) & 255) * a)
    this.px[i + 1] = Math.min(255, this.px[i + 1]! + ((c >> 8) & 255) * a)
    this.px[i + 2] = Math.min(255, this.px[i + 2]! + (c & 255) * a)
  }

  rect(x: number, y: number, w: number, h: number, c: number, a = 1) {
    const x0 = Math.max(0, Math.floor(x))
    const y0 = Math.max(0, Math.floor(y))
    const x1 = Math.min(this.w, Math.ceil(x + w))
    const y1 = Math.min(this.h, Math.ceil(y + h))
    for (let py = y0; py < y1; py++) {
      const cy = Math.min(py + 1, y + h) - Math.max(py, y)
      for (let px = x0; px < x1; px++) {
        const cx = Math.min(px + 1, x + w) - Math.max(px, x)
        this.blend(px, py, c, a * cx * cy)
      }
    }
  }

  /** A line of half-width `r` (pixels), anti-aliased by distance to the segment. */
  line(x0: number, y0: number, x1: number, y1: number, r: number, c: number, a = 1, additive = false) {
    const minX = Math.max(0, Math.floor(Math.min(x0, x1) - r - 1))
    const maxX = Math.min(this.w - 1, Math.ceil(Math.max(x0, x1) + r + 1))
    const minY = Math.max(0, Math.floor(Math.min(y0, y1) - r - 1))
    const maxY = Math.min(this.h - 1, Math.ceil(Math.max(y0, y1) + r + 1))
    const dx = x1 - x0
    const dy = y1 - y0
    const len2 = dx * dx + dy * dy || 1
    for (let py = minY; py <= maxY; py++) for (let px = minX; px <= maxX; px++) {
      const qx = px + 0.5
      const qy = py + 0.5
      const t = Math.max(0, Math.min(1, ((qx - x0) * dx + (qy - y0) * dy) / len2))
      const d = Math.hypot(qx - (x0 + dx * t), qy - (y0 + dy * t))
      const cover = Math.max(0, Math.min(1, r + 0.5 - d))
      if (cover > 0) additive ? this.add(px, py, c, a * cover) : this.blend(px, py, c, a * cover)
    }
  }

  /** A quadratic curve from (x0,y0) to (x2,y2) bent toward (x1,y1), drawn from `from` to `to` of its length. */
  curve(x0: number, y0: number, x1: number, y1: number, x2: number, y2: number, r: number, c: number, a = 1, from = 0, to = 1, additive = false) {
    const steps = Math.max(4, Math.ceil(Math.hypot(x2 - x0, y2 - y0) / 6))
    const pts: number[] = []
    for (let k = 0; k <= steps; k++) {
      const t = from + ((to - from) * k) / steps
      pts.push((1 - t) * (1 - t) * x0 + 2 * (1 - t) * t * x1 + t * t * x2, (1 - t) * (1 - t) * y0 + 2 * (1 - t) * t * y1 + t * t * y2)
    }
    this.stroke(pts, r, c, a, additive)
  }

  /** A polyline of half-width `r` through `pts` (x, y pairs), each pixel covered once however many segments touch it. */
  stroke(pts: readonly number[], r: number, c: number, a = 1, additive = false) {
    if (pts.length < 4) return
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (let i = 0; i < pts.length; i += 2) {
      minX = Math.min(minX, pts[i]!)
      maxX = Math.max(maxX, pts[i]!)
      minY = Math.min(minY, pts[i + 1]!)
      maxY = Math.max(maxY, pts[i + 1]!)
    }
    const x0 = Math.max(0, Math.floor(minX - r - 1))
    const y0 = Math.max(0, Math.floor(minY - r - 1))
    const x1 = Math.min(this.w - 1, Math.ceil(maxX + r + 1))
    const y1 = Math.min(this.h - 1, Math.ceil(maxY + r + 1))
    if (x1 < x0 || y1 < y0) return
    const mw = x1 - x0 + 1
    const mask = new Float32Array(mw * (y1 - y0 + 1))
    for (let i = 0; i + 3 < pts.length; i += 2) {
      const ax = pts[i]!
      const ay = pts[i + 1]!
      const dx = pts[i + 2]! - ax
      const dy = pts[i + 3]! - ay
      const len2 = dx * dx + dy * dy || 1
      const sx0 = Math.max(x0, Math.floor(Math.min(ax, ax + dx) - r - 1))
      const sx1 = Math.min(x1, Math.ceil(Math.max(ax, ax + dx) + r + 1))
      const sy0 = Math.max(y0, Math.floor(Math.min(ay, ay + dy) - r - 1))
      const sy1 = Math.min(y1, Math.ceil(Math.max(ay, ay + dy) + r + 1))
      for (let py = sy0; py <= sy1; py++) for (let px = sx0; px <= sx1; px++) {
        const qx = px + 0.5
        const qy = py + 0.5
        const t = Math.max(0, Math.min(1, ((qx - ax) * dx + (qy - ay) * dy) / len2))
        const cover = Math.max(0, Math.min(1, r + 0.5 - Math.hypot(qx - (ax + dx * t), qy - (ay + dy * t))))
        const k = (py - y0) * mw + (px - x0)
        if (cover > mask[k]!) mask[k] = cover
      }
    }
    for (let py = y0; py <= y1; py++) for (let px = x0; px <= x1; px++) {
      const cover = mask[(py - y0) * mw + (px - x0)]!
      if (cover > 0) additive ? this.add(px, py, c, a * cover) : this.blend(px, py, c, a * cover)
    }
  }

  disc(cx: number, cy: number, r: number, c: number, a = 1) {
    for (let py = Math.floor(cy - r - 1); py <= Math.ceil(cy + r + 1); py++) for (let px = Math.floor(cx - r - 1); px <= Math.ceil(cx + r + 1); px++) {
      const d = Math.hypot(px + 0.5 - cx, py + 0.5 - cy)
      this.blend(px, py, c, a * Math.max(0, Math.min(1, r + 0.5 - d)))
    }
  }

  /** A ring of half-width `w` at radius `r`. */
  circle(cx: number, cy: number, r: number, w: number, c: number, a = 1) {
    for (let py = Math.floor(cy - r - w - 1); py <= Math.ceil(cy + r + w + 1); py++) for (let px = Math.floor(cx - r - w - 1); px <= Math.ceil(cx + r + w + 1); px++) {
      const d = Math.abs(Math.hypot(px + 0.5 - cx, py + 0.5 - cy) - r)
      this.blend(px, py, c, a * Math.max(0, Math.min(1, w + 0.5 - d)))
    }
  }

  /** A soft additive halo: intensity falls off as a gaussian of radius `r`. */
  glow(cx: number, cy: number, r: number, c: number, a = 1) {
    const reach = r * 2.2
    for (let py = Math.floor(cy - reach); py <= Math.ceil(cy + reach); py++) for (let px = Math.floor(cx - reach); px <= Math.ceil(cx + reach); px++) {
      const d2 = (px + 0.5 - cx) ** 2 + (py + 0.5 - cy) ** 2
      this.add(px, py, c, a * Math.exp(-d2 / (r * r)))
    }
  }

  /** The pixels as an Image's `{ rgba, width, height }` source. */
  source(): { rgba: string; width: number; height: number } {
    return { rgba: base64(this.rgba()), width: this.w, height: this.h }
  }

  /** The pixels as RGB, 3 bytes each, rows top down. */
  rgb(): Uint8Array {
    const out = new Uint8Array(this.w * this.h * 3)
    for (let i = 0; i < this.px.length; i++) out[i] = this.px[i]!
    return out
  }

  rgba(): Uint8Array {
    const out = new Uint8Array(this.w * this.h * 4)
    for (let i = 0, j = 0; i < this.px.length; i += 3, j += 4) {
      out[j] = this.px[i]!
      out[j + 1] = this.px[i + 1]!
      out[j + 2] = this.px[i + 2]!
      out[j + 3] = 255
    }
    return out
  }
}
