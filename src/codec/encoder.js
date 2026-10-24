// Frame encoder (plan §6.10). It writes the H.264 subset of plan §6.
// R-01: no scene-cut detection. R-02: the only IDR is frame 0 of the session.
// R-03: with Heal Off there are no intra macroblocks in P-frames.
// R-04: the reference is the encoder's own reconstruction.
// R-05, R-11: the reconstruction uses the same prediction and inverse-transform code as the decoder.

import { BitWriter, extractBits, seBits } from './bitio.js';
import { ZIGZAG4x4, CBP_INTER_TO_CODE, CHROMA_QP } from './tables.js';
import { writeResidualBlock } from './cavlc.js';
import { makeRef, buildRef, predLuma, predChroma } from './inter.js';
import { makeMbInfo, mvPred16x16, mvSkip, lumaNC, chromaNC, MB_SKIP, MB_INTER, MB_PCM } from './mvpred.js';
import {
  MbResidual, reconInterMB, forward4x4, quant4x4, hadamard2x2, quantChromaDC,
} from './transform.js';
import { align16, writeSliceHeader, headerForFrame } from './headers.js';

// Plan §7.2. Each value makes a datamosh.
export const DEFAULT_SETTINGS = Object.freeze({ qp: 28, searchRange: 32, precision: 'half', skipBias: 50, heal: 'off' });
export const SETTING_VALUES = Object.freeze({
  qpMin: 16,
  qpMax: 44,
  searchRange: [8, 16, 32, 64],
  precision: ['full', 'half', 'quarter'],
  skipBiasMin: 0,
  skipBiasMax: 100,
  heal: ['off', 'low', 'high'],
});

export function checkSettings(s) {
  const v = SETTING_VALUES;
  if (!Number.isInteger(s.qp) || s.qp < v.qpMin || s.qp > v.qpMax) throw new Error('Bad qp');
  if (!v.searchRange.includes(s.searchRange)) throw new Error('Bad searchRange');
  if (!v.precision.includes(s.precision)) throw new Error('Bad precision');
  if (!Number.isInteger(s.skipBias) || s.skipBias < v.skipBiasMin || s.skipBias > v.skipBiasMax) throw new Error('Bad skipBias');
  if (!v.heal.includes(s.heal)) throw new Error('Bad heal');
  return { qp: s.qp, searchRange: s.searchRange, precision: s.precision, skipBias: s.skipBias, heal: s.heal };
}

// Heal: code I_PCM when the mean absolute error of the best inter prediction is above this value.
const HEAL_THRESHOLD = { low: 32, high: 16 };
// Motion search: stop when the mean absolute error is below 1; use the large diamond above 6.
const EARLY_STOP_SAD = 256;
const LARGE_SEARCH_SAD = 256 * 6;

const LAMBDA = new Float64Array(52);
for (let q = 0; q < 52; q++) LAMBDA[q] = Math.sqrt(0.85 * 2 ** ((q - 12) / 3));

const SMALL_DIAMOND = [0, -1, -1, 0, 1, 0, 0, 1];
const LARGE_DIAMOND = [0, -2, -1, -1, 1, -1, -2, 0, 2, 0, -1, 1, 1, 1, 0, 2];
const RING = [-1, -1, 0, -1, 1, -1, -1, 0, 1, 0, -1, 1, 0, 1, 1, 1];

