// Строгая проверка входных данных: партии (мост/импорт) и настройки. Возвращает очищенные копии без лишних полей.
import { DEFAULT_SETTINGS, LIMITS, SCHEMA_BATCH, SETTINGS_SPEC } from './constants.js';
import { sha256Hex } from './image.js';
import { sanitizeRoot } from './naming.js';

export const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const CTRL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const HEX64_RE = /^[0-9a-f]{64}$/;
export const CORE_KEYS = ['age', 'hairColor', 'hairLength', 'hairType', 'eyeColor', 'skinTone', 'build', 'height', 'freckles', 'features'];

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

const str = (v, max) => typeof v === 'string' && v.length <= max;
const isoDate = (v) => typeof v === 'string' && v.length <= 40 && !Number.isNaN(Date.parse(v));

function cleanParams(p) {
  const out = {};
  if (!isObj(p)) return out;
  for (const [k, v] of Object.entries(p).slice(0, 40)) {
    if (!/^[a-z][a-z0-9_]{0,39}$/.test(k)) continue;
    if (v === null || typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    else if (typeof v === 'string') out[k] = v.slice(0, 200);
  }
  return out;
}

function cleanStyling(s) {
  const out = {};
  if (!isObj(s)) return out;
  for (const k of ['hairStyle', 'makeup', 'glasses']) if (typeof s[k] === 'string') out[k] = s[k].slice(0, 40);
  return out;
}

function cleanCore(c) {
  if (c === null) return null;
  if (!isObj(c)) return undefined;
  const core = {};
  for (const k of CORE_KEYS) {
    if (k === 'age') {
      if (!Number.isInteger(c.age) || c.age < 1 || c.age > 120) return undefined;
      core.age = c.age;
    } else if (k === 'features') {
      if (!Array.isArray(c.features) || c.features.length > 20 || !c.features.every((x) => str(x, 60))) return undefined;
      core.features = [...c.features];
    } else {
      if (!str(c[k], 40) || !c[k]) return undefined;
      core[k] = c[k];
    }
  }
  return core;
}

/**
 * Проверка и нормализация партии rps-batch/1.
 * @returns {Promise<{ok:true,batch:object}|{ok:false,errors:string[]}>}
 */
export async function parseBatch(raw, opts = {}) {
  const maxJobs = opts.maxJobs ?? LIMITS.maxBatchJobs;
  const errors = [];
  const bad = (m) => {
    if (errors.length < 20) errors.push(m);
  };
  if (!isObj(raw)) return { ok: false, errors: ['Партия должна быть JSON-объектом.'] };
  if (raw.schema !== SCHEMA_BATCH) bad(`schema: ожидается «${SCHEMA_BATCH}».`);
  if (typeof raw.batch_id !== 'string' || !ID_RE.test(raw.batch_id)) bad('batch_id: недопустимый идентификатор.');
  if (!isoDate(raw.created_at)) bad('created_at: нужна ISO-дата.');
  const src = isObj(raw.source) ? raw.source : {};
  const kind = ['bridge', 'import', 'manual'].includes(src.kind) ? src.kind : null;
  if (!kind) bad('source.kind: bridge|import|manual.');
  if (!Array.isArray(raw.characters) || raw.characters.length < 1 || raw.characters.length > LIMITS.maxCharacters) bad(`characters: от 1 до ${LIMITS.maxCharacters}.`);
  if (errors.length) return { ok: false, errors };

  const characters = [];
  const jobIds = new Set();
  const charIds = new Set();
  let total = 0;
  for (const [ci, c] of raw.characters.entries()) {
    const where = `characters[${ci}]`;
    if (!isObj(c)) {
      bad(`${where}: объект.`);
      continue;
    }
    if (typeof c.character_id !== 'string' || !ID_RE.test(c.character_id) || charIds.has(c.character_id)) bad(`${where}.character_id: недопустим или повторяется.`);
    charIds.add(c.character_id);
    if (c.index !== ci + 1) bad(`${where}.index: ожидается ${ci + 1}.`);
    if (!str(c.name, 80) || !c.name) bad(`${where}.name: 1–80 символов.`);
    const identityIn = isObj(c.identity) ? c.identity : {};
    const core = cleanCore(identityIn.core === undefined ? null : identityIn.core);
    if (core === undefined) bad(`${where}.identity.core: неверный формат.`);
    if (core === null && kind === 'bridge') bad(`${where}.identity.core обязателен для партий с сайта.`);
    let fingerprint = null;
    if (core) {
      const expected = await sha256Hex(canonicalJson(core));
      if (identityIn.fingerprint !== undefined && identityIn.fingerprint !== null) {
        if (typeof identityIn.fingerprint !== 'string' || !HEX64_RE.test(identityIn.fingerprint) || identityIn.fingerprint !== expected) bad(`${where}.identity.fingerprint не совпадает с ядром внешности.`);
      } else if (kind === 'bridge') bad(`${where}.identity.fingerprint обязателен.`);
      fingerprint = expected;
    }
    if (!Array.isArray(c.jobs) || c.jobs.length < 1 || c.jobs.length > LIMITS.maxJobsPerCharacter) {
      bad(`${where}.jobs: от 1 до ${LIMITS.maxJobsPerCharacter}.`);
      continue;
    }
    const jobs = [];
    for (const [ji, j] of c.jobs.entries()) {
      const jw = `${where}.jobs[${ji}]`;
      if (!isObj(j)) {
        bad(`${jw}: объект.`);
        continue;
      }
      const id = j.image_job_id;
      if (typeof id !== 'string' || !ID_RE.test(id) || jobIds.has(id) || !id.startsWith(`${c.character_id}-`)) bad(`${jw}.image_job_id: недопустим, повторяется или не принадлежит персонажу.`);
      jobIds.add(id);
      if (j.index !== ji + 1) bad(`${jw}.index: ожидается ${ji + 1}.`);
      if (typeof j.prompt !== 'string' || j.prompt.length < LIMITS.promptMin || j.prompt.length > LIMITS.promptMax || CTRL_RE.test(j.prompt)) bad(`${jw}.prompt: ${LIMITS.promptMin}–${LIMITS.promptMax} символов без управляющих символов.`);
      else if (kind === 'bridge' && core && !new RegExp(`\\b${core.age}(?: years old|-year-old)`).test(j.prompt)) bad(`${jw}.prompt не соответствует возрасту персонажа (защита от смешивания идентичностей).`);
      if (j.negative !== null && j.negative !== undefined && (!str(j.negative, 4000) || CTRL_RE.test(j.negative))) bad(`${jw}.negative: строка ≤ 4000 или null.`);
      if (j.reference !== null && j.reference !== undefined) bad(`${jw}.reference: передача референса не поддерживается (null).`);
      jobs.push({
        image_job_id: id,
        index: ji + 1,
        prompt: typeof j.prompt === 'string' ? j.prompt : '',
        negative: typeof j.negative === 'string' ? j.negative : null,
        styling: cleanStyling(j.styling),
        params: cleanParams(j.params),
        reference: null,
      });
    }
    total += jobs.length;
    characters.push({
      character_id: c.character_id,
      index: ci + 1,
      name: typeof c.name === 'string' ? c.name : `Персонаж ${ci + 1}`,
      seed: typeof c.seed === 'string' ? c.seed.slice(0, 80) : '',
      identity: { core: core ?? null, fingerprint, fingerprint_alg: 'sha256-canonical-json' },
      notes: Array.isArray(c.notes) ? c.notes.filter((x) => str(x, 300)).slice(0, 5) : [],
      jobs,
    });
  }
  if (total > maxJobs) bad(`Всего заданий ${total} — больше лимита ${maxJobs}.`);
  if (errors.length) return { ok: false, errors };

  const spec = isObj(raw.spec) ? raw.spec : {};
  return {
    ok: true,
    batch: {
      schema: SCHEMA_BATCH,
      batch_id: raw.batch_id,
      created_at: raw.created_at,
      source: { app: str(src.app, 80) ? src.app : 'unknown', engine: str(src.engine, 32) ? src.engine : 'n/a', bridge: Number.isInteger(src.bridge) ? src.bridge : 0, origin: str(src.origin, 200) ? src.origin : '', kind },
      spec: pickSpec(spec),
      characters,
    },
  };
}

function pickSpec(s) {
  const out = {};
  for (const k of ['mode', 'strategy', 'preset_id', 'seed', 'profile', 'length']) if (typeof s[k] === 'string') out[k] = s[k].slice(0, 80);
  for (const k of ['characters', 'frames_per_character']) if (Number.isInteger(s[k])) out[k] = s[k];
  for (const k of ['include_negative', 'use_site_character']) if (typeof s[k] === 'boolean') out[k] = s[k];
  return out;
}

// ───────── Импорт (режим C) ─────────

function coreOfSubject(s) {
  if (!isObj(s)) return null;
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
    const characterId = `${batchId}-C${String(gi + 1).padStart(3, '0')}`;
    characters.push({
      character_id: characterId,
      index: gi + 1,
      name: g.name || `Персонаж ${gi + 1}`,
      seed: '',
      identity: { core: g.core, fingerprint: g.core ? await sha256Hex(canonicalJson(g.core)) : null, fingerprint_alg: 'sha256-canonical-json' },
      notes: g.core ? [] : ['Импортировано без паспорта внешности: идентичность не проверяется.'],
      jobs: g.jobs.map((j, ji) => ({
        image_job_id: `${characterId}-F${String(ji + 1).padStart(3, '0')}`,
        index: ji + 1,
        prompt: j.prompt,
        negative: j.negative ?? null,
        styling: j.styling ?? {},
        params: j.params ?? {},
        reference: null,
      })),
    });
  }
  return parseBatch(
    { schema: SCHEMA_BATCH, batch_id: batchId, created_at: new Date(now).toISOString(), source: { app: 'import', engine: 'n/a', bridge: 0, origin: `file:${String(fileName ?? 'queue').replace(/[^\w.-]+/g, '_').slice(0, 80)}`, kind: 'import' }, spec: {}, characters },
    {},
  );
}

