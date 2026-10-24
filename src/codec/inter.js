// Inter prediction: luma 6-tap half samples, quarter-sample averages, chroma 1/8-sample bilinear.
// References: H.264 8.4.2.2.1 (luma) and 8.4.2.2.2 (chroma).
//
// A reference frame is kept as padded planes. The padding copies the edge samples. The half-sample
// planes B (horizontal), H (vertical), and J (center) are computed once for each reference frame,
// when a fractional vector first needs them.
// Coordinates outside the padded area are clamped to it. This gives exactly the spec result
// (edge clamp, unrestricted motion vectors), because the padding is wider than the filter taps.

// Vectors that reach past the padding use the clamped (slow) path. The result is the same.
export const LUMA_PAD = 32;
export const CHROMA_PAD = 16;

export function makeRef(w, h) {
  const pad = LUMA_PAD;
  const stride = w + 2 * pad;
  const rows = h + 2 * pad;
  const cw = w >> 1, ch = h >> 1, cpad = CHROMA_PAD;
  const cstride = cw + 2 * cpad;
  const crows = ch + 2 * cpad;
  return {
    w, h, pad, stride, origin: pad * stride + pad,
    G: new Uint8Array(stride * rows),
    B: new Uint8Array(stride * rows),
    H: new Uint8Array(stride * rows),
    J: new Uint8Array(stride * rows),
    cw, ch, cpad, cstride, corigin: cpad * cstride + cpad,
    U: new Uint8Array(cstride * crows),
    V: new Uint8Array(cstride * crows),
    h1row: new Int32Array(stride + 5),
    halfReady: false,
  };
}

function padPlaneInto(src, w, h, dst, pad, stride) {
  const rows = h + 2 * pad;
  for (let r = 0; r < rows; r++) {
    let sy = r - pad;
    sy = sy < 0 ? 0 : sy >= h ? h - 1 : sy;
    const s = sy * w;
    const d = r * stride;
    dst.set(src.subarray(s, s + w), d + pad);
    dst.fill(src[s], d, d + pad);
    dst.fill(src[s + w - 1], d + pad + w, d + stride);
  }
}

// Fill the reference planes from a decoded picture (Y: w*h, U/V: w/2*h/2).
export function buildRef(ref, Y, U, V) {
  padPlaneInto(Y, ref.w, ref.h, ref.G, ref.pad, ref.stride);
  padPlaneInto(U, ref.cw, ref.ch, ref.U, ref.cpad, ref.cstride);
  padPlaneInto(V, ref.cw, ref.ch, ref.V, ref.cpad, ref.cstride);
  ref.halfReady = false;
}

// The half-sample planes B, H, and J of the padded plane G.
export function buildHalf(ref) {
  const { h, pad, stride: PW, G, B, H, J } = ref;
  const PH = h + 2 * pad;
  const h1 = ref.h1row; // unrounded vertical values, with 2 edge copies on the left and 3 on the right
  const last = PW - 1;
  for (let r = 0; r < PH; r++) {
    const ro = r * PW;
    // B: horizontal half sample between G(x) and G(x+1). The columns at the edges are clamped.
    for (let x = 0; x < PW; x++) {
      if (x === 2) x = last - 2; // the inner columns are done in the next loop
      const g = (k) => G[ro + (k < 0 ? 0 : k > last ? last : k)];
      const v = (g(x - 2) + g(x + 3) - 5 * (g(x - 1) + g(x + 2)) + 20 * (g(x) + g(x + 1)) + 16) >> 5;
      B[ro + x] = v < 0 ? 0 : v > 255 ? 255 : v;
    }
    for (let o = ro + 2, end = ro + last - 2; o < end; o++) {
      const v = (G[o - 2] + G[o + 3] - 5 * (G[o - 1] + G[o + 2]) + 20 * (G[o] + G[o + 1]) + 16) >> 5;
      B[o] = v < 0 ? 0 : v > 255 ? 255 : v;
    }
    // H: vertical half sample between G(y) and G(y+1).
    const rm2 = (r - 2 < 0 ? 0 : r - 2) * PW;
    const rm1 = (r - 1 < 0 ? 0 : r - 1) * PW;
    const rp1 = (r + 1 >= PH ? PH - 1 : r + 1) * PW;
    const rp2 = (r + 2 >= PH ? PH - 1 : r + 2) * PW;
    const rp3 = (r + 3 >= PH ? PH - 1 : r + 3) * PW;
    for (let x = 0; x < PW; x++) {
      const v = G[rm2 + x] + G[rp3 + x] - 5 * (G[rm1 + x] + G[rp2 + x]) + 20 * (G[ro + x] + G[rp1 + x]);
      h1[x + 2] = v;
      const hv = (v + 16) >> 5;
      H[ro + x] = hv < 0 ? 0 : hv > 255 ? 255 : hv;
    }
    h1[0] = h1[1] = h1[2];
    h1[PW + 2] = h1[PW + 3] = h1[PW + 4] = h1[PW + 1];
    // J: center sample, from the unrounded vertical values.
    for (let x = 0; x < PW; x++) {
      const v = (h1[x] + h1[x + 5] - 5 * (h1[x + 1] + h1[x + 4]) + 20 * (h1[x + 2] + h1[x + 3]) + 512) >> 10;
      J[ro + x] = v < 0 ? 0 : v > 255 ? 255 : v;
    }
  }
  ref.halfReady = true;
}

