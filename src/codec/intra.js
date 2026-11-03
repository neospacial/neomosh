// Intra 16x16 macroblocks (D33): the I-frames are coded, not I_PCM. References: H.264 8.3.3 (Intra_16x16
// prediction), 8.3.4 (chroma intra prediction), 8.5.10 (luma DC transform and scaling), 7.3.5 (syntax).
// The encoder and the decoder call the same prediction and reconstruction functions (R-05, R-11), so the
// encoder reconstruction is the decoder output, bit for bit.

import { QUANT_MF, DEQUANT_V, POS_CLASS, CHROMA_QP, ZIGZAG4x4 } from './tables.js';
import { forward4x4, dequant4x4, idct4x4Add, hadamard2x2, quantChromaDC, dequantChromaDC } from './transform.js';

export const I16_V = 0, I16_H = 1, I16_DC = 2, I16_PLANE = 3; // luma modes (Intra16x16PredMode)
export const IC_DC = 0, IC_H = 1, IC_V = 2, IC_PLANE = 3; // chroma modes (intra_chroma_pred_mode)

const clip = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);

// Luma prediction (8.3.3) from the decoded picture P (stride W) into out (16x16, stride 16).
// Returns false when the mode needs a neighbour that is not there.
export function predIntra16(P, W, mbx, mby, mode, out) {
  const top = mby > 0, left = mbx > 0;
  const o = mby * 16 * W + mbx * 16;
  if (mode === I16_V) {
    if (!top) return false;
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) out[y * 16 + x] = P[o - W + x];
  } else if (mode === I16_H) {
    if (!left) return false;
    for (let y = 0; y < 16; y++) out.fill(P[o + y * W - 1], y * 16, y * 16 + 16);
  } else if (mode === I16_DC) {
    let s = 0, v;
    if (top) for (let x = 0; x < 16; x++) s += P[o - W + x];
    if (left) for (let y = 0; y < 16; y++) s += P[o + y * W - 1];
    if (top && left) v = (s + 16) >> 5;
    else if (top || left) v = (s + 8) >> 4;
    else v = 128;
    out.fill(v, 0, 256);
  } else {
    if (!top || !left) return false;
    const t = (x) => P[o - W + x]; // p[x, -1], x = -1 is the top left sample
    const l = (y) => P[o + y * W - 1]; // p[-1, y]
    let H = 0, V = 0;
    for (let i = 0; i < 8; i++) {
      H += (i + 1) * (t(8 + i) - t(6 - i));
      V += (i + 1) * (l(8 + i) - (6 - i < 0 ? t(-1) : l(6 - i)));
    }
    const a = 16 * (l(15) + t(15)), b = (5 * H + 32) >> 6, c = (5 * V + 32) >> 6;
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) out[y * 16 + x] = clip((a + b * (x - 7) + c * (y - 7) + 16) >> 5);
  }
  return true;
}

// Chroma prediction (8.3.4, 4:2:0) of one plane P (stride cW) into out (8x8, stride 8).
export function predIntraChroma(P, cW, mbx, mby, mode, out) {
  const top = mby > 0, left = mbx > 0;
  const o = mby * 8 * cW + mbx * 8;
  if (mode === IC_DC) {
    for (let b = 0; b < 4; b++) {
      const xO = (b & 1) * 4, yO = (b >> 1) * 4;
      let st = 0, sl = 0;
      if (top) for (let x = 0; x < 4; x++) st += P[o - cW + xO + x];
      if (left) for (let y = 0; y < 4; y++) sl += P[o + (yO + y) * cW - 1];
      let v;
      if ((xO === 0 && yO === 0) || (xO > 0 && yO > 0)) {
        v = top && left ? (st + sl + 4) >> 3 : left ? (sl + 2) >> 2 : top ? (st + 2) >> 2 : 128;
      } else if (xO > 0) {
        v = top ? (st + 2) >> 2 : left ? (sl + 2) >> 2 : 128; // top right block: the top first
      } else {
        v = left ? (sl + 2) >> 2 : top ? (st + 2) >> 2 : 128; // bottom left block: the left first
      }
      for (let y = 0; y < 4; y++) out.fill(v, (yO + y) * 8 + xO, (yO + y) * 8 + xO + 4);
    }
  } else if (mode === IC_H) {
    if (!left) return false;
    for (let y = 0; y < 8; y++) out.fill(P[o + y * cW - 1], y * 8, y * 8 + 8);
  } else if (mode === IC_V) {
    if (!top) return false;
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) out[y * 8 + x] = P[o - cW + x];
  } else {
    if (!top || !left) return false;
    const t = (x) => P[o - cW + x];
    const l = (y) => P[o + y * cW - 1];
    let H = 0, V = 0;
    for (let i = 0; i < 4; i++) {
      H += (i + 1) * (t(4 + i) - t(2 - i));
      V += (i + 1) * (l(4 + i) - (2 - i < 0 ? t(-1) : l(2 - i)));
    }
    const a = 16 * (l(7) + t(7)), b = (34 * H + 32) >> 6, c = (34 * V + 32) >> 6;
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) out[y * 8 + x] = clip((a + b * (x - 3) + c * (y - 3) + 16) >> 5);
  }
  return true;
}

