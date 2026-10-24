// Bit writer, bit reader, Exp-Golomb codes, and emulation prevention.
// References: H.264 7.2 (syntax functions), 9.1 (Exp-Golomb), 7.4.1 (emulation prevention).
// R-09: plain JavaScript with no dependencies.

export class BitWriter {
  constructor(capacity = 4096) {
    this.buf = new Uint8Array(Math.max(16, capacity));
    this.pos = 0; // Position in bits.
  }

  // Make sure that nBits more bits fit. New bytes are zero.
  ensure(nBits) {
    const need = ((this.pos + nBits + 7) >> 3) + 4;
    if (need <= this.buf.length) return;
    let n = this.buf.length * 2;
    while (n < need) n *= 2;
    const b = new Uint8Array(n);
    b.set(this.buf.subarray(0, (this.pos + 7) >> 3));
    this.buf = b;
  }

  // Write the n low bits of v (0 <= n <= 32, v >= 0), most significant bit first.
  u(n, v) {
    if (n === 0) return;
    this.ensure(n);
    const buf = this.buf;
    let p = this.pos;
    this.pos = p + n;
    while (n > 0) {
      const free = 8 - (p & 7);
      const take = n < free ? n : free;
      const bits = (v >>> (n - take)) & ((1 << take) - 1);
      buf[p >> 3] |= bits << (free - take);
      p += take;
      n -= take;
    }
  }

  ue(v) {
    const x = v + 1;
    const len = 31 - Math.clz32(x);
    this.u(len, 0);
    this.u(len + 1, x);
  }

  se(v) {
    this.ue(v > 0 ? 2 * v - 1 : -2 * v);
  }

  // Move to the next byte boundary. The skipped bits are zero.
  alignZero() {
    const r = (8 - (this.pos & 7)) & 7;
    this.ensure(r);
    this.pos += r;
  }

  // Write whole bytes. The writer must be byte aligned.
  bytes(arr) {
    if (this.pos & 7) throw new Error('BitWriter.bytes: not aligned');
    this.ensure(arr.length * 8);
    this.buf.set(arr, this.pos >> 3);
    this.pos += arr.length * 8;
  }

  // rbsp_trailing_bits / rbsp_slice_trailing_bits: one 1 bit, then 0 bits to the byte boundary.
  trailing() {
    this.u(1, 1);
    this.alignZero();
  }

  // Append bitLen bits from src (first bit = MSB of src[0]).
  // The bits of src after bitLen must be zero.
  appendBits(src, bitLen) {
    if ((this.pos & 7) === 0) {
      const nBytes = (bitLen + 7) >> 3;
      this.ensure(nBytes * 8);
      this.buf.set(src.subarray(0, nBytes), this.pos >> 3);
      this.pos += bitLen;
      return;
    }
    const full = bitLen >> 3;
    for (let i = 0; i < full; i++) this.u(8, src[i]);
    const rem = bitLen & 7;
    if (rem) this.u(rem, src[full] >> (8 - rem));
  }

  // A copy of the written bytes. The last byte is padded with zero bits.
  toBytes() {
    return this.buf.slice(0, (this.pos + 7) >> 3);
  }
}

// Copy the bits [from, to) of src into a new array. The first copied bit becomes the MSB of byte 0.
// The bits after the end are zero.
export function extractBits(src, from, to) {
  const len = to - from;
  const out = new Uint8Array((len + 7) >> 3);
  const sh = from & 7;
  const base = from >> 3;
  const n = src.length;
  for (let k = 0; k < out.length; k++) {
    const a = base + k < n ? src[base + k] : 0;
    const b = base + k + 1 < n ? src[base + k + 1] : 0;
    out[k] = ((a << sh) | (b >> (8 - sh))) & 255;
  }
  if (len & 7) out[out.length - 1] &= (0xff << (8 - (len & 7))) & 0xff;
  return out;
}

export class BitReader {
  // alignBase: count of bits before bits[0] in the full slice. It is used only for byte alignment
  // (pcm_alignment_zero_bit), because a stored slice_data() does not start on a byte boundary.
  constructor(bytes, bitLen = bytes.length * 8, alignBase = 0) {
    this.buf = bytes;
    this.len = bitLen;
    this.pos = 0;
    this.alignBase = alignBase;
  }

  bitsLeft() {
    return this.len - this.pos;
  }

  // Read n bits (n <= 24) but do not advance. Bits after the end of the buffer read as zero.
  peek(n) {
    const p = this.pos;
    const i = p >> 3;
    const buf = this.buf;
    const L = buf.length;
    const w =
      (((i < L ? buf[i] : 0) << 24) |
        ((i + 1 < L ? buf[i + 1] : 0) << 16) |
        ((i + 2 < L ? buf[i + 2] : 0) << 8) |
        (i + 3 < L ? buf[i + 3] : 0)) >>>
      0;
    return ((w << (p & 7)) >>> 0) >>> (32 - n);
  }

  skip(n) {
    this.pos += n;
    if (this.pos > this.len) throw new Error('BitReader: read past end');
  }

  u1() {
    const p = this.pos;
    if (p >= this.len) throw new Error('BitReader: read past end');
    this.pos = p + 1;
    return (this.buf[p >> 3] >> (7 - (p & 7))) & 1;
  }

  u(n) {
    if (n === 0) return 0;
    if (n <= 24) {
      const v = this.peek(n);
      this.skip(n);
      return v;
    }
    const hi = this.u(n - 16);
    return hi * 65536 + this.u(16);
  }

  ue() {
    let lz = 0;
    while (this.u1() === 0) {
      lz++;
      if (lz > 31) throw new Error('BitReader: bad Exp-Golomb code');
    }
    return lz === 0 ? 0 : 2 ** lz - 1 + this.u(lz);
  }

  se() {
    const k = this.ue();
    return k & 1 ? (k + 1) / 2 : -(k / 2);
  }

  aligned() {
    return ((this.pos + this.alignBase) & 7) === 0;
  }

  // Skip to the next byte boundary. Returns the skipped bits (they must be zero).
  alignSkip() {
    const r = (8 - ((this.pos + this.alignBase) & 7)) & 7;
    return this.u(r);
  }
}

// Exp-Golomb code lengths (for rate estimates).
export function ueBits(v) {
  return 2 * (31 - Math.clz32(v + 1)) + 1;
}

export function seBits(v) {
  return ueBits(v > 0 ? 2 * v - 1 : -2 * v);
}

// RBSP -> EBSP: insert 0x03 after two 0x00 bytes when the next byte is <= 0x03 (7.4.1).
export function rbspToEbsp(rbsp) {
  const out = new Uint8Array(rbsp.length + (rbsp.length >> 1) + 4);
  let o = 0;
  let zeros = 0;
  for (let i = 0; i < rbsp.length; i++) {
    const b = rbsp[i];
    if (zeros >= 2 && b <= 3) {
      out[o++] = 3;
      zeros = 0;
    }
    out[o++] = b;
    zeros = b === 0 ? zeros + 1 : 0;
  }
  return out.slice(0, o);
}

// EBSP -> RBSP: remove each emulation_prevention_three_byte.
export function ebspToRbsp(ebsp) {
  const out = new Uint8Array(ebsp.length);
  let o = 0;
  let zeros = 0;
  for (let i = 0; i < ebsp.length; i++) {
    const b = ebsp[i];
    if (zeros >= 2 && b === 3) {
      zeros = 0;
      continue;
    }
    out[o++] = b;
    zeros = b === 0 ? zeros + 1 : 0;
  }
  return out.slice(0, o);
}
