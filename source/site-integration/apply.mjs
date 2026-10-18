// Применяет мост расширения к чекауту сайта RealPhoto Prompt Studio (идемпотентно): копирует модуль и тесты, правит src/main.tsx.
// Использование: node source/site-integration/apply.mjs <путь-к-сайту> [--check] [--revert]
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const FILES = join(HERE, 'files');
const args = process.argv.slice(2);
const target = resolve(args.find((a) => !a.startsWith('--')) ?? '');
const check = args.includes('--check');
const revert = args.includes('--revert');

const IMPORT_LINE = "import { installExtensionBridge } from './extension-bridge/index.ts';";
const CALL_BLOCK = "// Мост для расширения Chrome «пакетная генерация»: пассивен, отвечает только на запросы расширения.\ninstallExtensionBridge();\n\n";

function fail(msg) {
  console.error(`ОШИБКА: ${msg}`);
  process.exit(1);
}

function listFiles(dir, base = dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? listFiles(join(dir, e.name), base) : [join(dir, e.name).slice(base.length + 1)]));
}

if (!existsSync(join(target, 'src/main.tsx')) || !existsSync(join(target, 'src/engine/generate.ts'))) fail(`«${target}» не похож на каталог сайта RealPhoto Prompt Studio (нет src/main.tsx или src/engine/generate.ts)`);
if (!existsSync(join(target, 'src/engine/compose.ts'))) fail('нет src/engine/compose.ts — версия движка неизвестна');

const mainPath = join(target, 'src/main.tsx');
let main = readFileSync(mainPath, 'utf8');
const applied = main.includes('installExtensionBridge');
const files = listFiles(FILES);

if (check) {
  const missing = files.filter((f) => !existsSync(join(target, f)));
  console.log(applied && !missing.length ? 'Мост установлен.' : `Мост НЕ установлен полностью (main.tsx: ${applied ? 'есть' : 'нет'}, отсутствуют файлы: ${missing.length}).`);
  process.exit(applied && !missing.length ? 0 : 2);
}

if (revert) {
  for (const f of files) rmSync(join(target, f), { force: true });
  rmSync(join(target, 'src/extension-bridge'), { recursive: true, force: true });
  main = main.replace(`${IMPORT_LINE}\n`, '').replace(CALL_BLOCK, '');
  writeFileSync(mainPath, main);
  console.log('Мост удалён.');
  process.exit(0);
}

for (const f of files) {
  const dst = join(target, f);
  mkdirSync(dirname(dst), { recursive: true });
  copyFileSync(join(FILES, f), dst);
}
if (!applied) {
  const anchor = "import './ui/styles.css';\n";
  if (!main.includes(anchor)) fail('в src/main.tsx не найден ожидаемый импорт стилей — добавьте две строки вручную (см. docs/04-SERVER-SETUP.md)');
  main = main.replace(anchor, `${anchor}${IMPORT_LINE}\n`);
  const root = "const root = document.getElementById('root');";
  if (!main.includes(root)) fail('в src/main.tsx не найден контейнер #root');
  main = main.replace(root, `${CALL_BLOCK}${root}`);
  writeFileSync(mainPath, main);
}
console.log(`Мост ${applied ? 'обновлён' : 'установлен'}: ${files.length} файлов + src/main.tsx. Далее: npm run typecheck && npm test && npm run build`);
