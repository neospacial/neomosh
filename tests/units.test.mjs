// Unit tests for the codec building blocks (Phase 1 steps 1, 4, 5).

import { BitWriter, BitReader, rbspToEbsp, ebspToRbsp, extractBits } from '../src/codec/bitio.js';
import { CBP_INTER_FROM_CODE, CBP_INTER_TO_CODE, CHROMA_QP } from '../src/codec/tables.js';
import { writeResidualBlock, readResidualBlock } from '../src/codec/cavlc.js';
import { makeRef, buildRef, predLuma, predChroma } from '../src/codec/inter.js';
import { forward4x4, quant4x4, dequant4x4, idct4x4Add } from '../src/codec/transform.js';
import { chooseLevel, streamParams } from '../src/codec/headers.js';
import { rgbaToYuv420, yuv420ToRgba } from '../src/codec/color.js';
import { assert } from './lib/session.mjs';

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const tests = [
  {
    name: 'Exp-Golomb and fixed-length round trip',
    fn() {
      const r = rng(1);
      const vals = [];
      const bw = new BitWriter(8);
      for (let i = 0; i < 5000; i++) {
        const kind = i % 3;
        const v = kind === 0 ? Math.floor(r() * 70000) : kind === 1 ? Math.floor(r() * 2000) - 1000 : Math.floor(r() * 65536);
        vals.push([kind, v]);
        if (kind === 0) bw.ue(v);
        else if (kind === 1) bw.se(v);
        else bw.u(16, v);
      }
      const br = new BitReader(bw.toBytes(), bw.pos);
      for (const [kind, v] of vals) {
        const g = kind === 0 ? br.ue() : kind === 1 ? br.se() : br.u(16);
        assert(g === v, `value ${v} read as ${g}`);
      }
      assert(br.bitsLeft() === 0, 'bits left');
    },
  },
  {
    name: 'Emulation prevention round trip',
    fn() {
      const cases = [[0, 0, 0], [0, 0, 1], [0, 0, 2], [0, 0, 3], [0, 0, 4], [0, 0, 0, 0, 0, 3, 0, 0], [1, 0, 0, 3, 0, 0, 1]];
      const r = rng(2);
      for (let i = 0; i < 200; i++) cases.push(Array.from({ length: 50 }, () => (r() < 0.6 ? 0 : Math.floor(r() * 5))));
      for (const c of cases) {
        const e = rbspToEbsp(Uint8Array.from(c));
        for (let i = 2; i < e.length; i++) assert(!(e[i - 2] === 0 && e[i - 1] === 0 && e[i] <= 2), 'start code emulation');
        const back = ebspToRbsp(e);
        assert(Buffer.compare(Buffer.from(back), Buffer.from(c)) === 0, `round trip failed for ${c}`);
      }
    },
  },
  {
    name: 'Bit extraction and append at all offsets',
    fn() {
      const r = rng(3);
      const src = Uint8Array.from({ length: 40 }, () => Math.floor(r() * 256));
      for (let from = 0; from < 16; from++) {
        for (const len of [0, 1, 7, 8, 9, 100, 300]) {
          const ex = extractBits(src, from, from + len);
          for (let pre = 0; pre < 9; pre++) {
            const bw = new BitWriter(4);
            bw.u(pre, 0);
            bw.appendBits(ex, len);
            const br = new BitReader(bw.toBytes(), bw.pos);
            br.u(pre);
            const sr = new BitReader(src);
            sr.u(from);
            for (let i = 0; i < len; i++) assert(br.u1() === sr.u1(), `bit ${i} differs (from ${from}, pre ${pre})`);
          }
        }
      }
    },
  },
  {
    name: 'CBP table is a permutation; chroma QP table',
    fn() {
      const seen = new Set(CBP_INTER_FROM_CODE);
      assert(seen.size === 48, 'CBP table has duplicates');
      for (let c = 0; c < 48; c++) assert(CBP_INTER_FROM_CODE[CBP_INTER_TO_CODE[c]] === c, 'CBP inverse');
      assert(CHROMA_QP[29] === 29 && CHROMA_QP[30] === 29 && CHROMA_QP[44] === 37 && CHROMA_QP[51] === 39, 'chroma QP');
    },
  },
  {
    name: 'CAVLC residual block round trip (all nC tables, large levels)',
    fn() {
      const r = rng(4);
      for (let i = 0; i < 20000; i++) {
        const maxNum = [16, 15, 4][i % 3];
        const nC = maxNum === 4 ? -1 : [0, 1, 2, 3, 4, 7, 8, 16][Math.floor(r() * 8)];
        const density = r();
        const coef = new Int32Array(16);
        for (let k = 0; k < maxNum; k++) {
          if (r() < density) {
            const big = r() < 0.1;
            const mag = big ? 1 + Math.floor(r() * 2000) : 1 + Math.floor(r() * r() * 20);
            coef[k] = r() < 0.5 ? -mag : mag;
          }
        }
        const bw = new BitWriter(64);
        const n = writeResidualBlock(bw, coef, maxNum, nC);
        const out = new Int32Array(16);
        const br = new BitReader(bw.toBytes(), bw.pos);
        const m = readResidualBlock(br, out, maxNum, nC);
        assert(n === m, 'TotalCoeff differs');
        assert(br.bitsLeft() === 0, 'bits left');
        for (let k = 0; k < maxNum; k++) assert(out[k] === coef[k], `case ${i}: coefficient ${k}: ${out[k]} != ${coef[k]}`);
      }
    },
  },
  {
    name: 'Transform: quant + dequant + inverse transform approximates the residual',
    fn() {
      const r = rng(5);
      const blk = new Int32Array(16), w = new Int32Array(16), z = new Int32Array(16), d = new Int32Array(16);
      const pred = new Uint8Array(16).fill(128), dst = new Uint8Array(16);
      let sum = 0, max = 0;
      for (let i = 0; i < 1000; i++) {
        for (let k = 0; k < 16; k++) blk[k] = Math.floor(r() * 200) - 100;
        forward4x4(blk, w);
        quant4x4(w, 16, z, 0);
        dequant4x4(z, 16, d, false);
        idct4x4Add(d, pred, 0, 4, dst, 0, 4);
        for (let k = 0; k < 16; k++) {
          const e = Math.abs(dst[k] - 128 - blk[k]);
          sum += e;
          max = Math.max(max, e);
        }
      }
      assert(max <= 8 && sum / 16000 < 2, `reconstruction error too large (max ${max}, mean ${sum / 16000})`);
    },
  },
  {
    name: 'Luma and chroma interpolation equal the direct spec formulas (incl. far outside)',
    fn() {
      const W = 48, H = 32;
      const r = rng(6);
      const Y = Uint8Array.from({ length: W * H }, () => Math.floor(r() * 256));
      const U = Uint8Array.from({ length: (W * H) >> 2 }, () => Math.floor(r() * 256));
      const V = Uint8Array.from({ length: (W * H) >> 2 }, () => Math.floor(r() * 256));
      const ref = makeRef(W, H);
      buildRef(ref, Y, U, V);
      const cl = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
      const G = (x, y) => Y[cl(y, 0, H - 1) * W + cl(x, 0, W - 1)];
      const t6 = (a, b, c, d, e, f) => a - 5 * b + 20 * c + 20 * d - 5 * e + f;
      const c255 = (v) => cl(v, 0, 255);
      const b1 = (x, y) => t6(G(x - 2, y), G(x - 1, y), G(x, y), G(x + 1, y), G(x + 2, y), G(x + 3, y));
      const h1 = (x, y) => t6(G(x, y - 2), G(x, y - 1), G(x, y), G(x, y + 1), G(x, y + 2), G(x, y + 3));
      const b = (x, y) => c255((b1(x, y) + 16) >> 5);
      const h = (x, y) => c255((h1(x, y) + 16) >> 5);
      const j = (x, y) => c255((t6(h1(x - 2, y), h1(x - 1, y), h1(x, y), h1(x + 1, y), h1(x + 2, y), h1(x + 3, y)) + 512) >> 10);
      const av = (p, q) => (p + q + 1) >> 1;
      const spec = (x, y, xf, yf) => {
        switch (yf * 4 + xf) {
          case 0: return G(x, y);
          case 1: return av(G(x, y), b(x, y));
          case 2: return b(x, y);
          case 3: return av(G(x + 1, y), b(x, y));
          case 4: return av(G(x, y), h(x, y));
          case 5: return av(b(x, y), h(x, y));
          case 6: return av(b(x, y), j(x, y));
          case 7: return av(b(x, y), h(x + 1, y));
          case 8: return h(x, y);
          case 9: return av(h(x, y), j(x, y));
          case 10: return j(x, y);
          case 11: return av(j(x, y), h(x + 1, y));
          case 12: return av(G(x, y + 1), h(x, y));
          case 13: return av(h(x, y), b(x, y + 1));
          case 14: return av(j(x, y), b(x, y + 1));
          default: return av(h(x + 1, y), b(x, y + 1));
        }
      };
      const out = new Uint8Array(256), oU = new Uint8Array(64), oV = new Uint8Array(64);
      const C = (P, x, y) => P[cl(y, 0, H / 2 - 1) * (W / 2) + cl(x, 0, W / 2 - 1)];
      for (let i = 0; i < 1500; i++) {
        const far = i % 3 === 0 ? 1200 : 160;
        const mvx = Math.floor(r() * far * 2) - far, mvy = Math.floor(r() * far * 2) - far;
        const bx = 16 * Math.floor(r() * 3), by = 16 * Math.floor(r() * 2);
        predLuma(ref, bx, by, mvx, mvy, 16, 16, out);
        for (let yy = 0; yy < 16; yy++) {
          for (let xx = 0; xx < 16; xx++) {
            const e = spec(bx + xx + (mvx >> 2), by + yy + (mvy >> 2), mvx & 3, mvy & 3);
            assert(out[yy * 16 + xx] === e, `luma mv (${mvx},${mvy}) at (${xx},${yy}): ${out[yy * 16 + xx]} != ${e}`);
          }
        }
        predChroma(ref, bx / 2, by / 2, mvx, mvy, 8, 8, oU, oV);
        const xF = mvx & 7, yF = mvy & 7;
        for (let yy = 0; yy < 8; yy++) {
          for (let xx = 0; xx < 8; xx++) {
            const x = bx / 2 + xx + (mvx >> 3), y = by / 2 + yy + (mvy >> 3);
            for (const [P, o] of [[U, oU], [V, oV]]) {
              const e = ((8 - xF) * (8 - yF) * C(P, x, y) + xF * (8 - yF) * C(P, x + 1, y) +
                (8 - xF) * yF * C(P, x, y + 1) + xF * yF * C(P, x + 1, y + 1) + 32) >> 6;
              assert(o[yy * 8 + xx] === e, `chroma mv (${mvx},${mvy})`);
            }
          }
        }
      }
    },
  },
  {
    name: 'Level selection (plan §6.9)',
    fn() {
      assert(chooseLevel(640, 480, 30) === 30, '640x480@30');
      assert(chooseLevel(864, 480, 30) === 31, '864x480@30 (48600 MB/s)');
      assert(chooseLevel(864, 480, 24) === 30, '864x480@24');
      assert(chooseLevel(1280, 720, 30) === 31, '1280x720@30');
      assert(chooseLevel(1088, 720, 24) === 31, '1088x720@24');
      assert(streamParams(852, 480, 30).codedW === 864, 'coded width');
    },
  },
  {
    name: 'Colour conversion round trip (BT.709 limited range)',
    fn() {
      const w = 34, h = 18, cw = 48, ch = 32;
      const r = rng(7);
      const rgba = new Uint8Array(w * h * 4);
      // Smooth colours, so that the 4:2:0 chroma is a fair test.
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const o = (y * w + x) * 4;
        rgba[o] = 40 + ((x >> 1) * 5) % 180; rgba[o + 1] = 60 + ((y >> 1) * 7) % 150; rgba[o + 2] = 200 - ((x >> 1) * 3) % 150; rgba[o + 3] = 255;
      }
      const Y = new Uint8Array(cw * ch), U = new Uint8Array((cw * ch) >> 2), V = new Uint8Array((cw * ch) >> 2);
      rgbaToYuv420(rgba, w, h, cw, ch, Y, U, V);
      for (let i = 0; i < Y.length; i++) assert(Y[i] >= 16 && Y[i] <= 235, 'Y range');
      assert(Y[5 * cw + 40] === Y[5 * cw + w - 1] && Y[30 * cw + 3] === Y[(h - 1) * cw + 3], 'edge padding');
      const back = new Uint8Array(w * h * 4);
      yuv420ToRgba(Y, U, V, cw, w, h, back);
      let maxErr = 0;
      for (let i = 0; i < back.length; i++) maxErr = Math.max(maxErr, Math.abs(back[i] - rgba[i]));
      assert(maxErr <= 12, `colour round-trip error ${maxErr}`);
      void r;
    },
  },
];
