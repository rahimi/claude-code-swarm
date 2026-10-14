import { describe, expect, test } from 'claude-code/testing'

import type { LogEntry } from '../hooks/core'
import { Grid } from '../hooks/grid'
import { zlib } from '../hooks/png'
import { FLIGHT } from '../hooks/look-a'
import { ARRIVAL_MS, BURST_MS, FALLBACK_SKY_MS, FLIGHT_MS, LIT_MS, WORDS_MAX } from '../hooks/look-b'
import { CELL_PX, IMAGE_BUDGET, SKY_BUDGET, SKY_MIN_MS, inFlight, slotMs } from '../hooks/looks'
import type { Frame, View } from '../hooks/looks'
import { ImageShelf, LOOK_FNS, bandsOf, controlsOf, shapeOf } from '../hooks/pane-draw'
import { LiveScene, Scene, modelsOf, parseReplayArgs, runTitle, schedule, splitRuns, teamsOf, windowOf } from '../hooks/replay'

const T0 = Date.parse('2026-01-05T10:00:00Z')
const MIN = 60_000

/** How many distinct (foreground, background) pairs a grid uses: the Raster paints at most 1024 at once. */
function colourPairs(g: Grid): number {
  const pairs = new Set<string>()
  for (let i = 0; i < g.ch.length; i++) pairs.add(g.fg[i] + '/' + g.bg[i])
  return pairs.size
}

function line(at: number, from: string, to: string, summary: string, extra: Partial<LogEntry> = {}): LogEntry {
  const type = /^\[([A-Z]+)\]/.exec(summary)?.[1]
  return { ts: T0 + at, from, to, summary, length: summary.length, via: 'send', ...(type ? { type } : {}), ...extra }
}

/** A neutral two-agent run: hellos, a build claim each on one file (a duplicate), a block, an idle notice, a done. */
function fixture(): LogEntry[] {
  return [
    line(0, 'team-lead', 'w1', 'brief'),
    line(1_000, 'w1', 'w2', '[PROPOSE] hello Finch'),
    line(1_200, 'w2', 'w1', '[PROPOSE] hello Wren'),
    line(1_210, 'w2', 'w1', '[PROPOSE] hello Wren', { via: 'tool' }),
    line(5_000, 'w1', 'w2', '[CLAIM] build /tmp/out/report.md'),
    line(6_000, 'w2', 'w1', '[CLAIM] build /tmp/out/report.md'),
    line(7_000, 'w1', 'w2', '[BLOCK] two builders on report.md'),
    line(8_000, 'w2', 'team-lead', '{"type":"idle_notification"}', { type: 'IDLE', via: 'receive', idleReason: 'available' }),
    line(9_000, 'w1', 'team-lead', '[CLAIM] build report.md'),
    line(10_000, 'w1', 'team-lead', '[ASK] @lead which builder keeps it?'),
    line(20 * MIN, 'w1', 'team-lead', '[DONE] /tmp/out/report.md'),
  ]
}

function scene(lines = fixture(), until = Infinity): Scene {
  const s = new Scene(() => 'sonnet')
  s.seed(['w1', 'w2'], lines[0]!.ts)
  for (const e of lines) if (e.ts <= until) s.apply(e)
  return s
}

/** The base64 PNG of a `{ png }` source. */
function pngOf(src: unknown): string {
  return (src as { png: string }).png
}

/** The pixel width and height a base64 PNG's header gives. */
function pngSize(b64: string): [number, number] {
  const b = Uint8Array.from(atob(b64.slice(0, 40)), ch => ch.charCodeAt(0))
  const u32 = (i: number) => ((b[i]! << 24) | (b[i + 1]! << 16) | (b[i + 2]! << 8) | b[i + 3]!) >>> 0
  return [u32(16), u32(20)]
}

/** The frame's glyphs, one string per row. */
function text(f: Frame): string {
  return Array.from({ length: f.grid.rows }, (_, y) => f.grid.rowText(y)).join('\n')
}

function view(over: Partial<View> = {}): View {
  return { cols: 96, rows: 32, level: 'basic', now: T0 + 10_000, runFrom: T0, runTo: T0 + 20 * MIN, title: 'w1–w2', speed: 30, isPaused: false, age: () => Infinity, ...over }
}

describe('replay arguments', () => {
  test('a path alone takes the defaults', () => {
    expect(parseReplayArgs('.swarm/log.jsonl')).toEqual({ args: { path: '.swarm/log.jsonl', speed: 30, look: 'A' } })
  })
  test('flags set speed, look, level and the window', () => {
    const r = parseReplayArgs('/x/log.jsonl --speed 60 --look b --level rich --from 2026-01-05T10:00:00Z --to 2026-01-05T11:00:00Z')
    expect(r).toEqual({ args: { path: '/x/log.jsonl', speed: 60, look: 'B', level: 'rich', from: T0, to: T0 + 60 * MIN } })
  })
  test('stop, and the errors', () => {
    expect(parseReplayArgs('stop')).toEqual({ stop: true })
    expect('error' in parseReplayArgs('')).toBe(true)
    expect('error' in parseReplayArgs('log --speed 0')).toBe(true)
    expect(parseReplayArgs('log --look C')).toEqual({ error: '--look takes A or B' })
    expect('error' in parseReplayArgs('log --from yesterday')).toBe(true)
    expect('error' in parseReplayArgs('log --speed')).toBe(true)
  })
})

