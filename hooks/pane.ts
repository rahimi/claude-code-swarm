// The pane's stage at run time: the live team and `/swarm replay`, drawn by look A or B in bands of Rasters and Images;
// cells move frame by frame while an event lands, Images are sent only when what they draw changed.

import type { EngineInterface, RenderElement, RenderInputOf } from 'claude-code'

import { parseLog } from './core'
import { css } from './grid'
import { newSidecar, pauseSidecar, quitSidecar, startSidecar, updateSidecar } from './sidecar'
import type { LogEntry } from './core'
import { FLASH_MS, PULSE_MS } from './looks'
import type { Frame, ImageLayer, View } from './looks'
import { IMAGE_MIN_MS, ImageShelf, LOOK_FNS, agentControls, bandsOf, controlsOf, shapeOf, viewControls } from './pane-draw'
import type { Control } from './pane-draw'
import { Scene, modelsOf, parseReplayArgs, runTitle, schedule, splitRuns, windowOf } from './replay'
import type { Look, Level, ReplayArgs, Run } from './replay'

export const PANE = 'swarm'
/** Real ms between animation frames while a message travels or a change glows. */
const FRAME_MS = 80
/** How long after the latest event the animation keeps running. */
const ANIMATE_MS = Math.max(PULSE_MS, FLASH_MS * 1.5)
/** A 1×1 picture the pane draws once to learn whether the terminal shows pictures. */
const PROBE_SOURCE = { rgba: 'AAAA/w==', width: 1, height: 1 }

export type LevelSetting = Level | 'auto'

/** The person's level choice; `auto` is rich where the terminal draws pictures. */
let levelSetting: LevelSetting = 'auto'
/** Whether a probe Image drew as a picture (true) or the terminal draws none (false); undefined until a blit tells. */
let imagesDrawn: boolean | undefined
/** Probe blits refused for another reason (no image id free, not yet mounted); the pane stops asking after `PROBE_TRIES`. */
let probeRefusals = 0
const PROBE_TRIES = 3

export function setLevel(level: LevelSetting) {
  levelSetting = level
}

/** The level a stage draws at: an explicit one, else the setting, `auto` resolved by the probe. */
function levelOf(explicit?: Level): Level {
  const l = explicit ?? levelSetting
  return l === 'auto' ? (imagesDrawn === true ? 'rich' : 'basic') : l
}

/** What a stage draws now, at a size and a real time. */
type FrameOf = (cols: number, rows: number, realNow: number) => Frame

type Stage = {
  look: Look
  filter?: string
  anim?: { cancel: () => void }
  /** The next paint while an image still fades after the motion ended. */
  settle?: { cancel: () => void }
  /** The real ms the last frame's images still change, and its cells still move, by themselves. */
  fadeMs: number
  motionMs: number
  lastEventReal: number
  /** The stage size the pane last drew, and the bands' shape then. */
  size?: { cols: number; rows: number }
  shape?: string
  /** The source each Image shows, sent at most once a second. */
  images: ImageShelf
}

function newStage(look: Look): Stage {
  return { look, lastEventReal: 0, images: new ImageShelf(), fadeMs: 0, motionMs: 0 }
}

type Replay = Stage & {
  level?: Level
  speed: number
  run: Run
  lines: LogEntry[]
  realAt: number[]
  scene: Scene
  /** The next line to play. */
  next: number
  /** The real time playback would have started at, paused time left out. */
  startReal: number
  pausedAt?: number
  /** When each played run time was played, in real ms. */
  played: Map<number, number>
  timer?: { cancel: () => void }
  /** Whether it played its last line; it then hands the pane back to the live view after `REPLAY_HOLD_MS`. */
  isFinished: boolean
  /** Whether live team activity came while it played: the pane offers `[ live ]`. */
  isLiveWaiting: boolean
}

/** How long a finished replay holds its end frame before the pane shows the live view again. */
export const REPLAY_HOLD_MS = 3_000

/** What the live stage draws: the current team's scene, its title and when it started. */
/** What the live pane draws; `endedAt`, once every teammate of the team has ended: its last activity, where the clock holds. */
export type LiveSource = { scene: Scene; title: string; from: number; endedAt?: number }

export type LiveView = Look | 'list'

