import assert from 'node:assert/strict';
import test from 'node:test';
import { batchDone, folderOf, makeBatch, quiet, runUntil, setup } from './helpers/fakes.mjs';

const ROOT = 'ChatGPT-Images';
const names = (env, dir) => env.downloads.list(`${ROOT}/${dir}/`).filter((f) => /\.(png|jpg|webp|gif)$/.test(f)).map((f) => f.slice(`${ROOT}/${dir}/`.length));

test('один персонаж × 3: файлы в правильных папках, метаданные соответствуют промптам', async () => {
  const env = await setup();
  const batch = await makeBatch({ characters: 1, frames: 3 });
  const sum = await env.orch.addBatch(batch);
  assert.deepEqual([sum.total, sum.existed], [3, false]);
  await env.orch.start(batch.batch_id);
  assert.ok(await runUntil(env, batchDone(env, batch.batch_id)), `состояние: ${env.store.runner.state}`);
  const folder = folderOf(env, batch.batch_id);
  assert.match(folder, /^Batch_\d{4}-\d{2}-\d{2}_001$/);
  assert.deepEqual(names(env, `${folder}/Character_001`), ['001.png', '002.png', '003.png']);

  const jobs = env.store.jobsOf(batch.batch_id);
  assert.deepEqual(jobs.map((j) => j.status), ['completed', 'completed', 'completed']);
  const lines = env.downloads.files.get(`${ROOT}/${folder}/Character_001/prompts.jsonl`).text.trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, 3);
  for (const [i, l] of lines.entries()) {
    assert.equal(l.image_job_id, batch.characters[0].jobs[i].image_job_id);
    assert.equal(l.prompt, batch.characters[0].jobs[i].prompt);
    assert.equal(l.status, 'completed');
    assert.equal(l.file, `${ROOT}/${folder}/Character_001/00${i + 1}.png`);
    assert.equal(l.format, 'png');
    assert.match(l.sha256, /^[0-9a-f]{64}$/);
  }
  const manifest = env.downloads.json(`${ROOT}/${folder}/manifest.json`);
  assert.equal(manifest.batch_id, batch.batch_id);
  assert.deepEqual([manifest.totals.total, manifest.totals.completed, manifest.totals.failed], [3, 3, 0]);
  const ch = env.downloads.json(`${ROOT}/${folder}/Character_001/character.json`);
  assert.equal(ch.character_id, batch.characters[0].character_id);
  assert.deepEqual(ch.identity.core, batch.characters[0].identity.core);
  // отправленный текст: префикс из настроек + промпт сайта
  assert.ok(env.page.sent[0].text.startsWith('Generate an image from the following description.'));
  assert.ok(env.page.sent[0].text.includes(batch.characters[0].jobs[0].prompt));
});

test('следующее задание уходит только после сохранения файла и паузы интервала', async () => {
  const env = await setup({ intervalSec: 7 });
  const batch = await makeBatch({ characters: 1, frames: 4 });
  await env.orch.addBatch(batch);
  await env.orch.start(batch.batch_id);
  assert.ok(await runUntil(env, batchDone(env, batch.batch_id)));
  const jobs = env.store.jobsOf(batch.batch_id);
  assert.equal(env.page.sent.length, 4);
  for (let i = 0; i < 3; i++) {
    const savedAt = Date.parse(jobs[i].completed_at);
    assert.ok(env.page.sent[i + 1].at - savedAt >= 7000, `кадр ${i + 2} отправлен слишком рано: ${env.page.sent[i + 1].at - savedAt} мс`);
    assert.ok(Date.parse(jobs[i].result.saved_at) >= env.page.sent[i].at, 'сохранение раньше отправки?');
  }
});

test('три персонажа × 5: отдельные чаты и папки, идентичности не смешиваются', async () => {
  const env = await setup({ intervalSec: 2 });
  const batch = await makeBatch({ characters: 3, frames: 5 });
  await env.orch.addBatch(batch);
  await env.orch.start(batch.batch_id);
  assert.ok(await runUntil(env, batchDone(env, batch.batch_id)));
  const folder = folderOf(env, batch.batch_id);
  for (const c of [1, 2, 3]) assert.deepEqual(names(env, `${folder}/Character_00${c}`), ['001.png', '002.png', '003.png', '004.png', '005.png']);
  assert.equal(env.page.sent.length, 15);
  assert.equal(new Set(env.page.sent.map((s) => s.conv)).size, 3, 'каждому персонажу — своя беседа');
  for (const s of env.page.sent) {
    const m = /character (\d), frame (\d)/.exec(s.text);
    assert.ok(m);
    const convOf = env.page.sent.filter((x) => x.text.includes(`character ${m[1]},`)).map((x) => x.conv);
    assert.equal(new Set(convOf).size, 1, `персонаж ${m[1]} размазан по нескольким беседам`);
  }
  const all = [...env.downloads.files.keys()].filter((f) => f.endsWith('.png'));
  assert.equal(new Set(all).size, 15);
  const sha = new Set(env.store.jobsOf(batch.batch_id).map((j) => j.result.sha256));
  assert.equal(sha.size, 15, 'у каждого кадра свой файл');
});

