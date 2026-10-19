import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine, Plugin } from 'claude-code/testing'

const CWD = '/work'
const T0 = Date.parse('2026-01-05T10:00:00Z')
const DIR = '/tmp/swarm-abcdef01'

/** A run long enough (gaps capped at 1.5 s of replay) to stay on screen through each test. */
const LOG = [
  { ts: T0, from: 'w1', to: 'w2', summary: '[PROPOSE] hello Finch', length: 20, via: 'send', type: 'PROPOSE' },
  { ts: T0 + 3_000, from: 'w2', to: 'w1', summary: '[PROPOSE] hello Wren', length: 20, via: 'send', type: 'PROPOSE' },
  { ts: T0 + 6_000, from: 'w1', to: 'w2', summary: '[CLAIM] build /tmp/out/report.md', length: 30, via: 'send', type: 'CLAIM' },
  ...Array.from({ length: 16 }, (_, i) => ({ ts: T0 + 60_000 * (i + 1), from: i % 2 ? 'w2' : 'w1', to: i % 2 ? 'w1' : 'w2', summary: 'note ' + i, length: 6, via: 'send' })),
].map(e => JSON.stringify(e)).join('\n') + '\n'

const PANE = {
  plugin: 'agent-swarm',
  component: 'Pane',
  requestId: 'swarm',
  surface: 'terminal',
  viewport: { columns: 140, rows: 40 },
  props: { title: 'swarm', isFocused: true, bodyColumns: 90, placement: 'dock', scroll: { offset: 0, bodyRows: 34 }, view: {} },
} as const

const timer = (globalThis as unknown as { setTimeout: (f: () => void, ms: number) => void }).setTimeout
const real = (ms: number) => new Promise<void>(r => timer(r, ms))

type Opts = { unmountedFor?: number; spawnFails?: boolean; frames?: number; denyFiles?: boolean; unmounted?: number; abortsInRender?: boolean; crashes?: number; idles?: number; missing?: string[]; noNumpy?: string[] }

/**
 * Stubs the API; the renderer is a generator that says ready, sends `frames` frame lines, leaves idle when no scene comes
 * within 300 ms, else runs until scene.json says quit.
 */
