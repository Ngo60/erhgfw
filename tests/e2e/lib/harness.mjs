// Обвязка e2e: реальный Chrome + распакованное расширение + мок ChatGPT + реальная сборка сайта.
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const CHROME_CANDIDATES = [process.env.CHROME_PATH, '/usr/local/bin/google-chrome', '/usr/bin/google-chrome', '/usr/bin/chromium', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].filter(Boolean);

export function findChrome() {
  const p = CHROME_CANDIDATES.find((c) => existsSync(c));
  if (!p) throw new Error('Chrome не найден: задайте CHROME_PATH');
  return p;
}

export function makeDirs() {
  const root = mkdtempSync(join(process.env.E2E_TMP ?? tmpdir(), 'rps-e2e-'));
  const profile = join(root, 'profile');
  const downloads = join(root, 'downloads');
  mkdirSync(join(profile, 'Default'), { recursive: true });
  mkdirSync(downloads, { recursive: true });
  writeFileSync(join(profile, 'Default', 'Preferences'), JSON.stringify({ download: { default_directory: downloads, prompt_for_download: false, directory_upgrade: true }, savefile: { default_directory: downloads }, profile: { default_content_setting_values: { notifications: 1 } } }));
  return { root, profile, downloads };
}

/**
 * Запускает Chrome напрямую (не через launchPersistentContext) и подключается по CDP: так Playwright не перехватывает
 * загрузки, и chrome.downloads пишет файлы в папку из настроек профиля.
 */
export async function launch({ ext, profile, chatPort, sitePort, debugPort }) {
  const proc = spawn(
    findChrome(),
    [
      '--headless=new',
      '--no-sandbox',
      '--no-first-run',
      '--no-default-browser-check',
      `--user-data-dir=${profile}`,
      `--disable-extensions-except=${ext}`,
      `--load-extension=${ext}`,
      `--host-resolver-rules=MAP chatgpt.com 127.0.0.1:${chatPort}, MAP promts.vibecods.xyz 127.0.0.1:${sitePort}`,
      '--ignore-certificate-errors',
      '--window-size=1100,900',
      `--remote-debugging-port=${debugPort}`,
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
  await until(async () => (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).ok, { timeout: 30000, label: 'запуск Chrome' });
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);
  const ctx = browser.contexts()[0];
  const extId = await until(
    async () => {
      const list = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
      const t = list.find((x) => x.type === 'service_worker' && x.url.startsWith('chrome-extension://'));
      return t ? new URL(t.url).host : null;
    },
    { timeout: 30000, label: 'service worker расширения' },
  );
  return { ctx, browser, proc, extId };
}

export async function closeBrowser({ browser, proc }) {
  await browser?.close().catch(() => {});
  if (!proc || proc.exitCode !== null) return;
  const exited = new Promise((r) => proc.once('exit', r));
  proc.kill('SIGTERM');
  await Promise.race([exited, new Promise((r) => setTimeout(r, 8000))]);
  if (proc.exitCode === null) proc.kill('SIGKILL');
}

/** Принудительно завершает service worker расширения (как выгрузка по таймауту): CDP Target.closeTarget. */
export async function killServiceWorker(debugPort, extId) {
  const ver = await (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).json();
  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });
  const call = (id, method, params = {}) =>
    new Promise((res) => {
      const onMsg = (ev) => {
        const d = JSON.parse(ev.data);
        if (d.id === id) {
          ws.removeEventListener('message', onMsg);
          res(d.result);
        }
      };
      ws.addEventListener('message', onMsg);
      ws.send(JSON.stringify({ id, method, params }));
    });
  const { targetInfos } = await call(1, 'Target.getTargets');
  const targets = targetInfos.filter((t) => t.type === 'service_worker' && t.url.includes(extId));
  for (const [i, t] of targets.entries()) await call(10 + i, 'Target.closeTarget', { targetId: t.targetId });
  ws.close();
  return targets.length;
}

export function* walkFiles(dir) {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walkFiles(p);
    else yield p;
  }
}

export const relFiles = (dir) => [...walkFiles(dir)].map((p) => p.slice(dir.length + 1).replaceAll('\\', '/'));
export const readJsonl = (p) => readFileSync(p, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
export const isPng = (p) => {
  const b = readFileSync(p);
  return b.length > 100 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
};

export async function until(fn, { timeout = 60000, step = 250, label = 'условие' } = {}) {
  const end = Date.now() + timeout;
  let last;
  for (;;) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e;
    }
    if (Date.now() > end) throw new Error(`Таймаут ожидания: ${label}${last instanceof Error ? ` (${last.message})` : ''}`);
    await new Promise((r) => setTimeout(r, step));
  }
}
