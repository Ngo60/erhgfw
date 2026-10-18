// Content script вкладки chatgpt.com: наблюдение за интерфейсом и ограниченные действия (вставка промпта, отправка, «Стоп»).
// Это DOM-автоматизация пользовательской вкладки, а не официальный API. Селекторы — в lib/chatgpt-selectors.js.
// Скрипт не хранит состояние очереди: он отвечает на команды service worker и ничего не делает по своей инициативе.
import { analyzeSnapshot, decideWait, findUserTurn } from '../lib/chatgpt-classify.js';
import { PATTERNS, SELECTOR_PROFILE, SELECTORS } from '../lib/chatgpt-selectors.js';
import { validateCsMessage } from '../lib/messages.js';
import { normText } from '../lib/prompt.js';

const VERSION = 1;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (code, message) => Object.assign(new Error(message), { code });

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
    return `u:${u.origin}${u.pathname}`;
  } catch {
    return `raw:${String(src).slice(0, 120)}`;
  }
}

function imageInfo(img) {
  const src = img.currentSrc || img.src || '';
  return { key: imageKey(src), src, alt: (img.alt || '').slice(0, 100), w: img.naturalWidth || 0, h: img.naturalHeight || 0, complete: Boolean(img.complete) && img.naturalWidth > 0 };
}

/** Снимок страницы: компактный JSON, который анализируется чистыми функциями (lib/chatgpt-classify.js). */
export function collectSnapshot() {
  const composer = first(SELECTORS.composer);
  const send = first(SELECTORS.send);
  const stop = first(SELECTORS.stop);
  const turnEls = all(SELECTORS.turn);
  const roleBlocks = all(SELECTORS.roleBlock);
  const base = turnEls.length ? turnEls : roleBlocks;
  const turns = base.slice(-14).map((el, k, arr) => {
    const index = base.length - arr.length + k;
    const block = el.matches('[data-message-author-role]') ? el : el.querySelector('[data-message-author-role]');
    let role = el.getAttribute('data-turn') || block?.getAttribute('data-message-author-role') || null;
    const imgs = role === 'user' ? [] : all(SELECTORS.image, el).filter((i) => !i.closest('[data-message-author-role="user"]')).map(imageInfo);
    if (!role) role = imgs.length ? 'assistant' : 'unknown';
    return { i: index, role, text: normText(el.textContent).slice(0, 400), images: imgs };
  });
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
    turnCount: base.length,
    alerts: all(SELECTORS.alert).map((e) => normText(e.textContent).slice(0, 300)).filter(Boolean).slice(0, 8),
  };
}

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
  const composer = first(SELECTORS.composer);
  const baseline = { turnCount: snap.turnCount, imageKeys: snap.turns.flatMap((t) => t.images.map((i) => i.key)) };
  await setComposerText(composer.el, text);
  if (!(await waitFor(() => composerMatches(composer.el, text), 3000))) throw fail('PROMPT_NOT_ACCEPTED', 'Не удалось вставить текст в поле ввода.');
  const button = await waitFor(() => {
    const b = first(SELECTORS.send);
    return b && !isDisabled(b.el) ? b.el : null;
  }, 8000);
  if (!button) throw fail('UI_CHANGED', 'Кнопка отправки недоступна после вставки текста.');
  button.click();
  const after = await waitFor(() => {
    const s = collectSnapshot();
    return findUserTurn(s, key) ? s : null;
  }, 20000);
  if (!after) {
    // Кнопка нажата, но ход не распознан. Очистилось поле или началась генерация — сообщение, скорее всего, ушло, и повторно его
    // отправлять нельзя (решение о блокировке принимает оркестратор). Текст остался в поле — отправка не состоялась.
    const now = collectSnapshot();
    const field = first(SELECTORS.composer);
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
    const d = decideWait(collectSnapshot(), ctx, watch, Date.now());
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
  const snap = collectSnapshot();
  const turn = findUserTurn(snap, key);
  if (!turn) return { found: false, generating: snap.hasStop, images: [], url: snap.url };
  const a = analyzeSnapshot(snap, { key, minSide: minSide ?? 0, usedKeys: usedKeys ?? [] });
  return { found: true, generating: snap.hasStop, images: a.newImages, url: snap.url, userTurnIndex: turn.i };
}

function clearComposer(el) {
  el.focus();
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set.call(el, '');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return;
  }
  selectAll(el);
  document.execCommand('delete');
}

/**
 * Кнопка отправки в ChatGPT видна только при непустом поле. Для проверки в ПУСТОЕ поле на мгновение вставляется точка
 * (отправка не выполняется) и сразу удаляется. Черновик пользователя не трогается.
 */
