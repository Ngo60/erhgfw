// Content script вкладки chatgpt.com: наблюдение за интерфейсом и ограниченные действия (вставка промпта, отправка, «Стоп»).
// Это DOM-автоматизация пользовательской вкладки, а не официальный API. Селекторы — в lib/chatgpt-selectors.js.
// Скрипт не хранит состояние очереди: он отвечает на команды service worker и ничего не делает по своей инициативе.
import { analyzeSnapshot, decideWait, findUserTurn } from '../lib/chatgpt-classify.js';
import { PATTERNS, SELECTOR_PROFILE, SELECTORS } from '../lib/chatgpt-selectors.js';
import { LIMITS } from '../lib/constants.js';
import { sha256Hex, sniffImage } from '../lib/image.js';
import { validateCsMessage } from '../lib/messages.js';
import { KEY_SEP, normText, squash } from '../lib/prompt.js';
import { classifyImageUrl, describeImageUrl } from '../lib/validate.js';

const VERSION = 1;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (code, message, extra) => Object.assign(new Error(message), { code }, extra);

function first(list, root = document) {
  for (const selector of list) {
    const el = root.querySelector(selector);
    if (el) return { el, selector };
  }
  return null;
}

function all(list, root = document) {
  const out = new Set();
  for (const selector of list) root.querySelectorAll(selector).forEach((e) => out.add(e));
  return [...out].sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
}

/** Без вложенных друг в друга совпадений: иначе один ход будет посчитан дважды. */
const topmost = (els) => els.filter((e) => !els.some((o) => o !== e && o.contains(e)));

/** Видимый элемент: есть в раскладке, не visibility:hidden и не внутри aria-hidden/inert (у ChatGPT бывают скрытые дубли поля ввода). */
function isVisible(el) {
  if (!el.isConnected || el.closest('[aria-hidden="true"], [inert]')) return false;
  return el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
}

/**
 * Поле ввода: среди всех совпадений всех селекторов берутся видимые; предпочтительно внутри <form>, иначе первое видимое, иначе первое.
 * @returns {{el:Element, selector:string|null, count:number, visibleCount:number, visible:boolean, inForm:boolean}|null}
 */
function pickComposer() {
  const matches = all(SELECTORS.composer);
  if (!matches.length) return null;
  const visible = matches.filter(isVisible);
  const el = visible.find((e) => e.closest('form')) ?? visible[0] ?? matches[0];
  return { el, selector: SELECTORS.composer.find((sel) => el.matches(sel)) ?? null, count: matches.length, visibleCount: visible.length, visible: visible.includes(el), inForm: Boolean(el.closest('form')) };
}

/** Кнопки отправки и «Стоп»: сначала внутри формы выбранного поля ввода, затем на всей странице (видимая важнее скрытой). */
function findNear(list, composer) {
  const form = composer?.el.closest('form');
  const inForm = form ? first(list, form) : null;
  if (inForm) return inForm;
  const found = all(list);
  const el = found.find(isVisible) ?? found[0];
  return el ? { el, selector: list.find((sel) => el.matches(sel)) ?? null } : null;
}

async function waitFor(fn, timeoutMs, stepMs = 100) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() >= end) return null;
    await sleep(stepMs);
  }
}

const isDisabled = (el) => el.disabled === true || el.getAttribute('aria-disabled') === 'true';
const readComposer = (el) => (typeof el.value === 'string' ? el.value : (el.innerText ?? el.textContent ?? ''));

function imageKey(src) {
  try {
    const u = new URL(src, location.href);
    if (u.pathname.includes('/backend-api/estuary/content')) return `estuary:${u.searchParams.get('id') ?? u.pathname}`;
    if (u.protocol === 'blob:') return `blob:${u.pathname.split('/').pop()}`;
    return `u:${u.origin}${u.pathname}`;
  } catch {
    return `raw:${String(src).slice(0, 120)}`;
  }
}

function imageInfo(img) {
  const src = img.currentSrc || img.src || '';
  return { key: imageKey(src), src, alt: (img.alt || '').slice(0, 100), w: img.naturalWidth || 0, h: img.naturalHeight || 0, complete: Boolean(img.complete) && img.naturalWidth > 0 };
}

