/*
 * sfx.js — «Доктор Алинка»: процедурные ASMR-звуки стоматологии.
 * Pure Web Audio synthesis, no audio files, no dependencies, no build step.
 *
 * API (window.SFX)
 * ----------------
 *   SFX.init()            Idempotent. Registers first-gesture listeners. Runs automatically
 *                         when this file loads; calling it again is harmless.
 *   SFX.unlock()          Creates/resumes the AudioContext. Call it from a user gesture
 *                         (pointerdown / click / keydown). Also runs on its own on the first
 *                         gesture anywhere on the page. Returns Promise<boolean> (true = running).
 *   SFX.setMuted(b)       Mute / unmute. Saved to localStorage key "doctorAlinka.muted"
 *                         (all storage access is wrapped in try/catch).
 *   SFX.muted             Current mute state (getter; assigning to it calls setMuted).
 *   SFX.play(name, opts)  One-shot. Unknown names are ignored. Returns true if it was scheduled.
 *                         Names: click, pick, squeak, spit, pop, ding, star, fail, win, thud,
 *                                buzzshort, tick
 *                         Extras: crack (tooth extraction), squish (filling paste),
 *                                 beep (curing lamp), whoosh (swipe)
 *                         Common opts: volume 0..2 (1), pitch multiplier (1), pan -1..1 (0).
 *                         Specific: star {index: 1..3} (each next star is higher),
 *                                   tick {tock: bool} (alternates automatically if omitted),
 *                                   beep {n: 1..5} (number of beeps).
 *                         play(<loop name>, {dur: 0.4, ...}) plays a short independent burst
 *                         of that loop and fades it out after `dur` seconds.
 *   SFX.loop(name, opts)  Start a loop. IDEMPOTENT: if it is already playing, the call only
 *                         updates its params (and revives it if it is fading out). So it is
 *                         fine — and intended — to call it every frame to steer the sound:
 *                             SFX.loop('drill', {load: onCavity ? 1 : 0});
 *                             SFX.loop('scrape', {speed: pointerSpeed01});
 *                         Params are merged: keys you omit keep their previous value.
 *                         Loops: drill  {load 0..1 (0): pitch drops, grinding; wet 0..1 (0): spray}
 *                                suction{wet 0..1 (0.6): how much liquid is gurgling}
 *                                water  {intensity 0..1 (1)}
 *                                scrape {speed 0..1 (0.5): grain rate and loudness}
 *                                brush  {speed 0..1 (0.7): stroke rate ~5..8.5 Hz}
 *                                fly    {intensity 0..1 (1): 1 = flying, lower = crawling,
 *                                        short intermittent buzzes; pan -1..1 follows the fly}
 *                         Extra loop: lamp (curing light fan + beep at start).
 *                         Common opts: volume 0..2 (1), pan -1..1 (0).
 *   SFX.stop(name)        Fade a loop out (drill spins down). stop() without a name = all loops.
 *
 * Extras: SFX.set(name, opts) updates a playing loop without starting it; SFX.isPlaying(name);
 *         SFX.stopAll(); SFX.toggleMuted(); SFX.setVolume(0..1) / SFX.volume (saved too);
 *         SFX.names = {oneshots, loops}; SFX.ready; SFX.debug() -> state snapshot;
 *         SFX.ctx / SFX.output (AudioContext and the final node, e.g. to attach an analyser).
 *
 * Before the first user gesture nothing is created (no autoplay warnings). loop() calls made
 * before that are remembered and start right after unlock; play() calls are dropped.
 */
