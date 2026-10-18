// Пересчитывает source/site-integration/manifest.json. «До» — хеши файлов в ЧИСТОМ чекауте сайта (git show HEAD:путь, поэтому
// переводы строк рабочей копии не влияют), «после» — хеши файлов пакета (source/site-integration/files).
//   node scripts/make-site-manifest.mjs <чистый-чекаут-сайта>
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PKG = join(ROOT, 'source/site-integration');
const pristine = process.argv[2] ? resolve(process.argv[2]) : null;
if (!pristine) {
  console.error('Использование: node scripts/make-site-manifest.mjs <чистый-чекаут-сайта>');
  process.exit(1);
}

const norm = (buf) => buf.toString('utf8').replace(/\r\n/g, '\n');
const sha = (text) => createHash('sha256').update(text).digest('hex');

function* walk(dir) {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else yield p;
  }
}

const files = [];
for (const abs of walk(join(PKG, 'files'))) {
  const path = relative(join(PKG, 'files'), abs).split(sep).join('/');
  let before = null;
  try {
    before = sha(norm(execFileSync('git', ['-C', pristine, 'show', `HEAD:${path}`], { stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 })));
  } catch {
    before = null;
  }
  files.push({ path, before, after: sha(norm(readFileSync(abs))) });
}

const head = execFileSync('git', ['-C', pristine, 'rev-parse', '--short', 'HEAD']).toString().trim();
writeFileSync(join(PKG, 'manifest.json'), `${JSON.stringify({ engine: '1.1.0', base: `Juncker38/wefeer@${head}`, files }, null, 2)}\n`);
console.log(`manifest.json: ${files.length} файлов, база ${head}`);
for (const f of files) console.log(`  ${f.before === null ? 'новый    ' : 'заменяет '} ${f.path}`);