const MIN_FALLBACK_SIDE = 128;
const USER_TEXT_MAX = 12000;

/** Крупные (или ещё грузящиеся) картинки внутри элемента — запасной путь, если селекторы изображений перестали подходить. */
const largeImages = (root) => [...root.querySelectorAll('img')].filter((i) => !i.closest('form') && ((i.naturalWidth || 0) >= MIN_FALLBACK_SIDE || !i.complete));

/**
 * Запасной разбор беседы, когда разметка ходов не распознана: сообщение пользователя ищется по тексту (фрагменты ключа),
 * всё после него считается ответом. Включается только если обычные селекторы ничего не нашли и передан ключ промпта.
 */
function structuralTurns(key) {
  const root = document.querySelector('main') ?? document.body;
  const needles = String(key ?? '').split(KEY_SEP).map(squash).filter(Boolean);
  if (!root || !needles.length) return [];
  const nodes = [];
  let flat = '';
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement && !n.parentElement.closest('form, script, style, noscript, textarea, [hidden], [contenteditable="true"]') ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
  });
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const s = squash(n.nodeValue);
    if (!s) continue;
    nodes.push({ n, to: flat.length + s.length });
    flat += s;
  }
  const first = flat.lastIndexOf(needles[0]);
  if (first < 0) return [];
  let end = first + needles[0].length;
  for (const needle of needles.slice(1)) {
    const at = flat.indexOf(needle, first);
    if (at < 0) return [];
    end = Math.max(end, at + needle.length);
  }
  // Привязка к последнему текстовому узлу сообщения (а не к «контейнеру»): всё, что идёт после него в документе, — ответ.
  const ref = nodes.find((x) => x.to >= end)?.n;
  if (!ref) return [];
  const following = (n) => n !== ref && Boolean(ref.compareDocumentPosition(n) & Node.DOCUMENT_POSITION_FOLLOWING);
  const reply = nodes.filter((x) => following(x.n)).map((x) => normText(x.n.nodeValue)).filter(Boolean).join(' ').slice(0, 1500);
  return [
    { i: 0, role: 'user', text: flat.slice(first, end), images: [] },
    { i: 1, role: 'assistant', text: reply, images: largeImages(root).filter(following).map(imageInfo) },
  ];
}

/** Снимок страницы: компактный JSON, который анализируется чистыми функциями (lib/chatgpt-classify.js). */
export function collectSnapshot(key = null) {
  const composer = pickComposer();
  const send = findNear(SELECTORS.send, composer);
  const stop = findNear(SELECTORS.stop, composer);
  const turnEls = topmost(all(SELECTORS.turn));
  const roleBlocks = topmost(all(SELECTORS.roleBlock));
  const base = turnEls.length ? turnEls : roleBlocks;
  let turns = base.slice(-14).map((el, k, arr) => {
    const index = base.length - arr.length + k;
    const block = el.matches('[data-message-author-role]') ? el : el.querySelector('[data-message-author-role]');
    let role = el.getAttribute('data-turn') || block?.getAttribute('data-message-author-role') || null;
    const byRole = role === 'user' ? [] : all(SELECTORS.image, el);
    const imgs = (role === 'user' ? [] : byRole.length ? byRole : largeImages(el)).filter((i) => !i.closest('[data-message-author-role="user"]')).map(imageInfo);
    if (!role) role = imgs.length ? 'assistant' : 'unknown';
    return { i: index, role, text: normText(el.textContent).slice(0, role === 'user' ? USER_TEXT_MAX : 400), images: imgs };
  });
  let turnCount = base.length;
  let structural = false;
  if (!base.length && key) {
    const found = structuralTurns(key);
    if (found.length) {
      turns = found;
      turnCount = found.length;
      structural = true;
    }
  }
  const bodyText = !composer && document.body ? normText(document.body.innerText).slice(0, 2000) : '';
  return {
    t: Date.now(),
    url: location.href,
    online: navigator.onLine,
    hasComposer: Boolean(composer),
    composerLen: composer ? normText(readComposer(composer.el)).length : 0,
    hasSend: Boolean(send),
    sendDisabled: send ? isDisabled(send.el) : null,
    hasStop: Boolean(stop),
    loginUi: SELECTORS.loginUi.some((s) => document.querySelector(s)),
    captchaUi: SELECTORS.captchaUi.some((s) => document.querySelector(s)),
    captchaText: PATTERNS.captcha.some((re) => re.test(bodyText)),
    authUrl: /^\/(auth|login)(\/|$)/.test(location.pathname),
    turns,
    turnCount,
    structural,
    alerts: all(SELECTORS.alert).map((e) => normText(e.textContent).slice(0, 300)).filter(Boolean).slice(0, 8),
  };
}