// For each fraction (yFrac * 4 + xFrac): the two source samples to average, as
// [plane, dx, dy, plane, dx, dy]. Plane -1 = no second sample. Planes: 0 G, 1 B, 2 H, 3 J.
// From 8.4.2.2.1, Table 8-12.
const G_ = 0, B_ = 1, H_ = 2, J_ = 3, N_ = -1;
const FRAC = [
  [G_, 0, 0, N_, 0, 0], // (0,0) G
  [G_, 0, 0, B_, 0, 0], // (1,0) a
  [B_, 0, 0, N_, 0, 0], // (2,0) b
  [G_, 1, 0, B_, 0, 0], // (3,0) c
  [G_, 0, 0, H_, 0, 0], // (0,1) d
  [B_, 0, 0, H_, 0, 0], // (1,1) e
  [B_, 0, 0, J_, 0, 0], // (2,1) f
  [B_, 0, 0, H_, 1, 0], // (3,1) g
  [H_, 0, 0, N_, 0, 0], // (0,2) h
  [H_, 0, 0, J_, 0, 0], // (1,2) i
  [J_, 0, 0, N_, 0, 0], // (2,2) j
  [J_, 0, 0, H_, 1, 0], // (3,2) k
  [G_, 0, 1, H_, 0, 0], // (0,3) n
  [H_, 0, 0, B_, 0, 1], // (1,3) p
  [J_, 0, 0, B_, 0, 1], // (2,3) q
  [H_, 1, 0, B_, 0, 1], // (3,3) r
];

function planeOf(ref, i) {
  return i === 0 ? ref.G : i === 1 ? ref.B : i === 2 ? ref.H : ref.J;
}

const colIdx = new Int32Array(24);
const rowIdx = new Int32Array(24);

// Luma prediction of a bw x bh block at picture position (x, y) with a quarter-sample vector.
// out has stride bw.
export function predLuma(ref, x, y, mvx, mvy, bw, bh, out) {
  if ((mvx | mvy) & 3 && !ref.halfReady) buildHalf(ref);
  const xi = x + (mvx >> 2);
  const yi = y + (mvy >> 2);
  const f = FRAC[((mvy & 3) << 2) | (mvx & 3)];
  const P1 = planeOf(ref, f[0]);
  const two = f[3] >= 0;
  const P2 = two ? planeOf(ref, f[3]) : null;
  const { pad, stride, w, h } = ref;
  if (xi >= -pad && yi >= -pad && xi + bw + 1 <= w + pad && yi + bh + 1 <= h + pad) {
    const base = ref.origin + yi * stride + xi;
    const o1 = base + f[2] * stride + f[1];
    if (!two) {
      for (let r = 0; r < bh; r++) {
        const s = o1 + r * stride, d = r * bw;
        for (let c = 0; c < bw; c++) out[d + c] = P1[s + c];
      }
    } else {
      const o2 = base + f[5] * stride + f[4];
      for (let r = 0; r < bh; r++) {
        const s1 = o1 + r * stride, s2 = o2 + r * stride, d = r * bw;
        for (let c = 0; c < bw; c++) out[d + c] = (P1[s1 + c] + P2[s2 + c] + 1) >> 1;
      }
    }
    return;
  }
  // Slow path: clamp each coordinate to the padded area.
  const lo = -pad, hiX = w + pad - 1, hiY = h + pad - 1;
  for (let i = 0; i <= bw; i++) {
    const v = xi + i;
    colIdx[i] = (v < lo ? lo : v > hiX ? hiX : v) + pad;
  }
  for (let i = 0; i <= bh; i++) {
    const v = yi + i;
    rowIdx[i] = ((v < lo ? lo : v > hiY ? hiY : v) + pad) * stride;
  }
  for (let r = 0; r < bh; r++) {
    for (let c = 0; c < bw; c++) {
      const a = P1[rowIdx[r + f[2]] + colIdx[c + f[1]]];
      out[r * bw + c] = two ? (a + P2[rowIdx[r + f[5]] + colIdx[c + f[4]]] + 1) >> 1 : a;
    }
  }
}

