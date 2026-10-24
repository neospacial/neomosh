// Codec worker (R-06). One source, three roles: 'enc' (encoder), 'dec' (decoder), and 'cap' (capture).
// The capture worker reads the camera frames from a MediaStreamTrackProcessor, so the main thread is
// not in the frame path (R-14). It sends the RGBA pictures to the encoder through a MessagePort.
// The build bundles the codec modules before this file and starts the worker from a Blob URL (R-10).

import { Encoder } from '../codec/encoder.js';
import { Decoder } from '../codec/decoder.js';
import { coverCrop } from './geometry.js';
import { FrameGate } from './capture.js';

const MAX_IN_FLIGHT = 6; // R-18 (D19), the same as the main thread path

let enc = null;
let dec = null;
let canvas = null;
let ctx = null;
let img = null;
let w = 0, h = 0;

function initCanvas(width, height) {
  w = width;
  h = height;
  canvas = new OffscreenCanvas(w, h);
  ctx = canvas.getContext('2d', { willReadFrequently: true, alpha: false });
  img = null;
}

// The current decoder picture as an ImageBitmap (visible size). The RGBA conversion is in the
// kernels (D21); img is a view of the decoder memory, so there is no extra copy.
function decodedBitmap() {
  const rgba = dec.toRgba();
  if (!img || img.data.buffer !== rgba.buffer) img = new ImageData(new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.length), w, h);
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

// Upscale export (plan §9.3): the decoded frames, scaled, to the H.264 VideoEncoder of the browser.
let up = null;

// Capture worker state. port: to the encoder worker.
let cap = null;
// Encoder worker: the port from the capture worker.
let capPort = null;

function encodeRgba(m) {
  const t0 = performance.now();
  const [Y, U, V] = enc.inputFromRgba(m.rgba);
  const t1 = performance.now();
  const pkt = enc.encode(Y, U, V);
  const t2 = performance.now();
  self.postMessage({ cmd: 'packet', seq: m.seq, tsUs: m.tsUs, pkt, ms: t2 - t0, grabMs: t1 - t0, capMs: m.grabMs }, [pkt.bits.buffer]);
}

// One clip from the camera. m: { readable | track, fps, mirror, sessionEndUs, seq, vw, vh }.
async function captureClip(m, run) {
  const readable = m.readable || new MediaStreamTrackProcessor({ track: m.track }).readable;
  const reader = readable.getReader();
  cap.reader = reader;
  cap.track = m.track || null;
  const gate = new FrameGate(m.fps);
  let start = null, sent = 0, seq = m.seq, checked = false;
  try {
    for (;;) {
      const { value: frame, done } = await reader.read();
      if (done) break;
      if (run !== cap.run) {
        frame.close(); // stopped: close the queued frames until the stream ends
        continue;
      }
      const fw = frame.displayWidth, fh = frame.displayHeight;
      // The frames must have the same shape as the <video> (for example, not turned by 90 degrees).
      if (!checked) {
        checked = true;
        if (m.vw !== m.vh && (fw > fh) !== (m.vw > m.vh)) {
          frame.close();
          self.postMessage({ cmd: 'capMismatch', fw, fh });
          break;
        }
      }
      const t = frame.timestamp / 1000;
      if (!gate.next(t).keep) {
        frame.close();
        continue;
      }
      if (cap.inFlight >= MAX_IN_FLIGHT) {
        // R-18, R-19: an encoder drop. The previous frame becomes longer (R-20).
        frame.close();
        self.postMessage({ cmd: 'capDrop' });
        continue;
      }
      if (start === null) start = t;
      const tsUs = m.sessionEndUs + Math.round((t - start) * 1000);
      const t0 = performance.now();
      const c = coverCrop(fw, fh, w, h);
      ctx.setTransform(m.mirror ? -1 : 1, 0, 0, 1, m.mirror ? w : 0, 0);
      ctx.drawImage(frame, c.sx, c.sy, c.sw, c.sh, 0, 0, w, h);
      frame.close();
      const rgba = ctx.getImageData(0, 0, w, h).data;
      cap.inFlight++;
      sent++;
      cap.port.postMessage({ cmd: 'rgba', rgba, tsUs, seq: seq++, grabMs: performance.now() - t0 }, [rgba.buffer]);
    }
  } finally {
    if (cap.reader === reader) cap.reader = null;
    reader.cancel().catch(() => {});
    if (m.track) m.track.stop();
    self.postMessage({ cmd: 'capStopped', sent, seq });
  }
}

