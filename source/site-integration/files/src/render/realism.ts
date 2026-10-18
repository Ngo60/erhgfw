// Реалистичность фона и «характер камеры». Чистые функции: зависят только от сценария и переданного потока случайных чисел.
// Цель — убрать признаки, по которым ИИ-кадр узнаётся: постановочный, «открыточный» и везде одинаково резкий фон,
// симметрия, идеальное равномерное освещение, безликая «идеальная» толпа и однотипные кадры-селфи.
import type { PhotoScenario } from '../core/types.ts';
import type { Rng } from '../engine/rng.ts';
import { isArmSelfie, isMirrorSelfie } from './selfie.ts';

interface Line {
  text: string;
  w: number;
  when?: (s: PhotoScenario) => boolean;
}

const dark = (s: PhotoScenario): boolean => s.time === 'dusk' || s.time === 'evening' || s.time === 'night';
const skyOk = (s: PhotoScenario): boolean => s.weather !== null && ['clear', 'partly-cloudy', 'overcast', 'windy', 'heat'].includes(s.weather);

export const TIDY_LINE = 'Nothing in the scene has been tidied or arranged for the photo; it looks like an ordinary, slightly messy real place.';

const BACKGROUND_LINES: readonly Line[] = [
  { text: TIDY_LINE, w: 3 },
  { text: 'Objects near the edges of the frame are partly cut off, and nothing in the background is symmetrical or perfectly aligned.', w: 2.5 },
  {
    text: 'This is not a scenic postcard view: the place looks ordinary and unremarkable, with the occasional unrelated object, wire, sign or parked vehicle near the edges.',
    w: 2.6,
    when: (s) => s.env !== 'indoor' && (s.category === 'city' || s.category === 'everyday' || s.category === 'food' || s.category === 'travel'),
  },
  {
    text: 'The landscape is not composed like a postcard: the horizon is not perfectly framed and there is no dramatic light, only what the moment happened to give.',
    w: 2.6,
    when: (s) => s.env !== 'indoor' && (s.category === 'nature' || s.category === 'water-sport' || s.category === 'travel'),
  },
  { text: 'The sky is plain and a little overexposed rather than dramatic.', w: 1.8, when: (s) => s.env === 'outdoor' && s.weatherMode === 'visible' && s.view !== 'window' && !dark(s) && skyOk(s) },
  { text: 'The light is uneven, with some corners darker and some surfaces slightly blown out, not evenly lit like a studio or a render.', w: 2.5, when: (s) => s.env === 'indoor' && !dark(s) },
  { text: 'The room shows ordinary signs of use: a few unrelated things lying around that nobody posed.', w: 2, when: (s) => s.env === 'indoor' && s.category === 'home' },
  { text: 'Surfaces in the background show everyday wear: scuffs, uneven paint, dust and faded edges.', w: 1.6, when: (s) => s.env !== 'outdoor' },
  { text: 'Signs and screens in the background are out of focus, turned away or too small to read.', w: 1.8, when: (s) => s.category === 'city' || s.category === 'food' || s.category === 'everyday' },
  { text: 'Light sources in the background differ in color temperature; some bright lamps are slightly blown out while the shadows stay noisy.', w: 3, when: dark },
];

/** До count разных предложений об «обычности» фона без повторов; подбор учитывает сцену, время суток и людей в кадре. */
export function backgroundRealism(s: PhotoScenario, r: Rng, count: number, skip: readonly string[] = []): string[] {
  const pool = BACKGROUND_LINES.filter((l) => !skip.includes(l.text) && (!l.when || l.when(s)));
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const pick = r.weighted(pool, (l) => (out.includes(l.text) ? 0 : l.w));
    if (!pick) break;
    out.push(pick.text);
  }
  return out;
}

/** Особенности картинки именно от фронтальной камеры или зеркала (для остальных способов съёмки — null). */
export function cameraCharacter(s: PhotoScenario): string | null {
  if (isArmSelfie(s.capture) && s.look.style === 'smartphone') {
    return 'Front-camera look: slightly wide-angle perspective, so her face and the arm nearest the lens look a little larger than the rest of her, with mild stretching toward the edges of the frame.';
  }
  if (isMirrorSelfie(s.capture)) {
    return 'The reflective surface is not perfectly clean: faint smudges, slight distortion near its edges, and a bit of its frame or edge may show.';
  }
  return null;
}

/** Дополнительные пункты negative: признаки «постановочного» ИИ-фона. */
export const NEGATIVE_BACKGROUND: readonly string[] = [
  'staged or overly curated background',
  'postcard-perfect scenery',
  'stock photo look',
  'cinematic color grading',
  'perfectly symmetrical composition',
  'uniformly razor-sharp background',
  'repeated or duplicated background objects',
  'garbled signs or text in the background',
  'identical faceless crowd',
];
