// Определение реального формата и размеров изображения по байтам; SHA-256.

const u16be = (b, i) => (b[i] << 8) | b[i + 1];
const u32be = (b, i) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
const ascii = (b, i, n) => String.fromCharCode(...b.subarray(i, i + n));

/** @returns {{format:'png'|'jpeg'|'webp'|'gif', mime:string, width:number, height:number}|null} */
export function sniffImage(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b.length < 16) return null;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) {
    if (ascii(b, 12, 4) !== 'IHDR') return null;
    return ok('png', 'image/png', u32be(b, 16), u32be(b, 20));
  }
  if (b[0] === 0xff && b[1] === 0xd8) return sniffJpeg(b);
  if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') return sniffWebp(b);
  if (ascii(b, 0, 3) === 'GIF' && (ascii(b, 3, 3) === '87a' || ascii(b, 3, 3) === '89a')) return ok('gif', 'image/gif', b[6] | (b[7] << 8), b[8] | (b[9] << 8));
  return null;
}

function ok(format, mime, width, height) {
  return width > 0 && height > 0 ? { format, mime, width, height } : null;
}

function sniffJpeg(b) {
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null;
    let marker = b[i + 1];
    while (marker === 0xff && i + 2 < b.length) {
      i += 1;
      marker = b[i + 1];
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) return ok('jpeg', 'image/jpeg', u16be(b, i + 7), u16be(b, i + 5));
    i += 2 + u16be(b, i + 2);
  }
  return null;
}

function sniffWebp(b) {
  const kind = ascii(b, 12, 4);
  if (kind === 'VP8 ' && b.length >= 30) return ok('webp', 'image/webp', (b[26] | (b[27] << 8)) & 0x3fff, (b[28] | (b[29] << 8)) & 0x3fff);
  if (kind === 'VP8L' && b.length >= 25) {
    const bits = (b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24)) >>> 0;
    return ok('webp', 'image/webp', (bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
  }
  if (kind === 'VP8X' && b.length >= 30) {
    return ok('webp', 'image/webp', 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), 1 + (b[27] | (b[28] << 8) | (b[29] << 16)));
  }
  return null;
}

export async function sha256Hex(input) {
  const data = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  const digest = await globalThis.crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((x) => x.toString(16).padStart(2, '0')).join('');
}
