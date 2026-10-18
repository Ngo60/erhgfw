// Оркестратор очереди: конечный автомат, повторы, восстановление после выгрузки service worker, защита от дубликатов.
// Не зависит от chrome.* — все внешние действия приходят через deps (страница ChatGPT, загрузка изображения, downloads).
// Каждый шаг идемпотентен: после рестарта состояние читается из хранилища и продолжается без повторной отправки.
import { analyzeSnapshot } from '../lib/chatgpt-classify.js';
import { ACTIVE_STATES, ERR, errInfo, IN_FLIGHT, LIMITS } from '../lib/constants.js';
import { AdapterError, CommandError } from '../lib/errors.js';
import { assertTransition, IllegalTransition } from '../lib/fsm.js';
import { sha256Hex, sniffImage } from '../lib/image.js';
import { buildCharacterJson, buildManifest, buildPromptsJsonl, dataUrl, logToCsv, logToJson } from '../lib/metadata.js';
import { batchFolderName, batchMetaPath, characterMetaPath, imagePath, localDateStamp, sanitizeRoot } from '../lib/naming.js';
import { composePrompt, promptKey } from '../lib/prompt.js';
import { computeTotals, createBatchState, hasPendingWork, nextCounter, pickNextJob } from '../lib/queue.js';
import { backoffMs, networkBackoffMs } from '../lib/retry.js';
import { defaultRunner } from '../lib/store.js';
import { sanitizeSettings } from '../lib/validate.js';

const SLICE_MS = 20_000;
/** Ошибки скачивания: повтор берёт уже найденные изображения и не запускает новую генерацию. */
const REDOWNLOAD_CODES = ['DOWNLOAD_FAILED', 'SIZE_MISMATCH', 'FETCH_FAILED'];
const iso = (ms) => new Date(ms).toISOString();
const ev = (level, code, message, data) => ({ level, code, message, ...(data ? { data } : {}) });

export class Orchestrator {
  /** @param {{store:object, now:()=>number, setTimeout:Function, clearTimeout:Function, sleep:(ms:number)=>Promise<void>, page:object, images:object, downloads:object, notify?:Function}} deps */
  constructor(deps) {
    this.d = deps;
    this.store = deps.store;
    this.now = deps.now ?? (() => Date.now());
    this.ticking = false;
    this.again = false;
    this.wakeHandle = null;
  }

  // ───────── жизненный цикл ─────────

  /** reason: 'wake' — продолжить активную очередь; 'hydrate' — только прочитать состояние; перезапуски → пауза. */
  async init({ reason = 'wake' } = {}) {
    await this.store.load();
    if (reason === 'browser-startup' || reason === 'extension-update') await this.#pauseAfterRestart(reason);
    else if (reason !== 'hydrate' && ACTIVE_STATES.has(this.store.runner.state)) this.kick();
  }

  async notifyRestart(reason) {
    await this.#pauseAfterRestart(reason);
  }

  kick() {
    Promise.resolve().then(() => this.tick());
  }

  onTabRemoved(tabId) {
    const r = this.store.runner;
    if (r.chat?.tabId === tabId && ACTIVE_STATES.has(r.state)) this.kick();
  }

