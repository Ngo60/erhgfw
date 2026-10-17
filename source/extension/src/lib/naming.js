// Безопасные детерминированные имена папок и файлов (Windows/macOS/Linux).

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/** Один сегмент пути: только [A-Za-z0-9._-], без точек/дефисов по краям, без зарезервированных имён Windows. */
export function safeSegment(value, fallback = 'item') {
  let s = String(value ?? '')
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 64);
  if (!s) s = fallback;
  if (RESERVED.test(s)) s = `_${s}`;
  return s;
}

/** Относительная папка внутри «Загрузок»: без абсолютных путей, «..» и диска; максимум 4 уровня. */
export function sanitizeRoot(value, fallback = 'ChatGPT-Images') {
  const parts = String(value ?? '')
    .replace(/\\/g, '/')
    .split('/')
    .map((p) => p.trim())
    .filter((p) => p && p !== '.' && p !== '..')
    .map((p) => safeSegment(p, ''))
    .filter(Boolean)
    .slice(0, 4);
  return parts.length ? parts.join('/') : fallback;
}

export const pad = (n, width = 3) => String(Math.max(0, Math.trunc(n))).padStart(width, '0');

export function batchFolderName(dateStr, counter, kind = 'batch') {
  return `${kind === 'test' ? 'Test' : 'Batch'}_${dateStr}_${pad(counter, 3)}`;
}

export function characterFolderName(index) {
  return `Character_${pad(index, 3)}`;
}

export const EXT_BY_FORMAT = Object.freeze({ png: 'png', jpeg: 'jpg', webp: 'webp', gif: 'gif' });

/** 001.png; дополнительные изображения одного задания: 001_2.png, 001_3.png. */
export function imageFileName(index, format, variant = 1) {
  const ext = EXT_BY_FORMAT[format];
  if (!ext) throw new Error(`Неизвестный формат: ${format}`);
  return `${pad(index, 3)}${variant > 1 ? `_${variant}` : ''}.${ext}`;
}

export function imagePath({ root, batchFolder, characterIndex, frameIndex, format, variant = 1 }) {
  return [sanitizeRoot(root), batchFolder, characterFolderName(characterIndex), imageFileName(frameIndex, format, variant)].join('/');
}

export function characterMetaPath(root, batchFolder, characterIndex, name) {
  return [sanitizeRoot(root), batchFolder, characterFolderName(characterIndex), name].join('/');
}

export function batchMetaPath(root, batchFolder, name) {
  return [sanitizeRoot(root), batchFolder, name].join('/');
}

/** YYYY-MM-DD по локальному времени. */
export function localDateStamp(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1, 2)}-${pad(d.getDate(), 2)}`;
}
