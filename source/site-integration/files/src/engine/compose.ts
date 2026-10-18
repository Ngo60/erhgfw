import type { Action, PhotoScenario, Scene, ScenarioRatio, Subject } from '../core/types.ts';
import { RATIO_PRESETS } from '../core/settings.ts';
import { CAPTURES } from '../core/vocab.ts';
import type { Angle, Capture, Emotion, Framing, Gaze, Mode, Season, TimeOfDay, Weather } from '../core/vocab.ts';
import { ALL_SCENES, SCENE_BY_ID } from '../data/scenes/index.ts';
import { sceneTriples } from './climate.ts';
import type { Triple } from './climate.ts';
import type { Resolved } from './context.ts';
import { finishSubject, sampleCore, sunglassesPlausible } from './appearance.ts';
import type { SubjectKeep } from './appearance.ts';
import { createRng } from './rng.ts';
import type { Rng } from './rng.ts';
import {
  CAPTURE_FRAMINGS,
  anglesFor,
  captureReason,
  faceVisibilityOf,
  framingReason,
  gazesFor,
  isSelfie,
  ratioReason,
} from './rules.ts';
import { accessoryCtx, hasOutfit, outfitReason, needOf, pickAccessories, pickOutfit, OUTFIT_BY_ID } from './wardrobe.ts';
import { lightingFor, pickScenery } from './scenery.ts';
import { featuresOf, fingerprintOf } from './similarity.ts';

export const ENGINE_VERSION = '1.1.0';

export interface Keep {
  sceneId?: string;
  season?: Season;
  weather?: Weather | null;
  time?: TimeOfDay;
  actionId?: string;
  capture?: Capture;
  framing?: Framing;
  angle?: Angle;
  gaze?: Gaze;
  emotion?: Emotion;
  outfitId?: string;
  outfitEn?: string;
  ratio?: ScenarioRatio;
  accessories?: string[];
  details?: string[];
  fg?: string[];
  mid?: string[];
  far?: string[];
  imperfections?: string[];
  hand?: 'left' | 'right';
  subject?: SubjectKeep;
}

// ───────── допустимые сочетания съёмки для сцены ─────────

interface FramingOpt {
  angles: Angle[];
  ratios: ScenarioRatio[];
}
interface Combo {
  capture: Capture;
  framings: Map<Framing, FramingOpt>;
}
interface ActionFeas {
  action: Action;
  combos: Combo[];
}
interface SceneFeas {
  scene: Scene;
  actions: ActionFeas[];
}

const FEAS_CACHE = new Map<string, Map<string, SceneFeas | null>>();

function ratioOptions(R: Resolved, capture: Capture, framing: Framing): ScenarioRatio[] {
  if (R.ratio) return ratioReason(R.ratio, capture, framing) ? [] : [R.ratio];
  return RATIO_PRESETS.filter((r) => {
    if (R.orientation === 'vertical' && r.orientation !== 'vertical') return false;
    if (R.orientation === 'horizontal' && r.orientation !== 'horizontal') return false;
    return ratioReason(r, capture, framing) === null;
  });
}

export function sceneFeasibility(R: Resolved, scene: Scene): SceneFeas | null {
  let perSig = FEAS_CACHE.get(R.signature);
  if (!perSig) {
    if (FEAS_CACHE.size > 12) FEAS_CACHE.delete(FEAS_CACHE.keys().next().value as string);
    perSig = new Map();
    FEAS_CACHE.set(R.signature, perSig);
  }
  if (perSig.has(scene.id)) return perSig.get(scene.id) ?? null;
  const actions: ActionFeas[] = [];
  for (const action of scene.actions) {
    if (!R.posture.includes(action.posture)) continue;
    if (R.faceRequired && action.hidden) continue;
    const combos: Combo[] = [];
    for (const capture of CAPTURES) {
      if (R.shares[capture] <= 0 || captureReason(capture, scene, action)) continue;
      const framings = new Map<Framing, FramingOpt>();
      for (const framing of CAPTURE_FRAMINGS[capture]) {
        if (!R.framing.includes(framing) || framingReason(framing, capture, action)) continue;
        const angles = anglesFor(capture, framing, action, scene, R.faceRequired).filter((a) => R.angle.includes(a));
        if (!angles.length) continue;
        const ratios = ratioOptions(R, capture, framing);
        if (!ratios.length) continue;
        framings.set(framing, { angles, ratios });
      }
      if (framings.size) combos.push({ capture, framings });
    }
    if (combos.length) actions.push({ action, combos });
  }
  const res = actions.length ? { scene, actions } : null;
  perSig.set(scene.id, res);
  return res;
}

