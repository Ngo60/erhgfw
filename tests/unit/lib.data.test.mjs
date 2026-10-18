import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { analyzeSnapshot, decideWait, findUserTurn } from '../../source/extension/src/lib/chatgpt-classify.js';
import { Store, defaultRunner } from '../../source/extension/src/lib/store.js';
import { canonicalJson, isAllowedImageUrl, isChatGptUrl, parseBatch, parseImport, sanitizeSettings } from '../../source/extension/src/lib/validate.js';
import { composePrompt, promptKey } from '../../source/extension/src/lib/prompt.js';
import { sha256Hex } from '../../source/extension/src/lib/image.js';
import { FakeArea, loadFixture } from './helpers/fakes.mjs';

const fx = (n) => JSON.parse(loadFixture(n));
const clone = (v) => JSON.parse(JSON.stringify(v));

test('parseBatch: принимает реальную партию, собранную движком сайта (контрактная фикстура)', async () => {
  const r = await parseBatch(fx('bridge-batch-2x3.json'));
  assert.ok(r.ok, JSON.stringify(r.errors));
  assert.equal(r.batch.characters.length, 2);
  assert.equal(r.batch.characters[0].jobs.length, 3);
  assert.match(r.batch.batch_id, /^RPS-[0-9a-f]{10}$/);
  assert.equal(r.batch.characters[0].identity.fingerprint, await sha256Hex(canonicalJson(r.batch.characters[0].identity.core)));
  assert.notEqual(canonicalJson(r.batch.characters[0].identity.core), canonicalJson(r.batch.characters[1].identity.core));
});

test('parseBatch: отклоняет подделку и некорректные данные', async () => {
  const good = fx('bridge-batch-2x3.json');
  const bad = async (mutate, re) => {
    const b = clone(good);
    mutate(b);
    const r = await parseBatch(b);
    assert.equal(r.ok, false, `должно быть отклонено: ${re}`);
    assert.match(r.errors.join(' | '), re);
  };
  await bad((b) => (b.schema = 'x'), /schema/);
  await bad((b) => (b.batch_id = '../evil'), /batch_id/);
  await bad((b) => (b.characters[0].identity.core.age += 1), /fingerprint|возраст/);
  await bad((b) => (b.characters[0].identity.fingerprint = '0'.repeat(64)), /fingerprint/);
  await bad((b) => (b.characters[0].jobs[0].prompt = 'short'), /prompt/);
  await bad((b) => (b.characters[0].jobs[0].prompt = `${b.characters[0].jobs[0].prompt}\u0007`), /prompt/);
  await bad((b) => (b.characters[0].jobs[1].image_job_id = b.characters[0].jobs[0].image_job_id), /image_job_id/);
  await bad((b) => (b.characters[0].jobs[0].image_job_id = b.characters[1].jobs[0].image_job_id), /image_job_id/);
  await bad((b) => (b.characters[0].jobs[2].index = 7), /index/);
  await bad((b) => (b.characters[0].jobs[0].reference = { file: 'x.png' }), /reference/);
  await bad((b) => (b.characters[1].jobs[0].prompt = b.characters[1].jobs[0].prompt.replace(/\d+ years old/, '99 years old')), /возраст|смешивани/);
  await bad((b) => (b.source.kind = 'weird'), /source.kind/);
  await bad((b) => (b.characters = []), /characters/);
  await bad((b) => delete b.characters[0].identity, /identity|core/);
  const r = await parseBatch(good, { maxJobs: 5 });
  assert.equal(r.ok, false);
  assert.match(r.errors.join(' '), /лимит/);
});

test('parseBatch: лишние поля отбрасываются (в т.ч. __proto__)', async () => {
  const b = clone(good());
  b.evil = { polluted: true };
  b.characters[0].jobs[0].exec = 'rm -rf /';
  b.characters[0].jobs[0].params = JSON.parse('{"__proto__":{"x":1},"scene_id":"a","bad key":1,"n":2}');
  const r = await parseBatch(b);
  assert.ok(r.ok);
  assert.equal(r.batch.evil, undefined);
  assert.equal(r.batch.characters[0].jobs[0].exec, undefined);
  assert.deepEqual(Object.keys(r.batch.characters[0].jobs[0].params).sort(), ['n', 'scene_id']);
  assert.equal({}.x, undefined);
  function good() {
    return fx('bridge-batch-2x3.json');
  }
});

