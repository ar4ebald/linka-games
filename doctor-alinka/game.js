/* Доктор Алинка — game engine (vertical slice)
   Plain JS, no build. Canvas 2D 1600x900 logical, letterboxed, DPR-aware.
   Contract: BRIEF.md (manifest.json format, sfx.js API). */
(() => {
'use strict';

/* ======================================================================
   constants
   ====================================================================== */
const W = 1600, H = 900, TAU = Math.PI * 2;
const CFG = {
  levelTime: 150,
  anesthesia: 25,
  painDecay: 3,            // per second
  flinchReset: 60,
  lives: 3,
  invuln: 1.4,             // seconds of no pain after a flinch
  salivaFill: 36,          // seconds 0 -> 1 (20 s forced a suction break every ~15 s of real play)
  salivaSlow: 0.7,
  waterSaliva: 0.10,       // per second while spraying
  suction: 0.5,            // per second
  flyMin: 25, flyMax: 40, flyLife: 10, flyPain: 10,
  pain: { syringe: 8, scaler: 36, drill: 54, forceps: 25 }, // scaler/drill: brief's per-frame values x 60
  drillTime: 2.2, cureTime: 2,
  // share of levelTime LEFT at the win. A clean human run takes ~70-90 s of 150 s, so the brief's
  // 60% / 75% were unreachable; 3 stars = done in <= 97 s with no flinch, 2 stars = <= 127 s, <= 1 flinch
  stars: { two: { time: 0.15, flinch: 1 }, three: { time: 0.35, flinch: 0 } },
  score: { step: 100, item: 500, fly: 150, flinch: -300, timeBonus: 10 },
  done: { tartar: 0.15, plaque: 0.15, foam: 0.15, dust: 0.15, blood: 0.12 }, // share of alpha mass that may remain (real layers are big)
  alphaThr: 40,
};

const TOOL_ORDER = ['syringe', 'scaler', 'brush', 'water', 'suction', 'tweezers', 'drill', 'filling', 'lamp', 'forceps', 'implant'];
const TOOL_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '-'];
const TOOL_INFO = {
  syringe:  { name: 'Анестезия',  desc: 'Тап по десне, 25 секунд без боли' },
  scaler:   { name: 'Скребок',    desc: 'Соскобли зубной камень у десны' },
  brush:    { name: 'Щётка',      desc: 'Счищает жёлтый налёт, оставляет пену' },
  water:    { name: 'Ирригатор',  desc: 'Смывает пену, пыль и кровь' },
  suction:  { name: 'Слюноотсос', desc: 'Убирает слюну и воду из лужицы' },
  tweezers: { name: 'Пинцет',     desc: 'Схвати еду и вынеси за пределы рта' },
  drill:    { name: 'Бормашина',  desc: 'Держи на кариесе до 100%' },
  filling:  { name: 'Пломба',     desc: 'Тап по чистой рассверленной полости' },
  lamp:     { name: 'Лампа',      desc: 'Держи над пломбой 2 секунды' },
  forceps:  { name: 'Щипцы',      desc: 'Хватай мёртвый зуб, качай и тяни' },
  implant:  { name: 'Новый зуб',  desc: 'Перетащи в чистую лунку' },
};
const PROB = {
  tartar: { name: 'Камень',       steps: ['скребок'] },
  plaque: { name: 'Жёлтый налёт', steps: ['щётка', 'вода'] },
  food:   { name: 'Застряла еда', steps: ['пинцет', 'вынести изо рта'] },
  cavity: { name: 'Кариес',       steps: ['бор', 'вода', 'пломба', 'лампа'] },
  dead:   { name: 'Мёртвый зуб',  steps: ['щипцы', 'вода', 'новый зуб'] },
};
const LINES = {
  start: 'ребзи ,запускаю приём 🤭',
  order: ['пипяо', 'получается я лох'],
  flinch: 'Обожаю эту боль..(нет )',
  fly: 'КТО СГЛАЗИЛ ПРИЗНАВАЙТЕСЬ',
  win: 'УРА ПОБЕДА',
  tip: 'Ходите во время к стоматологу',
};

/* ======================================================================
   tiny utils
   ====================================================================== */
const $ = (s) => document.querySelector(s);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const rand = (a, b) => a + Math.random() * (b - a);
const pick = (a) => a[(Math.random() * a.length) | 0];
const dist = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by);
const smooth = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };
function mulberry(a) { return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function mkc(w, h, read) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h));
  c.x = c.getContext('2d', read ? { willReadFrequently: true } : undefined);
  return c;
}
function pathPoly(c, p) { c.beginPath(); c.moveTo(p[0][0], p[0][1]); for (let i = 1; i < p.length; i++) c.lineTo(p[i][0], p[i][1]); c.closePath(); }
function rrect(c, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath();
}
function pointInPoly(x, y, p) {
  let ins = false;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    const xi = p[i][0], yi = p[i][1], xj = p[j][0], yj = p[j][1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi + 1e-9) + xi) ins = !ins;
  }
  return ins;
}
function polyBB(p) { let a = 1e9, b = 1e9, c = -1e9, d = -1e9; for (const q of p) { a = Math.min(a, q[0]); b = Math.min(b, q[1]); c = Math.max(c, q[0]); d = Math.max(d, q[1]); } return [a, b, c, d]; }
function polyC(p) { let x = 0, y = 0; for (const q of p) { x += q[0]; y += q[1]; } return [x / p.length, y / p.length]; }
function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, l = dx * dx + dy * dy;
  const t = l ? clamp(((px - ax) * dx + (py - ay) * dy) / l, 0, 1) : 0;
  return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
}
function lineDist(px, py, pts) { let m = 1e9; for (let i = 1; i < pts.length; i++) m = Math.min(m, segDist(px, py, pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1])); return m; }
function walkLine(pts, step, cb) {
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = pts[i - 1], [bx, by] = pts[i];
    const l = Math.hypot(bx - ax, by - ay) || 1, nx = -(by - ay) / l, ny = (bx - ax) / l;
    for (let s = 0; s < l; s += step) { const t = s / l; cb(ax + (bx - ax) * t, ay + (by - ay) * t, nx, ny); }
  }
}
function lsGet(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch (e) { return d; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } }
function fmtTime(s) { s = Math.max(0, Math.ceil(s)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); }

function loadImage(src) {
  return new Promise((res) => {
    if (!src || typeof src !== 'string') return res(null);
    const im = new Image();
    im.decoding = 'async';
    im.onload = () => res(im.naturalWidth ? im : null);
    im.onerror = () => res(null);
    im.src = src;
  });
}
async function loadJSON(src) {
  if (!src || typeof src !== 'string') return null;
  try { const r = await fetch(src, { cache: 'no-cache' }); if (!r.ok) return null; return await r.json(); } catch (e) { return null; }
}

/* ======================================================================
   sound wrapper (sfx.js is optional and written elsewhere)
   ====================================================================== */
const TOOL_LOOPS = ['drill', 'scrape', 'brush', 'water', 'suction', 'lamp'];
const S = {
  active: {}, want: {}, lastSet: {}, lastWant: {},
  grace: 0.09, // a loop survives this long without being asked for (pointer events can skip a frame)
  call(fn, ...a) { try { const s = window.SFX; if (s && typeof s[fn] === 'function') return s[fn](...a); } catch (e) { /* never break the game */ } return undefined; },
  duck: 1, // 0.7 while an Alinka speech clip talks
  play(n, o) { this.call('play', n, this.duck < 1 ? { ...(o || {}), volume: ((o && o.volume) || 1) * this.duck } : o); },
  vol(o) { return { ...o, volume: (typeof o.volume === 'number' ? o.volume : 1) * this.duck }; },
  need(n, o) { this.want[n] = o || {}; },
  sync(now) {
    // muted (or paused): don't keep starting and steering silent loops
    if (G.muted || G.quiet) { this.want = {}; for (const n of Object.keys(this.active)) this.stop(n); return; }
    for (const n in this.want) {
      const o = this.want[n];
      this.lastWant[n] = now;
      if (!this.active[n]) { this.call('loop', n, this.vol(o)); this.active[n] = true; this.lastSet[n] = now; }
      else if (now - (this.lastSet[n] || 0) > 0.05) { this.set(n, this.vol(o)); this.lastSet[n] = now; }
    }
    for (const n of Object.keys(this.active)) if (!(n in this.want) && now - (this.lastWant[n] || 0) > this.grace) this.stop(n);
    this.want = {};
  },
  // pointer released / tool changed: tool loops stop right away (the fly keeps buzzing)
  stopTools() { for (const n of TOOL_LOOPS) { delete this.want[n]; this.stop(n); } },
  // SFX.loop() is idempotent (only updates params), so it doubles as "set" and also revives a fading loop
  set(n, o) { this.call('loop', n, o); },
  stop(n) { if (this.active[n]) { delete this.active[n]; delete this.lastWant[n]; this.call('stop', n); } },
  stopAll() { this.want = {}; for (const n of Object.keys(this.active)) this.stop(n); },
  inited: false,
  unlock() {
    if (!window.SFX) return;
    if (!this.inited) { this.inited = true; this.call('init'); this.call('setMuted', G.muted); }
    if (!window.SFX.ready) this.call('unlock'); // already running: nothing to unlock (no throwaway nodes per tap)
  },
};
// first gesture anywhere (title, tray, buttons, keyboard) unlocks audio
for (const ev of ['pointerdown', 'touchstart', 'keydown']) window.addEventListener(ev, () => S.unlock(), { capture: true, passive: true });

/* ======================================================================
   global state
   ====================================================================== */
const G = {
  man: null, pat: null, img: {}, ready: false,
  BW: 1600, BH: 900, u: 1,
  base: null, mouth: null, mouthBB: null, teeth: [], teethJson: false,
  mask: null, maskDil: null, maskA: null, teethPts: [],
  puddle: null, view: { s: 1, ox: 0, oy: 0 },
  screen: 'loading', tool: null, toolSpr: {}, faceImg: {},
  muted: window.SFX && typeof window.SFX.muted === 'boolean' ? window.SFX.muted : lsGet('da.muted', '0') === '1',
  best: parseInt(lsGet('da.best', '0'), 10) || 0,
  k: 1, cs: 1, L: null, time: 0, debug: false, perf: { u: 0, r: 0, dt: 16 },
  paused: false, quiet: false, // paused: portrait overlay (game frozen); quiet: portrait or hidden tab (no sound / video)
  SW: W, cox: 0, ox: 0, oy: 0, // stage logical width (letterbox bars are used by the HUD), canvas x inside it, stage origin in client px
  pool: {}, // level layers are allocated once and reused on restart (iOS caps total canvas memory)
};
const P = { x: -999, y: -999, bx: 0, by: 0, down: false, inside: false, type: 'mouse', id: null, path: [], vx: 0, vy: 0, lt: 0, consumed: false, sx: 0, sy: 0, fx: 0, fy: 0 };

// level-scoped timers: cleared on restart so nothing from the previous run fires into the new one
let timers = [];
function later(fn, ms) { const id = setTimeout(() => { timers = timers.filter((t) => t !== id); fn(); }, ms); timers.push(id); return id; }
function clearTimers() { for (const id of timers) clearTimeout(id); timers = []; }

const stage = $('#stage'), cv = $('#cv'), ctx = cv.getContext('2d');

/* ======================================================================
   layout / resize
   ====================================================================== */
function resize() {
  const vw = window.innerWidth || 1600, vh = window.innerHeight || 900;
  const k = Math.min(vw / W, vh / H);
  G.k = k;
  document.body.classList.toggle('small', k < 0.62);
  try { G.portrait = window.matchMedia('(orientation: portrait) and (max-width: 1024px)').matches; } catch (e) { G.portrait = false; }
  // the stage spans the full window width: the 16:9 canvas stays centred, the HUD docks into the side bars
  const SW = Math.max(W, Math.floor(vw / k));
  G.SW = SW; G.cox = Math.round((SW - W) / 2);
  stage.style.width = SW + 'px';
  cv.style.left = G.cox + 'px';
  const ox = (vw - SW * k) / 2, oy = (vh - H * k) / 2;
  G.ox = ox; G.oy = oy;
  stage.style.transform = `translate(${ox}px,${oy}px) scale(${k})`;
  // backing store: the base photo is ~1456 px wide and drawn at ~1.1x, so more than ~1.5 device px per
  // logical px adds fill cost (4K / 5K screens) but no detail
  const dpr = window.devicePixelRatio || 1, cs = Math.min(k * dpr, 1.5);
  const bw = Math.max(1, Math.round(W * cs)), bh = Math.max(1, Math.round(H * cs));
  if (cv.width !== bw || cv.height !== bh) { cv.width = bw; cv.height = bh; }
  G.cs = cv.width / W;
  updatePaused();
}
// a DPR change with the same CSS size (window dragged to another monitor) fires no resize event
function watchDpr() {
  try {
    const mq = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
    const on = () => { resize(); watchDpr(); };
    if (mq.addEventListener) mq.addEventListener('change', on, { once: true }); else if (mq.addListener) mq.addListener(on);
  } catch (e) { /* ignore */ }
}
// portrait overlay: freeze the game. Portrait or a hidden tab: silence the loops and Alinka's voice
// (a really hidden tab gets no rAF, so the game itself stops there anyway)
function updatePaused() {
  const freeze = !!G.portrait, quiet = freeze || !!document.hidden;
  if (freeze !== G.paused) { G.paused = freeze; if (freeze) cancelPointer(); }
  if (quiet === G.quiet) return;
  G.quiet = quiet;
  if (quiet) { S.stopAll(); Stream.pause(); } else Stream.resume();
}
function computeView() {
  const [x0, y0, x1, y1] = G.mouthBB;
  const mh = y1 - y0, mw = x1 - x0;
  const s = Math.max(W / G.BW, H / G.BH, Math.min(800 / mh, 760 / mw));
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  let ox = 770 - cx * s, oy = 455 - cy * s;
  ox = clamp(ox, W - G.BW * s, 0); oy = clamp(oy, H - G.BH * s, 0);
  G.view = { s, ox, oy };
}
const toBase = (lx, ly) => [(lx - G.view.ox) / G.view.s, (ly - G.view.oy) / G.view.s];
const toLogical = (bx, by) => [bx * G.view.s + G.view.ox, by * G.view.s + G.view.oy];

/* ======================================================================
   patient setup (once per manifest load)
   ====================================================================== */
const FALLBACK_MANIFEST = {
  version: 1, keyart: 'assets/keyart.jpg',
  patients: [{ id: 'p1', title: 'Пациент №1', base: 'assets/p1/base.jpg', size: [1600, 900], problems: [
    { type: 'tartar' }, { type: 'plaque' }, { type: 'food' }, { type: 'cavity' }, { type: 'cavity' }, { type: 'dead' }] }],
  tools: [], fx: {}, alinka: { clips: {} },
};

function approxTeeth(mouth) {
  const [x0, y0, x1, y1] = polyBB(mouth), w = x1 - x0, h = y1 - y0, cx = (x0 + x1) / 2;
  const out = [];
  const mk = (id, jaw, x, y, ang, tw, th) => {
    const poly = [];
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * TAU, ex = Math.cos(a) * tw / 2, ey = Math.sin(a) * th / 2;
      poly.push([x + ex * Math.cos(ang) - ey * Math.sin(ang), y + ex * Math.sin(ang) + ey * Math.cos(ang)]);
    }
    out.push({ id, jaw, poly, c: [x, y] });
  };
  const n = 14;
  const up = [];
  for (let i = 0; i < n; i++) {
    const t = ((i + 0.5) / n) * 2 - 1, th = t * (Math.PI / 2) * 0.92;
    up.push([cx + Math.sin(th) * 0.4 * w, y0 + 0.13 * h + (1 - Math.cos(th)) * 0.42 * h]);
  }
  up.forEach((p, i) => {
    const a = up[Math.max(0, i - 1)], b = up[Math.min(n - 1, i + 1)];
    const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
    const sp = dist(a[0], a[1], b[0], b[1]) / (i === 0 || i === n - 1 ? 1 : 2);
    mk('U' + String(i + 1).padStart(2, '0'), 'upper', p[0], p[1], ang, sp * 0.92, sp * 1.15);
  });
  for (let i = 0; i < n; i++) {
    const t = ((i + 0.5) / n) * 2 - 1;
    const x = cx + t * 0.4 * w, y = y0 + 0.7 * h - t * t * 0.07 * h;
    const sp = (0.8 * w) / n;
    mk('L' + String(i + 1).padStart(2, '0'), 'lower', x, y, -t * 0.25, sp * 0.92, sp * 1.5);
  }
  return out;
}

function proceduralBase(BW, BH, mouth, teeth) {
  const c = mkc(BW, BH), x = c.x;
  const g = x.createRadialGradient(BW / 2, BH / 2, 10, BW / 2, BH / 2, BW * 0.7);
  g.addColorStop(0, '#e9b9a0'); g.addColorStop(1, '#8a5a48');
  x.fillStyle = g; x.fillRect(0, 0, BW, BH);
  x.save(); pathPoly(x, mouth); x.fillStyle = '#b8505a'; x.fill(); x.lineWidth = 18; x.strokeStyle = '#c86a6f'; x.stroke(); x.clip();
  const [mx0, my0, mx1, my1] = polyBB(mouth);
  const g2 = x.createRadialGradient((mx0 + mx1) / 2, (my0 + my1) / 2, 5, (mx0 + mx1) / 2, (my0 + my1) / 2, (mx1 - mx0) * 0.45);
  g2.addColorStop(0, '#3a0d12'); g2.addColorStop(1, 'rgba(160,60,70,0)');
  x.fillStyle = g2; x.fillRect(mx0, my0, mx1 - mx0, my1 - my0);
  for (const t of teeth) {
    const [a, b, cc, d] = polyBB(t.poly);
    const tg = x.createLinearGradient(a, b, cc, d); tg.addColorStop(0, '#fbfaf6'); tg.addColorStop(1, '#d9d3c8');
    pathPoly(x, t.poly); x.fillStyle = tg; x.fill(); x.lineWidth = 1; x.strokeStyle = 'rgba(120,90,80,.45)'; x.stroke();
  }
  x.restore();
  return c;
}

function buildMask() {
  const BW = G.BW, BH = G.BH;
  const m = mkc(BW, BH, true), mx = m.x;
  let ok = false;
  if (G.teethJson) {
    mx.fillStyle = '#fff';
    for (const t of G.teeth) { pathPoly(mx, t.poly); mx.fill(); }
    ok = true;
  } else {
    try {
      const mm = mkc(BW, BH, true); pathPoly(mm.x, G.mouth); mm.x.fillStyle = '#fff'; mm.x.fill();
      const ma = mm.x.getImageData(0, 0, BW, BH).data;
      const d = G.base.x.getImageData(0, 0, BW, BH).data;
      const out = mx.createImageData(BW, BH), o = out.data;
      let n = 0, nm = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (ma[i + 3] < 128) continue;
        nm++;
        const r = d[i], g = d[i + 1], b = d[i + 2];
        const mxv = Math.max(r, g, b), mnv = Math.min(r, g, b), L = (r + g + b) / 3, s = mxv ? (mxv - mnv) / mxv : 0;
        const a = smooth(132, 172, L) * (1 - smooth(0.15, 0.27, s));
        if (a > 0.02) { o[i] = o[i + 1] = o[i + 2] = 255; o[i + 3] = (a * 255) | 0; if (a > 0.5) n++; }
      }
      if (nm > 0 && n > nm * 0.03) { mx.putImageData(out, 0, 0); ok = true; }
    } catch (e) { ok = false; }
  }
  if (!ok) { mx.clearRect(0, 0, BW, BH); mx.fillStyle = '#fff'; for (const t of G.teeth) { pathPoly(mx, t.poly); mx.fill(); } }
  G.mask = m;
  // dilated mask (lets tartar spill a little onto the gum)
  const dm = mkc(BW, BH), r = Math.max(2, Math.round(3 * G.u));
  for (let dy = -r; dy <= r; dy += Math.max(1, r / 2)) for (let dx = -r; dx <= r; dx += Math.max(1, r / 2)) dm.x.drawImage(m, dx, dy);
  G.maskDil = dm;
  try { const md = m.x.getImageData(0, 0, BW, BH).data; const a = new Uint8Array(BW * BH); for (let i = 0; i < a.length; i++) a[i] = md[i * 4 + 3]; G.maskA = a; }
  catch (e) { G.maskA = null; }
  // sample points on teeth (fly landing spots etc)
  G.teethPts = [];
  const st = Math.max(3, Math.round(5 * G.u));
  for (let y = 0; y < BH; y += st) for (let x = 0; x < BW; x += st) if (maskAt(x, y) > 200 && pointInPoly(x, y, G.mouth)) G.teethPts.push([x, y]);
  if (!G.teethPts.length) for (const t of G.teeth) G.teethPts.push(t.c.slice());
  puddleCv = null;
}
function maskAt(x, y) {
  x |= 0; y |= 0;
  if (x < 0 || y < 0 || x >= G.BW || y >= G.BH) return 0;
  if (G.maskA) return G.maskA[y * G.BW + x];
  for (const t of G.teeth) if (pointInPoly(x, y, t.poly)) return 255;
  return 0;
}

