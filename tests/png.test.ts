import { describe, expect, test } from 'claude-code/testing'

import { Canvas } from '../hooks/pixels'
import { png, zlib } from '../hooks/png'

const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258]
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0]
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577]
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13]

/** Inflates a zlib stream of fixed-Huffman blocks, the only kind the encoder writes. */
function inflate(z: Uint8Array): Uint8Array {
  let pos = 16
  const bit = () => (z[pos >> 3]! >> (pos++ & 7)) & 1
  const bits = (n: number) => {
    let v = 0
    for (let i = 0; i < n; i++) v |= bit() << i
    return v
  }
  const code = (n: number) => {
    let v = 0
    for (let i = 0; i < n; i++) v = (v << 1) | bit()
    return v
  }
  const out: number[] = []
  for (;;) {
    const last = bit()
    expect(bits(2)).toBe(1)
    for (;;) {
      let v = code(7)
      let sym: number
      if (v <= 23) sym = 256 + v
      else {
        v = (v << 1) | bit()
        if (v >= 0x30 && v <= 0xbf) sym = v - 0x30
        else if (v >= 0xc0 && v <= 0xc7) sym = 280 + v - 0xc0
        else sym = 144 + ((v << 1) | bit()) - 0x190
      }
      if (sym < 256) out.push(sym)
      else if (sym === 256) break
      else {
        const li = sym - 257
        const len = LEN_BASE[li]! + bits(LEN_EXTRA[li]!)
        const di = code(5)
        const dist = DIST_BASE[di]! + bits(DIST_EXTRA[di]!)
        for (let k = 0; k < len; k++) out.push(out[out.length - dist]!)
      }
    }
    if (last) break
  }
  return Uint8Array.from(out)
}

describe('png', () => {
  test('the deflate round-trips runs, repeats and noise', () => {
    let seed = 7
    const noise = () => ((seed = (seed * 1103515245 + 12345) >>> 0) >>> 16) & 255
    const cases = [new Uint8Array(0), new Uint8Array(1000).fill(9), Uint8Array.from({ length: 40_000 }, (_, i) => (i % 97 < 60 ? i % 7 : noise()))]
    for (const data of cases) expect([...inflate(zlib(data))]).toEqual([...data])
  })
  test('a PNG holds the canvas pixels, Sub-filtered rows', () => {
    const c = new Canvas(37, 11, 0x07060e)
    c.disc(10, 5, 4, 0xff6fa3)
    c.line(0, 0, 36, 10, 1, 0x5fe3e0)
    const file = png(c.rgb(), c.w, c.h)
    const idat = file.subarray(8 + 25 + 8, 8 + 25 + 8 + ((file[33]! << 24) | (file[34]! << 16) | (file[35]! << 8) | file[36]!))
    const raw = inflate(idat)
    const stride = c.w * 3
    const rgb = new Uint8Array(stride * c.h)
    for (let y = 0; y < c.h; y++) {
      expect(raw[y * (stride + 1)]).toBe(1)
      for (let x = 0; x < stride; x++) rgb[y * stride + x] = (raw[y * (stride + 1) + 1 + x]! + (x >= 3 ? rgb[y * stride + x - 3]! : 0)) & 255
    }
    expect([...rgb]).toEqual([...c.rgb()])
  })
})
