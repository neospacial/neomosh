// neomosh codec kernels in WebAssembly (SIMD). Plan R-09 (D21): the computation-intensive parts of
// the encoder and the decoder. Each function is an exact port of the JavaScript version in
// src/codec/*.js: the integer arithmetic is the same, so the output is bit-identical.
// Build: node tools/build-wasm.mjs (clang, target wasm32, -msimd128).

#include <stdint.h>
#include <wasm_simd128.h>

#define EXPORT(name) __attribute__((export_name(#name)))
typedef uint8_t u8;
typedef int32_t i32;

static inline int clampi(int v, int lo, int hi) { return v < lo ? lo : v > hi ? hi : v; }
static inline int clip255(int v) { return v < 0 ? 0 : v > 255 ? 255 : v; }
#define P8(a) ((u8 *)(uintptr_t)(a))
#define P32(a) ((i32 *)(uintptr_t)(a))

/* ---------------- tables (src/codec/tables.js) ---------------- */

static const int QUANT_MF[6][3] = {
  {13107, 5243, 8066}, {11916, 4660, 7490}, {10082, 4194, 6554},
  {9362, 3647, 5825}, {8192, 3355, 5243}, {7282, 2893, 4559},
};
static const int DEQUANT_V[6][3] = {
  {10, 16, 13}, {11, 18, 14}, {13, 20, 16}, {14, 23, 18}, {16, 25, 20}, {18, 29, 23},
};
static const u8 CHROMA_QP[52] = {
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25,
  26, 27, 28, 29, 29, 30, 31, 32, 32, 33, 34, 34, 35, 35, 36, 36, 37, 37, 37, 38, 38, 38, 39, 39,
  39, 39,
};

/* ---------------- reference picture (src/codec/inter.js) ----------------
   R (i32[16]): 0 w, 1 h, 2 pad, 3 stride, 4 G, 5 B, 6 H, 7 J, 8 cw, 9 ch, 10 cpad, 11 cstride,
   12 U, 13 V, 14 h1 row buffer (int16[stride + 32]), 15 halfReady (B, H, J are built).
   Plane pointers are at the padded start. */
enum { RW, RH, RPAD, RSTRIDE, RG, RB, RHH, RJ, RCW, RCH, RCPAD, RCSTRIDE, RU, RV, RH1, RHALF };

static void pad_plane(const u8 *src, int w, int h, u8 *dst, int pad, int stride) {
  int rows = h + 2 * pad;
  for (int r = 0; r < rows; r++) {
    int sy = clampi(r - pad, 0, h - 1);
    const u8 *s = src + sy * w;
    u8 *d = dst + r * stride;
    __builtin_memset(d, s[0], pad);
    __builtin_memcpy(d + pad, s, w);
    __builtin_memset(d + pad + w, s[w - 1], stride - pad - w);
  }
}

EXPORT(build_ref)
void build_ref(i32 *R, const u8 *Y, const u8 *U, const u8 *V) {
  pad_plane(Y, R[RW], R[RH], P8(R[RG]), R[RPAD], R[RSTRIDE]);
  pad_plane(U, R[RCW], R[RCH], P8(R[RU]), R[RCPAD], R[RCSTRIDE]);
  pad_plane(V, R[RCW], R[RCH], P8(R[RV]), R[RCPAD], R[RCSTRIDE]);
  R[RHALF] = 0;
}

// 6-tap on 8 int16 lanes: a + f - 5 (b + e) + 20 (c + d).
static inline v128_t tap6_i16(v128_t a, v128_t b, v128_t c, v128_t d, v128_t e, v128_t f) {
  v128_t s = wasm_i16x8_add(a, f);
  s = wasm_i16x8_sub(s, wasm_i16x8_mul(wasm_i16x8_add(b, e), wasm_i16x8_splat(5)));
  return wasm_i16x8_add(s, wasm_i16x8_mul(wasm_i16x8_add(c, d), wasm_i16x8_splat(20)));
}
static inline v128_t ld8_u16(const u8 *p) { return wasm_u16x8_load8x8(p); }

EXPORT(build_half)
void build_half(i32 *R) {
  const int h = R[RH], pad = R[RPAD], PW = R[RSTRIDE];
  const int PH = h + 2 * pad, last = PW - 1;
  const u8 *G = P8(R[RG]);
  u8 *B = P8(R[RB]), *H = P8(R[RHH]), *J = P8(R[RJ]);
  // h1: the unrounded vertical values of a row (-2550 .. 10710, so int16), with 2 edge copies on
  // the left and 3 on the right.
  int16_t *h16 = (int16_t *)(uintptr_t)R[RH1];
  for (int r = 0; r < PH; r++) {
    const int ro = r * PW;
    const u8 *g = G + ro;
    // B: columns at the edges are clamped.
    for (int x = 0; x < 2; x++) {
      int v = g[clampi(x - 2, 0, last)] + g[x + 3] - 5 * (g[clampi(x - 1, 0, last)] + g[x + 2]) + 20 * (g[x] + g[x + 1]);
      B[ro + x] = clip255((v + 16) >> 5);
    }
    int x = 2;
    for (; x + 8 <= last - 2; x += 8) {
      v128_t v = tap6_i16(ld8_u16(g + x - 2), ld8_u16(g + x - 1), ld8_u16(g + x), ld8_u16(g + x + 1), ld8_u16(g + x + 2), ld8_u16(g + x + 3));
      v = wasm_i16x8_shr(wasm_i16x8_add(v, wasm_i16x8_splat(16)), 5);
      wasm_v128_store64_lane(B + ro + x, wasm_u8x16_narrow_i16x8(v, v), 0);
    }
    for (; x < PW; x++) {
      int v = g[clampi(x - 2, 0, last)] + g[clampi(x + 3, 0, last)] - 5 * (g[clampi(x - 1, 0, last)] + g[clampi(x + 2, 0, last)]) +
              20 * (g[x] + g[clampi(x + 1, 0, last)]);
      B[ro + x] = clip255((v + 16) >> 5);
    }
    // H: vertical half sample; h1 keeps the unrounded value for J.
    const u8 *rm2 = G + clampi(r - 2, 0, PH - 1) * PW, *rm1 = G + clampi(r - 1, 0, PH - 1) * PW;
    const u8 *rp1 = G + clampi(r + 1, 0, PH - 1) * PW, *rp2 = G + clampi(r + 2, 0, PH - 1) * PW;
    const u8 *rp3 = G + clampi(r + 3, 0, PH - 1) * PW;
    x = 0;
    for (; x + 8 <= PW; x += 8) {
      v128_t v = tap6_i16(ld8_u16(rm2 + x), ld8_u16(rm1 + x), ld8_u16(g + x), ld8_u16(rp1 + x), ld8_u16(rp2 + x), ld8_u16(rp3 + x));
      wasm_v128_store(h16 + x + 2, v);
      v128_t hv = wasm_i16x8_shr(wasm_i16x8_add(v, wasm_i16x8_splat(16)), 5);
      wasm_v128_store64_lane(H + ro + x, wasm_u8x16_narrow_i16x8(hv, hv), 0);
    }
    for (; x < PW; x++) {
      int v = rm2[x] + rp3[x] - 5 * (rm1[x] + rp2[x]) + 20 * (g[x] + rp1[x]);
      h16[x + 2] = (int16_t)v;
      H[ro + x] = clip255((v + 16) >> 5);
    }
    h16[0] = h16[1] = h16[2];
    h16[PW + 2] = h16[PW + 3] = h16[PW + 4] = h16[PW + 1];
    // J: center sample from the unrounded vertical values (needs 32 bits).
    x = 0;
    for (; x + 8 <= PW; x += 8) {
      v128_t a = wasm_v128_load(h16 + x), b = wasm_v128_load(h16 + x + 1), c = wasm_v128_load(h16 + x + 2);
      v128_t d = wasm_v128_load(h16 + x + 3), e = wasm_v128_load(h16 + x + 4), f = wasm_v128_load(h16 + x + 5);
      v128_t lo = wasm_i32x4_add(wasm_i32x4_extend_low_i16x8(a), wasm_i32x4_extend_low_i16x8(f));
      v128_t hi = wasm_i32x4_add(wasm_i32x4_extend_high_i16x8(a), wasm_i32x4_extend_high_i16x8(f));
      v128_t be_lo = wasm_i32x4_add(wasm_i32x4_extend_low_i16x8(b), wasm_i32x4_extend_low_i16x8(e));
      v128_t be_hi = wasm_i32x4_add(wasm_i32x4_extend_high_i16x8(b), wasm_i32x4_extend_high_i16x8(e));
      v128_t cd_lo = wasm_i32x4_add(wasm_i32x4_extend_low_i16x8(c), wasm_i32x4_extend_low_i16x8(d));
      v128_t cd_hi = wasm_i32x4_add(wasm_i32x4_extend_high_i16x8(c), wasm_i32x4_extend_high_i16x8(d));
      lo = wasm_i32x4_add(wasm_i32x4_sub(lo, wasm_i32x4_mul(be_lo, wasm_i32x4_splat(5))), wasm_i32x4_mul(cd_lo, wasm_i32x4_splat(20)));
      hi = wasm_i32x4_add(wasm_i32x4_sub(hi, wasm_i32x4_mul(be_hi, wasm_i32x4_splat(5))), wasm_i32x4_mul(cd_hi, wasm_i32x4_splat(20)));
      lo = wasm_i32x4_shr(wasm_i32x4_add(lo, wasm_i32x4_splat(512)), 10);
      hi = wasm_i32x4_shr(wasm_i32x4_add(hi, wasm_i32x4_splat(512)), 10);
      v128_t n16 = wasm_i16x8_narrow_i32x4(lo, hi);
      wasm_v128_store64_lane(J + ro + x, wasm_u8x16_narrow_i16x8(n16, n16), 0);
    }
    for (; x < PW; x++) {
      int v = (h16[x] + h16[x + 5] - 5 * (h16[x + 1] + h16[x + 4]) + 20 * (h16[x + 2] + h16[x + 3]) + 512) >> 10;
      J[ro + x] = clip255(v);
    }
  }
  R[RHALF] = 1;
}

