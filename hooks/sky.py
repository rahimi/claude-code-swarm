# The look B sky renderer: paints the whole star map from the scene the mod writes to DIR/scene.json and writes each
# frame as raw RGB to one of three rotating files in DIR (atomic rename), printing
# "frame <path> <generation> <render ms> <width> <height>" for the mod to show.
# The scene is in the picture's pixels: the backdrop's colours, the membrane, edges with their weights, leader lines,
# the lead's rays and beads, the lit edges and comets with their start in the mod's clock, and the agents.
# What does not move is drawn once per scene (the backdrop once per size). A frame is drawn on a scene change and while
# a comet flies or a lit edge fades; idle, nothing is drawn.
# {"pause": true} draws nothing until the next scene. The process exits on {"quit": true}, on SIGTERM, or when
# scene.json has not changed for IDLE_EXIT_S; it then removes its files from DIR. At start it removes frames older
# than STALE_S.
import json, math, os, signal, sys, time

try:
    import numpy as np
except ImportError:
    print('fail numpy missing', flush=True)
    sys.exit(0)

DIR = ''
FPS = 30
RIPPLE_MS = 400
FLARE_MS = 300
IDLE_EXIT_S = 120
STALE_S = 5
YY, XX = np.mgrid[-12:13, -12:13]
SPRITE = (np.clip(1 - np.sqrt(XX ** 2 + YY ** 2) / 12, 0, 1) ** 2)[..., None].astype(np.float32)
WHITE = np.array([255, 255, 255], np.float32)


def clean(all_files):
    now = time.time()
    for name in os.listdir(DIR):
        path = os.path.join(DIR, name)
        if not name.startswith('sky-'):
            continue
        try:
            if all_files or now - os.stat(path).st_mtime > STALE_S:
                os.unlink(path)
        except FileNotFoundError:
            pass


def leave(why='quit'):
    print('bye ' + why, flush=True)
    clean(True)
    try:
        os.unlink(os.path.join(DIR, 'scene.json'))
    except FileNotFoundError:
        pass
    try:
        os.rmdir(DIR)
    except OSError:
        pass
    sys.exit(0)


def rgb(c):
    return np.array(c, np.float32)


def box(f, x0, y0, x1, y1):
    h, w = f.shape[:2]
    return max(0, int(math.floor(x0))), max(0, int(math.floor(y0))), min(w, int(math.ceil(x1)) + 1), min(h, int(math.ceil(y1)) + 1)


def put(f, mask, x0, y0, color, a, additive):
    """Adds or blends `color` at `a` times `mask` over the region of `f` at (x0, y0)."""
    if mask.size == 0:
        return
    reg = f[y0:y0 + mask.shape[0], x0:x0 + mask.shape[1]]
    m = (mask * a)[..., None]
    if additive:
        reg += m * color
    else:
        reg += m * (color - reg)
    np.minimum(reg, 255, out=reg)


masks = {}


