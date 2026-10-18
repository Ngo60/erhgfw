import { safetyProblems } from '../core/safety.ts';
import {
  L_ANGLE,
  L_CAPTURE,
  L_CATEGORY,
  L_COLOR,
  L_EMOTION,
  L_FRAMING,
  L_GAZE,
  L_LENGTH,
  L_MODE,
  L_PROFILE,
  L_SEASON,
  L_SHARPNESS,
  L_STYLE,
  L_TIME,
  L_WEATHER,
  L_BUILD,
  L_EYE_COLOR,
  L_HAIR_COLOR,
  L_HAIR_LENGTH,
  L_HAIR_STYLE,
  L_HAIR_TYPE,
  L_HEIGHT,
  L_MAKEUP,
  L_SKIN_TONE,
  L_LOCK,
} from '../core/labels.ts';
import type { PhotoScenario } from '../core/types.ts';
import type { Angle, Capture, Emotion, Framing, Gaze, Length, Profile, TimeOfDay, Weather } from '../core/vocab.ts';
import { ACCESSORY_BY_ID } from '../data/accessories.ts';
import { FEATURE_BY_ID } from '../data/appearance.ts';
import { createRng } from '../engine/rng.ts';
import type { Rng } from '../engine/rng.ts';
import { ENGINE_VERSION } from '../engine/compose.ts';
import { backgroundRealism, cameraCharacter, NEGATIVE_BACKGROUND, TIDY_LINE } from './realism.ts';
import { HEAD_EN, RU_FREE_HAND, RU_GRIP, RU_HAND, RU_HEAD, headPoseFor, isArmSelfie, selfieCaptureSentence, selfieExtras, selfieGazePhrase } from './selfie.ts';
import { EN_BUILD, EN_EYE, EN_FRECKLES, EN_HAIR_COLOR, EN_HAIR_LENGTH, EN_HAIR_STYLE, EN_HAIR_TYPE, EN_HEIGHT, EN_MAKEUP, EN_SKIN } from './phrases.ts';

export interface RenderOptions {
  profile: Profile;
  length: Length;
  includeNegative: boolean;
}

export interface MetaItem {
  key: string;
  value: string;
}

export interface Rendered {
  /** Готовый текст для копирования (с учётом профиля). */
  main: string;
  negative: string;
  /** Метаданные для показа. */
  metadata: MetaItem[];
  json: string;
  /** Краткое описание параметров по-русски. */
  ru: string;
  words: number;
  problems: string[];
}

// ───────── Английские формулировки ─────────

const cap = (s: string): string => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

