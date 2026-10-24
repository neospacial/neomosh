// The main page does not encode or decode (the workers do), so it does not carry the module.
// The build uses this file in place of wasm-bytes.js for the main page.
export const KERNELS_WASM = '';