// Plane and offset of each fraction (inter.js FRAC): [plane, dx, dy, plane2, dx2, dy2], plane -1 = none.
static const int8_t FRAC[16][6] = {
  {0, 0, 0, -1, 0, 0}, {0, 0, 0, 1, 0, 0}, {1, 0, 0, -1, 0, 0}, {0, 1, 0, 1, 0, 0},
  {0, 0, 0, 2, 0, 0}, {1, 0, 0, 2, 0, 0}, {1, 0, 0, 3, 0, 0}, {1, 0, 0, 2, 1, 0},
  {2, 0, 0, -1, 0, 0}, {2, 0, 0, 3, 0, 0}, {3, 0, 0, -1, 0, 0}, {3, 0, 0, 2, 1, 0},
  {0, 0, 1, 2, 0, 0}, {2, 0, 0, 1, 0, 1}, {3, 0, 0, 1, 0, 1}, {2, 1, 0, 1, 0, 1},
};
static inline const u8 *plane_of(i32 *R, int i) { return P8(R[RG + i]); }

// 16x16 luma prediction (inter.js predLuma with bw = bh = 16). out: stride 16.
EXPORT(pred_luma)
void pred_luma(i32 *R, int x, int y, int mvx, int mvy, u8 *out) {
  if (((mvx | mvy) & 3) && !R[RHALF]) build_half(R); // the half-sample planes when first needed
  const int xi = x + (mvx >> 2), yi = y + (mvy >> 2);
  const int8_t *f = FRAC[((mvy & 3) << 2) | (mvx & 3)];
  const int pad = R[RPAD], stride = R[RSTRIDE], w = R[RW], h = R[RH];
  const u8 *P1 = plane_of(R, f[0]);
  const int two = f[3] >= 0;
  const u8 *P2 = two ? plane_of(R, f[3]) : 0;
  if (xi >= -pad && yi >= -pad && xi + 17 <= w + pad && yi + 17 <= h + pad) {
    const int origin = pad * stride + pad;
    const u8 *s1 = P1 + origin + (yi + f[2]) * stride + xi + f[1];
    if (!two) {
      for (int r = 0; r < 16; r++) wasm_v128_store(out + r * 16, wasm_v128_load(s1 + r * stride));
    } else {
      const u8 *s2 = P2 + origin + (yi + f[5]) * stride + xi + f[4];
      for (int r = 0; r < 16; r++)
        wasm_v128_store(out + r * 16, wasm_u8x16_avgr(wasm_v128_load(s1 + r * stride), wasm_v128_load(s2 + r * stride)));
    }
    return;
  }
  // Slow path: clamp each coordinate to the padded area.
  int col[17], row[17];
  const int lo = -pad, hiX = w + pad - 1, hiY = h + pad - 1;
  for (int i = 0; i <= 16; i++) {
    col[i] = clampi(xi + i, lo, hiX) + pad;
    row[i] = (clampi(yi + i, lo, hiY) + pad) * stride;
  }
  for (int r = 0; r < 16; r++) {
    for (int c = 0; c < 16; c++) {
      int a = P1[row[r + f[2]] + col[c + f[1]]];
      out[r * 16 + c] = two ? (u8)((a + P2[row[r + f[5]] + col[c + f[4]]] + 1) >> 1) : (u8)a;
    }
  }
}

// 8x8 chroma prediction of both components (inter.js predChroma with bw = bh = 8).
EXPORT(pred_chroma)
void pred_chroma(i32 *R, int x, int y, int mvx, int mvy, u8 *outU, u8 *outV) {
  const int xi = x + (mvx >> 3), yi = y + (mvy >> 3);
  const int xF = mvx & 7, yF = mvy & 7;
  const int wA = (8 - xF) * (8 - yF), wB = xF * (8 - yF), wC = (8 - xF) * yF, wD = xF * yF;
  const int pad = R[RCPAD], stride = R[RCSTRIDE], w = R[RCW], h = R[RCH];
  for (int comp = 0; comp < 2; comp++) {
    const u8 *P = P8(R[comp ? RV : RU]);
    u8 *out = comp ? outV : outU;
    if (xi >= -pad && yi >= -pad && xi + 9 <= w + pad && yi + 9 <= h + pad) {
      const u8 *base = P + (pad + yi) * stride + pad + xi;
      const v128_t a = wasm_i16x8_splat(wA), b = wasm_i16x8_splat(wB), c = wasm_i16x8_splat(wC), d = wasm_i16x8_splat(wD);
      for (int r = 0; r < 8; r++) {
        const u8 *s = base + r * stride;
        v128_t v = wasm_i16x8_mul(ld8_u16(s), a);
        v = wasm_i16x8_add(v, wasm_i16x8_mul(ld8_u16(s + 1), b));
        v = wasm_i16x8_add(v, wasm_i16x8_mul(ld8_u16(s + stride), c));
        v = wasm_i16x8_add(v, wasm_i16x8_mul(ld8_u16(s + stride + 1), d));
        v = wasm_u16x8_shr(wasm_i16x8_add(v, wasm_i16x8_splat(32)), 6);
        wasm_v128_store64_lane(out + r * 8, wasm_u8x16_narrow_i16x8(v, v), 0);
      }
    } else {
      int col[9], row[9];
      const int lo = -pad, hiX = w + pad - 1, hiY = h + pad - 1;
      for (int i = 0; i <= 8; i++) {
        col[i] = clampi(xi + i, lo, hiX) + pad;
        row[i] = (clampi(yi + i, lo, hiY) + pad) * stride;
      }
      for (int r = 0; r < 8; r++) {
        for (int c = 0; c < 8; c++) {
          int A = P[row[r] + col[c]], B = P[row[r] + col[c + 1]], C = P[row[r + 1] + col[c]], D = P[row[r + 1] + col[c + 1]];
          out[r * 8 + c] = (u8)((wA * A + wB * B + wC * C + wD * D + 32) >> 6);
        }
      }
    }
  }
}

/* ---------------- SAD ---------------- */

static inline v128_t absdiff(v128_t a, v128_t b) { return wasm_v128_or(wasm_u8x16_sub_sat(a, b), wasm_u8x16_sub_sat(b, a)); }
static inline v128_t widen_add(v128_t acc, v128_t d) {
  return wasm_i32x4_add(acc, wasm_u32x4_extadd_pairwise_u16x8(wasm_u16x8_extadd_pairwise_u8x16(d)));
}
static inline int hsum(v128_t a) {
  return wasm_i32x4_extract_lane(a, 0) + wasm_i32x4_extract_lane(a, 1) + wasm_i32x4_extract_lane(a, 2) + wasm_i32x4_extract_lane(a, 3);
}

// SAD of a 16x16 block of src (stride ss) against pred (stride 16).
EXPORT(sad_block)
int sad_block(const u8 *src, int ss, const u8 *pred) {
  v128_t acc = wasm_i32x4_splat(0);
  for (int r = 0; r < 16; r++) acc = widen_add(acc, absdiff(wasm_v128_load(src + r * ss), wasm_v128_load(pred + r * 16)));
  return hsum(acc);
}

// SAD of the 16x16 luma prediction at (x, y) + mv against src (inter.js sadLuma). It stops when
// the sum is above limit and returns a value above limit; else it returns the exact SAD.
EXPORT(sad_luma)
int sad_luma(i32 *R, int x, int y, int mvx, int mvy, const u8 *src, int ss, double limit) {
  if (((mvx | mvy) & 3) && !R[RHALF]) build_half(R);
  const int xi = x + (mvx >> 2), yi = y + (mvy >> 2);
  const int pad = R[RPAD], stride = R[RSTRIDE], w = R[RW], h = R[RH];
  if (!(xi >= -pad && yi >= -pad && xi + 17 <= w + pad && yi + 17 <= h + pad)) {
    u8 tmp[256] __attribute__((aligned(16)));
    pred_luma(R, x, y, mvx, mvy, tmp);
    return sad_block(src, ss, tmp);
  }
  const int8_t *f = FRAC[((mvy & 3) << 2) | (mvx & 3)];
  const int origin = pad * stride + pad;
  const u8 *s1 = plane_of(R, f[0]) + origin + (yi + f[2]) * stride + xi + f[1];
  v128_t acc = wasm_i32x4_splat(0);
  if (f[3] < 0) {
    for (int r = 0; r < 16; r++) {
      acc = widen_add(acc, absdiff(wasm_v128_load(src + r * ss), wasm_v128_load(s1 + r * stride)));
      if ((r & 3) == 3 && hsum(acc) > limit) return hsum(acc);
    }
  } else {
    const u8 *s2 = plane_of(R, f[3]) + origin + (yi + f[5]) * stride + xi + f[4];
    for (int r = 0; r < 16; r++) {
      v128_t p = wasm_u8x16_avgr(wasm_v128_load(s1 + r * stride), wasm_v128_load(s2 + r * stride));
      acc = widen_add(acc, absdiff(wasm_v128_load(src + r * ss), p));
      if ((r & 3) == 3 && hsum(acc) > limit) return hsum(acc);
    }
  }
  return hsum(acc);
}

