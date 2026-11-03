// Codec worker (R-06). One source, three roles: 'enc' (encoder), 'dec' (decoder), and 'cap' (capture).
// The capture worker reads the camera frames from a MediaStreamTrackProcessor, so the main thread is
// not in the frame path (R-14). It sends the RGBA pictures to the encoder through a MessagePort.
// The build bundles the codec modules before this file and starts the worker from a Blob URL (R-10).

import { Encoder } from '../codec/encoder.js';
import { Decoder } from '../codec/decoder.js';
import { setKernelsModule } from '../codec/wasm.js';
import { coverCrop } from './geometry.js';
import { FrameGate, SourceGaps } from './capture.js';
import { CamYuv } from './camyuv.js';
import { demuxMp4, turnedCrop } from '../mux/demux.js';

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

// D31: the decoded picture as an I420 VideoFrame (visible size). The page draws it, and the GPU does the
// YUV to RGB conversion: no conversion in the kernels, no putImageData. The planes are next to each
// other in the decoder memory, so the frame is made from one view (VideoFrame copies it). Returns null
// when the browser cannot make it (then the bitmap way).
let frameOk = typeof VideoFrame === 'function';
function decodedFrame() {
  if (!frameOk) return null;
  try {
    const { Y, U, V } = dec;
    const cw = dec.codedW, n = Y.length, cn = U.length;
    let data;
    if (Y.buffer === V.buffer && U.byteOffset === Y.byteOffset + n && V.byteOffset === U.byteOffset + cn) {
      data = new Uint8Array(Y.buffer, Y.byteOffset, n + 2 * cn);
    } else {
      data = new Uint8Array(n + 2 * cn);
      data.set(Y);
      data.set(U, n);
      data.set(V, n + cn);
    }
    return new VideoFrame(data, {
      format: 'I420', codedWidth: cw, codedHeight: dec.codedH, timestamp: 0,
      visibleRect: { x: 0, y: 0, width: w, height: h },
      layout: [{ offset: 0, stride: cw }, { offset: n, stride: cw >> 1 }, { offset: n + cn, stride: cw >> 1 }],
      colorSpace: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: false },
    });
  } catch {
    frameOk = false;
    return null;
  }
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

// Bloom (D24): the source P packet of the bloom clip (while the button is held, paused).
let bloomSrc = null;

// A picture from the capture worker: RGBA, or the planes (coded size) of the 'yuv' way.
function encodeRgba(m) {
  const t0 = performance.now();
  const [Y, U, V] = m.Y ? [m.Y, m.U, m.V] : enc.inputFromRgba(m.rgba);
  const t1 = performance.now();
  const pkt = enc.encode(Y, U, V);
  const t2 = performance.now();
  self.postMessage({ cmd: 'packet', seq: m.seq, tsUs: m.tsUs, pkt, ms: t2 - t0, grabMs: t1 - t0, capMs: m.grabMs }, [pkt.bits.buffer]);
}

// Three ways to crop and scale a camera frame. 'yuv': copy the camera YUV and scale it in the kernels
// (no GPU, no canvas). 'bitmap': createImageBitmap with resize (the GPU on most phones), then read the
// small picture. 'draw': draw the full frame on the canvas. The fastest depends on the device and the
// browser, so the worker measures each one on the first frames and keeps the fastest.
const CAP_WARM = 5, CAP_TRIAL = 6; // short: a slow way can lose frames during its trial
function capCandidates() {
  const list = [];
  if (cap.yuv && cap.yuvOk !== false && cap.usable) list.push('yuv');
  list.push('bitmap', 'draw');
  return list;
}
function capMethod() {
  if (cap.method) return cap.method;
  const list = capCandidates();
  if (cap.warm < CAP_WARM) return list[0];
  return list.find((m) => (cap.trial[m] || []).length < CAP_TRIAL) || list[list.length - 1];
}
function capTimed(method, ms) {
  if (cap.method) return;
  if (cap.warm < CAP_WARM) {
    cap.warm++;
    return;
  }
  (cap.trial[method] = cap.trial[method] || []).push(ms);
  const list = capCandidates();
  if (list.every((m) => (cap.trial[m] || []).length >= CAP_TRIAL)) {
    const med = (a) => a.slice().sort((x, y) => x - y)[a.length >> 1];
    const times = {};
    for (const m of list) times[m] = med(cap.trial[m]);
    cap.method = list.reduce((a, b) => (times[b] < times[a] ? b : a));
    self.postMessage({ cmd: 'capMethod', method: cap.method, times, calib: cap.calib });
  }
}

