// Upscale export (plan §9.3). Decode the kept frames with our decoder in a worker, scale them,
// and encode them with the H.264 VideoEncoder of the browser. Then mux with our MP4 muxer.

import { frameSelector } from '../codec/headers.js';
import { muxMp4 } from '../mux/mp4.js';
import { VIDEO_TIMESCALE, CutRetime } from '../mux/remux.js';
import { makeWorker } from './recorder.js';

// High profile first (levels 5.1, 5.0, 4.2, 4.0), then Main and Baseline.
const CODECS = ['avc1.640033', 'avc1.640032', 'avc1.64002A', 'avc1.640028', 'avc1.4D4033', 'avc1.42E033'];
const SHORT_SIDE = 1080;
const BITRATE_1080P = 18e6; // about 16-20 Mbit/s at 1080p (plan §9.3)

// The output size: 1080 on the short side, the same shape, even numbers.
export function upscaleSize(w, h) {
  const s = SHORT_SIDE / Math.min(w, h);
  return { outW: Math.round((w * s) / 2) * 2, outH: Math.round((h * s) / 2) * 2 };
}

// The first supported encoder configuration, or null (then there is no Upscale mode).
export async function upscaleConfig(w, h, fps) {
  if (typeof VideoEncoder === 'undefined' || typeof OffscreenCanvas === 'undefined') return null;
  if (Math.min(w, h) >= SHORT_SIDE) return null; // a 1080 session is already at the Upscale size
  const { outW, outH } = upscaleSize(w, h);
  const bitrate = Math.round((BITRATE_1080P * outW * outH) / (1920 * 1080));
  for (const codec of CODECS) {
    try {
      const r = await VideoEncoder.isConfigSupported({ codec, width: outW, height: outH, bitrate, framerate: fps, avc: { format: 'avc' } });
      if (r.supported) return { codec, outW, outH, bitrate, fps };
    } catch { /* try the next one */ }
  }
  return null;
}

// frames: an (async) iterable of the session frames. opts: { cuts, smooth, signal, onProgress(framesRead) }.
// Returns { parts, size } (see muxMp4).
export async function upscaleExport(workerSrc, params, config, frames, opts = {}) {
  const wk = makeWorker(workerSrc);
  const chunks = [];
  let avcc = null;
  let acks = 0;
  let done = false;
  let failure = null;
  let wake = null;
  const poke = () => { if (wake) { const f = wake; wake = null; f(); } };
  const wait = () => new Promise((r) => (wake = r));
  wk.onmessage = (e) => {
    const m = e.data;
    if (m.cmd === 'upChunk') {
      if (m.desc && !avcc) avcc = m.desc;
      chunks.push(m);
    } else if (m.cmd === 'upAck') acks++;
    else if (m.cmd === 'upDone') done = true;
    else if (m.cmd === 'error') failure = new Error(m.message);
    poke();
  };
  wk.onerror = (e) => { failure = new Error(e.message || 'Worker error'); poke(); };
  const check = () => {
    if (failure) throw failure;
    if (opts.signal && opts.signal.aborted) throw new Error('Export cancelled');
  };
  try {
    wk.postMessage({ cmd: 'upInit', w: params.w, h: params.h, smooth: !!opts.smooth, ...config });
    const select = frameSelector(opts.cuts ?? 'mosh');
    const retime = new CutRetime(); // the same times as Original mode
    let sent = 0, read = 0, t0 = null;
    for await (const f of frames) {
      check();
      read++;
      if (!select(f)) retime.skip(f);
      else {
        const ts = retime.time(f);
        if (t0 === null) t0 = ts;
        wk.postMessage({ cmd: 'upFrame', pkt: f, show: true, tsUs: ts - t0 });
        sent++;
        while (sent - acks > 4) { await wait(); check(); }
      }
      if (opts.onProgress) opts.onProgress(read);
    }
    while (acks < sent) { await wait(); check(); }
    wk.postMessage({ cmd: 'upFlush' });
    while (!done) { await wait(); check(); }
  } finally {
    wk.terminate();
  }
  if (!chunks.length || !avcc) throw new Error('The encoder gave no output');

  const { samples, mediaTime } = upscaleSamples(chunks, Math.round(VIDEO_TIMESCALE / params.fps));
  return muxMp4({ width: config.outW, height: config.outH, timescale: VIDEO_TIMESCALE, avcc, samples, mediaTime });
}

// The MP4 samples of the encoder chunks (decode order). Times from rounded absolute times, as in
// Original mode (plan §9.2 step 4). An encoder with B-frames (for example on desktop computers) gives
// the chunks out of display order: then the decode times are the display times in order, and each
// sample gets a composition offset (display - decode, made >= 0 by the delay mediaTime).
// lastDuration: the display time of the last picture.
export function upscaleSamples(chunks, lastDuration) {
  const pts = chunks.map((c) => Math.round((c.ts * 9) / 100));
  const sorted = pts.slice().sort((a, b) => a - b);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] === sorted[i - 1]) throw new Error('The encoder gave two pictures with the same time');
  }
  let mediaTime = 0;
  for (let i = 0; i < pts.length; i++) mediaTime = Math.max(mediaTime, sorted[i] - pts[i]);
  const samples = chunks.map((c, i) => ({
    data: c.data, size: c.data.length, key: c.key,
    duration: i + 1 < sorted.length ? sorted[i + 1] - sorted[i] : lastDuration,
    cto: pts[i] - sorted[i] + mediaTime,
  }));
  return { samples, mediaTime };
}
