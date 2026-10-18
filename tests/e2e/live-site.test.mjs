// Опциональная проверка против ЖИВОГО сайта (нужен интернет): расширение в реальном Chrome подключается к настоящему
// https://promts.vibecods.xyz/, получает пресеты и собирает партию мостом боевого сайта. ChatGPT здесь — мок; генерация не запускается.
// Запуск: npm run build && npm run test:live-site   (SITE_URL=https://другой.адрес — для другого развёртывания)
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import test, { after, before } from 'node:test';
import { fileURLToPath } from 'node:url';
import { closeBrowser, launch, makeDirs, until } from './lib/harness.mjs';
import { makeCerts } from './mock/certs.mjs';
import { startMockChatGpt } from './mock/chatgpt-server.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const EXT = join(ROOT, 'dist/chrome-unpacked');
const SITE_URL = process.env.SITE_URL ?? 'https://promts.vibecods.xyz/';
const E = {};
const send = (msg) => E.panel.evaluate((m) => chrome.runtime.sendMessage({ rps: 1, ...m }), msg);

before(async () => {
  assert.ok(existsSync(join(EXT, 'manifest.json')), 'сначала npm run build');
  E.dirs = makeDirs();
  E.chat = await startMockChatGpt({ certs: await makeCerts() });
  Object.assign(E, await launch({ ext: EXT, profile: E.dirs.profile, chatPort: E.chat.port, sitePort: null, debugPort: 9900 + Math.floor(Math.random() * 90) }));
  E.siteTab = await E.ctx.newPage();
  await E.siteTab.goto(SITE_URL);
  E.panel = await E.ctx.newPage();
  await E.panel.goto(`chrome-extension://${E.extId}/sidepanel/index.html`);
});

after(async () => {
  await closeBrowser(E).catch(() => {});
  await E.chat?.stop().catch(() => {});
});

test('живой сайт: мост отвечает, пресеты и партия собираются боевым движком', async () => {
  const st = await until(async () => { const r = await send({ type: 'SITE_STATUS' }); return r.ok && r.site.connected ? r.site : null; }, { label: 'мост живого сайта', timeout: 30000 });
  assert.equal(st.bridge_version, 1);
  assert.ok(st.engine);
  const pr = await send({ type: 'SITE_LIST_PRESETS' });
  assert.ok(pr.ok && pr.presets.some((p) => p.id === 'natural-selfie'), JSON.stringify(pr));
  const r = await send({ type: 'SITE_CREATE_BATCH', params: { mode: 'multi', characters: 2, frames_per_character: 2, strategy: 'character', preset_id: null, seed: 'RP-LIVECHECK', profile: 'gpt-image', length: 'standard', include_negative: true, use_site_character: false } });
  assert.ok(r.ok, JSON.stringify(r.error));
  assert.deepEqual([r.summary.total, r.summary.characters, r.summary.frames], [4, 2, 2]);
  const again = await send({ type: 'SITE_CREATE_BATCH', params: { mode: 'multi', characters: 2, frames_per_character: 2, strategy: 'character', preset_id: null, seed: 'RP-LIVECHECK', profile: 'gpt-image', length: 'standard', include_negative: true, use_site_character: false } });
  assert.equal(again.summary.existed, true, 'тот же seed → тот же batch_id (идемпотентность живого моста)');
  assert.equal(again.summary.batch_id, r.summary.batch_id);
});
