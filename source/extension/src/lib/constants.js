// Общие константы: контракт rps-batch/1, состояния автомата, коды ошибок и настройки по умолчанию.

export const SCHEMA_BATCH = 'rps-batch/1';
export const BRIDGE = Object.freeze({ version: 1, channelExt: 'rps-extension', channelSite: 'rps-site' });

export const RUNNER_STATE = Object.freeze({
  IDLE: 'idle',
  PREPARING: 'preparing',
  SUBMITTING: 'submitting',
  WAITING: 'waiting',
  DOWNLOADING: 'downloading',
  VERIFYING: 'verifying',
  COMPLETED: 'completed',
  RETRYABLE_ERROR: 'retryable_error',
  PAUSED: 'paused',
  BLOCKED: 'blocked',
  FAILED: 'failed',
});

export const JOB_STATUS = Object.freeze({
  PENDING: 'pending',
  PREPARING: 'preparing',
  SUBMITTING: 'submitting',
  WAITING: 'waiting',
  DOWNLOADING: 'downloading',
  VERIFYING: 'verifying',
  COMPLETED: 'completed',
  RETRYABLE_ERROR: 'retryable_error',
  FAILED: 'failed',
});

/** Состояния, в которых очередь «работает» (браузер перезапущен → пауза, SW выгружен → продолжение). */
export const ACTIVE_STATES = new Set(['preparing', 'submitting', 'waiting', 'downloading', 'verifying', 'completed', 'retryable_error', 'failed']);
export const IN_FLIGHT = new Set(['preparing', 'submitting', 'waiting', 'downloading', 'verifying']);

export const LIMITS = Object.freeze({
  maxBatchJobs: 1500,
  maxCharacters: 200,
  maxJobsPerCharacter: 200,
  promptMin: 20,
  promptMax: 8000,
  maxImportBytes: 15 * 1024 * 1024,
  maxImageBytes: 50 * 1024 * 1024,
});

/** kind: blocking — остановка и уведомление; retry — повтор с расходом попыток; network; permanent — задание failed. */
export const ERR = Object.freeze({
  CAPTCHA: { kind: 'blocking', ru: 'ChatGPT показал проверку безопасности (CAPTCHA). Пройдите её вручную во вкладке ChatGPT и нажмите «Продолжить». Расширение её не обходит.' },
  AUTH_REQUIRED: { kind: 'blocking', ru: 'Нужен вход в ChatGPT. Войдите в аккаунт во вкладке ChatGPT и нажмите «Продолжить».' },
  RATE_LIMIT: { kind: 'blocking', ru: 'ChatGPT сообщил об ограничении (лимит генерации). Очередь остановлена: подождите сброса лимита и нажмите «Продолжить». Лимиты не обходятся.' },
  UI_CHANGED: { kind: 'blocking', ru: 'Интерфейс ChatGPT не распознан (изменилась разметка?). Нажмите «Проверить интерфейс ChatGPT» и обновите профиль селекторов.' },
  TAB_NOT_FOUND: { kind: 'blocking', ru: 'Не найдена вкладка ChatGPT. Откройте https://chatgpt.com/ в этом окне Chrome и нажмите «Продолжить».' },
  TAB_CLOSED: { kind: 'blocking', ru: 'Вкладка ChatGPT закрыта. Откройте ChatGPT и нажмите «Продолжить» — расширение найдёт уже отправленный промпт и не создаст дубликат.' },
  PAGE_BUSY: { kind: 'blocking', ru: 'В ChatGPT уже идёт генерация, не запущенная расширением. Дождитесь окончания и нажмите «Продолжить».' },
  OFFLINE: { kind: 'blocking', ru: 'Нет сети дольше допустимого времени ожидания. Проверьте подключение и нажмите «Продолжить».' },
  NETWORK: { kind: 'network', ru: 'Потеряна сеть или ChatGPT недоступен. Ожидание восстановления соединения.' },
  GENERATION_ERROR: { kind: 'retry', ru: 'ChatGPT сообщил об ошибке генерации.' },
  STALLED: { kind: 'retry', ru: 'Генерация зависла: нет изменений в интерфейсе слишком долго.' },
  TIMEOUT: { kind: 'retry', ru: 'Превышено время ожидания изображения.' },
  NO_IMAGE: { kind: 'retry', ru: 'ChatGPT ответил без изображения.' },
  PROMPT_NOT_ACCEPTED: { kind: 'retry', ru: 'ChatGPT не принял промпт (не удалось отправить сообщение).' },
  FETCH_FAILED: { kind: 'retry', ru: 'Не удалось получить исходный файл изображения.' },
  DOWNLOAD_FAILED: { kind: 'retry', ru: 'Chrome не смог сохранить файл.' },
  SIZE_MISMATCH: { kind: 'retry', ru: 'Размер сохранённого файла не совпал с проверенным.' },
  PREVIEW_ONLY: { kind: 'retry', ru: 'Найдено только превью (изображение меньше допустимого минимума).' },
  DUPLICATE_IMAGE: { kind: 'retry', ru: 'Получено изображение, которое уже сохранено для другого задания.' },
  SENT_NOT_VISIBLE: { kind: 'blocking', ru: 'Промпт отправлен (или мог быть отправлен), но расширение не видит его в беседе — вероятно, изменилась разметка ChatGPT или беседа была переключена. Повторно отправлять его автоматически нельзя. Проверьте беседу вручную: если изображение уже создано, сохраните его. «Проверить интерфейс ChatGPT» покажет, что именно не распознано.' },
  SENT_NOT_VISIBLE: { kind: 'blocking', ru: 'Промпт отправлен (или мог быть отправлен), но расширение не видит его в беседе — вероятно, изменилась разметка ChatGPT или беседа была переключена. Повторно отправлять его автоматически нельзя. Проверьте беседу вручную: если изображение уже создано, сохраните его. «Проверить интерфейс ChatGPT» покажет, что именно не распознано.' },
  CONTENT_POLICY: { kind: 'permanent', ru: 'ChatGPT отклонил запрос по правилам содержимого. Задание помечено ошибкой; правила не обходятся.' },
  MULTIPLE_IMAGES: { kind: 'permanent', ru: 'ChatGPT вернул несколько изображений вместо одного. Измените политику в настройках или выберите кадр вручную.' },
  UNSUPPORTED_IMAGE_FORMAT: { kind: 'permanent', ru: 'Формат файла не распознан как PNG/JPEG/WebP/GIF.' },
  INTEGRITY: { kind: 'permanent', ru: 'Нарушена целостность задания (промпт не соответствует персонажу).' },
  INTERNAL: { kind: 'permanent', ru: 'Внутренняя ошибка расширения.' },
});