describe('runs and schedule', () => {
  test('runs split by team: two teams 5 min apart are two runs; agents that only write to the lead are no team', () => {
    const lines = [
      line(0, 'team-lead', 'b1', 'build the parser'),
      line(10_000, 'b1', 'team-lead', '[DONE] parser'),
      line(20_000, 'c1', 'team-lead', '[REVIEW] #3 approve'),
      line(60_000, 'w1', 'w2', '[PROPOSE] hello Finch'),
      line(62_000, 'w2', 'w1', '[PROPOSE] hello Wren'),
      line(64_000, 'w3', 'w1', '[PROPOSE] hello Kite'),
      line(3 * MIN, 'w1', 'team-lead', '[DONE] report'),
      line(4 * MIN, 'b1', 'team-lead', '[DONE] second build'),
      line(6 * MIN, 'v1', 'v2', '[PROPOSE] hello Lark'),
      line(6 * MIN + 2_000, 'v2', 'v1', 'ok'),
      line(8 * MIN, 'v2', 'team-lead', '[DONE] notes'),
    ]
    const runs = splitRuns(lines)
    expect(runs.map(r => r.names)).toEqual([['w1', 'w2', 'w3'], ['v1', 'v2']])
    expect(runs.map(r => [r.from - T0, r.to - T0])).toEqual([[30_000, 3 * MIN], [6 * MIN - 30_000, 8 * MIN]])
  })
  test('a team: a late teammate joins on its first peer message, sent or received; a name talking in another team does not; names reused after 30 quiet min found a new team', () => {
    const teams = teamsOf([
      line(0, 'w1', 'w2', 'hi'),
      line(MIN, 'v1', 'v2', 'hi'),
      line(5 * MIN, 'w4', 'w1', 'joining late'),
      line(5 * MIN + 1_000, 'w2', 'w5', 'welcome, take the tests'),
      line(6 * MIN, 'w1', 'v2', 'about your notes'),
      line(50 * MIN, 'w1', 'w2', 'again'),
    ])
    expect(teams.map(t => t.names)).toEqual([['w1', 'w4', 'w2', 'w5'], ['v1', 'v2'], ['w1', 'w2']])
  })
  test('a team lists its names in the order each first sent a peer line, as the concept placed them', () => {
    const teams = teamsOf([line(0, 'w1', 'w2', 'hi'), line(1_000, 'w3', 'w1', 'hi'), line(2_000, 'w2', 'w1', 'hi')])
    expect(teams[0]!.names).toEqual(['w1', 'w3', 'w2'])
  })
  test('two pairs that found teams a second apart are one team once a peer line links them', () => {
    const teams = teamsOf([line(0, 't1', 't2', 'hi'), line(1_000, 't3', 't4', 'hi'), line(5_000, 't1', 't3', 'which slice?')])
    expect(teams.map(t => t.names)).toEqual([['t1', 't3', 't2', 't4']])
    expect(teams[0]!.firstAt).toBe(T0)
  })
  test('two teams spawned 40 s apart stay apart when a member of one writes to the other', () => {
    const teams = teamsOf([
      line(0, 'w1', 'w2', 'hi'),
      line(40_000, 'v1', 'v2', 'hi'),
      line(50_000, 'w2', 'v1', 'which slice is yours?'),
      line(70_000, 'v1', 'v2', 'ok'),
      line(80_000, 'w1', 'w2', 'ok'),
    ])
    expect(teams.map(t => t.names)).toEqual([['w1', 'w2'], ['v1', 'v2']])
  })
  test('the schedule divides gaps by the speed and caps a quiet stretch at 1.5 s', () => {
    const lines = [line(0, 'a', 'b', 'x'), line(3_000, 'a', 'b', 'y'), line(30 * MIN, 'a', 'b', 'z')]
    expect(schedule(lines, 30)).toEqual([0, 100, 1_600])
  })
  test('the window keeps the lines between the times, in order', () => {
    expect(windowOf(fixture(), T0 + 5_000, T0 + 7_000).map(e => e.ts - T0)).toEqual([5_000, 6_000, 7_000])
  })
  test('a model per name: the latest spawned by the run start', () => {
    const models = modelsOf({ agents: [
      { name: 'w1', model: 'claude-opus-5-5[1m]', spawnedAt: T0 - 9 * MIN },
      { name: 'w1', model: 'claude-haiku-5-5', spawnedAt: T0 + 60 * MIN },
      { name: 'w2', model: 'claude-fable-5-1' },
    ] })
    expect(models('w1', T0)).toBe('opus')
    expect(models('w1', T0 + 61 * MIN)).toBe('haiku')
    expect(models('w2', T0)).toBe('fable')
    expect(models('w3', T0)).toBeUndefined()
  })
  test('a run title folds a numbered team', () => {
    expect(runTitle(['r1', 'r2', 'r4'])).toBe('r1–r4')
    expect(runTitle(['ann', 'bo'])).toBe('ann bo')
  })
})

