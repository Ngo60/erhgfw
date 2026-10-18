// E2E в реальном Chrome: собранное расширение + мок ChatGPT (https://chatgpt.com → localhost) + реальная сборка сайта с мостом.
// Запуск: npm run build && SITE_DIST=<путь к dist сайта с мостом> npm run test:e2e
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { after, before } from 'node:test';
import { fileURLToPath } from 'node:url';
import { closeBrowser, isPng, killServiceWorker, launch, makeDirs, readJsonl, relFiles, until } from './lib/harness.mjs';
import { makeCerts } from './mock/certs.mjs';
import { startMockChatGpt } from './mock/chatgpt-server.mjs';
import { startStaticSite } from './mock/site-server.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const EXT = join(ROOT, 'dist/chrome-unpacked');
const SITE_DIST = process.env.SITE_DIST ?? '';
const DEBUG_PORT = 9333 + Math.floor(Math.random() * 500);
const E = {};

const PARAMS = { mode: 'single', characters: 1, frames_per_character: 2, strategy: 'character', preset_id: null, seed: null, profile: 'gpt-image', length: 'standard', include_negative: true, use_site_character: false };
const send = (msg) => E.panel.evaluate((m) => chrome.runtime.sendMessage({ rps: 1, ...m }), msg);
async function must(msg) {
  const r = await send(msg);
  assert.ok(r?.ok, `${msg.type}: ${JSON.stringify(r?.error ?? r)}`);
  return r;
}
const view = async () => (await must({ type: 'GET_VIEW' })).view;
const waitView = (pred, label, timeout = 120000) => until(async () => { const v = await view(); return pred(v) ? v : null; }, { label, timeout, step: 400 });
const done = (v) => v.runner.state === 'completed' && v.batch?.status === 'completed' && v.runner.batch_id === v.batch.batch_id;
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const imgs = (folder) => relFiles(E.dirs.downloads).filter((f) => f.startsWith(`ChatGPT-Images/${folder}/`) && /\.(png|jpg|webp)$/.test(f));
const sends = () => E.chat.getState().sends;

async function newBatch(over = {}) {
  const r = await must({ type: 'SITE_CREATE_BATCH', params: { ...PARAMS, ...over } });
  return r.summary;
}
async function runBatch(over = {}) {
  const s = await newBatch(over);
  await must({ type: 'START', batch_id: s.batch_id, confirm: { acknowledged: true } });
  return s;
}
/** Чистое состояние перед каждым сценарием: сбой одного теста не должен каскадом ломать остальные. */
async function clean() {
  const v = await view();
  if (v.runner.state !== 'idle' && v.runner.state !== 'completed') await send({ type: 'STOP' });
  E.chat.reset();
  E.chat.setToggles({ loggedOut: false, captcha: false, uiChanged: false, offline: false });
  E.chat.setScript([]);
  await must({ type: 'UPDATE_SETTINGS', patch: { newChatPerCharacter: true, multiImagePolicy: 'fail', intervalSec: 2, rotateChatEvery: 12 } });
  await reloadChat();
}

async function reloadChat() {
  await E.chatTab.goto('https://chatgpt.com/');
  await E.chatTab.waitForLoadState('load');
}

before(async () => {
  assert.ok(existsSync(join(EXT, 'manifest.json')), 'сначала выполните npm run build');
  assert.ok(SITE_DIST && existsSync(join(SITE_DIST, 'index.html')), 'задайте SITE_DIST — каталог dist собранного сайта с установленным мостом (см. .env.example)');
  E.dirs = makeDirs();
  E.certs = await makeCerts();
  E.chat = await startMockChatGpt({ certs: E.certs, defaults: { delayMs: 700 } });
  E.site = await startStaticSite({ dir: SITE_DIST, certs: E.certs });
  const opts = { ext: EXT, profile: E.dirs.profile, chatPort: E.chat.port, sitePort: E.site.port, debugPort: DEBUG_PORT };
  Object.assign(E, await launch(opts), { opts });
  E.chatTab = await E.ctx.newPage();
  await E.chatTab.goto('https://chatgpt.com/');
  E.siteTab = await E.ctx.newPage();
  await E.siteTab.goto('https://promts.vibecods.xyz/');
  E.panel = await E.ctx.newPage();
  await E.panel.goto(`chrome-extension://${E.extId}/sidepanel/index.html`);
  await must({ type: 'UPDATE_SETTINGS', patch: { intervalSec: 2 } });
});

