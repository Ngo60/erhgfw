// source/extension/src/lib/constants.js
var SCHEMA_BATCH = "rps-batch/1";
var BRIDGE = Object.freeze({ version: 1, channelExt: "rps-extension", channelSite: "rps-site" });
var RUNNER_STATE = Object.freeze({
  IDLE: "idle",
  PREPARING: "preparing",
  SUBMITTING: "submitting",
  WAITING: "waiting",
  DOWNLOADING: "downloading",
  VERIFYING: "verifying",
  COMPLETED: "completed",
  RETRYABLE_ERROR: "retryable_error",
  PAUSED: "paused",
  BLOCKED: "blocked",
  FAILED: "failed"
});
var JOB_STATUS = Object.freeze({
  PENDING: "pending",
  PREPARING: "preparing",
  SUBMITTING: "submitting",
  WAITING: "waiting",
  DOWNLOADING: "downloading",
  VERIFYING: "verifying",
  COMPLETED: "completed",
  RETRYABLE_ERROR: "retryable_error",
  FAILED: "failed"
});
var ACTIVE_STATES = /* @__PURE__ */ new Set(["preparing", "submitting", "waiting", "downloading", "verifying", "completed", "retryable_error", "failed"]);
var IN_FLIGHT = /* @__PURE__ */ new Set(["preparing", "submitting", "waiting", "downloading", "verifying"]);
var LIMITS = Object.freeze({
  maxBatchJobs: 1500,
  maxCharacters: 200,
  maxJobsPerCharacter: 200,
  promptMin: 20,
  promptMax: 8e3,
  maxImportBytes: 15 * 1024 * 1024,
  maxImageBytes: 50 * 1024 * 1024
});
var ERR = Object.freeze({
  CAPTCHA: { kind: "blocking", ru: "ChatGPT показал проверку безопасности (CAPTCHA). Пройдите её вручную во вкладке ChatGPT и нажмите «Продолжить». Расширение её не обходит." },
  AUTH_REQUIRED: { kind: "blocking", ru: "Нужен вход в ChatGPT. Войдите в аккаунт во вкладке ChatGPT и нажмите «Продолжить»." },
  RATE_LIMIT: { kind: "blocking", ru: "ChatGPT сообщил об ограничении (лимит генерации). Очередь остановлена: подождите сброса лимита и нажмите «Продолжить». Лимиты не обходятся." },
  UI_CHANGED: { kind: "blocking", ru: "Интерфейс ChatGPT не распознан (изменилась разметка?). Нажмите «Проверить интерфейс ChatGPT» и обновите профиль селекторов." },
  TAB_NOT_FOUND: { kind: "blocking", ru: "Не найдена вкладка ChatGPT. Откройте https://chatgpt.com/ в этом окне Chrome и нажмите «Продолжить»." },
  TAB_CLOSED: { kind: "blocking", ru: "Вкладка ChatGPT закрыта. Откройте ChatGPT и нажмите «Продолжить» — расширение найдёт уже отправленный промпт и не создаст дубликат." },
  PAGE_BUSY: { kind: "blocking", ru: "В ChatGPT уже идёт генерация, не запущенная расширением. Дождитесь окончания и нажмите «Продолжить»." },
  OFFLINE: { kind: "blocking", ru: "Нет сети дольше допустимого времени ожидания. Проверьте подключение и нажмите «Продолжить»." },
  NETWORK: { kind: "network", ru: "Потеряна сеть или ChatGPT недоступен. Ожидание восстановления соединения." },
  GENERATION_ERROR: { kind: "retry", ru: "ChatGPT сообщил об ошибке генерации." },
  STALLED: { kind: "retry", ru: "Генерация зависла: нет изменений в интерфейсе слишком долго." },
  TIMEOUT: { kind: "retry", ru: "Превышено время ожидания изображения." },
  NO_IMAGE: { kind: "retry", ru: "ChatGPT ответил без изображения." },
  PROMPT_NOT_ACCEPTED: { kind: "retry", ru: "ChatGPT не принял промпт (не удалось отправить сообщение)." },
  FETCH_FAILED: { kind: "retry", ru: "Не удалось получить исходный файл изображения." },
  DOWNLOAD_FAILED: { kind: "retry", ru: "Chrome не смог сохранить файл." },
  SIZE_MISMATCH: { kind: "retry", ru: "Размер сохранённого файла не совпал с проверенным." },
  PREVIEW_ONLY: { kind: "retry", ru: "Найдено только превью (изображение меньше допустимого минимума)." },
  DUPLICATE_IMAGE: { kind: "retry", ru: "Получено изображение, которое уже сохранено для другого задания." },
  CONTENT_POLICY: { kind: "permanent", ru: "ChatGPT отклонил запрос по правилам содержимого. Задание помечено ошибкой; правила не обходятся." },
  MULTIPLE_IMAGES: { kind: "permanent", ru: "ChatGPT вернул несколько изображений вместо одного. Измените политику в настройках или выберите кадр вручную." },
  UNSUPPORTED_IMAGE_FORMAT: { kind: "permanent", ru: "Формат файла не распознан как PNG/JPEG/WebP/GIF." },
  INTEGRITY: { kind: "permanent", ru: "Нарушена целостность задания (промпт не соответствует персонажу)." },
  INTERNAL: { kind: "permanent", ru: "Внутренняя ошибка расширения." }
});
function errInfo(code) {
  return ERR[code] ?? ERR.INTERNAL;
}
var DEFAULT_SETTINGS = Object.freeze({
  rootFolder: "ChatGPT-Images",
  intervalSec: 5,
  maxAttempts: 3,
  jobTimeoutSec: 600,
  stallTimeoutSec: 240,
  networkGiveUpSec: 900,
  newChatPerCharacter: true,
  rotateChatEvery: 12,
  chatStartUrl: "https://chatgpt.com/",
  multiImagePolicy: "fail",
  minImageSide: 512,
  promptPrefix: "Generate an image from the following description. Do not ask clarifying questions.\n\n",
  promptSuffix: "",
  confirmThreshold: 50,
  strongConfirmThreshold: 300,
  stopAfterPolicyRefusals: 3,
  notifications: true,
  writeMetadata: true
});
var SETTINGS_SPEC = Object.freeze({
  rootFolder: { type: "path" },
  intervalSec: { type: "int", min: 2, max: 120 },
  maxAttempts: { type: "int", min: 1, max: 5 },
  jobTimeoutSec: { type: "int", min: 60, max: 1800 },
  stallTimeoutSec: { type: "int", min: 60, max: 900 },
  networkGiveUpSec: { type: "int", min: 60, max: 3600 },
  newChatPerCharacter: { type: "bool" },
  rotateChatEvery: { type: "int", min: 0, max: 100 },
  chatStartUrl: { type: "chatUrl" },
  multiImagePolicy: { type: "enum", values: ["fail", "first", "all"] },
  minImageSide: { type: "int", min: 0, max: 4096 },
  promptPrefix: { type: "text", max: 500 },
  promptSuffix: { type: "text", max: 500 },
  confirmThreshold: { type: "int", min: 1, max: 1500 },
  strongConfirmThreshold: { type: "int", min: 1, max: 1500 },
  stopAfterPolicyRefusals: { type: "int", min: 1, max: 10 },
  notifications: { type: "bool" },
  writeMetadata: { type: "bool" }
});

// source/extension/src/lib/errors.js
var AdapterError = class extends Error {
  constructor(code, message, extra = {}) {
    super(message ?? code);
    this.name = "AdapterError";
    this.code = code;
    Object.assign(this, extra);
  }
};
var CommandError = class extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CommandError";
    this.code = code;
  }
};

// source/extension/src/lib/messages.js
var ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
var isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
var T = {
  id: { t: "id" },
  idOpt: { t: "id", opt: true },
  obj: { t: "obj" },
  boolOpt: { t: "bool", opt: true }
};
var PANEL_TYPES = Object.freeze({
  GET_VIEW: {},
  SITE_STATUS: {},
  SITE_LIST_PRESETS: {},
  SITE_CREATE_BATCH: { params: T.obj, test: T.boolOpt },
  IMPORT_BATCH: { text: { t: "str", max: 15 * 1024 * 1024 }, fileName: { t: "str", max: 200 }, test: T.boolOpt },
  START: { batch_id: T.id, confirm: { t: "obj", opt: true } },
  PAUSE: {},
  RESUME: {},
  STOP: {},
  EMERGENCY_STOP: {},
  RETRY_FAILED: { batch_id: T.id },
  SELECT_BATCH: { batch_id: T.id },
  DELETE_BATCH: { batch_id: T.id },
  UPDATE_SETTINGS: { patch: T.obj },
  DIAGNOSE_CHATGPT: {},
  OPEN_CHATGPT: {},
  OPEN_SITE: {},
  SHOW_FILE: { image_job_id: T.id },
  GET_EVENTS: { batch_id: T.id, limit: { t: "int", min: 1, max: 500, opt: true } },
  EXPORT_LOG: { batch_id: T.id, format: { t: "enum", values: ["json", "csv"] } }
});
var CS_TYPES = Object.freeze({
  CS_PING: {},
  CS_SNAPSHOT: {},
  CS_SUBMIT: { jobId: T.id, text: { t: "str", max: 2e4 }, key: { t: "str", max: 200 }, token: { t: "str", max: 200 } },
  CS_WAIT: {
    key: { t: "str", max: 200 },
    baseline: { t: "obj", opt: true, nullable: true },
    usedKeys: { t: "arr", max: 8e3, opt: true },
    minSide: { t: "int", min: 0, max: 4096, opt: true },
    sliceMs: { t: "int", min: 500, max: 3e4, opt: true }
  },
  CS_LOCATE: { key: { t: "str", max: 200 }, minSide: { t: "int", min: 0, max: 4096, opt: true }, usedKeys: { t: "arr", max: 8e3, opt: true } },
  CS_CANCEL: {},
  CS_DIAGNOSE: {}
});
var SITE_CALL_TYPES = Object.freeze(["hello", "list-presets", "create-batch", "cancel"]);
function check(spec, value) {
  if (value === void 0) return spec.opt === true;
  if (value === null) return spec.nullable === true;
  switch (spec.t) {
    case "id":
      return typeof value === "string" && ID_RE.test(value);
    case "str":
      return typeof value === "string" && value.length <= (spec.max ?? 1e3);
    case "bool":
      return typeof value === "boolean";
    case "int":
      return Number.isInteger(value) && value >= (spec.min ?? -Infinity) && value <= (spec.max ?? Infinity);
    case "enum":
      return spec.values.includes(value);
    case "obj":
      return isObj(value);
    case "arr":
      return Array.isArray(value) && value.length <= (spec.max ?? 1e3) && value.every((x) => typeof x === "string" && x.length <= 300);
    default:
      return false;
  }
}
function validateMessage(msg, table) {
  if (!isObj(msg) || msg.rps !== 1 || typeof msg.type !== "string" || !Object.hasOwn(table, msg.type)) return { ok: false, error: { code: "BAD_MESSAGE", message: "Неизвестное или некорректное сообщение." } };
  const spec = table[msg.type];
  for (const [field, s] of Object.entries(spec)) if (!check(s, msg[field])) return { ok: false, error: { code: "BAD_MESSAGE", message: `Некорректное поле «${field}» в сообщении ${msg.type}.` } };
  return { ok: true, type: msg.type };
}
var validatePanelMessage = (msg) => validateMessage(msg, PANEL_TYPES);
function cleanCreateParams(p) {
  if (!isObj(p)) return null;
  const mode = p.mode === "single" || p.mode === "multi" ? p.mode : null;
  const strategy = p.strategy === "series" || p.strategy === "character" ? p.strategy : null;
  if (!mode || !strategy) return null;
  const idOrNull = (v) => v === null || v === void 0 || v === "" ? null : typeof v === "string" && /^[A-Za-z0-9._~:-]{1,64}$/.test(v) ? v : void 0;
  const preset = idOrNull(p.preset_id);
  const seed = idOrNull(p.seed);
  if (preset === void 0 || seed === void 0) return null;
  const characters = mode === "single" ? 1 : p.characters;
  if (!Number.isInteger(characters) || !Number.isInteger(p.frames_per_character)) return null;
  if (typeof p.profile !== "string" || typeof p.length !== "string") return null;
  return { mode, characters, frames_per_character: p.frames_per_character, strategy, preset_id: preset, seed, profile: p.profile, length: p.length, include_negative: p.include_negative !== false, use_site_character: p.use_site_character === true };
}