export function errInfo(code) {
  return ERR[code] ?? ERR.INTERNAL;
}

export const DEFAULT_SETTINGS = Object.freeze({
  rootFolder: 'ChatGPT-Images',
  intervalSec: 5,
  maxAttempts: 3,
  jobTimeoutSec: 600,
  stallTimeoutSec: 240,
  networkGiveUpSec: 900,
  newChatPerCharacter: true,
  rotateChatEvery: 12,
  chatStartUrl: 'https://chatgpt.com/',
  multiImagePolicy: 'fail',
  minImageSide: 512,
  promptPrefix: 'Generate an image from the following description. Do not ask clarifying questions.\n\n',
  promptSuffix: '',
  confirmThreshold: 50,
  strongConfirmThreshold: 300,
  stopAfterPolicyRefusals: 3,
  notifications: true,
  writeMetadata: true,
});

/** Описание допустимых значений: используется для проверки и ограничения настроек. */
export const SETTINGS_SPEC = Object.freeze({
  rootFolder: { type: 'path' },
  intervalSec: { type: 'int', min: 2, max: 120 },
  maxAttempts: { type: 'int', min: 1, max: 5 },
  jobTimeoutSec: { type: 'int', min: 60, max: 1800 },
  stallTimeoutSec: { type: 'int', min: 60, max: 900 },
  networkGiveUpSec: { type: 'int', min: 60, max: 3600 },
  newChatPerCharacter: { type: 'bool' },
  rotateChatEvery: { type: 'int', min: 0, max: 100 },
  chatStartUrl: { type: 'chatUrl' },
  multiImagePolicy: { type: 'enum', values: ['fail', 'first', 'all'] },
  minImageSide: { type: 'int', min: 0, max: 4096 },
  promptPrefix: { type: 'text', max: 500 },
  promptSuffix: { type: 'text', max: 500 },
  confirmThreshold: { type: 'int', min: 1, max: 1500 },
  strongConfirmThreshold: { type: 'int', min: 1, max: 1500 },
  stopAfterPolicyRefusals: { type: 'int', min: 1, max: 10 },
  notifications: { type: 'bool' },
  writeMetadata: { type: 'bool' },
});
