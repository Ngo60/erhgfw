import { describe, expect, it } from 'vitest';
import { safetyProblems } from '../src/core/safety.ts';
import { defaultSettings, normalizeSettings } from '../src/core/settings.ts';
import type { Settings } from '../src/core/settings.ts';
import type { PhotoScenario } from '../src/core/types.ts';
import { CAPTURES } from '../src/core/vocab.ts';
import type { Capture } from '../src/core/vocab.ts';
import { SCENE_BY_ID } from '../src/data/scenes/index.ts';
import { ENGINE_VERSION } from '../src/engine/compose.ts';
import { generateScenario } from '../src/engine/generate.ts';
import { buildNegative, renderScenario } from '../src/render/render.ts';
import { FREE_HAND_EN, HEAD_EN, headPoseFor, isArmSelfie, isMirrorSelfie, selfieExtras } from '../src/render/selfie.ts';
import { contradictions } from './helpers.ts';

function settingsFor(capture: Capture | null, patch?: (s: Settings) => void): Settings {
  const s = defaultSettings();
  if (capture) for (const c of CAPTURES) s.captureShares[c] = c === capture ? 100 : 0;
  patch?.(s);
  return normalizeSettings({ ...s, mode: 'new' }).settings;
}

function frames(capture: Capture | null, n: number, prefix: string, patch?: (s: Settings) => void): PhotoScenario[] {
  const st = settingsFor(capture, patch);
  const out: PhotoScenario[] = [];
  for (let i = 0; i < n; i++) {
    const g = generateScenario({ settings: st, seed: `${prefix}-${i}`, index: i });
    if (g.ok) out.push(g.result.scenario);
  }
  return out;
}

const render = (s: PhotoScenario, length: 'short' | 'standard' | 'detailed' = 'standard') => renderScenario(s, { profile: 'gpt-image', length, includeNegative: true });
const share = (xs: string[], v: string): number => xs.filter((x) => x === v).length / xs.length;
const maxShare = (xs: string[]): number => Math.max(...[...new Set(xs)].map((v) => share(xs, v)));

const ARM = [...frames('selfie-arm', 300, 'SR-arm'), ...frames('front-camera', 300, 'SR-front')];
const MIRROR = [...frames('selfie-mirror', 250, 'SR-mirror'), ...frames('selfie-reflection', 120, 'SR-glass')];

describe('селфи: рука с телефоном', () => {
  it('в тексте всегда названа рука (или обе руки), а сторона входа руки в кадр согласована с ней', () => {
    for (const s of [...ARM, ...MIRROR]) {
      const ex = selfieExtras(s)!;
      const text = render(s).main;
      if (ex.grip === 'both-hands') expect(text).toContain('with both hands');
      else expect(text, s.id).toContain(`in her ${ex.hand} hand`);
      const m = /the arm entering from the (left|right) edge of the frame/.exec(text);
      if (m) expect(m[1]).toBe(ex.hand === 'right' ? 'left' : 'right');
    }
  });

  it('левая и правая рука встречаются примерно поровну', () => {
    for (const set of [ARM, MIRROR]) {
      const hands = set.map((s) => selfieExtras(s)!.hand);
      expect(share(hands, 'left')).toBeGreaterThan(0.4);
      expect(share(hands, 'left')).toBeLessThan(0.6);
    }
  });

  it('хваты разнообразны, а ракурс не противоречит хвату', () => {
    const grips = ARM.map((s) => selfieExtras(s)!.grip);
    expect(new Set(grips).size).toBeGreaterThanOrEqual(5);
    expect(maxShare(grips)).toBeLessThan(0.4);
    for (const s of ARM) {
      const g = selfieExtras(s)!.grip;
      if (s.angle === 'slightly-above') expect(g).not.toBe('low');
      if (s.angle === 'slightly-below') expect(g).not.toBe('high');
      if (s.framing === 'close-up') expect(g).not.toBe('both-hands');
      if (s.action.hands > 0) expect(g).not.toBe('both-hands');
    }
    const mirrorGrips = MIRROR.map((s) => selfieExtras(s)!.grip);
    expect(new Set(mirrorGrips).size).toBe(4);
  });

  it('свободная рука появляется только там, где она действительно свободна и уместна', () => {
    let withFree = 0;
    for (const s of [...ARM, ...MIRROR]) {
      const ex = selfieExtras(s)!;
      if (!ex.freeHand) continue;
      withFree++;
      expect(s.action.hands, s.id).toBe(0);
      expect(s.action.en).not.toMatch(/\b(hands?|pockets?|palms?|arms?|fingers?|wrists?)\b/i);
      expect(ex.grip).not.toBe('both-hands');
      if (ex.freeHand === 'glasses') expect(s.subject.glasses).not.toBe('none');
      if (ex.freeHand === 'necklace') expect(s.accessories).toContain('necklace');
      if (ex.freeHand === 'strap') expect(s.accessories.some((a) => ['backpack', 'tote-bag', 'crossbody-bag'].includes(a))).toBe(true);
      if (ex.freeHand === 'collar') expect(s.outfit.en).toMatch(/coat|jacket|hoodie|cardigan|blazer|parka|windbreaker|sweatshirt/i);
      if (ex.freeHand === 'lean') expect(s.action.posture).toBe('lean');
      expect(render(s).main).toContain(`Her free hand is ${FREE_HAND_EN[ex.freeHand]}`);
    }
    expect(withFree).toBeGreaterThan(40);
  });

  it('с солнцезащитными очками взгляд на экран не описывается; формат кадра не требует «руки с телефоном» целиком', () => {
    const sun = ARM.filter((s) => s.subject.glasses === 'sunglasses');
    expect(sun.length).toBeGreaterThan(0);
    for (const s of sun) expect(render(s).main).not.toContain('own image on the phone screen');
    for (const s of ARM) {
      const text = render(s).main;
      expect(text).not.toContain('keep her head and hands fully inside');
      expect(text.includes('her head and free hand fully inside')).toBe(!!selfieExtras(s)!.freeHand);
    }
  });
});

