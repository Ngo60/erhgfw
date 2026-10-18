// HTTPS mock of the ChatGPT web app (chatgpt.com) with scriptable failure modes, for extension e2e tests.
//
// Behaviours ({mode, delayMs, size, width, height, text, contentType, times} or just the mode name) are consumed one
// per prompt from the queue set by setScript(); an empty queue falls back to the defaults (setDefaults()).
// Modes: see MODES. Toggles (persist until reset()): loggedOut, captcha, uiChanged, offline.
// Out-of-process control: POST /__ctl {script?, defaults?, reset?, loggedOut?, captcha?, uiChanged?, offline?}, GET /__state.
import https from 'node:https';
import crypto from 'node:crypto';
import { makeCerts } from './certs.mjs';
import { makePng, makeJpeg, makeWebp } from './png.mjs';
import { renderPage } from './chatgpt-page.mjs';

export const MODES = [
  'normal',
  'two-images',
  'text-only',
  'rate-limit',
  'policy',
  'error',
  'hang',
  'small-image',
  'same-image',
  'jpeg',
  'webp',
  'slow',
  'drop-send',
];
const IMAGE_MODES = new Set(['normal', 'two-images', 'hang', 'small-image', 'same-image', 'jpeg', 'webp', 'slow']);
const TOGGLES = ['loggedOut', 'captcha', 'uiChanged', 'offline'];

const TEXTS = {
  'text-only': 'Sure! Here is a description\u2026',
  'rate-limit':
    "You've hit the free plan limit for image generations requests. You can create more images when the limit resets.",
  policy: "I'm sorry, but I can't generate that image because the request may violate our content policies.",
  stopped: 'Stopped.',
};

const SESSION_COOKIE = 'rps_session=ok; Path=/; Secure; SameSite=Lax';
const MAX_BODY = 1024 * 1024;

const uuid = () => crypto.randomUUID();
const hex = (bytes) => crypto.randomBytes(bytes).toString('hex');

function checkNumber(name, v, { min = 0, int = false } = {}) {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || (int && !Number.isInteger(v))) {
    throw new RangeError(`${name} must be ${int ? 'an integer' : 'a number'} >= ${min}, got ${JSON.stringify(v)}`);
  }
}

function checkBehaviourFields(b) {
  if (b.mode !== undefined && !MODES.includes(b.mode)) {
    throw new Error(`unknown mode ${JSON.stringify(b.mode)}; expected one of ${MODES.join(', ')}`);
  }
  if (b.delayMs !== undefined) checkNumber('delayMs', b.delayMs);
  for (const k of ['size', 'width', 'height']) if (b[k] !== undefined) checkNumber(k, b[k], { min: 1, int: true });
  if (b.times !== undefined) checkNumber('times', b.times, { min: 1, int: true });
}

function normalizeScript(script) {
  if (!Array.isArray(script)) throw new TypeError('script must be an array');
  const out = [];
  for (const item of script) {
    const b = typeof item === 'string' ? { mode: item } : item;
    if (!b || typeof b !== 'object' || Array.isArray(b)) throw new TypeError('a behaviour must be a string or an object');
    checkBehaviourFields(b);
    const { times = 1, ...rest } = b;
    for (let i = 0; i < times; i++) out.push({ ...rest });
  }
  return out;
}

/**
 * @param {{port?: number, certs?: {key: string, cert: string}, log?: boolean|Function, defaults?: object}} [opts]
 */
