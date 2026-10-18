// Тестовая среда без браузера: виртуальное время, фейковые storage/страница ChatGPT/загрузки.
// Логика ожидания результата — настоящая (decideWait/analyzeSnapshot), подменяется только окружение.
import { readFileSync } from 'node:fs';
import { crc32 } from 'node:zlib';
import { Orchestrator } from '../../../source/extension/src/background/orchestrator.js';
import { analyzeSnapshot, decideWait, findUserTurn } from '../../../source/extension/src/lib/chatgpt-classify.js';
import { AdapterError } from '../../../source/extension/src/lib/errors.js';
import { sha256Hex } from '../../../source/extension/src/lib/image.js';
import { Store } from '../../../source/extension/src/lib/store.js';
import { canonicalJson, parseBatch } from '../../../source/extension/src/lib/validate.js';

export const START_URL = 'https://chatgpt.com/';
export const flush = async (n = 6) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};

// ───────── часы ─────────
export class FakeClock {
  constructor(start = Date.parse('2026-10-17T12:00:00.000Z')) {
    this.t = start;
    this.timers = [];
    this.seq = 0;
    this.now = () => this.t;
    this.setTimeout = (fn, ms) => {
      const h = { id: ++this.seq, at: this.t + Math.max(0, ms), fn };
      this.timers.push(h);
      return h;
    };
    this.clearTimeout = (h) => {
      this.timers = this.timers.filter((x) => x !== h);
    };
    this.sleep = (ms) => new Promise((r) => this.setTimeout(r, ms));
  }
  pending() {
    return this.timers.length;
  }
  nextAt() {
    return Math.min(...this.timers.map((x) => x.at));
  }
  advanceTo(at) {
    this.t = Math.max(this.t, at);
    const due = this.timers.filter((x) => x.at <= this.t).sort((a, b) => a.at - b.at || a.id - b.id);
    this.timers = this.timers.filter((x) => x.at > this.t);
    for (const h of due) h.fn();
  }
}

// ───────── хранилище ─────────
export class FakeArea {
  constructor() {
    this.data = {};
    this.setCalls = 0;
    this.failNextSet = false;
  }
  async get(keys) {
    if (keys === null || keys === undefined) return structuredClone(this.data);
    const list = Array.isArray(keys) ? keys : [keys];
    return Object.fromEntries(list.filter((k) => k in this.data).map((k) => [k, structuredClone(this.data[k])]));
  }
  async set(obj) {
    if (this.failNextSet) {
      this.failNextSet = false;
      throw new Error('QUOTA_BYTES exceeded');
    }
    this.setCalls += 1;
    Object.assign(this.data, structuredClone(obj));
  }
  async remove(keys) {
    for (const k of Array.isArray(keys) ? keys : [keys]) delete this.data[k];
  }
}

// ───────── изображения ─────────
export function fakePng(width, height, seed = 0) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const body = Buffer.alloc(64);
  for (let i = 4; i < body.length; i++) body[i] = (seed * 31 + i * 7) & 255;
  body.writeUInt32BE(seed >>> 0, 0);
  return new Uint8Array(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', body), chunk('IEND', Buffer.alloc(0))]));
}

export class FakeImages {
  constructor() {
    this.map = new Map();
    this.failures = [];
    this.calls = [];
  }
  register(url, bytes) {
    this.map.set(url, bytes);
  }
  async fetch(url) {
    this.calls.push(url);
    const f = this.failures.shift();
    if (f) throw new AdapterError(f.code ?? 'FETCH_FAILED', f.message ?? 'fail', { status: f.status });
    const bytes = this.map.get(url);
    if (!bytes) throw new AdapterError('FETCH_FAILED', '404', { status: 404 });
    return { bytes, status: 200, contentType: 'image/png' };
  }
}

