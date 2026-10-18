// Селфи и положение головы. Эти детали не хранятся в сценарии: они подбираются при рендере из отдельного потока случайных
// чисел (seed + id сценария), поэтому один и тот же кадр всегда даёт один и тот же текст, а выбор остальных параметров
// сценария (сцена, одежда, ракурс и т. д.) не меняется. Сценарии из истории без новых полей рендерятся так же.
import type { PhotoScenario } from '../core/types.ts';
import type { Capture } from '../core/vocab.ts';
import { createRng } from '../engine/rng.ts';
import type { Rng } from '../engine/rng.ts';

export type Hand = PhotoScenario['hand'];
export type Grip = 'extended' | 'high' | 'low' | 'bent' | 'side' | 'both-hands' | 'chest' | 'face' | 'shoulder' | 'waist';
export type HeadPose = 'level' | 'tilt-left' | 'tilt-right' | 'chin-down' | 'chin-up' | 'turn-left' | 'turn-right' | 'lean-in' | 'laugh-back';
export type EyeLine = 'lens' | 'screen';
export type FreeHandId = 'hair' | 'glasses' | 'collar' | 'pocket' | 'strap' | 'necklace' | 'wave' | 'chin' | 'peace' | 'relaxed' | 'lean' | 'swing';

export interface SelfieExtras {
  /** Рука, держащая телефон (при хвате двумя руками — основная). */
  hand: Hand;
  grip: Grip;
  /** С какого края кадра входит рука с телефоном (в кадре, а не анатомически). */
  armSide: 'left' | 'right';
  head: HeadPose;
  eyes: EyeLine;
  freeHand: FreeHandId | null;
}

const ARM: readonly Capture[] = ['selfie-arm', 'front-camera'];
const MIRROR: readonly Capture[] = ['selfie-mirror', 'selfie-reflection'];
export const isArmSelfie = (c: Capture): boolean => ARM.includes(c);
export const isMirrorSelfie = (c: Capture): boolean => MIRROR.includes(c);

type Table<T extends string> = ReadonlyArray<readonly [T, number]>;

function weightedPick<T extends string>(r: Rng, table: Table<T>, fallback: T): T {
  return r.weighted(table, ([, w]) => w)?.[0] ?? fallback;
}

// ───────── хват телефона ─────────

function gripTable(s: PhotoScenario): Table<Grip> {
  if (isMirrorSelfie(s.capture)) {
    return [
      ['chest', 3],
      ['face', 1.3],
      ['shoulder', 1.3],
      ['waist', 1],
    ];
  }
  const free = s.action.hands === 0;
  const w: Record<Grip, number> = { extended: 3, high: 1.4, low: 0.9, bent: 1.2, side: 1.2, 'both-hands': free ? 1.8 : 0, chest: 0, face: 0, shoulder: 0, waist: 0 };
  switch (s.angle) {
    case 'slightly-above':
      Object.assign(w, { high: 6, extended: 2.2, low: 0, bent: 0.4, 'both-hands': w['both-hands'] * 0.5 });
      break;
    case 'slightly-below':
      Object.assign(w, { low: 6, high: 0, extended: 1.2, bent: w.bent * 0.5 });
      break;
    case 'close-up':
      Object.assign(w, { bent: 6, extended: 0.6, high: 0.8, low: 0.8, side: 0.5, 'both-hands': 0 });
      break;
    case 'three-quarter':
      Object.assign(w, { side: 4, extended: 3 });
      break;
    case 'dynamic-tilt':
      Object.assign(w, { side: 3.2, high: 2.4 });
      break;
    default:
      w['both-hands'] *= 1.5;
      w.bent *= 1.2;
  }
  if (s.framing === 'close-up') Object.assign(w, { bent: w.bent * 2.4, extended: w.extended * 0.5, 'both-hands': 0 });
  if (s.framing === 'waist-up') w['both-hands'] *= 1.3;
  if (s.capture === 'front-camera') Object.assign(w, { low: w.low * 2, bent: w.bent * 1.6, extended: w.extended * 0.4, side: w.side * 0.6, high: w.high * 0.8 });
  return (Object.keys(w) as Grip[]).map((g) => [g, w[g]] as const);
}

