import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { machineTime } from './zone'

const CWD = '/work'

const T0 = Date.parse('2026-01-05T10:00:00Z')

const LOG = [
  { ts: T0, from: 'w1', to: 'w2', summary: '[PROPOSE] hello Finch', length: 20, via: 'send', type: 'PROPOSE' },
  { ts: T0 + 3_000, from: 'w2', to: 'w1', summary: '[PROPOSE] hello Wren', length: 20, via: 'send', type: 'PROPOSE' },
  { ts: T0 + 6_000, from: 'w1', to: 'w2', summary: '[CLAIM] build /tmp/out/report.md', length: 30, via: 'send', type: 'CLAIM' },
].map(e => JSON.stringify(e)).join('\n') + '\n'

/** Stubs the mods API calls the replay makes; the log lives at /work/old/log.jsonl. */
function world(on: On, blitDeny?: string, log = LOG) {
  const w = { opens: [] as unknown[], clock: mock.clock(on, { now: 1_000_000 }), blits: [] as string[], images: [] as { key: string; rgba: string }[], toasts: [] as string[], writes: [] as string[], saved: new Map<string, unknown>(), opened: 0 }
  on('session.start', () => ({ cwd: CWD }) as never)
  on('session.cwd', () => ({ value: CWD }))
  on('session.id', () => ({ value: 'abcdef0123' }))
  on('env.get', () => ({ value: undefined }))
  on('fs.exists', ($, e) => ({ value: e.path === CWD + '/old/log.jsonl' }))
  on('fs.read', ($, e) => ({ value: e.path === CWD + '/old/log.jsonl' ? log : '' }) as never)
  on('fs.write', ($, e) => {
    w.writes.push(e.path)
    return { value: undefined }
  })
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '' } }) as never)
  on('store.get', ($, e) => ({ value: w.saved.get(e.key) }))
  on('store.set', ($, e) => {
    w.saved.set(e.key, e.value)
    return { value: undefined }
  })
  on('command.register', () => ({ value: undefined }) as never)
  on('ui.log', () => ({ value: undefined }))
  on('ui.toast', ($, e) => {
    w.toasts.push(String((e as { text?: unknown }).text ?? e))
    return { value: undefined } as never
  })
  on('ui.blit', ($, e) => {
    w.blits.push(e.key)
    if ('source' in e) {
      if (blitDeny !== undefined) return { value: { deny: blitDeny } }
      w.images.push({ key: e.key, rgba: (e.source as { rgba?: string }).rgba ?? '' })
    }
    return { value: {} }
  })
  on('ui.open', ($, e) => {
    w.opens.push(e)
    w.opened++
    return { value: { isPlaced: true } }
  })
  on('agent.list', () => ({ value: [] }) as never)
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['drawn by Claude Code'] }))
  return w
}

const PANE = {
  plugin: 'agent-swarm',
  component: 'Pane',
  requestId: 'swarm',
  surface: 'terminal',
  viewport: { columns: 140, rows: 40 },
  props: { title: 'swarm', isFocused: true, bodyColumns: 90, placement: 'dock', scroll: { offset: 0, bodyRows: 34 }, view: {} },
} as const

test('replay plays a log into the pane by blit, filters on an agent press, and stop gives the live look back', async ($, on) => {
  const w = world(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: CWD } as never)
  const r = (await $.command.run({ command: 'swarm', args: 'replay old/log.jsonl --speed 10 --look B --level basic' } as never)) as { text: string }
  expect(r.text).toMatch(/^replaying w1–w2 at 10× · look B basic/)
  expect(w.opened).toBe(1)
  const ui = await $.ui.mount(PANE as never)
  expect((await ui.findAll({ type: 'Raster' })).length).toBeGreaterThan(0)
  expect(await ui.find({ type: 'Button', text: 'Finch' })).toBeDefined()
  await w.clock.advance(350)
  expect(w.blits.length).toBeGreaterThan(0)
  const views = await ui.find({ type: 'Box', key: 'views' })
  expect(views?.props.display).toBe('none')
  expect((views?.children as { props: { key?: string; hotkey?: string } }[]).map(b => [b.props.key, b.props.hotkey])).toEqual([['view-A', '1'], ['view-B', '2']])
  await ui.press({ key: 'view-A' })
  await ui.press({ key: 'agent-w2' })
  expect(await ui.find({ type: 'Button', text: 'Wren' })).toBeDefined()
  await ui.press({ key: 'nudge' })
  expect(w.toasts.some(t => /a replay sends nothing/.test(t))).toBe(true)
  expect(w.writes).toEqual([])
  const after = w.blits.length
  await w.clock.advance(2_000)
  const settled = w.blits.length
  await w.clock.advance(800)
  expect(w.blits.length).toBe(settled)
  expect(settled).toBeGreaterThan(after)
  await $.command.run({ command: 'swarm', args: 'replay stop' } as never)
  expect(await ui.find({ type: 'Button', text: 'stop' })).toBeUndefined()
  expect(await ui.find({ type: 'Button', key: 'view-list' })).toBeDefined()
  await ui.unmount()
})