// source/extension/src/lib/store.js
var KEY = Object.freeze({
  meta: "rps:meta",
  settings: "rps:settings",
  runner: "rps:runner",
  batch: (id) => `rps:batch:${id}`,
  job: (id) => `rps:job:${id}`,
  log: (batchId, n) => `rps:log:${batchId}:${n}`
});
var defaultRunner = () => ({
  rev: 0,
  state: "idle",
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
  chat: { tabId: null, characterId: null, framesInChat: 0, url: null }
});
var defaultMeta = () => ({ schema: 1, selected_batch_id: null, day_counters: {} });
var clone = (v) => v === void 0 ? v : structuredClone(v);
var Store = class {
  constructor(area, { now = () => Date.now(), logChunkSize = 200 } = {}) {
    this.area = area;
    this.now = now;
    this.chunkSize = logChunkSize;
    this.meta = defaultMeta();
    this.settings = { ...DEFAULT_SETTINGS };
    this.runner = defaultRunner();
    this.batches = /* @__PURE__ */ new Map();
    this.jobs = /* @__PURE__ */ new Map();
    this.logs = /* @__PURE__ */ new Map();
    this.listeners = /* @__PURE__ */ new Set();
    this.chain = Promise.resolve();
  }
  /** Гидратация кэша из хранилища (вызывается при каждом старте service worker). */
  async load() {
    const all = await this.area.get(null) ?? {};
    this.meta = { ...defaultMeta(), ...all[KEY.meta] ?? {} };
    this.settings = { ...DEFAULT_SETTINGS, ...all[KEY.settings] ?? {} };
    this.runner = { ...defaultRunner(), ...all[KEY.runner] ?? {} };
    this.batches.clear();
    this.jobs.clear();
    this.logs.clear();
    const logKeys = [];
    for (const [k, v] of Object.entries(all)) {
      if (k.startsWith("rps:batch:")) this.batches.set(k.slice("rps:batch:".length), v);
      else if (k.startsWith("rps:job:")) this.jobs.set(k.slice("rps:job:".length), v);
      else if (k.startsWith("rps:log:")) logKeys.push(k);
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
      const batches = /* @__PURE__ */ new Map();
      for (const [id, b] of Object.entries(ch.batches ?? {})) {
        const c = clone(b);
        batches.set(id, c);
        out[KEY.batch(id)] = c;
      }
      const jobs = /* @__PURE__ */ new Map();
      for (const [id, j] of Object.entries(ch.jobs ?? {})) {
        const c = clone(j);
        jobs.set(id, c);
        out[KEY.job(id)] = c;
      }
      const logs = /* @__PURE__ */ new Map();
      for (const ev2 of ch.events ?? []) {
        const bid = ev2.batch_id;
        if (!bid) continue;
        let chunks = logs.get(bid) ?? [...this.logs.get(bid) ?? []];
        if (!chunks.length || (chunks[chunks.length - 1]?.length ?? 0) >= this.chunkSize) chunks = [...chunks, []];
        const last = chunks[chunks.length - 1] ?? [];
        const seq = (chunks.length - 1) * this.chunkSize + last.length + 1;
        chunks[chunks.length - 1] = [...last, { seq, ts: new Date(this.now()).toISOString(), ...clone(ev2) }];
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
        }
      }
    };
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => {
    });
    return p;
  }
};