def stroke_mask(h, w, pts, r):
    """The pixels a polyline of half-width `r` through `pts` covers, anti-aliased: rows, columns, cover, and how far along
    the line (0 at its first point, 1 at its last) each lies; kept by shape."""
    key = (h, w, r, tuple(pts))
    if key in masks:
        return masks[key]
    xs = [p[0] for p in pts]
    ys = [p[1] for p in pts]
    x0, y0 = max(0, int(min(xs) - r - 1)), max(0, int(min(ys) - r - 1))
    x1, y1 = min(w, int(math.ceil(max(xs) + r + 2))), min(h, int(math.ceil(max(ys) + r + 2)))
    if x1 <= x0 or y1 <= y0:
        empty = (np.zeros(0, np.intp), np.zeros(0, np.intp), np.zeros(0, np.float32), np.zeros(0, np.float32))
        masks[key] = empty
        return empty
    mask = np.zeros((y1 - y0, x1 - x0), np.float32)
    along = np.zeros((y1 - y0, x1 - x0), np.float32)
    n = max(1, len(pts) - 1)
    for i, ((ax, ay), (bx, by)) in enumerate(zip(pts, pts[1:])):
        sx0, sy0 = max(x0, int(min(ax, bx) - r - 1)), max(y0, int(min(ay, by) - r - 1))
        sx1, sy1 = min(x1, int(math.ceil(max(ax, bx) + r + 2))), min(y1, int(math.ceil(max(ay, by) + r + 2)))
        if sx1 <= sx0 or sy1 <= sy0:
            continue
        qy, qx = np.mgrid[sy0:sy1, sx0:sx1].astype(np.float32) + 0.5
        dx, dy = bx - ax, by - ay
        t = np.clip(((qx - ax) * dx + (qy - ay) * dy) / (dx * dx + dy * dy or 1), 0, 1)
        cover = np.clip(r + 0.5 - np.hypot(qx - (ax + dx * t), qy - (ay + dy * t)), 0, 1)
        sub = mask[sy0 - y0:sy1 - y0, sx0 - x0:sx1 - x0]
        sub_along = along[sy0 - y0:sy1 - y0, sx0 - x0:sx1 - x0]
        better = cover > sub
        sub_along[better] = ((i + t) / n)[better]
        np.maximum(sub, cover, out=sub)
    ry, rx = np.nonzero(mask)
    if len(masks) > 512:
        masks.clear()
    masks[key] = (ry + y0, rx + x0, mask[ry, rx], along[ry, rx])
    return masks[key]


def stroke(f, pts, r, color, a, additive=False, upto=1.0):
    """A polyline of half-width `r` through `pts`, anti-aliased, each pixel covered once, drawn `upto` of its length;
    its pixels kept by shape."""
    ys, xs, cover, along = stroke_mask(f.shape[0], f.shape[1], [(round(x, 2), round(y, 2)) for x, y in pts], round(r, 3))
    if upto < 1:
        keep = along <= upto
        ys, xs, cover = ys[keep], xs[keep], cover[keep]
    if cover.size == 0:
        return
    m = (cover * a)[:, None]
    reg = f[ys, xs]
    f[ys, xs] = np.minimum(reg + m * color if additive else reg + m * (color - reg), 255)


def curve_points(a, q, b, upto=1.0):
    steps = max(4, math.ceil(math.hypot(b[0] - a[0], b[1] - a[1]) / 6))
    out = []
    for k in range(steps + 1):
        t = upto * k / steps
        u = 1 - t
        out.append((u * u * a[0] + 2 * u * t * q[0] + t * t * b[0], u * u * a[1] + 2 * u * t * q[1] + t * t * b[1]))
    return out


def disc(f, cx, cy, r, color, a=1.0):
    x0, y0, x1, y1 = box(f, cx - r - 1, cy - r - 1, cx + r + 1, cy + r + 1)
    if x1 <= x0 or y1 <= y0:
        return
    qy, qx = np.mgrid[y0:y1, x0:x1].astype(np.float32) + 0.5
    put(f, np.clip(r + 0.5 - np.hypot(qx - cx, qy - cy), 0, 1), x0, y0, color, a, False)


def circle(f, cx, cy, r, w, color, a=1.0):
    x0, y0, x1, y1 = box(f, cx - r - w - 1, cy - r - w - 1, cx + r + w + 1, cy + r + w + 1)
    if x1 <= x0 or y1 <= y0:
        return
    qy, qx = np.mgrid[y0:y1, x0:x1].astype(np.float32) + 0.5
    put(f, np.clip(w + 0.5 - np.abs(np.hypot(qx - cx, qy - cy) - r), 0, 1), x0, y0, color, a, False)


def glow(f, cx, cy, r, color, a=1.0):
    reach = r * 2.2
    x0, y0, x1, y1 = box(f, cx - reach, cy - reach, cx + reach, cy + reach)
    if x1 <= x0 or y1 <= y0:
        return
    qy, qx = np.mgrid[y0:y1, x0:x1].astype(np.float32) + 0.5
    put(f, np.exp(-((qx - cx) ** 2 + (qy - cy) ** 2) / (r * r)), x0, y0, color, a, True)