async function setupPatient(pat) {
  G.pat = pat;
  const size = Array.isArray(pat.size) && pat.size.length === 2 ? pat.size : null;
  const [baseImg, teethJ0] = await Promise.all([loadImage(pat.base), loadJSON(pat.teeth)]);
  let teethJ = teethJ0;
  G.BW = Math.round(size ? size[0] : baseImg ? baseImg.naturalWidth : 1600);
  G.BH = Math.round(size ? size[1] : baseImg ? baseImg.naturalHeight : 900);
  const BW = G.BW, BH = G.BH;
  G.teethNote = teethJ ? 'teeth.json' : 'approx (no teeth.json)';
  if (teethJ && Array.isArray(teethJ.size) && (Math.abs(teethJ.size[0] - BW) > 2 || Math.abs(teethJ.size[1] - BH) > 2)) {
    G.teethNote = `approx (teeth.json is for ${teethJ.size[0]}x${teethJ.size[1]}, base is ${BW}x${BH})`; teethJ = null;
  }
  // mouth polygon
  let mouth = Array.isArray(pat.mouth) && pat.mouth.length > 2 ? pat.mouth : null;
  if (!mouth && teethJ && Array.isArray(teethJ.mouth) && teethJ.mouth.length > 2) mouth = teethJ.mouth;
  if (!mouth) { mouth = []; for (let i = 0; i < 24; i++) { const a = (i / 24) * TAU; mouth.push([BW / 2 + Math.cos(a) * BW * 0.22, BH * 0.52 + Math.sin(a) * BH * 0.42]); } }
  G.mouth = mouth; G.mouthBB = polyBB(mouth);
  G.u = (G.mouthBB[2] - G.mouthBB[0]) / 350;
  G.sm = Math.max(3, Math.round(4 * G.u)); // progress grid step = 1 px of each layer's small read copy
  // teeth
  G.teethJson = false;
  if (teethJ && Array.isArray(teethJ.teeth) && teethJ.teeth.length) {
    G.teeth = teethJ.teeth.filter((t) => Array.isArray(t.poly) && t.poly.length > 2).map((t) => ({
      id: String(t.id || ''), fdi: t.fdi ? String(t.fdi) : null, jaw: t.jaw || 'upper', poly: t.poly, c: Array.isArray(t.c) ? t.c : polyC(t.poly) }));
    G.teethJson = G.teeth.length > 0;
  }
  if (!G.teethJson) G.teeth = approxTeeth(mouth);
  // base canvas
  // G.base (CPU, readable) is for pixel reads and sprite clipping; the frame draws the decoded <img> (GPU texture)
  if (baseImg) { G.base = mkc(BW, BH, true); G.base.x.drawImage(baseImg, 0, 0, BW, BH); G.baseDraw = baseImg; }
  else { G.base = proceduralBase(BW, BH, mouth, G.teeth); G.baseDraw = null; }
  buildMask();
  // saliva puddle placement
  const [x0, y0, x1, y1] = G.mouthBB;
  const pd = pat.puddle && Array.isArray(pat.puddle.c) ? pat.puddle : { c: [(x0 + x1) / 2, y0 + (y1 - y0) * 0.62], r: [(x1 - x0) * 0.27, (y1 - y0) * 0.06] };
  G.puddle = { c: pd.c, r: Array.isArray(pd.r) ? pd.r : [pd.r || 60, (pd.r || 60) * 0.25] };
  computeView();
  // optional per-problem images
  const want = [];
  for (const p of pat.problems || []) { if (p.layer) want.push(p.layer); if (p.sprite) want.push(p.sprite); if (p.drilled) want.push(p.drilled); if (p.foam) want.push(p.foam); if (p.socket) want.push(p.socket); }
  const face = pat.face || {};
  for (const k of ['calm', 'worried', 'pain', 'cry']) if (face[k]) want.push(face[k]);
  if (pat.saliva) want.push(pat.saliva);
  await loadMany(want);
  // optional realistic saliva layer (base size); its alpha is multiplied by the saliva level
  G.salivaLayer = null;
  const sim = pat.saliva && G.img[pat.saliva];
  if (sim) { G.salivaLayer = poolLayer('saliva'); G.salivaLayer.fromImage(sim); }
  G.faceImg = {};
  for (const k of ['calm', 'worried', 'pain', 'cry']) if (face[k] && G.img[face[k]]) G.faceImg[k] = G.img[face[k]];
}
async function loadMany(list) {
  const uniq = [...new Set(list.filter((s) => typeof s === 'string' && s && !(s in G.img)))];
  const res = await Promise.all(uniq.map(loadImage));
  uniq.forEach((s, i) => { G.img[s] = res[i]; });
}

/* ---------- tooth lookup ---------- */
function toothNear(x, y, jaw, exclude) {
  let best = null, bd = 1e9;
  for (const t of G.teeth) {
    if (exclude && t === exclude) continue;
    if (jaw && t.jaw !== jaw) continue;
    const d = pointInPoly(x, y, t.poly) ? -1 : dist(x, y, t.c[0], t.c[1]);
    if (d < bd) { bd = d; best = t; }
  }
  return best;
}
// exact id first (teeth.json ids run U1..Un left to right), then the FDI-style hint from segment_teeth.py
function toothById(id) { if (!id) return null; id = String(id); return G.teeth.find((t) => t.id === id) || G.teeth.find((t) => t.fdi === id) || null; }
function mouthC() { const b = G.mouthBB; return [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2]; }
function upperFront(nth) { // nth upper tooth closest to the top centre
  const [cx] = mouthC();
  const up = G.teeth.filter((t) => t.jaw === 'upper').sort((a, b) => Math.abs(a.c[0] - cx) - Math.abs(b.c[0] - cx));
  return up[nth] || G.teeth[0];
}

/* ======================================================================
   brushes / stamps (pre-rendered sprites)
   ====================================================================== */
const SPR = {};
function makeSprites() {
  const soft = mkc(64, 64), s = soft.x, g = s.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(0,0,0,1)'); g.addColorStop(0.55, 'rgba(0,0,0,.7)'); g.addColorStop(1, 'rgba(0,0,0,0)');
  s.fillStyle = g; s.fillRect(0, 0, 64, 64); SPR.soft = soft;

  const R = mulberry(7);
  const foam = mkc(64, 64), f = foam.x;
  for (let i = 0; i < 16; i++) {
    const a = R() * TAU, rr = R() * 20, x = 32 + Math.cos(a) * rr, y = 32 + Math.sin(a) * rr, r = 2.5 + R() * 6;
    const bg = f.createRadialGradient(x - r * 0.3, y - r * 0.3, 0, x, y, r);
    bg.addColorStop(0, 'rgba(255,255,255,.98)'); bg.addColorStop(0.75, 'rgba(244,248,252,.9)'); bg.addColorStop(1, 'rgba(205,215,228,.75)');
    f.fillStyle = bg; f.beginPath(); f.arc(x, y, r, 0, TAU); f.fill();
  }
  SPR.foam = foam;

  const dust = mkc(64, 64), d = dust.x, dg = d.createRadialGradient(32, 32, 0, 32, 32, 30);
  dg.addColorStop(0, 'rgba(238,234,226,.95)'); dg.addColorStop(0.6, 'rgba(225,220,210,.6)'); dg.addColorStop(1, 'rgba(220,215,205,0)');
  d.fillStyle = dg; d.fillRect(0, 0, 64, 64);
  for (let i = 0; i < 70; i++) { const a = R() * TAU, rr = R() * 24; d.fillStyle = R() < 0.5 ? 'rgba(170,160,150,.7)' : 'rgba(255,255,255,.9)'; d.fillRect(32 + Math.cos(a) * rr, 32 + Math.sin(a) * rr, 1.5, 1.5); }
  SPR.dust = dust;

  const blood = mkc(64, 64), b = blood.x, bgr = b.createRadialGradient(30, 30, 0, 32, 32, 31);
  bgr.addColorStop(0, 'rgba(70,0,8,1)'); bgr.addColorStop(0.55, 'rgba(128,8,20,.95)'); bgr.addColorStop(0.85, 'rgba(150,18,28,.7)'); bgr.addColorStop(1, 'rgba(150,20,30,0)');
  b.fillStyle = bgr; b.fillRect(0, 0, 64, 64);
  b.fillStyle = 'rgba(255,190,190,.35)'; b.beginPath(); b.ellipse(24, 22, 7, 4, -0.6, 0, TAU); b.fill();
  SPR.blood = blood;
}
function grow(layer, x0, y0, x1, y1) {
  const b = layer.bb;
  if (layer.empty) { layer.bb = [x0, y0, x1, y1]; layer.empty = false; }
  else layer.bb = [Math.min(b[0], x0), Math.min(b[1], y0), Math.max(b[2], x1), Math.max(b[3], y1)];
}
/* Every layer keeps a coarse "shadow" of its alpha: one value per G.sm x G.sm cell (the progress grid).
   The drawing helpers below update it alongside the pixels with the same brush profile, so progress and
   "is there crust under the tool" never read pixels back from the (GPU) layer canvases. */
const PROF = {
  soft: (t) => (t < 0.55 ? 1 - 0.3 * (t / 0.55) : 0.7 * (1 - (t - 0.55) / 0.45)), // SPR.soft
  foam: (t) => 0.9 * (t < 0.75 ? 1 : (1 - t) / 0.25),
  dust: (t) => (t < 0.6 ? 0.95 - 0.35 * (t / 0.6) : 0.6 * Math.max(0, 1 - (t - 0.6) / 0.34)),
  blood: (t) => (t < 0.55 ? 1 - 0.05 * (t / 0.55) : t < 0.85 ? 0.95 - 0.25 * ((t - 0.55) / 0.3) : 0.7 * (1 - (t - 0.85) / 0.15)),
  wipe: (t) => (t < 0.8 ? 1 : (1 - t) / 0.2),
};
// visit grid cells whose centre lies inside the ellipse (x,y,rx,ry); cb(index, normalised distance)
function cells(layer, x, y, rx, ry, cb) {
  const s = G.sm, w = layer.sw, h = layer.sh;
  const i0 = Math.max(0, Math.floor((x - rx) / s - 0.5)), i1 = Math.min(w - 1, Math.ceil((x + rx) / s - 0.5));
  const j0 = Math.max(0, Math.floor((y - ry) / s - 0.5)), j1 = Math.min(h - 1, Math.ceil((y + ry) / s - 0.5));
  for (let j = j0; j <= j1; j++) {
    const dy = ((j + 0.5) * s - y) / ry;
    for (let i = i0; i <= i1; i++) { const dx = ((i + 0.5) * s - x) / rx, t = Math.sqrt(dx * dx + dy * dy); if (t < 1) cb(j * w + i, t); }
  }
}
function stamp(layer, spr, x, y, r, a, rot) {
  const c = layer.c.x;
  c.save(); c.globalAlpha = a;
  if (rot) { c.translate(x, y); c.rotate(rot); c.drawImage(spr, -r, -r, r * 2, r * 2); }
  else c.drawImage(spr, x - r, y - r, r * 2, r * 2);
  c.restore();
  const pf = spr === SPR.foam ? PROF.foam : spr === SPR.dust ? PROF.dust : spr === SPR.blood ? PROF.blood : PROF.soft, g = layer.g;
  cells(layer, x, y, r, r, (i, t) => { g[i] += (255 - g[i]) * a * pf(t); });
  grow(layer, x - r, y - r, x + r, y + r);
  layer.ver++;
}
// reveal a full-size picture (e.g. foam.png) through the soft brush
let stampTmp = null;
function stampImage(layer, img, x, y, r, a) {
  const d = Math.ceil(r * 2);
  if (!stampTmp || stampTmp.width < d) stampTmp = mkc(d, d);
  const t = stampTmp.x; t.globalCompositeOperation = 'source-over'; t.clearRect(0, 0, stampTmp.width, stampTmp.height);
  t.drawImage(SPR.soft, 0, 0, d, d);
  t.globalCompositeOperation = 'source-in';
  const sx = img.naturalWidth / G.BW, sy = img.naturalHeight / G.BH;
  t.drawImage(img, (x - r) * sx, (y - r) * sy, d * sx, d * sy, 0, 0, d, d);
  const c = layer.c.x; c.save(); c.globalAlpha = a; c.drawImage(stampTmp, 0, 0, d, d, x - r, y - r, d, d); c.restore();
  const ia = imgAlpha(img), g = layer.g;
  cells(layer, x, y, r, r, (i, tt) => { g[i] += (255 - g[i]) * a * PROF.soft(tt) * (ia ? ia[i] / 255 : 1); });
  grow(layer, x - r, y - r, x + r, y + r); layer.ver++;
}
function erase(layer, x, y, r, a) {
  if (!layer || layer.empty) return;
  const b = layer.bb;
  if (x + r < b[0] || x - r > b[2] || y + r < b[1] || y - r > b[3]) return;
  a = clamp(a, 0, 1);
  const c = layer.c.x;
  c.save(); c.globalCompositeOperation = 'destination-out'; c.globalAlpha = a;
  c.drawImage(SPR.soft, x - r, y - r, r * 2, r * 2); c.restore();
  const g = layer.g;
  cells(layer, x, y, r, r, (i, t) => { g[i] *= 1 - a * PROF.soft(t); });
  layer.ver++;
}
// alpha (0..255) under a point, from the layer's shadow grid
function alphaAt(layer, x, y) {
  if (!layer || layer.empty) return 0;
  return layer.g[layer.si(x, y)] || 0;
}
// a picture's alpha on the progress grid, read once from the decoded image (CPU, no GPU readback)
const IMGA = {};
function imgAlpha(img) {
  const key = img.src + '|' + G.BW + 'x' + G.BH + '|' + G.sm;
  if (key in IMGA) return IMGA[key];
  let out = null;
  try {
    const w = Math.ceil(G.BW / G.sm), h = Math.ceil(G.BH / G.sm), c = mkc(w, h, true);
    c.x.imageSmoothingEnabled = true; c.x.imageSmoothingQuality = 'medium';
    c.x.drawImage(img, 0, 0, img.naturalWidth, img.naturalHeight, 0, 0, G.BW / G.sm, G.BH / G.sm);
    const d = c.x.getImageData(0, 0, w, h).data; out = new Uint8Array(w * h);
    for (let i = 0; i < out.length; i++) out[i] = d[i * 4 + 3];
    c.width = c.height = 0;
  } catch (e) { out = null; }
  IMGA[key] = out;
  return out;
}

/* ======================================================================
   layers & regions
   ====================================================================== */
/* Layers are full base-size canvases kept GPU-backed (drawn every frame, never read every frame).
   layer.g is the alpha shadow on the progress grid (see cells()); sync() re-reads it from the pixels
   through a tiny downscaled copy and is used only for one-off drawings (procedural crust, fresh blood). */
class Layer {
  constructor() { this.c = mkc(G.BW, G.BH); this.bb = [0, 0, 0, 0]; this.empty = true; this.ver = 0; this.alpha = 1; this.fade = false; this.g = new Float32Array(this.sw * this.sh); }
  clear() { this.c.x.globalCompositeOperation = 'source-over'; this.c.x.clearRect(0, 0, G.BW, G.BH); this.g.fill(0); this.bb = [0, 0, 0, 0]; this.empty = true; this.alpha = 1; this.fade = false; this.ver++; }
  fromImage(img) {
    this.clear();
    this.c.x.drawImage(img, 0, 0, G.BW, G.BH); this.bb = [0, 0, G.BW, G.BH]; this.empty = false; this.ver++;
    const ia = imgAlpha(img);
    if (ia) this.g.set(ia); else this.sync();
    // the tight box is a property of the picture: computed once, reused on every restart
    const key = img.src + '|' + G.BW + 'x' + G.BH;
    if (!TIGHT[key]) TIGHT[key] = this.tightBB() || 'none';
    const tb = TIGHT[key];
    if (tb === 'none') this.empty = true; else this.bb = tb.slice();
  }
  get sw() { return Math.ceil(G.BW / G.sm); }
  get sh() { return Math.ceil(G.BH / G.sm); }
  si(x, y) { const sx = clamp((x / G.sm) | 0, 0, this.sw - 1), sy = clamp((y / G.sm) | 0, 0, this.sh - 1); return sy * this.sw + sx; }
  sync() {
    const w = this.sw, h = this.sh;
    try {
      const g = mkc(w, h), r = mkc(w, h, true);
      g.x.imageSmoothingEnabled = true; g.x.imageSmoothingQuality = 'medium';
      g.x.drawImage(this.c, 0, 0, G.BW, G.BH, 0, 0, G.BW / G.sm, G.BH / G.sm);
      r.x.drawImage(g, 0, 0);
      const d = r.x.getImageData(0, 0, w, h).data;
      for (let i = 0; i < this.g.length; i++) this.g[i] = d[i * 4 + 3];
      g.width = g.height = r.width = r.height = 0;
    } catch (e) { /* keep the old shadow */ }
    this.ver++;
  }
  // zero the shadow inside a polygon (its pixels were cut out with destination-out)
  cutPoly(poly) {
    const [x0, y0, x1, y1] = polyBB(poly), s = G.sm;
    for (let j = Math.max(0, Math.floor(y0 / s)); j <= Math.min(this.sh - 1, Math.ceil(y1 / s)); j++)
      for (let i = Math.max(0, Math.floor(x0 / s)); i <= Math.min(this.sw - 1, Math.ceil(x1 / s)); i++)
        if (pointInPoly((i + 0.5) * s, (j + 0.5) * s, poly)) this.g[j * this.sw + i] = 0;
    this.ver++;
  }
  tightBB() {
    const w = this.sw, h = this.sh, s = G.sm, d = this.g; let a = 1e9, b = 1e9, c = -1, e = -1;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (d[y * w + x] > 2) { if (x < a) a = x; if (x > c) c = x; if (y < b) b = y; if (y > e) e = y; }
    if (c < 0) return null;
    return [Math.max(0, (a - 1) * s), Math.max(0, (b - 1) * s), Math.min(G.BW, (c + 2) * s), Math.min(G.BH, (e + 2) * s)];
  }
  draw(c) {
    if (this.empty || this.alpha <= 0) return;
    const [x0, y0, x1, y1] = this.bb;
    const a = Math.max(0, Math.floor(x0)), b = Math.max(0, Math.floor(y0)), w = Math.min(G.BW, Math.ceil(x1)) - a, h = Math.min(G.BH, Math.ceil(y1)) - b;
    if (w <= 0 || h <= 0) return;
    if (this.alpha < 1) { c.save(); c.globalAlpha = this.alpha; c.drawImage(this.c, a, b, w, h, a, b, w, h); c.restore(); }
    else c.drawImage(this.c, a, b, w, h, a, b, w, h);
  }
}
const TIGHT = {};
// one Layer per slot for the whole session: a restart clears and redraws instead of allocating 5 MB canvases
function poolLayer(key) {
  let l = G.pool[key];
  if (!l || l.c.width !== G.BW || l.c.height !== G.BH || l.g.length !== l.sw * l.sh) { if (l) { l.c.width = l.c.height = 0; } l = G.pool[key] = new Layer(); }
  else l.clear();
  return l;
}
/* Progress of a problem = alpha "mass" on the sample grid (sum of the shadow alpha over the grid cells,
   so faint leftovers count proportionally).
   emptyDone: a region that starts with nothing in it counts as finished (dust / blood / foam washes);
   otherwise (tartar / plaque) it counts as untouched, never as auto-solved. */
class Region {
  constructor(layer, bb, step, test, emptyDone) {
    this.layer = layer; this.emptyDone = !!emptyDone;
    const x0 = Math.max(0, Math.floor(bb[0])), y0 = Math.max(0, Math.floor(bb[1])), x1 = Math.min(G.BW - 1, Math.ceil(bb[2])), y1 = Math.min(G.BH - 1, Math.ceil(bb[3]));
    const cand = [];
    for (let y = y0; y <= y1; y += step) for (let x = x0; x <= x1; x += step) if (!test || test(x, y)) cand.push(x, y);
    this.cand = cand; this.pts = cand; this.idx = null; this.init = 0; this.cur = 0; this.ver = -1;
    this.calcBB();
  }
  calcBB() {
    let a = 1e9, b = 1e9, c = -1, d = -1;
    for (let i = 0; i < this.pts.length; i += 2) { const x = this.pts[i], y = this.pts[i + 1]; if (x < a) a = x; if (x > c) c = x; if (y < b) b = y; if (y > d) d = y; }
    this.bb = c < 0 ? null : [a, b, c - a + 1, d - b + 1];
  }
  setInitial() {
    this.pts = this.cand;
    const d = this.layer.empty ? null : this.layer.g, keep = [], idx = [];
    let mass = 0;
    if (d) for (let i = 0; i < this.pts.length; i += 2) {
      const x = this.pts[i], y = this.pts[i + 1], k = this.layer.si(x, y), a = d[k];
      if (a > CFG.alphaThr) { keep.push(x, y); idx.push(k); mass += a; }
    }
    this.pts = keep; this.idx = idx; this.calcBB(); this.init = this.cur = mass; this.ver = this.layer.ver;
  }
  measure() {
    if (!this.init) { this.cur = 0; return; }
    if (this.layer.ver === this.ver) return;
    this.ver = this.layer.ver;
    if (this.layer.empty) { this.cur = 0; return; }
    const d = this.layer.g;
    let n = 0;
    for (const k of this.idx) { const a = d[k]; if (a > 12) n += a; }
    this.cur = n;
  }
  get frac() { return this.init ? this.cur / this.init : this.emptyDone ? 0 : 1; }
}

/* ======================================================================
   procedural generators
   ====================================================================== */
function maskLayer(layer, dil) { const c = layer.c.x; c.save(); c.globalCompositeOperation = 'destination-in'; c.drawImage(dil ? G.maskDil : G.mask, 0, 0); c.restore(); }