/* ---------------- motion search (encoder.js search) ---------------- */

static inline int ue_bits(unsigned v) { return 2 * (31 - __builtin_clz(v + 1)) + 1; }
static inline int se_bits(int v) { return ue_bits(v > 0 ? 2 * v - 1 : -2 * v); }

static const int8_t SMALL_D[8] = {0, -1, -1, 0, 1, 0, 0, 1};
static const int8_t LARGE_D[16] = {0, -2, -1, -1, 1, -1, -2, 0, 2, 0, -1, 1, 1, 1, 0, 2};
static const int8_t RING[16] = {-1, -1, 0, -1, 1, -1, -1, 0, 1, 0, -1, 1, 0, 1, 1, 1};
#define EARLY_STOP_SAD 256
#define LARGE_SEARCH_SAD (256 * 6)

typedef struct {
  i32 *R;
  const u8 *src;
  int ss, x, y, px, py, bx, by, bSad;
  double lambda, bCost;
  i32 *visited;
  int stamp;
} Search;

static int try_int(Search *s, int ix, int iy) {
  const int vi = (iy + 64) * 129 + ix + 64;
  if (s->visited[vi] == s->stamp) return 0;
  s->visited[vi] = s->stamp;
  const double rate = s->lambda * (double)(se_bits(ix * 4 - s->px) + se_bits(iy * 4 - s->py));
  const int sad = sad_luma(s->R, s->x, s->y, ix * 4, iy * 4, s->src, s->ss, s->bCost - rate + 0.5);
  const double cost = (double)sad + rate;
  if (cost < s->bCost) {
    s->bCost = cost;
    s->bSad = sad;
    s->bx = ix;
    s->by = iy;
    return 1;
  }
  return 0;
}

// The motion search of one MB. src: the MB in the source Y plane (stride ss). precision: 0 full,
// 1 half, 2 quarter. out[0..1]: the vector (quarter samples). Returns its SAD.
EXPORT(search_mb)
int search_mb(i32 *R, const u8 *src, int ss, int mbx, int mby, int range, double lambda,
              int px, int py, int skx, int sky, int pvx, int pvy, int precision, i32 *visited, int stamp, i32 *out) {
  Search s = {R, src, ss, mbx * 16, mby * 16, px, py, 0, 0, 0, lambda, __builtin_inf(), visited, stamp};
  const int Rr = range, R4 = range * 4;
#define RND(v) clampi(((v) + 2) >> 2, -Rr, Rr)
  try_int(&s, RND(skx), RND(sky));
  try_int(&s, RND(px), RND(py));
  try_int(&s, 0, 0);
  try_int(&s, RND(pvx), RND(pvy));
  if (s.bSad >= EARLY_STOP_SAD) {
    if (s.bSad > LARGE_SEARCH_SAD) {
      for (int it = 0; it < Rr; it++) {
        const int cx = s.bx, cy = s.by;
        int moved = 0;
        for (int k = 0; k < 16; k += 2) {
          const int ix = cx + LARGE_D[k], iy = cy + LARGE_D[k + 1];
          if (ix < -Rr || ix > Rr || iy < -Rr || iy > Rr) continue;
          if (try_int(&s, ix, iy)) moved = 1;
        }
        if (!moved || s.bSad < EARLY_STOP_SAD) break;
      }
    }
    for (int it = 0; it < 2 * Rr; it++) {
      const int cx = s.bx, cy = s.by;
      int moved = 0;
      for (int k = 0; k < 8; k += 2) {
        const int ix = cx + SMALL_D[k], iy = cy + SMALL_D[k + 1];
        if (ix < -Rr || ix > Rr || iy < -Rr || iy > Rr) continue;
        if (try_int(&s, ix, iy)) moved = 1;
      }
      if (!moved || s.bSad < EARLY_STOP_SAD) break;
    }
  }
#undef RND
  int mx = s.bx * 4, my = s.by * 4;
  if (precision > 0 && s.bSad > 0) {
    const int nsteps = precision == 2 ? 2 : 1;
    for (int si = 0; si < nsteps; si++) {
      const int st = si == 0 ? 2 : 1;
      const int cx = mx, cy = my;
      for (int k = 0; k < 16; k += 2) {
        const int qx = cx + RING[k] * st, qy = cy + RING[k + 1] * st;
        if (qx < -R4 || qx > R4 || qy < -R4 || qy > R4) continue;
        const double rate = lambda * (double)(se_bits(qx - px) + se_bits(qy - py));
        const int sad = sad_luma(R, s.x, s.y, qx, qy, src, ss, s.bCost - rate + 0.5);
        const double cost = (double)sad + rate;
        if (cost < s.bCost) {
          s.bCost = cost;
          s.bSad = sad;
          mx = qx;
          my = qy;
        }
      }
    }
  }
  out[0] = mx;
  out[1] = my;
  return s.bSad;
}

/* ---------------- transform and quantization (transform.js) ---------------- */

static void hadamard2x2(const int *c, int *f) {
  f[0] = c[0] + c[1] + c[2] + c[3];
  f[1] = c[0] - c[1] + c[2] - c[3];
  f[2] = c[0] + c[1] - c[2] - c[3];
  f[3] = c[0] - c[1] - c[2] + c[3];
}

static int quant_chroma_dc(const int *f, int qpc, i32 *z) {
  const int qbits = 16 + qpc / 6;
  const int r = (1 << qbits) / 6; // = JS ((1 << (qbits - 1)) / 6) * 2 | 0
  const int mf = QUANT_MF[qpc % 6][0];
  int nz = 0;
  for (int i = 0; i < 4; i++) {
    const int v = f[i], a = v < 0 ? -v : v;
    const int q = (a * mf + r) >> qbits;
    z[i] = v < 0 ? -q : q;
    if (q) nz++;
  }
  return nz;
}

static int zero_sad(int q) {
  const int qbits = 15 + q / 6, f = (1 << qbits) / 6;
  const int *mf = QUANT_MF[q % 6];
  int k = mf[0];
  if (4 * mf[1] > k) k = 4 * mf[1];
  if (2 * mf[2] > k) k = 2 * mf[2];
  return ((1 << qbits) - f - 1) / k;
}

/* SIMD 4x4 blocks: four i32x4 vectors, one for each row (lanes = columns). The forward transform is
   exact integer arithmetic, so the order of the passes does not change it. The inverse transform does
   the rows first, then the columns, as in 8.5.12.2 (the >> 1 makes the order matter). */
#define TR4(a, b, c, d)                                                          \
  do {                                                                           \
    v128_t t0_ = wasm_i32x4_shuffle(a, b, 0, 4, 1, 5), t1_ = wasm_i32x4_shuffle(a, b, 2, 6, 3, 7); \
    v128_t t2_ = wasm_i32x4_shuffle(c, d, 0, 4, 1, 5), t3_ = wasm_i32x4_shuffle(c, d, 2, 6, 3, 7); \
    a = wasm_i32x4_shuffle(t0_, t2_, 0, 1, 4, 5);                                \
    b = wasm_i32x4_shuffle(t0_, t2_, 2, 3, 6, 7);                                \
    c = wasm_i32x4_shuffle(t1_, t3_, 0, 1, 4, 5);                                \
    d = wasm_i32x4_shuffle(t1_, t3_, 2, 3, 6, 7);                                \
  } while (0)

static inline v128_t ld4_u32(const u8 *p) {
  return wasm_u32x4_extend_low_u16x8(wasm_u16x8_extend_low_u8x16(wasm_v128_load32_zero(p)));
}

// The residual rows of a 4x4 block (src stride ss, pred stride ps). Returns the sum of |residual|.
static inline int res_rows(const u8 *s, int ss, const u8 *p, int ps, v128_t *r) {
  v128_t acc = wasm_i32x4_splat(0);
  for (int y = 0; y < 4; y++) {
    r[y] = wasm_i32x4_sub(ld4_u32(s + y * ss), ld4_u32(p + y * ps));
    acc = wasm_i32x4_add(acc, wasm_i32x4_abs(r[y]));
  }
  return hsum(acc);
}

static inline void fwd_pass(v128_t *x) {
  const v128_t s03 = wasm_i32x4_add(x[0], x[3]), d03 = wasm_i32x4_sub(x[0], x[3]);
  const v128_t s12 = wasm_i32x4_add(x[1], x[2]), d12 = wasm_i32x4_sub(x[1], x[2]);
  x[0] = wasm_i32x4_add(s03, s12);
  x[1] = wasm_i32x4_add(wasm_i32x4_shl(d03, 1), d12);
  x[2] = wasm_i32x4_sub(s03, s12);
  x[3] = wasm_i32x4_sub(d03, wasm_i32x4_shl(d12, 1));
}

// forward4x4 in place: r (rows) -> W (rows = vertical frequency, lanes = horizontal frequency).
static inline void fwd4x4_v(v128_t *r) {
  fwd_pass(r); // columns
  TR4(r[0], r[1], r[2], r[3]);
  fwd_pass(r); // rows
  TR4(r[0], r[1], r[2], r[3]);
}

