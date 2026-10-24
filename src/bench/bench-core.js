// Benchmark core (plan §13.5): encoder and decoder ms per frame for each size and setting.
// It runs in Node (tools/bench.mjs) and in a browser worker (dist/neomosh-bench-v*.html).

import { Encoder, DEFAULT_SETTINGS } from '../codec/encoder.js';
import { Decoder } from '../codec/decoder.js';
import { Kernels } from '../codec/wasm.js';

export const BENCH_SIZES = [
  [480, 360], [640, 360],
  [640, 480], [852, 480],
  [960, 720], [1280, 720],
];

export const BENCH_PRESETS = [
  { name: 'Fast (Full, ±8)', settings: { ...DEFAULT_SETTINGS, precision: 'full', searchRange: 8 } },
  { name: 'Default (Half, ±32)', settings: { ...DEFAULT_SETTINGS } },
  { name: 'Max (Quarter, ±64)', settings: { ...DEFAULT_SETTINGS, precision: 'quarter', searchRange: 64 } },
];

function benchHash(x, y) {
  let h = Math.imul(x, 374761393) + Math.imul(y, 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h ^ (h >>> 16)) >>> 0;
}

// A large RGBA texture. Each frame is a moving window of it (a pan), plus a square that moves faster.
function makeTexture(tw, th) {
  const t = new Uint8Array(tw * th * 4);
  for (let y = 0; y < th; y++) {
    for (let x = 0; x < tw; x++) {
      const o = (y * tw + x) * 4;
      const n = benchHash(x >> 2, y >> 2) & 63;
      t[o] = 110 + 70 * Math.sin(x / 23) + n;
      t[o + 1] = 110 + 70 * Math.cos(y / 19) + n;
      t[o + 2] = 110 + 70 * Math.sin((x + y) / 31) + n;
      t[o + 3] = 255;
    }
  }
  return t;
}

// Sensor noise (about sigma 3, like a phone camera indoors): without it, the encoder can skip most
// blocks, and the benchmark is too optimistic.
const NOISE = new Int8Array(1 << 20);
{
  let s = 12345;
  for (let i = 0; i < NOISE.length; i++) {
    let g = 0;
    for (let k = 0; k < 4; k++) g += ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) >>> 24) / 255;
    NOISE[i] = Math.round((g - 2) * 5.2);
  }
}

function makeFrame(tex, tw, w, h, t, out) {
  const ox = (t * 3) % 160, oy = (t * 2) % 80;
  for (let y = 0; y < h; y++) {
    const s = ((y + oy) * tw + ox) * 4;
    out.set(tex.subarray(s, s + w * 4), y * w * 4);
  }
  const size = h >> 2;
  const sx = (t * 11) % (w - size), sy = (t * 5) % (h - size);
  for (let y = 0; y < size; y++) {
    const s = ((y + 40) * tw + 40) * 4;
    out.set(tex.subarray(s, s + size * 4), ((sy + y) * w + sx) * 4);
  }
  const off = (t * 7919) & (NOISE.length - 1 - 4096);
  for (let i = 0; i < out.length; i++) {
    if ((i & 3) === 3) continue;
    const v = out[i] + NOISE[(off + (i >> 2) + (i & 3) * 1031) & (NOISE.length - 1)];
    out[i] = v < 0 ? 0 : v > 255 ? 255 : v;
  }
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

// Run one case. Returns { w, h, preset, encMs, encP95, decMs, kbPerFrame }.
export function benchCase(w, h, preset, frames = 30) {
  const tw = w + 200, th = h + 100;
  const tex = makeTexture(tw, th);
  const rgba = new Uint8Array(w * h * 4);
  const enc = new Encoder(w, h, preset.settings);
  const dec = new Decoder(w, h);
  const encT = [];
  const decT = [];
  let bits = 0;
  for (let t = 0; t <= frames; t++) {
    makeFrame(tex, tw, w, h, t, rgba);
    const t0 = now();
    const [Y, U, V] = enc.inputFromRgba(rgba);
    const pkt = enc.encode(Y, U, V);
    const t1 = now();
    dec.decodePacket(pkt);
    const t2 = now();
    // Frame 0 is the IDR (I_PCM). Measure only the P-frames.
    if (t > 0) {
      encT.push(t1 - t0);
      decT.push(t2 - t1);
      bits += pkt.bitLen;
    }
  }
  const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const sorted = encT.slice().sort((a, b) => a - b);
  return {
    w, h, preset: preset.name,
    encMs: avg(encT),
    encP95: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))],
    decMs: avg(decT),
    kbPerFrame: bits / frames / 8 / 1024,
  };
}

// The encoder and the decoder run in separate workers (R-06), so the encoder sets the frame rate.
export function verdict(r) {
  const fps = 1000 / r.encP95;
  return fps >= 30 ? '30 fps OK' : fps >= 24 ? '24 fps OK' : fps >= 15 ? '15 fps OK' : 'too slow';
}

export const usesWasm = () => !!Kernels.create();

export function formatResults(results, header = '') {
  const lines = [header, 'size        preset                enc ms  enc p95  dec ms  KB/frame  verdict'];
  for (const r of results) {
    lines.push(
      `${(r.w + 'x' + r.h).padEnd(11)} ${r.preset.padEnd(21)} ${r.encMs.toFixed(1).padStart(6)}  ${r.encP95.toFixed(1).padStart(7)}  ` +
      `${r.decMs.toFixed(1).padStart(6)}  ${r.kbPerFrame.toFixed(1).padStart(8)}  ${verdict(r)}`,
    );
  }
  return lines.filter((l) => l !== '').join('\n');
}