test('parseImport: экспорт сайта JSON → группа по персонажу с ядром внешности', async () => {
  const text = loadFixture('site-export-3.json');
  const r = await parseImport(text, 'batch.json', 1792000000000);
  assert.ok(r.ok, JSON.stringify(r.errors));
  assert.equal(r.batch.source.kind, 'import');
  assert.equal(r.batch.characters.length, 1);
  assert.equal(r.batch.characters[0].jobs.length, 3);
  assert.ok(r.batch.characters[0].identity.core.age >= 20);
  assert.match(r.batch.characters[0].jobs[0].negative ?? '', /plastic|Avoid|skin/i);
  assert.equal(r.batch.characters[0].jobs[0].params.scene_id.length > 3, true);
  const again = await parseImport(text, 'другое-имя.json', 1792999999999);
  assert.equal(again.batch.batch_id, r.batch.batch_id, 'идемпотентный id по содержимому файла');
  assert.match(r.batch.batch_id, /^IMP-[0-9a-f]{10}$/);
});

test('parseImport: одиночный экспорт, TXT сайта, JSONL, список строк, партия rps-batch/1', async () => {
  const single = await parseImport(loadFixture('site-single.json'), 's.json');
  assert.ok(single.ok);
  assert.equal(single.batch.characters[0].jobs.length, 1);
  const txt = await parseImport(loadFixture('site-export-3.txt'), 'e.txt');
  assert.ok(txt.ok, JSON.stringify(txt.errors));
  assert.equal(txt.batch.characters[0].jobs.length, 3);
  assert.ok(txt.batch.characters[0].jobs.every((j) => j.prompt.startsWith('A photorealistic') && !j.prompt.includes('Seed:')));
  assert.equal(txt.batch.characters[0].identity.core, null);
  assert.match(txt.batch.characters[0].notes.join(' '), /не проверяется/);
  const jsonl = await parseImport('{"prompt":"A fictional adult woman, 30 years old, reading a book in a quiet cafe","character":"Анна"}\n{"prompt":"A fictional adult woman, 30 years old, walking in a park at sunrise","character":"Анна"}\n{"prompt":"Another fictional adult woman, 41 years old, cooking at home in the evening","character":"Мария"}', 'q.jsonl');
  assert.ok(jsonl.ok, JSON.stringify(jsonl.errors));
  assert.deepEqual(jsonl.batch.characters.map((c) => [c.name, c.jobs.length]), [['Анна', 2], ['Мария', 1]]);
  const lines = await parseImport('A fictional adult woman standing on a balcony at dusk with a cup of tea\nA fictional adult woman riding a bicycle along the river bank in summer', 'l.txt');
  assert.equal(lines.batch.characters[0].jobs.length, 2);
  const arr = await parseImport(JSON.stringify(['A fictional adult woman reading on a bench in autumn park, wearing a coat']), 'a.json');
  assert.ok(arr.ok);
  const native = await parseImport(JSON.stringify(fx('bridge-batch-2x3.json')), 'native.json');
  assert.ok(native.ok);
  assert.equal(native.batch.source.kind, 'import');
});

test('parseImport: пустые, слишком большие и повреждённые файлы отклоняются', async () => {
  assert.equal((await parseImport('', 'a.txt')).ok, false);
  assert.equal((await parseImport('   \n  ', 'a.txt')).ok, false);
  assert.equal((await parseImport('{"unknown":true}', 'a.json')).ok, false);
  assert.equal((await parseImport('x'.repeat(16 * 1024 * 1024), 'a.txt')).ok, false);
  assert.equal((await parseImport('{"prompt": broken}\n{"prompt":"x"}', 'a.jsonl')).ok, false);
  const tooShort = await parseImport('hi', 'a.txt');
  assert.equal(tooShort.ok, false);
  const r = await parseImport(fixtureWithManyLines(1600), 'big.txt');
  assert.equal(r.ok, false);
  function fixtureWithManyLines(n) {
    return Array.from({ length: n }, (_, i) => `A fictional adult woman number ${i} walking along a quiet street at sunrise`).join('\n');
  }
});