function siteItemToJob(item) {
  const sc = isObj(item.scenario) ? item.scenario : {};
  const prompt = typeof item.mainPrompt === 'string' ? item.mainPrompt : '';
  const params = { scenario_id: item.scenarioId, seed: item.seed, mode: item.mode, aspect_ratio: item.aspectRatio, scene_id: sc.sceneId, category: sc.category, season: sc.season, weather: sc.weather ?? null, time: sc.time, capture: sc.capture, framing: sc.framing, angle: sc.angle, emotion: sc.emotion };
  const subj = isObj(sc.subject) ? sc.subject : {};
  return { prompt, negative: typeof item.negativePrompt === 'string' && item.negativePrompt ? item.negativePrompt : null, params: cleanParams(params), styling: cleanStyling(subj), scenario: sc };
}

/** Экспорт сайта (entriesToJson/entryToJson) → группы по персонажу. */
function groupsFromSiteExport(items) {
  const map = new Map();
  for (const item of items.slice(0, LIMITS.maxBatchJobs + 1)) {
    if (!isObj(item)) continue;
    const j = siteItemToJob(item);
    const core = coreOfSubject(j.scenario.subject);
    const key = typeof j.scenario.characterId === 'string' && j.scenario.characterId ? `id:${j.scenario.characterId}` : core ? `core:${canonicalJson(core)}` : 'none';
    if (!map.has(key)) map.set(key, { core, name: null, jobs: [] });
    map.get(key).jobs.push(j);
  }
  return [...map.values()];
}

