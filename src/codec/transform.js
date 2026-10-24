// 4x4 integer transform, quantization, dequantization, chroma DC transform, and macroblock
// reconstruction. References: H.264 8.5.11 (chroma DC), 8.5.12 (scaling and inverse transform).
// R-05, R-11: the encoder reconstruction and the decoder call the same functions in this file.

import { QUANT_MF, DEQUANT_V, POS_CLASS, CHROMA_QP } from './tables.js';

const tmp16 = new Int32Array(16);

// Forward core transform (encoder only). In: residual r (raster 4x4). Out: w (raster 4x4).
export function forward4x4(r, w) {
  const t = tmp16;
  for (let y = 0; y < 4; y++) {
    const o = y * 4;
    const a = r[o], b = r[o + 1], c = r[o + 2], d = r[o + 3];
    const s03 = a + d, d03 = a - d, s12 = b + c, d12 = b - c;
    t[o] = s03 + s12;
    t[o + 1] = 2 * d03 + d12;
    t[o + 2] = s03 - s12;
    t[o + 3] = d03 - 2 * d12;
  }
  for (let x = 0; x < 4; x++) {
    const a = t[x], b = t[4 + x], c = t[8 + x], d = t[12 + x];
    const s03 = a + d, d03 = a - d, s12 = b + c, d12 = b - c;
    w[x] = s03 + s12;
    w[4 + x] = 2 * d03 + d12;
    w[8 + x] = s03 - s12;
    w[12 + x] = d03 - 2 * d12;
  }
}

// Quantize (encoder only, inter rounding f = 2^qbits / 6). Coefficients from index `first` (0 or 1).
// Writes the levels in raster order to z. Returns the count of nonzero levels.
export function quant4x4(w, qp, z, first) {
  const qbits = 15 + ((qp / 6) | 0);
  const f = ((1 << qbits) / 6) | 0;
  const mf = QUANT_MF[qp % 6];
  let nz = 0;
  if (first) z[0] = 0;
  for (let i = first; i < 16; i++) {
    const v = w[i];
    const a = v < 0 ? -v : v;
    const q = (a * mf[POS_CLASS[i]] + f) >> qbits;
    z[i] = v < 0 ? -q : q;
    if (q) nz++;
  }
  return nz;
}

// Scaling of 4x4 levels (8.5.12.1, flat matrices). Index 0 is not scaled when skipDC is set
// (chroma: d[0] is the chroma DC value from 8.5.11). Writes d (raster).
export function dequant4x4(c, qp, d, skipDC) {
  const v = DEQUANT_V[qp % 6];
  const sh = (qp / 6) | 0;
  for (let i = skipDC ? 1 : 0; i < 16; i++) d[i] = (c[i] * v[POS_CLASS[i]]) << sh;
}

// Inverse transform (8.5.12.2) and add the prediction: dst = clip(pred + ((h + 32) >> 6)).
// Rows first, then columns. d is changed.
export function idct4x4Add(d, pred, pOff, pStride, dst, dOff, dStride) {
  for (let y = 0; y < 4; y++) {
    const o = y * 4;
    const d0 = d[o], d1 = d[o + 1], d2 = d[o + 2], d3 = d[o + 3];
    const e0 = d0 + d2, e1 = d0 - d2, e2 = (d1 >> 1) - d3, e3 = d1 + (d3 >> 1);
    d[o] = e0 + e3;
    d[o + 1] = e1 + e2;
    d[o + 2] = e1 - e2;
    d[o + 3] = e0 - e3;
  }
  for (let x = 0; x < 4; x++) {
    const d0 = d[x], d1 = d[4 + x], d2 = d[8 + x], d3 = d[12 + x];
    const e0 = d0 + d2, e1 = d0 - d2, e2 = (d1 >> 1) - d3, e3 = d1 + (d3 >> 1);
    const r0 = (e0 + e3 + 32) >> 6, r1 = (e1 + e2 + 32) >> 6, r2 = (e1 - e2 + 32) >> 6, r3 = (e0 - e3 + 32) >> 6;
    let p = pOff + x, q = dOff + x, s;
    s = pred[p] + r0; dst[q] = s < 0 ? 0 : s > 255 ? 255 : s; p += pStride; q += dStride;
    s = pred[p] + r1; dst[q] = s < 0 ? 0 : s > 255 ? 255 : s; p += pStride; q += dStride;
    s = pred[p] + r2; dst[q] = s < 0 ? 0 : s > 255 ? 255 : s; p += pStride; q += dStride;
    s = pred[p] + r3; dst[q] = s < 0 ? 0 : s > 255 ? 255 : s;
  }
}

// 2x2 Hadamard: f = [[1,1],[1,-1]] * c * [[1,1],[1,-1]], raster order.
export function hadamard2x2(c, f) {
  const c0 = c[0], c1 = c[1], c2 = c[2], c3 = c[3];
  f[0] = c0 + c1 + c2 + c3;
  f[1] = c0 - c1 + c2 - c3;
  f[2] = c0 + c1 - c2 - c3;
  f[3] = c0 - c1 - c2 + c3;
}