// quant4x4 of W (rows). Writes z (raster). first = 1: z[0] = 0 and not counted. Returns nz.
static inline int quant4x4_v(const v128_t *w, int qp, i32 *z, int first) {
  const int qbits = 15 + qp / 6;
  const v128_t f = wasm_i32x4_splat((1 << qbits) / 6);
  const int *mf = QUANT_MF[qp % 6];
  const v128_t mfE = wasm_i32x4_make(mf[0], mf[2], mf[0], mf[2]), mfO = wasm_i32x4_make(mf[2], mf[1], mf[2], mf[1]);
  int nz = 0;
  for (int y = 0; y < 4; y++) {
    const v128_t a = wasm_i32x4_abs(w[y]);
    const v128_t q = wasm_i32x4_shr(wasm_i32x4_add(wasm_i32x4_mul(a, (y & 1) ? mfO : mfE), f), qbits);
    const v128_t sg = wasm_i32x4_shr(w[y], 31);
    wasm_v128_store(z + y * 4, wasm_i32x4_sub(wasm_v128_xor(q, sg), sg));
    nz += __builtin_popcount(wasm_i32x4_bitmask(wasm_i32x4_ne(q, wasm_i32x4_splat(0))));
  }
  if (first) {
    if (z[0]) nz--;
    z[0] = 0;
  }
  return nz;
}

static inline void inv_pass(v128_t *x) {
  const v128_t e0 = wasm_i32x4_add(x[0], x[2]), e1 = wasm_i32x4_sub(x[0], x[2]);
  const v128_t e2 = wasm_i32x4_sub(wasm_i32x4_shr(x[1], 1), x[3]), e3 = wasm_i32x4_add(x[1], wasm_i32x4_shr(x[3], 1));
  x[0] = wasm_i32x4_add(e0, e3);
  x[1] = wasm_i32x4_add(e1, e2);
  x[2] = wasm_i32x4_sub(e1, e2);
  x[3] = wasm_i32x4_sub(e0, e3);
}

// dequant4x4 + idct4x4Add: c levels (raster), dc: the value for d[0] when useDC (chroma).
static inline void recon4x4_v(const i32 *c, int qp, int useDC, int dc, int acZero, const u8 *pred, int ps, u8 *dst, int ds) {
  v128_t d[4];
  if (acZero) {
    for (int y = 0; y < 4; y++) d[y] = wasm_i32x4_splat(0);
  } else {
    const int *v = DEQUANT_V[qp % 6];
    const int sh = qp / 6;
    const v128_t vE = wasm_i32x4_make(v[0], v[2], v[0], v[2]), vO = wasm_i32x4_make(v[2], v[1], v[2], v[1]);
    for (int y = 0; y < 4; y++) d[y] = wasm_i32x4_shl(wasm_i32x4_mul(wasm_v128_load(c + y * 4), (y & 1) ? vO : vE), sh);
  }
  if (useDC) d[0] = wasm_i32x4_replace_lane(d[0], 0, dc);
  TR4(d[0], d[1], d[2], d[3]); // vectors = columns: the row pass works across them
  inv_pass(d);
  TR4(d[0], d[1], d[2], d[3]); // vectors = rows: the column pass
  inv_pass(d);
  const v128_t k32 = wasm_i32x4_splat(32);
  for (int y = 0; y < 4; y++) {
    const v128_t r = wasm_i32x4_add(ld4_u32(pred + y * ps), wasm_i32x4_shr(wasm_i32x4_add(d[y], k32), 6));
    const v128_t n16 = wasm_i16x8_narrow_i32x4(r, r);
    wasm_v128_store32_lane(dst + y * ds, wasm_u8x16_narrow_i16x8(n16, n16), 0);
  }
}

/* MB residual (transform.js MbResidual), i32: luma[256] (block b = by*4+bx, raster levels),
   cb[64], cr[64] (AC; index 0 unused), cbDC[4], crDC[4], nzLuma[16], nzCb[4], nzCr[4], cbp. */
enum { RES_LUMA = 0, RES_CB = 256, RES_CR = 320, RES_CBDC = 384, RES_CRDC = 388, RES_NZL = 392, RES_NZCB = 408, RES_NZCR = 412, RES_CBP = 416, RES_SIZE = 417 };

// encoder.js residual(): src* point to the MB (luma stride W, chroma stride cW). Returns cbp.
EXPORT(residual_mb)
int residual_mb(const u8 *sY, const u8 *sU, const u8 *sV, int W, int cW, const u8 *pY, const u8 *pU, const u8 *pV, int qp, i32 *res) {
  const int zeroL = zero_sad(qp);
  int cbp = 0;
  for (int b = 0; b < 16; b++) {
    const int bx = b & 3, by = b >> 2;
    v128_t r[4];
    const int sa = res_rows(sY + by * 4 * W + bx * 4, W, pY + by * 64 + bx * 4, 16, r);
    i32 *z = res + RES_LUMA + b * 16;
    if (sa <= zeroL) {
      for (int i = 0; i < 16; i += 4) wasm_v128_store(z + i, wasm_i32x4_splat(0));
      res[RES_NZL + b] = 0;
      continue;
    }
    fwd4x4_v(r);
    const int nz = quant4x4_v(r, qp, z, 0);
    res[RES_NZL + b] = nz;
    if (nz) cbp |= 1 << ((by >> 1) * 2 + (bx >> 1));
  }
  const int qpc = CHROMA_QP[qp];
  const int zeroC = zero_sad(qpc);
  int anyDC = 0, anyAC = 0;
  for (int comp = 0; comp < 2; comp++) {
    const u8 *P = comp ? sV : sU, *pred = comp ? pV : pU;
    i32 *ac = res + (comp ? RES_CR : RES_CB), *nzc = res + (comp ? RES_NZCR : RES_NZCB);
    int dc[4], dcF[4];
    for (int b = 0; b < 4; b++) {
      const int bx = b & 1, by = b >> 1;
      v128_t r[4];
      const int sa = res_rows(P + by * 4 * cW + bx * 4, cW, pred + by * 32 + bx * 4, 8, r);
      if (sa <= zeroC) {
        dc[b] = hsum(wasm_i32x4_add(wasm_i32x4_add(r[0], r[1]), wasm_i32x4_add(r[2], r[3]))); // W[0] = the sum
        for (int i = 0; i < 16; i += 4) wasm_v128_store(ac + b * 16 + i, wasm_i32x4_splat(0));
        nzc[b] = 0;
        continue;
      }
      fwd4x4_v(r);
      dc[b] = wasm_i32x4_extract_lane(r[0], 0);
      const int nz = quant4x4_v(r, qpc, ac + b * 16, 1);
      nzc[b] = nz;
      if (nz) anyAC = 1;
    }
    hadamard2x2(dc, dcF);
    if (quant_chroma_dc(dcF, qpc, res + (comp ? RES_CRDC : RES_CBDC))) anyDC = 1;
  }
  if (anyAC) cbp |= 32;
  else {
    if (anyDC) cbp |= 16;
    for (int i = 0; i < 64; i++) res[RES_CB + i] = res[RES_CR + i] = 0;
    for (int i = 0; i < 4; i++) res[RES_NZCB + i] = res[RES_NZCR + i] = 0;
  }
  res[RES_CBP] = cbp;
  return cbp;
}

// encoder.js residualIsZero(): 1 when all levels of the prediction are zero.
EXPORT(residual_is_zero)
int residual_is_zero(const u8 *sY, const u8 *sU, const u8 *sV, int W, int cW, const u8 *pY, const u8 *pU, const u8 *pV, int qp) {
  i32 zc[16];
  const int zeroL = zero_sad(qp);
  for (int b = 0; b < 16; b++) {
    v128_t r[4];
    const int sa = res_rows(sY + (b >> 2) * 4 * W + (b & 3) * 4, W, pY + (b >> 2) * 64 + (b & 3) * 4, 16, r);
    if (sa <= zeroL) continue;
    fwd4x4_v(r);
    if (quant4x4_v(r, qp, zc, 0)) return 0;
  }
  const int qpc = CHROMA_QP[qp];
  const int zeroC = zero_sad(qpc);
  for (int comp = 0; comp < 2; comp++) {
    const u8 *P = comp ? sV : sU, *pred = comp ? pV : pU;
    int dc[4], dcF[4];
    for (int b = 0; b < 4; b++) {
      v128_t r[4];
      const int sa = res_rows(P + (b >> 1) * 4 * cW + (b & 1) * 4, cW, pred + (b >> 1) * 32 + (b & 1) * 4, 8, r);
      if (sa <= zeroC) {
        dc[b] = hsum(wasm_i32x4_add(wasm_i32x4_add(r[0], r[1]), wasm_i32x4_add(r[2], r[3])));
        continue;
      }
      fwd4x4_v(r);
      dc[b] = wasm_i32x4_extract_lane(r[0], 0);
      if (quant4x4_v(r, qpc, zc, 1)) return 0;
    }
    hadamard2x2(dc, dcF);
    if (quant_chroma_dc(dcF, qpc, zc)) return 0;
  }
  return 1;
}