/** Для передачи в service worker: тексты ходов укорочены (полный текст нужен только внутри страницы для поиска ключа). */
const slimSnapshot = (s) => ({ ...s, turns: s.turns.map((t) => ({ ...t, text: t.text.slice(0, 200) })) });

function selectAll(el) {
  const sel = getSelection();
  const range = document.createRange();
  range.selectNodeContents(el);
  sel.removeAllRanges();
  sel.addRange(range);
}

function composerMatches(el, text) {
  const a = normText(readComposer(el));
  const b = normText(text);
  if (!a) return false;
  return a === b || (Math.abs(a.length - b.length) <= Math.max(10, b.length * 0.02) && a.slice(0, 120) === b.slice(0, 120));
}

async function setComposerText(el, text) {
  el.focus();
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set.call(el, text);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return;
  }
  selectAll(el);
  const dt = new DataTransfer();
  dt.setData('text/plain', text);
  el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  await sleep(150);
  if (composerMatches(el, text)) return;
  selectAll(el);
  document.execCommand('delete');
  document.execCommand('insertText', false, text);
  await sleep(150);
}

const submissions = new Map();

async function submit({ text, key, token }) {
  if (submissions.has(token)) return submissions.get(token);
  const snap = collectSnapshot();
  const a = analyzeSnapshot(snap, { requireUi: true });
  if (a.blocker) throw fail(a.blocker.code, a.blocker.message);
  if (snap.hasStop) throw fail('PAGE_BUSY', 'В ChatGPT уже идёт генерация.');
  const composer = pickComposer();
  const baseline = { turnCount: snap.turnCount, imageKeys: snap.turns.flatMap((t) => t.images.map((i) => i.key)) };
  await setComposerText(composer.el, text);
  if (!(await waitFor(() => composerMatches(composer.el, text), 3000))) throw fail('PROMPT_NOT_ACCEPTED', 'Не удалось вставить текст в поле ввода.');
  const button = await waitFor(() => {
    const b = findNear(SELECTORS.send, pickComposer() ?? composer);
    return b && !isDisabled(b.el) ? b.el : null;
  }, 8000);
  if (!button) throw fail('UI_CHANGED', 'Кнопка отправки недоступна после вставки текста.');
  button.click();
  const after = await waitFor(() => {
    const s = collectSnapshot(key);
    return findUserTurn(s, key) ? s : null;
  }, 20000);
  if (!after) {
    // Кнопка нажата, но ход не распознан. Очистилось поле или началась генерация — сообщение, скорее всего, ушло, и повторно его
    // отправлять нельзя (решение о блокировке принимает оркестратор). Текст остался в поле — отправка не состоялась.
    const now = collectSnapshot(key);
    const field = pickComposer();
    const typed = field ? normText(readComposer(field.el)).length : 0;
    if (now.hasStop || !field || typed < Math.min(10, normText(text).length / 2)) {
      const unverified = { accepted: true, unverified: true, baseline, url: location.href, userTurnIndex: null };
      submissions.set(token, unverified);
      return unverified;
    }
    throw fail('PROMPT_NOT_ACCEPTED', 'Сообщение не отправилось: текст остался в поле ввода.');
  }
  const result = { accepted: true, baseline, url: location.href, userTurnIndex: findUserTurn(after, key).i };
  submissions.set(token, result);
  return result;
}

const watches = new Map();

