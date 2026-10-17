import assert from 'node:assert/strict';
import test from 'node:test';
import { batchDone, flush, folderOf, makeBatch, quiet, restartWorker, runUntil, setup } from './helpers/fakes.mjs';

const ROOT = 'ChatGPT-Images';
const statuses = (env, id) => env.store.jobsOf(id).map((j) => j.status);
async function ready(frames = 3, settings = {}, characters = 1) {
  const env = await setup({ intervalSec: 2, ...settings });
  const batch = await makeBatch({ characters, frames });
  await env.orch.addBatch(batch);
  return { env, batch, id: batch.batch_id };
}

test('выгрузка service worker после отправки: очередь продолжается без повторной отправки', async () => {
  const { env, id } = await ready(3);
  await env.orch.start(id);
  assert.ok(await runUntil(env, () => env.page.sent.length === 2 && env.store.runner.state === 'waiting'));
  const env2 = restartWorker(env);
  await env2.orch.init({ reason: 'wake' });
  assert.equal(env2.store.runner.state, 'waiting');
  assert.ok(await runUntil(env2, batchDone(env2, id)));
  assert.equal(env2.page.sent.length, 3, 'ни один промпт не отправлен дважды');
  assert.ok(env2.store.jobsOf(id).every((j) => j.status === 'completed' && j.attempts === 1));
});

test('выгрузка во время отправки: промпт не дублируется, изображения разные', async () => {
  const { env, id } = await ready(2);
  await env.orch.start(id);
  assert.ok(await runUntil(env, () => env.store.runner.state === 'submitting' || env.page.sent.length === 1));
  const env2 = restartWorker(env);
  await env2.orch.init({ reason: 'wake' });
  assert.ok(await runUntil(env2, batchDone(env2, id)));
  const completed = env2.store.jobsOf(id).filter((j) => j.status === 'completed');
  assert.equal(completed.length, 2);
  assert.equal(new Set(completed.map((j) => j.result.sha256)).size, 2);
});

test('перезапуск браузера: пауза, ничего не стартует само; «Продолжить» без дублей', async () => {
  const { env, id } = await ready(3);
  await env.orch.start(id);
  await runUntil(env, () => env.page.sent.length === 2 && env.store.runner.state === 'waiting');
  const env2 = restartWorker(env);
  await env2.orch.init({ reason: 'browser-startup' });
  assert.equal(env2.store.runner.state, 'paused');
  assert.equal(env2.store.runner.halted, 'BROWSER_RESTART');
  assert.ok(env2.notes.some((n) => n[0] === 'paused'));
  const sentBefore = env2.page.sent.length;
  await runUntil(env2, () => false, { maxVirtualMs: 3600e3, maxIter: 3000 });
  assert.equal(env2.page.sent.length, sentBefore, 'без действия пользователя автоматизация не возобновляется');
  await env2.orch.resume();
  assert.ok(await runUntil(env2, batchDone(env2, id)));
  assert.equal(env2.page.sent.length, 3);
});

test('закрытие вкладки ChatGPT: остановка с причиной; после открытия — без повторной отправки', async () => {
  const { env, id } = await ready(2);
  await env.orch.start(id);
  await runUntil(env, () => env.page.sent.length === 1 && env.store.runner.state === 'waiting');
  env.page.closeTab();
  assert.ok(await runUntil(env, quiet(env, 'blocked')));
  assert.equal(env.store.runner.block.code, 'TAB_CLOSED');
  assert.ok(env.notes.some((n) => n[0] === 'blocked'));
  env.page.reopenTab();
  await env.orch.resume();
  assert.ok(await runUntil(env, batchDone(env, id)));
  assert.equal(env.page.sent.length, 2, 'уже отправленный промпт не отправлен повторно');
});

test('вкладка не найдена при старте → blocked TAB_NOT_FOUND; после открытия — продолжение', async () => {
  const { env, id } = await ready(1);
  env.page.closeTab();
  await env.orch.start(id);
  assert.ok(await runUntil(env, quiet(env, 'blocked')));
  assert.equal(env.store.runner.block.code, 'TAB_NOT_FOUND');
  env.page.reopenTab();
  await env.orch.resume();
  assert.ok(await runUntil(env, batchDone(env, id)));
});

test('потеря сети: ожидание без расхода попыток и продолжение после восстановления', async () => {
  const { env, id } = await ready(2);
  env.page.online = false;
  await env.orch.start(id);
  assert.ok(await runUntil(env, quiet(env, 'retryable_error')));
  assert.equal(env.store.runner.block, null);
  await runUntil(env, () => false, { maxVirtualMs: 200e3, maxIter: 4000 });
  assert.notEqual(env.store.runner.state, 'blocked');
  env.page.online = true;
  assert.ok(await runUntil(env, batchDone(env, id)));
  assert.ok(env.store.jobsOf(id).every((j) => j.attempts === 1 && j.status === 'completed'));
});