export async function startMockChatGpt({ port = 0, certs, log = false, defaults: initialDefaults } = {}) {
  certs ??= await makeCerts();
  const logFn = typeof log === 'function' ? log : log ? (...a) => console.log('[mock-chatgpt]', ...a) : null;
  const baseDefaults = { mode: 'normal', delayMs: 1200, size: 768, ...initialDefaults };
  checkBehaviourFields(baseDefaults);

  const freshState = () => ({
    conversations: new Map(),
    files: new Map(),
    sends: [],
    script: [],
    defaults: { ...baseDefaults },
    toggles: { loggedOut: false, captcha: false, uiChanged: false, offline: false },
    lastImages: null,
    seq: 0,
    ts: 0,
  });
  let st = freshState();

  // ---------- conversation model ----------
  const bump = (conv) => {
    conv.version++;
  };
  const touch = (conv, turn) => {
    turn.rev++;
    bump(conv);
  };

  function newConv(id = uuid()) {
    const conv = { id, version: 0, running: false, error: false, turns: [], timer: null, gen: null };
    st.conversations.set(id, conv);
    return conv;
  }

  const viewOf = (conv, id = null) =>
    conv
      ? {
          id: conv.id,
          exists: true,
          version: conv.version,
          running: conv.running,
          error: conv.error,
          turns: conv.turns.map((t) => ({ ...t })),
        }
      : { id, exists: false, version: 0, running: false, error: false, turns: [] };

  const uiFlags = () => ({
    loggedOut: st.toggles.loggedOut,
    captcha: st.toggles.captcha,
    uiChanged: st.toggles.uiChanged,
  });

  function pushUser(conv, text) {
    conv.turns.push({ id: 't_' + uuid(), role: 'user', text, msgId: uuid(), rev: 1 });
  }
  function pushText(conv, text) {
    conv.turns.push({ id: 't_' + uuid(), role: 'assistant', kind: 'text', text, msgId: uuid(), rev: 1 });
  }
  function pushPending(conv) {
    const turn = { id: 't_' + uuid(), role: 'assistant', kind: 'pending', rev: 1 };
    conv.turns.push(turn);
    return turn;
  }

  function registerFile({ buffer, contentType, width, height }) {
    const id = 'file_' + hex(16);
    st.files.set(id, { buffer, contentType, width, height });
    return id;
  }

  // New ts/sig on every call: a repeated file id still yields a fresh URL, like the real endpoint.
  function imageEntry(fileId, prompt) {
    const file = st.files.get(fileId);
    const ts = Date.now() * 1000 + (st.ts++ % 1000);
    const sig = crypto.createHash('sha256').update(`${fileId}:${ts}`).digest('hex').slice(0, 32);
    return {
      fileId,
      w: file.width,
      h: file.height,
      alt: 'Generated image: ' + prompt.slice(0, 60),
      src: `/backend-api/estuary/content?id=${fileId}&ts=${ts}&p=fs&cid=1&sig=${sig}`,
    };
  }

  function makeImages(beh, conv) {
    const seedBase = `${conv.id}:${conv.turns.length}:${++st.seq}`;
    const png = (i) =>
      registerFile({
        buffer: makePng({ width: beh.width, height: beh.height, seed: `${seedBase}:${i}` }),
        contentType: beh.contentType ?? 'image/png',
        width: beh.width,
        height: beh.height,
      });
    switch (beh.mode) {
      case 'two-images':
        return [png(0), png(1)];
      case 'jpeg':
      case 'webp': {
        const img = (beh.mode === 'jpeg' ? makeJpeg : makeWebp)({ seed: seedBase });
        return [registerFile({ ...img, contentType: beh.contentType ?? img.contentType })];
      }
      case 'same-image':
        return [st.lastImages ? st.lastImages[0].fileId : png(0)];
      default:
        return [png(0)];
    }
  }

  // ---------- generation lifecycle ----------
  function resolveBehaviour(raw) {
    const d = st.defaults;
    const mode = raw.mode ?? d.mode;
    const size = raw.size ?? (mode === 'small-image' ? 128 : d.size);
    return {
      ...raw,
      mode,
      delayMs: raw.delayMs ?? (mode === 'slow' ? 8000 : d.delayMs),
      width: raw.width ?? size,
      height: raw.height ?? size,
    };
  }

  function startGeneration(conv, raw, prompt) {
    const beh = resolveBehaviour(raw);
    const gen = { beh, prompt, placeholder: null };
    conv.gen = gen;
    conv.error = false;
    if (beh.mode === 'drop-send') {
      conv.running = false;
      conv.gen = null;
      bump(conv);
      return beh;
    }
    conv.running = true;
    if (IMAGE_MODES.has(beh.mode)) gen.placeholder = pushPending(conv);
    bump(conv);
    if (beh.mode !== 'hang') {
      conv.timer = setTimeout(() => finishGeneration(conv, gen), beh.delayMs);
      conv.timer.unref?.();
    }
    return beh;
  }

  function finishGeneration(conv, gen) {
    if (conv.gen !== gen) return;
    const { beh, prompt, placeholder } = gen;
    conv.timer = null;
    if (beh.mode === 'error') {
      conv.error = true;
    } else if (TEXTS[beh.mode] !== undefined) {
      pushText(conv, beh.text ?? TEXTS[beh.mode]);
    } else {
      const images = makeImages(beh, conv).map((id) => imageEntry(id, prompt));
      st.lastImages = images;
      const turn = placeholder ?? pushPending(conv);
      turn.kind = 'image';
      turn.images = images;
      turn.rev++;
    }
    conv.running = false;
    conv.gen = null;
    bump(conv);
  }

  function stopGeneration(conv) {
    if (!conv.running) return false;
    clearTimeout(conv.timer);
    conv.timer = null;
    const { placeholder } = conv.gen ?? {};
    if (placeholder) {
      placeholder.kind = 'text';
      placeholder.text = TEXTS.stopped;
      placeholder.msgId = uuid();
      placeholder.rev++;
    } else {
      pushText(conv, TEXTS.stopped);
    }
    conv.running = false;
    conv.gen = null;
    bump(conv);
    return true;
  }

  const releaseHung = () => {
    for (const conv of st.conversations.values()) if (conv.gen?.beh.mode === 'hang') stopGeneration(conv);
  };

  function clearTimers() {
    for (const conv of st.conversations.values()) clearTimeout(conv.timer);
  }

  const nextBehaviour = () => st.script.shift() ?? {};

  function handleSend(body) {
    const text = typeof body.text === 'string' ? body.text : '';
    if (!text.trim()) return [400, { error: 'text is required' }];
    if (st.toggles.loggedOut) return [401, { error: 'logged out' }];
    if (st.toggles.captcha) return [403, { error: 'challenge required' }];
    const wanted = typeof body.conv_id === 'string' && body.conv_id ? body.conv_id : null;
    const conv = (wanted && st.conversations.get(wanted)) || newConv(wanted ?? undefined);
    if (conv.running) return [409, { error: 'generation in progress' }];
    pushUser(conv, text);
    const beh = startGeneration(conv, nextBehaviour(), text);
    st.sends.push({ conv_id: conv.id, text, mode: beh.mode, at: Date.now() });
    return [200, { conv_id: conv.id, view: viewOf(conv) }];
  }

  function handleRetry(body) {
    const conv = st.conversations.get(body.conv_id);
    if (!conv) return [404, { error: 'unknown conversation' }];
    if (conv.running) return [409, { error: 'generation in progress' }];
    const lastUser = [...conv.turns].reverse().find((t) => t.role === 'user');
    if (!lastUser) return [400, { error: 'nothing to retry' }];
    const beh = startGeneration(conv, nextBehaviour(), lastUser.text);
    st.sends.push({ conv_id: conv.id, text: lastUser.text, mode: beh.mode, at: Date.now(), retry: true });
    return [200, { conv_id: conv.id }];
  }

  // ---------- public control surface ----------
  function setScript(script) {
    st.script = normalizeScript(script);
    releaseHung();
  }

  function setDefaults(opts) {
    if (!opts || typeof opts !== 'object') throw new TypeError('defaults must be an object');
    checkBehaviourFields(opts);
    for (const k of ['mode', 'delayMs', 'size']) if (opts[k] !== undefined) st.defaults[k] = opts[k];
  }

  function setToggles(flags) {
    for (const k of TOGGLES) if (flags[k] !== undefined) st.toggles[k] = !!flags[k];
  }

  function getState() {
    const conversations = {};
    for (const [id, conv] of st.conversations) conversations[id] = conv.turns.length;
    return {
      sends: st.sends.map((s) => ({ ...s })),
      conversations,
      script: st.script.map((b) => ({ ...b })),
      defaults: { ...st.defaults },
      running: [...st.conversations.values()].filter((c) => c.running).map((c) => c.id),
      ...st.toggles,
    };
  }

  function reset() {
    clearTimers();
    st = freshState();
  }

  function ctl(body) {
    if (!body || typeof body !== 'object') throw new TypeError('ctl body must be an object');
    if (body.script !== undefined) normalizeScript(body.script);
    if (body.defaults !== undefined) checkBehaviourFields(body.defaults);
    if (body.reset) reset();
    if (body.script !== undefined) setScript(body.script);
    if (body.defaults !== undefined) setDefaults(body.defaults);
    setToggles(body);
    return getState();
  }

  // ---------- HTTP ----------
  const hasSession = (req) => /(?:^|;\s*)rps_session=ok(?:;|$)/.test(req.headers.cookie ?? '');

  function sendJson(res, status, obj, extra = {}) {
    const body = JSON.stringify(obj);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body),
      'cache-control': 'no-store',
      ...extra,
    });
    res.end(body);
  }

  function readJson(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY) {
          reject(new Error('body too large'));
          req.destroy();
        } else chunks.push(c);
      });
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        if (!raw.trim()) return resolve({});
        try {
          resolve(JSON.parse(raw));
        } catch {
          reject(new Error('invalid JSON'));
        }
      });
      req.on('error', reject);
    });
  }

  function servePage(res, url) {
    const m = /^\/c\/([^/]+)\/?$/.exec(url.pathname);
    const convId = m ? decodeURIComponent(m[1]) : null;
    const boot = { convId, view: viewOf(convId ? st.conversations.get(convId) : null, convId), ui: uiFlags() };
    const cookie = st.toggles.loggedOut ? 'rps_session=; Path=/; Max-Age=0; Secure; SameSite=Lax' : SESSION_COOKIE;
    const html = renderPage(boot);
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-length': Buffer.byteLength(html),
      'cache-control': 'no-store',
      'set-cookie': cookie,
    });
    res.end(html);
  }

  function serveImage(req, res, url) {
    if (st.toggles.loggedOut || !hasSession(req)) return sendJson(res, 401, { detail: 'Unauthorized' });
    const file = st.files.get(url.searchParams.get('id'));
    if (!file) return sendJson(res, 404, { detail: 'File not found' });
    res.writeHead(200, {
      'content-type': file.contentType,
      'content-length': file.buffer.length,
      'cache-control': 'private, no-store',
    });
    res.end(req.method === 'HEAD' ? undefined : file.buffer);
  }

  const CORS = {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
  };

  async function route(req, res) {
    const url = new URL(req.url, 'https://localhost');
    const path = url.pathname;
    const method = req.method;

    if (path === '/__ctl' || path === '/__state') {
      if (method === 'OPTIONS') {
        res.writeHead(204, CORS);
        return res.end();
      }
      if (path === '/__state' && method === 'GET') return sendJson(res, 200, getState(), CORS);
      if (path === '/__ctl' && method === 'POST') {
        try {
          return sendJson(res, 200, ctl(await readJson(req)), CORS);
        } catch (e) {
          return sendJson(res, 400, { error: e.message }, CORS);
        }
      }
      return sendJson(res, 405, { error: 'method not allowed' }, CORS);
    }

    if (path.startsWith('/__mock/')) {
      if (st.toggles.offline) return sendJson(res, 503, { error: 'offline' });
      let m;
      if (method === 'GET' && (m = /^\/__mock\/conv\/([^/]+)$/.exec(path))) {
        const id = decodeURIComponent(m[1]);
        const conv = id === '_' ? null : st.conversations.get(id);
        return sendJson(res, 200, { ...viewOf(conv, id === '_' ? null : id), ui: uiFlags() });
      }
      if (method === 'POST' && ['/__mock/send', '/__mock/stop', '/__mock/retry'].includes(path)) {
        let body;
        try {
          body = await readJson(req);
        } catch (e) {
          return sendJson(res, 400, { error: e.message });
        }
        if (path === '/__mock/send') {
          const [status, out] = handleSend(body);
          return sendJson(res, status, out);
        }
        if (path === '/__mock/retry') {
          const [status, out] = handleRetry(body);
          return sendJson(res, status, out);
        }
        const conv = st.conversations.get(body.conv_id);
        if (conv) stopGeneration(conv);
        return sendJson(res, 200, { ok: true });
      }
      return sendJson(res, 404, { detail: 'Not Found' });
    }

    if (path === '/backend-api/estuary/content') {
      if (method !== 'GET' && method !== 'HEAD') return sendJson(res, 405, { detail: 'Method Not Allowed' });
      return serveImage(req, res, url);
    }
    if (path === '/api/auth/session' && method === 'GET') {
      return sendJson(
        res,
        200,
        st.toggles.loggedOut
          ? {}
          : {
              user: { id: 'user-mock', name: 'Mock User', email: 'mock@example.test' },
              expires: '2099-01-01T00:00:00.000Z',
              accessToken: 'mock-access-token',
            },
      );
    }
    if (path === '/favicon.ico') {
      res.writeHead(204);
      return res.end();
    }
    if ((method === 'GET' || method === 'HEAD') && (path === '/' || /^\/c\/[^/]+\/?$/.test(path))) {
      return servePage(res, url);
    }
    return sendJson(res, 404, { detail: 'Not Found' });
  }

  const server = https.createServer({ key: certs.key, cert: certs.cert }, (req, res) => {
    if (logFn) res.on('finish', () => logFn(req.method, req.url, res.statusCode));
    route(req, res).catch((e) => {
      if (!res.headersSent) sendJson(res, 500, { error: String(e?.message ?? e) });
      else res.destroy();
    });
  });
  server.on('tlsClientError', () => {});
  server.on('clientError', (_err, socket) => socket.destroy());
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const actualPort = server.address().port;

  async function stop() {
    clearTimers();
    await new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
  }

  return {
    url: `https://localhost:${actualPort}`,
    port: actualPort,
    setScript,
    setDefaults,
    setToggles,
    getState,
    reset,
    ctl,
    stop,
  };
}
