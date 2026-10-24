// Codec worker (R-06). One source, two roles: 'enc' (encoder) or 'dec' (decoder).
// The build bundles the codec modules before this file and starts the worker from a Blob URL (R-10).

import { Encoder } from '../codec/encoder.js';
import { Decoder } from '../codec/decoder.js';
import { rgbaToYuv420, yuv420ToRgba } from '../codec/color.js';

let enc = null;
let dec = null;
let canvas = null;
let ctx = null;
let img = null;
let w = 0, h = 0;
let Y, U, V;

function initCanvas(width, height) {
  w = width;
  h = height;
  canvas = new OffscreenCanvas(w, h);
  ctx = canvas.getContext('2d', { willReadFrequently: true, alpha: false });
  img = new ImageData(w, h);
}

// The current decoder picture as an ImageBitmap (visible size).
function decodedBitmap() {
  yuv420ToRgba(dec.Y, dec.U, dec.V, dec.codedW, w, h, img.data);
  ctx.putImageData(img, 0, 0);
  return canvas.transferToImageBitmap();
}

// Compile the hot code paths before the first real frame, so that the first frames are not dropped.
function warmUp() {
  const e = new Encoder(64, 48, { qp: 28, searchRange: 16, precision: 'quarter', skipBias: 50, heal: 'off' });
  const d = new Decoder(64, 48);
  const y = new Uint8Array(64 * 48), u = new Uint8Array(16 * 24 * 2), v = new Uint8Array(16 * 24 * 2);
  for (let t = 0; t < 12; t++) {
    for (let i = 0; i < y.length; i++) y[i] = ((i * 7 + t * 13) ^ (i >> 5)) & 255;
    u.fill(100 + t);
    v.fill(140 - t);
    d.decodePacket(e.encode(y, u, v));
  }
}

const handlers = {
  // { role, w, h, settings }
  init(m) {
    initCanvas(m.w, m.h);
    warmUp();
    if (m.role === 'enc') {
      enc = new Encoder(m.w, m.h, m.settings);
      Y = new Uint8Array(enc.codedW * enc.codedH);
      U = new Uint8Array(Y.length >> 2);
      V = new Uint8Array(Y.length >> 2);
    } else {
      dec = new Decoder(m.w, m.h);
    }
    self.postMessage({ cmd: 'ready' });
  },

  // Encoder. R-16: draw the bitmap (mirrored when needed), read the pixels, convert to YUV 4:2:0.
  frame(m) {
    const t0 = performance.now();
    ctx.setTransform(m.mirror ? -1 : 1, 0, 0, 1, m.mirror ? w : 0, 0);
    ctx.drawImage(m.bitmap, 0, 0, w, h);
    m.bitmap.close();
    const rgba = ctx.getImageData(0, 0, w, h).data;
    rgbaToYuv420(rgba, w, h, enc.codedW, enc.codedH, Y, U, V);
    const t1 = performance.now();
    const pkt = enc.encode(Y, U, V);
    const t2 = performance.now();
    self.postMessage({ cmd: 'packet', seq: m.seq, tsUs: m.tsUs, pkt, ms: t2 - t0, grabMs: t1 - t0 }, [pkt.bits.buffer]);
  },
  newClip() {
    enc.newClip();
  },
  restart() {
    enc.restart();
  },
  continueSession() {
    enc.continueSession();
  },
  settings(m) {
    enc.setSettings(m.settings);
  },

  // Decoder. preview: make a bitmap for the viewfinder (R-21: the main thread skips it when late).
  packet(m) {
    const t0 = performance.now();
    const changed = dec.decodePacket(m.pkt, !!m.show);
    const bitmap = changed && m.preview ? decodedBitmap() : null;
    self.postMessage({ cmd: 'decoded', seq: m.seq, bitmap, ms: performance.now() - t0 }, bitmap ? [bitmap] : []);
  },
  // The reference picture (plan §8.4 step 4) and a bitmap of it.
  snapshot(m) {
    const s = dec.snapshot();
    const bitmap = dec.hasRef ? decodedBitmap() : null;
    self.postMessage({ cmd: 'snapshot', id: m.id, ...s, bitmap }, [s.Y.buffer, s.U.buffer, s.V.buffer, ...(bitmap ? [bitmap] : [])]);
  },
  // R-08: set the reference picture.
  setRef(m) {
    dec.setRef(m.Y, m.U, m.V);
  },
};

self.onmessage = (e) => {
  const m = e.data;
  try {
    handlers[m.cmd](m);
  } catch (err) {
    self.postMessage({ cmd: 'error', message: String(err && err.message ? err.message : err), during: m.cmd });
  }
};
