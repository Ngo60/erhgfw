(() => {
  // source/extension/src/lib/chatgpt-selectors.js
  var SELECTOR_PROFILE = "chatgpt-2026-10";
  var SELECTORS = Object.freeze({
    composer: ["#prompt-textarea", 'div.ProseMirror[contenteditable="true"]', 'textarea[name="prompt-textarea"]'],
    send: ['button[data-testid="send-button"]', 'button[aria-label="Send prompt"]', 'button[aria-label="Send message"]'],
    stop: ['button[data-testid="stop-button"]', 'button[aria-label="Stop streaming"]', 'button[aria-label^="Stop"]'],
    turn: ['section[data-testid^="conversation-turn-"]', 'article[data-testid^="conversation-turn-"]'],
    roleBlock: ["[data-message-author-role]"],
    // Сгенерированное изображение лежит вне [data-message-author-role] и отдаётся с /backend-api/estuary/content.
    image: ['img[src*="/backend-api/estuary/content"]', 'img[alt^="Generated image"]', 'img[src*=".oaiusercontent.com/"]'],
    loginUi: ['[data-testid="login-button"]', '[data-testid="signup-button"]', 'a[href*="/auth/login"]'],
    captchaUi: ['iframe[src*="challenges.cloudflare.com"]', 'iframe[title*="Cloudflare"]', 'iframe[src*="recaptcha"]', 'iframe[src*="hcaptcha"]', "#challenge-stage", ".cf-turnstile"],
    alert: ['[role="alert"]', '[aria-live="assertive"]', '[data-testid*="toast"]']
  });
  var PATTERNS = Object.freeze({
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
      /слишком много запросов/i
    ],
    policy: [
      /may violate our (?:content )?polic/i,
      /can['’]?t (?:generate|create) (?:that|this|the) image/i,
      /(?:cannot|can not|unable to|not able to) (?:generate|create) (?:that|this|the) image/i,
      /content polic/i,
      /request was rejected/i,
      /не могу создать (?:это )?изображение/i,
      /нарушает (?:наши )?правила/i
    ],
    genError: [/something went wrong/i, /error generating (?:a )?response/i, /an error occurred/i, /network error/i, /произошла ошибка/i, /что-то пошло не так/i],
    captcha: [/verify you are human/i, /checking if the site connection is secure/i, /подтвердите, что вы не робот/i, /подтвердите, что вы человек/i]
  });

  // source/extension/src/lib/prompt.js
  var normText = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

  // source/extension/src/lib/chatgpt-classify.js
  function matchAny(text, list) {
    for (const re of list) {
      const m = re.exec(text);
      if (m) return m[0];
    }
    return null;
  }
  function findUserTurn(snap, key) {
    if (!key) return null;
    const turns = snap.turns ?? [];
    for (let i = turns.length - 1; i >= 0; i--) {
      const t = turns[i];
      if (t.role === "user" && normText(t.text).startsWith(key)) return t;
    }
    return null;
  }
  var BLOCK_TEXT = {
    CAPTCHA: "Обнаружена проверка безопасности (CAPTCHA/Cloudflare).",
    AUTH_REQUIRED: "Страница ChatGPT просит войти в аккаунт.",
    RATE_LIMIT: "ChatGPT сообщил об ограничении.",
    UI_CHANGED: "Не найдено поле ввода или кнопка отправки."
  };
  function analyzeSnapshot(snap, ctx = {}) {
    const out = {
      blocker: null,
      offline: snap.online === false,
      generating: Boolean(snap.hasStop),
      uiMissing: !snap.hasComposer || !snap.hasSend && !snap.hasStop,
      userTurn: null,
      newImages: [],
      smallImages: [],
      loadingImages: 0,
      policy: null,
      genError: null,
      assistantText: "",
      sig: ""
    };
    const block = (code, detail) => {
      if (!out.blocker) out.blocker = { code, message: detail ? `${BLOCK_TEXT[code]} «${String(detail).slice(0, 160)}»` : BLOCK_TEXT[code] };
    };
    if (snap.captchaUi || snap.captchaText) block("CAPTCHA");
    if (snap.loginUi || snap.authUrl) block("AUTH_REQUIRED");
    const turns = snap.turns ?? [];
    const userTurn = ctx.key ? findUserTurn(snap, ctx.key) : null;
    out.userTurn = userTurn;
    const fromIndex = userTurn ? userTurn.i + 1 : ctx.baselineTurnCount ?? Number.POSITIVE_INFINITY;
    const after = turns.filter((t) => t.i >= fromIndex && t.role !== "user");
    out.assistantText = after.map((t) => t.text).join(" ").slice(0, 600);
    const limitHit = matchAny(` ${(snap.alerts ?? []).join(" ")} ${out.assistantText}`, PATTERNS.rateLimit);
    if (limitHit) block("RATE_LIMIT", limitHit);
    const hasImages = after.some((t) => (t.images ?? []).length > 0);
    if (!hasImages) out.policy = matchAny(out.assistantText, PATTERNS.policy);
    out.genError = matchAny((snap.alerts ?? []).join(" "), PATTERNS.genError);
    const baseline = new Set(ctx.baselineKeys ?? []);
    const used = new Set(ctx.usedKeys ?? []);
    const minSide = ctx.minSide ?? 0;
    const seen = /* @__PURE__ */ new Set();
    for (const t of after) {
      for (const img of t.images ?? []) {
        if (seen.has(img.key) || baseline.has(img.key) || used.has(img.key)) continue;
        seen.add(img.key);
        if (!img.complete || !img.w || !img.h) out.loadingImages += 1;
        else if (Math.min(img.w, img.h) < minSide) out.smallImages.push(img);
        else out.newImages.push(img);
      }
    }
    out.sig = [out.generating ? "g" : "i", out.newImages.map((i) => i.key).join(","), out.loadingImages, out.smallImages.length, turns.length, out.assistantText.length].join("|");
    if (ctx.requireUi && out.uiMissing) block("UI_CHANGED");
    return out;
  }
  function decideWait(snap, ctx, watch, nowMs, opts = {}) {
    const stableMs = opts.stableMs ?? 2500;
    const noImageGraceMs = opts.noImageGraceMs ?? 6e3;
    const promptGraceMs = opts.promptGraceMs ?? 15e3;
    const a = analyzeSnapshot(snap, ctx);
    let w = { ...watch };
    if (a.blocker) return { result: { status: "blocked", code: a.blocker.code, message: a.blocker.message }, watch: w };
    if (a.offline) return { result: { status: "error", code: "NETWORK", message: "Браузер сообщает об отсутствии сети." }, watch: w };
    if (!a.userTurn) {
      w.missingSince ??= nowMs;
      if (nowMs - w.missingSince >= promptGraceMs) return { result: { status: "error", code: "PROMPT_NOT_ACCEPTED", message: "Отправленный промпт не найден в беседе." }, watch: w };
      return { result: { status: "pending", sig: "no-user-turn", phase: "locating" }, watch: w };
    }
    w.missingSince = null;
    if (a.policy && !a.generating) return { result: { status: "error", code: "CONTENT_POLICY", message: a.policy }, watch: w };
    if (a.genError && !a.generating) return { result: { status: "error", code: "GENERATION_ERROR", message: a.genError }, watch: w };
    if (a.sig !== w.sig) w = { ...w, sig: a.sig, since: nowMs };
    const stable = nowMs - (w.since ?? nowMs) >= stableMs;
    if (!a.generating && a.loadingImages === 0 && a.newImages.length > 0) {
      if (stable) return { result: { status: "done", images: a.newImages, sig: a.sig }, watch: w };
    } else if (!a.generating && a.loadingImages === 0 && a.smallImages.length > 0 && a.newImages.length === 0) {
      if (stable) return { result: { status: "error", code: "PREVIEW_ONLY", message: `Найдено только превью ${a.smallImages[0].w}×${a.smallImages[0].h}.` }, watch: w };
    }
    const textOnly = !a.generating && a.loadingImages === 0 && a.newImages.length === 0 && a.smallImages.length === 0 && a.assistantText.trim().length > 0;
    if (textOnly) {
      w.textOnlySince ??= nowMs;
      if (nowMs - w.textOnlySince >= noImageGraceMs) return { result: { status: "error", code: "NO_IMAGE", message: "ChatGPT ответил текстом без изображения." }, watch: w };
    } else {
      w.textOnlySince = null;
    }
    return { result: { status: "pending", sig: a.sig, phase: a.generating ? "generating" : "idle" }, watch: w };
  }

  // source/extension/src/lib/messages.js
  var ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
  var isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
  var T = {
    id: { t: "id" },
    idOpt: { t: "id", opt: true },
    obj: { t: "obj" },
    boolOpt: { t: "bool", opt: true }
  };
  var PANEL_TYPES = Object.freeze({
    GET_VIEW: {},
    SITE_STATUS: {},
    SITE_LIST_PRESETS: {},
    SITE_CREATE_BATCH: { params: T.obj, test: T.boolOpt },
    IMPORT_BATCH: { text: { t: "str", max: 15 * 1024 * 1024 }, fileName: { t: "str", max: 200 }, test: T.boolOpt },
    START: { batch_id: T.id, confirm: { t: "obj", opt: true } },
    PAUSE: {},
    RESUME: {},
    STOP: {},
    EMERGENCY_STOP: {},
    RETRY_FAILED: { batch_id: T.id },
    SELECT_BATCH: { batch_id: T.id },
    DELETE_BATCH: { batch_id: T.id },
    UPDATE_SETTINGS: { patch: T.obj },
    DIAGNOSE_CHATGPT: {},
    OPEN_CHATGPT: {},
    OPEN_SITE: {},
    SHOW_FILE: { image_job_id: T.id },
    GET_EVENTS: { batch_id: T.id, limit: { t: "int", min: 1, max: 500, opt: true } },
    EXPORT_LOG: { batch_id: T.id, format: { t: "enum", values: ["json", "csv"] } }
  });
  var CS_TYPES = Object.freeze({
    CS_PING: {},
    CS_SNAPSHOT: {},
    CS_SUBMIT: { jobId: T.id, text: { t: "str", max: 2e4 }, key: { t: "str", max: 200 }, token: { t: "str", max: 200 } },
    CS_WAIT: {
      key: { t: "str", max: 200 },
      baseline: { t: "obj", opt: true, nullable: true },
      usedKeys: { t: "arr", max: 8e3, opt: true },
      minSide: { t: "int", min: 0, max: 4096, opt: true },
      sliceMs: { t: "int", min: 500, max: 3e4, opt: true }
    },
    CS_LOCATE: { key: { t: "str", max: 200 }, minSide: { t: "int", min: 0, max: 4096, opt: true }, usedKeys: { t: "arr", max: 8e3, opt: true } },
    CS_CANCEL: {},
    CS_DIAGNOSE: {}
  });
  var SITE_CALL_TYPES = Object.freeze(["hello", "list-presets", "create-batch", "cancel"]);
  function check(spec, value) {
    if (value === void 0) return spec.opt === true;
    if (value === null) return spec.nullable === true;
    switch (spec.t) {
      case "id":
        return typeof value === "string" && ID_RE.test(value);
      case "str":
        return typeof value === "string" && value.length <= (spec.max ?? 1e3);
      case "bool":
        return typeof value === "boolean";
      case "int":
        return Number.isInteger(value) && value >= (spec.min ?? -Infinity) && value <= (spec.max ?? Infinity);
      case "enum":
        return spec.values.includes(value);
      case "obj":
        return isObj(value);
      case "arr":
        return Array.isArray(value) && value.length <= (spec.max ?? 1e3) && value.every((x) => typeof x === "string" && x.length <= 300);
      default:
        return false;
    }
  }
  function validateMessage(msg, table) {
    if (!isObj(msg) || msg.rps !== 1 || typeof msg.type !== "string" || !Object.hasOwn(table, msg.type)) return { ok: false, error: { code: "BAD_MESSAGE", message: "Неизвестное или некорректное сообщение." } };
    const spec = table[msg.type];
    for (const [field, s] of Object.entries(spec)) if (!check(s, msg[field])) return { ok: false, error: { code: "BAD_MESSAGE", message: `Некорректное поле «${field}» в сообщении ${msg.type}.` } };
    return { ok: true, type: msg.type };
  }
  var validateCsMessage = (msg) => validateMessage(msg, CS_TYPES);

  // source/extension/src/content/chatgpt.js
  var VERSION = 1;
  var sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  var fail = (code, message) => Object.assign(new Error(message), { code });
  function first(list, root = document) {
    for (const selector of list) {
      const el = root.querySelector(selector);
      if (el) return { el, selector };
    }
    return null;
  }
  function all(list, root = document) {
    const out = /* @__PURE__ */ new Set();
    for (const selector of list) root.querySelectorAll(selector).forEach((e) => out.add(e));
    return [...out].sort((a, b) => a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);
  }
  async function waitFor(fn, timeoutMs, stepMs = 100) {
    const end = Date.now() + timeoutMs;
    for (; ; ) {
      const v = fn();
      if (v) return v;
      if (Date.now() >= end) return null;
      await sleep(stepMs);
    }
  }
  var isDisabled = (el) => el.disabled === true || el.getAttribute("aria-disabled") === "true";
  var readComposer = (el) => typeof el.value === "string" ? el.value : el.innerText ?? el.textContent ?? "";
  function imageKey(src) {
    try {
      const u = new URL(src, location.href);
      if (u.pathname.includes("/backend-api/estuary/content")) return `estuary:${u.searchParams.get("id") ?? u.pathname}`;
      return `u:${u.origin}${u.pathname}`;
    } catch {
      return `raw:${String(src).slice(0, 120)}`;
    }
  }
  function imageInfo(img) {
    const src = img.currentSrc || img.src || "";
    return { key: imageKey(src), src, alt: (img.alt || "").slice(0, 100), w: img.naturalWidth || 0, h: img.naturalHeight || 0, complete: Boolean(img.complete) && img.naturalWidth > 0 };
  }
  function collectSnapshot() {
    const composer = first(SELECTORS.composer);
    const send = first(SELECTORS.send);
    const stop = first(SELECTORS.stop);
    const turnEls = all(SELECTORS.turn);
    const roleBlocks = all(SELECTORS.roleBlock);
    const base = turnEls.length ? turnEls : roleBlocks;
    const turns = base.slice(-14).map((el, k, arr) => {
      const index = base.length - arr.length + k;
      const block = el.matches("[data-message-author-role]") ? el : el.querySelector("[data-message-author-role]");
      let role = el.getAttribute("data-turn") || block?.getAttribute("data-message-author-role") || null;
      const imgs = role === "user" ? [] : all(SELECTORS.image, el).filter((i) => !i.closest('[data-message-author-role="user"]')).map(imageInfo);
      if (!role) role = imgs.length ? "assistant" : "unknown";
      return { i: index, role, text: normText(el.textContent).slice(0, 400), images: imgs };
    });
    const bodyText = !composer && document.body ? normText(document.body.innerText).slice(0, 2e3) : "";
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
      alerts: all(SELECTORS.alert).map((e) => normText(e.textContent).slice(0, 300)).filter(Boolean).slice(0, 8)
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
    return a === b || Math.abs(a.length - b.length) <= Math.max(10, b.length * 0.02) && a.slice(0, 120) === b.slice(0, 120);
  }
  async function setComposerText(el, text) {
    el.focus();
    if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value").set.call(el, text);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return;
    }
    selectAll(el);
    const dt = new DataTransfer();
    dt.setData("text/plain", text);
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    await sleep(150);
    if (composerMatches(el, text)) return;
    selectAll(el);
    document.execCommand("delete");
    document.execCommand("insertText", false, text);
    await sleep(150);
  }
  var submissions = /* @__PURE__ */ new Map();
  async function submit({ text, key, token }) {
    if (submissions.has(token)) return submissions.get(token);
    const snap = collectSnapshot();
    const a = analyzeSnapshot(snap, { requireUi: true });
    if (a.blocker) throw fail(a.blocker.code, a.blocker.message);
    if (snap.hasStop) throw fail("PAGE_BUSY", "В ChatGPT уже идёт генерация.");
    const composer = first(SELECTORS.composer);
    const baseline = { turnCount: snap.turnCount, imageKeys: snap.turns.flatMap((t) => t.images.map((i) => i.key)) };
    await setComposerText(composer.el, text);
    if (!await waitFor(() => composerMatches(composer.el, text), 3e3)) throw fail("PROMPT_NOT_ACCEPTED", "Не удалось вставить текст в поле ввода.");
    const button = await waitFor(() => {
      const b = first(SELECTORS.send);
      return b && !isDisabled(b.el) ? b.el : null;
    }, 8e3);
    if (!button) throw fail("UI_CHANGED", "Кнопка отправки недоступна после вставки текста.");
    button.click();
    const after = await waitFor(() => {
      const s = collectSnapshot();
      return findUserTurn(s, key) ? s : null;
    }, 2e4);
    if (!after) throw fail("PROMPT_NOT_ACCEPTED", "Отправленное сообщение не появилось в беседе.");
    const result = { accepted: true, baseline, url: location.href, userTurnIndex: findUserTurn(after, key).i };
    submissions.set(token, result);
    return result;
  }
  var watches = /* @__PURE__ */ new Map();
  async function waitSlice({ key, baseline, usedKeys, minSide, sliceMs }) {
    const ctx = { key, baselineKeys: baseline?.imageKeys ?? [], baselineTurnCount: baseline?.turnCount, usedKeys: usedKeys ?? [], minSide: minSide ?? 0 };
    const end = Date.now() + (sliceMs ?? 2e4);
    let watch = watches.get(key) ?? {};
    for (; ; ) {
      const d = decideWait(collectSnapshot(), ctx, watch, Date.now());
      watch = d.watch;
      if (d.result.status !== "pending") {
        watches.delete(key);
        return d.result;
      }
      if (Date.now() >= end) {
        watches.set(key, watch);
        return d.result;
      }
      await sleep(1e3);
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
    const groups = ["composer", "send", "stop", "turn", "roleBlock", "image", "loginUi", "captchaUi", "alert"];
    const items = groups.map((name) => {
      const hit = first(SELECTORS[name]);
      return { name, found: Boolean(hit), selector: hit?.selector ?? null, count: all(SELECTORS[name]).length };
    });
    const snap = collectSnapshot();
    const notes = [`Профиль селекторов: ${SELECTOR_PROFILE}`, `URL: ${location.origin}${location.pathname}`, `Ходов в беседе: ${snap.turnCount}`];
    const need = ["composer", "send"];
    const ok = need.every((n) => items.find((i) => i.name === n)?.found) && !snap.loginUi && !snap.captchaUi;
    if (snap.loginUi) notes.push("Обнаружены кнопки входа: нужен вход в аккаунт.");
    if (snap.captchaUi || snap.captchaText) notes.push("Обнаружена проверка безопасности (CAPTCHA).");
    if (!items.find((i) => i.name === "send")?.found && items.find((i) => i.name === "composer")?.found) notes.push("Кнопка отправки видна только при непустом поле ввода — это нормально для пустой беседы.");
    return { ok, items, notes };
  }
  function cancel() {
    const stop = first(SELECTORS.stop);
    if (stop && !isDisabled(stop.el)) stop.el.click();
    return { clicked: Boolean(stop) };
  }
  var HANDLERS = {
    CS_PING: () => ({ version: VERSION, url: location.href, ready: Boolean(first(SELECTORS.composer)) || SELECTORS.loginUi.some((s) => document.querySelector(s)) || SELECTORS.captchaUi.some((s) => document.querySelector(s)) }),
    CS_SNAPSHOT: () => ({ snapshot: collectSnapshot() }),
    CS_SUBMIT: (m) => submit(m),
    CS_WAIT: (m) => waitSlice(m),
    CS_LOCATE: (m) => locate(m),
    CS_CANCEL: () => cancel(),
    CS_DIAGNOSE: () => ({ report: diagnose() })
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
      Promise.resolve().then(() => HANDLERS[msg.type](msg)).then((data) => sendResponse({ ok: true, ...data })).catch((e) => sendResponse({ ok: false, error: { code: typeof e?.code === "string" ? e.code : "INTERNAL", message: String(e?.message ?? e).slice(0, 300) } }));
      return true;
    });
  }
})();
