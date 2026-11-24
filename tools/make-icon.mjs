// Generates build/icon.png and build/icon.ico (256x256, PNG-compressed ICO).
// No image libraries: raw RGBA -> zlib -> PNG chunks -> ICO container.
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';

const S = 256;
const OUT = path.join(process.cwd(), 'build');
fs.mkdirSync(OUT, { recursive: true });

const clamp01 = (v) => Math.min(1, Math.max(0, v));
const smooth = (edge0, edge1, x) => {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
};
const mix = (a, b, t) => a + (b - a) * t;

function sample(x, y) {
  // rounded-square background
  const r = 46;
  const dx = Math.abs(x - S / 2) - (S / 2 - r);
  const dy = Math.abs(y - S / 2) - (S / 2 - r);
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0) - r;
  const bgA = 1 - smooth(-1.2, 1.2, outside);
  if (bgA <= 0) return [0, 0, 0, 0];

  // vertical teal gradient
  const t = clamp01(y / S);
  let cr = mix(6, 16, t);
  let cg = mix(26, 62, t);
  let cb = mix(34, 72, t);

  // diamond (matches the in-game logo mark)
  const ax = Math.abs(x - 128) / 74;
  const ay = Math.abs(y - 128) / 96;
  const d = ax + ay;
  const glow = Math.exp(-Math.pow((d - 1) * 6, 2)) * 0.55;
  cr = mix(cr, 94, glow);
  cg = mix(cg, 242, glow);
  cb = mix(cb, 208, glow);

  const inner = 1 - smooth(0.94, 1.02, d);
  if (inner > 0) {
    const shade = mix(1, 0.55, clamp01((y - 60) / 150));
    const r0 = mix(94, 60, 1 - shade);
    cr = mix(cr, r0, inner);
    cg = mix(cg, mix(242, 180, 1 - shade), inner);
    cb = mix(cb, mix(208, 175, 1 - shade), inner);
  }

  // small highlight dot in the diamond's upper third
  const dot = 1 - smooth(9, 12, Math.hypot(x - 128, y - 104));
  if (dot > 0) {
    cr = mix(cr, 236, dot * 0.9);
    cg = mix(cg, 255, dot * 0.9);
    cb = mix(cb, 250, dot * 0.9);
  }

  return [cr, cg, cb, bgA * 255];
}

const px = Buffer.alloc(S * S * 4);
const SS = 3;
for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const [rr, gg, bb, aa] = sample(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS);
        r += rr * aa; g += gg * aa; b += bb * aa; a += aa;
      }
    }
    const n = SS * SS;
    const alpha = a / n;
    const i = (y * S + x) * 4;
    if (alpha > 0.5) {
      px[i] = Math.round(Math.min(255, r / a));
      px[i + 1] = Math.round(Math.min(255, g / a));
      px[i + 2] = Math.round(Math.min(255, b / a));
      px[i + 3] = Math.round(Math.min(255, alpha));
    }
  }
}

// ---- PNG ----
const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  crcTable[n] = c >>> 0;
}
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
};

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0);
ihdr.writeUInt32BE(S, 4);
ihdr[8] = 8;   // bit depth
ihdr[9] = 6;   // RGBA
const rawRows = Buffer.alloc((S * 4 + 1) * S);
for (let y = 0; y < S; y++) {
  rawRows[y * (S * 4 + 1)] = 0;
  px.copy(rawRows, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4);
}
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(rawRows, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

// ---- ICO (single 256px PNG frame) ----
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(1, 4);
const entry = Buffer.alloc(16);
entry[0] = 0; // 256
entry[1] = 0;
entry[4] = 1;
entry[6] = 32;
entry.writeUInt32LE(png.length, 8);
entry.writeUInt32LE(22, 12);
const ico = Buffer.concat([header, entry, png]);

fs.writeFileSync(path.join(OUT, 'icon.png'), png);
fs.writeFileSync(path.join(OUT, 'icon.ico'), ico);
console.log(`wrote build/icon.ico (${ico.length} bytes) and build/icon.png (${png.length} bytes)`);
