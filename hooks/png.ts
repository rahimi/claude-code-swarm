// A PNG encoder for Image sources: RGB rows, each filtered Sub, packed with a fixed-Huffman deflate.

import { base64 } from './grid'

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(bytes: Uint8Array, start: number, end: number): number {
  let c = 0xffffffff
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** Bits written least significant first, as deflate packs them. */
class BitWriter {
  private buf = new Uint8Array(1 << 16)
  private len = 0
  private acc = 0
  private n = 0

  bits(value: number, count: number) {
    this.acc |= value << this.n
    this.n += count
    while (this.n >= 8) {
      if (this.len === this.buf.length) {
        const next = new Uint8Array(this.buf.length * 2)
        next.set(this.buf)
        this.buf = next
      }
      this.buf[this.len++] = this.acc & 0xff
      this.acc >>>= 8
      this.n -= 8
    }
  }

  done(): Uint8Array {
    if (this.n > 0) this.bits(0, 8 - this.n)
    return this.buf.subarray(0, this.len)
  }
}

/** `code` of `count` bits reversed, as deflate writes a Huffman code. */
function reversed(code: number, count: number): number {
  let r = 0
  for (let i = 0; i < count; i++) r |= ((code >> i) & 1) << (count - 1 - i)
  return r
}

/** The fixed-Huffman literal/length codes, reversed, with their lengths, by symbol (0–287). */
const LIT_CODE = new Uint16Array(288)
const LIT_BITS = new Uint8Array(288)
for (let sym = 0; sym < 288; sym++) {
  const [base, from, n] = sym < 144 ? [0x30, 0, 8] : sym < 256 ? [0x190, 144, 9] : sym < 280 ? [0, 256, 7] : [0xc0, 280, 8]
  LIT_CODE[sym] = reversed(base + sym - from, n)
  LIT_BITS[sym] = n
}
const DIST_CODE = Uint8Array.from({ length: 30 }, (_, d) => reversed(d, 5))

const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258]
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0]
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577]
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13]

/** The table index whose base is the largest at most `v`, for every `v` up to `max`. */
function indexTable(base: readonly number[], max: number): Uint8Array {
  const t = new Uint8Array(max + 1)
  let i = 0
  for (let v = 0; v <= max; v++) {
    while (i + 1 < base.length && base[i + 1]! <= v) i++
    t[v] = i
  }
  return t
}
const LEN_INDEX = indexTable(LEN_BASE, 258)
const DIST_INDEX = indexTable(DIST_BASE, 32768)

const WINDOW = 32768
const HASH_BITS = 15
const MAX_CHAIN = 8
const MAX_LEN = 258
/** Positions inside a match past this many are not hashed: long matches are runs whose inner positions add nothing. */
const INSERT_MAX = 8

/**
 * A zlib stream of `data`: one fixed-Huffman block. A run of the byte before takes a distance-1 match at once; anything
 * else is matched through a hash chain over the last 32 KB.
 */
