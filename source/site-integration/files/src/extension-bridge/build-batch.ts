// Построение партии заданий (batch → characters → jobs) только вызовами существующего движка и рендерера.
import { BUILTIN_PRESETS, cleanName } from '../core/presets.ts';
import type { Preset } from '../core/presets.ts';
import { cloneSettings, normalizeSettings } from '../core/settings.ts';
import type { Settings } from '../core/settings.ts';
import type { Character, PhotoScenario, Subject } from '../core/types.ts';
import { ENGINE_VERSION } from '../engine/compose.ts';
import { generateScenario } from '../engine/generate.ts';
import { runBatch } from '../engine/batch.ts';
import { makeSeed } from '../engine/rng.ts';
import { renderScenario } from '../render/render.ts';
import { BATCH_SCHEMA, BRIDGE_VERSION } from './protocol.ts';
import type { CreateBatchPayload } from './protocol.ts';

export class BridgeFailure extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** Неизменяемое «ядро» внешности: должно совпадать во всех кадрах одного персонажа. */
export const CORE_FIELDS = ['age', 'hairColor', 'hairLength', 'hairType', 'eyeColor', 'skinTone', 'build', 'height', 'freckles', 'features'] as const;

export interface IdentityCore {
  age: number;
  hairColor: string;
  hairLength: string;
  hairType: string;
  eyeColor: string;
  skinTone: string;
  build: string;
  height: string;
  freckles: string;
  features: string[];
}

export interface BatchJob {
  image_job_id: string;
  index: number;
  prompt: string;
  negative: string | null;
  styling: { hairStyle: string; makeup: string; glasses: string };
  params: Record<string, string | number | null>;
  reference: null;
}

export interface BatchCharacter {
  character_id: string;
  index: number;
  name: string;
  seed: string;
  identity: { core: IdentityCore; fingerprint: string; fingerprint_alg: 'sha256-canonical-json' };
  notes: string[];
  jobs: BatchJob[];
}

export interface Batch {
  schema: typeof BATCH_SCHEMA;
  batch_id: string;
  created_at: string;
  source: { app: 'RealPhoto Prompt Studio'; engine: string; bridge: number; origin: string; kind: 'bridge' };
  spec: CreateBatchPayload & { seed: string };
  characters: BatchCharacter[];
}

export interface BuildDeps {
  origin: string;
  now?: () => Date;
  siteSettings?: () => Settings;
  userPresets?: () => Preset[];
  siteCharacter?: () => Character | null;
  newSeed?: () => string;
  sha256?: (text: string) => Promise<string>;
  onProgress?: (done: number, total: number) => void;
  signal?: AbortSignal;
  pause?: () => Promise<void>;
}