test('a replay shows each agent from its first log line, not from the run\'s start', async ($, on) => {
  const log = LOG + JSON.stringify({ ts: T0 + 60_000, from: 'w3', to: 'w1', summary: '[PROPOSE] hello Kite', length: 20, via: 'send', type: 'PROPOSE' }) + '\n'
  const w = world(on, undefined, log)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: CWD } as never)
  const r = (await $.command.run({ command: 'swarm', args: 'replay old/log.jsonl --speed 10' } as never)) as { text: string }
  expect(r.text).toMatch(/^replaying w1–w3/)
  const ui = await $.ui.mount(PANE as never)
  expect(await ui.find({ type: 'Button', key: 'agent-w1' })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'agent-w3' })).toBeUndefined()
  for (let i = 0; i < 8; i++) await w.clock.advance(500)
  expect(await ui.find({ type: 'Button', text: 'Kite' })).toBeDefined()
  await ui.unmount()
})

test('replay reports what it cannot play', async ($, on) => {
  world(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: CWD } as never)
  expect(await $.command.run({ command: 'swarm', args: 'replay old/log.jsonl --look Z' } as never)).toEqual({ text: '--look takes A or B' })
  expect(await $.command.run({ command: 'swarm', args: 'replay old/log.jsonl --from 2020-01-01T00:00:00Z --to 2020-01-02T00:00:00Z' } as never)).toEqual({ text: 'no run in /work/old/log.jsonl between those times' })
  expect(await $.command.run({ command: 'swarm', args: 'replay stop' } as never)).toEqual({ text: 'no replay running' })
})

test('the pane turns rich by itself where the terminal draws pictures, and the choice persists with /swarm level', async ($, on) => {
  const w = world(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: CWD } as never)
  await $.command.run({ command: 'swarm', args: 'replay old/log.jsonl --speed 10' } as never)
  const ui = await $.ui.mount(PANE as never)
  expect((await ui.findAll({ type: 'Image' })).map(i => i.key)).toEqual(['probe'])
  await w.clock.advance(1_000)
  const keys = (await ui.findAll({ type: 'Image' })).map(i => i.key)
  expect(keys).toContain('bar-w1')
  expect(keys).not.toContain('probe')
  expect(await $.command.run({ command: 'swarm', args: 'level basic' } as never)).toEqual({ text: 'pane level: basic' })
  expect(w.saved.get('level')).toBe('basic')
  expect(await ui.findAll({ type: 'Image' })).toEqual([])
  expect(await $.command.run({ command: 'swarm', args: 'level sharp' } as never)).toEqual({ text: 'usage: /swarm level auto|basic|rich' })
  await ui.unmount()
})

test('where a picture draws as its alt the pane stays basic', async ($, on) => {
  const w = world(on, 'the Image draws its alt here: the terminal draws no placeholder images (no reply)')
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: CWD } as never)
  await $.command.run({ command: 'swarm', args: 'replay old/log.jsonl --speed 10' } as never)
  const ui = await $.ui.mount(PANE as never)
  await w.clock.advance(100)
  expect(await ui.findAll({ type: 'Image' })).toEqual([])
  expect((await ui.findAll({ type: 'Raster' })).length).toBeGreaterThan(0)
  await ui.unmount()
})

test('a probe refused for another reason stays basic and asks again, at most three times', async ($, on) => {
  const w = world(on, 'the Image draws its alt here: every 8-bit image id is in use')
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: CWD } as never)
  await $.command.run({ command: 'swarm', args: 'replay old/log.jsonl --speed 10' } as never)
  for (let i = 0; i < 5; i++) {
    const ui = await $.ui.mount(PANE as never)
    await w.clock.advance(100)
    await ui.unmount()
  }
  expect(w.blits.filter(k => k === 'probe').length).toBe(3)
})