test('ротация беседы каждые N кадров', async () => {
  const env = await setup({ intervalSec: 2, rotateChatEvery: 4 });
  const batch = await makeBatch({ characters: 1, frames: 10 });
  await env.orch.addBatch(batch);
  await env.orch.start(batch.batch_id);
  assert.ok(await runUntil(env, batchDone(env, batch.batch_id)));
  assert.equal(new Set(env.page.sent.map((s) => s.conv)).size, 3);
  assert.equal(env.page.opened.length, 3);
});

test('нагрузочный сценарий 50 × 30 (виртуальное время, интервал 2 с): без потерь и дубликатов', async () => {
  const env = await setup({ intervalSec: 2, rotateChatEvery: 0 });
  env.page.defaults.delayMs = 1500;
  const batch = await makeBatch({ characters: 50, frames: 30 });
  await env.orch.addBatch(batch);
  await env.orch.start(batch.batch_id, { acknowledged: true, typed_total: 1500 });
  assert.ok(await runUntil(env, batchDone(env, batch.batch_id), { maxIter: 3_000_000 }));
  const jobs = env.store.jobsOf(batch.batch_id);
  assert.equal(jobs.length, 1500);
  assert.ok(jobs.every((j) => j.status === 'completed' && j.attempts === 1));
  assert.equal(env.page.sent.length, 1500, 'каждое задание отправлено ровно один раз');
  assert.equal(new Set(jobs.map((j) => j.result.file)).size, 1500);
  assert.equal(new Set(env.page.sent.map((s) => s.text)).size, 1500);
  assert.equal(new Set(env.page.sent.map((s) => s.conv)).size, 50);
});

test('повторная выдача той же партии (дубликат ответа API) не создаёт дублей', async () => {
  const env = await setup();
  const batch = await makeBatch({ characters: 2, frames: 2 });
  const a = await env.orch.addBatch(batch);
  const b = await env.orch.addBatch(batch);
  assert.equal(a.existed, false);
  assert.equal(b.existed, true);
  assert.equal(env.store.batches.size, 1);
  assert.equal(env.store.jobs.size, 4);
});

test('подтверждения больших партий проверяются в service worker', async () => {
  const env = await setup();
  const big = await makeBatch({ characters: 2, frames: 40, prefix: 'RPS-BIG0000001' }); // 80 > 50
  await env.orch.addBatch(big);
  await assert.rejects(env.orch.start(big.batch_id), { code: 'CONFIRM_REQUIRED' });
  await assert.rejects(env.orch.start(big.batch_id, { acknowledged: false }), { code: 'CONFIRM_REQUIRED' });
  const huge = await makeBatch({ characters: 4, frames: 100, prefix: 'RPS-HUGE000001' }); // 400 > 300
  await env.orch.addBatch(huge);
  await assert.rejects(env.orch.start(huge.batch_id, { acknowledged: true }), { code: 'CONFIRM_MISMATCH' });
  await assert.rejects(env.orch.start(huge.batch_id, { acknowledged: true, typed_total: 399 }), { code: 'CONFIRM_MISMATCH' });
  assert.equal(env.store.runner.state, 'idle', 'без подтверждения ничего не запускается');
  assert.equal(env.page.sent.length, 0);
  await env.orch.start(huge.batch_id, { acknowledged: true, typed_total: 400 });
  assert.equal(env.store.runner.state, 'preparing');
  await env.orch.emergencyStop();
  const tooBig = await makeBatch({ characters: 20, frames: 100, prefix: 'RPS-TOOBIG00001' }); // 2000 > 1500
  await assert.rejects(env.orch.addBatch(tooBig), { code: 'BATCH_TOO_LARGE' });
});