// One picture by the canvas ways ('bitmap' or 'draw'). Returns the RGBA pixels (visible size).
async function canvasPicture(frame, c, mirror, method) {
  ctx.setTransform(mirror ? -1 : 1, 0, 0, 1, mirror ? w : 0, 0);
  let bitmap = null;
  if (method === 'bitmap') {
    try {
      bitmap = await createImageBitmap(frame, c.sx, c.sy, c.sw, c.sh, { resizeWidth: w, resizeHeight: h, resizeQuality: 'medium' });
    } catch {
      cap.method = 'draw'; // not supported: draw the frame
    }
  }
  if (bitmap) {
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
  } else ctx.drawImage(frame, c.sx, c.sy, c.sw, c.sh, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h).data;
}

/* File source without real time (D25). The capture worker reads the MP4/MOV file, decodes every frame
   with a VideoDecoder, and sends each frame of the target rate to the encoder. When the encoder is
   busy, it waits: no frame is dropped. The frame times come from the file (media time), so the export
   has the speed of the file, at any decode speed. */
let fileDemux = null; // { key, d } for the last file

async function fileInfo(file) {
  const key = `${file.name}|${file.size}|${file.lastModified}`;
  if (fileDemux && fileDemux.key === key) return fileDemux.d;
  const d = await demuxMp4(file);
  let ok = false;
  if (d && typeof VideoDecoder === 'function') {
    try {
      ok = (await VideoDecoder.isConfigSupported(decoderConfig(d))).supported;
    } catch {
      ok = false;
    }
  }
  fileDemux = { key, d: ok ? d : null };
  return fileDemux.d;
}

const decoderConfig = (d) => ({ codec: d.codec, codedWidth: d.codedWidth, codedHeight: d.codedHeight, ...(d.description ? { description: d.description } : {}) });

