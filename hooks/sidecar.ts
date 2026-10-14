// The look B sky renderer process: hooks/sky.py paints the star map and writes each frame to a file the terminal reads
// itself; the pane shows a frame by blitting its `{ file }` source, so no pixel crosses the engine and the mod draws no
// picture of its own. The mod hands it the scene in DIR/scene.json. Any failure falls back for good.

import type { EngineInterface, ImageSource } from 'claude-code'

import type { SkyLine, SkyScene } from './looks'

export type SidecarState = 'off' | 'starting' | 'running' | 'failed'

/** Real ms before a frame the host held back (the sky Image not drawn now, the terminal busy) is offered again. */
const RETRY_MS = 500

/** The refusals that mean the terminal will never show a `{ file }` frame: no pictures at all, or no files read. */
const CANNOT_SHOW = /draws no placeholder images|cannot read files on this machine/

/** The renderer's state; the functions below act on it. */
export type SkySidecar = {
  requestId: string
  key: string
  state: SidecarState
  /** Why it failed, once it did. */
  failure: string | undefined
  /** The latest frame as an Image source, once one came. */
  source: ImageSource | undefined
  /** The renderer's ms per frame, the last 100. */
  renderMs: number[]
  /** The newest frame not yet taken by the host. */
  pending: ImageSource | undefined
  retryTimer: { cancel: () => void } | undefined
  /** How often it crashed this session, and the last crash: its exit and the end of its stderr. */
  crashes: number
  crash: string | undefined
  /** Whether the running renderer said it ends on its own (`bye`), and the end of its stderr. */
  isLeaving: boolean
  stderr: string
  dir: string
  stream: AsyncGenerator<unknown, unknown> | undefined
  seq: number
  sent: string
}

export function newSidecar(requestId: string, key: string): SkySidecar {
  return { requestId, key, state: 'off', failure: undefined, source: undefined, renderMs: [], crashes: 0, crash: undefined, isLeaving: false, stderr: '', pending: undefined, retryTimer: undefined, dir: '', stream: undefined, seq: 0, sent: '' }
}

/** Starts the renderer in `dir` while it is asked for (`starting`) and not yet spawned; its frames are blitted as they come. */
export function startSidecar($: EngineInterface, sc: SkySidecar, dir: string) {
  if (sc.state !== 'starting' || sc.stream !== undefined) return
  sc.dir = dir
  sc.sent = ''
  sc.isLeaving = false
  sc.stderr = ''
  const stream = $.process.spawn({ argv: ['python3', '-I', `${$.plugin.root}/hooks/sky.py`, dir] })
  sc.stream = stream
  void readSidecar($, sc, stream)
}

/**
 * Reads the renderer's lines until it ends. An end it announced (`bye`: told to quit, idle) or one we caused leaves it off,
 * to start again when wanted; any other end is a crash: the first leaves it off with the crash noted, a second fails it.
 */
async function readSidecar($: EngineInterface, sc: SkySidecar, stream: AsyncGenerator<{ stream: string; text: string }, unknown>) {
  let buf = ''
  let end: { code?: number | null; signal?: string | null } | undefined
  try {
    for (let r = await stream.next(); ; r = await stream.next()) {
      if (r.done === true) {
        end = r.value as typeof end
        break
      }
      if (sc.stream !== stream) break
      if (r.value.stream === 'stderr') {
        sc.stderr = (sc.stderr + r.value.text).slice(-400)
        continue
      }
      buf += r.value.text
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        await sidecarLine($, sc, line)
      }
    }
  } catch (err) {
    if (sc.stream === stream) failSidecar($, sc, 'renderer did not start: ' + String(err))
    return
  }
  if (sc.stream !== stream) return
  sc.stream = undefined
  sc.source = undefined
  sc.sent = ''
  if (sc.isLeaving) {
    sc.state = 'off'
    return
  }
  const last = sc.stderr.trim().split('\n').pop() ?? ''
  const crash = `exit ${end?.code ?? end?.signal ?? '?'}${last === '' ? '' : ': ' + last}`
  if (++sc.crashes > 1) failSidecar($, sc, 'renderer crashed: ' + crash)
  else {
    sc.crash = crash
    sc.state = 'off'
    $.ui.log('swarm sky renderer crashed, starts again when wanted: ' + crash)
  }
}