// ───────── загрузки ─────────
export class FakeDownloads {
  constructor(clock, images) {
    this.clock = clock;
    this.images = images;
    this.items = new Map();
    this.files = new Map(); // filename → {text?, bytes?, writes}
    this.calls = [];
    this.failures = []; // 'interrupt' | 'size' | 'throw'
    this.seq = 0;
  }
  async start({ url, filename, conflictAction }) {
    const id = ++this.seq;
    this.calls.push({ url: url.startsWith('data:') ? 'data:' : url, filename, conflictAction, at: this.clock.now() });
    const f = this.failures.length && !url.startsWith('data:') ? this.failures.shift() : null;
    if (f === 'throw') throw new AdapterError('DOWNLOAD_FAILED', 'downloads.download отклонён');
    let size = 0;
    let text = null;
    let bytes = null;
    if (url.startsWith('data:')) {
      text = decodeURIComponent(url.slice(url.indexOf(',') + 1));
      size = Buffer.byteLength(text);
    } else {
      bytes = this.images.map.get(url);
      size = bytes?.length ?? 0;
    }
    const item = { id, state: f === 'interrupt' ? 'interrupted' : 'complete', exists: true, fileSize: f === 'size' ? size + 5 : size, filename: `C:\\Users\\u\\Downloads\\${filename.replaceAll('/', '\\')}`, rel: filename };
    this.items.set(id, item);
    if (item.state === 'complete') {
      const prev = this.files.get(filename);
      this.files.set(filename, { text, bytes, size, writes: (prev?.writes ?? 0) + 1, conflictAction });
    }
    return id;
  }
  async search(id) {
    return this.items.get(id) ?? null;
  }
  async waitComplete(id) {
    await this.clock.sleep(200);
    const it = this.items.get(id);
    if (!it || it.state !== 'complete') throw new AdapterError('DOWNLOAD_FAILED', 'Загрузка прервана');
    return it;
  }
  async erase(id) {
    this.items.get(id) && (this.items.get(id).erased = true);
  }
  list(prefix = '') {
    return [...this.files.keys()].filter((k) => k.startsWith(prefix)).sort();
  }
  json(filename) {
    return JSON.parse(this.files.get(filename).text);
  }
}