static void dequant_chroma_dc(const i32 *c, int qpc, int *out) {
  int f[4], ci[4] = {c[0], c[1], c[2], c[3]};
  hadamard2x2(ci, f);
  const int ls = 16 * DEQUANT_V[qpc % 6][0], sh = qpc / 6;
  for (int i = 0; i < 4; i++) out[i] = ((f[i] * ls) << sh) >> 5;
}

// transform.js reconInterMB: prediction + residual. dY: the MB in the Y plane (stride W);
// dU, dV: the MB in the chroma planes (stride cW).
EXPORT(recon_inter)
void recon_inter(const i32 *res, int qp, const u8 *pY, const u8 *pU, const u8 *pV, u8 *dY, int W, u8 *dU, u8 *dV, int cW) {
  const int cbp = res[RES_CBP];
  for (int b = 0; b < 16; b++) {
    const int bx = b & 3, by = b >> 2;
    const u8 *p = pY + by * 64 + bx * 4;
    u8 *d = dY + by * 4 * W + bx * 4;
    const int b8 = (by >> 1) * 2 + (bx >> 1);
    if (((cbp >> b8) & 1) && res[RES_NZL + b]) {
      recon4x4_v(res + RES_LUMA + b * 16, qp, 0, 0, 0, p, 16, d, W);
    } else {
      for (int y = 0; y < 4; y++) for (int x = 0; x < 4; x++) d[y * W + x] = p[y * 16 + x];
    }
  }
  const int cc = cbp >> 4;
  const int qpc = CHROMA_QP[qp];
  for (int comp = 0; comp < 2; comp++) {
    const u8 *pred = comp ? pV : pU;
    u8 *P = comp ? dV : dU;
    if (cc == 0) {
      for (int y = 0; y < 8; y++) for (int x = 0; x < 8; x++) P[y * cW + x] = pred[y * 8 + x];
      continue;
    }
    int dcOut[4];
    dequant_chroma_dc(res + (comp ? RES_CRDC : RES_CBDC), qpc, dcOut);
    const i32 *ac = res + (comp ? RES_CR : RES_CB);
    for (int b = 0; b < 4; b++) {
      const int bx = b & 1, by = b >> 1;
      recon4x4_v(ac + b * 16, qpc, 1, dcOut[b], cc != 2, pred + by * 32 + bx * 4, 8, P + by * 4 * cW + bx * 4, cW);
    }
  }
}

// Copy the prediction to the MB (P_Skip).
EXPORT(copy_pred)
void copy_pred(const u8 *pY, const u8 *pU, const u8 *pV, u8 *dY, int W, u8 *dU, u8 *dV, int cW) {
  for (int y = 0; y < 16; y++) wasm_v128_store(dY + y * W, wasm_v128_load(pY + y * 16));
  for (int y = 0; y < 8; y++) {
    wasm_v128_store64_lane(dU + y * cW, wasm_v128_load64_zero(pU + y * 8), 0);
    wasm_v128_store64_lane(dV + y * cW, wasm_v128_load64_zero(pV + y * 8), 0);
  }
}

/* ---------------- colour (color.js) ---------------- */

static void pad_coded(u8 *P, int w, int h, int codedW, int codedH) {
  for (int y = 0; y < h; y++) __builtin_memset(P + y * codedW + w, P[y * codedW + w - 1], codedW - w);
  for (int y = h; y < codedH; y++) __builtin_memcpy(P + y * codedW, P + (h - 1) * codedW, codedW);
}

EXPORT(rgba_to_yuv420)
void rgba_to_yuv420(const u8 *rgba, int w, int h, int codedW, int codedH, u8 *Y, u8 *U, u8 *V) {
  for (int y = 0; y < h; y++) {
    const u8 *s = rgba + y * w * 4;
    u8 *d = Y + y * codedW;
    for (int x = 0; x < w; x++, s += 4) d[x] = (u8)(16 + ((47 * s[0] + 157 * s[1] + 16 * s[2] + 128) >> 8));
  }
  const int cW = codedW >> 1, cw = w >> 1, ch = h >> 1;
  for (int y = 0; y < ch; y++) {
    for (int x = 0; x < cw; x++) {
      const u8 *s0 = rgba + (2 * y * w + 2 * x) * 4, *s1 = s0 + w * 4;
      const int r = s0[0] + s0[4] + s1[0] + s1[4];
      const int g = s0[1] + s0[5] + s1[1] + s1[5];
      const int b = s0[2] + s0[6] + s1[2] + s1[6];
      U[y * cW + x] = (u8)(128 + ((-26 * r - 87 * g + 113 * b + 512) >> 10));
      V[y * cW + x] = (u8)(128 + ((112 * r - 102 * g - 10 * b + 512) >> 10));
    }
  }
  pad_coded(Y, w, h, codedW, codedH);
  pad_coded(U, cw, ch, cW, codedH >> 1);
  pad_coded(V, cw, ch, cW, codedH >> 1);
}

EXPORT(yuv420_to_rgba)
void yuv420_to_rgba(const u8 *Y, const u8 *U, const u8 *V, int codedW, int w, int h, u8 *rgba) {
  const int cW = codedW >> 1;
  for (int y = 0; y < h; y++) {
    for (int x = 0; x < w; x++) {
      const int c = 298 * (Y[y * codedW + x] - 16);
      const int ci = (y >> 1) * cW + (x >> 1);
      const int u = U[ci] - 128, v = V[ci] - 128;
      u8 *o = rgba + (y * w + x) * 4;
      o[0] = (u8)clip255((c + 459 * v + 128) >> 8);
      o[1] = (u8)clip255((c - 55 * u - 136 * v + 128) >> 8);
      o[2] = (u8)clip255((c + 541 * u + 128) >> 8);
      o[3] = 255;
    }
  }
}

/* ---------------- bitstream writer and CAVLC (bitio.js, cavlc.js, encoder.js) ---------------- */

#include "tables.h"

// One writer for each instance. The slice data starts at bit `start` of the buffer (the bit
// position of the slice header end, modulo 8), so that the I_PCM alignment is the same as in the
// complete slice.
static u8 *bw_buf;
static uint64_t bw_acc;
static int bw_accBits, bw_byte, bw_start;

static inline void put(int n, unsigned v) {
  if (n == 0) return;
  bw_acc = (bw_acc << n) | (v & (n == 32 ? 0xffffffffu : ((1u << n) - 1)));
  bw_accBits += n;
  while (bw_accBits >= 8) {
    bw_accBits -= 8;
    bw_buf[bw_byte++] = (u8)(bw_acc >> bw_accBits);
  }
}
static inline void put_ue(unsigned v) {
  const unsigned x = v + 1;
  const int len = 31 - __builtin_clz(x);
  put(len, 0);
  put(len + 1, x);
}
static inline void put_se(int v) { put_ue(v > 0 ? 2 * v - 1 : -2 * v); }

EXPORT(bw_reset)
void bw_reset(u8 *buf, int start) {
  bw_buf = buf;
  bw_acc = 0;
  bw_accBits = start;
  bw_byte = 0;
  bw_start = start;
}

EXPORT(bw_ue)
void bw_ue(int v) { put_ue((unsigned)v); }

// Write the slice data, from bit 0, to dst. Returns the bit length.
EXPORT(bw_extract)
int bw_extract(u8 *dst) {
  const int total = bw_byte * 8 + bw_accBits;
  bw_buf[bw_byte] = bw_accBits ? (u8)(bw_acc << (8 - bw_accBits)) : 0; // no old data after the end
  const int len = total - bw_start, n = (len + 7) >> 3, sh = bw_start;
  for (int k = 0; k < n; k++) {
    const int a = bw_buf[k], b = k + 1 <= bw_byte ? bw_buf[k + 1] : 0;
    dst[k] = (u8)((a << sh) | (sh ? b >> (8 - sh) : 0));
  }
  if (len & 7) dst[n - 1] &= (u8)(0xff << (8 - (len & 7)));
  return len;
}

static int token_table(int nC) { return nC < 2 ? 0 : nC < 4 ? 1 : nC < 8 ? 2 : 3; }