async function sidecarLine($: EngineInterface, sc: SkySidecar, line: string) {
  const [kind, ...rest] = line.split(' ')
  if (kind === 'ready') sc.state = 'running'
  else if (kind === 'bye') sc.isLeaving = true
  else if (kind === 'fail') failSidecar($, sc, rest.join(' '))
  else if (kind === 'frame' && sc.state !== 'failed') {
    const [file, gen, ms, w, h] = rest
    sc.renderMs.push(Number(ms))
    if (sc.renderMs.length > 100) sc.renderMs.shift()
    sc.pending = { file: file!, format: 'rgb' as const, width: Number(w), height: Number(h), generation: Number(gen) }
    await flushSidecar($, sc)
  }
}

/**
 * Blits the newest frame to the sky Image. A refusal that says the terminal cannot show it fails the renderer; any other
 * (the Image not drawn now, the terminal busy) keeps the newest frame and offers it again in `RETRY_MS` and after each
 * draw of the pane, for as long as it takes.
 */
async function flushSidecar($: EngineInterface, sc: SkySidecar) {
  const source = sc.pending
  if (source === undefined || sc.state === 'failed' || sc.state === 'off') return
  const res = await $.ui.blit({ requestId: sc.requestId, key: sc.key, source }).catch((err: unknown) => ({ deny: String(err) }))
  if (res.deny === undefined) {
    if (sc.pending === source) sc.pending = undefined
    sc.source = source
  } else if (CANNOT_SHOW.test(res.deny)) failSidecar($, sc, 'frame refused: ' + res.deny)
  else if (sc.retryTimer === undefined) {
    sc.retryTimer = $.clock.after(RETRY_MS, () => {
      sc.retryTimer = undefined
      void flushSidecar($, sc)
    })
  }
}

/** Hands the renderer the scene when it changed, each lit edge and comet with its start in the mod's clock at `now`. */
export async function updateSidecar($: EngineInterface, sc: SkySidecar, now: number, sky: SkyScene) {
  if (sc.state === 'off' || sc.state === 'failed') return
  const timed = ({ age, ...rest }: SkyLine) => ({ ...rest, start: Math.round(now - age) })
  const scene = {
    ...sky,
    edges: sky.edges.map(({ age, ...e }) => (age === undefined ? e : { ...e, start: Math.round(now - age) })),
    lit: sky.lit.map(timed),
    comets: sky.comets.map(timed),
  }
  const sent = JSON.stringify(scene)
  if (sent === sc.sent) return
  sc.sent = sent
  await $.fs.write(sc.dir + '/scene.json', JSON.stringify({ seq: ++sc.seq, now, ...scene }))
}

/** Ends the renderer cleanly, as when its pane closes: it reads `quit`, removes its files and exits; it starts again when wanted. */
export async function quitSidecar($: EngineInterface, sc: SkySidecar) {
  if (sc.state === 'off' || sc.state === 'failed') return
  await endSidecar($, sc)
  sc.state = 'off'
}

/** Pauses the renderer while look B rich is not drawn: it draws nothing until the next scene. */
export async function pauseSidecar($: EngineInterface, sc: SkySidecar) {
  if (sc.state === 'off' || sc.state === 'failed' || sc.sent === 'pause') return
  sc.sent = 'pause'
  sc.pending = undefined
  await $.fs.write(sc.dir + '/scene.json', JSON.stringify({ seq: ++sc.seq, pause: true }))
}

function failSidecar($: EngineInterface, sc: SkySidecar, why: string) {
  if (sc.state === 'failed') return
  sc.failure = why
  void endSidecar($, sc)
  sc.state = 'failed'
  $.ui.log('swarm sky renderer: ' + why)
  $.ui.invalidate('ui.render')
}

async function endSidecar($: EngineInterface, sc: SkySidecar) {
  const stream = sc.stream
  sc.stream = undefined
  sc.source = undefined
  sc.sent = ''
  sc.pending = undefined
  sc.retryTimer?.cancel()
  sc.retryTimer = undefined
  await $.fs.write(sc.dir + '/scene.json', JSON.stringify({ seq: ++sc.seq, quit: true })).catch(() => undefined)
  void stream?.return(undefined)
}