// 4x4 Hadamard (raster): f = H c H, H = [[1,1,1,1],[1,1,-1,-1],[1,-1,-1,1],[1,-1,1,-1]].
function hadamard4x4(c, f) {
  const t = h4tmp;
  for (let i = 0; i < 4; i++) {
    const a = c[i * 4], b = c[i * 4 + 1], d = c[i * 4 + 2], e = c[i * 4 + 3];
    t[i * 4] = a + b + d + e;
    t[i * 4 + 1] = a + b - d - e;
    t[i * 4 + 2] = a - b - d + e;
    t[i * 4 + 3] = a - b + d - e;
  }
  for (let j = 0; j < 4; j++) {
    const a = t[j], b = t[4 + j], d = t[8 + j], e = t[12 + j];
    f[j] = a + b + d + e;
    f[4 + j] = a + b - d - e;
    f[8 + j] = a - b - d + e;
    f[12 + j] = a - b + d - e;
  }
}
const h4tmp = new Int32Array(16);
const h4f = new Int32Array(16);

// Luma DC scaling (8.5.10): dcY = scale(H c H). c: the DC levels (raster: block by * 4 + bx).
export function dequantLumaDC(c, qp, out) {
  hadamard4x4(c, h4f);
  const ls = 16 * DEQUANT_V[qp % 6][0];
  const q6 = (qp / 6) | 0;
  for (let i = 0; i < 16; i++) {
    out[i] = qp >= 36 ? (h4f[i] * ls) << (q6 - 6) : (h4f[i] * ls + (1 << (5 - q6))) >> (6 - q6);
  }
}

// The levels of one Intra 16x16 macroblock (raster in each block).
//   dc[16]: luma DC levels (raster by * 4 + bx). ac: 16 blocks x 16 (index 0 not used).
//   cbDC, crDC: chroma DC levels; cb, cr: 4 blocks x 16 (index 0 not used).
//   nzAC[16], nzCb[4], nzCr[4]: TotalCoeff of each AC block (for nC).
export class IntraResidual {
  constructor() {
    this.dc = new Int32Array(16);
    this.ac = new Int32Array(256);
    this.cbDC = new Int32Array(4);
    this.crDC = new Int32Array(4);
    this.cb = new Int32Array(64);
    this.cr = new Int32Array(64);
    this.nzAC = new Int32Array(16);
    this.nzCb = new Int32Array(4);
    this.nzCr = new Int32Array(4);
    this.cbpL = 0; // 0 or 15
    this.cbpC = 0; // 0, 1, or 2
  }
}

const dq = new Int32Array(16);
const dcY = new Int32Array(16);
const dcC = new Int32Array(4);

// Reconstruct one Intra 16x16 macroblock: prediction + residual. predY 16x16 (stride 16), predU and
// predV 8x8 (stride 8). Writes to the picture planes at the macroblock.
export function reconIntra16(res, qp, predY, predU, predV, Y, yOff, W, U, V, cOff, cW) {
  dequantLumaDC(res.dc, qp, dcY);
  for (let b = 0; b < 16; b++) {
    dq.fill(0);
    if (res.cbpL) dequant4x4(res.ac.subarray(b * 16, b * 16 + 16), qp, dq, true);
    dq[0] = dcY[b];
    const bx = b & 3, by = b >> 2;
    idct4x4Add(dq, predY, by * 64 + bx * 4, 16, Y, yOff + by * 4 * W + bx * 4, W);
  }
  const qpc = CHROMA_QP[qp];
  for (let comp = 0; comp < 2; comp++) {
    const pred = comp ? predV : predU, P = comp ? V : U;
    if (!res.cbpC) {
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) P[cOff + y * cW + x] = pred[y * 8 + x];
      continue;
    }
    dequantChromaDC(comp ? res.crDC : res.cbDC, qpc, dcC);
    const ac = comp ? res.cr : res.cb;
    for (let b = 0; b < 4; b++) {
      dq.fill(0);
      if (res.cbpC === 2) dequant4x4(ac.subarray(b * 16, b * 16 + 16), qpc, dq, true);
      dq[0] = dcC[b];
      const bx = b & 1, by = b >> 1;
      idct4x4Add(dq, pred, by * 32 + bx * 4, 8, P, cOff + by * 4 * cW + bx * 4, cW);
    }
  }
}

