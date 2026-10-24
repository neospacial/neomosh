// RGBA <-> YCbCr 4:2:0, BT.709, limited range (plan §6.1). Integer math.

// Convert a visible RGBA picture (w x h, even) to coded-size planes. The area outside the
// visible picture is filled by edge copy.
export function rgbaToYuv420(rgba, w, h, codedW, codedH, Y, U, V) {
  for (let y = 0; y < h; y++) {
    let s = y * w * 4, d = y * codedW;
    for (let x = 0; x < w; x++, s += 4) {
      Y[d + x] = 16 + ((47 * rgba[s] + 157 * rgba[s + 1] + 16 * rgba[s + 2] + 128) >> 8);
    }
  }
  const cW = codedW >> 1, cw = w >> 1, ch = h >> 1;
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const s0 = (2 * y * w + 2 * x) * 4, s1 = s0 + w * 4;
      const r = rgba[s0] + rgba[s0 + 4] + rgba[s1] + rgba[s1 + 4];
      const g = rgba[s0 + 1] + rgba[s0 + 5] + rgba[s1 + 1] + rgba[s1 + 5];
      const b = rgba[s0 + 2] + rgba[s0 + 6] + rgba[s1 + 2] + rgba[s1 + 6];
      // Sums of 4 samples: divide by 4 * 256.
      U[y * cW + x] = 128 + ((-26 * r - 87 * g + 113 * b + 512) >> 10);
      V[y * cW + x] = 128 + ((112 * r - 102 * g - 10 * b + 512) >> 10);
    }
  }
  padPlane(Y, w, h, codedW, codedH);
  padPlane(U, cw, ch, cW, codedH >> 1);
  padPlane(V, cw, ch, cW, codedH >> 1);
}

// Fill the area of a plane (stride = codedW) outside w x h by edge copy.
export function padPlane(P, w, h, codedW, codedH) {
  for (let y = 0; y < h; y++) {
    const o = y * codedW;
    P.fill(P[o + w - 1], o + w, o + codedW);
  }
  for (let y = h; y < codedH; y++) P.copyWithin(y * codedW, (h - 1) * codedW, h * codedW);
}

// Convert planes (stride = codedW) to a visible RGBA picture.
export function yuv420ToRgba(Y, U, V, codedW, w, h, rgba) {
  const cW = codedW >> 1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const c = 298 * (Y[y * codedW + x] - 16);
      const ci = (y >> 1) * cW + (x >> 1);
      const u = U[ci] - 128, v = V[ci] - 128;
      const o = (y * w + x) * 4;
      const r = (c + 459 * v + 128) >> 8;
      const g = (c - 55 * u - 136 * v + 128) >> 8;
      const b = (c + 541 * u + 128) >> 8;
      rgba[o] = r < 0 ? 0 : r > 255 ? 255 : r;
      rgba[o + 1] = g < 0 ? 0 : g > 255 ? 255 : g;
      rgba[o + 2] = b < 0 ? 0 : b > 255 ? 255 : b;
      rgba[o + 3] = 255;
    }
  }
}
