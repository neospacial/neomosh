// Recorder (plan §8): session, capture, encoder and decoder workers, pause and resume.

import { DEFAULT_SETTINGS } from '../codec/encoder.js';
import { streamParams } from '../codec/headers.js';
import { coverCrop } from './geometry.js';

export const ST = {
  IDLE: 'idle',
  RECORDING: 'recording',
  PAUSING: 'pausing',
  PAUSED: 'paused',
  EXPORTING: 'exporting',
  REVIEW: 'review',
};

const MAX_IN_FLIGHT = 2; // R-18

function makeWorker(src) {
  const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
  const wk = new Worker(url);
  URL.revokeObjectURL(url);
  return wk;
}

// Callbacks (all optional): state(st), decoded(bitmap), drop(total), paused(bitmap), error(msg), toast(msg).
export class Recorder {
  constructor({ workerSrc, store, video, on }) {
    this.workerSrc = workerSrc;
    this.store = store;
    this.video = video;
    this.on = on || {};
    this.state = ST.IDLE;
    this.settings = { ...DEFAULT_SETTINGS };
    this.enc = null;
    this.dec = null;
    this.session = null;
    this.reset();
  }

  reset() {
    this.frameCount = 0; // frames stored for this session
    this.clip = 0;
    this.cuts = []; // frame index of each hidden I-frame
    this.points = 0; // number of the last pause point
    this.pointList = []; // pause point meta in RAM: { n, frameIndex, tsUs, drops, thumb }
    this.sessionEndUs = 0; // end of the previous clips
    this.lastTsUs = 0;
    this.encInFlight = 0;
    this.decInFlight = 0;
    this.drops = 0;
    this.clipDrops = 0;
    this.seq = 0;
    this.encMs = 0; // average time in the encoder worker for each frame
    this.grabMs = 0; // the part for drawing, reading the pixels, and RGB to YUV
  }

  setState(s) {
    this.state = s;
    if (this.on.state) this.on.state(s);
  }

  get hasFrames() {
    return this.frameCount > 0;
  }

  // Session time now (microseconds).
  get timeUs() {
    return this.state === ST.RECORDING && this.clipFrames ? this.lastTsUs : this.sessionEndUs;
  }

  async startWorkers(w, h) {
    this.stopWorkers();
    this.enc = makeWorker(this.workerSrc);
    this.dec = makeWorker(this.workerSrc);
    this.enc.onmessage = (e) => this.onEnc(e.data);
    this.dec.onmessage = (e) => this.onDec(e.data);
    const ready = (wk) => new Promise((resolve) => {
      const prev = wk.onmessage;
      wk.onmessage = (e) => {
        if (e.data.cmd === 'ready') {
          wk.onmessage = prev;
          resolve();
        } else prev(e);
      };
    });
    const r = Promise.all([ready(this.enc), ready(this.dec)]);
    this.enc.postMessage({ cmd: 'init', role: 'enc', w, h, settings: this.settings });
    this.dec.postMessage({ cmd: 'init', role: 'dec', w, h });
    await r;
  }

  stopWorkers() {
    if (this.enc) this.enc.terminate();
    if (this.dec) this.dec.terminate();
    this.enc = this.dec = null;
  }

  // Start a new session (plan §7.1: size and frame rate are locked from here).
  async newSession({ w, h, fps, aspect, orient, mirror }) {
    for (const s of await this.store.listSessions()) await this.store.deleteSession(s.id);
    const p = streamParams(w, h, fps);
    this.params = p;
    this.mirror = mirror;
    this.session = {
      id: Date.now(), created: Date.now(), w, h, codedW: p.codedW, codedH: p.codedH, fps, aspect, orient,
      level: p.level, audio: false, sampleRate: 0,
    };
    await this.store.putSession(this.session);
    this.reset();
    // Point 0 = the start (plan §12): frameIndex 0, no reference.
    await this.putPoint({ n: 0, frameIndex: 0, tsUs: 0, drops: 0, thumb: null, refY: null, refU: null, refV: null });
    await this.startWorkers(w, h);
    // R-26 (D18): warn when free storage is low. No persistent storage request (it can show a prompt).
    try {
      const e = await navigator.storage.estimate();
      if (e.quota - e.usage < 200e6 && this.on.toast) this.on.toast('Free storage is low (less than 200 MB).');
    } catch {
      /* not available */
    }
  }