describe('scene', () => {
  test('code names, sends and a tool call echo counted once', () => {
    const s = scene()
    expect(s.order().map(a => [a.name, a.code, a.sent])).toEqual([['w1', 'Finch', 6], ['w2', 'Wren', 2]])
  })
  test('states: running after a send, idle after its idle notice, stalled once idle past the stall time with a claim', () => {
    const s = scene(fixture(), T0 + 10_000)
    expect(s.stateAt('w1')).toBe('running')
    expect(s.stateAt('w2')).toBe('idle')
    expect(s.stateAt('w2', T0 + 8_000 + 5 * MIN)).toBe('stalled')
    expect(s.stateAt('w1', T0)).toBe('quiet')
  })
  test('lead wakes: an idle notice and a claim are held back, an @lead ask is delivered', () => {
    const s = scene(fixture(), T0 + 10_000)
    expect([s.delivered, s.held]).toEqual([1, 2])
  })
  test('two build claims on one file make one blocked duplicate card naming the path', () => {
    const cards = scene(fixture(), T0 + 7_000).cards()
    expect(cards).toHaveLength(1)
    expect(cards[0]).toMatchObject({ builders: ['w1', 'w2'], isDuplicate: true, status: 'blocked', path: '/tmp/out/report.md' })
  })
  test('a shared code name shows with the team name', () => {
    const s = new Scene()
    s.apply(line(0, 'w1', 'w2', '[PROPOSE] hello Kite'))
    s.apply(line(1, 'w2', 'w1', '[PROPOSE] hello kite'))
    expect([s.label('w1'), s.label('w2')]).toEqual(['Kite·w1', 'kite·w2'])
  })
  test('a message is in flight for 700 real ms after it played', () => {
    const s = scene(fixture(), T0 + 7_000)
    const at = (ms: number) => inFlight(s, view({ now: T0 + 7_000, age: ts => (ts === T0 + 7_000 ? ms : Infinity) })).map(p => p.m.type)
    expect(at(300)).toEqual(['BLOCK'])
    expect(at(800)).toEqual([])
  })
})

