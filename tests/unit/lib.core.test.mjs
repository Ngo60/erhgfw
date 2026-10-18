import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkBundles, checkManifest } from '../../scripts/lib/manifest-check.mjs';
import { makeZip, readZip } from '../../scripts/lib/zip.mjs';
import { ERR, RUNNER_STATE } from '../../source/extension/src/lib/constants.js';
import { IllegalTransition, TRANSITIONS, assertTransition, canTransition } from '../../source/extension/src/lib/fsm.js';
import { sha256Hex, sniffImage } from '../../source/extension/src/lib/image.js';
import { csvCell, dataUrl, logToCsv, logToJson } from '../../source/extension/src/lib/metadata.js';
import { cleanCreateParams, validateCsMessage, validatePanelMessage } from '../../source/extension/src/lib/messages.js';
import { EXT_BY_FORMAT, batchFolderName, characterFolderName, imageFileName, imagePath, localDateStamp, pad, safeSegment, sanitizeRoot } from '../../source/extension/src/lib/naming.js';
import { backoffMs, networkBackoffMs } from '../../source/extension/src/lib/retry.js';
import { fakePng } from './helpers/fakes.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

test('naming: безопасные сегменты и папка-корень', () => {
  assert.equal(safeSegment('Персонаж №1: тест*?'), '1');
  assert.match(safeSegment('a/b\\c:d*e?f"g<h>i|j'), /^[A-Za-z0-9._-]+$/);
  assert.equal(safeSegment('CON'), '_CON');
  assert.equal(safeSegment('com1.txt'), '_com1.txt');
  assert.equal(safeSegment('...'), 'item');
  assert.equal(safeSegment('x'.repeat(200)).length, 64);
  assert.equal(sanitizeRoot('../../Windows/System32'), 'Windows/System32');
  assert.equal(sanitizeRoot('C:\\Users\\me\\Pics'), 'C/Users/me/Pics');
  assert.equal(sanitizeRoot('   '), 'ChatGPT-Images');
  assert.equal(sanitizeRoot('/abs/path/'), 'abs/path');
  assert.equal(sanitizeRoot('a/b/c/d/e/f').split('/').length, 4);
  assert.equal(sanitizeRoot('nul/aux'), '_nul/_aux');
});

test('naming: детерминированные пути без коллизий', () => {
  assert.equal(pad(7), '007');
  assert.equal(pad(1234), '1234');
  assert.equal(batchFolderName('2026-10-18', 1), 'Batch_2026-10-18_001');
  assert.equal(batchFolderName('2026-10-18', 12, 'test'), 'Test_2026-10-18_012');
  assert.equal(characterFolderName(3), 'Character_003');
  assert.equal(imageFileName(2, 'jpeg'), '002.jpg');
  assert.equal(imageFileName(2, 'png', 2), '002_2.png');
  assert.throws(() => imageFileName(1, 'bmp'));
  assert.deepEqual(Object.keys(EXT_BY_FORMAT).sort(), ['gif', 'jpeg', 'png', 'webp']);
  const seen = new Set();
  for (let c = 1; c <= 50; c++) for (let f = 1; f <= 30; f++) seen.add(imagePath({ root: 'ChatGPT-Images', batchFolder: 'Batch_2026-10-18_001', characterIndex: c, frameIndex: f, format: 'png' }));
  assert.equal(seen.size, 1500);
  assert.equal(imagePath({ root: '../x', batchFolder: 'B', characterIndex: 1, frameIndex: 1, format: 'webp' }), 'x/B/Character_001/001.webp');
  assert.match(localDateStamp(Date.parse('2026-10-18T12:00:00Z')), /^2026-10-1[78]$/);
});