  // Record (from IDLE with a new session) or resume (from PAUSED).
  async record(opts) {
    if (this.state === ST.IDLE) await this.newSession(opts);
    else if (this.state === ST.PAUSED) this.enc.postMessage({ cmd: 'newClip' }); // plan §8.5
    else return;
    this.mirror = opts.mirror;
    this.clip++;
    this.clipFrames = 0;
    this.clipDrops = 0;
    this.clipStartFrameTime = null;
    this.lastCapture = -1e9;
    this.chain = Promise.resolve();
    this.setState(ST.RECORDING);
    this.lockScreen();
    this.loop();
  }

  // R-14: frame timing from requestVideoFrameCallback, else requestAnimationFrame.
  loop() {
    const v = this.video;
    const useVfc = typeof v.requestVideoFrameCallback === 'function';
    const tick = (now, meta) => {
      if (this.state !== ST.RECORDING) return;
      if (useVfc) v.requestVideoFrameCallback(tick);
      else requestAnimationFrame(tick);
      // R-17: frame time of the camera.
      const t = meta ? meta.captureTime ?? meta.expectedDisplayTime ?? now : performance.now();
      this.capture(t);
    };
    if (useVfc) v.requestVideoFrameCallback(tick);
    else requestAnimationFrame(tick);
  }

  capture(t) {
    const p = this.params;
    if (t - this.lastCapture < 1000 / p.fps - 2) return;
    this.lastCapture = t;
    if (this.encInFlight >= MAX_IN_FLIGHT) {
      // R-18, R-19: an encoder drop. The previous frame becomes longer (R-20).
      this.drops++;
      this.clipDrops++;
      if (this.on.drop) this.on.drop(this.drops);
      return;
    }
    const v = this.video;
    if (!v.videoWidth || !v.videoHeight) return;
    if (this.clipStartFrameTime === null) this.clipStartFrameTime = t;
    const tsUs = this.sessionEndUs + Math.round((t - this.clipStartFrameTime) * 1000);
    const c = coverCrop(v.videoWidth, v.videoHeight, p.w, p.h);
    this.encInFlight++;
    const seq = this.seq++;
    const mirror = this.mirror;
    const bmp = this.grab(v, c, p.w, p.h);
    // Keep the frames in order: post each one after the one before it.
    this.chain = this.chain.then(() => bmp).then((bitmap) => {
      this.enc.postMessage({ cmd: 'frame', bitmap, tsUs, mirror, seq }, [bitmap]);
    }).catch((err) => {
      this.encInFlight--;
      this.fail(`Capture failed: ${err && err.message}`);
    });
  }

  // R-15: crop and resize with createImageBitmap. Fallback: draw on a canvas first.
  grab(v, c, w, h) {
    if (!this.noResize) {
      try {
        return createImageBitmap(v, c.sx, c.sy, c.sw, c.sh, { resizeWidth: w, resizeHeight: h, resizeQuality: 'medium' })
          .catch(() => {
            this.noResize = true;
            return this.grab(v, c, w, h);
          });
      } catch {
        this.noResize = true;
      }
    }
    if (!this.grabCanvas) {
      this.grabCanvas = document.createElement('canvas');
      this.grabCtx = this.grabCanvas.getContext('2d', { alpha: false });
    }
    this.grabCanvas.width = w;
    this.grabCanvas.height = h;
    this.grabCtx.drawImage(v, c.sx, c.sy, c.sw, c.sh, 0, 0, w, h);
    return createImageBitmap(this.grabCanvas);
  }

  onEnc(m) {
    if (m.cmd === 'error') {
      if (m.during === 'frame') this.encInFlight--;
      this.fail(`Encoder: ${m.message}`);
      return this.checkIdle();
    }
    if (m.cmd !== 'packet') return;
    this.encInFlight--;
    this.encMs = this.encMs ? this.encMs * 0.9 + m.ms * 0.1 : m.ms;
    this.grabMs = this.grabMs ? this.grabMs * 0.9 + m.grabMs * 0.1 : m.grabMs;
    const pkt = m.pkt;
    const index = this.frameCount++;
    if (pkt.type === 'hiddenI') this.cuts.push(index);
    this.clipFrames++;
    this.lastTsUs = m.tsUs;
    this.store.addFrame({
      sessionId: this.session.id, index, type: pkt.type, clip: this.clip, tsUs: m.tsUs, qp: pkt.qp,
      bits: pkt.bits, bitLen: pkt.bitLen, hdrBits: pkt.hdrBits, settings: pkt.settings,
    });
    // R-21: no preview bitmap when the decoder is late.
    const preview = this.decInFlight === 0 && this.state === ST.RECORDING;
    this.decInFlight++;
    this.dec.postMessage({ cmd: 'packet', seq: m.seq, pkt, preview });
    this.checkIdle();
  }

