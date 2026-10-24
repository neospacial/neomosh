// In-browser self-test (plan §13.3, hidden debug setting). Export the session (Original mode, all
// Mosh), decode it with the VideoDecoder of the browser, and compare each frame with our decoder.
// Result: { ok, frames, message }. ok: all frames identical.

import { spsNal, ppsNal } from '../codec/headers.js';
import { avcC } from '../mux/mp4.js';
import { Remuxer } from '../mux/remux.js';
import { makeWorker } from './recorder.js';

const hex = (b) => b.toString(16).padStart(2, '0');

// The planes of a decoded VideoFrame, cropped to w x h, as I420 (I420 and NV12 are accepted).
async function framePlanes(frame, w, h) {
  const fmt = frame.format;
  if (fmt !== 'I420' && fmt !== 'NV12') throw new Error(`The browser frame format is ${fmt || 'not readable'}`);
  const rect = { x: frame.visibleRect.x, y: frame.visibleRect.y, width: w, height: h };
  const buf = new Uint8Array(frame.allocationSize({ rect }));
  const layout = await frame.copyTo(buf, { rect });
  const y = new Uint8Array(w * h), u = new Uint8Array((w * h) >> 2), v = new Uint8Array((w * h) >> 2);
  const cw = w >> 1, ch = h >> 1;
  for (let r = 0; r < h; r++) y.set(buf.subarray(layout[0].offset + r * layout[0].stride, layout[0].offset + r * layout[0].stride + w), r * w);
  for (let r = 0; r < ch; r++) {
    if (fmt === 'I420') {
      u.set(buf.subarray(layout[1].offset + r * layout[1].stride, layout[1].offset + r * layout[1].stride + cw), r * cw);
      v.set(buf.subarray(layout[2].offset + r * layout[2].stride, layout[2].offset + r * layout[2].stride + cw), r * cw);
    } else {
      const o = layout[1].offset + r * layout[1].stride;
      for (let c = 0; c < cw; c++) {
        u[r * cw + c] = buf[o + 2 * c];
        v[r * cw + c] = buf[o + 2 * c + 1];
      }
    }
  }
  return { y, u, v };
}

function firstDiff(a, b) {
  for (const k of ['y', 'u', 'v']) {
    for (let i = 0; i < a[k].length; i++) if (a[k][i] !== b[k][i]) return { plane: k, i, ours: a[k][i], theirs: b[k][i] };
  }
  return null;
}

// frames: an (async) iterable of the session frames. onProgress(n): frames compared.
export async function selfTest(workerSrc, params, frames, onProgress) {
  if (typeof VideoDecoder === 'undefined') return { ok: false, frames: 0, message: 'This browser has no WebCodecs VideoDecoder, so the self-test cannot run. Use Chrome (Android) or Safari (iOS 16.4 or later).' };
  const { w, h } = params;
  const sps = spsNal(params), pps = ppsNal();
  const config = {
    codec: `avc1.${hex(sps[1])}${hex(sps[2])}${hex(sps[3])}`,
    codedWidth: w, codedHeight: h,
    description: avcC(sps, pps).subarray(8),
    hardwareAcceleration: 'no-preference',
  };
  const support = await VideoDecoder.isConfigSupported(config);
  if (!support.supported) return { ok: false, frames: 0, message: `The browser cannot decode ${config.codec}.` };

  const wk = makeWorker(workerSrc);
  const ours = new Map(); // index -> our picture
  let theirs = []; // browser frames not yet compared
  let compared = 0, failure = null, result = null, wake = null;
  const poke = () => { if (wake) { const f = wake; wake = null; f(); } };
  const wait = () => new Promise((r) => (wake = r));
  wk.onmessage = (e) => {
    const m = e.data;
    if (m.cmd === 'yuv') ours.set(m.seq, m);
    else if (m.cmd === 'error') failure = new Error('Our decoder: ' + m.message);
    poke();
  };
  const vd = new VideoDecoder({
    output: (frame) => {
      const p = framePlanes(frame, w, h);
      p.finally(() => frame.close()).catch(() => {});
      theirs.push(p);
      poke();
    },
    error: (e) => { failure = new Error('VideoDecoder: ' + (e && e.message)); poke(); },
  });
  // Compare the frames that both decoders have given.
  const compare = async () => {
    while (!result && theirs.length && ours.has(compared)) {
      const b = await theirs.shift();
      const a = ours.get(compared);
      ours.delete(compared);
      const d = firstDiff(a, b);
      if (d) {
        const plane = d.plane === 'y' ? w : w >> 1;
        result = { ok: false, frames: compared, message: `Frame ${compared} differs: plane ${d.plane.toUpperCase()}, x ${d.i % plane}, y ${Math.floor(d.i / plane)} (neomosh ${d.ours}, browser ${d.theirs}).` };
      }
      compared++;
      if (onProgress) onProgress(compared);
    }
  };
  try {
    wk.postMessage({ cmd: 'init', role: 'dec', w, h });
    vd.configure(config);
    const rx = new Remuxer(params, { cuts: 'mosh' });
    let n = 0;
    for await (const f of frames) {
      if (!rx.add(f)) continue;
      const s = rx.last;
      wk.postMessage({ cmd: 'yuv', seq: n, pkt: f });
      vd.decode(new EncodedVideoChunk({ type: s.key ? 'key' : 'delta', timestamp: Math.round((s.t * 100) / 9), data: s.data }));
      n++;
      s.data = null; // the self-test does not keep the file
      await compare();
      while (!result && !failure && (n - compared > 8 || vd.decodeQueueSize > 4)) {
        await wait();
        await compare();
      }
      if (failure) throw failure;
      if (result) return result;
    }
    await vd.flush();
    for (;;) {
      await compare();
      if (result || failure || compared >= n) break;
      if (!theirs.length && compared + ours.size >= n) break; // the browser gave fewer frames
      await wait();
    }
    if (failure) throw failure;
    if (result) return result;
    if (compared !== n) return { ok: false, frames: compared, message: `The browser gave ${compared} of ${n} frames.` };
    return { ok: true, frames: n, message: `Identical: ${n} frames.` };
  } catch (e) {
    return { ok: false, frames: compared, message: String(e && e.message ? e.message : e) };
  } finally {
    wk.terminate();
    try { vd.close(); } catch { /* closed */ }
  }
}