(function () {
  'use strict';

  const AC = window.AudioContext || window.webkitAudioContext;
  const LS_MUTED = 'doctorAlinka.muted';
  const LS_VOLUME = 'doctorAlinka.volume';
  const MASTER = 0.85;          // headroom before the compressor
  const SMOOTH_PPS = 10;        // random points per second in the smooth-noise modulation buffer
  const LOOKAHEAD = 0.12;       // seconds of events the scheduler keeps queued
  const EPS = 1e-4;

  let ctx = null, master = null, comp = null, loopBus = null, fxBus = null, revIn = null;
  const buffers = {};
  let muted = readMuted();
  let volume = readVolume();
  let inited = false, unlocked = false, schedTimer = 0;
  const active = {};            // loop name -> Voice (playing or fading out)
  const voices = [];            // every live voice, loops and bursts
  const pending = {};           // loops requested before an AudioContext existed
  let tickN = 0, errCount = 0, lastErr = '';

  // ---------------------------------------------------------------- small helpers
  const R = Math.random;
  const rnd = (a, b) => a + (b - a) * R();
  const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
  const num = (x, d) => (typeof x === 'number' && isFinite(x) ? x : d);
  const near = (a, b) => Math.abs(num(a, 0) - num(b, 0)) < 0.004;
  const expRand = (mean) => -Math.log(1 - R() * 0.999) * mean;
  const now = () => ctx.currentTime;
  const hz = (f) => clamp(f, 1, ctx.sampleRate * 0.45);   // keep frequencies inside the nominal range

  function note(e) { errCount++; lastErr = String((e && e.message) || e); }

  function readMuted() { try { return localStorage.getItem(LS_MUTED) === '1'; } catch (e) { return false; } }
  function readVolume() {
    try { const v = parseFloat(localStorage.getItem(LS_VOLUME)); return isFinite(v) ? clamp(v, 0, 1) : 1; } catch (e) { return 1; }
  }

  function clean(o) {
    if (!o || typeof o !== 'object') return null;
    let r = null;
    for (const k in o) {
      if (!Object.prototype.hasOwnProperty.call(o, k)) continue;
      const x = o[k];
      if ((typeof x === 'number' && isFinite(x)) || typeof x === 'boolean' || typeof x === 'string') (r || (r = {}))[k] = x;
    }
    return r;
  }

  // ---------------------------------------------------------------- AudioParam helpers
  function hold(p, t) {
    if (p.cancelAndHoldAtTime) { try { p.cancelAndHoldAtTime(t); return; } catch (e) { /* fall through */ } }
    const v = p.value;
    p.cancelScheduledValues(t);
    p.setValueAtTime(v, t);
  }
  // smoothly move a param to v with time constant tc (seconds), from its current value
  function glide(p, v, tc, t) {
    if (t == null) t = now();
    hold(p, t);
    p.setTargetAtTime(v, t, Math.max(0.002, tc));
  }
  // silence -> peak in a seconds -> exponential tail to silence over d seconds
  function perc(p, t, a, peak, d) {
    p.setValueAtTime(0, t);
    p.linearRampToValueAtTime(Math.max(EPS * 2, peak), t + a);
    p.exponentialRampToValueAtTime(EPS, t + a + Math.max(0.002, d));
  }
  function sweep(p, v0, v1, t, d, lin) {
    p.setValueAtTime(v0, t);
    if (lin) p.linearRampToValueAtTime(v1, t + d);
    else p.exponentialRampToValueAtTime(Math.max(EPS, v1), t + d);
  }
  const fsweep = (p, f0, f1, t, d) => sweep(p, hz(f0), hz(f1), t, d);

  // ---------------------------------------------------------------- node factories
  function G(v) { const g = ctx.createGain(); g.gain.value = v == null ? 1 : v; return g; }
  function F(type, f, Q, gainDb) {
    const b = ctx.createBiquadFilter();
    b.type = type; b.frequency.value = hz(f);
    if (Q != null) b.Q.value = Q;
    if (gainDb != null) b.gain.value = gainDb;
    return b;
  }
  function O(type, f) { const o = ctx.createOscillator(); o.type = type; o.frequency.value = f === 0 ? 0 : hz(f); return o; }
  function B(kind) { const s = ctx.createBufferSource(); s.buffer = buffers[kind]; return s; }
  function link() {
    for (let i = 0; i < arguments.length - 1; i++) arguments[i].connect(arguments[i + 1]);
    return arguments[arguments.length - 1];
  }
  function mkPan(p) {
    if (ctx.createStereoPanner) { const n = ctx.createStereoPanner(); n.pan.value = clamp(num(p, 0), -1, 1); return n; }
    return G(1);
  }
  function mkConst(v) {
    if (ctx.createConstantSource) { const c = ctx.createConstantSource(); c.offset.value = v; return c; }
    if (!buffers.ones) { const b = ctx.createBuffer(1, 128, ctx.sampleRate); b.getChannelData(0).fill(1); buffers.ones = b; }
    const s = ctx.createBufferSource(), g = ctx.createGain();
    s.buffer = buffers.ones; s.loop = true; g.gain.value = v; s.connect(g);
    return {
      offset: g.gain,
      connect: (d) => g.connect(d),
      disconnect: () => { try { g.disconnect(); s.disconnect(); } catch (e) { /* ignore */ } },
      start: (t) => s.start(t),
      stop: (t) => s.stop(t)
    };
  }
  function shaper(drive) {
    const ws = ctx.createWaveShaper(), n = 1024, c = new Float32Array(n), k = Math.tanh(drive);
    for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; c[i] = Math.tanh(x * drive) / k; }
    ws.curve = c;
    return ws;
  }
  const off = (buf, d) => R() * Math.max(0, buf.duration - d - 0.06);

  // ---------------------------------------------------------------- generated buffers
  function normalize(d, peak) {
    let m = 0;
    for (let i = 0; i < d.length; i++) { const a = Math.abs(d[i]); if (a > m) m = a; }
    if (m > 0) { const k = peak / m; for (let i = 0; i < d.length; i++) d[i] *= k; }
  }
  // seamless looping noise: generate an overhang and crossfade it into the head
  function makeNoise(channels, sec, gen) {
    const sr = ctx.sampleRate, len = Math.floor(sr * sec), xf = Math.floor(sr * 0.05);
    const b = ctx.createBuffer(channels, len, sr);
    for (let ch = 0; ch < channels; ch++) {
      const d = b.getChannelData(ch), tmp = new Float32Array(len + xf), g = gen();
      for (let i = 0; i < len + xf; i++) tmp[i] = g();
      for (let i = 0; i < len; i++) d[i] = i < xf ? tmp[i] * (i / xf) + tmp[len + i] * (1 - i / xf) : tmp[i];
      normalize(d, 0.9);
    }
    return b;
  }
  function makeSmooth(sec) {
    let sr = 8000, b;
    try { b = ctx.createBuffer(1, sr * sec, sr); } catch (e) { sr = ctx.sampleRate; b = ctx.createBuffer(1, sr * sec, sr); }
    const d = b.getChannelData(0), n = sec * SMOOTH_PPS, pts = new Float32Array(n + 1), seg = sr / SMOOTH_PPS;
    for (let i = 0; i < n; i++) pts[i] = R() * 2 - 1;
    pts[n] = pts[0];
    for (let i = 0; i < d.length; i++) {
      const x = i / seg, k = Math.floor(x), fr = x - k, w = (1 - Math.cos(Math.PI * fr)) / 2;
      d[i] = pts[k] + (pts[Math.min(n, k + 1)] - pts[k]) * w;
    }
    return b;
  }
  // small tiled treatment room: short, bright, a few early reflections
  function makeIR(sec) {
    const sr = ctx.sampleRate, len = Math.floor(sr * sec), b = ctx.createBuffer(2, len, sr);
    for (let ch = 0; ch < 2; ch++) {
      const d = b.getChannelData(ch);
      let lp = 0;
      for (let i = 0; i < len; i++) {
        const t = i / sr, damp = 0.12 + 0.75 * Math.exp(-t / 0.18);
        lp += (R() * 2 - 1 - lp) * damp;
        d[i] = lp * Math.exp(-t / 0.13) * (t < 0.004 ? t / 0.004 : 1);
      }
      for (let k = 0; k < 7; k++) {
        const i = Math.floor(sr * rnd(0.005, 0.04));
        if (i < len) d[i] += (R() < 0.5 ? -1 : 1) * rnd(0.25, 0.6);
      }
    }
    return b;
  }
  function makeBuffers() {
    const sr = ctx.sampleRate;
    buffers.white = makeNoise(2, 2.5, () => () => R() * 2 - 1);
    buffers.pink = makeNoise(2, 2.5, () => {   // Paul Kellet's economy pink filter
      let b0 = 0, b1 = 0, b2 = 0;
      return () => {
        const w = R() * 2 - 1;
        b0 = 0.99765 * b0 + w * 0.099046; b1 = 0.963 * b1 + w * 0.2965164; b2 = 0.57 * b2 + w * 1.0526913;
        return b0 + b1 + b2 + w * 0.1848;
      };
    });
    buffers.brown = makeNoise(1, 2.5, () => { let l = 0; return () => (l = (l + 0.02 * (R() * 2 - 1)) / 1.02); });
    buffers.crackle = makeNoise(2, 2.5, () => {   // sparse random clicks: bristles, foam, grit
      const dens = 1500 / sr;
      return () => (R() < dens ? (R() < 0.5 ? -1 : 1) * (0.15 + 0.85 * R() * R()) : 0);
    });
    buffers.smooth = makeSmooth(30);
    buffers.ir = makeIR(0.8);
  }

  // ---------------------------------------------------------------- context and graph
  function canStart() {
    const ua = navigator.userActivation;
    return !ua || ua.hasBeenActive;
  }
  function ensureCtx() {
    if (ctx) return true;
    if (!AC || !canStart()) return false;
    try {
      try { ctx = new AC({ latencyHint: 'interactive' }); } catch (e) { ctx = new AC(); }
      makeBuffers();
      comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -15; comp.knee.value = 12; comp.ratio.value = 3;
      comp.attack.value = 0.004; comp.release.value = 0.2;
      master = G(muted ? 0 : volume * MASTER);
      link(master, comp, ctx.destination);
      loopBus = G(1); fxBus = G(1);
      loopBus.connect(master); fxBus.connect(master);
      try {
        const conv = ctx.createConvolver();
        conv.buffer = buffers.ir;
        revIn = G(1);
        link(revIn, conv, G(0.5), master);
      } catch (e) { revIn = null; }
      ctx.onstatechange = () => { if (ctx && ctx.state === 'running') onRunning(); };
      if (!schedTimer) schedTimer = setInterval(tick, 25);
    } catch (e) {
      note(e);
      try { if (ctx && ctx.close) ctx.close(); } catch (e2) { /* ignore */ }
      ctx = null;
      return false;
    }
    return true;
  }
  function onRunning() {
    unlocked = true;
    for (const k of Object.keys(pending)) { const o = pending[k]; delete pending[k]; loop(k, o); }
  }
  function unlock() {
    init();
    if (!ensureCtx()) return Promise.resolve(false);
    if (ctx.state === 'running') { if (!unlocked || Object.keys(pending).length) onRunning(); return Promise.resolve(true); }
    // iOS: playing something inside the gesture is what really unlocks output (only needed while not running)
    try { const s = ctx.createBufferSource(); s.buffer = ctx.createBuffer(1, 1, 22050); s.connect(ctx.destination); s.start(0); } catch (e) { /* ignore */ }
    if (document.hidden) return Promise.resolve(false);
    let p;
    try { p = ctx.resume(); } catch (e) { p = null; }
    return Promise.resolve(p).then(
      () => { const ok = !!ctx && ctx.state === 'running'; if (ok) onRunning(); return ok; },
      () => false
    );
  }
  function onGesture() { if (!ctx || ctx.state !== 'running') unlock(); }
  function onVisibility() {
    if (!ctx) return;
    try {
      if (document.hidden) { if (ctx.state === 'running') Promise.resolve(ctx.suspend()).catch(() => {}); }
      else if (unlocked && ctx.state !== 'running') Promise.resolve(ctx.resume()).catch(() => {});
    } catch (e) { /* ignore */ }
  }
  function init() {
    if (!inited) {
      inited = true;
      const o = { capture: true, passive: true };
      for (const ev of ['pointerdown', 'mousedown', 'touchend', 'keydown', 'click']) {
        try { window.addEventListener(ev, onGesture, o); } catch (e) { /* ignore */ }
      }
      try { document.addEventListener('visibilitychange', onVisibility); } catch (e) { /* ignore */ }
    }
    return SFX;
  }
  function applyMaster() { if (master) glide(master.gain, muted ? 0 : volume * MASTER, 0.03); }
  function setMuted(b) {
    muted = !!b;
    try { localStorage.setItem(LS_MUTED, muted ? '1' : '0'); } catch (e) { /* ignore */ }
    applyMaster();
    return muted;
  }
  function setVolume(v) {
    volume = clamp(num(v, 1), 0, 1);
    try { localStorage.setItem(LS_VOLUME, String(volume)); } catch (e) { /* ignore */ }
    applyMaster();
    return volume;
  }

  // ---------------------------------------------------------------- scheduler (grains, bubbles, strokes)
  function tick() {
    if (!ctx || ctx.state !== 'running') return;
    const ct = ctx.currentTime, until = ct + LOOKAHEAD;
    for (let i = voices.length - 1; i >= 0; i--) {
      const v = voices[i];
      if (v.dead) { voices.splice(i, 1); continue; }
      if (v.stopping || !v.def.sched) continue;
      if (v.nextT < ct) v.nextT = ct + 0.005;
      try { v.def.sched(v, until); } catch (e) { note(e); v.nextT = until; }
    }
  }

  // ---------------------------------------------------------------- shared micro-sounds
  // filtered noise burst with a percussive envelope; returns the filter so it can be swept
  function nb(dest, kind, t, dur, ftype, f, Q, amp, att) {
    const s = B(kind), fl = F(ftype, f, Q), g = G(0);
    link(s, fl, g, dest);
    perc(g.gain, t, att || 0.001, amp, dur);
    s.start(t, off(s.buffer, dur), (att || 0.001) + dur + 0.05);
    return fl;
  }
  // decaying sine (or other wave) partial; returns the oscillator so it can be swept
  function ring(dest, t, f, amp, d, att, type) {
    const o = O(type || 'sine', f), g = G(0), a = att || 0.002;
    perc(g.gain, t, a, amp, d);
    link(o, g, dest);
    o.start(t); o.stop(t + a + d + 0.05);
    return o;
  }
  // Minnaert-style bubble: sine whose pitch rises while it decays
  function bubble(dest, t, f, dur, amp) {
    const o = ring(dest, t, f, amp, dur, 0.0015);
    fsweep(o.frequency, f, f * rnd(1.4, 2.5), t, dur);
  }
  // water droplet "plink"
  function droplet(dest, t, amp) {
    const f = rnd(1300, 3800), o = ring(dest, t, f, amp, rnd(0.008, 0.02), 0.0006);
    fsweep(o.frequency, f, f * rnd(1.15, 1.6), t, 0.012);
  }
  // short noise grain through a resonant band (scraping)
  function grain(dest, t, f, Q, dur, amp) {
    const s = B('white'), bp = F('bandpass', f, Q), g = G(0);
    link(s, bp, g, dest);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(Math.max(EPS * 2, amp), t + 0.0007);
    g.gain.exponentialRampToValueAtTime(EPS, t + 0.0007 + dur);
    s.start(t, off(s.buffer, dur), dur + 0.04);
  }
  // marimba-ish pluck for melodies
  function pluck(dest, t, f, amp, d) {
    ring(dest, t, f, amp, d, 0.003);
    ring(dest, t, f * 2, amp * 0.22, d * 0.5, 0.002, 'triangle');
    ring(dest, t, f * 3.98, amp * 0.16, d * 0.16, 0.001);
    nb(dest, 'white', t, 0.012, 'bandpass', Math.min(12000, f * 4), 2, amp * 0.5);
  }

  // ---------------------------------------------------------------- Voice (a running loop)
  class Voice {
    constructor(name, def, opts) {
      this.name = name;
      this.def = def;
      this.o = Object.assign({}, def.defaults, clean(opts));
      this.nodes = []; this.srcs = [];
      this.stopping = false; this.dead = false; this.killTimer = 0; this.nextT = 0;
      const t = this.t0 = now();
      this.out = G(0);
      this.panner = mkPan(num(this.o.pan, 0));
      link(this.out, this.panner, loopBus);
      if (revIn && def.send) { this.sendG = G(def.send); link(this.out, this.sendG, revIn); }
      try { def.build(this, t); } catch (e) { this.dispose(); throw e; }
      glide(this.out.gain, this.level(), (def.attack || 0.05) / 3, t);
      voices.push(this);
    }
    level() { return clamp(num(this.o.volume, 1), 0, 2) * (this.def.gain || 1); }
    keep(n) { this.nodes.push(n); return n; }
    gain(v) { return this.keep(G(v)); }
    filter(type, f, Q, g) { return this.keep(F(type, f, Q, g)); }
    osc(type, f) { const o = this.keep(O(type, f)); o.start(this.t0); this.srcs.push(o); return o; }
    cst(v) { const c = this.keep(mkConst(v)); c.start(this.t0); this.srcs.push(c); return c; }
    noise(kind) {
      const s = this.keep(B(kind));
      s.loop = true;
      s.start(this.t0, R() * s.buffer.duration * 0.9);
      this.srcs.push(s);
      return s;
    }
    // smooth random modulation: `rate` changes per second, +-depth, summed into param
    mod(rate, depth, param) {
      const s = this.keep(B('smooth')), g = this.gain(depth);
      s.loop = true;
      s.playbackRate.value = rate / SMOOTH_PPS;
      link(s, g, param);
      s.start(this.t0, R() * s.buffer.duration * 0.95);
      this.srcs.push(s);
      return g;
    }
    lfo(type, f, depth, param) {
      const o = this.osc(type, f), g = this.gain(depth);
      link(o, g, param);
      o.depth = g;
      return o;
    }
    update(opts) {
      const c = clean(opts);
      if (!c) return;
      const prev = this.o;
      this.o = Object.assign({}, prev, c);
      const t = now();
      if (!this.stopping && !near(num(prev.volume, 1), num(this.o.volume, 1))) glide(this.out.gain, this.level(), 0.04, t);
      if (this.panner.pan && 'pan' in c && !near(prev.pan, this.o.pan)) glide(this.panner.pan, clamp(num(this.o.pan, 0), -1, 1), 0.06, t);
      if (this.def.update) this.def.update(this, t, prev);
    }
    release() {
      if (this.stopping || this.dead) return;
      this.stopping = true;
      const t = now(), r = this.def.release || 0.2;
      glide(this.out.gain, 0, r / 4, t);
      if (this.def.onStop) { try { this.def.onStop(this, t); } catch (e) { note(e); } }
      clearTimeout(this.killTimer);
      this.killTimer = setTimeout(() => this.dispose(), (r * 2 + 0.15) * 1000);
    }
    revive() {
      if (!this.stopping || this.dead) return;
      this.stopping = false;
      clearTimeout(this.killTimer);
      const t = now();
      glide(this.out.gain, this.level(), (this.def.attack || 0.05) / 3, t);
      if (this.def.onRevive) { try { this.def.onRevive(this, t); } catch (e) { note(e); } }
    }
    dispose() {
      if (this.dead) return;
      this.dead = true;
      clearTimeout(this.killTimer);
      for (const s of this.srcs) { try { s.stop(); } catch (e) { /* already stopped */ } }
      for (const n of this.nodes) { try { n.disconnect(); } catch (e) { /* ignore */ } }
      try { this.out.disconnect(); this.panner.disconnect(); if (this.sendG) this.sendG.disconnect(); } catch (e) { /* ignore */ }
      if (active[this.name] === this) delete active[this.name];
    }
  }

  // ---------------------------------------------------------------- LOOPS
  const LOOPS = {};

  // Dental air turbine: piercing whine + micromotor hum + exhaust hiss; load drops the pitch,
  // roughens it and adds bur-on-enamel grinding. Spins up on start, spins down on stop.
  const drillHz = (L) => 6150 - 2350 * L;
  function drillApply(v, t, tc) {
    const L = clamp(num(v.o.load, 0), 0, 1), W = clamp(num(v.o.wet, 0), 0, 1);
    if (!v.stopping) glide(v.f.offset, drillHz(L), tc, t);
    glide(v.jSlow.gain, 35 + 170 * L, tc, t);
    glide(v.jFast.gain, 9 + 35 * L, tc, t);
    glide(v.fmD.gain, 12 + 80 * L, tc, t);
    glide(v.whine.gain, 1 - 0.35 * L, tc, t);
    glide(v.grind.gain, 0.15 * L, tc, t);
    glide(v.grJ.gain, 0.12 * L, tc, t);
    glide(v.chatD.gain, 0.12 * L, tc, t);
    glide(v.crunch.gain, 0.22 * L, tc, t);
    glide(v.chD2.gain, 0.15 * L, tc, t);
    glide(v.chat.frequency, 28 + 20 * L, tc, t);
    glide(v.wetG.gain, 0.1 * W, tc, t);
    glide(v.wetJ.gain, 0.08 * W, tc, t);
  }
  LOOPS.drill = {
    gain: 1, attack: 0.08, release: 0.6, send: 0.05,
    defaults: { load: 0, wet: 0 },
    build(v, t) {
      const L = clamp(num(v.o.load, 0), 0, 1), W = clamp(num(v.o.wet, 0), 0, 1);
      // one ConstantSource = whine fundamental in Hz; every partial (and the hum) follows it
      const f = v.f = v.cst(1400);
      f.offset.setValueAtTime(1400, t);
      f.offset.setTargetAtTime(drillHz(L), t, 0.15);          // spin-up
      v.jSlow = v.mod(2.5, 35 + 170 * L, f.offset);           // slow wander, wider under load
      v.jFast = v.mod(40, 9 + 35 * L, f.offset);              // fast jitter
      const fm = v.osc('sine', rnd(52, 66));
      v.fmD = v.gain(12 + 80 * L);
      link(fm, v.fmD, f.offset);                              // FM roughness
      const follow = (type, mult) => { const o = v.osc(type, 0), k = v.gain(mult); link(f, k, o.frequency); return o; };
      // whine: sine core, slightly detuned twin (shimmer), a little band-limited saw edge
      v.whine = v.gain(1 - 0.35 * L);
      v.whine.connect(v.out);
      link(follow('sine', 1), v.gain(0.07), v.whine);
      link(follow('sine', 1.0017), v.gain(0.035), v.whine);
      link(follow('sawtooth', 1), v.filter('lowpass', 9500, 0), v.gain(0.02), v.whine);
      link(follow('sine', 2), v.gain(0.01), v.whine);
      link(follow('sine', 0.5), v.gain(0.009), v.whine);
      // micromotor hum: ~200 Hz idle, ~125 Hz under load
      const humLp = v.filter('lowpass', 700, 1);
      v.hum = v.gain(0.045);
      link(humLp, v.hum, v.out);
      link(follow('sawtooth', 0.033), v.gain(0.6), humLp);
      link(follow('sine', 0.033), v.gain(0.8), humLp);
      link(follow('sine', 0.066), v.gain(0.25), humLp);
      v.mod(7, 0.015, v.hum.gain);
      // exhaust air hiss
      v.hiss = v.gain(0.04);
      link(v.noise('white'), v.filter('highpass', 2600, 0), v.filter('peaking', 8500, 1, 5), v.hiss, v.out);
      v.mod(9, 0.007, v.hiss.gain);
      // grinding: band noise, saturated, chattering
      const gbp = v.filter('bandpass', 2300, 0.9);
      v.mod(4, 450, gbp.frequency);
      v.grind = v.gain(0.15 * L);
      link(v.noise('white'), gbp, v.keep(shaper(2.5)), v.grind, v.out);
      v.chat = v.osc('sawtooth', 28 + 20 * L);
      v.chatD = v.gain(0.12 * L);
      link(v.chat, v.chatD, v.grind.gain);
      v.grJ = v.mod(35, 0.12 * L, v.grind.gain);
      v.crunch = v.gain(0.22 * L);
      link(v.noise('brown'), v.filter('bandpass', 480, 1.2), v.crunch, v.out);
      v.chD2 = v.gain(0.15 * L);
      link(v.chat, v.chD2, v.crunch.gain);
      // coolant spray (opts.wet)
      v.wetG = v.gain(0.1 * W);
      link(v.noise('white'), v.filter('bandpass', 1700, 1.3), v.wetG, v.out);
      v.wetJ = v.mod(20, 0.08 * W, v.wetG.gain);
      // pedal: short puff of air as the turbine kicks in
      nb(v.panner, 'white', t, 0.16, 'highpass', 2500, 0, 0.05, 0.02);
      v.nextT = t + 0.03;
    },
    update(v, t, prev) {
      if (near(prev.load, v.o.load) && near(prev.wet, v.o.wet)) return;
      // still spinning up: keep the slow ramp; otherwise the bur bogs down fast and recovers slower
      const tc = t - v.t0 < 0.45 ? 0.15 : num(v.o.load, 0) > num(prev.load, 0) ? 0.05 : 0.12;
      drillApply(v, t, tc);
    },
    onStop(v, t) {
      glide(v.f.offset, 500, 0.3, t);                         // spin-down
      for (const g of [v.grind.gain, v.grJ.gain, v.chatD.gain, v.crunch.gain, v.chD2.gain, v.wetG.gain]) glide(g, 0, 0.03, t);
    },
    onRevive(v, t) { drillApply(v, t, 0.1); },
    sched(v, until) {
      const W = clamp(num(v.o.wet, 0), 0, 1);
      if (W < 0.03) { v.nextT = until; return; }
      while (v.nextT < until) {
        const t = v.nextT;
        if (R() < 0.6) droplet(v.out, t, rnd(0.01, 0.035) * W);
        else bubble(v.out, t, rnd(600, 2000), rnd(0.01, 0.03), rnd(0.02, 0.05) * W);
        v.nextT += expRand(1 / (4 + 14 * W));
      }
    }
  };

  // Saliva ejector: airflow roar + vacuum rumble + resonant slurp + bubbly pops (opts.wet)
  LOOPS.suction = {
    gain: 1, attack: 0.15, release: 0.25, send: 0.04,
    defaults: { wet: 0.6 },
    build(v, t) {
      const W = clamp(num(v.o.wet, 0.6), 0, 1);
      const n = v.noise('pink');
      const bp = v.filter('bandpass', 1700, 0.55);
      v.mod(2.2, 550, bp.frequency);
      const air = v.gain(0.65);
      link(n, bp, air, v.out);
      v.mod(5, 0.12, air.gain);
      const tip = v.gain(0.24);
      link(n, v.filter('highpass', 3500, 0), v.filter('peaking', 6000, 1, 3), tip, v.out);
      v.mod(6, 0.05, tip.gain);
      const rum = v.gain(0.13);
      link(v.noise('brown'), v.filter('highpass', 70, 0), v.filter('lowpass', 260, 0), rum, v.out);
      v.mod(3, 0.05, rum.gain);
      const gb = v.filter('bandpass', 750, 6);
      v.mod(8, 420, gb.frequency);
      v.gurg = v.gain(2 * W);
      v.gurgAm = v.mod(7, 1.8 * W, v.gurg.gain);
      link(v.noise('white'), gb, v.gurg, v.out);
      v.nextT = t + 0.03;
    },
    update(v, t, prev) {
      if (near(prev.wet, v.o.wet)) return;
      const W = clamp(num(v.o.wet, 0.6), 0, 1);
      glide(v.gurg.gain, 2 * W, 0.1, t);
      glide(v.gurgAm.gain, 1.8 * W, 0.1, t);
    },
    sched(v, until) {
      while (v.nextT < until) {
        const W = clamp(num(v.o.wet, 0.6), 0, 1), t = v.nextT, k = 0.4 + 0.6 * W;
        if (W > 0.02) {
          if (R() < 0.18) {                                   // a slurp: cluster of big bubbles
            const n = 3 + Math.floor(R() * 4);
            for (let i = 0; i < n; i++) bubble(v.out, t + rnd(0, 0.07), rnd(260, 900), rnd(0.02, 0.06), rnd(0.05, 0.13) * k);
          } else bubble(v.out, t, rnd(350, 1500), rnd(0.012, 0.04), rnd(0.03, 0.1) * k);
        }
        v.nextT += expRand(1 / (2 + 14 * W));
      }
    }
  };

  // Irrigator: wide hissy spray + splatter on enamel + low gush + droplet ticks
  LOOPS.water = {
    gain: 1, attack: 0.05, release: 0.18, send: 0.07,
    defaults: { intensity: 1 },
    build(v, t) {
      const I = clamp(num(v.o.intensity, 1), 0, 1);
      const n = v.noise('white');
      const bp = v.filter('bandpass', 3000, 0.6);
      v.mod(1.6, 450, bp.frequency);
      v.spray = v.gain(0.3 * (0.35 + 0.65 * I));
      v.mod(11, 0.035, v.spray.gain);
      link(n, bp, v.spray, v.out);
      link(n, v.filter('highpass', 6500, 0), v.gain(0.05), v.out);
      v.splat = v.gain(0.28 * I);
      v.splatJ = v.mod(26, 0.22 * I, v.splat.gain);
      link(v.noise('white'), v.filter('bandpass', 1300, 1.4), v.splat, v.out);
      v.gush = v.gain(0.14 * I);
      link(v.noise('brown'), v.filter('highpass', 120, 0), v.filter('lowpass', 520, 0), v.gush, v.out);
      v.nextT = t + 0.02;
    },
    update(v, t, prev) {
      if (near(prev.intensity, v.o.intensity)) return;
      const I = clamp(num(v.o.intensity, 1), 0, 1);
      glide(v.spray.gain, 0.3 * (0.35 + 0.65 * I), 0.06, t);
      glide(v.splat.gain, 0.28 * I, 0.06, t);
      glide(v.splatJ.gain, 0.22 * I, 0.06, t);
      glide(v.gush.gain, 0.14 * I, 0.06, t);
    },
    sched(v, until) {
      while (v.nextT < until) {
        const I = clamp(num(v.o.intensity, 1), 0, 1), t = v.nextT;
        if (R() < 0.85) droplet(v.out, t, rnd(0.015, 0.05) * (0.5 + 0.5 * I));
        else bubble(v.out, t, rnd(800, 2400), rnd(0.01, 0.025), rnd(0.02, 0.05));
        v.nextT += expRand(1 / (6 + 18 * I));
      }
    }
  };

  // Scaler on tartar: granular scritch through a resonant metal band; opts.speed drives density
  const spd = (v, d) => clamp(num(v.o.speed, d), 0, 1);
  LOOPS.scrape = {
    gain: 1, attack: 0.03, release: 0.12, send: 0.04,
    defaults: { speed: 0.5 },
    build(v, t) {
      const S = spd(v, 0.5);
      v.bus = v.filter('highpass', 1500, 0);
      link(v.bus, v.filter('peaking', 4300, 1.4, 5), v.filter('peaking', 7400, 4, 3), v.out);
      v.fric = v.gain(0.06 + 0.16 * S);
      link(v.noise('white'), v.filter('bandpass', 3800, 2.2), v.fric, v.bus);
      v.fricJ = v.mod(16, 0.04 + 0.12 * S, v.fric.gain);
      v.rw = 0;
      v.nextT = t + 0.005;
    },
    update(v, t, prev) {
      if (near(prev.speed, v.o.speed)) return;
      const S = spd(v, 0.5);
      glide(v.fric.gain, 0.06 + 0.16 * S, 0.05, t);
      glide(v.fricJ.gain, 0.04 + 0.12 * S, 0.05, t);
    },
    sched(v, until) {
      while (v.nextT < until) {
        const S = spd(v, 0.5), t = v.nextT;
        if (R() < 0.06) {                                     // a chunk of tartar cracks off
          grain(v.bus, t, rnd(1100, 2200), rnd(1.5, 3), rnd(0.018, 0.035), rnd(0.5, 0.9) * (0.5 + 0.5 * S));
        } else {
          const Q = rnd(3, 11);
          grain(v.bus, t, rnd(2400, 6800), Q, rnd(0.003, 0.011), rnd(0.25, 0.75) * (0.5 + 0.5 * S) * Math.sqrt(Q) * 0.35);
        }
        if (R() < 0.025 + 0.04 * S) ring(v.bus, t, rnd(6200, 9000), rnd(0.008, 0.02), rnd(0.03, 0.07), 0.0005);
        v.rw = clamp(v.rw * 0.96 + (R() - 0.5) * 0.25, -0.7, 0.7);   // stick-slip clustering
        const rate = (9 + 116 * Math.pow(S, 0.85)) * (1 + v.rw);
        v.nextT += rnd(0.35, 1.65) / Math.max(2, rate);
      }
    }
  };

  // Toothbrush: back-and-forth bristle swishes (~6-8 Hz) + bristle flicks + foam fizz
  function stroke(v, t, d, S) {
    const a = (0.2 + 0.42 * S) * rnd(0.75, 1.1), fwd = v.dir === 0;
    const pn = mkPan(fwd ? -0.14 : 0.14);
    pn.connect(v.bus);
    const env = (g, k) => {
      const p = g.gain;
      p.setValueAtTime(0, t);
      p.linearRampToValueAtTime(a * k, t + d * 0.22);
      p.linearRampToValueAtTime(a * k * 0.55, t + d * 0.62);
      p.linearRampToValueAtTime(0, t + d * 0.97);
    };
    const s = B('white'), bp = F('bandpass', 2000, 0.8), g = G(0);
    fsweep(bp.frequency, fwd ? 1900 : 3900, fwd ? 3900 : 1900, t, d * 0.85);
    env(g, 1);
    link(s, bp, g, pn);
    s.start(t, off(s.buffer, d), d + 0.02);
    const c = B('crackle'), cg = G(0);
    env(cg, 0.9);
    link(c, F('highpass', 3200, 0), cg, pn);
    c.start(t, off(c.buffer, d), d + 0.02);
  }
  LOOPS.brush = {
    gain: 1, attack: 0.05, release: 0.18, send: 0.03,
    defaults: { speed: 0.7 },
    build(v, t) {
      v.bus = v.filter('highpass', 650, 0);
      v.bus.connect(v.out);
      v.fizz = v.gain(0.12);
      link(v.noise('crackle'), v.filter('highpass', 5200, 0), v.fizz, v.out);
      v.mod(3, 0.07, v.fizz.gain);
      v.dir = 0;
      v.nextT = t + 0.01;
    },
    sched(v, until) {
      while (v.nextT < until) {
        const S = spd(v, 0.7), d = rnd(0.88, 1.12) / (5.2 + 3.3 * S);
        stroke(v, v.nextT, d, S);
        v.dir ^= 1;
        v.nextT += d;
      }
    }
  };

  // House fly: detuned saws ~190-230 Hz, random vibrato, amplitude flutter, drifting pan
  LOOPS.fly = {
    gain: 1, attack: 0.18, release: 0.35, send: 0.05,
    defaults: { intensity: 1, pan: 0 },
    build(v, t) {
      const f = v.f = v.cst(rnd(196, 224));
      v.lfo('sine', rnd(6, 9), rnd(3, 6), f.offset);
      v.mod(1.3, 14, f.offset);
      v.mod(25, 4, f.offset);
      const hpf = v.filter('highpass', 140, 0);
      const mk = (type, mult, amp) => { const o = v.osc(type, 0), k = v.gain(mult); link(f, k, o.frequency); link(o, v.gain(amp), hpf); };
      mk('sawtooth', 1, 0.5);
      mk('sawtooth', 1.007, 0.35);
      mk('triangle', 2, 0.15);
      const lp = v.filter('lowpass', 2800, 0.9);
      v.mod(2, 900, lp.frequency);
      v.gate = v.gain(1);
      v.vca = v.gain(0.2);
      link(hpf, lp, v.filter('peaking', 950, 1.3, 6), v.gate, v.vca, v.out);
      v.mod(4, 0.065, v.vca.gain);                            // flutter
      if (v.panner.pan) v.mod(0.45, 0.3, v.panner.pan);       // wandering around the base pan
      v.on = true;
      v.nextT = t;
    },
    sched(v, until) {
      const I = clamp(num(v.o.intensity, 1), 0, 1);
      if (I >= 0.98) {
        if (!v.on) { glide(v.gate.gain, 1, 0.02); v.on = true; }
        v.nextT = until;
        return;
      }
      while (v.nextT < until) {
        const t = v.nextT;
        if (v.on) { v.gate.gain.setTargetAtTime(0, t, 0.03); v.on = false; v.nextT += rnd(0.15, 1.2) * (1.2 - I); }
        else { v.gate.gain.setTargetAtTime(1, t, 0.015); v.on = true; v.nextT += rnd(0.12, 0.5) * (0.5 + I); }
      }
    }
  };

  // Curing lamp (extra): small fan, mains hum, faint electronics whine; beeps at start
  LOOPS.lamp = {
    gain: 1, attack: 0.04, release: 0.15, send: 0.02,
    defaults: {},
    build(v, t) {
      const fan = v.gain(0.13);
      link(v.noise('brown'), v.filter('highpass', 120, 0), v.filter('bandpass', 380, 0.9), fan, v.out);
      v.mod(5, 0.02, fan.gain);
      link(v.osc('sine', 100), v.gain(0.012), v.out);
      link(v.osc('sine', 9600), v.gain(0.0035), v.out);
      link(v.noise('white'), v.filter('highpass', 5000, 0), v.gain(0.012), v.out);
      SHOTS.beep({ t, out: v.panner, p: 1, o: { n: 1 }, send() {} });
    }
  };

  // ---------------------------------------------------------------- ONE-SHOTS
  // each gets S = {t, out, p (pitch), o (opts), send(amount)} and returns its length in seconds
  const SHOTS = {
    click(S) {
      const { t, out, p } = S;
      const a = ring(out, t, 2300 * p, 0.28, 0.035, 0.0008);
      fsweep(a.frequency, 2300 * p, 1250 * p, t, 0.03);
      const b = ring(out, t, 480 * p, 0.2, 0.04, 0.001, 'triangle');
      fsweep(b.frequency, 480 * p, 260 * p, t, 0.04);
      nb(out, 'white', t, 0.008, 'highpass', 3000, 0, 0.25);
      return 0.12;
    },

    tick(S) {
      const { t, out } = S;
      const tock = S.o.tock != null ? !!S.o.tock : tickN++ % 2 === 1;
      const p = S.p * (tock ? 0.78 : 1);
      nb(out, 'white', t, 0.01, 'bandpass', 4200 * p, 3, 0.8);
      ring(out, t, 2100 * p, 0.16, 0.018, 0.0005);
      ring(out, t, 1150 * p, 0.12, 0.03, 0.0005, 'triangle');
      return 0.08;
    },

    // a steel instrument lifted off the tray: soft clack + inharmonic ringing partials
    pick(S) {
      const { t, out } = S, k = rnd(0.96, 1.04) * S.p;
      nb(out, 'white', t, 0.012, 'bandpass', 1800 * k, 1.2, 0.22);
      nb(out, 'white', t, 0.004, 'highpass', 5000, 0, 0.12);
      const P = [[2870, 0.05, 0.45], [4190, 0.04, 0.32], [5340, 0.03, 0.26], [7060, 0.02, 0.16], [9230, 0.012, 0.1]];
      for (const [f, a, d] of P) {
        ring(out, t + 0.002, f * k, a, d, 0.0015);
        ring(out, t + 0.002, f * k * 1.0021, a * 0.6, d * 0.8, 0.0015);
      }
      nb(out, 'pink', t + 0.01, 0.12, 'bandpass', 1400, 0.8, 0.04, 0.05);
      S.send(0.22);
      return 0.6;
    },

    // squeaky-clean enamel / latex glove: stick-slip saw through a moving band
    squeak(S) {
      const { t, out, p } = S, f0 = rnd(900, 1250) * p, d = rnd(0.09, 0.15);
      const o = O('sawtooth', f0), bp = F('bandpass', f0 * 2.2, 3), g = G(0);
      o.frequency.setValueAtTime(f0, t);
      o.frequency.exponentialRampToValueAtTime(hz(f0 * rnd(1.5, 1.9)), t + d * 0.35);
      o.frequency.exponentialRampToValueAtTime(hz(f0 * rnd(1.2, 1.45)), t + d);
      bp.frequency.setValueAtTime(hz(f0 * 2.2), t);
      bp.frequency.exponentialRampToValueAtTime(hz(f0 * 3.6), t + d * 0.35);
      bp.frequency.exponentialRampToValueAtTime(hz(f0 * 2.8), t + d);
      const j = O('square', rnd(45, 70)), jg = G(f0 * 0.03);
      link(j, jg, o.frequency);
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.28, t + 0.012);
      g.gain.linearRampToValueAtTime(0.2, t + d * 0.7);
      g.gain.exponentialRampToValueAtTime(EPS, t + d + 0.03);
      link(o, bp, F('lowpass', 6000, 0), g, out);
      o.start(t); j.start(t);
      o.stop(t + d + 0.06); j.stop(t + d + 0.06);
      return d + 0.1;
    },

    // patient spits: lip plosive, wet spray sweeping down, bubbles, splat into the basin
    spit(S) {
      const { t, out } = S;
      const th = ring(out, t, 150, 0.28, 0.07, 0.002);
      fsweep(th.frequency, 150, 55, t, 0.06);
      nb(out, 'white', t, 0.03, 'lowpass', 1800, 0, 0.25);
      const sp = nb(out, 'white', t + 0.01, 0.28, 'bandpass', 3400, 1.1, 0.42, 0.008);
      fsweep(sp.frequency, 3400, 800, t + 0.01, 0.25);
      for (let i = 0; i < 7; i++) bubble(out, t + rnd(0.02, 0.22), rnd(700, 2200), rnd(0.012, 0.03), rnd(0.04, 0.1));
      const ts = t + rnd(0.3, 0.36);
      nb(out, 'white', ts, 0.09, 'lowpass', 1100, 0, 0.3, 0.003);
      nb(out, 'white', ts, 0.05, 'bandpass', 2500, 1.5, 0.12);
      for (let i = 0; i < 5; i++) droplet(out, ts + rnd(0.01, 0.15), rnd(0.03, 0.07));
      S.send(0.15);
      return 0.7;
    },

    // bubble pop: rising "bloop" + click
    pop(S) {
      const { t, out, p } = S, f = rnd(520, 700) * p;
      const o = ring(out, t, f, 0.4, 0.07, 0.001);
      fsweep(o.frequency, f, f * rnd(2.3, 2.9), t, 0.05);
      nb(out, 'white', t, 0.004, 'highpass', 2500, 0, 0.22);
      ring(out, t, 110 * p, 0.08, 0.04, 0.001);
      return 0.15;
    },

    // small reception bell
    ding(S) {
      const { t, out, p } = S, f = 1318.5 * p;
      const P = [[1, 0.085, 1.5], [1.0013, 0.042, 1.3], [2.0, 0.03, 0.9], [2.76, 0.036, 0.7], [3.98, 0.015, 0.45], [5.4, 0.012, 0.3], [6.79, 0.006, 0.2]];
      for (const [r, a, d] of P) ring(out, t, f * r, a, d, 0.002);
      nb(out, 'white', t, 0.006, 'highpass', 6000, 0, 0.05);
      S.send(0.35);
      return 1.8;
    },

    // sparkle: quick rising tinkles with shimmer; opts.index 1..3 raises it per star
    star(S) {
      const { t, out } = S;
      const idx = clamp(Math.round(num(S.o.index, 1)), 1, 5);
      const p = S.p * Math.pow(2, ((idx - 1) * 3) / 12);
      const scale = [1568, 1760, 2093, 2349, 2637, 3136, 3520, 4186];
      for (let i = 0; i < 7; i++) {
        const tt = t + i * 0.042 + rnd(0, 0.012);
        const f = scale[Math.min(scale.length - 1, i + (R() < 0.3 ? 1 : 0))] * p;
        const pn = mkPan(rnd(-0.6, 0.6));
        pn.connect(out);
        ring(pn, tt, f, 0.12 * (1 - i * 0.06), 0.28, 0.002);
        ring(pn, tt, f * 2.01, 0.034, 0.12, 0.002);
      }
      nb(out, 'white', t, 0.45, 'highpass', 7500, 0, 0.05, 0.12);
      S.send(0.45);
      return 1.2;
    },

    // low descending "wah-wah-waaah", muted-brass-ish
    fail(S) {
      const { t, out, p } = S;
      const notes = [[330, 311, 0, 0.17], [262, 247, 0.19, 0.17], [208, 156, 0.38, 0.62]];
      notes.forEach(([f0, f1, dt, d], i) => {
        const tt = t + dt, last = i === notes.length - 1;
        const o1 = O('sawtooth', f0 * p), o2 = O('square', f0 * p * 0.5), g2 = G(0.5);
        fsweep(o1.frequency, f0 * p, f1 * p, tt, d);
        fsweep(o2.frequency, f0 * p * 0.5, f1 * p * 0.5, tt, d);
        const lp = F('lowpass', 450, 4), g = G(0);
        lp.frequency.setValueAtTime(450, tt);
        lp.frequency.linearRampToValueAtTime(2000, tt + 0.05);
        lp.frequency.exponentialRampToValueAtTime(420, tt + d);
        g.gain.setValueAtTime(0, tt);
        g.gain.linearRampToValueAtTime(0.18, tt + 0.015);
        g.gain.linearRampToValueAtTime(0.135, tt + d * 0.8);
        g.gain.linearRampToValueAtTime(0, tt + d);
        link(o1, lp); link(o2, g2, lp); link(lp, g, out);
        const srcs = [o1, o2];
        if (last) {
          const l = O('sine', 5.5), l1 = G(f1 * p * 0.025), l2 = G(f1 * p * 0.0125);
          link(l, l1, o1.frequency); link(l, l2, o2.frequency);
          srcs.push(l);
          ring(out, tt, f0 * p * 0.5, 0.1, d, 0.02);
        }
        for (const s of srcs) { s.start(tt); s.stop(tt + d + 0.05); }
      });
      S.send(0.15);
      return 1.2;
    },

    // short cheerful arpeggio C-E-G-C-E + chord + sparkle
    win(S) {
      const { t, out, p } = S;
      const notes = [523.25, 659.25, 783.99, 1046.5, 1318.5];
      notes.forEach((f, i) => pluck(out, t + i * 0.085, f * p, 0.11, i === notes.length - 1 ? 0.9 : 0.32));
      const tc = t + 4 * 0.085;
      pluck(out, tc, 783.99 * p, 0.05, 0.8);
      pluck(out, tc, 1046.5 * p, 0.05, 0.8);
      for (let i = 0; i < 5; i++) ring(out, tc + 0.05 + i * 0.05, rnd(3000, 4800) * p, 0.025, 0.18, 0.002);
      S.send(0.35);
      return 1.6;
    },

    // heavy low impact
    thud(S) {
      const { t, out, p } = S;
      const o = ring(out, t, 120 * p, 0.42, 0.22, 0.002);
      fsweep(o.frequency, 120 * p, 42 * p, t, 0.14);
      // upper body so it still reads on phone / laptop speakers
      const k = ring(out, t, 240 * p, 0.38, 0.1, 0.001, 'triangle');
      fsweep(k.frequency, 240 * p, 120 * p, t, 0.08);
      nb(out, 'brown', t, 0.06, 'lowpass', 600, 0, 0.3);
      nb(out, 'white', t, 0.035, 'bandpass', 520 * p, 1.2, 0.6);
      nb(out, 'white', t, 0.006, 'bandpass', 2200 * p, 1, 0.12);
      nb(out, 'white', t, 0.02, 'bandpass', 900 * p, 1.5, 0.45);   // knock
      return 0.4;
    },

    // fly shooed away: buzz accelerates, then fades off to one side
    buzzshort(S) {
      const { t, out, p } = S, d = rnd(0.35, 0.5), f0 = rnd(205, 230) * p;
      const o1 = O('sawtooth', f0), o2 = O('sawtooth', f0 * 1.008);
      for (const o of [o1, o2]) {
        const f = o.frequency.value;
        o.frequency.setValueAtTime(f, t);
        o.frequency.linearRampToValueAtTime(hz(f * 1.18), t + d * 0.35);
        o.frequency.linearRampToValueAtTime(hz(f * 0.92), t + d);
      }
      const vib = O('sine', rnd(7, 10)), vg = G(6);
      link(vib, vg, o1.frequency); vg.connect(o2.frequency);
      const lp = F('lowpass', 3200, 0.9);
      fsweep(lp.frequency, 3200, 900, t + d * 0.3, d * 0.7);
      const g = G(0);
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.11, t + 0.03);
      g.gain.setTargetAtTime(0, t + d * 0.35, d * 0.22);
      const pn = mkPan(0), side = R() < 0.5 ? -1 : 1;
      if (pn.pan) sweep(pn.pan, 0, side * 0.85, t, d, true);
      link(o1, lp); o2.connect(lp);
      link(lp, F('peaking', 950, 1.3, 6), g, pn, out);
      for (const s of [o1, o2, vib]) { s.start(t); s.stop(t + d + 0.1); }
      return d + 0.2;
    },

    // ---- extras
    // tooth extraction: crunchy cracks + a dull pull
    crack(S) {
      const { t, out, p } = S, n = 6 + Math.floor(R() * 6);
      for (let i = 0; i < n; i++) {
        const Q = rnd(2, 5);
        nb(out, 'white', t + Math.pow(R(), 1.6) * 0.18, rnd(0.004, 0.018), 'bandpass', rnd(900, 3500) * p, Q, rnd(0.6, 1.4) * Math.sqrt(Q));
      }
      const o = ring(out, t, 160 * p, 0.18, 0.09, 0.002);
      fsweep(o.frequency, 160 * p, 70 * p, t, 0.08);
      nb(out, 'brown', t, 0.08, 'lowpass', 900, 0, 0.25);
      return 0.4;
    },

    // filling paste pressed in: wet rising squelch + small bubbles
    squish(S) {
      const { t, out, p } = S, d = 0.26;
      const fl = nb(out, 'pink', t, d, 'bandpass', 300 * p, 3.5, 1.5, 0.02);
      fsweep(fl.frequency, 300 * p, 1300 * p, t, d * 0.8);
      for (let i = 0; i < 4; i++) bubble(out, t + rnd(0.02, d), rnd(300, 900) * p, rnd(0.02, 0.05), rnd(0.06, 0.13));
      return d + 0.2;
    },

    // curing lamp piezo beep(s)
    beep(S) {
      const { t, out, p } = S, n = clamp(Math.round(num(S.o.n, 1)), 1, 5);
      for (let i = 0; i < n; i++) {
        const tt = t + i * 0.16, g = G(0), o = O('sine', 2730 * p), q = O('square', 2730 * p);
        g.gain.setValueAtTime(0, tt);
        g.gain.linearRampToValueAtTime(0.06, tt + 0.004);
        g.gain.setValueAtTime(0.06, tt + 0.085);
        g.gain.linearRampToValueAtTime(0, tt + 0.092);
        link(o, g, out);
        link(q, F('lowpass', 4000, 0), G(0.15), g);
        for (const s of [o, q]) { s.start(tt); s.stop(tt + 0.12); }
      }
      return n * 0.16 + 0.1;
    },

    // swipe / swish
    whoosh(S) {
      const { t, out, p } = S, d = 0.38;
      const s = B('pink'), bp = F('bandpass', 450 * p, 1.2), g = G(0);
      bp.frequency.setValueAtTime(hz(450 * p), t);
      bp.frequency.exponentialRampToValueAtTime(hz(2600 * p), t + d * 0.45);
      bp.frequency.exponentialRampToValueAtTime(hz(700 * p), t + d);
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.6, t + d * 0.45);
      g.gain.exponentialRampToValueAtTime(EPS, t + d);
      link(s, bp, g, out);
      s.start(t, off(s.buffer, d), d + 0.05);
      return d + 0.15;
    }
  };

  // ---------------------------------------------------------------- public functions
  function shot(fn, opts) {
    const t = now() + 0.005;
    const out = G(clamp(num(opts.volume, 1), 0, 2));
    const pan = mkPan(num(opts.pan, 0));
    link(out, pan, fxBus);
    const S = {
      t, out, o: opts,
      p: clamp(num(opts.pitch, 1), 0.25, 4),
      send(amount) { if (revIn && amount > 0) link(out, G(amount), revIn); }
    };
    const dur = num(fn(S), 2);
    setTimeout(() => { try { out.disconnect(); pan.disconnect(); } catch (e) { /* ignore */ } }, (dur + 0.6) * 1000);
  }

  function play(name, opts) {
    const o = clean(opts) || {};
    if (muted) return false;
    init();
    if (!ctx && !ensureCtx()) return false;
    if (document.hidden) return false;
    if (ctx.state !== 'running') {
      unlock();
      // not running yet: only keep the sound if we are inside a gesture (resume is immediate),
      // otherwise it would pile up and fire later all at once
      const ua = navigator.userActivation;
      if (ua && !ua.isActive) return false;
    }
    if (SHOTS[name]) {
      try { shot(SHOTS[name], o); return true; } catch (e) { note(e); return false; }
    }
    const def = LOOPS[name];
    if (def) {                                               // short independent burst of a loop
      try {
        const v = new Voice(name, def, o);
        setTimeout(() => v.release(), clamp(num(o.dur, 0.4), 0.05, 10) * 1000);
        return true;
      } catch (e) { note(e); return false; }
    }
    return false;
  }

  function loop(name, opts) {
    const def = LOOPS[name];
    if (!def) return false;
    init();
    if (!ctx && !ensureCtx()) {
      pending[name] = Object.assign(pending[name] || {}, clean(opts));
      return false;
    }
    if (ctx.state !== 'running' && !document.hidden) unlock();
    let v = active[name];
    if (v && !v.dead) {
      try { v.update(opts); if (v.stopping) v.revive(); } catch (e) { note(e); }
      return true;
    }
    try { v = new Voice(name, def, opts); } catch (e) { note(e); return false; }
    active[name] = v;
    return true;
  }

  function set(name, opts) {
    if (pending[name]) { Object.assign(pending[name], clean(opts)); return true; }
    const v = active[name];
    if (!v || v.dead || v.stopping) return false;
    try { v.update(opts); } catch (e) { note(e); }
    return true;
  }

  function stop(name) {
    if (name == null) {
      for (const k of Object.keys(pending)) delete pending[k];
      for (const k of Object.keys(active)) active[k].release();
      return;
    }
    delete pending[name];
    const v = active[name];
    if (v) v.release();
  }

  function isPlaying(name) {
    const v = active[name];
    return !!(v && !v.dead && !v.stopping) || !!pending[name];
  }

  function debug() {
    return {
      supported: !!AC,
      state: ctx ? ctx.state : 'none',
      unlocked, muted, volume,
      sampleRate: ctx ? ctx.sampleRate : 0,
      time: ctx ? Math.round(ctx.currentTime * 1000) / 1000 : 0,
      loops: Object.keys(active).map((k) => k + (active[k].stopping ? ' (fading)' : '') + ' ' + JSON.stringify(active[k].o)),
      voices: voices.length,
      pending: Object.keys(pending),
      errors: errCount,
      lastError: lastErr
    };
  }

  const SFX = {
    init, unlock, setMuted, play, loop, stop,
    set, setVolume, isPlaying, debug,
    stopAll: () => stop(),
    toggleMuted: () => setMuted(!muted),
    get muted() { return muted; },
    set muted(b) { setMuted(b); },
    get volume() { return volume; },
    get ready() { return !!ctx && ctx.state === 'running'; },
    get ctx() { return ctx; },
    get output() { return comp; },
    names: { oneshots: Object.keys(SHOTS), loops: Object.keys(LOOPS) }
  };

  window.SFX = SFX;
  init();
})();