function world(on: On, o: Opts = {}) {
  const w = { rendering: false, clock: mock.clock(on, { now: 1_000_000 }), files: new Map<string, string[]>(), argv: [] as (readonly string[])[], sky: [] as unknown[], paintedAt: [] as number[], killed: false, logs: [] as string[] }
  on('session.start', () => ({ cwd: CWD }) as never)
  on('session.cwd', () => ({ value: CWD }))
  on('session.id', () => ({ value: 'abcdef0123' }))
  on('env.get', () => ({ value: undefined }))
  on('fs.exists', ($, e) => ({ value: e.path === CWD + '/old/log.jsonl' }))
  on('fs.read', ($, e) => ({ value: e.path === CWD + '/old/log.jsonl' ? LOG : '' }) as never)
  on('fs.write', ($, e) => {
    w.files.set(e.path, [...(w.files.get(e.path) ?? []), e.text])
    return { value: undefined }
  })
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '' } }) as never)
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('command.register', () => ({ value: undefined }) as never)
  on('ui.log', ($, e) => {
    w.logs.push(String((e as { text?: unknown }).text ?? e))
    return { value: undefined }
  })
  on('ui.toast', () => ({ value: undefined }) as never)
  on('ui.blit', ($, e) => {
    if (!('source' in e)) w.paintedAt.push(w.clock.now())
    if ('source' in e && e.key === 'sky') {
      w.sky.push(e.source)
      if (o.denyFiles === true && 'file' in (e.source as object)) return { value: { deny: 'the Image draws its alt here: this terminal cannot read files on this machine' } }
      if (o.unmountedFor !== undefined && w.clock.now() < 1_000_000 + o.unmountedFor && 'file' in (e.source as object)) {
        return { value: { deny: 'no Image of its own is mounted under key "sky" in swarm' } }
      }
      if ((o.unmounted ?? 0) > 0 && 'file' in (e.source as object)) {
        o.unmounted!--
        return { value: { deny: 'no Image of its own is mounted under key "sky" in swarm' } }
      }
    }
    return { value: {} }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => ({ value: undefined }) as never)
  on('agent.list', () => ({ value: [] }) as never)
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['drawn by Claude Code'] }))
  on('process.spawn', async function* (_$: unknown, e: { argv: readonly string[] }) {
    w.argv = [...w.argv, e.argv]
    if (o.spawnFails === true || o.missing?.includes(e.argv[0]!) === true) throw new Error(`${e.argv[0]}: not found`)
    if (o.noNumpy?.includes(e.argv[0]!) === true) {
      yield { stream: 'stdout', text: 'fail numpy missing\n' }
      return { value: { code: 0, signal: null } }
    }
    if (o.abortsInRender === true && w.rendering) throw new Error('swarm: $.process.spawn(python3) aborted')
    try {
      yield { stream: 'stdout', text: 'ready\n' }
      for (let i = 1; i <= (o.frames ?? 1); i++) yield { stream: 'stdout', text: `frame ${DIR}/sky-1-${i % 3}.rgb ${i} 3.20 860 620\n` }
      if ((o.idles ?? 0) > 0) {
        o.idles!--
        yield { stream: 'stdout', text: 'bye idle\n' }
        return { value: { code: 0, signal: null } }
      }
      if ((o.crashes ?? 0) > 0) {
        o.crashes!--
        yield { stream: 'stderr', text: 'Traceback (most recent call last):\nKeyError: centre\n' }
        return { value: { code: 1, signal: null } }
      }
      const seen = w.files.get(DIR + '/scene.json')?.length ?? 0
      const scenes = () => w.files.get(DIR + '/scene.json')?.slice(seen) ?? []
      for (let waited = 0; scenes().length === 0; waited += 2) {
        if (waited > 300) {
          yield { stream: 'stdout', text: 'bye idle\n' }
          return { value: { code: 0, signal: null } }
        }
        await real(2)
      }
      while (!JSON.stringify(scenes().at(-1) ?? '').includes('quit')) await real(2)
      yield { stream: 'stdout', text: 'bye quit\n' }
      return { value: { code: 0, signal: null } }
    } finally {
      w.killed = true
    }
  } as never)
  return w
}

async function replayB($: Engine, w: ReturnType<typeof world>, speed = 10) {
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: CWD } as never)
  await $.command.run({ command: 'swarm', args: `replay old/log.jsonl --speed ${speed} --look B --level rich` } as never)
  w.rendering = true
  const ui = await $.ui.mount(PANE as never)
  w.rendering = false
  await w.clock.advance(400)
  await real(40)
  return ui
}