// ───────── положение головы ─────────

function headTable(s: PhotoScenario, grip: Grip | null): Table<HeadPose> {
  const e = s.emotion;
  const a = s.angle;
  const turn = a === 'three-quarter' ? 3 : a === 'front' ? 0.7 : 1.3;
  const w: Record<HeadPose, number> = {
    level: e === 'laugh' ? 0.5 : 1.6,
    'tilt-left': 2,
    'tilt-right': 2,
    'chin-down': a === 'slightly-above' ? 3.4 : a === 'slightly-below' ? 0 : 1.3,
    'chin-up': a === 'slightly-below' ? 3 : a === 'slightly-above' ? 0.2 : 0.8,
    'turn-left': turn,
    'turn-right': turn,
    'lean-in': grip === 'bent' || a === 'close-up' ? 2 : 0.15,
    'laugh-back': e === 'laugh' ? 1.8 : 0,
  };
  if (e === 'thoughtful') Object.assign(w, { 'chin-down': w['chin-down'] * 1.6, 'chin-up': w['chin-up'] * 0.5 });
  if (e === 'surprise') w['chin-up'] *= 1.4;
  if (!isArmSelfie(s.capture) && !isMirrorSelfie(s.capture)) w['lean-in'] = 0;
  return (Object.keys(w) as HeadPose[]).map((h) => [h, w[h]] as const);
}

export const HEAD_EN: Record<HeadPose, string> = {
  level: 'her head held level',
  'tilt-left': 'her head tilted slightly toward her left shoulder',
  'tilt-right': 'her head tilted slightly toward her right shoulder',
  'chin-down': 'her chin slightly lowered',
  'chin-up': 'her chin lifted a little',
  'turn-left': 'her head turned a few degrees to her left',
  'turn-right': 'her head turned a few degrees to her right',
  'lean-in': 'her head leaning in toward the phone',
  'laugh-back': 'her head tipped slightly back as she laughs',
};

/** Положение головы нужно там, где она смотрит в камеру: селфи, съёмка по таймеру и снимок от знакомого. */
export function headPoseFor(s: PhotoScenario, extras: SelfieExtras | null = selfieExtras(s)): HeadPose | null {
  if (extras) return extras.head;
  if ((s.capture === 'tripod-timer' || s.capture === 'by-acquaintance') && s.gaze === 'camera' && s.faceVisibility === 'full') {
    return weightedPick(createRng(`${s.seed}:${s.id}:head`), headTable(s, null), 'level');
  }
  return null;
}

// ───────── свободная рука ─────────

const WARM = /\b(coat|jacket|hoodie|cardigan|blazer|parka|windbreaker|sweatshirt)\b/i;
const POCKETS = /\b(jeans|trousers|pants|shorts|overalls|joggers|cargo)\b/i;
const BAGS = ['backpack', 'tote-bag', 'crossbody-bag'];
/** Если в описании действия уже названы руки, карманы или пальцы, свободная рука не добавляется — иначе возможны противоречия. */
const HANDS_IN_ACTION = /\b(hands?|pockets?|palms?|arms?|fingers?|wrists?)\b/i;

function freeHandTable(s: PhotoScenario): Table<FreeHandId> {
  const close = s.framing === 'close-up' || s.framing === 'portrait';
  const warm = WARM.test(s.outfit.en);
  const pockets = warm || POCKETS.test(s.outfit.en);
  const covered = s.accessories.includes('hood-up') || s.accessories.includes('beanie');
  return [
    ['hair', covered ? 0.4 : 2],
    ['glasses', s.subject.glasses !== 'none' ? 0.9 : 0],
    ['collar', warm ? 1 : 0],
    ['pocket', pockets && !close ? 1.2 : 0],
    ['strap', s.accessories.some((a) => BAGS.includes(a)) && !close ? 1.2 : 0],
    ['necklace', s.accessories.includes('necklace') ? 1 : 0],
    ['wave', ['natural-smile', 'laugh', 'playful', 'surprise'].includes(s.emotion) ? 1 : 0],
    ['chin', close && ['thoughtful', 'calm-friendly', 'neutral'].includes(s.emotion) ? 1 : 0],
    ['peace', ['playful', 'laugh'].includes(s.emotion) ? 0.5 : 0],
    ['relaxed', close ? 0 : 1.4],
    ['lean', s.action.posture === 'lean' ? 2 : 0],
    ['swing', s.action.posture === 'walk' && !close ? 1.4 : 0],
  ];
}