function genTartar(layer, bands, seed) {
  const c = layer.c.x, R = mulberry(seed), u = G.u;
  let bb = [1e9, 1e9, -1e9, -1e9];
  c.lineCap = 'round'; c.lineJoin = 'round';
  const line = (pts) => { c.beginPath(); pts.forEach((p, j) => (j ? c.lineTo(p[0], p[1]) : c.moveTo(p[0], p[1]))); c.stroke(); };
  for (const band of bands) {
    const w = band.w;
    // continuous chalky crust
    c.lineWidth = w * 0.85; c.strokeStyle = 'rgba(200,168,112,.92)'; line(band.pts);
    c.lineWidth = w * 0.5; c.strokeStyle = 'rgba(170,132,84,.5)'; line(band.pts);
    // lumpy contour
    walkLine(band.pts, 1.3 * u, (x, y, nx, ny) => {
      for (const sd of [-1, 1]) {
        const off = sd * w * (0.3 + R() * 0.25), r = w * (0.07 + R() * 0.13);
        c.fillStyle = R() < 0.7 ? 'rgba(200,168,112,.9)' : 'rgba(178,144,94,.9)';
        c.beginPath(); c.arc(x + nx * off, y + ny * off, r, 0, TAU); c.fill();
      }
    });
    // stains
    walkLine(band.pts, 7 * u, (x, y, nx, ny) => {
      const off = (R() - 0.5) * w * 0.6, r = w * (0.2 + R() * 0.25), px = x + nx * off, py = y + ny * off;
      const g = c.createRadialGradient(px, py, 0, px, py, r);
      g.addColorStop(0, `rgba(${110 + R() * 30},${82 + R() * 20},${46 + R() * 14},.45)`); g.addColorStop(1, 'rgba(120,90,50,0)');
      c.fillStyle = g; c.beginPath(); c.arc(px, py, r, 0, TAU); c.fill();
    });
    // grain
    walkLine(band.pts, 0.6 * u, (x, y, nx, ny) => {
      const off = (R() - 0.5) * w * 0.95, sz = (0.5 + R() * 1.1) * u;
      c.fillStyle = R() < 0.55 ? `rgba(96,72,44,${0.25 + R() * 0.35})` : `rgba(232,220,190,${0.2 + R() * 0.3})`;
      c.fillRect(x + nx * off + (R() - 0.5) * u, y + ny * off, sz, sz);
    });
    for (const p of band.pts) bb = [Math.min(bb[0], p[0] - w), Math.min(bb[1], p[1] - w), Math.max(bb[2], p[0] + w), Math.max(bb[3], p[1] + w)];
  }
  maskLayer(layer, true);
  layer.bb = [bb[0] - 2, bb[1] - 2, bb[2] + 2, bb[3] + 2]; layer.empty = false; layer.ver++;
}
function genPlaque(layer, bands, seed) {
  const c = layer.c.x, R = mulberry(seed), u = G.u;
  let bb = [1e9, 1e9, -1e9, -1e9];
  c.lineCap = 'round'; c.lineJoin = 'round';
  for (const band of bands) {
    const w = band.w;
    for (let i = 0; i < 5; i++) {
      c.lineWidth = w * (1 - i * 0.16); c.strokeStyle = 'rgba(212,182,78,.17)';
      c.beginPath(); band.pts.forEach((p, j) => (j ? c.lineTo(p[0], p[1]) : c.moveTo(p[0], p[1]))); c.stroke();
    }
    walkLine(band.pts, 4 * u, (x, y, nx, ny) => {
      const off = (R() - 0.5) * w * 0.8, r = w * (0.12 + R() * 0.2), px = x + nx * off, py = y + ny * off;
      const g = c.createRadialGradient(px, py, 0, px, py, r);
      g.addColorStop(0, R() < 0.6 ? 'rgba(190,150,50,.22)' : 'rgba(150,130,60,.18)'); g.addColorStop(1, 'rgba(190,150,50,0)');
      c.fillStyle = g; c.beginPath(); c.arc(px, py, r, 0, TAU); c.fill();
    });
    walkLine(band.pts, 0.8 * u, (x, y, nx, ny) => {
      const off = (R() - 0.5) * w; c.fillStyle = `rgba(170,140,50,${0.1 + R() * 0.15})`;
      c.fillRect(x + nx * off, y + ny * off, (0.6 + R()) * u, (0.6 + R()) * u);
    });
    for (const p of band.pts) bb = [Math.min(bb[0], p[0] - w), Math.min(bb[1], p[1] - w), Math.max(bb[2], p[0] + w), Math.max(bb[3], p[1] + w)];
  }
  maskLayer(layer, false);
  layer.bb = bb; layer.empty = false; layer.ver++;
}
function genCavity(layer, x, y, r, seed) {
  const c = layer.c.x, R = mulberry(seed);
  const halo = c.createRadialGradient(x, y, r * 0.3, x, y, r * 1.7);
  halo.addColorStop(0, 'rgba(120,78,34,.85)'); halo.addColorStop(0.55, 'rgba(140,96,44,.5)'); halo.addColorStop(1, 'rgba(160,120,60,0)');
  c.fillStyle = halo; c.beginPath(); c.arc(x, y, r * 1.7, 0, TAU); c.fill();
  for (let i = 0; i < 6; i++) {
    const a = R() * TAU, d = R() * r * 0.45, rr = r * (0.35 + R() * 0.35), px = x + Math.cos(a) * d, py = y + Math.sin(a) * d;
    const g = c.createRadialGradient(px, py, 0, px, py, rr);
    g.addColorStop(0, 'rgba(18,10,5,1)'); g.addColorStop(0.6, 'rgba(48,28,12,.95)'); g.addColorStop(1, 'rgba(80,50,22,0)');
    c.fillStyle = g; c.beginPath(); c.arc(px, py, rr, 0, TAU); c.fill();
  }
  c.strokeStyle = 'rgba(40,24,10,.7)'; c.lineWidth = Math.max(0.8, r * 0.07);
  for (let i = 0; i < 4; i++) {
    const a = R() * TAU; c.beginPath(); c.moveTo(x + Math.cos(a) * r * 0.4, y + Math.sin(a) * r * 0.4);
    c.quadraticCurveTo(x + Math.cos(a + 0.3) * r * 0.9, y + Math.sin(a + 0.3) * r * 0.9, x + Math.cos(a + 0.1) * r * 1.35, y + Math.sin(a + 0.1) * r * 1.35); c.stroke();
  }
  maskLayer(layer, true);
  layer.bb = [x - r * 1.8, y - r * 1.8, x + r * 1.8, y + r * 1.8]; layer.empty = false; layer.ver++;
}
function genFood(w, h, seed) {
  const S3 = 3, c = mkc(w * S3, h * S3), x = c.x, R = mulberry(seed);
  x.scale(S3, S3);
  const cx = w / 2, cy = h / 2;
  const pts = [];
  for (let i = 0; i < 40; i++) {
    const a = (i / 40) * TAU, wob = 1 + 0.07 * Math.sin(a * 5 + 1.3) + 0.05 * Math.sin(a * 11) + (R() - 0.5) * 0.1;
    pts.push([cx + Math.cos(a) * w * 0.46 * wob, cy + Math.sin(a) * h * 0.44 * wob]);
  }
  const g = x.createRadialGradient(cx - w * 0.15, cy - h * 0.15, 1, cx, cy, w * 0.55);
  g.addColorStop(0, '#d4f08a'); g.addColorStop(0.5, '#93c94e'); g.addColorStop(1, '#4c8a2a');
  x.save(); x.shadowColor = 'rgba(0,0,0,.35)'; x.shadowBlur = 3; x.shadowOffsetY = 1.2;
  pathPoly(x, pts); x.fillStyle = g; x.fill(); x.restore();
  x.lineWidth = 0.7; x.strokeStyle = 'rgba(50,90,25,.8)'; pathPoly(x, pts); x.stroke();
  // ruffles
  x.strokeStyle = 'rgba(60,110,30,.45)'; x.lineWidth = 0.5;
  for (let i = 0; i < 12; i++) { const a = R() * TAU; x.beginPath(); x.arc(cx + Math.cos(a) * w * 0.3, cy + Math.sin(a) * h * 0.3, w * 0.12, a, a + 1.6); x.stroke(); }
  // veins
  x.strokeStyle = 'rgba(235,250,200,.75)'; x.lineWidth = 0.9;
  x.beginPath(); x.moveTo(cx - w * 0.36, cy + h * 0.25); x.quadraticCurveTo(cx, cy, cx + w * 0.38, cy - h * 0.28); x.stroke();
  x.lineWidth = 0.5;
  for (let i = 0; i < 5; i++) { const t = 0.2 + i * 0.15, px = lerp(cx - w * 0.36, cx + w * 0.38, t), py = lerp(cy + h * 0.25, cy - h * 0.28, t); x.beginPath(); x.moveTo(px, py); x.lineTo(px + (i % 2 ? 1 : -1) * w * 0.16, py - h * 0.18); x.stroke(); }
  x.fillStyle = 'rgba(255,255,255,.35)'; x.beginPath(); x.ellipse(cx - w * 0.12, cy - h * 0.16, w * 0.12, h * 0.06, -0.5, 0, TAU); x.fill();
  return c;
}

/* ---------- dead tooth / socket / implant ---------- */
function clipSprite(poly, src, pad, flip) {
  const [x0, y0, x1, y1] = polyBB(poly);
  const ox = Math.floor(x0 - pad), oy = Math.floor(y0 - pad), w = Math.ceil(x1 - x0 + pad * 2), h = Math.ceil(y1 - y0 + pad * 2);
  const c = mkc(w, h), x = c.x;
  x.save(); x.translate(-ox, -oy); pathPoly(x, poly); x.clip(); x.drawImage(src, 0, 0); x.restore();
  if (flip) { const f = mkc(w, h); f.x.translate(w, 0); f.x.scale(-1, 1); f.x.drawImage(c, 0, 0); return { c: f, ox, oy, w, h }; }
  return { c, ox, oy, w, h };
}
function makeDeadSprite(D, layerImg) {
  const spr = clipSprite(D.poly, G.base, 3, false);
  const x = spr.c.x;
  if (layerImg) { // real dead.png layer: composite it over the clip
    x.save(); x.translate(-spr.ox, -spr.oy); pathPoly(x, D.poly); x.clip(); x.drawImage(layerImg, 0, 0, G.BW, G.BH); x.restore();
  } else {
    const clip = clipSprite(D.poly, G.base, 3, false).c;
    x.save();
    x.globalCompositeOperation = 'multiply'; x.fillStyle = 'rgb(158,138,112)'; x.fillRect(0, 0, spr.w, spr.h);
    x.globalCompositeOperation = 'source-atop';
    const [rx, ry] = [D.root[0] - spr.ox, D.root[1] - spr.oy], [ix, iy] = [D.tip[0] - spr.ox, D.tip[1] - spr.oy];
    const g = x.createLinearGradient(rx, ry, ix, iy);
    g.addColorStop(0, 'rgba(72,52,38,.55)'); g.addColorStop(0.45, 'rgba(104,92,80,.22)'); g.addColorStop(1, 'rgba(130,128,124,.1)');
    x.fillStyle = g; x.fillRect(0, 0, spr.w, spr.h);
    x.fillStyle = 'rgba(104,106,118,.16)'; x.fillRect(0, 0, spr.w, spr.h);
    x.globalCompositeOperation = 'soft-light'; x.globalAlpha = 0.55; x.drawImage(clip, 0, 0); x.globalAlpha = 1;
    x.globalCompositeOperation = 'source-atop';
    const hg = x.createRadialGradient(spr.w * 0.38, spr.h * 0.4, 0, spr.w * 0.38, spr.h * 0.4, spr.w * 0.35);
    hg.addColorStop(0, 'rgba(255,250,240,.28)'); hg.addColorStop(1, 'rgba(255,250,240,0)');
    x.fillStyle = hg; x.fillRect(0, 0, spr.w, spr.h);
    const R = mulberry(31);
    for (let i = 0; i < 7; i++) { x.fillStyle = `rgba(70,50,36,${0.08 + R() * 0.12})`; x.beginPath(); x.ellipse(R() * spr.w, R() * spr.h, (1 + R() * 2.4) * G.u, (0.6 + R()) * G.u, R() * 3, 0, TAU); x.fill(); }
    x.restore();
  }
  x.save(); x.globalCompositeOperation = 'destination-in'; x.translate(-spr.ox, -spr.oy); pathPoly(x, D.poly); x.fillStyle = '#000'; x.fill(); x.restore();
  return spr;
}
// per-problem socket picture first (manifest problems[].socket), then the shared fx.socket
function socketImg(D) { return (D.src && D.src.socket && G.img[D.src.socket]) || (G.man.fx && G.img[G.man.fx.socket]) || null; }
function makeSocket(D) {
  const [x0, y0, x1, y1] = polyBB(D.poly), pad = 4 * G.u;
  const ox = Math.floor(x0 - pad), oy = Math.floor(y0 - pad), w = Math.ceil(x1 - x0 + pad * 2), h = Math.ceil(y1 - y0 + pad * 2);
  const c = mkc(w, h), x = c.x;
  x.translate(-ox, -oy);
  const simg = socketImg(D);
  if (simg) { // optional socket picture: full-size layer (base pixels) or a sprite stretched into the tooth box
    // mask = tooth outline grown by `pad` with a soft edge, so the torn gum rim of the picture survives
    x.save(); x.filter = `blur(${Math.max(1, pad * 0.35).toFixed(1)}px)`; pathPoly(x, D.poly); x.fillStyle = '#000'; x.fill();
    x.lineJoin = 'round'; x.lineWidth = pad * 1.6; x.strokeStyle = '#000'; x.stroke(); x.restore();
    x.save(); x.globalCompositeOperation = 'source-in';
    if (Math.abs(simg.naturalWidth / simg.naturalHeight - G.BW / G.BH) < 0.02 && simg.naturalWidth >= G.BW * 0.5) x.drawImage(simg, 0, 0, G.BW, G.BH);
    else x.drawImage(simg, x0 - pad, y0 - pad, x1 - x0 + pad * 2, y1 - y0 + pad * 2);
    x.restore();
    // where the picture has no pixels, fall through to a dark procedural hole inside the outline
    x.save(); x.globalCompositeOperation = 'destination-over'; pathPoly(x, D.poly); x.fillStyle = '#5a0b12'; x.fill(); x.restore();
    return { c, ox, oy };
  }
  pathPoly(x, D.poly);
  const g = x.createRadialGradient(D.root[0], D.root[1], 1, D.c[0], D.c[1], Math.max(x1 - x0, y1 - y0) * 0.75);
  g.addColorStop(0, '#1b0204'); g.addColorStop(0.35, '#4a070d'); g.addColorStop(0.75, '#8c1c25'); g.addColorStop(1, '#b8505a');
  x.fillStyle = g; x.fill();
  x.save(); x.clip();
  const hx = lerp(D.root[0], D.c[0], 0.35), hy = lerp(D.root[1], D.c[1], 0.35), hr = Math.min(x1 - x0, y1 - y0) * 0.28;
  const hg = x.createRadialGradient(hx, hy, 0, hx, hy, hr * 1.6);
  hg.addColorStop(0, 'rgba(8,0,1,.98)'); hg.addColorStop(0.6, 'rgba(40,2,6,.85)'); hg.addColorStop(1, 'rgba(60,5,10,0)');
  x.fillStyle = hg; x.beginPath(); x.ellipse(hx, hy, hr * 1.5, hr, Math.atan2(D.dir[1], D.dir[0]) + Math.PI / 2, 0, TAU); x.fill();
  x.fillStyle = 'rgba(255,170,170,.25)'; x.beginPath(); x.ellipse(hx - hr * 0.5, hy + hr * 0.4, hr * 0.5, hr * 0.2, -0.4, 0, TAU); x.fill();
  x.restore();
  x.lineWidth = 2.4 * G.u; x.strokeStyle = 'rgba(205,110,115,.85)'; pathPoly(x, D.poly); x.stroke();
  return { c, ox, oy };
}
function makeImplant(D) {
  const flip = !D.donor.self && (D.donor.c[0] - mouthC()[0]) * (D.c[0] - mouthC()[0]) < 0;
  const spr = clipSprite(D.donor.poly, G.base, 2, flip);
  const [x0, y0, x1, y1] = polyBB(D.poly);
  const x = spr.c.x; x.save(); x.globalCompositeOperation = 'source-atop'; x.fillStyle = 'rgba(255,255,255,.07)'; x.fillRect(0, 0, spr.w, spr.h); x.restore();
  spr.tw = (x1 - x0) * 1.05; spr.th = (y1 - y0) * 1.05; // drawn size in base px
  spr.cx = (x0 + x1) / 2; spr.cy = (y0 + y1) / 2; // drawn centre (bbox centre of the socket)
  return spr;
}

/* ======================================================================
   procedural tool silhouettes & faces
   ====================================================================== */
function metal(c, y0, y1) { const g = c.createLinearGradient(0, y0, 0, y1); g.addColorStop(0, '#5b646d'); g.addColorStop(0.3, '#f0f4f8'); g.addColorStop(0.55, '#a9b3bc'); g.addColorStop(1, '#434b54'); return g; }
function plastic(c, y0, y1, a, b) { const g = c.createLinearGradient(0, y0, 0, y1); g.addColorStop(0, b); g.addColorStop(0.35, a); g.addColorStop(1, b); return g; }
function drawToolShape(c, id) {
  c.lineJoin = 'round'; c.lineCap = 'round';
  switch (id) {
    case 'scaler':
      rrect(c, 52, -6, 134, 12, 6); c.fillStyle = metal(c, -6, 6); c.fill();
      c.strokeStyle = 'rgba(0,0,0,.22)'; c.lineWidth = 1; for (let x = 70; x < 176; x += 5) { c.beginPath(); c.moveTo(x, -6); c.lineTo(x + 3, 6); c.stroke(); }
      c.beginPath(); c.moveTo(52, -3.5); c.lineTo(14, -1.2); c.lineTo(14, 1.2); c.lineTo(52, 3.5); c.closePath(); c.fillStyle = metal(c, -3.5, 3.5); c.fill();
      c.strokeStyle = '#c9d1d8'; c.lineWidth = 2.4; c.beginPath(); c.moveTo(15, 0); c.bezierCurveTo(6, 0, 2, -9, -2, -6); c.lineTo(0, 0); c.stroke();
      break;
    case 'brush':
      rrect(c, 48, -7, 138, 14, 7); c.fillStyle = plastic(c, -7, 7, '#ff8dbd', '#d63c78'); c.fill();
      rrect(c, 80, -2, 80, 4, 2); c.fillStyle = 'rgba(255,255,255,.55)'; c.fill();
      c.beginPath(); c.moveTo(48, -5); c.lineTo(26, -4); c.lineTo(26, 4); c.lineTo(48, 5); c.closePath(); c.fillStyle = plastic(c, -5, 5, '#ff8dbd', '#d63c78'); c.fill();
      rrect(c, -2, -7, 32, 14, 6); c.fillStyle = plastic(c, -7, 7, '#ff8dbd', '#d63c78'); c.fill();
      for (let i = 0; i < 7; i++) { rrect(c, 0 + i * 4.2, -22, 3.3, 16, 1.6); c.fillStyle = i % 2 ? '#7fd8f0' : '#ffffff'; c.fill(); }
      break;
    case 'water':
      rrect(c, 64, -15, 122, 30, 15); c.fillStyle = plastic(c, -15, 15, '#ff86b8', '#d8306f'); c.fill();
      c.beginPath(); c.ellipse(98, 0, 9, 6, 0, 0, TAU); c.fillStyle = '#ffd3e6'; c.fill(); c.strokeStyle = 'rgba(120,10,50,.5)'; c.lineWidth = 1.2; c.stroke();
      c.beginPath(); c.moveTo(66, -4.5); c.lineTo(10, -1.6); c.lineTo(10, 1.6); c.lineTo(66, 4.5); c.closePath(); c.fillStyle = plastic(c, -4.5, 4.5, '#ffffff', '#c6ccd3'); c.fill();
      c.strokeStyle = '#e8ecf0'; c.lineWidth = 3; c.beginPath(); c.moveTo(11, 0); c.quadraticCurveTo(3, 0, 0, -5); c.stroke();
      break;
    case 'suction':
      rrect(c, 0, -6, 186, 12, 6); c.fillStyle = plastic(c, -6, 6, 'rgba(225,242,255,.95)', 'rgba(150,190,220,.95)'); c.fill();
      c.fillStyle = 'rgba(90,140,180,.35)'; c.fillRect(14, -1.5, 170, 3);
      rrect(c, 120, -7, 16, 14, 3); c.fillStyle = '#3aa6ff'; c.fill();
      rrect(c, -2, -7.5, 16, 15, 5); c.fillStyle = '#d8e8f2'; c.fill();
      c.fillStyle = '#5c7486'; for (let i = 0; i < 3; i++) { c.beginPath(); c.arc(3 + i * 4, (i % 2 ? 2.5 : -2.5), 1.3, 0, TAU); c.fill(); }
      break;
    case 'tweezers':
      c.beginPath(); c.moveTo(0, -0.8); c.lineTo(168, -10); c.lineTo(168, -4); c.lineTo(2, 0); c.closePath(); c.fillStyle = metal(c, -10, 0); c.fill();
      c.beginPath(); c.moveTo(0, 0.8); c.lineTo(168, 10); c.lineTo(168, 4); c.lineTo(2, 0); c.closePath(); c.fillStyle = metal(c, 0, 10); c.fill();
      rrect(c, 160, -11, 26, 22, 5); c.fillStyle = metal(c, -11, 11); c.fill();
      c.strokeStyle = 'rgba(0,0,0,.25)'; c.lineWidth = 1; for (let x = 90; x < 140; x += 6) { c.beginPath(); c.moveTo(x, -x * 0.055 - 1); c.lineTo(x, -x * 0.03 + 1); c.stroke(); c.beginPath(); c.moveTo(x, x * 0.055 + 1); c.lineTo(x, x * 0.03 - 1); c.stroke(); }
      break;
    case 'drill':
      rrect(c, -1, -1.6, 13, 3.2, 1.2); c.fillStyle = '#e8c26a'; c.fill();
      c.beginPath(); c.arc(1, 0, 2.4, 0, TAU); c.fillStyle = '#c99a3c'; c.fill();
      rrect(c, 10, -10, 22, 20, 7); c.fillStyle = metal(c, -10, 10); c.fill();
      c.beginPath(); c.moveTo(30, -6); c.lineTo(62, -8); c.lineTo(62, 8); c.lineTo(30, 6); c.closePath(); c.fillStyle = metal(c, -8, 8); c.fill();
      rrect(c, 60, -9.5, 126, 19, 8); c.fillStyle = metal(c, -9.5, 9.5); c.fill();
      rrect(c, 70, -10, 6, 20, 2); c.fillStyle = '#3aa6ff'; c.fill();
      c.strokeStyle = 'rgba(0,0,0,.2)'; c.lineWidth = 1; for (let x = 96; x < 150; x += 4) { c.beginPath(); c.moveTo(x, -9); c.lineTo(x, 9); c.stroke(); }
      rrect(c, 176, -8, 12, 16, 4); c.fillStyle = '#2b3138'; c.fill();
      break;
    case 'filling':
      c.beginPath(); c.arc(3, 0, 5.5, 0, TAU); c.fillStyle = '#f3eee3'; c.fill(); c.fillStyle = 'rgba(255,255,255,.9)'; c.beginPath(); c.arc(1.5, -1.8, 1.8, 0, TAU); c.fill();
      c.strokeStyle = '#9aa3ab'; c.lineWidth = 5; c.beginPath(); c.moveTo(8, 0); c.quadraticCurveTo(22, 6, 42, 0); c.stroke();
      rrect(c, 40, -10, 110, 20, 6); c.fillStyle = plastic(c, -10, 10, '#f4f7fa', '#c3ccd5'); c.fill();
      rrect(c, 70, -10, 30, 20, 2); c.fillStyle = '#4fd1c5'; c.fill();
      rrect(c, 148, -4, 32, 8, 3); c.fillStyle = '#b8c1c9'; c.fill();
      rrect(c, 178, -12, 8, 24, 3); c.fillStyle = '#dfe6ec'; c.fill();
      break;
    case 'lamp':
      c.save(); c.shadowColor = '#5aa8ff'; c.shadowBlur = 14; c.beginPath(); c.arc(1, 0, 5, 0, TAU); c.fillStyle = '#9fd0ff'; c.fill(); c.restore();
      rrect(c, 0, -3.5, 60, 7, 3.5); c.fillStyle = plastic(c, -3.5, 3.5, '#e6edf3', '#8c99a6'); c.fill();
      c.beginPath(); c.arc(1, 0, 4, 0, TAU); c.fillStyle = '#5aa8ff'; c.fill();
      c.beginPath(); c.ellipse(26, 0, 3.5, 15, 0, 0, TAU); c.fillStyle = 'rgba(255,140,40,.75)'; c.fill();
      rrect(c, 58, -13, 128, 26, 12); c.fillStyle = plastic(c, -13, 13, '#f5f8fb', '#b9c3cc'); c.fill();
      c.beginPath(); c.arc(92, 0, 5, 0, TAU); c.fillStyle = '#3aa6ff'; c.fill();
      break;
    case 'forceps':
      c.beginPath(); c.moveTo(0, -1); c.quadraticCurveTo(14, -10, 36, -6); c.lineTo(36, -1.5); c.quadraticCurveTo(16, -4, 2, 0); c.closePath(); c.fillStyle = metal(c, -10, 0); c.fill();
      c.beginPath(); c.moveTo(0, 1); c.quadraticCurveTo(14, 10, 36, 6); c.lineTo(36, 1.5); c.quadraticCurveTo(16, 4, 2, 0); c.closePath(); c.fillStyle = metal(c, 0, 10); c.fill();
      c.beginPath(); c.arc(40, 0, 7, 0, TAU); c.fillStyle = metal(c, -7, 7); c.fill(); c.beginPath(); c.arc(40, 0, 2, 0, TAU); c.fillStyle = '#4a525b'; c.fill();
      c.lineWidth = 8; c.strokeStyle = metal(c, -18, 2); c.beginPath(); c.moveTo(44, -3); c.quadraticCurveTo(110, -6, 182, -17); c.stroke();
      c.strokeStyle = metal(c, -2, 18); c.beginPath(); c.moveTo(44, 3); c.quadraticCurveTo(110, 6, 182, 17); c.stroke();
      break;
    case 'syringe':
      c.strokeStyle = '#c9d0d6'; c.lineWidth = 1.8; c.beginPath(); c.moveTo(0, 0); c.lineTo(40, 0); c.stroke();
      rrect(c, 38, -4.5, 11, 9, 2); c.fillStyle = '#7fd8f0'; c.fill();
      rrect(c, 48, -10, 100, 20, 4); c.fillStyle = 'rgba(230,245,255,.5)'; c.fill(); c.strokeStyle = 'rgba(255,255,255,.85)'; c.lineWidth = 1.4; c.stroke();
      rrect(c, 50, -7.5, 70, 15, 3); c.fillStyle = 'rgba(110,200,255,.6)'; c.fill();
      c.strokeStyle = 'rgba(40,70,100,.5)'; c.lineWidth = 1; for (let x = 60; x < 146; x += 10) { c.beginPath(); c.moveTo(x, -10); c.lineTo(x, -4); c.stroke(); }
      rrect(c, 120, -8, 6, 16, 2); c.fillStyle = '#3c4650'; c.fill();
      rrect(c, 146, -17, 6, 34, 2); c.fillStyle = '#e6eef4'; c.fill();
      rrect(c, 150, -3, 30, 6, 2); c.fillStyle = '#dfe6ec'; c.fill();
      rrect(c, 178, -12, 8, 24, 3); c.fillStyle = '#dfe6ec'; c.fill();
      break;
  }
}
function drawToothIcon(c, cx, cy, s) {
  c.save(); c.translate(cx, cy); c.scale(s / 100, s / 100);
  c.beginPath();
  c.moveTo(0, -38); c.bezierCurveTo(-18, -48, -44, -44, -44, -18); c.bezierCurveTo(-44, 4, -34, 14, -30, 34);
  c.bezierCurveTo(-26, 50, -18, 52, -14, 40); c.bezierCurveTo(-10, 26, -6, 16, 0, 16); c.bezierCurveTo(6, 16, 10, 26, 14, 40);
  c.bezierCurveTo(18, 52, 26, 50, 30, 34); c.bezierCurveTo(34, 14, 44, 4, 44, -18); c.bezierCurveTo(44, -44, 18, -48, 0, -38); c.closePath();
  const g = c.createLinearGradient(-40, -40, 40, 50); g.addColorStop(0, '#ffffff'); g.addColorStop(0.6, '#eceae2'); g.addColorStop(1, '#c9c3b6');
  c.fillStyle = g; c.fill(); c.lineWidth = 3; c.strokeStyle = 'rgba(120,110,95,.6)'; c.stroke();
  c.fillStyle = 'rgba(255,255,255,.85)'; c.beginPath(); c.ellipse(-20, -24, 9, 5, -0.6, 0, TAU); c.fill();
  c.restore();
}
function makeToolSprite(id) {
  const R = 2, c = mkc(160 * R, 160 * R), x = c.x;
  x.scale(R, R);
  if (id === 'implant') { drawToothIcon(x, 80, 80, 110); return { img: c, w: 110, h: 110, hx: 55, hy: 55, proc: true }; }
  x.save(); x.shadowColor = 'rgba(0,0,0,.45)'; x.shadowBlur = 6; x.shadowOffsetX = 3; x.shadowOffsetY = 4;
  x.translate(14, 14); x.rotate(Math.PI / 4); drawToolShape(x, id); x.restore();
  return { img: c, w: 150, h: 150, hx: (14 / 160) * 150, hy: (14 / 160) * 150, proc: true };
}
function drawFace(c, s, st) {
  c.clearRect(0, 0, s, s);
  const r = s / 2;
  const g = c.createRadialGradient(r * 0.75, r * 0.7, 2, r, r, r);
  const skin = { calm: ['#ffe0c4', '#e8b48e'], worried: ['#fde3c2', '#e2b07f'], pain: ['#ffd0bf', '#e08f7a'], cry: ['#ffc9c0', '#d9786c'] }[st];
  g.addColorStop(0, skin[0]); g.addColorStop(1, skin[1]);
  c.fillStyle = g; c.beginPath(); c.arc(r, r, r - 1, 0, TAU); c.fill();
  c.strokeStyle = '#3a2a26'; c.fillStyle = '#3a2a26'; c.lineCap = 'round'; c.lineWidth = s * 0.05;
  const ey = r * 0.85, ex = r * 0.42;
  if (st === 'calm') {
    for (const sx of [-1, 1]) { c.beginPath(); c.arc(r + sx * ex, ey, s * 0.07, Math.PI * 1.1, Math.PI * 1.9); c.stroke(); }
    c.beginPath(); c.arc(r, r * 1.15, r * 0.4, 0.2 * Math.PI, 0.8 * Math.PI); c.stroke();
  } else if (st === 'worried') {
    for (const sx of [-1, 1]) {
      c.beginPath(); c.arc(r + sx * ex, ey, s * 0.06, 0, TAU); c.fill();
      c.beginPath(); c.moveTo(r + sx * ex * 1.45, ey - s * 0.13); c.lineTo(r + sx * ex * 0.6, ey - s * 0.2); c.stroke();
    }
    c.beginPath(); c.moveTo(r - r * 0.32, r * 1.42); c.quadraticCurveTo(r - r * 0.1, r * 1.32, r, r * 1.42); c.quadraticCurveTo(r + r * 0.12, r * 1.52, r + r * 0.32, r * 1.4); c.stroke();
    c.fillStyle = '#7fd0ff'; c.beginPath(); c.moveTo(s * 0.86, s * 0.22); c.quadraticCurveTo(s * 0.95, s * 0.38, s * 0.86, s * 0.42); c.quadraticCurveTo(s * 0.77, s * 0.38, s * 0.86, s * 0.22); c.fill();
  } else if (st === 'pain') {
    for (const sx of [-1, 1]) { c.beginPath(); c.moveTo(r + sx * ex * 1.4, ey - s * 0.07); c.lineTo(r + sx * ex * 0.7, ey); c.lineTo(r + sx * ex * 1.4, ey + s * 0.07); c.stroke(); }
    c.fillStyle = '#fff'; rrect(c, r - r * 0.45, r * 1.22, r * 0.9, r * 0.36, r * 0.12); c.fill(); c.stroke();
    c.lineWidth = s * 0.025; c.beginPath(); c.moveTo(r - r * 0.45, r * 1.4); c.lineTo(r + r * 0.45, r * 1.4); for (let i = -2; i <= 2; i++) { c.moveTo(r + i * r * 0.18, r * 1.22); c.lineTo(r + i * r * 0.18, r * 1.58); } c.stroke();
  } else {
    for (const sx of [-1, 1]) { c.beginPath(); c.arc(r + sx * ex, ey + s * 0.02, s * 0.07, Math.PI * 0.1, Math.PI * 0.9, true); c.stroke(); }
    c.fillStyle = '#5a1f22'; c.beginPath(); c.ellipse(r, r * 1.42, r * 0.3, r * 0.24, 0, 0, TAU); c.fill();
    c.fillStyle = 'rgba(110,200,255,.9)';
    for (const sx of [-1, 1]) { c.beginPath(); c.moveTo(r + sx * ex, ey + s * 0.08); c.quadraticCurveTo(r + sx * ex * 1.25, r * 1.4, r + sx * ex * 1.05, s * 0.92); c.lineTo(r + sx * ex * 0.85, s * 0.92); c.quadraticCurveTo(r + sx * ex * 0.9, r * 1.3, r + sx * ex, ey + s * 0.08); c.fill(); }
  }
}

