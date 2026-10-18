// Service worker (MV3): единственный владелец состояния очереди. Выгружаемый: всё состояние — в chrome.storage.local.
// Слушатели регистрируются синхронно на верхнем уровне; панель — лишь «окно» к состоянию.
import { ACTIVE_STATES } from '../lib/constants.js';
import { AdapterError, CommandError } from '../lib/errors.js';
import { cleanCreateParams, validatePanelMessage } from '../lib/messages.js';
import { Store } from '../lib/store.js';
import { parseBatch, parseImport } from '../lib/validate.js';
import { createChatPage, createDownloads, createImages, createSiteClient } from './adapters.js';
import { Orchestrator } from './orchestrator.js';

const SITE_ORIGIN = 'https://promts.vibecods.xyz';
const EXT_URL = chrome.runtime.getURL('');

const store = new Store(chrome.storage.local);
const chatPage = createChatPage();
const site = createSiteClient(SITE_ORIGIN);
const downloads = createDownloads();

function notify(kind, title, message) {
  chrome.notifications.create(`rps-${kind}-${Date.now()}`, { type: 'basic', iconUrl: chrome.runtime.getURL('icons/icon128.png'), title, message: String(message).slice(0, 250), priority: kind === 'blocked' || kind === 'failed' ? 2 : 0 }).catch?.(() => {});
}

const orch = new Orchestrator({
  store,
  now: () => Date.now(),
  setTimeout: (f, ms) => setTimeout(f, ms),
  clearTimeout: (h) => clearTimeout(h),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  page: chatPage,
  images: createImages(),
  downloads,
  notify,
});

const boot = orch.init({ reason: 'hydrate' }).catch((e) => console.error('[rps] init failed', e));
let woken = false;
async function wake() {
  await boot;
  if (woken) return;
  woken = true;
  if (ACTIVE_STATES.has(store.runner.state)) orch.kick();
}

// ───────── состояние для панели ─────────
let lastSite = { connected: false };
const ports = new Set();
let pushTimer = null;

async function view() {
  await boot;
  const chatgpt = await chatPage.status(store.runner.chat?.tabId ?? null).catch(() => ({ tabFound: false }));
  return orch.getView({ site: lastSite, chatgpt });
}

function schedulePush() {
  if (pushTimer !== null || ports.size === 0) return;
  pushTimer = setTimeout(async () => {
    pushTimer = null;
    const v = await view();
    for (const p of ports) {
      try {
        p.postMessage({ type: 'VIEW', view: v });
      } catch {
        ports.delete(p);
      }
    }
  }, 150);
}

let alarmOn = false;
let badge = '';
function syncSideEffects() {
  const state = store.runner.state;
  const active = ACTIVE_STATES.has(state);
  if (active && !alarmOn) {
    chrome.alarms.create('rps-watchdog', { periodInMinutes: 0.5 });
    alarmOn = true;
  } else if (!active && alarmOn) {
    chrome.alarms.clear('rps-watchdog');
    alarmOn = false;
  }
  const next = state === 'blocked' ? '!' : state === 'paused' ? 'II' : active && state !== 'completed' ? '▶' : '';
  if (next !== badge) {
    badge = next;
    chrome.action.setBadgeText({ text: next });
    chrome.action.setBadgeBackgroundColor({ color: state === 'blocked' ? '#c62828' : '#2e7d32' });
  }
}
store.onChange(() => {
  syncSideEffects();
  schedulePush();
});

// ───────── обработчики команд панели ─────────
const toError = (e) => ({ code: typeof e?.code === 'string' ? e.code : 'INTERNAL', message: String(e?.message ?? e).slice(0, 400) });
const viewResp = async () => ({ view: await view() });

async function siteStatus() {
  try {
    const { tab, res } = await site.call('hello');
    if (!res?.ok) throw new AdapterError(res?.error?.code ?? 'SITE_ERROR', res?.error?.message ?? 'Мост сайта не отвечает. Сайт нужно обновить (см. docs/04-SERVER-SETUP.md).');
    const p = res.payload ?? {};
    lastSite = { connected: true, tabId: tab.id, origin: SITE_ORIGIN, engine: String(p.engine ?? ''), bridge_version: p.bridge_version ?? null, limits: p.limits ?? null, site_character: p.site_character === true, profiles: Array.isArray(p.profiles) ? p.profiles : null, lengths: Array.isArray(p.lengths) ? p.lengths : null };
  } catch (e) {
    lastSite = { connected: false, reason: toError(e).message };
  }
  schedulePush();
  return lastSite;
}

async function addParsed(parsed, test) {
  if (!parsed.ok) throw new CommandError('BAD_BATCH', `Партия не прошла проверку: ${parsed.errors.slice(0, 3).join(' ')}`);
  return { summary: await orch.addBatch(parsed.batch, { kind: test ? 'test' : 'batch' }) };
}