// SAD of the 16x16 luma prediction against the source Y (stride yStride, offset yOff), without
// writing the prediction. It stops (and returns a value > limit) when the sum is above limit.
// The values are the same as predLuma; tmp (256 bytes) is used for the slow path only.
export function sadLuma(ref, x, y, mvx, mvy, Y, yOff, yStride, limit, tmp) {
  if ((mvx | mvy) & 3 && !ref.halfReady) buildHalf(ref);
  const xi = x + (mvx >> 2);
  const yi = y + (mvy >> 2);
  const { pad, stride, w, h } = ref;
  let sad = 0;
  if (!(xi >= -pad && yi >= -pad && xi + 17 <= w + pad && yi + 17 <= h + pad)) {
    predLuma(ref, x, y, mvx, mvy, 16, 16, tmp);
    for (let r = 0; r < 16; r++) {
      const s = yOff + r * yStride;
      for (let c = 0; c < 16; c++) {
        const d = Y[s + c] - tmp[r * 16 + c];
        sad += d < 0 ? -d : d;
      }
      if (sad > limit) return sad;
    }
    return sad;
  }
  const f = FRAC[((mvy & 3) << 2) | (mvx & 3)];
  const P1 = planeOf(ref, f[0]);
  const base = ref.origin + yi * stride + xi;
  let o1 = base + f[2] * stride + f[1];
  if (f[3] < 0) {
    for (let r = 0; r < 16; r++) {
      const s = yOff + r * yStride;
      for (let c = 0; c < 16; c++) {
        const d = Y[s + c] - P1[o1 + c];
        sad += d < 0 ? -d : d;
      }
      if (sad > limit) return sad;
      o1 += stride;
    }
    return sad;
  }
  const P2 = planeOf(ref, f[3]);
  let o2 = base + f[5] * stride + f[4];
  for (let r = 0; r < 16; r++) {
    const s = yOff + r * yStride;
    for (let c = 0; c < 16; c++) {
      const d = Y[s + c] - ((P1[o1 + c] + P2[o2 + c] + 1) >> 1);
      sad += d < 0 ? -d : d;
    }
    if (sad > limit) return sad;
    o1 += stride;
    o2 += stride;
  }
  return sad;
}

// Chroma prediction (both components) of a bw x bh block at chroma position (x, y).
// The vector is the luma vector; in chroma samples it has 1/8 precision (4:2:0).
export function predChroma(ref, x, y, mvx, mvy, bw, bh, outU, outV) {
  const xi = x + (mvx >> 3);
  const yi = y + (mvy >> 3);
  const xF = mvx & 7, yF = mvy & 7;
  const wA = (8 - xF) * (8 - yF), wB = xF * (8 - yF), wC = (8 - xF) * yF, wD = xF * yF;
  const { cpad: pad, cstride: stride, cw: w, ch: h } = ref;
  for (let comp = 0; comp < 2; comp++) {
    const P = comp ? ref.V : ref.U;
    const out = comp ? outV : outU;
    if (xi >= -pad && yi >= -pad && xi + bw + 1 <= w + pad && yi + bh + 1 <= h + pad) {
      const base = ref.corigin + yi * stride + xi;
      for (let r = 0; r < bh; r++) {
        const s = base + r * stride, d = r * bw;
        for (let c = 0; c < bw; c++) {
          const o = s + c;
          out[d + c] = (wA * P[o] + wB * P[o + 1] + wC * P[o + stride] + wD * P[o + stride + 1] + 32) >> 6;
        }
      }
    } else {
      const lo = -pad, hiX = w + pad - 1, hiY = h + pad - 1;
      for (let i = 0; i <= bw; i++) {
        const v = xi + i;
        colIdx[i] = (v < lo ? lo : v > hiX ? hiX : v) + pad;
      }
      for (let i = 0; i <= bh; i++) {
        const v = yi + i;
        rowIdx[i] = ((v < lo ? lo : v > hiY ? hiY : v) + pad) * stride;
      }
      for (let r = 0; r < bh; r++) {
        for (let c = 0; c < bw; c++) {
          const A = P[rowIdx[r] + colIdx[c]], B = P[rowIdx[r] + colIdx[c + 1]];
          const C = P[rowIdx[r + 1] + colIdx[c]], D = P[rowIdx[r + 1] + colIdx[c + 1]];
          out[r * bw + c] = (wA * A + wB * B + wC * C + wD * D + 32) >> 6;
        }
      }
    }
  }
}