/* ---------------- encoder only ---------------- */

const blk = new Int32Array(16);
const w4 = new Int32Array(16);
const wdc = new Int32Array(16);

// Quantize with the intra rounding (f = 2^qbits / 3), from index `first`. Returns the nonzero count.
function quantIntra(w, qp, z, first) {
  const qbits = 15 + ((qp / 6) | 0);
  const f = ((1 << qbits) / 3) | 0;
  const mf = QUANT_MF[qp % 6];
  let nz = 0;
  if (first) z[0] = 0;
  for (let i = first; i < 16; i++) {
    const v = w[i], a = v < 0 ? -v : v;
    const q = (a * mf[POS_CLASS[i]] + f) >> qbits;
    z[i] = v < 0 ? -q : q;
    if (q) nz++;
  }
  return nz;
}

// The residual levels of one Intra 16x16 macroblock (encoder). src: the source planes (coded size).
export function intraResidual(res, qp, Ysrc, Usrc, Vsrc, yOff, W, cOff, cW, predY, predU, predV) {
  let anyAC = false;
  for (let b = 0; b < 16; b++) {
    const bx = b & 3, by = b >> 2;
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 4; x++) blk[y * 4 + x] = Ysrc[yOff + (by * 4 + y) * W + bx * 4 + x] - predY[(by * 4 + y) * 16 + bx * 4 + x];
    }
    forward4x4(blk, w4);
    wdc[b] = w4[0];
    const z = res.ac.subarray(b * 16, b * 16 + 16);
    const n = quantIntra(w4, qp, z, 1);
    res.nzAC[b] = n;
    if (n) anyAC = true;
  }
  // The luma DC: Hadamard, halved, then quantized (qbits + 1).
  hadamard4x4(wdc, h4f);
  const qbits = 15 + ((qp / 6) | 0), f = ((1 << qbits) / 3) | 0, mf = QUANT_MF[qp % 6][0];
  for (let i = 0; i < 16; i++) {
    const v = h4f[i] >> 1, a = v < 0 ? -v : v;
    const q = (a * mf + 2 * f) >> (qbits + 1);
    res.dc[i] = v < 0 ? -q : q;
  }
  res.cbpL = anyAC ? 15 : 0;
  if (!anyAC) res.nzAC.fill(0);
  // Chroma (as inter, intra rounding for AC).
  const qpc = CHROMA_QP[qp];
  let cDC = false, cAC = false;
  for (let comp = 0; comp < 2; comp++) {
    const S = comp ? Vsrc : Usrc, pred = comp ? predV : predU;
    const ac = comp ? res.cr : res.cb, nzc = comp ? res.nzCr : res.nzCb, dcl = comp ? res.crDC : res.cbDC;
    const dcs = dcC;
    for (let b = 0; b < 4; b++) {
      const bx = b & 1, by = b >> 1;
      for (let y = 0; y < 4; y++) {
        for (let x = 0; x < 4; x++) blk[y * 4 + x] = S[cOff + (by * 4 + y) * cW + bx * 4 + x] - pred[(by * 4 + y) * 8 + bx * 4 + x];
      }
      forward4x4(blk, w4);
      dcs[b] = w4[0];
      const n = quantIntra(w4, qpc, ac.subarray(b * 16, b * 16 + 16), 1);
      nzc[b] = n;
      if (n) cAC = true;
    }
    const f2 = new Int32Array(4);
    hadamard2x2(dcs, f2);
    if (quantChromaDC(f2, qpc, dcl)) cDC = true;
  }
  res.cbpC = cAC ? 2 : cDC ? 1 : 0;
  if (res.cbpC < 2) {
    res.nzCb.fill(0);
    res.nzCr.fill(0);
  }
}

// The sum of absolute differences of a 16x16 (or 8x8) prediction against the source.
export function sadBlock(S, off, stride, pred, n) {
  let s = 0;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const d = S[off + y * stride + x] - pred[y * n + x];
      s += d < 0 ? -d : d;
    }
  }
  return s;
}

// The scan order arrays for CAVLC: the DC levels and an AC block.
export function dcScan(dc, out) {
  for (let i = 0; i < 16; i++) out[i] = dc[ZIGZAG4x4[i]];
}
export function acScan(ac, b, out) {
  for (let i = 0; i < 15; i++) out[i] = ac[b * 16 + ZIGZAG4x4[i + 1]];
}