let replay: Replay | undefined
const live: Stage & { view: LiveView; source?: () => LiveSource } = { ...newStage('A'), view: 'A' }

export function isReplaying(): boolean {
  return replay !== undefined
}

/** Which live view the pane shows: look A (the default), look B, or the text list. */
export function liveView(): LiveView {
  return live.view
}

function stopReplay() {
  replay?.timer?.cancel()
  replay?.anim?.cancel()
  replay?.settle?.cancel()
  replay = undefined
}

function replayFrame(r: Replay): FrameOf {
  return (cols, rows, realNow) => {
    const last = r.lines[r.next - 1]
    const view: View = {
      cols,
      rows,
      level: lookLevel(r.look, levelOf(r.level)),
      now: last?.ts ?? r.run.from,
      runFrom: r.run.from,
      runTo: r.run.to,
      title: runTitle(r.run.names),
      speed: r.speed,
      isPaused: r.pausedAt !== undefined,
      age: ts => {
        const at = r.played.get(ts)
        return at === undefined ? Infinity : realNow - at
      },
      ...(r.filter === undefined ? {} : { filter: r.filter }),
      ...(r.isFinished || r.isLiveWaiting ? { note: [...(r.isFinished ? ['replay finished'] : []), ...(r.isLiveWaiting ? ['live swarm running'] : [])].join(' · ') } : {}),
    }
    return LOOK_FNS[r.look](r.scene, view)
  }
}

function liveFrame(src: LiveSource): FrameOf {
  return (cols, rows, realNow) => {
    const now = src.endedAt ?? realNow
    const view: View = {
      cols,
      rows,
      level: lookLevel(live.look, levelOf()),
      now,
      runFrom: src.from,
      runTo: Math.max(now, src.from + 1),
      title: src.title,
      isPaused: false,
      ...(src.endedAt === undefined ? {} : { isEnded: true }),
      age: ts => realNow - ts,
      ...(live.filter === undefined ? {} : { filter: live.filter }),
    }
    return LOOK_FNS[live.look](src.scene, view)
  }
}

/** The stage on screen now and how to draw it, or undefined when the pane shows no stage. */
function current(): { stage: Stage; frame: FrameOf } | undefined {
  if (replay !== undefined) return { stage: replay, frame: replayFrame(replay) }
  if (live.view !== 'list' && live.source !== undefined) return { stage: live, frame: liveFrame(live.source()) }
  return undefined
}

/** Plays every line that is due, schedules the next one, and animates when anything played; the last line draws the pane in full. */
async function step($: EngineInterface) {
  const r = replay
  if (r === undefined || r.pausedAt !== undefined) return
  r.timer = undefined
  const now = await $.clock.now()
  const elapsed = now - r.startReal
  let played = false
  while (r.next < r.lines.length && r.realAt[r.next]! <= elapsed) {
    const e = r.lines[r.next]!
    r.scene.apply(e)
    r.played.set(e.ts, now)
    r.next++
    played = true
  }
  if (played) {
    r.lastEventReal = now
    animate($, r)
  }
  if (r.next < r.lines.length) {
    r.timer = $.clock.after(Math.max(1, r.realAt[r.next]! - elapsed), () => {
      void step($)
    })
  } else if (played) {
    r.isFinished = true
    $.ui.invalidate('ui.render')
    $.ui.toast('swarm: replay finished')
    r.timer = $.clock.after(REPLAY_HOLD_MS, () => {
      if (replay !== r) return
      stopReplay()
      $.ui.invalidate('ui.render')
    })
  }
}

/** Live team activity (a teammate spawned, a peer message) while a replay shows: the pane offers `[ live ]` (key 0). */
export function liveActivity($: EngineInterface) {
  if (replay === undefined || replay.isLiveWaiting) return
  replay.isLiveWaiting = true
  $.ui.invalidate('ui.render')
}

/** A live event landed: the live stage animates while it moves on screen. */
export async function liveEvent($: EngineInterface) {
  if (replay !== undefined || live.size === undefined || live.view === 'list') return
  live.lastEventReal = await $.clock.now()
  animate($, live)
}

