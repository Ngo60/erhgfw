// Генератор иконок расширения (без зависимостей): растр с суперсэмплингом → PNG. Запуск: node scripts/make-icons.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { crc32 } from './lib/crc32.mjs';

const OUT = fileURLToPath(new URL('../source/extension/icons/', import.meta.url));
const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const A = hex('#4f46e5');
const B = hex('#0ea5e9');
const INK = hex('#312e81');

const inRound = (u, v, x0, y0, x1, y1, r) => {
  if (u < x0 || u > x1 || v < y0 || v > y1) return false;
  const cx = Math.min(Math.max(u, x0 + r), x1 - r);
  const cy = Math.min(Math.max(v, y0 + r), y1 - r);
  return (u - cx) ** 2 + (v - cy) ** 2 <= r * r;
};
const inTri = (u, v, [ax, ay], [bx, by], [cx, cy]) => {
  const d = (px, py, qx, qy, rx, ry) => (px - rx) * (qy - ry) - (qx - rx) * (py - ry);
  const d1 = d(u, v, ax, ay, bx, by);
  const d2 = d(u, v, bx, by, cx, cy);
  const d3 = d(u, v, cx, cy, ax, ay);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
};

function sample(u, v) {
  if (!inRound(u, v, 0, 0, 1, 1, 0.22)) return null;
  const t = v;
  let c = [0, 1, 2].map((i) => A[i] + (B[i] - A[i]) * t);
  if (inRound(u, v, 0.18, 0.16, 0.82, 0.68, 0.07)) {
    c = [255, 255, 255];
    if ((u - 0.38) ** 2 + (v - 0.32) ** 2 < 0.065 ** 2) c = INK;
    if (inTri(u, v, [0.24, 0.62], [0.45, 0.4], [0.66, 0.62]) || inTri(u, v, [0.5, 0.62], [0.65, 0.47], [0.77, 0.62])) c = INK;
  }
  for (const x of [0.33, 0.5, 0.67]) if ((u - x) ** 2 + (v - 0.83) ** 2 < 0.04 ** 2) c = [255, 255, 255];
  return c;
}

function png(size) {
  const S = 4;
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < S; sy++) for (let sx = 0; sx < S; sx++) {
        const c = sample((x + (sx + 0.5) / S) / size, (y + (sy + 0.5) / S) / size);
        if (c) { r += c[0]; g += c[1]; b += c[2]; a += 1; }
      }
      const o = y * (size * 4 + 1) + 1 + x * 4;
      const n = S * S;
      raw[o] = a ? Math.round(r / a) : 0;
      raw[o + 1] = a ? Math.round(g / a) : 0;
      raw[o + 2] = a ? Math.round(b / a) : 0;
      raw[o + 3] = Math.round((255 * a) / n);
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

mkdirSync(OUT, { recursive: true });
for (const s of [16, 32, 48, 128]) writeFileSync(`${OUT}icon${s}.png`, png(s));
console.log('icons written to', OUT);
