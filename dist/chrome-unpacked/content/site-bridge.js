(() => {
  // source/extension/src/content/site-bridge.js
  (() => {
    if (globalThis.__rpsSiteBridge) return;
    globalThis.__rpsSiteBridge = true;
    const CHANNEL_EXT = "rps-extension";
    const CHANNEL_SITE = "rps-site";
    const VERSION = 1;
    const ALLOWED = ["hello", "list-presets", "create-batch", "cancel"];
    const TIMEOUTS = { hello: 5e3, "list-presets": 8e3, "create-batch": 24e4, cancel: 5e3 };
    const pending = /* @__PURE__ */ new Map();
    const isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
    window.addEventListener("message", (ev) => {
      if (ev.source !== window || ev.origin !== location.origin) return;
      const d = ev.data;
      if (!isObj(d) || d.source !== CHANNEL_SITE || d.version !== VERSION || typeof d.id !== "string") return;
      const p = pending.get(d.id);
      if (!p) return;
      if (d.type === "create-batch:progress" && isObj(d.payload)) {
        chrome.runtime.sendMessage({ rps: 1, type: "SITE_PROGRESS", done: Number(d.payload.done) || 0, total: Number(d.payload.total) || 0 }).catch(() => {
        });
        return;
      }
      clearTimeout(p.timer);
      pending.delete(d.id);
      p.resolve({ ok: d.ok === true, type: String(d.type ?? ""), payload: isObj(d.payload) ? d.payload : null, error: isObj(d.error) ? { code: String(d.error.code ?? "ERROR").slice(0, 40), message: String(d.error.message ?? "").slice(0, 300) } : null });
    });
    function call(type, payload) {
      return new Promise((resolve) => {
        const id = `x-${crypto.randomUUID()}`;
        const timer = setTimeout(() => {
          pending.delete(id);
          resolve({ ok: false, type, payload: null, error: { code: "TIMEOUT", message: "Страница сайта не ответила вовремя (мост не установлен на сайте?)." } });
        }, TIMEOUTS[type] ?? 1e4);
        pending.set(id, { resolve, timer });
        window.postMessage({ source: CHANNEL_EXT, version: VERSION, id, type, ...payload !== void 0 ? { payload } : {} }, location.origin);
      });
    }
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (sender.id !== chrome.runtime.id) return false;
      if (!isObj(msg) || msg.rps !== 1) return false;
      if (msg.type === "SITE_PING") {
        sendResponse({ ok: true, origin: location.origin });
        return false;
      }
      if (msg.type !== "SITE_CALL" || !isObj(msg.req) || !ALLOWED.includes(msg.req.type)) {
        sendResponse({ ok: false, error: { code: "BAD_MESSAGE", message: "Недопустимый запрос к сайту." } });
        return false;
      }
      const payload = msg.req.payload;
      if (payload !== void 0 && (!isObj(payload) || JSON.stringify(payload).length > 4e3)) {
        sendResponse({ ok: false, error: { code: "BAD_MESSAGE", message: "Недопустимые параметры запроса к сайту." } });
        return false;
      }
      call(msg.req.type, payload).then(sendResponse);
      return true;
    });
  })();
})();