// cavlc.js writeResidualBlock. coef: maxNum coefficients in scan order. Returns TotalCoeff.
static int write_block(const int *coef, int maxNum, int nC) {
  int lvl[16], run[16];
  int last = maxNum - 1;
  while (last >= 0 && coef[last] == 0) last--;
  int n = 0, i = last;
  while (i >= 0) {
    lvl[n] = coef[i];
    i--;
    int r = 0;
    while (i >= 0 && coef[i] == 0) {
      r++;
      i--;
    }
    run[n] = r;
    n++;
  }
  int t1 = 0;
  while (t1 < n && t1 < 3 && (lvl[t1] == 1 || lvl[t1] == -1)) t1++;
  const int tk = n * 4 + t1;
  if (nC == -1) put(CHROMA_DC_COEFF_TOKEN_LEN[tk], CHROMA_DC_COEFF_TOKEN_BITS[tk]);
  else {
    const int t = token_table(nC);
    put(COEFF_TOKEN_LEN[t][tk], COEFF_TOKEN_BITS[t][tk]);
  }
  if (n == 0) return 0;
  for (int k = 0; k < t1; k++) put(1, lvl[k] < 0 ? 1 : 0);
  int suffixLength = n > 10 && t1 < 3 ? 1 : 0;
  for (int k = t1; k < n; k++) {
    const int level = lvl[k];
    int levelCode = level > 0 ? 2 * level - 2 : -2 * level - 1;
    if (k == t1 && t1 < 3) levelCode -= 2;
    int prefix, suffix, suffixSize;
    if (suffixLength == 0) {
      if (levelCode < 14) {
        prefix = levelCode;
        suffixSize = 0;
        suffix = 0;
      } else if (levelCode < 30) {
        prefix = 14;
        suffixSize = 4;
        suffix = levelCode - 14;
      } else {
        prefix = 15;
        suffixSize = 12;
        suffix = levelCode - 30;
      }
    } else if (levelCode < (15 << suffixLength)) {
      prefix = levelCode >> suffixLength;
      suffixSize = suffixLength;
      suffix = levelCode & ((1 << suffixLength) - 1);
    } else {
      prefix = 15;
      suffixSize = 12;
      suffix = levelCode - (15 << suffixLength);
    }
    // (The JavaScript writer throws for suffix >= 4096; the encoder QP range never reaches it.)
    put(prefix, 0);
    put(1, 1);
    put(suffixSize, (unsigned)suffix);
    if (suffixLength == 0) suffixLength = 1;
    const int a = level < 0 ? -level : level;
    if (a > (3 << (suffixLength - 1)) && suffixLength < 6) suffixLength++;
  }
  const int totalZeros = last + 1 - n;
  if (n < maxNum) {
    if (maxNum == 4) put(CHROMA_DC_TOTAL_ZEROS_LEN[n - 1][totalZeros], CHROMA_DC_TOTAL_ZEROS_BITS[n - 1][totalZeros]);
    else put(TOTAL_ZEROS_LEN[n - 1][totalZeros], TOTAL_ZEROS_BITS[n - 1][totalZeros]);
  }
  int zerosLeft = totalZeros;
  for (int k = 0; k < n - 1 && zerosLeft > 0; k++) {
    const int t = (zerosLeft > 7 ? 7 : zerosLeft) - 1;
    put(RUN_BEFORE_LEN[t][run[k]], RUN_BEFORE_BITS[t][run[k]]);
    zerosLeft -= run[k];
  }
  return n;
}

// mvpred.js lumaNC / chromaNC. nz: u8 TotalCoeff of each 4x4 block (16 per MB luma, 4 chroma).
static int luma_nc(const u8 *nz, int addr, int mbx, int mby, int mbW, int bx, int by) {
  int availA = 1, availB = 1, nA = 0, nB = 0;
  if (bx > 0) nA = nz[addr * 16 + by * 4 + bx - 1];
  else if (mbx > 0) nA = nz[(addr - 1) * 16 + by * 4 + 3];
  else availA = 0;
  if (by > 0) nB = nz[addr * 16 + (by - 1) * 4 + bx];
  else if (mby > 0) nB = nz[(addr - mbW) * 16 + 12 + bx];
  else availB = 0;
  if (availA && availB) return (nA + nB + 1) >> 1;
  return availA ? nA : availB ? nB : 0;
}
static int chroma_nc(const u8 *nz, int addr, int mbx, int mby, int mbW, int bx, int by) {
  int availA = 1, availB = 1, nA = 0, nB = 0;
  if (bx > 0) nA = nz[addr * 4 + by * 2];
  else if (mbx > 0) nA = nz[(addr - 1) * 4 + by * 2 + 1];
  else availA = 0;
  if (by > 0) nB = nz[addr * 4 + bx];
  else if (mby > 0) nB = nz[(addr - mbW) * 4 + 2 + bx];
  else availB = 0;
  if (availA && availB) return (nA + nB + 1) >> 1;
  return availA ? nA : availB ? nB : 0;
}

// encoder.js: a P_L0_16x16 MB (mb_skip_run before it, mb_type, mvd, cbp, mb_qp_delta, residual).
// The nz arrays of this MB must already have its TotalCoeff values.
EXPORT(write_inter_mb)
void write_inter_mb(int skipRun, int mvdx, int mvdy, const i32 *res, int addr, int mbx, int mby, int mbW,
                    const u8 *nzL, const u8 *nzCb, const u8 *nzCr) {
  const int cbp = res[RES_CBP];
  int scan[16];
  put_ue((unsigned)skipRun);
  put_ue(0);
  put_se(mvdx);
  put_se(mvdy);
  put_ue(CBP_INTER_TO_CODE[cbp]);
  if (!cbp) return;
  put_se(0); // mb_qp_delta
  for (int b8 = 0; b8 < 4; b8++) {
    if (!((cbp >> b8) & 1)) continue;
    for (int b4 = 0; b4 < 4; b4++) {
      const int bx = (b8 & 1) * 2 + (b4 & 1), by = (b8 >> 1) * 2 + (b4 >> 1);
      const i32 *l = res + RES_LUMA + (by * 4 + bx) * 16;
      for (int i = 0; i < 16; i++) scan[i] = l[ZIGZAG4x4[i]];
      write_block(scan, 16, luma_nc(nzL, addr, mbx, mby, mbW, bx, by));
    }
  }
  const int cc = cbp >> 4;
  if (cc) {
    int dc[4];
    for (int i = 0; i < 4; i++) dc[i] = res[RES_CBDC + i];
    write_block(dc, 4, -1);
    for (int i = 0; i < 4; i++) dc[i] = res[RES_CRDC + i];
    write_block(dc, 4, -1);
  }
  if (cc == 2) {
    for (int comp = 0; comp < 2; comp++) {
      const u8 *nz = comp ? nzCr : nzCb;
      const i32 *ac = res + (comp ? RES_CR : RES_CB);
      for (int b = 0; b < 4; b++) {
        for (int i = 0; i < 15; i++) scan[i] = ac[b * 16 + ZIGZAG4x4[i + 1]];
        write_block(scan, 15, chroma_nc(nz, addr, mbx, mby, mbW, b & 1, b >> 1));
      }
    }
  }
}

// encoder.js writePcm: (mb_skip_run when skipRun >= 0), mb_type, alignment, the samples (0 -> 1).
// The reconstruction is the clamped source. s*: the MB in the source; d*: the MB in the recon.
EXPORT(write_pcm_mb)
void write_pcm_mb(int skipRun, int mbType, const u8 *sY, const u8 *sU, const u8 *sV, u8 *dY, u8 *dU, u8 *dV, int W, int cW) {
  if (skipRun >= 0) put_ue((unsigned)skipRun);
  put_ue((unsigned)mbType);
  put((8 - (bw_accBits & 7)) & 7, 0);
  for (int y = 0; y < 16; y++) {
    for (int x = 0; x < 16; x++) {
      const int v = sY[y * W + x] ? sY[y * W + x] : 1;
      bw_buf[bw_byte++] = (u8)v;
      dY[y * W + x] = (u8)v;
    }
  }
  for (int c = 0; c < 2; c++) {
    const u8 *s = c ? sV : sU;
    u8 *d = c ? dV : dU;
    for (int y = 0; y < 8; y++) {
      for (int x = 0; x < 8; x++) {
        const int v = s[y * cW + x] ? s[y * cW + x] : 1;
        bw_buf[bw_byte++] = (u8)v;
        d[y * cW + x] = (u8)v;
      }
    }
  }
}

/* ---------------- macroblock state and motion vector prediction (mvpred.js) ----------------
   I (i32[8]): 0 type (u8, 0 skip, 1 inter, 2 pcm), 1 mvx (i16), 2 mvy (i16), 3 nzLuma (u8, 16 per MB),
   4 nzCb (u8, 4), 5 nzCr (u8, 4), 6 mbW, 7 mbH. */
enum { MB_SKIP = 0, MB_INTER = 1, MB_PCM = 2 };
enum { IT, IMVX, IMVY, INZL, INZCB, INZCR, IMBW, IMBH };
#define TYPE(I) P8((I)[IT])
#define MVX(I) ((int16_t *)(uintptr_t)(I)[IMVX])
#define MVY(I) ((int16_t *)(uintptr_t)(I)[IMVY])

static inline int median3(int a, int b, int c) {
  return a > b ? (b > c ? b : a > c ? c : a) : a > c ? a : b > c ? c : b;
}

static void load_nb(const i32 *I, int addr, int avail, int *ref, int *mx, int *my) {
  if (!avail || TYPE(I)[addr] == MB_PCM) {
    *ref = -1;
    *mx = *my = 0;
  } else {
    *ref = 0;
    *mx = MVX(I)[addr];
    *my = MVY(I)[addr];
  }
}

static void mv_pred(const i32 *I, int mbx, int mby, int *ox, int *oy) {
  const int mbW = I[IMBW], addr = mby * mbW + mbx;
  const int availA = mbx > 0, availB = mby > 0, availC = mby > 0 && mbx < mbW - 1, availD = mbx > 0 && mby > 0;
  int rA, ax, ay, rB, bx, by, rC, cx, cy, availCD = 1;
  load_nb(I, addr - 1, availA, &rA, &ax, &ay);
  load_nb(I, addr - mbW, availB, &rB, &bx, &by);
  if (availC) load_nb(I, addr - mbW + 1, 1, &rC, &cx, &cy);
  else if (availD) load_nb(I, addr - mbW - 1, 1, &rC, &cx, &cy);
  else {
    availCD = 0;
    load_nb(I, 0, 0, &rC, &cx, &cy);
  }
  if (!availB && !availCD && availA) {
    rB = rC = rA;
    bx = cx = ax;
    by = cy = ay;
  }
  const int mA = rA == 0, mB = rB == 0, mC = rC == 0;
  if (mA + mB + mC == 1) {
    *ox = mA ? ax : mB ? bx : cx;
    *oy = mA ? ay : mB ? by : cy;
  } else {
    *ox = median3(ax, bx, cx);
    *oy = median3(ay, by, cy);
  }
}

