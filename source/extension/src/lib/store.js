// Устойчивое хранилище поверх chrome.storage.local (или совместимого объекта): кэш в памяти + атомарная запись нескольких ключей.
// Любое изменение (раннер + задание + событие журнала) уходит одним вызовом set(), чтобы переход статуса был атомарным.
import { DEFAULT_SETTINGS } from './constants.js';

export const KEY = Object.freeze({
  meta: 'rps:meta',
  settings: 'rps:settings',
  runner: 'rps:runner',
  batch: (id) => `rps:batch:${id}`,
  job: (id) => `rps:job:${id}`,
  log: (batchId, n) => `rps:log:${batchId}:${n}`,
});

export const defaultRunner = () => ({
  rev: 0,
  state: 'idle',
  batch_id: null,
  job_id: null,
  phase_started_at: 0,
  last_progress_at: 0,
  progress_sig: null,
  next_allowed_at: 0,
  retry_at: 0,
  pause_requested: false,
  halted: null,
  block: null,
  failure_kind: null,
  policy_streak: 0,
  network_since: 0,
  chat: { tabId: null, characterId: null, framesInChat: 0, url: null },
});

export const defaultMeta = () => ({ schema: 1, selected_batch_id: null, day_counters: {} });

const clone = (v) => (v === undefined ? v : structuredClone(v));

export class Store {
  constructor(area, { now = () => Date.now(), logChunkSize = 200 } = {}) {
    this.area = area;
    this.now = now;
    this.chunkSize = logChunkSize;
    this.meta = defaultMeta();
    this.settings = { ...DEFAULT_SETTINGS };
    this.runner = defaultRunner();
    this.batches = new Map();
    this.jobs = new Map();
    this.logs = new Map();
    this.listeners = new Set();
    this.chain = Promise.resolve();
  }

  /** Гидратация кэша из хранилища (вызывается при каждом старте service worker). */
  async load() {
    const all = (await this.area.get(null)) ?? {};
    this.meta = { ...defaultMeta(), ...(all[KEY.meta] ?? {}) };
    this.settings = { ...DEFAULT_SETTINGS, ...(all[KEY.settings] ?? {}) };
    this.runner = { ...defaultRunner(), ...(all[KEY.runner] ?? {}) };
    this.batches.clear();
    this.jobs.clear();
    this.logs.clear();
    const logKeys = [];
    for (const [k, v] of Object.entries(all)) {
      if (k.startsWith('rps:batch:')) this.batches.set(k.slice('rps:batch:'.length), v);
      else if (k.startsWith('rps:job:')) this.jobs.set(k.slice('rps:job:'.length), v);
      else if (k.startsWith('rps:log:')) logKeys.push(k);
    }
    for (const k of logKeys) {
      const m = /^rps:log:(.+):(\d+)$/.exec(k);
      if (!m) continue;
      const chunks = this.logs.get(m[1]) ?? [];
      chunks[Number(m[2])] = all[k];
      this.logs.set(m[1], chunks);
    }
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  getBatch(id) {
    return this.batches.get(id) ?? null;
  }

  getJob(id) {
    return this.jobs.get(id) ?? null;
  }

  /** Задания партии в порядке очереди. */
  jobsOf(batchId) {
    const b = this.batches.get(batchId);
    if (!b) return [];
    const out = [];
    for (const ch of b.characters) for (const id of ch.job_ids) {
      const j = this.jobs.get(id);
      if (j) out.push(j);
    }
    return out;
  }

  events(batchId, limit = 100) {
    const chunks = this.logs.get(batchId) ?? [];
    const all = [];
    for (let i = chunks.length - 1; i >= 0 && all.length < limit; i--) {
      const c = chunks[i] ?? [];
      for (let k = c.length - 1; k >= 0 && all.length < limit; k--) all.push(c[k]);
    }
    return all.reverse();
  }

  /**
   * Атомарная фиксация изменений.
   * @param {{runner?:object,meta?:object,settings?:object,batches?:Record<string,object>,jobs?:Record<string,object>,events?:object[],removeBatch?:string}} ch
   */
  commit(ch = {}) {
    const run = async () => {
      const out = {};
      let runner = this.runner;
      let meta = this.meta;
      let settings = this.settings;
      if (ch.runner) {
        runner = { ...clone(ch.runner), rev: (this.runner.rev ?? 0) + 1 };
        out[KEY.runner] = runner;
      }
      if (ch.meta) {
        meta = clone(ch.meta);
        out[KEY.meta] = meta;
      }
      if (ch.settings) {
        settings = clone(ch.settings);
        out[KEY.settings] = settings;
      }
      const batches = new Map();
      for (const [id, b] of Object.entries(ch.batches ?? {})) {
        const c = clone(b);
        batches.set(id, c);
        out[KEY.batch(id)] = c;
      }
      const jobs = new Map();
      for (const [id, j] of Object.entries(ch.jobs ?? {})) {
        const c = clone(j);
        jobs.set(id, c);
        out[KEY.job(id)] = c;
      }
      const logs = new Map();
      for (const ev of ch.events ?? []) {
        const bid = ev.batch_id;
        if (!bid) continue;
        let chunks = logs.get(bid) ?? [...(this.logs.get(bid) ?? [])];
        if (!chunks.length || (chunks[chunks.length - 1]?.length ?? 0) >= this.chunkSize) chunks = [...chunks, []];
        const last = chunks[chunks.length - 1] ?? [];
        const seq = (chunks.length - 1) * this.chunkSize + last.length + 1;
        chunks[chunks.length - 1] = [...last, { seq, ts: new Date(this.now()).toISOString(), ...clone(ev) }];
        logs.set(bid, chunks);
        out[KEY.log(bid, chunks.length - 1)] = chunks[chunks.length - 1];
      }
      const removeKeys = [];
      if (ch.removeBatch) {
        const id = ch.removeBatch;
        const b = this.batches.get(id);
        removeKeys.push(KEY.batch(id));
        for (const c of b?.characters ?? []) for (const jid of c.job_ids) removeKeys.push(KEY.job(jid));
        for (let n = 0; n < (this.logs.get(id)?.length ?? 0); n++) removeKeys.push(KEY.log(id, n));
      }
      if (Object.keys(out).length) await this.area.set(out);
      if (removeKeys.length) await this.area.remove(removeKeys);
      this.runner = runner;
      this.meta = meta;
      this.settings = settings;
      for (const [id, b] of batches) this.batches.set(id, b);
      for (const [id, j] of jobs) this.jobs.set(id, j);
      for (const [id, c] of logs) this.logs.set(id, c);
      if (ch.removeBatch) {
        const b = this.batches.get(ch.removeBatch);
        for (const c of b?.characters ?? []) for (const jid of c.job_ids) this.jobs.delete(jid);
        this.batches.delete(ch.removeBatch);
        this.logs.delete(ch.removeBatch);
      }
      for (const fn of this.listeners) {
        try {
          fn();
        } catch {
          // слушатель не должен ломать запись
        }
      }
    };
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => {});
    return p;
  }
}
