'use strict';

/**
 * Generates build/icon.ico, build/icon.png and build/tray.ico.
 *
 *   node build/make-icons.js        (or: npm run icons)
 *
 * Artwork is drawn by maths rather than scaled from one bitmap, so every size
 * in the ICO is rendered natively and stays crisp.
 *
 * Two glyphs:
 *   - "board"  a 7-hex TFT board cluster, used at 32px and up
 *   - "cell"   one hollow board cell, used at 16/24px and for the tray, where
 *              seven hexes turn to mush
 *
 * ICO format note: entries are written as uncompressed DIBs, not PNGs. A
 * PNG-compressed ICO is legal and works in many places, but Explorer will not
 * decode one for a desktop shortcut icon and silently falls back to the
 * generic exe icon. Only the 256px entry stays PNG (universally supported at
 * that size, and a DIB there would be 256 KB).
 */

const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const SQ3 = Math.sqrt(3);
const OUT = __dirname;

/* -------------------------------------------------------------- drawing */

function canvas(S) {
  const buf = Buffer.alloc(S * S * 4, 0);

  const blend = (x, y, r, g, b, a) => {
    if (x < 0 || y < 0 || x >= S || y >= S || a <= 0) return;
    const i = (y * S + x) * 4;
    const sa = a / 255, da = buf[i + 3] / 255, oa = sa + da * (1 - sa);
    if (oa === 0) return;
    buf[i]     = Math.round((r * sa + buf[i]     * da * (1 - sa)) / oa);
    buf[i + 1] = Math.round((g * sa + buf[i + 1] * da * (1 - sa)) / oa);
    buf[i + 2] = Math.round((b * sa + buf[i + 2] * da * (1 - sa)) / oa);
    buf[i + 3] = Math.round(oa * 255);
  };

  // 4x4 supersampled coverage of any shape given a point-inside predicate.
  const each = (x0, y0, x1, y1, inside, fn) => {
    for (let py = Math.floor(y0); py <= Math.ceil(y1); py++) {
      for (let px = Math.floor(x0); px <= Math.ceil(x1); px++) {
        let hit = 0;
        for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) {
          if (inside(px + (sx + 0.5) / 4, py + (sy + 0.5) / 4)) hit++;
        }
        if (hit) fn(px, py, hit / 16);
      }
    }
  };

  const hexIn = (cx, cy, R) => (fx, fy) => {
    const dx = Math.abs(fx - cx), dy = Math.abs(fy - cy);
    return dy <= (SQ3 / 2) * R && (SQ3 / 2) * dx + 0.5 * dy <= (SQ3 / 2) * R;
  };

  return {
    buf,
    hex(cx, cy, R, [r, g, b, a = 255]) {
      each(cx - R, cy - R, cx + R, cy + R, hexIn(cx, cy, R),
        (x, y, cov) => blend(x, y, r, g, b, Math.round(a * cov)));
    },
    /** Punch a hexagonal hole, so the shape works on any background. */
    clearHex(cx, cy, R) {
      each(cx - R, cy - R, cx + R, cy + R, hexIn(cx, cy, R), (x, y, cov) => {
        const i = (y * S + x) * 4;
        buf[i + 3] = Math.round(buf[i + 3] * (1 - cov));
      });
    },
    roundRect(x, y, w, h, rad, [r, g, b, a = 255]) {
      const inside = (fx, fy) => {
        if (fx < x || fy < y || fx > x + w || fy > y + h) return false;
        const cx = Math.min(Math.max(fx, x + rad), x + w - rad);
        const cy = Math.min(Math.max(fy, y + rad), y + h - rad);
        return (fx - cx) ** 2 + (fy - cy) ** 2 <= rad * rad;
      };
      each(x, y, x + w, y + h, inside,
        (px, py, cov) => blend(px, py, r, g, b, Math.round(a * cov)));
    },
  };
}

const GOLD_TOP = [255, 216, 130];
const GOLD_BOTTOM = [176, 130, 56];
const BLUE = [92, 140, 255];
const NAVY = [20, 26, 42];