// ───────── страница ChatGPT ─────────
export class FakePage {
  constructor(clock, images) {
    this.clock = clock;
    this.images = images;
    this.tabId = 7;
    this.alive = true;
    this.online = true;
    this.loggedIn = true;
    this.captcha = false;
    this.uiChanged = false;
    this.convs = new Map();
    this.convSeq = 0;
    this.imgSeq = 0;
    this.script = [];
    this.defaults = { delayMs: 3000, size: 1024 };
    this.sent = [];
    this.opened = [];
    this.pending = null;
    this.watch = {};
    this.lastImage = null;
    this.cur = this.#newConv();
  }
  #newConv() {
    const c = { url: START_URL, turns: [], alerts: [], id: ++this.convSeq };
    return c;
  }
  setScript(list) {
    this.script = [...list];
  }
  get turns() {
    return this.cur.turns;
  }
  async ensureTab() {
    if (!this.alive) throw new AdapterError('TAB_NOT_FOUND', 'Вкладка не найдена');
    return { tabId: this.tabId, url: this.cur.url };
  }
  async openChat(_tabId, url) {
    if (!this.alive) throw new AdapterError('TAB_CLOSED', 'Вкладка закрыта');
    this.opened.push(url);
    if (url === START_URL) this.cur = this.#newConv();
    else if (this.convs.has(url)) this.cur = this.convs.get(url);
    else this.cur = this.#newConv();
    this.pending = this.cur.pending ?? null;
  }
  #materialize() {
    const p = this.pending;
    if (!p || this.clock.now() < p.readyAt || p.done) return;
    const { mode, size } = p.beh;
    const mkImg = (reuse, sameBytes) => {
      if (reuse && this.lastImage) return this.lastImage;
      const n = ++this.imgSeq;
      const src = `https://chatgpt.com/backend-api/estuary/content?id=file_${n}&sig=s${n}`;
      this.images.register(src, sameBytes && this.lastImage ? this.images.map.get(this.lastImage.src) : fakePng(size, size, n));
      const img = { key: `estuary:file_${n}`, src, alt: 'Generated image: test', w: size, h: size, complete: true };
      this.lastImage = img;
      return img;
    };
    if (mode === 'hang' || mode === 'drop-send') return;
    p.done = true;
    const turns = this.cur.turns.filter((t) => !t.placeholder);
    this.cur.turns = turns;
    if (mode === 'normal' || mode === 'small-image') turns.push({ role: 'assistant', text: '', images: [mkImg(false)] });
    else if (mode === 'same-image') turns.push({ role: 'assistant', text: '', images: [mkImg(true)] });
    else if (mode === 'same-bytes') turns.push({ role: 'assistant', text: '', images: [mkImg(false, true)] });
    else if (mode === 'two-images') turns.push({ role: 'assistant', text: '', images: [mkImg(false), mkImg(false)] });
    else if (mode === 'text-only') turns.push({ role: 'assistant', text: 'Sure! Here is a detailed description of the photo you asked for, as plain text.', images: [] });
    else if (mode === 'rate-limit') turns.push({ role: 'assistant', text: "You've hit the free plan limit for image generations requests. You can create more images when the limit resets.", images: [] });
    else if (mode === 'policy') turns.push({ role: 'assistant', text: "I'm sorry, but I can't generate that image because the request may violate our content policies.", images: [] });
    else if (mode === 'error') this.cur.alerts.push('Something went wrong. There was an error generating a response.');
    this.pending = null;
  }
  get generating() {
    const p = this.pending;
    return Boolean(p && !p.done && p.beh.mode !== 'drop-send' && this.alive);
  }
  snapshot() {
    this.#materialize();
    const turns = this.cur.turns.map((t, i) => ({ i, role: t.role, text: t.text, images: t.images }));
    if (this.generating) turns.push({ i: turns.length, role: 'assistant', text: 'Creating image', images: [] });
    const ui = !this.uiChanged;
    return {
      t: this.clock.now(),
      url: this.cur.url,
      online: this.online,
      hasComposer: ui && this.loggedIn,
      hasSend: ui && this.loggedIn && !this.generating,
      hasStop: ui && this.generating,
      loginUi: !this.loggedIn,
      captchaUi: this.captcha,
      captchaText: false,
      authUrl: false,
      turns,
      turnCount: turns.length,
      alerts: [...this.cur.alerts],
    };
  }
  async snapshotAsync() {
    if (!this.alive) throw new AdapterError('TAB_CLOSED', 'Вкладка закрыта');
    return this.snapshot();
  }
  async submit(_tabId, { text, key }) {
    if (!this.alive) throw new AdapterError('TAB_CLOSED', 'Вкладка закрыта');
    if (!this.online) throw new AdapterError('NETWORK', 'Нет сети');
    const raw = this.script.shift() ?? 'normal';
    const beh = { mode: typeof raw === 'string' ? raw : raw.mode, delayMs: raw.delayMs ?? this.defaults.delayMs, size: raw.size ?? (raw === 'small-image' || raw.mode === 'small-image' ? 128 : this.defaults.size) };
    if (beh.mode === 'not-accepted') return { accepted: false };
    const snap = this.snapshot();
    const baseline = { turnCount: snap.turnCount, imageKeys: snap.turns.flatMap((t) => t.images.map((i) => i.key)) };
    this.cur.turns.push({ role: 'user', text, images: [] });
    this.cur.alerts = [];
    const userIdx = this.cur.turns.length - 1;
    this.pending = { beh, readyAt: this.clock.now() + beh.delayMs, userIdx, done: false };
    this.cur.pending = this.pending;
    if (this.cur.url === START_URL) {
      this.cur.url = `https://chatgpt.com/c/conv-${this.cur.id}`;
      this.convs.set(this.cur.url, this.cur);
    }
    this.sent.push({ text, key, mode: beh.mode, at: this.clock.now(), conv: this.cur.id });
    return { accepted: true, baseline, url: this.cur.url, userTurnIndex: userIdx };
  }
  async locate(_tabId, { key, minSide = 0, usedKeys = [] }) {
    const snap = await this.snapshotAsync();
    const turn = findUserTurn(snap, key);
    if (!turn) return { found: false, generating: snap.hasStop, images: [], url: snap.url };
    const a = analyzeSnapshot(snap, { key, minSide, usedKeys });
    return { found: true, generating: snap.hasStop, images: a.newImages, url: snap.url, userTurnIndex: turn.i };
  }
  async waitSlice(_tabId, { key, baseline, usedKeys, minSide, sliceMs }) {
    const ctx = { key, baselineKeys: baseline?.imageKeys ?? [], baselineTurnCount: baseline?.turnCount, usedKeys, minSide };
    const end = this.clock.now() + sliceMs;
    let watch = this.watch;
    for (;;) {
      if (!this.alive) throw new AdapterError('TAB_CLOSED', 'Вкладка закрыта');
      const snap = this.snapshot();
      const d = decideWait(snap, ctx, watch, this.clock.now());
      watch = d.watch;
      if (d.result.status !== 'pending') {
        this.watch = {};
        return d.result;
      }
      if (this.clock.now() >= end) {
        this.watch = watch;
        return d.result;
      }
      await this.clock.sleep(1000);
    }
  }
  async cancel() {
    this.pending = null;
    this.cancelled = true;
  }
  /** Имитация закрытия вкладки пользователем. */
  closeTab() {
    this.alive = false;
  }
  /** Генерация, запущенная не расширением (страница занята). */
  startForeignGeneration() {
    this.pending = { beh: { mode: 'hang', delayMs: 0, size: 1024 }, readyAt: this.clock.now(), userIdx: -1, done: false };
  }
  reopenTab() {
    this.alive = true;
  }
}