/** Runs frames while the latest event still moves on screen (a frame's `motionMs`), then stops; never a frame without an event. */
function animate($: EngineInterface, s: Stage) {
  if (s.anim !== undefined) return
  void paint($)
  s.anim = $.clock.every(FRAME_MS, () => {
    void (async () => {
      const now = await $.clock.now()
      if (now - s.lastEventReal > ANIMATE_MS && s.motionMs <= 0) {
        s.anim?.cancel()
        s.anim = undefined
      }
      if (current()?.stage === s) await paint($)
      if (s.anim === undefined) settle($, s)
    })()
  })
}

/** After the motion, paints once a second while the stage's images still fade, then stops. */
function settle($: EngineInterface, s: Stage) {
  s.settle?.cancel()
  s.settle = undefined
  if (s.fadeMs <= 0) return
  s.settle = $.clock.after(IMAGE_MIN_MS, () => {
    s.settle = undefined
    if (s.anim !== undefined || current()?.stage !== s) return
    void paint($).then(() => settle($, s))
  })
}

/**
 * Repaints the mounted stage: every Raster by blit, an Image only when its sig changed; a change of shape (an agent
 * appeared, a resize) draws the pane again instead.
 */
async function paint($: EngineInterface) {
  try {
    await paintNow($)
  } catch (err) {
    $.ui.log('swarm paint: ' + String(err))
  }
}

async function paintNow($: EngineInterface) {
  const cur = current()
  const size = cur?.stage.size
  if (cur === undefined || size === undefined) return
  const s = cur.stage
  const now = await $.clock.now()
  const frame = cur.frame(size.cols, size.rows, now)
  s.fadeMs = frame.fadeMs ?? 0
  s.motionMs = frame.motionMs ?? 0
  await feedSky($, frame, now)
  const bands = bandsOf(frame)
  if (shapeOf(bands) !== s.shape) {
    $.ui.invalidate('ui.render')
    return
  }
  for (const b of bands) {
    for (const p of b.pieces) {
      if (p.kind === 'raster') {
        await $.ui.blit({ requestId: PANE, key: p.key, cells: frame.grid.cells(p.x, b.y, p.cols, b.rows), columns: p.cols, rows: b.rows })
      } else if (p.layer.stream === undefined || !skyActive()) {
        const { source, isNew } = takeImage($, s, p.layer, now)
        if (isNew && (await $.ui.blit({ requestId: PANE, key: p.layer.key, source })).deny !== undefined) s.images.forget(p.layer.key)
      }
    }
  }
}

/** The look B sky renderer process, while a stage draws look B rich. */
const sky = newSidecar(PANE, 'sky')
let skyDir: string | undefined
/**
 * Starts the renderer through the session's `$`, on its clock: a child spawned through a render's or a paint's `$` is
 * killed when that dispatch is abandoned (a render superseded, its budget spent). Set at `session.start`.
 */
let startSky: ((dir: string) => void) | undefined

/** Makes the session's `$` the owner of the sky renderer. */
export function ownSky($: EngineInterface) {
  startSky = dir => {
    $.clock.after(0, () => startSidecar($, sky, dir))
  }
}

/**
 * Keeps the sky renderer in step with a frame: started and handed the scene while the frame has a streamed sky, stopped
 * when it has none; once failed, the frame's PNG sky is used.
 */
async function feedSky($: EngineInterface, frame: Frame, now: number) {
  const layer = frame.images.find(im => im.stream !== undefined)
  if (layer === undefined) return pauseSidecar($, sky)
  if (sky.state === 'failed') return
  if (sky.state === 'off') {
    if (startSky === undefined) return
    skyDir ??= `${(await $.env.get('TMPDIR')) ?? '/tmp'}`.replace(/\/+$/, '') + `/swarm-${(await $.session.id()).slice(0, 8)}`
    sky.state = 'starting'
    sky.dir = skyDir
    startSky(skyDir)
    return
  }
  await updateSidecar($, sky, now, layer.stream!)
}

/** The longest a PNG sky may take to draw (the `skyMaxDrawMs` option): one slower turns look B basic for the session; 0, the first one does. */
let skyMaxDrawMs = 50

export function setSkyMaxDrawMs(ms: number) {
  skyMaxDrawMs = ms
}
/** How long the PNG sky took when it was too slow; set, look B draws at the basic level. */
let slowSkyMs: number | undefined