export const FREE_HAND_EN: Record<FreeHandId, string> = {
  hair: 'pushing her hair back from her face',
  glasses: 'resting on the frame of her glasses',
  collar: 'holding the collar of her clothes',
  pocket: 'tucked into a pocket',
  strap: 'resting on the strap of her bag',
  necklace: 'lightly touching her necklace',
  wave: 'raised in a small casual wave',
  chin: 'resting lightly against her chin',
  peace: 'making a peace sign near her cheek',
  relaxed: 'hanging relaxed at her side',
  lean: 'resting on the surface she is leaning on',
  swing: 'swinging naturally as she walks',
};

// ───────── сборка параметров ─────────

export function selfieExtras(s: PhotoScenario): SelfieExtras | null {
  const arm = isArmSelfie(s.capture);
  if (!arm && !isMirrorSelfie(s.capture)) return null;
  const r = createRng(`${s.seed}:${s.id}:selfie`);
  const grip = weightedPick(r.fork('grip'), gripTable(s), arm ? 'extended' : 'chest');
  const head = weightedPick(r.fork('head'), headTable(s, grip), 'level');
  const sun = s.subject.glasses === 'sunglasses';
  const eyes: EyeLine = arm && !sun && r.fork('eyes').chance(0.3) ? 'screen' : 'lens';
  const free = s.action.hands === 0 && !HANDS_IN_ACTION.test(s.action.en) && grip !== 'both-hands' && r.fork('free-on').chance(0.85) ? weightedPick(r.fork('free'), freeHandTable(s), 'relaxed') : null;
  // Селфи на вытянутой руке в немзеркальном кадре: правая рука входит с левого края; в зеркале — с того же края.
  const armSide: SelfieExtras['armSide'] = arm ? (s.hand === 'right' ? 'left' : 'right') : s.hand;
  return { hand: s.hand, grip, armSide, head, eyes, freeHand: free };
}

// ───────── тексты ─────────

function freeHandText(s: PhotoScenario, id: FreeHandId): string {
  if (id === 'relaxed' && isArmSelfie(s.capture)) return `${FREE_HAND_EN.relaxed}, mostly out of frame`;
  return FREE_HAND_EN[id];
}

function armSentence(s: PhotoScenario, ex: SelfieExtras, r: Rng): string {
  const { hand, armSide: side } = ex;
  const intro =
    s.capture === 'front-camera'
      ? r.pick(['A quick front-camera snapshot, framed like a video-call still:', "A casual shot on the phone's front camera:"])
      : r.pick(['A casual front-camera selfie:', "A quick selfie on her phone's front camera:", 'A spontaneous front-camera selfie:']);
  const grip: Record<Grip, string> = {
    extended: `she holds the phone at arm's length in her ${hand} hand, the arm entering from the ${side} edge of the frame, foreshortened, with the phone hidden behind her hand`,
    high: `she holds the phone up and a little toward the ${side} side of the frame in her ${hand} hand, so the camera looks slightly down at her, her raised forearm cutting into the ${side} edge of the frame, the phone out of sight`,
    low: `she holds the phone low in her ${hand} hand and tilts it up toward her face, the arm coming in from the bottom ${side} corner of the frame, the phone out of sight`,
    bent: `she holds the phone close in her ${hand} hand with the elbow bent, so her face fills most of the frame and only a bit of her shoulder or forearm shows, the phone out of sight`,
    side: `she holds the phone out toward the ${side} side in her ${hand} hand, so the camera catches her from a slight angle, the arm partly visible along the ${side} edge of the frame and the phone out of sight`,
    'both-hands': 'she steadies the phone with both hands in front of her, only her fingers and wrists showing at the bottom of the frame and the phone hidden behind them',
    chest: '',
    face: '',
    shoulder: '',
    waist: '',
  };
  const free = ex.freeHand ? ` Her free hand is ${freeHandText(s, ex.freeHand)}.` : '';
  return `${intro} ${grip[ex.grip]}.${free}`;
}

