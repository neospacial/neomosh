// Synthetic test content (plan §13.1): moving gradients, moving noise, a moving square on a flat
// field, a pan, a zoom, and a scene change. Each generator returns coded-size Y, U, V planes.

import { padPlane } from '../../src/codec/color.js';
import { align16 } from '../../src/codec/headers.js';

function hash(x, y, seed) {
  let h = (x * 374761393 + y * 668265263 + seed * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) & 255;
}

// A smooth texture with detail: sines plus bilinear value noise.
function texture(x, y, seed) {
  const xi = Math.floor(x / 4), yi = Math.floor(y / 4);
  const fx = x / 4 - xi, fy = y / 4 - yi;
  const a = hash(xi, yi, seed), b = hash(xi + 1, yi, seed), c = hash(xi, yi + 1, seed), d = hash(xi + 1, yi + 1, seed);
  const n = a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + d * fx * fy;
  return 0.5 * n + 60 * Math.sin(x / 11 + seed) * Math.cos(y / 13) + 64;
}

const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));

// Make planes from sample functions fy(x, y) and fu/fv(x, y) (chroma coordinates).
export function makeFrame(w, h, fy, fu, fv) {
  const cw = align16(w), ch = align16(h);
  const Y = new Uint8Array(cw * ch), U = new Uint8Array((cw * ch) >> 2), V = new Uint8Array((cw * ch) >> 2);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) Y[y * cw + x] = clamp(fy(x, y));
  for (let y = 0; y < h >> 1; y++) {
    for (let x = 0; x < w >> 1; x++) {
      U[y * (cw >> 1) + x] = clamp(fu(x, y));
      V[y * (cw >> 1) + x] = clamp(fv(x, y));
    }
  }
  padPlane(Y, w, h, cw, ch);
  padPlane(U, w >> 1, h >> 1, cw >> 1, ch >> 1);
  padPlane(V, w >> 1, h >> 1, cw >> 1, ch >> 1);
  return { Y, U, V };
}

const tri = (v) => {
  const m = ((v % 512) + 512) % 512;
  return m < 256 ? m : 511 - m;
};

export const CONTENT = {
  gradient: (w, h, t) =>
    makeFrame(w, h,
      (x, y) => 16 + (tri(x * 3 + y * 2 + t * 9) * 219) / 255,
      (x, y) => 128 + 50 * Math.sin((x + t * 2) / 9),
      (x, y) => 128 + 50 * Math.cos((y - t) / 7)),
  noise: (w, h, t) =>
    makeFrame(w, h,
      (x, y) => hash(x - t * 3, y - t, 7),
      (x, y) => 64 + (hash(x - ((t * 3) >> 1), y, 8) >> 1),
      (x, y) => 64 + (hash(x, y - t, 9) >> 1)),
  square: (w, h, t, opt = {}) => {
    const sp = opt.speed ?? 5;
    const size = opt.size ?? 24;
    const sx = 8 + ((t * sp) % Math.max(1, w - size - 16)), sy = 6 + ((t * Math.ceil(sp / 2)) % Math.max(1, h - size - 12));
    const inSq = (x, y) => x >= sx && x < sx + size && y >= sy && y < sy + size;
    return makeFrame(w, h,
      (x, y) => (inSq(x, y) ? texture(x - sx, y - sy, 3) : 80),
      (x, y) => (inSq(2 * x, 2 * y) ? 90 + hash(x, y, 4) / 8 : 128),
      (x, y) => (inSq(2 * x, 2 * y) ? 170 : 128));
  },
  pan: (w, h, t, opt = {}) => {
    const vx = opt.vx ?? 2.5, vy = opt.vy ?? 1.25;
    return makeFrame(w, h,
      (x, y) => texture(x + t * vx, y + t * vy, 1),
      (x, y) => 128 + 0.4 * (texture(2 * x + t * vx, 2 * y + t * vy, 2) - 128),
      (x, y) => 128 + 0.4 * (texture(2 * x + t * vx, 2 * y + t * vy, 5) - 128));
  },
  zoom: (w, h, t) => {
    const s = 1 - 0.03 * t, cx = w / 2, cy = h / 2;
    return makeFrame(w, h,
      (x, y) => texture(cx + (x - cx) * s, cy + (y - cy) * s, 1),
      (x, y) => 128 + 0.4 * (texture(cx + (2 * x - cx) * s, cy + (2 * y - cy) * s, 2) - 128),
      (x, y) => 128 + 0.4 * (texture(cx + (2 * x - cx) * s, cy + (2 * y - cy) * s, 5) - 128));
  },
  still: (w, h) =>
    makeFrame(w, h,
      (x, y) => texture(x, y, 11),
      (x, y) => 128 + 0.4 * (texture(2 * x, 2 * y, 12) - 128),
      (x, y) => 128 + 0.4 * (texture(2 * x, 2 * y, 13) - 128)),
  // Scene A for the first half, then scene B (the encoder must not insert an I-frame, R-01).
  sceneChange: (w, h, t, opt = {}) => (t < (opt.cutAt ?? 4) ? CONTENT.pan(w, h, t) : CONTENT.noise(w, h, t)),
};