test('пауза применяется после текущего изображения, продолжение доводит партию до конца', async () => {
  const env = await setup();
  const batch = await makeBatch({ characters: 1, frames: 5 });
  await env.orch.addBatch(batch);
  await env.orch.start(batch.batch_id);
  await runUntil(env, () => env.page.sent.length === 2);
  await env.orch.pause();
  assert.ok(await runUntil(env, quiet(env, 'paused')));
  const done = env.store.jobsOf(batch.batch_id).filter((j) => j.status === 'completed').length;
  assert.equal(done, 2, 'текущее изображение дожидается, следующее не отправляется');
  assert.equal(env.page.sent.length, 2);
  await env.orch.resume();
  assert.ok(await runUntil(env, batchDone(env, batch.batch_id)));
  assert.equal(env.page.sent.length, 5);
  assert.equal(new Set(env.page.sent.map((s) => s.text)).size, 5);
});

test('«Остановить» возвращает неотправленное задание в очередь; «Продолжить» не дублирует отправленное', async () => {
  const env = await setup();
  const batch = await makeBatch({ characters: 1, frames: 3 });
  await env.orch.addBatch(batch);
  await env.orch.start(batch.batch_id);
  await runUntil(env, () => env.page.sent.length === 1 && env.store.runner.state === 'waiting');
  await env.orch.stop();
  assert.equal(env.store.runner.state, 'idle');
  assert.equal(env.store.runner.halted, 'USER_STOP');
  const j1 = env.store.jobsOf(batch.batch_id)[0];
  assert.equal(j1.status, 'pending');
  assert.ok(j1.submitted, 'метка отправки сохранена для восстановления');
  await env.orch.resume();
  assert.ok(await runUntil(env, batchDone(env, batch.batch_id)));
  assert.equal(env.page.sent.length, 3, 'промпт первого кадра не отправлялся повторно');
});

test('аварийная остановка: нажимает «стоп» в ChatGPT и блокирует автоматическое продолжение', async () => {
  const env = await setup();
  const batch = await makeBatch({ characters: 1, frames: 3 });
  await env.orch.addBatch(batch);
  await env.orch.start(batch.batch_id);
  await runUntil(env, () => env.page.sent.length === 1 && env.store.runner.state === 'waiting');
  await env.orch.emergencyStop();
  assert.equal(env.store.runner.state, 'idle');
  assert.equal(env.store.runner.halted, 'EMERGENCY');
  assert.equal(env.page.cancelled, true);
  await runUntil(env, () => false, { maxVirtualMs: 600000, maxIter: 2000 });
  assert.equal(env.page.sent.length, 1, 'после аварийной остановки ничего не отправляется');
});

test('тестовое задание: отдельная папка Test_…, основная партия не затронута', async () => {
  const env = await setup();
  const batch = await makeBatch({ characters: 2, frames: 3 });
  const t = await env.orch.addBatch(batch, { kind: 'test' });
  assert.equal(t.total, 1);
  assert.match(t.folder, /^Test_\d{4}-\d{2}-\d{2}_001$/);
  assert.notEqual(t.batch_id, batch.batch_id);
  await env.orch.start(t.batch_id);
  assert.ok(await runUntil(env, batchDone(env, t.batch_id)));
  assert.deepEqual(names(env, `${t.folder}/Character_001`), ['001.png']);
  const full = await env.orch.addBatch(batch);
  assert.equal(full.existed, false);
  assert.equal(full.total, 6);
});

test('один персонаж × 20: 20 файлов подряд, ротация беседы на 12-м кадре, имена 001…020', async () => {
  const env = await setup({ intervalSec: 2 });
  const batch = await makeBatch({ characters: 1, frames: 20 });
  await env.orch.addBatch(batch);
  await env.orch.start(batch.batch_id, { acknowledged: true });
  assert.ok(await runUntil(env, batchDone(env, batch.batch_id)));
  const folder = folderOf(env, batch.batch_id);
  const files = names(env, `${folder}/Character_001`);
  assert.deepEqual(files, Array.from({ length: 20 }, (_, i) => `${String(i + 1).padStart(3, '0')}.png`));
  assert.equal(new Set(env.page.sent.map((s) => s.conv)).size, 2, 'ротация: 12 + 8 кадров');
  assert.deepEqual([...new Set(env.page.sent.slice(0, 12).map((s) => s.conv))].length, 1);
  assert.equal(env.store.jobsOf(batch.batch_id).every((j) => j.attempts === 1), true);
});