// ───────── сборка среды ─────────
export function makeEnv({ area = new FakeArea(), clock = new FakeClock(), page, images, downloads, settings = {} } = {}) {
  const img = images ?? new FakeImages();
  const pg = page ?? new FakePage(clock, img);
  const dl = downloads ?? new FakeDownloads(clock, img);
  const notes = [];
  const store = new Store(area, { now: clock.now });
  const pageAdapter = {
    ensureTab: (p) => pg.ensureTab(p),
    openChat: (t, u) => pg.openChat(t, u),
    snapshot: (t) => pg.snapshotAsync(t),
    submit: (t, a) => pg.submit(t, a),
    waitSlice: (t, a) => pg.waitSlice(t, a),
    locate: (t, a) => pg.locate(t, a),
    cancel: (t) => pg.cancel(t),
  };
  const orch = new Orchestrator({ store, now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, sleep: clock.sleep, page: pageAdapter, images: img, downloads: dl, notify: (...a) => notes.push(a) });
  const env = { area, clock, page: pg, images: img, downloads: dl, store, orch, notes, settingsPatch: settings, pageAdapter };
  return env;
}

/** Новая «копия» оркестратора над тем же хранилищем/страницей — имитация выгрузки и повторного запуска service worker. */
export function restartWorker(env) {
  const store = new Store(env.area, { now: env.clock.now });
  const orch = new Orchestrator({ store, now: env.clock.now, setTimeout: env.clock.setTimeout, clearTimeout: env.clock.clearTimeout, sleep: env.clock.sleep, page: env.pageAdapter, images: env.images, downloads: env.downloads, notify: (...a) => env.notes.push(a) });
  env.store.commit = () => new Promise(() => {}); // «убитый» service worker больше ничего не записывает
  env.orch.ticking = true; // старый экземпляр больше не должен ничего делать
  env.orch.tick = async () => {};
  env.orch.kick = () => {};
  return { ...env, store, orch };
}