/* ---------- fly ---------- */
function drawFly(c, f, t) {
  const u = G.u * 1.05;
  c.save(); c.translate(f.x, f.y);
  if (f.state === 'sit') { c.fillStyle = 'rgba(0,0,0,.22)'; c.beginPath(); c.ellipse(1.5 * u, 2.5 * u, 6 * u, 3.5 * u, f.ang, 0, TAU); c.fill(); }
  const lift = f.state === 'sit' ? 0 : -4 * u;
  c.translate(0, lift); c.rotate(f.ang);
  const img = G.img[G.man.fx && G.man.fx.fly];
  if (img) {
    const hh = 20 * u, ww = hh * img.naturalWidth / img.naturalHeight;
    c.rotate(Math.PI / 2);
    if (f.state !== 'sit') { c.globalAlpha = 0.85 + Math.sin(t * 90) * 0.15; c.scale(1 + Math.sin(t * 90) * 0.06, 1); }
    c.drawImage(img, -ww / 2, -hh / 2, ww, hh); c.restore(); return;
  }
  // legs
  c.strokeStyle = 'rgba(20,18,16,.9)'; c.lineWidth = 0.7 * u;
  const wig = f.state === 'sit' && f.moving ? Math.sin(t * 40) * 0.25 : 0;
  for (let i = -1; i <= 1; i++) for (const sd of [-1, 1]) {
    c.beginPath(); c.moveTo(i * 2 * u, 0); c.lineTo(i * 2.6 * u + (i + wig * sd) * 2 * u, sd * 4.2 * u); c.lineTo(i * 3.8 * u + i * 2 * u, sd * 6 * u); c.stroke();
  }
  // wings
  const flap = f.state === 'sit' ? 0.35 + Math.sin(t * 3) * 0.04 : 0.2 + Math.abs(Math.sin(t * 90)) * 0.9;
  c.fillStyle = 'rgba(200,215,230,.42)'; c.strokeStyle = 'rgba(80,90,100,.5)'; c.lineWidth = 0.4 * u;
  for (const sd of [-1, 1]) { c.save(); c.rotate(sd * (Math.PI - flap)); c.beginPath(); c.ellipse(5.5 * u, 0, 6 * u, 2.4 * u, 0, 0, TAU); c.fill(); c.stroke(); c.restore(); }
  // abdomen, thorax, head
  const ab = c.createRadialGradient(-3.5 * u, -1 * u, 0, -3.5 * u, 0, 4.5 * u); ab.addColorStop(0, '#5a5f55'); ab.addColorStop(0.6, '#25261f'); ab.addColorStop(1, '#0d0d0a');
  c.fillStyle = ab; c.beginPath(); c.ellipse(-3.8 * u, 0, 4.6 * u, 3.3 * u, 0, 0, TAU); c.fill();
  c.strokeStyle = 'rgba(160,165,150,.35)'; c.lineWidth = 0.5 * u; for (let i = 0; i < 3; i++) { c.beginPath(); c.arc(-3.8 * u + i * 1.6 * u - 1.6 * u, 0, 3 * u, -1, 1); c.stroke(); }
  c.fillStyle = '#2a2b26'; c.beginPath(); c.ellipse(1.2 * u, 0, 2.8 * u, 2.6 * u, 0, 0, TAU); c.fill();
  c.fillStyle = '#5b1610'; for (const sd of [-1, 1]) { c.beginPath(); c.ellipse(4.2 * u, sd * 1.5 * u, 1.6 * u, 1.4 * u, 0, 0, TAU); c.fill(); }
  c.fillStyle = 'rgba(255,255,255,.45)'; c.beginPath(); c.arc(-4.5 * u, -1.2 * u, 1 * u, 0, TAU); c.fill();
  c.restore();
}

/* ======================================================================
   level
   ====================================================================== */
function deriveBands(type) {
  const u = G.u;
  if (type === 'tartar') {
    const low = G.teeth.filter((t) => t.jaw === 'lower').sort((a, b) => a.c[0] - b.c[0]);
    const pts = low.map((t) => { const [, , , y1] = polyBB(t.poly); return [t.c[0], lerp(t.c[1], y1, 0.65)]; });
    return pts.length > 1 ? [{ pts, w: 14 * u }] : [];
  }
  const up = G.teeth.filter((t) => t.jaw === 'upper');
  const mc = mouthC();
  up.sort((a, b) => Math.atan2(a.c[0] - mc[0], -(a.c[1] - mc[1])) - Math.atan2(b.c[0] - mc[0], -(b.c[1] - mc[1])));
  return up.length > 1 ? [{ pts: up.map((t) => t.c.slice()), w: 36 * u }] : [];
}
function resolveTooth(p, fallbackPoly) {
  let t = null;
  if (G.teethJson) {
    // position wins over id: ids from segment_teeth.py shift when a tooth is merged or split
    const at = Array.isArray(p.pos) ? p.pos : Array.isArray(p.c) ? p.c : null;
    if (at) { t = toothNear(at[0], at[1]); if (t && !pointInPoly(at[0], at[1], t.poly) && dist(at[0], at[1], t.c[0], t.c[1]) > 30 * G.u) t = null; }
    if (!t) t = toothById(p.tooth);
  }
  if (!t && Array.isArray(fallbackPoly) && fallbackPoly.length > 2) t = { id: p.tooth || 'X', jaw: 'upper', poly: fallbackPoly, c: polyC(fallbackPoly) };
  if (!t && Array.isArray(p.pos)) t = toothNear(p.pos[0], p.pos[1]);
  if (!t) t = toothById(p.tooth) || upperFront(0);
  return t;
}

function buildLevel() {
  const u = G.u;
  const L = G.L = {
    time: CFG.levelTime, score: 0, lives: CFG.lives, flinches: 0, pain: 0, anest: 0, saliva: 0.12,
    invuln: 0, shake: 0, vig: 0, flyT: rand(CFG.flyMin, CFG.flyMax), fly: null, parts: [], pops: [],
    probs: [], winT: -1, over: false, injected: false, cd: {}, t: 0, measureT: 0, tickS: -1, salHint: false,
    foam: poolLayer('foam'), dust: poolLayer('dust'), blood: poolLayer('blood'), tooth: null, wipes: [],
  };
  let seed = 100, cavN = 0;
  const step = G.sm;
  (G.pat.problems || []).forEach((src, si) => {
    const p = { type: src.type, src, done: false };
    if (!PROB[p.type]) return;
    seed += 17;
    if (p.type === 'tartar' || p.type === 'plaque') {
      p.layer = poolLayer('p' + si);
      const img = src.layer && G.img[src.layer];
      const gen = () => {
        let bands = Array.isArray(src.bands) && src.bands.length ? src.bands : deriveBands(p.type);
        bands = bands.map((b) => ({ pts: b.pts, w: b.w || (p.type === 'tartar' ? 14 : 36) * u }));
        if (!bands.length) return;
        if (p.type === 'tartar') genTartar(p.layer, bands, seed); else genPlaque(p.layer, bands, seed);
        p.layer.sync(); // one-off: the procedural crust's alpha onto the progress grid
      };
      // progress counts only what is inside the mouth (stray alpha on the lips would block completion)
      // plaque counts only on/near the teeth (a coated tongue in the picture is not part of the job)
      const near = 10 * u, onTooth = (x, y) => maskAt(x, y) > 60 || maskAt(x - near, y) > 60 || maskAt(x + near, y) > 60 || maskAt(x, y - near) > 60 || maskAt(x, y + near) > 60;
      const mkRegion = () => {
        p.region = new Region(p.layer, p.layer.empty ? [0, 0, 0, 0] : p.layer.bb, step, p.type === 'plaque' && G.teethJson ? (x, y) => pointInPoly(x, y, G.mouth) && onTooth(x, y) : (x, y) => pointInPoly(x, y, G.mouth));
        p.region.setInitial();
      };
      if (img) p.layer.fromImage(img); else gen();
      mkRegion();
      if (!p.region.init && img) { // the picture has nothing inside the mouth: fall back to the procedural crust
        console.warn(`[doctor-alinka] ${p.type}: layer ${src.layer} has no alpha inside "mouth", using the procedural one`);
        p.layer.clear(); gen(); mkRegion();
      }
      if (!p.region.init) { console.warn(`[doctor-alinka] ${p.type}: nothing to clean (no layer, no teeth bands), item skipped`); return; }
      if (p.type === 'plaque') {
        p.cleared = false;
        if (src.foam && G.img[src.foam]) { L.foamImg = G.img[src.foam]; imgAlpha(L.foamImg); } // warm the cache now, not on the first brush stroke
        p.foamRegion = new Region(L.foam, [0, 0, 0, 0], step, null, true);
        p.foamRegion.cand = p.region.pts.slice();
      }
    } else if (p.type === 'food') {
      const fp = Array.isArray(src.pos) ? src.pos : (() => { const a = upperFront(0), b = upperFront(1); return [(a.c[0] + b.c[0]) / 2, Math.max(a.c[1], b.c[1]) + 6 * u]; })();
      const sz = Array.isArray(src.size) ? src.size : [34 * u, 28 * u];
      p.w = sz[0]; p.h = sz[1]; p.x = p.hx = fp[0]; p.y = p.hy = fp[1]; p.rot = ((src.rot || 0) * Math.PI) / 180; p.rot0 = p.rot;
      const img = src.sprite && G.img[src.sprite];
      p.img = img || src._food || (src._food = genFood(p.w, p.h, seed));
      p.state = 'stuck'; p.a = 1;
    } else if (p.type === 'cavity') {
      let pos = Array.isArray(src.pos) ? src.pos : null;
      if (!pos) {
        const up = G.teeth.filter((t) => t.jaw === 'upper'), mc = mouthC();
        const side = up.filter((t) => (cavN % 2 ? t.c[0] > mc[0] : t.c[0] < mc[0])).sort((a, b) => b.c[1] - a.c[1]);
        const t = toothById(src.tooth) || side[1] || side[0] || up[0];
        pos = t ? t.c.slice() : mc;
      }
      cavN++;
      p.x = pos[0]; p.y = pos[1]; p.r = src.r || 11 * u;
      p.fillR = src.fillR || p.r * 0.88; // the drilled hole is smaller than the decay halo
      const ct = G.teethJson ? toothNear(p.x, p.y) : toothById(src.tooth);
      p.toothId = ct ? ct.id : (src.tooth || null);
      p.layer = poolLayer('p' + si);
      const img = src.layer && G.img[src.layer];
      if (img) p.layer.fromImage(img); else genCavity(p.layer, p.x, p.y, p.r, seed);
      p.state = 'decay'; p.drill = 0; p.cure = 0; p.anim = 0;
      p.drilledImg = (src.drilled && G.img[src.drilled]) || null; // optional full-size "drilled cavity" layer
      p.dustRegion = new Region(L.dust, [p.x - p.r * 3, p.y - p.r * 3, p.x + p.r * 3, p.y + p.r * 3], Math.max(2, step - 1), (x, y) => dist(x, y, p.x, p.y) < p.r * 3, true);
    } else if (p.type === 'dead') {
      const t = resolveTooth(src, src.poly);
      p.poly = t.poly; p.c = polyC(t.poly); p.toothId = t.id;
      const mc = mouthC(); let dx = p.c[0] - mc[0], dy = p.c[1] - mc[1]; const dl = Math.hypot(dx, dy) || 1; dx /= dl; dy /= dl;
      p.dir = [dx, dy]; // outward = toward the gum / root
      const [x0, y0, x1, y1] = polyBB(p.poly), half = Math.max(x1 - x0, y1 - y0) / 2;
      p.root = [p.c[0] + dx * half * 0.9, p.c[1] + dy * half * 0.9];
      p.tip = [p.c[0] - dx * half * 0.9, p.c[1] - dy * half * 0.9];
      // donor
      let donor = null;
      // the base photo is the clean mouth, so by default the new tooth is the patient's own healthy tooth
      // from under the dead layer; a neighbour (mirrored) is used only when the manifest asks for one
      const wantDonor = !!(src.donor || (Array.isArray(src.donorPoly) && src.donorPoly.length > 2));
      if (G.teethJson && wantDonor) {
        const dp = Array.isArray(src.donorPoly) && src.donorPoly.length > 2 ? polyC(src.donorPoly) : null;
        if (dp) { donor = toothNear(dp[0], dp[1], null, t); if (donor && dist(dp[0], dp[1], donor.c[0], donor.c[1]) > 40 * G.u) donor = null; }
        if (!donor) { const byId = toothById(src.donor); if (byId && byId !== t && dist(byId.c[0], byId.c[1], p.c[0], p.c[1]) < 90 * G.u) donor = byId; }
        if (!donor) donor = toothNear(p.c[0], p.c[1], t.jaw, t);
      }
      if (!donor && wantDonor && Array.isArray(src.donorPoly) && src.donorPoly.length > 2) donor = { id: src.donor || 'D', poly: src.donorPoly, c: polyC(src.donorPoly) };
      // no trustworthy neighbour: the base photo under the dead tooth is the clean tooth itself
      if (!donor) donor = { id: 'self', poly: p.poly, c: p.c, self: true };
      p.donor = donor;
      const dimg = src.layer && G.img[src.layer];
      // sprites depend only on the patient: built once, reused on every restart
      const dc = src._sprites || (src._sprites = { spr: makeDeadSprite(p, dimg), socket: makeSocket(p), imp: makeImplant(p) });
      p.spr = dc.spr; p.socket = dc.socket; p.imp = dc.imp;
      p.state = 'dead'; p.grab = false; p.rev = 0; p.sgn = 0; p.loosen = 0; p.rot = 0; p.off = [0, 0]; p.flyAway = null; p.snap = 0;
      p.bloodRegion = new Region(L.blood, [x0 - 40 * u, y0 - 40 * u, x1 + 40 * u, y1 + 60 * u], step, null, true);
      L.tooth = p;
    }
    L.probs.push(p);
  });
  // nothing else is painted over the dead tooth (it gets its own grey-brown look)
  if (L.tooth) for (const p of L.probs) if (p.type === 'plaque' || p.type === 'tartar') {
    const c = p.layer.c.x; c.save(); c.globalCompositeOperation = 'destination-out'; pathPoly(c, L.tooth.poly); c.fillStyle = '#000'; c.fill();
    if (!p.src.layer) { c.lineWidth = 2 * u; c.stroke(); } c.restore();
    if (p.src.layer) p.layer.cutPoly(L.tooth.poly); else p.layer.sync();
    p.region.setInitial(); if (p.foamRegion) p.foamRegion.cand = p.region.pts.slice();
  }
  L.probs = L.probs.filter((p) => !p.region || p.region.init > 0);
  buildChecklist();
  G.tool = null; refreshTray();
  P.path = []; P.consumed = false;
}

/* ======================================================================
   gameplay helpers
   ====================================================================== */
function addPain(v, force) {
  const L = G.L;
  if (L.over || L.winT > 0) return; // everything is done (win countdown) or the level already ended
  if (!force && (L.anest > 0 || L.invuln > 0)) return;
  if (L.invuln > 0) return;
  L.pain = Math.min(100, L.pain + v);
}
function addScore(v, bx, by, col) {
  const L = G.L; L.score = Math.max(0, L.score + v);
  if (bx !== undefined) { const [lx, ly] = toLogical(bx, by); L.pops.push({ x: lx, y: ly - 20, t: 0, txt: (v > 0 ? '+' : '') + v, col: col || (v > 0 ? '#8ff0e6' : '#ff6b7a') }); }
}
function step(bx, by) { addScore(CFG.score.step, bx, by); S.play('pop'); }
function cool(key, sec) { const L = G.L; if ((L.cd[key] || -1e9) > L.t) return false; L.cd[key] = L.t + sec; return true; }
function hintCD(key, txt, kind, sec) { if (cool(key, sec || 3)) hint(txt, kind || 'warn'); }
function orderError(txt) {
  if (!cool('order:' + txt, 2.2)) return;
  hint(txt, 'warn'); S.play('beep', { n: 2, pitch: 0.55, volume: 0.8 });
  if (cool('orderLine', 6)) Stream.play('fail', pick(LINES.order));
}
function completeProblem(p, bx, by) {
  if (p.done || G.L.over) return;
  p.done = true;
  // leftovers that were allowed to stay (foam on the tongue, the last dust / blood) go away with the item
  if (p.type === 'plaque') G.L.foam.fade = true;
  addScore(CFG.score.item, bx, by, '#ffd166');
  S.play('ding');
  for (let i = 0; i < 14; i++) spark(bx, by);
  updateChecklist(p.type);
  const left = G.L.probs.filter((q) => !q.done).length;
  if (left === 0) { G.L.winT = 1.1; }
  else if (!Stream.speaking && cool('laugh', 20)) Stream.play('laugh'); // not more often than every 20 s
}
function spark(bx, by) { G.L.parts.push({ k: 'spark', x: bx, y: by, vx: rand(-90, 90) * G.u, vy: rand(-110, 40) * G.u, life: rand(0.4, 0.8), t: 0, s: rand(1.2, 2.6) * G.u }); }
function addPart(o) { if (G.L.parts.length < 700) G.L.parts.push(o); }
function inMouth(x, y) { return pointInPoly(x, y, G.mouth); }
function flyActive() { const f = G.L.fly; return f && f.state === 'sit'; }

