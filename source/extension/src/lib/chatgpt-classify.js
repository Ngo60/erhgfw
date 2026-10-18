// Чистый анализ снимка страницы ChatGPT (без DOM): блокировки, ход генерации, найденные новые изображения.
// Используется и content script (во время ожидания), и service worker (проверка перед отправкой), и тестами.
import { PATTERNS } from './chatgpt-selectors.js';
import { KEY_SEP, squash } from './prompt.js';

export function matchAny(text, list) {
  for (const re of list) {
    const m = re.exec(text);
    if (m) return m[0];
  }
  return null;
}

/**
 * Последний пользовательский ход, содержащий все фрагменты ключа (см. promptKey). Пробелы не учитываются: ChatGPT склеивает
 * абзацы без пробела, а скрытый заголовок «You said:» перед текстом не мешает.
 */
export function findUserTurn(snap, key) {
  if (!key) return null;
  const needles = String(key).split(KEY_SEP).map(squash).filter(Boolean);
  if (!needles.length) return null;
  const turns = snap.turns ?? [];
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i];
    if (t.role !== 'user') continue;
    const text = squash(t.text);
    if (needles.every((n) => text.includes(n))) return t;
  }
  return null;
}

const BLOCK_TEXT = {
  CAPTCHA: 'Обнаружена проверка безопасности (CAPTCHA/Cloudflare).',
  AUTH_REQUIRED: 'Страница ChatGPT просит войти в аккаунт.',
  RATE_LIMIT: 'ChatGPT сообщил об ограничении.',
  UI_CHANGED: 'Не найдено поле ввода сообщения ChatGPT.',
};

/**
 * @param {object} snap снимок страницы (см. content/chatgpt.js collectSnapshot)
 * @param {{key?:string, baselineTurnCount?:number, baselineKeys?:string[], usedKeys?:string[], minSide?:number, requireUi?:boolean}} ctx
 */
export function analyzeSnapshot(snap, ctx = {}) {
  const out = {
    blocker: null,
    offline: snap.online === false,
    generating: Boolean(snap.hasStop),
    // В пустом поле ввода ChatGPT нет кнопки отправки (она появляется с текстом), поэтому о «изменении интерфейса» говорит только
    // отсутствие самого поля ввода; кнопка проверяется после вставки текста.
    uiMissing: !snap.hasComposer,
    userTurn: null,
    newImages: [],
    smallImages: [],
    loadingImages: 0,
    policy: null,
    genError: null,
    assistantText: '',
    sig: '',
  };
  const block = (code, detail) => {
    if (!out.blocker) out.blocker = { code, message: detail ? `${BLOCK_TEXT[code]} «${String(detail).slice(0, 160)}»` : BLOCK_TEXT[code] };
  };

  if (snap.captchaUi || snap.captchaText) block('CAPTCHA');
  if (snap.loginUi || snap.authUrl) block('AUTH_REQUIRED');

  const turns = snap.turns ?? [];
  const userTurn = ctx.key ? findUserTurn(snap, ctx.key) : null;
  out.userTurn = userTurn;
  const fromIndex = userTurn ? userTurn.i + 1 : (ctx.baselineTurnCount ?? Number.POSITIVE_INFINITY);
  const after = turns.filter((t) => t.i >= fromIndex && t.role !== 'user');
  out.assistantText = after.map((t) => t.text).join(' ').slice(0, 600);

  const limitHit = matchAny(` ${(snap.alerts ?? []).join(' ')} ${out.assistantText}`, PATTERNS.rateLimit);
  if (limitHit) block('RATE_LIMIT', limitHit);

  const hasImages = after.some((t) => (t.images ?? []).length > 0);
  if (!hasImages) out.policy = matchAny(out.assistantText, PATTERNS.policy);
  out.genError = matchAny((snap.alerts ?? []).join(' '), PATTERNS.genError);

  const baseline = new Set(ctx.baselineKeys ?? []);
  const used = new Set(ctx.usedKeys ?? []);
  const minSide = ctx.minSide ?? 0;
  const seen = new Set();
  for (const t of after) {
    for (const img of t.images ?? []) {
      if (seen.has(img.key) || baseline.has(img.key) || used.has(img.key)) continue;
      seen.add(img.key);
      if (!img.complete || !img.w || !img.h) out.loadingImages += 1;
      else if (Math.min(img.w, img.h) < minSide) out.smallImages.push(img);
      else out.newImages.push(img);
    }
  }
  out.sig = [out.generating ? 'g' : 'i', out.newImages.map((i) => i.key).join(','), out.loadingImages, out.smallImages.length, turns.length, out.assistantText.length].join('|');

  if (ctx.requireUi && out.uiMissing) block('UI_CHANGED');
  return out;
}

/**
 * Решение «что сейчас с генерацией» по снимку страницы. Чистая функция: состояние наблюдения (watch) возвращается наружу,
 * поэтому её можно вызывать и в content script (реальное время), и в тестах (виртуальное).
 * @returns {{result:{status:'pending'|'done'|'blocked'|'error', [k:string]:any}, watch:object}}
 */
export function decideWait(snap, ctx, watch, nowMs, opts = {}) {
  const stableMs = opts.stableMs ?? 2500;
  const noImageGraceMs = opts.noImageGraceMs ?? 6000;
  const promptGraceMs = opts.promptGraceMs ?? 15000;
  const a = analyzeSnapshot(snap, ctx);
  let w = { ...watch };
  if (a.blocker) return { result: { status: 'blocked', code: a.blocker.code, message: a.blocker.message }, watch: w };
  if (a.offline) return { result: { status: 'error', code: 'NETWORK', message: 'Браузер сообщает об отсутствии сети.' }, watch: w };
  if (!a.userTurn) {
    w.missingSince ??= nowMs;
    if (nowMs - w.missingSince >= promptGraceMs) return { result: { status: 'blocked', code: 'SENT_NOT_VISIBLE', message: 'Отправленный промпт не найден в беседе.' }, watch: w };
    return { result: { status: 'pending', sig: 'no-user-turn', phase: 'locating' }, watch: w };
  }
  w.missingSince = null;
  if (a.policy && !a.generating) return { result: { status: 'error', code: 'CONTENT_POLICY', message: a.policy }, watch: w };
  if (a.genError && !a.generating) return { result: { status: 'error', code: 'GENERATION_ERROR', message: a.genError }, watch: w };
  if (a.sig !== w.sig) w = { ...w, sig: a.sig, since: nowMs };
  const stable = nowMs - (w.since ?? nowMs) >= stableMs;
  if (!a.generating && a.loadingImages === 0 && a.newImages.length > 0) {
    if (stable) return { result: { status: 'done', images: a.newImages, sig: a.sig }, watch: w };
  } else if (!a.generating && a.loadingImages === 0 && a.smallImages.length > 0 && a.newImages.length === 0) {
    if (stable) return { result: { status: 'error', code: 'PREVIEW_ONLY', message: `Найдено только превью ${a.smallImages[0].w}×${a.smallImages[0].h}.` }, watch: w };
  }
  const textOnly = !a.generating && a.loadingImages === 0 && a.newImages.length === 0 && a.smallImages.length === 0 && a.assistantText.trim().length > 0;
  if (textOnly) {
    w.textOnlySince ??= nowMs;
    if (nowMs - w.textOnlySince >= noImageGraceMs) return { result: { status: 'error', code: 'NO_IMAGE', message: 'ChatGPT ответил текстом без изображения.' }, watch: w };
  } else {
    w.textOnlySince = null;
  }
  return { result: { status: 'pending', sig: a.sig, phase: a.generating ? 'generating' : 'idle' }, watch: w };
}