test('долгая потеря сети → blocked OFFLINE', async () => {
  const { env, id } = await ready(1, { networkGiveUpSec: 60 });
  env.page.online = false;
  await env.orch.start(id);
  assert.ok(await runUntil(env, quiet(env, 'blocked'), { maxVirtualMs: 3600e3 }));
  assert.equal(env.store.runner.block.code, 'OFFLINE');
  env.page.online = true;
  await env.orch.resume();
  assert.ok(await runUntil(env, batchDone(env, id)));
});

test('нет авторизации → blocked AUTH_REQUIRED, после входа продолжение', async () => {
  const { env, id } = await ready(2);
  env.page.loggedIn = false;
  await env.orch.start(id);
  assert.ok(await runUntil(env, quiet(env, 'blocked')));
  assert.equal(env.store.runner.block.code, 'AUTH_REQUIRED');
  assert.equal(env.page.sent.length, 0);
  env.page.loggedIn = true;
  await env.orch.resume();
  assert.ok(await runUntil(env, batchDone(env, id)));
});

test('изменённый DOM (не найдены поле ввода/кнопки) → blocked UI_CHANGED, ничего не нажимается', async () => {
  const { env, id } = await ready(1);
  env.page.uiChanged = true;
  await env.orch.start(id);
  assert.ok(await runUntil(env, quiet(env, 'blocked')));
  assert.equal(env.store.runner.block.code, 'UI_CHANGED');
  assert.equal(env.page.sent.length, 0);
});

test('CAPTCHA → остановка и уведомление, без повторов и обхода', async () => {
  const { env, id } = await ready(2);
  env.page.captcha = true;
  await env.orch.start(id);
  assert.ok(await runUntil(env, quiet(env, 'blocked')));
  assert.equal(env.store.runner.block.code, 'CAPTCHA');
  assert.match(env.store.runner.block.message, /CAPTCHA/);
  await runUntil(env, () => false, { maxVirtualMs: 3600e3, maxIter: 3000 });
  assert.equal(env.page.sent.length, 0);
  assert.ok(env.notes.length >= 1);
});

test('лимит сервиса после отправки → blocked RATE_LIMIT, авто-повторов нет, попытка не расходуется', async () => {
  const { env, id } = await ready(2);
  env.page.setScript(['rate-limit']);
  await env.orch.start(id);
  assert.ok(await runUntil(env, quiet(env, 'blocked')));
  assert.equal(env.store.runner.block.code, 'RATE_LIMIT');
  assert.equal(env.page.sent.length, 1);
  await runUntil(env, () => false, { maxVirtualMs: 6 * 3600e3, maxIter: 5000 });
  assert.equal(env.page.sent.length, 1, 'лимит не «пробивается» повторами');
  const job = env.store.jobsOf(id)[0];
  assert.equal(job.status, 'pending');
  assert.equal(job.attempts, 0);
  env.page.cur.turns = env.page.cur.turns.filter((t) => t.role === 'user');
  await env.orch.resume();
  assert.ok(await runUntil(env, batchDone(env, id)));
  assert.equal(statuses(env, id).every((s) => s === 'completed'), true);
});

test('ошибка загрузки: повтор скачивания без повторной генерации; имя файла то же, без «(1)»', async () => {
  const { env, id } = await ready(2);
  env.downloads.failures = ['interrupt'];
  await env.orch.start(id);
  assert.ok(await runUntil(env, batchDone(env, id)));
  assert.equal(env.page.sent.length, 2, 'генерация не повторялась');
  const j = env.store.jobsOf(id)[0];
  assert.equal(j.status, 'completed');
  assert.equal(j.attempts, 1);
  const folder = folderOf(env, id);
  const f = env.downloads.files.get(`${ROOT}/${folder}/Character_001/001.png`);
  assert.equal(f.writes, 1);
  assert.ok(env.downloads.calls.filter((c) => c.filename.endsWith('.png')).every((c) => c.conflictAction === 'overwrite'));
  assert.equal(env.downloads.list(`${ROOT}/${folder}/Character_001/`).filter((n) => /\(\d+\)/.test(n)).length, 0);
});

test('несовпадение размера файла → SIZE_MISMATCH → повтор скачивания', async () => {
  const { env, id } = await ready(1);
  env.downloads.failures = ['size'];
  await env.orch.start(id);
  assert.ok(await runUntil(env, batchDone(env, id)));
  assert.equal(env.page.sent.length, 1);
  assert.equal(env.store.jobsOf(id)[0].status, 'completed');
  assert.ok(env.store.events(id, 200).some((e) => e.code === 'SIZE_MISMATCH'));
});