test('image: формат и размеры по байтам, SHA-256', async () => {
  const png = sniffImage(fakePng(1024, 768, 3));
  assert.deepEqual(png, { format: 'png', mime: 'image/png', width: 1024, height: 768 });
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), Buffer.alloc(14), Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0x58, 0x03, 0x20, 0x03]), Buffer.alloc(9)]);
  assert.deepEqual(sniffImage(jpeg), { format: 'jpeg', mime: 'image/jpeg', width: 800, height: 600 });
  const riff = (kind, payload) => Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.from(kind), Buffer.alloc(4), payload]);
  const vp8l = Buffer.alloc(12);
  vp8l[0] = 0x2f;
  vp8l.writeUInt32LE((299 | (199 << 14)) >>> 0, 1);
  assert.deepEqual(sniffImage(riff('VP8L', vp8l)), { format: 'webp', mime: 'image/webp', width: 300, height: 200 });
  const vp8x = Buffer.alloc(14);
  vp8x.writeUIntLE(1023, 4, 3);
  vp8x.writeUIntLE(767, 7, 3);
  assert.deepEqual(sniffImage(riff('VP8X', vp8x)), { format: 'webp', mime: 'image/webp', width: 1024, height: 768 });
  const vp8 = Buffer.alloc(14);
  vp8.set([0x9d, 0x01, 0x2a], 3);
  vp8.writeUInt16LE(640, 6);
  vp8.writeUInt16LE(480, 8);
  assert.deepEqual(sniffImage(riff('VP8 ', vp8)), { format: 'webp', mime: 'image/webp', width: 640, height: 480 });
  const gif = Buffer.concat([Buffer.from('GIF89a'), Buffer.from([0x40, 0x01, 0xf0, 0x00]), Buffer.alloc(8)]);
  assert.deepEqual(sniffImage(gif), { format: 'gif', mime: 'image/gif', width: 320, height: 240 });
  assert.equal(sniffImage(Buffer.from('<html>login</html> padding padding')), null);
  assert.equal(sniffImage(Buffer.alloc(4)), null);
  assert.equal(sniffImage(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40)])), null);
  assert.equal(await sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(await sha256Hex(new TextEncoder().encode('abc')), createHash('sha256').update('abc').digest('hex'));
});

test('fsm: таблица переходов полна и допускает только объявленные переходы', () => {
  const states = Object.values(RUNNER_STATE);
  assert.deepEqual(Object.keys(TRANSITIONS).sort(), [...states].sort());
  for (const [from, list] of Object.entries(TRANSITIONS)) for (const to of list) assert.ok(states.includes(to), `${from} → ${to}`);
  for (const s of states) assert.ok(canTransition(s, 'idle'), `из ${s} можно остановить`);
  const reach = new Set(['idle']);
  for (let i = 0; i < 12; i++) for (const s of [...reach]) for (const t of TRANSITIONS[s]) reach.add(t);
  assert.equal(reach.size, states.length, 'все состояния достижимы');
  assert.throws(() => assertTransition('idle', 'waiting'), IllegalTransition);
  assert.throws(() => assertTransition('paused', 'completed'), IllegalTransition);
  assert.throws(() => assertTransition('blocked', 'waiting'), IllegalTransition);
  assert.doesNotThrow(() => assertTransition('completed', 'paused'));
  assert.doesNotThrow(() => assertTransition('verifying', 'completed'));
  assert.equal(canTransition('waiting', 'waiting'), true);
  assert.deepEqual(states, ['idle', 'preparing', 'submitting', 'waiting', 'downloading', 'verifying', 'completed', 'retryable_error', 'paused', 'blocked', 'failed']);
});

test('ошибки: у каждого кода есть класс и русский текст', () => {
  for (const [code, e] of Object.entries(ERR)) {
    assert.ok(['blocking', 'retry', 'network', 'permanent'].includes(e.kind), code);
    assert.ok(e.ru.length > 10, code);
  }
  for (const c of ['CAPTCHA', 'RATE_LIMIT', 'AUTH_REQUIRED', 'UI_CHANGED']) assert.equal(ERR[c].kind, 'blocking');
});

test('retry: нарастающие ограниченные задержки', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7].map((n) => backoffMs(n)), [15000, 30000, 60000, 120000, 240000, 300000, 300000]);
  assert.ok(networkBackoffMs(1) < networkBackoffMs(3) && networkBackoffMs(99) <= 120000);
});

test('messages: строгая проверка сообщений панели и content script', () => {
  assert.equal(validatePanelMessage({ rps: 1, type: 'GET_VIEW' }).ok, true);
  assert.equal(validatePanelMessage({ rps: 1, type: 'START', batch_id: 'RPS-abc', confirm: { acknowledged: true } }).ok, true);
  for (const bad of [null, 'x', { type: 'GET_VIEW' }, { rps: 2, type: 'GET_VIEW' }, { rps: 1, type: 'EVAL' }, { rps: 1, type: 'START' }, { rps: 1, type: 'START', batch_id: '../x' }, { rps: 1, type: 'EXPORT_LOG', batch_id: 'a', format: 'xml' }, { rps: 1, type: 'GET_EVENTS', batch_id: 'a', limit: 9999 }, { rps: 1, type: 'IMPORT_BATCH', text: 5, fileName: 'a' }, { rps: 1, type: 'constructor' }, { rps: 1, type: '__proto__' }])
    assert.equal(validatePanelMessage(bad).ok, false, JSON.stringify(bad));
  assert.equal(validateCsMessage({ rps: 1, type: 'CS_SUBMIT', jobId: 'a-1', text: 'hi', key: 'k', token: 't' }).ok, true);
  assert.equal(validateCsMessage({ rps: 1, type: 'CS_SUBMIT', jobId: 'a-1', text: 'x'.repeat(20001), key: 'k', token: 't' }).ok, false);
  assert.equal(validateCsMessage({ rps: 1, type: 'CS_WAIT', key: 'k', baseline: null, sliceMs: 100 }).ok, false);
  assert.equal(validateCsMessage({ rps: 1, type: 'CS_WAIT', key: 'k', baseline: null, sliceMs: 5000, usedKeys: ['a'] }).ok, true);
  assert.equal(validateCsMessage({ rps: 1, type: 'START' }).ok, false);
  const ok = { mode: 'multi', characters: 3, frames_per_character: 5, strategy: 'series', preset_id: '', seed: null, profile: 'gpt-image', length: 'standard' };
  assert.deepEqual(cleanCreateParams(ok), { mode: 'multi', characters: 3, frames_per_character: 5, strategy: 'series', preset_id: null, seed: null, profile: 'gpt-image', length: 'standard', include_negative: true, use_site_character: false });
  assert.equal(cleanCreateParams({ ...ok, seed: 'bad seed!' }), null);
  assert.equal(cleanCreateParams({ ...ok, mode: 'x' }), null);
  assert.equal(cleanCreateParams({ ...ok, evil: 1 }).evil, undefined);
});