export function zlib(data: Uint8Array): Uint8Array {
  const w = new BitWriter()
  w.bits(0x78, 8)
  w.bits(0x01, 8)
  w.bits(1, 1)
  w.bits(1, 2)
  const n = data.length
  const head = new Int32Array(1 << HASH_BITS).fill(-1)
  const prev = new Int32Array(WINDOW)
  const insert = (i: number) => {
    if (i + 2 >= n) return
    const h = ((data[i]! << 10) ^ (data[i + 1]! << 5) ^ data[i + 2]!) & ((1 << HASH_BITS) - 1)
    prev[i & (WINDOW - 1)] = head[h]!
    head[h] = i
  }
  const symbol = (sym: number) => w.bits(LIT_CODE[sym]!, LIT_BITS[sym]!)
  let i = 0
  while (i < n) {
    let bestLen = 0
    let bestDist = 0
    const max = Math.min(MAX_LEN, n - i)
    if (i > 0 && max >= 3) {
      const b = data[i - 1]!
      let l = 0
      while (l < max && data[i + l] === b) l++
      if (l >= 3) {
        bestLen = l
        bestDist = 1
      }
    }
    if (bestLen < 3 && max >= 3) {
      const h = ((data[i]! << 10) ^ (data[i + 1]! << 5) ^ data[i + 2]!) & ((1 << HASH_BITS) - 1)
      let cand = head[h]!
      for (let chain = 0; cand >= 0 && i - cand <= WINDOW && chain < MAX_CHAIN; chain++) {
        let l = 0
        while (l < max && data[cand + l] === data[i + l]) l++
        if (l > bestLen) {
          bestLen = l
          bestDist = i - cand
          if (l === max) break
        }
        const next = prev[cand & (WINDOW - 1)]!
        if (next >= cand) break
        cand = next
      }
    }
    if (bestLen >= 3) {
      const li = LEN_INDEX[bestLen]!
      symbol(257 + li)
      if (LEN_EXTRA[li]! > 0) w.bits(bestLen - LEN_BASE[li]!, LEN_EXTRA[li]!)
      const di = DIST_INDEX[bestDist]!
      w.bits(DIST_CODE[di]!, 5)
      if (DIST_EXTRA[di]! > 0) w.bits(bestDist - DIST_BASE[di]!, DIST_EXTRA[di]!)
      for (let k = 0; k < Math.min(bestLen, INSERT_MAX); k++) insert(i + k)
      i += bestLen
    } else {
      symbol(data[i]!)
      insert(i)
      i++
    }
  }
  symbol(256)
  const body = w.done()
  let a = 1
  let b = 0
  for (let k = 0; k < n; ) {
    const end = Math.min(n, k + 5552)
    for (; k < end; k++) {
      a += data[k]!
      b += a
    }
    a %= 65521
    b %= 65521
  }
  const out = new Uint8Array(body.length + 4)
  out.set(body)
  const adler = ((b << 16) | a) >>> 0
  out.set([adler >>> 24, (adler >>> 16) & 255, (adler >>> 8) & 255, adler & 255], body.length)
  return out
}

/** RGB pixels (3 bytes each, rows top down) as a PNG file. */
export function png(rgb: Uint8Array, width: number, height: number): Uint8Array {
  const stride = width * 3
  const raw = new Uint8Array((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    const row = y * stride
    const out = y * (stride + 1)
    raw[out] = 1
    for (let x = 0; x < stride; x++) raw[out + 1 + x] = (rgb[row + x]! - (x >= 3 ? rgb[row + x - 3]! : 0)) & 0xff
  }
  const idat = zlib(raw)
  const chunks: [string, Uint8Array][] = [
    ['IHDR', new Uint8Array([width >>> 24, (width >>> 16) & 255, (width >>> 8) & 255, width & 255, height >>> 24, (height >>> 16) & 255, (height >>> 8) & 255, height & 255, 8, 2, 0, 0, 0])],
    ['IDAT', idat],
    ['IEND', new Uint8Array(0)],
  ]
  const size = 8 + chunks.reduce((n, [, d]) => n + 12 + d.length, 0)
  const file = new Uint8Array(size)
  file.set([137, 80, 78, 71, 13, 10, 26, 10])
  let p = 8
  for (const [type, d] of chunks) {
    file.set([d.length >>> 24, (d.length >>> 16) & 255, (d.length >>> 8) & 255, d.length & 255], p)
    for (let k = 0; k < 4; k++) file[p + 4 + k] = type.charCodeAt(k)
    file.set(d, p + 8)
    const crc = crc32(file, p + 4, p + 8 + d.length)
    file.set([crc >>> 24, (crc >>> 16) & 255, (crc >>> 8) & 255, crc & 255], p + 8 + d.length)
    p += 12 + d.length
  }
  return file
}

/** A PNG as an Image's `{ png }` source. */
export function pngSource(rgb: Uint8Array, width: number, height: number): { png: string } {
  return { png: base64(png(rgb, width, height)) }
}
