// Сборка текста, отправляемого в ChatGPT, и ключ для поиска уже отправленного промпта.

export const normText = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

const NEGATIVE_MARK = /\b(avoid|do not include|negative prompt)\b/i;

/** Префикс/суффикс из настроек + (при необходимости) отрицательные ограничения, если их нет в тексте профиля. */
export function composePrompt(job, settings = {}) {
  let body = String(job.prompt ?? '').trim();
  if (job.negative && !NEGATIVE_MARK.test(body)) body += `\n\nAvoid: ${job.negative}.`;
  return `${settings.promptPrefix ?? ''}${body}${settings.promptSuffix ?? ''}`;
}

/** Нормализованные первые 60 символов: по ним ищется отправленное сообщение (восстановление без дубликатов). */
export function promptKey(text) {
  return normText(text).slice(0, 60);
}