function inject() {
  const L = G.L;
  if (!inMouth(P.bx, P.by)) { hintCD('syr', 'Укол делают в десну, внутри рта', 'warn', 2); return; }
  addPain(CFG.pain.syringe, true);
  L.anest = CFG.anesthesia;
  S.play('squeak');
  for (let i = 0; i < 8; i++) addPart({ k: 'drop', x: P.bx, y: P.by, vx: rand(-40, 40) * G.u, vy: rand(-60, 10) * G.u, life: 0.5, t: 0, s: rand(0.8, 1.6) * G.u });
  if (!L.injected) { L.injected = true; step(P.bx, P.by); hint('Анестезия 25 с: можно скрести и сверлить без боли', 'good'); }
  else hint('Анестезию обновили', 'good');
}
function cavityAt(x, y, k) {
  let best = null, bd = 1e9;
  for (const p of G.L.probs) if (p.type === 'cavity') { const d = dist(x, y, p.x, p.y); if (d < p.r * k && d < bd) { bd = d; best = p; } }
  return best;
}
function fillTap() {
  const c = cavityAt(P.bx, P.by, 2.2);
  if (!c) { hintCD('fillmiss', 'Пломбу ставят в рассверленную полость', 'warn', 2.5); return; }
  if (c.state === 'decay') return orderError('Сначала рассверли кариес бормашиной');
  if (c.state === 'drilled') return orderError('Сначала смой пыль водой');
  if (c.state === 'filled' || c.state === 'cured') { hintCD('fillx', c.state === 'filled' ? 'Пломба уже стоит, теперь лампа' : 'Тут уже всё готово', 'warn', 2); return; }
  c.state = 'filled'; c.anim = 0; S.play('squish'); step(c.x, c.y);
  hint('Пломба на месте. Посвети лампой 2 секунды', 'good');
}
function grabFood() {
  const f = G.L.probs.find((p) => p.type === 'food' && p.state !== 'gone');
  if (!f) return;
  if (dist(P.bx, P.by, f.x, f.y) < Math.max(f.w, f.h) * 0.75 + 6 * G.u) {
    f.state = 'held'; f.gx = f.x - P.bx; f.gy = f.y - P.by; S.play('pick');
  }
}
function grabTooth() {
  const D = G.L.tooth;
  if (!D) return;
  const hit = pointInPoly(P.bx, P.by, D.poly) || dist(P.bx, P.by, D.c[0], D.c[1]) < 22 * G.u;
  if (!hit) return;
  if (D.state === 'dead' || D.state === 'loose') {
    D.grab = true; D.gx = P.bx; D.gy = P.by; D.sgn = 0; S.play('pick');
    if (D.state === 'dead') hintCD('wig', 'Качай зуб влево-вправо', 'good', 4);
  } else if (D.state === 'implanted') hintCD('forx', 'Новый зуб трогать не надо', 'warn', 2);
  else if (D.state !== 'pulled') hintCD('forx2', 'Зуб уже удалён', 'warn', 2);
}
function startImplant() {
  const D = G.L.tooth; if (!D) return;
  if (D.state === 'implanted') { hintCD('impx', 'Новый зуб уже стоит', 'warn', 2); return; }
  G.L.impDrag = true;
}
function extractTooth() {
  const D = G.L.tooth, u = G.u;
  D.state = 'pulled'; D.grab = true;
  addPain(CFG.pain.forceps);
  S.play('crack'); S.play('thud');
  // blood
  const L = G.L, c = L.blood.c.x;
  c.save(); pathPoly(c, D.poly); c.clip();
  const [x0, y0, x1, y1] = polyBB(D.poly);
  // a real socket picture already has the clot in it: fresh blood on top is a thin wash, not a blob
  const realSocket = !!socketImg(D);
  for (let i = 0; i < (realSocket ? 14 : 26); i++) { const x = rand(x0, x1), y = rand(y0, y1); c.globalAlpha = realSocket ? 0.32 : 0.85; c.drawImage(SPR.blood, x - 9 * u, y - 9 * u, 18 * u, 18 * u); }
  c.restore();
  c.save();
  if (!realSocket) {
    // a few runs from the gum edge: curved, tapering chains of soft blood stamps (no stroked "lollipops")
    const inx = -D.dir[0], iny = -D.dir[1], px = -iny, py = inx;
    for (let i = 0; i < 3; i++) {
      const s0 = (i / 2 - 0.5) * (x1 - x0) * 0.6 + rand(-3, 3) * u;
      let x = D.tip[0] + px * s0 - inx * 4 * u, y = D.tip[1] + py * s0 - iny * 4 * u;
      const len = rand(8, 22) * u, w0 = rand(2.2, 3.4) * u, bend = rand(-0.5, 0.5), n = Math.ceil(len / (0.9 * u));
      for (let k = 0; k <= n; k++) {
        const t = k / n, r = w0 * (1 - 0.65 * t) * (t > 0.85 ? 1.15 : 1); // slightly heavier bead at the end
        c.globalAlpha = 0.55 * (1 - 0.5 * t);
        c.drawImage(SPR.blood, x - r, y - r, r * 2, r * 2);
        const sw = Math.sin(t * 3 + i) * bend * 0.35;
        x += (inx + px * sw) * (len / n); y += (iny + py * sw) * (len / n);
      }
    }
  }
  const nSpl = realSocket ? 5 : 10, rs = realSocket ? 0.75 : 1.1, ss = realSocket ? 3.5 : 5;
  for (let i = 0; i < nSpl; i++) { const a = rand(0, TAU), r = rand(0.5, rs) * Math.max(x1 - x0, y1 - y0) * 0.6; c.globalAlpha = realSocket ? 0.35 : 0.45; const x = D.c[0] + Math.cos(a) * r, y = D.c[1] + Math.sin(a) * r; c.drawImage(SPR.blood, x - ss * u, y - ss * u, ss * 2 * u, ss * 2 * u); }
  c.restore();
  grow(L.blood, x0 - 40 * u, y0 - 40 * u, x1 + 40 * u, y1 + 60 * u);
  L.blood.sync(); // one-off read of the fresh blood (clipped stamps) onto the progress grid
  D.bloodRegion.setInitial();
  for (let i = 0; i < 16; i++) addPart({ k: 'blood', x: D.c[0], y: D.c[1], vx: rand(-80, 80) * u, vy: rand(-90, 30) * u, life: rand(0.5, 1), t: 0, s: rand(1, 2.4) * u });
  step(D.c[0], D.c[1]);
  hint('Зуб удалён. Смой кровь водой', 'good');
}

/* ---------- fly ---------- */
// landing spots: teeth, but never the dead tooth / its empty socket (until the new tooth is in)
function flyPts() {
  const D = G.L.tooth;
  if (!D || D.state === 'implanted') return G.teethPts;
  if (!D.flyPts) D.flyPts = G.teethPts.filter((q) => !pointInPoly(q[0], q[1], D.poly));
  return D.flyPts.length ? D.flyPts : G.teethPts;
}
function spawnFly() {
  const L = G.L, u = G.u;
  const pts = flyPts(); if (!pts.length) return;
  const tgt = pick(pts);
  const [lx0, ly0] = toBase(0, 0), [lx1, ly1] = toBase(W, H);
  const side = (Math.random() * 4) | 0;
  const sx = side === 0 ? lx0 - 30 : side === 1 ? lx1 + 30 : rand(lx0, lx1);
  const sy = side === 2 ? ly0 - 30 : side === 3 ? ly1 + 30 : rand(ly0, ly1);
  L.fly = { state: 'in', x: sx, y: sy, tx: tgt[0], ty: tgt[1], ang: 0, life: CFG.flyLife, t: 0, vx: 0, vy: 0, moving: false, wait: 0.5 };
  void u;
}
function shooFly() {
  const L = G.L, f = L.fly; if (!f) return;
  f.state = 'out'; const a = rand(0, TAU); f.vx = Math.cos(a) * 500 * G.u; f.vy = Math.sin(a) * 500 * G.u - 200 * G.u;
  addScore(CFG.score.fly, f.x, f.y, '#ffd166'); f.shooed = true; S.stop('fly'); S.play('buzzshort', { pan: flyPan(f) }); S.play('whoosh', { volume: 0.6 });
  hint('Кыш! Муха прогнана', 'good');
}
function flyPan(f) { return clamp((toLogical(f.x, f.y)[0] - W / 2) / (W / 2), -1, 1); }
function updateFly(dt) {
  const L = G.L;
  if (!L.fly) {
    L.flyT -= dt;
    if (L.flyT <= 0 && L.winT < 0) spawnFly();
    return;
  }
  const f = L.fly, u = G.u; f.t += dt;
  if (f.state === 'in') {
    const dx = f.tx - f.x, dy = f.ty - f.y, d = Math.hypot(dx, dy);
    const sp = 260 * u, wob = Math.sin(f.t * 9) * 0.9;
    const a = Math.atan2(dy, dx) + wob * Math.min(1, d / (80 * u));
    f.x += Math.cos(a) * sp * dt; f.y += Math.sin(a) * sp * dt; f.ang = a;
    S.need('fly', { intensity: 1, pan: flyPan(f) });
    if (d < 6 * u) {
      f.state = 'sit'; f.x = f.tx; f.y = f.ty;
      releaseAll(); // the fly blocks every working tool, including a drag already in progress
      Stream.play('fly', LINES.fly);
      hint('Муха! Тапни по ней любым инструментом', 'warn');
    }
  } else if (f.state === 'sit') {
    f.life -= dt;
    S.need('fly', { intensity: f.moving ? 0.35 : 0.2, pan: flyPan(f) });
    f.wait -= dt;
    if (f.moving) {
      const dx = f.tx - f.x, dy = f.ty - f.y, d = Math.hypot(dx, dy);
      const ta = Math.atan2(dy, dx);
      let da = ta - f.ang; while (da > Math.PI) da -= TAU; while (da < -Math.PI) da += TAU;
      f.ang += clamp(da, -6 * dt, 6 * dt);
      const sp = 22 * u;
      if (d < 1.5 * u) { f.moving = false; f.wait = rand(0.4, 1.6); }
      else { f.x += Math.cos(f.ang) * sp * dt; f.y += Math.sin(f.ang) * sp * dt; }
    } else if (f.wait <= 0) {
      // crawl to a nearby tooth point
      const near = flyPts().filter((p) => Math.abs(p[0] - f.x) < 16 * u && Math.abs(p[1] - f.y) < 16 * u);
      const n = near.length ? pick(near) : [f.x + rand(-6, 6) * u, f.y + rand(-6, 6) * u];
      f.tx = n[0]; f.ty = n[1]; f.moving = true;
    }
    if (f.life <= 0) {
      f.state = 'out'; const a = rand(0, TAU); f.vx = Math.cos(a) * 300 * u; f.vy = Math.sin(a) * 300 * u - 120 * u;
      addPain(CFG.flyPain, true);
      hint('Муха улетела сама. Пациенту неприятно', 'bad');
    }
  } else if (f.state === 'out') {
    f.vx *= 1 + dt; f.vy *= 1 + dt;
    f.x += f.vx * dt; f.y += f.vy * dt + Math.sin(f.t * 20) * 2 * u;
    f.ang = Math.atan2(f.vy, f.vx);
    const [lx, ly] = toLogical(f.x, f.y);
    if (lx < -200 || lx > W + 200 || ly < -200 || ly > H + 200) { L.fly = null; L.flyT = rand(CFG.flyMin, CFG.flyMax); }
    else if (!f.shooed) S.need('fly', { intensity: 1, pan: flyPan(f) }); // a shooed fly uses the buzzshort one-shot
  }
}

/* ---------- flinch / end ---------- */
function flinch() {
  const L = G.L;
  L.lives--; L.flinches++; L.pain = CFG.flinchReset; L.shake = 0.6; L.vig = 1; L.invuln = CFG.invuln;
  addScore(CFG.score.flinch);
  S.play('thud'); S.play('fail');
  releaseAll();
  updateLives();
  Stream.play('pain', LINES.flinch);
  if (L.lives <= 0) { L.over = true; later(() => { if (G.L === L && G.screen === 'play') lose('fled'); }, 700); }
  else hint(L.lives === 1 ? 'Последний шанс! Сделай анестезию' : 'Пациент дёрнулся! Сделай анестезию шприцем', 'bad');
}
function releaseAll() {
  const L = G.L; if (!L) return;
  for (const p of L.probs) if (p.type === 'food' && p.state === 'held') p.state = 'back';
  const D = L.tooth;
  if (D && D.grab) { if (D.state === 'pulled') throwTooth(); else D.grab = false; }
  L.impDrag = false;
  P.consumed = true;
  S.stopTools();
}
function throwTooth() {
  const D = G.L.tooth;
  D.grab = false; D.state = 'extracted';
  D.flyAway = { x: D.off[0], y: D.off[1], vx: clamp(P.vx, -900, 900) * 0.5, vy: Math.min(-120 * G.u, clamp(P.vy, -900, 900) * 0.5), vr: rand(-8, 8), r: D.rot, a: 1 };
}

/* ======================================================================
   input
   ====================================================================== */
