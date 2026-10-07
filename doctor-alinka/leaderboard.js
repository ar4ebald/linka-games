/* Доктор Алинка — speed leaderboard client.
   Contract: BRIEF.md «ЛИДЕРБОРД ПО СКОРОСТИ». Backend = Google Sheet + Apps Script web app.
   There is NO secret in this file and there must never be one: the /exec URL from manifest.leaderboard.url
   is public by design, the server only trusts what it can check (nick rules, run log, rate limits).
   ?lbmock=1 swaps the network for a localStorage fake with the same rules (offline UI tests);
   ?lbmock=offline / ?lbmock=busy fake those failures. Nicks are only ever rendered with textContent.
   The only thing kept on the device is `da.claim`: 128 random bits that say "this nick belongs to this device"
   (the server stores only its SHA-256). It is not a password and opens nothing but that nick. */
(() => {
'use strict';

/* ======================================================================
   rules (the mock enforces them; the real server has its own copy)
   ====================================================================== */
// the same numbers as LB in leaderboard/Code.gs: keep both in sync
const RULES = {
  nickMin: 2, nickMax: 16,
  // Latin, Cyrillic, 0-9, space, _ - .  (no invisible Hangul fillers, no Greek look-alikes, no fullwidth)
  nickRe: /^[\p{Script=Latin}\p{Script=Cyrillic}0-9 _.\-]+$/u, nickBad: /[\uFF00-\uFFEF\u115F\u1160\u3164]/,
  maxMs: 150000,                      // CFG.levelTime
  cheatMs: 5000,                      // owner's rule (07.10): anything faster than 5 s is a cheat
  drillMs: 2200, lampMs: 2000,        // CFG.drillTime / CFG.cureTime per cavity
  holdTolMs: 50,                      // one clipped 0.05 s frame
  wiggles: 6,                         // forceps direction changes before the dead tooth loosens
  steps: ['tartar', 'plaque', 'food', 'cavity', 'cavity', 'dead'], // one per closed checklist problem
  flinchMax: 3,
  stars: { levelMs: 150000, two: { time: 0.15, flinch: 1 }, three: { time: 0.35, flinch: 0 } },
  // stars come from the level timer (dt clipped at 0.05 s), ms from the wall clock: on a slow phone the
  // timer lags, so stars / score are capped for the time, never rejected (Code.gs capsFor_)
  lagRatio: 0.8, winDelayMs: 1100, slackMs: 1000, scoreBaseMax: 6000, scoreTimeBonus: 10,
  nickEveryMs: 60000, perMinute: 30, newPerMinute: 10, maxRows: 5000,
};
const TIMEOUT = 8000, LIMIT = 10, CACHE_MS = 15000;

/* ======================================================================
   utils
   ====================================================================== */
const $ = (s) => document.querySelector(s);
function lsGet(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch (e) { return d; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } }
function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }
const int = (v) => typeof v === 'number' && Number.isFinite(v) && Math.floor(v) === v;

// 67300 -> "1:07,3" (tenths are truncated: a run is never shown faster than it was)
function fmtMs(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '—';
  const t = Math.floor(ms / 100), s = Math.floor(t / 10);
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0') + ',' + (t % 10);
}
function normNick(s) { return String(s == null ? '' : s).normalize('NFC').replace(/\s+/g, ' ').trim(); }
// a copy of nickKey_ in Code.gs: case, ё/е and Cyrillic / Greek letters that look Latin are one nick
const TO_LAT = { 'а': 'a', 'в': 'b', 'с': 'c', 'е': 'e', 'ё': 'e', 'н': 'h', 'к': 'k', 'м': 'm', 'о': 'o', 'р': 'p',
  'т': 't', 'х': 'x', 'у': 'y', 'и': 'u', 'і': 'i', 'α': 'a', 'β': 'b', 'ε': 'e', 'η': 'h', 'ι': 'i', 'κ': 'k', 'μ': 'm',
  'ν': 'n', 'ο': 'o', 'ρ': 'p', 'τ': 't', 'χ': 'x', 'υ': 'y', 'ζ': 'z' };
function nickKey(s) {
  s = normNick(s).toLowerCase().replace(/ё/g, 'е');
  let out = '';
  for (const ch of s) out += TO_LAT[ch] || ch;
  return out;
}
// the sheet stores formula-looking nicks as '=x; never show the guard quote
function showNick(s) { s = String(s == null ? '' : s); return /^'[=+\-@]/.test(s) ? s.slice(1) : s; }
function nickError(n) {
  const len = [...n].length;
  if (len < RULES.nickMin || len > RULES.nickMax) return 'len';
  if (!RULES.nickRe.test(n) || RULES.nickBad.test(n) || !/[\p{L}0-9]/u.test(n)) return 'chars';
  return '';
}
const NICK_MSG = {
  len: 'Ник: от 2 до 16 символов',
  chars: 'В нике можно только русские и латинские буквы, цифры, пробел и _ - .',
};
// the most stars / score a run of this wall-clock length could have earned (Code.gs capsFor_)
function capsFor(ms, flinches) {
  const S = RULES.stars, R = RULES;
  const elapsed = Math.max(0, ms * R.lagRatio - R.winDelayMs - R.slackMs), left = (S.levelMs - elapsed) / S.levelMs;
  let stars = 1;
  if (left >= S.two.time && flinches <= S.two.flinch) stars = 2;
  if (left >= S.three.time && flinches <= S.three.flinch) stars = 3;
  return { stars, score: R.scoreBaseMax + R.scoreTimeBonus * Math.ceil((S.levelMs - elapsed) / 1000) };
}
// this device's nick claim: 128 random bits, made once (not a password, it only binds nicks to the device)
function claim() {
  let c = lsGet('da.claim', '');
  if (/^[0-9a-f]{32}$/.test(c)) return c;
  const b = new Uint8Array(16);
  try { crypto.getRandomValues(b); } catch (e) { for (let i = 0; i < 16; i++) b[i] = (Math.random() * 256) | 0; }
  c = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  lsSet('da.claim', c);
  return c;
}
const cmp = (a, b) => a.ms - b.ms || a.flinches - b.flinches || (b.score || 0) - (a.score || 0);
const mskDay = (ts) => Math.floor((ts + 3 * 3600e3) / 864e5); // the board's day is Moscow time (UTC+3)

/* ======================================================================
   run log: pause-aware clock from the first tool action to the last closed item
   ====================================================================== */
class Run {
  constructor() {
    this.started = false; this.done = false; this.paused = false;
    this.acc = 0; this.seg = null; this.ms = 0;
    this.steps = []; this.holds = { drill: [], lamp: [] }; this.hacc = new Map();
    this.wiggles = 0; this.tools = 0; this.fakeMs = 0;
    this.tainted = false; // a debug call (DA.*) touched this run: it is never sent to the real board
  }
  taint() { this.tainted = true; }
  now() { return this.acc + (this.seg !== null ? performance.now() - this.seg : 0); }
  // first touch of the mouth with a tool starts the clock
  action() { if (this.started || this.done) return; this.started = true; if (!this.paused) this.seg = performance.now(); }
  // portrait overlay / hidden tab: the clock stops with the game
  setPaused(p) {
    p = !!p; if (p === this.paused) return;
    this.paused = p;
    if (!this.started || this.done) return;
    if (p) { if (this.seg !== null) { this.acc += performance.now() - this.seg; this.seg = null; } }
    else this.seg = performance.now();
  }
  step(id) {
    if (this.done) return;
    this.action();
    const prev = this.steps.length ? this.steps[this.steps.length - 1].t : -1;
    // two items can close in the same frame: keep t strictly growing
    this.steps.push({ id: String(id), t: Math.max(Math.round(this.now()), prev + 1) });
  }
  // kind: drill | lamp; key: the cavity; dt: game seconds of active work this frame
  hold(kind, key, dt) { if (!this.done) this.hacc.set(key, (this.hacc.get(key) || 0) + dt * 1000); }
  holdDone(kind, key) {
    if (this.done || !this.holds[kind]) return;
    this.holds[kind].push(Math.ceil(this.hacc.get(key) || 0)); this.hacc.delete(key);
  }
  wiggle() { if (!this.done) this.wiggles++; }
  tool() { if (!this.done) this.tools++; }
  fake(ms) { this.fakeMs = Math.max(1, Math.round(ms)); this.tainted = true; } // debug only (DA.fakeRun): a believable log for UI tests
  finish() {
    if (this.done) return;
    this.action();
    const last = this.steps.length ? this.steps[this.steps.length - 1].t : 0;
    this.ms = Math.max(Math.round(this.now()), last);
    this.done = true; this.seg = null;
    if (this.fakeMs) {
      const ms = this.ms = this.fakeMs, n = this.steps.length || 1;
      this.steps.forEach((s, i) => { s.t = Math.round(ms * (0.25 + 0.75 * (i + 1) / n)); });
      const cav = this.steps.filter((s) => s.id === 'cavity').length;
      this.holds = { drill: Array.from({ length: cav }, (_, i) => 2280 + i * 140), lamp: Array.from({ length: cav }, (_, i) => 2040 + i * 60) };
      this.wiggles = 8; this.tools = 15;
    }
  }
  result() {
    return { ms: this.ms, log: { steps: this.steps.map((s) => ({ id: s.id, t: s.t })), holds: { drill: this.holds.drill.slice(), lamp: this.holds.lamp.slice() }, wiggles: this.wiggles, tools: this.tools } };
  }
}

/* ======================================================================
   personal best (works without any network)
   ====================================================================== */
function bestMs() { const v = parseInt(lsGet('da.bestms', '0'), 10); return v > 0 ? v : 0; }

/* ======================================================================
   backends
   ====================================================================== */
async function request(url, opt) {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return { ok: false, error: 'net' };
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  let timer = 0;
  const timeout = new Promise((res) => { timer = setTimeout(() => { if (ctl) ctl.abort(); res({ ok: false, error: 'net', why: 'timeout' }); }, TIMEOUT); });
  const go = (async () => {
    // Apps Script answers with a 302 to googleusercontent.com: fetch follows it (a POST turns into a GET there)
    const r = await fetch(url, { ...opt, signal: ctl ? ctl.signal : undefined, redirect: 'follow', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer' });
    if (!r.ok) return { ok: false, error: r.status === 429 || r.status >= 500 ? 'busy' : 'net' };
    const txt = await r.text();
    let j = null; try { j = JSON.parse(txt); } catch (e) { return { ok: false, error: 'server' }; } // an HTML error page
    return j && typeof j === 'object' ? j : { ok: false, error: 'server' };
  })().catch(() => ({ ok: false, error: 'net' }));
  try { return await Promise.race([go, timeout]); } finally { clearTimeout(timer); }
}

const Net = {
  url: '',
  top(period, limit) {
    const sep = this.url.includes('?') ? '&' : '?';
    return request(`${this.url}${sep}action=top&period=${period === 'day' ? 'day' : 'all'}&limit=${limit || LIMIT}`, { method: 'GET' });
  },
  // text/plain = a "simple" request: no CORS preflight (Apps Script cannot answer OPTIONS)
  submit(body) { return request(this.url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(body) }); },
};

const Mock = {
  mode: '1', key: 'da.lbmock.v2', // v2: nick claims
  load() {
    let d = null;
    try { d = JSON.parse(lsGet(this.key, 'null')); } catch (e) { d = null; }
    if (!d || !Array.isArray(d.rows)) d = { rows: this.seed(), hits: [], claims: {} };
    if (!Array.isArray(d.hits)) d.hits = [];
    if (!d.claims || typeof d.claims !== 'object') d.claims = {};
    return d;
  },
  save(d) { lsSet(this.key, JSON.stringify(d)); },
  // made-up players from a few days ago, so «Всё время» has rows and «Сегодня» starts empty
  seed() {
    const day = 864e5, now = Date.now();
    return [['Зубная фея', 61400, 0, 3, 2410], ['Пломбир', 73850, 0, 3, 2290], ['Dr_Smile', 82120, 1, 2, 1980], ['Кариесоборец', 95600, 0, 3, 1840],
      ['Щипчик', 104300, 1, 2, 1610], ['мятная паста', 118900, 2, 1, 1120], ['Флосс-2000', 131250, 1, 1, 980]]
      .map(([nick, ms, flinches, stars, score], i) => ({ nick, ms, flinches, stars, score, date: now - (2 + i % 4) * day - i * 3600e3 }));
  },
  delay(v) { return new Promise((res) => setTimeout(() => res(v), 250 + Math.random() * 350)); },
  fail() { return this.mode === 'offline' ? { ok: false, error: 'net' } : this.mode === 'busy' ? { ok: false, error: 'busy' } : null; },
  board(rows, period, limit) {
    const today = mskDay(Date.now());
    const best = new Map();
    for (const r of rows) {
      if (period === 'day' && mskDay(r.date) !== today) continue;
      const k = nickKey(r.nick), b = best.get(k);
      if (!b || cmp(r, b) < 0) best.set(k, r);
    }
    const list = [...best.values()].sort(cmp);
    return { list, top: list.slice(0, limit).map((r) => ({ nick: r.nick, ms: r.ms, flinches: r.flinches, stars: r.stars, date: new Date(r.date).toISOString() })) };
  },
  top(period, limit) {
    const f = this.fail(); if (f) return this.delay(f);
    const p = period === 'day' ? 'day' : 'all', b = this.board(this.load().rows, p, limit || LIMIT);
    return this.delay({ ok: true, period: p, top: b.top, total: b.list.length });
  },
  // the same answers as validate_ in Code.gs (error codes and order); '' = accepted
  validate(q) {
    if (!q || q.action !== 'submit' || q.v !== 1) return 'invalid';
    const nick = normNick(q.nick);
    if (nickError(nick)) return 'bad_nick';
    const low = nick.toLowerCase().replace(/[\s_.\-]/g, '');
    if (/(https?|www|:\/\/)/i.test(nick) || /\.(ru|com|net|org|рф|su|io|me|gg|tv|xyz|link|site|online|top|info|pro|cc|ly)(\b|$)/i.test(nick)) return 'bad_nick';
    if (['хуй', 'хуе', 'хуё', 'пизд', 'ебат', 'ебан', 'ёбан', 'еблан', 'бляд', 'блят', 'сука', 'пидор', 'пидар', 'fuck', 'shit', 'bitch', 'cunt', 'nigg'].some((w) => low.includes(w))) return 'bad_nick';
    if (typeof q.claim !== 'string' || !/^[0-9a-f]{32}$/.test(q.claim)) return 'invalid';
    const { ms, flinches, stars, score, log } = q;
    if (!int(ms) || ms <= 0 || ms > RULES.maxMs) return 'invalid';
    if (!int(flinches) || flinches < 0 || flinches > RULES.flinchMax) return 'invalid';
    if (!int(stars) || stars < 1 || stars > 3) return 'invalid';
    if (!int(score) || score < 0) return 'invalid';
    if (!log || !Array.isArray(log.steps) || !log.holds || !Array.isArray(log.holds.drill) || !Array.isArray(log.holds.lamp)) return 'invalid';
    const cav = RULES.steps.filter((s) => s === 'cavity').length;
    const okHold = (a, min) => a.length >= cav && a.length <= 16 && a.every((h) => typeof h === 'number' && Number.isFinite(h) && h >= 0 && h <= RULES.maxMs)
      && a.filter((h) => h >= min - RULES.holdTolMs).length >= cav;
    if (!okHold(log.holds.drill, RULES.drillMs) || !okHold(log.holds.lamp, RULES.lampMs)) return 'invalid';
    if (ms < RULES.cheatMs) return 'too_fast';
    const held = log.holds.drill.concat(log.holds.lamp).reduce((a, b) => a + b, 0);
    if (ms < held) return 'invalid';
    if (!log.steps.length || log.steps.length > 64) return 'invalid';
    const need = {}; for (const id of RULES.steps) need[id] = (need[id] || 0) + 1;
    let prev = 0;
    for (const s of log.steps) {
      if (!s || typeof s.id !== 'string' || !/^[A-Za-z][A-Za-z0-9_:.\-]{0,23}$/.test(s.id)) return 'invalid';
      if (typeof s.t !== 'number' || !Number.isFinite(s.t) || s.t < prev || s.t > ms) return 'invalid';
      prev = s.t;
      const t = s.id.toLowerCase().replace(/[^a-z]+/g, ' ').trim().split(' ').find((x) => need[x] > 0);
      if (t) need[t]--;
    }
    if (Object.values(need).some((n) => n > 0)) return 'invalid';
    if (!int(log.wiggles) || log.wiggles < RULES.wiggles || log.wiggles > 10000) return 'invalid';
    return '';
  },
  submit(q) {
    const f = this.fail(); if (f) return this.delay(f);
    const err = this.validate(q); if (err) return this.delay({ ok: false, error: err });
    const d = this.load(), now = Date.now(), nick = normNick(q.nick), k = nickKey(nick);
    d.hits = d.hits.filter((h) => now - h.at < 60000);
    if (d.hits.some((h) => h.k === k && now - h.at < RULES.nickEveryMs) || d.hits.length >= RULES.perMinute) return this.delay({ ok: false, error: 'rate' });
    const isNew = !d.claims[k] && !d.rows.some((r) => nickKey(r.nick) === k); // seeded rows count as someone else's
    if (d.claims[k] ? d.claims[k] !== q.claim : !isNew) return this.delay({ ok: false, error: 'nick_taken' });
    if (isNew && d.hits.filter((h) => h.isNew).length >= RULES.newPerMinute) return this.delay({ ok: false, error: 'rate' });
    d.hits.push({ k, at: now, isNew });
    d.claims[k] = q.claim; // the real server keeps only a SHA-256 of it
    const cap = capsFor(q.ms, q.flinches);
    const row = { nick, ms: q.ms, flinches: q.flinches, stars: Math.min(q.stars, cap.stars), score: Math.min(q.score, cap.score), date: now };
    d.rows.push(row);
    if (d.rows.length > RULES.maxRows) { d.rows.sort(cmp); d.rows.length = RULES.maxRows; }
    this.save(d);
    const all = this.board(d.rows, 'all', LIMIT), day = this.board(d.rows, 'day', LIMIT);
    const rank = (list) => 1 + list.filter((r) => nickKey(r.nick) !== k && cmp(r, row) < 0).length;
    const mine = all.list.find((r) => nickKey(r.nick) === k);
    return this.delay({ ok: true, rank: rank(all.list), rankDay: rank(day.list), best: mine ? { nick: mine.nick, ms: mine.ms, flinches: mine.flinches, stars: mine.stars } : null, top: all.top, topDay: day.top, total: all.list.length, totalDay: day.list.length });
  },
  reset() { try { localStorage.removeItem(this.key); } catch (e) { /* ignore */ } },
};

/* ======================================================================
   UI
   ====================================================================== */
const ERR = {
  net: 'Нет сети или сервер не ответил. Проверь интернет и попробуй ещё раз',
  busy: 'Сервер занят, попробуй через пару секунд',
  rate: 'Слишком часто. Подожди минуту и попробуй снова',
  too_fast: 'Слишком быстро — похоже на чит. Результат не записан',
  bad_nick: 'Такой ник не подойдёт: без ссылок и мата, 2–16 символов',
  nick_taken: 'Этот ник уже занят другим игроком (или другим твоим устройством). Выбери другой',
  closed: 'Запись результатов сейчас закрыта. Попробуй позже',
  invalid: 'Результат не прошёл проверку и не записан',
  server: 'Сервер ответил что-то странное, попробуй позже',
};
const errText = (e) => ERR[e] || 'Что-то пошло не так, попробуй ещё раз';
const FINAL = { too_fast: 1, invalid: 1 }; // retrying the same run cannot help

const LB = {
  RULES, fmtMs, normNick, nickError, nickKey, capsFor, bestMs, mock: false, on: false,
  api: Net, cache: {}, tok: 0, win: null, modalTab: 'all', modalTok: 0, modalOpen: false,

  init(opts) {
    opts = opts || {};
    const c = opts.cfg;
    if (c) {
      if (typeof c.levelTime === 'number') { RULES.maxMs = c.levelTime * 1000; RULES.stars.levelMs = c.levelTime * 1000; }
      if (typeof c.drillTime === 'number') RULES.drillMs = c.drillTime * 1000;
      if (typeof c.cureTime === 'number') RULES.lampMs = c.cureTime * 1000;
      if (c.stars && c.stars.two && c.stars.three) { RULES.stars.two = c.stars.two; RULES.stars.three = c.stars.three; }
    }
    let mock = '';
    try { mock = new URLSearchParams(location.search).get('lbmock') || ''; } catch (e) { mock = ''; }
    const man = opts.manifest || {};
    let url = man.leaderboard && typeof man.leaderboard.url === 'string' ? man.leaderboard.url.trim() : '';
    if (url && !/^https:\/\/[^\s"'<>]+$/i.test(url)) { console.warn('[doctor-alinka] leaderboard.url must be an https:// URL, network features are off'); url = ''; }
    if (mock && mock !== '0') { this.mock = true; Mock.mode = mock; this.api = Mock; }
    else { Net.url = url; this.api = Net; }
    this.on = this.mock || !!url;
    document.body.classList.toggle('lb-on', this.on);
    this.bindTitle();
    this.bindWin();
  },
  newRun() { return new Run(); },
  isModalOpen() { return this.modalOpen; },

  /* ---------- data ---------- */
  async getTop(period, force) {
    const c = this.cache[period];
    if (!force && c && Date.now() - c.at < CACHE_MS) return c.res;
    const res = await this.api.top(period, LIMIT);
    if (res && res.ok && Array.isArray(res.top)) this.cache[period] = { at: Date.now(), res };
    return res;
  },

  /* ---------- table ---------- */
  // state: {kind:'loading'|'empty'|'error', text, retry}
  render(box, rows, opt) {
    opt = opt || {};
    const ol = box.querySelector('.lbt'), st = box.querySelector('.lbstate'), foot = box.querySelector('.lbfoot');
    ol.textContent = ''; ol.classList.remove('dense'); st.textContent = ''; st.className = 'lbstate';
    if (foot) foot.textContent = '';
    if (opt.state) {
      st.classList.add('on', opt.state.kind);
      if (opt.state.kind === 'loading') st.appendChild(el('i', 'lbspin'));
      st.appendChild(el('span', '', opt.state.text));
      if (opt.state.retry) { const b = el('button', 'btn ghost sm', 'Повторить'); b.type = 'button'; b.addEventListener('click', opt.state.retry); st.appendChild(b); }
      return;
    }
    let shown = false;
    rows.forEach((r, i) => {
      const li = el('li');
      if (opt.me && nickKey(showNick(r.nick)) === opt.me && !shown) { li.classList.add('me'); shown = true; }
      this.row(li, i + 1, r);
      ol.appendChild(li);
    });
    const extra = !!(opt.extra && !shown);
    ol.classList.toggle('dense', extra); // 12 rows fit in the height of 10
    if (extra) { ol.appendChild(el('li', 'gap', '⋯')); const li = el('li', 'me'); this.row(li, opt.extra.rank, opt.extra); ol.appendChild(li); }
    if (foot && typeof opt.total === 'number' && opt.total > 0) foot.textContent = `Всего игроков: ${opt.total}`;
  },
  row(li, rank, r) {
    const rk = el('span', 'rk' + (rank <= 3 ? ' p' + rank : ''), String(rank));
    const nk = el('span', 'nk', showNick(r.nick)); // textContent only
    const st = el('span', 'st'); const n = Math.max(0, Math.min(3, r.stars | 0));
    st.appendChild(el('b', '', '★'.repeat(n))); st.appendChild(el('i', '', '★'.repeat(3 - n)));
    if (int(r.flinches) && r.flinches > 0) li.title = `Срывов: ${r.flinches}`;
    const tm = el('span', 'tm', fmtMs(r.ms));
    li.append(rk, nk, st, tm);
  },
  async showTab(box, period, opt, tokRef) {
    for (const b of box.querySelectorAll('.tabs button')) { const on = b.dataset.p === period; b.classList.toggle('on', on); b.setAttribute('aria-selected', String(on)); }
    const tok = ++this[tokRef];
    const paint = (r) => {
      const o = opt(period);
      if (!r.top.length && !o.extra) this.render(box, [], { state: { kind: 'empty', text: period === 'day' ? 'Сегодня ещё никто не лечил. Будь первым!' : 'Пока пусто. Будь первым!' } });
      else this.render(box, r.top, { ...o, total: r.total });
    };
    const c = this.cache[period];
    if (c) paint(c.res); else this.render(box, [], { state: { kind: 'loading', text: 'Загружаем таблицу…' } });
    if (c && Date.now() - c.at < CACHE_MS) return c.res;
    const res = await this.getTop(period, true);
    if (tok !== this[tokRef]) return null;
    if (!res || !res.ok || !Array.isArray(res.top)) {
      if (!c) this.render(box, [], { state: { kind: 'error', text: errText(res && res.error), retry: () => this.showTab(box, period, opt, tokRef) } });
      return null;
    }
    paint(res);
    return res;
  },

  /* ---------- title: «Лидеры» ---------- */
  bindTitle() {
    if (this.titleBound) return; this.titleBound = true;
    const btn = $('#lbopen'), m = $('#lbmodal');
    if (!btn || !m) return;
    btn.hidden = !this.on;
    btn.addEventListener('click', () => this.openModal());
    $('#lbclose').addEventListener('click', () => this.closeModal());
    // the overlay lives in the 16:9 stage: a tap on the letterbox bars outside it must close it too
    document.addEventListener('pointerdown', (e) => {
      if (this.modalOpen && !(e.target && e.target.closest && e.target.closest('.lbpanel'))) this.closeModal();
    }, true);
    for (const b of m.querySelectorAll('.tabs button')) b.addEventListener('click', () => { this.modalTab = b.dataset.p; this.modalShow(); });
    window.addEventListener('keydown', (e) => {
      if (!this.modalOpen) return;
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.closeModal(); return; }
      if (e.key === 'Tab') { // keep focus inside the panel
        const f = [...m.querySelectorAll('.lbpanel button:not([disabled])')].filter((b) => b.offsetParent !== null);
        if (!f.length) return;
        const i = f.indexOf(document.activeElement), n = e.shiftKey ? (i <= 0 ? f.length - 1 : i - 1) : (i < 0 || i === f.length - 1 ? 0 : i + 1);
        e.preventDefault(); f[n].focus();
      }
    }, true);
  },
  modalOpts() { const me = nickKey(lsGet('da.nick', '')); return () => ({ me: me || null }); },
  modalShow() { return this.showTab($('#lbmodal'), this.modalTab, this.modalOpts(), 'modalTok'); },
  openModal() {
    if (!this.on) return;
    const m = $('#lbmodal'); m.classList.add('on'); m.setAttribute('aria-hidden', 'false');
    this.modalOpen = true;
    this.modalShow();
    try { $('#lbclose').focus({ preventScroll: true }); } catch (e) { /* ignore */ }
  },
  closeModal() {
    if (!this.modalOpen) return;
    const m = $('#lbmodal'); m.classList.remove('on'); m.setAttribute('aria-hidden', 'true');
    this.modalOpen = false; this.modalTok++;
    try { $('#lbopen').focus({ preventScroll: true }); } catch (e) { /* ignore */ }
  },

  /* ---------- win card ---------- */
  bindWin() {
    if (this.winBound) return; this.winBound = true;
    const inp = $('#lbnick'), send = $('#lbsend'), box = $('#wlb');
    if (!inp || !send || !box) return;
    inp.maxLength = RULES.nickMax + 4;
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); this.submit(); } e.stopPropagation(); });
    inp.addEventListener('input', () => {
      const w = this.win; if (!w || w.sent) return;
      const n = normNick(inp.value), err = n ? nickError(n) : '';
      inp.classList.toggle('bad', err === 'chars');
      if (err === 'chars') this.msg(NICK_MSG.chars, 'bad'); else if (w.msgKind === 'bad') this.msg('', '');
    });
    send.addEventListener('click', () => this.submit());
    for (const b of box.querySelectorAll('.tabs button')) b.addEventListener('click', () => { if (this.win) { this.win.tab = b.dataset.p; this.winShow(); } });
  },
  msg(text, kind) { const m = $('#lbmsg'); if (!m) return; m.textContent = text; m.className = 'lbmsg ' + (kind || ''); if (this.win) this.win.msgKind = kind; },
  winOpts() { const w = this.win; return (period) => (w && w.sent ? { me: w.key, extra: period === 'day' ? (w.rankDay > LIMIT ? { rank: w.rankDay, nick: w.nick, ms: w.ms, stars: w.stars } : null) : (w.rank > LIMIT ? { rank: w.rank, nick: w.nick, ms: w.ms, stars: w.stars } : null) } : {}); },
  async winShow() {
    const w = this.win; if (!w) return;
    const res = await this.showTab($('#wlb'), w.tab, this.winOpts(), 'tok');
    if (res && this.win === w && !w.sent && !w.final && w.sane && w.tab === 'all') this.estimate(res);
  },
  // before submitting: where this time would land among the loaded top
  estimate(res) {
    const w = this.win, list = (res.top || []).filter((r) => nickKey(showNick(r.nick)) !== nickKey($('#lbnick').value));
    const me = { ms: w.ms, flinches: w.flinches, score: w.score };
    const better = list.filter((r) => cmp(r, me) < 0).length;
    if (better < LIMIT) this.place(`Это примерно ${better + 1} место в общем зачёте`);
    else this.place('Пока за пределами топ-10');
  },
  place(t, kind) { const p = $('#wplace'); if (p) { p.textContent = t; p.className = 'wplace ' + (kind || ''); } },

  // called by game.js on every win
  showWin(d) {
    this.tok++;
    const ms = d.ms | 0, flinches = d.flinches | 0, cap = capsFor(ms, flinches);
    // on a very slow phone the level timer lags the wall clock: send no more stars / score than ms allows
    const stars = Math.max(1, Math.min(d.stars | 0, cap.stars)), score = Math.min(d.score | 0, cap.score);
    // a run the board would reject as impossible (debug wins, a broken log) is not a personal record either
    const tainted = !!d.tainted;
    const sane = ms > 0 && !tainted && !Mock.validate({ action: 'submit', v: 1, nick: 'ok', claim: '0'.repeat(32), ms, flinches, stars, score, log: d.log });
    const prev = bestMs(), rec = sane && (!prev || ms < prev);
    if (rec) lsSet('da.bestms', String(ms));
    const t = $('#wtime'); if (t) t.textContent = fmtMs(ms);
    const pb = $('#wpb');
    if (pb) { pb.textContent = rec ? (prev ? `Новый личный рекорд! Было ${fmtMs(prev)}` : 'Первый результат — уже рекорд') : prev ? `Личный рекорд: ${fmtMs(prev)}` : ''; pb.classList.toggle('rec', rec); }
    this.place('');
    const card = $('#wcard'), box = $('#wlb');
    if (!this.on || !card || !box) { if (card) card.classList.remove('wide'); if (box) box.hidden = true; this.win = null; return; }
    card.classList.add('wide'); box.hidden = false;
    this.win = { ms, flinches, stars, score, log: d.log, sent: false, busy: false, final: false, sane, tainted, tab: 'all', key: '', nick: '' };
    const inp = $('#lbnick'), send = $('#lbsend');
    inp.value = lsGet('da.nick', ''); inp.classList.remove('bad'); inp.disabled = false;
    send.disabled = false; send.textContent = 'Записать';
    if (tainted && !this.mock) { // console debug (DA.*) was used: the real board never gets this run
      this.win.final = true; inp.disabled = true; send.disabled = true; send.textContent = 'Не записано';
      this.msg('Отладка — результат не записывается', 'warn');
    } else if (tainted) this.msg('Тестовый режим, отладочный заезд: пишется только в эту фейковую таблицу', 'warn');
    else this.msg(this.mock ? 'Тестовый режим: таблица хранится только в этом браузере' : 'Впиши ник и запишись в таблицу', this.mock ? 'warn' : '');
    this.winShow();
  },
  // a new run started: nothing from the old card may land on the next one
  reset() { this.tok++; this.win = null; },

  async submit() {
    const w = this.win; if (!w || w.sent || w.busy || w.final) return;
    const inp = $('#lbnick'), send = $('#lbsend');
    const nick = normNick(inp.value), ne = nickError(nick);
    if (ne) { inp.classList.add('bad'); this.msg(NICK_MSG[ne], 'bad'); try { inp.focus({ preventScroll: true }); } catch (e) { /* ignore */ } return; }
    inp.value = nick; inp.classList.remove('bad');
    w.busy = true; send.disabled = true; send.textContent = 'Записываю…';
    this.msg('Отправляем результат…', '');
    const body = { action: 'submit', v: 1, nick, claim: claim(), ms: w.ms, flinches: w.flinches, stars: w.stars, score: w.score, log: w.log };
    const res = await this.api.submit(body);
    if (this.win !== w) return; // «Ещё раз» was pressed meanwhile
    w.busy = false;
    if (!res || !res.ok) {
      const e = (res && res.error) || 'net';
      this.msg(errText(e), e === 'busy' || e === 'rate' || e === 'net' ? 'warn' : 'bad');
      const nickErr = e === 'bad_nick' || e === 'nick_taken';
      if (nickErr) { inp.classList.add('bad'); try { inp.focus({ preventScroll: true }); } catch (er) { /* ignore */ } }
      if (FINAL[e]) { w.final = true; send.textContent = 'Не записано'; inp.disabled = true; this.place(''); } // no "≈ N место" for a run that was not written
      else { send.disabled = false; send.textContent = nickErr ? 'Записать' : 'Повторить'; }
      return;
    }
    lsSet('da.nick', nick); // only a nick the server took is remembered (and highlighted later)
    w.sent = true; w.nick = nick; w.key = nickKey(nick);
    w.rank = int(res.rank) ? res.rank : 0; w.rankDay = int(res.rankDay) ? res.rankDay : 0;
    send.textContent = 'Записано ✓'; inp.disabled = true;
    const now = Date.now();
    // the answer carries both fresh tops (empty when the server stored the run but could not build them: refetch)
    const fresh = Array.isArray(res.top) && (res.top.length || res.rank);
    if (fresh) this.cache.all = { at: now, res: { ok: true, period: 'all', top: res.top, total: res.total } };
    else delete this.cache.all;
    if (fresh && Array.isArray(res.topDay)) this.cache.day = { at: now, res: { ok: true, period: 'day', top: res.topDay, total: res.totalDay } };
    else delete this.cache.day;
    const bestMsN = typeof res.best === 'number' ? res.best : res.best && typeof res.best.ms === 'number' ? res.best.ms : 0;
    const parts = [];
    if (w.rank) parts.push(`${w.rank} место в общем зачёте`);
    if (w.rankDay) parts.push(`сегодня ${w.rankDay}-е`);
    this.place(parts.join(' · '), 'ok');
    this.msg(bestMsN && bestMsN < w.ms ? `Записано! Твой лучший в таблице — ${fmtMs(bestMsN)}` : 'Записано! Ты в таблице', 'ok');
    const inAll = (res.top || []).some((r) => nickKey(showNick(r.nick)) === w.key), inDay = (res.topDay || []).some((r) => nickKey(showNick(r.nick)) === w.key);
    w.tab = !inAll && inDay ? 'day' : 'all';
    this.winShow();
  },

  mockReset() { Mock.reset(); this.cache = {}; return true; },
};

window.LB = LB;
})();