function parseSiteTxt(text) {
  const blocks = text.split(/\n---\n+/).map((b) => b.replace(/^\s*#\d+\s*\n/, '').trim()).filter(Boolean);
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

/**
 * Импорт из файла: JSON-экспорт сайта, партия rps-batch/1, JSON-массив, JSONL, TXT.
 * @returns {Promise<{ok:true,batch:object}|{ok:false,errors:string[]}>}
 */
export async function parseImport(text, fileName, now = Date.now()) {
  if (typeof text !== 'string' || !text.trim()) return { ok: false, errors: ['Файл пуст.'] };
  if (text.length > LIMITS.maxImportBytes) return { ok: false, errors: ['Файл слишком большой.'] };
  const body = text.replace(/^\uFEFF/, '');
  const trimmed = body.trim();
  try {
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      const data = JSON.parse(trimmed);
      if (isObj(data) && data.schema === SCHEMA_BATCH) {
        const parsed = await parseBatch(data);
        if (!parsed.ok) return parsed;
        return { ok: true, batch: { ...parsed.batch, source: { ...parsed.batch.source, kind: 'import' } } };
      }
      if (isObj(data) && Array.isArray(data.items)) return assemble(groupsFromSiteExport(data.items), { text: body, fileName, now });
      if (isObj(data) && typeof data.mainPrompt === 'string') return assemble(groupsFromSiteExport([data]), { text: body, fileName, now });
      if (Array.isArray(data)) return assemble(groupsFromList(data), { text: body, fileName, now });
      return { ok: false, errors: ['Неизвестная структура JSON: ожидается экспорт сайта, партия rps-batch/1 или массив промптов.'] };
    }
  } catch {
    // не JSON целиком — пробуем JSONL/TXT
  }
  const lines = trimmed.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length && lines.every((l) => l.trim().startsWith('{'))) {
    try {
      return assemble(groupsFromList(lines.map((l) => JSON.parse(l))), { text: body, fileName, now });
    } catch {
      return { ok: false, errors: ['Некорректная строка JSONL.'] };
    }
  }
  if (/\n---\n/.test(trimmed) || /^\s*#\d+\s*$/m.test(trimmed)) {
    const jobs = parseSiteTxt(trimmed);
    if (jobs.length) return assemble([{ core: null, name: null, jobs }], { text: body, fileName, now });
  }
  return assemble([{ core: null, name: null, jobs: lines.map((l) => ({ prompt: l.trim(), negative: null })) }], { text: body, fileName, now });
}

function groupsFromList(list) {
  const map = new Map();
  for (const x of list.slice(0, LIMITS.maxBatchJobs + 1)) {
    const prompt = typeof x === 'string' ? x : isObj(x) && typeof x.prompt === 'string' ? x.prompt : null;
    if (prompt === null) continue;
    const name = isObj(x) && typeof x.character === 'string' ? x.character.slice(0, 80) : '';
    const key = name || '';
    if (!map.has(key)) map.set(key, { core: null, name: name || null, jobs: [] });
    map.get(key).jobs.push({ prompt: prompt.trim(), negative: isObj(x) && typeof x.negative === 'string' ? x.negative : null, params: isObj(x) ? cleanParams(x.params) : {}, styling: {} });
  }
  return [...map.values()];
}

// ───────── Настройки ─────────

/** @returns {{ok:true,settings:object}|{ok:false,errors:string[]}} */
export function sanitizeSettings(patch, base = DEFAULT_SETTINGS) {
  const errors = [];
  const out = { ...base };
  if (!isObj(patch)) return { ok: false, errors: ['Настройки должны быть объектом.'] };
  for (const [key, val] of Object.entries(patch)) {
    const spec = SETTINGS_SPEC[key];
    if (!spec) continue;
    switch (spec.type) {
      case 'bool':
        if (typeof val === 'boolean') out[key] = val;
        else errors.push(`${key}: да/нет.`);
        break;
      case 'int': {
        const n = typeof val === 'string' && val.trim() !== '' ? Number(val) : val;
        if (Number.isInteger(n) && n >= spec.min && n <= spec.max) out[key] = n;
        else errors.push(`${key}: целое от ${spec.min} до ${spec.max}.`);
        break;
      }
      case 'enum':
        if (spec.values.includes(val)) out[key] = val;
        else errors.push(`${key}: допустимо ${spec.values.join(', ')}.`);
        break;
      case 'text':
        if (typeof val === 'string' && val.length <= spec.max && !CTRL_RE.test(val)) out[key] = val;
        else errors.push(`${key}: текст до ${spec.max} символов.`);
        break;
      case 'path':
        if (typeof val === 'string' && val.length <= 200) out[key] = sanitizeRoot(val, DEFAULT_SETTINGS.rootFolder);
        else errors.push(`${key}: недопустимая папка.`);
        break;
      case 'chatUrl':
        if (typeof val === 'string' && val.length <= 300 && isChatGptUrl(val)) out[key] = val;
        else errors.push(`${key}: ссылка должна начинаться с https://chatgpt.com/.`);
        break;
      default:
        break;
    }
  }
  if (out.strongConfirmThreshold < out.confirmThreshold) errors.push('strongConfirmThreshold не может быть меньше confirmThreshold.');
  return errors.length ? { ok: false, errors } : { ok: true, settings: out };
}

export function isChatGptUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && u.hostname === 'chatgpt.com' && !u.username && !u.password && !u.port;
  } catch {
    return false;
  }
}

/** Допустимые URL изображений: только https и хосты ChatGPT/OpenAI (защита от SSRF через сообщения). */
export function isAllowedImageUrl(value) {
  try {
    const u = new URL(value);
    if (u.protocol !== 'https:' || u.username || u.password) return false;
    return u.hostname === 'chatgpt.com' || u.hostname.endsWith('.oaiusercontent.com') || u.hostname === 'files.oaiusercontent.com';
  } catch {
    return false;
  }
}