  onDec(m) {
    if (m.cmd === 'error') {
      if (m.during === 'packet') this.decInFlight--;
      this.fail(`Decoder: ${m.message}`);
      return this.checkIdle();
    }
    if (m.cmd === 'snapshot') {
      if (this.snapWaiter) this.snapWaiter(m);
      return;
    }
    if (m.cmd !== 'decoded') return;
    this.decInFlight--;
    if (m.bitmap) {
      if (this.state === ST.RECORDING && this.on.decoded) this.on.decoded(m.bitmap);
      else m.bitmap.close();
    }
    this.checkIdle();
  }

  checkIdle() {
    if (this.idleWaiter && this.encInFlight === 0 && this.decInFlight === 0) {
      const w = this.idleWaiter;
      this.idleWaiter = null;
      w();
    }
  }

  // Plan §8.4.
  async pause(reason) {
    if (this.state !== ST.RECORDING) return;
    this.setState(ST.PAUSING); // step 1: the capture loop stops
    this.unlockScreen();
    if (reason && this.on.toast) this.on.toast(reason);
    await this.chain;
    // Steps 2 and 3: wait for the encoder and the decoder.
    await new Promise((resolve) => {
      this.idleWaiter = resolve;
      this.checkIdle();
    });
    if (this.state !== ST.PAUSING) return; // failed while waiting
    if (!this.frameCount) {
      this.setState(ST.IDLE);
      return;
    }
    if (!this.clipFrames) {
      // No frame in this clip: no new pause point. The overlay stays.
      this.clip--;
      this.setState(ST.PAUSED);
      if (this.on.paused) this.on.paused(null, null);
      return;
    }
    this.sessionEndUs = this.lastTsUs + Math.round(1e6 / this.params.fps);
    await this.makePoint(this.clipDrops);
  }

  // Plan §8.4 steps 4, 6, and 7: a pause point at the current end of the session.
  async makePoint(drops) {
    const snap = await this.snapshot();
    const thumb = await makeThumb(snap.bitmap);
    await this.store.flush();
    await this.putPoint({
      n: this.points + 1, frameIndex: this.frameCount, tsUs: this.sessionEndUs, drops, thumb,
      refY: snap.Y, refU: snap.U, refV: snap.V,
    });
    if (this.on.paused) this.on.paused(snap.bitmap, thumb);
    this.setState(ST.PAUSED);
  }

  async putPoint(p) {
    const point = { sessionId: this.session.id, audioSamples: 0, settings: { ...this.settings }, ...p };
    await this.store.putPoint(point);
    this.points = p.n;
    this.pointList[p.n] = { n: p.n, frameIndex: p.frameIndex, tsUs: p.tsUs, drops: p.drops, thumb: p.thumb, settings: point.settings };
  }

  // The decoder reference picture: { Y, U, V, bitmap }.
  snapshot() {
    return new Promise((resolve) => {
      this.snapWaiter = (m) => {
        this.snapWaiter = null;
        resolve(m);
      };
      this.dec.postMessage({ cmd: 'snapshot' });
    });
  }

  // Wait until the decoder has decoded all packets that were sent to it.
  decIdle() {
    return new Promise((resolve) => {
      this.idleWaiter = resolve;
      this.checkIdle();
    });
  }

  // Plan §12.3: revert to pause point n. Then PAUSED at that point, or IDLE for n = 0.
  async revert(n) {
    if ((this.state !== ST.PAUSED && this.state !== ST.REVIEW) || !this.session) return;
    if (n === 0) return this.discard();
    this.setState(ST.PAUSING); // busy until the overlay shows point n
    const p = await this.store.getPoint(this.session.id, n);
    if (!p || !p.refY) {
      this.setState(ST.PAUSED);
      throw new Error(`No pause point ${n}`);
    }
    await this.store.truncate(this.session.id, p.frameIndex, n); // steps 1 to 3
    this.dec.postMessage({ cmd: 'setRef', Y: p.refY, U: p.refU, V: p.refV }); // step 4
    this.settings = { ...p.settings }; // step 6
    this.enc.postMessage({ cmd: 'settings', settings: this.settings });
    this.enc.postMessage({ cmd: 'continueSession' }); // step 5
    this.pointList.length = n + 1;
    this.applyPoint(p);
    const snap = await this.snapshot();
    if (this.on.paused) this.on.paused(snap.bitmap, p.thumb);
    this.setState(ST.PAUSED);
  }

