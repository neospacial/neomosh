// Original mode export: lossless remux (plan §9.2, D12). No decode, no re-encode.
// The exported pictures are the same as our decoder output, bit for bit.

import { frameSelector, sliceNal, spsNal, ppsNal } from '../codec/headers.js';
import { muxMp4 } from './mp4.js';

export const VIDEO_TIMESCALE = 90000;

// Microseconds -> 90 kHz units.
const to90k = (us) => Math.round((us * 9) / 100);

// Mosh cut (plan §9.2): the hidden I-frame is not shown. Its time slot is removed, so the frames after
// the cut move one frame earlier. Without this, the last picture before the cut stays for two frame
// times, which looks like a dropped frame. Clean cuts show the I-frame: no change.
// skip(frame): a frame that is not shown. time(frame): the output time (microseconds) of a shown frame.
export class CutRetime {
  constructor() {
    this.shift = 0;
    this.skipAt = null;
  }

  skip(f) {
    if (this.skipAt === null) this.skipAt = f.tsUs;
  }

  time(f) {
    if (this.skipAt !== null) {
      this.shift += f.tsUs - this.skipAt;
      this.skipAt = null;
    }
    return f.tsUs - this.shift;
  }
}

// Add the frames in session order, then call finish().
// params: streamParams() of the session. opts.cuts: 'mosh' | 'clean' | an array for each cut.
export class Remuxer {
  constructor(params, opts = {}) {
    this.params = params;
    this.select = frameSelector(opts.cuts ?? 'mosh');
    this.samples = [];
    this.t0 = null;
    this.last = null;
    this.retime = new CutRetime();
  }

  // frame = { type, qp, bits, bitLen, hdrBits, tsUs } (plan §12, frames store).
  add(frame) {
    const k = this.select(frame);
    if (!k) {
      this.retime.skip(frame);
      return false;
    }
    const ts = this.retime.time(frame);
    const nal = sliceNal(frame, k.frameNum);
    // MP4 uses a 4-byte length prefix, not start codes (plan §9.2 step 3).
    const data = new Uint8Array(nal.length + 4);
    new DataView(data.buffer).setUint32(0, nal.length);
    data.set(nal, 4);
    if (this.t0 === null) this.t0 = ts;
    // Durations come from rounded absolute times, so the rounding error does not add up (step 4).
    let t = to90k(ts - this.t0);
    if (this.last) {
      if (t <= this.last.t) t = this.last.t + 1;
      this.last.duration = t - this.last.t;
    }
    this.last = { data, size: data.length, key: k.key, t, duration: 0 };
    this.samples.push(this.last);
    return true;
  }

  // Returns { parts, size, samples } (see muxMp4). muxOpts: for tests only.
  finish(muxOpts) {
    if (!this.last) throw new Error('No frames to export');
    this.last.duration = Math.round(VIDEO_TIMESCALE / this.params.fps);
    const p = this.params;
    const r = muxMp4({
      width: p.w, height: p.h, timescale: VIDEO_TIMESCALE, sps: spsNal(p), pps: ppsNal(), samples: this.samples,
    }, muxOpts);
    return { ...r, samples: this.samples };
  }
}

// Export from an (async) iterable of frames, for example a cursor over IndexedDB (R-34).
// opts: { cuts, signal (AbortSignal), onProgress(framesRead) }.
export async function remuxOriginal(params, frames, opts = {}) {
  const rx = new Remuxer(params, opts);
  let n = 0;
  for await (const f of frames) {
    if (opts.signal && opts.signal.aborted) throw new Error('Export cancelled');
    rx.add(f);
    n++;
    if (opts.onProgress) opts.onProgress(n);
  }
  return rx.finish();
}
