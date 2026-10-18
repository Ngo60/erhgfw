// Строгая проверка сообщений между панелью, service worker и content scripts (контракт: docs/02-CONTRACT.md §7).

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

const T = {
  id: { t: 'id' },
  idOpt: { t: 'id', opt: true },
  obj: { t: 'obj' },
  boolOpt: { t: 'bool', opt: true },
};

export const PANEL_TYPES = Object.freeze({
  GET_VIEW: {},
  SITE_STATUS: {},
  SITE_LIST_PRESETS: {},
  SITE_CREATE_BATCH: { params: T.obj, test: T.boolOpt },
  IMPORT_BATCH: { text: { t: 'str', max: 15 * 1024 * 1024 }, fileName: { t: 'str', max: 200 }, test: T.boolOpt },
  START: { batch_id: T.id, confirm: { t: 'obj', opt: true } },
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
  GET_EVENTS: { batch_id: T.id, limit: { t: 'int', min: 1, max: 500, opt: true } },
  EXPORT_LOG: { batch_id: T.id, format: { t: 'enum', values: ['json', 'csv'] } },
});

export const CS_TYPES = Object.freeze({
  CS_PING: {},
  CS_SNAPSHOT: {},
  CS_SUBMIT: { jobId: T.id, text: { t: 'str', max: 20000 }, key: { t: 'str', max: 400 }, token: { t: 'str', max: 200 } },
  CS_WAIT: {
    key: { t: 'str', max: 400 },
    baseline: { t: 'obj', opt: true, nullable: true },
    usedKeys: { t: 'arr', max: 8000, opt: true },
    minSide: { t: 'int', min: 0, max: 4096, opt: true },
    sliceMs: { t: 'int', min: 500, max: 30000, opt: true },
  },
  CS_LOCATE: { key: { t: 'str', max: 400 }, minSide: { t: 'int', min: 0, max: 4096, opt: true }, usedKeys: { t: 'arr', max: 8000, opt: true } },
  CS_CANCEL: {},
  CS_DIAGNOSE: {},
});

export const SITE_CALL_TYPES = Object.freeze(['hello', 'list-presets', 'create-batch', 'cancel']);

function check(spec, value) {
  if (value === undefined) return spec.opt === true;
  if (value === null) return spec.nullable === true;
  switch (spec.t) {
    case 'id':
      return typeof value === 'string' && ID_RE.test(value);
    case 'str':
      return typeof value === 'string' && value.length <= (spec.max ?? 1000);
    case 'bool':
      return typeof value === 'boolean';
    case 'int':
      return Number.isInteger(value) && value >= (spec.min ?? -Infinity) && value <= (spec.max ?? Infinity);
    case 'enum':
      return spec.values.includes(value);
    case 'obj':
      return isObj(value);
    case 'arr':
      return Array.isArray(value) && value.length <= (spec.max ?? 1000) && value.every((x) => typeof x === 'string' && x.length <= 300);
    default:
      return false;
  }
}

/** @returns {{ok:true,type:string}|{ok:false,error:{code:string,message:string}}} */
export function validateMessage(msg, table) {
  if (!isObj(msg) || msg.rps !== 1 || typeof msg.type !== 'string' || !Object.hasOwn(table, msg.type)) return { ok: false, error: { code: 'BAD_MESSAGE', message: 'Неизвестное или некорректное сообщение.' } };
  const spec = table[msg.type];
  for (const [field, s] of Object.entries(spec)) if (!check(s, msg[field])) return { ok: false, error: { code: 'BAD_MESSAGE', message: `Некорректное поле «${field}» в сообщении ${msg.type}.` } };
  return { ok: true, type: msg.type };
}

export const validatePanelMessage = (msg) => validateMessage(msg, PANEL_TYPES);
export const validateCsMessage = (msg) => validateMessage(msg, CS_TYPES);

/** Параметры create-batch: только известные поля нужных типов (остальное отбрасывается). */
export function cleanCreateParams(p) {
  if (!isObj(p)) return null;
  const mode = p.mode === 'single' || p.mode === 'multi' ? p.mode : null;
  const strategy = p.strategy === 'series' || p.strategy === 'character' ? p.strategy : null;
  if (!mode || !strategy) return null;
  const idOrNull = (v) => (v === null || v === undefined || v === '' ? null : typeof v === 'string' && /^[A-Za-z0-9._~:-]{1,64}$/.test(v) ? v : undefined);
  const preset = idOrNull(p.preset_id);
  const seed = idOrNull(p.seed);
  if (preset === undefined || seed === undefined) return null;
  const characters = mode === 'single' ? 1 : p.characters;
  if (!Number.isInteger(characters) || !Number.isInteger(p.frames_per_character)) return null;
  if (typeof p.profile !== 'string' || typeof p.length !== 'string') return null;
  return { mode, characters, frames_per_character: p.frames_per_character, strategy, preset_id: preset, seed, profile: p.profile, length: p.length, include_negative: p.include_negative !== false, use_site_character: p.use_site_character === true };
}