after(async () => {
  await closeBrowser(E).catch(() => {});
  await E.chat?.stop().catch(() => {});
  await E.site?.stop().catch(() => {});
});

test('загрузка: манифест MV3, минимальные разрешения, мост сайта, диагностика ChatGPT', async () => {
  const m = await E.panel.evaluate(() => chrome.runtime.getManifest());
  assert.equal(m.manifest_version, 3);
  assert.deepEqual([...m.permissions].sort(), ['alarms', 'downloads', 'notifications', 'scripting', 'sidePanel', 'storage', 'unlimitedStorage']);
  assert.ok(m.host_permissions.every((h) => /^https:\/\/(chatgpt\.com|\*\.oaiusercontent\.com|promts\.vibecods\.xyz)\/\*$/.test(h)));
  const st = await until(async () => { const r = await must({ type: 'SITE_STATUS' }); return r.site.connected ? r.site : null; }, { label: 'мост сайта', timeout: 30000 });
  assert.equal(st.bridge_version, 1);
  assert.ok(st.limits.maxCharacters >= 50);
  const pr = await must({ type: 'SITE_LIST_PRESETS' });
  assert.ok(pr.presets.some((p) => p.id === 'natural-selfie'));
  const d = await must({ type: 'DIAGNOSE_CHATGPT' });
  assert.equal(d.report.ok, true, JSON.stringify(d.report));
  assert.ok(['composer', 'send'].every((n) => d.report.items.find((i) => i.name === n)?.found));
});

test('режим A через интерфейс панели: один персонаж × 3 кадра → файлы, метаданные, отправки', async () => {
  const p = E.panel;
  await p.reload();
  await p.getByTestId('mode-single').check();
  await p.getByTestId('input-frames').fill('3');
  await p.getByTestId('btn-create-batch').click();
  await until(async () => /3/.test(await p.getByTestId('batch-summary').innerText()), { label: 'сводка партии', timeout: 60000 });
  await p.getByTestId('btn-start').click();
  await until(async () => (await p.getByTestId('count-done').innerText()).trim() === '3', { label: '3 готовых кадра', timeout: 150000, step: 500 });
  const v = await waitView(done, 'партия завершена');
  const folder = v.batch.folder;
  assert.match(folder, /^Batch_\d{4}-\d{2}-\d{2}_\d{3}$/);
  const files = imgs(folder);
  assert.deepEqual(files.map((f) => f.split('/').slice(-2).join('/')), ['Character_001/001.png', 'Character_001/002.png', 'Character_001/003.png']);
  for (const f of files) assert.ok(isPng(join(E.dirs.downloads, f)), `${f} не PNG`);
  assert.equal(new Set(files.map((f) => sha(join(E.dirs.downloads, f)))).size, 3);
  const lines = readJsonl(join(E.dirs.downloads, `ChatGPT-Images/${folder}/Character_001/prompts.jsonl`));
  assert.equal(lines.length, 3);
  assert.ok(lines.every((l) => l.status === 'completed' && l.file.endsWith('.png') && /^[0-9a-f]{64}$/.test(l.sha256) && l.prompt.length > 200));
  const sent = sends().slice(-3);
  for (const [i, l] of lines.entries()) assert.ok(sent[i].text.includes(l.prompt), `кадр ${i + 1}: отправленный текст ≠ промпт сайта`);
  const manifest = JSON.parse(readFileSync(join(E.dirs.downloads, `ChatGPT-Images/${folder}/manifest.json`), 'utf8'));
  assert.deepEqual([manifest.totals.total, manifest.totals.completed], [3, 3]);
  const ch = JSON.parse(readFileSync(join(E.dirs.downloads, `ChatGPT-Images/${folder}/Character_001/character.json`), 'utf8'));
  assert.equal(ch.identity.core.age >= 20, true);
});