test('rich replay: an Image is sent again only when what it draws changed, never on the frame timer', async ($, on) => {
  const w = world(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: CWD } as never)
  await $.command.run({ command: 'swarm', args: 'replay old/log.jsonl --speed 10 --level rich' } as never)
  const ui = await $.ui.mount(PANE as never)
  for (let i = 0; i < 40; i++) await w.clock.advance(100)
  const rasters = w.blits.filter(k => k.startsWith('r')).length
  const sent = w.images.filter(i => i.key !== 'probe')
  expect(rasters).toBeGreaterThan(10)
  expect(sent.length).toBeLessThan(rasters / 4)
  for (const key of new Set(sent.map(i => i.key))) {
    const mine = sent.filter(i => i.key === key).map(i => i.rgba)
    expect(mine.every((r, i) => i === 0 || r !== mine[i - 1])).toBe(true)
  }
  const before = w.blits.length
  await w.clock.advance(5_000)
  expect(w.blits.length).toBe(before)
  await ui.unmount()
})

test('/swarm and /swarm replay open the pane asking for the keyboard, so its keys press its buttons', async ($, on) => {
  const w = world(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: CWD } as never)
  await $.command.run({ command: 'swarm', args: '' } as never)
  await $.command.run({ command: 'swarm', args: 'replay old/log.jsonl' } as never)
  expect(w.opens).toEqual([{ id: 'swarm', title: 'swarm', focus: true, closeOnEscape: true }, { id: 'swarm', title: 'swarm replay', focus: true }])
})

test('a replay started again, after a stop or while one plays, draws its control row', async ($, on) => {
  const w = world(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: CWD } as never)
  const ui = await $.ui.mount(PANE as never)
  await $.command.run({ command: 'swarm', args: 'replay old/log.jsonl --speed 10' } as never)
  await w.clock.advance(2_000)
  expect(await ui.find({ type: 'Button', key: 'stop' })).toBeDefined()
  await $.command.run({ command: 'swarm', args: 'replay stop' } as never)
  await $.command.run({ command: 'swarm', args: 'replay old/log.jsonl --speed 10' } as never)
  await w.clock.advance(2_000)
  expect(await ui.find({ type: 'Button', key: 'stop' })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'agent-w1' })).toBeDefined()
  await $.command.run({ command: 'swarm', args: 'replay old/log.jsonl --speed 10' } as never)
  await w.clock.advance(2_000)
  expect(await ui.find({ type: 'Button', key: 'stop' })).toBeDefined()
  await ui.unmount()
})

test('the control row comes first and a short pane shrinks the stage, so the buttons are never below the body', async ($, on) => {
  const w = world(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: CWD } as never)
  await $.command.run({ command: 'swarm', args: 'replay old/log.jsonl --speed 10 --level rich' } as never)
  const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, scroll: { offset: 0, bodyRows: 7 } } } as never)
  await w.clock.advance(2_000)
  const tree = (await ui.drawn()) as { children: { type: string; key?: string; props: { key?: string; height?: number } }[] }
  expect(tree.children[0]!.props.key).toBe('controls')
  expect(await ui.find({ type: 'Button', key: 'stop' })).toBeDefined()
  const top = (await ui.findAll({ type: 'Box' })).filter(b => String(b.key ?? '').startsWith('band-'))
  const stageRows = top.reduce((n, b) => n + Number(b.props.height), 0)
  expect(stageRows + 2).toBeLessThanOrEqual(7)
  const first = await ui.findAll({ type: 'Button' })
  expect(first.length).toBeGreaterThan(0)
  await ui.unmount()
})

test('rich look B without the renderer: fading lit edges never send the sky again, and the pane goes still', async ($, on) => {
  const w = world(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: CWD } as never)
  await $.command.run({ command: 'swarm', args: 'replay old/log.jsonl --speed 10 --look B --level rich' } as never)
  const ui = await $.ui.mount(PANE as never)
  for (let i = 0; i < 20; i++) await w.clock.advance(100)
  const skies = () => w.images.filter(i => i.key === 'sky').length
  const early = skies()
  for (let i = 0; i < 80; i++) await w.clock.advance(100)
  expect(skies()).toBe(early)
  const blits = w.blits.length
  await w.clock.advance(10_000)
  expect(w.blits.length).toBe(blits)
  await ui.unmount()
})

