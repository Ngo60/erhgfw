// Боковая панель: тонкий клиент. Вся очередь живёт в service worker, панель только
// показывает `view` и отправляет команды (docs/02-CONTRACT.md §7), поэтому её можно закрыть в любой момент.
import { t } from './i18n/ru.js';

/* ───────── константы ───────── */

const POLL_MS = 2000;
const RECONNECT_MS = 500;
const MAX_IMPORT_BYTES = 15 * 1024 * 1024;
const MAX_LOG_ROWS = 200;
const CLOCK_MS = 250;
const SEED_RE = /^[A-Za-z0-9._~:-]{1,64}$/;
const DEFAULT_PROFILES = ['gpt-image', 'universal', 'nano-banana', 'seedance'];

const ACTIVE = new Set(['preparing', 'submitting', 'waiting', 'downloading', 'verifying']);
const PAUSABLE = new Set([...ACTIVE, 'retryable_error']);
const STARTABLE = new Set(['idle', 'completed', 'failed']);
const RESUMABLE = new Set(['paused', 'blocked']);
const RETRYABLE = new Set(['idle', 'completed', 'failed', 'paused', 'blocked']);
// completed/failed — это и пауза между заданиями (ждём next_allowed_at), и конец партии
const BETWEEN_JOBS = new Set(['completed', 'failed']);
const QUIET = new Set(['idle', 'paused', 'blocked']);
const TONE = {
  idle: 'neutral', preparing: 'info', submitting: 'info', waiting: 'info', downloading: 'info', verifying: 'info',
  completed: 'ok', retryable_error: 'warn', paused: 'warn', blocked: 'error', failed: 'error',
};
const ZERO_TOTALS = { total: 0, completed: 0, failed: 0, pending: 0, active: 0, retryable: 0 };

const DEFAULT_SETTINGS = {
  rootFolder: 'ChatGPT-Images', intervalSec: 5, maxAttempts: 3, jobTimeoutSec: 600, stallTimeoutSec: 240,
  networkGiveUpSec: 900, newChatPerCharacter: true, rotateChatEvery: 12, chatStartUrl: 'https://chatgpt.com/',
  multiImagePolicy: 'fail', minImageSide: 512, promptPrefix: '', promptSuffix: '', confirmThreshold: 50,
  strongConfirmThreshold: 300, stopAfterPolicyRefusals: 3, notifications: true, writeMetadata: true, maxBatchJobs: 1500,
};

const SETTINGS_GROUPS = ['storage', 'pace', 'chat', 'result', 'prompt', 'safety', 'misc'];
const SETTINGS_FIELDS = [
  { key: 'rootFolder', group: 'storage', type: 'text', validate: validateFolder },
  { key: 'writeMetadata', group: 'storage', type: 'checkbox' },
  { key: 'intervalSec', group: 'pace', type: 'number', min: 2, max: 120 },
  { key: 'maxAttempts', group: 'pace', type: 'number', min: 1, max: 5 },
  { key: 'jobTimeoutSec', group: 'pace', type: 'number', min: 60, max: 1800 },
  { key: 'stallTimeoutSec', group: 'pace', type: 'number', min: 60, max: 900 },
  { key: 'networkGiveUpSec', group: 'pace', type: 'number', min: 60, max: 3600 },
  { key: 'chatStartUrl', group: 'chat', type: 'url', validate: validateChatUrl },
  { key: 'newChatPerCharacter', group: 'chat', type: 'checkbox' },
  { key: 'rotateChatEvery', group: 'chat', type: 'number', min: 0, max: 100 },
  { key: 'multiImagePolicy', group: 'result', type: 'select', options: ['fail', 'first', 'all'] },
  { key: 'minImageSide', group: 'result', type: 'number', min: 0, max: 4096 },
  { key: 'promptPrefix', group: 'prompt', type: 'textarea', maxLength: 500 },
  { key: 'promptSuffix', group: 'prompt', type: 'textarea', maxLength: 500 },
  { key: 'confirmThreshold', group: 'safety', type: 'number', min: 1, max: 1500 },
  { key: 'strongConfirmThreshold', group: 'safety', type: 'number', min: 1, max: 1500 },
  { key: 'stopAfterPolicyRefusals', group: 'safety', type: 'number', min: 1, max: 10 },
  { key: 'notifications', group: 'misc', type: 'checkbox' },
];

const ABOUT_SECTIONS = [
  { title: 'about.what.title', text: 'about.what.text' },
  { title: 'about.how.title', text: 'about.how.text' },
  { title: 'about.tos.title', text: 'about.tos.text', list: ['about.tos.tip.1', 'about.tos.tip.2', 'about.tos.tip.3'] },
  { title: 'about.limits.title', text: 'about.limits.text' },
  { title: 'about.identity.title', text: 'about.identity.text' },
  { title: 'about.files.title', text: 'about.files.text' },
  { title: 'about.privacy.title', text: 'about.privacy.text' },
  { title: 'about.limitations.title', list: [1, 2, 3, 4, 5, 6, 7].map((n) => `about.limitation.${n}`) },
];

/* ───────── утилиты ───────── */

const byId = (id) => document.getElementById(id);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const num = (v, d = 0) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? d : Number(v));
const pad2 = (n) => String(n).padStart(2, '0');
const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/** DOM без innerHTML: текст всегда идёт через textContent / текстовые узлы. */
function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'text') node.textContent = value;
    else if (key === 'class') node.className = value;
    else if (key === 'dataset') {
      for (const [k, v] of Object.entries(value)) if (v !== undefined && v !== null) node.dataset[k] = v;
    } else node.setAttribute(key, value === true ? '' : String(value));
  }
  node.append(...[].concat(children).filter((c) => c !== null && c !== undefined && c !== false));
  return node;
}

const fill = (node, ...children) => node.replaceChildren(...children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false));

/** Пробелы между соседними элементами: в flex-раскладке их не видно, но textContent и скринридер читают слова раздельно. */
const spaced = (...nodes) => nodes.filter(Boolean).flatMap((n, i) => (i ? [' ', n] : [n]));

function setText(node, text) {
  if (node.textContent !== text) node.textContent = text;
}

function setDisabled(id, value) {
  const node = byId(id);
  if (node.disabled !== value) node.disabled = value;
}

/** Нужна ли перерисовка секции: сравниваем компактную подпись данных. */
function changed(key, value) {
  const sig = JSON.stringify(value) ?? '';
  if (ui.memo[key] === sig) return false;
  ui.memo[key] = sig;
  return true;
}

function label(prefix, value) {
  if (value === null || value === undefined || value === '') return '—';
  const key = prefix + value;
  const text = t(key);
  return text === key ? String(value) : text;
}

function toMs(v) {
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? v : 0;
  if (typeof v === 'string' && v) {
    const ms = Date.parse(v);
    return Number.isNaN(ms) ? 0 : ms;
  }
  return 0;
}