test('попытки скачивания исчерпаны → failed; «Повторить ошибки» скачивает снова без генерации', async () => {
  const { env, id } = await ready(3, { maxAttempts: 2 });
  env.downloads.failures = ['interrupt', 'interrupt'];
  await env.orch.start(id);
  assert.ok(await runUntil(env, batchDone(env, id)));
  assert.deepEqual(statuses(env, id), ['failed', 'completed', 'completed']);
  assert.equal(env.page.sent.length, 3);
  await env.orch.retryFailed(id);
  assert.ok(await runUntil(env, batchDone(env, id)));
  assert.deepEqual(statuses(env, id), ['completed', 'completed', 'completed']);
  assert.equal(env.page.sent.length, 3, 'повторная загрузка без повторной генерации');
});

test('два изображения вместо одного: политика «остановить», «первое», «все»', async () => {
  const a = await ready(3);
  a.env.page.setScript(['two-images']);
  await a.env.orch.start(a.id);
  assert.ok(await runUntil(a.env, batchDone(a.env, a.id)));
  assert.deepEqual(statuses(a.env, a.id), ['failed', 'completed', 'completed']);
  assert.equal(a.env.store.jobsOf(a.id)[0].error.code, 'MULTIPLE_IMAGES');
  assert.equal(a.env.page.sent.length, 3);
  await a.env.orch.updateSettings({ multiImagePolicy: 'first' });
  await a.env.orch.retryFailed(a.id);
  assert.ok(await runUntil(a.env, batchDone(a.env, a.id)));
  assert.deepEqual(statuses(a.env, a.id), ['completed', 'completed', 'completed']);
  assert.equal(a.env.page.sent.length, 3, 'выбор из уже полученных изображений — без новой генерации');
  assert.equal(a.env.store.jobsOf(a.id)[0].result.files.length, 1);

  const b = await ready(2, { multiImagePolicy: 'all' });
  b.env.page.setScript(['two-images']);
  await b.env.orch.start(b.id);
  assert.ok(await runUntil(b.env, batchDone(b.env, b.id)));
  const files = b.env.store.jobsOf(b.id)[0].result.files.map((f) => f.split('/').pop());
  assert.deepEqual(files, ['001.png', '001_2.png']);
});

test('отказ по правилам содержимого: задание failed без повторов; 3 подряд → остановка', async () => {
  const a = await ready(3);
  a.env.page.setScript(['policy']);
  await a.env.orch.start(a.id);
  assert.ok(await runUntil(a.env, batchDone(a.env, a.id)));
  assert.deepEqual(statuses(a.env, a.id), ['failed', 'completed', 'completed']);
  assert.equal(a.env.store.jobsOf(a.id)[0].attempts, 1);
  assert.equal(a.env.store.jobsOf(a.id)[0].error.code, 'CONTENT_POLICY');

  const b = await ready(5);
  b.env.page.setScript(['policy', 'policy', 'policy']);
  await b.env.orch.start(b.id);
  assert.ok(await runUntil(b.env, quiet(b.env, 'blocked')));
  assert.equal(b.env.store.runner.block.code, 'CONTENT_POLICY');
  assert.equal(b.env.page.sent.length, 3);
});

test('зависание генерации → STALLED → повтор; исчерпание попыток → failed → ручной повтор', async () => {
  const a = await ready(2, { stallTimeoutSec: 60 });
  a.env.page.setScript([{ mode: 'hang' }]);
  await a.env.orch.start(a.id);
  assert.ok(await runUntil(a.env, batchDone(a.env, a.id)));
  assert.deepEqual(statuses(a.env, a.id), ['completed', 'completed']);
  assert.equal(a.env.store.jobsOf(a.id)[0].attempts, 2);

  const b = await ready(2, { stallTimeoutSec: 60, maxAttempts: 2 });
  b.env.page.setScript(['hang', 'hang']);
  await b.env.orch.start(b.id);
  assert.ok(await runUntil(b.env, batchDone(b.env, b.id)));
  assert.deepEqual(statuses(b.env, b.id), ['failed', 'completed']);
  assert.equal(b.env.store.jobsOf(b.id)[0].error.code, 'STALLED');
  await b.env.orch.retryFailed(b.id);
  assert.ok(await runUntil(b.env, batchDone(b.env, b.id)));
  assert.deepEqual(statuses(b.env, b.id), ['completed', 'completed']);
});

test('ответ без изображения и превью-размер → ограниченные повторы', async () => {
  const a = await ready(1);
  a.env.page.setScript(['text-only', 'small-image']);
  await a.env.orch.start(a.id);
  assert.ok(await runUntil(a.env, batchDone(a.env, a.id)));
  const j = a.env.store.jobsOf(a.id)[0];
  assert.equal(j.status, 'completed');
  assert.equal(j.attempts, 3);
  const codes = a.env.store.events(a.id, 200).map((e) => e.code);
  assert.ok(codes.includes('NO_IMAGE') && codes.includes('PREVIEW_ONLY'));
});