// source/extension/src/lib/image.js
var u16be = (b, i) => b[i] << 8 | b[i + 1];
var u32be = (b, i) => (b[i] << 24 | b[i + 1] << 16 | b[i + 2] << 8 | b[i + 3]) >>> 0;
var ascii = (b, i, n) => String.fromCharCode(...b.subarray(i, i + n));
function sniffImage(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b.length < 16) return null;
  if (b[0] === 137 && b[1] === 80 && b[2] === 78 && b[3] === 71 && b[4] === 13 && b[5] === 10 && b[6] === 26 && b[7] === 10) {
    if (ascii(b, 12, 4) !== "IHDR") return null;
    return ok("png", "image/png", u32be(b, 16), u32be(b, 20));
  }
  if (b[0] === 255 && b[1] === 216) return sniffJpeg(b);
  if (ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WEBP") return sniffWebp(b);
  if (ascii(b, 0, 3) === "GIF" && (ascii(b, 3, 3) === "87a" || ascii(b, 3, 3) === "89a")) return ok("gif", "image/gif", b[6] | b[7] << 8, b[8] | b[9] << 8);
  return null;
}
function ok(format, mime, width, height) {
  return width > 0 && height > 0 ? { format, mime, width, height } : null;
}
function sniffJpeg(b) {
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 255) return null;
    let marker = b[i + 1];
    while (marker === 255 && i + 2 < b.length) {
      i += 1;
      marker = b[i + 1];
    }
    if (marker === 216 || marker === 1 || marker >= 208 && marker <= 215) {
      i += 2;
      continue;
    }
    const isSof = marker >= 192 && marker <= 207 && marker !== 196 && marker !== 200 && marker !== 204;
    if (isSof) return ok("jpeg", "image/jpeg", u16be(b, i + 7), u16be(b, i + 5));
    i += 2 + u16be(b, i + 2);
  }
  return null;
}
function sniffWebp(b) {
  const kind = ascii(b, 12, 4);
  if (kind === "VP8 " && b.length >= 30) return ok("webp", "image/webp", (b[26] | b[27] << 8) & 16383, (b[28] | b[29] << 8) & 16383);
  if (kind === "VP8L" && b.length >= 25) {
    const bits = (b[21] | b[22] << 8 | b[23] << 16 | b[24] << 24) >>> 0;
    return ok("webp", "image/webp", (bits & 16383) + 1, (bits >>> 14 & 16383) + 1);
  }
  if (kind === "VP8X" && b.length >= 30) {
    return ok("webp", "image/webp", 1 + (b[24] | b[25] << 8 | b[26] << 16), 1 + (b[27] | b[28] << 8 | b[29] << 16));
  }
  return null;
}
async function sha256Hex(input) {
  const data = typeof input === "string" ? new TextEncoder().encode(input) : input;
  const digest = await globalThis.crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

// source/extension/src/lib/naming.js
var RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
function safeSegment(value, fallback = "item") {
  let s = String(value ?? "").normalize("NFKD").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/-{2,}/g, "-").replace(/^[-.]+|[-.]+$/g, "").slice(0, 64);
  if (!s) s = fallback;
  if (RESERVED.test(s)) s = `_${s}`;
  return s;
}
function sanitizeRoot(value, fallback = "ChatGPT-Images") {
  const parts = String(value ?? "").replace(/\\/g, "/").split("/").map((p) => p.trim()).filter((p) => p && p !== "." && p !== "..").map((p) => safeSegment(p, "")).filter(Boolean).slice(0, 4);
  return parts.length ? parts.join("/") : fallback;
}
var pad = (n, width = 3) => String(Math.max(0, Math.trunc(n))).padStart(width, "0");
function batchFolderName(dateStr, counter, kind = "batch") {
  return `${kind === "test" ? "Test" : "Batch"}_${dateStr}_${pad(counter, 3)}`;
}
function characterFolderName(index) {
  return `Character_${pad(index, 3)}`;
}
var EXT_BY_FORMAT = Object.freeze({ png: "png", jpeg: "jpg", webp: "webp", gif: "gif" });
function imageFileName(index, format, variant = 1) {
  const ext = EXT_BY_FORMAT[format];
  if (!ext) throw new Error(`Неизвестный формат: ${format}`);
  return `${pad(index, 3)}${variant > 1 ? `_${variant}` : ""}.${ext}`;
}
function imagePath({ root, batchFolder, characterIndex, frameIndex, format, variant = 1 }) {
  return [sanitizeRoot(root), batchFolder, characterFolderName(characterIndex), imageFileName(frameIndex, format, variant)].join("/");
}
function characterMetaPath(root, batchFolder, characterIndex, name) {
  return [sanitizeRoot(root), batchFolder, characterFolderName(characterIndex), name].join("/");
}
function batchMetaPath(root, batchFolder, name) {
  return [sanitizeRoot(root), batchFolder, name].join("/");
}
function localDateStamp(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1, 2)}-${pad(d.getDate(), 2)}`;
}

// source/extension/src/lib/validate.js
var isObj2 = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
var ID_RE2 = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
var CTRL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
var HEX64_RE = /^[0-9a-f]{64}$/;
var CORE_KEYS = ["age", "hairColor", "hairLength", "hairType", "eyeColor", "skinTone", "build", "height", "freckles", "features"];
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
var str = (v, max) => typeof v === "string" && v.length <= max;
var isoDate = (v) => typeof v === "string" && v.length <= 40 && !Number.isNaN(Date.parse(v));
function cleanParams(p) {
  const out = {};
  if (!isObj2(p)) return out;
  for (const [k, v] of Object.entries(p).slice(0, 40)) {
    if (!/^[a-z][a-z0-9_]{0,39}$/.test(k)) continue;
    if (v === null || typeof v === "number" && Number.isFinite(v)) out[k] = v;
    else if (typeof v === "string") out[k] = v.slice(0, 200);
  }
  return out;
}
function cleanStyling(s) {
  const out = {};
  if (!isObj2(s)) return out;
  for (const k of ["hairStyle", "makeup", "glasses"]) if (typeof s[k] === "string") out[k] = s[k].slice(0, 40);
  return out;
}
function cleanCore(c) {
  if (c === null) return null;
  if (!isObj2(c)) return void 0;
  const core = {};
  for (const k of CORE_KEYS) {
    if (k === "age") {
      if (!Number.isInteger(c.age) || c.age < 1 || c.age > 120) return void 0;
      core.age = c.age;
    } else if (k === "features") {
      if (!Array.isArray(c.features) || c.features.length > 20 || !c.features.every((x) => str(x, 60))) return void 0;
      core.features = [...c.features];
    } else {
      if (!str(c[k], 40) || !c[k]) return void 0;
      core[k] = c[k];
    }
  }
  return core;
}
async function parseBatch(raw, opts = {}) {
  const maxJobs = opts.maxJobs ?? LIMITS.maxBatchJobs;
  const errors = [];
  const bad = (m) => {
    if (errors.length < 20) errors.push(m);
  };
  if (!isObj2(raw)) return { ok: false, errors: ["Партия должна быть JSON-объектом."] };
  if (raw.schema !== SCHEMA_BATCH) bad(`schema: ожидается «${SCHEMA_BATCH}».`);
  if (typeof raw.batch_id !== "string" || !ID_RE2.test(raw.batch_id)) bad("batch_id: недопустимый идентификатор.");
  if (!isoDate(raw.created_at)) bad("created_at: нужна ISO-дата.");
  const src = isObj2(raw.source) ? raw.source : {};
  const kind = ["bridge", "import", "manual"].includes(src.kind) ? src.kind : null;
  if (!kind) bad("source.kind: bridge|import|manual.");
  if (!Array.isArray(raw.characters) || raw.characters.length < 1 || raw.characters.length > LIMITS.maxCharacters) bad(`characters: от 1 до ${LIMITS.maxCharacters}.`);
  if (errors.length) return { ok: false, errors };
  const characters = [];
  const jobIds = /* @__PURE__ */ new Set();
  const charIds = /* @__PURE__ */ new Set();
  let total = 0;
  for (const [ci, c] of raw.characters.entries()) {
    const where = `characters[${ci}]`;
    if (!isObj2(c)) {
      bad(`${where}: объект.`);
      continue;
    }
    if (typeof c.character_id !== "string" || !ID_RE2.test(c.character_id) || charIds.has(c.character_id)) bad(`${where}.character_id: недопустим или повторяется.`);
    charIds.add(c.character_id);
    if (c.index !== ci + 1) bad(`${where}.index: ожидается ${ci + 1}.`);
    if (!str(c.name, 80) || !c.name) bad(`${where}.name: 1–80 символов.`);
    const identityIn = isObj2(c.identity) ? c.identity : {};
    const core = cleanCore(identityIn.core === void 0 ? null : identityIn.core);
    if (core === void 0) bad(`${where}.identity.core: неверный формат.`);
    if (core === null && kind === "bridge") bad(`${where}.identity.core обязателен для партий с сайта.`);
    let fingerprint = null;
    if (core) {
      const expected = await sha256Hex(canonicalJson(core));
      if (identityIn.fingerprint !== void 0 && identityIn.fingerprint !== null) {
        if (typeof identityIn.fingerprint !== "string" || !HEX64_RE.test(identityIn.fingerprint) || identityIn.fingerprint !== expected) bad(`${where}.identity.fingerprint не совпадает с ядром внешности.`);
      } else if (kind === "bridge") bad(`${where}.identity.fingerprint обязателен.`);
      fingerprint = expected;
    }
    if (!Array.isArray(c.jobs) || c.jobs.length < 1 || c.jobs.length > LIMITS.maxJobsPerCharacter) {
      bad(`${where}.jobs: от 1 до ${LIMITS.maxJobsPerCharacter}.`);
      continue;
    }
    const jobs = [];
    for (const [ji, j] of c.jobs.entries()) {
      const jw = `${where}.jobs[${ji}]`;
      if (!isObj2(j)) {
        bad(`${jw}: объект.`);
        continue;
      }
      const id = j.image_job_id;
      if (typeof id !== "string" || !ID_RE2.test(id) || jobIds.has(id) || !id.startsWith(`${c.character_id}-`)) bad(`${jw}.image_job_id: недопустим, повторяется или не принадлежит персонажу.`);
      jobIds.add(id);
      if (j.index !== ji + 1) bad(`${jw}.index: ожидается ${ji + 1}.`);
      if (typeof j.prompt !== "string" || j.prompt.length < LIMITS.promptMin || j.prompt.length > LIMITS.promptMax || CTRL_RE.test(j.prompt)) bad(`${jw}.prompt: ${LIMITS.promptMin}–${LIMITS.promptMax} символов без управляющих символов.`);
      else if (kind === "bridge" && core && !new RegExp(`\\b${core.age}(?: years old|-year-old)`).test(j.prompt)) bad(`${jw}.prompt не соответствует возрасту персонажа (защита от смешивания идентичностей).`);
      if (j.negative !== null && j.negative !== void 0 && (!str(j.negative, 4e3) || CTRL_RE.test(j.negative))) bad(`${jw}.negative: строка ≤ 4000 или null.`);
      if (j.reference !== null && j.reference !== void 0) bad(`${jw}.reference: передача референса не поддерживается (null).`);
      jobs.push({
        image_job_id: id,
        index: ji + 1,
        prompt: typeof j.prompt === "string" ? j.prompt : "",
        negative: typeof j.negative === "string" ? j.negative : null,
        styling: cleanStyling(j.styling),
        params: cleanParams(j.params),
        reference: null
      });
    }
    total += jobs.length;
    characters.push({
      character_id: c.character_id,
      index: ci + 1,
      name: typeof c.name === "string" ? c.name : `Персонаж ${ci + 1}`,
      seed: typeof c.seed === "string" ? c.seed.slice(0, 80) : "",
      identity: { core: core ?? null, fingerprint, fingerprint_alg: "sha256-canonical-json" },
      notes: Array.isArray(c.notes) ? c.notes.filter((x) => str(x, 300)).slice(0, 5) : [],
      jobs
    });
  }
  if (total > maxJobs) bad(`Всего заданий ${total} — больше лимита ${maxJobs}.`);
  if (errors.length) return { ok: false, errors };
  const spec = isObj2(raw.spec) ? raw.spec : {};
  return {
    ok: true,
    batch: {
      schema: SCHEMA_BATCH,
      batch_id: raw.batch_id,
      created_at: raw.created_at,
      source: { app: str(src.app, 80) ? src.app : "unknown", engine: str(src.engine, 32) ? src.engine : "n/a", bridge: Number.isInteger(src.bridge) ? src.bridge : 0, origin: str(src.origin, 200) ? src.origin : "", kind },
      spec: pickSpec(spec),
      characters
    }
  };
}
function pickSpec(s) {
  const out = {};
  for (const k of ["mode", "strategy", "preset_id", "seed", "profile", "length"]) if (typeof s[k] === "string") out[k] = s[k].slice(0, 80);
  for (const k of ["characters", "frames_per_character"]) if (Number.isInteger(s[k])) out[k] = s[k];
  for (const k of ["include_negative", "use_site_character"]) if (typeof s[k] === "boolean") out[k] = s[k];
  return out;
}
function coreOfSubject(s) {
  if (!isObj2(s)) return null;
  const candidate = {};
  for (const k of CORE_KEYS) candidate[k] = s[k];
  const core = cleanCore(candidate);
  return core ?? null;
}
async function assemble(groups, { text, fileName, now }) {
  const hash = (await sha256Hex(text)).slice(0, 10);
  const batchId = `IMP-${hash}`;
  const characters = [];
  for (const [gi, g] of groups.entries()) {
    const characterId = `${batchId}-C${String(gi + 1).padStart(3, "0")}`;
    characters.push({
      character_id: characterId,
      index: gi + 1,
      name: g.name || `Персонаж ${gi + 1}`,
      seed: "",
      identity: { core: g.core, fingerprint: g.core ? await sha256Hex(canonicalJson(g.core)) : null, fingerprint_alg: "sha256-canonical-json" },
      notes: g.core ? [] : ["Импортировано без паспорта внешности: идентичность не проверяется."],
      jobs: g.jobs.map((j, ji) => ({
        image_job_id: `${characterId}-F${String(ji + 1).padStart(3, "0")}`,
        index: ji + 1,
        prompt: j.prompt,
        negative: j.negative ?? null,
        styling: j.styling ?? {},
        params: j.params ?? {},
        reference: null
      }))
    });
  }
  return parseBatch(
    { schema: SCHEMA_BATCH, batch_id: batchId, created_at: new Date(now).toISOString(), source: { app: "import", engine: "n/a", bridge: 0, origin: `file:${String(fileName ?? "queue").replace(/[^\w.-]+/g, "_").slice(0, 80)}`, kind: "import" }, spec: {}, characters },
    {}
  );
}
function siteItemToJob(item) {
  const sc = isObj2(item.scenario) ? item.scenario : {};
  const prompt = typeof item.mainPrompt === "string" ? item.mainPrompt : "";
  const params = { scenario_id: item.scenarioId, seed: item.seed, mode: item.mode, aspect_ratio: item.aspectRatio, scene_id: sc.sceneId, category: sc.category, season: sc.season, weather: sc.weather ?? null, time: sc.time, capture: sc.capture, framing: sc.framing, angle: sc.angle, emotion: sc.emotion };
  const subj = isObj2(sc.subject) ? sc.subject : {};
  return { prompt, negative: typeof item.negativePrompt === "string" && item.negativePrompt ? item.negativePrompt : null, params: cleanParams(params), styling: cleanStyling(subj), scenario: sc };
}
function groupsFromSiteExport(items) {
  const map = /* @__PURE__ */ new Map();
  for (const item of items.slice(0, LIMITS.maxBatchJobs + 1)) {
    if (!isObj2(item)) continue;
    const j = siteItemToJob(item);
    const core = coreOfSubject(j.scenario.subject);
    const key = typeof j.scenario.characterId === "string" && j.scenario.characterId ? `id:${j.scenario.characterId}` : core ? `core:${canonicalJson(core)}` : "none";
    if (!map.has(key)) map.set(key, { core, name: null, jobs: [] });
    map.get(key).jobs.push(j);
  }
  return [...map.values()];
}
function parseSiteTxt(text) {
  const blocks = text.split(/\n---\n+/).map((b) => b.replace(/^\s*#\d+\s*\n/, "").trim()).filter(Boolean);
  const jobs = [];
  for (const b of blocks) {
    const cut = b.search(/\n\s*\n(?:Seed|Scenario|Aspect ratio|Profile):/);
    let body = cut >= 0 ? b.slice(0, cut) : b;
    let negative = null;
    const neg = /\n\s*\nNegative prompt:\s*([\s\S]*)$/.exec(body);
    if (neg) {
      negative = neg[1].trim();
      body = body.slice(0, neg.index);
    }
    jobs.push({ prompt: body.trim(), negative });
  }
  return jobs;
}
async function parseImport(text, fileName, now = Date.now()) {
  if (typeof text !== "string" || !text.trim()) return { ok: false, errors: ["Файл пуст."] };
  if (text.length > LIMITS.maxImportBytes) return { ok: false, errors: ["Файл слишком большой."] };
  const body = text.replace(/^\uFEFF/, "");
  const trimmed = body.trim();
  try {
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      const data = JSON.parse(trimmed);
      if (isObj2(data) && data.schema === SCHEMA_BATCH) {
        const parsed = await parseBatch(data);
        if (!parsed.ok) return parsed;
        return { ok: true, batch: { ...parsed.batch, source: { ...parsed.batch.source, kind: "import" } } };
      }
      if (isObj2(data) && Array.isArray(data.items)) return assemble(groupsFromSiteExport(data.items), { text: body, fileName, now });
      if (isObj2(data) && typeof data.mainPrompt === "string") return assemble(groupsFromSiteExport([data]), { text: body, fileName, now });
      if (Array.isArray(data)) return assemble(groupsFromList(data), { text: body, fileName, now });
      return { ok: false, errors: ["Неизвестная структура JSON: ожидается экспорт сайта, партия rps-batch/1 или массив промптов."] };
    }
  } catch {
  }
  const lines = trimmed.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length && lines.every((l) => l.trim().startsWith("{"))) {
    try {
      return assemble(groupsFromList(lines.map((l) => JSON.parse(l))), { text: body, fileName, now });
    } catch {
      return { ok: false, errors: ["Некорректная строка JSONL."] };
    }
  }
  if (/\n---\n/.test(trimmed) || /^\s*#\d+\s*$/m.test(trimmed)) {
    const jobs = parseSiteTxt(trimmed);
    if (jobs.length) return assemble([{ core: null, name: null, jobs }], { text: body, fileName, now });
  }
  return assemble([{ core: null, name: null, jobs: lines.map((l) => ({ prompt: l.trim(), negative: null })) }], { text: body, fileName, now });
}
function groupsFromList(list) {
  const map = /* @__PURE__ */ new Map();
  for (const x of list.slice(0, LIMITS.maxBatchJobs + 1)) {
    const prompt = typeof x === "string" ? x : isObj2(x) && typeof x.prompt === "string" ? x.prompt : null;
    if (prompt === null) continue;
    const name = isObj2(x) && typeof x.character === "string" ? x.character.slice(0, 80) : "";
    const key = name || "";
    if (!map.has(key)) map.set(key, { core: null, name: name || null, jobs: [] });
    map.get(key).jobs.push({ prompt: prompt.trim(), negative: isObj2(x) && typeof x.negative === "string" ? x.negative : null, params: isObj2(x) ? cleanParams(x.params) : {}, styling: {} });
  }
  return [...map.values()];
}
function sanitizeSettings(patch, base = DEFAULT_SETTINGS) {
  const errors = [];
  const out = { ...base };
  if (!isObj2(patch)) return { ok: false, errors: ["Настройки должны быть объектом."] };
  for (const [key, val] of Object.entries(patch)) {
    const spec = SETTINGS_SPEC[key];
    if (!spec) continue;
    switch (spec.type) {
      case "bool":
        if (typeof val === "boolean") out[key] = val;
        else errors.push(`${key}: да/нет.`);
        break;
      case "int": {
        const n = typeof val === "string" && val.trim() !== "" ? Number(val) : val;
        if (Number.isInteger(n) && n >= spec.min && n <= spec.max) out[key] = n;
        else errors.push(`${key}: целое от ${spec.min} до ${spec.max}.`);
        break;
      }
      case "enum":
        if (spec.values.includes(val)) out[key] = val;
        else errors.push(`${key}: допустимо ${spec.values.join(", ")}.`);
        break;
      case "text":
        if (typeof val === "string" && val.length <= spec.max && !CTRL_RE.test(val)) out[key] = val;
        else errors.push(`${key}: текст до ${spec.max} символов.`);
        break;
      case "path":
        if (typeof val === "string" && val.length <= 200) out[key] = sanitizeRoot(val, DEFAULT_SETTINGS.rootFolder);
        else errors.push(`${key}: недопустимая папка.`);
        break;
      case "chatUrl":
        if (typeof val === "string" && val.length <= 300 && isChatGptUrl(val)) out[key] = val;
        else errors.push(`${key}: ссылка должна начинаться с https://chatgpt.com/.`);
        break;
      default:
        break;
    }
  }
  if (out.strongConfirmThreshold < out.confirmThreshold) errors.push("strongConfirmThreshold не может быть меньше confirmThreshold.");
  return errors.length ? { ok: false, errors } : { ok: true, settings: out };
}
function isChatGptUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === "https:" && u.hostname === "chatgpt.com" && !u.username && !u.password && !u.port;
  } catch {
    return false;
  }
}
function isAllowedImageUrl(value) {
  try {
    const u = new URL(value);
    if (u.protocol !== "https:" || u.username || u.password) return false;
    return u.hostname === "chatgpt.com" || u.hostname.endsWith(".oaiusercontent.com") || u.hostname === "files.oaiusercontent.com";
  } catch {
    return false;
  }
}

