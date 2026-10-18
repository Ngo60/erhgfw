// Адаптеры к chrome.*: вкладка ChatGPT, загрузка изображений, downloads, клиент моста сайта. Протестированы в e2e (реальный Chrome).
import { LIMITS } from '../lib/constants.js';
import { AdapterError } from '../lib/errors.js';
import { isAllowedImageUrl, isChatGptUrl } from '../lib/validate.js';

const CHAT_MATCH = 'https://chatgpt.com/*';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function withTimeout(promise, ms, code, message) {
  let timer;
  return Promise.race([promise, new Promise((_, rej) => (timer = setTimeout(() => rej(new AdapterError(code, message)), ms)))]).finally(() => clearTimeout(timer));
}

function mapTabError(e) {
  if (e instanceof AdapterError) return e;
  const m = String(e?.message ?? e);
  if (/No tab with id|tab was closed|Cannot access|The tab was closed|Frame with ID/i.test(m)) return new AdapterError('TAB_CLOSED', 'Вкладка ChatGPT закрыта или недоступна.');
  if (/Receiving end does not exist|message port closed|Could not establish connection/i.test(m)) return new AdapterError('NETWORK', 'Страница ChatGPT перезагрузилась или не отвечает; жду восстановления.');
  return new AdapterError('INTERNAL', m.slice(0, 200));
}

// ───────── вкладка ChatGPT ─────────
export function createChatPage() {
  async function findTab(preferredId) {
    const tabs = await chrome.tabs.query({ url: CHAT_MATCH });
    return tabs.find((t) => t.id === preferredId) ?? tabs.find((t) => t.active) ?? tabs[0] ?? null;
  }

  async function ensureInjected(tabId) {
    for (let i = 0; i < 3; i++) {
      try {
        const r = await chrome.tabs.sendMessage(tabId, { rps: 1, type: 'CS_PING' });
        if (r?.ok) return r;
      } catch {
        // скрипта нет — внедряем
      }
      try {
        await chrome.scripting.executeScript({ target: { tabId }, files: ['content/chatgpt.js'] });
      } catch (e) {
        if (/No tab/i.test(String(e?.message))) throw new AdapterError('TAB_CLOSED', 'Вкладка ChatGPT закрыта.');
      }
      await sleep(400);
    }
    throw new AdapterError('UI_CHANGED', 'Не удалось подключиться к вкладке ChatGPT (content script не отвечает).');
  }

  async function send(tabId, msg, timeoutMs = 30000) {
    let res;
    try {
      res = await withTimeout(chrome.tabs.sendMessage(tabId, { rps: 1, ...msg }), timeoutMs, 'NETWORK', 'Вкладка ChatGPT не ответила вовремя.');
    } catch (e) {
      throw mapTabError(e);
    }
    if (!res) throw new AdapterError('UI_CHANGED', 'Вкладка ChatGPT не вернула ответ.');
    if (res.ok === false) throw new AdapterError(res.error?.code ?? 'INTERNAL', res.error?.message ?? 'Ошибка страницы ChatGPT');
    return res;
  }

  return {
    async ensureTab(preferredId) {
      const tab = await findTab(preferredId);
      if (!tab) throw new AdapterError('TAB_NOT_FOUND', 'Вкладка ChatGPT не найдена.');
      await ensureInjected(tab.id);
      return { tabId: tab.id, url: tab.url };
    },
    async openChat(tabId, url) {
      if (!isChatGptUrl(url)) throw new AdapterError('INTERNAL', 'Недопустимая ссылка беседы.');
      try {
        await chrome.tabs.update(tabId, { url });
      } catch (e) {
        throw mapTabError(e);
      }
      const end = Date.now() + 45000;
      while (Date.now() < end) {
        await sleep(500);
        let tab;
        try {
          tab = await chrome.tabs.get(tabId);
        } catch (e) {
          throw mapTabError(e);
        }
        if (tab.status !== 'complete') continue;
        try {
          const r = await chrome.tabs.sendMessage(tabId, { rps: 1, type: 'CS_PING' });
          if (r?.ok && r.ready) return;
        } catch {
          try {
            await chrome.scripting.executeScript({ target: { tabId }, files: ['content/chatgpt.js'] });
          } catch {
            // повторим на следующей итерации
          }
        }
      }
      throw new AdapterError('UI_CHANGED', 'Страница ChatGPT не загрузилась или интерфейс не распознан.');
    },
    async snapshot(tabId) {
      return (await send(tabId, { type: 'CS_SNAPSHOT' })).snapshot;
    },
    submit: (tabId, a) => send(tabId, { type: 'CS_SUBMIT', jobId: a.jobId, text: a.text, key: a.key, token: a.token }, 60000),
    waitSlice: (tabId, a) => send(tabId, { type: 'CS_WAIT', key: a.key, baseline: a.baseline ?? null, usedKeys: a.usedKeys ?? [], minSide: a.minSide ?? 0, sliceMs: a.sliceMs ?? 20000 }, (a.sliceMs ?? 20000) + 20000),
    locate: (tabId, a) => send(tabId, { type: 'CS_LOCATE', key: a.key, minSide: a.minSide ?? 0, usedKeys: a.usedKeys ?? [] }),
    cancel: (tabId) => send(tabId, { type: 'CS_CANCEL' }, 8000),
    async diagnose(preferredId) {
      const tab = await findTab(preferredId ?? null);
      if (!tab) return { ok: false, items: [], notes: ['Вкладка https://chatgpt.com/ не найдена. Откройте ChatGPT в этом окне Chrome.'] };
      await ensureInjected(tab.id);
      const r = await send(tab.id, { type: 'CS_DIAGNOSE' });
      const rep = r.report ?? {};
      return { ok: rep.ok === true, items: Array.isArray(rep.items) ? rep.items : [], notes: Array.isArray(rep.notes) ? rep.notes : [] };
    },
    async status(preferredId) {
      const tab = await findTab(preferredId ?? null);
      if (!tab) return { tabFound: false };
      let origin = '';
      try {
        const u = new URL(tab.url);
        origin = `${u.origin}${u.pathname}`;
      } catch {
        // без URL
      }
      return { tabFound: true, tabId: tab.id, url: origin, ready: tab.status === 'complete', active: Boolean(tab.active) };
    },
    async openOrFocus() {
      const tab = await findTab(null);
      if (tab) {
        await chrome.tabs.update(tab.id, { active: true });
        await chrome.windows.update(tab.windowId, { focused: true });
      } else {
        await chrome.tabs.create({ url: 'https://chatgpt.com/' });
      }
    },
  };
}

