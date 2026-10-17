// Проверка манифеста и собранных файлов: минимальные разрешения, отсутствие удалённого кода, существование файлов.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const ALLOWED_PERMISSIONS = ['storage', 'unlimitedStorage', 'downloads', 'alarms', 'sidePanel', 'scripting', 'notifications'];
export const ALLOWED_HOSTS = ['https://chatgpt.com/*', 'https://*.oaiusercontent.com/*', 'https://promts.vibecods.xyz/*'];
const ALLOWED_KEYS = new Set(['manifest_version', 'name', 'short_name', 'description', 'version', 'default_locale', 'minimum_chrome_version', 'icons', 'action', 'background', 'side_panel', 'permissions', 'host_permissions', 'content_scripts', 'content_security_policy']);

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else yield p;
  }
}

export function checkManifest(m, dir, expectedVersion) {
  const errors = [];
  const bad = (x) => errors.push(x);
  if (m.manifest_version !== 3) bad('manifest_version должен быть 3');
  if (!/^\d+\.\d+\.\d+$/.test(m.version ?? '')) bad('version: ожидается x.y.z');
  if (expectedVersion && m.version !== expectedVersion) bad(`version ${m.version} ≠ package.json ${expectedVersion}`);
  for (const k of Object.keys(m)) if (!ALLOWED_KEYS.has(k)) bad(`неожиданный ключ манифеста: ${k}`);
  for (const p of m.permissions ?? []) if (!ALLOWED_PERMISSIONS.includes(p)) bad(`лишнее разрешение: ${p}`);
  for (const h of m.host_permissions ?? []) if (!ALLOWED_HOSTS.includes(h)) bad(`лишний host_permissions: ${h}`);
  for (const cs of m.content_scripts ?? []) {
    for (const match of cs.matches ?? []) if (!ALLOWED_HOSTS.includes(match)) bad(`content_scripts.matches вне списка: ${match}`);
    for (const f of cs.js ?? []) if (!existsSync(join(dir, f))) bad(`нет файла content script: ${f}`);
  }
  const csp = m.content_security_policy?.extension_pages ?? '';
  if (!csp) bad('не задан content_security_policy.extension_pages');
  if (/unsafe-eval|unsafe-inline|https?:\/\//i.test(csp.replace(/https?:\/\/[^\s;]*/g, (x) => (x ? 'REMOTE' : '')).replace('REMOTE', 'https://'))) bad('CSP допускает eval/inline/удалённый код');
  if (!existsSync(join(dir, m.background?.service_worker ?? '__none__'))) bad('нет service worker');
  if (!existsSync(join(dir, m.side_panel?.default_path ?? '__none__'))) bad('нет страницы side panel');
  for (const f of Object.values(m.icons ?? {})) if (!existsSync(join(dir, f))) bad(`нет иконки ${f}`);
  const locale = join(dir, '_locales', m.default_locale ?? 'ru', 'messages.json');
  if (!existsSync(locale)) bad('нет _locales/<default_locale>/messages.json');
  else {
    const msgs = JSON.parse(readFileSync(locale, 'utf8'));
    for (const key of JSON.stringify(m).matchAll(/__MSG_(\w+)__/g)) if (!msgs[key[1]]) bad(`нет перевода для __MSG_${key[1]}__`);
  }
  return errors;
}

/** Запрещённые конструкции в собранных скриптах (удалённый код, eval, небезопасная вставка HTML). */
export function checkBundles(dir) {
  const errors = [];
  const rules = [
    [/\beval\s*\(/, 'eval('],
    [/new\s+Function\s*\(/, 'new Function('],
    [/\bimportScripts\s*\(/, 'importScripts('],
    [/document\.write\s*\(/, 'document.write('],
    [/\.(?:innerHTML|outerHTML)\s*=/, 'присваивание innerHTML/outerHTML'],
    [/insertAdjacentHTML\s*\(/, 'insertAdjacentHTML('],
    [/<script[^>]+src=["']https?:/i, 'внешний <script src>'],
  ];
  for (const file of walk(dir)) {
    if (!/\.(js|html|css|json)$/.test(file)) continue;
    const text = readFileSync(file, 'utf8');
    for (const [re, label] of rules) if (re.test(text)) errors.push(`${file.slice(dir.length + 1)}: ${label}`);
  }
  return errors;
}