// source/extension/src/background/adapters.js
var CHAT_MATCH = "https://chatgpt.com/*";
var sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function withTimeout(promise, ms, code, message) {
  let timer;
  return Promise.race([promise, new Promise((_, rej) => timer = setTimeout(() => rej(new AdapterError(code, message)), ms))]).finally(() => clearTimeout(timer));
}
function mapTabError(e) {
  if (e instanceof AdapterError) return e;
  const m = String(e?.message ?? e);
  if (/No tab with id|tab was closed|Cannot access|The tab was closed|Frame with ID/i.test(m)) return new AdapterError("TAB_CLOSED", "Вкладка ChatGPT закрыта или недоступна.");
  if (/Receiving end does not exist|message port closed|Could not establish connection/i.test(m)) return new AdapterError("NETWORK", "Страница ChatGPT перезагрузилась или не отвечает; жду восстановления.");
  return new AdapterError("INTERNAL", m.slice(0, 200));
}
function createChatPage() {
  async function findTab(preferredId) {
    const tabs = await chrome.tabs.query({ url: CHAT_MATCH });
    return tabs.find((t) => t.id === preferredId) ?? tabs.find((t) => t.active) ?? tabs[0] ?? null;
  }
  async function ensureInjected(tabId) {
    for (let i = 0; i < 3; i++) {
      try {
        const r = await chrome.tabs.sendMessage(tabId, { rps: 1, type: "CS_PING" });
        if (r?.ok) return r;
      } catch {
      }
      try {
        await chrome.scripting.executeScript({ target: { tabId }, files: ["content/chatgpt.js"] });
      } catch (e) {
        if (/No tab/i.test(String(e?.message))) throw new AdapterError("TAB_CLOSED", "Вкладка ChatGPT закрыта.");
      }
      await sleep(400);
    }
    throw new AdapterError("UI_CHANGED", "Не удалось подключиться к вкладке ChatGPT (content script не отвечает).");
  }
  async function send(tabId, msg, timeoutMs = 3e4) {
    let res;
    try {
      res = await withTimeout(chrome.tabs.sendMessage(tabId, { rps: 1, ...msg }), timeoutMs, "NETWORK", "Вкладка ChatGPT не ответила вовремя.");
    } catch (e) {
      throw mapTabError(e);
    }
    if (!res) throw new AdapterError("UI_CHANGED", "Вкладка ChatGPT не вернула ответ.");
    if (res.ok === false) throw new AdapterError(res.error?.code ?? "INTERNAL", res.error?.message ?? "Ошибка страницы ChatGPT");
    return res;
  }
  return {
    async ensureTab(preferredId) {
      const tab = await findTab(preferredId);
      if (!tab) throw new AdapterError("TAB_NOT_FOUND", "Вкладка ChatGPT не найдена.");
      await ensureInjected(tab.id);
      return { tabId: tab.id, url: tab.url };
    },
    async openChat(tabId, url) {
      if (!isChatGptUrl(url)) throw new AdapterError("INTERNAL", "Недопустимая ссылка беседы.");
      try {
        await chrome.tabs.update(tabId, { url });
      } catch (e) {
        throw mapTabError(e);
      }
      const end = Date.now() + 45e3;
      while (Date.now() < end) {
        await sleep(500);
        let tab;
        try {
          tab = await chrome.tabs.get(tabId);
        } catch (e) {
          throw mapTabError(e);
        }
        if (tab.status !== "complete") continue;
        try {
          const r = await chrome.tabs.sendMessage(tabId, { rps: 1, type: "CS_PING" });
          if (r?.ok && r.ready) return;
        } catch {
          try {
            await chrome.scripting.executeScript({ target: { tabId }, files: ["content/chatgpt.js"] });
          } catch {
          }
        }
      }
      throw new AdapterError("UI_CHANGED", "Страница ChatGPT не загрузилась или интерфейс не распознан.");
    },
    async snapshot(tabId) {
      return (await send(tabId, { type: "CS_SNAPSHOT" })).snapshot;
    },
    submit: (tabId, a) => send(tabId, { type: "CS_SUBMIT", jobId: a.jobId, text: a.text, key: a.key, token: a.token }, 6e4),
    waitSlice: (tabId, a) => send(tabId, { type: "CS_WAIT", key: a.key, baseline: a.baseline ?? null, usedKeys: a.usedKeys ?? [], minSide: a.minSide ?? 0, sliceMs: a.sliceMs ?? 2e4 }, (a.sliceMs ?? 2e4) + 2e4),
    locate: (tabId, a) => send(tabId, { type: "CS_LOCATE", key: a.key, minSide: a.minSide ?? 0, usedKeys: a.usedKeys ?? [] }),
    cancel: (tabId) => send(tabId, { type: "CS_CANCEL" }, 8e3),
    async diagnose(preferredId) {
      const tab = await findTab(preferredId ?? null);
      if (!tab) return { ok: false, items: [], notes: ["Вкладка https://chatgpt.com/ не найдена. Откройте ChatGPT в этом окне Chrome."] };
      await ensureInjected(tab.id);
      const r = await send(tab.id, { type: "CS_DIAGNOSE" });
      return { ok: r.ok === true && Array.isArray(r.items) ? r.ok : false, items: r.items ?? [], notes: r.notes ?? [] };
    },
    async status(preferredId) {
      const tab = await findTab(preferredId ?? null);
      if (!tab) return { tabFound: false };
      let origin = "";
      try {
        const u = new URL(tab.url);
        origin = `${u.origin}${u.pathname}`;
      } catch {
      }
      return { tabFound: true, tabId: tab.id, url: origin, ready: tab.status === "complete", active: Boolean(tab.active) };
    },
    async openOrFocus() {
      const tab = await findTab(null);
      if (tab) {
        await chrome.tabs.update(tab.id, { active: true });
        await chrome.windows.update(tab.windowId, { focused: true });
      } else {
        await chrome.tabs.create({ url: "https://chatgpt.com/" });
      }
    }
  };
}
function createImages() {
  return {
    async fetch(url) {
      if (!isAllowedImageUrl(url)) throw new AdapterError("FETCH_FAILED", "Адрес изображения не входит в список разрешённых (chatgpt.com, *.oaiusercontent.com).");
      let res;
      try {
        res = await fetch(url, { credentials: "include", cache: "no-store", redirect: "follow" });
      } catch (e) {
        if (globalThis.navigator?.onLine === false) throw new AdapterError("NETWORK", "Нет сети при получении изображения.");
        throw new AdapterError("FETCH_FAILED", `Сеть: ${String(e?.message ?? e).slice(0, 120)}`);
      }
      if (res.status === 429) throw new AdapterError("RATE_LIMIT", "Сервер ответил 429 (слишком много запросов).");
      if (!res.ok) throw new AdapterError("FETCH_FAILED", `HTTP ${res.status}`, { status: res.status });
      const type = res.headers.get("content-type") ?? "";
      if (!type.toLowerCase().startsWith("image/")) throw new AdapterError("FETCH_FAILED", `Ожидалось изображение, получено «${type.slice(0, 60)}»`, { status: res.status });
      const len = Number(res.headers.get("content-length") ?? 0);
      if (len > LIMITS.maxImageBytes) throw new AdapterError("FETCH_FAILED", "Файл слишком большой.");
      const buf = new Uint8Array(await res.arrayBuffer());
      if (buf.length > LIMITS.maxImageBytes) throw new AdapterError("FETCH_FAILED", "Файл слишком большой.");
      return { bytes: buf, status: res.status, contentType: type };
    }
  };
}
function createDownloads() {
  const search = async (id) => (await chrome.downloads.search({ id }))[0] ?? null;
  return {
    async start({ url, filename, conflictAction }) {
      try {
        return await chrome.downloads.download({ url, filename, conflictAction, saveAs: false });
      } catch (e) {
        throw new AdapterError("DOWNLOAD_FAILED", `downloads.download отклонён: ${String(e?.message ?? e).slice(0, 160)}`);
      }
    },
    search,
    async waitComplete(id, timeoutMs) {
      const end = Date.now() + timeoutMs;
      for (; ; ) {
        const item = await search(id);
        if (!item) throw new AdapterError("DOWNLOAD_FAILED", "Запись о загрузке исчезла.");
        if (item.state === "complete") return item;
        if (item.state === "interrupted") throw new AdapterError("DOWNLOAD_FAILED", `Загрузка прервана: ${item.error ?? "неизвестная причина"}`);
        if (Date.now() >= end) throw new AdapterError("DOWNLOAD_FAILED", "Тайм-аут загрузки.");
        await sleep(300);
      }
    },
    erase: (id) => chrome.downloads.erase({ id }),
    show: (id) => chrome.downloads.show(id)
  };
}
function createSiteClient(origin) {
  async function findTab() {
    const tabs = await chrome.tabs.query({ url: `${origin}/*` });
    return tabs.find((t) => t.active) ?? tabs[0] ?? null;
  }
  return {
    async call(type, payload) {
      const tab = await findTab();
      if (!tab) throw new AdapterError("SITE_NOT_FOUND", `Откройте ${origin}/ в этом окне Chrome.`);
      const msg = { rps: 1, type: "SITE_CALL", req: { type, ...payload !== void 0 ? { payload } : {} } };
      let res;
      try {
        res = await chrome.tabs.sendMessage(tab.id, msg);
      } catch {
        try {
          await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content/site-bridge.js"] });
          res = await chrome.tabs.sendMessage(tab.id, msg);
        } catch (e) {
          throw new AdapterError("SITE_NOT_FOUND", `Не удалось связаться со вкладкой сайта: ${String(e?.message ?? e).slice(0, 120)}`);
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
    }
  };
}

// source/extension/src/lib/chatgpt-selectors.js
var SELECTORS = Object.freeze({
  composer: ["#prompt-textarea", 'div.ProseMirror[contenteditable="true"]', 'textarea[name="prompt-textarea"]'],
  send: ['button[data-testid="send-button"]', 'button[aria-label="Send prompt"]', 'button[aria-label="Send message"]'],
  stop: ['button[data-testid="stop-button"]', 'button[aria-label="Stop streaming"]', 'button[aria-label^="Stop"]'],
  turn: ['section[data-testid^="conversation-turn-"]', 'article[data-testid^="conversation-turn-"]'],
  roleBlock: ["[data-message-author-role]"],
  // Сгенерированное изображение лежит вне [data-message-author-role] и отдаётся с /backend-api/estuary/content.
  image: ['img[src*="/backend-api/estuary/content"]', 'img[alt^="Generated image"]', 'img[src*=".oaiusercontent.com/"]'],
  loginUi: ['[data-testid="login-button"]', '[data-testid="signup-button"]', 'a[href*="/auth/login"]'],
  captchaUi: ['iframe[src*="challenges.cloudflare.com"]', 'iframe[title*="Cloudflare"]', 'iframe[src*="recaptcha"]', 'iframe[src*="hcaptcha"]', "#challenge-stage", ".cf-turnstile"],
  alert: ['[role="alert"]', '[aria-live="assertive"]', '[data-testid*="toast"]']
});
var PATTERNS = Object.freeze({
  rateLimit: [
    /you['’]ve (?:hit|reached) (?:the |your )?(?:current |free plan )?(?:usage cap|limit)/i,
    /usage cap/i,
    /limit for image/i,
    /image (?:generation|creation)s? limit/i,
    /can create more images when the limit resets/i,
    /wait for your limit to reset/i,
    /rate limit/i,
    /too many requests/i,
    /достигли (?:текущего )?лимита/i,
    /превышен лимит/i,
    /слишком много запросов/i
  ],
  policy: [
    /may violate our (?:content )?polic/i,
    /can['’]?t (?:generate|create) (?:that|this|the) image/i,
    /(?:cannot|can not|unable to|not able to) (?:generate|create) (?:that|this|the) image/i,
    /content polic/i,
    /request was rejected/i,
    /не могу создать (?:это )?изображение/i,
    /нарушает (?:наши )?правила/i
  ],
  genError: [/something went wrong/i, /error generating (?:a )?response/i, /an error occurred/i, /network error/i, /произошла ошибка/i, /что-то пошло не так/i],
  captcha: [/verify you are human/i, /checking if the site connection is secure/i, /подтвердите, что вы не робот/i, /подтвердите, что вы человек/i]
});

// source/extension/src/lib/prompt.js
var normText = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
var NEGATIVE_MARK = /\b(avoid|do not include|negative prompt)\b/i;
function composePrompt(job, settings = {}) {
  let body = String(job.prompt ?? "").trim();
  if (job.negative && !NEGATIVE_MARK.test(body)) body += `

Avoid: ${job.negative}.`;
  return `${settings.promptPrefix ?? ""}${body}${settings.promptSuffix ?? ""}`;
}
function promptKey(text) {
  return normText(text).slice(0, 60);
}

// source/extension/src/lib/chatgpt-classify.js
function matchAny(text, list) {
  for (const re of list) {
    const m = re.exec(text);
    if (m) return m[0];
  }
  return null;
}
function findUserTurn(snap, key) {
  if (!key) return null;
  const turns = snap.turns ?? [];
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i];
    if (t.role === "user" && normText(t.text).startsWith(key)) return t;
  }
  return null;
}
var BLOCK_TEXT = {
  CAPTCHA: "Обнаружена проверка безопасности (CAPTCHA/Cloudflare).",
  AUTH_REQUIRED: "Страница ChatGPT просит войти в аккаунт.",
  RATE_LIMIT: "ChatGPT сообщил об ограничении.",
  UI_CHANGED: "Не найдено поле ввода или кнопка отправки."
};
function analyzeSnapshot(snap, ctx = {}) {
  const out = {
    blocker: null,
    offline: snap.online === false,
    generating: Boolean(snap.hasStop),
    uiMissing: !snap.hasComposer || !snap.hasSend && !snap.hasStop,
    userTurn: null,
    newImages: [],
    smallImages: [],
    loadingImages: 0,
    policy: null,
    genError: null,
    assistantText: "",
    sig: ""
  };
  const block = (code, detail) => {
    if (!out.blocker) out.blocker = { code, message: detail ? `${BLOCK_TEXT[code]} «${String(detail).slice(0, 160)}»` : BLOCK_TEXT[code] };
  };
  if (snap.captchaUi || snap.captchaText) block("CAPTCHA");
  if (snap.loginUi || snap.authUrl) block("AUTH_REQUIRED");
  const turns = snap.turns ?? [];
  const userTurn = ctx.key ? findUserTurn(snap, ctx.key) : null;
  out.userTurn = userTurn;
  const fromIndex = userTurn ? userTurn.i + 1 : ctx.baselineTurnCount ?? Number.POSITIVE_INFINITY;
  const after = turns.filter((t) => t.i >= fromIndex && t.role !== "user");
  out.assistantText = after.map((t) => t.text).join(" ").slice(0, 600);
  const limitHit = matchAny(` ${(snap.alerts ?? []).join(" ")} ${out.assistantText}`, PATTERNS.rateLimit);
  if (limitHit) block("RATE_LIMIT", limitHit);
  const hasImages = after.some((t) => (t.images ?? []).length > 0);
  if (!hasImages) out.policy = matchAny(out.assistantText, PATTERNS.policy);
  out.genError = matchAny((snap.alerts ?? []).join(" "), PATTERNS.genError);
  const baseline = new Set(ctx.baselineKeys ?? []);
  const used = new Set(ctx.usedKeys ?? []);
  const minSide = ctx.minSide ?? 0;
  const seen = /* @__PURE__ */ new Set();
  for (const t of after) {
    for (const img of t.images ?? []) {
      if (seen.has(img.key) || baseline.has(img.key) || used.has(img.key)) continue;
      seen.add(img.key);
      if (!img.complete || !img.w || !img.h) out.loadingImages += 1;
      else if (Math.min(img.w, img.h) < minSide) out.smallImages.push(img);
      else out.newImages.push(img);
    }
  }
  out.sig = [out.generating ? "g" : "i", out.newImages.map((i) => i.key).join(","), out.loadingImages, out.smallImages.length, turns.length, out.assistantText.length].join("|");
  if (ctx.requireUi && out.uiMissing) block("UI_CHANGED");
  return out;
}

// source/extension/src/lib/fsm.js
var TRANSITIONS = Object.freeze({
  idle: ["preparing"],
  preparing: ["submitting", "retryable_error", "blocked", "paused", "failed", "completed", "idle"],
  submitting: ["waiting", "downloading", "retryable_error", "blocked", "paused", "failed", "idle"],
  waiting: ["downloading", "retryable_error", "blocked", "paused", "failed", "idle"],
  downloading: ["verifying", "retryable_error", "blocked", "paused", "failed", "idle"],
  verifying: ["completed", "retryable_error", "failed", "blocked", "paused", "idle"],
  completed: ["preparing", "paused", "idle"],
  retryable_error: ["preparing", "failed", "paused", "blocked", "idle"],
  paused: ["preparing", "idle"],
  blocked: ["preparing", "idle"],
  failed: ["preparing", "paused", "idle"]
});
var canTransition = (from, to) => from === to || (TRANSITIONS[from]?.includes(to) ?? false);
var IllegalTransition = class extends Error {
  constructor(from, to) {
    super(`Недопустимый переход автомата: ${from} → ${to}`);
    this.name = "IllegalTransition";
    this.from = from;
    this.to = to;
  }
};
function assertTransition(from, to) {
  if (!canTransition(from, to)) throw new IllegalTransition(from, to);
}

// source/extension/src/lib/metadata.js
var csvCell = (value) => {
  let v = value === null || value === void 0 ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(v)) v = `'${v}`;
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
};
function dataUrl(text, mime = "application/json") {
  return `data:${mime};charset=utf-8,${encodeURIComponent(text)}`;
}
function jobRecord(job) {
  const r = job.result;
  return {
    image_job_id: job.image_job_id,
    index: job.index,
    status: job.status,
    prompt: job.prompt,
    negative: job.negative,
    params: job.params,
    styling: job.styling,
    file: r?.file ?? null,
    files: r?.files ?? null,
    format: r?.format ?? null,
    bytes: r?.bytes ?? null,
    width: r?.width ?? null,
    height: r?.height ?? null,
    sha256: r?.sha256 ?? null,
    attempts: job.attempts,
    started_at: job.started_at ?? null,
    completed_at: job.completed_at ?? null,
    error: job.error ? { code: job.error.code, message: job.error.message } : null
  };
}
function buildPromptsJsonl(jobs) {
  return jobs.map((j) => JSON.stringify(jobRecord(j))).join("\n") + "\n";
}
function buildCharacterJson(batch, ch) {
  return {
    schema: "rps-character/1",
    batch_id: batch.batch_id,
    character_id: ch.character_id,
    index: ch.index,
    name: ch.name,
    folder: ch.folder,
    seed: ch.seed,
    identity: ch.identity,
    notes: ch.notes,
    frames: ch.job_ids.length,
    note: "identity.core — неизменяемое ядро внешности; изменяемые параметры кадра лежат в prompts.jsonl (params, styling)."
  };
}
function buildManifest(batch, jobsByChar, nowIso) {
  const totals = { total: 0, completed: 0, failed: 0 };
  const characters = batch.characters.map((ch) => {
    const jobs = jobsByChar.get(ch.character_id) ?? [];
    for (const j of jobs) {
      totals.total += 1;
      if (j.status === "completed") totals.completed += 1;
      if (j.status === "failed") totals.failed += 1;
    }
    return {
      character_id: ch.character_id,
      index: ch.index,
      name: ch.name,
      folder: ch.folder,
      identity: ch.identity,
      jobs: jobs.map((j) => ({ image_job_id: j.image_job_id, index: j.index, status: j.status, file: j.result?.file ?? null }))
    };
  });
  return {
    schema: "rps-manifest/1",
    batch_id: batch.batch_id,
    folder: batch.folder,
    kind: batch.kind,
    created_at: batch.created_at,
    updated_at: nowIso,
    source: batch.source,
    spec: batch.spec,
    totals,
    characters
  };
}
var LOG_COLUMNS = ["seq", "ts", "level", "state", "job_id", "code", "message"];
function logToCsv(events) {
  const rows = events.map((e) => LOG_COLUMNS.map((c) => csvCell(e[c])).join(","));
  return `\uFEFF${LOG_COLUMNS.join(",")}\r
${rows.join("\r\n")}\r
`;
}
function logToJson(events, batchId) {
  return JSON.stringify({ app: "RealPhoto ChatGPT Batch", batch_id: batchId, count: events.length, events }, null, 2);
}

// source/extension/src/lib/queue.js
var emptyTotals = () => ({ total: 0, completed: 0, failed: 0, pending: 0, active: 0, retryable: 0 });
function computeTotals(jobs) {
  const t = emptyTotals();
  for (const j of jobs) {
    t.total += 1;
    if (j.status === "completed") t.completed += 1;
    else if (j.status === "failed") t.failed += 1;
    else if (j.status === "pending") t.pending += 1;
    else if (j.status === "retryable_error") t.retryable += 1;
    else if (IN_FLIGHT.has(j.status)) t.active += 1;
  }
  return t;
}
function nextCounter(meta, dateStr, kind) {
  const key = `${kind}:${dateStr}`;
  const n = (meta.day_counters?.[key] ?? 0) + 1;
  return { n, meta: { ...meta, day_counters: { ...meta.day_counters ?? {}, [key]: n } } };
}
function createBatchState(batch, { folder, kind, nowIso }) {
  const jobs = [];
  const characters = batch.characters.map((c) => {
    const job_ids = [];
    for (const j of c.jobs) {
      job_ids.push(j.image_job_id);
      jobs.push({
        image_job_id: j.image_job_id,
        batch_id: batch.batch_id,
        character_id: c.character_id,
        character_index: c.index,
        index: j.index,
        global_index: jobs.length + 1,
        prompt: j.prompt,
        negative: j.negative,
        styling: j.styling,
        params: j.params,
        status: "pending",
        attempts: 0,
        error: null,
        submitted: null,
        candidates: null,
        downloads: null,
        result: null,
        retry_at: 0,
        started_at: null,
        completed_at: null,
        created_at: nowIso,
        updated_at: nowIso
      });
    }
    return { character_id: c.character_id, index: c.index, name: c.name, seed: c.seed, identity: c.identity, notes: c.notes, folder: characterFolderName(c.index), job_ids };
  });
  const header = {
    batch_id: batch.batch_id,
    kind,
    status: "ready",
    folder,
    created_at: batch.created_at,
    added_at: nowIso,
    source: batch.source,
    spec: batch.spec,
    characters,
    totals: computeTotals(jobs)
  };
  return { header, jobs };
}
function pickNextJob(jobsOrdered, nowMs) {
  let waitUntil = null;
  for (const j of jobsOrdered) if (IN_FLIGHT.has(j.status)) return { job: j, waitUntil: null };
  for (const j of jobsOrdered) {
    if (j.status === "pending") return { job: j, waitUntil: null };
    if (j.status === "retryable_error") {
      if ((j.retry_at ?? 0) <= nowMs) return { job: j, waitUntil: null };
      waitUntil = waitUntil === null ? j.retry_at : Math.min(waitUntil, j.retry_at);
    }
  }
  return { job: null, waitUntil };
}
var hasPendingWork = (jobs) => jobs.some((j) => j.status === "pending" || j.status === "retryable_error" || IN_FLIGHT.has(j.status));

// source/extension/src/lib/retry.js
function backoffMs(attempt, baseMs = 15e3, maxMs = 3e5) {
  return Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
}
function networkBackoffMs(failures) {
  return Math.min(12e4, 1e4 * 2 ** Math.max(0, Math.min(failures, 4) - 1));
}

// source/extension/src/background/orchestrator.js
var SLICE_MS = 2e4;
var REDOWNLOAD_CODES = ["DOWNLOAD_FAILED", "SIZE_MISMATCH", "FETCH_FAILED"];
var iso = (ms) => new Date(ms).toISOString();
var ev = (level, code, message, data) => ({ level, code, message, ...data ? { data } : {} });
var Orchestrator = class {
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
  async init({ reason = "wake" } = {}) {
    await this.store.load();
    if (reason === "browser-startup" || reason === "extension-update") await this.#pauseAfterRestart(reason);
    else if (reason !== "hydrate" && ACTIVE_STATES.has(this.store.runner.state)) this.kick();
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
    const halted = reason === "browser-startup" ? "BROWSER_RESTART" : "EXTENSION_UPDATE";
    await this.#go("paused", {
      job: job && IN_FLIGHT.has(job.status) ? job : null,
      jobStatus: "pending",
      runnerPatch: { halted, pause_requested: false },
      events: [ev("warn", halted, "Очередь приостановлена после перезапуска. Нажмите «Продолжить»: расширение найдёт уже отправленный промпт и не создаст дубликат.")]
    });
    this.#notify("paused", "Очередь приостановлена", "Chrome или расширение были перезапущены. Нажмите «Продолжить» в панели расширения.");
  }
  // ───────── команды пользователя ─────────
  async addBatch(batch, { kind = "batch" } = {}) {
    const st = this.store;
    let b = batch;
    if (kind === "test") {
      const c = b.characters[0];
      b = retag({ ...b, characters: [{ ...c, jobs: [c.jobs[0]] }] }, `${b.batch_id.slice(0, 40)}-T${this.now().toString(36)}`);
    }
    const existing = st.getBatch(b.batch_id);
    const total = b.characters.reduce((n2, c) => n2 + c.jobs.length, 0);
    if (existing) {
      await st.commit({ meta: { ...st.meta, selected_batch_id: b.batch_id } });
      return { batch_id: b.batch_id, total, characters: b.characters.length, frames: b.characters[0].jobs.length, folder: existing.folder, existed: true };
    }
    if (total > LIMITS.maxBatchJobs) throw new CommandError("BATCH_TOO_LARGE", `Партия больше лимита ${LIMITS.maxBatchJobs} изображений.`);
    const t = this.now();
    const { n, meta } = nextCounter(st.meta, localDateStamp(t), kind);
    const folder = batchFolderName(localDateStamp(t), n, kind);
    const { header, jobs } = createBatchState(b, { folder, kind, nowIso: iso(t) });
    header.root = sanitizeRoot(st.settings.rootFolder);
    await st.commit({
      meta: { ...meta, selected_batch_id: b.batch_id },
      batches: { [b.batch_id]: header },
      jobs: Object.fromEntries(jobs.map((j) => [j.image_job_id, j])),
      events: [{ batch_id: b.batch_id, ...ev("info", "BATCH_ADDED", `Партия добавлена: ${total} изображений, папка ${folder}`) }]
    });
    return { batch_id: b.batch_id, total, characters: b.characters.length, frames: b.characters[0].jobs.length, folder, existed: false };
  }
  async start(batchId, confirm = {}) {
    const st = this.store;
    const r = st.runner;
    if (r.state === "paused" || r.state === "blocked") throw new CommandError("USE_RESUME", "Очередь на паузе или остановлена: используйте «Продолжить».");
    if (!["idle", "completed", "failed"].includes(r.state)) throw new CommandError("BUSY", "Очередь уже работает.");
    const batch = st.getBatch(batchId);
    if (!batch) throw new CommandError("NOT_FOUND", "Партия не найдена.");
    const jobs = st.jobsOf(batchId);
    const totals = computeTotals(jobs);
    if (totals.pending + totals.retryable + totals.active === 0) throw new CommandError("NOTHING_TO_DO", "В партии нет заданий для запуска.");
    if (totals.total > LIMITS.maxBatchJobs) throw new CommandError("BATCH_TOO_LARGE", `Партия больше лимита ${LIMITS.maxBatchJobs}.`);
    if (totals.total > st.settings.confirmThreshold && confirm?.acknowledged !== true) throw new CommandError("CONFIRM_REQUIRED", `Партия из ${totals.total} изображений требует подтверждения.`);
    if (totals.total > st.settings.strongConfirmThreshold && confirm?.typed_total !== totals.total) throw new CommandError("CONFIRM_MISMATCH", `Введите число ${totals.total} для подтверждения большой партии.`);
    await this.#begin(batch, "START", `Запуск: ${totals.total - totals.completed - totals.failed} заданий`);
  }
  async #begin(batch, code, message) {
    const st = this.store;
    const r = st.runner;
    assertTransition(r.state, "preparing");
    await st.commit({
      runner: { ...defaultRunner(), rev: r.rev, state: "preparing", batch_id: batch.batch_id, phase_started_at: this.now(), policy_streak: 0 },
      batches: { [batch.batch_id]: { ...batch, status: "running" } },
      meta: { ...st.meta, selected_batch_id: batch.batch_id },
      events: [{ batch_id: batch.batch_id, state: "preparing", ...ev("info", code, message) }]
    });
    this.kick();
  }
  async resume() {
    const st = this.store;
    const r = st.runner;
    const resumable = r.state === "paused" || r.state === "blocked" || r.state === "failed" && r.failure_kind !== "job" || r.state === "idle" && r.halted && r.batch_id;
    if (!resumable) throw new CommandError("NOT_RESUMABLE", "Нечего продолжать.");
    const batch = st.getBatch(r.batch_id);
    if (!batch) throw new CommandError("NOT_FOUND", "Партия не найдена.");
    await this.#go("preparing", {
      runnerPatch: { pause_requested: false, halted: null, block: null, failure_kind: null, network_since: 0, network_failures: 0, retry_at: 0 },
      batchPatch: { status: "running" },
      events: [ev("info", "RESUME", "Продолжение очереди")]
    });
    this.kick();
  }
  async pause() {
    const st = this.store;
    const r = st.runner;
    if (!["preparing", "submitting", "waiting", "downloading", "verifying", "retryable_error", "completed", "failed"].includes(r.state)) throw new CommandError("NOT_RUNNING", "Очередь не выполняется.");
    await st.commit({ runner: { ...r, pause_requested: true }, events: [{ batch_id: r.batch_id, state: r.state, ...ev("info", "PAUSE_REQUESTED", "Пауза после завершения текущего изображения") }] });
    this.kick();
  }
  async stop() {
    const r = this.store.runner;
    if (r.state === "idle") throw new CommandError("NOT_RUNNING", "Очередь не выполняется.");
    await this.#halt("USER_STOP", "STOP", "Остановлено пользователем");
  }
  async emergencyStop() {
    const r = this.store.runner;
    this.#clearWake();
    const tabId = r.chat?.tabId;
    if (r.state !== "idle") await this.#halt("EMERGENCY", "EMERGENCY_STOP", "АВАРИЙНАЯ ОСТАНОВКА");
    if (tabId != null) {
      try {
        await this.d.page.cancel(tabId);
      } catch {
      }
    }
  }
  async #halt(halted, code, message) {
    const st = this.store;
    const r = st.runner;
    const job = r.job_id ? st.getJob(r.job_id) : null;
    const batch = r.batch_id ? st.getBatch(r.batch_id) : null;
    await this.#go("idle", {
      job: job && IN_FLIGHT.has(job.status) ? job : null,
      jobStatus: "pending",
      runnerPatch: { halted, pause_requested: false, block: null, retry_at: 0 },
      batchPatch: batch ? { status: "stopped" } : void 0,
      events: [ev("warn", code, message)]
    });
    if (batch) void this.#flushMetadata(batch.batch_id).catch(() => {
    });
    this.#notify("stopped", "Очередь остановлена", message);
  }
  async retryFailed(batchId) {
    const st = this.store;
    const r = st.runner;
    const batch = st.getBatch(batchId);
    if (!batch) throw new CommandError("NOT_FOUND", "Партия не найдена.");
    if (["preparing", "submitting", "waiting", "downloading", "verifying", "retryable_error"].includes(r.state) && r.batch_id === batchId) throw new CommandError("BUSY", "Дождитесь паузы или остановки очереди.");
    const jobs = st.jobsOf(batchId).filter((j) => j.status === "failed");
    if (!jobs.length) throw new CommandError("NOTHING_TO_DO", "Ошибочных заданий нет.");
    const t = iso(this.now());
    const patch = {};
    for (const j of jobs) patch[j.image_job_id] = { ...j, status: "pending", attempts: 0, download_attempts: 0, downloads: null, error: null, retry_at: 0, updated_at: t, completed_at: null };
    await st.commit({ jobs: patch, batches: { [batchId]: { ...batch, status: "ready" } }, events: [{ batch_id: batchId, ...ev("info", "RETRY_FAILED", `Сброшено ошибочных заданий: ${jobs.length}`) }] });
    if (["idle", "completed", "failed"].includes(st.runner.state) && st.runner.state !== "failed") await this.#begin(st.getBatch(batchId), "START", "Повтор ошибочных заданий");
    else if (st.runner.state === "failed") await this.#begin(st.getBatch(batchId), "START", "Повтор ошибочных заданий");
  }
  async selectBatch(id) {
    const st = this.store;
    if (!st.getBatch(id)) throw new CommandError("NOT_FOUND", "Партия не найдена.");
    await st.commit({ meta: { ...st.meta, selected_batch_id: id } });
  }
  async deleteBatch(id) {
    const st = this.store;
    const r = st.runner;
    if (!st.getBatch(id)) throw new CommandError("NOT_FOUND", "Партия не найдена.");
    if (r.batch_id === id && !["idle", "completed"].includes(r.state)) throw new CommandError("BUSY", "Нельзя удалить выполняющуюся партию.");
    const change = { removeBatch: id, meta: { ...st.meta, selected_batch_id: st.meta.selected_batch_id === id ? null : st.meta.selected_batch_id } };
    if (r.batch_id === id) change.runner = { ...defaultRunner(), rev: r.rev };
    await st.commit(change);
  }
  async updateSettings(patch) {
    const res = sanitizeSettings(patch, this.store.settings);
    if (!res.ok) throw new CommandError("BAD_SETTINGS", res.errors.join(" "));
    await this.store.commit({ settings: res.settings });
    return res.settings;
  }
  exportLog(batchId, format) {
    const st = this.store;
    if (!st.getBatch(batchId)) throw new CommandError("NOT_FOUND", "Партия не найдена.");
    const events = st.events(batchId, Number.MAX_SAFE_INTEGER);
    return format === "csv" ? { filename: `rps-log-${batchId}.csv`, mime: "text/csv", text: logToCsv(events) } : { filename: `rps-log-${batchId}.json`, mime: "application/json", text: logToJson(events, batchId) };
  }
  // ───────── представление для панели ─────────
  getView({ site: site2, chatgpt } = {}) {
    const st = this.store;
    const r = st.runner;
    const selected = st.meta.selected_batch_id ?? r.batch_id;
    const header = selected ? st.getBatch(selected) : null;
    const batches = [...st.batches.values()].sort((a, b) => String(b.added_at).localeCompare(String(a.added_at))).map((h) => {
      const t = computeTotals(st.jobsOf(h.batch_id));
      return { batch_id: h.batch_id, folder: h.folder, kind: h.kind, status: h.status, created_at: h.created_at, total: t.total, completed: t.completed, failed: t.failed };
    });
    return {
      version: 1,
      runner: { state: r.state, batch_id: r.batch_id, job_id: r.job_id, phase_started_at: r.phase_started_at, next_allowed_at: r.next_allowed_at, retry_at: r.retry_at, pause_requested: r.pause_requested, halted: r.halted, block: r.block, chat: r.chat },
      batch: header ? this.#batchView(header) : null,
      batches,
      settings: { ...st.settings, maxBatchJobs: LIMITS.maxBatchJobs },
      site: site2 ?? { connected: false },
      chatgpt: chatgpt ?? { tabFound: false },
      events: header ? st.events(header.batch_id, 80) : []
    };
  }
  #batchView(h) {
    const st = this.store;
    const jobs = st.jobsOf(h.batch_id);
    const byChar = /* @__PURE__ */ new Map();
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
          completed: list.filter((j) => j.status === "completed").length,
          failed: list.filter((j) => j.status === "failed").length,
          jobs: list.map((j) => ({ index: j.index, image_job_id: j.image_job_id, status: j.status, attempts: j.attempts, file: j.result?.file ?? null, error_code: j.error?.code ?? null }))
        };
      })
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
        for (let guard = 0; guard < 2e3; guard++) if (!await this.#step()) break;
      } while (this.again);
    } catch (e) {
      if (!(e instanceof IllegalTransition)) await this.#fatal(e);
    } finally {
      this.ticking = false;
    }
  }
  async #step() {
    switch (this.store.runner.state) {
      case "preparing":
        return this.#prepare();
      case "submitting":
        return this.#submit();
      case "waiting":
        return this.#wait();
      case "downloading":
        return this.#download();
      case "verifying":
        return this.#verify();
      case "completed":
        return this.#afterCompleted();
      case "retryable_error":
        return this.#afterRetryable();
      case "failed":
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
    }, Math.max(50, Math.min(ms, 25e3)));
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
      const status = jobStatus ?? (IN_FLIGHT.has(to) || to === "completed" || to === "retryable_error" ? to : job.status);
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
      await this.#go("idle", { runnerPatch: { batch_id: null, job_id: null } });
      return false;
    }
    if (r0.pause_requested) return this.#pauseNow("Пауза (до отправки следующего промпта)");
    const jobs = st.jobsOf(batch.batch_id);
    const { job, waitUntil } = pickNextJob(jobs, this.now());
    if (!job) {
      if (waitUntil !== null) {
        await this.#go("retryable_error", { runnerPatch: { retry_at: waitUntil }, events: [ev("info", "WAIT_RETRY", "Ожидание времени повтора")] });
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
    const resumeDownload = job.resume_from === "downloading" && job.candidates?.length;
    let chat = { ...r0.chat ?? {}, tabId: tab.tabId };
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
        if (a.offline) throw new AdapterError("NETWORK", "Браузер сообщает об отсутствии сети.");
        if (a.blocker) throw new AdapterError(a.blocker.code, a.blocker.message);
        if (a.generating && !job.submitted) {
          if (t - r0.phase_started_at < 9e4) {
            this.#wake(3e3);
            return false;
          }
          throw new AdapterError("PAGE_BUSY", "Генерация в ChatGPT не завершилась за 90 секунд.");
        }
      }
    } catch (e) {
      if (this.#stale(r0)) return true;
      await this.#handleError(e, { job });
      return true;
    }
    if (this.#stale(r0)) return true;
    const fresh = !job.submitted && !resumeDownload;
    await this.#go("submitting", {
      job,
      jobStatus: "submitting",
      jobPatch: { started_at: job.started_at ?? iso(t), attempts: fresh ? job.attempts + 1 : job.attempts, submit_seq: fresh ? (job.submit_seq ?? 0) + 1 : job.submit_seq ?? 0, error: null },
      runnerPatch: { job_id: job.image_job_id, chat, failure_kind: null },
      batchPatch: { status: "running" },
      events: [ev("info", "JOB_START", `Кадр ${job.index} персонажа ${job.character_index}${fresh && job.attempts > 0 ? ` — попытка ${job.attempts + 1}` : ""}`)]
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
      await this.#go("idle", { runnerPatch: { job_id: null } });
      return false;
    }
    if (job.resume_from === "downloading" && job.candidates?.length) {
      await this.#go("downloading", { job, jobStatus: "downloading", events: [ev("info", "RESUME_DOWNLOAD", "Повторная загрузка без повторной генерации")] });
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
          await this.#go("downloading", { job, jobStatus: "downloading", jobPatch: { candidates: loc.images, downloads: null, resume_from: "downloading" }, events: [ev("info", "REATTACH", "Изображение найдено в беседе — повторная отправка не нужна")] });
          return true;
        }
        if (loc.found && (job.submitted || loc.generating)) {
          await this.#go("waiting", {
            job,
            jobStatus: "waiting",
            jobPatch: job.submitted ? {} : { submitted: { at: iso(this.now()), token: `${job.image_job_id}#${job.submit_seq ?? 0}`, baseline: null, chat_url: loc.url ?? null, user_turn_index: loc.userTurnIndex ?? null }, error: null },
            runnerPatch: { last_progress_at: this.now(), progress_sig: null },
            events: [ev("info", "REATTACH", "Промпт уже отправлен — продолжаю ожидание без повторной отправки")]
          });
          return true;
        }
      }
      const token = `${job.image_job_id}#${job.submit_seq ?? 0}`;
      const res = await this.d.page.submit(tabId, { jobId: job.image_job_id, text, key, token });
      if (this.#stale(r0)) return true;
      if (!res?.accepted) throw new AdapterError("PROMPT_NOT_ACCEPTED", "Сообщение не появилось в беседе.");
      await this.#go("waiting", {
        job,
        jobStatus: "waiting",
        jobPatch: { submitted: { at: iso(this.now()), token, baseline: res.baseline ?? null, chat_url: res.url ?? null, user_turn_index: res.userTurnIndex ?? null }, error: null },
        runnerPatch: { last_progress_at: this.now(), progress_sig: null, chat: { ...r0.chat, url: res.url ?? r0.chat.url } },
        events: [ev("info", "SUBMITTED", "Промпт отправлен в ChatGPT")]
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
      await this.#go("idle", { runnerPatch: { job_id: null } });
      return false;
    }
    const t0 = this.now();
    if (t0 - r0.phase_started_at > s.jobTimeoutSec * 1e3) {
      await this.#handleError(new AdapterError("TIMEOUT", `Нет результата за ${s.jobTimeoutSec} с`), { job });
      return true;
    }
    if (t0 - r0.last_progress_at > s.stallTimeoutSec * 1e3) {
      await this.#handleError(new AdapterError("STALLED", `Нет изменений в интерфейсе ${s.stallTimeoutSec} с`), { job });
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
      case "pending": {
        const spent = this.now() - t0;
        if (res.sig !== r0.progress_sig) await st.commit({ runner: { ...st.runner, progress_sig: res.sig, last_progress_at: this.now() } });
        if (spent < 500) await this.d.sleep(500 - spent);
        return true;
      }
      case "done": {
        if (!res.images?.length) {
          await this.#handleError(new AdapterError("NO_IMAGE", "Изображение не найдено."), { job });
          return true;
        }
        await this.#go("downloading", {
          job,
          jobStatus: "downloading",
          jobPatch: { candidates: res.images.map(({ key: k, src, alt, w, h }) => ({ key: k, src, alt, w, h })), downloads: null, resume_from: "downloading" },
          events: [ev("info", "IMAGE_READY", `Изображений найдено: ${res.images.length}`)]
        });
        return true;
      }
      case "blocked":
        await this.#block(res.code, res.message, { job, keepSubmitted: res.code !== "RATE_LIMIT" });
        return true;
      case "error":
        await this.#handleError({ code: res.code, message: res.message }, { job });
        return true;
      default:
        await this.#handleError(new AdapterError("INTERNAL", "Неизвестный ответ страницы."), { job });
        return true;
    }
  }
  #chooseCandidates(list, policy) {
    if (!list.length) return { error: "NO_IMAGE" };
    if (list.length === 1) return { list };
    if (policy === "first") return { list: [list[0]] };
    if (policy === "all") return { list };
    return { error: "MULTIPLE_IMAGES" };
  }
  async #download() {
    const st = this.store;
    const r0 = st.runner;
    const s = st.settings;
    let job = st.getJob(r0.job_id);
    const batch = st.getBatch(r0.batch_id);
    if (!job || !batch) {
      await this.#go("idle", { runnerPatch: { job_id: null } });
      return false;
    }
    const choice = this.#chooseCandidates(job.candidates ?? [], s.multiImagePolicy);
    if (choice.error) {
      await this.#handleError(new AdapterError(choice.error, errInfo(choice.error).ru), { job });
      return true;
    }
    const downloads2 = [...job.downloads ?? []];
    try {
      for (const [k, cand] of choice.list.entries()) {
        if (downloads2[k]?.state === "complete") continue;
        const fetched = await this.d.images.fetch(cand.src);
        const info = sniffImage(fetched.bytes);
        if (!info) throw new AdapterError("UNSUPPORTED_IMAGE_FORMAT", "Не удалось определить формат изображения.");
        if (s.minImageSide > 0 && Math.min(info.width, info.height) < s.minImageSide) {
          throw new AdapterError("PREVIEW_ONLY", `Размер ${info.width}×${info.height} меньше минимума ${s.minImageSide}px`);
        }
        const sha = await sha256Hex(fetched.bytes);
        const owner = this.#dupOwner(batch.batch_id, sha, job.image_job_id);
        if (owner) {
          job = await this.#putJob(job, { rejected_keys: [...job.rejected_keys ?? [], cand.key] });
          throw new AdapterError("DUPLICATE_IMAGE", `Это изображение уже сохранено для ${owner}`);
        }
        const filename = imagePath({ root: batch.root, batchFolder: batch.folder, characterIndex: job.character_index, frameIndex: job.index, format: info.format, variant: k + 1 });
        const id = await this.d.downloads.start({ url: cand.src, filename, conflictAction: "overwrite" });
        downloads2[k] = { key: cand.key, filename, id, bytes: fetched.bytes.length, sha256: sha, format: info.format, width: info.width, height: info.height, state: "started" };
        job = await this.#putJob(job, { downloads: downloads2 });
        await this.d.downloads.waitComplete(id, 12e4);
        downloads2[k] = { ...downloads2[k], state: "complete" };
        job = await this.#putJob(job, { downloads: downloads2 });
        if (this.#stale(r0)) return true;
      }
    } catch (e) {
      if (this.#stale(r0)) return true;
      if (e instanceof AdapterError && e.code === "FETCH_FAILED" && [401, 403, 404, 410].includes(e.status)) {
        job = await this.#putJob(job, { candidates: null, downloads: null, resume_from: null, submitted: null });
      }
      await this.#handleError(e, { job });
      return true;
    }
    await this.#go("verifying", { job, jobStatus: "verifying", jobPatch: { downloads: downloads2 }, events: [ev("info", "DOWNLOADED", `Файлов сохранено: ${downloads2.length}`)] });
    return true;
  }
  async #verify() {
    const st = this.store;
    const r0 = st.runner;
    const s = st.settings;
    const job = st.getJob(r0.job_id);
    const batch = st.getBatch(r0.batch_id);
    if (!job || !batch) {
      await this.#go("idle", { runnerPatch: { job_id: null } });
      return false;
    }
    const downloads2 = job.downloads ?? [];
    try {
      if (!downloads2.length) throw new AdapterError("DOWNLOAD_FAILED", "Нет сведений о загрузке.");
      for (const d of downloads2) {
        const item = await this.d.downloads.search(d.id);
        if (!item || item.state !== "complete" || item.exists === false) throw new AdapterError("DOWNLOAD_FAILED", `Файл ${d.filename} не найден или загрузка не завершена.`);
        if (item.fileSize !== d.bytes) throw new AdapterError("SIZE_MISMATCH", `Размер файла ${item.fileSize} ≠ ${d.bytes}`);
      }
    } catch (e) {
      if (this.#stale(r0)) return true;
      await this.#handleError(e, { job });
      return true;
    }
    if (this.#stale(r0)) return true;
    const t = this.now();
    const first = downloads2[0];
    const result = { file: first.filename, files: downloads2.map((d) => d.filename), bytes: first.bytes, format: first.format, width: first.width, height: first.height, sha256: first.sha256, hashes: downloads2.map((d) => d.sha256), keys: downloads2.map((d) => d.key), download_id: first.id, saved_at: iso(t) };
    await this.#go("completed", {
      job,
      jobStatus: "completed",
      jobPatch: { result, error: null, completed_at: iso(t), submitted: null, candidates: null, resume_from: null },
      runnerPatch: { next_allowed_at: t + s.intervalSec * 1e3, policy_streak: 0, network_since: 0, network_failures: 0, chat: { ...r0.chat, framesInChat: (r0.chat?.framesInChat ?? 0) + 1 } },
      events: [ev("info", "JOB_DONE", `Сохранено: ${result.file} (${result.width}×${result.height}, ${result.bytes} Б)`)]
    });
    await this.#writeMetadata(batch.batch_id, job.character_id, { manifest: this.#manifestDue(batch.batch_id, job.character_id) }).catch(() => {
    });
    return true;
  }
  async #afterCompleted() {
    const st = this.store;
    const r = st.runner;
    const batch = st.getBatch(r.batch_id);
    if (!batch) return false;
    const jobs = st.jobsOf(batch.batch_id);
    if (!hasPendingWork(jobs)) return this.#finishBatch(batch, jobs);
    if (r.pause_requested) return this.#pauseNow("Пауза после завершения изображения");
    const wait = r.next_allowed_at - this.now();
    if (wait > 0) {
      this.#wake(wait);
      return false;
    }
    await this.#go("preparing", { runnerPatch: { job_id: null } });
    return true;
  }
  async #afterRetryable() {
    const st = this.store;
    const r = st.runner;
    if (r.pause_requested) return this.#pauseNow("Пауза (ожидание повтора)");
    const wait = r.retry_at - this.now();
    if (wait > 0) {
      this.#wake(wait);
      return false;
    }
    await this.#go("preparing", {});
    return true;
  }
  async #afterFailed() {
    const st = this.store;
    const r = st.runner;
    if (r.failure_kind !== "job") return false;
    if (r.pause_requested) return this.#pauseNow("Пауза после ошибки задания");
    const wait = r.next_allowed_at - this.now();
    if (wait > 0) {
      this.#wake(wait);
      return false;
    }
    await this.#go("preparing", { runnerPatch: { job_id: null, failure_kind: null } });
    return true;
  }
  async #pauseNow(message) {
    const r = this.store.runner;
    const job = r.job_id ? this.store.getJob(r.job_id) : null;
    await this.#go("paused", { job: job && IN_FLIGHT.has(job.status) ? job : null, jobStatus: "pending", runnerPatch: { pause_requested: false, halted: null }, events: [ev("info", "PAUSED", message)] });
    if (r.batch_id) await this.#flushMetadata(r.batch_id).catch(() => {
    });
    return false;
  }
  async #finishBatch(batch, jobs) {
    const st = this.store;
    if (batch.status === "completed" && st.runner.state === "completed") return false;
    const totals = computeTotals(jobs);
    await this.#go("completed", {
      runnerPatch: { job_id: null },
      batchPatch: { status: "completed" },
      events: [ev("info", "BATCH_DONE", `Партия завершена: готово ${totals.completed} из ${totals.total}, ошибок ${totals.failed}`)]
    });
    await this.#flushMetadata(batch.batch_id).catch(() => {
    });
    this.#notify("completed", "Партия завершена", `Готово ${totals.completed} из ${totals.total}, ошибок ${totals.failed}.`);
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
    for (const j of this.store.jobsOf(batchId)) if (j.image_job_id !== jobId && j.status === "completed" && j.result?.hashes?.includes(sha)) return j.image_job_id;
    return null;
  }
  // ───────── ошибки ─────────
  async #handleError(err, { job = null, keepSubmitted = true } = {}) {
    const code = typeof err?.code === "string" && Object.hasOwn(ERR, err.code) ? err.code : "INTERNAL";
    const info = errInfo(code);
    const detail = err?.message && err.message !== code ? err.message : info.ru;
    const cur = job ?? (this.store.runner.job_id ? this.store.getJob(this.store.runner.job_id) : null);
    switch (info.kind) {
      case "blocking":
        return this.#block(code, detail, { job: cur, keepSubmitted });
      case "network":
        return this.#networkError(detail, cur);
      case "retry":
        return this.#retryOrFail(code, detail, cur);
      default:
        return this.#failJob(code, detail, cur);
    }
  }
  async #block(code, detail, { job = null, keepSubmitted = true } = {}) {
    const info = errInfo(code);
    const message = detail && detail !== info.ru ? `${info.ru} (${detail})` : info.ru;
    const cur = job ?? (this.store.runner.job_id ? this.store.getJob(this.store.runner.job_id) : null);
    await this.#go("blocked", {
      job: cur,
      jobStatus: cur && IN_FLIGHT.has(cur.status) ? "pending" : cur?.status,
      jobPatch: cur ? { error: { code, message: info.ru }, submitted: keepSubmitted ? cur.submitted : null, ...keepSubmitted ? {} : { attempts: Math.max(0, cur.attempts - 1) } } : {},
      runnerPatch: { block: { code, message, at: iso(this.now()) }, pause_requested: false, job_id: cur?.image_job_id ?? this.store.runner.job_id },
      events: [ev("error", code, message)]
    });
    this.#notify("blocked", "Очередь остановлена", message);
    return true;
  }
  async #networkError(detail, job) {
    const st = this.store;
    const r = st.runner;
    const t = this.now();
    const since = r.network_since || t;
    const failures = (r.network_failures ?? 0) + 1;
    if (t - since > st.settings.networkGiveUpSec * 1e3) return this.#block("OFFLINE", detail, { job });
    const retryAt = t + networkBackoffMs(failures);
    await this.#go("retryable_error", {
      job,
      jobStatus: "retryable_error",
      jobPatch: job ? { error: { code: "NETWORK", message: detail }, retry_at: retryAt } : {},
      runnerPatch: { retry_at: retryAt, network_since: since, network_failures: failures, job_id: job?.image_job_id ?? r.job_id },
      events: [ev("warn", "NETWORK", `${detail} Повтор через ${Math.round((retryAt - t) / 1e3)} с (попытка не расходуется)`)]
    });
    return true;
  }
  async #retryOrFail(code, detail, job) {
    const st = this.store;
    if (!job) return this.#failJob(code, detail, job);
    const redownload = REDOWNLOAD_CODES.includes(code) && Boolean(job.candidates?.length);
    const used = redownload ? (job.download_attempts ?? 0) + 1 : job.attempts;
    if (used >= st.settings.maxAttempts) return this.#failJob(code, `${detail} (попытки исчерпаны: ${used})`, job);
    if (code === "STALLED" || code === "TIMEOUT") await this.#stopStuckGeneration();
    const t = this.now();
    const retryAt = t + backoffMs(used);
    await this.#go("retryable_error", {
      job,
      jobStatus: "retryable_error",
      jobPatch: { error: { code, message: detail }, retry_at: retryAt, submitted: null, ...redownload ? { download_attempts: used, downloads: null } : { candidates: null, downloads: null, resume_from: null } },
      runnerPatch: { retry_at: retryAt, job_id: job.image_job_id },
      events: [ev("warn", code, `${detail} Повтор через ${Math.round((retryAt - t) / 1e3)} с (попытка ${used} из ${st.settings.maxAttempts})`)]
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
    }
  }
  async #failJob(code, detail, job) {
    const st = this.store;
    const r = st.runner;
    const t = this.now();
    const streak = code === "CONTENT_POLICY" ? (r.policy_streak ?? 0) + 1 : 0;
    const message = detail || errInfo(code).ru;
    if (code === "STALLED" || code === "TIMEOUT") await this.#stopStuckGeneration();
    if (!job) {
      await this.#go("failed", { runnerPatch: { failure_kind: "fatal", policy_streak: streak }, events: [ev("error", code, message)] });
      return true;
    }
    const jobPatch = { error: { code, message }, completed_at: iso(t), submitted: null, downloads: null, ...code === "MULTIPLE_IMAGES" || REDOWNLOAD_CODES.includes(code) ? {} : { resume_from: null, candidates: null } };
    const stopNow = code === "CONTENT_POLICY" && streak >= st.settings.stopAfterPolicyRefusals;
    if (stopNow) {
      const text = `Подряд отклонено заданий: ${streak}. Проверьте пресет и промпты. ${errInfo("CONTENT_POLICY").ru}`;
      await this.#go("blocked", {
        job,
        jobStatus: "failed",
        jobPatch,
        runnerPatch: { block: { code: "CONTENT_POLICY", message: text, at: iso(t) }, policy_streak: streak, pause_requested: false, job_id: job.image_job_id },
        events: [ev("error", code, `Задание не выполнено: ${message}`), ev("error", "CONTENT_POLICY", text)]
      });
      this.#notify("blocked", "Очередь остановлена", text);
    } else {
      await this.#go("failed", {
        job,
        jobStatus: "failed",
        jobPatch,
        runnerPatch: { failure_kind: "job", next_allowed_at: t + st.settings.intervalSec * 1e3, policy_streak: streak, job_id: job.image_job_id },
        events: [ev("error", code, `Задание не выполнено: ${message}`)]
      });
    }
    await this.#writeMetadata(job.batch_id, job.character_id, { manifest: this.#manifestDue(job.batch_id, job.character_id) }).catch(() => {
    });
    return true;
  }
  async #fatal(e) {
    try {
      const st = this.store;
      const r = st.runner;
      const job = r.job_id ? st.getJob(r.job_id) : null;
      await this.#go("failed", {
        job: job && IN_FLIGHT.has(job.status) ? job : null,
        jobStatus: "pending",
        runnerPatch: { failure_kind: "fatal" },
        events: [ev("error", "INTERNAL", `Внутренняя ошибка: ${String(e?.message ?? e).slice(0, 300)}`)]
      });
      this.#notify("failed", "Ошибка расширения", String(e?.message ?? e).slice(0, 200));
    } catch {
    }
  }
  // ───────── метаданные на диске ─────────
  /** manifest.json пишется по завершении персонажа и раз в 25 готовых заданий (не после каждого кадра). */
  #manifestDue(batchId, characterId) {
    const jobs = this.store.jobsOf(batchId);
    const own = jobs.filter((j) => j.character_id === characterId);
    if (own.every((j) => j.status === "completed" || j.status === "failed")) return true;
    return jobs.filter((j) => j.status === "completed").length % 25 === 0;
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
    const byChar = /* @__PURE__ */ new Map();
    for (const j of jobs) {
      if (!byChar.has(j.character_id)) byChar.set(j.character_id, []);
      byChar.get(j.character_id).push(j);
    }
    const ch = characterId ? batch.characters.find((c) => c.character_id === characterId) : null;
    const files = [];
    if (ch) {
      const list = byChar.get(ch.character_id) ?? [];
      files.push([characterMetaPath(batch.root, batch.folder, ch.index, "prompts.jsonl"), buildPromptsJsonl(list), "application/x-ndjson"]);
      if (character || list.filter((j) => j.status === "completed").length <= 1) files.push([characterMetaPath(batch.root, batch.folder, ch.index, "character.json"), JSON.stringify(buildCharacterJson(batch, ch), null, 2), "application/json"]);
    }
    if (manifest) files.push([batchMetaPath(batch.root, batch.folder, "manifest.json"), JSON.stringify(buildManifest(batch, byChar, iso(this.now())), null, 2), "application/json"]);
    for (const [filename, text, mime] of files) {
      try {
        const id = await this.d.downloads.start({ url: dataUrl(text, mime), filename, conflictAction: "overwrite" });
        await this.d.downloads.waitComplete(id, 2e4);
        await this.d.downloads.erase?.(id);
      } catch (e) {
        await st.commit({ events: [{ batch_id: batchId, state: st.runner.state, ...ev("warn", "METADATA_FAILED", `Не удалось записать ${filename}: ${String(e?.message ?? e).slice(0, 120)}`) }] });
      }
    }
  }
};
function retag(batch, newId) {
  const old = batch.batch_id;
  const re = (s) => newId + s.slice(old.length);
  return {
    ...batch,
    batch_id: newId,
    characters: batch.characters.map((c) => ({ ...c, character_id: re(c.character_id), jobs: c.jobs.map((j) => ({ ...j, image_job_id: re(j.image_job_id) })) }))
  };
}