/** An Image's source from the stage's shelf; a new PNG sky past `skyMaxDrawMs` turns look B basic. */
function takeImage($: EngineInterface, s: Stage, layer: ImageLayer, now: number) {
  const t0 = performance.now()
  const r = s.images.take(layer, now)
  const ms = performance.now() - t0
  if (r.isNew && layer.stream !== undefined && (skyMaxDrawMs === 0 || ms > skyMaxDrawMs) && slowSkyMs === undefined) {
    slowSkyMs = ms
    $.ui.log(`swarm: the PNG sky took ${Math.round(ms)} ms, look B draws basic`)
    $.ui.invalidate('ui.render')
  }
  return r
}

/** The level look `look` draws at: basic for look B once its PNG sky proved too slow. */
function lookLevel(look: Look, level: Level): Level {
  return look === 'B' && slowSkyMs !== undefined ? 'basic' : level
}

/** Whether the renderer paints the sky: then the mod draws no PNG sky and shows only its `{ file }` frames. */
function skyActive(): boolean {
  return sky.state === 'starting' || sky.state === 'running'
}

/** What the sky Image shows until the renderer's first frame: one pixel of the sky's dark ground. */
const SKY_WAIT = { rgba: 'BwYO/w==', width: 1, height: 1 }

/** The sky renderer's state for `/swarm status`. */
export function skyStatus(): string {
  const ms = [...sky.renderMs].sort((a, b) => a - b)
  const slow = slowSkyMs === undefined ? '' : `, PNG sky took ${Math.round(slowSkyMs)} ms, look B basic`
  if (sky.state === 'failed') return 'failed (' + sky.failure + '), PNG sky' + slow
  const notes = [...(sky.crash === undefined ? [] : ['crashed once: ' + sky.crash]), ...(ms.length > 0 ? [`${ms[ms.length >> 1]!.toFixed(1)} ms a frame`] : [])]
  return sky.state + (notes.length > 0 ? ` (${notes.join('; ')})` : '') + slow
}

/**
 * Blits the probe Image once it is mounted: taken, the terminal draws pictures; refused because the terminal draws no
 * placeholder images, it does not. Any other refusal counts toward `PROBE_TRIES`.
 */
async function probe($: EngineInterface) {
  if (imagesDrawn !== undefined || probeRefusals >= PROBE_TRIES) return
  const res = await $.ui.blit({ requestId: PANE, key: 'probe', source: PROBE_SOURCE }).catch(() => ({ deny: 'no blit' }))
  if (res.deny === undefined) imagesDrawn = true
  else if (/no placeholder images/i.test(res.deny)) imagesDrawn = false
  else if (++probeRefusals < PROBE_TRIES) return
  $.ui.invalidate('ui.render')
}

/** The run to play: the window the flags give, else the most recent run. */
function pickRun(lines: readonly LogEntry[], runs: readonly Run[], args: ReplayArgs): Run | undefined {
  if (args.from !== undefined || args.to !== undefined) {
    const from = args.from ?? -Infinity
    const to = args.to ?? Infinity
    const inside = windowOf(lines, from, to)
    if (inside.length === 0) return undefined
    const names = [...new Set(splitRuns(inside).flatMap(r => r.names))]
    return { from: inside[0]!.ts, to: inside[inside.length - 1]!.ts, count: inside.length, names }
  }
  return [...runs].sort((a, b) => b.from - a.from)[0]
}