// m: { file, startUs (file time), fps, sessionEndUs, seq }. Posts 'capStopped' with ended and the
// file time of the last frame (lastUs), or 'capFileFail' (then the page path plays the file).
async function fileClip(m, run) {
  const d = await fileInfo(m.file);
  if (!d) {
    self.postMessage({ cmd: 'capFileFail' });
    return;
  }
  const S = d.samples;
  const period = 1e6 / m.fps;
  // Start at the last sync sample at or before the start time (decode order).
  let first = 0;
  for (let i = 0; i < S.length; i++) if (S[i].key && S[i].us <= m.startUs + 1000) first = i;
  const out = [];
  let failure = null, wake = null;
  const poke = () => { if (wake) { const f = wake; wake = null; f(); } };
  const wait = () => new Promise((r) => (wake = r));
  cap.onAck = poke;
  const dec = new VideoDecoder({ output: (f) => { out.push(f); poke(); }, error: (e) => { failure = e; poke(); } });
  dec.configure(decoderConfig(d));
  const gate = new FrameGate(m.fps);
  let next = first, flushed = false, start = null, sent = 0, seq = m.seq, lastUs = m.startUs, ended = false, lastPost = 0;
  // Read the samples in runs of up to 4 MB that are next to each other in the file.
  let buf = null, bufFrom = 0, bufTo = 0;
  const readAt = async (s) => {
    if (!buf || s.offset < bufFrom || s.offset + s.size > bufTo) {
      let to = s.offset + s.size;
      for (let j = next + 1; j < S.length && S[j].offset === to && to - s.offset < 4194304; j++) to += S[j].size;
      buf = new Uint8Array(await m.file.slice(s.offset, to).arrayBuffer());
      [bufFrom, bufTo] = [s.offset, to];
    }
    return buf.subarray(s.offset - bufFrom, s.offset - bufFrom + s.size);
  };
  try {
    for (;;) {
      if (run !== cap.run) break;
      if (failure) throw failure;
      // Feed the decoder: a few frames ahead, no more.
      while (next < S.length && dec.decodeQueueSize < 4 && out.length < 4) {
        const s = S[next];
        dec.decode(new EncodedVideoChunk({ type: s.key ? 'key' : 'delta', timestamp: s.us, data: await readAt(s) }));
        next++;
      }
      if (next >= S.length && !flushed) {
        flushed = true;
        await dec.flush();
      }
      if (!out.length) {
        if (flushed) {
          ended = true;
          break;
        }
        await wait();
        continue;
      }
      const frame = out.shift();
      const us = frame.timestamp;
      // Before the start (from the sync sample), or not on the target rate: not used.
      if (us < m.startUs - period / 2 || !gate.next(us / 1000).keep) {
        frame.close();
        continue;
      }
      // No drop: wait for the encoder.
      while (cap.inFlight >= MAX_IN_FLIGHT && run === cap.run && !failure) await wait();
      if (run !== cap.run) {
        frame.close();
        break;
      }
      const t0 = performance.now();
      if (start === null) start = us;
      // The crop in display coordinates (the file turned as a player shows it), then the frame area.
      const fw = frame.displayWidth, fh = frame.displayHeight;
      const turned = d.rotation % 180 !== 0;
      const c = coverCrop(turned ? fh : fw, turned ? fw : fh, w, h);
      const t = turnedCrop(d.rotation, fw, fh, c, w, h);
      ctx.setTransform(...t.m);
      ctx.drawImage(frame, t.sx, t.sy, t.sw, t.sh, 0, 0, t.dw, t.dh);
      frame.close();
      const rgba = ctx.getImageData(0, 0, w, h).data;
      cap.inFlight++;
      sent++;
      lastUs = us;
      const ms = performance.now() - t0;
      cap.port.postMessage({ cmd: 'rgba', rgba, tsUs: m.sessionEndUs + (us - start), seq: seq++, grabMs: ms }, [rgba.buffer]);
      if (performance.now() - lastPost > 200) {
        lastPost = performance.now();
        self.postMessage({ cmd: 'fileTime', us, durationUs: d.durationUs });
      }
    }
  } catch (err) {
    self.postMessage({ cmd: 'error', message: String(err && err.message ? err.message : err), during: 'file' });
  } finally {
    for (const f of out) f.close();
    try {
      dec.close();
    } catch { /* closed */ }
    cap.onAck = null;
    self.postMessage({ cmd: 'capStopped', sent, seq, file: true, ended, lastUs });
  }
}

// After a stop: cancel the stream when no frame came for 300 ms. Then no frame is in its queue
// (a cancel drops the queued frames without close()).
function armQuietCancel(reader) {
  clearTimeout(cap.quietTimer);
  cap.quietTimer = setTimeout(() => {
    if (cap.reader === reader) reader.cancel().catch(() => {});
  }, 300);
}