/** Look B draws the basic sky: no sky Image, and one dim line saying why. */
async function expectBasicSky(ui: { find: (q: never) => Promise<unknown>; drawn: () => Promise<unknown> }, why: RegExp) {
  expect(await ui.find({ type: 'Image', key: 'sky' } as never)).toBeUndefined()
  const notes = JSON.stringify(await ui.drawn()).match(/basic sky: the sky renderer failed \([^"]*\)/g) ?? []
  expect(notes).toHaveLength(1)
  expect(notes[0]).toMatch(why)
}

const scenes = (w: ReturnType<typeof world>) => (w.files.get(DIR + '/scene.json') ?? []).map(t => JSON.parse(t))

test('look B rich runs the sky renderer: it is handed the scene, and every frame it makes is shown by file, unthrottled', async ($, on) => {
  const w = world(on, { frames: 30 })
  const ui = await replayB($, w)
  expect(w.argv).toHaveLength(1)
  expect(w.argv[0]!.slice(0, 2)).toEqual(['python3', '-I'])
  expect(w.argv[0]![2]!.endsWith('/hooks/sky.py')).toBe(true)
  expect(w.argv[0]![3]).toBe(DIR)
  expect(w.files.has(DIR + '/bg.b64')).toBe(false)
  const scene = scenes(w).at(-1)
  expect(Object.keys(scene).sort()).toEqual(['accent', 'beads', 'centre', 'comets', 'count', 'dim', 'edges', 'flightMs', 'ground', 'h', 'haze', 'landMs', 'leaders', 'lit', 'litMs', 'membrane', 'membraneRgb', 'nodes', 'now', 'nu', 'rays', 'rule', 'seq', 'stalled', 'star', 'u', 'w'])
  expect(scene.nodes.map((n: { state: string }) => n.state)).toEqual(['running', 'running'])
  expect(scene.edges.length).toBeGreaterThan(0)
  for (const c of [...scene.comets, ...scene.lit]) expect(Object.keys(c).sort()).toEqual(['a', 'b', 'q', 'rgb', 'start', 'stop'])
  const files = w.sky.filter(s => typeof s === 'object' && s !== null && 'file' in s)
  expect(files).toHaveLength(30)
  expect(files.at(-1)).toEqual({ file: DIR + '/sky-1-0.rgb', format: 'rgb', width: 860, height: 620, generation: 30 })
  await ui.redraw()
  expect((await ui.find({ type: 'Image', key: 'sky' }))?.props.source).toEqual(files.at(-1))
  expect(((await $.command.run({ command: 'swarm', args: 'status' } as never)) as { text: string }).text).toMatch(/sky renderer: running \(3\.2 ms a frame\)/)
  await ui.unmount()
})

test('a renderer that cannot start: look B draws the basic sky, the pane and the status say why', async ($, on) => {
  const w = world(on, { spawnFails: true })
  const ui = await replayB($, w)
  await ui.redraw()
  await expectBasicSky(ui, /no python with numpy: python3: /)
  expect(w.logs.some(l => /sky renderer: no python with numpy/.test(l))).toBe(true)
  expect(((await $.command.run({ command: 'swarm', args: 'status' } as never)) as { text: string }).text).toMatch(/sky renderer: failed \(no python with numpy: python3: [^;]+; uv: [^)]+\), look B draws the basic sky/)
  await ui.unmount()
})

const UV = ['uv', 'run', '--no-project', '--with', 'numpy', 'python', '-I']

test('a python3 without numpy hands the renderer to uv with numpy, which a restart keeps', async ($, on) => {
  const w = world(on, { noNumpy: ['python3'], idles: 1 })
  const ui = await replayB($, w)
  await real(20)
  await ui.redraw()
  for (let i = 0; i < 5; i++) await w.clock.advance(100)
  await real(30)
  expect(w.argv.map(a => a.slice(0, -2))).toEqual([['python3', '-I'], UV, UV])
  expect(w.argv[1]!.slice(-2)[0]!.endsWith('/hooks/sky.py')).toBe(true)
  expect(w.argv[1]!.at(-1)).toBe(DIR)
  expect(((await $.command.run({ command: 'swarm', args: 'status' } as never)) as { text: string }).text).toMatch(/sky renderer: running/)
  await ui.unmount()
})

test('a python3 without numpy and no uv: look B draws the basic sky, the status naming both', async ($, on) => {
  const w = world(on, { noNumpy: ['python3'], missing: ['uv'] })
  const ui = await replayB($, w)
  await ui.redraw()
  await expectBasicSky(ui, /no python with numpy: python3: numpy missing; uv: /)
  expect(((await $.command.run({ command: 'swarm', args: 'status' } as never)) as { text: string }).text).toMatch(/sky renderer: failed \(no python with numpy: python3: numpy missing; uv: [^)]+\), look B draws the basic sky/)
  await ui.unmount()
})

test('the skyPython setting runs the renderer with that python alone', { options: { skyPython: '/opt/py/bin/python3' } }, async ($, on) => {
  const w = world(on, { noNumpy: ['/opt/py/bin/python3'] })
  const ui = await replayB($, w)
  await ui.redraw()
  expect(w.argv.map(a => a.slice(0, -2))).toEqual([['/opt/py/bin/python3', '-I']])
  expect(((await $.command.run({ command: 'swarm', args: 'status' } as never)) as { text: string }).text).toMatch(/sky renderer: failed \(no python with numpy: \/opt\/py\/bin\/python3: numpy missing\), look B draws the basic sky/)
  await ui.unmount()
})

test('a frame the terminal refuses ends the renderer and look B draws the basic sky', async ($, on) => {
  const w = world(on, { frames: 3, denyFiles: true })
  const ui = await replayB($, w)
  await real(20)
  expect(w.killed).toBe(true)
  expect(scenes(w).at(-1)).toMatchObject({ quit: true })
  await ui.redraw()
  await expectBasicSky(ui, /frame refused: .*cannot read files/)
  await ui.unmount()
})

test('the scene goes to the renderer only when it changes: idle in the hold after the replay finished, nothing is written and the pane paints at most once a second', async ($, on) => {
  const w = world(on)
  const ui = await replayB($, w, 1_000)
  await w.clock.advance(2_100)
  const settled = scenes(w).length
  const painted = new Set(w.paintedAt).size
  await w.clock.advance(1_400)
  expect(scenes(w).at(-1)).not.toHaveProperty('pause')
  expect(scenes(w).length).toBe(settled)
  expect(new Set(w.paintedAt).size - painted).toBeLessThanOrEqual(1)
  await ui.unmount()
})

test('leaving look B pauses the renderer, its process kept; back on look B it gets the scene again', async ($, on) => {
  const w = world(on)
  const ui = await replayB($, w)
  await ui.press({ key: 'view-A' })
  await real(20)
  expect(scenes(w).at(-1)).toMatchObject({ pause: true })
  expect(w.killed).toBe(false)
  await ui.press({ key: 'view-B' })
  await w.clock.advance(100)
  await real(20)
  expect(scenes(w).at(-1)).toMatchObject({ w: expect.any(Number) })
  expect(scenes(w).at(-1)).not.toHaveProperty('pause')
  expect(w.argv).toHaveLength(1)
  expect(w.killed).toBe(false)
  await ui.unmount()
})

test('the sky stands on its own dark ground: a terminal that fits it inside its box shows that colour, not grey bars', async ($, on) => {
  const w = world(on)
  const ui = await replayB($, w)
  const ground = await ui.find({ type: 'Box', key: 'sky-ground' })
  expect(ground?.props.backgroundColor).toBe('#07060e')
  expect((ground?.children as { type: string }[]).map(c => c.type)).toEqual(['Image'])
  await ui.unmount()
})

test('a frame that comes before the sky Image is mounted waits and is shown once it is; the renderer keeps running', async ($, on) => {
  const w = world(on, { frames: 1, unmounted: 2 })
  const ui = await replayB($, w)
  for (let i = 0; i < 20; i++) await w.clock.advance(100)
  await real(20)
  const files = w.sky.filter(s => typeof s === 'object' && s !== null && 'file' in s)
  expect(files).toHaveLength(3)
  expect(((await $.command.run({ command: 'swarm', args: 'status' } as never)) as { text: string }).text).toMatch(/sky renderer: running/)
  await ui.redraw()
  expect((await ui.find({ type: 'Image', key: 'sky' }))?.props.source).toEqual(files.at(-1))
  await ui.unmount()
})

test('a sky Image unmounted for 10 s is no failure: the renderer keeps running and its frame is shown once the Image is back', async ($, on) => {
  const w = world(on, { frames: 1, unmountedFor: 10_000 })
  const ui = await replayB($, w)
  for (let i = 0; i < 120; i++) await w.clock.advance(100)
  await real(20)
  expect(((await $.command.run({ command: 'swarm', args: 'status' } as never)) as { text: string }).text).toMatch(/sky renderer: running/)
  await ui.redraw()
  expect(Object.keys((await ui.find({ type: 'Image', key: 'sky' }))?.props.source as object)).toContain('file')
  await ui.unmount()
})

test('the renderer is started by the session, after the render that wants it returned: a host that aborts a child with the render that spawned it does not stop it', async ($, on) => {
  const w = world(on, { frames: 2, abortsInRender: true })
  const ui = await replayB($, w)
  await real(20)
  expect(w.argv).toHaveLength(1)
  expect(w.killed).toBe(false)
  expect(((await $.command.run({ command: 'swarm', args: 'status' } as never)) as { text: string }).text).toMatch(/sky renderer: running/)
  await ui.unmount()
})

test('while the renderer runs, the sky Image only ever gets file frames', async ($, on) => {
  const w = world(on, { frames: 5 })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: CWD } as never)
  await $.command.run({ command: 'swarm', args: 'replay old/log.jsonl --speed 10 --look B --level rich' } as never)
  const ui = await $.ui.mount(PANE as never)
  expect((await ui.find({ type: 'Image', key: 'sky' }))?.props.source).toEqual({ rgba: 'BwYO/w==', width: 1, height: 1 })
  for (let i = 0; i < 80; i++) await w.clock.advance(100)
  await real(20)
  await ui.redraw()
  expect(scenes(w).length).toBeGreaterThan(2)
  expect(w.sky.filter(x => !(typeof x === 'object' && x !== null && 'file' in x))).toEqual([])
  expect(Object.keys((await ui.find({ type: 'Image', key: 'sky' }))?.props.source as object)).toContain('file')
  await ui.unmount()
})