test('настройки и адреса: проверка диапазонов, allow-list URL', () => {
  const base = sanitizeSettings({});
  assert.equal(base.ok, true);
  assert.equal(sanitizeSettings({ intervalSec: 2 }).settings.intervalSec, 2);
  assert.equal(sanitizeSettings({ intervalSec: 121 }).ok, false);
  assert.equal(sanitizeSettings({ maxAttempts: 0 }).ok, false);
  assert.equal(sanitizeSettings({ rotateChatEvery: 0 }).ok, true);
  assert.equal(sanitizeSettings({ promptPrefix: 'x'.repeat(501) }).ok, false);
  assert.equal(sanitizeSettings({ promptPrefix: 'a\u0000b' }).ok, false);
  assert.equal(sanitizeSettings({ notifications: 'yes' }).ok, false);
  assert.equal(sanitizeSettings({ strongConfirmThreshold: 10, confirmThreshold: 50 }).ok, false);
  assert.equal(sanitizeSettings({ unknown: 1 }).ok, true);
  assert.equal(isChatGptUrl('https://chatgpt.com/'), true);
  assert.equal(isChatGptUrl('https://chatgpt.com/c/abc'), true);
  for (const u of ['http://chatgpt.com/', 'https://chatgpt.com.evil.com/', 'https://evil.com/chatgpt.com/', 'https://u:p@chatgpt.com/', 'https://chatgpt.com:8443/', 'javascript:alert(1)', 'not a url']) assert.equal(isChatGptUrl(u), false, u);
  assert.equal(isAllowedImageUrl('https://chatgpt.com/backend-api/estuary/content?id=file_1'), true);
  assert.equal(isAllowedImageUrl('https://files.oaiusercontent.com/file-abc'), true);
  for (const u of ['http://chatgpt.com/x.png', 'https://evil.com/x.png', 'https://oaiusercontent.com.evil.com/x', 'file:///etc/passwd', 'data:image/png;base64,AAAA', 'https://169.254.169.254/latest/meta-data/']) assert.equal(isAllowedImageUrl(u), false, u);
});

test('prompt: сборка текста с префиксом и ключ поиска', () => {
  const job = { prompt: 'A fictional adult woman, 30 years old, reading.', negative: 'plastic skin, watermarks' };
  assert.equal(composePrompt(job, { promptPrefix: 'P: ', promptSuffix: ' :S' }), 'P: A fictional adult woman, 30 years old, reading.\n\nAvoid: plastic skin, watermarks. :S');
  assert.equal(composePrompt({ ...job, prompt: `${job.prompt}\n\nAvoid: plastic skin, watermarks.` }, {}), `${job.prompt}\n\nAvoid: plastic skin, watermarks.`);
  assert.equal(composePrompt({ prompt: 'x'.repeat(30), negative: null }, { promptPrefix: '' }), 'x'.repeat(30));
  assert.equal(promptKey('  Hello\n\n  world  '.repeat(20)).length, 60);
});