backdrops = {}


def backdrop(s):
    """The ground, its central haze and the stars: drawn once per size and centre."""
    key = (s['w'], s['h'], tuple(s['centre']), s['u'])
    if key not in backdrops:
        backdrops.clear()
        w, h, u = s['w'], s['h'], s['u']
        f = np.empty((h, w, 3), np.float32)
        f[:] = rgb(s['ground'])
        cx, cy = s['centre']
        qy, qx = np.mgrid[0:h, 0:w].astype(np.float32) + 0.5
        r = min(w, h) * 0.45
        f += np.exp(-((qx - cx) ** 2 + (qy - cy) ** 2) / (r * r))[..., None] * 0.9 * rgb(s['haze'])
        rs = np.random.default_rng(7)
        for _ in range(int(w * h / (900 * u * u))):
            b = rs.random()
            disc(f, rs.random() * w, rs.random() * h, (0.35 + b * 0.5) * u, rgb(s['ground']) + (rgb(s['star']) - rgb(s['ground'])) * (0.15 + b * 0.45))
        np.minimum(f, 255, out=f)
        backdrops[key] = f
    return backdrops[key]


stills = {}


# A 3 x 5 pixel font for the digits, one row of three bits per number, top row first.
DIGITS = [
    [7, 5, 5, 5, 7], [2, 6, 2, 2, 7], [7, 1, 7, 4, 7], [7, 1, 7, 1, 7], [5, 5, 7, 1, 1],
    [7, 4, 7, 1, 7], [7, 4, 7, 5, 7], [7, 1, 1, 1, 1], [7, 5, 7, 5, 7], [7, 5, 7, 1, 7],
]


def digits(f, text, cx, cy, k, color):
    """Draws a number in the pixel font, centred on (cx, cy), each font pixel k pixels square."""
    h, w = f.shape[:2]
    x0 = cx - (len(text) * 4 - 1) * k / 2
    y0 = cy - 2.5 * k
    for i, ch in enumerate(text):
        for row, bits in enumerate(DIGITS[int(ch)]):
            for col in range(3):
                if bits & (4 >> col):
                    x, y = int(round(x0 + (i * 4 + col) * k)), int(round(y0 + row * k))
                    if 0 <= x and x + k <= w and 0 <= y and y + k <= h:
                        f[y:y + k, x:x + k] = color


def still(s, now):
    """The backdrop with what does not move: the membrane, edges whose first comet has landed, leader lines, rays and beads, and the wake count once the rays are capped."""
    edges = [e for e in s['edges'] if now - e.get('start', -math.inf) >= s['flightMs']]
    key = json.dumps([s['w'], s['h'], s['centre'], s['u'], s['membrane'], edges, s['leaders'], s['rays'], s['beads'], s.get('count', 0)])
    if key not in stills:
        stills.clear()
        f = backdrop(s).copy()
        u = s['u']
        cx, cy = s['centre']
        rm = s['membrane']
        circle(f, cx, cy, rm, 0.7 * u, rgb(s['membraneRgb']), 0.9)
        for e in edges:
            stroke(f, curve_points(e['a'], e['q'], e['b']), (0.5 + 1.6 * e['w']) * u, rgb(e['rgb']), (0.08 + 0.3 * e['w']) * e['lit'], True)
        for l in s['leaders']:
            stroke(f, l['pts'], 0.45 * u, rgb(l['rgb']), 0.35 * l['lit'])
        for i in range(s['rays']):
            a = -math.pi / 2 + i * 2 * math.pi / 24
            stroke(f, [(cx + math.cos(a) * rm * 0.45, cy + math.sin(a) * rm * 0.45), (cx + math.cos(a) * rm * 0.8, cy + math.sin(a) * rm * 0.8)], 0.5 * u, rgb(s['accent']), 0.9)
        for i in range(s['beads']):
            a = -math.pi / 2 + i * 2 * math.pi / 24
            disc(f, cx + math.cos(a) * rm, cy + math.sin(a) * rm, 1.1 * u, rgb(s['dim']))
        if s.get('count'):
            digits(f, str(s['count']), cx, cy + rm * 0.25, max(1, round(1.2 * u)), rgb(s['accent']))
        stills[key] = f
    return stills[key]