test('режим B: 2 персонажа × 2 кадра → отдельные папки и отдельные беседы', async () => {
  await clean();
  const before = Object.keys(E.chat.getState().conversations).length;
  await runBatch({ mode: 'multi', characters: 2, frames_per_character: 2 });
  const v = await waitView(done, 'партия 2×2');
  const files = imgs(v.batch.folder).map((f) => f.split('/').slice(-2).join('/'));
  assert.deepEqual(files, ['Character_001/001.png', 'Character_001/002.png', 'Character_002/001.png', 'Character_002/002.png']);
  assert.equal(Object.keys(E.chat.getState().conversations).length - before, 2, 'каждому персонажу — своя беседа');
});

test('лимит ChatGPT → остановка с уведомлением, без авто-повторов; после «Продолжить» — завершение', async () => {
  await clean();
  E.chat.setScript(['rate-limit']);
  const n0 = sends().length;
  await runBatch({ frames_per_character: 2 });
  const v = await waitView((x) => x.runner.state === 'blocked', 'блокировка по лимиту', 90000);
  assert.equal(v.runner.block.code, 'RATE_LIMIT');
  assert.equal(sends().length - n0, 1);
  await new Promise((r) => setTimeout(r, 8000));
  assert.equal(sends().length - n0, 1, 'лимит не обходится повторами');
  await must({ type: 'RESUME' });
  const f = await waitView(done, 'завершение после лимита');
  assert.equal(imgs(f.batch.folder).length, 2);
  assert.equal(sends().length - n0, 3);
});

test('нет авторизации → AUTH_REQUIRED; после входа продолжение', async () => {
  await clean();
  E.chat.setToggles({ loggedOut: true });
  await runBatch({ frames_per_character: 1 });
  const v = await waitView((x) => x.runner.state === 'blocked', 'блокировка AUTH', 90000);
  assert.equal(v.runner.block.code, 'AUTH_REQUIRED');
  E.chat.setToggles({ loggedOut: false });
  await must({ type: 'RESUME' });
  await waitView(done, 'завершение после входа');
});

test('CAPTCHA → остановка и сообщение; без обхода', async () => {
  await clean();
  E.chat.setToggles({ captcha: true });
  const n0 = sends().length;
  await runBatch({ frames_per_character: 1 });
  const v = await waitView((x) => x.runner.state === 'blocked', 'блокировка CAPTCHA', 90000);
  assert.equal(v.runner.block.code, 'CAPTCHA');
  assert.equal(sends().length, n0);
  E.chat.setToggles({ captcha: false });
  await must({ type: 'RESUME' });
  await waitView(done, 'завершение после CAPTCHA');
});

test('изменённая разметка ChatGPT → UI_CHANGED, кнопки не нажимаются', async () => {
  await clean();
  await must({ type: 'UPDATE_SETTINGS', patch: { newChatPerCharacter: false } });
  E.chat.setToggles({ uiChanged: true });
  await reloadChat();
  const n0 = sends().length;
  await runBatch({ frames_per_character: 1 });
  const v = await waitView((x) => x.runner.state === 'blocked', 'блокировка UI_CHANGED', 90000);
  assert.equal(v.runner.block.code, 'UI_CHANGED');
  assert.equal(sends().length, n0);
  const d = await must({ type: 'DIAGNOSE_CHATGPT' });
  assert.equal(d.report.ok, false);
  E.chat.setToggles({ uiChanged: false });
  await reloadChat();
  await must({ type: 'UPDATE_SETTINGS', patch: { newChatPerCharacter: true } });
  await must({ type: 'RESUME' });
  await waitView(done, 'завершение после восстановления разметки');
});

