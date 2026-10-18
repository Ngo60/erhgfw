// Сборка текста, отправляемого в ChatGPT, и ключ для поиска уже отправленного промпта.

export const normText = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
export const squash = (s) => String(s ?? '').replace(/\s+/g, '');
/** Разделитель фрагментов ключа: управляющий символ, которого нет ни в одном допустимом промпте. */
export const KEY_SEP = '\u001f';

const NEGATIVE_MARK = /\b(avoid|do not include|negative prompt)\b/i;

/** Префикс/суффикс из настроек + (при необходимости) отрицательные ограничения, если их нет в тексте профиля. */
export function composePrompt(job, settings = {}) {
  let body = String(job.prompt ?? '').trim();
  if (job.negative && !NEGATIVE_MARK.test(body)) body += `\n\nAvoid: ${job.negative}.`;
  return `${settings.promptPrefix ?? ''}${body}${settings.promptSuffix ?? ''}`;
}

const KEY_FRAGMENTS = 12;
const KEY_FRAGMENT_LEN = 20;

/**
 * Ключ поиска отправленного сообщения. Все промпты партии начинаются с одного и того же префикса, поэтому «первые N символов»
 * не различают задания. Короткий текст берётся целиком (без пробелов); длинный — 12 равномерно распределённых фрагментов по
 * 20 символов, от начала до конца: сообщение находится по совпадению всех фрагментов.
 */
export function promptKey(text) {
  const s = squash(text);
  if (s.length <= KEY_FRAGMENTS * KEY_FRAGMENT_LEN) return s;
  const last = s.length - KEY_FRAGMENT_LEN;
  return Array.from({ length: KEY_FRAGMENTS }, (_, k) => {
    const at = Math.floor((k * last) / (KEY_FRAGMENTS - 1));
    return s.slice(at, at + KEY_FRAGMENT_LEN);
  }).join(KEY_SEP);
}