  async #pauseAfterRestart(reason) {
    const r = this.store.runner;
    if (!ACTIVE_STATES.has(r.state)) return;
    const job = r.job_id ? this.store.getJob(r.job_id) : null;
    const halted = reason === 'browser-startup' ? 'BROWSER_RESTART' : 'EXTENSION_UPDATE';
    await this.#go('paused', {
      job: job && IN_FLIGHT.has(job.status) ? job : null,
      jobStatus: 'pending',
      runnerPatch: { halted, pause_requested: false },
      events: [ev('warn', halted, 'Очередь приостановлена после перезапуска. Нажмите «Продолжить»: расширение найдёт уже отправленный промпт и не создаст дубликат.')],
    });
    this.#notify('paused', 'Очередь приостановлена', 'Chrome или расширение были перезапущены. Нажмите «Продолжить» в панели расширения.');
  }

  // ───────── команды пользователя ─────────

  async addBatch(batch, { kind = 'batch' } = {}) {
    const st = this.store;
    let b = batch;
    if (kind === 'test') {
      const c = b.characters[0];
      b = retag({ ...b, characters: [{ ...c, jobs: [c.jobs[0]] }] }, `${b.batch_id.slice(0, 40)}-T${this.now().toString(36)}`);
    }
    const existing = st.getBatch(b.batch_id);
    const total = b.characters.reduce((n, c) => n + c.jobs.length, 0);
    if (existing) {
      await st.commit({ meta: { ...st.meta, selected_batch_id: b.batch_id } });
      return { batch_id: b.batch_id, total, characters: b.characters.length, frames: b.characters[0].jobs.length, folder: existing.folder, existed: true };
    }
    if (total > LIMITS.maxBatchJobs) throw new CommandError('BATCH_TOO_LARGE', `Партия больше лимита ${LIMITS.maxBatchJobs} изображений.`);
    const t = this.now();
    const { n, meta } = nextCounter(st.meta, localDateStamp(t), kind);
    const folder = batchFolderName(localDateStamp(t), n, kind);
    const { header, jobs } = createBatchState(b, { folder, kind, nowIso: iso(t) });
    header.root = sanitizeRoot(st.settings.rootFolder);
    await st.commit({
      meta: { ...meta, selected_batch_id: b.batch_id },
      batches: { [b.batch_id]: header },
      jobs: Object.fromEntries(jobs.map((j) => [j.image_job_id, j])),
      events: [{ batch_id: b.batch_id, ...ev('info', 'BATCH_ADDED', `Партия добавлена: ${total} изображений, папка ${folder}`) }],
    });
    return { batch_id: b.batch_id, total, characters: b.characters.length, frames: b.characters[0].jobs.length, folder, existed: false };
  }

  async start(batchId, confirm = {}) {
    const st = this.store;
    const r = st.runner;
    if (r.state === 'paused' || r.state === 'blocked') throw new CommandError('USE_RESUME', 'Очередь на паузе или остановлена: используйте «Продолжить».');
    if (!['idle', 'completed', 'failed'].includes(r.state)) throw new CommandError('BUSY', 'Очередь уже работает.');
    const batch = st.getBatch(batchId);
    if (!batch) throw new CommandError('NOT_FOUND', 'Партия не найдена.');
    const jobs = st.jobsOf(batchId);
    const totals = computeTotals(jobs);
    if (totals.pending + totals.retryable + totals.active === 0) throw new CommandError('NOTHING_TO_DO', 'В партии нет заданий для запуска.');
    if (totals.total > LIMITS.maxBatchJobs) throw new CommandError('BATCH_TOO_LARGE', `Партия больше лимита ${LIMITS.maxBatchJobs}.`);
    if (totals.total > st.settings.confirmThreshold && confirm?.acknowledged !== true) throw new CommandError('CONFIRM_REQUIRED', `Партия из ${totals.total} изображений требует подтверждения.`);
    if (totals.total > st.settings.strongConfirmThreshold && confirm?.typed_total !== totals.total) throw new CommandError('CONFIRM_MISMATCH', `Введите число ${totals.total} для подтверждения большой партии.`);
    await this.#begin(batch, 'START', `Запуск: ${totals.total - totals.completed - totals.failed} заданий`);
  }

  async #begin(batch, code, message) {
    const st = this.store;
    const r = st.runner;
    assertTransition(r.state, 'preparing');
    await st.commit({
      runner: { ...defaultRunner(), rev: r.rev, state: 'preparing', batch_id: batch.batch_id, phase_started_at: this.now(), policy_streak: 0 },
      batches: { [batch.batch_id]: { ...batch, status: 'running' } },
      meta: { ...st.meta, selected_batch_id: batch.batch_id },
      events: [{ batch_id: batch.batch_id, state: 'preparing', ...ev('info', code, message) }],
    });
    this.kick();
  }

  async resume() {
    const st = this.store;
    const r = st.runner;
    const resumable = r.state === 'paused' || r.state === 'blocked' || (r.state === 'failed' && r.failure_kind !== 'job') || (r.state === 'idle' && r.halted && r.batch_id);
    if (!resumable) throw new CommandError('NOT_RESUMABLE', 'Нечего продолжать.');
    const batch = st.getBatch(r.batch_id);
    if (!batch) throw new CommandError('NOT_FOUND', 'Партия не найдена.');
    await this.#go('preparing', {
      runnerPatch: { pause_requested: false, halted: null, block: null, failure_kind: null, network_since: 0, network_failures: 0, retry_at: 0 },
      batchPatch: { status: 'running' },
      events: [ev('info', 'RESUME', 'Продолжение очереди')],
    });
    this.kick();
  }

  async pause() {
    const st = this.store;
    const r = st.runner;
    if (!['preparing', 'submitting', 'waiting', 'downloading', 'verifying', 'retryable_error', 'completed', 'failed'].includes(r.state)) throw new CommandError('NOT_RUNNING', 'Очередь не выполняется.');
    await st.commit({ runner: { ...r, pause_requested: true }, events: [{ batch_id: r.batch_id, state: r.state, ...ev('info', 'PAUSE_REQUESTED', 'Пауза после завершения текущего изображения') }] });
    this.kick();
  }

  async stop() {
    const r = this.store.runner;
    if (r.state === 'idle') throw new CommandError('NOT_RUNNING', 'Очередь не выполняется.');
    await this.#halt('USER_STOP', 'STOP', 'Остановлено пользователем');
  }

  async emergencyStop() {
    const r = this.store.runner;
    this.#clearWake();
    const tabId = r.chat?.tabId;
    if (r.state !== 'idle') await this.#halt('EMERGENCY', 'EMERGENCY_STOP', 'АВАРИЙНАЯ ОСТАНОВКА');
    if (tabId != null) {
      try {
        await this.d.page.cancel(tabId);
      } catch {
        // вкладки уже может не быть
      }
    }
  }

  async #halt(halted, code, message) {
    const st = this.store;
    const r = st.runner;
    const job = r.job_id ? st.getJob(r.job_id) : null;
    const batch = r.batch_id ? st.getBatch(r.batch_id) : null;
    await this.#go('idle', {
      job: job && IN_FLIGHT.has(job.status) ? job : null,
      jobStatus: 'pending',
      runnerPatch: { halted, pause_requested: false, block: null, retry_at: 0 },
      batchPatch: batch ? { status: 'stopped' } : undefined,
      events: [ev('warn', code, message)],
    });
    if (batch) void this.#flushMetadata(batch.batch_id).catch(() => {});
    this.#notify('stopped', 'Очередь остановлена', message);
  }

  async retryFailed(batchId) {
    const st = this.store;
    const r = st.runner;
    const batch = st.getBatch(batchId);
    if (!batch) throw new CommandError('NOT_FOUND', 'Партия не найдена.');
    if (['preparing', 'submitting', 'waiting', 'downloading', 'verifying', 'retryable_error'].includes(r.state) && r.batch_id === batchId) throw new CommandError('BUSY', 'Дождитесь паузы или остановки очереди.');
    const jobs = st.jobsOf(batchId).filter((j) => j.status === 'failed');
    if (!jobs.length) throw new CommandError('NOTHING_TO_DO', 'Ошибочных заданий нет.');
    const t = iso(this.now());
    const patch = {};
    for (const j of jobs) patch[j.image_job_id] = { ...j, status: 'pending', attempts: 0, download_attempts: 0, downloads: null, error: null, retry_at: 0, updated_at: t, completed_at: null };
    await st.commit({ jobs: patch, batches: { [batchId]: { ...batch, status: 'ready' } }, events: [{ batch_id: batchId, ...ev('info', 'RETRY_FAILED', `Сброшено ошибочных заданий: ${jobs.length}`) }] });
    if (['idle', 'completed', 'failed'].includes(st.runner.state) && st.runner.state !== 'failed') await this.#begin(st.getBatch(batchId), 'START', 'Повтор ошибочных заданий');
    else if (st.runner.state === 'failed') await this.#begin(st.getBatch(batchId), 'START', 'Повтор ошибочных заданий');
  }

  async selectBatch(id) {
    const st = this.store;
    if (!st.getBatch(id)) throw new CommandError('NOT_FOUND', 'Партия не найдена.');
    await st.commit({ meta: { ...st.meta, selected_batch_id: id } });
  }

  async deleteBatch(id) {
    const st = this.store;
    const r = st.runner;
    if (!st.getBatch(id)) throw new CommandError('NOT_FOUND', 'Партия не найдена.');
    if (r.batch_id === id && !['idle', 'completed'].includes(r.state)) throw new CommandError('BUSY', 'Нельзя удалить выполняющуюся партию.');
    const change = { removeBatch: id, meta: { ...st.meta, selected_batch_id: st.meta.selected_batch_id === id ? null : st.meta.selected_batch_id } };
    if (r.batch_id === id) change.runner = { ...defaultRunner(), rev: r.rev };
    await st.commit(change);
  }

  async updateSettings(patch) {
    const res = sanitizeSettings(patch, this.store.settings);
    if (!res.ok) throw new CommandError('BAD_SETTINGS', res.errors.join(' '));
    await this.store.commit({ settings: res.settings });
    return res.settings;
  }

  exportLog(batchId, format) {
    const st = this.store;
    if (!st.getBatch(batchId)) throw new CommandError('NOT_FOUND', 'Партия не найдена.');
    const events = st.events(batchId, Number.MAX_SAFE_INTEGER);
    return format === 'csv'
      ? { filename: `rps-log-${batchId}.csv`, mime: 'text/csv', text: logToCsv(events) }
      : { filename: `rps-log-${batchId}.json`, mime: 'application/json', text: logToJson(events, batchId) };
  }

  // ───────── представление для панели ─────────

  getView({ site, chatgpt } = {}) {
    const st = this.store;
    const r = st.runner;
    const selected = st.meta.selected_batch_id ?? r.batch_id;
    const header = selected ? st.getBatch(selected) : null;
    const batches = [...st.batches.values()]
      .sort((a, b) => String(b.added_at).localeCompare(String(a.added_at)))
      .map((h) => {
        const t = computeTotals(st.jobsOf(h.batch_id));
        return { batch_id: h.batch_id, folder: h.folder, kind: h.kind, status: h.status, created_at: h.created_at, total: t.total, completed: t.completed, failed: t.failed };
      });
    return {
      version: 1,
      runner: { state: r.state, batch_id: r.batch_id, job_id: r.job_id, phase_started_at: r.phase_started_at, next_allowed_at: r.next_allowed_at, retry_at: r.retry_at, pause_requested: r.pause_requested, halted: r.halted, block: r.block, chat: r.chat },
      batch: header ? this.#batchView(header) : null,
      batches,
      settings: { ...st.settings, maxBatchJobs: LIMITS.maxBatchJobs },
      site: site ?? { connected: false },
      chatgpt: chatgpt ?? { tabFound: false },
      events: header ? st.events(header.batch_id, 80) : [],
    };
  }

  #batchView(h) {
    const st = this.store;
    const jobs = st.jobsOf(h.batch_id);
    const byChar = new Map();
    for (const j of jobs) {
      if (!byChar.has(j.character_id)) byChar.set(j.character_id, []);
      byChar.get(j.character_id).push(j);
    }
    return {
      batch_id: h.batch_id,
      folder: h.folder,
      kind: h.kind,
      status: h.status,
      created_at: h.created_at,
      totals: computeTotals(jobs),
      characters: h.characters.map((c) => {
        const list = byChar.get(c.character_id) ?? [];
        return {
          character_id: c.character_id,
          index: c.index,
          name: c.name,
          total: list.length,
          completed: list.filter((j) => j.status === 'completed').length,
          failed: list.filter((j) => j.status === 'failed').length,
          jobs: list.map((j) => ({ index: j.index, image_job_id: j.image_job_id, status: j.status, attempts: j.attempts, file: j.result?.file ?? null, error_code: j.error?.code ?? null })),
        };
      }),
    };
  }

  // ───────── основной цикл ─────────

  async tick() {
    if (this.ticking) {
      this.again = true;
      return;
    }
    this.ticking = true;
    try {
      do {
        this.again = false;
        for (let guard = 0; guard < 2000; guard++) if (!(await this.#step())) break;
      } while (this.again);
    } catch (e) {
      if (!(e instanceof IllegalTransition)) await this.#fatal(e);
    } finally {
      this.ticking = false;
    }
  }

  async #step() {
    switch (this.store.runner.state) {
      case 'preparing':
        return this.#prepare();
      case 'submitting':
        return this.#submit();
      case 'waiting':
        return this.#wait();
      case 'downloading':
        return this.#download();
      case 'verifying':
        return this.#verify();
      case 'completed':
        return this.#afterCompleted();
      case 'retryable_error':
        return this.#afterRetryable();
      case 'failed':
        return this.#afterFailed();
      default:
        return false;
    }
  }

  #stale(r0) {
    const r = this.store.runner;
    return r.state !== r0.state || r.job_id !== r0.job_id || r.batch_id !== r0.batch_id;
  }

  #wake(ms) {
    this.#clearWake();
    this.wakeHandle = this.d.setTimeout(() => {
      this.wakeHandle = null;
      this.kick();
    }, Math.max(50, Math.min(ms, 25_000)));
  }

  #clearWake() {
    if (this.wakeHandle !== null) this.d.clearTimeout(this.wakeHandle);
    this.wakeHandle = null;
  }

  #notify(kind, title, message) {
    if (this.store.settings.notifications) this.d.notify?.(kind, title, message);
  }

  /** Атомарный переход: runner + (опционально) задание + событие журнала — одной записью. */
  async #go(to, { job = null, jobStatus, jobPatch = {}, runnerPatch = {}, batchPatch, events = [] } = {}) {
    const st = this.store;
    const r = st.runner;
    assertTransition(r.state, to);
    const t = this.now();
    const next = { ...r, ...runnerPatch, state: to };
    if (to !== r.state) next.phase_started_at = t;
    const change = { runner: next };
    if (job) {
      const status = jobStatus ?? (IN_FLIGHT.has(to) || to === 'completed' || to === 'retryable_error' ? to : job.status);
      change.jobs = { [job.image_job_id]: { ...job, ...jobPatch, status, updated_at: iso(t) } };
    }
    if (batchPatch && next.batch_id) change.batches = { [next.batch_id]: { ...st.getBatch(next.batch_id), ...batchPatch } };
    change.events = events.map((e) => ({ batch_id: next.batch_id, job_id: next.job_id ?? job?.image_job_id ?? null, state: to, ...e }));
    await st.commit(change);
  }

  async #putJob(job, patch) {
    const next = { ...job, ...patch, updated_at: iso(this.now()) };
    await this.store.commit({ jobs: { [job.image_job_id]: next } });
    return next;
  }

  // ───────── шаги ─────────

  async #prepare() {
    const st = this.store;
    const r0 = st.runner;
    const s = st.settings;
    const batch = st.getBatch(r0.batch_id);
    if (!batch) {
      await this.#go('idle', { runnerPatch: { batch_id: null, job_id: null } });
      return false;
    }
    if (r0.pause_requested) return this.#pauseNow('Пауза (до отправки следующего промпта)');
    const jobs = st.jobsOf(batch.batch_id);
    const { job, waitUntil } = pickNextJob(jobs, this.now());
    if (!job) {
      if (waitUntil !== null) {
        await this.#go('retryable_error', { runnerPatch: { retry_at: waitUntil }, events: [ev('info', 'WAIT_RETRY', 'Ожидание времени повтора')] });
        return true;
      }
      return this.#finishBatch(batch, jobs);
    }
    const t = this.now();
    if (t < r0.next_allowed_at) {
      this.#wake(r0.next_allowed_at - t);
      return false;
    }

    let tab;
    try {
      tab = await this.d.page.ensureTab(r0.chat?.tabId ?? null);
    } catch (e) {
      if (this.#stale(r0)) return true;
      await this.#handleError(e, { job });
      return true;
    }
    if (this.#stale(r0)) return true;

    const resumeDownload = job.resume_from === 'downloading' && job.candidates?.length;
    let chat = { ...(r0.chat ?? {}), tabId: tab.tabId };
    try {
      if (!job.submitted && !resumeDownload && this.#needNewChat(job, r0, s)) {
        await this.d.page.openChat(tab.tabId, s.chatStartUrl);
        chat = { tabId: tab.tabId, characterId: job.character_id, framesInChat: 0, url: null };
      } else if (job.submitted?.chat_url && tab.url && tab.url !== job.submitted.chat_url) {
        await this.d.page.openChat(tab.tabId, job.submitted.chat_url);
      }
      if (!resumeDownload) {
        const snap = await this.d.page.snapshot(tab.tabId);
        const a = analyzeSnapshot(snap, { requireUi: true });
        if (a.offline) throw new AdapterError('NETWORK', 'Браузер сообщает об отсутствии сети.');
        if (a.blocker) throw new AdapterError(a.blocker.code, a.blocker.message);
        if (a.generating && !job.submitted) {
          if (t - r0.phase_started_at < 90_000) {
            this.#wake(3000);
            return false;
          }
          throw new AdapterError('PAGE_BUSY', 'Генерация в ChatGPT не завершилась за 90 секунд.');
        }
      }
    } catch (e) {
      if (this.#stale(r0)) return true;
      await this.#handleError(e, { job });
      return true;
    }
    if (this.#stale(r0)) return true;

    const fresh = !job.submitted && !resumeDownload;
    await this.#go('submitting', {
      job,
      jobStatus: 'submitting',
      jobPatch: { started_at: job.started_at ?? iso(t), attempts: fresh ? job.attempts + 1 : job.attempts, error: null },
      runnerPatch: { job_id: job.image_job_id, chat, failure_kind: null },
      batchPatch: { status: 'running' },
      events: [ev('info', 'JOB_START', `Кадр ${job.index} персонажа ${job.character_index}${fresh && job.attempts > 0 ? ` — попытка ${job.attempts + 1}` : ''}`)],
    });
    return true;
  }

  #needNewChat(job, r, s) {
    if (s.newChatPerCharacter && r.chat?.characterId !== job.character_id) return true;
    if (s.rotateChatEvery > 0 && (r.chat?.framesInChat ?? 0) >= s.rotateChatEvery) return true;
    return false;
  }

  async #submit() {
    const st = this.store;
    const r0 = st.runner;
    const s = st.settings;
    const job = st.getJob(r0.job_id);
    const batch = st.getBatch(r0.batch_id);
    if (!job || !batch) {
      await this.#go('idle', { runnerPatch: { job_id: null } });
      return false;
    }
    if (job.resume_from === 'downloading' && job.candidates?.length) {
      await this.#go('downloading', { job, jobStatus: 'downloading', events: [ev('info', 'RESUME_DOWNLOAD', 'Повторная загрузка без повторной генерации')] });
      return true;
    }
    const text = composePrompt(job, s);
    const key = promptKey(text);
    const tabId = r0.chat.tabId;
    try {
      if (job.submitted || job.attempts > 1) {
        const loc = await this.d.page.locate(tabId, { key, minSide: s.minImageSide, usedKeys: this.#usedKeys(batch.batch_id) });
        if (this.#stale(r0)) return true;
        if (loc.found && loc.images?.length) {
          await this.#go('downloading', { job, jobStatus: 'downloading', jobPatch: { candidates: loc.images, downloads: null, resume_from: 'downloading' }, events: [ev('info', 'REATTACH', 'Изображение найдено в беседе — повторная отправка не нужна')] });
          return true;
        }
        if (loc.found && (job.submitted || loc.generating)) {
          await this.#go('waiting', {
            job,
            jobStatus: 'waiting',
            jobPatch: job.submitted ? {} : { submitted: { at: iso(this.now()), token: `${job.image_job_id}#${job.attempts}`, baseline: null, chat_url: loc.url ?? null, user_turn_index: loc.userTurnIndex ?? null }, error: null },
            runnerPatch: { last_progress_at: this.now(), progress_sig: null },
            events: [ev('info', 'REATTACH', 'Промпт уже отправлен — продолжаю ожидание без повторной отправки')],
          });
          return true;
        }
      }
      const res = await this.d.page.submit(tabId, { jobId: job.image_job_id, text, key, token: `${job.image_job_id}#${job.attempts}` });
      if (this.#stale(r0)) return true;
      if (!res?.accepted) throw new AdapterError('PROMPT_NOT_ACCEPTED', 'Сообщение не появилось в беседе.');
      await this.#go('waiting', {
        job,
        jobStatus: 'waiting',
        jobPatch: { submitted: { at: iso(this.now()), token: `${job.image_job_id}#${job.attempts}`, baseline: res.baseline ?? null, chat_url: res.url ?? null, user_turn_index: res.userTurnIndex ?? null }, error: null },
        runnerPatch: { last_progress_at: this.now(), progress_sig: null, chat: { ...r0.chat, url: res.url ?? r0.chat.url } },
        events: [ev('info', 'SUBMITTED', 'Промпт отправлен в ChatGPT')],
      });
      return true;
    } catch (e) {
      if (this.#stale(r0)) return true;
      await this.#handleError(e, { job });
      return true;
    }
  }

  async #wait() {
    const st = this.store;
    const r0 = st.runner;
    const s = st.settings;
    const job = st.getJob(r0.job_id);
    const batch = st.getBatch(r0.batch_id);
    if (!job || !batch) {
      await this.#go('idle', { runnerPatch: { job_id: null } });
      return false;
    }
    const t0 = this.now();
    if (t0 - r0.phase_started_at > s.jobTimeoutSec * 1000) {
      await this.#handleError(new AdapterError('TIMEOUT', `Нет результата за ${s.jobTimeoutSec} с`), { job });
      return true;
    }
    if (t0 - r0.last_progress_at > s.stallTimeoutSec * 1000) {
      await this.#handleError(new AdapterError('STALLED', `Нет изменений в интерфейсе ${s.stallTimeoutSec} с`), { job });
      return true;
    }
    const key = promptKey(composePrompt(job, s));
    let res;
    try {
      res = await this.d.page.waitSlice(r0.chat.tabId, { key, baseline: job.submitted?.baseline ?? null, usedKeys: this.#usedKeys(batch.batch_id), minSide: s.minImageSide, sliceMs: SLICE_MS });
    } catch (e) {
      if (this.#stale(r0)) return true;
      await this.#handleError(e, { job, keepSubmitted: true });
      return true;
    }
    if (this.#stale(r0)) return true;
    switch (res.status) {
      case 'pending': {
        const spent = this.now() - t0;
        if (res.sig !== r0.progress_sig) await st.commit({ runner: { ...st.runner, progress_sig: res.sig, last_progress_at: this.now() } });
        if (spent < 500) await this.d.sleep(500 - spent);
        return true;
      }
      case 'done': {
        if (!res.images?.length) {
          await this.#handleError(new AdapterError('NO_IMAGE', 'Изображение не найдено.'), { job });
          return true;
        }
        await this.#go('downloading', {
          job,
          jobStatus: 'downloading',
          jobPatch: { candidates: res.images.map(({ key: k, src, alt, w, h }) => ({ key: k, src, alt, w, h })), downloads: null, resume_from: 'downloading' },
          events: [ev('info', 'IMAGE_READY', `Изображений найдено: ${res.images.length}`)],
        });
        return true;
      }
      case 'blocked':
        await this.#block(res.code, res.message, { job, keepSubmitted: res.code !== 'RATE_LIMIT' });
        return true;
      case 'error':
        await this.#handleError({ code: res.code, message: res.message }, { job });
        return true;
      default:
        await this.#handleError(new AdapterError('INTERNAL', 'Неизвестный ответ страницы.'), { job });
        return true;
    }
  }

  #chooseCandidates(list, policy) {
    if (!list.length) return { error: 'NO_IMAGE' };
    if (list.length === 1) return { list };
    if (policy === 'first') return { list: [list[0]] };
    if (policy === 'all') return { list };
    return { error: 'MULTIPLE_IMAGES' };
  }

  async #download() {
    const st = this.store;
    const r0 = st.runner;
    const s = st.settings;
    let job = st.getJob(r0.job_id);
    const batch = st.getBatch(r0.batch_id);
    if (!job || !batch) {
      await this.#go('idle', { runnerPatch: { job_id: null } });
      return false;
    }
    const choice = this.#chooseCandidates(job.candidates ?? [], s.multiImagePolicy);
    if (choice.error) {
      await this.#handleError(new AdapterError(choice.error, errInfo(choice.error).ru), { job });
      return true;
    }
    const downloads = [...(job.downloads ?? [])];
    try {
      for (const [k, cand] of choice.list.entries()) {
        if (downloads[k]?.state === 'complete') continue;
        const fetched = await this.d.images.fetch(cand.src);
        const info = sniffImage(fetched.bytes);
        if (!info) throw new AdapterError('UNSUPPORTED_IMAGE_FORMAT', 'Не удалось определить формат изображения.');
        if (s.minImageSide > 0 && Math.min(info.width, info.height) < s.minImageSide) {
          throw new AdapterError('PREVIEW_ONLY', `Размер ${info.width}×${info.height} меньше минимума ${s.minImageSide}px`);
        }
        const sha = await sha256Hex(fetched.bytes);
        const owner = this.#dupOwner(batch.batch_id, sha, job.image_job_id);
        if (owner) {
          job = await this.#putJob(job, { rejected_keys: [...(job.rejected_keys ?? []), cand.key] });
          throw new AdapterError('DUPLICATE_IMAGE', `Это изображение уже сохранено для ${owner}`);
        }
        const filename = imagePath({ root: batch.root, batchFolder: batch.folder, characterIndex: job.character_index, frameIndex: job.index, format: info.format, variant: k + 1 });
        const id = await this.d.downloads.start({ url: cand.src, filename, conflictAction: 'overwrite' });
        downloads[k] = { key: cand.key, filename, id, bytes: fetched.bytes.length, sha256: sha, format: info.format, width: info.width, height: info.height, state: 'started' };
        job = await this.#putJob(job, { downloads });
        await this.d.downloads.waitComplete(id, 120_000);
        downloads[k] = { ...downloads[k], state: 'complete' };
        job = await this.#putJob(job, { downloads });
        if (this.#stale(r0)) return true;
      }
    } catch (e) {
      if (this.#stale(r0)) return true;
      if (e instanceof AdapterError && e.code === 'FETCH_FAILED' && [401, 403, 404, 410].includes(e.status)) {
        job = await this.#putJob(job, { candidates: null, downloads: null, resume_from: null, submitted: null });
      }
      await this.#handleError(e, { job });
      return true;
    }
    await this.#go('verifying', { job, jobStatus: 'verifying', jobPatch: { downloads }, events: [ev('info', 'DOWNLOADED', `Файлов сохранено: ${downloads.length}`)] });
    return true;
  }

  async #verify() {
    const st = this.store;
    const r0 = st.runner;
    const s = st.settings;
    const job = st.getJob(r0.job_id);
    const batch = st.getBatch(r0.batch_id);
    if (!job || !batch) {
      await this.#go('idle', { runnerPatch: { job_id: null } });
      return false;
    }
    const downloads = job.downloads ?? [];
    try {
      if (!downloads.length) throw new AdapterError('DOWNLOAD_FAILED', 'Нет сведений о загрузке.');
      for (const d of downloads) {
        const item = await this.d.downloads.search(d.id);
        if (!item || item.state !== 'complete' || item.exists === false) throw new AdapterError('DOWNLOAD_FAILED', `Файл ${d.filename} не найден или загрузка не завершена.`);
        if (item.fileSize !== d.bytes) throw new AdapterError('SIZE_MISMATCH', `Размер файла ${item.fileSize} ≠ ${d.bytes}`);
      }
    } catch (e) {
      if (this.#stale(r0)) return true;
      await this.#handleError(e, { job });
      return true;
    }
    if (this.#stale(r0)) return true;
    const t = this.now();
    const first = downloads[0];
    const result = { file: first.filename, files: downloads.map((d) => d.filename), bytes: first.bytes, format: first.format, width: first.width, height: first.height, sha256: first.sha256, hashes: downloads.map((d) => d.sha256), keys: downloads.map((d) => d.key), download_id: first.id, saved_at: iso(t) };
    await this.#go('completed', {
      job,
      jobStatus: 'completed',
      jobPatch: { result, error: null, completed_at: iso(t), submitted: null, candidates: null, resume_from: null },
      runnerPatch: { next_allowed_at: t + s.intervalSec * 1000, policy_streak: 0, network_since: 0, network_failures: 0, chat: { ...r0.chat, framesInChat: (r0.chat?.framesInChat ?? 0) + 1 } },
      events: [ev('info', 'JOB_DONE', `Сохранено: ${result.file} (${result.width}×${result.height}, ${result.bytes} Б)`)],
    });
    await this.#writeMetadata(batch.batch_id, job.character_id, { manifest: this.#manifestDue(batch.batch_id, job.character_id) }).catch(() => {});
    return true;
  }

  async #afterCompleted() {
    const st = this.store;
    const r = st.runner;
    const batch = st.getBatch(r.batch_id);
    if (!batch) return false;
    const jobs = st.jobsOf(batch.batch_id);
    if (!hasPendingWork(jobs)) return this.#finishBatch(batch, jobs);
    if (r.pause_requested) return this.#pauseNow('Пауза после завершения изображения');
    const wait = r.next_allowed_at - this.now();
    if (wait > 0) {
      this.#wake(wait);
      return false;
    }
    await this.#go('preparing', { runnerPatch: { job_id: null } });
    return true;
  }

  async #afterRetryable() {
    const st = this.store;
    const r = st.runner;
    if (r.pause_requested) return this.#pauseNow('Пауза (ожидание повтора)');
    const wait = r.retry_at - this.now();
    if (wait > 0) {
      this.#wake(wait);
      return false;
    }
    await this.#go('preparing', {});
    return true;
  }

  async #afterFailed() {
    const st = this.store;
    const r = st.runner;
    if (r.failure_kind !== 'job') return false;
    if (r.pause_requested) return this.#pauseNow('Пауза после ошибки задания');
    const wait = r.next_allowed_at - this.now();
    if (wait > 0) {
      this.#wake(wait);
      return false;
    }
    await this.#go('preparing', { runnerPatch: { job_id: null, failure_kind: null } });
    return true;
  }

  async #pauseNow(message) {
    const r = this.store.runner;
    const job = r.job_id ? this.store.getJob(r.job_id) : null;
    await this.#go('paused', { job: job && IN_FLIGHT.has(job.status) ? job : null, jobStatus: 'pending', runnerPatch: { pause_requested: false, halted: null }, events: [ev('info', 'PAUSED', message)] });
    if (r.batch_id) await this.#flushMetadata(r.batch_id).catch(() => {});
    return false;
  }

  async #finishBatch(batch, jobs) {
    const st = this.store;
    if (batch.status === 'completed' && st.runner.state === 'completed') return false;
    const totals = computeTotals(jobs);
    await this.#go('completed', {
      runnerPatch: { job_id: null },
      batchPatch: { status: 'completed' },
      events: [ev('info', 'BATCH_DONE', `Партия завершена: готово ${totals.completed} из ${totals.total}, ошибок ${totals.failed}`)],
    });
    await this.#flushMetadata(batch.batch_id).catch(() => {});
    this.#notify('completed', 'Партия завершена', `Готово ${totals.completed} из ${totals.total}, ошибок ${totals.failed}.`);
    return false;
  }

  /** Ключи изображений, уже использованных в партии (сохранённые и отклонённые как дубликаты). */
  #usedKeys(batchId) {
    const out = [];
    for (const j of this.store.jobsOf(batchId)) {
      if (j.result?.keys) out.push(...j.result.keys);
      if (j.rejected_keys) out.push(...j.rejected_keys);
    }
    return out;
  }

  #dupOwner(batchId, sha, jobId) {
    for (const j of this.store.jobsOf(batchId)) if (j.image_job_id !== jobId && j.status === 'completed' && j.result?.hashes?.includes(sha)) return j.image_job_id;
    return null;
  }

  // ───────── ошибки ─────────

  async #handleError(err, { job = null, keepSubmitted = true } = {}) {
    const code = typeof err?.code === 'string' && Object.hasOwn(ERR, err.code) ? err.code : 'INTERNAL';
    const info = errInfo(code);
    const detail = err?.message && err.message !== code ? err.message : info.ru;
    const cur = job ?? (this.store.runner.job_id ? this.store.getJob(this.store.runner.job_id) : null);
    switch (info.kind) {
      case 'blocking':
        return this.#block(code, detail, { job: cur, keepSubmitted });
      case 'network':
        return this.#networkError(detail, cur);
      case 'retry':
        return this.#retryOrFail(code, detail, cur);
      default:
        return this.#failJob(code, detail, cur);
    }
  }

  async #block(code, detail, { job = null, keepSubmitted = true } = {}) {
    const info = errInfo(code);
    const message = detail && detail !== info.ru ? `${info.ru} (${detail})` : info.ru;
    const cur = job ?? (this.store.runner.job_id ? this.store.getJob(this.store.runner.job_id) : null);
    await this.#go('blocked', {
      job: cur,
      jobStatus: cur && IN_FLIGHT.has(cur.status) ? 'pending' : cur?.status,
      jobPatch: cur ? { error: { code, message: info.ru }, submitted: keepSubmitted ? cur.submitted : null, ...(keepSubmitted ? {} : { attempts: Math.max(0, cur.attempts - 1) }) } : {},
      runnerPatch: { block: { code, message, at: iso(this.now()) }, pause_requested: false, job_id: cur?.image_job_id ?? this.store.runner.job_id },
      events: [ev('error', code, message)],
    });
    this.#notify('blocked', 'Очередь остановлена', message);
    return true;
  }

  async #networkError(detail, job) {
    const st = this.store;
    const r = st.runner;
    const t = this.now();
    const since = r.network_since || t;
    const failures = (r.network_failures ?? 0) + 1;
    if (t - since > st.settings.networkGiveUpSec * 1000) return this.#block('OFFLINE', detail, { job });
    const retryAt = t + networkBackoffMs(failures);
    await this.#go('retryable_error', {
      job,
      jobStatus: 'retryable_error',
      jobPatch: job ? { error: { code: 'NETWORK', message: detail }, retry_at: retryAt } : {},
      runnerPatch: { retry_at: retryAt, network_since: since, network_failures: failures, job_id: job?.image_job_id ?? r.job_id },
      events: [ev('warn', 'NETWORK', `${detail} Повтор через ${Math.round((retryAt - t) / 1000)} с (попытка не расходуется)`)],
    });
    return true;
  }

  async #retryOrFail(code, detail, job) {
    const st = this.store;
    if (!job) return this.#failJob(code, detail, job);
    const redownload = REDOWNLOAD_CODES.includes(code) && Boolean(job.candidates?.length);
    const used = redownload ? (job.download_attempts ?? 0) + 1 : job.attempts;
    if (used >= st.settings.maxAttempts) return this.#failJob(code, `${detail} (попытки исчерпаны: ${used})`, job);
    if (code === 'STALLED' || code === 'TIMEOUT') await this.#stopStuckGeneration();
    const t = this.now();
    const retryAt = t + backoffMs(used);
    await this.#go('retryable_error', {
      job,
      jobStatus: 'retryable_error',
      jobPatch: { error: { code, message: detail }, retry_at: retryAt, submitted: null, ...(redownload ? { download_attempts: used, downloads: null } : { candidates: null, downloads: null, resume_from: null }) },
      runnerPatch: { retry_at: retryAt, job_id: job.image_job_id },
      events: [ev('warn', code, `${detail} Повтор через ${Math.round((retryAt - t) / 1000)} с (попытка ${used} из ${st.settings.maxAttempts})`)],
    });
    return true;
  }

  /** Своя зависшая генерация останавливается кнопкой «Стоп» — иначе поле ввода ChatGPT остаётся занятым. */
  async #stopStuckGeneration() {
    const tabId = this.store.runner.chat?.tabId;
    if (tabId == null) return;
    try {
      await this.d.page.cancel(tabId);
    } catch {
      // вкладка недоступна — повтор сам обнаружит это
    }
  }

  async #failJob(code, detail, job) {
    const st = this.store;
    const r = st.runner;
    const t = this.now();
    const streak = code === 'CONTENT_POLICY' ? (r.policy_streak ?? 0) + 1 : 0;
    const message = detail || errInfo(code).ru;
    if (code === 'STALLED' || code === 'TIMEOUT') await this.#stopStuckGeneration();
    if (!job) {
      await this.#go('failed', { runnerPatch: { failure_kind: 'fatal', policy_streak: streak }, events: [ev('error', code, message)] });
      return true;
    }
    const jobPatch = { error: { code, message }, completed_at: iso(t), submitted: null, downloads: null, ...(code === 'MULTIPLE_IMAGES' || REDOWNLOAD_CODES.includes(code) ? {} : { resume_from: null, candidates: null }) };
    const stopNow = code === 'CONTENT_POLICY' && streak >= st.settings.stopAfterPolicyRefusals;
    if (stopNow) {
      const text = `Подряд отклонено заданий: ${streak}. Проверьте пресет и промпты. ${errInfo('CONTENT_POLICY').ru}`;
      await this.#go('blocked', {
        job,
        jobStatus: 'failed',
        jobPatch,
        runnerPatch: { block: { code: 'CONTENT_POLICY', message: text, at: iso(t) }, policy_streak: streak, pause_requested: false, job_id: job.image_job_id },
        events: [ev('error', code, `Задание не выполнено: ${message}`), ev('error', 'CONTENT_POLICY', text)],
      });
      this.#notify('blocked', 'Очередь остановлена', text);
    } else {
      await this.#go('failed', {
        job,
        jobStatus: 'failed',
        jobPatch,
        runnerPatch: { failure_kind: 'job', next_allowed_at: t + st.settings.intervalSec * 1000, policy_streak: streak, job_id: job.image_job_id },
        events: [ev('error', code, `Задание не выполнено: ${message}`)],
      });
    }
    await this.#writeMetadata(job.batch_id, job.character_id, { manifest: this.#manifestDue(job.batch_id, job.character_id) }).catch(() => {});
    return true;
  }

  async #fatal(e) {
    try {
      const st = this.store;
      const r = st.runner;
      const job = r.job_id ? st.getJob(r.job_id) : null;
      await this.#go('failed', {
        job: job && IN_FLIGHT.has(job.status) ? job : null,
        jobStatus: 'pending',
        runnerPatch: { failure_kind: 'fatal' },
        events: [ev('error', 'INTERNAL', `Внутренняя ошибка: ${String(e?.message ?? e).slice(0, 300)}`)],
      });
      this.#notify('failed', 'Ошибка расширения', String(e?.message ?? e).slice(0, 200));
    } catch {
      // запись состояния не удалась — оставляем как есть
    }
  }

  // ───────── метаданные на диске ─────────

  /** manifest.json пишется по завершении персонажа и раз в 25 готовых заданий (не после каждого кадра). */
  #manifestDue(batchId, characterId) {
    const jobs = this.store.jobsOf(batchId);
    const own = jobs.filter((j) => j.character_id === characterId);
    if (own.every((j) => j.status === 'completed' || j.status === 'failed')) return true;
    return jobs.filter((j) => j.status === 'completed').length % 25 === 0;
  }

  async #flushMetadata(batchId) {
    const batch = this.store.getBatch(batchId);
    if (!batch) return;
    for (const c of batch.characters) await this.#writeMetadata(batchId, c.character_id, { character: true });
    await this.#writeMetadata(batchId, null, { manifest: true });
  }

  async #writeMetadata(batchId, characterId, { character = false, manifest = false } = {}) {
    const st = this.store;
    if (!st.settings.writeMetadata) return;
    const batch = st.getBatch(batchId);
    if (!batch) return;
    const jobs = st.jobsOf(batchId);
    const byChar = new Map();
    for (const j of jobs) {
      if (!byChar.has(j.character_id)) byChar.set(j.character_id, []);
      byChar.get(j.character_id).push(j);
    }
    const ch = characterId ? batch.characters.find((c) => c.character_id === characterId) : null;
    const files = [];
    if (ch) {
      const list = byChar.get(ch.character_id) ?? [];
      files.push([characterMetaPath(batch.root, batch.folder, ch.index, 'prompts.jsonl'), buildPromptsJsonl(list), 'application/x-ndjson']);
      if (character || list.filter((j) => j.status === 'completed').length <= 1) files.push([characterMetaPath(batch.root, batch.folder, ch.index, 'character.json'), JSON.stringify(buildCharacterJson(batch, ch), null, 2), 'application/json']);
    }
    if (manifest) files.push([batchMetaPath(batch.root, batch.folder, 'manifest.json'), JSON.stringify(buildManifest(batch, byChar, iso(this.now())), null, 2), 'application/json']);
    for (const [filename, text, mime] of files) {
      try {
        const id = await this.d.downloads.start({ url: dataUrl(text, mime), filename, conflictAction: 'overwrite' });
        await this.d.downloads.waitComplete(id, 20_000);
        await this.d.downloads.erase?.(id);
      } catch (e) {
        await st.commit({ events: [{ batch_id: batchId, state: st.runner.state, ...ev('warn', 'METADATA_FAILED', `Не удалось записать ${filename}: ${String(e?.message ?? e).slice(0, 120)}`) }] });
      }
    }
  }
}

/** Переименовывает партию (для тестовых заданий), сохраняя уникальность ключей хранилища. */
function retag(batch, newId) {
  const old = batch.batch_id;
  const re = (s) => newId + s.slice(old.length);
  return {
    ...batch,
    batch_id: newId,
    characters: batch.characters.map((c) => ({ ...c, character_id: re(c.character_id), jobs: c.jobs.map((j) => ({ ...j, image_job_id: re(j.image_job_id) })) })),
  };
}