test('replay, stop, replay: the renderer pauses and runs again, one process', async ($, on) => {
  const w = world(on)
  await replayB($, w)
  await $.command.run({ command: 'swarm', args: 'replay stop' } as never)
  for (let i = 0; i < 5; i++) await w.clock.advance(100)
  await real(30)
  await $.command.run({ command: 'swarm', args: 'replay old/log.jsonl --speed 10 --look B --level rich' } as never)
  for (let i = 0; i < 5; i++) await w.clock.advance(100)
  await real(30)
  expect(w.argv).toHaveLength(1)
  expect(((await $.command.run({ command: 'swarm', args: 'status' } as never)) as { text: string }).text).toMatch(/sky renderer: running/)
})

test('a replay started four times in a row keeps one renderer running', async ($, on) => {
  const w = world(on, { frames: 2 })
  const ui = await replayB($, w)
  for (let k = 0; k < 3; k++) {
    await $.command.run({ command: 'swarm', args: 'replay old/log.jsonl --speed 10 --look B --level rich' } as never)
    await ui.redraw()
    for (let i = 0; i < 5; i++) await w.clock.advance(100)
    await real(10)
  }
  expect(w.argv).toHaveLength(1)
  expect(w.killed).toBe(false)
  expect(((await $.command.run({ command: 'swarm', args: 'status' } as never)) as { text: string }).text).toMatch(/sky renderer: running/)
  await ui.unmount()
})