describe('looks', () => {
  for (const look of ['A', 'B'] as const) {
    test(`look ${look}: basic draws cells only and names both agents; rich adds images inside the grid`, () => {
      const s = scene(fixture(), T0 + 10_000)
      const basic = LOOK_FNS[look](s, view())
      expect(basic.images).toEqual([])
      expect(text(basic)).toContain('Finch')
      expect(text(basic)).toContain('Wren')
      const rich = LOOK_FNS[look](s, view({ level: 'rich' }))
      expect(rich.images.length).toBeGreaterThan(0)
      for (const im of rich.images) {
        expect(im.x + im.cols <= rich.grid.cols && im.y + im.rows <= rich.grid.rows).toBe(true)
        expect(im.draw().w).toBeGreaterThan(im.cols)
      }
      expect(rich.links).toEqual([{ label: 'report.md', href: 'file:///tmp/out/report.md' }])
    })
    test(`look ${look}: a narrow pane still draws, at its size`, () => {
      const f = LOOK_FNS[look](scene(), view({ cols: 44, rows: 18 }))
      expect([f.grid.cols, f.grid.rows]).toEqual([44, 18])
      expect(text(f)).toContain('Finch')
    })
    test(`look ${look}: a message in flight changes the cells, and once landed the frame settles`, () => {
      const s = scene(fixture(), T0 + 7_000)
      const at = (ms: number) => LOOK_FNS[look](s, view({ now: T0 + 7_000, age: ts => (ts === T0 + 7_000 ? ms : Infinity) })).grid.cells()
      expect(at(300)).not.toBe(at(5_000))
      expect(at(5_000)).toBe(at(9_000))
    })
    test(`look ${look}: rich images are still: within a sky interval a message landed moves cells only; a state change changes an image's sig`, () => {
      const s = scene(fixture(), T0 + 7_000)
      const sigs = (f: Frame) => f.images.map(im => im.key + '=' + im.sig).join(' ')
      const at = (ms: number) => LOOK_FNS[look](s, view({ level: 'rich', now: T0 + 7_000, age: ts => (ts === T0 + 7_000 ? ms : Infinity) }))
      const first = look === 'A' ? 300 : BURST_MS
      expect(sigs(at(first))).toBe(sigs(at(1_900)))
      expect(at(300).grid.cells()).not.toBe(at(1_900).grid.cells())
      const later = scene(fixture(), T0 + 8_000)
      expect(sigs(LOOK_FNS[look](later, view({ level: 'rich', now: T0 + 8_000 })))).not.toBe(sigs(at(5_000)))
    })
    test(`look ${look}: every rich image stays inside the size budget, even full screen with eight agents`, () => {
      const names = Array.from({ length: 8 }, (_, i) => 'w' + (i + 1))
      const s = new Scene()
      s.seed(names, T0)
      names.forEach((n, i) => s.apply(line(i * 1_000, n, names[(i + 1) % 8]!, `[PROPOSE] hello Bird${i}`)))
      for (const [cols, rows] of [[96, 32], [250, 60]] as const) {
        const f = LOOK_FNS[look](s, view({ level: 'rich', cols, rows }))
        for (const im of f.images) {
          if (im.source === undefined) expect(im.draw().source().rgba.length).toBeLessThanOrEqual(IMAGE_BUDGET)
          else expect(pngOf(im.source()).length).toBeLessThanOrEqual(SKY_BUDGET)
        }
      }
    })
  }
  test('look A rich: an image whose sig holds draws the same pixels, a card glowing or not', () => {
    const s = scene(fixture(), T0 + 8_000)
    const at = (age: number) => LOOK_FNS.A(s, view({ level: 'rich', now: T0 + 8_000, age: () => age }))
    const glowing = at(100)
    const still = at(Infinity)
    expect(glowing.grid.cells()).not.toBe(still.grid.cells())
    for (const im of glowing.images) {
      const twin = still.images.find(x => x.key === im.key)!
      if (twin.sig === im.sig) expect(twin.draw().source().rgba === im.draw().source().rgba).toBe(true)
    }
  })
  test('look A pins its header and the blocked claim card', () => {
    const f = LOOK_FNS.A(scene(fixture(), T0 + 7_000), view({ now: T0 + 7_000 }))
    expect(f.grid.rowText(0)).toMatch(/^ ◉ S W A R M {2}REPLAY · w1–w2 .* 10:00:07 {2}▶ 30× $/)
    expect(f.grid.rowText(3)).toMatch(/╭─ report\.md ─+ BLOCKED ─╮/)
  })
  test('look A live: the header says LIVE and no speed', () => {
    const f = LOOK_FNS.A(scene(fixture(), T0 + 7_000), view({ now: T0 + 7_000, speed: undefined, title: 'w1–w2' }))
    expect(f.grid.rowText(0)).toMatch(/LIVE · w1–w2 .* 10:00:07 {2}● live $/)
  })
  test('look B rich: the sky is a PNG at a cell\'s pixel size, filling its box, sent at most every 10 s; one past the budget drops to a smaller scale, never skipped', () => {
    const s = scene(fixture(), T0 + 10_000)
    const sky = LOOK_FNS.B(s, view({ level: 'rich' })).images.find(im => im.key === 'sky')!
    const png = pngOf(sky.source!())
    expect(png.startsWith('iVBORw0KGgo')).toBe(true)
    expect(pngSize(png)).toEqual([sky.cols * CELL_PX.w, sky.rows * CELL_PX.h])
    expect(sky.minMs).toBe(FALLBACK_SKY_MS)
    const names = Array.from({ length: 8 }, (_, i) => 'w' + (i + 1))
    const busy = new Scene()
    busy.seed(names, T0)
    names.forEach((n, i) => names.forEach((m, k) => k !== i && busy.apply(line(i * 1_000 + k, n, m, 'hi'))))
    const big = LOOK_FNS.B(busy, view({ level: 'rich', cols: 400, rows: 120 })).images.find(im => im.key === 'sky')!
    const bigPng = pngOf(big.source!())
    expect(bigPng.length).toBeGreaterThan(0)
    expect(bigPng.length).toBeLessThanOrEqual(SKY_BUDGET)
    expect(pngSize(bigPng)[0]).toBeLessThan(big.cols * CELL_PX.w)
  })
  test('the PNG deflate: an empty stream is the canonical fixed block, a run of one byte packs to a few bytes', () => {
    expect([...zlib(new Uint8Array(0))]).toEqual([0x78, 0x01, 0x03, 0x00, 0x00, 0x00, 0x00, 0x01])
    expect(zlib(new Uint8Array(10_000).fill(7)).length).toBeLessThan(150)
  })
  test('look B rich for the renderer: a message lights its edge with its age, the newest per edge, gone after LIT_MS; a burst lights every edge it used', () => {
    const s = scene(fixture(), T0 + 7_000)
    const at = (ms: number, sent = [T0 + 7_000]) => LOOK_FNS.B(s, view({ level: 'rich', now: T0 + 7_000, age: ts => (sent.includes(ts) ? ms : Infinity) }))
    const lit = (f: Frame) => f.images[0]!.stream!.lit.map(l => l.age)
    expect(lit(at(1_300))).toEqual([1_300])
    expect(lit(at(LIT_MS + 100))).toEqual([])
    expect(at(1_300).fadeMs).toBe(LIT_MS - 1_300)
    expect(lit(at(1_300, [T0 + 5_000, T0 + 6_000, T0 + 7_000]))).toHaveLength(2)
  })
  test('look B rich PNG sky (the fallback): its sig holds only structure, so lit edges, fades and wake counts never redraw it; at most once per 10 s; lit edges drawn without fade', () => {
    const s = scene(fixture(), T0 + 10_000)
    const at = (ms: number) => LOOK_FNS.B(s, view({ level: 'rich', now: T0 + 10_000, age: ts => (ts >= T0 + 7_000 ? ms : Infinity) })).images[0]!
    for (const ms of [0, 1_300, 2_500, 4_500, 7_000, Infinity]) expect(at(ms).sig).toBe(at(0).sig)
    expect(at(0).minMs).toBe(FALLBACK_SKY_MS)
    expect(FALLBACK_SKY_MS).toBeGreaterThanOrEqual(10_000)
    expect(at(1_300).draw().rgb().join() === at(4_500).draw().rgb().join()).toBe(true)
    const later = scene(fixture(), T0 + 20 * MIN)
    expect(LOOK_FNS.B(later, view({ level: 'rich', now: T0 + 20 * MIN })).images[0]!.sig).not.toBe(at(0).sig)
  })
  test('look B for the renderer: comets to the lead say whether they are held (stopping at the membrane) or delivered (reaching the centre); a pair\'s first message makes its edge young, drawn from its sender', () => {
    const at = (until: number, played: Record<number, number>) => LOOK_FNS.B(scene(fixture(), until), view({ level: 'rich', now: until, age: ts => played[ts] ?? 5_000 })).images[0]!.stream!
    const held = at(T0 + 9_000, { [T0 + 9_000]: 300 }).comets[0]!
    expect(held).toMatchObject({ lead: true, held: true })
    expect(held.stop).toBeLessThan(1)
    const sky = at(T0 + 9_000, { [T0 + 9_000]: 300 })
    const u = 1 - held.stop
    const end = [u * u * held.a[0] + 2 * u * held.stop * held.q[0] + held.stop ** 2 * held.b[0], u * u * held.a[1] + 2 * u * held.stop * held.q[1] + held.stop ** 2 * held.b[1]]
    expect(Math.hypot(end[0]! - sky.centre[0], end[1]! - sky.centre[1]) / sky.membrane).toBeGreaterThan(0.7)
    expect(Math.hypot(end[0]! - sky.centre[0], end[1]! - sky.centre[1]) / sky.membrane).toBeLessThan(1.6)
    const delivered = at(T0 + 10_000, { [T0 + 10_000]: 300 }).comets[0]!
    expect(delivered).toMatchObject({ lead: true, held: false, stop: 1, b: sky.centre })
    const fresh = new Scene()
    fresh.seed(['w1', 'w2'], T0)
    fresh.apply(line(0, 'w2', 'w1', 'first ever'))
    const edge = (ms: number) => LOOK_FNS.B(fresh, view({ level: 'rich', now: T0, age: () => ms })).images[0]!.stream!.edges[0]!
    expect(edge(400).age).toBe(400)
    expect(edge(1_200).age).toBeUndefined()
    const sky2 = LOOK_FNS.B(fresh, view({ level: 'rich', now: T0, age: () => 400 })).images[0]!.stream!
    const w2 = sky2.nodes[1]!
    expect(edge(400).a).toEqual([w2.x, w2.y])
  })
  test('look A has no watch mode: its images hold still while a burst flies', () => {
    const s = scene(fixture(), T0 + 7_000)
    const sigs = (ms: number) => LOOK_FNS.A(s, view({ level: 'rich', now: T0 + 7_000, age: ts => (ts === T0 + 7_000 ? ms : Infinity) })).images.map(i => i.key + '=' + i.sig).join(' ')
    for (let ms = 0; ms < BURST_MS; ms += 100) expect(sigs(ms)).toBe(sigs(BURST_MS))
  })
  test('look A: each card shows the file its agent last touched', () => {
    const lines = [...fixture().slice(0, 5), line(5_500, 'w1', '', '✎ hooks/core.ts', { type: 'FILE', via: 'tool' }), line(5_600, 'w2', '', '◦ README.md', { type: 'FILE', via: 'tool' })]
    const f = LOOK_FNS.A(scene(lines), view({ now: T0 + 6_000 }))
    expect(text(f)).toContain('✎ hooks/core.ts')
    expect(text(f)).toContain('◦ README.md')
  })
  test('look A: a card bar is the agent\'s sends per slot on one axis, coloured by its state then', () => {
    const s = new Scene()
    s.seed(['w1', 'w2'], T0)
    for (let i = 0; i < 6; i++) s.apply(line(i * 1_000, 'w1', 'w2', 'note ' + i))
    s.apply(line(10 * MIN, 'w1', 'team-lead', '{"type":"idle_notification"}', { type: 'IDLE', via: 'receive' }))
    s.apply(line(10 * MIN, 'w2', 'w1', 'one reply'))
    const v = view({ now: T0 + 19 * MIN, runTo: T0 + 20 * MIN })
    const f = LOOK_FNS.A(s, v)
    const row = (name: string) => {
      for (let y = 0; y < f.grid.rows; y++) if (f.grid.rowText(y).includes(' ' + name + ' ')) return y + 2
      return -1
    }
    const bar = (y: number) => f.grid.rowText(y).slice(3, 3 + 38)
    const slot = slotMs(20 * MIN, 38)
    const at10 = Math.floor((10 * MIN) / slot)
    expect(bar(row('w1'))[0]).toBe('█')
    expect(bar(row('w2'))[0]).toBe(' ')
    expect(bar(row('w2')).slice(at10, at10 + 2)).toBe('▂▁')
    const idleAt = 3 + at10 + 1
    expect(f.grid.fg[row('w1') * f.grid.cols + idleAt]).toBe(FLIGHT.state.idle)
    expect(f.grid.fg[row('w1') * f.grid.cols + 3]).toBe(FLIGHT.state.running)
  })
  test('look A: the message list shows names in full, never cut', () => {
    const s = new Scene()
    s.seed(['builder-alpha', 'builder-bravo'], T0)
    s.apply(line(0, 'builder-alpha', 'builder-bravo', '[PROPOSE] hello Kestrel'))
    s.apply(line(1, 'builder-bravo', 'builder-alpha', '[PROPOSE] hello kestrel'))
    expect(text(LOOK_FNS.A(s, view({ now: T0 + 1 })))).toMatch(/kestrel·builder-bravo +→ +Kestrel·builder-alpha/)
  })
  test('look B basic: the lead shows its delivered and held wakes beside it; the sky is half-block cells', () => {
    const f = LOOK_FNS.B(scene(fixture(), T0 + 10_000), view())
    expect(text(f)).toMatch(/▲ 1 ◉ ▽ 2/)
    expect(text(f)).toMatch(/LEAD/)
    expect(text(f)).toContain('▀')
  })
})