export function listJoin(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

const EN_ANGLE: Record<Angle, string> = {
  front: 'seen straight on from the front',
  'three-quarter': 'seen from a three-quarter angle',
  profile: 'seen in side profile',
  'back-head-turn': 'seen from behind as she turns her head back over her shoulder',
  side: 'seen from the side',
  'slightly-above': 'seen from slightly above eye level',
  'slightly-below': 'seen from slightly below eye level',
  'eye-level': 'seen at eye level',
  distant: 'seen from a distance, so the surroundings take up much of the frame',
  'close-up': 'seen very close, her face and shoulders filling the frame',
  'dynamic-tilt': 'seen with a slightly tilted, dynamic handheld framing',
  'face-limited': 'seen with her face partly turned away, so it is only partly visible',
};

const EN_FRAMING: Record<Framing, string> = {
  'close-up': 'framed as a close-up on her face and shoulders',
  portrait: 'framed as a head-and-shoulders portrait',
  'waist-up': 'framed from the waist up',
  'full-body': 'framed full-length with her feet and the ground in view',
  seated: 'framed to show her whole seated figure',
  'in-motion': 'caught mid-movement with a little space ahead of her',
};

const EN_EMOTION: Record<Emotion, string> = {
  'natural-smile': 'a light natural smile',
  'calm-friendly': 'a calm, friendly expression',
  laugh: 'a natural laugh with her eyes crinkled',
  playful: 'a playful half-smile',
  surprise: 'a look of mild surprise',
  thoughtful: 'a thoughtful, absorbed expression',
  neutral: 'a relaxed neutral expression',
  sad: 'a quiet, sad expression',
  crying: 'teary eyes and a natural, unposed expression of crying',
};

const EN_TIME: Record<TimeOfDay, string> = {
  dawn: 'at dawn',
  morning: 'in the morning',
  day: 'in the middle of the day',
  'golden-hour': 'during the golden hour',
  dusk: 'at dusk',
  evening: 'in the evening',
  night: 'at night',
};

const OPEN_WEATHER: Record<Weather, string> = {
  clear: 'under a clear sky',
  'partly-cloudy': 'under a partly cloudy sky',
  overcast: 'under a flat gray overcast sky',
  rain: 'with steady light rain falling',
  'after-rain': 'just after the rain, with the sky clearing',
  fog: 'in thin fog that softens the distance',
  snow: 'with light snow falling',
  windy: 'on a breezy day',
  heat: 'on a hot, dry day',
  frost: 'on a cold, clear frosty day',
};

const WINDOW_WEATHER: Record<Weather, string> = {
  clear: 'a clear sky visible through the window',
  'partly-cloudy': 'scattered clouds visible through the window',
  overcast: 'a flat gray sky visible through the window',
  rain: 'steady rain outside the window',
  'after-rain': 'wet streets and a clearing sky outside the window',
  fog: 'fog outside the window',
  snow: 'snow falling outside the window',
  windy: 'a breezy day outside the window',
  heat: 'a hot, bright day outside the window',
  frost: 'a cold, clear day outside the window',
};

function expressionPhrase(s: PhotoScenario, r: Rng): string {
  const sun = s.subject.glasses === 'sunglasses';
  const em = sun && s.emotion === 'laugh' ? 'a natural laugh' : sun && s.emotion === 'crying' ? 'a natural expression of distress' : EN_EMOTION[s.emotion];
  const mirror = s.capture === 'selfie-mirror';
  const reflect = s.capture === 'selfie-reflection';
  const gazes: Record<Gaze, string> = {
    camera: sun
      ? 'turned toward the camera'
      : mirror
        ? 'looking at the mirror'
        : reflect
          ? 'looking at her reflection'
          : s.capture === 'selfie-arm' || s.capture === 'front-camera'
            ? (selfieGazePhrase(s, selfieExtras(s)) ?? 'looking into the front camera')
            : s.angle === 'back-head-turn'
              ? 'glancing back toward the camera'
              : r.pick(['looking straight into the lens', 'looking toward the camera']),
    away: s.angle === 'back-head-turn' ? 'looking away along the view' : 'looking away from the camera',
    down: mirror || reflect ? 'looking down at her phone screen' : 'her eyes lowered',
    object: 'her attention on what she is doing',
    side: 'glancing off to the side',
  };
  const gaze = gazes[s.gaze];
  if (s.faceVisibility === 'partial') return `What is visible of her face shows ${em}, ${gaze}.`;
  const head = headPoseFor(s);
  if (head) return r.pick([`She has ${em}, ${gaze}, ${HEAD_EN[head]}.`, `${cap(HEAD_EN[head])}, she has ${em}, ${gaze}.`]);
  return r.pick([`She has ${em}, ${gaze}.`, `${cap(gaze)}, she has ${em}.`]);
}

function captureSentence(s: PhotoScenario, r: Rng): string {
  const ex = selfieExtras(s);
  if (ex) return selfieCaptureSentence(s, ex, r);
  const hand = s.hand;
  const map: Record<Capture, string[]> = {
    'selfie-arm': [
      `It is a selfie taken with her ${hand} arm extended toward the front camera; the phone stays out of frame.`,
      `A casual front-camera selfie at arm's length with a slightly wide-angle look; the phone is not visible.`,
    ],
    'front-camera': [
      `Taken with the phone's front camera held close in front of her, framed like a quick video-call still; the phone is not visible.`,
      `A quick front-camera snapshot with the phone held low and close, her arm out of frame and the phone not visible.`,
    ],
    'selfie-mirror': [
      `A mirror selfie: she holds a phone in her ${hand} hand at chest height, and the phone is visible in the mirror next to her reflection.`,
    ],
    'selfie-reflection': [
      `A selfie caught in the reflection of a large glass surface: she holds a phone in her ${hand} hand, and both she and the phone appear in the reflection.`,
    ],
    'tripod-timer': [
      `Taken with the camera propped on a stable surface and triggered by a self-timer, a few steps away from her.`,
      `Shot with a phone on a small tripod using the self-timer, the camera standing a few steps from her.`,
    ],
    'by-acquaintance': [
      `Photographed by an acquaintance a few steps away who asked her to pause for a second; the photographer is not in the frame.`,
      `Taken by an acquaintance standing a few steps away, who said "hold on a moment"; the photographer is not in the frame.`,
    ],
    'by-friend-walk': [
      `Taken by a friend walking beside her, snapped on the move; the friend is not in the frame.`,
      `A frame snapped by a friend who was walking along with her; the friend does not appear in it.`,
    ],
    candid: [
      `A candid frame taken by someone nearby without posing; she is only half aware of the camera.`,
      `An unposed moment caught by someone nearby; she is not performing for the camera.`,
    ],
  };
  return r.pick(map[s.capture]);
}

function appearanceSentence(s: PhotoScenario, length: Length, style: string): string {
  const p = s.subject;
  const hair = `${EN_HAIR_LENGTH[p.hairLength]} ${EN_HAIR_TYPE[p.hairType]} ${EN_HAIR_COLOR[p.hairColor]} hair ${EN_HAIR_STYLE[p.hairStyle]}`;
  const bits = [hair, `${EN_EYE[p.eyeColor]} eyes`, `${EN_SKIN[p.skinTone]} skin with natural texture`];
  if (EN_FRECKLES[p.freckles]) bits.push(EN_FRECKLES[p.freckles]);
  if (p.glasses === 'clear') bits.push('clear-lens glasses');
  let sentence = `${style} of a fictional adult woman, ${p.age} years old, with ${listJoin(bits)}.`;
  if (length !== 'short') {
    const extra = [`She has ${EN_BUILD[p.build]}`, `is ${EN_HEIGHT[p.height]}`];
    let tail = listJoin(extra);
    const feats = p.features.map((f) => FEATURE_BY_ID.get(f)?.en).filter((x): x is string => !!x);
    if (feats.length) tail += `, with ${listJoin(feats)}`;
    tail += `, and ${EN_MAKEUP[p.makeup]}`;
    sentence += ` ${tail}.`;
  } else if (p.makeup !== 'none') {
    sentence += ` ${cap(EN_MAKEUP[p.makeup])}.`;
  }
  return sentence;
}

function styleOpening(s: PhotoScenario): string {
  const bw = s.look.color === 'bw' ? 'black-and-white ' : '';
  switch (s.look.style) {
    case 'smartphone':
      return `A ${bw}photorealistic, everyday smartphone photo`;
    case 'camera':
      return `A ${bw}photorealistic photograph taken with a mirrorless camera`;
    case 'film':
      return `A ${bw}photorealistic photograph with subtle analog film grain`;
    case 'documentary':
      return `A ${bw}photorealistic documentary-style photograph in available light`;
  }
}

const EN_TIME_BARE: Record<TimeOfDay, string> = {
  dawn: 'dawn',
  morning: 'morning',
  day: 'daytime',
  'golden-hour': 'the golden hour',
  dusk: 'dusk',
  evening: 'evening',
  night: 'night',
};

function worldSentence(s: PhotoScenario): string {
  if (s.weatherMode === 'irrelevant') return `It is ${EN_TIME_BARE[s.time]}.`;
  let clause = '';
  if (s.weather !== null) {
    if (s.weatherMode === 'visible') clause = s.view === 'window' ? `, with ${WINDOW_WEATHER[s.weather]}` : `, ${OPEN_WEATHER[s.weather]}`;
    else if (s.weather === 'rain') clause = ', and she has just come in out of the rain';
    else if (s.weather === 'snow') clause = ', and she has just come in from the snow';
  }
  return `It is ${EN_TIME[s.time]} in ${s.season}${clause}.`;
}

function formatSentence(s: PhotoScenario): string {
  const { label, orientation } = s.ratio;
  const word = orientation === 'vertical' ? 'vertical (portrait-orientation)' : orientation === 'horizontal' ? 'horizontal (landscape-orientation)' : 'square';
  const whole = s.framing === 'full-body' || s.framing === 'in-motion' || s.framing === 'seated';
  const target = whole ? 'her whole figure, including head, hands and feet,' : isArmSelfie(s.capture) ? (selfieExtras(s)?.freeHand ? 'her head and free hand' : 'her head') : 'her head and hands';
  const wide = s.ratio.w / s.ratio.h >= 1.9 ? ' with enough surrounding space to read the setting' : '';
  return `Composed for a ${word} ${label} frame${wide}; keep ${target} fully inside the frame with comfortable margins.`;
}

const REALISM = [
  'Natural skin texture with visible pores and fine hairs, no beauty retouching, ordinary believable surroundings.',
  'Unretouched, true-to-life skin and fabrics, believable proportions and consistent shadows.',
  'Real-world imperfections stay in: uneven skin tone, creases in the clothes, objects that were not arranged for the camera.',
  'Skin shows natural variation, with slight redness and tiny blemishes, and the clothes have real creases and wear.',
  'Unposed and unstyled: nobody arranged the light, the pose or the background for this picture.',
];

const REALISM_PHONE = [
  'It reads as an unedited phone snapshot, not a styled photoshoot: ordinary light, ordinary framing, no studio polish.',
  'Casual phone-snapshot framing: not perfectly composed, the subject slightly off-center, with no deliberate styling.',
];

function sharpnessSentence(s: PhotoScenario): string {
  const dark = s.time === 'dusk' || s.time === 'evening' || s.time === 'night';
  const phone = s.look.style === 'smartphone';
  if (s.look.sharpness === 'sharp') {
    if (dark) {
      return phone
        ? 'Phone-camera low-light rendering: visible noise in the shadows and softer distant detail, with no artificial blur.'
        : 'Even in the low light the background stays readable, with only mild noise in the shadows and no artificial blur.';
    }
    return phone
      ? 'Phone-camera depth of field: the whole scene is in focus, but distant details are slightly soft and simplified, with no portrait-mode blur.'
      : 'The background stays clear and readable, without artificial blur.';
  }
  if (s.look.sharpness === 'moderate') return 'Moderate, natural depth of field: the background is slightly softer but still readable.';
  return 'Shallow depth of field with a softly blurred background.';
}

const COLOR_SENTENCE = {
  natural: 'True-to-life colors with no filter, grading or HDR boost.',
  bw: 'Black-and-white image with a natural tonal range.',
  muted: 'Muted, slightly desaturated natural colors.',
  film: 'Film-like color rendition with subtle grain.',
} as const;

const STYLE_TAIL = {
  smartphone: 'Natural smartphone image processing without a heavy HDR look.',
  camera: 'Shot at a 35mm-equivalent focal length with natural perspective.',
  film: 'Gentle film grain and soft highlight roll-off.',
  documentary: 'Available light only, no staged lighting.',
} as const;

export function buildNegative(s: PhotoScenario): string {
  const items = [
    'plastic skin',
    'excessive beauty retouching',
    'airbrushed face',
    'distorted hands',
    'extra fingers',
    'fused fingers',
    'warped architecture',
    'inconsistent shadows',
    'duplicate limbs',
    'extra limbs',
    'text artifacts',
    'watermarks',
    'logos',
    'oversaturated colors',
    'HDR look',
    'cartoon',
    'illustration',
    '3D render',
    'deformed eyes',
  ];
  if (s.look.sharpness !== 'blur') items.push('fake bokeh', 'artificial background blur');
  if (s.capture === 'selfie-arm' || s.capture === 'front-camera') items.push('visible phone in a front-camera selfie');
  if (s.crowd === 'none') items.push('second person in the frame');
  else items.push('a second main subject');
  if (s.look.color === 'natural') items.push('heavy color filters');
  if (s.time === 'night' || s.time === 'dusk' || s.time === 'evening') items.push('daytime lighting in a night scene');
  items.push(...NEGATIVE_BACKGROUND);
  return items.join(', ');
}

/** Профиль-независимый связный текст: порядок задан требованиями проекта. */
export function buildCore(s: PhotoScenario, length: Length): string {
  const r = createRng(`${s.seed}:${s.id}:render`);
  const parts: string[] = [];
  parts.push(appearanceSentence(s, length, styleOpening(s)));
  parts.push(`She is ${s.action.en} ${s.place}.`);
  parts.push(captureSentence(s, r.fork('capture')));
  parts.push(`${cap(EN_FRAMING[s.framing])}, ${EN_ANGLE[s.angle]}.`);

  const acc = s.accessories.map((id) => ACCESSORY_BY_ID.get(id)?.en).filter((x): x is string => !!x);
  const wear = [...(s.subject.glasses === 'sunglasses' ? ['sunglasses'] : []), ...acc];
  parts.push(`She wears ${s.outfit.en}${wear.length ? `, along with ${listJoin(wear)}` : ''}.`);
  parts.push(expressionPhrase(s, r.fork('expr')));
  parts.push(worldSentence(s));
  parts.push(`Lighting: ${s.light}.`);

  if (length !== 'short') {
    const rr = r.fork('bg');
    const fg = length === 'standard' ? s.fg.slice(0, 1) : s.fg;
    const mid = length === 'standard' ? s.mid.slice(0, 1) : s.mid;
    const far = length === 'standard' ? s.far.slice(0, 1) : s.far;
    const layers = rr.pick([
      `In the foreground there is ${listJoin(fg)}. Behind her are ${listJoin(mid)}, and farther back ${listJoin(far)}.`,
      `Close to the lens: ${listJoin(fg)}. Behind her: ${listJoin(mid)}, and farther back ${listJoin(far)}.`,
      `The surroundings are ordinary and lived-in: ${listJoin(fg)} close by, ${listJoin(mid)} behind her, ${listJoin(far)} in the distance.`,
    ]);
    parts.push(layers);
    parts.push(
      s.crowd === 'incidental'
        ? 'She is the only main subject; a few unposed passers-by appear small and far behind her, caught mid-step, some turned away or partly cut off by the frame, none of them looking at the camera.'
        : 'She is the only person in the frame.',
    );
    const det = length === 'standard' ? s.details.slice(0, 2) : s.details;
    if (det.length) parts.push(`Small details: ${listJoin(det)}.`);
    parts.push(...backgroundRealism(s, r.fork('auth'), length === 'detailed' ? 3 : 2, layers.startsWith('The surroundings are ordinary') ? [TIDY_LINE] : []));
    if (s.imperfections.length) parts.push(`Photographic imperfections: ${listJoin(length === 'detailed' ? s.imperfections : s.imperfections.slice(0, 2))}.`);
    parts.push(r.fork('realism').pick(s.look.style === 'smartphone' ? [...REALISM, ...REALISM_PHONE] : REALISM));
    const cam = cameraCharacter(s);
    if (cam) parts.push(cam);
    parts.push(sharpnessSentence(s));
    parts.push(COLOR_SENTENCE[s.look.color]);
    if (length === 'detailed' || s.look.style === 'smartphone') parts.push(STYLE_TAIL[s.look.style]);
  } else {
    parts.push(...backgroundRealism(s, r.fork('auth'), 1));
    parts.push(sharpnessSentence(s));
    parts.push('Natural skin texture, no beauty retouching.');
  }
  parts.push(formatSentence(s));
  return parts.join(' ');
}

export function profileText(core: string, negative: string, profile: Profile, includeNegative: boolean): string {
  switch (profile) {
    case 'universal':
      return core;
    case 'gpt-image':
      return includeNegative ? `${core}\n\nAvoid: ${negative}.` : core;
    case 'nano-banana':
      return `Create a photorealistic image. ${core}${includeNegative ? `\n\nDo not include: ${negative}.` : ''}`;
    case 'seedance': {
      const compact = core.replace(/\s+/g, ' ').replace(/\. /g, '; ').replace(/\.$/, '');
      return `Single still frame, no camera movement: ${compact}${includeNegative ? `; avoid: ${negative}` : ''}`;
    }
  }
}

// ───────── Метаданные, русское описание, JSON ─────────

function metaItems(s: PhotoScenario, opts: RenderOptions): MetaItem[] {
  const m: MetaItem[] = [
    { key: 'Seed', value: s.seed },
    { key: 'ID сценария', value: s.id },
    { key: 'Режим', value: L_MODE[s.mode] },
    { key: 'Aspect ratio', value: `${s.ratio.label} (${s.ratio.orientation === 'vertical' ? 'вертикальный' : s.ratio.orientation === 'horizontal' ? 'горизонтальный' : 'квадрат'})` },
    { key: 'Возраст', value: `${s.subject.age}` },
    { key: 'Локация', value: `${s.sceneTitle} (${L_CATEGORY[s.category]})` },
    { key: 'Сезон', value: L_SEASON[s.season] },
    { key: 'Погода', value: s.weather === null ? 'не применима (помещение без окон)' : L_WEATHER[s.weather] },
    { key: 'Время суток', value: L_TIME[s.time] },
    { key: 'Тип съёмки', value: L_CAPTURE[s.capture] },
    { key: 'Кадрирование', value: L_FRAMING[s.framing] },
    { key: 'Ракурс', value: L_ANGLE[s.angle] },
    { key: 'Эмоция и взгляд', value: `${L_EMOTION[s.emotion]}; ${L_GAZE[s.gaze].toLowerCase()}` },
    { key: 'Стиль', value: `${L_STYLE[s.look.style]}; ${L_COLOR[s.look.color].toLowerCase()}; ${L_SHARPNESS[s.look.sharpness].toLowerCase()}` },
    { key: 'Профиль экспорта', value: `${L_PROFILE[opts.profile]} (только форматирование текста)` },
    { key: 'Длина', value: L_LENGTH[opts.length] },
    { key: 'Версия движка', value: `${s.engine} (попытка ${s.attempt + 1})` },
  ];
  const ex = selfieExtras(s);
  if (ex) {
    m.push({ key: 'Рука с телефоном', value: ex.grip === 'both-hands' ? 'обе руки' : `${RU_HAND[ex.hand]}; ${RU_GRIP[ex.grip]}` });
    if (ex.freeHand) m.push({ key: 'Свободная рука', value: RU_FREE_HAND[ex.freeHand] });
  }
  const head = headPoseFor(s, ex);
  if (head) m.push({ key: 'Положение головы', value: RU_HEAD[head] });
  if (s.locks.length) m.push({ key: 'Закреплено', value: s.locks.map((l) => L_LOCK[l]).join(', ') });
  if (s.notes.length) m.push({ key: 'Примечания', value: s.notes.join(' ') });
  return m;
}

export function buildRussian(s: PhotoScenario): string {
  const p = s.subject;
  const feats = p.features.map((f) => FEATURE_BY_ID.get(f)?.ru).filter((x): x is string => !!x);
  const acc = s.accessories.map((id) => ACCESSORY_BY_ID.get(id)?.ru).filter((x): x is string => !!x);
  const lines = [
    `Вымышленная взрослая женщина, ${p.age} лет. Волосы: ${L_HAIR_LENGTH[p.hairLength].toLowerCase()}, ${L_HAIR_TYPE[p.hairType].toLowerCase()}, ${L_HAIR_COLOR[p.hairColor].toLowerCase()}, причёска — ${L_HAIR_STYLE[p.hairStyle].toLowerCase()}. Глаза: ${L_EYE_COLOR[p.eyeColor].toLowerCase()}. Кожа: ${L_SKIN_TONE[p.skinTone].toLowerCase()}. Телосложение: ${L_BUILD[p.build].toLowerCase()}, рост: ${L_HEIGHT[p.height].toLowerCase()}. Макияж: ${L_MAKEUP[p.makeup].toLowerCase()}.${feats.length ? ` Особенности: ${feats.join(', ')}.` : ''}`,
    `Сцена: ${s.sceneTitle}. Действие: ${s.action.ru}.`,
    `Съёмка: ${L_CAPTURE[s.capture].toLowerCase()}; кадрирование — ${L_FRAMING[s.framing].toLowerCase()}; ракурс — ${L_ANGLE[s.angle].toLowerCase()}.`,
    `Одежда: ${s.outfit.ru}${acc.length ? `; аксессуары: ${acc.join(', ')}` : ''}${p.glasses === 'sunglasses' ? '; солнцезащитные очки' : p.glasses === 'clear' ? '; очки с прозрачными стёклами' : ''}.`,
    `Эмоция: ${L_EMOTION[s.emotion].toLowerCase()}; взгляд: ${L_GAZE[s.gaze].toLowerCase()}.`,
    s.weatherMode === 'irrelevant'
      ? `Время суток: ${L_TIME[s.time].toLowerCase()}. Освещение — искусственное, по месту.`
      : `${L_SEASON[s.season]}, ${s.weather ? L_WEATHER[s.weather].toLowerCase() : ''}, ${L_TIME[s.time].toLowerCase()}.`.replace(/, ,/g, ','),
    `Формат кадра ${s.ratio.label}; фон описан как обычное, не постановочное место. Подробные детали фона — в английском тексте.`,
  ];
  const ex = selfieExtras(s);
  const head = headPoseFor(s, ex);
  const extra: string[] = [];
  if (ex) {
    const hold = ex.grip === 'both-hands' ? 'в обеих руках' : `в ${s.hand === 'left' ? 'левой' : 'правой'} руке`;
    extra.push(`Телефон: ${hold}, ${RU_GRIP[ex.grip].toLowerCase()}${ex.freeHand ? `; свободная рука — ${RU_FREE_HAND[ex.freeHand]}` : ''}.`);
  }
  if (head) extra.push(`Положение головы: ${RU_HEAD[head].toLowerCase()}.`);
  if (extra.length) lines.splice(3, 0, ...extra);
  return lines.join('\n');
}

export function renderScenario(s: PhotoScenario, opts: RenderOptions): Rendered {
  const core = buildCore(s, opts.length);
  const negative = buildNegative(s);
  const main = profileText(core, negative, opts.profile, opts.includeNegative);
  const metadata = metaItems(s, opts);
  const ru = buildRussian(s);
  // В negative-списке слова «logos», «watermarks» уместны — это то, чего нужно избегать.
  const problems = [...safetyProblems(core), ...safetyProblems(negative, { allowTextTerms: true })];
  const json = JSON.stringify(
    {
      app: 'RealPhoto Prompt Studio',
      engine: ENGINE_VERSION,
      profile: opts.profile,
      length: opts.length,
      prompt: { main, negative: opts.includeNegative ? negative : null },
      metadata: Object.fromEntries(metadata.map((m) => [m.key, m.value])),
      scenario: s,
    },
    null,
    2,
  );
  return { main, negative, metadata, json, ru, words: main.split(/\s+/).filter(Boolean).length, problems };
}

