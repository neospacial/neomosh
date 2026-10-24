// WebAssembly kernels (plan R-09, D21). The module is compiled from src/codec/wasm/kernels.c and is
// part of this file set (wasm-bytes.js): no network request. Each encoder and decoder has its own
// instance and memory. Its planes and buffers are views of that memory, so that the JavaScript code
// and the kernels share them without copies.
// Without WebAssembly SIMD (or with setWasmEnabled(false)), the codec uses the JavaScript functions.

import { KERNELS_WASM } from './wasm-bytes.js';

let compiled; // undefined: not tried. null: not available.
let enabled = true;

// For tests: false makes new encoders and decoders use the JavaScript functions.
export function setWasmEnabled(on) {
  enabled = on;
}

function wasmModule() {
  if (compiled !== undefined) return compiled;
  compiled = null;
  try {
    const bin = Uint8Array.from(atob(KERNELS_WASM), (c) => c.charCodeAt(0));
    if (typeof WebAssembly === 'object' && WebAssembly.validate(bin)) compiled = new WebAssembly.Module(bin);
  } catch {
    compiled = null; // for example a synchronous compile on a browser main thread
  }
  return compiled;
}

export class Kernels {
  // Returns null when the kernels are not available.
  static create() {
    const m = enabled ? wasmModule() : null;
    return m ? new Kernels(m) : null;
  }

  constructor(m) {
    // 32 pages: the stack (64 KB) and the static tables of the module (about 0.5 MB) fit.
    this.mem = new WebAssembly.Memory({ initial: 32 });
    this.x = new WebAssembly.Instance(m, { env: { memory: this.mem } }).exports;
    this.top = (this.x.__heap_base.value + 15) & ~15;
    this.sealed = false;
  }

  // Reserve n bytes (16-byte aligned). Only before seal(): growing the memory detaches the views.
  alloc(n) {
    if (this.sealed) throw new Error('Kernels: alloc after seal');
    const p = this.top;
    this.top = (p + n + 15) & ~15;
    const need = Math.ceil(this.top / 65536) - this.mem.buffer.byteLength / 65536;
    if (need > 0) this.mem.grow(need);
    return p;
  }

  seal() {
    this.sealed = true;
  }

  u8(p, n) {
    return new Uint8Array(this.mem.buffer, p, n);
  }

  i32(p, n) {
    return new Int32Array(this.mem.buffer, p, n);
  }

  // True when the typed array is a view of this memory (then byteOffset is its address).
  has(a) {
    return a.buffer === this.mem.buffer;
  }
}