describe('pane drawing', () => {
  test('bands cut the grid at image rows; the shape changes when an image moves', () => {
    const grid = new Grid(20, 10)
    const canvas = { w: 8, h: 16 } as never
    const bands = bandsOf({ grid, links: [], images: [{ key: 'i', x: 4, y: 3, cols: 6, rows: 2, sig: '', draw: () => canvas, alt: ' ' }] })
    expect(bands.map(b => [b.y, b.rows, b.pieces.map(p => (p.kind === 'raster' ? `${p.x}+${p.cols}` : 'img'))])).toEqual([
      [0, 3, ['0+20']],
      [3, 2, ['0+4', 'img', '10+10']],
      [5, 5, ['0+20']],
    ])
    const moved = bandsOf({ grid, links: [], images: [{ key: 'i', x: 5, y: 3, cols: 6, rows: 2, sig: '', draw: () => canvas, alt: ' ' }] })
    expect(shapeOf(moved)).not.toBe(shapeOf(bands))
  })
  test('controls: one per agent, dim when another is the filter, the looks as hidden keys, then nudge, pause and stop', () => {
    const c = controlsOf(scene(), 'w1', 'B')
    expect(c.map(x => [x.label, x.dim === true, x.hidden === true])).toEqual([['Finch', false, false], ['Wren', true, false], ['A', false, true], ['B', false, true], ['nudge', false, false], ['pause', false, false], ['stop', false, false]])
  })
  test('raster cells encode code point, foreground and background per cell', () => {
    const g = new Grid(2, 1, 0x000000)
    g.put(0, 0, 'A', 0xff8800)
    const bytes = Uint8Array.from(atob(g.cells()), ch => ch.charCodeAt(0))
    expect([...new Uint32Array(bytes.buffer)]).toEqual([65, 0xff8800, 0, 32, 0x01000000, 0])
  })
})

