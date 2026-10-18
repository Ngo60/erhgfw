import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const PKG = join(ROOT, 'source/site-integration');
const APPLY = join(PKG, 'apply.mjs');
const sha = (t) => createHash('sha256').update(String(t).replace(/\r\n/g, '\n')).digest('hex');

function run(args) {
  try {
    return { code: 0, out: execFileSync('node', [APPLY, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
  } catch (e) {
    return { code: e.status, out: `${e.stdout}${e.stderr}` };
  }
}

function* walk(dir) {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else yield p;
  }
}

const put = (root, path, text) => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
};
const get = (root, path) => readFileSync(join(root, path), 'utf8');

test('пакет интеграции: манифест полон и совпадает с файлами пакета', () => {
  const m = JSON.parse(readFileSync(join(PKG, 'manifest.json'), 'utf8'));
  const listed = new Set(m.files.map((f) => f.path));
  const onDisk = [...walk(join(PKG, 'files'))].map((p) => relative(join(PKG, 'files'), p).split(sep).join('/'));
  assert.deepEqual([...listed].sort(), onDisk.sort(), 'каждый файл пакета описан в манифесте и наоборот');
  for (const f of m.files) {
    assert.equal(sha(readFileSync(join(PKG, 'files', f.path), 'utf8')), f.after, `хеш ${f.path}`);
    assert.ok(f.before === null || /^[0-9a-f]{64}$/.test(f.before), `before ${f.path}`);
  }
  assert.ok(m.files.some((f) => f.path === 'src/render/selfie.ts' && f.before === null));
  assert.ok(m.files.some((f) => f.path === 'src/render/render.ts' && f.before !== null));
  const compose = readFileSync(join(PKG, 'files/src/engine/compose.ts'), 'utf8');
  assert.match(compose, new RegExp(`ENGINE_VERSION = '${m.engine.replaceAll('.', '\\.')}'`), 'версия движка в манифесте совпадает с кодом');
});

test('установщик: проверка → установка → идемпотентность → откат; ручные правки не перезаписываются молча', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'rps-apply-'));
  const pkg = join(tmp, 'pkg');
  const site = join(tmp, 'site');
  const ORIG = { compose: 'ORIGINAL COMPOSE\n', render: 'ORIGINAL RENDER\n' };
  const NEW = { compose: 'NEW COMPOSE\n', render: 'NEW RENDER\n', selfie: 'NEW SELFIE\n' };
  put(pkg, 'files/src/engine/compose.ts', NEW.compose);
  put(pkg, 'files/src/render/render.ts', NEW.render);
  put(pkg, 'files/src/render/selfie.ts', NEW.selfie);
  writeFileSync(join(pkg, 'manifest.json'), JSON.stringify({ engine: 'x', base: 'test', files: [
    { path: 'src/engine/compose.ts', before: sha(ORIG.compose), after: sha(NEW.compose) },
    { path: 'src/render/render.ts', before: sha(ORIG.render), after: sha(NEW.render) },
    { path: 'src/render/selfie.ts', before: null, after: sha(NEW.selfie) },
  ] }));
  const MAIN = "import './ui/styles.css';\n\nconst root = document.getElementById('root');\n";
  put(site, 'src/main.tsx', MAIN);
  put(site, 'src/engine/generate.ts', 'g\n');
  put(site, 'src/engine/compose.ts', ORIG.compose.replace(/\n/g, '\r\n')); // рабочая копия с CRLF всё равно считается «чистой»
  put(site, 'src/render/render.ts', ORIG.render);
  const base = [site, '--package', pkg];

  assert.equal(run(['--check', ...base]).code, 2);
  assert.equal(run(base).code, 0);
  assert.equal(get(site, 'src/render/render.ts'), NEW.render);
  assert.equal(get(site, 'src/engine/compose.ts'), NEW.compose);
  assert.equal(get(site, 'src/render/selfie.ts'), NEW.selfie);
  assert.match(get(site, 'src/main.tsx'), /installExtensionBridge\(\);/);
  assert.equal(run(['--check', ...base]).code, 0);
  assert.match(run(base).out, /Уже установлено/);

  assert.equal(run(['--revert', ...base]).code, 0);
  assert.equal(get(site, 'src/render/render.ts'), ORIG.render);
  assert.equal(get(site, 'src/engine/compose.ts'), ORIG.compose.replace(/\n/g, '\r\n'), 'исходные байты (с CRLF) восстановлены');
  assert.equal(existsSync(join(site, 'src/render/selfie.ts')), false, 'новые файлы удалены');
  assert.equal(existsSync(join(site, 'src/render')), true);
  assert.equal(get(site, 'src/main.tsx'), MAIN);
  assert.equal(existsSync(join(site, '.rps-site-integration-backup')), false);

  put(site, 'src/render/render.ts', 'USER EDITED RENDER\n');
  const blocked = run(base);
  assert.equal(blocked.code, 3);
  assert.match(blocked.out, /modified: src\/render\/render\.ts/);
  assert.equal(get(site, 'src/render/render.ts'), 'USER EDITED RENDER\n', 'без --force файл не тронут');
  assert.equal(existsSync(join(site, 'src/render/selfie.ts')), false, 'при блокировке не установлено ничего');
  assert.equal(run(['--check', ...base]).code, 3);

  assert.equal(run([...base, '--force']).code, 0);
  assert.equal(get(site, 'src/render/render.ts'), NEW.render);
  assert.equal(run(['--revert', ...base]).code, 0);
  assert.equal(get(site, 'src/render/render.ts'), 'USER EDITED RENDER\n', 'откат возвращает версию пользователя');
});

test('установщик отказывается работать не в каталоге сайта и без пути', () => {
  assert.equal(run([]).code, 1);
  const tmp = mkdtempSync(join(tmpdir(), 'rps-apply-bad-'));
  assert.equal(run([tmp]).code, 1);
});
