// Self-test of the mock servers, no extension involved: `node tests/e2e/mock/selftest.mjs`
// Env: CHROME_PATH (browser), SITE_DIST (built promts.vibecods.xyz dist), SELFTEST_ONLY=<regex> (subset of checks).
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { chromium } from 'playwright-core';
import { makeCerts } from './certs.mjs';
import { makePng, makeJpeg, makeWebp } from './png.mjs';
import { startMockChatGpt } from './chatgpt-server.mjs';
import { startStaticSite } from './site-server.mjs';

const SITE_DIST = process.env.SITE_DIST ?? '/tmp/site/dist';
const DELAY = 300;
const PROMPT = 'A photo of a red fox in the snow, golden hour, 35mm film';

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    '/usr/local/bin/google-chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean);
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) throw new Error('Chrome not found; set CHROME_PATH');
  return found;
}

const results = [];
// A check may rely on state built by an earlier one, so subsets should include their prerequisites.
const ONLY = process.env.SELFTEST_ONLY ? new RegExp(process.env.SELFTEST_ONLY) : null;
let cleanup = async () => {};
async function check(name, fn) {
  if (ONLY && !ONLY.test(name)) return;
  const started = Date.now();
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`PASS  ${name}  (${Date.now() - started} ms)`);
  } catch (e) {
    results.push({ name, ok: false });
    console.log(`FAIL  ${name}\n      ${String(e?.stack ?? e).split('\n').slice(0, 6).join('\n      ')}`);
  } finally {
    await cleanup();
  }
}

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sniff(buf) {
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  return null;
}