/** Копия настроек с учётом жёстких закреплений: закреплённое значение важнее ручных фильтров. */
function withKeep(R: Resolved, hard: Keep): Resolved {
  const k: Resolved = { ...R };
  if (hard.angle) k.angle = [hard.angle];
  if (hard.framing) k.framing = [hard.framing];
  if (hard.capture) {
    const only = { ...R.shares };
    for (const c of CAPTURES) if (c !== hard.capture) only[c] = 0;
    only[hard.capture] = 1;
    k.shares = only;
  }
  if (hard.actionId) k.posture = [...R.posture, 'stand', 'sit', 'walk', 'move', 'lean', 'crouch'];
  if (hard.ratio) k.ratio = hard.ratio;
  const captureOn = CAPTURES.filter((c) => k.shares[c] > 0).join(',');
  k.signature = [captureOn, k.framing.join(','), k.angle.join(','), [...new Set(k.posture)].join(','), k.faceRequired ? 'F' : '-', k.ratio ? k.ratio.label : '-', k.orientation].join('|');
  return k;
}

function narrow(feas: SceneFeas, keep: Keep): ActionFeas[] {
  const out: ActionFeas[] = [];
  for (const af of feas.actions) {
    if (keep.actionId && af.action.id !== keep.actionId) continue;
    const combos: Combo[] = [];
    for (const cb of af.combos) {
      if (keep.capture && cb.capture !== keep.capture) continue;
      const framings = new Map<Framing, FramingOpt>();
      for (const [f, opt] of cb.framings) {
        if (keep.framing && f !== keep.framing) continue;
        const angles = keep.angle ? opt.angles.filter((a) => a === keep.angle) : opt.angles;
        if (!angles.length) continue;
        framings.set(f, { angles, ratios: opt.ratios });
      }
      if (framings.size) combos.push({ capture: cb.capture, framings });
    }
    if (combos.length) out.push({ action: af.action, combos });
  }
  return out;
}

function triplesFor(R: Resolved, scene: Scene, hard: Keep): Triple[] {
  return sceneTriples(scene, R.climate).filter((t) => {
    if (hard.season ? t.season !== hard.season : !R.season.includes(t.season)) return false;
    if (hard.time ? t.time !== hard.time : !R.time.includes(t.time)) return false;
    // Погода не видна: сцена подходит, только если погода не задана явно (вручную или закреплением).
    if (scene.weatherMode === 'irrelevant') return hard.weather === undefined && R.settings.choices.weather.mode !== 'manual';
    if (t.weather === null) return false;
    if (hard.weather !== undefined) return t.weather === hard.weather;
    return R.weather.includes(t.weather);
  });
}

interface Candidate {
  scene: Scene;
  narrowed: ActionFeas[];
  triples: Triple[];
}

export interface Plan {
  R: Resolved;
  hard: Keep;
  candidates: Candidate[];
}