// source/extension/src/background/index.js
var SITE_ORIGIN = "https://promts.vibecods.xyz";
var EXT_URL = chrome.runtime.getURL("");
var store = new Store(chrome.storage.local);
var chatPage = createChatPage();
var site = createSiteClient(SITE_ORIGIN);
var downloads = createDownloads();
function notify(kind, title, message) {
  chrome.notifications.create(`rps-${kind}-${Date.now()}`, { type: "basic", iconUrl: chrome.runtime.getURL("icons/icon128.png"), title, message: String(message).slice(0, 250), priority: kind === "blocked" || kind === "failed" ? 2 : 0 }).catch?.(() => {
  });
}
var orch = new Orchestrator({
  store,
  now: () => Date.now(),
  setTimeout: (f, ms) => setTimeout(f, ms),
  clearTimeout: (h) => clearTimeout(h),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  page: chatPage,
  images: createImages(),
  downloads,
  notify
});
var boot = orch.init({ reason: "hydrate" }).catch((e) => console.error("[rps] init failed", e));
var woken = false;
async function wake() {
  await boot;
  if (woken) return;
  woken = true;
  if (ACTIVE_STATES.has(store.runner.state)) orch.kick();
}
var lastSite = { connected: false };
var ports = /* @__PURE__ */ new Set();
var pushTimer = null;
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
        p.postMessage({ type: "VIEW", view: v });
      } catch {
        ports.delete(p);
      }
    }
  }, 150);
}
var alarmOn = false;
var badge = "";
function syncSideEffects() {
  const state = store.runner.state;
  const active = ACTIVE_STATES.has(state);
  if (active && !alarmOn) {
    chrome.alarms.create("rps-watchdog", { periodInMinutes: 0.5 });
    alarmOn = true;
  } else if (!active && alarmOn) {
    chrome.alarms.clear("rps-watchdog");
    alarmOn = false;
  }
  const next = state === "blocked" ? "!" : state === "paused" ? "II" : active && state !== "completed" ? "▶" : "";
  if (next !== badge) {
    badge = next;
    chrome.action.setBadgeText({ text: next });
    chrome.action.setBadgeBackgroundColor({ color: state === "blocked" ? "#c62828" : "#2e7d32" });
  }
}
store.onChange(() => {
  syncSideEffects();
  schedulePush();
});
var toError = (e) => ({ code: typeof e?.code === "string" ? e.code : "INTERNAL", message: String(e?.message ?? e).slice(0, 400) });
var viewResp = async () => ({ view: await view() });
async function siteStatus() {
  try {
    const { tab, res } = await site.call("hello");
    if (!res?.ok) throw new AdapterError(res?.error?.code ?? "SITE_ERROR", res?.error?.message ?? "Мост сайта не отвечает. Сайт нужно обновить (см. docs/04-SERVER-SETUP.md).");
    const p = res.payload ?? {};
    lastSite = { connected: true, tabId: tab.id, origin: SITE_ORIGIN, engine: String(p.engine ?? ""), bridge_version: p.bridge_version ?? null, limits: p.limits ?? null, site_character: p.site_character === true, profiles: Array.isArray(p.profiles) ? p.profiles : null, lengths: Array.isArray(p.lengths) ? p.lengths : null };
  } catch (e) {
    lastSite = { connected: false, reason: toError(e).message };
  }
  schedulePush();
  return lastSite;
}
async function addParsed(parsed, test) {
  if (!parsed.ok) throw new CommandError("BAD_BATCH", `Партия не прошла проверку: ${parsed.errors.slice(0, 3).join(" ")}`);
  return { summary: await orch.addBatch(parsed.batch, { kind: test ? "test" : "batch" }) };
}
var handlers = {
  GET_VIEW: viewResp,
  SITE_STATUS: async () => ({ site: await siteStatus() }),
  SITE_LIST_PRESETS: async () => {
    const { res } = await site.call("list-presets");
    if (!res?.ok) throw new CommandError(res?.error?.code ?? "SITE_ERROR", res?.error?.message ?? "Не удалось получить пресеты.");
    return { presets: (res.payload?.presets ?? []).slice(0, 80).map((p) => ({ id: String(p.id), name: String(p.name).slice(0, 80), description: String(p.description ?? "").slice(0, 200), builtin: p.builtin === true })) };
  },
  SITE_CREATE_BATCH: async (m) => {
    let params = cleanCreateParams(m.params);
    if (!params) throw new CommandError("BAD_PARAMS", "Некорректные параметры партии.");
    if (m.test) params = { ...params, mode: "single", characters: 1, frames_per_character: 1 };
    const { res } = await site.call("create-batch", params);
    if (!res?.ok) throw new CommandError(res?.error?.code ?? "SITE_ERROR", res?.error?.message ?? "Сайт не смог создать партию.");
    const parsed = await parseBatch(res.payload?.batch);
    if (parsed.ok && parsed.batch.source.origin !== SITE_ORIGIN) throw new CommandError("BAD_BATCH", "Партия пришла не с ожидаемого сайта.");
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
    if (!job?.result?.download_id && job?.result?.download_id !== 0) throw new CommandError("NOT_FOUND", "Файл ещё не сохранён.");
    downloads.show(job.result.download_id);
    return {};
  },
  GET_EVENTS: async (m) => ({ events: store.events(m.batch_id, m.limit ?? 100) }),
  EXPORT_LOG: async (m) => orch.exportLog(m.batch_id, m.format)
};
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  if (msg?.type === "SITE_PROGRESS" && msg.rps === 1) {
    if (!sender.tab || !String(sender.url ?? "").startsWith(`${SITE_ORIGIN}/`)) return false;
    for (const p of ports) p.postMessage({ type: "SITE_PROGRESS", done: Number(msg.done) || 0, total: Number(msg.total) || 0 });
    return false;
  }
  if (!String(sender.url ?? "").startsWith(EXT_URL)) return false;
  const v = validatePanelMessage(msg);
  if (!v.ok) {
    sendResponse({ ok: false, error: v.error });
    return false;
  }
  (async () => {
    await boot;
    await wake();
    return handlers[msg.type](msg);
  })().then((data) => sendResponse({ ok: true, ...data })).catch((e) => sendResponse({ ok: false, error: toError(e) }));
  return true;
});
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "rps-panel" || port.sender?.id !== chrome.runtime.id || !String(port.sender?.url ?? "").startsWith(EXT_URL)) {
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
  await orch.notifyRestart("browser-startup");
  chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true });
});
chrome.runtime.onInstalled.addListener(async (details) => {
  await boot;
  chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true });
  if (details.reason === "update") {
    woken = true;
    await orch.notifyRestart("extension-update");
  }
});
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== "rps-watchdog") return;
  await wake();
  orch.kick();
});
chrome.tabs.onRemoved.addListener(async (tabId) => {
  await wake();
  orch.onTabRemoved(tabId);
  schedulePush();
});
chrome.tabs.onUpdated.addListener((_id, info) => {
  if (info.status === "complete" || info.url) schedulePush();
});
chrome.tabs.onActivated.addListener(() => schedulePush());
syncSideEffects();