static void mv_skip(const i32 *I, int mbx, int mby, int *ox, int *oy) {
  if (mbx == 0 || mby == 0) {
    *ox = *oy = 0;
    return;
  }
  const int mbW = I[IMBW], addr = mby * mbW + mbx, a = addr - 1, b = addr - mbW;
  const u8 *t = TYPE(I);
  if ((t[a] != MB_PCM && MVX(I)[a] == 0 && MVY(I)[a] == 0) || (t[b] != MB_PCM && MVX(I)[b] == 0 && MVY(I)[b] == 0)) {
    *ox = *oy = 0;
    return;
  }
  mv_pred(I, mbx, mby, ox, oy);
}

static void set_info(i32 *I, int addr, int type, int mx, int my, int nz) {
  TYPE(I)[addr] = (u8)type;
  MVX(I)[addr] = (int16_t)mx;
  MVY(I)[addr] = (int16_t)my;
  __builtin_memset(P8(I[INZL]) + addr * 16, nz, 16);
  __builtin_memset(P8(I[INZCB]) + addr * 4, nz, 4);
  __builtin_memset(P8(I[INZCR]) + addr * 4, nz, 4);
}

/* ---------------- P picture encoder loop (encoder.js encodeP) ----------------
   Planes: src and rec (coded size, Y stride W, chroma stride W/2). pred: 384 bytes (Y 256, U 64,
   V 64). prevMv: i16 vectors of the previous picture. stats: i32[4] = skip, inter, pcm, and the
   motion-search stamp (in and out). forceMode: 0, 1 (all P_Skip), 2 (no residual). The writer
   (bw_reset) must be set. */
EXPORT(encode_p_frame)
void encode_p_frame(i32 *R, i32 *I, const u8 *sY, const u8 *sU, const u8 *sV, u8 *rY, u8 *rU, u8 *rV, int W,
                    u8 *pred, i32 *res, const int16_t *prevMvx, const int16_t *prevMvy, i32 *visited,
                    int qp, int range, int precision, double lambda, double skipThr, double healThr, int forceMode, i32 *stats) {
  const int mbW = I[IMBW], mbH = I[IMBH], cW = W >> 1;
  u8 *pY = pred, *pU = pred + 256, *pV = pred + 320;
  int skipRun = 0;
  i32 mvOut[2];
  for (int mby = 0; mby < mbH; mby++) {
    for (int mbx = 0; mbx < mbW; mbx++) {
      const int addr = mby * mbW + mbx;
      const int yOff = mby * 16 * W + mbx * 16, cOff = mby * 8 * cW + mbx * 8;
      int skx, sky;
      mv_skip(I, mbx, mby, &skx, &sky);
      // Step 1: skip test.
      int skip = forceMode == 1, predicted = 0;
      if (!skip && forceMode != 2) {
        pred_luma(R, mbx * 16, mby * 16, skx, sky, pY);
        if ((double)sad_block(sY + yOff, W, pY) < skipThr) {
          pred_chroma(R, mbx * 8, mby * 8, skx, sky, pU, pV);
          predicted = 1;
          skip = residual_is_zero(sY + yOff, sU + cOff, sV + cOff, W, cW, pY, pU, pV, qp);
        }
      }
      if (skip) {
        if (!predicted) {
          pred_luma(R, mbx * 16, mby * 16, skx, sky, pY);
          pred_chroma(R, mbx * 8, mby * 8, skx, sky, pU, pV);
        }
        copy_pred(pY, pU, pV, rY + yOff, W, rU + cOff, rV + cOff, cW);
        set_info(I, addr, MB_SKIP, skx, sky, 0);
        skipRun++;
        stats[0]++;
        continue;
      }
      // Steps 2 and 3: motion search.
      int px, py;
      mv_pred(I, mbx, mby, &px, &py);
      const int sad = search_mb(R, sY + yOff, W, mbx, mby, range, lambda, px, py, skx, sky,
                                prevMvx[addr], prevMvy[addr], precision, visited, ++stats[3], mvOut);
      // Step 4: heal.
      if ((double)sad > healThr) {
        write_pcm_mb(skipRun, 30, sY + yOff, sU + cOff, sV + cOff, rY + yOff, rU + cOff, rV + cOff, W, cW);
        set_info(I, addr, MB_PCM, 0, 0, 16);
        skipRun = 0;
        stats[2]++;
        continue;
      }
      // Step 5: P_L0_16x16.
      const int mvx = mvOut[0], mvy = mvOut[1];
      pred_luma(R, mbx * 16, mby * 16, mvx, mvy, pY);
      pred_chroma(R, mbx * 8, mby * 8, mvx, mvy, pU, pV);
      if (forceMode == 2) {
        for (int i = 0; i < RES_SIZE; i++) res[i] = 0;
      } else {
        residual_mb(sY + yOff, sU + cOff, sV + cOff, W, cW, pY, pU, pV, qp, res);
      }
      TYPE(I)[addr] = MB_INTER;
      MVX(I)[addr] = (int16_t)mvx;
      MVY(I)[addr] = (int16_t)mvy;
      u8 *nzL = P8(I[INZL]), *nzCb = P8(I[INZCB]), *nzCr = P8(I[INZCR]);
      for (int i = 0; i < 16; i++) nzL[addr * 16 + i] = (u8)res[RES_NZL + i];
      for (int i = 0; i < 4; i++) {
        nzCb[addr * 4 + i] = (u8)res[RES_NZCB + i];
        nzCr[addr * 4 + i] = (u8)res[RES_NZCR + i];
      }
      write_inter_mb(skipRun, mvx - px, mvy - py, res, addr, mbx, mby, mbW, nzL, nzCb, nzCr);
      skipRun = 0;
      // Step 6: reconstruction (R-11).
      recon_inter(res, qp, pY, pU, pV, rY + yOff, W, rU + cOff, rV + cOff, cW);
      stats[1]++;
    }
  }
  if (skipRun > 0) put_ue((unsigned)skipRun);
}

/* ---------------- bit reader and CAVLC decoding (bitio.js, cavlc.js) ---------------- */

static const u8 *br_buf;
static int br_pos, br_len, br_base, br_err;

static inline unsigned peek(int n) { // n <= 24; bits after the end are zero
  const int i = br_pos >> 3;
  unsigned w = 0;
  for (int k = 0; k < 4; k++) w = (w << 8) | (i + k < ((br_len + 7) >> 3) ? br_buf[i + k] : 0);
  return (w << (br_pos & 7)) >> (32 - n);
}
static inline void skip_bits(int n) {
  br_pos += n;
  if (br_pos > br_len) br_err = 9;
}
static inline unsigned get(int n) {
  if (n == 0) return 0;
  if (n > 24) {
    const unsigned hi = get(n - 16);
    return (hi << 16) | get(16);
  }
  const unsigned v = peek(n);
  skip_bits(n);
  return v;
}
static inline unsigned get_ue(void) {
  int lz = 0;
  while (!br_err && get(1) == 0) {
    if (++lz > 31) {
      br_err = 9;
      return 0;
    }
  }
  return lz == 0 ? 0 : (1u << lz) - 1 + get(lz);
}
static inline int get_se(void) {
  const unsigned k = get_ue();
  return k & 1 ? (int)((k + 1) / 2) : -(int)(k / 2);
}

// Peek tables (tables.js makeVlcDecoder): entry = (value << 5) | len, 0 = no code.
typedef struct {
  int maxLen;
  i32 *t;
} Vlc;
static i32 vlc_ct0[1 << 16], vlc_ct1[1 << 14], vlc_ct2[1 << 10], vlc_ct3[1 << 6], vlc_cdc[1 << 8];
static i32 vlc_tz[15][1 << 9], vlc_cdctz[3][1 << 3], vlc_rb[7][1 << 11];
static Vlc VCT[4], VCDC, VTZ[15], VCDCTZ[3], VRB[7];
static int vlc_ready;

static void vlc_add(Vlc *v, int len, int code, int value) {
  if (len == 0) return;
  const int shift = v->maxLen - len, start = code << shift;
  for (int i = 0; i < (1 << shift); i++) v->t[start + i] = (value << 5) | len;
}
static void vlc_make(Vlc *v, i32 *t, const uint16_t *lens, const uint16_t *bits, int n) {
  int m = 1;
  for (int i = 0; i < n; i++) if (lens[i] > m) m = lens[i];
  v->maxLen = m;
  v->t = t;
  for (int i = 0; i < n; i++) vlc_add(v, lens[i], bits[i], i);
}
static void vlc_init(void) {
  i32 *ct[4] = {vlc_ct0, vlc_ct1, vlc_ct2, vlc_ct3};
  for (int t = 0; t < 4; t++) vlc_make(&VCT[t], ct[t], COEFF_TOKEN_LEN[t], COEFF_TOKEN_BITS[t], 68);
  vlc_make(&VCDC, vlc_cdc, CHROMA_DC_COEFF_TOKEN_LEN, CHROMA_DC_COEFF_TOKEN_BITS, 20);
  for (int t = 0; t < 15; t++) vlc_make(&VTZ[t], vlc_tz[t], TOTAL_ZEROS_LEN[t], TOTAL_ZEROS_BITS[t], 16);
  for (int t = 0; t < 3; t++) vlc_make(&VCDCTZ[t], vlc_cdctz[t], CHROMA_DC_TOTAL_ZEROS_LEN[t], CHROMA_DC_TOTAL_ZEROS_BITS[t], 4);
  for (int t = 0; t < 7; t++) vlc_make(&VRB[t], vlc_rb[t], RUN_BEFORE_LEN[t], RUN_BEFORE_BITS[t], 16);
  vlc_ready = 1;
}
static int read_vlc(const Vlc *v) {
  const int e = v->t[peek(v->maxLen)];
  if (e == 0) {
    br_err = 8;
    return 0;
  }
  skip_bits(e & 31);
  return e >> 5;
}