const pad3 = (n: number): string => String(n).padStart(3, '0');

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export async function defaultSha256(text: string): Promise<string> {
  const buf = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function coreOf(s: Subject): IdentityCore {
  return {
    age: s.age,
    hairColor: s.hairColor,
    hairLength: s.hairLength,
    hairType: s.hairType,
    eyeColor: s.eyeColor,
    skinTone: s.skinTone,
    build: s.build,
    height: s.height,
    freckles: s.freckles,
    features: [...s.features].sort(),
  };
}

/** Сколько полей ядра заметно различаются (возраст — при разнице ≥ 3 лет). */
export function coreDistance(a: IdentityCore, b: IdentityCore): number {
  let d = 0;
  for (const k of CORE_FIELDS) {
    if (k === 'age') d += Math.abs(a.age - b.age) >= 3 ? 1 : 0;
    else if (k === 'features') d += a.features.join('|') !== b.features.join('|') ? 1 : 0;
    else d += a[k] !== b[k] ? 1 : 0;
  }
  return d;
}

const MIN_CORE_DISTANCE = 4;
const PASSPORT_ATTEMPTS = 16;

function resolveBase(p: CreateBatchPayload, deps: BuildDeps): Settings {
  if (p.preset_id !== null) {
    const all = [...BUILTIN_PRESETS, ...(deps.userPresets?.() ?? [])];
    const found = all.find((x) => x.id === p.preset_id);
    if (!found) throw new BridgeFailure('PRESET_NOT_FOUND', `Пресет «${cleanName(p.preset_id)}» не найден на сайте.`);
    return cloneSettings(found.settings);
  }
  return cloneSettings(deps.siteSettings ? deps.siteSettings() : normalizeSettings(null).settings);
}

export async function buildBatch(p: CreateBatchPayload, deps: BuildDeps): Promise<Batch> {
  const sha = deps.sha256 ?? defaultSha256;
  const pause = deps.pause ?? (() => Promise.resolve());
  const seed = p.seed ?? (deps.newSeed ?? makeSeed)();
  const base = resolveBase(p, deps);
  base.profile = p.profile;
  base.length = p.length;
  base.includeNegative = p.include_negative;
  base.locks = [];

  const frameSettings = normalizeSettings({ ...base, mode: p.strategy === 'series' ? 'series' : 'character' }).settings;
  const passportSettings = normalizeSettings({ ...base, mode: 'new' }).settings;
  const characters = p.mode === 'single' ? 1 : p.characters;
  const total = characters * p.frames_per_character;

  const specForId = { engine: ENGINE_VERSION, bridge: BRIDGE_VERSION, p: { ...p, seed }, settings: frameSettings };
  const batchId = `RPS-${(await sha(canonicalJson(specForId))).slice(0, 10)}`;

  const out: BatchCharacter[] = [];
  const cores: IdentityCore[] = [];
  let done = 0;
  const siteCharacter = p.use_site_character ? (deps.siteCharacter?.() ?? null) : null;
  if (p.use_site_character && !siteCharacter) throw new BridgeFailure('NO_SITE_CHARACTER', 'На сайте нет сохранённого персонажа.');

  for (let c = 1; c <= characters; c++) {
    if (deps.signal?.aborted) throw new BridgeFailure('CANCELLED', 'Создание партии отменено.');
    const characterId = `${batchId}-C${pad3(c)}`;
    const cseed = `${seed}~c${pad3(c)}`;
    const notes: string[] = [];
    let subject: Subject | null = null;

    if (c === 1 && siteCharacter) {
      subject = siteCharacter.subject;
    } else {
      let best: { subject: Subject; dist: number } | null = null;
      for (let attempt = 0; attempt < PASSPORT_ATTEMPTS; attempt++) {
        const g = generateScenario({ settings: passportSettings, seed: `${cseed}~passport~${attempt}`, index: 0 });
        if (!g.ok) continue;
        const core = coreOf(g.result.scenario.subject);
        const dist = cores.length ? Math.min(...cores.map((x) => coreDistance(core, x))) : MIN_CORE_DISTANCE;
        if (!best || dist > best.dist) best = { subject: g.result.scenario.subject, dist };
        if (dist >= MIN_CORE_DISTANCE) break;
      }
      if (!best) throw new BridgeFailure('PASSPORT_FAILED', `Не удалось создать паспорт внешности для персонажа ${c}.`);
      subject = best.subject;
      if (best.dist < MIN_CORE_DISTANCE) notes.push(`Внешность похожа на другого персонажа партии (различий в ядре: ${best.dist}).`);
    }

    const core = coreOf(subject);
    cores.push(core);
    const character: Character = { id: characterId, name: `Персонаж ${c}`, subject, createdAt: 0 };
    const res = await runBatch({ settings: frameSettings, count: p.frames_per_character, baseSeed: cseed, character, history: [], pause });
    if (res.failures > 0 || res.scenarios.length !== p.frames_per_character) {
      throw new BridgeFailure('GENERATION_FAILED', `Движок не смог создать все кадры персонажа ${c} (ошибок: ${res.failures}). Ослабьте ограничения пресета.`);
    }
    const coreKey = canonicalJson(core);
    const jobs: BatchJob[] = [];
    for (const [i, sc] of res.scenarios.entries()) {
      if (canonicalJson(coreOf(sc.subject)) !== coreKey) throw new BridgeFailure('IDENTITY_DRIFT', `Ядро внешности персонажа ${c} изменилось в кадре ${i + 1}.`);
      const r = renderScenario(sc, { profile: p.profile, length: p.length, includeNegative: p.include_negative });
      if (r.problems.length) throw new BridgeFailure('UNSAFE_PROMPT', `Промпт кадра ${i + 1} не прошёл проверку безопасности сайта: ${r.problems[0]}`);
      jobs.push({
        image_job_id: `${characterId}-F${pad3(i + 1)}`,
        index: i + 1,
        prompt: r.main,
        negative: p.include_negative ? r.negative : null,
        styling: { hairStyle: sc.subject.hairStyle, makeup: sc.subject.makeup, glasses: sc.subject.glasses },
        params: paramsOf(sc),
        reference: null,
      });
      done += 1;
      deps.onProgress?.(done, total);
    }
    out.push({
      character_id: characterId,
      index: c,
      name: character.name,
      seed: cseed,
      identity: { core, fingerprint: await sha(coreKey), fingerprint_alg: 'sha256-canonical-json' },
      notes,
      jobs,
    });
    await pause();
  }

  return {
    schema: BATCH_SCHEMA,
    batch_id: batchId,
    created_at: (deps.now ?? (() => new Date()))().toISOString(),
    source: { app: 'RealPhoto Prompt Studio', engine: ENGINE_VERSION, bridge: BRIDGE_VERSION, origin: deps.origin, kind: 'bridge' },
    spec: { ...p, seed },
    characters: out,
  };
}

function paramsOf(sc: PhotoScenario): Record<string, string | number | null> {
  return {
    scenario_id: sc.id,
    seed: sc.seed,
    mode: sc.mode,
    scene_id: sc.sceneId,
    category: sc.category,
    season: sc.season,
    weather: sc.weather,
    time: sc.time,
    capture: sc.capture,
    framing: sc.framing,
    angle: sc.angle,
    emotion: sc.emotion,
    aspect_ratio: sc.ratio.label,
    fingerprint: sc.fingerprint,
  };
}
