// Draws the PWA icons (anchor glyph from the mockups on the sidebar navy)
// without any image dependencies. Run: node scripts/make-icons.mjs

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');
const BG = [0x0e, 0x1a, 0x22]; // --nav-bg
const FG = [0xff, 0xff, 0xff]; // --nav-title

const segDist = (px, py, ax, ay, bx, by) => {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
};

/** Distance in icon units (24-unit grid) from a point to the anchor strokes. */
function anchorDist(x, y) {
  const d = [
    segDist(x, y, 12, 6, 12, 20),
    segDist(x, y, 8, 9, 16, 9),
    Math.abs(Math.hypot(x - 12, y - 4.5) - 1.5),
    // Lower semicircle of radius 7 centred at (12, 14).
    y >= 14 ? Math.abs(Math.hypot(x - 12, y - 14) - 7) : Math.min(Math.hypot(x - 5, y - 14), Math.hypot(x - 19, y - 14)),
  ];
  return Math.min(...d);
}

function draw(size, { glyphScale, rounded }) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  const unit = (size * glyphScale) / 24; // pixels per icon unit
  const off = (size - 24 * unit) / 2;
  const half = (1.8 * unit) / 2;
  const radius = rounded ? size * 0.22 : 0;
  for (let py = 0; py < size; py++) {
    raw[py * (size * 4 + 1)] = 0; // filter: none
    for (let px = 0; px < size; px++) {
      const cx = px + 0.5;
      const cy = py + 0.5;
      // Rounded-square mask for the regular icon; full bleed for maskable.
      let alpha = 1;
      if (radius > 0) {
        const qx = Math.max(radius - cx, cx - (size - radius), 0);
        const qy = Math.max(radius - cy, cy - (size - radius), 0);
        alpha = Math.max(0, Math.min(1, radius + 0.5 - Math.hypot(qx, qy)));
      }
      const dist = anchorDist((cx - off) / unit, (cy - off) / unit) * unit;
      const ink = Math.max(0, Math.min(1, half + 0.5 - dist));
      const i = py * (size * 4 + 1) + 1 + px * 4;
      for (let c = 0; c < 3; c++) raw[i + c] = Math.round(BG[c] * (1 - ink) + FG[c] * ink);
      raw[i + 3] = Math.round(alpha * 255);
    }
  }
  return png(size, size, raw);
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([len, body, crc]);
}

function png(w, h, raw) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'icon-192.png'), draw(192, { glyphScale: 0.62, rounded: true }));
writeFileSync(join(OUT, 'icon-512.png'), draw(512, { glyphScale: 0.62, rounded: true }));
// Maskable: glyph inside the 80% safe zone, background to the edges.
writeFileSync(join(OUT, 'maskable-512.png'), draw(512, { glyphScale: 0.5, rounded: false }));
writeFileSync(join(OUT, 'apple-touch-icon.png'), draw(180, { glyphScale: 0.6, rounded: false }));
console.log(`icons written to ${OUT}`);
