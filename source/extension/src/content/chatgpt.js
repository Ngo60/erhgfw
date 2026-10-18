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
  if (!after) throw fail('PROMPT_NOT_ACCEPTED', 'Отправленное сообщение не появилось в беседе.');
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

function diagnose() {
  const groups = ['composer', 'send', 'stop', 'turn', 'roleBlock', 'image', 'loginUi', 'captchaUi', 'alert'];
  const items = groups.map((name) => {
    const hit = first(SELECTORS[name]);
    return { name, found: Boolean(hit), selector: hit?.selector ?? null, count: all(SELECTORS[name]).length };
  });
  const snap = collectSnapshot();
  const notes = [`Профиль селекторов: ${SELECTOR_PROFILE}`, `URL: ${location.origin}${location.pathname}`, `Ходов в беседе: ${snap.turnCount}`];
  const need = ['composer', 'send'];
  const ok = need.every((n) => items.find((i) => i.name === n)?.found) && !snap.loginUi && !snap.captchaUi;
  if (snap.loginUi) notes.push('Обнаружены кнопки входа: нужен вход в аккаунт.');
  if (snap.captchaUi || snap.captchaText) notes.push('Обнаружена проверка безопасности (CAPTCHA).');
  if (!items.find((i) => i.name === 'send')?.found && items.find((i) => i.name === 'composer')?.found) notes.push('Кнопка отправки видна только при непустом поле ввода — это нормально для пустой беседы.');
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
  CS_DIAGNOSE: () => diagnose(),
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