async function waitSlice({ key, baseline, usedKeys, minSide, sliceMs }) {
  const ctx = { key, baselineKeys: baseline?.imageKeys ?? [], baselineTurnCount: baseline?.turnCount, usedKeys: usedKeys ?? [], minSide: minSide ?? 0 };
  const end = Date.now() + (sliceMs ?? 20000);
  let watch = watches.get(key) ?? {};
  for (;;) {
    const d = decideWait(collectSnapshot(key), ctx, watch, Date.now());
    watch = d.watch;
    if (d.result.status !== 'pending') {
      watches.delete(key);
      return d.result;
    }
    if (Date.now() >= end) {
      watches.set(key, watch);
      return d.result;
    }
    await sleep(1000);
  }
}

function locate({ key, minSide, usedKeys }) {
  const snap = collectSnapshot(key);
  const turn = findUserTurn(snap, key);
  if (!turn) return { found: false, generating: snap.hasStop, images: [], url: snap.url };
  const a = analyzeSnapshot(snap, { key, minSide: minSide ?? 0, usedKeys: usedKeys ?? [] });
  return { found: true, generating: snap.hasStop, images: a.newImages, url: snap.url, userTurnIndex: turn.i };
}

const maskIds = (s) => String(s).replace(/[0-9a-f]{8,}(?:-[0-9a-f]{4,})*/gi, '…');

/** Обзор структуры страницы без текста сообщений: показывает, чем реальная разметка отличается от ожидаемой. */
function surveyPage() {
  const count = (sel) => document.querySelectorAll(sel).length;
  const ids = new Map();
  document.querySelectorAll('[data-testid]').forEach((e) => {
    const v = (e.getAttribute('data-testid') ?? '').replace(/\d+/g, 'N').slice(0, 40);
    ids.set(v, (ids.get(v) ?? 0) + 1);
  });
  const testids = [...ids].sort((x, y) => y[1] - x[1]).slice(0, 12).map(([k, n]) => `${k}×${n}`);
  const bigImages = [...document.images].filter((i) => i.naturalWidth >= 256 && i.naturalHeight >= 256);
  const big = bigImages.slice(0, 5).map((i) => {
    let where = '?';
    try {
      const u = new URL(i.currentSrc || i.src, location.href);
      where = `${u.hostname}${maskIds(u.pathname)}`;
    } catch {
      // оставляем «?»
    }
    return `${where} ${i.naturalWidth}×${i.naturalHeight}${i.closest('[data-message-author-role]') ? ' (внутри блока роли)' : ' (вне блока роли)'}`;
  });
  const tags = ['main', 'article', 'section', 'form'].map((t) => `${t}×${count(t)}`).join(' ');
  const roles = ['user', 'assistant'].map((r) => `${r}×${count(`[data-message-author-role="${r}"]`)}`).join(' ');
  return { tags, roles, testids, big, bigCount: bigImages.length, lang: document.documentElement.lang || '' };
}

const DIAG_SPEC = {
  composer: { role: 'required', label: 'поле ввода' },
  send: { role: 'required', label: 'кнопка отправки' },
  stop: { role: 'info', label: 'кнопка «Стоп»' },
  turn: { role: 'info', label: 'ходы беседы' },
  roleBlock: { role: 'info', label: 'блоки сообщений' },
  image: { role: 'info', label: 'изображения в беседе' },
  loginUi: { role: 'alarm', label: 'кнопки входа (их быть не должно)' },
  captchaUi: { role: 'alarm', label: 'проверка CAPTCHA (её быть не должно)' },
  alert: { role: 'info', label: 'уведомления страницы' },
};

function stateOf(item) {
  if (item.role === 'required') return item.found ? 'ok' : 'bad';
  if (item.role === 'alarm') return item.found ? 'bad' : 'ok';
  return item.found ? 'ok' : 'info';
}

const NOTE_SEND_UNKNOWN = 'Кнопка отправки в ChatGPT появляется только после ввода текста — она проверяется при первой отправке (кнопка «Тестовое задание» безопасна для проверки)';