// continuous touch tools work a little above the finger, so the finger does not hide the spot
// (and the progress ring). Taps and grabs (syringe, filling, tweezers, forceps, implant) stay under it.
const LIFT_TOOLS = { scaler: 1, brush: 1, water: 1, suction: 1, drill: 1, lamp: 1 };
function touchLift() { return P.type === 'touch' && LIFT_TOOLS[G.tool] ? clamp(46 / G.k, 44, 110) : 0; }
function setPtr(e) {
  // stage origin and scale are cached in resize(): no layout read on every pointermove
  P.fx = (e.clientX - G.ox) / G.k - G.cox; P.fy = (e.clientY - G.oy) / G.k;
  P.x = P.fx; P.y = P.fy - touchLift();
  const [bx, by] = toBase(P.x, P.y);
  const now = performance.now() / 1000, dtv = Math.max(0.001, now - P.lt);
  if (P.lt) { P.vx = lerp(P.vx, (bx - P.bx) / dtv, 0.5); P.vy = lerp(P.vy, (by - P.by) / dtv, 0.5); }
  P.lt = now; P.bx = bx; P.by = by;
}
// the pointer went away without a proper pointerup (system gesture, lost capture, window blur):
// no flush and no coordinates (pointercancel has none), just drop whatever was held
function cancelPointer() {
  if (!P.down) return;
  P.down = false; P.path = [];
  if (P.type !== 'mouse') P.inside = false;
  if (G.L) releaseAll(); else S.stopTools();
}
cv.addEventListener('pointerdown', (e) => {
  if (e.pointerType === 'mouse' && e.button !== 0) return; // right / middle click do nothing
  S.unlock();
  if (P.down && e.pointerId !== P.id) {
    if (!e.isPrimary) return; // a second finger
    cancelPointer(); // a new primary pointer while the old one is still "down": its up/cancel was lost
  }
  try { cv.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
  P.id = e.pointerId; P.type = e.pointerType || 'mouse'; P.lt = 0; setPtr(e); P.vx = P.vy = 0;
  P.down = true; P.inside = true; P.path = [[P.bx, P.by]]; P.sx = P.bx; P.sy = P.by;
  onDown();
  e.preventDefault();
});
cv.addEventListener('pointermove', (e) => {
  if (P.down && e.pointerId !== P.id) return;
  P.type = e.pointerType || P.type; setPtr(e); P.inside = true;
  if (P.down) { P.path.push([P.bx, P.by]); onMove(); }
});
cv.addEventListener('pointerup', (e) => {
  if (e.pointerId !== P.id || !P.down) return;
  setPtr(e);
  // flush a stroke that started and ended between two frames (fast flicks)
  if (P.path.length > 1 && G.screen === 'play' && G.L && !G.paused) { P.path.push([P.bx, P.by]); try { toolUpdate(1 / 60); } catch (err) { console.error(err); } }
  P.down = false; onUp(); if (P.type !== 'mouse') P.inside = false;
});
cv.addEventListener('pointercancel', (e) => { if (e.pointerId === P.id) cancelPointer(); });
cv.addEventListener('lostpointercapture', (e) => { if (e.pointerId === P.id) cancelPointer(); });
window.addEventListener('blur', () => cancelPointer());
cv.addEventListener('pointerleave', () => { if (!P.down) P.inside = false; });
cv.addEventListener('contextmenu', (e) => e.preventDefault());
window.addEventListener('keydown', (e) => {
  if (e.repeat) return; // holding a tool key must not toggle it on and off
  const onBtn = e.target && e.target.tagName === 'BUTTON'; // a focused button handles Space / Enter itself
  if (G.screen !== 'play') { if ((e.key === 'Enter' || e.key === ' ') && G.screen === 'title' && G.ready && !onBtn) { e.preventDefault(); startGame(); } return; }
  const i = TOOL_KEYS.indexOf(e.key);
  if (i >= 0 && TOOL_ORDER[i]) { selectTool(TOOL_ORDER[i]); e.preventDefault(); }
  else if (e.key === 'Escape') selectTool(null);
});
document.addEventListener('visibilitychange', () => updatePaused());

function onDown() {
  if (G.screen !== 'play' || !G.L || G.L.over) return;
  const L = G.L, u = G.u;
  P.consumed = false;
  const f = L.fly;
  if (f && (f.state === 'sit' || f.state === 'in')) {
    const [fbx, fby] = toBase(P.fx, P.fy); // the finger itself counts too, not only the lifted tool tip
    if (dist(P.bx, P.by, f.x, f.y) < 26 * u || dist(fbx, fby, f.x, f.y) < 26 * u) { shooFly(); P.consumed = true; return; }
  }
  const t = G.tool;
  if (!t) { hintCD('notool', 'Выбери инструмент в лотке слева', 'warn', 2); P.consumed = true; return; }
  if (flyActive()) { hintCD('flyblock', 'Муха мешает! Сначала прогони её тапом', 'warn', 2); P.consumed = true; return; }
  if (t === 'syringe') { inject(); P.consumed = true; }
  else if (t === 'filling') { fillTap(); P.consumed = true; }
  else if (t === 'tweezers') grabFood();
  else if (t === 'forceps') grabTooth();
  else if (t === 'implant') startImplant();
}
function onMove() {
  if (G.screen !== 'play' || !G.L || G.L.over || G.paused || P.consumed || flyActive()) return;
  const L = G.L, u = G.u;
  if (G.tool === 'tweezers') {
    const f = L.probs.find((p) => p.type === 'food' && p.state === 'held');
    if (f) { f.x = P.bx + f.gx; f.y = P.by + f.gy; f.rot = f.rot0 + Math.sin(L.t * 9) * 0.15; }
  }
  const D = L.tooth;
  if (G.tool === 'forceps' && D && D.grab) {
    const dx = P.bx - D.gx, dy = P.by - D.gy;
    if (D.state === 'dead' || D.state === 'loose') {
      // wiggle: count left-right reversals along the jaw tangent
      const tx = -D.dir[1], ty = D.dir[0];
      const lat = dx * tx + dy * ty, pull = -(dx * D.dir[0] + dy * D.dir[1]);
      D.rot = clamp(lat / (26 * u), -1, 1) * (0.1 + 0.18 * D.loosen);
      D.off = [tx * clamp(lat, -3, 3) * u * 0.4, ty * clamp(lat, -3, 3) * u * 0.4];
      if (Math.abs(lat) > 5 * u) {
        const s = Math.sign(lat);
        if (s !== D.sgn) {
          if (D.sgn !== 0) { D.rev++; S.play('squeak'); if (D.rev % 2 === 0) addPart({ k: 'blood', x: D.root[0], y: D.root[1], vx: rand(-30, 30) * u, vy: rand(-20, 30) * u, life: 0.6, t: 0, s: 1.2 * u }); }
          D.sgn = s;
          D.loosen = Math.min(1, D.rev / 6);
          if (D.loosen >= 1 && D.state === 'dead') { D.state = 'loose'; hint(`Шатается! Теперь тяни ${pullWord(D)}`, 'good'); }
        }
      }
      const pd = Math.hypot(dx, dy);
      // out of the socket = toward the mouth centre or sideways; straight into the gum/root does nothing
      if (D.state === 'loose' && pd > 28 * u && pull > -0.5 * pd) extractTooth();
      else if (D.state === 'loose' && pd > 25 * u) hintCD('pullDir', `Не в десну! Тяни ${pullWord(D)}`, 'warn', 2.5);
      else if (D.state === 'dead' && pull > 22 * u) hintCD('wig2', 'Не тянется. Сначала раскачай влево-вправо', 'warn', 2.5);
    }
    if (D.state === 'pulled') { D.off = [dx, dy]; D.rot = lerp(D.rot, clamp(dx / (40 * u), -0.6, 0.6), 0.2); }
  }
}
function pullWord(D) { return -D.dir[1] > 0.5 ? 'вниз, к языку' : -D.dir[1] < -0.5 ? 'вверх, к языку' : 'к центру рта'; }
function onUp() {
  if (!G.L) return;
  const L = G.L, u = G.u;
  // the level ended (or a fly sits) while something was held: just let go, no scoring behind the end card
  if (G.screen !== 'play' || L.over || flyActive()) { releaseAll(); return; }
  const f = L.probs.find((p) => p.type === 'food' && p.state === 'held');
  if (f) {
    if (!inMouth(f.x, f.y)) {
      f.state = 'gone'; f.vy = -60 * u; f.vx = P.vx * 0.3; S.play('whoosh', { volume: 0.5 });
      step(f.x, f.y); completeProblem(f, f.x, f.y);
    } else { f.state = 'back'; hintCD('foodin', 'Вынеси еду за пределы рта', 'warn', 2.5); }
  }
  const D = L.tooth;
  if (D && D.grab) {
    if (D.state === 'pulled') throwTooth();
    else { D.grab = false; }
  }
  if (L.impDrag && D) {
    L.impDrag = false;
    const near = dist(P.bx, P.by, D.c[0], D.c[1]) < 34 * u || pointInPoly(P.bx, P.by, D.poly);
    if (near) {
      if (D.state === 'clean') { D.state = 'implanted'; D.snap = 0; D.dropAt = [P.bx - D.c[0], P.by - D.c[1]]; S.play('thud'); step(D.c[0], D.c[1]); completeProblem(D, D.c[0], D.c[1]); }
      else if (D.state === 'extracted' || D.state === 'pulled') orderError('Сначала смой кровь из лунки водой');
      else if (D.state === 'dead' || D.state === 'loose') orderError('Сначала удали мёртвый зуб щипцами');
    } else if (D.state === 'clean') hintCD('impmiss', 'Отпусти новый зуб прямо над лункой', 'warn', 2);
  }
  S.stopTools();
}

/* ---------- tool selection ---------- */
function selectTool(id) {
  if (id && !TOOL_INFO[id]) return;
  if (G.L && G.L.impDrag) G.L.impDrag = false;
  if (G.L && G.L.tooth && G.L.tooth.grab && G.L.tooth.state !== 'pulled') G.L.tooth.grab = false;
  if (G.L) for (const p of G.L.probs) if (p.type === 'food' && p.state === 'held') p.state = 'back';
  G.tool = id === G.tool ? null : id;
  S.stopTools();
  if (G.tool) S.play('pick'); else S.play('click');
  refreshTray();
}

/* ======================================================================
   update
   ====================================================================== */
function toolUpdate(dt) {
  const L = G.L, u = G.u, t = G.tool;
  const path = P.path; P.path = P.down ? [[P.bx, P.by]] : [];
  L.lampOn = false;
  const snd = L.snd || (L.snd = { speed: 0, lastMove: -1, load: 0 });
  if (!P.down || !t || P.consumed || L.over || G.paused) { snd.speed = 0; snd.load = 0; snd.lastMove = -1; return; }
  if (flyActive()) { hintCD('flyblock', 'Муха мешает! Сначала прогони её тапом', 'warn', 2.5); return; }
  const eff = L.saliva > CFG.salivaSlow ? 0.5 : 1;
  let moved = 0;
  for (let i = 1; i < path.length; i++) moved += dist(path[i - 1][0], path[i - 1][1], path[i][0], path[i][1]);
  // pointer speed for the scrape / brush loops: smoothed, and kept alive briefly between move events
  if (moved > 0.4 * u) { snd.lastMove = L.t; snd.speed = lerp(snd.speed, clamp(moved / Math.max(dt, 1 / 120) / (500 * u), 0, 1), 0.35); }
  else snd.speed *= Math.pow(0.02, dt);
  const strokeOn = snd.lastMove >= 0 && L.t - snd.lastMove < 0.16;
  const each = (sp, cb) => {
    if (path.length < 2) return;
    for (let i = 1; i < path.length; i++) {
      const [ax, ay] = path[i - 1], [bx, by] = path[i], l = dist(ax, ay, bx, by), n = Math.max(1, Math.ceil(l / sp));
      for (let k = 1; k <= n; k++) cb(lerp(ax, bx, k / n), lerp(ay, by, k / n));
    }
  };
  if (t === 'scaler') {
    const tar = L.probs.filter((p) => p.type === 'tartar' && !p.done);
    let on = false;
    if (moved > 0.4 * u) { // sample before erasing: are we actually scraping crust?
      const mid = path[(path.length / 2) | 0];
      for (const p of tar) if (alphaAt(p.layer, P.bx, P.by) > 30 || alphaAt(p.layer, mid[0], mid[1]) > 30) on = true;
    }
    each(2.5 * u, (x, y) => { for (const p of tar) { erase(p.layer, x, y, 13 * u, 0.38 * eff); } });
    if (strokeOn) S.need('scrape', { speed: clamp(snd.speed * (on ? 1 : 0.6), 0.08, 1) });
    if (moved > 0.4 * u) {
      if (on) {
        addPain(CFG.pain.scaler * dt);
        if (Math.random() < 0.7) addPart({ k: 'crumb', x: P.bx, y: P.by, vx: rand(-70, 70) * u, vy: rand(-80, 0) * u, life: rand(0.6, 1.1), t: 0, s: rand(0.9, 2) * u, r: rand(0, TAU), vr: rand(-12, 12), c: pick(['#c9a35a', '#a77f3f', '#8a6430', '#d8bc80']) });
        if (eff < 1) hintCD('salslow', 'Слюни мешают! Скребок работает вдвое хуже', 'warn', 5);
      }
    }
  } else if (t === 'brush') {
    const pl = L.probs.filter((p) => p.type === 'plaque' && !p.cleared);
    let fa = 0;
    each(3 * u, (x, y) => {
      for (const p of pl) erase(p.layer, x, y, 18 * u, 0.3);
      fa += 3;
      if (pl.length && fa > 7 * u && inMouth(x, y)) { // no new foam once the plaque is brushed off
        fa = 0;
        if (L.foamImg) stampImage(L.foam, L.foamImg, x, y, 14 * u, 0.9);
        else stamp(L.foam, SPR.foam, x + rand(-5, 5) * u, y + rand(-5, 5) * u, rand(6, 10) * u, rand(0.5, 0.85), rand(0, TAU));
      }
    });
    if (strokeOn) S.need('brush', { speed: clamp(0.25 + snd.speed, 0.1, 1) });
    if (moved > 0.4 * u) {
      if (Math.random() < 0.4) addPart({ k: 'foam', x: P.bx + rand(-6, 6) * u, y: P.by + rand(-6, 6) * u, vx: rand(-15, 15) * u, vy: rand(-30, -5) * u, life: rand(0.5, 1), t: 0, s: rand(1, 2.6) * u });
    }
  } else if (t === 'water') {
    const a = Math.min(1, 0.17 * dt * 60);
    const wash = (x, y) => { erase(L.foam, x, y, 25 * u, a); erase(L.dust, x, y, 26 * u, a); erase(L.blood, x, y, 23 * u, a * 0.85); };
    wash(P.bx, P.by); each(6 * u, wash);
    L.saliva = Math.min(1, L.saliva + CFG.waterSaliva * dt);
    S.need('water', { intensity: 1 });
    for (let i = 0; i < 4; i++) addPart({ k: 'drop', x: P.bx + rand(-3, 3) * u, y: P.by + rand(-3, 3) * u, vx: rand(-110, 110) * u, vy: rand(-150, 20) * u, life: rand(0.35, 0.7), t: 0, s: rand(0.7, 1.7) * u });
  } else if (t === 'suction') {
    S.need('suction', { wet: clamp(0.2 + L.saliva, 0, 1) });
    const pc = G.puddle, k = 1.6 + L.saliva;
    const ex = (P.bx - pc.c[0]) / (pc.r[0] * k), ey = (P.by - pc.c[1]) / (pc.r[1] * k + 20 * u);
    if (ex * ex + ey * ey < 1 && L.saliva > 0) {
      const before = L.saliva;
      L.saliva = Math.max(0, L.saliva - CFG.suction * dt);
      if (before > 0.04 && L.saliva <= 0.04) { S.play('spit'); hint('Сухо и чисто', 'good'); }
      if (Math.random() < 0.8) { const a = rand(0, TAU), r = rand(10, 24) * u; addPart({ k: 'suck', x: P.bx + Math.cos(a) * r, y: P.by + Math.sin(a) * r, tx: P.bx, ty: P.by, life: 0.35, t: 0, s: rand(0.8, 1.6) * u }); }
    } else hintCD('suckmiss', 'Слюноотсос работает в лужице слюны', 'warn', 3.5);
  } else if (t === 'drill') {
    const c = cavityAt(P.bx, P.by, 1.9);
    let load = 0;
    if (c && c.state === 'decay') {
      load = 1;
      c.drill = Math.min(1, c.drill + (dt / CFG.drillTime) * eff);
      erase(c.layer, c.x + rand(-2, 2) * u, c.y + rand(-2, 2) * u, c.r * 1.25, dt * 1.6 * eff);
      addPain(CFG.pain.drill * dt);
      if (Math.random() < 0.5) { const a = rand(0, TAU), r = rand(0.3, 1.2) * c.r; stamp(L.dust, SPR.dust, c.x + Math.cos(a) * r, c.y + Math.sin(a) * r, rand(0.4, 0.8) * c.r, rand(0.35, 0.7)); }
      if (Math.random() < 0.6) addPart({ k: 'dust', x: c.x + rand(-3, 3) * u, y: c.y + rand(-3, 3) * u, vx: rand(-40, 40) * u, vy: rand(-50, 10) * u, life: rand(0.5, 1.1), t: 0, s: rand(2, 5) * u });
      if (eff < 1) hintCD('salslow2', 'Слюни мешают! Бор работает вдвое хуже', 'warn', 5);
      if (c.drill >= 1) {
        c.state = 'drilled'; c.layer.clear();
        for (let i = 0; i < 6; i++) { const a = rand(0, TAU), r = rand(0.2, 1.1) * c.r; stamp(L.dust, SPR.dust, c.x + Math.cos(a) * r, c.y + Math.sin(a) * r, rand(0.6, 0.9) * c.r, 0.7); }
        c.dustRegion.setInitial();
        step(c.x, c.y);
        hint('Рассверлено! Смой пыль водой', 'good');
      }
    } else if (c && moved < 0.01 && cool('drillx', 3)) {
      if (c.state === 'drilled') hint('Уже рассверлено. Смой пыль водой', 'warn');
      else if (c.state === 'clean') hint('Полость готова, ставь пломбу', 'warn');
    }
    // motor bogs down smoothly when the bur bites and spins back up when lifted
    snd.load = lerp(snd.load, load, 1 - Math.pow(load > snd.load ? 0.0005 : 0.02, dt));
    S.need('drill', { load: +snd.load.toFixed(3), wet: c && c.state === 'decay' ? 0.3 : 0 });
  } else if (t === 'lamp') {
    L.lampOn = true;
    S.need('lamp', {});
    const c = cavityAt(P.bx, P.by, 2.4);
    if (c && c.state === 'filled') {
      c.cure = Math.min(1, c.cure + dt / CFG.cureTime);
      if (c.cure >= 1) {
        c.state = 'cured'; c.anim = 0; S.play('beep', { n: 2 }); step(c.x, c.y);
        for (let i = 0; i < 10; i++) spark(c.x, c.y);
        completeProblem(c, c.x, c.y);
      }
    } else if (c && cool('lampx', 3)) {
      if (c.state === 'decay' || c.state === 'drilled' || c.state === 'clean') orderError('Лампа нужна для пломбы. Сначала поставь её');
    }
  }
}

function measure(dt) {
  const L = G.L;
  L.measureT -= dt;
  if (L.measureT > 0) return;
  L.measureT = 0.12;
  for (const p of L.probs) {
    if (p.done) continue;
    if (p.type === 'tartar') {
      p.region.measure();
      if (p.region.frac <= CFG.done.tartar) { p.layer.fade = true; const [x, y] = regionC(p.region); completeProblem(p, x, y); }
    } else if (p.type === 'plaque') {
      if (!p.cleared) {
        p.region.measure();
        if (p.region.frac <= CFG.done.plaque) {
          p.cleared = true; p.layer.fade = true;
          const [x, y] = regionC(p.region); step(x, y);
          p.foamRegion.setInitial();
          if (p.foamRegion.init < 8 * 255) completeProblem(p, x, y);
          else hint('Налёт счищен! Смой пену водой', 'good');
        }
      } else {
        p.foamRegion.measure();
        if (p.foamRegion.frac <= CFG.done.foam) { const [x, y] = regionC(p.foamRegion); completeProblem(p, x, y); }
      }
    } else if (p.type === 'cavity' && p.state === 'drilled') {
      p.dustRegion.measure();
      if (p.dustRegion.frac <= CFG.done.dust) { p.state = 'clean'; wipe(L.dust, p.x, p.y, p.r * 3.2, p.r * 3.2); step(p.x, p.y); hint('Полость чистая. Ставь пломбу', 'good'); }
    } else if (p.type === 'dead' && (p.state === 'extracted' || p.state === 'pulled')) {
      p.bloodRegion.measure();
      if (p.state === 'extracted' && p.bloodRegion.frac <= CFG.done.blood) {
        p.state = 'clean'; const b = polyBB(p.poly);
        wipe(L.blood, (b[0] + b[2]) / 2, (b[1] + b[3]) / 2 + 10 * G.u, (b[2] - b[0]) / 2 + 46 * G.u, (b[3] - b[1]) / 2 + 58 * G.u);
        step(p.c[0], p.c[1]); hint('Лунка чистая. Ставь новый зуб', 'good');
      }
    }
  }
}
// the allowed leftovers of a finished step (last dust / blood) dissolve over ~0.5 s
function wipe(layer, x, y, rx, ry) { G.L.wipes.push({ layer, x, y, rx, ry, t: 0.5 }); }
function runWipes(dt) {
  const L = G.L;
  for (let i = L.wipes.length - 1; i >= 0; i--) {
    const w = L.wipes[i]; w.t -= dt;
    const a = w.t <= 0 ? 1 : Math.min(1, dt * 6), ly = w.layer;
    if (!ly.empty) {
      const c = ly.c.x; c.save(); c.globalCompositeOperation = 'destination-out'; c.globalAlpha = a;
      c.translate(w.x, w.y); c.scale(w.rx, w.ry);
      const g = c.createRadialGradient(0, 0, 0, 0, 0, 1); g.addColorStop(0, '#000'); g.addColorStop(0.8, '#000'); g.addColorStop(1, 'rgba(0,0,0,0)');
      c.fillStyle = g; c.beginPath(); c.arc(0, 0, 1, 0, TAU); c.fill(); c.restore();
      const sg = ly.g; cells(ly, w.x, w.y, w.rx, w.ry, (k, t) => { sg[k] *= 1 - a * PROF.wipe(t); }); ly.ver++;
    }
    if (w.t <= 0) L.wipes.splice(i, 1);
  }
}
function regionC(r) { if (!r.bb) return mouthC(); return [r.bb[0] + r.bb[2] / 2, r.bb[1] + r.bb[3] / 2]; }

function update(dt) {
  const L = G.L;
  G.time += dt;
  if (G.screen !== 'play' || !L || G.paused) { S.sync(G.time); return; } // paused: rotate overlay / hidden tab
  L.t += dt;
  const u = G.u;
  if (!L.over && L.winT < 0) {
    L.time -= dt;
    const sec = Math.ceil(L.time);
    if (sec <= 10 && sec !== L.tickS && sec > 0) { L.tickS = sec; S.play('tick'); }
    if (L.time <= 0) { L.time = 0; L.over = true; lose('time'); return; }
  }
  L.anest = Math.max(0, L.anest - dt);
  L.invuln = Math.max(0, L.invuln - dt);
  L.pain = Math.max(0, L.pain - CFG.painDecay * dt);
  L.saliva = Math.min(1, L.saliva + dt / CFG.salivaFill);
  if (L.saliva > CFG.salivaSlow && !L.salHint) { L.salHint = true; hint('Слюни! Возьми слюноотсос: скребок и бор работают хуже', 'warn'); }
  if (L.saliva < CFG.salivaSlow - 0.1) L.salHint = false;
  L.shake = Math.max(0, L.shake - dt);
  L.vig = Math.max(0, L.vig - dt * 1.3);

  // once the level is decided (fatal flinch, time out) only particles / HUD keep running
  if (!L.over) { updateFly(dt); toolUpdate(dt); measure(dt); }
  runWipes(dt);

  // layers fading after completion
  for (const ly of [L.foam, ...L.probs.map((p) => p.layer).filter(Boolean)]) if (ly.fade) { ly.alpha -= dt * 2.5; if (ly.alpha <= 0) ly.clear(); }

  // food anim
  for (const p of L.probs) if (p.type === 'food') {
    if (p.state === 'back') { p.x = lerp(p.x, p.hx, Math.min(1, dt * 10)); p.y = lerp(p.y, p.hy, Math.min(1, dt * 10)); p.rot = lerp(p.rot, p.rot0, dt * 10); if (dist(p.x, p.y, p.hx, p.hy) < 0.5) { p.state = 'stuck'; p.x = p.hx; p.y = p.hy; } }
    else if (p.state === 'gone') { p.vy += 900 * u * dt; p.x += (p.vx || 0) * dt; p.y += p.vy * dt; p.rot += dt * 4; p.a = Math.max(0, p.a - dt * 1.4); }
  }
  // tooth anim
  const D = L.tooth;
  if (D) {
    if (!D.grab && (D.state === 'dead' || D.state === 'loose')) { D.rot *= Math.pow(0.0005, dt); D.off[0] *= Math.pow(0.001, dt); D.off[1] *= Math.pow(0.001, dt); }
    if (D.state === 'loose' && !D.grab) D.rot += Math.sin(L.t * 30) * 0.004;
    if (D.flyAway) { const f = D.flyAway; f.vy += 1100 * u * dt; f.x += f.vx * dt; f.y += f.vy * dt; f.r += f.vr * dt; f.a -= dt * 0.9; if (f.a <= 0) D.flyAway = null; }
    if (D.state === 'implanted') D.snap = Math.min(1, D.snap + dt * 5);
  }
  for (const p of L.probs) if (p.type === 'cavity') p.anim = Math.min(1, p.anim + dt * 5);

  // particles
  const g = 700 * u;
  for (let i = L.parts.length - 1; i >= 0; i--) {
    const q = L.parts[i]; q.t += dt;
    if (q.t >= q.life) { L.parts.splice(i, 1); continue; }
    if (q.k === 'suck') { const k = q.t / q.life; q.x = lerp(q.x, q.tx, k * 0.5); q.y = lerp(q.y, q.ty, k * 0.5); continue; }
    if (q.k === 'dust' || q.k === 'foam') { q.x += q.vx * dt; q.y += q.vy * dt; q.vx *= 0.96; q.vy *= 0.96; continue; }
    q.vy += (q.k === 'spark' ? g * 0.3 : g) * dt; q.x += q.vx * dt; q.y += q.vy * dt;
    if (q.r !== undefined) q.r += q.vr * dt;
  }
  for (let i = L.pops.length - 1; i >= 0; i--) { const q = L.pops[i]; q.t += dt; if (q.t > 1.1) L.pops.splice(i, 1); }

  // flinch
  if (!L.over && L.winT < 0 && L.pain >= 100 && L.invuln <= 0) flinch();
  // win
  if (L.winT > 0 && !L.over) { L.winT -= dt; if (L.winT <= 0) { L.over = true; win(); } }
  S.sync(G.time);
  updateHUD();
}

/* ======================================================================
   render
   ====================================================================== */
function render() {
  if (G.screen === 'title' || G.screen === 'loading') return; // opaque screens cover the canvas
  const c = ctx, cs = G.cs;
  c.setTransform(cs, 0, 0, cs, 0, 0);
  c.fillStyle = '#0b1016'; c.fillRect(0, 0, W, H);
  if (!G.base) return;
  const L = G.L;
  let sx = 0, sy = 0;
  if (L && L.shake > 0) { const k = L.shake / 0.6; sx = (Math.random() - 0.5) * 26 * k; sy = (Math.random() - 0.5) * 18 * k; }
  c.save();
  c.translate(G.view.ox + sx, G.view.oy + sy); c.scale(G.view.s, G.view.s);
  c.imageSmoothingEnabled = true; c.imageSmoothingQuality = 'high';
  if (G.baseDraw) c.drawImage(G.baseDraw, 0, 0, G.BW, G.BH); else c.drawImage(G.base, 0, 0);
  if (L) drawScene(c);
  c.restore();
  if (L && G.screen === 'play') drawOverlay(c);
}
function drawScene(c) {
  const L = G.L, u = G.u, t = G.time;
  const D = L.tooth;
  // socket + tooth in place
  if (D) {
    const moved = D.state !== 'dead' || D.grab || Math.abs(D.rot) > 0.002;
    if (moved) c.drawImage(D.socket.c, D.socket.ox, D.socket.oy);
    if (D.state === 'dead' || D.state === 'loose') drawToothSpr(c, D, D.off[0], D.off[1], D.rot, 1);
    if (D.state === 'implanted') {
      const k = D.snap, e = 1 - Math.pow(1 - k, 3);
      const ox = D.dropAt ? D.dropAt[0] * (1 - e) : 0, oy = D.dropAt ? D.dropAt[1] * (1 - e) : 0;
      const im = D.imp, sc = 1 + (1 - e) * 0.15;
      c.save(); c.translate(im.cx + ox, im.cy + oy); c.scale(sc, sc);
      c.drawImage(im.c, -im.tw / 2, -im.th / 2, im.tw, im.th); c.restore();
    }
  }
  // cavities: holes / fillings
  for (const p of L.probs) if (p.type === 'cavity') drawCavity(c, p);
  for (const p of L.probs) if (p.type === 'cavity') p.layer.draw(c);
  for (const p of L.probs) if (p.type === 'plaque') p.layer.draw(c);
  for (const p of L.probs) if (p.type === 'tartar') p.layer.draw(c);
  L.foam.draw(c); L.dust.draw(c); L.blood.draw(c);
  if (D && D.state === 'pulled') drawToothSpr(c, D, D.off[0], D.off[1], D.rot, 1, true);
  if (D && D.flyAway) drawToothSpr(c, D, D.flyAway.x, D.flyAway.y, D.flyAway.r, Math.max(0, D.flyAway.a), true);
  // food
  for (const p of L.probs) if (p.type === 'food' && p.a > 0) {
    c.save(); c.globalAlpha = p.a; c.translate(p.x, p.y); c.rotate(p.rot);
    if (p.state === 'held') { c.shadowColor = 'rgba(0,0,0,.35)'; c.shadowBlur = 6 * u; c.shadowOffsetY = 4 * u; }
    c.drawImage(p.img, -p.w / 2, -p.h / 2, p.w, p.h); c.restore();
  }
  drawPuddle(c, t);
  // progress rings
  for (const p of L.probs) if (p.type === 'cavity') {
    if (p.state === 'decay' && p.drill > 0) ring(c, p.x, p.y, p.r * 2.1, p.drill, '#ffd166', Math.round(p.drill * 100) + '%');
    if (p.state === 'filled' && p.cure > 0) ring(c, p.x, p.y, p.r * 2.1, p.cure, '#7fb8ff');
  }
  if (D && (D.state === 'dead' || D.state === 'loose') && D.grab) {
    const b = polyBB(D.poly);
    ring(c, D.c[0], D.c[1], Math.max(b[2] - b[0], b[3] - b[1]) / 2 + 8 * u, D.loosen, '#ff8fbe', D.state === 'loose' ? 'тяни!' : 'качай');
  }
  if (L.fly) drawFly(c, L.fly, t);
  // particles
  for (const q of L.parts) drawPart(c, q);
  // lamp light
  if (L.lampOn) {
    c.save(); c.globalCompositeOperation = 'lighter';
    const r = 46 * u, g = c.createRadialGradient(P.bx, P.by, 0, P.bx, P.by, r);
    g.addColorStop(0, 'rgba(140,190,255,.85)'); g.addColorStop(0.35, 'rgba(60,120,255,.45)'); g.addColorStop(1, 'rgba(30,60,255,0)');
    c.fillStyle = g; c.beginPath(); c.arc(P.bx, P.by, r, 0, TAU); c.fill(); c.restore();
  }
  if (G.debug) drawDebug(c);
}
function drawToothSpr(c, D, ox, oy, rot, a, out) {
  c.save(); c.globalAlpha = a;
  c.translate(D.root[0] + ox, D.root[1] + oy); c.rotate(rot); c.translate(-D.root[0], -D.root[1]);
  if (out) drawRoot(c, D);
  c.drawImage(D.spr.c, D.spr.ox, D.spr.oy); c.restore();
}
function drawRoot(c, D) {
  // the root only shows once the tooth is out of the socket
  if (!D.rootGeo) {
    const tx = -D.dir[1], ty = D.dir[0];
    let a = 1e9, b = -1e9, e = 1e9, f = -1e9;
    for (const p of D.poly) { const pt = (p[0] - D.c[0]) * tx + (p[1] - D.c[1]) * ty, pd = (p[0] - D.c[0]) * D.dir[0] + (p[1] - D.c[1]) * D.dir[1]; a = Math.min(a, pt); b = Math.max(b, pt); e = Math.min(e, pd); f = Math.max(f, pd); }
    const hw = (b - a) * 0.3, len = (f - e) * 0.95, bx = D.c[0] + D.dir[0] * f * 0.8, by = D.c[1] + D.dir[1] * f * 0.8;
    D.rootGeo = { tx, ty, hw, len, bx, by };
  }
  const { tx, ty, hw, len, bx, by } = D.rootGeo, dx = D.dir[0], dy = D.dir[1];
  const ex = bx + dx * len, ey = by + dy * len;
  c.beginPath();
  c.moveTo(bx + tx * hw, by + ty * hw);
  c.quadraticCurveTo(bx + tx * hw * 0.9 + dx * len * 0.6, by + ty * hw * 0.9 + dy * len * 0.6, ex + tx * hw * 0.15, ey + ty * hw * 0.15);
  c.quadraticCurveTo(ex + dx * hw * 0.2, ey + dy * hw * 0.2, ex - tx * hw * 0.15, ey - ty * hw * 0.15);
  c.quadraticCurveTo(bx - tx * hw * 0.9 + dx * len * 0.6, by - ty * hw * 0.9 + dy * len * 0.6, bx - tx * hw, by - ty * hw);
  c.closePath();
  const g = c.createLinearGradient(bx - tx * hw, by - ty * hw, bx + tx * hw, by + ty * hw);
  g.addColorStop(0, '#b29c74'); g.addColorStop(0.45, '#e6d8b8'); g.addColorStop(1, '#a48c66');
  c.fillStyle = g; c.fill();
  const bg = c.createLinearGradient(bx, by, ex, ey);
  bg.addColorStop(0, 'rgba(120,8,18,.45)'); bg.addColorStop(0.35, 'rgba(120,8,18,.05)'); bg.addColorStop(0.75, 'rgba(120,8,18,.25)'); bg.addColorStop(1, 'rgba(100,4,12,.9)');
  c.fillStyle = bg; c.fill();
}
function ring(c, x, y, r, k, col, label) {
  c.save(); c.lineCap = 'round';
  c.lineWidth = 3 * G.u; c.strokeStyle = 'rgba(0,0,0,.35)'; c.beginPath(); c.arc(x, y, r, 0, TAU); c.stroke();
  c.strokeStyle = col; c.beginPath(); c.arc(x, y, r, -Math.PI / 2, -Math.PI / 2 + TAU * k); c.stroke();
  if (label) { c.font = `800 ${9 * G.u}px Rubik, system-ui, Segoe UI, Roboto, sans-serif`; c.textAlign = 'center'; c.fillStyle = '#fff'; c.strokeStyle = 'rgba(0,0,0,.6)'; c.lineWidth = 2.5 * G.u; c.strokeText(label, x, y - r - 4 * G.u); c.fillText(label, x, y - r - 4 * G.u); }
  c.restore();
}
// where the drilled picture is darker than the clean base = the hole the filling goes into (once per cavity)
function holeMask(p) {
  const src = p.src;
  if (src._hole !== undefined) return src._hole;
  let res = null;
  try {
    const R = Math.ceil(p.fillR * 1.7), x0 = Math.round(p.x - R), y0 = Math.round(p.y - R), d = R * 2;
    const im = p.drilledImg, sx = im.naturalWidth / G.BW, sy = im.naturalHeight / G.BH;
    const a = mkc(d, d, true); a.x.drawImage(im, x0 * sx, y0 * sy, d * sx, d * sy, 0, 0, d, d);
    const da = a.x.getImageData(0, 0, d, d).data, b = G.base.x.getImageData(x0, y0, d, d).data;
    const m = a.x.createImageData(d, d), o = m.data;
    let mx = 0, my = 0, mw = 0;
    for (let y = 0; y < d; y++) for (let x = 0; x < d; x++) {
      const i = (y * d + x) * 4, al = da[i + 3] / 255;
      const diff = ((b[i] + b[i + 1] + b[i + 2]) - (da[i] + da[i + 1] + da[i + 2])) / 3 * al;
      const r = Math.hypot(x - R, y - R) / (p.fillR * 1.15);
      const k = smooth(10, 34, diff) * (1 - smooth(0.7, 1, r));
      o[i + 3] = (k * 255) | 0; mx += x * k; my += y * k; mw += k;
    }
    a.x.putImageData(m, 0, 0);
    const cx = mw > 4 ? mx / mw : R, cy = mw > 4 ? my / mw : R;
    // close the speckles: a solid core at the hole's centroid, then a soft edge
    a.x.fillStyle = '#000'; a.x.beginPath(); a.x.ellipse(cx, cy, p.fillR * 0.72, p.fillR * 0.64, 0.3, 0, TAU); a.x.fill();
    const c2 = mkc(d, d); c2.x.filter = 'blur(2.2px)'; c2.x.drawImage(a, 0, 0); c2.x.filter = 'none';
    res = { c: c2, tmp: mkc(d, d), x0, y0, d, cx: x0 + cx, cy: y0 + cy };
  } catch (e) { res = null; }
  src._hole = res;
  return res;
}
function drawCavity(c, p) {
  const r = p.r;
  const hole = p.state === 'decay' ? p.drill : 1;
  if (p.drilledImg) {
    // real assets: drilled hole picture -> putty blob -> fades to the clean base once cured
    const e = 1 - Math.pow(1 - p.anim, 3);
    const ha = p.state === 'filled' ? 1 - e * 0.85 : p.state === 'cured' ? 0.15 * (1 - e) : hole;
    if (ha > 0.01) { c.save(); c.globalAlpha = ha; c.beginPath(); c.arc(p.x, p.y, r * 1.8, 0, TAU); c.clip(); c.drawImage(p.drilledImg, 0, 0, G.BW, G.BH); c.restore(); }
    if (p.state === 'filled' || p.state === 'cured') {
      const cured = p.state === 'cured', rr = p.fillR * (cured ? 1 : 0.6 + 0.4 * e), a = cured ? 1 - e : 1;
      const hm = a > 0.01 ? holeMask(p) : null;
      if (hm) { // resin pressed into the drilled hole: clipped to the hole, flat, nearly enamel-coloured
        const t = hm.tmp, x = t.x, cx = hm.cx - hm.x0, cy = hm.cy - hm.y0;
        x.globalCompositeOperation = 'source-over'; x.globalAlpha = 1; x.clearRect(0, 0, hm.d, hm.d);
        const g = x.createRadialGradient(cx - rr * 0.25, cy - rr * 0.3, 0, cx, cy, rr * 1.4);
        if (cured) { g.addColorStop(0, '#efe8dc'); g.addColorStop(1, '#d9d0bf'); } else { g.addColorStop(0, '#f1efe9'); g.addColorStop(1, '#d6d4cc'); }
        x.fillStyle = g; x.fillRect(0, 0, hm.d, hm.d);
        x.fillStyle = `rgba(255,255,255,${cured ? 0.1 : 0.28})`; x.beginPath(); x.ellipse(cx - rr * 0.2, cy - rr * 0.3, rr * 0.45, rr * 0.11, -0.35, 0, TAU); x.fill();
        x.globalCompositeOperation = 'destination-in';
        const eg = x.createRadialGradient(cx, cy, 0, cx, cy, rr * 1.45); eg.addColorStop(0, '#000'); eg.addColorStop(0.8, '#000'); eg.addColorStop(1, 'rgba(0,0,0,0)');
        x.fillStyle = eg; x.fillRect(0, 0, hm.d, hm.d); // grows in while the putty is pressed
        x.drawImage(hm.c, 0, 0); // ...but never outside the hole
        c.save(); c.globalAlpha = a; c.drawImage(t, hm.x0, hm.y0); c.restore();
      } else if (a > 0.01) {
        c.save(); c.globalAlpha = a;
        const g = c.createRadialGradient(p.x - rr * 0.3, p.y - rr * 0.35, 0, p.x, p.y, rr * 1.1);
        g.addColorStop(0, '#ffffff'); g.addColorStop(0.55, '#e4e9ec'); g.addColorStop(0.85, 'rgba(200,208,214,.9)'); g.addColorStop(1, 'rgba(200,208,214,0)');
        c.fillStyle = g; c.beginPath(); c.ellipse(p.x, p.y, rr * 1.1, rr * 0.95, 0.3, 0, TAU); c.fill();
        c.fillStyle = 'rgba(255,255,255,.85)'; c.beginPath(); c.ellipse(p.x - rr * 0.3, p.y - rr * 0.3, rr * 0.3, rr * 0.16, -0.6, 0, TAU); c.fill();
        c.restore();
      }
    }
    return;
  }
  if (hole > 0 && p.state !== 'filled' && p.state !== 'cured') {
    c.save(); c.globalAlpha = hole;
    const g = c.createRadialGradient(p.x - r * 0.2, p.y - r * 0.2, 0, p.x, p.y, r * 0.95);
    g.addColorStop(0, '#2a2420'); g.addColorStop(0.6, '#544a43'); g.addColorStop(0.85, '#8d837a'); g.addColorStop(1, 'rgba(230,226,220,0)');
    c.fillStyle = g; c.beginPath(); c.ellipse(p.x, p.y, r * 0.95, r * 0.8, 0.3, 0, TAU); c.fill();
    c.strokeStyle = 'rgba(255,255,255,.35)'; c.lineWidth = 0.8 * G.u; c.beginPath(); c.ellipse(p.x, p.y, r * 0.8, r * 0.66, 0.3, 3.6, 5.6); c.stroke();
    c.restore();
  }
  if (p.state === 'filled' || p.state === 'cured') {
    const e = 1 - Math.pow(1 - p.anim, 3), rr = p.fillR * (0.6 + 0.4 * e);
    c.save();
    const cured = p.state === 'cured';
    const g = c.createRadialGradient(p.x - rr * 0.3, p.y - rr * 0.35, 0, p.x, p.y, rr);
    if (cured) { g.addColorStop(0, '#fffdf7'); g.addColorStop(0.7, '#ece6da'); g.addColorStop(1, '#d6cfc2'); }
    else { g.addColorStop(0, '#ffffff'); g.addColorStop(0.6, '#dfe5ea'); g.addColorStop(1, '#b9c4cd'); }
    c.fillStyle = g; c.beginPath(); c.ellipse(p.x, p.y, rr, rr * 0.85, 0.3, 0, TAU); c.fill();
    const fimg = G.man.fx && G.img[G.man.fx.filling];
    if (fimg) { c.save(); c.clip(); c.drawImage(fimg, p.x - rr * 1.05, p.y - rr * 1.05, rr * 2.1, rr * 2.1); c.restore(); }
    c.fillStyle = cured ? 'rgba(255,255,255,.5)' : 'rgba(255,255,255,.85)';
    c.beginPath(); c.ellipse(p.x - rr * 0.3, p.y - rr * 0.3, rr * 0.3, rr * 0.16, -0.6, 0, TAU); c.fill();
    if (!cured) { c.strokeStyle = 'rgba(120,140,160,.35)'; c.lineWidth = 0.7 * G.u; c.beginPath(); c.ellipse(p.x, p.y, rr, rr * 0.85, 0.3, 0, TAU); c.stroke(); }
    c.restore();
  }
}
const BUBBLES = (() => { const R = mulberry(99), a = []; for (let i = 0; i < 26; i++) a.push([R() * TAU, 0.7 + R() * 0.32, 0.5 + R() * 1.3, R() * TAU]); return a; })();
let puddleCv = null;
function drawPuddle(c, t) {
  const L = G.L, lv = L.saliva;
  if (lv < 0.02) return;
  if (G.salivaLayer) { // picture: fades in with the level, a slight wobble so it reads as liquid
    const sl = G.salivaLayer; sl.alpha = clamp(smooth(0.02, 0.95, lv) * (0.96 + 0.04 * Math.sin(t * 2.3)), 0, 1);
    sl.draw(c); return;
  }
  const pc = G.puddle, u = G.u, k = (0.35 + 0.65 * Math.sqrt(lv)) * (1 + Math.max(0, lv - 0.7) * 0.5);
  const cx = pc.c[0], cy = pc.c[1], rx = pc.r[0] * k, ry = pc.r[1] * k, al = 0.3 + 0.6 * lv;
  // offscreen in base space around the max puddle, so teeth can be masked out of it
  const mrx = pc.r[0] * 1.25 + 8, mry = pc.r[1] * 1.25 + 8, ox = Math.floor(cx - mrx), oy = Math.floor(cy - mry);
  if (!puddleCv) puddleCv = mkc(mrx * 2, mry * 2);
  const p = puddleCv.x; p.setTransform(1, 0, 0, 1, 0, 0); p.clearRect(0, 0, puddleCv.width, puddleCv.height); p.translate(-ox, -oy);
  p.save(); pathPoly(p, G.mouth); p.clip();
  p.beginPath();
  for (let i = 0; i <= 48; i++) {
    const a = (i / 48) * TAU, rr = 1 + 0.06 * Math.sin(a * 3 + t * 1.3) + 0.035 * Math.sin(a * 5 - t * 2.1);
    const x = cx + Math.cos(a) * rx * rr, y = cy + Math.sin(a) * ry * rr;
    if (i) p.lineTo(x, y); else p.moveTo(x, y);
  }
  p.closePath();
  p.save(); p.translate(cx, cy); p.scale(1, (ry * 1.08) / (rx * 1.08));
  const g = p.createRadialGradient(0, 0, 0, 0, 0, rx * 1.08);
  g.addColorStop(0, `rgba(230,236,246,${al * 0.2})`); g.addColorStop(0.65, `rgba(214,222,236,${al * 0.2})`); g.addColorStop(0.85, `rgba(250,252,255,${al * 0.26})`); g.addColorStop(1, 'rgba(255,255,255,0)');
  p.fillStyle = g; p.fill(); p.restore();
  p.clip();
  // wet speculars
  p.fillStyle = `rgba(255,255,255,${al * 0.7})`;
  p.beginPath(); p.ellipse(cx - rx * 0.32 + Math.sin(t * 0.7) * 2 * u, cy - ry * 0.35, rx * 0.16, ry * 0.12, -0.08, 0, TAU); p.fill();
  p.fillStyle = `rgba(255,255,255,${al * 0.45})`;
  p.beginPath(); p.ellipse(cx + rx * 0.28, cy - ry * 0.2, rx * 0.06, ry * 0.08, 0, 0, TAU); p.fill();
  // froth along the edge
  for (const b of BUBBLES) {
    const a = b[0] + Math.sin(t * 0.4 + b[3]) * 0.04, bx = cx + Math.cos(a) * rx * b[1], by = cy + Math.sin(a) * ry * b[1], br = b[2] * u * (0.5 + lv * 0.8);
    p.strokeStyle = `rgba(255,255,255,${al * 0.65})`; p.lineWidth = 0.5 * u; p.beginPath(); p.arc(bx, by, br, 0, TAU); p.stroke();
    p.fillStyle = `rgba(255,255,255,${al * 0.75})`; p.beginPath(); p.arc(bx - br * 0.35, by - br * 0.35, br * 0.28, 0, TAU); p.fill();
  }
  p.restore();
  // liquid sits behind/around the teeth: mostly hide it on top of them
  p.save(); p.globalCompositeOperation = 'destination-out'; p.globalAlpha = 0.8; p.drawImage(G.mask, 0, 0); p.restore();
  c.drawImage(puddleCv, ox, oy);
}
function drawPart(c, q) {
  const k = 1 - q.t / q.life;
  switch (q.k) {
    case 'drop': c.fillStyle = `rgba(215,238,255,${0.85 * k})`; c.beginPath(); c.arc(q.x, q.y, q.s, 0, TAU); c.fill(); c.fillStyle = `rgba(255,255,255,${k})`; c.beginPath(); c.arc(q.x - q.s * 0.3, q.y - q.s * 0.3, q.s * 0.35, 0, TAU); c.fill(); break;
    case 'crumb': c.save(); c.globalAlpha = Math.min(1, k * 2); c.translate(q.x, q.y); c.rotate(q.r); c.fillStyle = q.c; c.beginPath(); c.moveTo(-q.s, -q.s * 0.6); c.lineTo(q.s * 0.8, -q.s); c.lineTo(q.s, q.s * 0.5); c.lineTo(-q.s * 0.4, q.s); c.closePath(); c.fill(); c.restore(); break;
    case 'dust': c.fillStyle = `rgba(236,232,224,${0.45 * k})`; c.beginPath(); c.arc(q.x, q.y, q.s * (1.6 - k * 0.6), 0, TAU); c.fill(); break;
    case 'foam': c.strokeStyle = `rgba(255,255,255,${0.9 * k})`; c.lineWidth = 0.6 * G.u; c.beginPath(); c.arc(q.x, q.y, q.s, 0, TAU); c.stroke(); c.fillStyle = `rgba(255,255,255,${0.35 * k})`; c.fill(); break;
    case 'blood': c.fillStyle = `rgba(120,6,16,${k})`; c.beginPath(); c.arc(q.x, q.y, q.s, 0, TAU); c.fill(); break;
    case 'suck': c.fillStyle = `rgba(225,240,255,${0.8 * k})`; c.beginPath(); c.arc(q.x, q.y, q.s, 0, TAU); c.fill(); break;
    case 'spark': c.save(); c.globalCompositeOperation = 'lighter'; c.fillStyle = `rgba(255,236,170,${k})`; c.beginPath(); c.arc(q.x, q.y, q.s * k, 0, TAU); c.fill(); c.restore(); break;
  }
}
function drawOverlay(c) {
  const L = G.L;
  // floating score pops
  c.save(); c.textAlign = 'center'; c.font = '800 30px Rubik, system-ui, Segoe UI, Roboto, sans-serif';
  for (const q of L.pops) {
    const k = q.t / 1.1; c.globalAlpha = 1 - k * k; c.lineWidth = 5; c.strokeStyle = 'rgba(0,0,0,.55)';
    c.strokeText(q.txt, q.x, q.y - k * 50); c.fillStyle = q.col; c.fillText(q.txt, q.x, q.y - k * 50);
  }
  c.restore();
  // tool cursor
  const show = G.tool && (P.down || (P.inside && P.type === 'mouse'));
  if (!show) return;
  let x = P.x, y = P.y;
  if (G.tool === 'drill' && P.down) { x += (Math.random() - 0.5) * 2.2; y += (Math.random() - 0.5) * 2.2; }
  if (G.tool === 'implant' && L.tooth) {
    const im = L.tooth.imp, s = G.view.s;
    c.save(); c.globalAlpha = L.impDrag ? 1 : 0.5; c.shadowColor = 'rgba(0,0,0,.45)'; c.shadowBlur = 14; c.shadowOffsetY = 8;
    c.drawImage(im.c, x - (im.tw * s) / 2, y - (im.th * s) / 2, im.tw * s, im.th * s); c.restore();
    return;
  }
  const sp = G.toolSpr[G.tool]; if (!sp) return;
  c.save();
  if (G.tool === 'lamp' && P.down) { c.shadowColor = 'rgba(90,160,255,.9)'; c.shadowBlur = 24; }
  if (sp.ang) { c.translate(x, y); c.rotate(sp.ang); c.drawImage(sp.img, -sp.hx, -sp.hy, sp.w, sp.h); }
  else c.drawImage(sp.img, x - sp.hx, y - sp.hy, sp.w, sp.h);
  c.restore();
  if (G.tool === 'water' && P.down) {
    c.save(); c.strokeStyle = 'rgba(220,240,255,.75)'; c.lineWidth = 3; c.setLineDash([6, 5]); c.lineDashOffset = -G.time * 120;
    c.beginPath(); c.moveTo(x, y); c.lineTo(x - 2, y + 4); c.stroke(); c.restore();
  }
}
function drawDebug(c) {
  c.save(); c.globalAlpha = 0.35; c.drawImage(G.mask, 0, 0); c.globalAlpha = 1;
  c.lineWidth = 1; c.strokeStyle = '#0f0'; pathPoly(c, G.mouth); c.stroke();
  c.strokeStyle = '#0ff'; c.font = '8px sans-serif'; c.fillStyle = '#ff0';
  for (const t of G.teeth) { pathPoly(c, t.poly); c.stroke(); c.fillText(t.id, t.c[0] - 6, t.c[1]); }
  const D = G.L.tooth; if (D) { c.strokeStyle = '#f0f'; pathPoly(c, D.poly); c.stroke(); c.strokeStyle = '#ff0'; pathPoly(c, D.donor.poly); c.stroke(); }
  c.restore();
}

/* ======================================================================
   DOM UI
   ====================================================================== */
const UI = {
  tools: $('#tools'), tip: $('#tip'), fill: $('#fill'), ring: $('#ring'), anest: $('#anest'), lives: $('#lives'), face: $('#face'),
  time: $('#time'), score: $('#score'), list: $('#list'), toast: $('#toast'), bubbles: $('#bubbles'), vig: $('#vig'), numb: $('#numb'),
  hud: $('#hud'), ptitle: $('#ptitle'), stream: $('#stream'), vid: $('#vid'), poster: $('#poster'),
  cache: {},
};
const ICON_SND_ON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H3v6h3l5 4z" fill="currentColor"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/></svg>';
const ICON_SND_OFF = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H3v6h3l5 4z" fill="currentColor"/><path d="m16 9 5 6M21 9l-5 6"/></svg>';
const TOOTH_SVG = '<svg viewBox="0 0 30 34"><path d="M15 4c-4-2.4-11-2.4-11.6 4.4C2.8 14 5 17 6 23c1 6 2.2 9 4 9 2.2 0 1.8-7 5-7s2.8 7 5 7c1.8 0 3-3 4-9 1-6 3.2-9 2.6-14.6C26 1.6 19 1.6 15 4z" fill="#f4f1ea" stroke="#bdb4a4" stroke-width="1.4"/><ellipse cx="9.5" cy="8.5" rx="2.6" ry="1.5" fill="#fff" transform="rotate(-30 9.5 8.5)"/></svg>';
const STAR_SVG = '<svg viewBox="0 0 24 24"><path d="M12 2.2l2.9 6.3 6.9.8-5.1 4.7 1.4 6.8L12 17.4l-6.1 3.4 1.4-6.8L2.2 9.3l6.9-.8z" fill="#ffc94d" stroke="#ffe7a6" stroke-width=".7" stroke-linejoin="round"/></svg>';

function buildTray() {
  UI.tools.innerHTML = '';
  TOOL_ORDER.forEach((id, i) => {
    const b = document.createElement('button');
    b.className = 'tool'; b.dataset.id = id; b.setAttribute('aria-label', TOOL_INFO[id].name);
    const sp = G.toolSpr[id];
    const c = mkc(168, 168);
    if (sp && !sp.proc) { // photo: lay long tools diagonally like the silhouettes, tip to the top-left
      const im = sp.img, iw = im.naturalWidth, ih = im.naturalHeight, x = c.x;
      x.save(); x.translate(84, 84);
      if (id !== 'implant' && ih > iw * 1.6) { x.rotate(-Math.PI / 4); const k = 210 / ih; x.drawImage(im, -iw * k / 2, -ih * k / 2, iw * k, ih * k); }
      else { const k = Math.min(150 / iw, 150 / ih); x.drawImage(im, -iw * k / 2, -ih * k / 2, iw * k, ih * k); }
      x.restore();
    } else c.x.drawImage(sp.img, 0, 0, 168, 168);
    b.appendChild(c);
    const k = document.createElement('span'); k.className = 'k'; k.textContent = TOOL_KEYS[i]; b.appendChild(k);
    const nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = TOOL_INFO[id].name; b.appendChild(nm);
    b.addEventListener('click', () => {
      S.unlock(); selectTool(id); b.blur(); // keep focus off the tray: Space / Enter must not re-click the tool
      // touch screens have no hover tip: name the tool, but never over a fresh gameplay hint
      if (G.tool === id && document.body.classList.contains('small') && G.screen === 'play') hint(`${TOOL_INFO[id].name} — ${TOOL_INFO[id].desc}`, 'info', true);
    });
    b.addEventListener('pointerenter', (e) => { if (e.pointerType === 'mouse') showTip(b, id); });
    b.addEventListener('pointerleave', () => UI.tip.classList.remove('on'));
    UI.tools.appendChild(b);
  });
}
function showTip(b, id) {
  UI.tip.innerHTML = `<b>${TOOL_INFO[id].name}</b>${TOOL_INFO[id].desc}`;
  UI.tip.style.top = (b.offsetTop + b.offsetHeight / 2 - 30) + 'px';
  UI.tip.classList.add('on');
}
function refreshTray() {
  for (const b of UI.tools.children) b.classList.toggle('sel', b.dataset.id === G.tool);
  cv.classList.toggle('nocursor', !!G.tool && G.screen === 'play');
}
function buildChecklist() {
  const L = G.L;
  UI.ptitle.textContent = G.pat.title || 'Пациент';
  UI.list.innerHTML = '';
  L.groups = [];
  for (const type of Object.keys(PROB)) {
    const probs = L.probs.filter((p) => p.type === type);
    if (!probs.length) continue;
    const li = document.createElement('li');
    li.innerHTML = `<div class="bx"><svg viewBox="0 0 20 20"><path d="M4 10.5l4 4 8-9"/></svg></div><div class="tx"><div class="nm"></div><div class="rc"></div></div>`;
    UI.list.appendChild(li);
    L.groups.push({ type, probs, li });
  }
  updateChecklist();
}
function stepIndex(p) {
  switch (p.type) {
    case 'plaque': return p.cleared ? 1 : 0;
    case 'food': return p.state === 'held' ? 1 : 0;
    case 'cavity': return { decay: 0, drilled: 1, clean: 2, filled: 3, cured: 4 }[p.state];
    case 'dead': return { dead: 0, loose: 0, pulled: 1, extracted: 1, clean: 2, implanted: 3 }[p.state];
    default: return 0;
  }
}
function updateChecklist(flashType) {
  const L = G.L; if (!L || !L.groups) return;
  for (const g of L.groups) {
    const done = g.probs.filter((p) => p.done).length, all = done === g.probs.length;
    const nm = PROB[g.type].name + (g.probs.length > 1 ? `<em>${done}/${g.probs.length}</em>` : '');
    const open = g.probs.filter((p) => !p.done);
    const si = open.length ? Math.min(...open.map(stepIndex)) : 0;
    const rc = PROB[g.type].steps.map((s, i) => (i === si ? `<b>${s}</b>` : s)).join(' → ');
    const key = nm + '|' + rc + '|' + all;
    if (g.key !== key) { g.key = key; g.li.querySelector('.nm').innerHTML = nm; g.li.querySelector('.rc').innerHTML = rc; g.li.classList.toggle('done', all); }
    if (flashType === g.type) { g.li.classList.add('flash'); setTimeout(() => g.li.classList.remove('flash'), 700); }
  }
}
function updateLives() {
  const L = G.L;
  if (UI.lives.children.length !== CFG.lives) { UI.lives.innerHTML = ''; for (let i = 0; i < CFG.lives; i++) UI.lives.insertAdjacentHTML('beforeend', TOOTH_SVG); }
  [...UI.lives.children].forEach((s, i) => s.classList.toggle('lost', i >= L.lives));
}
function faceState(p) { return p < 30 ? 'calm' : p < 60 ? 'worried' : p < 85 ? 'pain' : 'cry'; }
function setFace(st) {
  if (UI.cache.face === st) return; UI.cache.face = st;
  const old = UI.face.querySelector('canvas,img'); if (old) old.remove();
  let el;
  if (G.faceImg[st]) { el = document.createElement('img'); el.src = G.faceImg[st].src; el.alt = ''; }
  else { el = mkc(96, 96); drawFace(el.x, 96, st); }
  UI.face.insertBefore(el, UI.face.firstChild);
}
function updateHUD() {
  const L = G.L, C = UI.cache;
  const pw = Math.round(L.pain * 2) / 2;
  if (C.pain !== pw) { C.pain = pw; UI.fill.style.width = pw + '%'; }
  setFace(faceState(L.pain));
  const an = L.anest > 0 ? Math.ceil(L.anest) : 0;
  const ringOff = (169.6 * (1 - L.anest / CFG.anesthesia)).toFixed(1);
  if (C.ring !== ringOff) { C.ring = ringOff; UI.ring.style.strokeDashoffset = ringOff; }
  if (C.an !== an) { C.an = an; UI.anest.textContent = an ? `❄ анестезия ${an} с` : ''; UI.numb.style.opacity = an ? 1 : 0; }
  const ts = fmtTime(L.time);
  if (C.time !== ts) { C.time = ts; UI.time.textContent = ts; UI.time.classList.toggle('low', L.time <= 20); }
  if (C.score !== L.score) { C.score = L.score; UI.score.textContent = L.score; }
  const v = L.vig + (L.pain > 85 ? 0.25 + 0.15 * Math.sin(G.time * 8) : 0);
  const vs = v.toFixed(2); if (C.vig !== vs) { C.vig = vs; UI.vig.style.opacity = vs; }
  if ((L.t * 4 | 0) !== C.ck) { C.ck = L.t * 4 | 0; updateChecklist(); }
}
let toastTimer = 0, toastAt = -1e9;
// soft: informational toast that must not replace a gameplay hint shown less than 2 s ago
function hint(txt, kind, soft) {
  const now = performance.now();
  if (soft && now - toastAt < 2000 && UI.toast.classList.contains('on')) return;
  if (!soft) toastAt = now;
  const t = UI.toast; t.textContent = txt; t.className = 'on ' + (kind || '');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.className = kind || ''; }, 2400);
}
function clearHint() { clearTimeout(toastTimer); UI.toast.className = ''; toastAt = -1e9; }
function say(txt, ms) {
  const b = document.createElement('div'); b.className = 'bubble'; b.textContent = txt;
  UI.bubbles.appendChild(b);
  while (UI.bubbles.children.length > 1) UI.bubbles.firstChild.remove(); // one subtitle at a time
  setTimeout(() => { b.classList.add('out'); setTimeout(() => b.remove(), 320); }, ms || 2800);
}

