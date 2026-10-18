// Профиль селекторов и текстовых признаков интерфейса ChatGPT. Это ДАННЫЕ: при изменении разметки правится только этот файл.
// Источники: наблюдаемая разметка chatgpt.com (data-testid/aria-label), публичные описания DOM; проверяется диагностикой
// «Проверить интерфейс ChatGPT» и тестами на макете. Соответствие реальному интерфейсу нужно подтверждать вручную.

export const SELECTOR_PROFILE = 'chatgpt-2026-10b';

export const SELECTORS = Object.freeze({
  composer: ['#prompt-textarea', 'div.ProseMirror[contenteditable="true"]', 'div[contenteditable="true"][data-virtualkeyboard="true"]', 'textarea[name="prompt-textarea"]', 'form [contenteditable="true"][role="textbox"]'],
  send: ['button[data-testid="send-button"]', 'button[aria-label="Send prompt"]', 'button[aria-label="Send message"]', 'button[aria-label^="Отправить"]'],
  stop: ['button[data-testid="stop-button"]', 'button[aria-label="Stop streaming"]', 'button[aria-label^="Stop"]', 'button[aria-label^="Остановить"]'],
  turn: ['section[data-testid^="conversation-turn-"]', 'article[data-testid^="conversation-turn-"]', '[data-testid^="conversation-turn-"]'],
  roleBlock: ['[data-message-author-role]'],
  // Сгенерированное изображение лежит вне [data-message-author-role] и отдаётся с /backend-api/estuary/content.
  image: ['img[src*="/backend-api/estuary/content"]', 'img[alt^="Generated image"]', 'img[src*=".oaiusercontent.com/"]'],
  loginUi: ['[data-testid="login-button"]', '[data-testid="signup-button"]', 'a[href*="/auth/login"]'],
  captchaUi: ['iframe[src*="challenges.cloudflare.com"]', 'iframe[title*="Cloudflare"]', 'iframe[src*="recaptcha"]', 'iframe[src*="hcaptcha"]', '#challenge-stage', '.cf-turnstile'],
  alert: ['[role="alert"]', '[aria-live="assertive"]', '[data-testid*="toast"]'],
});

export const PATTERNS = Object.freeze({
  rateLimit: [
    /you['’]ve (?:hit|reached) (?:the |your )?(?:current |free plan )?(?:usage cap|limit)/i,
    /usage cap/i,
    /limit for image/i,
    /image (?:generation|creation)s? limit/i,
    /can create more images when the limit resets/i,
    /wait for your limit to reset/i,
    /rate limit/i,
    /too many requests/i,
    /достигли (?:текущего )?лимита/i,
    /превышен лимит/i,
    /слишком много запросов/i,
  ],
  policy: [
    /may violate our (?:content )?polic/i,
    /can['’]?t (?:generate|create) (?:that|this|the) image/i,
    /(?:cannot|can not|unable to|not able to) (?:generate|create) (?:that|this|the) image/i,
    /content polic/i,
    /request was rejected/i,
    /не могу создать (?:это )?изображение/i,
    /нарушает (?:наши )?правила/i,
  ],
  genError: [/something went wrong/i, /error generating (?:a )?response/i, /an error occurred/i, /network error/i, /произошла ошибка/i, /что-то пошло не так/i],
  captcha: [/verify you are human/i, /checking if the site connection is secure/i, /подтвердите, что вы не робот/i, /подтвердите, что вы человек/i],
});