/** `/swarm replay …`: starts or stops a replay; the text lists the runs the log holds. */
export async function replayCommand($: EngineInterface, rest: string): Promise<{ text: string }> {
  const parsed = parseReplayArgs(rest)
  if ('error' in parsed) return { text: parsed.error }
  if ('stop' in parsed) {
    const was = replay !== undefined
    stopReplay()
    $.ui.invalidate('ui.render')
    return { text: was ? 'replay stopped; the pane shows the live swarm' : 'no replay running' }
  }
  const args = parsed.args
  const path = args.path.startsWith('/') ? args.path : (await $.session.cwd()) + '/' + args.path
  let text: string
  try {
    text = await $.fs.read(path)
  } catch (err) {
    return { text: `cannot read ${path}: ${String(err)}` }
  }
  const lines = parseLog(text)
  const runs = splitRuns(lines)
  const run = pickRun(lines, runs, args)
  if (run === undefined) return { text: `no run in ${path}${args.from !== undefined || args.to !== undefined ? ' between those times' : ''}` }
  let rosterJson: unknown = null
  const rosterPath = path.replace(/[^/]*$/, 'roster.json')
  try {
    if (await $.fs.exists(rosterPath)) rosterJson = JSON.parse(await $.fs.read(rosterPath))
  } catch {
    rosterJson = null
  }
  stopReplay()
  const win = windowOf(lines, run.from, run.to)
  const scene = new Scene(modelsOf(rosterJson))
  scene.seed(run.names, run.from)
  replay = {
    ...newStage(args.look),
    ...(args.level === undefined ? {} : { level: args.level }),
    speed: args.speed,
    run,
    lines: win,
    realAt: schedule(win, args.speed),
    scene,
    next: 0,
    startReal: await $.clock.now(),
    played: new Map(),
    isFinished: false,
    isLiveWaiting: false,
  }
  await $.ui.open({ id: PANE, title: 'swarm replay', focus: true })
  $.ui.invalidate('ui.render')
  void step($)
  const list = runs.map(r => `  ${r === run ? '▶' : ' '} ${runTitle(r.names).padEnd(12)} --from ${new Date(r.from).toISOString()} --to ${new Date(r.to).toISOString()}  (${r.count} lines)`)
  return { text: [`replaying ${runTitle(run.names)} at ${args.speed}× · look ${args.look} ${levelOf(args.level)}; stop with /swarm replay stop`, 'runs in this log:', ...list].join('\n') }
}

/**
 * The stage's tree: the control row first, so a body the host cuts short never hides it, then the bands of Rasters and
 * Images sized to the rows left, the caller's rows, and the claim paths when rich.
 */
async function renderStage($: EngineInterface, e: RenderInputOf<'Pane', 'terminal'>, s: Stage, level: Level, frameOf: FrameOf, controls: Control[], extra: RenderElement[]): Promise<RenderElement> {
  const { Box, Text, Raster, Image, Link } = $.ui.resolve(e)
  const frameRows = Math.max(3, Math.min(60, e.props.scroll.bodyRows - (level === 'rich' ? 2 : 1) - extra.length))
  const cols = Math.max(20, e.props.bodyColumns)
  const now = await $.clock.now()
  const frame = frameOf(cols, frameRows, now)
  s.motionMs = frame.motionMs ?? 0
  await feedSky($, frame, now)
  const bands = bandsOf(frame)
  s.size = { cols, rows: frameRows }
  s.shape = shapeOf(bands)
  const stage = bands.map(b =>
    Box({
      key: 'band-' + b.y,
      flexDirection: 'row',
      height: b.rows,
      children: b.pieces.map(p => {
        if (p.kind === 'raster') return Raster({ key: p.key, columns: p.cols, rows: b.rows, cells: frame.grid.cells(p.x, b.y, p.cols, b.rows) })
        const source = p.layer.stream !== undefined && skyActive() ? (sky.source ?? SKY_WAIT) : takeImage($, s, p.layer, now).source
        const image = Image({ key: p.layer.key, columns: p.layer.cols, rows: p.layer.rows, source, alt: p.layer.alt })
        if (p.layer.ground === undefined) return image
        return Box({ key: p.layer.key + '-ground', width: p.layer.cols, height: p.layer.rows, backgroundColor: css(p.layer.ground), children: [image] })
      }),
    }),
  )
  const buttons = buttonsOf($, e, controls, key => press($, key))
  if (levelSetting === 'auto' && imagesDrawn === undefined && probeRefusals < PROBE_TRIES) {
    buttons.push(Image({ key: 'probe', columns: 1, rows: 1, source: PROBE_SOURCE, alt: ' ' }))
    $.clock.after(50, () => {
      void probe($)
    })
  }
  const rows: RenderElement[] = [Box({ key: 'controls', flexDirection: 'row', flexWrap: 'wrap', columnGap: 2, children: buttons }), ...stage, ...extra]
  if (level === 'rich' && frame.links.length > 0) {
    rows.push(Text({ dimColor: true, children: ['open: ', ...frame.links.flatMap((l, i) => [...(i > 0 ? ['  '] : []), Link({ href: l.href, label: l.label })])] }))
  }
  return Box({ flexDirection: 'column', children: rows })
}

