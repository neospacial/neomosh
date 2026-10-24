// residual_block_cavlc() write and read. Reference: H.264 7.3.5.3.2 and 9.2.

import {
  COEFF_TOKEN_LEN, COEFF_TOKEN_BITS, COEFF_TOKEN_DEC,
  CHROMA_DC_COEFF_TOKEN_LEN, CHROMA_DC_COEFF_TOKEN_BITS, CHROMA_DC_COEFF_TOKEN_DEC,
  TOTAL_ZEROS_LEN, TOTAL_ZEROS_BITS, TOTAL_ZEROS_DEC,
  CHROMA_DC_TOTAL_ZEROS_LEN, CHROMA_DC_TOTAL_ZEROS_BITS, CHROMA_DC_TOTAL_ZEROS_DEC,
  RUN_BEFORE_LEN, RUN_BEFORE_BITS, RUN_BEFORE_DEC,
} from './tables.js';

function tokenTable(nC) {
  return nC < 2 ? 0 : nC < 4 ? 1 : nC < 8 ? 2 : 3;
}

const lvl = new Int32Array(16);
const run = new Int32Array(16);

// Write one block. coef: maxNum coefficients in scan order. nC = -1 for chroma DC.
// Returns TotalCoeff.
export function writeResidualBlock(bw, coef, maxNum, nC) {
  let last = maxNum - 1;
  while (last >= 0 && coef[last] === 0) last--;
  // Levels from the highest frequency to the lowest, and the zeros before each one.
  let n = 0;
  let i = last;
  while (i >= 0) {
    lvl[n] = coef[i];
    i--;
    let r = 0;
    while (i >= 0 && coef[i] === 0) {
      r++;
      i--;
    }
    run[n] = r;
    n++;
  }
  let t1 = 0;
  while (t1 < n && t1 < 3 && (lvl[t1] === 1 || lvl[t1] === -1)) t1++;

  const tk = n * 4 + t1;
  if (nC === -1) bw.u(CHROMA_DC_COEFF_TOKEN_LEN[tk], CHROMA_DC_COEFF_TOKEN_BITS[tk]);
  else {
    const t = tokenTable(nC);
    bw.u(COEFF_TOKEN_LEN[t][tk], COEFF_TOKEN_BITS[t][tk]);
  }
  if (n === 0) return 0;

  for (let k = 0; k < t1; k++) bw.u(1, lvl[k] < 0 ? 1 : 0);

  let suffixLength = n > 10 && t1 < 3 ? 1 : 0;
  for (let k = t1; k < n; k++) {
    const level = lvl[k];
    let levelCode = level > 0 ? 2 * level - 2 : -2 * level - 1;
    if (k === t1 && t1 < 3) levelCode -= 2;
    let prefix, suffix, suffixSize;
    if (suffixLength === 0) {
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
    } else if (levelCode < 15 << suffixLength) {
      prefix = levelCode >> suffixLength;
      suffixSize = suffixLength;
      suffix = levelCode & ((1 << suffixLength) - 1);
    } else {
      prefix = 15;
      suffixSize = 12;
      suffix = levelCode - (15 << suffixLength);
    }
    if (suffix >= 4096) throw new Error('CAVLC: level too large');
    bw.u(prefix, 0);
    bw.u(1, 1);
    bw.u(suffixSize, suffix);
    if (suffixLength === 0) suffixLength = 1;
    const a = level < 0 ? -level : level;
    if (a > 3 << (suffixLength - 1) && suffixLength < 6) suffixLength++;
  }

  const totalZeros = last + 1 - n;
  if (n < maxNum) {
    if (maxNum === 4) bw.u(CHROMA_DC_TOTAL_ZEROS_LEN[n - 1][totalZeros], CHROMA_DC_TOTAL_ZEROS_BITS[n - 1][totalZeros]);
    else bw.u(TOTAL_ZEROS_LEN[n - 1][totalZeros], TOTAL_ZEROS_BITS[n - 1][totalZeros]);
  }
  let zerosLeft = totalZeros;
  for (let k = 0; k < n - 1 && zerosLeft > 0; k++) {
    const t = (zerosLeft > 7 ? 7 : zerosLeft) - 1;
    bw.u(RUN_BEFORE_LEN[t][run[k]], RUN_BEFORE_BITS[t][run[k]]);
    zerosLeft -= run[k];
  }
  return n;
}

function readVlc(br, dec) {
  const e = dec.table[br.peek(dec.maxLen)];
  if (e === 0) throw new Error('CAVLC: invalid code');
  br.skip(e & 31);
  return e >> 5;
}

// Read one block into coef (maxNum coefficients in scan order; the caller clears it).
// Returns TotalCoeff.
export function readResidualBlock(br, coef, maxNum, nC) {
  const tk = readVlc(br, nC === -1 ? CHROMA_DC_COEFF_TOKEN_DEC : COEFF_TOKEN_DEC[tokenTable(nC)]);
  const n = tk >> 2;
  const t1 = tk & 3;
  if (n === 0) return 0;
  if (n > maxNum) throw new Error('CAVLC: TotalCoeff too large');

  for (let k = 0; k < t1; k++) lvl[k] = br.u1() ? -1 : 1;
  let suffixLength = n > 10 && t1 < 3 ? 1 : 0;
  for (let k = t1; k < n; k++) {
    let prefix = 0;
    while (br.u1() === 0) {
      prefix++;
      if (prefix > 15) throw new Error('CAVLC: level_prefix > 15');
    }
    let levelCode = (Math.min(15, prefix) << suffixLength);
    let suffixSize = suffixLength;
    if (prefix === 14 && suffixLength === 0) suffixSize = 4;
    if (prefix >= 15) suffixSize = prefix - 3;
    if (suffixSize > 0) levelCode += br.u(suffixSize);
    if (prefix >= 15 && suffixLength === 0) levelCode += 15;
    if (k === t1 && t1 < 3) levelCode += 2;
    const level = levelCode % 2 === 0 ? (levelCode + 2) >> 1 : (-levelCode - 1) >> 1;
    lvl[k] = level;
    if (suffixLength === 0) suffixLength = 1;
    const a = level < 0 ? -level : level;
    if (a > 3 << (suffixLength - 1) && suffixLength < 6) suffixLength++;
  }

  let totalZeros = 0;
  if (n < maxNum) {
    totalZeros = readVlc(br, maxNum === 4 ? CHROMA_DC_TOTAL_ZEROS_DEC[n - 1] : TOTAL_ZEROS_DEC[n - 1]);
  }
  if (totalZeros + n > maxNum) throw new Error('CAVLC: total_zeros too large');
  let zerosLeft = totalZeros;
  for (let k = 0; k < n - 1; k++) {
    if (zerosLeft > 0) {
      const r = readVlc(br, RUN_BEFORE_DEC[(zerosLeft > 7 ? 7 : zerosLeft) - 1]);
      if (r > zerosLeft) throw new Error('CAVLC: run_before too large');
      run[k] = r;
      zerosLeft -= r;
    } else run[k] = 0;
  }
  run[n - 1] = zerosLeft;
  let pos = -1;
  for (let k = n - 1; k >= 0; k--) {
    pos += run[k] + 1;
    coef[pos] = lvl[k];
  }
  return n;
}
