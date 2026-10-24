// Frame decoder for the H.264 subset that the encoder makes (plan §6).
// I slices: I_PCM only. P slices: P_Skip, P_L0_16x16, I_PCM. No deblocking filter.
// R-07: a hidden I-frame does not change the decoder reference (unless it is shown, for a Clean cut).
// R-08: the reference can be set from a stored picture.

import { BitReader } from './bitio.js';
import { ZIGZAG4x4, CBP_INTER_FROM_CODE } from './tables.js';
import { readResidualBlock } from './cavlc.js';
import { makeRef, allocRef, buildRef, predLuma, predChroma } from './inter.js';
import { yuv420ToRgba } from './color.js';
import { Kernels } from './wasm.js';
import { makeMbInfo, allocMbInfo, mvPred16x16, mvSkip, lumaNC, chromaNC, MB_SKIP, MB_INTER, MB_PCM } from './mvpred.js';
import { MbResidual, reconInterMB } from './transform.js';
import { align16, parseNal } from './headers.js';

// The error codes of kernels.c decode_slice.
const DECODE_ERRORS = [
  '', 'mb_skip_run too large', 'Macroblock type is not supported', 'Bits left after the last macroblock',
  'pcm_alignment_zero_bit is not zero', 'Motion vector out of range', 'coded_block_pattern out of range',
  'mb_qp_delta out of range', 'CAVLC: invalid code', 'BitReader: read past end',
];

export class Decoder {
  // w, h: visible size.
  constructor(w, h) {
    this.w = w;
    this.h = h;
    this.codedW = align16(w);
    this.codedH = align16(h);
    this.mbW = this.codedW >> 4;
    this.mbH = this.codedH >> 4;
    this.numMbs = this.mbW * this.mbH;
    const n = this.codedW * this.codedH, cn = n >> 2;
    // D21: the planes and buffers are in the memory of the WebAssembly kernels when available.
    const k = Kernels.create();
    this.k = k;
    if (k) {
      this.bitCap = this.numMbs * 1600 + 4096;
      const p = {
        pic: k.alloc(n + 2 * cn), pred: k.alloc(384), res: k.alloc(417 * 4), rgba: k.alloc(w * h * 4), bits: k.alloc(this.bitCap),
      };
      const mkRef = allocRef(k, this.codedW, this.codedH);
      const mkInfo = allocMbInfo(k, this.numMbs, this.mbW, this.mbH);
      k.seal();
      this.ref = mkRef();
      this.info = mkInfo();
      this.bitBuf = k.u8(p.bits, this.bitCap);
      [this.Y, this.U, this.V] = [k.u8(p.pic, n), k.u8(p.pic + n, cn), k.u8(p.pic + n + cn, cn)];
      [this.predY, this.predU, this.predV] = [k.u8(p.pred, 256), k.u8(p.pred + 256, 64), k.u8(p.pred + 320, 64)];
      this.res = new MbResidual(k, p.res);
      this.rgba = k.u8(p.rgba, w * h * 4);
    } else {
      [this.Y, this.U, this.V] = [new Uint8Array(n), new Uint8Array(cn), new Uint8Array(cn)];
      this.ref = makeRef(this.codedW, this.codedH);
      [this.predY, this.predU, this.predV] = [new Uint8Array(256), new Uint8Array(64), new Uint8Array(64)];
      this.res = new MbResidual();
      this.rgba = new Uint8Array(w * h * 4);
      this.info = makeMbInfo(this.numMbs);
    }
    this.coef = new Int32Array(16);
    this.mv = new Int32Array(2);
    this.hasRef = false;
  }

  // Decode a stored frame packet { type, qp, bits, bitLen, hdrBits }.
  // Returns true when the picture changed.
  decodePacket(pkt, show = false) {
    if (pkt.type === 'hiddenI' && !show) return false;
    const br = new BitReader(pkt.bits, pkt.bitLen, pkt.hdrBits);
    this.decodeSliceData(br, pkt.type !== 'p', pkt.qp);
    return true;
  }

  // Decode one NAL unit of an Annex B stream. Returns true for a slice.
  decodeNal(nal) {
    const s = parseNal(nal);
    if (!s.reader) return false;
    if (s.firstMb !== 0) throw new Error('Only one slice for each picture is supported');
    this.decodeSliceData(s.reader, s.intra, s.qp);
    return true;
  }