// Chroma DC quantization (encoder only). In: f = Hadamard of the four block DC values.
export function quantChromaDC(f, qpc, z) {
  const qbits = 16 + ((qpc / 6) | 0);
  const r = ((1 << (qbits - 1)) / 6) * 2 | 0;
  const mf = QUANT_MF[qpc % 6][0];
  let nz = 0;
  for (let i = 0; i < 4; i++) {
    const v = f[i];
    const a = v < 0 ? -v : v;
    const q = (a * mf + r) >> qbits;
    z[i] = v < 0 ? -q : q;
    if (q) nz++;
  }
  return nz;
}

const dcTmp = new Int32Array(4);

// Chroma DC scaling (8.5.11.2, 4:2:0): dcC = ((f * LevelScale(qPc % 6, 0, 0)) << (qPc / 6)) >> 5.
export function dequantChromaDC(c, qpc, out) {
  hadamard2x2(c, dcTmp);
  const ls = 16 * DEQUANT_V[qpc % 6][0];
  const sh = (qpc / 6) | 0;
  for (let i = 0; i < 4; i++) out[i] = ((dcTmp[i] * ls) << sh) >> 5;
}

// Residual of one inter macroblock, as levels.
//   luma: 16 blocks x 16 levels. Block b = by*4 + bx. Level i is raster in the block.
//   cbDC, crDC: chroma DC levels c[0..3] (raster 2x2, before the inverse Hadamard).
//   cb, cr: 4 blocks x 16 levels (AC; index 0 is not used).
//   nzLuma[16], nzCb[4], nzCr[4]: TotalCoeff of each block (for nC).
export class MbResidual {
  constructor() {
    this.luma = new Int32Array(256);
    this.cb = new Int32Array(64);
    this.cr = new Int32Array(64);
    this.cbDC = new Int32Array(4);
    this.crDC = new Int32Array(4);
    this.nzLuma = new Uint8Array(16);
    this.nzCb = new Uint8Array(4);
    this.nzCr = new Uint8Array(4);
    this.cbp = 0;
  }
  clear() {
    this.luma.fill(0);
    this.cb.fill(0);
    this.cr.fill(0);
    this.cbDC.fill(0);
    this.crDC.fill(0);
    this.nzLuma.fill(0);
    this.nzCb.fill(0);
    this.nzCr.fill(0);
    this.cbp = 0;
  }
}

const dq = new Int32Array(16);
const dcOut = new Int32Array(4);

// Reconstruct one inter macroblock: prediction + residual (R-11).
// predY: 16x16 (stride 16), predU/predV: 8x8 (stride 8). Writes to the frame planes.
export function reconInterMB(res, qp, predY, predU, predV, Y, yOff, yStride, U, V, cOff, cStride) {
  const cbp = res.cbp;
  for (let b = 0; b < 16; b++) {
    const bx = b & 3, by = b >> 2;
    const pOff = by * 64 + bx * 4;
    const dOff = yOff + by * 4 * yStride + bx * 4;
    const b8 = (by >> 1) * 2 + (bx >> 1);
    if ((cbp >> b8) & 1 && res.nzLuma[b]) {
      dequant4x4(res.luma.subarray(b * 16, b * 16 + 16), qp, dq, false);
      idct4x4Add(dq, predY, pOff, 16, Y, dOff, yStride);
    } else {
      for (let y = 0; y < 4; y++) {
        const p = pOff + y * 16, q = dOff + y * yStride;
        Y[q] = predY[p]; Y[q + 1] = predY[p + 1]; Y[q + 2] = predY[p + 2]; Y[q + 3] = predY[p + 3];
      }
    }
  }
  const cc = cbp >> 4;
  const qpc = CHROMA_QP[qp];
  for (let comp = 0; comp < 2; comp++) {
    const pred = comp ? predV : predU;
    const P = comp ? V : U;
    if (cc === 0) {
      for (let y = 0; y < 8; y++) {
        const p = y * 8, q = cOff + y * cStride;
        for (let x = 0; x < 8; x++) P[q + x] = pred[p + x];
      }
      continue;
    }
    dequantChromaDC(comp ? res.crDC : res.cbDC, qpc, dcOut);
    const ac = comp ? res.cr : res.cb;
    for (let b = 0; b < 4; b++) {
      const bx = b & 1, by = b >> 1;
      if (cc === 2) dequant4x4(ac.subarray(b * 16, b * 16 + 16), qpc, dq, true);
      else dq.fill(0);
      dq[0] = dcOut[b];
      idct4x4Add(dq, pred, by * 32 + bx * 4, 8, P, cOff + by * 4 * cStride + bx * 4, cStride);
    }
  }
}