def ease(t):
    return 2 * t * t if t < 0.5 else 1 - (-2 * t + 2) ** 2 / 2


def bez(c, t):
    (ax, ay), (qx, qy), (bx, by) = c['a'], c['q'], c['b']
    u = 1 - t
    return u * u * ax + 2 * u * t * qx + t * t * bx, u * u * ay + 2 * u * t * qy + t * t * by


def flown(start, now, flight_ms):
    """How far along its path a line set off at `start` has got: 0 to 1, eased."""
    return ease(min(1.0, max(0.0, (now - start) / flight_ms)))


def arrival(c, flight_ms):
    """When a comet reaches the end of its path (`stop` of the way), in the mod's clock."""
    lo, hi = 0.0, 1.0
    for _ in range(30):
        mid = (lo + hi) / 2
        lo, hi = (mid, hi) if ease(mid) < c['stop'] else (lo, mid)
    return c['start'] + hi * flight_ms


def ripple(c, now, flight_ms):
    """0 to 1: a held comet's ripple on the membrane, full as it hits, gone after RIPPLE_MS."""
    if not c.get('held'):
        return 0.0
    age = now - arrival(c, flight_ms)
    return 0.0 if age < 0 or age >= RIPPLE_MS else 1 - age / RIPPLE_MS


def flare(c, now, flight_ms):
    """0 to 1: the sun's flare as a delivered comet reaches the lead, gone after FLARE_MS."""
    if not c.get('lead') or c.get('held'):
        return 0.0
    age = now - arrival(c, flight_ms)
    return 0.0 if age < 0 or age >= FLARE_MS else 1 - age / FLARE_MS


def stamp(f, x, y, color, a):
    h, w = f.shape[:2]
    x0, y0 = int(x) - 12, int(y) - 12
    sx0, sy0 = max(0, -x0), max(0, -y0)
    sx1, sy1 = min(25, w - x0), min(25, h - y0)
    if sx1 <= sx0 or sy1 <= sy0:
        return
    reg = f[y0 + sy0:y0 + sy1, x0 + sx0:x0 + sx1]
    reg += SPRITE[sy0:sy1, sx0:sx1] * a * (color - reg)