test('a replay without flags plays the most recent run, and its playhead reaches the run\'s last line', async ($, on) => {
  const at = (min: number, from: string, to: string, summary: string, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ ts: T0 + min * 60_000, from, to, summary, length: summary.length, via: 'send', ...extra })
  const log = [
    at(0, 'v1', 'v2', 'hi'), at(0.1, 'v2', 'v1', 'hi'), at(1, 'v1', 'v2', 'a'), at(1.1, 'v2', 'v1', 'b'), at(1.2, 'v1', 'v2', 'c'), at(2, 'v1', 'team-lead', '[DONE] old'),
    at(60, 'w1', 'w2', 'hi'), at(60.1, 'w2', 'w1', 'hi'),
    at(65, 'w1', 'team-lead', '[DONE] report'),
    at(66, 'w2', 'team-lead', '{"type":"idle_notification"}', { type: 'IDLE', via: 'receive' }),
    at(67, 'team-lead', 'w1', 'thanks, all done'),
  ].join('\n') + '\n'
  const w = world(on, undefined, log)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: CWD } as never)
  const r = (await $.command.run({ command: 'swarm', args: 'replay old/log.jsonl --speed 3' } as never)) as { text: string }
  expect(r.text).toMatch(/^replaying w1–w2/)
  expect(r.text).toMatch(/▶ w1–w2/)
  const ui = await $.ui.mount(PANE as never)
  for (let i = 0; i < 13; i++) await w.clock.advance(500)
  expect(w.toasts.some(t => /replay finished/.test(t))).toBe(true)
  const cells = (await ui.findAll({ type: 'Raster' })).map(x => {
    const words = new Uint32Array(Uint8Array.from(atob(String(x.props.cells)), ch => ch.charCodeAt(0)).buffer)
    let s = ''
    for (let k = 0; k < words.length; k += 3) s += String.fromCharCode(words[k]!)
    return s
  }).join('')
  expect(cells).toContain(machineTime(Date.parse('2026-01-05T11:07:00Z')))
  await ui.unmount()
})

test('look B basic keeps painting while its comets fly and words rest, then goes still', async ($, on) => {
  const w = world(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: CWD } as never)
  await $.command.run({ command: 'swarm', args: 'replay old/log.jsonl --speed 10 --look B --level basic' } as never)
  const ui = await $.ui.mount(PANE as never)
  for (let i = 0; i < 21; i++) await w.clock.advance(100)
  const settled = w.blits.length
  for (let i = 0; i < 8; i++) await w.clock.advance(100)
  const late = w.blits.length
  expect(late).toBeGreaterThan(settled)
  for (let i = 0; i < 40; i++) await w.clock.advance(100)
  const still = w.blits.length
  await w.clock.advance(5_000)
  expect(w.blits.length).toBe(still)
  await ui.unmount()
})

/** The glyphs every Raster of a mounted pane shows, rows joined. */
async function cellsOf(ui: { findAll: (q: never) => Promise<{ props: Record<string, unknown> }[]> }): Promise<string> {
  const out: string[] = []
  for (const r of await ui.findAll({ type: 'Raster' } as never)) {
    const words = new Uint32Array(Uint8Array.from(atob(String(r.props.cells)), ch => ch.charCodeAt(0)).buffer)
    let line = ''
    for (let k = 0; k < words.length; k += 3) line += String.fromCharCode(words[k]!)
    out.push(line)
  }
  return out.join('\n')
}

test('a finished replay holds its end frame with a note for 3 s, then the pane shows the live swarm', async ($, on) => {
  const w = world(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: CWD } as never)
  await $.command.run({ command: 'swarm', args: 'replay old/log.jsonl --speed 10' } as never)
  const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: 120 } } as never)
  for (let i = 0; i < 8; i++) await w.clock.advance(100)
  expect(await cellsOf(ui)).toContain('replay finished')
  expect(await ui.find({ type: 'Button', key: 'stop' })).toBeDefined()
  await w.clock.advance(2_500)
  expect(await ui.find({ type: 'Button', key: 'stop' })).toBeDefined()
  await w.clock.advance(1_000)
  expect(await ui.find({ type: 'Button', key: 'stop' })).toBeUndefined()
  expect(await cellsOf(ui)).toContain('LIVE')
  await ui.unmount()
})