function request(base, pathAndQuery, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(base + pathAndQuery, { method, headers, rejectUnauthorized: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

const SESSION = { cookie: 'rps_session=ok' };

async function main() {
  const certs = await makeCerts();
  const chat = await startMockChatGpt({ certs, defaults: { delayMs: DELAY } });
  const slowChat = await startMockChatGpt({ certs });
  const browser = await chromium.launch({
    executablePath: findChrome(),
    args: ['--no-sandbox', '--ignore-certificate-errors', '--disable-dev-shm-usage'],
  });
  const stoppers = [() => sampleTimers.forEach(clearTimeout), () => browser.close(), () => chat.stop(), () => slowChat.stop()];

  // `slow` defaults to 8 s: start it now and sample its state on a timer while the other checks run.
  slowChat.setScript(['slow']);
  const slowStart = Date.now();
  const slowSend = await request(slowChat.url, '/__mock/send', { method: 'POST', body: { text: PROMPT } });
  const slowConvId = JSON.parse(slowSend.body.toString()).conv_id;
  const slowView = async () => JSON.parse((await request(slowChat.url, `/__mock/conv/${slowConvId}`)).body.toString());
  const slowSamples = {};
  const sampleTimers = [1, 7, 9.5].map((sec) =>
    setTimeout(async () => {
      slowSamples[sec] = await slowView().catch(() => null);
    }, sec * 1000),
  );

  const openedContexts = [];
  cleanup = () => Promise.all(openedContexts.splice(0).map((c) => c.close().catch(() => {})));
  async function open(baseUrl = chat.url, { path: p = '/', ...ctxOpts } = {}) {
    const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1100, height: 800 }, ...ctxOpts });
    openedContexts.push(context);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && errors.push(m.text()));
    await page.goto(baseUrl + p);
    return { context, page, errors };
  }

  const setPrompt = (page, text) =>
    page.evaluate((t) => {
      const el = document.querySelector('#prompt-textarea');
      el.focus();
      document.execCommand('selectAll');
      document.execCommand('insertText', false, t);
    }, text);

  async function sendPrompt(page, text = PROMPT) {
    await setPrompt(page, text);
    await page.waitForSelector('button[data-testid="send-button"]:not([disabled])', { timeout: 3000 });
    await page.click('button[data-testid="send-button"]');
  }

  const assistantTurn = (page, n = 2) => page.locator(`section[data-testid="conversation-turn-${n}"][data-turn="assistant"]`);
  // Resolves once `count` generated images are present and fully decoded.
  const waitImages = (page, count = 1, timeout = 6000) =>
    page.waitForFunction(
      (c) => {
        const imgs = [...document.querySelectorAll('img[src*="/backend-api/estuary/content"]')];
        return imgs.length >= c && imgs.every((i) => i.complete && i.naturalWidth > 0);
      },
      count,
      { timeout },
    );
  const stopButton = (page) => page.locator('button[data-testid="stop-button"]');
  const pageFetch = (page, src) =>
    page.evaluate(async (u) => {
      const r = await fetch(u);
      const buf = new Uint8Array(await r.arrayBuffer());
      return { status: r.status, type: r.headers.get('content-type'), bytes: Array.from(buf.subarray(0, 16)), length: buf.length };
    }, src);
  const imgInfo = (page, index = 0) =>
    page.evaluate((i) => {
      const img = document.querySelectorAll('img[src*="/backend-api/estuary/content"]')[i];
      return {
        src: img.getAttribute('src'),
        alt: img.getAttribute('alt'),
        w: img.getAttribute('width'),
        h: img.getAttribute('height'),
        nw: img.naturalWidth,
        nh: img.naturalHeight,
        inAuthorRole: !!img.closest('[data-message-author-role]'),
        inAgentTurn: !!img.closest('div.agent-turn'),
        inGroup: !!img.closest('div[class~="group/imagegen-image"]'),
      };
    }, index);
  async function fetchBytes(page, src) {
    return page.evaluate(async (u) => {
      const r = await fetch(u);
      return Array.from(new Uint8Array(await r.arrayBuffer()));
    }, src);
  }
  const textOf = (page, selector) => page.evaluate((s) => document.querySelector(s)?.textContent ?? null, selector);

  async function runMode(behaviour, text = PROMPT) {
    chat.reset();
    chat.setScript([behaviour]);
    const o = await open();
    await sendPrompt(o.page, text);
    return o;
  }

  // ---------------------------------------------------------------- helpers: certs, images
  await check('certs: SAN names, 2-day validity, usable by https', async () => {
    const x = new crypto.X509Certificate(certs.cert);
    for (const n of ['DNS:chatgpt.com', 'DNS:promts.vibecods.xyz', 'DNS:localhost', 'IP Address:127.0.0.1']) {
      assert.ok(x.subjectAltName.includes(n), `SAN lacks ${n}: ${x.subjectAltName}`);
    }
    const days = (new Date(x.validTo) - new Date(x.validFrom)) / 86400000;
    assert.ok(days >= 1.9 && days <= 2.2, `validity ${days} days`);
    assert.ok(new Date(x.validTo) > new Date(Date.now() + 24 * 3600 * 1000));
  });

  await check('png.mjs: valid PNG, >20 KB, deterministic, seeds differ', async () => {
    const a = makePng();
    assert.equal(sniff(a), 'png');
    assert.ok(a.length > 20 * 1024, `size ${a.length}`);
    assert.equal(a.readUInt32BE(16), 768);
    assert.equal(a.readUInt32BE(20), 768);
    assert.ok(makePng({ seed: 1 }).equals(makePng({ seed: 1 })));
    assert.ok(!makePng({ seed: 1 }).equals(makePng({ seed: 2 })));
    assert.ok(!makePng({ seed: 'a' }).equals(makePng({ seed: 'b' })));
    // IDAT inflates to exactly height * (1 + 3 * width) bytes and every chunk CRC verifies.
    let off = 8;
    const idat = [];
    while (off < a.length) {
      const len = a.readUInt32BE(off);
      const type = a.toString('latin1', off + 4, off + 8);
      const crc = a.readUInt32BE(off + 8 + len);
      assert.equal(zlib.crc32(a.subarray(off + 4, off + 8 + len)) >>> 0, crc, `crc of ${type}`);
      if (type === 'IDAT') idat.push(a.subarray(off + 8, off + 8 + len));
      off += 12 + len;
    }
    assert.equal(zlib.inflateSync(Buffer.concat(idat)).length, 768 * (1 + 3 * 768));
    const cpu = process.cpuUsage();
    makePng({ seed: 'speed' });
    const used = process.cpuUsage(cpu);
    assert.ok((used.user + used.system) / 1000 < 300, 'default PNG should take well under 300 ms of CPU');
  });

  await check('png.mjs: JPEG/WebP fixtures decode in Chrome with their stated size', async () => {
    const { page: ctxPage } = await open();
    const cases = [
      ['png', makePng({ width: 100, height: 37, seed: 5 }), 100, 37, 'image/png'],
      ['jpeg', makeJpeg(), makeJpeg().width, makeJpeg().height, 'image/jpeg'],
      ['jpeg seeded', makeJpeg({ seed: 'x' }), 768, 768, 'image/jpeg'],
      ['webp', makeWebp(), makeWebp().width, makeWebp().height, 'image/webp'],
      ['webp seeded', makeWebp({ seed: 'abc' }), 768, 768, 'image/webp'],
    ];
    for (const [name, img, w, h, mime] of cases) {
      const buffer = Buffer.isBuffer(img) ? img : img.buffer;
      const got = await ctxPage.evaluate(
        async ({ b64, mime }) => {
          const blob = new Blob([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], { type: mime });
          const bmp = await createImageBitmap(blob);
          return [bmp.width, bmp.height];
        },
        { b64: buffer.toString('base64'), mime },
      );
      assert.deepEqual(got, [w, h], name);
    }
    assert.equal(sniff(makeJpeg().buffer), 'jpeg');
    assert.equal(sniff(makeWebp().buffer), 'webp');
    assert.ok(!makeJpeg({ seed: 1 }).buffer.equals(makeJpeg({ seed: 2 }).buffer));
    assert.ok(!makeWebp({ seed: 1 }).buffer.equals(makeWebp({ seed: 2 }).buffer));
    assert.equal(makeWebp({ seed: 3 }).buffer.readUInt32LE(4) + 8, makeWebp({ seed: 3 }).buffer.length);
  });

  // ---------------------------------------------------------------- (a) normal flow
  let flowConvPath;
  let flowImageId;
  await check('(a) normal flow: type, send, stop button, image after delay, URL -> /c/<id>', async () => {
    chat.reset();
    chat.setScript([{ mode: 'normal', delayMs: 1500 }]); // transient states are asserted below
    const { page, errors } = await open();
    // composer contract
    const composer = await page.$eval('#prompt-textarea', (el) => ({
      tag: el.tagName,
      cls: el.className,
      ce: el.getAttribute('contenteditable'),
      role: el.getAttribute('role'),
      label: el.getAttribute('aria-label'),
      vk: el.getAttribute('data-virtualkeyboard'),
      html: el.innerHTML,
    }));
    assert.deepEqual(composer, {
      tag: 'DIV',
      cls: 'ProseMirror',
      ce: 'true',
      role: 'textbox',
      label: 'Chat with ChatGPT',
      vk: 'true',
      html: '<p data-placeholder="Ask anything" class="placeholder"><br></p>',
    });
    assert.equal(await page.$eval('main > div#thread', (el) => el.children.length), 0);
    assert.equal(await page.$eval('a[data-testid="new-chat-button"]', (a) => a.getAttribute('href') + '|' + a.textContent), '/|New chat');
    assert.equal(await page.$('[data-testid="login-button"], [data-testid="signup-button"]'), null);
    assert.equal(await page.$('button[data-testid="send-button"]'), null, 'empty composer: no send button (like the real composer)');
    assert.equal(await page.$eval('button[data-testid="composer-speech-button"]', (b) => b.getAttribute('aria-label')), 'Start voice mode');

    await setPrompt(page, PROMPT);
    assert.equal(await textOf(page, '#prompt-textarea'), PROMPT);
    assert.equal(await page.$eval('#prompt-textarea', (e) => e.innerText), PROMPT);
    await page.waitForSelector('button[data-testid="send-button"]:not([disabled])', { timeout: 3000 });
    await page.click('button[data-testid="send-button"]');

    await page.waitForSelector('button[data-testid="stop-button"][aria-label="Stop streaming"]', { timeout: 3000 });
    assert.equal(await page.$('button[data-testid="send-button"]'), null, 'send button is replaced by stop button');
    // user turn + placeholder while generating
    const user = await page.$eval('section[data-testid="conversation-turn-1"][data-turn="user"]', (s) => ({
      role: s.querySelector('[data-message-author-role]')?.getAttribute('data-message-author-role'),
      id: !!s.querySelector('[data-message-author-role][data-message-id]')?.getAttribute('data-message-id'),
      text: s.querySelector('[data-message-author-role="user"] > div.whitespace-pre-wrap')?.textContent,
    }));
    assert.deepEqual(user, { role: 'user', id: true, text: PROMPT });
    const pending = await page.$eval('section[data-testid="conversation-turn-2"][data-turn="assistant"]', (s) => ({
      text: s.querySelector('div.agent-turn')?.textContent,
      imgs: s.querySelectorAll('img').length,
      inRole: !!s.querySelector('[data-message-author-role]'),
    }));
    assert.deepEqual(pending, { text: 'Creating image', imgs: 0, inRole: false });
    assert.equal(await page.$eval('#prompt-textarea', (e) => e.textContent), '', 'composer cleared after send');

    await waitImages(page, 1);
    const info = await imgInfo(page);
    assert.match(info.src, /^\/backend-api\/estuary\/content\?id=file_[0-9a-f]{32}&ts=\d+&p=fs&cid=1&sig=[0-9a-f]{32}$/);
    assert.equal(info.alt, 'Generated image: ' + PROMPT.slice(0, 60));
    assert.equal(info.inAuthorRole, false, 'image must not be inside [data-message-author-role]');
    assert.equal(info.inAgentTurn && info.inGroup, true);
    assert.ok(info.nw >= 512 && info.nh >= 512, `natural ${info.nw}x${info.nh}`);
    assert.equal(`${info.w}x${info.h}`, `${info.nw}x${info.nh}`);
    const fetched = await pageFetch(page, info.src);
    assert.equal(fetched.status, 200);
    assert.equal(fetched.type, 'image/png');
    assert.deepEqual(fetched.bytes.slice(0, 4), [0x89, 0x50, 0x4e, 0x47]);
    assert.equal(await page.locator('button[data-testid="stop-button"]').count(), 0, 'stop button gone');
    assert.equal(await page.$('button[data-testid="send-button"]'), null);
    assert.equal(await page.locator('[data-testid^="conversation-turn-"]').count(), 2);
    assert.equal(await page.locator('div.agent-turn').filter({ hasText: 'Creating image' }).count(), 0);
    flowConvPath = new URL(page.url()).pathname;
    flowImageId = new URL(info.src, 'https://x').searchParams.get('id');
    assert.match(flowConvPath, /^\/c\/[0-9a-f-]{36}$/);
    const st = chat.getState();
    assert.equal(st.sends.length, 1);
    assert.deepEqual({ ...st.sends[0], at: typeof st.sends[0].at }, { conv_id: flowConvPath.slice(3), text: PROMPT, mode: 'normal', at: 'number' });
    assert.equal(st.conversations[flowConvPath.slice(3)], 2);
    assert.deepEqual(errors, []);
  });

  // ---------------------------------------------------------------- (b) reload restores
  await check('(b) reload of /c/<id> restores turns server-side, also mid-generation', async () => {
    const { page } = await open(chat.url, { path: flowConvPath });
    await waitImages(page, 1);
    assert.equal(await textOf(page, 'section[data-testid="conversation-turn-1"] .whitespace-pre-wrap'), PROMPT);
    const info = await imgInfo(page);
    assert.equal(new URL(info.src, 'https://x').searchParams.get('id'), flowImageId);
    assert.equal(info.inAuthorRole, false);
    await page.reload();
    await waitImages(page, 1);
    assert.equal(await page.locator('[data-testid^="conversation-turn-"]').count(), 2);
    assert.equal(await stopButton(page).count(), 0);
    // reload while generating (crash recovery): placeholder + stop button come back, then the image
    chat.setScript([{ mode: 'normal', delayMs: 3000 }]);
    await page.goto(chat.url + '/');
    await sendPrompt(page, 'second prompt for crash recovery');
    await stopButton(page).waitFor({ timeout: 3000 });
    await page.reload();
    assert.equal(await stopButton(page).count(), 1, 'stop button restored after reload');
    assert.equal(await textOf(page, 'section[data-testid="conversation-turn-2"] div.agent-turn'), 'Creating image');
    assert.equal(await textOf(page, 'section[data-testid="conversation-turn-1"] .whitespace-pre-wrap'), 'second prompt for crash recovery');
    await waitImages(page, 1);
    assert.equal(await stopButton(page).count(), 0);
  });

  // ---------------------------------------------------------------- composer behaviour
  await check('composer: typing, Shift+Enter, paste, clearing, Enter to send, exact server text', async () => {
    chat.reset();
    const { page, errors } = await open();
    const html = () => page.$eval('#prompt-textarea', (e) => e.innerHTML);
    const lines = () => page.$$eval('#prompt-textarea > p', (ps) => ps.map((p) => p.textContent));
    const settle = () => page.evaluate(() => new Promise((r) => setTimeout(r, 30)));
    await page.click('#prompt-textarea');
    await page.keyboard.type('hello world ');
    assert.equal(await textOf(page, '#prompt-textarea'), 'hello world ', 'typed text, regular spaces');
    assert.equal(await page.$eval('button[data-testid="send-button"]', (b) => b.disabled), false);
    await page.keyboard.press('Shift+Enter');
    await page.keyboard.type('second');
    await settle();
    assert.deepEqual(await lines(), ['hello world ', 'second']);
    assert.equal(await html(), '<p>hello world </p><p>second</p>');
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Backspace');
    await settle();
    assert.equal(await html(), '<p data-placeholder="Ask anything" class="placeholder"><br></p>');
    assert.equal(await page.$('button[data-testid="send-button"]'), null);
    await page.keyboard.type('   ');
    assert.equal(await page.$('button[data-testid="send-button"]'), null, 'whitespace only: still no send button');
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Backspace');
    // synthetic paste with text/plain DataTransfer (what extensions dispatch)
    await page.evaluate(() => {
      const el = document.querySelector('#prompt-textarea');
      el.focus();
      const dt = new DataTransfer();
      dt.setData('text/plain', 'p1\r\np2\n\np4');
      const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
      window.__pasteHandled = !el.dispatchEvent(ev);
    });
    await settle();
    assert.equal(await page.evaluate(() => window.__pasteHandled), true, 'paste default prevented');
    assert.equal(await html(), '<p>p1</p><p>p2</p><p><br></p><p>p4</p>');
    // typing continues at the caret after a paste
    await page.keyboard.type('!');
    await settle();
    assert.deepEqual(await lines(), ['p1', 'p2', '', 'p4!']);
    // execCommand multi-line insert normalises to one <p> per line without placeholder attributes
    await page.evaluate(() => {
      const el = document.querySelector('#prompt-textarea');
      el.focus();
      document.execCommand('selectAll');
      document.execCommand('insertText', false, 'a\nb\n\nd');
    });
    await settle();
    assert.equal(await html(), '<p>a</p><p>b</p><p><br></p><p>d</p>');
    // Enter (no Shift) sends and the server receives the exact text
    chat.setScript([{ mode: 'normal', delayMs: 2000 }]);
    await page.keyboard.press('Enter');
    await page.waitForSelector('section[data-testid="conversation-turn-1"]', { timeout: 3000 });
    assert.equal(await page.$eval('section[data-testid="conversation-turn-1"] .whitespace-pre-wrap', (e) => e.textContent), 'a\nb\n\nd');
    assert.equal(await textOf(page, '#prompt-textarea'), '');
    assert.equal(chat.getState().sends.at(-1).text, 'a\nb\n\nd');
    await stopButton(page).waitFor({ timeout: 3000 });
    await page.keyboard.type('typed while generating');
    await page.keyboard.press('Enter');
    await sleep(100);
    assert.equal(chat.getState().sends.length, 1, 'Enter while generating does not send');
    await waitImages(page, 1);
    assert.deepEqual(errors, []);
  });

  await check('composer: reference-extension flows (emptied <p>, selectAll+insertText, textContent+input, synthetic Enter/click)', async () => {
    chat.reset();
    const { page } = await open();
    const settle = () => page.evaluate(() => new Promise((r) => setTimeout(r, 30)));
    // flow 1: strip every <p> child, caret at end of the editor, insertText
    await page.evaluate(() => {
      const t = document.querySelector('#prompt-textarea');
      t.focus();
      t.querySelectorAll('p').forEach((c) => [...c.childNodes].forEach((o) => (o.nodeType === 1 ? o.nodeName === 'BR' && o.remove() : o.remove())));
      const r = getSelection();
      const n = document.createRange();
      n.selectNodeContents(t);
      n.collapse(false);
      r.removeAllRanges();
      r.addRange(n);
      document.execCommand('insertText', false, 'first flow text');
    });
    await settle();
    assert.equal(await page.$eval('#prompt-textarea', (e) => e.innerHTML), '<p>first flow text</p>');
    assert.equal(await page.$eval('button[data-testid="send-button"]', (b) => b.disabled), false);
    // caret stays at the end after normalisation: typing appends
    await page.keyboard.type('!');
    await settle();
    assert.equal(await textOf(page, '#prompt-textarea'), 'first flow text!');
    // flow 2: selectAll + insertText replaces
    await page.evaluate(() => {
      const t = document.querySelector('#prompt-textarea');
      t.focus();
      document.execCommand('selectAll', false, null);
      document.execCommand('insertText', false, 'second flow');
    });
    await settle();
    assert.equal(await page.$eval('#prompt-textarea', (e) => e.innerHTML), '<p>second flow</p>');
    // flow 3: textContent assignment + input event; send through a synthetic Enter keydown
    await page.evaluate(() => {
      const t = document.querySelector('#prompt-textarea');
      t.textContent = 'third flow';
      t.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: 'x' }));
    });
    await settle();
    assert.equal(await page.$eval('#prompt-textarea', (e) => e.innerHTML), '<p>third flow</p>');
    await page.evaluate(() => {
      const t = document.querySelector('#prompt-textarea');
      t.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
    });
    await page.waitForSelector('section[data-testid="conversation-turn-1"]', { timeout: 3000 });
    assert.equal(chat.getState().sends.at(-1).text, 'third flow');
    await waitImages(page, 1);
    // flow 4: programmatic click on the send button (React-style dispatch)
    await setPrompt(page, 'fourth flow');
    await page.evaluate(() => document.querySelector('button[data-testid="send-button"]').click());
    await page.waitForSelector('section[data-testid="conversation-turn-3"]', { timeout: 3000 });
    assert.equal(chat.getState().sends.at(-1).text, 'fourth flow');
    await waitImages(page, 2);
  });

  await check('composer: caret stays right when lines are split, joined or pasted into mid-text', async () => {
    chat.reset();
    const { page } = await open();
    const lines = () => page.$$eval('#prompt-textarea > p', (ps) => ps.map((p) => p.textContent));
    const settle = () => page.evaluate(() => new Promise((r) => setTimeout(r, 30)));
    await page.click('#prompt-textarea');
    await page.keyboard.type('abcdef');
    for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('Shift+Enter');
    await page.keyboard.type('X');
    await settle();
    assert.equal(await page.$eval('#prompt-textarea', (e) => e.innerHTML), '<p>abc</p><p>Xdef</p>');
    await page.keyboard.press('Home');
    await page.keyboard.press('Backspace');
    await page.keyboard.type('Y');
    await settle();
    assert.deepEqual(await lines(), ['abcYXdef']);
    await page.evaluate(() => {
      const dt = new DataTransfer();
      dt.setData('text/plain', 'P\nQ');
      document.querySelector('#prompt-textarea').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    });
    await page.keyboard.type('Z');
    await settle();
    assert.deepEqual(await lines(), ['abcYP', 'QZXdef']);
    assert.equal(await page.$eval('#prompt-textarea', (e) => e.querySelectorAll('[class],[data-placeholder]').length), 0);
  });

  await check('round trip: markup-like text, emoji and an 8000-char multi-line prompt survive send + reload', async () => {
    chat.reset();
    const { page } = await open();
    const nasty = '</script><b>bold</b> & "quotes" \'single\' <img src=x onerror=alert(1)> Caf\u00e9 \u{1F98A} \u65e5\u672c\u8a9e';
    await sendPrompt(page, nasty);
    await waitImages(page, 1);
    const userText = () => textOf(page, 'section[data-testid="conversation-turn-1"] .whitespace-pre-wrap');
    assert.equal(await userText(), nasty);
    assert.equal(chat.getState().sends[0].text, nasty);
    await page.reload();
    await waitImages(page, 1);
    assert.equal(await userText(), nasty);
    assert.equal(await page.locator('#thread b, #thread img[src="x"]').count(), 0, 'prompt text is never parsed as markup');
    const long = Array.from({ length: 40 }, (_, i) => `line ${i}: ${'lorem ipsum '.repeat(17)}`).join('\n').slice(0, 8000).trim();
    assert.equal(long.length >= 7990, true);
    await sendPrompt(page, long);
    await waitImages(page, 2);
    assert.equal(chat.getState().sends.at(-1).text, long);
    assert.equal(await textOf(page, 'section[data-testid="conversation-turn-3"] .whitespace-pre-wrap'), long);
  });

  await check('SPA: New chat link navigates without reload, back restores the conversation', async () => {
    chat.reset();
    const { page } = await open();
    await sendPrompt(page);
    await waitImages(page, 1);
    const convPath = new URL(page.url()).pathname;
    await page.evaluate(() => (window.__alive = 42));
    await page.click('a[data-testid="new-chat-button"]');
    await page.waitForFunction(() => location.pathname === '/');
    assert.equal(await page.evaluate(() => window.__alive), 42, 'no full page reload');
    assert.equal(await page.locator('[data-testid^="conversation-turn-"]').count(), 0);
    assert.equal(await page.$eval('#prompt-textarea', (e) => e.innerHTML), '<p data-placeholder="Ask anything" class="placeholder"><br></p>');
    await page.goBack();
    await page.waitForFunction((p) => location.pathname === p, convPath);
    await waitImages(page, 1);
    assert.equal(await page.evaluate(() => window.__alive), 42);
  });

  // ---------------------------------------------------------------- (c) modes
  await check('(c) mode two-images: final turn has two distinct images', async () => {
    const { page } = await runMode('two-images');
    await waitImages(page, 2);
    assert.equal(await page.locator('img[src*="/backend-api/estuary/content"]').count(), 2);
    assert.equal(await page.locator('section[data-testid="conversation-turn-2"] div[class~="group/imagegen-image"]').count(), 2);
    const [a, b] = [await imgInfo(page, 0), await imgInfo(page, 1)];
    assert.notEqual(a.src, b.src);
    assert.equal(a.inAuthorRole || b.inAuthorRole, false);
    const [ba, bb] = [await fetchBytes(page, a.src), await fetchBytes(page, b.src)];
    assert.notEqual(sha(Buffer.from(ba)), sha(Buffer.from(bb)));
    assert.equal(await page.locator('section[data-testid^="conversation-turn-"]').count(), 2);
  });

  await check('(c) mode text-only: assistant text, no image', async () => {
    const { page } = await runMode('text-only');
    await page.waitForSelector('[data-message-author-role="assistant"]', { timeout: 4000 });
    assert.equal(await textOf(page, '[data-message-author-role="assistant"] .markdown.prose p'), 'Sure! Here is a description\u2026');
    await page.waitForFunction(() => !document.querySelector('[data-testid="stop-button"]'));
    assert.equal(await page.locator('img').count(), 0);
    assert.equal(await page.locator('[role="alert"]').count(), 0);
    assert.equal(await page.locator('section[data-testid="conversation-turn-2"][data-turn="assistant"]').count(), 1);
  });

  await check('(c) mode rate-limit: free plan limit text, no image', async () => {
    const { page } = await runMode('rate-limit');
    await page.waitForSelector('[data-message-author-role="assistant"]', { timeout: 4000 });
    assert.equal(
      await textOf(page, '[data-message-author-role="assistant"] .markdown p'),
      "You've hit the free plan limit for image generations requests. You can create more images when the limit resets.",
    );
    assert.equal(await page.locator('img').count(), 0);
    await page.waitForFunction(() => !document.querySelector('[data-testid="stop-button"]'));
  });

  await check('(c) mode policy: content policy refusal text, no image', async () => {
    const { page } = await runMode('policy');
    await page.waitForSelector('[data-message-author-role="assistant"]', { timeout: 4000 });
    assert.equal(
      await textOf(page, '[data-message-author-role="assistant"] .markdown p'),
      "I'm sorry, but I can't generate that image because the request may violate our content policies.",
    );
    assert.equal(await page.locator('img').count(), 0);
  });

  await check('(c) mode error: alert + Retry button, stop button gone, no image; Retry re-runs the prompt', async () => {
    const { page } = await runMode('error');
    await page.waitForSelector('div[role="alert"]', { timeout: 4000 });
    assert.equal(await textOf(page, 'div[role="alert"]'), 'Something went wrong. There was an error generating a response.');
    assert.equal(await page.locator('button', { hasText: /^Retry$/ }).count(), 1);
    assert.equal(await stopButton(page).count(), 0);
    assert.equal(await page.locator('img').count(), 0);
    assert.equal(await page.locator('section[data-turn="assistant"]').count(), 0);
    assert.equal(await page.locator('button[data-testid="send-button"]').count(), 0, 'empty composer after the error: no send button');
    chat.setScript(['normal']);
    await page.click('button:has-text("Retry")');
    await waitImages(page, 1);
    assert.equal(await page.locator('div[role="alert"]').count(), 0);
    const sends = chat.getState().sends;
    assert.deepEqual(sends.map((s) => [s.mode, s.text, !!s.retry]), [['error', PROMPT, false], ['normal', PROMPT, true]]);
  });

  await check('(c) mode hang: stop stays until stop is clicked; also released by a script change', async () => {
    const { page } = await runMode('hang');
    await stopButton(page).waitFor({ timeout: 3000 });
    await sleep(DELAY * 3);
    assert.equal(await stopButton(page).count(), 1, 'stop button still there after > delay');
    assert.equal(await page.locator('img').count(), 0);
    assert.equal(await textOf(page, 'section[data-testid="conversation-turn-2"] div.agent-turn'), 'Creating image');
    await stopButton(page).click();
    await page.waitForFunction(() => !document.querySelector('[data-testid="stop-button"]'));
    assert.equal(await textOf(page, '[data-message-author-role="assistant"] .markdown p'), 'Stopped.');
    assert.equal(await page.locator('img').count(), 0);
    assert.equal(await page.locator('div.agent-turn').count(), 0);
    // second hang, released through setScript
    chat.setScript(['hang']);
    await setPrompt(page, 'another one');
    await page.click('button[data-testid="send-button"]');
    await stopButton(page).waitFor({ timeout: 3000 });
    chat.setScript([]);
    await page.waitForFunction(() => !document.querySelector('[data-testid="stop-button"]'), null, { timeout: 3000 });
    assert.equal(await page.locator('[data-message-author-role="assistant"]').count(), 2);
  });

  await check('(c) stop button cancels a running generation ("Stopped.", no image)', async () => {
    chat.reset();
    chat.setScript([{ mode: 'normal', delayMs: 3000 }]);
    const { page } = await open();
    await sendPrompt(page);
    await stopButton(page).click();
    await page.waitForFunction(() => !document.querySelector('[data-testid="stop-button"]'));
    assert.equal(await textOf(page, 'section[data-testid="conversation-turn-2"] [data-message-author-role="assistant"] .markdown p'), 'Stopped.');
    await sleep(DELAY + 200);
    assert.equal(await page.locator('img').count(), 0);
  });

  await check('(c) mode small-image: 128x128 preview-sized image', async () => {
    const { page } = await runMode('small-image');
    await waitImages(page, 1);
    const info = await imgInfo(page);
    assert.deepEqual([info.nw, info.nh, info.w, info.h], [128, 128, '128', '128']);
    assert.equal((await pageFetch(page, info.src)).status, 200);
  });

  await check('(c) mode same-image: same file id and bytes as the previous generation', async () => {
    chat.reset();
    chat.setScript(['normal', 'same-image']);
    const { page } = await open();
    await sendPrompt(page, 'first');
    await waitImages(page, 1);
    await page.waitForFunction(() => !document.querySelector('[data-testid="stop-button"]'));
    await sendPrompt(page, 'second');
    await waitImages(page, 2);
    const [a, b] = [await imgInfo(page, 0), await imgInfo(page, 1)];
    const idOf = (src) => new URL(src, 'https://x').searchParams.get('id');
    assert.equal(idOf(a.src), idOf(b.src), 'same file id');
    assert.equal(sha(Buffer.from(await fetchBytes(page, a.src))), sha(Buffer.from(await fetchBytes(page, b.src))), 'same bytes');
    assert.equal(b.alt, 'Generated image: second');
    assert.equal(await page.locator('[data-testid^="conversation-turn-"]').count(), 4);
  });

  for (const [mode, fmt, mime] of [['jpeg', 'jpeg', 'image/jpeg'], ['webp', 'webp', 'image/webp']]) {
    await check(`(c) mode ${mode}: ${mime} bytes with matching Content-Type`, async () => {
      const { page } = await runMode(mode);
      await waitImages(page, 1);
      const info = await imgInfo(page);
      const fetched = await pageFetch(page, info.src);
      assert.equal(fetched.status, 200);
      assert.equal(fetched.type, mime);
      assert.equal(sniff(Buffer.from(fetched.bytes)), fmt);
      assert.deepEqual([info.nw, info.nh], [info.w, info.h].map(Number));
      assert.ok(info.nw >= 512);
      assert.equal(info.inAuthorRole, false);
    });
  }

  await check('(c) mode drop-send: user turn appears, no assistant turn, no stop button', async () => {
    const { page } = await runMode('drop-send');
    await page.waitForSelector('section[data-testid="conversation-turn-1"][data-turn="user"]', { timeout: 3000 });
    await sleep(DELAY * 3);
    assert.equal(await page.locator('[data-testid^="conversation-turn-"]').count(), 1);
    assert.equal(await stopButton(page).count(), 0);
    assert.equal(await page.locator('img').count(), 0);
    assert.equal(chat.getState().sends[0].mode, 'drop-send');
    assert.deepEqual(chat.getState().running, []);
  });

  await check('(c) script queue, defaults, times, behaviour options, HTTP control', async () => {
    chat.reset();
    const send = async (text = 'x') => {
      const r = await request(chat.url, '/__mock/send', { method: 'POST', body: { text } });
      assert.equal(r.status, 200);
      return JSON.parse(r.body.toString()).conv_id;
    };
    const waitDone = async (id) => {
      for (let i = 0; i < 100; i++) {
        const v = JSON.parse((await request(chat.url, `/__mock/conv/${id}`)).body.toString());
        if (!v.running) return v;
        await sleep(50);
      }
      throw new Error('generation never finished');
    };
    chat.setScript(['normal', { mode: 'rate-limit' }, 'text-only']);
    assert.deepEqual(chat.getState().script.map((b) => b.mode), ['normal', 'rate-limit', 'text-only']);
    const ids = [await send(), await send(), await send(), await send()];
    for (const id of ids) await waitDone(id);
    assert.deepEqual(chat.getState().sends.map((s) => s.mode), ['normal', 'rate-limit', 'text-only', 'normal']);
    assert.deepEqual(chat.getState().script, []);
    // times + defaults.mode + per-behaviour text/delay overrides
    chat.setDefaults({ mode: 'policy', delayMs: 50 });
    chat.setScript([{ mode: 'text-only', times: 2, text: 'custom' }, { mode: 'normal', delayMs: 10, size: 64 }]);
    assert.equal(chat.getState().script.length, 3);
    const t1 = await waitDone(await send());
    assert.equal(t1.turns.at(-1).text, 'custom');
    await waitDone(await send());
    const n = await waitDone(await send());
    assert.equal(n.turns.at(-1).images[0].w, 64);
    const d = await waitDone(await send());
    assert.match(d.turns.at(-1).text, /content policies/);
    assert.throws(() => chat.setScript(['bogus']), /unknown mode/);
    assert.throws(() => chat.setDefaults({ delayMs: -1 }));
    // HTTP control mirrors the in-process API
    const ctl = await request(chat.url, '/__ctl', { method: 'POST', body: { reset: true, script: ['error', { mode: 'hang' }], defaults: { delayMs: 77 }, captcha: true } });
    const state = JSON.parse(ctl.body.toString());
    assert.deepEqual(
      [ctl.status, state.sends.length, state.script.map((b) => b.mode), state.defaults.delayMs, state.captcha, state.loggedOut, state.uiChanged],
      [200, 0, ['error', 'hang'], 77, true, false, false],
    );
    const viaGet = JSON.parse((await request(chat.url, '/__state')).body.toString());
    assert.deepEqual(Object.keys(viaGet).filter((k) => ['sends', 'conversations', 'script', 'defaults'].includes(k)).sort(), ['conversations', 'defaults', 'script', 'sends']);
    const bad = await request(chat.url, '/__ctl', { method: 'POST', body: { script: ['nope'] } });
    assert.equal(bad.status, 400);
    await request(chat.url, '/__ctl', { method: 'POST', body: { reset: true } });
    const clean = chat.getState();
    assert.deepEqual([clean.captcha, clean.script, clean.defaults.delayMs, clean.sends], [false, [], DELAY, []]);
  });

  // ---------------------------------------------------------------- (d) toggles
  await check('(d) loggedOut: login/signup buttons, no composer, URL stays, image endpoint 401', async () => {
    chat.reset();
    chat.setScript(['normal']);
    const { page } = await open();
    await sendPrompt(page);
    await waitImages(page, 1);
    const convPath = new URL(page.url()).pathname;
    const src = (await imgInfo(page)).src;
    assert.equal((await pageFetch(page, src)).status, 200);
    // flipping the toggle at runtime updates the open page
    chat.setToggles({ loggedOut: true });
    await page.waitForSelector('button[data-testid="login-button"]', { timeout: 3000 });
    assert.equal(await page.$eval('button[data-testid="login-button"]', (b) => b.textContent), 'Log in');
    assert.equal(await page.$eval('button[data-testid="signup-button"]', (b) => b.textContent), 'Sign up');
    assert.equal(await page.locator('#prompt-textarea').count(), 0);
    assert.equal(await page.locator('button[data-testid="send-button"]').count(), 0);
    assert.equal((await pageFetch(page, src)).status, 401, 'image endpoint 401 even with the cookie');
    assert.equal(new URL(page.url()).pathname, convPath, 'URL stays');
    // a fresh load while logged out
    const { page: fresh } = await open(chat.url, { path: convPath });
    assert.equal(await fresh.locator('button[data-testid="login-button"]').count(), 1);
    assert.equal(await fresh.locator('#prompt-textarea').count(), 0);
    assert.equal(new URL(fresh.url()).pathname, convPath);
    assert.equal(JSON.parse((await request(chat.url, '/api/auth/session')).body.toString()).user, undefined);
    chat.setToggles({ loggedOut: false });
    await fresh.reload();
    assert.equal(await fresh.locator('#prompt-textarea').count(), 1);
    assert.equal(await fresh.locator('button[data-testid="login-button"]').count(), 0);
  });

  await check('(d) captcha: challenge overlay, composer disabled', async () => {
    chat.reset();
    chat.setToggles({ captcha: true });
    const { page } = await open();
    const overlay = await page.$eval('#challenge-stage', (el) => ({
      iframe: el.querySelector('iframe')?.getAttribute('title'),
      src: el.querySelector('iframe')?.getAttribute('src'),
      text: el.querySelector('p')?.textContent,
      position: getComputedStyle(el).position,
      covers: el.getBoundingClientRect().width >= innerWidth && el.getBoundingClientRect().height >= innerHeight,
      top: document.elementFromPoint(innerWidth / 2, innerHeight / 2) === el || el.contains(document.elementFromPoint(innerWidth / 2, innerHeight / 2)),
    }));
    assert.deepEqual(overlay, {
      iframe: 'Widget containing a Cloudflare security challenge',
      src: 'about:blank',
      text: 'Verify you are human',
      position: 'fixed',
      covers: true,
      top: true,
    });
    assert.equal(await page.$eval('#prompt-textarea', (e) => e.getAttribute('contenteditable')), 'false');
    assert.equal(await page.$('button[data-testid="send-button"]'), null);
    await page.evaluate(() => document.querySelector('#prompt-textarea').focus());
    await page.keyboard.type('should not appear');
    await page.keyboard.press('Enter');
    await sleep(100);
    assert.equal(await textOf(page, '#prompt-textarea'), '');
    assert.equal(chat.getState().sends.length, 0);
    // toggling off at runtime restores the composer
    chat.setToggles({ captcha: false });
    await page.waitForFunction(() => !document.querySelector('#challenge-stage'), null, { timeout: 3000 });
    assert.equal(await page.$eval('#prompt-textarea', (e) => e.getAttribute('contenteditable')), 'true');
    // and toggling on at runtime shows it
    chat.setToggles({ captcha: true });
    await page.waitForSelector('#challenge-stage', { timeout: 3000 });
  });

  await check('(d) uiChanged: no data-testid/aria-label/id, plain textarea + div.btn', async () => {
    chat.reset();
    chat.setToggles({ uiChanged: true });
    const { page } = await open();
    const counts = await page.evaluate(() => ({
      testid: document.querySelectorAll('[data-testid]').length,
      aria: document.querySelectorAll('[aria-label]').length,
      id: document.querySelectorAll('[id]').length,
      textarea: document.querySelectorAll('textarea.x1').length,
      cls: document.querySelector('textarea')?.className,
      pm: document.querySelectorAll('.ProseMirror, [contenteditable]').length,
      buttons: document.querySelectorAll('button').length,
      divBtn: document.querySelectorAll('div.btn').length,
    }));
    assert.deepEqual(
      { ...counts, divBtn: counts.divBtn >= 2 },
      { testid: 0, aria: 0, id: 0, textarea: 1, cls: 'x1', pm: 0, buttons: 0, divBtn: true },
    );
    for (const sel of ['#prompt-textarea', '[data-testid="send-button"]', '#thread', 'button[aria-label="Send prompt"]']) {
      assert.equal(await page.locator(sel).count(), 0, sel);
    }
    // the page itself stays functional: type in the textarea and click the send div
    await page.fill('textarea.x1', 'ui changed prompt');
    await page.locator('div.btn').last().click();
    await page.waitForSelector('section[data-turn="user"]', { timeout: 3000 });
    assert.equal(chat.getState().sends.at(-1).text, 'ui changed prompt');
    await waitImages(page, 1);
    const after = await page.evaluate(() => ({
      testid: document.querySelectorAll('[data-testid]').length,
      aria: document.querySelectorAll('[aria-label]').length,
      id: document.querySelectorAll('[id]').length,
    }));
    assert.deepEqual(after, { testid: 0, aria: 0, id: 0 });
  });

  await check('(d) offline: /__mock/* returns 503 so turns never complete', async () => {
    chat.reset();
    chat.setToggles({ offline: true });
    assert.equal((await request(chat.url, '/__mock/conv/anything')).status, 503);
    assert.equal((await request(chat.url, '/__mock/send', { method: 'POST', body: { text: 'x' } })).status, 503);
    assert.equal((await request(chat.url, '/__state')).status, 200, 'control endpoints keep working');
    assert.equal((await request(chat.url, '/')).status, 200, 'page itself still loads');
    const { page } = await open();
    await sendPrompt(page, 'offline prompt');
    await page.waitForSelector('section[data-testid="conversation-turn-1"][data-turn="user"]', { timeout: 3000 });
    await sleep(DELAY * 3);
    assert.equal(await page.locator('img').count(), 0);
    assert.equal(await page.locator('section[data-turn="assistant"]').count(), 0);
    assert.equal(chat.getState().sends.length, 0);
    // offline mid-generation: the page never learns about the finished turn
    chat.reset();
    chat.setScript([{ mode: 'normal', delayMs: 1500 }]);
    const { page: p2 } = await open();
    await sendPrompt(p2);
    await stopButton(p2).waitFor({ timeout: 3000 });
    chat.setToggles({ offline: true });
    await sleep(2200);
    assert.equal(await stopButton(p2).count(), 1, 'stale UI keeps showing the generation');
    assert.equal(await p2.locator('img').count(), 0);
    chat.setToggles({ offline: false });
    await waitImages(p2, 1);
  });

  // ---------------------------------------------------------------- (e) image endpoint cookie
  await check('(e) image endpoint: 401 without cookie, 200 + Content-Type with it, HEAD, 404 unknown', async () => {
    chat.reset();
    chat.setScript(['normal', 'jpeg']);
    const gen = async () => {
      const id = JSON.parse((await request(chat.url, '/__mock/send', { method: 'POST', body: { text: 'cookie test' } })).body.toString()).conv_id;
      for (let i = 0; i < 100; i++) {
        const v = JSON.parse((await request(chat.url, `/__mock/conv/${id}`)).body.toString());
        if (!v.running) return v.turns.at(-1).images[0].src;
        await sleep(50);
      }
      throw new Error('never finished');
    };
    const png = await gen();
    const jpg = await gen();
    const noCookie = await request(chat.url, png);
    assert.equal(noCookie.status, 401);
    assert.match(noCookie.headers['content-type'], /application\/json/);
    assert.ok(JSON.parse(noCookie.body.toString()).detail);
    assert.equal((await request(chat.url, png, { headers: { cookie: 'rps_session=nope' } })).status, 401);
    assert.equal((await request(chat.url, png, { headers: { cookie: 'other=1; rps_session=ok' } })).status, 200);
    const ok = await request(chat.url, png, { headers: SESSION });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers['content-type'], 'image/png');
    assert.equal(sniff(ok.body), 'png');
    const head = await request(chat.url, png, { method: 'HEAD', headers: SESSION });
    assert.equal(head.status, 200);
    assert.equal(head.headers['content-type'], 'image/png');
    assert.equal(Number(head.headers['content-length']), ok.body.length);
    assert.equal(head.body.length, 0);
    assert.equal((await request(chat.url, png, { method: 'HEAD' })).status, 401);
    const jpeg = await request(chat.url, jpg, { headers: SESSION });
    assert.deepEqual([jpeg.status, jpeg.headers['content-type'], sniff(jpeg.body)], [200, 'image/jpeg', 'jpeg']);
    assert.equal((await request(chat.url, '/backend-api/estuary/content?id=file_missing', { headers: SESSION })).status, 404);
    // the page sets the cookie exactly as specified
    const page = await request(chat.url, '/');
    assert.equal(page.headers['set-cookie']?.[0], 'rps_session=ok; Path=/; Secure; SameSite=Lax');
    assert.equal((await request(chat.url, '/c/some-id')).status, 200);
    assert.equal((await request(chat.url, '/nope')).status, 404);
  });

  // ---------------------------------------------------------------- (f) static site
  let site;
  let siteDir = SITE_DIST;
  let siteIsReal = fs.existsSync(path.join(SITE_DIST, 'index.html'));
  if (!siteIsReal) {
    siteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mock-site-'));
    fs.mkdirSync(path.join(siteDir, 'assets'));
    fs.writeFileSync(path.join(siteDir, 'index.html'), '<!doctype html><title>tiny</title><div id="root"></div><script type="module" src="./assets/app.js"></script>');
    fs.writeFileSync(path.join(siteDir, 'assets', 'app.js'), 'document.getElementById("root").textContent = "ok";');
    fs.writeFileSync(path.join(siteDir, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>');
  }
  site = await startStaticSite({ dir: siteDir, certs });
  stoppers.push(() => site.stop());
  if (!siteIsReal) stoppers.push(() => fs.rmSync(siteDir, { recursive: true, force: true }));
  await check(`(f) static site (${siteIsReal ? 'real dist' : 'tiny temp dir'}): index 200 + CSP, MIME types, SPA fallback`, async () => {
    const index = await request(site.url, '/');
    assert.equal(index.status, 200);
    assert.match(index.headers['content-type'], /^text\/html/);
    assert.equal(
      index.headers['content-security-policy'],
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    );
    assert.equal(index.headers['cache-control'], 'no-cache');
    assert.equal(index.headers['x-content-type-options'], 'nosniff');
    assert.equal(index.headers['x-frame-options'], 'DENY');
    assert.equal(index.headers['referrer-policy'], 'no-referrer');
    assert.equal((await request(site.url, '/index.html')).status, 200);
    const html = index.body.toString();
    const js = html.match(/src="\.\/(assets\/[^"]+\.js)"/)?.[1];
    assert.ok(js, 'index.html references a script');
    const jsRes = await request(site.url, '/' + js);
    assert.deepEqual([jsRes.status, jsRes.headers['content-type']], [200, 'text/javascript; charset=utf-8']);
    const css = html.match(/href="\.\/(assets\/[^"]+\.css)"/)?.[1];
    if (css) assert.equal((await request(site.url, '/' + css)).headers['content-type'], 'text/css; charset=utf-8');
    assert.equal((await request(site.url, '/favicon.svg')).headers['content-type'], 'image/svg+xml');
    const spa = await request(site.url, '/some/deep/route');
    assert.deepEqual([spa.status, spa.body.equals(index.body)], [200, true]);
    assert.equal((await request(site.url, '/assets/missing.js')).status, 404);
    assert.equal((await request(site.url, '/../../../etc/passwd')).headers['content-type'].startsWith('text/html'), true);
    const head = await request(site.url, '/', { method: 'HEAD' });
    assert.deepEqual([head.status, head.body.length, Number(head.headers['content-length'])], [200, 0, index.body.length]);
  });

  await check('(f) static site renders in Chrome under its CSP without violations', async () => {
    const { page, errors } = await open(site.url);
    await page.waitForFunction(() => (document.getElementById('root')?.childNodes.length ?? 0) > 0 || document.getElementById('root')?.textContent, null, { timeout: 8000 });
    assert.deepEqual(errors, []);
  });

  // ---------------------------------------------------------------- (g) mapped hostnames, like the real runs
  await check('(g) Chrome with --host-resolver-rules: https://chatgpt.com + https://promts.vibecods.xyz', async () => {
    chat.reset();
    const mapped = await chromium.launch({
      executablePath: findChrome(),
      args: [
        '--no-sandbox',
        '--ignore-certificate-errors',
        '--disable-dev-shm-usage',
        `--host-resolver-rules=MAP chatgpt.com 127.0.0.1:${chat.port}, MAP promts.vibecods.xyz 127.0.0.1:${site.port}`,
      ],
    });
    try {
      const page = await mapped.newPage({ ignoreHTTPSErrors: true });
      await page.goto('https://chatgpt.com/');
      assert.equal(await page.evaluate(() => location.origin), 'https://chatgpt.com');
      await sendPrompt(page, 'mapped host prompt');
      await waitImages(page, 1);
      const info = await imgInfo(page);
      const resolved = await page.evaluate((s) => new URL(document.querySelector(`img[src="${s}"]`).src).origin, info.src);
      assert.equal(resolved, 'https://chatgpt.com');
      assert.equal((await pageFetch(page, info.src)).status, 200);
      assert.match(await page.evaluate(() => document.cookie), /rps_session=ok/);
      const resp = await page.goto('https://promts.vibecods.xyz/');
      assert.equal(resp.status(), 200);
      assert.match(resp.headers()['content-security-policy'], /default-src 'self'/);
      assert.equal(await page.evaluate(() => location.origin), 'https://promts.vibecods.xyz');
    } finally {
      await mapped.close();
    }
  });

  // ---------------------------------------------------------------- slow mode (started at the beginning)
  await check('(c) mode slow: defaults to an 8 s delay, then one image', async () => {
    while (!slowSamples[9.5] && Date.now() - slowStart < 15000) await sleep(100);
    assert.equal(slowSamples[1]?.running, true, 'running at 1 s');
    assert.equal(slowSamples[1].turns.at(-1).kind, 'pending');
    assert.equal(slowSamples[7]?.running, true, 'still running at 7 s');
    assert.equal(slowSamples[9.5]?.running, false, 'finished by 9.5 s');
    const last = slowSamples[9.5].turns.at(-1);
    assert.equal(last.kind, 'image');
    assert.equal(last.images.length, 1);
    assert.equal(slowChat.getState().sends[0].mode, 'slow');
  });

  // ---------------------------------------------------------------- teardown
  for (const stopper of stoppers) await Promise.race([Promise.resolve().then(stopper).catch(() => {}), sleep(5000)]);
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed${failed.length ? `, ${failed.length} FAILED` : ''}`);
  return failed.length ? 1 : 0;
}

const started = Date.now();
main()
  .then((code) => {
    console.log(`selftest took ${((Date.now() - started) / 1000).toFixed(1)} s`);
    process.exitCode = code;
    setTimeout(() => process.exit(code), 2000).unref();
  })
  .catch((e) => {
    console.error('selftest crashed:', e);
    process.exit(1);
  });