test('a crashed renderer starts once more, the crash in the status; a second crash fails it for the session', async ($, on) => {
  const once = world(on, { crashes: 1 })
  const ui = await replayB($, once)
  for (let i = 0; i < 5; i++) await once.clock.advance(100)
  await ui.redraw()
  await real(30)
  expect(once.argv).toHaveLength(2)
  expect(((await $.command.run({ command: 'swarm', args: 'status' } as never)) as { text: string }).text).toMatch(/sky renderer: running \(crashed once: exit 1: KeyError: centre/)
  await ui.unmount()
})

test('a renderer that crashes twice fails for the session, its exit and stderr in the status', async ($, on) => {
  const w = world(on, { crashes: 2 })
  const ui = await replayB($, w)
  for (let i = 0; i < 5; i++) await w.clock.advance(100)
  await ui.redraw()
  await real(30)
  expect(w.argv).toHaveLength(2)
  expect(((await $.command.run({ command: 'swarm', args: 'status' } as never)) as { text: string }).text).toMatch(/sky renderer: failed \(renderer crashed: exit 1: KeyError: centre\), look B draws the basic sky/)
  await ui.unmount()
})

test('a renderer that left idle is no failure: the next draw that wants it starts it again', async ($, on) => {
  const w = world(on, { idles: 1 })
  const ui = await replayB($, w)
  await real(20)
  await ui.redraw()
  for (let i = 0; i < 5; i++) await w.clock.advance(100)
  await real(30)
  expect(w.argv).toHaveLength(2)
  expect(((await $.command.run({ command: 'swarm', args: 'status' } as never)) as { text: string }).text).toMatch(/sky renderer: running$|sky renderer: running \(/m)
  await ui.unmount()
})

for (const speed of [1, 3, 30]) {
  test(`a full replay at ${speed}× with the renderer running draws only its frames: every sky blit and the drawn source are its files`, async ($, on) => {
    const w = world(on, { frames: 4 })
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: CWD } as never)
    await $.command.run({ command: 'swarm', args: `replay old/log.jsonl --speed ${speed} --look B --level rich` } as never)
    const ui = await $.ui.mount(PANE as never)
    for (let i = 0; i < 100; i++) {
      await w.clock.advance(100)
      if (i % 10 === 0) await ui.redraw()
    }
    await real(20)
    await ui.redraw()
    expect(w.sky.filter(x => !(typeof x === 'object' && x !== null && 'file' in x))).toEqual([])
    expect(Object.keys((await ui.find({ type: 'Image', key: 'sky' }))?.props.source as object)).toContain('file')
    const status = ((await $.command.run({ command: 'swarm', args: 'status' } as never)) as { text: string }).text
    expect(status).toMatch(/sky renderer: running/)
    await ui.unmount()
  })
}

