// Constant tables: zigzag scan, CBP mapping, chroma QP, quantization, CAVLC VLC tables.
// References: H.264 8.5.6 (Table 8-13), 9.1.2 (Table 9-4), 8.5.8 (Table 8-15), 9.2 (Tables 9-5 .. 9-10).

// Frame zigzag scan for 4x4 blocks: scan index -> raster index (y*4 + x).
export const ZIGZAG4x4 = new Uint8Array([0, 1, 4, 8, 5, 2, 3, 6, 9, 12, 13, 10, 7, 11, 14, 15]);

// Table 9-4, inter column (ChromaArrayType 1): codeNum -> coded_block_pattern.
export const CBP_INTER_FROM_CODE = new Uint8Array([
  0, 16, 1, 2, 4, 8, 32, 3, 5, 10, 12, 15, 47, 7, 11, 13,
  14, 6, 9, 31, 35, 37, 42, 44, 33, 34, 36, 40, 39, 43, 45, 46,
  17, 18, 20, 24, 19, 21, 26, 28, 23, 27, 29, 30, 22, 25, 38, 41,
]);
export const CBP_INTER_TO_CODE = new Uint8Array(48);
for (let i = 0; i < 48; i++) CBP_INTER_TO_CODE[CBP_INTER_FROM_CODE[i]] = i;

// Table 8-15: qPI -> QPc (chroma_qp_index_offset = 0, so qPI = QP).
export const CHROMA_QP = new Uint8Array(52);
{
  const hi = [29, 30, 31, 32, 32, 33, 34, 34, 35, 35, 36, 36, 37, 37, 37, 38, 38, 38, 39, 39, 39, 39];
  for (let q = 0; q < 52; q++) CHROMA_QP[q] = q < 30 ? q : hi[q - 30];
}

// Position class of a raster index in a 4x4 block:
// 0 = (even, even), 1 = (odd, odd), 2 = other.
export const POS_CLASS = new Uint8Array(16);
for (let i = 0; i < 16; i++) {
  const x = i & 3;
  const y = i >> 2;
  POS_CLASS[i] = (x & 1) === 0 && (y & 1) === 0 ? 0 : (x & 1) === 1 && (y & 1) === 1 ? 1 : 2;
}

// Forward quantization multipliers MF[QP % 6][class] (encoder only).
export const QUANT_MF = [
  [13107, 5243, 8066],
  [11916, 4660, 7490],
  [10082, 4194, 6554],
  [9362, 3647, 5825],
  [8192, 3355, 5243],
  [7282, 2893, 4559],
];

// normAdjust4x4 v[QP % 6][class] (8.5.9). With flat scaling, LevelScale4x4 = 16 * v.
export const DEQUANT_V = [
  [10, 16, 13],
  [11, 18, 14],
  [13, 20, 16],
  [14, 23, 18],
  [16, 25, 20],
  [18, 29, 23],
];

// Table 9-5: coeff_token. Index = TotalCoeff * 4 + TrailingOnes.
// Tables 0..3 are for 0<=nC<2, 2<=nC<4, 4<=nC<8, 8<=nC.
export const COEFF_TOKEN_LEN = [
  [
    1, 0, 0, 0,
    6, 2, 0, 0, 8, 6, 3, 0, 9, 8, 7, 5, 10, 9, 8, 6,
    11, 10, 9, 7, 13, 11, 10, 8, 13, 13, 11, 9, 13, 13, 13, 10,
    14, 14, 13, 11, 14, 14, 14, 13, 15, 15, 14, 14, 15, 15, 15, 14,
    16, 15, 15, 15, 16, 16, 16, 15, 16, 16, 16, 16, 16, 16, 16, 16,
  ],
  [
    2, 0, 0, 0,
    6, 2, 0, 0, 6, 5, 3, 0, 7, 6, 6, 4, 8, 6, 6, 4,
    8, 7, 7, 5, 9, 8, 8, 6, 11, 9, 9, 6, 11, 11, 11, 7,
    12, 11, 11, 9, 12, 12, 12, 11, 12, 12, 12, 11, 13, 13, 13, 12,
    13, 13, 13, 13, 13, 14, 13, 13, 14, 14, 14, 13, 14, 14, 14, 14,
  ],
  [
    4, 0, 0, 0,
    6, 4, 0, 0, 6, 5, 4, 0, 6, 5, 5, 4, 7, 5, 5, 4,
    7, 5, 5, 4, 7, 6, 6, 4, 7, 6, 6, 4, 8, 7, 7, 5,
    8, 8, 7, 6, 9, 8, 8, 7, 9, 9, 8, 8, 9, 9, 9, 8,
    10, 9, 9, 9, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10,
  ],
  [
    6, 0, 0, 0,
    6, 6, 0, 0, 6, 6, 6, 0, 6, 6, 6, 6, 6, 6, 6, 6,
    6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6,
    6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6,
    6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6,
  ],
];