/* ---------- stream window ----------
   Speech clips (hello, fail, laugh, win, pain, fly) play WITH sound unless the game is muted,
   with the game sounds ducked meanwhile; idle loops silently in between. One speech clip at a
   time: while one talks, the next request waits in a queue of one (extra ones are dropped),
   except win, which interrupts. The subtitle bubble shows manifest.alinka.speech[name]. */
const Stream = {
  clips: {}, speech: {}, bad: {}, cur: null, speaking: null, queued: null, guard: 0, fb: 0,
  init(al) {
    this.clips = (al && al.clips) || {};
    this.speech = (al && al.speech) || {};
    const poster = (al && al.poster) || (G.man && G.man.keyart);
    UI.poster.onload = () => UI.stream.classList.remove('nopost');
    UI.poster.onerror = () => UI.stream.classList.add('nopost');
    if (poster) UI.poster.src = poster; else UI.stream.classList.add('nopost');
    UI.stream.classList.toggle('kcrop', !!poster && poster === (G.man && G.man.keyart)); // key art: zoom onto her face
    UI.vid.muted = true; UI.vid.playsInline = true;
    UI.vid.addEventListener('ended', () => { if (this.speaking) this.onEnd(); });
    UI.vid.addEventListener('error', () => {
      const src = UI.vid.getAttribute('src'); if (src) this.bad[src] = true;
      UI.stream.classList.remove('vid');
      if (this.speaking) this.onEnd();
    });
  },
  react(name) {
    const k = name === 'hello' || name === 'laugh' ? 'laugh' : name === 'win' ? 'win' : 'fail';
    UI.stream.classList.remove('react-fail', 'react-laugh', 'react-win'); void UI.stream.offsetWidth; UI.stream.classList.add('react-' + k);
  },
  // name: clip id; line: fallback bubble text (her chat spelling) when there is no clip / no speech text
  // opts.force: interrupt whatever is talking (win and the lose reaction do)
  play(name, line, opts) {
    if (name === 'idle') { this.idle(); return; }
    const force = name === 'win' || !!(opts && opts.force);
    if (this.speaking && !force) { if (!this.queued) this.queued = { name, line, at: performance.now() }; return; }
    this.queued = null;
    this.react(name);
    const src = this.clips[name], text = this.speech[name] || line;
    clearTimeout(this.guard); clearTimeout(this.fb);
    if (!src || this.bad[src]) { // poster fallback: bubble + small CSS reaction
      this.speaking = null; S.duck = 1; this.cur = name;
      if (line) say(line);
      this.fb = setTimeout(() => { if (this.cur === name) this.idle(); }, 1200);
      return;
    }
    this.speaking = name; this.cur = name; S.duck = 0.7;
    if (text) say(text, 4600);
    this.start(src, false);
    this.guard = setTimeout(() => { if (this.speaking === name) this.onEnd(); }, 9000); // never stuck on a stalled clip
  },
  start(src, loop) {
    const v = UI.vid;
    const ok = () => { UI.stream.classList.add('vid'); if (G.quiet) { try { v.pause(); } catch (e) { /* ignore */ } } };
    const fail = () => { UI.stream.classList.remove('vid'); if (!loop && this.speaking) this.onEnd(); };
    try {
      if (v.getAttribute('src') !== src) v.setAttribute('src', src);
      v.loop = loop; v.muted = loop || G.muted; v.volume = 0.9;
      try { v.currentTime = 0; } catch (e) { /* not seekable yet */ }
      if (G.quiet) return; // resume() starts it
      const pr = v.play();
      if (pr && pr.then) {
        pr.then(ok).catch((err) => {
          if (!v.muted && err && err.name === 'NotAllowedError') { v.muted = true; v.play().then(ok).catch(fail); } // sound refused: muted + subtitles
          else if (!err || err.name !== 'AbortError') fail();
        });
      } else ok();
    } catch (e) { fail(); }
  },
  onEnd() {
    clearTimeout(this.guard);
    this.speaking = null; S.duck = 1;
    const q = this.queued; this.queued = null;
    // a queued reaction only plays while it still makes sense: fresh, the level still running, the fly still there
    const fresh = q && performance.now() - q.at < 2500 && G.screen === 'play' && G.L && !G.L.over && (q.name !== 'fly' || flyActive());
    if (fresh) { this.play(q.name, q.line); return; }
    this.idle();
  },
  pause() {
    clearTimeout(this.guard);
    try { UI.vid.pause(); } catch (e) { /* ignore */ }
  },
  resume() {
    const v = UI.vid;
    if (G.screen === 'loading' || G.screen === 'title') return;
    if (this.speaking) { // continue the sentence; the guard restarts so a stalled clip still ends
      const name = this.speaking;
      this.guard = setTimeout(() => { if (this.speaking === name) this.onEnd(); }, 9000);
      try { const pr = v.play(); if (pr && pr.catch) pr.catch(() => this.onEnd()); } catch (e) { this.onEnd(); }
    } else this.idle();
  },
  idle() {
    this.cur = 'idle';
    const src = this.clips.idle;
    if (!src || this.bad[src]) { UI.stream.classList.remove('vid'); return; }
    this.start(src, true);
  },
  setMuted(m) { if (this.speaking) UI.vid.muted = m; },
  reset() { clearTimeout(this.guard); clearTimeout(this.fb); this.speaking = null; this.queued = null; S.duck = 1; },
  stop() { this.reset(); try { UI.vid.pause(); } catch (e) { /* ignore */ } UI.stream.classList.remove('vid'); },
};

