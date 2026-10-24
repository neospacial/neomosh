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
    this.points = 0;
    this.sessionEndUs = 0; // end of the previous clips
    this.lastTsUs = 0;
    this.encInFlight = 0;
    this.decInFlight = 0;
    this.drops = 0;
    this.clipDrops = 0;
    this.seq = 0;
    this.encMs = 0;
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
    await this.startWorkers(w, h);
    // R-26: ask for persistent storage, and warn when free storage is low.
    try {
      if (navigator.storage && navigator.storage.persist) await navigator.storage.persist();
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
    if (this.clipFrames) this.sessionEndUs = this.lastTsUs + Math.round(1e6 / this.params.fps);
    // Step 4: the reference picture and a thumbnail.
    const snap = await new Promise((resolve) => {
      this.snapWaiter = resolve;
      this.dec.postMessage({ cmd: 'snapshot', id: this.points });
    });
    this.snapWaiter = null;
    const thumb = await makeThumb(snap.bitmap);
    // Step 6: the pause point.
    this.points++;
    await this.store.flush();
    await this.store.putPoint({
      sessionId: this.session.id, n: this.points, frameIndex: this.frameCount, tsUs: this.sessionEndUs,
      audioSamples: 0, refY: snap.Y, refU: snap.U, refV: snap.V, thumb, settings: { ...this.settings },
      drops: this.clipDrops,
    });
    this.setState(ST.PAUSED);
    // Step 7: the overlay.
    if (this.on.paused) this.on.paused(snap.bitmap, thumb);
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