  decodeSliceData(br, intra, sliceQp) {
    if (!intra && !this.hasRef) throw new Error('P picture without a reference picture');
    const nBytes = (br.len + 7) >> 3;
    if (this.k && nBytes <= this.bitCap) {
      // The whole slice in the kernels (kernels.c decode_slice, the same steps as below).
      this.bitBuf.set(br.buf.subarray(0, nBytes));
      const err = this.k.x.decode_slice(this.bitBuf.byteOffset, br.pos, br.len, br.alignBase, intra ? 1 : 0, sliceQp,
        this.ref.R, this.info.I, this.Y.byteOffset, this.U.byteOffset, this.V.byteOffset, this.codedW,
        this.predY.byteOffset, this.res.ptr);
      if (err) throw new Error(DECODE_ERRORS[err] || `Decode error ${err}`);
      buildRef(this.ref, this.Y, this.U, this.V);
      this.hasRef = true;
      return;
    }
    const n = this.numMbs;
    let qp = sliceQp;
    let addr = 0;
    while (addr < n) {
      if (!intra) {
        let run = br.ue();
        if (addr + run > n) throw new Error('mb_skip_run too large');
        while (run-- > 0) this.decodeSkip(addr++);
        if (addr >= n) break;
      }
      const mbType = br.ue();
      if (intra ? mbType === 25 : mbType === 30) this.decodePcm(br, addr);
      else if (!intra && mbType === 0) qp = this.decodeInter(br, addr, qp);
      else throw new Error(`Macroblock type ${mbType} is not supported`);
      addr++;
    }
    if (br.bitsLeft() !== 0) throw new Error(`${br.bitsLeft()} bits left after the last macroblock`);
    buildRef(this.ref, this.Y, this.U, this.V);
    this.hasRef = true;
  }

  decodeSkip(addr) {
    const mbx = addr % this.mbW, mby = (addr / this.mbW) | 0;
    const info = this.info;
    const mv = this.mv;
    mvSkip(info, mbx, mby, this.mbW, mv);
    info.type[addr] = MB_SKIP;
    info.mvx[addr] = mv[0];
    info.mvy[addr] = mv[1];
    info.nzLuma.fill(0, addr * 16, addr * 16 + 16);
    info.nzCb.fill(0, addr * 4, addr * 4 + 4);
    info.nzCr.fill(0, addr * 4, addr * 4 + 4);
    this.predict(mbx, mby, mv[0], mv[1]);
    const W = this.codedW, cW = W >> 1;
    const yOff = mby * 16 * W + mbx * 16, cOff = mby * 8 * cW + mbx * 8;
    if (this.k) {
      this.k.x.copy_pred(this.predY.byteOffset, this.predU.byteOffset, this.predV.byteOffset,
        this.Y.byteOffset + yOff, W, this.U.byteOffset + cOff, this.V.byteOffset + cOff, cW);
      return;
    }
    for (let y = 0; y < 16; y++) this.Y.set(this.predY.subarray(y * 16, y * 16 + 16), yOff + y * W);
    for (let y = 0; y < 8; y++) {
      this.U.set(this.predU.subarray(y * 8, y * 8 + 8), cOff + y * cW);
      this.V.set(this.predV.subarray(y * 8, y * 8 + 8), cOff + y * cW);
    }
  }

  predict(mbx, mby, mvx, mvy) {
    predLuma(this.ref, mbx * 16, mby * 16, mvx, mvy, 16, 16, this.predY);
    predChroma(this.ref, mbx * 8, mby * 8, mvx, mvy, 8, 8, this.predU, this.predV);
  }

