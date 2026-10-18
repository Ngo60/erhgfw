// Устанавливает на сайт RealPhoto Prompt Studio мост для расширения и улучшения генератора (движок 1.1.0: селфи и реализм).
// Идемпотентно и безопасно: перезаписывает файлы сайта только если они «чистые» (хеш совпадает с manifest.json), делает
// резервные копии, умеет проверять (--check) и откатывать (--revert).
//
//   node source/site-integration/apply.mjs <путь-к-сайту>            установить
//   node source/site-integration/apply.mjs <путь-к-сайту> --check    только показать состояние (код 0 — всё установлено)
//   node source/site-integration/apply.mjs <путь-к-сайту> --revert   вернуть исходное состояние из резервных копий
//   --force   перезаписать и изменённые вручную файлы сайта (резервная копия сохраняется)
//   --package <каталог>   другой пакет (для тестов)
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const has = (n) => args.includes(n);
const opt = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : null);
const pkgDir = resolve(opt('--package') ?? HERE);
const positional = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--package');

const IMPORT_LINE = "import { installExtensionBridge } from './extension-bridge/index.ts';";
const CALL_BLOCK = "// Мост для расширения Chrome «пакетная генерация»: пассивен, отвечает только на запросы расширения.\ninstallExtensionBridge();\n\n";
const BACKUP = '.rps-site-integration-backup';

const fail = (msg, code = 1) => {
  console.error(`ОШИБКА: ${msg}`);
  process.exit(code);
};

if (!positional[0]) fail('укажите путь к каталогу сайта: node apply.mjs <путь-к-сайту> [--check|--revert] [--force]');
const target = resolve(positional[0]);
if (!existsSync(join(target, 'src/main.tsx')) || !existsSync(join(target, 'src/engine/generate.ts')) || !existsSync(join(target, 'src/engine/compose.ts'))) {
  fail(`«${target}» не похож на каталог сайта RealPhoto Prompt Studio (нет src/main.tsx, src/engine/generate.ts или src/engine/compose.ts)`);
}
if (!existsSync(join(pkgDir, 'manifest.json'))) fail(`в пакете нет manifest.json (${pkgDir})`);
const manifest = JSON.parse(readFileSync(join(pkgDir, 'manifest.json'), 'utf8'));

/** Хеш с нормализацией переводов строк: рабочая копия на Windows может быть с CRLF. */
const sha = (p) => (existsSync(p) ? createHash('sha256').update(readFileSync(p, 'utf8').replace(/\r\n/g, '\n')).digest('hex') : null);

const mainPath = join(target, 'src/main.tsx');
const backupDir = join(target, BACKUP);

function classify() {
  return manifest.files.map((e) => {
    const dst = join(target, e.path);
    const cur = sha(dst);
    let status;
    if (cur === e.after) status = 'applied';
    else if (e.before === null) status = cur === null ? 'new' : 'replace-ours';
    else if (cur === e.before) status = 'pristine';
    else status = cur === null ? 'missing' : 'modified';
    return { ...e, dst, cur, status };
  });
}

const entries = classify();
const mainApplied = readFileSync(mainPath, 'utf8').includes('installExtensionBridge');
const blockers = entries.filter((e) => e.status === 'modified' || e.status === 'missing');

if (has('--check')) {
  for (const e of entries) console.log(`  ${e.status.padEnd(12)} ${e.path}`);
  console.log(`  ${(mainApplied ? 'applied' : 'pristine').padEnd(12)} src/main.tsx`);
  const done = entries.every((e) => e.status === 'applied') && mainApplied;
  console.log(done ? 'Установлено полностью.' : blockers.length ? `Есть файлы, изменённые вручную или отсутствующие (${blockers.length}): установка без --force не выполнится.` : 'Установка ещё не выполнена или выполнена не полностью.');
  process.exit(done ? 0 : blockers.length ? 3 : 2);
}

/** Папка резервных копий не должна попадать в git-статус сайта: добавляем её в локальный .git/info/exclude. */
function ignoreBackupDir() {
  if (!existsSync(join(target, '.git'))) return;
  try {
    const file = join(target, '.git', 'info', 'exclude');
    mkdirSync(dirname(file), { recursive: true });
    const cur = existsSync(file) ? readFileSync(file, 'utf8') : '';
    if (!cur.split(/\r?\n/).includes(`/${BACKUP}/`)) writeFileSync(file, `${cur}${cur && !cur.endsWith('\n') ? '\n' : ''}/${BACKUP}/\n`);
  } catch {
    // необязательная аккуратность: без неё папка просто видна в git status
  }
}

function pruneEmptyDirs(file) {
  let dir = dirname(file);
  while (dir.startsWith(target) && dir !== target) {
    try {
      rmdirSync(dir);
    } catch {
      return;
    }
    dir = dirname(dir);
  }
}

if (has('--revert')) {
  const warnings = [];
  for (const e of entries) {
    if (e.before === null) {
      rmSync(e.dst, { force: true });
      pruneEmptyDirs(e.dst);
      continue;
    }
    const b = join(backupDir, e.path);
    if (existsSync(b)) copyFileSync(b, e.dst);
    else if (e.status !== 'pristine') warnings.push(`нет резервной копии для ${e.path} — восстановите файл из git (git checkout -- ${e.path})`);
  }
  const main = readFileSync(mainPath, 'utf8').replace(`${IMPORT_LINE}\n`, '').replace(CALL_BLOCK, '');
  writeFileSync(mainPath, main);
  if (warnings.length) {
    console.warn(warnings.join('\n'));
    process.exit(4);
  }
  rmSync(backupDir, { recursive: true, force: true });
  console.log('Исходное состояние сайта восстановлено.');
  process.exit(0);
}

if (blockers.length && !has('--force')) {
  console.error('Установка остановлена: эти файлы сайта изменены вручную (или отсутствуют), их нельзя перезаписывать молча:');
  for (const e of blockers) console.error(`  ${e.status}: ${e.path}`);
  console.error('Проверьте различия или повторите с --force (резервная копия будет сохранена).');
  process.exit(3);
}

let changed = 0;
for (const e of entries) {
  if (e.status === 'applied') continue;
  if (e.before !== null && existsSync(e.dst)) {
    const b = join(backupDir, e.path);
    if (!existsSync(b)) {
      ignoreBackupDir();
      mkdirSync(dirname(b), { recursive: true });
      copyFileSync(e.dst, b);
    }
  }
  mkdirSync(dirname(e.dst), { recursive: true });
  copyFileSync(join(pkgDir, 'files', e.path), e.dst);
  if (sha(e.dst) !== e.after) fail(`после копирования хеш файла ${e.path} не совпал с манифестом`);
  changed += 1;
}

if (!mainApplied) {
  let main = readFileSync(mainPath, 'utf8');
  const anchor = "import './ui/styles.css';\n";
  const root = "const root = document.getElementById('root');";
  if (!main.includes(anchor) || !main.includes(root)) fail('в src/main.tsx не найдены ожидаемые строки — добавьте импорт и вызов installExtensionBridge() вручную (см. docs/04-SERVER-SETUP.md)');
  main = main.replace(anchor, `${anchor}${IMPORT_LINE}\n`).replace(root, `${CALL_BLOCK}${root}`);
  writeFileSync(mainPath, main);
  changed += 1;
}

console.log(changed ? `Готово: обновлено файлов — ${changed}. Далее: npm run typecheck && npm test && npm run build && npm run smoke` : 'Уже установлено, ничего не изменено.');