const handlers = {
  GET_VIEW: viewResp,
  SITE_STATUS: async () => ({ site: await siteStatus() }),
  SITE_LIST_PRESETS: async () => {
    const { res } = await site.call('list-presets');
    if (!res?.ok) throw new CommandError(res?.error?.code ?? 'SITE_ERROR', res?.error?.message ?? 'Не удалось получить пресеты.');
    return { presets: (res.payload?.presets ?? []).slice(0, 80).map((p) => ({ id: String(p.id), name: String(p.name).slice(0, 80), description: String(p.description ?? '').slice(0, 200), builtin: p.builtin === true })) };
  },
  SITE_CREATE_BATCH: async (m) => {
    let params = cleanCreateParams(m.params);
    if (!params) throw new CommandError('BAD_PARAMS', 'Некорректные параметры партии.');
    if (m.test) params = { ...params, mode: 'single', characters: 1, frames_per_character: 1 };
    const { res } = await site.call('create-batch', params);
    if (!res?.ok) throw new CommandError(res?.error?.code ?? 'SITE_ERROR', res?.error?.message ?? 'Сайт не смог создать партию.');
    const parsed = await parseBatch(res.payload?.batch);
    if (parsed.ok && parsed.batch.source.origin !== SITE_ORIGIN) throw new CommandError('BAD_BATCH', 'Партия пришла не с ожидаемого сайта.');
    return addParsed(parsed, m.test === true);
  },
  IMPORT_BATCH: async (m) => addParsed(await parseImport(m.text, m.fileName, Date.now()), m.test === true),
  START: async (m) => (await boot, await orch.start(m.batch_id, m.confirm ?? {}), viewResp()),
  PAUSE: async () => (await orch.pause(), viewResp()),
  RESUME: async () => (await orch.resume(), viewResp()),
  STOP: async () => (await orch.stop(), viewResp()),
  EMERGENCY_STOP: async () => (await orch.emergencyStop(), viewResp()),
  RETRY_FAILED: async (m) => (await orch.retryFailed(m.batch_id), viewResp()),
  SELECT_BATCH: async (m) => (await orch.selectBatch(m.batch_id), viewResp()),
  DELETE_BATCH: async (m) => (await orch.deleteBatch(m.batch_id), viewResp()),
  UPDATE_SETTINGS: async (m) => ({ settings: await orch.updateSettings(m.patch) }),
  DIAGNOSE_CHATGPT: async () => ({ report: await chatPage.diagnose(store.runner.chat?.tabId ?? null) }),
  OPEN_CHATGPT: async () => (await chatPage.openOrFocus(), {}),
  OPEN_SITE: async () => (await site.openOrFocus(), {}),
  SHOW_FILE: async (m) => {
    const job = store.getJob(m.image_job_id);
    if (!job?.result?.download_id && job?.result?.download_id !== 0) throw new CommandError('NOT_FOUND', 'Файл ещё не сохранён.');
    downloads.show(job.result.download_id);
    return {};
  },
  GET_EVENTS: async (m) => ({ events: store.events(m.batch_id, m.limit ?? 100) }),
  EXPORT_LOG: async (m) => orch.exportLog(m.batch_id, m.format),
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  if (msg?.type === 'SITE_PROGRESS' && msg.rps === 1) {
    if (!sender.tab || !String(sender.url ?? '').startsWith(`${SITE_ORIGIN}/`)) return false;
    for (const p of ports) p.postMessage({ type: 'SITE_PROGRESS', done: Number(msg.done) || 0, total: Number(msg.total) || 0 });
    return false;
  }
  if (!String(sender.url ?? '').startsWith(EXT_URL)) return false;
  const v = validatePanelMessage(msg);
  if (!v.ok) {
    sendResponse({ ok: false, error: v.error });
    return false;
  }
  (async () => {
    await boot;
    await wake();
    return handlers[msg.type](msg);
  })()
    .then((data) => sendResponse({ ok: true, ...data }))
    .catch((e) => sendResponse({ ok: false, error: toError(e) }));
  return true;
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'rps-panel' || port.sender?.id !== chrome.runtime.id || !String(port.sender?.url ?? '').startsWith(EXT_URL)) {
    port.disconnect();
    return;
  }
  ports.add(port);
  port.onDisconnect.addListener(() => ports.delete(port));
  wake().then(schedulePush);
});

chrome.runtime.onStartup.addListener(async () => {
  await boot;
  woken = true;
  await orch.notifyRestart('browser-startup');
  chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true });
});

chrome.runtime.onInstalled.addListener(async (details) => {
  await boot;
  chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true });
  if (details.reason === 'update') {
    woken = true;
    await orch.notifyRestart('extension-update');
  }
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== 'rps-watchdog') return;
  await wake();
  orch.kick();
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  await wake();
  orch.onTabRemoved(tabId);
  schedulePush();
});
chrome.tabs.onUpdated.addListener((_id, info) => {
  if (info.status === 'complete' || info.url) schedulePush();
});
chrome.tabs.onActivated.addListener(() => schedulePush());

syncSideEffects();