function fmtElapsed(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${pad2(m)}:${pad2(s % 60)}` : `${m}:${pad2(s % 60)}`;
}

function fmtCountdown(ms) {
  const s = Math.max(1, Math.ceil(ms / 1000));
  if (s < 60) return t('time.sec', { n: s });
  return s % 60 ? t('time.minSec', { m: Math.floor(s / 60), s: s % 60 }) : t('time.min', { m: Math.floor(s / 60) });
}

function fmtBytes(n) {
  return n >= 1048576 ? `${(n / 1048576).toFixed(1)} ${t('unit.mb')}` : `${Math.max(1, Math.round(n / 1024))} ${t('unit.kb')}`;
}

function fmtClock(ts) {
  const ms = toMs(ts);
  return ms ? new Date(ms).toLocaleTimeString('ru-RU', { hour12: false }) : '';
}

/* ───────── состояние панели ───────── */

const ui = {
  view: normalizeView(null),
  sig: '', // подпись последнего view: одинаковые обновления не перерисовываются
  rev: 0, // растёт с каждым новым view; по нему отбрасываем устаревшие ответы команд
  memo: {},
  tab: 'queue',
  busy: false, // выполняется команда управления очередью
  creating: false,
  siteProgress: null, // { done, total } от сайта, пока он собирает партию
  pausing: false, // «Пауза» нажата, worker ещё не подтвердил
  offline: false,
  importFile: null,
  settingsBase: {}, // последние настройки из worker
  dirty: new Set(), // поля, которые пользователь правил и ещё не сохранил
  saving: false,
  sctl: {}, // элементы управления настройками по ключу
  charKey: '',
  presetsKey: '',
  presetsRetryAt: 0,
  refreshing: false,
  refreshAgain: false,
  port: null,
  portFailures: 0,
  clock: null,
  toastTimer: null,
};

/* ───────── нормализация view (частичный view не должен ломать панель) ───────── */

function jobTotals(jobs) {
  const x = { ...ZERO_TOTALS };
  for (const j of jobs) {
    x.total += 1;
    if (j.status === 'completed') x.completed += 1;
    else if (j.status === 'failed') x.failed += 1;
    else if (j.status === 'retryable_error') x.retryable += 1;
    else if (!j.status || j.status === 'pending') x.pending += 1;
    else x.active += 1;
  }
  return x;
}

function normalizeBatch(b) {
  if (!isObj(b)) return null;
  const characters = (Array.isArray(b.characters) ? b.characters : []).filter(isObj).map((c, i) => {
    const jobs = (Array.isArray(c.jobs) ? c.jobs : []).filter(isObj);
    return {
      ...c,
      jobs,
      index: num(c.index, i + 1),
      total: num(c.total, jobs.length),
      completed: num(c.completed, jobs.filter((j) => j.status === 'completed').length),
      failed: num(c.failed, jobs.filter((j) => j.status === 'failed').length),
    };
  });
  const base = isObj(b.totals) ? ZERO_TOTALS : jobTotals(characters.flatMap((c) => c.jobs));
  const raw = isObj(b.totals) ? b.totals : {};
  const totals = Object.fromEntries(Object.keys(ZERO_TOTALS).map((k) => [k, num(raw[k], base[k])]));
  return { ...b, characters, totals };
}

function normalizeView(raw) {
  const v = isObj(raw) ? raw : {};
  const runner = { ...(isObj(v.runner) ? v.runner : {}) };
  if (typeof runner.state !== 'string' || !runner.state) runner.state = 'idle';
  return {
    ...v,
    runner,
    batch: normalizeBatch(v.batch),
    batches: (Array.isArray(v.batches) ? v.batches : []).filter(isObj),
    settings: { ...DEFAULT_SETTINGS, ...(isObj(v.settings) ? v.settings : {}) },
    site: isObj(v.site) ? v.site : { connected: false },
    chatgpt: isObj(v.chatgpt) ? v.chatgpt : {},
    events: (Array.isArray(v.events) ? v.events : []).filter(isObj),
  };
}

/* ───────── связь с service worker ───────── */

async function api(type, fields, { silent = false } = {}) {
  let res = null;
  try {
    res = await chrome.runtime.sendMessage({ rps: 1, type, ...fields });
    if (chrome.runtime.lastError) res = null;
  } catch (error) {
    res = null;
  }
  if (!isObj(res)) res = { ok: false, error: { code: 'NO_RESPONSE', message: t('err.generic') } };
  else if (res.ok !== true) {
    const e = isObj(res.error) ? res.error : {};
    res = { ...res, ok: false, error: { code: e.code || 'ERROR', message: e.message || t('err.generic') } };
  }
  if (!res.ok && !silent) toast(res.error.message, 'error', res.error.code);
  return res;
}

const pickView = (res) => (isObj(res.view) ? res.view : isObj(res.runner) ? res : null);

function toast(message, kind = 'info', code) {
  const box = byId('toast');
  clearTimeout(ui.toastTimer);
  const close = el('button', { type: 'button', class: 'toast-close', 'aria-label': t('toast.close') });
  close.addEventListener('click', clearToast);
  box.className = `toast toast-${kind}`;
  if (code) box.dataset.code = code;
  else delete box.dataset.code;
  fill(box, el('span', { class: 'toast-text', text: message }), close);
  ui.toastTimer = setTimeout(clearToast, kind === 'error' ? 12000 : 5000);
}

function clearToast() {
  const box = byId('toast');
  clearTimeout(ui.toastTimer);
  box.className = 'toast';
  delete box.dataset.code;
  box.replaceChildren();
}

function applyView(raw) {
  if (!isObj(raw)) return;
  ui.offline = false;
  byId('worker-offline').hidden = true;
  const sig = JSON.stringify(raw);
  if (sig === ui.sig) return;
  ui.sig = sig;
  ui.rev += 1;
  ui.view = normalizeView(raw);
  renderAll();
}

async function refreshView() {
  if (ui.refreshing) {
    ui.refreshAgain = true;
    return;
  }
  ui.refreshing = true;
  try {
    const res = await api('GET_VIEW', {}, { silent: true });
    const view = res.ok ? pickView(res) : null;
    if (view) {
      applyView(view);
      maybeLoadPresets(ui.view);
    } else {
      ui.offline = true;
      byId('worker-offline').hidden = false;
    }
  } finally {
    ui.refreshing = false;
    if (ui.refreshAgain) {
      ui.refreshAgain = false;
      refreshView();
    }
  }
}

/** Состояние из ответа команды; если за время запроса уже пришёл более новый view, ответ не применяем. */
async function adopt(res, rev) {
  if (ui.rev !== rev) return;
  const view = pickView(res);
  if (view) applyView(view);
  else await refreshView();
}

function connectPort() {
  let port = null;
  try {
    port = chrome.runtime.connect({ name: 'rps-panel' });
  } catch (error) {
    port = null;
  }
  ui.port = port;
  if (!port) {
    ui.portFailures += 1;
    scheduleReconnect();
    return;
  }
  let gotView = false;
  const connectedAt = Date.now();
  port.onMessage.addListener((msg) => {
    if (!isObj(msg)) return;
    if (msg.type === 'VIEW' && isObj(msg.view)) {
      gotView = true;
      ui.portFailures = 0;
      applyView(msg.view);
    } else if (msg.type === 'SITE_PROGRESS' && ui.creating) {
      ui.siteProgress = { done: num(msg.done), total: num(msg.total) };
      renderPending();
    }
  });
  port.onDisconnect.addListener(() => {
    void (chrome.runtime && chrome.runtime.lastError);
    ui.port = null;
    ui.portFailures = gotView || Date.now() - connectedAt > 3000 ? 0 : ui.portFailures + 1;
    scheduleReconnect();
  });
}

// После выгрузки service worker порт рвётся: переподключаемся и сразу запрашиваем состояние.
function scheduleReconnect() {
  const delay = Math.min(10000, RECONNECT_MS * 2 ** Math.max(0, ui.portFailures - 1));
  setTimeout(() => {
    connectPort();
    refreshView();
  }, delay);
}

/* ───────── рендер: общий ───────── */

function renderAll() {
  const view = ui.view;
  renderHeader(view);
  renderQueue(view);
  renderSettings(view.settings);
  renderLog();
  renderAbout();
  maybeLoadPresets(view);
  syncClock();
}

function setChip(node, tone, state, text) {
  node.dataset.tone = tone;
  node.dataset.state = state;
  setText(node, text);
}

function renderHeader(view) {
  const { site, chatgpt } = view;
  if (site.checking && !site.connected) setChip(byId('site-status'), 'warn', 'checking', t('site.unknown'));
  else if (site.connected) {
    setChip(byId('site-status'), 'ok', 'connected', site.engine ? t('site.connected', { engine: site.engine }) : t('site.connectedNoEngine'));
  } else if (site.code === 'NO_BRIDGE') setChip(byId('site-status'), 'warn', 'no-bridge', t('site.noBridge'));
  else if (site.code === 'BRIDGE_VERSION') setChip(byId('site-status'), 'warn', 'bridge-version', t('site.bridgeVersion'));
  else if (site.tabFound) setChip(byId('site-status'), 'warn', 'error', t('site.error'));
  else setChip(byId('site-status'), 'warn', 'missing', t('site.missing'));
  byId('site-status').title = site.connected || !site.reason ? '' : String(site.reason);

  if (chatgpt.tabFound && chatgpt.ready !== false) setChip(byId('chatgpt-status'), 'ok', 'ready', t('chatgpt.ready'));
  else if (chatgpt.tabFound) setChip(byId('chatgpt-status'), 'warn', 'not-ready', t('chatgpt.notReady'));
  else setChip(byId('chatgpt-status'), 'warn', 'missing', t('chatgpt.missing'));
}

const DIAG_MARK = { ok: '✓', bad: '✕', info: '–', unknown: '?' };

function diagItemState(item) {
  if (typeof item.state === 'string' && item.state in DIAG_MARK) return item.state;
  return item.found === true ? 'ok' : 'bad';
}

function diagStateText(item, state) {
  if (item.role === 'alarm') return item.found === true ? t('diag.alarmBad') : t('diag.alarmOk');
  if (state === 'unknown') return t('diag.unknown');
  if (state === 'info') return t('diag.info');
  return item.found === true ? t('diag.found') : t('diag.missing');
}

function renderDiagnose(report) {
  const box = byId('diagnose-report');
  if (!report) {
    box.hidden = true;
    box.replaceChildren();
    return;
  }
  const items = Array.isArray(report.items) ? report.items.filter(isObj) : [];
  const notes = Array.isArray(report.notes) ? report.notes.map(String) : [];
  const states = items.map(diagItemState);
  const ok = report.ok === true;
  const headText = ok ? t('diag.ok') : states.includes('bad') ? t('diag.fail') : t('diag.partial');
  const close = el('button', { type: 'button', class: 'btn btn-sm', text: t('diag.close') });
  close.addEventListener('click', () => renderDiagnose(null));
  fill(box,
    el('div', { class: 'diag-head' }, [el('span', { text: headText }), close]),
    items.length
      ? el('ul', { class: 'diag-list' }, items.map((item, i) => el('li', { class: 'diag-item', dataset: { found: String(item.found === true), state: states[i] } }, spaced(
        el('span', { class: 'diag-mark', 'aria-hidden': 'true', text: DIAG_MARK[states[i]] }),
        el('span', { class: 'diag-name', text: String(item.label ?? item.name ?? '') }),
        el('span', { class: 'diag-state', text: diagStateText(item, states[i]) }),
        item.count !== undefined && item.count !== null && item.role !== 'alarm' ? el('span', { class: 'muted', text: `(${t('diag.count', { count: item.count })})` }) : null,
        item.selector ? el('code', { text: String(item.selector) }) : null,
        item.note ? el('span', { class: 'muted', text: String(item.note) }) : null,
      ))))
      : el('p', { class: 'muted', text: t('diag.empty') }),
    notes.length ? el('p', { class: 'muted', text: t('diag.notes') }) : null,
    notes.length ? el('ul', { class: 'diag-notes' }, notes.map((n) => el('li', { text: n }))) : null);
  box.hidden = false;
}

/* ───────── рендер: очередь ───────── */

function renderQueue(view) {
  renderBatchCard(view);
  renderProgress(view);
  renderControls(view);
  renderCharacters(view.batch);
  renderBatchList(view);
  renderFormState(view);
}

function renderBatchCard(view) {
  const b = view.batch;
  if (!changed('card', b && [b.batch_id, b.kind, b.status, b.folder, b.totals])) return;
  const host = byId('batch-card');
  if (!b) {
    fill(host, el('p', { class: 'muted', text: t('batch.none') }));
    return;
  }
  const x = b.totals;
  const rows = [
    ['batch.id', el('code', { text: String(b.batch_id) })],
    ['batch.kind', label('batch.kind.', b.kind)],
    ['batch.status', label('batch.status.', b.status)],
    ['batch.folder', b.folder || '—'],
    ['batch.totals', t('batch.totalsValue', { total: x.total, completed: x.completed, failed: x.failed, pending: x.pending, active: x.active + x.retryable })],
  ];
  fill(host, el('dl', { class: 'kv' }, rows.flatMap(([k, v]) => [el('dt', { text: t(k) }), el('dd', {}, [v])])));
}

/** Остаток работы в партии: из view.batch либо из плоской строки view.batches. */
function remainingOf(view, batchId) {
  const b = view.batch;
  if (b && b.batch_id === batchId) return b.totals.pending + b.totals.active + b.totals.retryable;
  const row = view.batches.find((x) => x.batch_id === batchId);
  if (!row) return 0;
  const x = isObj(row.totals) ? row.totals : row;
  return Math.max(0, num(x.total) - num(x.completed) - num(x.failed));
}

const runnerHasWork = (view) => remainingOf(view, view.runner.batch_id) > 0;

function stateLabel(view) {
  const st = view.runner.state;
  return st === 'completed' && runnerHasWork(view) ? t('state.completedJob') : label('state.', st);
}

function phaseText(view) {
  const st = view.runner.state;
  if (st === 'completed') return t(runnerHasWork(view) ? 'phase.completedJob' : 'phase.completed');
  return label('phase.', st);
}

/** Текущее задание в виде { ci, ji }: по image_job_id, иначе по ID вида <batch>-C002-F003. */
function locateJob(view) {
  const { runner, batch } = view;
  if (!batch || !runner.job_id || (runner.batch_id && runner.batch_id !== batch.batch_id)) return null;
  const id = String(runner.job_id);
  for (let ci = 0; ci < batch.characters.length; ci += 1) {
    const ji = batch.characters[ci].jobs.findIndex((j) => j.image_job_id === id);
    if (ji >= 0) return { ci, ji };
  }
  const m = /-F(\d+)$/.exec(id);
  if (!m) return null;
  const ci = batch.characters.findIndex((c) => String(c.character_id) === id.slice(0, m.index));
  if (ci < 0) return null;
  const ji = batch.characters[ci].jobs.findIndex((j, i) => num(j.index, i + 1) === Number(m[1]));
  return ji >= 0 ? { ci, ji } : null;
}

const jobNo = (job, ji) => num(job.index, ji + 1);

function currentOp(view, now) {
  const { runner, batch } = view;
  const st = runner.state;
  if (st === 'idle' && !batch) return t('op.noBatch');
  const finished = st === 'completed' && !runnerHasWork(view);
  const loc = st === 'idle' || finished ? null : locateJob(view);
  let head = phaseText(view);
  if (loc) {
    const c = batch.characters[loc.ci];
    head = `${t('op.position', { c: c.index, n: batch.characters.length, f: jobNo(c.jobs[loc.ji], loc.ji) })} — ${head}`;
  } else head = cap(head);
  const started = toMs(runner.phase_started_at);
  if (ACTIVE.has(st) && started) head += ` (${fmtElapsed(now - started)})`;
  const parts = [head];
  if (!QUIET.has(st)) {
    const next = toMs(runner.next_allowed_at);
    const retry = toMs(runner.retry_at);
    if (next > now && runnerHasWork(view)) parts.push(t('op.next', { time: fmtCountdown(next - now) }));
    if (st === 'retryable_error' && retry > now) parts.push(t('op.retry', { time: fmtCountdown(retry - now) }));
  }
  return parts.join('. ');
}

function renderRunnerNote(runner) {
  const note = byId('runner-note');
  let text = '';
  if (runner.halted && !runner.block) {
    const reason = typeof runner.halted === 'string' ? runner.halted : '';
    const key = `runner.halted.${reason}`;
    text = !reason ? t('runner.halted.generic') : t(key) !== key ? t(key) : t('runner.halted.other', { reason });
  }
  note.hidden = !text;
  setText(note, text);
}

function renderBlock(block) {
  const box = byId('block-message');
  if (!changed('block', block)) return;
  if (!isObj(block)) {
    box.hidden = true;
    box.replaceChildren();
    return;
  }
  const code = String(block.code || '');
  const hintKey = `block.hint.${code}`;
  fill(box,
    el('p', {}, [el('strong', { text: String(block.message || t(t(hintKey) === hintKey ? 'block.hint.default' : hintKey)) })]),
    code ? el('p', { class: 'code', text: t('block.code', { code }) }) : null);
  box.hidden = false;
}

function renderProgress(view) {
  const { runner, batch } = view;
  const x = batch ? batch.totals : ZERO_TOTALS;
  const chip = byId('runner-state');
  chip.dataset.state = runner.state;
  chip.dataset.tone = TONE[runner.state] || 'neutral';
  setText(chip, stateLabel(view));
  setText(byId('current-op'), currentOp(view, Date.now()));
  renderRunnerNote(runner);
  renderBlock(runner.block);
  const bar = byId('overall-progress');
  bar.max = Math.max(1, x.total);
  bar.value = Math.min(x.completed, bar.max);
  setText(byId('count-done'), String(x.completed));
  setText(byId('count-failed'), String(x.failed));
  setText(byId('count-pending'), String(x.pending));
  setText(byId('count-active'), String(x.active + x.retryable));
}

/** Какие кнопки доступны: автомат состояний (контракт §4) плюс правила, которые проверяет worker. */
function controlFlags(view, now) {
  const { runner, batch } = view;
  const st = runner.state;
  const x = batch ? batch.totals : ZERO_TOTALS;
  const startable = x.pending + x.active + x.retryable > 0;
  const midInterval = BETWEEN_JOBS.has(st) && toMs(runner.next_allowed_at) > now && runnerHasWork(view);
  return {
    start: STARTABLE.has(st) && !!batch && startable && !midInterval,
    pause: PAUSABLE.has(st) || midInterval,
    resume: RESUMABLE.has(st) || (st === 'idle' && !!runner.halted && !!runner.batch_id),
    stop: st !== 'idle',
    retry: !!batch && x.failed > 0 && RETRYABLE.has(st),
    emergency: st !== 'idle',
  };
}

function renderControls(view = ui.view) {
  const { runner } = view;
  if (!PAUSABLE.has(runner.state) && !BETWEEN_JOBS.has(runner.state)) ui.pausing = false;
  const f = controlFlags(view, Date.now());
  const pausing = (runner.pause_requested === true || ui.pausing) && f.pause;
  const lock = ui.busy;
  setDisabled('btn-start', lock || !f.start);
  setDisabled('btn-pause', lock || !f.pause || pausing);
  setDisabled('btn-resume', lock || !f.resume);
  setDisabled('btn-stop', lock || !f.stop);
  setDisabled('btn-retry-failed', lock || !f.retry);
  setDisabled('btn-emergency-stop', !f.emergency); // аварийная остановка не ждёт других команд
  const hint = byId('pause-hint');
  hint.hidden = !pausing;
  setText(hint, pausing ? t('pause.requested') : '');
}

/* ───────── рендер: персонажи и кадры ───────── */

function frameTitle(job, n) {
  const status = job.status || 'pending';
  return [
    t('frame.title', { n, status }),
    job.file ? t('frame.file', { file: job.file }) : null,
    t('frame.attempts', { n: num(job.attempts) }),
    job.error_code ? t('frame.error', { code: job.error_code }) : null,
    status === 'completed' && job.file ? t('frame.open') : null,
  ].filter(Boolean).join('; ');
}

function patchFrame(cell, job, ji) {
  const status = job.status || 'pending';
  const n = jobNo(job, ji);
  if (cell.dataset.status !== status) cell.dataset.status = status;
  if (cell.dataset.jobIndex !== String(n)) cell.dataset.jobIndex = String(n);
  const title = frameTitle(job, n);
  if (cell.title !== title) {
    cell.title = title;
    cell.setAttribute('aria-label', title);
  }
  const open = status === 'completed';
  const role = open ? 'button' : 'img';
  if (cell.getAttribute('role') !== role) {
    cell.setAttribute('role', role);
    if (open) cell.tabIndex = 0;
    else cell.removeAttribute('tabindex');
  }
  if (job.image_job_id) cell.dataset.jobId = String(job.image_job_id);
  else delete cell.dataset.jobId;
}

function buildCharacter(c) {
  return el('div', { class: 'character', dataset: { characterIndex: c.index, characterId: c.character_id } }, [
    el('div', { class: 'character-head' }, spaced(
      el('h3', { class: 'character-title', text: t('character.title', { n: c.index }) }),
      el('span', { class: 'character-name' }),
      el('span', { class: 'character-count' }, [el('span', { class: 'cc-main' }), el('span', { class: 'character-failed' })]),
    )),
    el('progress', { value: 0, max: 1, 'aria-label': t('progress.character', { n: c.index }) }),
    el('div', { class: 'frames' }, c.jobs.map(() => el('span', { class: 'frame' }))),
  ]);
}

function patchCharacter(node, c) {
  const total = num(c.total, c.jobs.length);
  const bar = node.querySelector('progress');
  const max = Math.max(1, total);
  if (bar.max !== max) bar.max = max;
  if (bar.value !== c.completed) bar.value = c.completed;
  const name = node.querySelector('.character-name');
  // Имя по умолчанию («Персонаж 1») совпадает с заголовком карточки — второй раз его не показываем.
  const own = c.name ? String(c.name).trim() : '';
  const showName = own !== '' && own !== t('character.title', { n: c.index });
  name.hidden = !showName;
  setText(name, showName ? own : '');
  setText(node.querySelector('.cc-main'), t('character.counts', { completed: c.completed, total }));
  const failed = node.querySelector('.character-failed');
  failed.hidden = !c.failed;
  setText(failed, c.failed ? ` · ${t('character.failed', { n: c.failed })}` : '');
  const cells = node.querySelector('.frames').children;
  c.jobs.forEach((job, ji) => patchFrame(cells[ji], job, ji));
}

// Структура меняется редко (другая партия): обычные обновления только правят атрибуты кадров на месте.
function renderCharacters(batch) {
  const host = byId('character-list');
  if (!batch || !batch.characters.length) {
    ui.charKey = '';
    host.replaceChildren();
    return;
  }
  const key = [batch.batch_id, ...batch.characters.map((c) => `${c.character_id ?? ''}:${c.index}:${c.jobs.length}`)].join('|');
  if (key !== ui.charKey) {
    ui.charKey = key;
    fill(host, batch.characters.map(buildCharacter));
  }
  batch.characters.forEach((c, i) => patchCharacter(host.children[i], c));
}

function onFrameActivate(cell) {
  if (cell.dataset.status !== 'completed') return;
  let id = cell.dataset.jobId;
  if (!id) {
    const characterId = cell.closest('.character')?.dataset.characterId;
    id = characterId ? `${characterId}-F${String(cell.dataset.jobIndex).padStart(3, '0')}` : '';
  }
  if (id) return api('SHOW_FILE', { image_job_id: id });
}

/* ───────── рендер: предыдущие партии ───────── */

function batchRow(b, selected, runner) {
  const id = String(b.batch_id);
  const x = isObj(b.totals) ? b.totals : b;
  const current = id === selected;
  const running = runner.batch_id === id && !['idle', 'completed'].includes(runner.state); // так же решает worker
  return el('li', { class: 'batch-row', dataset: { batchId: id }, 'aria-current': current ? 'true' : null }, [
    el('div', { class: 'batch-id', text: id }),
    el('div', { class: 'batch-meta', text: [label('batch.kind.', b.kind), label('batch.status.', b.status), t('prev.counts', { completed: num(x.completed), total: num(x.total), failed: num(x.failed) })].join(' · ') }),
    el('div', { class: 'row-actions' }, [
      el('button', { type: 'button', class: 'btn btn-sm', 'data-act': 'select', 'data-testid': 'btn-select-batch', disabled: current, text: current ? t('prev.selected') : t('prev.select') }),
      el('button', { type: 'button', class: 'btn btn-sm', 'data-act': 'delete', 'data-testid': 'btn-delete-batch', disabled: running, title: running ? t('prev.deleteBusy') : null, text: t('prev.delete') }),
    ]),
  ]);
}

function renderBatchList(view) {
  const { batches, batch, runner } = view;
  const selected = batch ? batch.batch_id : null;
  const runningId = ['idle', 'completed'].includes(runner.state) ? null : runner.batch_id;
  if (!changed('batches', [batches, selected, runningId])) return;
  fill(byId('batch-list'), batches.map((b) => batchRow(b, selected, runner)));
  byId('batch-list-empty').hidden = batches.length > 0;
}

/* ───────── форма новой партии ───────── */

const currentMode = () => (document.querySelector('input[name="mode"]:checked') || { value: 'single' }).value;

function toInt(value) {
  const s = String(value).trim();
  return /^\d+$/.test(s) ? Number(s) : NaN;
}

function limits() {
  const { settings, site } = ui.view;
  const lim = isObj(site.limits) ? site.limits : {};
  return {
    maxChars: Math.min(50, num(lim.maxCharacters, 50)),
    maxFrames: Math.min(100, num(lim.maxFrames, 100)),
    maxTotal: Math.min(num(settings.maxBatchJobs, 1500), num(lim.maxTotalJobs, Infinity)),
    confirm: num(settings.confirmThreshold, 50),
  };
}

function readForm() {
  const mode = currentMode();
  const lim = limits();
  const errors = {};
  const characters = mode === 'multi' ? toInt(byId('input-characters').value) : 1;
  const frames = toInt(byId('input-frames').value);
  if (mode === 'multi' && !(characters >= 2 && characters <= lim.maxChars)) errors.characters = t('err.range', { min: 2, max: lim.maxChars });
  if (!(frames >= 1 && frames <= lim.maxFrames)) errors.frames = t('err.range', { min: 1, max: lim.maxFrames });
  const seed = byId('input-seed').value.trim();
  if (seed && !SEED_RE.test(seed)) errors.seed = t('err.seed');
  return { mode, lim, errors, characters, frames, seed: seed || null, total: errors.characters || errors.frames ? null : characters * frames };
}

function setFieldError(id, message) {
  const input = byId(id);
  const box = byId(`err-${id.replace(/^input-/, '')}`);
  if (message) input.setAttribute('aria-invalid', 'true');
  else input.removeAttribute('aria-invalid');
  setText(box, message || '');
}

function updateForm() {
  const f = readForm();
  setFieldError('input-characters', f.errors.characters);
  setFieldError('input-frames', f.errors.frames);
  setFieldError('input-seed', f.errors.seed);
  const line = byId('total-count');
  let level = 'ok';
  let text = t('total.ok', { n: f.total });
  if (f.total === null) text = t('total.unknown');
  else if (f.total > f.lim.maxTotal) {
    level = 'error';
    text = t('total.error', { n: f.total, max: f.lim.maxTotal });
  } else if (f.total > f.lim.confirm) {
    level = 'warn';
    text = t('total.warn', { n: f.total });
  }
  line.dataset.level = level;
  setText(line, text);
  setDisabled('btn-create-batch', ui.creating || level === 'error' || f.total === null || !!f.errors.seed);
  setDisabled('btn-test-job', ui.creating || !!f.errors.seed);
  setDisabled('btn-import-test', ui.creating);
  const { site } = ui.view;
  byId('site-hint').hidden = f.mode === 'import' || !!site.connected;
  const hintBase = site.code === 'NO_BRIDGE' ? t('create.siteHintNoBridge') : t('create.siteHint');
  setText(byId('site-hint'), site.reason && site.code !== 'NO_BRIDGE' ? `${hintBase} ${site.reason}` : hintBase);
  document.querySelectorAll('.chip-btn').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.frames === byId('input-frames').value.trim())));
}

function fillSelect(select, options, fallback) {
  const prev = select.value;
  fill(select, options.map((o) => el('option', { value: o.value, text: o.label, title: o.title })));
  const values = options.map((o) => o.value);
  select.value = values.includes(prev) ? prev : values.includes(fallback) ? fallback : values[0] ?? '';
}

function profileOptions(site) {
  const list = Array.isArray(site.profiles) && site.profiles.length ? site.profiles : DEFAULT_PROFILES;
  return list
    .map((p) => (isObj(p) ? { value: String(p.id ?? p.value ?? p.name ?? ''), label: String(p.name ?? p.label ?? p.id ?? '') } : { value: String(p), label: String(p) }))
    .filter((o) => o.value);
}

function renderFormState(view) {
  const sc = !!view.site.site_character;
  byId('field-site-character').hidden = !sc;
  if (!sc) byId('check-site-character').checked = false;
  const options = profileOptions(view.site);
  if (changed('profiles', options)) fillSelect(byId('select-profile'), options, 'gpt-image');
  const lim = limits();
  byId('input-characters').max = String(lim.maxChars);
  byId('input-frames').max = String(lim.maxFrames);
  updateForm();
}

function fillPresets(list) {
  const options = [{ value: '', label: t('preset.current') }].concat(
    list.filter(isObj).filter((p) => p.id).map((p) => ({
      value: String(p.id),
      label: p.builtin === false ? t('preset.user', { name: p.name || p.id }) : String(p.name || p.id),
      title: p.description ? String(p.description) : null,
    })));
  fillSelect(byId('select-preset'), options, '');
}

async function loadPresets() {
  const res = await api('SITE_LIST_PRESETS', {}, { silent: true });
  if (res.ok && Array.isArray(res.presets)) fillPresets(res.presets);
  else {
    ui.presetsKey = '';
    ui.presetsRetryAt = Date.now() + 10000;
  }
}

function maybeLoadPresets(view) {
  const { site } = view;
  const key = site.connected ? `${site.tabId ?? ''}|${site.engine ?? ''}` : '';
  if (!key) {
    ui.presetsKey = '';
    return;
  }
  if (key === ui.presetsKey || Date.now() < ui.presetsRetryAt) return;
  ui.presetsKey = key;
  loadPresets();
}

function onModeChange() {
  const mode = currentMode();
  byId('form-generate').hidden = mode === 'import';
  byId('form-import').hidden = mode !== 'import';
  byId('field-characters').hidden = mode !== 'multi';
  updateForm();
}

function renderPending() {
  const p = ui.siteProgress;
  const known = ui.creating && p && p.total > 0;
  const bar = byId('create-pending').querySelector('progress');
  if (known) {
    bar.max = p.total;
    bar.value = Math.min(p.done, p.total);
  } else {
    bar.removeAttribute('value');
    bar.removeAttribute('max');
  }
  setText(byId('create-pending-text'), known ? t('create.progress', { done: p.done, total: p.total }) : t('create.pending'));
}

function setCreating(on) {
  ui.creating = on;
  ui.siteProgress = null;
  byId('create-pending').hidden = !on;
  renderPending();
  updateForm();
}

function renderSummary(s) {
  const box = byId('batch-summary');
  if (!isObj(s)) {
    box.replaceChildren();
    return;
  }
  const v = (x) => (x === undefined || x === null ? '—' : x);
  fill(box,
    t('summary.line', { id: v(s.batch_id), characters: v(s.characters), frames: v(s.frames), total: v(s.total), folder: v(s.folder) }),
    s.existed ? el('span', { class: 'existed', text: t('summary.existed') }) : null);
}

async function submitBatch(type, fields) {
  if (ui.creating) return;
  setCreating(true);
  const res = await api(type, fields);
  setCreating(false);
  if (!res.ok) {
    renderSummary(null);
    return;
  }
  renderSummary(isObj(res.summary) ? res.summary : res.batch_id ? res : null);
  await refreshView();
}

function createBatch(test) {
  const f = readForm();
  if (f.errors.seed || (!test && (f.errors.frames || f.errors.characters))) {
    updateForm();
    return;
  }
  const params = {
    mode: test ? 'single' : f.mode,
    characters: test ? 1 : f.characters,
    frames_per_character: test ? 1 : f.frames,
    strategy: byId('select-strategy').value,
    preset_id: byId('select-preset').value || null,
    seed: f.seed,
    profile: byId('select-profile').value || 'gpt-image',
    length: byId('select-length').value || 'standard',
    include_negative: true,
    use_site_character: Boolean(ui.view.site.site_character && byId('check-site-character').checked),
  };
  return submitBatch('SITE_CREATE_BATCH', test ? { params, test: true } : { params });
}

/* ───────── импорт файла ───────── */

function readText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file, 'utf-8');
  });
}

const fileNameOf = (file) => file.name.slice(-200); // worker принимает имя до 200 символов

function renderImportInfo() {
  const f = ui.importFile;
  setText(byId('import-file-info'), f ? t('import.selected', { name: f.name, size: fmtBytes(f.size) }) : t('import.none'));
}

async function onImportFile(event) {
  const input = event.target;
  const file = input.files && input.files[0];
  if (!file) return;
  ui.importFile = null;
  renderImportInfo();
  try {
    if (file.size > MAX_IMPORT_BYTES) {
      toast(t('err.fileTooLarge', { mb: MAX_IMPORT_BYTES / 1048576 }), 'error');
      return;
    }
    let text;
    try {
      text = await readText(file);
    } catch (error) {
      toast(t('err.fileRead'), 'error');
      return;
    }
    ui.importFile = { name: fileNameOf(file), size: file.size, text };
    renderImportInfo();
    await submitBatch('IMPORT_BATCH', { text, fileName: fileNameOf(file) });
  } finally {
    input.value = ''; // чтобы тот же файл можно было выбрать повторно
  }
}

function onImportTest() {
  if (!ui.importFile) {
    toast(t('err.noFile'), 'error');
    return;
  }
  return submitBatch('IMPORT_BATCH', { text: ui.importFile.text, fileName: ui.importFile.name, test: true });
}

/* ───────── диалог подтверждения ───────── */

/** Модальный <dialog>: Esc и «Отмена» закрывают без действия. Возвращает null или { typedTotal }. */
function askConfirm(o) {
  const dlg = byId('confirm-dialog');
  if (dlg.open) return Promise.resolve(null);
  const check = byId('confirm-check');
  const typed = byId('confirm-typed-total');
  const ok = byId('confirm-ok');
  const cancel = byId('confirm-cancel');
  const opener = document.activeElement;
  setText(byId('confirm-title'), o.title);
  fill(byId('confirm-body'),
    (o.lines || []).map((line) => el('p', { text: line })),
    o.note ? el('p', { class: 'notice notice-error', text: o.note }) : null);
  byId('confirm-check-row').hidden = !o.checkLabel;
  setText(byId('confirm-check-label'), o.checkLabel || '');
  byId('confirm-total-row').hidden = o.requiredTotal === null || o.requiredTotal === undefined;
  setText(byId('confirm-total-label'), o.typedLabel || '');
  setText(ok, o.okLabel);
  check.checked = false;
  typed.value = '';
  const needTotal = !byId('confirm-total-row').hidden;
  const ready = () => (!o.checkLabel || check.checked) && (!needTotal || (/^\d+$/.test(typed.value.trim()) && Number(typed.value) === o.requiredTotal));
  const sync = () => { ok.disabled = !ready(); };
  sync();
  return new Promise((resolve) => {
    const ac = new AbortController();
    const { signal } = ac;
    let result = null;
    check.addEventListener('change', sync, { signal });
    typed.addEventListener('input', sync, { signal });
    byId('confirm-form').addEventListener('submit', (e) => {
      e.preventDefault();
      if (ok.disabled) return;
      result = { typedTotal: needTotal ? Number(typed.value) : null };
      dlg.close();
    }, { signal });
    cancel.addEventListener('click', () => dlg.close(), { signal });
    dlg.addEventListener('close', () => {
      ac.abort();
      if (opener && opener.isConnected && typeof opener.focus === 'function') opener.focus();
      resolve(result);
    }, { signal });
    dlg.showModal();
    (o.checkLabel ? check : cancel).focus();
  });
}

/* ───────── команды управления ───────── */

async function runControl(type, fields) {
  if (ui.busy) return null;
  ui.busy = true;
  renderControls();
  const rev = ui.rev;
  const res = await api(type, fields);
  ui.busy = false;
  if (res.ok) await adopt(res, rev);
  renderControls();
  return res;
}

async function onStart() {
  const { batch, settings } = ui.view;
  if (!batch || ui.busy) return;
  const total = batch.totals.total;
  const strong = total > num(settings.strongConfirmThreshold, 300);
  const confirm = { acknowledged: true };
  if (strong || total > num(settings.confirmThreshold, 50)) {
    const answer = await askConfirm({
      title: t('confirm.start.title'),
      lines: [t('confirm.start.count', { total }), t('confirm.start.folder', { folder: batch.folder || '—' })],
      note: total > num(settings.maxBatchJobs, 1500) ? t('confirm.start.tooLarge', { max: num(settings.maxBatchJobs, 1500) }) : '',
      checkLabel: t('confirm.start.check', { total }),
      requiredTotal: strong ? total : null,
      typedLabel: t('confirm.start.typed', { total }),
      okLabel: t('confirm.start.ok'),
    });
    if (!answer) return;
    if (strong) confirm.typed_total = answer.typedTotal;
  }
  await runControl('START', { batch_id: batch.batch_id, confirm });
}

async function onPause() {
  if (ui.busy) return;
  ui.pausing = true;
  const res = await runControl('PAUSE');
  if (!res || !res.ok) {
    ui.pausing = false;
    renderControls();
  }
}

async function onEmergency() {
  const rev = ui.rev;
  const res = await api('EMERGENCY_STOP');
  ui.pausing = false;
  if (res.ok) await adopt(res, rev);
  renderControls();
}

async function onDeleteBatch(id) {
  const answer = await askConfirm({ title: t('confirm.delete.title'), lines: [t('confirm.delete.body', { id })], okLabel: t('confirm.delete.ok') });
  if (answer) await runControl('DELETE_BATCH', { batch_id: id });
}

function saveTextFile(filename, mime, text) {
  const name = String(filename || 'rps-log.txt').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 150);
  const url = URL.createObjectURL(new Blob([text], { type: mime || 'text/plain' }));
  const link = el('a', { href: url, download: name, hidden: true });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  return name;
}

async function exportLog(format) {
  const { batch, runner } = ui.view;
  const batchId = batch ? batch.batch_id : runner.batch_id;
  if (!batchId) {
    toast(t('err.noBatch'), 'error');
    return;
  }
  const res = await api('EXPORT_LOG', { batch_id: batchId, format });
  if (!res.ok) return;
  const file = isObj(res.file) ? res.file : res;
  if (typeof file.text !== 'string') {
    toast(t('err.generic'), 'error');
    return;
  }
  toast(t('toast.exported', { name: saveTextFile(file.filename, file.mime, file.text) }), 'success');
}

async function onRefresh() {
  const res = await api('SITE_STATUS');
  if (res.ok) {
    const site = isObj(res.site) ? res.site : typeof res.connected === 'boolean' ? res : null;
    if (site) {
      ui.view = { ...ui.view, site: { ...ui.view.site, ...site } };
      renderHeader(ui.view);
      renderFormState(ui.view);
    }
  }
  await refreshView();
  ui.presetsKey = '';
  ui.presetsRetryAt = 0;
  maybeLoadPresets(ui.view);
}

async function onDiagnose() {
  const btn = byId('btn-diagnose');
  btn.disabled = true;
  fill(byId('diagnose-report'), el('p', { class: 'muted', text: t('diag.pending') }));
  byId('diagnose-report').hidden = false;
  const res = await api('DIAGNOSE_CHATGPT');
  btn.disabled = false;
  const report = isObj(res.report) ? res.report : res.ok && Array.isArray(res.items) ? res : null;
  renderDiagnose(res.ok ? report : null);
}

/* ───────── таймеры: секундомер и обратный отсчёт ───────── */

function needsClock(view, now) {
  const r = view.runner;
  if (ACTIVE.has(r.state) && toMs(r.phase_started_at)) return true;
  if (QUIET.has(r.state)) return false;
  return toMs(r.next_allowed_at) > now || toMs(r.retry_at) > now;
}

function syncClock() {
  const need = needsClock(ui.view, Date.now());
  if (need && !ui.clock) ui.clock = setInterval(tick, CLOCK_MS);
  else if (!need && ui.clock) {
    clearInterval(ui.clock);
    ui.clock = null;
  }
}

function tick() {
  setText(byId('current-op'), currentOp(ui.view, Date.now()));
  renderControls();
  syncClock();
}

/* ───────── настройки ───────── */

function validateFolder(v) {
  if (!v) return t('err.required');
  if (v.length > 200) return t('err.maxLen', { max: 200 });
  if (/[:*?"<>|\\\u0000-\u001f]/.test(v)) return t('err.folder.chars');
  if (v.startsWith('/')) return t('err.folder.abs');
  const parts = v.split('/');
  if (parts.some((p) => p === '.' || p === '..')) return t('err.folder.dots');
  if (parts.some((p) => !p.trim() || /[. ]$/.test(p))) return t('err.folder.segment');
  return '';
}

function validateChatUrl(v) {
  if (!v) return t('err.required');
  if (v.length > 300) return t('err.maxLen', { max: 300 });
  try {
    const u = new URL(v);
    const ok = u.protocol === 'https:' && u.hostname === 'chatgpt.com' && !u.username && !u.password && !u.port && v.startsWith('https://chatgpt.com/');
    return ok ? '' : t('err.url');
  } catch (error) {
    return t('err.url');
  }
}

function validateField(f, value) {
  if (f.type === 'number') {
    if (!Number.isFinite(value)) return t('err.required');
    if (!Number.isInteger(value)) return t('err.int');
    return value < f.min || value > f.max ? t('err.range', { min: f.min, max: f.max }) : '';
  }
  if (f.type === 'textarea') {
    if (value.length > f.maxLength) return t('err.maxLen', { max: f.maxLength });
    return /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value) ? t('err.control') : '';
  }
  return f.validate ? f.validate(value) : '';
}

function readControl(f) {
  const c = ui.sctl[f.key];
  if (f.type === 'checkbox') return c.checked;
  if (f.type === 'number') return c.value.trim() === '' ? NaN : Number(c.value);
  if (f.type === 'text' || f.type === 'url') return c.value.trim();
  return c.value;
}

function writeControl(f, value) {
  const c = ui.sctl[f.key];
  if (f.type === 'checkbox') c.checked = Boolean(value);
  else c.value = value === undefined || value === null ? '' : String(value);
  if (f.type === 'textarea') setText(byId(`counter-${f.key}`), t('settings.counter', { n: c.value.length, max: f.maxLength }));
}

function settingRow(f) {
  const id = `setting-${f.key}`;
  const common = { id, name: f.key, 'data-testid': id, 'aria-describedby': `hint-${f.key} err-${f.key}` };
  let control;
  if (f.type === 'select') control = el('select', common, f.options.map((v) => el('option', { value: v, text: t(`settings.${f.key}.${v}`) })));
  else if (f.type === 'textarea') control = el('textarea', { ...common, rows: 3, maxlength: f.maxLength, spellcheck: 'false' });
  else if (f.type === 'checkbox') control = el('input', { ...common, type: 'checkbox' });
  else if (f.type === 'number') control = el('input', { ...common, type: 'number', min: f.min, max: f.max, step: 1, inputmode: 'numeric' });
  else control = el('input', { ...common, type: f.type, autocomplete: 'off', spellcheck: 'false' });
  ui.sctl[f.key] = control;
  const hint = el('small', { class: 'hint', id: `hint-${f.key}`, text: t(`settings.hint.${f.key}`) });
  const error = el('small', { class: 'field-error', id: `err-${f.key}` });
  const counter = f.type === 'textarea' ? el('small', { class: 'hint counter-text', id: `counter-${f.key}` }) : null;
  if (f.type === 'checkbox') {
    return el('div', { class: 'field field-check' }, [
      el('label', { class: 'check' }, [control, el('span', { text: t(`settings.label.${f.key}`) })]), hint, error]);
  }
  return el('div', { class: 'field' }, [el('label', { for: id, text: t(`settings.label.${f.key}`) }), control, hint, counter, error]);
}

function buildSettingsForm() {
  const host = byId('settings-groups');
  for (const group of SETTINGS_GROUPS) {
    const box = el('fieldset', { class: 'group' }, [el('legend', { text: t(`settings.group.${group}`) })]);
    for (const f of SETTINGS_FIELDS.filter((x) => x.group === group)) box.append(settingRow(f));
    host.append(box);
  }
}

function setSettingError(key, message) {
  const c = ui.sctl[key];
  if (message) c.setAttribute('aria-invalid', 'true');
  else c.removeAttribute('aria-invalid');
  setText(byId(`err-${key}`), message || '');
}

/** Живая проверка полей; возвращает true, если форму можно сохранять. */
function validateSettingsForm() {
  const values = {};
  let valid = true;
  for (const f of SETTINGS_FIELDS) {
    values[f.key] = readControl(f);
    const message = validateField(f, values[f.key]);
    setSettingError(f.key, message);
    if (message) valid = false;
  }
  const { confirmThreshold: soft, strongConfirmThreshold: strong } = values;
  if (Number.isFinite(soft) && Number.isFinite(strong) && strong < soft && !byId('err-strongConfirmThreshold').textContent) {
    setSettingError('strongConfirmThreshold', t('err.strongLess'));
    valid = false;
  }
  setDisabled('btn-save-settings', !valid || ui.saving);
  byId('settings-invalid').hidden = valid;
  return valid;
}

function controlShows(f, value) {
  const c = ui.sctl[f.key];
  return f.type === 'checkbox' ? c.checked === Boolean(value) : c.value === String(value ?? '');
}

/** Подтягиваем настройки из worker, не трогая поле в фокусе и несохранённые правки пользователя. */
function renderSettings(settings) {
  for (const f of SETTINGS_FIELDS) {
    const prev = ui.settingsBase[f.key];
    ui.settingsBase[f.key] = settings[f.key];
    if (document.activeElement === ui.sctl[f.key]) continue;
    if (ui.dirty.has(f.key) && !controlShows(f, prev)) continue; // несохранённая правка пользователя
    ui.dirty.delete(f.key);
    if (!controlShows(f, settings[f.key])) writeControl(f, settings[f.key]);
  }
  validateSettingsForm();
}

async function saveSettings() {
  if (ui.saving || !validateSettingsForm()) return;
  const patch = {};
  for (const f of SETTINGS_FIELDS) {
    const value = readControl(f);
    if (ui.dirty.has(f.key) && value !== ui.settingsBase[f.key]) patch[f.key] = value;
  }
  if (!Object.keys(patch).length) {
    toast(t('settings.noChanges'));
    return;
  }
  ui.saving = true;
  validateSettingsForm();
  const res = await api('UPDATE_SETTINGS', { patch });
  ui.saving = false;
  if (!res.ok) {
    validateSettingsForm();
    return;
  }
  const saved = { ...ui.view.settings, ...patch, ...(isObj(res.settings) ? res.settings : {}) };
  // Поля, которые пользователь успел изменить во время запроса, остаются как есть.
  for (const f of SETTINGS_FIELDS) if (f.key in patch && readControl(f) === patch[f.key]) ui.dirty.delete(f.key);
  ui.view = { ...ui.view, settings: saved };
  ui.sig = '';
  renderSettings(saved);
  renderFormState(ui.view);
  renderAbout();
  toast(t('settings.saved'), 'success');
}

/* ───────── журнал и «О расширении» ───────── */

function sortEvents(events) {
  return events
    .map((e, i) => ({ e, i }))
    .sort((a, b) => (num(b.e.seq, NaN) - num(a.e.seq, NaN)) || (toMs(b.e.ts) - toMs(a.e.ts)) || (b.i - a.i))
    .map((x) => x.e);
}

function logRow(e) {
  const level = String(e.level || 'info');
  const ms = toMs(e.ts);
  return el('li', { class: 'log-row', dataset: { level } }, spaced(
    el('time', { class: 'log-time', datetime: ms ? new Date(ms).toISOString() : null, title: ms ? new Date(ms).toLocaleString('ru-RU') : null, text: fmtClock(e.ts) }),
    el('span', { class: 'log-level', text: level }),
    el('span', { class: 'log-msg' }, [
      e.code ? el('code', { class: 'log-code', text: String(e.code) }) : null,
      e.code ? ' ' : null,
      String(e.message ?? ''),
      e.job_id ? ' ' : null,
      e.job_id ? el('span', { class: 'log-job', text: t('log.job', { id: e.job_id }) }) : null,
    ]),
  ));
}

function renderLog() {
  const level = byId('log-filter').value;
  const all = sortEvents(ui.view.events);
  const rows = all.filter((e) => !level || e.level === level).slice(0, MAX_LOG_ROWS);
  if (!changed('log', [level, rows])) return;
  fill(byId('log-list'), rows.map(logRow));
  const empty = byId('log-empty');
  empty.hidden = rows.length > 0;
  setText(empty, all.length ? t('log.noMatch') : t('log.empty'));
}

function renderAbout() {
  const s = ui.view.settings;
  const params = { root: s.rootFolder, max: s.maxBatchJobs, confirm: s.confirmThreshold, strong: s.strongConfirmThreshold };
  if (!changed('about', params)) return;
  let version = '—';
  try {
    version = chrome.runtime.getManifest().version || version;
  } catch (error) {
    version = '—';
  }
  fill(byId('about-content'),
    ABOUT_SECTIONS.map((sec) => [
      el('h3', { text: t(sec.title) }),
      sec.text ? el('p', { text: t(sec.text, params) }) : null,
      sec.list ? el('ul', {}, sec.list.map((key) => el('li', { text: t(key, params) }))) : null,
    ]),
    el('p', { class: 'version', text: t('about.version', { version }) }));
}

/* ───────── вкладки, события, запуск ───────── */

function selectTab(name, focus = false) {
  ui.tab = name;
  document.querySelectorAll('[role="tab"]').forEach((tab) => {
    const on = tab.dataset.tab === name;
    tab.setAttribute('aria-selected', String(on));
    tab.tabIndex = on ? 0 : -1;
    if (on && focus) tab.focus();
  });
  document.querySelectorAll('[role="tabpanel"]').forEach((p) => { p.hidden = p.dataset.tab !== name; });
}

function applyI18n() {
  document.documentElement.lang = t('lang.code');
  document.title = t('app.title');
  document.querySelectorAll('[data-i18n]').forEach((n) => { n.textContent = t(n.dataset.i18n); });
  document.querySelectorAll('[data-i18n-placeholder]').forEach((n) => n.setAttribute('placeholder', t(n.dataset.i18nPlaceholder)));
  document.querySelectorAll('[data-i18n-aria-label]').forEach((n) => n.setAttribute('aria-label', t(n.dataset.i18nAriaLabel)));
  document.querySelectorAll('.chip-btn').forEach((b) => b.setAttribute('aria-label', t('quick.set', { n: b.dataset.frames })));
}

function fail(error) {
  console.error(error);
  toast(t('err.generic'), 'error');
}

/** Обработчик с общим перехватом ошибок; вызывается синхронно, чтобы работал preventDefault. */
function on(target, type, handler) {
  target.addEventListener(type, (event) => {
    try {
      const out = handler(event);
      if (out && typeof out.catch === 'function') out.catch(fail);
    } catch (error) {
      fail(error);
    }
  });
}

function bindEvents() {
  const tabs = Array.from(document.querySelectorAll('[role="tab"]'));
  tabs.forEach((tab, i) => {
    on(tab, 'click', () => selectTab(tab.dataset.tab));
    on(tab, 'keydown', (e) => {
      const to = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 }[e.key];
      if (to === undefined) return;
      e.preventDefault();
      selectTab(tabs[(to + tabs.length) % tabs.length].dataset.tab, true);
    });
  });

  on(byId('btn-refresh'), 'click', onRefresh);
  on(byId('btn-open-site'), 'click', () => api('OPEN_SITE'));
  on(byId('btn-open-chatgpt'), 'click', () => api('OPEN_CHATGPT'));
  on(byId('btn-diagnose'), 'click', onDiagnose);

  document.querySelectorAll('input[name="mode"]').forEach((r) => on(r, 'change', onModeChange));
  for (const id of ['input-characters', 'input-frames', 'input-seed']) on(byId(id), 'input', updateForm);
  document.querySelectorAll('.chip-btn').forEach((b) => on(b, 'click', () => {
    byId('input-frames').value = b.dataset.frames;
    updateForm();
  }));
  on(byId('btn-create-batch'), 'click', () => createBatch(false));
  on(byId('btn-test-job'), 'click', () => createBatch(true));
  on(byId('input-import-file'), 'change', onImportFile);
  on(byId('btn-import-test'), 'click', onImportTest);

  on(byId('btn-start'), 'click', onStart);
  on(byId('btn-pause'), 'click', onPause);
  on(byId('btn-resume'), 'click', () => runControl('RESUME'));
  on(byId('btn-stop'), 'click', () => runControl('STOP'));
  on(byId('btn-retry-failed'), 'click', () => ui.view.batch && runControl('RETRY_FAILED', { batch_id: ui.view.batch.batch_id }));
  on(byId('btn-emergency-stop'), 'click', onEmergency);
  on(byId('btn-export-log'), 'click', () => exportLog(byId('select-export-format').value));
  on(byId('btn-log-json'), 'click', () => exportLog('json'));
  on(byId('btn-log-csv'), 'click', () => exportLog('csv'));

  on(byId('character-list'), 'click', (e) => {
    const cell = e.target.closest && e.target.closest('.frame');
    return cell && onFrameActivate(cell);
  });
  on(byId('character-list'), 'keydown', (e) => {
    const cell = e.target.closest && e.target.closest('.frame');
    if (!cell || (e.key !== 'Enter' && e.key !== ' ')) return;
    e.preventDefault();
    return onFrameActivate(cell);
  });
  on(byId('batch-list'), 'click', (e) => {
    const button = e.target.closest && e.target.closest('button[data-act]');
    const id = button && button.closest('li').dataset.batchId;
    if (!id) return;
    return button.dataset.act === 'delete' ? onDeleteBatch(id) : runControl('SELECT_BATCH', { batch_id: id });
  });

  const edited = (e) => {
    if (e.target.name in ui.sctl) ui.dirty.add(e.target.name);
    validateSettingsForm();
  };
  on(byId('settings-form'), 'input', edited);
  on(byId('settings-form'), 'change', edited);
  on(byId('settings-form'), 'focusout', () => renderSettings(ui.view.settings)); // догоняем обновления, пришедшие пока поле было в фокусе
  on(byId('settings-form'), 'submit', (e) => {
    e.preventDefault();
    return saveSettings();
  });
  for (const f of SETTINGS_FIELDS.filter((x) => x.type === 'textarea')) {
    on(ui.sctl[f.key], 'input', () => writeCounter(f));
  }
  on(byId('log-filter'), 'change', renderLog);
}

function writeCounter(f) {
  setText(byId(`counter-${f.key}`), t('settings.counter', { n: ui.sctl[f.key].value.length, max: f.maxLength }));
}

function init() {
  applyI18n();
  buildSettingsForm();
  fillSelect(byId('select-profile'), profileOptions({}), 'gpt-image');
  bindEvents();
  selectTab('queue');
  renderImportInfo();
  onModeChange();
  renderAll();
  connectPort();
  refreshView();
  setInterval(refreshView, POLL_MS);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
