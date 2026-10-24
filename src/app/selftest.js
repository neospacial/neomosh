// In-browser self-test (plan §13.3, hidden debug setting). Export the session (Original mode, all
// Mosh), decode it with the VideoDecoder of the browser, and compare each frame with our decoder.
// Result: { ok, frames, message }. ok: all frames identical.

import { spsNal, ppsNal } from '../codec/headers.js';
import { avcC } from '../mux/mp4.js';
import { Remuxer } from '../mux/remux.js';
import { makeWorker } from './recorder.js';

const hex = (b) => b.toString(16).padStart(2, '0');

const RGB_FORMATS = ['RGBA', 'RGBX', 'BGRA', 'BGRX'];

// The planes of a decoded VideoFrame, cropped to w x h, as I420 (I420 and NV12 are accepted).
// An RGB frame (some hardware decoders) gives only the luma: { y, clip, rgb: true }. clip[i] = 1:
// a channel is at 0 or 255, so the luma of that pixel is lost (saturated colours). The stream signals
// BT.709 limited range (VUI), so Y' = 16 + 219 * (0.2126 R + 0.7152 G + 0.0722 B) / 255. The luma
// does not depend on how the browser scales the chroma up, so it can be compared closely.
async function framePlanes(frame, w, h) {
  const fmt = frame.format;
  if (RGB_FORMATS.includes(fmt)) {
    const rect = { x: frame.visibleRect.x, y: frame.visibleRect.y, width: w, height: h };
    const buf = new Uint8Array(frame.allocationSize({ rect }));
    const layout = await frame.copyTo(buf, { rect });
    const [ri, bi] = fmt[0] === 'R' ? [0, 2] : [2, 0];
    const y = new Uint8Array(w * h), clip = new Uint8Array(w * h);
    for (let r = 0; r < h; r++) {
      const o = layout[0].offset + r * layout[0].stride;
      for (let c = 0; c < w; c++) {
        const p = o + 4 * c;
        const R = buf[p + ri], G = buf[p + 1], B = buf[p + bi];
        y[r * w + c] = Math.round(16 + (219 / 255) * (0.2126 * R + 0.7152 * G + 0.0722 * B));
        clip[r * w + c] = R === 0 || R === 255 || G === 0 || G === 255 || B === 0 || B === 255 ? 1 : 0;
      }
    }
    return { y, clip, rgb: true };
  }
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

// Luma only (an RGB frame): close, not identical. Pass: mean difference below 1.5 and less than
// 0.2% of the pixels more than 6 apart (rounding and clipping in the RGB conversion).
function lumaDiff(a, b) {
  let sum = 0, far = 0, max = 0, n = 0;
  for (let i = 0; i < a.y.length; i++) {
    if (b.clip[i]) continue;
    n++;
    const d = Math.abs(a.y[i] - b.y[i]);
    sum += d;
    if (d > 6) far++;
    if (d > max) max = d;
  }
  return { mean: sum / Math.max(1, n), far: far / Math.max(1, n), max };
}

function firstDiff(a, b) {
  for (const k of ['y', 'u', 'v']) {
    for (let i = 0; i < a[k].length; i++) if (a[k][i] !== b[k][i]) return { plane: k, i, ours: a[k][i], theirs: b[k][i] };
  }
  return null;
}

// frames: an (async) iterable of the session frames. onProgress(n): frames compared.
// hw: the VideoDecoder hardwareAcceleration ('prefer-software' or 'prefer-hardware').
export async function selfTest(workerSrc, params, frames, onProgress, hw = 'no-preference') {
  if (typeof VideoDecoder === 'undefined') return { ok: false, frames: 0, message: 'This browser has no WebCodecs VideoDecoder, so the self-test cannot run. Use Chrome (Android) or Safari (iOS 16.4 or later).' };
  const { w, h } = params;
  const sps = spsNal(params), pps = ppsNal();
  const config = {
    codec: `avc1.${hex(sps[1])}${hex(sps[2])}${hex(sps[3])}`,
    codedWidth: w, codedHeight: h,
    description: avcC(sps, pps).subarray(8),
    hardwareAcceleration: hw,
  };
  const support = await VideoDecoder.isConfigSupported(config);
  if (!support.supported) {
    // No hardware decoder for this stream is not an error of the stream.
    if (hw === 'prefer-hardware') return { ok: true, frames: 0, message: 'No hardware decoder for this stream (not tested).' };
    return { ok: false, frames: 0, message: `The browser cannot decode ${config.codec}.` };
  }

  const wk = makeWorker(workerSrc);
  const ours = new Map(); // index -> our picture
  let theirs = []; // browser frames not yet compared
  let compared = 0, failure = null, result = null, wake = null;
  let rgb = false, worst = { mean: 0, far: 0, max: 0 };
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
      if (b.rgb) {
        rgb = true;
        const l = lumaDiff(a, b);
        worst = { mean: Math.max(worst.mean, l.mean), far: Math.max(worst.far, l.far), max: Math.max(worst.max, l.max) };
        if (l.mean >= 1.5 || l.far >= 0.002) {
          result = { ok: false, frames: compared, message: `Frame ${compared} differs (RGB, luma): mean ${l.mean.toFixed(2)}, ${(100 * l.far).toFixed(2)}% of pixels more than 6 apart, max ${l.max}.` };
        }
      }
      const d = b.rgb ? null : firstDiff(a, b);
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
    if (rgb) return { ok: true, frames: n, message: `Close: ${n} frames (the browser gives RGB, so only the luma is compared; worst mean ${worst.mean.toFixed(2)}, max ${worst.max}).` };
    return { ok: true, frames: n, message: `Identical: ${n} frames.` };
  } catch (e) {
    return { ok: false, frames: compared, message: String(e && e.message ? e.message : e) };
  } finally {
    wk.terminate();
    try { vd.close(); } catch { /* closed */ }
  }
}