  // RAM state at pause point p (the last point of the session).
  applyPoint(p) {
    this.points = p.n;
    this.frameCount = p.frameIndex;
    this.clip = p.n;
    this.sessionEndUs = p.tsUs;
    this.lastTsUs = p.tsUs;
    // Each clip after the first starts with a hidden I-frame at its pause point.
    this.cuts = this.pointList.filter((q) => q && q.n >= 1 && q.frameIndex < this.frameCount).map((q) => q.frameIndex);
    this.drops = this.pointList.reduce((a, q) => a + (q ? q.drops : 0), 0);
    this.clipDrops = 0;
  }

  // Plan §11.4 "New video" (and revert to point 0): delete the session. Then IDLE.
  async discard() {
    this.setState(ST.PAUSING);
    if (this.session) await this.store.deleteSession(this.session.id);
    this.stopWorkers();
    this.session = null;
    this.reset();
    this.setState(ST.IDLE);
  }

  // Plan §11.6: continue a stored session. Returns false when it has no frames.
  async restore(session) {
    this.session = session;
    this.params = streamParams(session.w, session.h, session.fps);
    this.reset();
    const id = session.id;
    const pts = (await this.store.getPoints(id)).sort((a, b) => a.n - b.n);
    const total = await this.store.countFrames(id);
    if (!total) {
      await this.discard();
      return false;
    }
    if (!pts.length || pts[0].n !== 0) pts.unshift({ n: 0, frameIndex: 0, tsUs: 0, drops: 0, thumb: null });
    for (const q of pts) this.pointList[q.n] = { n: q.n, frameIndex: q.frameIndex, tsUs: q.tsUs, drops: q.drops || 0, thumb: q.thumb, settings: q.settings };
    let last = pts[pts.length - 1];
    if (last.settings) this.settings = { ...last.settings };
    await this.startWorkers(session.w, session.h);
    if (last.refY) this.dec.postMessage({ cmd: 'setRef', Y: last.refY, U: last.refU, V: last.refV });
    this.applyPoint(last);
    this.setState(ST.PAUSING);
    if (total > last.frameIndex) {
      // The app closed while recording: decode the frames after the last point, then make a point.
      let lastTs = last.tsUs;
      for await (const f of this.store.readFrames(id, last.frameIndex)) {
        if (f.type === 'hiddenI' && f.index > last.frameIndex) this.cuts.push(f.index);
        this.decInFlight++;
        this.dec.postMessage({ cmd: 'packet', seq: f.index, pkt: f, preview: false });
        lastTs = f.tsUs;
        if (f.settings) this.settings = { ...f.settings };
      }
      await this.decIdle();
      if (last.n >= 1 && last.frameIndex < total) this.cuts = [...new Set([...this.cuts, last.frameIndex])].sort((a, b) => a - b);
      this.frameCount = total;
      this.clip = last.n + 1;
      this.sessionEndUs = this.lastTsUs = lastTs + Math.round(1e6 / session.fps);
      await this.makePoint(0);
    } else {
      const snap = await this.snapshot();
      if (this.on.paused) this.on.paused(snap.bitmap, last.thumb);
      this.setState(ST.PAUSED);
    }
    this.enc.postMessage({ cmd: 'settings', settings: this.settings });
    this.enc.postMessage({ cmd: 'continueSession' });
    return true;
  }

  fail(msg) {
    if (this.on.error) this.on.error(msg);
    if (this.state === ST.RECORDING) this.pause();
  }

  // R-25.
  lockScreen() {
    if (!navigator.wakeLock || !navigator.wakeLock.request) return;
    navigator.wakeLock.request('screen').then((w) => (this.wake = w)).catch(() => {});
  }

  unlockScreen() {
    if (this.wake && this.wake.release) this.wake.release().catch(() => {});
    this.wake = null;
  }
}

// A small JPEG of the picture, for the thumbnail and the history (plan §8.4 step 4).
async function makeThumb(bitmap) {
  if (!bitmap) return null;
  const k = Math.min(1, 240 / Math.max(bitmap.width, bitmap.height));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(bitmap.width * k));
  c.height = Math.max(1, Math.round(bitmap.height * k));
  c.getContext('2d').drawImage(bitmap, 0, 0, c.width, c.height);
  return new Promise((resolve) => c.toBlob((b) => resolve(b), 'image/jpeg', 0.8));
}
