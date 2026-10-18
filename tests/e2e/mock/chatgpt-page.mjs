// HTML, CSS and client script of the mock ChatGPT page. clientMain() is serialised into the page via
// Function#toString, so it must only reference its own scope and browser globals.

const CSS = `
*{box-sizing:border-box}
html,body{margin:0;height:100%;font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#0d0d0d;background:#fff}
.app{display:flex;flex-direction:column;height:100vh}
.hdr{display:flex;align-items:center;gap:12px;height:56px;padding:0 16px;border-bottom:1px solid #eee;flex:none}
.hdr .spacer{flex:1}
.hdr .model{font-weight:600;color:#555}
.new-chat{color:inherit;text-decoration:none;padding:6px 12px;border-radius:8px;background:#f4f4f4}
.btn,.hdr button{font:inherit;cursor:pointer;padding:6px 14px;border-radius:18px;border:1px solid #d0d0d0;background:#fff;color:inherit}
.hdr .avatar{width:32px;height:32px;padding:0;border-radius:50%;background:#10a37f;color:#fff;border:0}
main{flex:1;min-height:0;display:flex;flex-direction:column}
.thread{flex:1;min-height:0;overflow-y:auto;padding:24px 0}
.thread>section{max-width:768px;margin:0 auto 24px;padding:0 16px}
[data-message-author-role=user]{display:flex;justify-content:flex-end}
.whitespace-pre-wrap{white-space:pre-wrap;background:#f4f4f4;border-radius:18px;padding:10px 16px;max-width:80%;word-break:break-word}
.markdown p{margin:0}
.agent-turn{color:#555}
.agent-turn img{display:block;max-width:min(100%,512px);height:auto;border-radius:12px;margin-bottom:8px}
.error-banner{max-width:768px;margin:0 auto 24px;padding:0 16px;display:flex;gap:12px;align-items:center}
.error-banner [role=alert]{color:#b42318}
.welcome{flex:1;display:flex;align-items:center;justify-content:center;color:#555}
.bottom{flex:none;padding:0 16px 16px}
.composer-form{max-width:768px;margin:0 auto}
.composer-surface{display:flex;align-items:flex-end;gap:8px;border:1px solid #ddd;border-radius:28px;padding:10px 12px 10px 16px;box-shadow:0 2px 8px rgba(0,0,0,.06)}
.composer-editor{flex:1;min-width:0;position:relative;padding:4px 0}
.composer-editor>*{display:block;width:100%;min-height:24px;max-height:200px;overflow-y:auto;outline:none;white-space:pre-wrap;word-break:break-word;font:inherit;border:0;resize:none;background:transparent}
.ProseMirror p{margin:0;position:relative}
.ProseMirror p.placeholder::before{content:attr(data-placeholder);position:absolute;color:#8e8ea0;pointer-events:none}
.icon-btn,.send-btn,.stop-btn,.btn.round{flex:none;width:36px;height:36px;padding:0;border-radius:50%;border:0;cursor:pointer;font:inherit;display:inline-flex;align-items:center;justify-content:center}
.icon-btn{background:#f4f4f4;color:#0d0d0d}
.send-btn,.stop-btn,.btn.round{background:#0d0d0d;color:#fff}
.send-btn:disabled,.btn.round.off{background:#d7d7d7;cursor:default}
.slot{display:inline-flex}
#challenge-stage{position:fixed;inset:0;z-index:2147483000;background:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px}
#challenge-stage iframe{width:300px;height:65px;border:1px solid #ddd}
`;

