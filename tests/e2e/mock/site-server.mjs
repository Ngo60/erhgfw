// Static HTTPS server for the built promts.vibecods.xyz site (Vite `dist`), with the real site's security headers.
import https from 'node:https';
import fs from 'node:fs/promises';
import path from 'node:path';
import { makeCerts } from './certs.mjs';

// Mirrors deploy/nginx.conf of the real site, plus the HSTS header Caddy adds in front of it.
export const SECURITY_HEADERS = {
  'content-security-policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
};

/**
 * @param {{dir: string, port?: number, certs?: {key: string, cert: string}}} opts
 * @returns {Promise<{url: string, port: number, stop: () => Promise<void>}>}
 */
export async function startStaticSite({ dir, port = 0, certs }) {
  if (!dir) throw new TypeError('startStaticSite: dir is required');
  certs ??= await makeCerts();
  const root = path.resolve(dir);

  async function readFileIn(relPath) {
    const abs = path.resolve(root, '.' + path.sep + relPath);
    const rel = path.relative(root, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
    try {
      const stat = await fs.stat(abs);
      return stat.isFile() ? { body: await fs.readFile(abs), ext: path.extname(abs).toLowerCase() } : null;
    } catch {
      return null;
    }
  }

  async function handle(req, res) {
    const send = (status, headers, body) => {
      const buf = Buffer.isBuffer(body) ? body : Buffer.from(body ?? '');
      res.writeHead(status, {
        ...SECURITY_HEADERS,
        'cache-control': 'no-cache',
        'content-length': buf.length,
        ...headers,
      });
      res.end(req.method === 'HEAD' ? undefined : buf);
    };
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return send(405, { allow: 'GET, HEAD', 'content-type': 'text/plain; charset=utf-8' }, 'Method Not Allowed\n');
    }
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url, 'https://localhost').pathname);
    } catch {
      return send(400, { 'content-type': 'text/plain; charset=utf-8' }, 'Bad Request\n');
    }
    if (pathname.includes('\0')) return send(400, { 'content-type': 'text/plain; charset=utf-8' }, 'Bad Request\n');
    if (pathname === '/healthz') return send(200, { 'content-type': 'text/plain; charset=utf-8' }, 'ok\n');

    const wantsIndex = pathname.endsWith('/');
    let file = wantsIndex ? await readFileIn(pathname.slice(1) + 'index.html') : await readFileIn(pathname.slice(1));
    if (!file && !path.extname(pathname)) file = await readFileIn('index.html'); // SPA fallback
    if (!file) return send(404, { 'content-type': 'text/plain; charset=utf-8' }, 'Not Found\n');
    return send(200, { 'content-type': MIME[file.ext] ?? 'application/octet-stream' }, file.body);
  }

  const server = https.createServer({ key: certs.key, cert: certs.cert }, (req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Internal Server Error\n');
    });
  });
  server.on('tlsClientError', () => {});
  server.on('clientError', (_err, socket) => socket.destroy());
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const actualPort = server.address().port;

  return {
    url: `https://localhost:${actualPort}`,
    port: actualPort,
    stop: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}