/* ---------- screens ---------- */
function show(id) {
  for (const s of ['loading', 'title', 'win', 'lose']) $('#' + s).classList.toggle('on', s === id);
  UI.hud.classList.toggle('on', id === 'play' || id === 'win' || id === 'lose');
  // end cards: her stream window (the payoff) comes up above the blur, larger
  document.body.classList.toggle('ending', id === 'win' || id === 'lose');
}
function setScreen(s) { G.screen = s; show(s); refreshTray(); }
function startGame() {
  if (!G.ready) return;
  clearTimers(); clearHint(); // nothing from the previous run (stars, flinch->lose, toasts) fires into this one
  if (G.L) releaseAll();
  P.down = false;
  S.unlock(); S.stopAll(); S.play('click');
  buildLevel();
  UI.cache = {}; updateLives(); UI.bubbles.innerHTML = '';
  setScreen('play');
  Stream.reset(); Stream.play('hello', LINES.start);
  const L0 = G.L;
  later(() => { if (G.screen === 'play' && G.L === L0 && !L0.injected) hint('Начни с анестезии: шприц и тап по десне', 'good'); }, 1600);
  updateHUD();
}
function win() {
  const L = G.L; if (!L) return;
  releaseAll(); S.stopAll();
  const bonus = Math.ceil(L.time) * CFG.score.timeBonus;
  L.score += bonus;
  const tf = L.time / CFG.levelTime;
  let stars = 1;
  if (tf >= CFG.stars.two.time && L.flinches <= CFG.stars.two.flinch) stars = 2;
  if (tf >= CFG.stars.three.time && L.flinches <= CFG.stars.three.flinch) stars = 3;
  const rec = L.score > G.best; if (rec) { G.best = L.score; lsSet('da.best', String(G.best)); }
  $('#wscore').textContent = L.score;
  $('#wtime').textContent = fmtTime(CFG.levelTime - L.time);
  const wb = $('#wbest'); wb.textContent = G.best; wb.classList.toggle('rec', rec);
  const st = $('#stars'); st.innerHTML = STAR_SVG + STAR_SVG + STAR_SVG;
  [...st.children].forEach((s, i) => { if (i < stars) later(() => { if (G.L === L && G.screen === 'win') { s.classList.add('on'); S.play('star', { index: i + 1 }); } }, 450 + i * 380); });
  L.stars = stars;
  setScreen('win'); updateTitleBest();
  S.play('win'); Stream.play('win', LINES.win);
  updateHUD();
}
function lose(why) {
  const L = G.L; if (!L) return;
  L.over = true; releaseAll(); S.stopAll();
  $('#lwhy').textContent = why === 'time' ? 'Приём затянулся, время вышло. Пациент ушёл недолеченным' : 'Три срыва — и он уже в маршрутке';
  setScreen('lose');
  if (why === 'time') S.play('fail'); else { S.play('whoosh'); S.play('fail', { pitch: 0.8, volume: 0.8 }); } // fled: lower than the flinch's fail
  Stream.play('fail', why === 'time' ? pick(LINES.order) : null, { force: true }); // her reaction interrupts the last line
}
function updateTitleBest() { $('#best').textContent = G.best ? `Рекорд: ${G.best}` : ''; }
function setMuted(m) {
  G.muted = m; lsSet('da.muted', m ? '1' : '0');
  S.call('setMuted', m); Stream.setMuted(m);
  for (const b of [$('#snd'), $('#tsnd')]) { b.innerHTML = m ? ICON_SND_OFF : ICON_SND_ON; b.setAttribute('aria-pressed', String(!m)); b.title = m ? 'Звук выключен' : 'Звук включён'; }
}

/* ======================================================================
   main loop
   ====================================================================== */
let last = 0;
function frame(ts) {
  const dt = Math.min(0.05, last ? (ts - last) / 1000 : 0.016);
  last = ts;
  try {
    const t0 = performance.now(); update(dt); const t1 = performance.now(); render(); const t2 = performance.now();
    G.perf.u = lerp(G.perf.u, t1 - t0, 0.1); G.perf.r = lerp(G.perf.r, t2 - t1, 0.1); G.perf.dt = lerp(G.perf.dt, dt * 1000, 0.1);
  } catch (e) { console.error(e); }
  requestAnimationFrame(frame);
}

/* ======================================================================
   boot
   ====================================================================== */
async function boot() {
  resize(); watchDpr();
  window.addEventListener('resize', resize);
  window.addEventListener('orientationchange', () => setTimeout(resize, 200));
  makeSprites();
  setMuted(G.muted);
  $('#snd').addEventListener('click', () => { S.unlock(); setMuted(!G.muted); S.play('click'); });
  $('#tsnd').addEventListener('click', () => { S.unlock(); setMuted(!G.muted); S.play('click'); });
  $('#start').addEventListener('click', startGame);
  $('#again1').addEventListener('click', startGame);
  $('#again2').addEventListener('click', startGame);
  requestAnimationFrame(frame);

  // ?manifest=other.json lets you try asset sets side by side (relative same-folder paths only)
  let mpath = 'manifest.json';
  try { const q = new URLSearchParams(location.search).get('manifest'); if (q && /^[\w./-]+\.json$/.test(q) && !q.includes('..') && !q.startsWith('/')) mpath = q; } catch (e) { /* ignore */ }
  let man = await loadJSON(mpath);
  if (!man || !Array.isArray(man.patients) || !man.patients.length) man = FALLBACK_MANIFEST;
  G.man = man;
  // key art
  const ka = $('#keyart');
  ka.onerror = () => ka.classList.add('missing');
  if (man.keyart) ka.src = man.keyart; else ka.classList.add('missing');
  // tools
  const tdefs = {}; for (const t of man.tools || []) if (t && t.id) tdefs[t.id] = t;
  await loadMany(Object.values(tdefs).map((t) => t.img).concat(man.fx ? Object.values(man.fx) : []));
  for (const id of TOOL_ORDER) {
    const d = tdefs[id], im = d && d.img && G.img[d.img];
    if (im) {
      const sc = typeof d.scale === 'number' ? d.scale : 0.5, hs = Array.isArray(d.hotspot) ? d.hotspot : [0.5, 0.05];
      const w = im.naturalWidth * sc, h = im.naturalHeight * sc;
      G.toolSpr[id] = { img: im, w, h, hx: w * hs[0], hy: h * hs[1], proc: false, ang: ((typeof d.angle === 'number' ? d.angle : 0) * Math.PI) / 180 };
    } else G.toolSpr[id] = makeToolSprite(id);
  }
  buildTray();
  Stream.init(man.alinka || {});
  await setupPatient(man.patients[0]);
  G.L = null;
  G.ready = true;
  const st = $('#start'); st.disabled = false;
  updateTitleBest();
  setScreen('title');
}

/* ======================================================================
   debug / test API
   ====================================================================== */
function solveOne(p) {
  const L = G.L;
  if (p.done) return;
  switch (p.type) {
    case 'tartar': p.layer.clear(); p.region.cur = 0; completeProblem(p, ...regionC(p.region)); break;
    case 'plaque': p.cleared = true; p.layer.clear(); p.region.cur = 0; L.foam.clear(); completeProblem(p, ...regionC(p.region)); break;
    case 'food': p.state = 'gone'; p.vy = -60 * G.u; p.vx = 0; completeProblem(p, p.x, p.y); break;
    case 'cavity': p.layer.clear(); p.drill = 1; p.state = 'cured'; p.anim = 1; completeProblem(p, p.x, p.y); break;
    case 'dead': p.grab = false; p.state = 'implanted'; p.snap = 1; p.dropAt = null; L.blood.clear(); completeProblem(p, p.c[0], p.c[1]); break;
  }
}
window.DA = {
  state() {
    const L = G.L;
    return {
      screen: G.screen, ready: G.ready, tool: G.tool,
      time: L ? +L.time.toFixed(2) : null, score: L ? L.score : 0, lives: L ? L.lives : null, flinches: L ? L.flinches : 0,
      pain: L ? +L.pain.toFixed(1) : 0, anesthesia: L ? +L.anest.toFixed(1) : 0, saliva: L ? +L.saliva.toFixed(2) : 0,
      fly: L && L.fly ? L.fly.state : null, stars: L ? L.stars || 0 : 0,
      teethSource: G.teethJson ? 'teeth.json' : (G.teethNote || 'approx'), teeth: G.teeth.length, base: [G.BW, G.BH], view: { ...G.view },
      problems: L ? L.probs.map((p) => ({ type: p.type, done: p.done, state: p.state || (p.cleared ? 'cleared' : undefined),
        left: p.region ? +p.region.frac.toFixed(3) : undefined, foamLeft: p.foamRegion ? +p.foamRegion.frac.toFixed(3) : undefined,
        dustLeft: p.dustRegion ? +p.dustRegion.frac.toFixed(3) : undefined, bloodLeft: p.bloodRegion ? +p.bloodRegion.frac.toFixed(3) : undefined })) : [],
      sfx: !!window.SFX, duck: S.duck, loops: Object.keys(S.active),
      stream: { cur: Stream.cur, speaking: Stream.speaking, queued: Stream.queued && Stream.queued.name, src: UI.vid.getAttribute('src'), muted: UI.vid.muted, playing: !UI.vid.paused },
    };
  },
  selectTool(id) { G.tool = null; selectTool(id || null); return G.tool; },
  solve(type) { const L = G.L; if (!L || G.screen !== 'play') return false; const list = L.probs.filter((p) => !p.done && (type === 'all' || p.type === type)); list.forEach(solveOne); return list.length; },
  win() { if (!G.L || G.screen !== 'play') return false; G.L.probs.forEach(solveOne); G.L.winT = -1; G.L.over = true; win(); return true; },
  lose(why) { if (!G.L || G.screen !== 'play') return false; lose(why || 'fled'); return true; },
  restart() { if (!G.ready) return false; startGame(); return true; },
  start() { return this.restart(); },
  fly() { if (G.L && !G.L.fly) spawnFly(); return !!(G.L && G.L.fly); },
  pain(v) { if (G.L) G.L.pain = clamp(v, 0, 100); },
  saliva(v) { if (G.L) G.L.saliva = clamp(v, 0, 1); },
  anesthesia(s) { if (G.L) G.L.anest = s === undefined ? CFG.anesthesia : s; },
  time(s) { if (G.L) G.L.time = s; },
  debug(on) { G.debug = on === undefined ? !G.debug : !!on; return G.debug; },
  toScreen(bx, by) { const [lx, ly] = toLogical(bx, by); return [G.ox + (lx + G.cox) * G.k, G.oy + ly * G.k]; },
  toBase(cx, cy) { return toBase((cx - G.ox) / G.k - G.cox, (cy - G.oy) / G.k); },
  // advance the simulation synchronously (tests in throttled/background tabs)
  tick(sec) { const n = Math.max(1, Math.round((sec || 1 / 60) * 60)); for (let i = 0; i < n; i++) update(1 / 60); render(); return DA.state().time; },
  cfg: CFG,
  _G: G,
};

boot().catch((e) => {
  console.error(e);
  const p = document.querySelector('#loading p'), sp = document.querySelector('#loading .spin');
  if (sp) sp.style.display = 'none';
  if (p) p.innerHTML = 'Не получилось загрузить приём 😿<br><b>Обнови страницу</b>';
});
})();