/** Отбор сцен, совместимых с настройками и жёсткими закреплениями (не зависит от seed). */
export function preparePlan(R: Resolved, hard: Keep): Plan {
  const Rk = withKeep(R, hard);
  const candidates: Candidate[] = [];
  const consider = (scene: Scene, forced: boolean) => {
    if (!forced) {
      if (R.sceneExclude.has(scene.id)) return;
      if (R.sceneManual && !R.sceneManual.has(scene.id)) return;
      if (!R.category.includes(scene.category)) return;
      if (!R.crowdOk && scene.crowd === 2) return;
    }
    const feas = sceneFeasibility(Rk, scene);
    if (!feas) return;
    const narrowed = narrow(feas, hard);
    if (!narrowed.length) return;
    let triples = triplesFor(Rk, scene, hard);
    if (hard.outfitId) {
      const o = OUTFIT_BY_ID.get(hard.outfitId);
      triples = triples.filter((t) => !!o && outfitReason(o, scene, needOf(scene, t.season, t.weather, t.time, R.climate), t.weather) === null);
    }
    if (!triples.length) return;
    candidates.push({ scene, narrowed, triples });
  };
  if (hard.sceneId) {
    const sc = SCENE_BY_ID.get(hard.sceneId);
    if (sc) consider(sc, true);
  } else {
    for (const sc of ALL_SCENES) consider(sc, false);
  }
  return { R, hard, candidates };
}

// ───────── выбор с предпочтением и исключением ─────────

function choose<T>(rng: Rng, items: readonly T[], weight: (t: T) => number, prefer?: (t: T) => boolean, avoid?: (t: T) => boolean): T | undefined {
  let pool = items;
  if (avoid) {
    const f = pool.filter((t) => !avoid(t));
    if (f.length) pool = f;
  }
  if (prefer) {
    const p = pool.find(prefer);
    if (p) return p;
  }
  return rng.weighted(pool, weight) ?? pool[0];
}

const FRAMING_W: Record<Framing, number> = { 'waist-up': 4, portrait: 3, 'full-body': 3, seated: 2, 'in-motion': 2, 'close-up': 1.4 };
const ANGLE_W: Record<Angle, number> = {
  front: 4,
  'three-quarter': 4,
  'eye-level': 3,
  'slightly-above': 2.2,
  'slightly-below': 1,
  profile: 1.2,
  side: 1.5,
  'back-head-turn': 1.2,
  distant: 1.5,
  'close-up': 1.6,
  'dynamic-tilt': 0.8,
  'face-limited': 0.7,
};
/** Настоящие селфи чаще снимают чуть сверху и с наклоном, чем строго анфас: поправка весов ракурса только для селфи. */
const SELFIE_ANGLE_FACTOR: Partial<Record<Angle, number>> = { front: 0.55, 'eye-level': 0.85, 'slightly-above': 2.4, 'slightly-below': 1.9, 'close-up': 1.2, 'dynamic-tilt': 2.6 };
const selfieAngleFactor = (capture: Capture, angle: Angle): number => (isSelfie(capture) ? (SELFIE_ANGLE_FACTOR[angle] ?? 1) : 1);
const CANDID_ANGLES: readonly Angle[] = ['profile', 'side', 'back-head-turn', 'face-limited', 'dynamic-tilt'];
const EMOTION_W: Record<Emotion, number> = {
  'natural-smile': 4,
  'calm-friendly': 3,
  laugh: 1.2,
  playful: 1,
  surprise: 0.5,
  thoughtful: 1,
  neutral: 1,
  sad: 0.5,
  crying: 0.25,
};

function spontaneityFactor(c: Capture, sp: number): number {
  const s = sp / 100;
  switch (c) {
    case 'candid':
      return 0.4 + 1.8 * s;
    case 'by-friend-walk':
      return 0.5 + 1.4 * s;
    case 'tripod-timer':
      return 1.6 - 1.2 * s;
    case 'by-acquaintance':
      return 1.5 - 0.9 * s;
    default:
      return 1;
  }
}