function clientMain(BOOT) {
  'use strict';
  const POLL_MS = 250;
  const BLOCK_TAGS = /^(P|DIV|LI|UL|OL|H[1-6]|BLOCKQUOTE|PRE|SECTION|ARTICLE|TABLE|TR)$/;
  const STRIPPED_WHEN_UI_CHANGED = ['id', 'data-testid', 'aria-label'];

  const S = {
    ui: BOOT.ui,
    convId: BOOT.convId,
    view: BOOT.view,
    version: BOOT.view.version,
    localView: false, // send failed: the page keeps a view the server does not know about
    pending: null, // user turn of a failed send, shown although the server never saw it
    sendPromise: null, // send in flight
  };
  let els = {};
  let slotKind = null;
  let errorEl = null;
  let observer = null;
  let polling = false;
  const turnEls = new Map();

  const emptyView = () => ({ id: null, exists: false, version: 0, running: false, error: false, turns: [] });

  function h(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    if (attrs) {
      for (const k of Object.keys(attrs)) {
        const v = attrs[k];
        if (v === false || v == null) continue;
        if (S.ui.uiChanged && STRIPPED_WHEN_UI_CHANGED.includes(k)) continue;
        if (k === 'class') e.className = v;
        else e.setAttribute(k, v === true ? '' : String(v));
      }
    }
    for (const kid of kids) if (kid != null) e.append(kid);
    return e;
  }

  const uuid = () =>
    crypto.randomUUID
      ? crypto.randomUUID()
      : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => ((Math.random() * 16) | 0).toString(16));

  const post = (url, body) =>
    fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      cache: 'no-store',
    });

  const convIdOf = (pathname) => {
    const m = /^\/c\/([^/]+)\/?$/.exec(pathname);
    return m ? decodeURIComponent(m[1]) : null;
  };

  // ---------- composer text model ----------
  // Reads the editor DOM as a list of lines. Tolerates whatever contenteditable editing leaves behind:
  // <p> per line, <br>, "\n" inside text (white-space: pre-wrap), <div> blocks, root-level text.
  function readLines(root, forCaret) {
    const lines = [];
    let cur = null;
    // A break (<br> or "\n" under white-space: pre-wrap) ends the open line, but at the end of a block it is only
    // the invisible placeholder that keeps the last line visible; it counts once more content follows.
    let br = false;
    const commitBr = () => {
      if (br) {
        lines.push(cur === null ? '' : cur);
        cur = '';
        br = false;
      }
    };
    const lineBreak = () => {
      if (br) {
        lines.push(cur === null ? '' : cur);
        cur = '';
      } else if (cur === null) {
        cur = '';
      }
      br = true;
    };
    const flush = () => {
      if (br && forCaret) {
        lines.push(cur === null ? '' : cur);
        cur = '';
      }
      if (cur !== null) lines.push(cur);
      cur = null;
      br = false;
    };
    const text = (s) => {
      const parts = s.replace(/\r\n?/g, '\n').split('\n');
      for (let i = 0; i < parts.length; i++) {
        if (i > 0) lineBreak();
        if (parts[i] !== '') {
          commitBr();
          cur = (cur === null ? '' : cur) + parts[i];
        }
      }
    };
    const walk = (node) => {
      for (const ch of node.childNodes) {
        if (ch.nodeType === 3) {
          text(ch.nodeValue);
        } else if (ch.nodeType === 1) {
          const tag = ch.tagName;
          if (tag === 'BR') {
            lineBreak();
          } else if (BLOCK_TAGS.test(tag)) {
            flush();
            if (forCaret && !ch.firstChild) lines.push('');
            else walk(ch);
            flush();
          } else {
            walk(ch);
          }
        }
      }
    };
    walk(root);
    flush();
    return lines;
  }

  function isCanonical(root, lines) {
    const kids = root.childNodes;
    if (kids.length !== lines.length) return false;
    for (let i = 0; i < kids.length; i++) {
      const p = kids[i];
      if (p.nodeType !== 1 || p.tagName !== 'P' || p.childNodes.length !== 1) return false;
      const only = p.firstChild;
      if (lines[i] === '' ? only.nodeName !== 'BR' : only.nodeType !== 3 || only.nodeValue !== lines[i]) return false;
    }
    return true;
  }

  function rebuild(root, lines) {
    root.replaceChildren(
      ...lines.map((l) => (l === '' ? h('p', null, h('br')) : h('p', null, document.createTextNode(l)))),
    );
  }

  function fixAttrs(root, lines) {
    const empty = lines.length === 1 && lines[0] === '';
    for (let i = 0; i < root.children.length; i++) {
      const p = root.children[i];
      if (empty && i === 0) {
        if (p.getAttribute('data-placeholder') !== 'Ask anything') p.setAttribute('data-placeholder', 'Ask anything');
        if (p.className !== 'placeholder') p.className = 'placeholder';
      } else {
        if (p.hasAttribute('class')) p.removeAttribute('class');
        if (p.hasAttribute('data-placeholder')) p.removeAttribute('data-placeholder');
      }
    }
  }

  function caretPos(root) {
    const sel = getSelection();
    if (!sel || sel.rangeCount === 0 || !sel.focusNode || !root.contains(sel.focusNode)) return null;
    const r = document.createRange();
    r.selectNodeContents(root);
    r.setEnd(sel.focusNode, sel.focusOffset);
    const pre = readLines(r.cloneContents(), true);
    return pre.length ? { line: pre.length - 1, col: pre[pre.length - 1].length } : { line: 0, col: 0 };
  }

  function setCaret(root, pos, lines) {
    let { line, col } = pos;
    if (line > lines.length - 1) {
      line = lines.length - 1;
      col = lines[line].length;
    }
    col = Math.min(col, lines[line].length);
    const p = root.children[line];
    const r = document.createRange();
    if (p.firstChild && p.firstChild.nodeType === 3) r.setStart(p.firstChild, col);
    else r.setStart(p, 0);
    r.collapse(true);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
  }

  // Normalises the editor into one <p> per line (the shape a ProseMirror doc renders to) and keeps the caret.
  function syncComposer() {
    const root = els.editor;
    if (!root || S.ui.uiChanged) return;
    let lines = readLines(root, false);
    if (!lines.length) lines = [''];
    if (!isCanonical(root, lines)) {
      const pos = caretPos(root);
      rebuild(root, lines);
      if (pos) setCaret(root, pos, lines);
    }
    fixAttrs(root, lines);
    if (observer) observer.takeRecords();
    updateControls();
  }

  const composerText = () => {
    if (!els.editor) return '';
    return S.ui.uiChanged ? els.editor.value : readLines(els.editor, false).join('\n');
  };

  function clearComposer() {
    if (!els.editor) return;
    if (S.ui.uiChanged) {
      els.editor.value = '';
    } else {
      rebuild(els.editor, ['']);
      fixAttrs(els.editor, ['']);
      if (observer) observer.takeRecords();
    }
  }

  function insertPlain(text) {
    const root = els.editor;
    root.focus();
    const sel = getSelection();
    if (!sel.rangeCount || !root.contains(sel.focusNode)) {
      const r = document.createRange();
      r.selectNodeContents(root);
      r.collapse(false);
      sel.removeAllRanges();
      sel.addRange(r);
    }
    text
      .replace(/\r\n?/g, '\n')
      .split('\n')
      .forEach((line, i) => {
        if (i > 0) document.execCommand('insertParagraph');
        if (line) document.execCommand('insertText', false, line);
      });
  }

  // ---------- state helpers ----------
  const isRunning = () => !!S.view.running;
  const canSend = () =>
    !!els.editor && !S.ui.loggedOut && !S.ui.captcha && !isRunning() && !S.sendPromise && composerText().trim() !== '';

  // ---------- shell ----------
  function makeSendButton() {
    const b = S.ui.uiChanged
      ? h('div', { class: 'btn round off' }, '\u2191')
      : h(
          'button',
          { type: 'button', class: 'send-btn', 'data-testid': 'send-button', 'aria-label': 'Send prompt', disabled: true },
          '\u2191',
        );
    b.addEventListener('click', () => {
      if (canSend()) doSend();
    });
    return b;
  }

  function makeStopButton() {
    const b = S.ui.uiChanged
      ? h('div', { class: 'btn round' }, '\u25a0')
      : h(
          'button',
          { type: 'button', class: 'stop-btn', 'data-testid': 'stop-button', 'aria-label': 'Stop streaming' },
          '\u25a0',
        );
    b.addEventListener('click', onStop);
    return b;
  }

  function updateControls() {
    if (!els.slot) return;
    const want = isRunning() ? 'stop' : 'send';
    if (slotKind !== want) {
      els.send = want === 'send' ? makeSendButton() : null;
      els.slot.replaceChildren(want === 'send' ? els.send : makeStopButton());
      slotKind = want;
    }
    if (want === 'send') {
      const off = !canSend();
      if (S.ui.uiChanged) els.send.className = off ? 'btn round off' : 'btn round';
      else els.send.disabled = off;
    }
  }

  function buildComposer() {
    const ui = S.ui;
    let editor;
    if (ui.uiChanged) {
      editor = h('textarea', { class: 'x1', rows: '1' });
      editor.addEventListener('input', updateControls);
      editor.addEventListener('paste', (e) => {
        const text = e.clipboardData ? e.clipboardData.getData('text/plain') : '';
        e.preventDefault();
        if (text) editor.setRangeText(text, editor.selectionStart, editor.selectionEnd, 'end');
        updateControls();
      });
    } else {
      editor = h(
        'div',
        {
          id: 'prompt-textarea',
          class: 'ProseMirror',
          contenteditable: ui.captcha ? 'false' : 'true',
          role: 'textbox',
          'aria-label': 'Chat with ChatGPT',
          'aria-disabled': ui.captcha ? 'true' : null,
          'data-virtualkeyboard': 'true',
          spellcheck: 'false',
        },
        h('p', { 'data-placeholder': 'Ask anything', class: 'placeholder' }, h('br')),
      );
      // Chrome's own editing is authoritative; the MutationObserver reshapes whatever it produced.
      editor.addEventListener('input', updateControls);
      editor.addEventListener('paste', (e) => {
        const text = e.clipboardData ? e.clipboardData.getData('text/plain') : '';
        e.preventDefault();
        if (text && !ui.captcha) insertPlain(text);
      });
      observer = new MutationObserver(syncComposer);
      observer.observe(editor, {
        childList: true,
        characterData: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class', 'data-placeholder'],
      });
    }
    editor.addEventListener('keydown', (e) => {
      const enter = e.key === 'Enter' || (!e.key && (e.keyCode === 13 || e.which === 13));
      if (!enter || e.shiftKey || e.isComposing) return;
      e.preventDefault();
      if (canSend()) doSend();
    });
    els.editor = editor;
    els.slot = h('span', { class: 'slot' });
    slotKind = null;
    const actions = ui.uiChanged
      ? []
      : [h('button', { type: 'button', class: 'icon-btn', 'data-testid': 'composer-plus-btn', 'aria-label': 'Add files and more' }, '+')];
    const form = h(
      'form',
      { class: 'composer-form', 'data-type': 'unified-composer' },
      h('div', { class: 'composer-surface' }, ...actions, h('div', { class: 'composer-editor' }, editor), els.slot),
    );
    form.addEventListener('submit', (e) => e.preventDefault());
    return h('div', { class: 'bottom' }, form);
  }

  function buildShell() {
    const ui = S.ui;
    if (observer) observer.disconnect();
    observer = null;
    els = {};
    turnEls.clear();
    errorEl = null;
    document.body.replaceChildren();

    const newChat = ui.uiChanged
      ? h('div', { class: 'btn' }, 'New chat')
      : h('a', { href: '/', 'data-testid': 'new-chat-button', class: 'new-chat' }, 'New chat');
    if (ui.uiChanged) newChat.addEventListener('click', () => navigate('/'));
    const header = h('header', { class: 'hdr' }, newChat, h('span', { class: 'model' }, 'ChatGPT'), h('span', { class: 'spacer' }));
    if (ui.loggedOut) {
      const mk = (label, testid) => (ui.uiChanged ? h('div', { class: 'btn' }, label) : h('button', { type: 'button', 'data-testid': testid }, label));
      header.append(mk('Log in', 'login-button'), mk('Sign up', 'signup-button'));
    } else if (!ui.uiChanged) {
      header.append(h('button', { type: 'button', class: 'avatar', 'data-testid': 'profile-button', 'aria-label': 'Open profile menu' }, 'M'));
    }

    els.thread = h('div', { id: 'thread', class: 'thread' });
    const main = h('main', null, els.thread);
    if (ui.loggedOut) main.append(h('div', { class: 'welcome' }, 'Log in or sign up to get smarter responses.'));
    else main.append(buildComposer());

    const app = h('div', { class: 'app' }, header, main);
    document.body.append(app);

    if (ui.captcha) {
      const overlay = h('div', null, h('iframe', { title: 'Widget containing a Cloudflare security challenge', src: 'about:blank' }), h('p', null, 'Verify you are human'));
      overlay.id = 'challenge-stage';
      document.body.append(overlay);
    }
    renderThread();
    updateControls();
  }

  // ---------- thread ----------
  // The agent-turn container survives the "Creating image" -> image transition, like a re-rendered React node.
  function agentTurn(sec) {
    let a = sec.firstElementChild;
    if (!a || !a.classList.contains('agent-turn')) {
      a = h('div', { class: 'agent-turn' });
      sec.replaceChildren(a);
    }
    return a;
  }

  function fillTurn(sec, t) {
    if (t.role === 'user') {
      sec.replaceChildren(
        h('div', { 'data-message-author-role': 'user', 'data-message-id': t.msgId }, h('div', { class: 'whitespace-pre-wrap' }, t.text)),
      );
    } else if (t.kind === 'text') {
      sec.replaceChildren(
        h('div', { 'data-message-author-role': 'assistant', 'data-message-id': t.msgId }, h('div', { class: 'markdown prose' }, h('p', null, t.text))),
      );
    } else if (t.kind === 'image') {
      agentTurn(sec).replaceChildren(
        ...t.images.map((im) =>
          h('div', { class: 'group/imagegen-image' }, h('img', { alt: im.alt, width: im.w, height: im.h, src: im.src })),
        ),
      );
    } else {
      agentTurn(sec).replaceChildren('Creating image');
    }
  }

  function renderThread() {
    const thread = els.thread;
    if (!thread) return;
    let turns = S.ui.loggedOut ? [] : S.view.turns;
    if (S.pending && !S.ui.loggedOut && !turns.some((t) => t.id === S.pending.id)) turns = [...turns, S.pending];
    const seen = new Set();
    let prev = null;
    turns.forEach((t, i) => {
      let sec = turnEls.get(t.id);
      if (!sec) {
        sec = document.createElement('section');
        sec._rev = -1;
        turnEls.set(t.id, sec);
      }
      seen.add(t.id);
      sec.setAttribute('data-turn', t.role);
      if (S.ui.uiChanged) sec.removeAttribute('data-testid');
      else sec.setAttribute('data-testid', 'conversation-turn-' + (i + 1));
      if (sec._rev !== t.rev) {
        fillTurn(sec, t);
        sec._rev = t.rev;
      }
      const want = prev ? prev.nextSibling : thread.firstChild;
      if (sec !== want) thread.insertBefore(sec, want);
      prev = sec;
    });
    for (const [id, sec] of turnEls) {
      if (!seen.has(id)) {
        sec.remove();
        turnEls.delete(id);
      }
    }
    if (S.view.error && !S.ui.loggedOut) {
      if (!errorEl) {
        const retry = S.ui.uiChanged ? h('div', { class: 'btn' }, 'Retry') : h('button', { type: 'button' }, 'Retry');
        retry.addEventListener('click', onRetry);
        errorEl = h(
          'div',
          { class: 'error-banner' },
          h('div', { role: 'alert' }, 'Something went wrong. There was an error generating a response.'),
          retry,
        );
      }
      thread.append(errorEl);
    } else if (errorEl) {
      errorEl.remove();
      errorEl = null;
    }
    thread.scrollTop = thread.scrollHeight;
  }

  // ---------- actions ----------
  // The page changes state only once the server has answered, in one synchronous step: URL, user turn,
  // placeholder and stop button appear together (a failed send falls back to a local, never-completing view).
  async function doSend() {
    const text = composerText().trim();
    if (!text) return;
    clearComposer();
    const p = (async () => {
      try {
        const r = await post('/__mock/send', { conv_id: S.convId, text });
        if (!r.ok) throw new Error('send failed: ' + r.status);
        const out = await r.json();
        if (S.convId !== out.conv_id) {
          S.convId = out.conv_id;
          history.replaceState(null, '', '/c/' + encodeURIComponent(out.conv_id));
        }
        S.localView = false;
        S.pending = null;
        S.version = null;
        applyData({ ...out.view, ui: S.ui });
      } catch (e) {
        S.localView = true;
        S.pending = { id: 'local-' + uuid(), role: 'user', text, msgId: uuid(), rev: 1 };
        S.view = { ...S.view, running: true };
        renderThread();
        updateControls();
      }
    })();
    S.sendPromise = p;
    updateControls();
    await p;
    S.sendPromise = null;
    updateControls();
  }

  async function onStop() {
    if (S.sendPromise) await S.sendPromise;
    if (S.localView) {
      S.view = { ...S.view, running: false };
      renderThread();
      updateControls();
      return;
    }
    if (!S.convId) return;
    try {
      await post('/__mock/stop', { conv_id: S.convId });
    } catch (e) {
      return;
    }
    await poll(true);
  }

  async function onRetry() {
    if (!S.convId) return;
    try {
      await post('/__mock/retry', { conv_id: S.convId });
    } catch (e) {
      return;
    }
    await poll(true);
  }

  // ---------- polling ----------
  function applyData(d) {
    if (JSON.stringify(d.ui) !== JSON.stringify(S.ui)) {
      S.ui = d.ui;
      buildShell();
    }
    if (S.localView) return;
    if ((d.id || null) !== (S.convId || null)) return;
    // Forced polls can overlap; never let an older response overwrite a newer view.
    const stale = S.version !== null && d.version < S.version && d.exists !== false;
    if (d.version === S.version || stale) return;
    S.version = d.version;
    S.view = d;
    if (S.pending && d.turns.some((t) => t.id === S.pending.id)) S.pending = null;
    renderThread();
    updateControls();
  }

  async function poll(force) {
    if (polling && !force) return;
    polling = true;
    const asked = S.convId;
    try {
      const r = await fetch('/__mock/conv/' + encodeURIComponent(asked || '_'), { cache: 'no-store' });
      if (r.ok && asked === S.convId) applyData(await r.json());
    } catch (e) {
      // network trouble: keep the stale view
    } finally {
      polling = false;
    }
  }

  // ---------- routing (client-side, like the real SPA) ----------
  function routeChanged() {
    S.convId = convIdOf(location.pathname);
    S.view = emptyView();
    S.version = null;
    S.localView = false;
    S.pending = null;
    S.sendPromise = null;
    clearComposer();
    renderThread();
    updateControls();
    if (els.editor && !S.ui.captcha) els.editor.focus();
    poll(true);
  }

  function navigate(url) {
    const u = new URL(url, location.href);
    if (u.pathname === location.pathname && u.search === location.search) return;
    history.pushState(null, '', u.pathname + u.search);
    routeChanged();
  }

  window.addEventListener('popstate', routeChanged);
  document.addEventListener('click', (e) => {
    const a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const u = new URL(a.href, location.href);
    if (u.origin !== location.origin || !(u.pathname === '/' || convIdOf(u.pathname))) return;
    e.preventDefault();
    navigate(u.pathname + u.search);
  });

  buildShell();
  if (els.editor && !S.ui.captcha) els.editor.focus();
  setInterval(poll, POLL_MS);
}

const safeJson = (v) => JSON.stringify(v).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

/** @param {{convId: string|null, view: object, ui: object}} boot */
export function renderPage(boot) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>ChatGPT</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" href="data:,">
<style>${CSS}</style>
</head>
<body>
<script>(${clientMain.toString()})(${safeJson(boot)});</script>
</body>
</html>
`;
}