function mirrorSentence(s: PhotoScenario, ex: SelfieExtras): string {
  const pos: Partial<Record<Grip, string>> = {
    chest: 'at chest height',
    face: 'up in front of the lower part of her face',
    shoulder: 'raised beside her shoulder with the screen turned toward the mirror',
    waist: 'low at her waist, tilted up toward the mirror',
  };
  const where = pos[ex.grip] ?? 'at chest height';
  const free = ex.freeHand ? ` Her free hand is ${freeHandText(s, ex.freeHand)}.` : '';
  if (s.capture === 'selfie-reflection') {
    return `A selfie caught in the reflection of a large glass surface: she holds a phone in her ${ex.hand} hand ${where}, and both she and the phone appear in the reflection.${free}`;
  }
  return `A mirror selfie: she holds a phone in her ${ex.hand} hand ${where}, and the phone is visible in the mirror next to her reflection.${free}`;
}

/** Предложение о способе съёмки для всех видов селфи (ЗАМЕНЯЕТ прежние однотипные шаблоны). */
export function selfieCaptureSentence(s: PhotoScenario, ex: SelfieExtras, r: Rng): string {
  return isMirrorSelfie(s.capture) ? mirrorSentence(s, ex) : armSentence(s, ex, r);
}

/** Куда смотрят глаза у селфи на вытянутой руке (null — оставить прежнюю формулировку). */
export function selfieGazePhrase(s: PhotoScenario, ex: SelfieExtras | null): string | null {
  if (!ex || !isArmSelfie(s.capture) || s.subject.glasses === 'sunglasses') return null;
  return ex.eyes === 'screen' ? 'her gaze resting on her own image on the phone screen, just below the lens' : 'looking straight into the front camera';
}

// ───────── подписи для интерфейса ─────────

export const RU_HAND: Record<Hand, string> = { left: 'левая', right: 'правая' };
export const RU_GRIP: Record<Grip, string> = {
  extended: 'рука вытянута вперёд',
  high: 'телефон выше уровня глаз',
  low: 'телефон ниже подбородка',
  bent: 'рука согнута, телефон близко',
  side: 'телефон в стороне от лица',
  'both-hands': 'телефон в двух руках',
  chest: 'телефон на уровне груди',
  face: 'телефон перед нижней частью лица',
  shoulder: 'телефон у плеча',
  waist: 'телефон на уровне талии',
};
export const RU_HEAD: Record<HeadPose, string> = {
  level: 'голова ровно',
  'tilt-left': 'наклон к левому плечу',
  'tilt-right': 'наклон к правому плечу',
  'chin-down': 'подбородок чуть опущен',
  'chin-up': 'подбородок чуть поднят',
  'turn-left': 'поворот головы влево',
  'turn-right': 'поворот головы вправо',
  'lean-in': 'голова наклонена к телефону',
  'laugh-back': 'голова чуть запрокинута от смеха',
};
export const RU_FREE_HAND: Record<FreeHandId, string> = {
  hair: 'поправляет волосы',
  glasses: 'у оправы очков',
  collar: 'держит воротник',
  pocket: 'в кармане',
  strap: 'на ремне сумки',
  necklace: 'касается украшения на шее',
  wave: 'приветственный взмах',
  chin: 'у подбородка',
  peace: 'знак «мир» у щеки',
  relaxed: 'расслабленно опущена',
  lean: 'опирается на поверхность',
  swing: 'свободно в движении',
};