export const COEFF_TOKEN_BITS = [
  [
    1, 0, 0, 0,
    5, 1, 0, 0, 7, 4, 1, 0, 7, 6, 5, 3, 7, 6, 5, 3,
    7, 6, 5, 4, 15, 6, 5, 4, 11, 14, 5, 4, 8, 10, 13, 4,
    15, 14, 9, 4, 11, 10, 13, 12, 15, 14, 9, 12, 11, 10, 13, 8,
    15, 1, 9, 12, 11, 14, 13, 8, 7, 10, 9, 12, 4, 6, 5, 8,
  ],
  [
    3, 0, 0, 0,
    11, 2, 0, 0, 7, 7, 3, 0, 7, 10, 9, 5, 7, 6, 5, 4,
    4, 6, 5, 6, 7, 6, 5, 8, 15, 6, 5, 4, 11, 14, 13, 4,
    15, 10, 9, 4, 11, 14, 13, 12, 8, 10, 9, 8, 15, 14, 13, 12,
    11, 10, 9, 12, 7, 11, 6, 8, 9, 8, 10, 1, 7, 6, 5, 4,
  ],
  [
    15, 0, 0, 0,
    15, 14, 0, 0, 11, 15, 13, 0, 8, 12, 14, 12, 15, 10, 11, 11,
    11, 8, 9, 10, 9, 14, 13, 9, 8, 10, 9, 8, 15, 14, 13, 13,
    11, 14, 10, 12, 15, 10, 13, 12, 11, 14, 9, 12, 8, 10, 13, 8,
    13, 7, 9, 12, 9, 12, 11, 10, 5, 8, 7, 6, 1, 4, 3, 2,
  ],
  [
    3, 0, 0, 0,
    0, 1, 0, 0, 4, 5, 6, 0, 8, 9, 10, 11, 12, 13, 14, 15,
    16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31,
    32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47,
    48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63,
  ],
];

// Table 9-5, nC = -1 (chroma DC, 4:2:0). Index = TotalCoeff * 4 + TrailingOnes.
export const CHROMA_DC_COEFF_TOKEN_LEN = [2, 0, 0, 0, 6, 1, 0, 0, 6, 6, 3, 0, 6, 7, 7, 6, 6, 8, 8, 7];
export const CHROMA_DC_COEFF_TOKEN_BITS = [1, 0, 0, 0, 7, 1, 0, 0, 4, 6, 1, 0, 3, 3, 2, 5, 2, 3, 2, 0];

// Tables 9-7 and 9-8: total_zeros for 4x4 blocks. Index [TotalCoeff - 1][total_zeros].
export const TOTAL_ZEROS_LEN = [
  [1, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 9],
  [3, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 6, 6, 6, 6],
  [4, 3, 3, 3, 4, 4, 3, 3, 4, 5, 5, 6, 5, 6],
  [5, 3, 4, 4, 3, 3, 3, 4, 3, 4, 5, 5, 5],
  [4, 4, 4, 3, 3, 3, 3, 3, 4, 5, 4, 5],
  [6, 5, 3, 3, 3, 3, 3, 3, 4, 3, 6],
  [6, 5, 3, 3, 3, 2, 3, 4, 3, 6],
  [6, 4, 5, 3, 2, 2, 3, 3, 6],
  [6, 6, 4, 2, 2, 3, 2, 5],
  [5, 5, 3, 2, 2, 2, 4],
  [4, 4, 3, 3, 1, 3],
  [4, 4, 2, 1, 3],
  [3, 3, 1, 2],
  [2, 2, 1],
  [1, 1],
];
export const TOTAL_ZEROS_BITS = [
  [1, 3, 2, 3, 2, 3, 2, 3, 2, 3, 2, 3, 2, 3, 2, 1],
  [7, 6, 5, 4, 3, 5, 4, 3, 2, 3, 2, 3, 2, 1, 0],
  [5, 7, 6, 5, 4, 3, 4, 3, 2, 3, 2, 1, 1, 0],
  [3, 7, 5, 4, 6, 5, 4, 3, 3, 2, 2, 1, 0],
  [5, 4, 3, 7, 6, 5, 4, 3, 2, 1, 1, 0],
  [1, 1, 7, 6, 5, 4, 3, 2, 1, 1, 0],
  [1, 1, 5, 4, 3, 3, 2, 1, 1, 0],
  [1, 1, 1, 3, 3, 2, 2, 1, 0],
  [1, 0, 1, 3, 2, 1, 1, 1],
  [1, 0, 1, 3, 2, 1, 1],
  [0, 1, 1, 2, 1, 3],
  [0, 1, 1, 1, 1],
  [0, 1, 1, 1],
  [0, 1, 1],
  [0, 1],
];