export class Encoder {
  // w, h: visible size (even). settings: plan §7.2.
  constructor(w, h, settings = DEFAULT_SETTINGS) {
    this.w = w;
    this.h = h;
    this.codedW = align16(w);
    this.codedH = align16(h);
    this.mbW = this.codedW >> 4;
    this.mbH = this.codedH >> 4;
    this.numMbs = this.mbW * this.mbH;
    this.settings = checkSettings(settings);
    this.ref = makeRef(this.codedW, this.codedH);
    this.recY = new Uint8Array(this.codedW * this.codedH);
    this.recU = new Uint8Array((this.codedW * this.codedH) >> 2);
    this.recV = new Uint8Array((this.codedW * this.codedH) >> 2);
    this.info = makeMbInfo(this.numMbs);
    this.prevMvx = new Int16Array(this.numMbs);
    this.prevMvy = new Int16Array(this.numMbs);
    this.res = new MbResidual();
    this.predY = new Uint8Array(256);
    this.predU = new Uint8Array(64);
    this.predV = new Uint8Array(64);
    this.tmpY = new Uint8Array(256);
    this.mv = new Int32Array(2);
    this.mvp = new Int32Array(2);
    this.blk = new Int32Array(16);
    this.wc = new Int32Array(16);
    this.zc = new Int32Array(16);
    this.scan = new Int32Array(16);
    this.dc = new Int32Array(4);
    this.dcF = new Int32Array(4);
    this.nextType = 'idr';
    this.hasRef = false;
    // Test hooks (not used by the app):
    //   forceMode: 'skip' (all P_Skip) or 'noResidual' (P_L0_16x16 with cbp 0).
    //   forceMv(mbx, mby) -> [mvx, mvy]: use this vector and no search and no skip test.
    this.debug = { forceMode: null, forceMv: null };
    this.stats = null;
  }

  // R-12: the app calls this only while paused.
  setSettings(s) {
    this.settings = checkSettings(s);
  }

  // Plan §8.5: the next frame is a hidden I-frame.
  newClip() {
    if (this.hasRef) this.nextType = 'hiddenI';
  }

  // Plan §12.3, revert to point 0: the next frame is the IDR.
  restart() {
    this.nextType = 'idr';
    this.hasRef = false;
  }

  // Encode one picture. Y, U, V: coded-size planes (pad the visible picture by edge copy).
  // Returns the frame packet { type, qp, bits, bitLen, hdrBits, settings, stats }.
  encode(Y, U, V) {
    const type = this.nextType;
    const s = this.settings;
    const frame = { type, qp: s.qp };
    const bw = new BitWriter(type === 'p' ? 4096 + this.numMbs * 16 : this.numMbs * 390 + 64);
    writeSliceHeader(bw, headerForFrame(frame, 0));
    const hdrBits = bw.pos;
    this.stats = { skip: 0, inter: 0, pcm: 0 };
    if (type === 'p') this.encodeP(bw, Y, U, V);
    else this.encodeI(bw, Y, U, V);
    buildRef(this.ref, this.recY, this.recU, this.recV);
    this.prevMvx.set(this.info.mvx);
    this.prevMvy.set(this.info.mvy);
    this.hasRef = true;
    this.nextType = 'p';
    return {
      type,
      qp: s.qp,
      bits: extractBits(bw.buf, hdrBits, bw.pos),
      bitLen: bw.pos - hdrBits,
      hdrBits,
      settings: { ...s },
      stats: this.stats,
    };
  }

