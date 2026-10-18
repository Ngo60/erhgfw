(() => {
  // source/extension/src/lib/chatgpt-selectors.js
  var SELECTOR_PROFILE = "chatgpt-2026-10b";
  var SELECTORS = Object.freeze({
    composer: ["#prompt-textarea", 'div.ProseMirror[contenteditable="true"]', 'div[contenteditable="true"][data-virtualkeyboard="true"]', 'textarea[name="prompt-textarea"]', 'form [contenteditable="true"][role="textbox"]'],
    send: ['button[data-testid="send-button"]', 'button[aria-label="Send prompt"]', 'button[aria-label="Send message"]', 'button[aria-label^="Отправить"]'],
    stop: ['button[data-testid="stop-button"]', 'button[aria-label="Stop streaming"]', 'button[aria-label^="Stop"]', 'button[aria-label^="Остановить"]'],
    turn: ['section[data-testid^="conversation-turn-"]', 'article[data-testid^="conversation-turn-"]', '[data-testid^="conversation-turn-"]', "article[data-turn]", "[data-turn-id]"],
    roleBlock: ["[data-message-author-role]", "[data-message-id]"],
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
  var squash = (s) => String(s ?? "").replace(/\s+/g, "");
  var KEY_SEP = "";

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
    const needles = String(key).split(KEY_SEP).map(squash).filter(Boolean);
    if (!needles.length) return null;
    const turns = snap.turns ?? [];
    for (let i = turns.length - 1; i >= 0; i--) {
      const t = turns[i];
      if (t.role !== "user") continue;
      const text = squash(t.text);
      if (needles.every((n) => text.includes(n))) return t;
    }
    return null;
  }
  var BLOCK_TEXT = {
    CAPTCHA: "Обнаружена проверка безопасности (CAPTCHA/Cloudflare).",
    AUTH_REQUIRED: "Страница ChatGPT просит войти в аккаунт.",
    RATE_LIMIT: "ChatGPT сообщил об ограничении.",
    UI_CHANGED: "Не найдено поле ввода сообщения ChatGPT."
  };
  function analyzeSnapshot(snap, ctx = {}) {
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
      if (nowMs - w.missingSince >= promptGraceMs) return { result: { status: "blocked", code: "SENT_NOT_VISIBLE", message: "Отправленный промпт не найден в беседе." }, watch: w };
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
    CS_SUBMIT: { jobId: T.id, text: { t: "str", max: 2e4 }, key: { t: "str", max: 400 }, token: { t: "str", max: 200 } },
    CS_WAIT: {
      key: { t: "str", max: 400 },
      baseline: { t: "obj", opt: true, nullable: true },
      usedKeys: { t: "arr", max: 8e3, opt: true },
      minSide: { t: "int", min: 0, max: 4096, opt: true },
      sliceMs: { t: "int", min: 500, max: 3e4, opt: true }
    },
    CS_LOCATE: { key: { t: "str", max: 400 }, minSide: { t: "int", min: 0, max: 4096, opt: true }, usedKeys: { t: "arr", max: 8e3, opt: true } },
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
  var topmost = (els) => els.filter((e) => !els.some((o) => o !== e && o.contains(e)));
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
  var MIN_FALLBACK_SIDE = 128;
  var USER_TEXT_MAX = 12e3;
  var largeImages = (root) => [...root.querySelectorAll("img")].filter((i) => !i.closest("form") && ((i.naturalWidth || 0) >= MIN_FALLBACK_SIDE || !i.complete));
  function structuralTurns(key) {
    const root = document.querySelector("main") ?? document.body;
    const needles = String(key ?? "").split(KEY_SEP).map(squash).filter(Boolean);
    if (!root || !needles.length) return [];
    const nodes = [];
    let flat = "";
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => n.parentElement && !n.parentElement.closest('form, script, style, noscript, textarea, [hidden], [contenteditable="true"]') ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT
    });
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const s = squash(n.nodeValue);
      if (!s) continue;
      nodes.push({ n, to: flat.length + s.length });
      flat += s;
    }
    const first2 = flat.lastIndexOf(needles[0]);
    if (first2 < 0) return [];
    let end = first2 + needles[0].length;
    for (const needle of needles.slice(1)) {
      const at = flat.indexOf(needle, first2);
      if (at < 0) return [];
      end = Math.max(end, at + needle.length);
    }
    const ref = nodes.find((x) => x.to >= end)?.n;
    if (!ref) return [];
    const following = (n) => n !== ref && Boolean(ref.compareDocumentPosition(n) & Node.DOCUMENT_POSITION_FOLLOWING);
    const reply = nodes.filter((x) => following(x.n)).map((x) => normText(x.n.nodeValue)).filter(Boolean).join(" ").slice(0, 1500);
    return [
      { i: 0, role: "user", text: flat.slice(first2, end), images: [] },
      { i: 1, role: "assistant", text: reply, images: largeImages(root).filter(following).map(imageInfo) }
    ];
  }
  function collectSnapshot(key = null) {
    const composer = first(SELECTORS.composer);
    const send = first(SELECTORS.send);
    const stop = first(SELECTORS.stop);
    const turnEls = topmost(all(SELECTORS.turn));
    const roleBlocks = topmost(all(SELECTORS.roleBlock));
    const base = turnEls.length ? turnEls : roleBlocks;
    let turns = base.slice(-14).map((el, k, arr) => {
      const index = base.length - arr.length + k;
      const block = el.matches("[data-message-author-role]") ? el : el.querySelector("[data-message-author-role]");
      let role = el.getAttribute("data-turn") || block?.getAttribute("data-message-author-role") || null;
      const byRole = role === "user" ? [] : all(SELECTORS.image, el);
      const imgs = (role === "user" ? [] : byRole.length ? byRole : largeImages(el)).filter((i) => !i.closest('[data-message-author-role="user"]')).map(imageInfo);
      if (!role) role = imgs.length ? "assistant" : "unknown";
      return { i: index, role, text: normText(el.textContent).slice(0, role === "user" ? USER_TEXT_MAX : 400), images: imgs };
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
      turnCount,
      structural,
      alerts: all(SELECTORS.alert).map((e) => normText(e.textContent).slice(0, 300)).filter(Boolean).slice(0, 8)
    };
  }
  var slimSnapshot = (s) => ({ ...s, turns: s.turns.map((t) => ({ ...t, text: t.text.slice(0, 200) })) });
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
      const s = collectSnapshot(key);
      return findUserTurn(s, key) ? s : null;
    }, 2e4);
    if (!after) {
      const now = collectSnapshot(key);
      const field = first(SELECTORS.composer);
      const typed = field ? normText(readComposer(field.el)).length : 0;
      if (now.hasStop || !field || typed < Math.min(10, normText(text).length / 2)) {
        const unverified = { accepted: true, unverified: true, baseline, url: location.href, userTurnIndex: null };
        submissions.set(token, unverified);
        return unverified;
      }
      throw fail("PROMPT_NOT_ACCEPTED", "Сообщение не отправилось: текст остался в поле ввода.");
    }
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
      const d = decideWait(collectSnapshot(key), ctx, watch, Date.now());
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
    const snap = collectSnapshot(key);
    const turn = findUserTurn(snap, key);
    if (!turn) return { found: false, generating: snap.hasStop, images: [], url: snap.url };
    const a = analyzeSnapshot(snap, { key, minSide: minSide ?? 0, usedKeys: usedKeys ?? [] });
    return { found: true, generating: snap.hasStop, images: a.newImages, url: snap.url, userTurnIndex: turn.i };
  }
  function clearComposer(el) {
    el.focus();
    if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value").set.call(el, "");
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return;
    }
    selectAll(el);
    document.execCommand("delete");
  }
  async function probeSend() {
    const field = first(SELECTORS.composer);
    if (!field) return { state: "unknown", note: "поле ввода не найдено" };
    if (first(SELECTORS.stop)) return { state: "unknown", note: "идёт генерация — проверка отложена" };
    if (normText(readComposer(field.el))) return { state: "unknown", note: "в поле ввода есть ваш черновик — не трогаю; очистите поле и повторите" };
    await setComposerText(field.el, ".");
    const inserted = composerMatches(field.el, ".");
    const hit = inserted ? await waitFor(() => first(SELECTORS.send), 2500) : null;
    clearComposer(field.el);
    await sleep(250);
    const restored = !normText(readComposer(field.el));
    if (!inserted) return { state: "unknown", note: "вставка текста в поле ввода не сработала — так расширение не сможет отправлять промпты", restored, insertFailed: true };
    return { state: hit ? "found" : "missing", selector: hit?.selector ?? null, restored };
  }
  var maskIds = (s) => String(s).replace(/[0-9a-f]{8,}(?:-[0-9a-f]{4,})*/gi, "…");
  function surveyPage() {
    const count = (sel) => document.querySelectorAll(sel).length;
    const ids = /* @__PURE__ */ new Map();
    document.querySelectorAll("[data-testid]").forEach((e) => {
      const v = (e.getAttribute("data-testid") ?? "").replace(/\d+/g, "N").slice(0, 40);
      ids.set(v, (ids.get(v) ?? 0) + 1);
    });
    const testids = [...ids].sort((x, y) => y[1] - x[1]).slice(0, 12).map(([k, n]) => `${k}×${n}`);
    const bigImages = [...document.images].filter((i) => i.naturalWidth >= 256 && i.naturalHeight >= 256);
    const big = bigImages.slice(0, 5).map((i) => {
      let where = "?";
      try {
        const u = new URL(i.currentSrc || i.src, location.href);
        where = `${u.hostname}${maskIds(u.pathname)}`;
      } catch {
      }
      return `${where} ${i.naturalWidth}×${i.naturalHeight}${i.closest("[data-message-author-role]") ? " (внутри блока роли)" : " (вне блока роли)"}`;
    });
    const tags = ["main", "article", "section", "form"].map((t) => `${t}×${count(t)}`).join(" ");
    const roles = ["user", "assistant"].map((r) => `${r}×${count(`[data-message-author-role="${r}"]`)}`).join(" ");
    return { tags, roles, testids, big, bigCount: bigImages.length, lang: document.documentElement.lang || "" };
  }
  var DIAG_SPEC = {
    composer: { role: "required", label: "поле ввода" },
    send: { role: "required", label: "кнопка отправки" },
    stop: { role: "info", label: "кнопка «Стоп»" },
    turn: { role: "info", label: "ходы беседы" },
    roleBlock: { role: "info", label: "блоки сообщений" },
    image: { role: "info", label: "изображения в беседе" },
    loginUi: { role: "alarm", label: "кнопки входа (их быть не должно)" },
    captchaUi: { role: "alarm", label: "проверка CAPTCHA (её быть не должно)" },
    alert: { role: "info", label: "уведомления страницы" }
  };
  function stateOf(item) {
    if (item.role === "required") return item.found ? "ok" : "bad";
    if (item.role === "alarm") return item.found ? "bad" : "ok";
    return item.found ? "ok" : "info";
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
    if (!by("send").found) {
      const probe = await probeSend();
      const send = by("send");
      send.state = probe.state === "found" ? "ok" : probe.state === "missing" ? "bad" : "unknown";
      send.found = probe.state === "found";
      if (probe.selector) {
        send.selector = probe.selector;
        send.count = 1;
      }
      if (probe.note) send.note = probe.note;
      if (probe.state === "found") notes.push("Кнопка отправки найдена после ввода символа в пустое поле (символ удалён, отправка не выполнялась).");
      if (probe.restored === false) notes.push("Внимание: не удалось очистить поле ввода после проверки — очистите его вручную.");
    }
    const titled = location.pathname.startsWith("/c/") && !/^\s*(ChatGPT)?\s*$/.test(document.title);
    if (snap.turnCount === 0 && titled) {
      for (const n of ["turn", "roleBlock"]) by(n).state = "bad";
      notes.push("Беседа открыта и имеет название, но ни одного сообщения не распознано: страница ещё грузится или изменилась разметка. Расширение попробует найти отправленное сообщение по его тексту; если не найдёт — остановит очередь, а не повторит отправку.");
    }
    if (survey.bigCount > 0 && by("image").count === 0) {
      by("image").state = "bad";
      notes.push("На странице есть крупные изображения, но селектор изображений их не находит.");
    }
    if (snap.loginUi) notes.push("Обнаружены кнопки входа: нужен вход в аккаунт.");
    if (snap.captchaUi || snap.captchaText) notes.push("Обнаружена проверка безопасности (CAPTCHA).");
    notes.push(`Структура: ${survey.tags} · роли: ${survey.roles}`);
    if (survey.testids.length) notes.push(`data-testid на странице: ${survey.testids.join(", ")}`);
    if (survey.big.length) notes.push(`Крупные изображения: ${survey.big.join("; ")}`);
    const ok = items.every((i) => i.state !== "bad") && by("send").state === "ok" && by("composer").state === "ok";
    return { ok, items, notes };
  }
  function cancel() {
    const stop = first(SELECTORS.stop);
    if (stop && !isDisabled(stop.el)) stop.el.click();
    return { clicked: Boolean(stop) };
  }
  var HANDLERS = {
    CS_PING: () => ({ version: VERSION, url: location.href, ready: Boolean(first(SELECTORS.composer)) || SELECTORS.loginUi.some((s) => document.querySelector(s)) || SELECTORS.captchaUi.some((s) => document.querySelector(s)) }),
    CS_SNAPSHOT: () => ({ snapshot: slimSnapshot(collectSnapshot()) }),
    CS_SUBMIT: (m) => submit(m),
    CS_WAIT: (m) => waitSlice(m),
    CS_LOCATE: (m) => locate(m),
    CS_CANCEL: () => cancel(),
    CS_DIAGNOSE: async () => ({ report: await diagnose() })
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