// ───────── исходный файл изображения ─────────
export function createImages() {
  return {
    async fetch(url) {
      if (!isAllowedImageUrl(url)) throw new AdapterError('FETCH_FAILED', 'Адрес изображения не входит в список разрешённых (chatgpt.com, *.oaiusercontent.com).');
      let res;
      try {
        res = await fetch(url, { credentials: 'include', cache: 'no-store', redirect: 'follow' });
      } catch (e) {
        if (globalThis.navigator?.onLine === false) throw new AdapterError('NETWORK', 'Нет сети при получении изображения.');
        throw new AdapterError('FETCH_FAILED', `Сеть: ${String(e?.message ?? e).slice(0, 120)}`);
      }
      if (res.status === 429) throw new AdapterError('RATE_LIMIT', 'Сервер ответил 429 (слишком много запросов).');
      if (!res.ok) throw new AdapterError('FETCH_FAILED', `HTTP ${res.status}`, { status: res.status });
      const type = res.headers.get('content-type') ?? '';
      if (!type.toLowerCase().startsWith('image/')) throw new AdapterError('FETCH_FAILED', `Ожидалось изображение, получено «${type.slice(0, 60)}»`, { status: res.status });
      const len = Number(res.headers.get('content-length') ?? 0);
      if (len > LIMITS.maxImageBytes) throw new AdapterError('FETCH_FAILED', 'Файл слишком большой.');
      const buf = new Uint8Array(await res.arrayBuffer());
      if (buf.length > LIMITS.maxImageBytes) throw new AdapterError('FETCH_FAILED', 'Файл слишком большой.');
      return { bytes: buf, status: res.status, contentType: type };
    },
  };
}

// ───────── chrome.downloads ─────────
export function createDownloads() {
  const search = async (id) => (await chrome.downloads.search({ id }))[0] ?? null;
  return {
    async start({ url, filename, conflictAction }) {
      try {
        return await chrome.downloads.download({ url, filename, conflictAction, saveAs: false });
      } catch (e) {
        throw new AdapterError('DOWNLOAD_FAILED', `downloads.download отклонён: ${String(e?.message ?? e).slice(0, 160)}`);
      }
    },
    search,
    async waitComplete(id, timeoutMs) {
      const end = Date.now() + timeoutMs;
      for (;;) {
        const item = await search(id);
        if (!item) throw new AdapterError('DOWNLOAD_FAILED', 'Запись о загрузке исчезла.');
        if (item.state === 'complete') return item;
        if (item.state === 'interrupted') throw new AdapterError('DOWNLOAD_FAILED', `Загрузка прервана: ${item.error ?? 'неизвестная причина'}`);
        if (Date.now() >= end) throw new AdapterError('DOWNLOAD_FAILED', 'Тайм-аут загрузки.');
        await sleep(300);
      }
    },
    erase: (id) => chrome.downloads.erase({ id }),
    show: (id) => chrome.downloads.show(id),
  };
}

// ───────── мост сайта ─────────
export function createSiteClient(origin) {
  async function findTab() {
    const tabs = await chrome.tabs.query({ url: `${origin}/*` });
    return tabs.find((t) => t.active) ?? tabs[0] ?? null;
  }
  return {
    async call(type, payload) {
      const tab = await findTab();
      if (!tab) throw new AdapterError('SITE_NOT_FOUND', `Откройте ${origin}/ в этом окне Chrome.`);
      const msg = { rps: 1, type: 'SITE_CALL', req: { type, ...(payload !== undefined ? { payload } : {}) } };
      let res;
      try {
        res = await chrome.tabs.sendMessage(tab.id, msg);
      } catch {
        try {
          await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content/site-bridge.js'] });
          res = await chrome.tabs.sendMessage(tab.id, msg);
        } catch (e) {
          throw new AdapterError('SITE_NOT_FOUND', `Не удалось связаться со вкладкой сайта: ${String(e?.message ?? e).slice(0, 120)}`);
        }
      }
      return { tab, res };
    },
    async openOrFocus() {
      const tab = await findTab();
      if (tab) {
        await chrome.tabs.update(tab.id, { active: true });
        await chrome.windows.update(tab.windowId, { focused: true });
      } else {
        await chrome.tabs.create({ url: `${origin}/` });
      }
    },
  };
}