test('store: атомарная запись, откат при сбое, журнал по чанкам, удаление партии', async () => {
  const area = new FakeArea();
  const st = new Store(area, { logChunkSize: 3, now: () => 1792000000000 });
  await st.load();
  const header = { batch_id: 'B1', characters: [{ job_ids: ['J1', 'J2'] }] };
  await st.commit({ batches: { B1: header }, jobs: { J1: { image_job_id: 'J1', status: 'pending' }, J2: { image_job_id: 'J2', status: 'pending' } }, runner: { ...defaultRunner(), state: 'preparing', batch_id: 'B1' }, events: [{ batch_id: 'B1', level: 'info', code: 'A', message: 'm1' }] });
  assert.equal(area.setCalls, 1, 'вся фиксация — одним set()');
  assert.equal(st.runner.rev, 1);
  area.failNextSet = true;
  await assert.rejects(st.commit({ runner: { ...st.runner, state: 'waiting' }, jobs: { J1: { image_job_id: 'J1', status: 'waiting' } } }));
  assert.equal(st.runner.state, 'preparing', 'кэш не изменился после сбоя записи');
  assert.equal(st.getJob('J1').status, 'pending');
  for (let i = 2; i <= 8; i++) await st.commit({ events: [{ batch_id: 'B1', level: 'info', code: 'E', message: `m${i}` }] });
  const events = st.events('B1', 100);
  assert.deepEqual(events.map((e) => e.seq), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(Object.keys(area.data).filter((k) => k.startsWith('rps:log:B1:')).length, 3);
  const st2 = new Store(area, { logChunkSize: 3 });
  await st2.load();
  assert.equal(st2.runner.state, 'preparing');
  assert.deepEqual(st2.events('B1', 100).map((e) => e.seq), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(st2.jobsOf('B1').map((j) => j.image_job_id), ['J1', 'J2']);
  assert.deepEqual(st2.events('B1', 2).map((e) => e.seq), [7, 8]);
  await st2.commit({ removeBatch: 'B1' });
  assert.equal(Object.keys(area.data).filter((k) => k.includes('B1') || k.includes('J1')).length, 0);
  const c = [];
  await Promise.all([1, 2, 3, 4, 5].map((n) => st2.commit({ meta: { ...st2.meta, n } }).then(() => c.push(n))));
  assert.deepEqual(c, [1, 2, 3, 4, 5], 'записи выполняются строго по порядку');
});

const turn = (i, role, text = '', images = []) => ({ i, role, text, images });
const img = (key, w = 1024, h = 1024, complete = true) => ({ key, src: `https://chatgpt.com/backend-api/estuary/content?id=${key}`, alt: 'Generated image: x', w, h, complete });
const snap = (over = {}) => ({ t: 0, url: 'https://chatgpt.com/c/1', online: true, hasComposer: true, hasSend: true, hasStop: false, loginUi: false, captchaUi: false, captchaText: false, authUrl: false, turns: [], turnCount: 0, alerts: [], ...over });
const KEY = promptKey('Generate an image: A fictional adult woman, 30 years old, reading a book');

test('classify: блокировки — приоритет, область поиска текста лимитов', () => {
  const t = [turn(0, 'user', 'Generate an image: A fictional adult woman, 30 years old, reading a book in a cafe'), turn(1, 'assistant', "You've hit the free plan limit for image generations requests.")];
  assert.equal(analyzeSnapshot(snap({ turns: t, turnCount: 2 }), { key: KEY }).blocker.code, 'RATE_LIMIT');
  const old = [turn(0, 'user', "I want to know about the rate limit and too many requests please"), turn(1, 'assistant', "You've hit the free plan limit for image generations"), turn(2, 'user', 'Generate an image: A fictional adult woman, 30 years old, reading a book in a cafe'), turn(3, 'assistant', '', [img('a')])];
  assert.equal(analyzeSnapshot(snap({ turns: old, turnCount: 4 }), { key: KEY }).blocker, null, 'старые сообщения до отправленного промпта не считаются');
  const echo = [turn(0, 'user', 'Generate an image: A fictional adult woman, 30 years old, reading a book about rate limit and too many requests')];
  assert.equal(analyzeSnapshot(snap({ turns: echo, turnCount: 1 }), { key: KEY }).blocker, null, 'текст пользователя не сканируется');
  assert.equal(analyzeSnapshot(snap({ alerts: ['You have reached the usage cap'] })).blocker.code, 'RATE_LIMIT');
  assert.equal(analyzeSnapshot(snap({ captchaUi: true, loginUi: true })).blocker.code, 'CAPTCHA');
  assert.equal(analyzeSnapshot(snap({ loginUi: true })).blocker.code, 'AUTH_REQUIRED');
  assert.equal(analyzeSnapshot(snap({ authUrl: true })).blocker.code, 'AUTH_REQUIRED');
  assert.equal(analyzeSnapshot(snap({ hasComposer: false }), { requireUi: true }).blocker.code, 'UI_CHANGED');
  assert.equal(analyzeSnapshot(snap({ hasSend: false, hasStop: true }), { requireUi: true }).blocker, null);
  assert.equal(analyzeSnapshot(snap({ hasComposer: false })).blocker, null);
  assert.equal(analyzeSnapshot(snap({ online: false })).offline, true);
  const ru = analyzeSnapshot(snap({ alerts: ['Вы достигли лимита генерации изображений'] }));
  assert.equal(ru.blocker.code, 'RATE_LIMIT');
});

test('classify: изображения — базовые, использованные, превью и недозагруженные', () => {
  const t = [turn(0, 'user', 'Generate an image: A fictional adult woman, 30 years old, reading a book'), turn(1, 'assistant', '', [img('old'), img('new'), img('tiny', 120, 120), img('half', 0, 0, false)])];
  const a = analyzeSnapshot(snap({ turns: t, turnCount: 2 }), { key: KEY, baselineKeys: ['old'], minSide: 512 });
  assert.deepEqual(a.newImages.map((i) => i.key), ['new']);
  assert.deepEqual(a.smallImages.map((i) => i.key), ['tiny']);
  assert.equal(a.loadingImages, 1);
  const used = analyzeSnapshot(snap({ turns: t, turnCount: 2 }), { key: KEY, usedKeys: ['old', 'new'], minSide: 512 });
  assert.equal(used.newImages.length, 0);
  assert.equal(findUserTurn(snap({ turns: [turn(0, 'user', 'x'), turn(1, 'user', 'Generate an image: A fictional adult woman, 30 years old, reading a book 1'), turn(2, 'user', 'Generate an image: A fictional adult woman, 30 years old, reading a book 2')] }), KEY).i, 2);
  const noUser = analyzeSnapshot(snap({ turns: [turn(0, 'assistant', '', [img('z')])], turnCount: 1 }), { key: KEY });
  assert.equal(noUser.newImages.length, 0);
});

test('decideWait: готово только после стабильности; ошибки и блокировки; нет изображения', () => {
  const user = turn(0, 'user', 'Generate an image: A fictional adult woman, 30 years old, reading a book');
  const ctx = { key: KEY, minSide: 512 };
  const opts = { stableMs: 2500, noImageGraceMs: 6000, promptGraceMs: 15000 };
  const run = (steps, mk) => {
    let watch = {};
    const out = [];
    for (const [now, s] of steps) {
      const d = decideWait(mk(s), ctx, watch, now, opts);
      watch = d.watch;
      out.push(d.result.status + (d.result.code ? `:${d.result.code}` : ''));
    }
    return out;
  };
  const gen = (s) => snap({ hasStop: s === 'gen', hasSend: s !== 'gen', turns: s === 'gen' ? [user, turn(1, 'assistant', 'Creating image')] : [user, turn(1, 'assistant', '', [img('a')])], turnCount: 2 });
  assert.deepEqual(run([[0, 'gen'], [1000, 'gen'], [2000, 'done'], [3000, 'done'], [4500, 'done'], [5000, 'done']], gen), ['pending', 'pending', 'pending', 'pending', 'pending', 'done']);
  assert.deepEqual(run([[0, 'x']], () => snap({ turns: [user, turn(1, 'assistant', "I'm sorry, but I can't generate that image because it may violate our content policies.")], turnCount: 2 })), ['error:CONTENT_POLICY']);
  assert.deepEqual(run([[0, 'x']], () => snap({ turns: [user], turnCount: 1, alerts: ['Something went wrong. There was an error generating a response.'] })), ['error:GENERATION_ERROR']);
  assert.deepEqual(run([[0, 'x']], () => snap({ turns: [user, turn(1, 'assistant', "You've hit the free plan limit for image generations")], turnCount: 2 })), ['blocked']);
  assert.deepEqual(run([[0, 'x']], () => snap({ captchaUi: true })), ['blocked']);
  assert.deepEqual(run([[0, 'x']], () => snap({ online: false })), ['error:NETWORK']);
  const text = () => snap({ turns: [user, turn(1, 'assistant', 'Sure! Here is a long description of the scene you asked about.')], turnCount: 2 });
  assert.deepEqual(run([[0, 'x'], [3000, 'x'], [6500, 'x']], text), ['pending', 'pending', 'error:NO_IMAGE']);
  const small = () => snap({ turns: [user, turn(1, 'assistant', '', [img('s', 128, 128)])], turnCount: 2 });
  assert.deepEqual(run([[0, 'x'], [1000, 'x'], [3000, 'x']], small), ['pending', 'pending', 'error:PREVIEW_ONLY']);
  const missing = () => snap({ turns: [], turnCount: 0 });
  assert.deepEqual(run([[0, 'x'], [14000, 'x'], [16000, 'x']], missing), ['pending', 'pending', 'error:PROMPT_NOT_ACCEPTED']);
  const same = decideWait(gen('gen'), ctx, {}, 0, opts);
  assert.equal(same.result.phase, 'generating');
});