export async function runUntil(env, pred, { maxVirtualMs = 24 * 3600e3, maxIter = 400000 } = {}) {
  const t0 = env.clock.now();
  env.orch.kick();
  for (let i = 0; i < maxIter; i++) {
    await flush();
    if (pred()) return true;
    if (env.clock.pending() > 0) {
      const next = env.clock.nextAt();
      if (next - t0 > maxVirtualMs) return false;
      env.clock.advanceTo(next);
    } else if (!env.orch.ticking) {
      await flush();
      return pred();
    }
  }
  return false;
}

export const stateIs = (env, ...states) => () => states.includes(env.store.runner.state);

export async function init(env, opts) {
  await env.orch.init(opts);
  if (env.settingsPatch && Object.keys(env.settingsPatch).length) await env.orch.updateSettings(env.settingsPatch);
}

// ───────── партии ─────────
const COLORS = ['black', 'brown', 'red', 'dark-blonde', 'grey', 'auburn'];
export async function makeBatch({ characters = 1, frames = 3, prefix = 'RPS-TEST000001', kind = 'bridge' } = {}) {
  const chars = [];
  for (let c = 1; c <= characters; c++) {
    const cid = `${prefix}-C${String(c).padStart(3, '0')}`;
    const core = { age: 20 + ((c * 7) % 25), hairColor: COLORS[c % COLORS.length], hairLength: ['short', 'chin', 'long'][c % 3], hairType: ['straight', 'wavy', 'curly'][c % 3], eyeColor: ['brown', 'blue', 'green'][c % 3], skinTone: ['light', 'medium', 'tan'][c % 3], build: 'average', height: 'average', freckles: 'none', features: [] };
    chars.push({
      character_id: cid,
      index: c,
      name: `Персонаж ${c}`,
      seed: `seed-${c}`,
      identity: { core, fingerprint: await sha256Hex(canonicalJson(core)), fingerprint_alg: 'sha256-canonical-json' },
      notes: [],
      jobs: Array.from({ length: frames }, (_, i) => ({
        image_job_id: `${cid}-F${String(i + 1).padStart(3, '0')}`,
        index: i + 1,
        prompt: `A photorealistic photo of a fictional adult woman, ${core.age} years old, character ${c}, frame ${i + 1}, standing in a quiet street at golden hour.`,
        negative: 'plastic skin, text artifacts',
        styling: { hairStyle: 'loose', makeup: 'minimal', glasses: 'none' },
        params: { scene_id: `scene-${i + 1}`, season: 'summer', capture: 'candid' },
        reference: null,
      })),
    });
  }
  const raw = { schema: 'rps-batch/1', batch_id: prefix, created_at: '2026-10-17T12:00:00.000Z', source: { app: 'RealPhoto Prompt Studio', engine: '1.0.0', bridge: 1, origin: 'https://promts.vibecods.xyz', kind }, spec: { mode: characters > 1 ? 'multi' : 'single', characters, frames_per_character: frames }, characters: chars };
  const parsed = await parseBatch(raw, { maxJobs: 5000 });
  if (!parsed.ok) throw new Error(`fixture batch invalid: ${parsed.errors.join('; ')}`);
  return parsed.batch;
}

export function loadFixture(name) {
  return readFileSync(new URL(`../../../source/contract/fixtures/${name}`, import.meta.url), 'utf8');
}

export const batchDone = (env, id) => () => env.store.getBatch(id)?.status === 'completed' && env.store.runner.state === 'completed' && !env.orch.ticking;
export const quiet = (env, ...states) => () => states.includes(env.store.runner.state) && !env.orch.ticking;
export async function setup(settings = {}) {
  const env = makeEnv();
  await env.orch.init();
  await env.orch.updateSettings({ intervalSec: 5, ...settings });
  return env;
}
export const folderOf = (env, id) => env.store.getBatch(id).folder;