describe('live scene and image sources', () => {
  test('the live scene follows the current team: a new team builds a new scene; a line of the same team feeds it', () => {
    const live = new LiveScene()
    for (const e of fixture()) live.push(e)
    const t1 = live.team(() => true)!
    expect(t1.names).toEqual(['w1', 'w2'])
    const s1 = live.scene(t1.names, t1.firstAt, () => undefined, 5 * MIN)
    expect(s1.order().map(a => a.code)).toEqual(['Finch', 'Wren'])
    live.push(line(21 * MIN, 'w2', 'w1', '[DONE] checked'))
    expect(live.scene(t1.names, t1.firstAt, () => undefined, 5 * MIN)).toBe(s1)
    expect(s1.agents.get('w2')!.sent).toBe(3)
    live.push(line(60 * MIN, 'v1', 'v2', '[PROPOSE] hello Lark'))
    const t2 = live.team(() => true)!
    expect(t2.names).toEqual(['v1', 'v2'])
    expect(live.scene(t2.names, t2.firstAt, () => undefined, 5 * MIN).order().map(a => a.code)).toEqual(['Lark', undefined])
  })
  test('a flood of FILE lines never pushes the current team out', () => {
    const live = new LiveScene()
    for (const e of fixture()) live.push(e)
    for (let i = 0; i < 6_000; i++) live.push(line(21 * MIN + i, 'w1', '', '◦ f' + (i % 2) + '.md', { type: 'FILE', via: 'tool' }))
    expect(live.team(() => true)?.names).toEqual(['w1', 'w2'])
  })
  test('an image is drawn once per sig, and a changed sig is shown at most once a second; changes in between merge into the next', () => {
    const shelf = new ImageShelf()
    let draws = 0
    const layer = (sig: string) => ({ key: 'k', x: 0, y: 0, cols: 2, rows: 1, sig, alt: ' ', draw: () => {
      draws++
      return LOOK_FNS.A(scene(), view({ level: 'rich' })).images[0]!.draw()
    } })
    expect(shelf.take(layer('a'), 0).isNew).toBe(true)
    expect(shelf.take(layer('a'), 10).isNew).toBe(false)
    expect(draws).toBe(1)
    expect(shelf.take(layer('b'), 400).isNew).toBe(false)
    expect(shelf.take(layer('c'), 900).isNew).toBe(false)
    expect(draws).toBe(1)
    expect(shelf.take(layer('c'), 1_000).isNew).toBe(true)
    expect(draws).toBe(2)
    shelf.forget('k')
    expect(shelf.take(layer('c'), 1_010).isNew).toBe(true)
    const sky = (sig: string) => ({ ...layer(sig), key: 'sky', minMs: SKY_MIN_MS })
    expect(shelf.take(sky('a'), 0).isNew).toBe(true)
    expect(shelf.take(sky('b'), 1_500).isNew).toBe(false)
    expect(shelf.take(sky('b'), 2_000).isNew).toBe(true)
  })
})