def draw(s, now):
    """One frame: the still picture, the lit edges at their fade, the lead, the agents, the comets."""
    f = still(s, now).copy()
    u, nu = s['u'], s['nu']
    flight = s['flightMs']
    young = [e for e in s['edges'] if now - e.get('start', -math.inf) < flight]
    for e in young:
        stroke(f, curve_points(e['a'], e['q'], e['b']), (0.5 + 1.6 * e['w']) * u, rgb(e['rgb']), (0.08 + 0.3 * e['w']) * e['lit'], True, flown(e['start'], now, flight))
    for l in s['lit']:
        k = 1 - (now - l['start']) / s['litMs']
        if k > 0:
            grown = min(1.0, flown(l['start'], now, flight) / l['stop'])
            stroke(f, curve_points(l['a'], l['q'], l['b'], l['stop']), 1.2 * u, rgb(l['rgb']), 0.3 * k, True, grown)
    cx, cy = s['centre']
    sun = max([flare(c, now, flight) for c in s['comets']] + [0.0])
    glow(f, cx, cy, 9 * nu * (1 + 1.5 * sun), rgb(s['accent']), 0.7 + 0.3 * sun)
    disc(f, cx, cy, 2.6 * nu, WHITE)
    for n in s['nodes']:
        x, y, color, lit, state = n['x'], n['y'], rgb(n['rgb']), n['lit'], n['state']
        if state == 'quiet':
            circle(f, x, y, 3 * nu, 0.5 * nu, rgb(s['rule']))
            continue
        halo = 9 if state == 'running' else 8 if state == 'stalled' else 5
        glow(f, x, y, halo * nu, color, (0.25 if state in ('idle', 'ended') else 0.6) * lit)
        if state == 'waiting':
            for k in range(0, 12, 2):
                a0, a1 = k * math.pi / 6, (k + 1) * math.pi / 6
                stroke(f, [(x + math.cos(a0) * 7 * nu, y + math.sin(a0) * 7 * nu), (x + math.cos(a1) * 7 * nu, y + math.sin(a1) * 7 * nu)], 0.6 * nu, color, lit)
        if state == 'stalled':
            circle(f, x, y, 7 * nu, 0.9 * nu, rgb(s['stalled']), lit)
        if state in ('idle', 'ended'):
            circle(f, x, y, 4 * nu, 0.7 * nu, color, 0.8 * lit)
        else:
            disc(f, x, y, 3 * nu, color + (WHITE - color) * 0.55, lit)
    for c in s['comets']:
        head = min(c['stop'], flown(c['start'], now, flight))
        hit = ripple(c, now, flight)
        landed = c.get('held') and now >= arrival(c, flight)
        if landed and hit == 0:
            continue
        color = rgb(c['rgb'])
        if landed:
            mem = rgb(s['membraneRgb'])
            color = mem + (color - mem) * hit
            x, y = bez(c, head)
            angle = math.atan2(y - cy, x - cx)
            rm = s['membrane']
            spread = 0.12 + 0.3 * (1 - hit)
            arc = [(cx + math.cos(angle + spread * (k / 6 - 1)) * rm, cy + math.sin(angle + spread * (k / 6 - 1)) * rm) for k in range(13)]
            stroke(f, arc, 1.2 * u * (1 + hit), WHITE + (mem - WHITE) * (1 - hit), 0.8 * hit, True)
        for k in range(12, -1, -1):
            tt = head - k * 0.02
            if tt <= 0:
                continue
            x, y = bez(c, tt)
            stamp(f, x, y, color if k or landed else WHITE, (1 - k / 13) * 0.9 * (hit if landed else 1))
    np.clip(f, 0, 255, out=f)
    return f.astype(np.uint8)


def moving(s, now):
    return any(now - c['start'] < s['landMs'] for c in s['comets']) or any(now - l['start'] < s['litMs'] for l in s['lit'])


def main():
    global DIR
    DIR = sys.argv[1]
    scene_path = os.path.join(DIR, 'scene.json')
    os.makedirs(DIR, exist_ok=True)
    clean(False)
    signal.signal(signal.SIGTERM, lambda *_: leave('term'))
    names = [os.path.join(DIR, f'sky-{os.getpid()}-{k}.rgb') for k in range(3)]
    seq, scene, offset, changed_at, dirty, gen = -1, None, 0.0, time.time(), False, 0
    print('ready', flush=True)
    while True:
        tick = time.time()
        try:
            s = json.loads(open(scene_path).read())
            if s.get('quit'):
                leave()
            if s.get('seq', -1) != seq and s.get('pause'):
                seq, scene, changed_at, dirty = s['seq'], None, tick, False
            elif s.get('seq', -1) != seq:
                seq, scene, changed_at, dirty = s['seq'], s, tick, True
                offset = tick * 1000 - s['now']
        except (OSError, ValueError, KeyError):
            pass
        if tick - changed_at > IDLE_EXIT_S:
            leave('idle')
        if scene is not None:
            now = tick * 1000 - offset
            if dirty or moving(scene, now):
                r0 = time.perf_counter()
                buf = draw(scene, now).tobytes()
                gen += 1
                name = names[gen % 3]
                with open(name + '.tmp', 'wb') as fh:
                    fh.write(buf)
                os.replace(name + '.tmp', name)
                dirty = False
                print(f'frame {name} {gen} {(time.perf_counter() - r0) * 1000:.2f} {scene["w"]} {scene["h"]}', flush=True)
        time.sleep(max(0.0, 1 / FPS - (time.time() - tick)))


if __name__ == '__main__':
    try:
        main()
    finally:
        clean(True)