async function probeSend() {
  const field = first(SELECTORS.composer);
  if (!field) return { state: 'unknown', note: 'поле ввода не найдено' };
  if (first(SELECTORS.stop)) return { state: 'unknown', note: 'идёт генерация — проверка отложена' };
  if (normText(readComposer(field.el))) return { state: 'unknown', note: 'в поле ввода есть ваш черновик — не трогаю; очистите поле и повторите' };
  await setComposerText(field.el, '.');
  const inserted = composerMatches(field.el, '.');
  const hit = inserted ? await waitFor(() => first(SELECTORS.send), 2500) : null;
  clearComposer(field.el);
  await sleep(250);
  const restored = !normText(readComposer(field.el));
  if (!inserted) return { state: 'unknown', note: 'вставка текста в поле ввода не сработала — так расширение не сможет отправлять промпты', restored, insertFailed: true };
  return { state: hit ? 'found' : 'missing', selector: hit?.selector ?? null, restored };
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
  stop: { role: 'info', label: 'кнопка «Стоп» (видна только во время генерации)' },
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

async function diagnose() {
  const items = Object.entries(DIAG_SPEC).map(([name, spec]) => {
    const hit = first(SELECTORS[name]);
    const item = { name, label: spec.label, role: spec.role, found: Boolean(hit), selector: hit?.selector ?? null, count: all(SELECTORS[name]).length };
    return { ...item, state: stateOf(item) };
  });
  const by = (n) => items.find((i) => i.name === n);
  const snap = collectSnapshot();
  const survey = surveyPage();
  const notes = [`Профиль селекторов: ${SELECTOR_PROFILE}`, `Страница: ${location.origin}${maskIds(location.pathname)}`, `Ходов в беседе: ${snap.turnCount}`];
  if (survey.lang) notes.push(`Язык страницы: ${survey.lang}`);

  if (!by('send').found) {
    const probe = await probeSend();
    const send = by('send');
    send.state = probe.state === 'found' ? 'ok' : probe.state === 'missing' ? 'bad' : 'unknown';
    send.found = probe.state === 'found';
    if (probe.selector) {
      send.selector = probe.selector;
      send.count = 1;
    }
    if (probe.note) send.note = probe.note;
    if (probe.state === 'found') notes.push('Кнопка отправки найдена после ввода символа в пустое поле (символ удалён, отправка не выполнялась).');
    if (probe.restored === false) notes.push('Внимание: не удалось очистить поле ввода после проверки — очистите его вручную.');
  }

  const titled = location.pathname.startsWith('/c/') && !/^\s*(ChatGPT)?\s*$/.test(document.title);
  if (snap.turnCount === 0 && titled) {
    for (const n of ['turn', 'roleBlock']) by(n).state = 'bad';
    notes.push('Беседа открыта и имеет название, но ни одного сообщения не распознано: страница ещё грузится или изменилась разметка. В таком состоянии расширение отправку остановит, а не повторит.');
  }
  if (survey.bigCount > 0 && by('image').count === 0) {
    by('image').state = 'bad';
    notes.push('На странице есть крупные изображения, но селектор изображений их не находит.');
  }
  if (snap.loginUi) notes.push('Обнаружены кнопки входа: нужен вход в аккаунт.');
  if (snap.captchaUi || snap.captchaText) notes.push('Обнаружена проверка безопасности (CAPTCHA).');

  notes.push(`Структура: ${survey.tags} · роли: ${survey.roles}`);
  if (survey.testids.length) notes.push(`data-testid на странице: ${survey.testids.join(', ')}`);
  if (survey.big.length) notes.push(`Крупные изображения: ${survey.big.join('; ')}`);

  const ok = items.every((i) => i.state !== 'bad') && by('send').state === 'ok' && by('composer').state === 'ok';
  return { ok, items, notes };
}

function cancel() {
  const stop = first(SELECTORS.stop);
  if (stop && !isDisabled(stop.el)) stop.el.click();
  return { clicked: Boolean(stop) };
}

const HANDLERS = {
  CS_PING: () => ({ version: VERSION, url: location.href, ready: Boolean(first(SELECTORS.composer)) || SELECTORS.loginUi.some((s) => document.querySelector(s)) || SELECTORS.captchaUi.some((s) => document.querySelector(s)) }),
  CS_SNAPSHOT: () => ({ snapshot: collectSnapshot() }),
  CS_SUBMIT: (m) => submit(m),
  CS_WAIT: (m) => waitSlice(m),
  CS_LOCATE: (m) => locate(m),
  CS_CANCEL: () => cancel(),
  CS_DIAGNOSE: async () => ({ report: await diagnose() }),
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
      .catch((e) => sendResponse({ ok: false, error: { code: typeof e?.code === 'string' ? e.code : 'INTERNAL', message: String(e?.message ?? e).slice(0, 300) } }));
    return true;
  });
}
