// Frame encoder (plan §6.10). It writes the H.264 subset of plan §6.
// R-01: no scene-cut detection. R-02: the only IDR is frame 0 of the session.
// R-03: with Heal Off there are no intra macroblocks in P-frames.
// R-04: the reference is the encoder's own reconstruction.
// R-05, R-11: the reconstruction uses the same prediction and inverse-transform code as the decoder.

import { BitWriter, extractBits, seBits } from './bitio.js';
import { ZIGZAG4x4, CBP_INTER_TO_CODE, CHROMA_QP } from './tables.js';
import { writeResidualBlock } from './cavlc.js';
import { makeRef, allocRef, buildRef, buildHalf, predLuma, predChroma, sadLuma } from './inter.js';
import { rgbaToYuv420 } from './color.js';
import { Kernels } from './wasm.js';
import { Decoder } from './decoder.js';
import { makeMbInfo, allocMbInfo, mvPred16x16, mvSkip, lumaNC, chromaNC, MB_SKIP, MB_INTER, MB_PCM } from './mvpred.js';
import {
  MbResidual, reconInterMB, forward4x4, quant4x4, hadamard2x2, quantChromaDC,
} from './transform.js';
import { QUANT_MF } from './tables.js';
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

// ZERO_SAD[qp]: when the sum of |residual| of a 4x4 block is at most this value, all its levels are
// zero, so the transform is not necessary. Proof: |W| <= S for positions (even, even), 4S for
// (odd, odd), 2S for the others (the core transform has |c| <= 2), and a level is zero when
// |W| * MF + f < 2^qbits. The result is exactly the same as with the transform.
const ZERO_SAD = new Int32Array(52);
for (let q = 0; q < 52; q++) {
  const qbits = 15 + ((q / 6) | 0);
  const f = ((1 << qbits) / 6) | 0;
  const mf = QUANT_MF[q % 6];
  const k = Math.max(mf[0], 4 * mf[1], 2 * mf[2]);
  ZERO_SAD[q] = Math.floor(((1 << qbits) - f - 1) / k);
}

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
    const n = this.codedW * this.codedH, cn = n >> 2;
    // D21: the planes and buffers are in the memory of the WebAssembly kernels when available.
    const k = Kernels.create();
    this.k = k;
    if (k) {
      const p = {
        rec: k.alloc(n + 2 * cn), src: k.alloc(n + 2 * cn), rgba: k.alloc(w * h * 4), pred: k.alloc(384),
        tmp: k.alloc(256), res: k.alloc(417 * 4), visited: k.alloc(129 * 129 * 4), mv: k.alloc(8),
        bits: k.alloc(this.numMbs * 1600 + 4096), out: k.alloc(this.numMbs * 1600 + 4096),
        prev: k.alloc(this.numMbs * 4), stats: k.alloc(16),
      };
      const mkRef = allocRef(k, this.codedW, this.codedH);
      const mkInfo = allocMbInfo(k, this.numMbs, this.mbW, this.mbH);
      k.seal();
      this.ref = mkRef();
      this.info = mkInfo();
      this.prevMvx = new Int16Array(k.mem.buffer, p.prev, this.numMbs);
      this.prevMvy = new Int16Array(k.mem.buffer, p.prev + this.numMbs * 2, this.numMbs);
      this.kStats = k.i32(p.stats, 4);
      [this.recY, this.recU, this.recV] = [k.u8(p.rec, n), k.u8(p.rec + n, cn), k.u8(p.rec + n + cn, cn)];
      [this.srcY, this.srcU, this.srcV] = [k.u8(p.src, n), k.u8(p.src + n, cn), k.u8(p.src + n + cn, cn)];
      this.rgba = k.u8(p.rgba, w * h * 4);
      [this.predY, this.predU, this.predV] = [k.u8(p.pred, 256), k.u8(p.pred + 256, 64), k.u8(p.pred + 320, 64)];
      this.tmpY = k.u8(p.tmp, 256);
      this.res = new MbResidual(k, p.res);
      this.visited = k.i32(p.visited, 129 * 129); // motion search: positions tested for this MB
      this.mvOut = k.i32(p.mv, 2);
      // The slice data writer (kernels.c): its buffer, and the TotalCoeff arrays for nC.
      this.bitBuf = k.u8(p.bits, this.numMbs * 1600 + 4096);
      this.outBuf = k.u8(p.out, this.numMbs * 1600 + 4096);
    } else {
      this.ref = makeRef(this.codedW, this.codedH);
      [this.recY, this.recU, this.recV] = [new Uint8Array(n), new Uint8Array(cn), new Uint8Array(cn)];
      [this.srcY, this.srcU, this.srcV] = [new Uint8Array(n), new Uint8Array(cn), new Uint8Array(cn)];
      this.rgba = null;
      [this.predY, this.predU, this.predV] = [new Uint8Array(256), new Uint8Array(64), new Uint8Array(64)];
      this.tmpY = new Uint8Array(256);
      this.res = new MbResidual();
      this.visited = new Int32Array(129 * 129); // motion search: positions tested for this MB
      this.info = makeMbInfo(this.numMbs);
      this.prevMvx = new Int16Array(this.numMbs);
      this.prevMvy = new Int16Array(this.numMbs);
    }
    this.mv = new Int32Array(2);
    this.mvp = new Int32Array(2);
    this.blk = new Int32Array(16);
    this.wc = new Int32Array(16);
    this.zc = new Int32Array(16);
    this.scan = new Int32Array(16);
    this.dc = new Int32Array(4);
    this.dcF = new Int32Array(4);
    this.visitStamp = 0;
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

  // Plan §12.3 and §11.6: continue a session that has frames (after a revert, or in a new worker
  // after a restore). The next frame is a hidden I-frame, which makes a new reference.
  continueSession() {
    this.nextType = 'hiddenI';
    this.hasRef = true;
  }

  // Plan §12.3, revert to point 0: the next frame is the IDR.
  restart() {
    this.nextType = 'idr';
    this.hasRef = false;
  }

  // The input planes from a visible RGBA picture (w x h). Returns [Y, U, V] for encode().
  inputFromRgba(rgba) {
    if (this.k) {
      this.rgba.set(rgba);
      this.k.x.rgba_to_yuv420(this.rgba.byteOffset, this.w, this.h, this.codedW, this.codedH,
        this.srcY.byteOffset, this.srcU.byteOffset, this.srcV.byteOffset);
    } else rgbaToYuv420(rgba, this.w, this.h, this.codedW, this.codedH, this.srcY, this.srcU, this.srcV);
    return [this.srcY, this.srcU, this.srcV];
  }

  // Encode one picture. Y, U, V: coded-size planes (pad the visible picture by edge copy).
  // Returns the frame packet { type, qp, bits, bitLen, hdrBits, settings, stats }.
  encode(Y, U, V) {
    if (this.k && Y !== this.srcY) {
      // The kernels read the source from their memory.
      this.srcY.set(Y);
      this.srcU.set(U);
      this.srcV.set(V);
      [Y, U, V] = [this.srcY, this.srcU, this.srcV];
    }
    const type = this.nextType;
    const s = this.settings;
    const frame = { type, qp: s.qp };
    const bw = new BitWriter(type === 'p' ? 4096 + this.numMbs * 16 : this.numMbs * 390 + 64);
    writeSliceHeader(bw, headerForFrame(frame, 0));
    const hdrBits = bw.pos;
    this.stats = { skip: 0, inter: 0, pcm: 0 };
    // With the kernels, the slice data goes to their writer. It starts at the same bit alignment.
    if (this.k) this.k.x.bw_reset(this.bitBuf.byteOffset, hdrBits & 7);
    if (type === 'p') this.encodeP(bw, Y, U, V);
    else this.encodeI(bw, Y, U, V);
    let bits, bitLen;
    if (this.k) {
      bitLen = this.k.x.bw_extract(this.outBuf.byteOffset);
      bits = this.outBuf.slice(0, (bitLen + 7) >> 3);
    } else {
      bits = extractBits(bw.buf, hdrBits, bw.pos);
      bitLen = bw.pos - hdrBits;
    }
    buildRef(this.ref, this.recY, this.recU, this.recV);
    this.prevMvx.set(this.info.mvx);
    this.prevMvy.set(this.info.mvy);
    this.hasRef = true;
    this.nextType = 'p';
    return {
      type,
      qp: s.qp,
      bits,
      bitLen,
      hdrBits,
      settings: { ...s },
      stats: this.stats,
    };
  }

  // Bloom (plan §15): the same P-frame again. The packet is a copy of an earlier P packet (its slice
  // data bits do not change). The decoder applies it to its current picture; the encoder does the same
  // to its reference with a decoder (the decoder output is the encoder reconstruction, bit for bit), so
  // the next frames are coded against the correct picture.
  repeat(pkt) {
    if (pkt.type !== 'p' || !this.hasRef) throw new Error('Bloom needs a P-frame and a reference');
    if (!this.bloomDec) this.bloomDec = new Decoder(this.w, this.h);
    const d = this.bloomDec;
    d.setRef(this.recY, this.recU, this.recV);
    d.decodePacket(pkt);
    this.recY.set(d.Y);
    this.recU.set(d.U);
    this.recV.set(d.V);
    buildRef(this.ref, this.recY, this.recU, this.recV);
    this.nextType = 'p';
    this.stats = { skip: 0, inter: 0, pcm: 0, bloom: 1 };
    return { type: 'p', qp: pkt.qp, bits: pkt.bits.slice(), bitLen: pkt.bitLen, hdrBits: pkt.hdrBits, settings: { ...pkt.settings }, stats: this.stats, bloom: true };
  }

  // An I_PCM MB: mb_skip_run (when skipRun >= 0), mb_type, the samples.
  writePcm(bw, Y, U, V, mbx, mby, skipRun, mbType) {
    if (this.k) {
      const W = this.codedW, cW = W >> 1;
      const yOff = mby * 16 * W + mbx * 16, cOff = mby * 8 * cW + mbx * 8;
      this.k.x.write_pcm_mb(skipRun, mbType, Y.byteOffset + yOff, U.byteOffset + cOff, V.byteOffset + cOff,
        this.recY.byteOffset + yOff, this.recU.byteOffset + cOff, this.recV.byteOffset + cOff, W, cW);
      this.pcmInfo(mbx, mby);
      return;
    }
    if (skipRun >= 0) bw.ue(skipRun);
    bw.ue(mbType);
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
    this.pcmInfo(mbx, mby);
  }

  pcmInfo(mbx, mby) {
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
        this.writePcm(bw, Y, U, V, mbx, mby, -1, 25);
      }
    }
  }

  predict(mbx, mby, mvx, mvy) {
    predLuma(this.ref, mbx * 16, mby * 16, mvx, mvy, 16, 16, this.predY);
    predChroma(this.ref, mbx * 8, mby * 8, mvx, mvy, 8, 8, this.predU, this.predV);
  }

  sadPred(Y, yOff, pred) {
    const W = this.codedW;
    if (this.k && this.k.has(Y) && this.k.has(pred)) return this.k.x.sad_block(Y.byteOffset + yOff, W, pred.byteOffset);
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

  // SAD at a full-sample vector (ix, iy) in samples. It stops (and returns a value > limit) as soon
  // as the sum is above limit.
  sadInt(Y, yOff, mbx, mby, ix, iy, limit = Infinity) {
    const ref = this.ref;
    const x = mbx * 16 + ix, y = mby * 16 + iy;
    if (x < -ref.pad || y < -ref.pad || x + 16 > ref.w + ref.pad || y + 16 > ref.h + ref.pad) {
      return sadLuma(ref, mbx * 16, mby * 16, ix * 4, iy * 4, Y, yOff, this.codedW, limit, this.tmpY);
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
      if (sad > limit) return sad;
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
    if (this.k) {
      return this.k.x.residual_mb(Y.byteOffset + yOff, U.byteOffset + cOff, V.byteOffset + cOff, W, cW,
        this.predY.byteOffset, this.predU.byteOffset, this.predV.byteOffset, qp, res.ptr);
    }
    const blk = this.blk, wc = this.wc, zc = this.zc;
    const zeroL = ZERO_SAD[qp];
    let cbp = 0;
    for (let b = 0; b < 16; b++) {
      const bx = b & 3, by = b >> 2;
      const s = yOff + by * 4 * W + bx * 4, p = by * 64 + bx * 4;
      let sa = 0;
      for (let y = 0; y < 4; y++) {
        for (let x = 0; x < 4; x++) {
          const d = Y[s + y * W + x] - this.predY[p + y * 16 + x];
          blk[y * 4 + x] = d;
          sa += d < 0 ? -d : d;
        }
      }
      if (sa <= zeroL) {
        res.luma.fill(0, b * 16, b * 16 + 16);
        res.nzLuma[b] = 0;
        continue;
      }
      forward4x4(blk, wc);
      const nz = quant4x4(wc, qp, zc, 0);
      res.luma.set(zc, b * 16);
      res.nzLuma[b] = nz;
      if (nz) cbp |= 1 << ((by >> 1) * 2 + (bx >> 1));
    }
    const qpc = CHROMA_QP[qp];
    const zeroC = ZERO_SAD[qpc];
    let anyDC = false, anyAC = false;
    for (let comp = 0; comp < 2; comp++) {
      const P = comp ? V : U, pred = comp ? this.predV : this.predU;
      const ac = comp ? res.cr : res.cb, nzc = comp ? res.nzCr : res.nzCb;
      for (let b = 0; b < 4; b++) {
        const bx = b & 1, by = b >> 1;
        const s = cOff + by * 4 * cW + bx * 4, p = by * 32 + bx * 4;
        let sa = 0, sum = 0;
        for (let y = 0; y < 4; y++) {
          for (let x = 0; x < 4; x++) {
            const d = P[s + y * cW + x] - pred[p + y * 8 + x];
            blk[y * 4 + x] = d;
            sum += d;
            sa += d < 0 ? -d : d;
          }
        }
        if (sa <= zeroC) {
          this.dc[b] = sum; // W[0] is the sum of the residual
          ac.fill(0, b * 16, b * 16 + 16);
          nzc[b] = 0;
          continue;
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
    if (this.k) {
      return this.k.x.residual_is_zero(Y.byteOffset + yOff, U.byteOffset + cOff, V.byteOffset + cOff, W, cW,
        this.predY.byteOffset, this.predU.byteOffset, this.predV.byteOffset, qp) === 1;
    }
    const blk = this.blk, wc = this.wc, zc = this.zc;
    const zeroL = ZERO_SAD[qp];
    for (let b = 0; b < 16; b++) {
      const s = yOff + (b >> 2) * 4 * W + (b & 3) * 4, p = (b >> 2) * 64 + (b & 3) * 4;
      let sa = 0;
      for (let y = 0; y < 4; y++) {
        for (let x = 0; x < 4; x++) {
          const d = Y[s + y * W + x] - this.predY[p + y * 16 + x];
          blk[y * 4 + x] = d;
          sa += d < 0 ? -d : d;
        }
      }
      if (sa <= zeroL) continue;
      forward4x4(blk, wc);
      if (quant4x4(wc, qp, zc, 0)) return false;
    }
    const qpc = CHROMA_QP[qp];
    const zeroC = ZERO_SAD[qpc];
    for (let comp = 0; comp < 2; comp++) {
      const P = comp ? V : U, pred = comp ? this.predV : this.predU;
      for (let b = 0; b < 4; b++) {
        const s = cOff + (b >> 1) * 4 * cW + (b & 1) * 4, p = (b >> 1) * 32 + (b & 1) * 4;
        let sa = 0, sum = 0;
        for (let y = 0; y < 4; y++) {
          for (let x = 0; x < 4; x++) {
            const d = P[s + y * cW + x] - pred[p + y * 8 + x];
            blk[y * 4 + x] = d;
            sum += d;
            sa += d < 0 ? -d : d;
          }
        }
        if (sa <= zeroC) {
          this.dc[b] = sum;
          continue;
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
    if (this.k) {
      // The same search in the kernels (kernels.c search_mb).
      if (s.precision !== 'full' && !this.ref.halfReady) buildHalf(this.ref);
      const sad = this.k.x.search_mb(this.ref.R, Y.byteOffset + yOff, this.codedW, mbx, mby, s.searchRange, LAMBDA[s.qp],
        this.mvp[0], this.mvp[1], skx, sky, this.prevMvx[addr], this.prevMvy[addr],
        s.precision === 'full' ? 0 : s.precision === 'half' ? 1 : 2, this.visited.byteOffset, ++this.visitStamp, this.mvOut.byteOffset);
      this.mv[0] = this.mvOut[0];
      this.mv[1] = this.mvOut[1];
      return sad;
    }
    const R = s.searchRange;
    const R4 = R * 4;
    const lambda = LAMBDA[s.qp];
    const px = this.mvp[0], py = this.mvp[1];
    const clampI = (v) => (v < -R ? -R : v > R ? R : v);
    const rnd = (v) => clampI((v + 2) >> 2);

    let bx = 0, by = 0, bSad = 0, bCost = Infinity;
    // A position tested before gives the same cost again, so it is not tested again.
    const visited = this.visited;
    const stamp = ++this.visitStamp;
    const tryInt = (ix, iy) => {
      const vi = (iy + 64) * 129 + ix + 64;
      if (visited[vi] === stamp) return false;
      visited[vi] = stamp;
      const rate = lambda * (seBits(ix * 4 - px) + seBits(iy * 4 - py));
      // Stop the SAD when it cannot give a lower cost (+0.5: no float rounding risk).
      const sad = this.sadInt(Y, yOff, mbx, mby, ix, iy, bCost - rate + 0.5);
      const cost = sad + rate;
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
          const rate = lambda * (seBits(qx - px) + seBits(qy - py));
          const sad = sadLuma(this.ref, mbx * 16, mby * 16, qx, qy, Y, yOff, this.codedW, bCost - rate + 0.5, this.tmpY);
          const cost = sad + rate;
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
    if (this.k && !dbg.forceMv) {
      // The whole picture in the kernels (kernels.c encode_p_frame, the same steps as below).
      const k = this.k, st = this.kStats;
      st[0] = st[1] = st[2] = 0;
      st[3] = this.visitStamp;
      k.x.encode_p_frame(this.ref.R, info.I, Y.byteOffset, U.byteOffset, V.byteOffset,
        this.recY.byteOffset, this.recU.byteOffset, this.recV.byteOffset, W, this.predY.byteOffset, this.res.ptr,
        this.prevMvx.byteOffset, this.prevMvy.byteOffset, this.visited.byteOffset, qp, s.searchRange,
        s.precision === 'full' ? 0 : s.precision === 'half' ? 1 : 2, LAMBDA[qp], skipThr, healThr,
        dbg.forceMode === 'skip' ? 1 : dbg.forceMode === 'noResidual' ? 2 : 0, st.byteOffset);
      this.stats.skip = st[0];
      this.stats.inter = st[1];
      this.stats.pcm = st[2];
      this.visitStamp = st[3];
      return;
    }
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
        if (sad > healThr) {
          this.writePcm(bw, Y, U, V, mbx, mby, skipRun, 30);
          skipRun = 0;
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
        if (this.k) {
          this.k.x.write_inter_mb(skipRun, mvx - this.mvp[0], mvy - this.mvp[1], res.ptr, addr, mbx, mby, this.mbW,
            info.nzLuma.byteOffset, info.nzCb.byteOffset, info.nzCr.byteOffset);
        } else {
          bw.ue(skipRun);
          bw.ue(0);
          bw.se(mvx - this.mvp[0]);
          bw.se(mvy - this.mvp[1]);
          bw.ue(CBP_INTER_TO_CODE[cbp]);
          if (cbp) {
            bw.se(0); // mb_qp_delta
            this.writeResidual(bw, addr, mbx, mby);
          }
        }
        skipRun = 0;
        // Step 6: reconstruction (R-11).
        reconInterMB(res, qp, this.predY, this.predU, this.predV, this.recY, yOff, W, this.recU, this.recV, cOff, cW);
        this.stats.inter++;
      }
    }
    if (skipRun > 0) {
      if (this.k) this.k.x.bw_ue(skipRun);
      else bw.ue(skipRun);
    }
  }

  copyPred(yOff, cOff) {
    const W = this.codedW, cW = W >> 1;
    if (this.k) {
      this.k.x.copy_pred(this.predY.byteOffset, this.predU.byteOffset, this.predV.byteOffset,
        this.recY.byteOffset + yOff, W, this.recU.byteOffset + cOff, this.recV.byteOffset + cOff, cW);
      return;
    }
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