/** Только чтение: диагностика ничего не вводит и не меняет в поле ввода пользователя (в том числе черновик). */
function diagnose() {
  const composer = pickComposer();
  const pick = { composer: () => composer, send: () => findNear(SELECTORS.send, composer), stop: () => findNear(SELECTORS.stop, composer) };
  const items = Object.entries(DIAG_SPEC).map(([name, spec]) => {
    const hit = pick[name] ? pick[name]() : first(SELECTORS[name]);
    const item = { name, label: spec.label, role: spec.role, found: Boolean(hit), selector: hit?.selector ?? null, count: all(SELECTORS[name]).length };
    return { ...item, state: stateOf(item) };
  });
  const by = (n) => items.find((i) => i.name === n);
  const snap = collectSnapshot();
  const survey = surveyPage();
  const notes = [`Профиль селекторов: ${SELECTOR_PROFILE}`, `Страница: ${location.origin}${maskIds(location.pathname)}`, `Ходов в беседе: ${snap.turnCount}`];
  if (survey.lang) notes.push(`Язык страницы: ${survey.lang}`);

  if (composer) {
    const chosen = `${composer.visible ? 'видимое' : 'скрытое (видимых нет)'}${composer.inForm ? ', внутри формы' : ''}`;
    by('composer').note = `выбрано ${chosen}`;
    notes.push(`Поле ввода: совпало элементов — ${composer.count}, видимых — ${composer.visibleCount}; выбрано ${chosen}.`);
  }
  const send = by('send');
  if (!send.found && composer) {
    send.state = 'unknown';
    send.note = NOTE_SEND_UNKNOWN;
  }

  const titled = location.pathname.startsWith('/c/') && !/^\s*(ChatGPT)?\s*$/.test(document.title);
  if (snap.turnCount === 0 && titled) {
    for (const n of ['turn', 'roleBlock']) by(n).state = 'bad';
    notes.push('Беседа открыта и имеет название, но ни одного сообщения не распознано: страница ещё грузится или изменилась разметка. Расширение попробует найти отправленное сообщение по его тексту; если не найдёт — остановит очередь, а не повторит отправку.');
  }
  if (survey.bigCount > 0 && by('image').count === 0) {
    if (snap.turnCount > 0) {
      by('image').state = 'bad';
      notes.push('В беседе есть крупные изображения, но селектор изображений их не находит.');
    } else {
      notes.push('Крупные изображения вне беседы (например, галерея на главной странице) — это нормально.');
    }
  }
  if (snap.loginUi) notes.push('Обнаружены кнопки входа: нужен вход в аккаунт.');
  if (snap.captchaUi || snap.captchaText) notes.push('Обнаружена проверка безопасности (CAPTCHA).');

  notes.push(`Структура: ${survey.tags} · роли: ${survey.roles}`);
  if (survey.testids.length) notes.push(`data-testid на странице: ${survey.testids.join(', ')}`);
  if (survey.big.length) notes.push(`Крупные изображения: ${survey.big.join('; ')}`);

  // Неизвестная кнопка отправки (пустое поле) — не отказ; отказ — нет поля ввода или есть тревожные признаки.
  const ok = by('composer').state === 'ok' && items.every((i) => i.state !== 'bad');
  return { ok, items, notes };
}

function cancel() {
  const stop = findNear(SELECTORS.stop, pickComposer());
  if (stop && !isDisabled(stop.el)) stop.el.click();
  return { clicked: Boolean(stop) };
}

// ───────── изображения: байты, формат, SHA-256 и своя стабильная копия для chrome.downloads ─────────

const BLOB_TTL_MS = 10 * 60_000;
const ownBlobs = new Map(); // blob:-адрес нашей копии → таймер автоотзыва

function forgetBlob(url) {
  if (!ownBlobs.has(url)) return false;
  clearTimeout(ownBlobs.get(url));
  ownBlobs.delete(url);
  URL.revokeObjectURL(url);
  return true;
}

/** Своя копия байт: ChatGPT может отозвать собственный blob: в любой момент, а Chrome читает адрес для загрузки позже. */
function ownBlobUrl(bytes, mime) {
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
  ownBlobs.set(url, setTimeout(() => forgetBlob(url), BLOB_TTL_MS));
  return url;
}

const tooBig = () => fail('FETCH_FAILED', 'Файл слишком большой.');