describe('селфи: положение головы', () => {
  it('положение головы разнообразно и согласовано с ракурсом и эмоцией', () => {
    const heads = ARM.map((s) => selfieExtras(s)!.head);
    expect(new Set(heads).size).toBeGreaterThanOrEqual(7);
    expect(maxShare(heads)).toBeLessThan(0.25);
    for (const s of [...ARM, ...MIRROR]) {
      const h = selfieExtras(s)!.head;
      if (s.angle === 'slightly-below') expect(h).not.toBe('chin-down');
      if (h === 'laugh-back') expect(s.emotion).toBe('laugh');
      expect(render(s).main.toLowerCase()).toContain(HEAD_EN[h]);
    }
  });

  it('голова описана и при съёмке по таймеру и от знакомого (если смотрит в камеру), но не при других взглядах', () => {
    const timer = frames('tripod-timer', 200, 'SR-timer');
    const friend = frames('by-acquaintance', 200, 'SR-acq');
    for (const s of [...timer, ...friend]) {
      expect(selfieExtras(s)).toBeNull();
      const h = headPoseFor(s);
      if (s.gaze === 'camera' && s.faceVisibility === 'full') {
        expect(h).not.toBeNull();
        expect(h).not.toBe('lean-in');
        expect(render(s).main.toLowerCase()).toContain(HEAD_EN[h!]);
      } else expect(h).toBeNull();
    }
    expect(new Set([...timer, ...friend].map((s) => headPoseFor(s)).filter(Boolean)).size).toBeGreaterThanOrEqual(6);
  });

  it('взгляд на экран у селфи встречается, но не всегда', () => {
    const eyes = ARM.filter((s) => s.subject.glasses !== 'sunglasses').map((s) => selfieExtras(s)!.eyes);
    expect(share(eyes, 'screen')).toBeGreaterThan(0.15);
    expect(share(eyes, 'screen')).toBeLessThan(0.45);
  });
});

describe('селфи: ракурс в движке', () => {
  it('чуть сверху и с наклоном — чаще, анфас — реже, чем раньше', () => {
    const angles = ARM.map((s) => s.angle);
    expect(share(angles, 'slightly-above')).toBeGreaterThan(0.14);
    expect(share(angles, 'front')).toBeLessThan(0.26);
    expect(new Set(angles).size).toBeGreaterThanOrEqual(5);
  });

  it('версия движка повышена: текст кадров изменился', () => {
    expect(ENGINE_VERSION).not.toBe('1.0.0');
  });
});

describe('детерминизм и совместимость', () => {
  it('один и тот же кадр даёт один и тот же текст и одни и те же параметры селфи', () => {
    for (const s of [...ARM.slice(0, 40), ...MIRROR.slice(0, 40)]) {
      expect(selfieExtras(s)).toEqual(selfieExtras(structuredClone(s)));
      expect(render(s).main).toBe(render(structuredClone(s)).main);
    }
  });

  it('профиль и длина не меняют выбор деталей селфи', () => {
    for (const s of ARM.slice(0, 40)) {
      const ex = selfieExtras(s);
      render(s, 'short');
      render(s, 'detailed');
      expect(selfieExtras(s)).toEqual(ex);
    }
  });

  it('выбор остальных параметров сценария от селфи-деталей не зависит (детали берутся из отдельного потока)', () => {
    const a = frames('selfie-arm', 20, 'SR-stable');
    const b = frames('selfie-arm', 20, 'SR-stable');
    expect(a.map((s) => s.id)).toEqual(b.map((s) => s.id));
  });

  it('у других способов съёмки селфи-параметров нет', () => {
    for (const c of ['tripod-timer', 'by-acquaintance', 'by-friend-walk', 'candid'] as const) {
      for (const s of frames(c, 30, `SR-other-${c}`)) {
        expect(selfieExtras(s)).toBeNull();
        expect(isArmSelfie(c) || isMirrorSelfie(c)).toBe(false);
      }
    }
  });
});