// Table 9-9a: total_zeros for chroma DC 2x2. Index [TotalCoeff - 1][total_zeros].
export const CHROMA_DC_TOTAL_ZEROS_LEN = [
  [1, 2, 3, 3],
  [1, 2, 2],
  [1, 1],
];
export const CHROMA_DC_TOTAL_ZEROS_BITS = [
  [1, 1, 1, 0],
  [1, 1, 0],
  [1, 0],
];

// Table 9-10: run_before. Index [min(zerosLeft, 7) - 1][run_before].
export const RUN_BEFORE_LEN = [
  [1, 1],
  [1, 2, 2],
  [2, 2, 2, 2],
  [2, 2, 2, 3, 3],
  [2, 2, 3, 3, 3, 3],
  [2, 3, 3, 3, 3, 3, 3],
  [3, 3, 3, 3, 3, 3, 3, 4, 5, 6, 7, 8, 9, 10, 11],
];
export const RUN_BEFORE_BITS = [
  [1, 0],
  [1, 1, 0],
  [3, 2, 1, 0],
  [3, 2, 1, 1, 0],
  [3, 2, 3, 2, 1, 0],
  [3, 0, 1, 3, 2, 5, 4],
  [7, 6, 5, 4, 3, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1],
];

// Make a peek-table VLC decoder. entries: [len, code, value]. A table entry is (value << 5) | len.
// Zero means "no code" (the bitstream is not valid).
export function makeVlcDecoder(entries) {
  let maxLen = 1;
  for (const [len] of entries) if (len > maxLen) maxLen = len;
  const table = new Int32Array(1 << maxLen);
  for (const [len, code, value] of entries) {
    if (len === 0) continue;
    const shift = maxLen - len;
    const start = code << shift;
    for (let i = 0; i < 1 << shift; i++) {
      if (table[start + i] !== 0) throw new Error('VLC table is not prefix free');
      table[start + i] = (value << 5) | len;
    }
  }
  return { maxLen, table };
}

function tokenEntries(lens, bits, maxTotal) {
  const e = [];
  for (let tc = 0; tc <= maxTotal; tc++) {
    for (let t1 = 0; t1 <= Math.min(3, tc); t1++) {
      const i = tc * 4 + t1;
      e.push([lens[i], bits[i], i]);
    }
  }
  return e;
}

// Decoders. coeff_token values are TotalCoeff * 4 + TrailingOnes.
export const COEFF_TOKEN_DEC = COEFF_TOKEN_LEN.map((l, t) => makeVlcDecoder(tokenEntries(l, COEFF_TOKEN_BITS[t], 16)));
export const CHROMA_DC_COEFF_TOKEN_DEC = makeVlcDecoder(
  tokenEntries(CHROMA_DC_COEFF_TOKEN_LEN, CHROMA_DC_COEFF_TOKEN_BITS, 4),
);
export const TOTAL_ZEROS_DEC = TOTAL_ZEROS_LEN.map((l, t) =>
  makeVlcDecoder(l.map((len, tz) => [len, TOTAL_ZEROS_BITS[t][tz], tz])),
);
export const CHROMA_DC_TOTAL_ZEROS_DEC = CHROMA_DC_TOTAL_ZEROS_LEN.map((l, t) =>
  makeVlcDecoder(l.map((len, tz) => [len, CHROMA_DC_TOTAL_ZEROS_BITS[t][tz], tz])),
);
export const RUN_BEFORE_DEC = RUN_BEFORE_LEN.map((l, t) =>
  makeVlcDecoder(l.map((len, r) => [len, RUN_BEFORE_BITS[t][r], r])),
);