async function readImageBytes(src, kind) {
  let res;
  let blob;
  try {
    res = await fetch(src, kind === 'https' ? { credentials: 'include', cache: 'no-store' } : undefined);
    if (res.ok && Number(res.headers.get('content-length') ?? 0) > LIMITS.maxImageBytes) throw tooBig();
    if (res.ok) blob = await res.blob();
  } catch (e) {
    if (e?.code) throw e;
    throw fail('FETCH_FAILED', `Не удалось прочитать изображение: ${String(e?.message ?? e).slice(0, 120)}`, { unreadable: true });
  }
  if (res.status === 429) throw fail('RATE_LIMIT', 'Сервер ответил 429 (слишком много запросов).');
  if (!res.ok) throw fail('FETCH_FAILED', `HTTP ${res.status}`, { status: res.status });
  if (kind === 'https' && !(res.headers.get('content-type') ?? '').toLowerCase().startsWith('image/')) throw fail('FETCH_FAILED', 'Ожидалось изображение.', { status: res.status });
  if (blob.size > LIMITS.maxImageBytes) throw tooBig();
  return new Uint8Array(await blob.arrayBuffer());
}

/** Последний шанс, если исходный blob: уже отозван: страница ещё показывает картинку — рисуем её на canvas и кодируем в PNG. */
async function recodeShownImage(src, cause) {
  const img = [...document.images].find((i) => (i.currentSrc || i.src) === src && i.complete && i.naturalWidth > 0);
  if (!img) throw fail('FETCH_FAILED', `Исходник недоступен, изображения на странице уже нет (${cause.message})`);
  try {
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    canvas.getContext('2d').drawImage(img, 0, 0);
    const png = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!png || png.size > LIMITS.maxImageBytes) throw new Error('canvas');
    return new Uint8Array(await png.arrayBuffer());
  } catch {
    throw fail('FETCH_FAILED', `Исходник недоступен, перекодировать изображение страницы не удалось (${cause.message})`);
  }
}

async function fetchImage({ src }) {
  const { kind } = classifyImageUrl(src, location.origin);
  if (kind === 'unsupported') throw fail('IMAGE_URL_UNSUPPORTED', `Адрес изображения не поддерживается расширением: ${describeImageUrl(src)}`);
  let bytes;
  let recoded = false;
  try {
    bytes = await readImageBytes(src, kind);
  } catch (e) {
    if (kind === 'https' || !e.unreadable) throw e;
    bytes = await recodeShownImage(src, e);
    recoded = true;
  }
  const info = sniffImage(bytes);
  if (!info) return { size: bytes.length, info: null, sha256: null, downloadUrl: null, recoded };
  return { size: bytes.length, info, sha256: await sha256Hex(bytes), downloadUrl: ownBlobUrl(bytes, info.mime), recoded };
}

const releaseImage = ({ url }) => ({ released: forgetBlob(url) });

const HANDLERS = {
  CS_PING: () => ({ version: VERSION, url: location.href, ready: Boolean(pickComposer()) || SELECTORS.loginUi.some((s) => document.querySelector(s)) || SELECTORS.captchaUi.some((s) => document.querySelector(s)) }),
  CS_SNAPSHOT: () => ({ snapshot: slimSnapshot(collectSnapshot()) }),
  CS_SUBMIT: (m) => submit(m),
  CS_WAIT: (m) => waitSlice(m),
  CS_LOCATE: (m) => locate(m),
  CS_CANCEL: () => cancel(),
  CS_DIAGNOSE: () => ({ report: diagnose() }),
  CS_FETCH_IMAGE: (m) => fetchImage(m),
  CS_RELEASE_IMAGE: (m) => releaseImage(m),
};

if (!globalThis.__rpsChatGpt) {
  globalThis.__rpsChatGpt = true;
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id) return false;
    const v = validateCsMessage(msg);
    if (!v.ok) {
      sendResponse({ ok: false, error: v.error });
      return false;
    }
    Promise.resolve()
      .then(() => HANDLERS[msg.type](msg))
      .then((data) => sendResponse({ ok: true, ...data }))
      .catch((e) => sendResponse({ ok: false, error: { code: typeof e?.code === 'string' ? e.code : 'INTERNAL', message: String(e?.message ?? e).slice(0, 300), ...(Number.isInteger(e?.status) ? { status: e.status } : {}) } }));
    return true;
  });
}