/** A plugin standing for the person's close mark: `/closer` closes the swarm pane, raising `ui.close` through every plugin. */
const CLOSER = {
  name: 'closer',
  register: (on: Parameters<Plugin['register']>[0]) => {
    on('command.run', { command: 'closer' }, async $ => {
      await $.ui.close({ id: 'swarm' })
      return {}
    })
  },
}

test('closing the pane quits the renderer cleanly; reopening starts it again, and look B stays rich', { plugins: [CLOSER] }, async ($, on) => {
  const w = world(on)
  const ui = await replayB($, w)
  expect(((await $.command.run({ command: 'swarm', args: 'status' } as never)) as { text: string }).text).toMatch(/sky renderer: running/)
  await ui.unmount()
  await $.command.run({ command: 'closer', args: '' } as never)
  await real(20)
  expect(scenes(w).at(-1)).toMatchObject({ quit: true })
  expect(w.killed).toBe(true)
  const blits = w.sky.length
  for (let i = 0; i < 20; i++) await w.clock.advance(100)
  expect(w.sky.length).toBe(blits)
  expect(((await $.command.run({ command: 'swarm', args: 'status' } as never)) as { text: string }).text).toMatch(/sky renderer: off(?! \(crashed)/)
  await $.command.run({ command: 'swarm', args: 'replay old/log.jsonl --speed 10 --look B --level rich' } as never)
  const again = await $.ui.mount(PANE as never)
  for (let i = 0; i < 5; i++) await w.clock.advance(100)
  await real(30)
  expect(w.argv).toHaveLength(2)
  const status = ((await $.command.run({ command: 'swarm', args: 'status' } as never)) as { text: string }).text
  expect(status).toMatch(/sky renderer: running/)
  await again.redraw()
  expect(await again.find({ type: 'Image', key: 'sky' })).toBeDefined()
  await again.unmount()
})