const handlers = {
  // { role, w, h, settings }
  init(m) {
    initCanvas(m.w, m.h);
    if (m.role === 'cap') {
      cap = { port: m.port, inFlight: 0, run: 0, reader: null };
      cap.port.onmessage = (e) => {
        if (e.data.cmd === 'ack') cap.inFlight--;
      };
      self.postMessage({ cmd: 'ready', mstp: typeof MediaStreamTrackProcessor === 'function' });
      return;
    }
    warmUp();
    if (m.role === 'enc') {
      enc = new Encoder(m.w, m.h, m.settings);
      if (m.port) {
        capPort = m.port;
        capPort.onmessage = (e) => {
          try {
            encodeRgba(e.data);
          } catch (err) {
            self.postMessage({ cmd: 'error', message: String(err && err.message ? err.message : err), during: 'rgba' });
          }
          capPort.postMessage({ cmd: 'ack' });
        };
      }
    } else {
      dec = new Decoder(m.w, m.h);
    }
    self.postMessage({ cmd: 'ready', wasm: !!(enc || dec).k });
  },

  // Encoder. R-16: draw the bitmap (mirrored when needed), read the pixels, convert to YUV 4:2:0.
  frame(m) {
    const t0 = performance.now();
    ctx.setTransform(m.mirror ? -1 : 1, 0, 0, 1, m.mirror ? w : 0, 0);
    ctx.drawImage(m.bitmap, 0, 0, w, h);
    m.bitmap.close();
    const [Y, U, V] = enc.inputFromRgba(ctx.getImageData(0, 0, w, h).data); // RGB to YUV in the kernels
    const t1 = performance.now();
    const pkt = enc.encode(Y, U, V);
    const t2 = performance.now();
    self.postMessage({ cmd: 'packet', seq: m.seq, tsUs: m.tsUs, pkt, ms: t2 - t0, grabMs: t1 - t0 }, [pkt.bits.buffer]);
  },
  // Capture worker: start and stop one clip.
  capStart(m) {
    const run = ++cap.run;
    captureClip(m, run).catch((err) => self.postMessage({ cmd: 'error', message: String(err && err.message ? err.message : err), during: 'capture' }));
  },
  // The track stops (here or on the main thread), so the stream ends after its queued frames.
  // If it does not end, cancel it.
  capStop() {
    cap.run++;
    if (cap.track) cap.track.stop();
    const reader = cap.reader;
    setTimeout(() => {
      if (reader && cap.reader === reader) reader.cancel().catch(() => {});
    }, 500);
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
  // Upscale export. { w, h, outW, outH, smooth, codec, bitrate, fps }
  upInit(m) {
    initCanvas(m.w, m.h);
    dec = new Decoder(m.w, m.h);
    const canvas2 = new OffscreenCanvas(m.outW, m.outH);
    const ctx2 = canvas2.getContext('2d', { alpha: false });
    ctx2.imageSmoothingEnabled = !!m.smooth; // Sharp = nearest neighbour
    if (m.smooth) ctx2.imageSmoothingQuality = 'high';
    const ve = new VideoEncoder({
      output: (chunk, meta) => {
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        const d = meta && meta.decoderConfig && meta.decoderConfig.description;
        const desc = d ? new Uint8Array(d instanceof ArrayBuffer ? d : d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength)) : null;
        self.postMessage({ cmd: 'upChunk', data, key: chunk.type === 'key', ts: chunk.timestamp, desc }, [data.buffer]);
      },
      error: (e) => self.postMessage({ cmd: 'error', message: String(e && e.message ? e.message : e), during: 'upscale' }),
    });
    ve.configure({ codec: m.codec, width: m.outW, height: m.outH, bitrate: m.bitrate, framerate: m.fps, avc: { format: 'avc' }, latencyMode: 'realtime' });
    up = { ve, canvas2, ctx2, outW: m.outW, outH: m.outH, lastKey: -Infinity, chain: Promise.resolve() };
    self.postMessage({ cmd: 'ready' });
  },
  // { pkt, show, tsUs }: decode; when the picture changed, scale and encode it (keyframe every 2 s).
  // The frames go through one chain, so that a frame does not start before the last one is done.
  upFrame(m) {
    return (up.chain = up.chain.then(() => upFrame(m)));
  },
  upFlush() {
    return (up.chain = up.chain.then(async () => {
      await up.ve.flush();
      up.ve.close();
      self.postMessage({ cmd: 'upDone' });
    }));
  },

  // Self-test (plan §13.3): decode a kept frame and return the picture, cropped, as I420 planes.
  yuv(m) {
    dec.decodePacket(m.pkt, true);
    const f = dec.getFrame();
    self.postMessage({ cmd: 'yuv', seq: m.seq, ...f }, [f.y.buffer, f.u.buffer, f.v.buffer]);
  },

  // R-08: set the reference picture.
  setRef(m) {
    dec.setRef(m.Y, m.U, m.V);
  },
};

async function upFrame(m) {
  if (dec.decodePacket(m.pkt, m.show)) {
    const bitmap = decodedBitmap();
    up.ctx2.drawImage(bitmap, 0, 0, up.outW, up.outH);
    bitmap.close();
    const vf = new VideoFrame(up.canvas2, { timestamp: m.tsUs });
    const key = m.tsUs - up.lastKey >= 2e6;
    if (key) up.lastKey = m.tsUs;
    up.ve.encode(vf, { keyFrame: key });
    vf.close();
    while (up.ve.encodeQueueSize > 2) await new Promise((r) => setTimeout(r, 2));
  }
  self.postMessage({ cmd: 'upAck' });
}

self.onmessage = (e) => {
  const m = e.data;
  const fail = (err) => self.postMessage({ cmd: 'error', message: String(err && err.message ? err.message : err), during: m.cmd });
  try {
    const r = handlers[m.cmd](m);
    if (r && r.catch) r.catch(fail);
  } catch (err) {
    fail(err);
  }
};