test('metadata: CSV без формул, JSON-журнал, data: URL', () => {
  assert.equal(csvCell('=SUM(A1)'), "'=SUM(A1)");
  assert.equal(csvCell('+1'), "'+1");
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell(null), '');
  const events = [{ seq: 1, ts: '2026-10-18T00:00:00Z', level: 'info', state: 'idle', job_id: 'j', code: 'X', message: '=cmd|calc' }];
  const csv = logToCsv(events);
  assert.ok(csv.startsWith('\uFEFFseq,ts,level,state,job_id,code,message\r\n'));
  assert.ok(csv.includes("'=cmd|calc"));
  assert.equal(JSON.parse(logToJson(events, 'B1')).events.length, 1);
  const u = dataUrl('{"a":"Привет"}');
  assert.equal(decodeURIComponent(u.slice(u.indexOf(',') + 1)), '{"a":"Привет"}');
  assert.equal(localDateStamp(0).length, 10);
});

test('zip: детерминированный ZIP читается обратно', () => {
  const files = [
    { path: 'b/two.txt', data: Buffer.from('второй файл '.repeat(50)) },
    { path: 'a/one.json', data: Buffer.from('{"x":1}') },
    { path: 'empty.bin', data: Buffer.alloc(0) },
  ];
  const a = makeZip(files);
  const b = makeZip([...files].reverse());
  assert.ok(a.equals(b), 'порядок входа не влияет на результат');
  const back = readZip(a);
  assert.deepEqual([...back.keys()], ['a/one.json', 'b/two.txt', 'empty.bin']);
  assert.equal(back.get('a/one.json').toString(), '{"x":1}');
  assert.equal(back.get('empty.bin').length, 0);
});

test('manifest-check: проверка на реальном манифесте и негативные случаи', () => {
  const dist = `${ROOT}dist/chrome-unpacked`;
  const manifest = JSON.parse(readFileSync(`${ROOT}source/extension/manifest.json`, 'utf8'));
  const pkg = JSON.parse(readFileSync(`${ROOT}package.json`, 'utf8'));
  assert.equal(manifest.version, pkg.version);
  if (existsSync(dist)) {
    assert.deepEqual(checkManifest(manifest, dist, pkg.version), []);
    assert.deepEqual(checkBundles(dist), []);
  }
  const base = { ...manifest };
  const errs = (patch) => checkManifest({ ...base, ...patch }, existsSync(dist) ? dist : ROOT, pkg.version);
  assert.ok(errs({ permissions: [...manifest.permissions, 'tabs'] }).some((e) => e.includes('tabs')));
  assert.ok(errs({ host_permissions: ['<all_urls>'] }).some((e) => e.includes('<all_urls>')));
  assert.ok(errs({ host_permissions: ['http://*/*'] }).length > 0);
  assert.ok(errs({ manifest_version: 2 }).length > 0);
  assert.ok(errs({ externally_connectable: { matches: ['*://*/*'] } }).some((e) => e.includes('externally_connectable')));
  assert.ok(errs({ content_security_policy: { extension_pages: "script-src 'self' 'unsafe-eval'" } }).some((e) => e.includes('CSP')));
  assert.ok(errs({ content_security_policy: { extension_pages: "script-src 'self' https://cdn.example.com" } }).some((e) => e.includes('CSP')));
});

test('иконки: валидные PNG нужных размеров', () => {
  for (const s of [16, 32, 48, 128]) {
    const buf = readFileSync(`${ROOT}source/extension/icons/icon${s}.png`);
    const info = sniffImage(buf);
    assert.deepEqual([info.format, info.width, info.height], ['png', s, s]);
  }
});