function ratioWeight(label: string, capture: Capture): number {
  const selfie = isSelfie(capture);
  const table: Record<string, number> = selfie
    ? { '9:16': 5, '3:4': 3, '4:5': 3, '2:3': 1.5, '1:1': 1 }
    : { '9:16': 3, '3:4': 3, '4:5': 2.5, '2:3': 2, '4:3': 2.5, '3:2': 2.5, '16:9': 2, '1:1': 1, '5:4': 1, '21:9': 0.4 };
  return table[label] ?? 1;
}

export interface ComposeContext {
  seed: string;
  /** Seed, который показывается в результате (для производных кадров — исходный). */
  seedLabel: string;
  attempt: number;
  soft: Keep;
  avoid: Keep;
  base: Subject | null;
  characterId: string | null;
  index: number;
  mode: Mode;
  notes: string[];
  appliedLocks: PhotoScenario['locks'];
}

/** Один проход сборки сценария из подготовленного плана. null — собрать не удалось. */
export function composeFromPlan(plan: Plan, cx: ComposeContext): PhotoScenario | null {
  const { R, hard } = plan;
  const { soft, avoid } = cx;
  const rng = createRng(cx.seed);
  const notes = [...cx.notes];
  if (!plan.candidates.length) return null;

  // Закреплённые солнцезащитные очки допустимы только на улице при ярком дневном свете.
  const subjKeep: SubjectKeep = { ...soft.subject, ...hard.subject };
  const keepSun = subjKeep.face?.glasses === 'sunglasses';
  const sunOk = (sc: Scene, t: Triple): boolean => sunglassesPlausible({ tags: [], time: t.time, weather: t.weather, outdoors: sc.env !== 'indoor' });

  // 1. Локация: при сохранённом сезоне (серия, смена локации) предпочитаем сцены, где он возможен
  const sunny = keepSun ? plan.candidates.filter((c) => c.triples.some((t) => sunOk(c.scene, t))) : [];
  let scenePool = sunny.length ? sunny : plan.candidates;
  if (soft.season) {
    const sameSeason = scenePool.filter((c) => c.triples.some((t) => t.season === soft.season));
    if (sameSeason.length) scenePool = sameSeason;
  }
  const cand = choose(
    rng.fork('scene'),
    scenePool,
    (c) => R.temper(R.rarityW[c.scene.rarity] * (1 + 0.04 * c.narrowed.length)),
    soft.sceneId ? (c) => c.scene.id === soft.sceneId : undefined,
    avoid.sceneId ? (c) => c.scene.id === avoid.sceneId : undefined,
  );
  if (!cand) return null;
  const scene = cand.scene;

  // 2. Сезон × погода × время (с проверкой, что для сочетания есть одежда)
  const withOutfit = cand.triples.filter((t) => hasOutfit(scene, t.season, t.weather, t.time, R.climate));
  if (!withOutfit.length) return null;
  let pool = withOutfit;
  if (keepSun) {
    const sun = pool.filter((t) => sunOk(scene, t));
    if (sun.length) pool = sun;
  }
  for (const key of ['season', 'weather', 'time'] as const) {
    if (avoid[key] !== undefined) {
      const f = pool.filter((t) => t[key] !== avoid[key]);
      if (f.length) pool = f;
    }
  }
  const score = (t: Triple): number =>
    (soft.season && t.season === soft.season ? 4 : 0) + (soft.time && t.time === soft.time ? 2 : 0) + (soft.weather !== undefined && t.weather === soft.weather ? 1 : 0);
  const best = pool.reduce((m, t) => Math.max(m, score(t)), 0);
  if (best > 0) pool = pool.filter((t) => score(t) === best);
  const tr = rng.fork('triple');
  const seasons = [...new Set(pool.map((t) => t.season))];
  const season = soft.season && seasons.includes(soft.season) && best > 0 ? soft.season : tr.pick(seasons);
  const bySeason = pool.filter((t) => t.season === season);
  const weathers = [...new Set(bySeason.map((t) => t.weather))];
  const weather = tr.weighted(weathers, (w) => R.temper(bySeason.filter((t) => t.weather === w).reduce((a, t) => a + t.weight, 0))) ?? (weathers[0] as Weather | null);
  const byWeather = bySeason.filter((t) => t.weather === weather);
  const time = (tr.weighted(byWeather, (t) => R.temper(t.weight)) ?? (byWeather[0] as Triple)).time;
  const facts = { season, weather, time };

  // 3. Действие → съёмка → кадрирование → ракурс → формат
  const af = choose(
    rng.fork('action'),
    cand.narrowed,
    (a) => R.temper(1 + 0.15 * a.combos.length),
    soft.actionId ? (a) => a.action.id === soft.actionId : undefined,
    avoid.actionId ? (a) => a.action.id === avoid.actionId : undefined,
  );
  if (!af) return null;
  const action = af.action;
  const cb = choose(
    rng.fork('capture'),
    af.combos,
    (c) => R.temper(R.shares[c.capture] * spontaneityFactor(c.capture, R.spontaneity)),
    soft.capture ? (c) => c.capture === soft.capture : undefined,
    avoid.capture ? (c) => c.capture === avoid.capture : undefined,
  );
  if (!cb) return null;
  const capture = cb.capture;
  const framingEntries = [...cb.framings.entries()];
  const fe = choose(
    rng.fork('framing'),
    framingEntries,
    ([f]) => R.temper(FRAMING_W[f] * (f === 'seated' && action.posture === 'sit' ? 2 : 1) * (f === 'in-motion' && action.posture === 'walk' ? 2 : 1) * (isSelfie(capture) && f === 'close-up' ? 1.4 : 1)),
    soft.framing ? ([f]) => f === soft.framing : undefined,
    avoid.framing ? ([f]) => f === avoid.framing : undefined,
  );
  if (!fe) return null;
  const [framing, opt] = fe;
  const sp = R.spontaneity;
  const angle = choose(
    rng.fork('angle'),
    opt.angles,
    (a) => R.temper(ANGLE_W[a] * selfieAngleFactor(capture, a) * (CANDID_ANGLES.includes(a) ? 1 + (sp - 50) / 100 : a === 'front' || a === 'eye-level' ? 1 - (sp - 50) / 200 : 1)),
    soft.angle ? (a) => a === soft.angle : undefined,
    avoid.angle ? (a) => a === avoid.angle : undefined,
  );
  if (!angle) return null;
  const ratio = choose(
    rng.fork('ratio'),
    opt.ratios,
    (r) => R.temper(ratioWeight(r.label, capture)),
    soft.ratio ? (r) => r.label === soft.ratio?.label : undefined,
    avoid.ratio ? (r) => r.label === avoid.ratio?.label : undefined,
  );
  if (!ratio) return null;

  // 4. Взгляд и эмоция
  const gazes = gazesFor(capture, angle, action);
  const selfie = isSelfie(capture);
  const gaze = choose(
    rng.fork('gaze'),
    gazes,
    (g) => {
      const s = sp / 100;
      if (selfie) return 1;
      switch (g) {
        case 'camera':
          return (capture === 'by-acquaintance' || capture === 'tripod-timer' ? 4 : capture === 'by-friend-walk' ? 2 : 0.5) * (1.3 - s * 0.8);
        case 'away':
          return 2 * (0.8 + s * 0.6);
        case 'side':
          return 1.5 * (0.8 + s * 0.6);
        case 'down':
          return 1;
        case 'object':
          return (action.obj ? 4 : 1.2) * (0.8 + s * 0.6);
      }
    },
    soft.gaze ? (g) => g === soft.gaze : undefined,
  );
  if (!gaze) return null;
  const emotion = hard.emotion && R.emotion.length ? hard.emotion : choose(
    rng.fork('emotion'),
    R.emotion,
    (e) => {
      const s = sp / 100;
      let w = EMOTION_W[e];
      if (e === 'laugh' || e === 'playful' || e === 'surprise') w *= 0.6 + s * 1.2;
      if (action.posture === 'move' && (e === 'laugh' || e === 'playful')) w *= 1.6;
      if (action.obj && (e === 'thoughtful' || e === 'neutral')) w *= 1.5;
      return R.temper(w);
    },
    soft.emotion && R.emotion.includes(soft.emotion) ? (e) => e === soft.emotion : undefined,
    avoid.emotion ? (e) => e === avoid.emotion : undefined,
  );
  if (!emotion) return null;

  // 5. Одежда, внешность, аксессуары
  const outfit = pickOutfit(R, rng.fork('outfit'), scene, facts, {
    keepId: hard.outfitId ?? soft.outfitId,
    keepEn: hard.outfitId ? hard.outfitEn : soft.outfitEn,
    avoidId: avoid.outfitId,
    notes,
  });
  if (!outfit) return null;
  const outdoors = scene.env !== 'indoor';
  const core = sampleCore(R, rng.fork('subject'), subjKeep, cx.base);
  const subject = finishSubject(R, rng.fork('subject-ctx'), core, { tags: outfit.def.tags, time, weather, outdoors }, subjKeep, cx.base, notes);
  const accCtx = accessoryCtx(scene, facts, R.climate, outfit.def, outfit.en);
  const accessories = pickAccessories(R, rng.fork('accessories'), accCtx, {
    actionHands: action.hands,
    capture,
    keep: hard.accessories ?? soft.accessories,
  });

  // 6. Окружение
  const sceneryKeep = soft.fg && soft.mid && soft.far && soft.sceneId === scene.id;
  const scenery = pickScenery(R, rng.fork('scenery'), scene, facts, capture, soft.sceneId === scene.id ? soft.details : undefined);
  if (sceneryKeep) {
    const okAll = (list: string[], pool: string[]) => list.every((t) => pool.includes(t));
    if (okAll(soft.fg ?? [], scene.fg) && okAll(soft.mid ?? [], scene.mid) && okAll(soft.far ?? [], scene.far)) {
      scenery.fg = soft.fg ?? scenery.fg;
      scenery.mid = soft.mid ?? scenery.mid;
      scenery.far = soft.far ?? scenery.far;
    }
    if (soft.imperfections) scenery.imperfections = soft.imperfections;
  }
  const light = lightingFor(scene, time, weather, rng.fork('light'));
  const hand = soft.hand ?? rng.fork('hand').pick(['left', 'right'] as const);

  const scenario: PhotoScenario = {
    schema: 1,
    engine: ENGINE_VERSION,
    id: '',
    seed: cx.seedLabel,
    mode: cx.mode,
    index: cx.index,
    characterId: cx.characterId,
    subject,
    sceneId: scene.id,
    category: scene.category,
    rarity: scene.rarity,
    sceneTitle: scene.titleRu,
    place: scene.place,
    env: scene.env,
    view: scene.view,
    dress: scene.dress,
    weatherMode: scene.weatherMode,
    climate: R.climate,
    season,
    weather,
    time,
    action,
    capture,
    framing,
    angle,
    gaze,
    emotion,
    faceVisibility: faceVisibilityOf(angle),
    hand,
    outfit: { id: outfit.def.id, en: outfit.en, ru: outfit.def.ru, tags: [...outfit.def.tags] },
    accessories,
    fg: scenery.fg,
    mid: scenery.mid,
    far: scenery.far,
    details: scenery.details,
    imperfections: scenery.imperfections,
    light,
    crowd: R.crowdOk && scene.crowd > 0 ? 'incidental' : 'none',
    ratio,
    look: { ...R.look },
    spontaneity: R.spontaneity,
    detailLevel: R.detailLevel,
    fingerprint: '',
    attempt: cx.attempt,
    notes,
    locks: cx.appliedLocks,
  };
  const feat = featuresOf(scenario);
  scenario.fingerprint = fingerprintOf(feat);
  scenario.id = `${scene.id}~${scenario.fingerprint}`;
  return scenario;
}
