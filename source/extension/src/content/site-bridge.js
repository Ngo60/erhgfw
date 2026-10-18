// Content script на promts.vibecods.xyz: ретранслятор между service worker и мостом страницы (window.postMessage).
// Принимает только сообщения этого же окна/origin; наружу передаёт только белый список запросов.
(() => {
  if (globalThis.__rpsSiteBridge) return;
  globalThis.__rpsSiteBridge = true;

  const CHANNEL_EXT = 'rps-extension';
  const CHANNEL_SITE = 'rps-site';
  const VERSION = 1;
  const ALLOWED = ['hello', 'list-presets', 'create-batch', 'cancel'];
  const TIMEOUTS = { hello: 5000, 'list-presets': 8000, 'create-batch': 240000, cancel: 5000 };
  const pending = new Map();
  const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

  window.addEventListener('message', (ev) => {
    if (ev.source !== window || ev.origin !== location.origin) return;
    const d = ev.data;
    if (!isObj(d) || d.source !== CHANNEL_SITE || d.version !== VERSION || typeof d.id !== 'string') return;
    const p = pending.get(d.id);
    if (!p) return;
    if (d.type === 'create-batch:progress' && isObj(d.payload)) {
      chrome.runtime.sendMessage({ rps: 1, type: 'SITE_PROGRESS', done: Number(d.payload.done) || 0, total: Number(d.payload.total) || 0 }).catch(() => {});
      return;
    }
    clearTimeout(p.timer);
    pending.delete(d.id);
    p.resolve({ ok: d.ok === true, type: String(d.type ?? ''), payload: isObj(d.payload) ? d.payload : null, error: isObj(d.error) ? { code: String(d.error.code ?? 'ERROR').slice(0, 40), message: String(d.error.message ?? '').slice(0, 300) } : null });
  });

  function call(type, payload) {
    return new Promise((resolve) => {
      const id = `x-${crypto.randomUUID()}`;
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve({ ok: false, type, payload: null, error: { code: 'TIMEOUT', message: 'Страница сайта не ответила вовремя (мост не установлен на сайте?).' } });
      }, TIMEOUTS[type] ?? 10000);
      pending.set(id, { resolve, timer });
      window.postMessage({ source: CHANNEL_EXT, version: VERSION, id, type, ...(payload !== undefined ? { payload } : {}) }, location.origin);
    });
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id) return false;
    if (!isObj(msg) || msg.rps !== 1) return false;
    if (msg.type === 'SITE_PING') {
      sendResponse({ ok: true, origin: location.origin });
      return false;
    }
    if (msg.type !== 'SITE_CALL' || !isObj(msg.req) || !ALLOWED.includes(msg.req.type)) {
      sendResponse({ ok: false, error: { code: 'BAD_MESSAGE', message: 'Недопустимый запрос к сайту.' } });
      return false;
    }
    const payload = msg.req.payload;
    if (payload !== undefined && (!isObj(payload) || JSON.stringify(payload).length > 4000)) {
      sendResponse({ ok: false, error: { code: 'BAD_MESSAGE', message: 'Недопустимые параметры запроса к сайту.' } });
      return false;
    }
    call(msg.req.type, payload).then(sendResponse);
    return true;
  });
})();