describe('метаданные и сводка', () => {
  it('в метаданных и русской сводке есть рука, хват, свободная рука и положение головы', () => {
    const s = ARM.find((x) => selfieExtras(x)?.freeHand && selfieExtras(x)?.grip !== 'both-hands')!;
    const r = render(s);
    const keys = r.metadata.map((m) => m.key);
    expect(keys).toContain('Рука с телефоном');
    expect(keys).toContain('Свободная рука');
    expect(keys).toContain('Положение головы');
    expect(r.ru).toContain('Телефон:');
    expect(r.ru).toContain('Положение головы:');
    expect(r.ru).not.toContain('фон по умолчанию чёткий');
    const none = frames('candid', 5, 'SR-meta-candid')[0]!;
    expect(render(none).metadata.map((m) => m.key)).not.toContain('Рука с телефоном');
  });
});

describe('реализм фона и кадра', () => {
  const SAMPLE = frames(null, 240, 'SR-real');

  it('нет «сценических» слоёв и «резкого везде»; есть описание обычного, не постановочного места', () => {
    for (const s of SAMPLE) {
      const text = render(s).main;
      expect(text).not.toContain('Middle distance:');
      expect(text).not.toContain('Foreground:');
      if (s.look.style === 'smartphone' && s.look.sharpness === 'sharp') {
        const night = s.time === 'dusk' || s.time === 'evening' || s.time === 'night';
        expect(text).toContain(night ? 'Phone-camera low-light rendering' : 'no portrait-mode blur');
        expect(text).not.toContain('The background stays clear and readable');
      }
    }
  });

  it('в стандартной длине есть минимум 2 предложения о естественности фона и (если есть) недостатки съёмки', () => {
    const marks = [/tidied or arranged/, /edges of the frame are partly cut off/, /scenic postcard view/, /not composed like/, /plain and/, /light is uneven/, /ordinary signs of use/, /everyday wear/, /too small to read/, /differ in color temperature/];
    for (const s of SAMPLE) {
      const text = render(s).main;
      const hits = marks.filter((m) => m.test(text)).length;
      expect(hits, s.id).toBeGreaterThanOrEqual(1);
      if (s.imperfections.length) {
        expect(text).toContain('Photographic imperfections:');
        expect(text).toContain(s.imperfections[0]!);
      }
    }
  });

  it('прохожие: подробное описание только если они есть в кадре', () => {
    for (const s of SAMPLE) {
      const text = render(s).main;
      if (s.crowd === 'incidental') expect(text).toContain('caught mid-step');
      else expect(text).toContain('She is the only person in the frame.');
    }
  });

  it('negative содержит признаки постановочного ИИ-фона', () => {
    const n = buildNegative(SAMPLE[0]!);
    for (const item of ['staged or overly curated background', 'postcard-perfect scenery', 'stock photo look', 'identical faceless crowd', 'garbled signs or text in the background']) expect(n).toContain(item);
  });
});

describe('безопасность, противоречия и размер', () => {
  const ALL = frames(null, 700, 'SR-all');

  it('нет нарушений безопасности и противоречий во всех длинах и профилях', () => {
    for (const s of ALL) {
      const water = SCENE_BY_ID.get(s.sceneId)?.tags.includes('water') ?? false;
      for (const length of ['short', 'standard', 'detailed'] as const) {
        const r = renderScenario(s, { profile: 'universal', length, includeNegative: true });
        expect(r.problems, `${s.id} ${length}`).toEqual([]);
        // «sun spots» — особая примета кожи (уже была в данных), а не солнечный свет: проверка по словам её не различает
        expect(contradictions(r.main.replace(/\bsun spots\b/gi, 'age spots'), s, water), `${s.id} ${length}`).toEqual([]);
        expect(r.main).toContain(`${s.subject.age} years old`);
      }
    }
  });

  it('безопасность проверена на выделенных наборах селфи', () => {
    for (const s of [...ARM, ...MIRROR]) {
      const core = renderScenario(s, { profile: 'universal', length: 'standard', includeNegative: false });
      expect(core.problems, s.id).toEqual([]);
      expect(safetyProblems(core.main, { allowTextTerms: false }), s.id).toEqual([]);
    }
  });

  it('длина промптов укладывается в пределы (мост принимает до 8000 символов)', () => {
    for (const s of ALL) {
      expect(render(s, 'short').main.length).toBeLessThan(2600);
      expect(render(s, 'standard').main.length).toBeLessThan(4400);
      expect(render(s, 'detailed').main.length).toBeLessThan(6800);
    }
  });
});