// One clip from the camera. m: { readable | track, fps, mirror, sessionEndUs, seq, vw, vh }.
async function captureClip(m, run) {
  // A short buffer absorbs short delays of this worker (the camera keeps its pool of frames).
  const readable = m.readable || new MediaStreamTrackProcessor({ track: m.track, maxBufferSize: 4 }).readable;
  const reader = readable.getReader();
  cap.reader = reader;
  cap.track = m.track || null;
  const gate = new FrameGate(m.fps);
  const gaps = cap.gaps || (cap.gaps = new SourceGaps());
  gaps.restart();
  let start = null, sent = 0, seq = m.seq, checked = false;
  let frame = null; // the current frame; closed in 'finally' when an error stops the loop (close() twice is no error)
  try {
    for (;;) {
      const tr = performance.now();
      const r = await reader.read();
      const waited = performance.now() - tr;
      if (r.done) break;
      frame = r.value;
      if (run !== cap.run) {
        frame.close(); // stopped: close the queued frames until the stream ends
        armQuietCancel(reader);
        continue;
      }
      const fw = frame.displayWidth, fh = frame.displayHeight;
      // The frames must have the same shape as the <video> (for example, not turned by 90 degrees).
      if (!checked) {
        checked = true;
        if (m.vw !== m.vh && (fw > fh) !== (m.vw > m.vh)) {
          frame.close();
          self.postMessage({ cmd: 'capMismatch', fw, fh, cw: frame.codedWidth, ch: frame.codedHeight, rotation: frame.rotation ?? '-' });
          break;
        }
      }
      // Probe (before the recording): only measure the ways, then stop. No gate, no encoder. At the end
      // the page stops the track; the frames still in the stream are closed above until it ends (a
      // cancel would drop them without close()).
      if (cap.probe && (cap.method || ++cap.probeFrames > 80)) {
        cap.run++;
        frame.close();
        if (!cap.method) self.postMessage({ cmd: 'probeEnd' });
        if (cap.track) cap.track.stop(); // Safari: the track is in this worker
        armQuietCancel(reader);
        continue;
      }
      const t = frame.timestamp / 1000;
      // A gap in the source times: when this worker waited for the frame, the camera did not give the
      // missing frames (R-19: not a drop). When the frame was ready at once, the processor dropped
      // frames because this worker was late: a drop.
      const missed = gaps.next(t);
      const late = missed > 0 && waited < 3;
      if (missed > 0 && !late) self.postMessage({ cmd: 'capSkip', n: missed });
      const g = gate.next(t, late ? missed : 0);
      if (g.lost) self.postMessage({ cmd: 'capDrop', n: g.lost, kind: 'cap' });
      if (!g.keep && !cap.probe) {
        frame.close();
        continue;
      }
      if (!cap.probe && cap.inFlight >= MAX_IN_FLIGHT) {
        // R-18, R-19: an encoder drop. The previous frame becomes longer (R-20).
        frame.close();
        self.postMessage({ cmd: 'capDrop', n: 1, kind: 'enc' });
        continue;
      }
      if (start === null) start = t;
      const tsUs = m.sessionEndUs + Math.round((t - start) * 1000);
      const t0 = performance.now();
      const c = coverCrop(fw, fh, w, h);
      cap.usable = CamYuv.usable(frame);
      let method = capMethod();
      if (method === 'yuv' && !(cap.yuv && cap.usable)) method = 'draw';
      let msg, calibrated = false;
      if (method === 'yuv') {
        let planes = null;
        try {
          planes = await cap.yuv.convert(frame, c, m.mirror);
        } catch {
          cap.yuvOk = false; // copyTo or the format failed: use the canvas ways
        }
        // The same frame by the canvas, to check the colour matrix and the range. A frame with too
        // few unclipped areas gives no answer: try again on the next frames (10 times at most).
        if (planes && cap.yuvOk === undefined) {
          const rgba = await canvasPicture(frame, c, m.mirror, 'draw');
          const d = cap.yuv.calibrate(rgba, planes);
          const cs = frame.colorSpace;
          const csText = `${frame.format} ${cs ? `${cs.matrix} ${cs.fullRange === null ? '' : cs.fullRange ? 'full' : 'limited'}` : ''}`;
          calibrated = true;
          if (d) {
            cap.calib = `Y ${d.y.toFixed(1)}, U ${d.u.toFixed(1)}, V ${d.v.toFixed(1)}; ${csText}`;
            cap.yuvOk = d.y < 3 && d.u < 3 && d.v < 3;
          } else if (++cap.calibTries >= 10) {
            // No answer: trust the colour space only when the browser gives it in full.
            cap.yuvOk = !!(cs && cs.matrix && cs.fullRange !== null && cs.fullRange !== undefined);
            cap.calib = `no clear frame; ${csText}`;
          }
          if (cap.yuvOk !== true) planes = null;
        }
        if (planes) msg = { cmd: 'planes', Y: planes[0], U: planes[1], V: planes[2] };
      }
      if (!msg) msg = { cmd: 'rgba', rgba: await canvasPicture(frame, c, m.mirror, method === 'yuv' ? 'draw' : method) };
      frame.close();
      const ms = performance.now() - t0;
      if (!calibrated && (method !== 'yuv' || msg.cmd === 'planes')) capTimed(method, ms);
      if (cap.probe) continue;
      cap.inFlight++;
      sent++;
      Object.assign(msg, { tsUs, seq: seq++, grabMs: ms });
      cap.port.postMessage(msg, msg.rgba ? [msg.rgba.buffer] : [msg.Y.buffer]);
    }
  } finally {
    if (frame) frame.close();
    clearTimeout(cap.quietTimer);
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
      cap = { port: m.port || null, probe: !!m.probe, inFlight: 0, run: 0, reader: null, method: null, warm: 0, trial: {}, yuv: CamYuv.create(m.w, m.h), yuvOk: undefined, calib: '', calibTries: 0, probeFrames: 0 };
      // A way from a probe before the recording (saved), or forced (debug). 'yuv' still needs a usable
      // frame; its colour check was done by the probe.
      if (['yuv', 'bitmap', 'draw'].includes(m.method)) {
        cap.method = m.method;
        if (m.method === 'yuv') cap.yuvOk = true;
      }
      if (cap.port) {
        cap.port.onmessage = (e) => {
          if (e.data.cmd === 'ack') {
            cap.inFlight--;
            if (cap.onAck) cap.onAck();
          }
        };
      }
      self.postMessage({ cmd: 'ready', mstp: typeof MediaStreamTrackProcessor === 'function', vd: typeof VideoDecoder === 'function' });
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
  capFileStart(m) {
    const run = ++cap.run;
    fileClip(m, run).catch((err) => self.postMessage({ cmd: 'error', message: String(err && err.message ? err.message : err), during: 'file' }));
  },
  capStart(m) {
    const run = ++cap.run;
    captureClip(m, run).catch((err) => self.postMessage({ cmd: 'error', message: String(err && err.message ? err.message : err), during: 'capture' }));
  },
  // The track stops (here or on the main thread), so the stream ends after its queued frames.
  // If it does not end, cancel it.
  // A way measured before the recording (probe): use it from the next frame.
  capSet(m) {
    if (!['yuv', 'bitmap', 'draw'].includes(m.method)) return;
    cap.method = m.method;
    if (m.method === 'yuv') cap.yuvOk = true;
  },
  capStop() {
    cap.run++;
    if (cap.onAck) cap.onAck(); // a file clip that waits for the encoder: it ends now
    if (cap.track) cap.track.stop();
    if (cap.reader) armQuietCancel(cap.reader);
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
  // Bloom clip (D24): the source packet, then one copy for each frame time, then stop.
  bloomStart(m) {
    bloomSrc = m.src;
  },
  bloomFrame(m) {
    const t0 = performance.now();
    const pkt = enc.repeat(bloomSrc);
    self.postMessage({ cmd: 'packet', seq: m.seq, tsUs: m.tsUs, pkt, ms: performance.now() - t0, grabMs: 0 }, [pkt.bits.buffer]);
  },
  bloomStop() {
    bloomSrc = null;
  },
  settings(m) {
    enc.setSettings(m.settings);
  },

  // Decoder. preview: make a picture for the viewfinder (R-21: the main thread skips it when late).
  // gpu (D31): the live view takes a VideoFrame (the GPU converts the colour); the others an exact bitmap.
  packet(m) {
    const t0 = performance.now();
    const changed = dec.decodePacket(m.pkt, !!m.show);
    let bitmap = null;
    if (changed && m.preview) {
      const vf = m.gpu ? decodedFrame() : null;
      if (vf) {
        try {
          self.postMessage({ cmd: 'decoded', seq: m.seq, bitmap: vf, ms: performance.now() - t0 }, [vf]);
          return;
        } catch {
          vf.close();
          frameOk = false; // a VideoFrame cannot go to the page here: bitmaps from now on
        }
      }
      bitmap = decodedBitmap();
    }
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

// D30: the messages wait for the compiled module from the page (the first message, 'kernels').
let kernelsSet = false;
const waiting = [];

self.onmessage = (e) => {
  if (e.data.cmd === 'kernels') {
    setKernelsModule(e.data.module);
    kernelsSet = true;
    for (const m of waiting.splice(0)) run(m);
    return;
  }
  if (!kernelsSet) waiting.push(e.data);
  else run(e.data);
};

function run(m) {
  const fail = (err) => self.postMessage({ cmd: 'error', message: String(err && err.message ? err.message : err), during: m.cmd });
  try {
    const r = handlers[m.cmd](m);
    if (r && r.catch) r.catch(fail);
  } catch (err) {
    fail(err);
  }
}