test('ошибка генерации ChatGPT (баннер) → ровно ограниченное число повторов', async () => {
  const a = await ready(1, { maxAttempts: 3 });
  a.env.page.setScript(['error', 'error', 'error']);
  await a.env.orch.start(a.id);
  assert.ok(await runUntil(a.env, batchDone(a.env, a.id)));
  const j = a.env.store.jobsOf(a.id)[0];
  assert.equal(j.status, 'failed');
  assert.equal(j.attempts, 3);
  assert.equal(a.env.page.sent.length, 3);
});

test('то же содержимое под другим URL → DUPLICATE_IMAGE, дубликат не сохраняется', async () => {
  const a = await ready(2);
  a.env.page.setScript(['normal', 'same-bytes', 'normal']);
  await a.env.orch.start(a.id);
  assert.ok(await runUntil(a.env, batchDone(a.env, a.id)));
  const jobs = a.env.store.jobsOf(a.id);
  assert.ok(jobs.every((j) => j.status === 'completed'));
  assert.notEqual(jobs[0].result.sha256, jobs[1].result.sha256);
  assert.equal(jobs[1].attempts, 2);
  assert.equal([...a.env.downloads.files.keys()].filter((k) => k.endsWith('.png')).length, 2);
});

test('страница занята чужой генерацией → ожидание, затем PAGE_BUSY', async () => {
  const { env, id } = await ready(1);
  env.page.startForeignGeneration();
  await env.orch.start(id);
  assert.ok(await runUntil(env, quiet(env, 'blocked')));
  assert.equal(env.store.runner.block.code, 'PAGE_BUSY');
  assert.equal(env.page.sent.length, 0);
});

test('сбой записи состояния не роняет очередь: после «Продолжить» партия завершается', async () => {
  const { env, id } = await ready(2);
  await env.orch.start(id);
  await runUntil(env, () => env.page.sent.length === 1 && env.store.runner.state === 'waiting');
  env.area.failNextSet = true;
  await runUntil(env, () => env.store.runner.state === 'failed' || env.store.runner.state === 'completed', { maxIter: 3000 });
  if (env.store.runner.state === 'failed' && env.store.runner.failure_kind === 'fatal') await env.orch.resume();
  assert.ok(await runUntil(env, batchDone(env, id), { maxIter: 60000 }));
  assert.ok(env.store.jobsOf(id).every((j) => j.status === 'completed'));
});

test('настройки: проверка диапазонов и безопасное имя папки', async () => {
  const { env } = await ready(1);
  await assert.rejects(env.orch.updateSettings({ intervalSec: 1 }), { code: 'BAD_SETTINGS' });
  await assert.rejects(env.orch.updateSettings({ chatStartUrl: 'https://evil.example/' }), { code: 'BAD_SETTINGS' });
  await assert.rejects(env.orch.updateSettings({ multiImagePolicy: 'x' }), { code: 'BAD_SETTINGS' });
  await assert.rejects(env.orch.updateSettings({ confirmThreshold: 400 }), { code: 'BAD_SETTINGS' });
  const s = await env.orch.updateSettings({ rootFolder: '../../Windows/System32:evil', intervalSec: '9' });
  assert.equal(s.rootFolder, 'Windows/System32-evil');
  assert.equal(s.intervalSec, 9);
});

test('удаление: нельзя во время работы; после завершения очищает ключи хранилища', async () => {
  const { env, id } = await ready(2);
  await env.orch.start(id);
  await assert.rejects(env.orch.deleteBatch(id), { code: 'BUSY' });
  assert.ok(await runUntil(env, batchDone(env, id)));
  await env.orch.deleteBatch(id);
  await flush();
  assert.equal(Object.keys(env.area.data).filter((k) => k.includes(id)).length, 0);
});

test('журнал: экспорт JSON/CSV; seq непрерывен', async () => {
  const { env, id } = await ready(1);
  await env.orch.start(id);
  assert.ok(await runUntil(env, batchDone(env, id)));
  const j = env.orch.exportLog(id, 'json');
  const parsed = JSON.parse(j.text);
  assert.equal(parsed.batch_id, id);
  assert.ok(parsed.events.length >= 5);
  assert.deepEqual(parsed.events.map((e) => e.seq), parsed.events.map((_, i) => i + 1));
  const c = env.orch.exportLog(id, 'csv');
  assert.match(c.filename, /\.csv$/);
  assert.ok(c.text.startsWith('\uFEFFseq,ts,level'));
});
