// Camera YUV to the encoder input (D22): copy the cropped area of a VideoFrame (I420 or NV12),
// then scale, mirror, and convert the colour to BT.709 limited range in the kernels. There is no
// GPU, canvas, or RGBA step.

import { Kernels } from '../codec/wasm.js';

const align16 = (n) => (n + 15) & ~15;
const KRB = { bt709: [0.2126, 0.0722], bt470bg: [0.299, 0.114], smpte170m: [0.299, 0.114], 'bt2020-ncl': [0.2627, 0.0593] };

// The 3x3 matrix (Q12) from the source YUV to BT.709 limited range, and the source Y offset.
// cs: VideoColorSpace (matrix, fullRange). An unknown matrix is taken as BT.601 (smpte170m).
export function colourMatrix(cs) {
  const [sKr, sKb] = KRB[cs && cs.matrix] || KRB.smpte170m;
  const full = !!(cs && cs.fullRange);
  const yo = full ? 0 : 16, yr = full ? 255 : 219, cr = full ? 255 : 224;
  const [Kr, Kb] = KRB.bt709;
  // Source (dy, du, dv) -> RGB (0..1) -> BT.709 limited (dY, dU, dV). Linear, so the columns are the
  // images of the unit vectors.
  const map = (dy, du, dv) => {
    const y = dy / yr, u = du / cr, v = dv / cr;
    const R = y + 2 * (1 - sKr) * v, B = y + 2 * (1 - sKb) * u, G = (y - sKr * R - sKb * B) / (1 - sKr - sKb);
    const Y = Kr * R + (1 - Kr - Kb) * G + Kb * B;
    return [219 * Y, (224 * (B - Y)) / (2 * (1 - Kb)), (224 * (R - Y)) / (2 * (1 - Kr))];
  };
  const cols = [map(1, 0, 0), map(0, 1, 0), map(0, 0, 1)];
  const M = new Int32Array(10);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) M[r * 3 + c] = Math.round(cols[c][r] * 4096);
  M[9] = yo;
  return M;
}

export class CamYuv {
  // Returns null when the kernels are not available.
  static create(w, h) {
    const k = Kernels.create();
    return k ? new CamYuv(k, w, h) : null;
  }

  constructor(k, w, h) {
    this.k = k;
    this.w = w;
    this.h = h;
    this.codedW = align16(w);
    this.codedH = align16(h);
    const n = this.codedW * this.codedH;
    this.out = k.alloc(n * 3 / 2);
    this.tmp = k.alloc(n * 3 / 2 + w * h * 4); // calibration: RGBA and its YUV
    this.M = k.alloc(40);
    this.scratch = k.alloc(4 * (4 * w + 2 * w + 2 * w));
    this.src = 0;
    this.srcSize = 0;
    this.csKey = null;
  }

  static usable(frame) {
    return frame.format === 'I420' || frame.format === 'NV12';
  }

  // The crop rect, on even numbers (4:2:0).
  static rect(c) {
    const x = c.sx & ~1, y = c.sy & ~1;
    return { x, y, width: Math.max(2, c.sw & ~1), height: Math.max(2, c.sh & ~1) };
  }

  // frame: a camera VideoFrame. c: the crop (coverCrop). Returns [Y, U, V] (coded size, new arrays).
  async convert(frame, c, mirror) {
    const k = this.k;
    const rect = CamYuv.rect(c);
    const size = frame.allocationSize({ rect });
    if (size > this.srcSize) {
      this.src = k.alloc(size);
      this.half = k.alloc(2 * ((rect.width >> 1) * (rect.height >> 1) * 3 / 2 + 16));
      this.srcSize = size;
    }
    const key = JSON.stringify(frame.colorSpace && frame.colorSpace.toJSON ? frame.colorSpace.toJSON() : frame.colorSpace);
    if (key !== this.csKey) {
      this.csKey = key;
      k.i32(this.M, 10).set(colourMatrix(frame.colorSpace));
    }
    const layout = await frame.copyTo(k.u8(this.src, size), { rect });
    const nv12 = frame.format === 'NV12';
    const sy = this.src + layout[0].offset, su = this.src + layout[1].offset;
    const sv = nv12 ? su + 1 : this.src + layout[2].offset;
    const n = this.codedW * this.codedH, cn = n >> 2;
    k.x.scale_yuv(sy, layout[0].stride, su, sv, layout[1].stride, nv12 ? 2 : 1, rect.width, rect.height,
      this.out, this.out + n, this.out + n + cn, this.w, this.h, this.codedW, this.codedH, mirror ? 1 : 0,
      this.M, this.scratch, this.half);
    const all = k.u8(this.out, n + 2 * cn).slice();
    return [all.subarray(0, n), all.subarray(n, n + cn), all.subarray(n + cn)];
  }

  // Compare with the RGBA path of the same frame (visible size): the mean absolute difference of the
  // 8x8 block means (luma; 4x4 for chroma, the same area), so that noise and the scale filters do not
  // count. A large difference means a wrong colour matrix or range: do not use this path.
  calibrate(rgba, planes) {
    const { k, w, h, codedW, codedH } = this;
    const n = codedW * codedH, cn = n >> 2;
    const p = this.tmp + w * h * 4;
    k.u8(this.tmp, w * h * 4).set(rgba);
    k.x.rgba_to_yuv420(this.tmp, w, h, codedW, codedH, p, p + n, p + n + cn);
    const ref = k.u8(p, n + 2 * cn);
    // Blocks with a clipped RGB channel (0 or 255) are left out: there the canvas way lost the colour.
    const cs = codedW >> 1, cn2 = n + cn;
    let dy = 0, du = 0, dv = 0, blocks = 0;
    for (let by = 0; by + 8 <= h; by += 8) {
      for (let bx = 0; bx + 8 <= w; bx += 8) {
        let clipped = false;
        for (let y = by; y < by + 8 && !clipped; y++) {
          for (let x = bx; x < bx + 8; x++) {
            const p = (y * w + x) * 4;
            if (rgba[p] === 0 || rgba[p] === 255 || rgba[p + 1] === 0 || rgba[p + 1] === 255 || rgba[p + 2] === 0 || rgba[p + 2] === 255) {
              clipped = true;
              break;
            }
          }
        }
        if (clipped) continue;
        let sy = 0, su = 0, sv = 0;
        for (let y = by; y < by + 8; y++) for (let x = bx; x < bx + 8; x++) sy += ref[y * codedW + x] - planes[0][y * codedW + x];
        for (let y = by >> 1; y < (by >> 1) + 4; y++) {
          for (let x = bx >> 1; x < (bx >> 1) + 4; x++) {
            su += ref[n + y * cs + x] - planes[1][y * cs + x];
            sv += ref[cn2 + y * cs + x] - planes[2][y * cs + x];
          }
        }
        dy += Math.abs(sy) / 64;
        du += Math.abs(su) / 16;
        dv += Math.abs(sv) / 16;
        blocks++;
      }
    }
    // Too few blocks to tell (a saturated scene): null, try again on a later frame.
    if (blocks < 0.05 * (w >> 3) * (h >> 3)) return null;
    return { y: dy / blocks, u: du / blocks, v: dv / blocks };
  }
}