// cavlc.js readResidualBlock: coef (maxNum, scan order) must be zero. Returns TotalCoeff.
static int read_block(int *coef, int maxNum, int nC) {
  int lvl[16], run[16];
  const int tk = read_vlc(nC == -1 ? &VCDC : &VCT[token_table(nC)]);
  const int n = tk >> 2, t1 = tk & 3;
  if (n == 0 || br_err) return 0;
  if (n > maxNum) {
    br_err = 8;
    return 0;
  }
  for (int k = 0; k < t1; k++) lvl[k] = get(1) ? -1 : 1;
  int suffixLength = n > 10 && t1 < 3 ? 1 : 0;
  for (int k = t1; k < n; k++) {
    int prefix = 0;
    while (!br_err && get(1) == 0) {
      if (++prefix > 15) {
        br_err = 8;
        return 0;
      }
    }
    int levelCode = (prefix < 15 ? prefix : 15) << suffixLength;
    int suffixSize = suffixLength;
    if (prefix == 14 && suffixLength == 0) suffixSize = 4;
    if (prefix >= 15) suffixSize = prefix - 3;
    if (suffixSize > 0) levelCode += (int)get(suffixSize);
    if (prefix >= 15 && suffixLength == 0) levelCode += 15;
    if (k == t1 && t1 < 3) levelCode += 2;
    const int level = levelCode % 2 == 0 ? (levelCode + 2) >> 1 : (-levelCode - 1) >> 1;
    lvl[k] = level;
    if (suffixLength == 0) suffixLength = 1;
    const int a = level < 0 ? -level : level;
    if (a > (3 << (suffixLength - 1)) && suffixLength < 6) suffixLength++;
  }
  int totalZeros = 0;
  if (n < maxNum) totalZeros = read_vlc(maxNum == 4 ? &VCDCTZ[n - 1] : &VTZ[n - 1]);
  if (totalZeros + n > maxNum) {
    br_err = 8;
    return 0;
  }
  int zerosLeft = totalZeros;
  for (int k = 0; k < n - 1; k++) {
    if (zerosLeft > 0) {
      const int r = read_vlc(&VRB[(zerosLeft > 7 ? 7 : zerosLeft) - 1]);
      if (r > zerosLeft) {
        br_err = 8;
        return 0;
      }
      run[k] = r;
      zerosLeft -= r;
    } else run[k] = 0;
  }
  run[n - 1] = zerosLeft;
  int pos = -1;
  for (int k = n - 1; k >= 0; k--) {
    pos += run[k] + 1;
    coef[pos] = lvl[k];
  }
  return n;
}

/* ---------------- slice decoder (decoder.js decodeSliceData) ----------------
   bits: the slice data from bit `start`, `len` bits in all (end of slice data). alignBase: the
   count of bits before bit 0 in the slice (for pcm alignment). Writes the picture (Y, U, V coded,
   stride W). Returns 0, or an error code (decoder.js DECODE_ERRORS). */
EXPORT(decode_slice)
int decode_slice(const u8 *bits, int start, int len, int alignBase, int intra, int sliceQp,
                 i32 *R, i32 *I, u8 *Y, u8 *U, u8 *V, int W, u8 *pred, i32 *res) {
  if (!vlc_ready) vlc_init();
  br_buf = bits;
  br_pos = start;
  br_len = len;
  br_base = alignBase;
  br_err = 0;
  const int mbW = I[IMBW], n = mbW * I[IMBH], cW = W >> 1;
  u8 *pY = pred, *pU = pred + 256, *pV = pred + 320;
  int qp = sliceQp, addr = 0;
  while (addr < n) {
    if (!intra) {
      int run = (int)get_ue();
      if (br_err) return br_err;
      if (addr + run > n) return 1;
      while (run-- > 0) {
        const int mbx = addr % mbW, mby = addr / mbW;
        int mx, my;
        mv_skip(I, mbx, mby, &mx, &my);
        set_info(I, addr, MB_SKIP, mx, my, 0);
        pred_luma(R, mbx * 16, mby * 16, mx, my, pY);
        pred_chroma(R, mbx * 8, mby * 8, mx, my, pU, pV);
        copy_pred(pY, pU, pV, Y + mby * 16 * W + mbx * 16, W, U + mby * 8 * cW + mbx * 8, V + mby * 8 * cW + mbx * 8, cW);
        addr++;
      }
      if (addr >= n) break;
    }
    const int mbType = (int)get_ue();
    if (br_err) return br_err;
    const int mbx = addr % mbW, mby = addr / mbW;
    u8 *dY = Y + mby * 16 * W + mbx * 16, *dU = U + mby * 8 * cW + mbx * 8, *dV = V + mby * 8 * cW + mbx * 8;
    if (intra ? mbType == 25 : mbType == 30) {
      // I_PCM
      if (get((8 - ((br_pos + br_base) & 7)) & 7) != 0) return 4;
      for (int y = 0; y < 16; y++) for (int x = 0; x < 16; x++) dY[y * W + x] = (u8)get(8);
      for (int y = 0; y < 8; y++) for (int x = 0; x < 8; x++) dU[y * cW + x] = (u8)get(8);
      for (int y = 0; y < 8; y++) for (int x = 0; x < 8; x++) dV[y * cW + x] = (u8)get(8);
      if (br_err) return br_err;
      set_info(I, addr, MB_PCM, 0, 0, 16);
    } else if (!intra && mbType == 0) {
      // P_L0_16x16
      int px, py;
      mv_pred(I, mbx, mby, &px, &py);
      const int mvx = px + get_se(), mvy = py + get_se();
      if (br_err) return br_err;
      if (mvx < -8192 || mvx > 8191 || mvy < -2048 || mvy > 2047) return 5;
      const unsigned code = get_ue();
      if (br_err) return br_err;
      if (code > 47) return 6;
      const int cbp = CBP_INTER_FROM_CODE[code];
      if (cbp > 0) {
        const int dq = get_se();
        if (dq < -26 || dq > 25) return 7;
        qp = (qp + dq + 52) % 52;
      }
      set_info(I, addr, MB_INTER, mvx, mvy, 0);
      u8 *nzL = P8(I[INZL]), *nzCb = P8(I[INZCB]), *nzCr = P8(I[INZCR]);
      for (int i = 0; i < RES_SIZE; i++) res[i] = 0;
      res[RES_CBP] = cbp;
      int coef[16];
      for (int b8 = 0; b8 < 4; b8++) {
        if (!((cbp >> b8) & 1)) continue;
        for (int b4 = 0; b4 < 4; b4++) {
          const int bx = (b8 & 1) * 2 + (b4 & 1), by = (b8 >> 1) * 2 + (b4 >> 1), blk = by * 4 + bx;
          for (int i = 0; i < 16; i++) coef[i] = 0;
          const int nn = read_block(coef, 16, luma_nc(nzL, addr, mbx, mby, mbW, bx, by));
          if (br_err) return br_err;
          nzL[addr * 16 + blk] = (u8)nn;
          res[RES_NZL + blk] = nn;
          for (int i = 0; i < 16; i++) res[RES_LUMA + blk * 16 + ZIGZAG4x4[i]] = coef[i];
        }
      }
      const int cc = cbp >> 4;
      if (cc) {
        for (int comp = 0; comp < 2; comp++) {
          for (int i = 0; i < 4; i++) coef[i] = 0;
          read_block(coef, 4, -1);
          if (br_err) return br_err;
          for (int i = 0; i < 4; i++) res[(comp ? RES_CRDC : RES_CBDC) + i] = coef[i];
        }
      }
      if (cc == 2) {
        for (int comp = 0; comp < 2; comp++) {
          u8 *nz = comp ? nzCr : nzCb;
          i32 *ac = res + (comp ? RES_CR : RES_CB);
          for (int b = 0; b < 4; b++) {
            for (int i = 0; i < 16; i++) coef[i] = 0;
            const int nn = read_block(coef, 15, chroma_nc(nz, addr, mbx, mby, mbW, b & 1, b >> 1));
            if (br_err) return br_err;
            nz[addr * 4 + b] = (u8)nn;
            for (int i = 0; i < 15; i++) ac[b * 16 + ZIGZAG4x4[i + 1]] = coef[i];
          }
        }
      }
      pred_luma(R, mbx * 16, mby * 16, mvx, mvy, pY);
      pred_chroma(R, mbx * 8, mby * 8, mvx, mvy, pU, pV);
      recon_inter(res, qp, pY, pU, pV, dY, W, dU, dV, cW);
    } else {
      return 2;
    }
    addr++;
  }
  if (br_pos != br_len) return 3;
  return 0;
}