  decodePcm(br, addr) {
    const mbx = addr % this.mbW, mby = (addr / this.mbW) | 0;
    if (br.alignSkip() !== 0) throw new Error('pcm_alignment_zero_bit is not zero');
    const W = this.codedW, cW = W >> 1;
    const yOff = mby * 16 * W + mbx * 16, cOff = mby * 8 * cW + mbx * 8;
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) this.Y[yOff + y * W + x] = br.u(8);
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) this.U[cOff + y * cW + x] = br.u(8);
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) this.V[cOff + y * cW + x] = br.u(8);
    const info = this.info;
    info.type[addr] = MB_PCM;
    info.mvx[addr] = 0;
    info.mvy[addr] = 0;
    info.nzLuma.fill(16, addr * 16, addr * 16 + 16);
    info.nzCb.fill(16, addr * 4, addr * 4 + 4);
    info.nzCr.fill(16, addr * 4, addr * 4 + 4);
  }

  decodeInter(br, addr, qp) {
    const mbx = addr % this.mbW, mby = (addr / this.mbW) | 0;
    const info = this.info;
    const mv = this.mv;
    mvPred16x16(info, mbx, mby, this.mbW, mv);
    const mvx = mv[0] + br.se();
    const mvy = mv[1] + br.se();
    if (mvx < -8192 || mvx > 8191 || mvy < -2048 || mvy > 2047) throw new Error('Motion vector out of range');
    const code = br.ue();
    if (code > 47) throw new Error('coded_block_pattern out of range');
    const cbp = CBP_INTER_FROM_CODE[code];
    if (cbp > 0) {
      const dq = br.se();
      if (dq < -26 || dq > 25) throw new Error('mb_qp_delta out of range');
      qp = (qp + dq + 52) % 52;
    }
    info.type[addr] = MB_INTER;
    info.mvx[addr] = mvx;
    info.mvy[addr] = mvy;
    info.nzLuma.fill(0, addr * 16, addr * 16 + 16);
    info.nzCb.fill(0, addr * 4, addr * 4 + 4);
    info.nzCr.fill(0, addr * 4, addr * 4 + 4);

    const res = this.res;
    const coef = this.coef;
    res.clear();
    res.cbp = cbp;
    for (let b8 = 0; b8 < 4; b8++) {
      if (!((cbp >> b8) & 1)) continue;
      for (let b4 = 0; b4 < 4; b4++) {
        const bx = (b8 & 1) * 2 + (b4 & 1), by = (b8 >> 1) * 2 + (b4 >> 1);
        const blk = by * 4 + bx;
        coef.fill(0);
        const n = readResidualBlock(br, coef, 16, lumaNC(info, addr, mbx, mby, this.mbW, bx, by));
        info.nzLuma[addr * 16 + blk] = n;
        res.nzLuma[blk] = n;
        for (let i = 0; i < 16; i++) res.luma[blk * 16 + ZIGZAG4x4[i]] = coef[i];
      }
    }
    const cc = cbp >> 4;
    if (cc) {
      for (let comp = 0; comp < 2; comp++) {
        coef.fill(0);
        readResidualBlock(br, coef, 4, -1);
        (comp ? res.crDC : res.cbDC).set(coef.subarray(0, 4));
      }
    }
    if (cc === 2) {
      for (let comp = 0; comp < 2; comp++) {
        const nz = comp ? info.nzCr : info.nzCb;
        const ac = comp ? res.cr : res.cb;
        for (let b = 0; b < 4; b++) {
          coef.fill(0);
          const n = readResidualBlock(br, coef, 15, chromaNC(nz, addr, mbx, mby, this.mbW, b & 1, b >> 1));
          nz[addr * 4 + b] = n;
          for (let i = 0; i < 15; i++) ac[b * 16 + ZIGZAG4x4[i + 1]] = coef[i];
        }
      }
    }
    this.predict(mbx, mby, mvx, mvy);
    const W = this.codedW, cW = W >> 1;
    reconInterMB(res, qp, this.predY, this.predU, this.predV,
      this.Y, mby * 16 * W + mbx * 16, W, this.U, this.V, mby * 8 * cW + mbx * 8, cW);
    return qp;
  }

  // The current picture as RGBA (visible size). The array is reused by the next call.
  toRgba() {
    if (this.k) {
      this.k.x.yuv420_to_rgba(this.Y.byteOffset, this.U.byteOffset, this.V.byteOffset, this.codedW, this.w, this.h, this.rgba.byteOffset);
    } else yuv420ToRgba(this.Y, this.U, this.V, this.codedW, this.w, this.h, this.rgba);
    return this.rgba;
  }

  // The current picture, cropped to the visible size (new arrays).
  getFrame() {
    return cropPicture(this.Y, this.U, this.V, this.codedW, this.w, this.h);
  }

  // R-08: set the reference picture (coded size planes), for revert and session restore.
  setRef(Y, U, V) {
    this.Y.set(Y);
    this.U.set(U);
    this.V.set(V);
    buildRef(this.ref, this.Y, this.U, this.V);
    this.hasRef = true;
  }

  // A copy of the current picture (coded size), for a pause point.
  snapshot() {
    return { Y: this.Y.slice(), U: this.U.slice(), V: this.V.slice() };
  }
}

export function cropPicture(Y, U, V, codedW, w, h) {
  const y = new Uint8Array(w * h);
  const u = new Uint8Array((w * h) >> 2);
  const v = new Uint8Array((w * h) >> 2);
  for (let r = 0; r < h; r++) y.set(Y.subarray(r * codedW, r * codedW + w), r * w);
  const cW = codedW >> 1, cw = w >> 1;
  for (let r = 0; r < h >> 1; r++) {
    u.set(U.subarray(r * cW, r * cW + cw), r * cw);
    v.set(V.subarray(r * cW, r * cW + cw), r * cw);
  }
  return { y, u, v };
}