/** The controls as Buttons; the hidden ones last, in a Box drawn `display: none`, so only their hotkeys act. */
export function buttonsOf($: EngineInterface, e: RenderInputOf<'Pane', 'terminal'>, controls: readonly Control[], onPress: (key: string) => Promise<void> | void): RenderElement[] {
  const { Box, Text, Button } = $.ui.resolve(e)
  const button = (c: Control) =>
    Button({
      key: c.key,
      ...(c.hotkey === undefined ? {} : { hotkey: c.hotkey }),
      ...(c.plain === true ? { plain: true as const } : {}),
      ...(c.dim === true ? { dimColor: true } : {}),
      onPress: async () => onPress(c.key),
      children: [Text({ ...(c.color === undefined ? {} : { color: c.color }), children: [c.label] })],
    })
  const hidden = controls.filter(c => c.hidden === true)
  return [...controls.filter(c => c.hidden !== true).map(button), ...(hidden.length > 0 ? [Box({ key: 'views', display: 'none', children: hidden.map(button) })] : [])]
}

/** The replay pane, or undefined while no replay runs. */
export async function renderReplay($: EngineInterface, e: RenderInputOf<'Pane', 'terminal'>): Promise<RenderElement | undefined> {
  const r = replay
  if (r === undefined) return undefined
  return renderStage($, e, r, levelOf(r.level), replayFrame(r), controlsOf(r.scene, r.filter, r.look, r.pausedAt !== undefined, r.isLiveWaiting), [])
}

/** The live pane in look A or B: the agents and the view buttons, the stage, then the caller's rows. */
export async function renderLive($: EngineInterface, e: RenderInputOf<'Pane', 'terminal'>, source: () => LiveSource, extra: RenderElement[]): Promise<RenderElement> {
  live.source = source
  const src = source()
  const controls: Control[] = [...agentControls(src.scene, live.filter, live.look), ...viewControls(live.view, true)]
  return renderStage($, e, live, levelOf(), liveFrame(src), controls, extra)
}

/** The pane closed: the replay stops, nothing animates or paints, and the sky renderer quits; the next open starts them again. */
export async function paneClosed($: EngineInterface) {
  stopReplay()
  live.anim?.cancel()
  live.anim = undefined
  live.settle?.cancel()
  live.settle = undefined
  live.size = undefined
  await quitSidecar($, sky)
}

/** Shows a view: a look in the replay while one plays, else a look or the text list live. */
export function showView($: EngineInterface, view: LiveView) {
  if (replay !== undefined && view !== 'list') replay.look = view
  else {
    live.view = view
    if (view !== 'list') live.look = view
  }
  if (view !== 'B') void pauseSidecar($, sky)
  $.ui.invalidate('ui.render')
}

/** A control-row press: an agent toggles the filter; a view button switches the view; nudge, pause and stop act on the replay. */
async function press($: EngineInterface, key: string) {
  const r = replay
  const s: Stage = r ?? live
  if (key.startsWith('agent-')) {
    const name = key.slice('agent-'.length)
    s.filter = s.filter === name ? undefined : name
    $.ui.invalidate('ui.render')
  } else if (key.startsWith('view-')) showView($, key.slice('view-'.length) as LiveView)
  else if (r === undefined) return
  else if (key === 'live') {
    stopReplay()
    $.ui.invalidate('ui.render')
  }
  else if (key === 'nudge') {
    const target = r.filter === undefined ? 'the claim holders' : r.scene.label(r.filter)
    $.ui.toast(`replay: a nudge would go to ${target}; a replay sends nothing`)
  } else if (key === 'pause') {
    const now = await $.clock.now()
    if (r.pausedAt === undefined) {
      r.pausedAt = now
      r.timer?.cancel()
      r.timer = undefined
    } else {
      r.startReal += now - r.pausedAt
      r.pausedAt = undefined
      void step($)
    }
    $.ui.invalidate('ui.render')
  } else if (key === 'stop') {
    stopReplay()
    $.ui.invalidate('ui.render')
  }
}
