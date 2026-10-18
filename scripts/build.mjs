// Воспроизводимая сборка: source/extension → dist/chrome-unpacked (+ ZIP расширения и ZIP исходников).
// Запуск: npm ci && npm run build. Результат детерминирован (одинаковые исходники → одинаковые байты).
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkBundles, checkManifest } from './lib/manifest-check.mjs';
import { makeZip } from './lib/zip.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SRC = join(ROOT, 'source/extension');
const OUT = join(ROOT, 'dist/chrome-unpacked');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const esbuildVersion = JSON.parse(readFileSync(join(ROOT, 'node_modules/esbuild/package.json'), 'utf8')).version;

function* walk(dir, skip = () => false) {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (skip(p, name)) continue;
    if (statSync(p).isDirectory()) yield* walk(p, skip);
    else yield p;
  }
}
const posix = (p, base) => relative(base, p).split(sep).join('/');

async function main() {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });

  const common = { bundle: true, target: 'chrome116', legalComments: 'none', charset: 'utf8', logLevel: 'warning', sourcemap: false, minify: false };
  await build({ ...common, entryPoints: [join(SRC, 'src/background/index.js')], outfile: join(OUT, 'background.js'), format: 'esm' });
  await build({ ...common, entryPoints: [join(SRC, 'src/content/chatgpt.js')], outfile: join(OUT, 'content/chatgpt.js'), format: 'iife' });
  await build({ ...common, entryPoints: [join(SRC, 'src/content/site-bridge.js')], outfile: join(OUT, 'content/site-bridge.js'), format: 'iife' });
  await build({ ...common, entryPoints: [join(SRC, 'src/sidepanel/panel.js')], outfile: join(OUT, 'sidepanel/panel.js'), format: 'iife' });
  cpSync(join(SRC, 'src/sidepanel/index.html'), join(OUT, 'sidepanel/index.html'));
  cpSync(join(SRC, 'src/sidepanel/styles.css'), join(OUT, 'sidepanel/styles.css'));
  cpSync(join(SRC, 'icons'), join(OUT, 'icons'), { recursive: true });
  cpSync(join(SRC, '_locales'), join(OUT, '_locales'), { recursive: true });
  cpSync(join(SRC, 'manifest.json'), join(OUT, 'manifest.json'));

  const manifest = JSON.parse(readFileSync(join(OUT, 'manifest.json'), 'utf8'));
  const problems = [...checkManifest(manifest, OUT, pkg.version), ...checkBundles(OUT)];
  if (problems.length) {
    console.error(`СБОРКА ОТКЛОНЕНА:\n - ${problems.join('\n - ')}`);
    process.exit(1);
  }

  const h = createHash('sha256');
  for (const f of walk(SRC)) h.update(posix(f, SRC)).update('\0').update(readFileSync(f));
  writeFileSync(join(OUT, 'BUILD-INFO.json'), `${JSON.stringify({ name: pkg.name, version: pkg.version, source_sha256: h.digest('hex'), esbuild: esbuildVersion }, null, 2)}\n`);

  const extFiles = [...walk(OUT)].map((f) => ({ path: posix(f, OUT), data: readFileSync(f) }));
  const extZip = join(ROOT, `dist/realphoto-chatgpt-batch-extension-${pkg.version}.zip`);
  writeFileSync(extZip, makeZip(extFiles));

  const roots = ['source', 'docs', 'tests', 'scripts'];
  const rootFiles = ['package.json', 'package-lock.json', 'README.md', 'CHANGELOG.md', 'LICENSE', '.env.example', '.gitignore'];
  const skip = (p, name) => name === 'node_modules' || name === '.tmp' || name === '.git';
  const srcFiles = [];
  for (const r of roots) if (existsSync(join(ROOT, r))) for (const f of walk(join(ROOT, r), skip)) srcFiles.push({ path: posix(f, ROOT), data: readFileSync(f) });
  for (const f of rootFiles) if (existsSync(join(ROOT, f))) srcFiles.push({ path: f, data: readFileSync(join(ROOT, f)) });
  for (const f of walk(OUT)) srcFiles.push({ path: `dist/chrome-unpacked/${posix(f, OUT)}`, data: readFileSync(f) });
  writeFileSync(join(ROOT, `dist/realphoto-chatgpt-batch-source-${pkg.version}.zip`), makeZip(srcFiles));

  console.log(`OK: dist/chrome-unpacked (${extFiles.length} файлов), ZIP расширения и ZIP исходников v${pkg.version}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