test('два изображения вместо одного → ошибка задания; смена политики и «Повторить ошибки» без новой генерации', async () => {
  await clean();
  E.chat.setScript(['two-images']);
  const n0 = sends().length;
  await runBatch({ frames_per_character: 2 });
  const v = await waitView(done, 'партия с двумя изображениями');
  assert.deepEqual(v.batch.characters[0].jobs.map((j) => j.status), ['failed', 'completed']);
  assert.equal(v.batch.characters[0].jobs[0].error_code, 'MULTIPLE_IMAGES');
  await must({ type: 'UPDATE_SETTINGS', patch: { multiImagePolicy: 'first' } });
  await must({ type: 'RETRY_FAILED', batch_id: v.batch.batch_id });
  const f = await waitView(done, 'повторная загрузка');
  assert.deepEqual(f.batch.characters[0].jobs.map((j) => j.status), ['completed', 'completed']);
  assert.equal(sends().length - n0, 2, 'повторная загрузка без повторной генерации');
  assert.equal(imgs(f.batch.folder).length, 2);
  await must({ type: 'UPDATE_SETTINGS', patch: { multiImagePolicy: 'fail' } });
});

test('выгрузка service worker посреди генерации → продолжение без дублей', async () => {
  await clean();
  const n0 = sends().length;
  await runBatch({ frames_per_character: 3 });
  await waitView((x) => x.batch?.characters[0].jobs[0].status === 'completed' && x.runner.state === 'waiting', 'первый кадр готов, второй ждёт', 90000);
  assert.ok((await killServiceWorker(DEBUG_PORT, E.extId)) >= 1);
  const v = await waitView(done, 'партия после выгрузки SW', 150000);
  assert.equal(sends().length - n0, 3, 'ни один промпт не отправлен дважды');
  assert.equal(imgs(v.batch.folder).length, 3);
});

test('закрытие панели не останавливает очередь', async () => {
  await clean();
  const n0 = sends().length;
  await runBatch({ frames_per_character: 3 });
  await waitView((x) => x.runner.state === 'waiting', 'ожидание изображения', 60000);
  await E.panel.close();
  await new Promise((r) => setTimeout(r, 15000));
  E.panel = await E.ctx.newPage();
  await E.panel.goto(`chrome-extension://${E.extId}/sidepanel/index.html`);
  const v = await waitView(done, 'партия завершена без открытой панели', 150000);
  assert.equal(sends().length - n0, 3);
  assert.equal(imgs(v.batch.folder).length, 3);
});

test('перезапуск Chrome (тот же профиль): состояние сохранено; после «Продолжить» без дублей', async () => {
  await clean();
  const n0 = sends().length;
  await runBatch({ frames_per_character: 3 });
  await waitView((x) => x.batch?.characters[0].jobs[0].status === 'completed' && x.runner.state === 'waiting', 'второй кадр ждёт', 90000);
  await closeBrowser(E);
  Object.assign(E, await launch(E.opts));
  E.chatTab = await E.ctx.newPage();
  await E.chatTab.goto('https://chatgpt.com/');
  E.siteTab = await E.ctx.newPage();
  await E.siteTab.goto('https://promts.vibecods.xyz/');
  E.panel = await E.ctx.newPage();
  await E.panel.goto(`chrome-extension://${E.extId}/sidepanel/index.html`);
  let v = await view();
  assert.ok(v.batch, 'партия сохранилась после перезапуска');
  if (['paused', 'blocked', 'idle'].includes(v.runner.state)) await must({ type: 'RESUME' });
  v = await waitView(done, 'партия завершена после перезапуска', 180000);
  assert.equal(sends().length - n0, 3, 'после перезапуска нет повторных отправок');
  assert.equal(imgs(v.batch.folder).length, 3);
});