  writePcm(bw, Y, U, V, mbx, mby) {
    bw.alignZero();
    bw.ensure(384 * 8);
    const buf = bw.buf;
    let o = bw.pos >> 3;
    const W = this.codedW, cW = W >> 1;
    const yOff = mby * 16 * W + mbx * 16, cOff = mby * 8 * cW + mbx * 8;
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        const i = yOff + y * W + x;
        const v = Y[i] === 0 ? 1 : Y[i];
        buf[o++] = v;
        this.recY[i] = v;
      }
    }
    for (let c = 0; c < 2; c++) {
      const P = c ? V : U, R = c ? this.recV : this.recU;
      for (let y = 0; y < 8; y++) {
        for (let x = 0; x < 8; x++) {
          const i = cOff + y * cW + x;
          const v = P[i] === 0 ? 1 : P[i];
          buf[o++] = v;
          R[i] = v;
        }
      }
    }
    bw.pos += 384 * 8;
    const addr = mby * this.mbW + mbx;
    const info = this.info;
    info.type[addr] = MB_PCM;
    info.mvx[addr] = 0;
    info.mvy[addr] = 0;
    info.nzLuma.fill(16, addr * 16, addr * 16 + 16);
    info.nzCb.fill(16, addr * 4, addr * 4 + 4);
    info.nzCr.fill(16, addr * 4, addr * 4 + 4);
    this.stats.pcm++;
  }

  // I picture: all I_PCM (plan §6.5). The reconstruction equals the clamped source.
  encodeI(bw, Y, U, V) {
    for (let mby = 0; mby < this.mbH; mby++) {
      for (let mbx = 0; mbx < this.mbW; mbx++) {
        bw.ue(25);
        this.writePcm(bw, Y, U, V, mbx, mby);
      }
    }
  }

  predict(mbx, mby, mvx, mvy) {
    predLuma(this.ref, mbx * 16, mby * 16, mvx, mvy, 16, 16, this.predY);
    predChroma(this.ref, mbx * 8, mby * 8, mvx, mvy, 8, 8, this.predU, this.predV);
  }

  sadPred(Y, yOff, pred) {
    const W = this.codedW;
    let sad = 0;
    for (let y = 0; y < 16; y++) {
      const s = yOff + y * W, p = y * 16;
      for (let x = 0; x < 16; x++) {
        const d = Y[s + x] - pred[p + x];
        sad += d < 0 ? -d : d;
      }
    }
    return sad;
  }

  // SAD at a full-sample vector (ix, iy) in samples.
  sadInt(Y, yOff, mbx, mby, ix, iy) {
    const ref = this.ref;
    const x = mbx * 16 + ix, y = mby * 16 + iy;
    if (x < -ref.pad || y < -ref.pad || x + 16 > ref.w + ref.pad || y + 16 > ref.h + ref.pad) {
      predLuma(ref, mbx * 16, mby * 16, ix * 4, iy * 4, 16, 16, this.tmpY);
      return this.sadPred(Y, yOff, this.tmpY);
    }
    const G = ref.G, rs = ref.stride, W = this.codedW;
    let o = ref.origin + y * rs + x;
    let sad = 0;
    for (let r = 0; r < 16; r++) {
      const s = yOff + r * W;
      for (let c = 0; c < 16; c++) {
        const d = Y[s + c] - G[o + c];
        sad += d < 0 ? -d : d;
      }
      o += rs;
    }
    return sad;
  }

  sadFrac(Y, yOff, mbx, mby, mvx, mvy) {
    predLuma(this.ref, mbx * 16, mby * 16, mvx, mvy, 16, 16, this.tmpY);
    return this.sadPred(Y, yOff, this.tmpY);
  }

  // Compute the residual levels of the current prediction into this.res. Returns cbp.
  residual(Y, U, V, yOff, cOff, qp) {
    const res = this.res;
    const W = this.codedW, cW = W >> 1;
    const blk = this.blk, wc = this.wc, zc = this.zc;
    let cbp = 0;
    for (let b = 0; b < 16; b++) {
      const bx = b & 3, by = b >> 2;
      const s = yOff + by * 4 * W + bx * 4, p = by * 64 + bx * 4;
      for (let y = 0; y < 4; y++) {
        for (let x = 0; x < 4; x++) blk[y * 4 + x] = Y[s + y * W + x] - this.predY[p + y * 16 + x];
      }
      forward4x4(blk, wc);
      const nz = quant4x4(wc, qp, zc, 0);
      res.luma.set(zc, b * 16);
      res.nzLuma[b] = nz;
      if (nz) cbp |= 1 << ((by >> 1) * 2 + (bx >> 1));
    }
    const qpc = CHROMA_QP[qp];
    let anyDC = false, anyAC = false;
    for (let comp = 0; comp < 2; comp++) {
      const P = comp ? V : U, pred = comp ? this.predV : this.predU;
      const ac = comp ? res.cr : res.cb, nzc = comp ? res.nzCr : res.nzCb;
      for (let b = 0; b < 4; b++) {
        const bx = b & 1, by = b >> 1;
        const s = cOff + by * 4 * cW + bx * 4, p = by * 32 + bx * 4;
        for (let y = 0; y < 4; y++) {
          for (let x = 0; x < 4; x++) blk[y * 4 + x] = P[s + y * cW + x] - pred[p + y * 8 + x];
        }
        forward4x4(blk, wc);
        this.dc[b] = wc[0];
        const nz = quant4x4(wc, qpc, zc, 1);
        ac.set(zc, b * 16);
        nzc[b] = nz;
        if (nz) anyAC = true;
      }
      hadamard2x2(this.dc, this.dcF);
      if (quantChromaDC(this.dcF, qpc, comp ? res.crDC : res.cbDC)) anyDC = true;
    }
    if (anyAC) cbp |= 32;
    else {
      if (anyDC) cbp |= 16;
      res.cb.fill(0);
      res.cr.fill(0);
      res.nzCb.fill(0);
      res.nzCr.fill(0);
    }
    res.cbp = cbp;
    return cbp;
  }

  // Skip test: true when all luma and chroma levels of the current prediction are zero.
  residualIsZero(Y, U, V, yOff, cOff, qp) {
    const W = this.codedW, cW = W >> 1;
    const blk = this.blk, wc = this.wc, zc = this.zc;
    for (let b = 0; b < 16; b++) {
      const s = yOff + (b >> 2) * 4 * W + (b & 3) * 4, p = (b >> 2) * 64 + (b & 3) * 4;
      for (let y = 0; y < 4; y++) {
        for (let x = 0; x < 4; x++) blk[y * 4 + x] = Y[s + y * W + x] - this.predY[p + y * 16 + x];
      }
      forward4x4(blk, wc);
      if (quant4x4(wc, qp, zc, 0)) return false;
    }
    const qpc = CHROMA_QP[qp];
    for (let comp = 0; comp < 2; comp++) {
      const P = comp ? V : U, pred = comp ? this.predV : this.predU;
      for (let b = 0; b < 4; b++) {
        const s = cOff + (b >> 1) * 4 * cW + (b & 1) * 4, p = (b >> 1) * 32 + (b & 1) * 4;
        for (let y = 0; y < 4; y++) {
          for (let x = 0; x < 4; x++) blk[y * 4 + x] = P[s + y * cW + x] - pred[p + y * 8 + x];
        }
        forward4x4(blk, wc);
        this.dc[b] = wc[0];
        if (quant4x4(wc, qpc, zc, 1)) return false;
      }
      hadamard2x2(this.dc, this.dcF);
      if (quantChromaDC(this.dcF, qpc, zc)) return false;
    }
    return true;
  }

  // Motion search (plan §6.10 steps 2 and 3). Writes the vector to this.mv. Returns its SAD.
  search(Y, yOff, mbx, mby, addr, skx, sky) {
    const s = this.settings;
    const R = s.searchRange;
    const R4 = R * 4;
    const lambda = LAMBDA[s.qp];
    const px = this.mvp[0], py = this.mvp[1];
    const clampI = (v) => (v < -R ? -R : v > R ? R : v);
    const rnd = (v) => clampI((v + 2) >> 2);

    let bx = 0, by = 0, bSad = 0, bCost = Infinity;
    const tryInt = (ix, iy) => {
      const sad = this.sadInt(Y, yOff, mbx, mby, ix, iy);
      const cost = sad + lambda * (seBits(ix * 4 - px) + seBits(iy * 4 - py));
      if (cost < bCost) {
        bCost = cost;
        bSad = sad;
        bx = ix;
        by = iy;
        return true;
      }
      return false;
    };
    tryInt(rnd(skx), rnd(sky));
    tryInt(rnd(px), rnd(py));
    tryInt(0, 0);
    tryInt(rnd(this.prevMvx[addr]), rnd(this.prevMvy[addr]));

    if (bSad >= EARLY_STOP_SAD) {
      if (bSad > LARGE_SEARCH_SAD) {
        for (let it = 0; it < R; it++) {
          const cx = bx, cy = by;
          let moved = false;
          for (let k = 0; k < 16; k += 2) {
            const ix = cx + LARGE_DIAMOND[k], iy = cy + LARGE_DIAMOND[k + 1];
            if (ix < -R || ix > R || iy < -R || iy > R) continue;
            if (tryInt(ix, iy)) moved = true;
          }
          if (!moved || bSad < EARLY_STOP_SAD) break;
        }
      }
      for (let it = 0; it < 2 * R; it++) {
        const cx = bx, cy = by;
        let moved = false;
        for (let k = 0; k < 8; k += 2) {
          const ix = cx + SMALL_DIAMOND[k], iy = cy + SMALL_DIAMOND[k + 1];
          if (ix < -R || ix > R || iy < -R || iy > R) continue;
          if (tryInt(ix, iy)) moved = true;
        }
        if (!moved || bSad < EARLY_STOP_SAD) break;
      }
    }

    // Sub-sample refinement: 8 half positions, then 8 quarter positions.
    let mx = bx * 4, my = by * 4;
    if (s.precision !== 'full' && bSad > 0) {
      const steps = s.precision === 'quarter' ? [2, 1] : [2];
      for (const st of steps) {
        const cx = mx, cy = my;
        for (let k = 0; k < 16; k += 2) {
          const qx = cx + RING[k] * st, qy = cy + RING[k + 1] * st;
          if (qx < -R4 || qx > R4 || qy < -R4 || qy > R4) continue;
          const sad = this.sadFrac(Y, yOff, mbx, mby, qx, qy);
          const cost = sad + lambda * (seBits(qx - px) + seBits(qy - py));
          if (cost < bCost) {
            bCost = cost;
            bSad = sad;
            mx = qx;
            my = qy;
          }
        }
      }
    }
    this.mv[0] = mx;
    this.mv[1] = my;
    return bSad;
  }

  encodeP(bw, Y, U, V) {
    const s = this.settings;
    const qp = s.qp;
    const info = this.info;
    const W = this.codedW, cW = W >> 1;
    const skipThr = 256 * 16 * (s.skipBias / 100) ** 2;
    const healThr = s.heal === 'off' ? Infinity : HEAL_THRESHOLD[s.heal] * 256;
    const dbg = this.debug;
    const sk = new Int32Array(2);
    let skipRun = 0;
    for (let mby = 0; mby < this.mbH; mby++) {
      for (let mbx = 0; mbx < this.mbW; mbx++) {
        const addr = mby * this.mbW + mbx;
        const yOff = mby * 16 * W + mbx * 16, cOff = mby * 8 * cW + mbx * 8;
        mvSkip(info, mbx, mby, this.mbW, sk);

        // Step 1: skip test.
        let skip = dbg.forceMode === 'skip';
        let predicted = false;
        if (!skip && !dbg.forceMv && dbg.forceMode !== 'noResidual') {
          predLuma(this.ref, mbx * 16, mby * 16, sk[0], sk[1], 16, 16, this.predY);
          if (this.sadPred(Y, yOff, this.predY) < skipThr) {
            predChroma(this.ref, mbx * 8, mby * 8, sk[0], sk[1], 8, 8, this.predU, this.predV);
            predicted = true;
            skip = this.residualIsZero(Y, U, V, yOff, cOff, qp);
          }
        }
        if (skip) {
          if (!predicted) this.predict(mbx, mby, sk[0], sk[1]);
          this.copyPred(yOff, cOff);
          info.type[addr] = MB_SKIP;
          info.mvx[addr] = sk[0];
          info.mvy[addr] = sk[1];
          info.nzLuma.fill(0, addr * 16, addr * 16 + 16);
          info.nzCb.fill(0, addr * 4, addr * 4 + 4);
          info.nzCr.fill(0, addr * 4, addr * 4 + 4);
          skipRun++;
          this.stats.skip++;
          continue;
        }

        // Steps 2 and 3: motion search.
        mvPred16x16(info, mbx, mby, this.mbW, this.mvp);
        let sad;
        if (dbg.forceMv) {
          const m = dbg.forceMv(mbx, mby);
          this.mv[0] = m[0];
          this.mv[1] = m[1];
          sad = this.sadFrac(Y, yOff, mbx, mby, m[0], m[1]);
        } else {
          sad = this.search(Y, yOff, mbx, mby, addr, sk[0], sk[1]);
        }

        // Step 4: heal.
        bw.ue(skipRun);
        skipRun = 0;
        if (sad > healThr) {
          bw.ue(30);
          this.writePcm(bw, Y, U, V, mbx, mby);
          continue;
        }

        // Step 5: P_L0_16x16.
        const mvx = this.mv[0], mvy = this.mv[1];
        this.predict(mbx, mby, mvx, mvy);
        const res = this.res;
        let cbp;
        if (dbg.forceMode === 'noResidual') {
          res.clear();
          cbp = 0;
        } else cbp = this.residual(Y, U, V, yOff, cOff, qp);
        info.type[addr] = MB_INTER;
        info.mvx[addr] = mvx;
        info.mvy[addr] = mvy;
        info.nzLuma.set(res.nzLuma, addr * 16);
        info.nzCb.set(res.nzCb, addr * 4);
        info.nzCr.set(res.nzCr, addr * 4);
        bw.ue(0);
        bw.se(mvx - this.mvp[0]);
        bw.se(mvy - this.mvp[1]);
        bw.ue(CBP_INTER_TO_CODE[cbp]);
        if (cbp) {
          bw.se(0); // mb_qp_delta
          this.writeResidual(bw, addr, mbx, mby);
        }
        // Step 6: reconstruction (R-11).
        reconInterMB(res, qp, this.predY, this.predU, this.predV, this.recY, yOff, W, this.recU, this.recV, cOff, cW);
        this.stats.inter++;
      }
    }
    if (skipRun > 0) bw.ue(skipRun);
  }

  copyPred(yOff, cOff) {
    const W = this.codedW, cW = W >> 1;
    for (let y = 0; y < 16; y++) this.recY.set(this.predY.subarray(y * 16, y * 16 + 16), yOff + y * W);
    for (let y = 0; y < 8; y++) {
      this.recU.set(this.predU.subarray(y * 8, y * 8 + 8), cOff + y * cW);
      this.recV.set(this.predV.subarray(y * 8, y * 8 + 8), cOff + y * cW);
    }
  }

  writeResidual(bw, addr, mbx, mby) {
    const res = this.res, info = this.info, scan = this.scan;
    const cbp = res.cbp;
    for (let b8 = 0; b8 < 4; b8++) {
      if (!((cbp >> b8) & 1)) continue;
      for (let b4 = 0; b4 < 4; b4++) {
        const bx = (b8 & 1) * 2 + (b4 & 1), by = (b8 >> 1) * 2 + (b4 >> 1);
        const blk = by * 4 + bx;
        for (let i = 0; i < 16; i++) scan[i] = res.luma[blk * 16 + ZIGZAG4x4[i]];
        writeResidualBlock(bw, scan, 16, lumaNC(info, addr, mbx, mby, this.mbW, bx, by));
      }
    }
    const cc = cbp >> 4;
    if (cc) {
      writeResidualBlock(bw, res.cbDC, 4, -1);
      writeResidualBlock(bw, res.crDC, 4, -1);
    }
    if (cc === 2) {
      for (let comp = 0; comp < 2; comp++) {
        const nz = comp ? info.nzCr : info.nzCb;
        const ac = comp ? res.cr : res.cb;
        for (let b = 0; b < 4; b++) {
          for (let i = 0; i < 15; i++) scan[i] = ac[b * 16 + ZIGZAG4x4[i + 1]];
          writeResidualBlock(bw, scan, 15, chromaNC(nz, addr, mbx, mby, this.mbW, b & 1, b >> 1));
        }
      }
    }
  }
}
