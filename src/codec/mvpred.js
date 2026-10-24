// Macroblock state of the current picture, motion vector prediction, and the P_Skip vector.
// References: H.264 8.4.1.1 (P_Skip), 8.4.1.3 (16x16 prediction), 6.4.11.7 (neighbors).
// Only 16x16 partitions and one reference picture (refIdx 0) are used.

export const MB_SKIP = 0;
export const MB_INTER = 1;
export const MB_PCM = 2;

export function makeMbInfo(numMbs) {
  return {
    type: new Uint8Array(numMbs),
    mvx: new Int16Array(numMbs),
    mvy: new Int16Array(numMbs),
    nzLuma: new Uint8Array(numMbs * 16), // TotalCoeff, 4x4 blocks in raster order.
    nzCb: new Uint8Array(numMbs * 4),
    nzCr: new Uint8Array(numMbs * 4),
  };
}

// The same state in the memory of the WebAssembly kernels (wasm.js). Reserve now; call the returned
// function after k.seal(). The object also has the address I of the descriptor for kernels.c.
export function allocMbInfo(k, numMbs, mbW, mbH) {
  const p = { type: k.alloc(numMbs), mv: k.alloc(numMbs * 4), nz: k.alloc(numMbs * 24), I: k.alloc(32) };
  return () => {
    k.i32(p.I, 8).set([p.type, p.mv, p.mv + numMbs * 2, p.nz, p.nz + numMbs * 16, p.nz + numMbs * 20, mbW, mbH]);
    return {
      type: k.u8(p.type, numMbs),
      mvx: new Int16Array(k.mem.buffer, p.mv, numMbs),
      mvy: new Int16Array(k.mem.buffer, p.mv + numMbs * 2, numMbs),
      nzLuma: k.u8(p.nz, numMbs * 16),
      nzCb: k.u8(p.nz + numMbs * 16, numMbs * 4),
      nzCr: k.u8(p.nz + numMbs * 20, numMbs * 4),
      I: p.I,
    };
  };
}

const nb = new Int32Array(9); // refA, mvA.x, mvA.y, refB, ..., refC, ...

function loadNeighbor(info, addr, avail, k) {
  if (!avail || info.type[addr] === MB_PCM) {
    nb[k] = -1;
    nb[k + 1] = 0;
    nb[k + 2] = 0;
  } else {
    nb[k] = 0;
    nb[k + 1] = info.mvx[addr];
    nb[k + 2] = info.mvy[addr];
  }
}

function median3(a, b, c) {
  return a > b ? (b > c ? b : a > c ? c : a) : a > c ? a : b > c ? c : b;
}

// 16x16 motion vector predictor (8.4.1.3). Writes [mvx, mvy] to out.
export function mvPred16x16(info, mbx, mby, mbW, out) {
  const addr = mby * mbW + mbx;
  const availA = mbx > 0;
  const availB = mby > 0;
  const availC = mby > 0 && mbx < mbW - 1;
  const availD = mbx > 0 && mby > 0;
  loadNeighbor(info, addr - 1, availA, 0);
  loadNeighbor(info, addr - mbW, availB, 3);
  let availCD = true;
  if (availC) loadNeighbor(info, addr - mbW + 1, true, 6);
  else if (availD) loadNeighbor(info, addr - mbW - 1, true, 6);
  else {
    availCD = false;
    loadNeighbor(info, 0, false, 6);
  }
  if (!availB && !availCD && availA) {
    nb[3] = nb[6] = nb[0];
    nb[4] = nb[7] = nb[1];
    nb[5] = nb[8] = nb[2];
  }
  const mA = nb[0] === 0, mB = nb[3] === 0, mC = nb[6] === 0;
  if (mA + mB + mC === 1) {
    const k = mA ? 0 : mB ? 3 : 6;
    out[0] = nb[k + 1];
    out[1] = nb[k + 2];
  } else {
    out[0] = median3(nb[1], nb[4], nb[7]);
    out[1] = median3(nb[2], nb[5], nb[8]);
  }
}

// P_Skip motion vector (8.4.1.1). Writes [mvx, mvy] to out.
export function mvSkip(info, mbx, mby, mbW, out) {
  if (mbx === 0 || mby === 0) {
    out[0] = out[1] = 0;
    return;
  }
  const addr = mby * mbW + mbx;
  const a = addr - 1, b = addr - mbW;
  if (
    (info.type[a] !== MB_PCM && info.mvx[a] === 0 && info.mvy[a] === 0) ||
    (info.type[b] !== MB_PCM && info.mvx[b] === 0 && info.mvy[b] === 0)
  ) {
    out[0] = out[1] = 0;
    return;
  }
  mvPred16x16(info, mbx, mby, mbW, out);
}

// nC for a luma 4x4 block (9.2.1). bx, by: block position in the MB (0..3).
// A P_Skip neighbor has TotalCoeff 0 and an I_PCM neighbor has 16 (both are stored in nzLuma).
export function lumaNC(info, addr, mbx, mby, mbW, bx, by) {
  const nz = info.nzLuma;
  let availA = true, availB = true, nA = 0, nB = 0;
  if (bx > 0) nA = nz[addr * 16 + by * 4 + bx - 1];
  else if (mbx > 0) nA = nz[(addr - 1) * 16 + by * 4 + 3];
  else availA = false;
  if (by > 0) nB = nz[addr * 16 + (by - 1) * 4 + bx];
  else if (mby > 0) nB = nz[(addr - mbW) * 16 + 12 + bx];
  else availB = false;
  if (availA && availB) return (nA + nB + 1) >> 1;
  if (availA) return nA;
  if (availB) return nB;
  return 0;
}

// nC for a chroma AC 4x4 block. nz = info.nzCb or info.nzCr. bx, by: 0..1.
export function chromaNC(nz, addr, mbx, mby, mbW, bx, by) {
  let availA = true, availB = true, nA = 0, nB = 0;
  if (bx > 0) nA = nz[addr * 4 + by * 2];
  else if (mbx > 0) nA = nz[(addr - 1) * 4 + by * 2 + 1];
  else availA = false;
  if (by > 0) nB = nz[addr * 4 + bx];
  else if (mby > 0) nB = nz[(addr - mbW) * 4 + 2 + bx];
  else availB = false;
  if (availA && availB) return (nA + nB + 1) >> 1;
  if (availA) return nA;
  if (availB) return nB;
  return 0;
}