describe('look B arrivals', () => {
  const rowsOf = (f: Frame) => Array.from({ length: f.grid.rows }, (_, y) => f.grid.rowText(y))
  test('a landed comet shows its type for 1.5 s under the receiver\'s name; a burst is bundled as claim ×3', () => {
    const s = new Scene()
    s.seed(['w1', 'w2'], T0)
    s.apply(line(0, 'w1', 'w2', '[PROPOSE] hello Finch'))
    s.apply(line(1, 'w2', 'w1', '[PROPOSE] hello Wren'))
    for (const at of [10, 11, 12]) s.apply(line(at, 'w1', 'w2', `[CLAIM] build part${at}.md`))
    s.apply(line(13, 'w1', 'w2', '[HANDOFF] notes.md'))
    const frame = (age: number) => rowsOf(LOOK_FNS.B(s, view({ now: T0 + 13, age: ts => (ts >= T0 + 10 ? age : Infinity) }))).join('\n')
    expect(frame(1_200)).toMatch(/claim ×3 · hand/)
    expect(frame(300)).not.toMatch(/claim ×3/)
    expect(frame(2_600)).not.toMatch(/claim ×3/)
  })
})

describe('look B basic sky', () => {
  /** A busy moment: eight agents, every pair talking, a burst of claims to the lead in flight. */
  function busy(age: (ts: number) => number) {
    const names = Array.from({ length: 8 }, (_, i) => 'w' + (i + 1))
    const s = new Scene()
    s.seed(names, T0)
    names.forEach((n, i) => names.forEach((m, k) => k !== i && s.apply(line(i * 100 + k, n, m, '[PROPOSE] hello ' + n))))
    for (let k = 0; k < 5; k++) s.apply(line(2_000 + k * 10, 'w1', 'team-lead', '[CLAIM] build part' + k + '.md'))
    return LOOK_FNS.B(s, view({ cols: 120, rows: 36, now: T0 + 2_100, age }))
  }

  test('marks stay small: a comet in flight lights at most 12 cells of the bitmap, the sun\'s flare and a held splash at most 2 cells around', () => {
    const s = new Scene()
    s.seed(['w1', 'w2'], T0)
    s.apply(line(0, 'w1', 'w2', '[CLAIM] build a.md'))
    const ground = (ms: number) => LOOK_FNS.B(s, view({ cols: 120, rows: 36, now: T0, age: () => ms })).grid
    const changed = (a: Grid, b: Grid) => {
      let n = 0
      for (let i = 0; i < a.bg.length; i++) {
        const d = Math.abs(((a.bg[i]! >> 16) & 255) - ((b.bg[i]! >> 16) & 255)) + Math.abs(((a.bg[i]! >> 8) & 255) - ((b.bg[i]! >> 8) & 255)) + Math.abs((a.bg[i]! & 255) - (b.bg[i]! & 255))
        if (d > 24) n++
      }
      return n
    }
    const rest = ground(FLIGHT_MS + ARRIVAL_MS + 10)
    for (const ms of [200, 450, 700]) expect(changed(ground(ms), rest)).toBeLessThanOrEqual(12)
    const lead = new Scene()
    lead.seed(['w1'], T0)
    lead.apply(line(0, 'w1', 'team-lead', '[ASK] @lead which one?'))
    const sky = (ms: number) => LOOK_FNS.B(lead, view({ cols: 120, rows: 36, now: T0, age: () => ms })).grid
    expect(changed(sky(FLIGHT_MS + 20), sky(FLIGHT_MS + ARRIVAL_MS + 10))).toBeLessThanOrEqual(25)
    expect(changed(sky(FLIGHT_MS + 20), sky(FLIGHT_MS + ARRIVAL_MS + 10))).toBeGreaterThan(0)
    expect(changed(sky(FLIGHT_MS + 300 + 10), sky(FLIGHT_MS + ARRIVAL_MS + 10))).toBe(0)
    const resting = sky(FLIGHT_MS + ARRIVAL_MS + 10)
    let lit = 0
    for (let i = 0; i < resting.bg.length; i++) if (((resting.bg[i]! >> 16) & 255) + ((resting.bg[i]! >> 8) & 255) + (resting.bg[i]! & 255) > 200) lit++
    expect(lit).toBeLessThanOrEqual(6)
    const held = new Scene()
    held.seed(['w1'], T0)
    held.apply(line(0, 'w1', 'team-lead', '[PROPOSE] hello Finch'))
    const hsky = (ms: number) => LOOK_FNS.B(held, view({ cols: 120, rows: 36, now: T0, age: () => ms })).grid
    expect(Math.max(...[500, 600, 700, 800].map(ms => changed(hsky(ms), hsky(FLIGHT_MS + ARRIVAL_MS + 10))))).toBeLessThanOrEqual(25)
  })
  test('a frame stays under the Raster\'s 1024 colour pairs, even busy and wide', () => {
    for (const ms of [0, 300, 600, 900, 1_400, 2_400]) expect(colourPairs(busy(ts => (ts >= T0 + 2_000 ? ms : 5_000)).grid)).toBeLessThan(1024)
  })
  test('a frame draws in a few ms: under 50 ms at 120 × 36, the median of five', () => {
    const ms: number[] = []
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now()
      busy(ts => (ts >= T0 + 2_000 ? 400 + i * 50 : 5_000))
      ms.push(performance.now() - t0)
    }
    expect([...ms].sort((a, b) => a - b)[2]!).toBeLessThan(50)
  })
  test('a burst flies as one quiet label, `claim ×5`, and at most WORDS_MAX words fly at once', () => {
    const f = busy(ts => (ts >= T0 + 2_000 ? 500 : 5_000))
    expect(text(f)).toContain('claim ×5')
    const all = busy(ts => (ts >= T0 ? 300 : 5_000))
    expect((text(all).match(/propose|claim/g) ?? []).length).toBeLessThanOrEqual(WORDS_MAX * 2)
  })
  test('motion: the frame says how long its cells still move, and nothing after the last word rests', () => {
    expect(busy(ts => (ts >= T0 + 2_000 ? 500 : 5_000)).motionMs).toBe(FLIGHT_MS + ARRIVAL_MS - 500)
    expect(busy(() => 5_000).motionMs).toBeUndefined()
  })
  test('an edge grows behind its first comet: half way, about half its dots', () => {
    const s = new Scene()
    s.seed(['w1', 'w2'], T0)
    s.apply(line(0, 'w1', 'w2', 'first ever'))
    const dots = (ms: number) => {
      const f = LOOK_FNS.B(s, view({ cols: 120, rows: 36, now: T0, age: () => ms }))
      let n = 0
      for (let i = 0; i < f.grid.ch.length; i++) if (f.grid.ch[i]! > 0x2800 && f.grid.ch[i]! <= 0x28ff) n++
      return n
    }
    const before = dots(1)
    const mid = dots(FLIGHT_MS / 2)
    const settled = dots(FLIGHT_MS + ARRIVAL_MS + 1)
    expect(mid).toBeGreaterThan(before)
    expect(mid).toBeLessThan(settled + 40)
  })
  test('a held comet splashes at the membrane, a delivered one flares the sun; both settle', () => {
    const s = scene(fixture(), T0 + 10_000)
    const at = (played: Record<number, number>) => LOOK_FNS.B(s, view({ now: T0 + 10_000, age: ts => played[ts] ?? 9_000 })).grid
    /** The summed brightness of the cells within `r` columns (and r/2 rows) of the sun, found as the cell above `LEAD`. */
    const glow = (g: Grid, r: number) => {
      let sy = 0
      let sx = 0
      for (let y = 0; y < g.rows; y++) {
        const i = g.rowText(y).indexOf('LEAD')
        if (i >= 0 && g.rowText(y - 1)[i + 1] === '◉') [sx, sy] = [i + 1, y - 1]
      }
      let sum = 0
      for (let y = sy - Math.ceil(r / 2); y <= sy + Math.ceil(r / 2); y++) for (let x = sx - r; x <= sx + r; x++) {
        const c = g.bg[y * g.cols + x]!
        sum += ((c >> 16) & 255) + ((c >> 8) & 255) + (c & 255)
      }
      return sum
    }
    const quiet = at({})
    expect(glow(at({ [T0 + 10_000]: FLIGHT_MS + 30 }), 3)).toBeGreaterThan(glow(quiet, 3) * 1.1)
    const before = scene(fixture(), T0 + 9_000)
    const heldAt = (ms: number) => LOOK_FNS.B(before, view({ now: T0 + 9_000, age: ts => (ts === T0 + 9_000 ? ms : 9_000) })).grid
    expect(Math.max(...[400, 500, 600, 700, 800].map(ms => glow(heldAt(ms), 8)))).toBeGreaterThan(glow(heldAt(9_000), 8) * 1.02)
    expect(glow(heldAt(FLIGHT_MS + 600), 8)).toBeLessThan(glow(heldAt(9_000), 8) * 1.02)
    expect(glow(at({ [T0 + 10_000]: FLIGHT_MS + 600 }), 3)).toBeLessThan(glow(quiet, 3) * 1.05)
  })
})