/** 7-hex board cluster on a dark rounded tile. */
function board(S) {
  const c = canvas(S);
  c.roundRect(0, 0, S, S, S * 0.22, NAVY);

  const R = S * 0.137;
  const step = SQ3 * R;
  const draw = R * 0.92;
  const m = S / 2;
  for (let k = 0; k < 6; k++) {
    const a = (Math.PI / 180) * (30 + 60 * k);
    const y = m + step * Math.sin(a);
    c.hex(m + step * Math.cos(a), y, draw, y < m ? GOLD_TOP : GOLD_BOTTOM);
  }
  c.hex(m, m, draw, BLUE);
  c.hex(m, m, draw * 0.42, [235, 243, 255]);
  return c.buf;
}

/** One hollow board cell on a transparent background. */
function cell(S) {
  const c = canvas(S);
  const m = S / 2;
  c.hex(m, m, S * 0.46, GOLD_TOP);
  c.clearHex(m, m, S * 0.34);
  c.hex(m, m, S * 0.20, BLUE);
  return c.buf;
}

/* --------------------------------------------------------------- encoders */

const CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let x = n;
    for (let k = 0; k < 8; k++) x = x & 1 ? 0xedb88320 ^ (x >>> 1) : x >>> 1;
    t[n] = x;
  }
  return t;
})();

function png(S, rgba) {
  const crc32 = (b) => {
    let x = -1;
    for (let i = 0; i < b.length; i++) x = CRC[(x ^ b[i]) & 0xff] ^ (x >>> 8);
    return (x ^ -1) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const raw = Buffer.alloc((S * 4 + 1) * S);
  for (let y = 0; y < S; y++) rgba.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Uncompressed 32-bit DIB as an ICO expects it: BGRA, bottom-up, + AND mask. */
function dib(S, rgba) {
  const hdr = Buffer.alloc(40);
  hdr.writeUInt32LE(40, 0);
  hdr.writeInt32LE(S, 4);
  hdr.writeInt32LE(S * 2, 8);   // doubled height: colour rows then mask rows
  hdr.writeUInt16LE(1, 12);     // planes
  hdr.writeUInt16LE(32, 14);    // bits per pixel
  hdr.writeUInt32LE(0, 16);     // BI_RGB, uncompressed

  const xor = Buffer.alloc(S * S * 4);
  for (let y = 0; y < S; y++) {
    const src = (S - 1 - y) * S * 4;
    for (let x = 0; x < S; x++) {
      const s = src + x * 4, d = (y * S + x) * 4;
      xor[d] = rgba[s + 2]; xor[d + 1] = rgba[s + 1];
      xor[d + 2] = rgba[s]; xor[d + 3] = rgba[s + 3];
    }
  }
  // 32-bit icons use the alpha channel; an all-zero AND mask means "opaque".
  const and = Buffer.alloc(Math.ceil(S / 32) * 4 * S, 0);
  hdr.writeUInt32LE(xor.length + and.length, 20);
  return Buffer.concat([hdr, xor, and]);
}

function ico(entries) {
  const head = Buffer.alloc(6);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(entries.length, 4);
  let off = 6 + 16 * entries.length;
  const dirs = entries.map(({ size, data }) => {
    const d = Buffer.alloc(16);
    d[0] = size >= 256 ? 0 : size;   // 0 means 256
    d[1] = size >= 256 ? 0 : size;
    d.writeUInt16LE(1, 4);
    d.writeUInt16LE(32, 6);
    d.writeUInt32LE(data.length, 8);
    d.writeUInt32LE(off, 12);
    off += data.length;
    return d;
  });
  return Buffer.concat([head, ...dirs, ...entries.map((e) => e.data)]);
}

/* ----------------------------------------------------------------- output */

// Small sizes get the single cell; 32px and up get the full board.
const appIcon = [16, 24, 32, 48, 64, 128, 256].map((size) => {
  const rgba = size >= 32 ? board(size) : cell(size);
  return { size, data: size === 256 ? png(size, rgba) : dib(size, rgba) };
});
const trayIcon = [16, 20, 24, 32, 48, 64].map((size) => ({ size, data: dib(size, cell(size)) }));

fs.writeFileSync(path.join(OUT, 'icon.ico'), ico(appIcon));
fs.writeFileSync(path.join(OUT, 'icon.png'), png(256, board(256)));
fs.writeFileSync(path.join(OUT, 'tray.ico'), ico(trayIcon));

console.log('icon.ico  ', appIcon.map((e) => e.size).join('/'));
console.log('tray.ico  ', trayIcon.map((e) => e.size).join('/'));
console.log('icon.png   256');
