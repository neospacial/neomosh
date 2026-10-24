// Recorder (plan §8): session, capture, encoder and decoder workers, pause and resume.

import { DEFAULT_SETTINGS, checkSettings } from '../codec/encoder.js';
import { streamParams } from '../codec/headers.js';
import { coverCrop } from './geometry.js';
import { FrameGate } from './capture.js';

export const ST = {
  IDLE: 'idle',
  RECORDING: 'recording',
  PAUSING: 'pausing',
  PAUSED: 'paused',
  EXPORTING: 'exporting',
  REVIEW: 'review',
};

const MAX_IN_FLIGHT = 6; // R-18 (D19): about 200 ms of buffer at 30 fps for short CPU load peaks

export function makeWorker(src) {
  const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
  const wk = new Worker(url);
  URL.revokeObjectURL(url);
  return wk;
}

// The info text of a capture way result: the way, the times of each way, the YUV colour check.
function methodText(m) {
  return `${m.method}; ${Object.entries(m.times).map(([k, v]) => `${k} ${v.toFixed(1)} ms`).join(', ')}` +
    (m.calib ? `; yuv check ${m.calib}` : '');
}

// Callbacks (all optional): state(st), decoded(bitmap), drop(total), paused(bitmap), error(msg), toast(msg).
export class Recorder {
  // captureMethod: force the crop way of the capture worker ('yuv', 'bitmap', 'draw'; debug, D22).
  constructor({ workerSrc, store, video, on, captureMethod }) {
    this.captureMethod = ['yuv', 'bitmap', 'draw'].includes(captureMethod) ? captureMethod : null;
    if (this.captureMethod) this.capMethod = `${this.captureMethod}, forced`;
    this.workerSrc = workerSrc;
    this.store = store;
    this.video = video;
    this.source = 'camera'; // 'camera' or 'file' (plan §11.5). The encoder cannot tell (R-31).
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
    this.dropKinds = { enc: 0, page: 0, cap: 0 }; // R-19: encoder busy; source frames that the page or the capture worker did not get
    this.seq = 0;
    this.encMs = 0; // average time in the encoder worker for each frame
    this.grabMs = 0; // the part for drawing, reading the pixels, and RGB to YUV
    this.capMs = 0; // capture worker: drawing and reading the pixels (in parallel with the encoder)
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
    this.cap = makeWorker(this.workerSrc);
    this.enc.onmessage = (e) => this.onEnc(e.data);
    this.dec.onmessage = (e) => this.onDec(e.data);
    this.cap.onmessage = (e) => this.onCap(e.data);
    const ready = (wk) => new Promise((resolve) => {
      const prev = wk.onmessage;
      wk.onmessage = (e) => {
        if (e.data.cmd === 'ready') {
          if (wk === this.cap) this.capMstp = e.data.mstp;
          else this.wasm = e.data.wasm;
          wk.onmessage = prev;
          resolve();
        } else prev(e);
      };
    });
    const r = Promise.all([ready(this.enc), ready(this.dec), ready(this.cap)]);
    // The capture worker sends the pictures straight to the encoder worker (R-14).
    const ch = new MessageChannel();
    this.enc.postMessage({ cmd: 'init', role: 'enc', w, h, settings: this.settings, port: ch.port2 }, [ch.port2]);
    this.dec.postMessage({ cmd: 'init', role: 'dec', w, h });
    // The way: forced (debug), else from the probe before the recording, else measured on the first frames.
    const preset = this.captureMethod || (this.capPreset && this.capPreset.method);
    if (!this.captureMethod && this.capPreset) this.capMethod = `${this.capPreset.text} (measured before the recording)`;
    this.cap.postMessage({ cmd: 'init', role: 'cap', w, h, port: ch.port1, method: preset }, [ch.port1]);
    await r;
  }

  stopWorkers() {
    for (const wk of [this.enc, this.dec, this.cap]) if (wk) wk.terminate();
    this.enc = this.dec = this.cap = null;
    this.capActive = false;
    if (this.capTrack) this.capTrack.stop();
    this.capTrack = null;
  }

  // R-14: the camera frames go to the capture worker (MediaStreamTrackProcessor), not through the
  // main thread. Returns false when this is not possible: then the page path (rVFC) is used.
  startCapture() {
    const stream = this.video.srcObject;
    const track = this.source === 'camera' && !this.noCapWorker && this.cap && stream && stream.getVideoTracks ? stream.getVideoTracks()[0] : null;
    // The reason for the page path, for the info section.
    if (this.source !== 'camera') this.capReason = 'file source';
    else if (!this.noCapWorker) this.capReason = !track ? 'no camera track' : track.readyState !== 'live' ? 'camera track ended' : '';
    if (!track || track.readyState !== 'live') return false;
    const base = {
      cmd: 'capStart', fps: this.params.fps, mirror: this.mirror, sessionEndUs: this.sessionEndUs, seq: this.seq,
      vw: this.video.videoWidth, vh: this.video.videoHeight,
    };
    const clone = track.clone();
    try {
      if (typeof MediaStreamTrackProcessor === 'function') {
        // Chrome: the processor on the main thread, the stream to the worker.
        const readable = new MediaStreamTrackProcessor({ track: clone, maxBufferSize: 4 }).readable;
        this.cap.postMessage({ ...base, readable }, [readable]);
        this.capTrack = clone;
      } else if (this.capMstp) {
        // Safari: the processor only in a worker, so the track goes to the worker.
        this.cap.postMessage({ ...base, track: clone }, [clone]);
        this.capTrack = null;
      } else {
        clone.stop();
        this.capReason = 'no MediaStreamTrackProcessor';
        return false;
      }
    } catch (e) {
      clone.stop();
      this.noCapWorker = true;
      this.capReason = `transfer failed: ${e && e.message}`;
      return false;
    }
    this.capActive = true;
    this.captureMode = 'worker';
    return true;
  }

  // Before the recording (D22): measure the crop ways of the capture worker on about 25 camera frames
  // (about 1 s) in a worker of its own, so that the slow ways do not drop frames of the first clip.
  // Resolves { method, text } or null (no camera, no processor, or no result).
  async probeCapture(w, h, mirror) {
    const stream = this.video.srcObject;
    const track = stream && stream.getVideoTracks ? stream.getVideoTracks()[0] : null;
    if (!track || track.readyState !== 'live' || this.captureMethod) return null;
    const wk = makeWorker(this.workerSrc);
    const clone = track.clone();
    let done;
    const result = new Promise((resolve) => (done = resolve));
    let out = null;
    wk.onmessage = (e) => {
      const m = e.data;
      if (m.cmd === 'ready') {
        const base = { cmd: 'capStart', fps: 30, mirror, sessionEndUs: 0, seq: 0, vw: this.video.videoWidth, vh: this.video.videoHeight };
        try {
          if (typeof MediaStreamTrackProcessor === 'function') {
            const readable = new MediaStreamTrackProcessor({ track: clone, maxBufferSize: 4 }).readable;
            wk.postMessage({ ...base, readable }, [readable]);
          } else if (m.mstp) wk.postMessage({ ...base, track: clone }, [clone]);
          else done();
        } catch {
          done();
        }
      } else if (m.cmd === 'capMethod') {
        out = { method: m.method, text: methodText(m), ms: m.times[m.method] };
      } else if (m.cmd === 'capStopped' || m.cmd === 'capMismatch' || m.cmd === 'error') done();
    };
    wk.postMessage({ cmd: 'init', role: 'cap', w, h, probe: true });
    const timer = setTimeout(done, 5000);
    await result;
    clearTimeout(timer);
    clone.stop();
    // Let the worker close the frames that are still in its queue, then end it.
    setTimeout(() => wk.terminate(), 400);
    return out;
  }

  // A probe result for this camera and size: the next workers use it, and a running capture worker
  // changes to it at once.
  setCapPreset(p) {
    if (this.captureMethod || (this.capPreset && this.capPreset.method === p.method && this.capPreset.text === p.text)) return;
    this.capPreset = p;
    if (this.cap) {
      this.cap.postMessage({ cmd: 'capSet', method: p.method });
      this.capMs = 0;
      this.capMethod = `${p.text} (measured before the recording)`;
    }
  }

  setBloomOff() {
    if (!this.bloomOn) return;
    this.bloomOn = false;
    if (this.enc) this.enc.postMessage({ cmd: 'bloom', on: false });
    if (this.on.bloom) this.on.bloom(false);
  }

  // The page goes away (pagehide): stop the camera track of the capture at once, so that no camera
  // frame is left in a page that ends.
  stopCaptureNow() {
    if (this.capTrack) this.capTrack.stop();
    if (this.cap && this.capActive) this.cap.postMessage({ cmd: 'capStop' });
  }

  // Stop the capture worker clip. Resolves when it sent its last frame to the encoder.
  stopCapture() {
    if (!this.capActive) return Promise.resolve();
    return new Promise((resolve) => {
      this.capWaiter = resolve;
      if (this.capTrack) this.capTrack.stop(); // the stream ends after its queued frames
      this.cap.postMessage({ cmd: 'capStop' });
    });
  }

  onCap(m) {
    if (m.cmd === 'capDrop') this.countDrops(m.n, m.kind);
    else if (m.cmd === 'capSkip') this.camSkips += m.n;
    else if (m.cmd === 'capMethod') {
      this.capMethod = methodText(m);
      this.capMs = 0; // the average starts again with the chosen way
    }
    else if (m.cmd === 'capMismatch') {
      // The frames are turned against the <video>: use the page path from now on.
      this.noCapWorker = true;
      this.captureMode = 'page';
      this.capReason = `frames ${m.fw}×${m.fh} (coded ${m.cw}×${m.ch}, rotation ${m.rotation}), view ${this.video.videoWidth}×${this.video.videoHeight}`;
    } else if (m.cmd === 'capStopped') {
      // The packets of these frames decrement encInFlight (it can be below 0 until now).
      this.encInFlight += m.sent;
      this.seq = m.seq;
      this.capActive = false;
      if (this.capTrack) this.capTrack.stop();
      this.capTrack = null;
      if (this.capWaiter) {
        const w = this.capWaiter;
        this.capWaiter = null;
        w();
      } else if (this.state === ST.RECORDING) {
        this.loop(); // after a mismatch: continue with the page path
      }
      this.checkIdle();
    } else if (m.cmd === 'error') {
      this.fail(`Capture: ${m.message}`);
    }
  }

  // Start a new session (plan §7.1: size and frame rate are locked from here).
  async newSession({ w, h, fps, aspect, orient, mirror }) {
    for (const s of await this.store.listSessions()) await this.store.deleteSession(s.id);
    const p = streamParams(w, h, fps);
    this.params = p;
    this.mirror = mirror;
    this.session = {
      id: Date.now(), created: Date.now(), w, h, codedW: p.codedW, codedH: p.codedH, fps, aspect, orient,
      level: p.level,
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

  // Plan §7.2, R-12: the encoder settings change only while not recording. They apply to the next
  // clip, and the next pause point stores them (R-13).
  setSettings(s) {
    if (this.state !== ST.IDLE && this.state !== ST.PAUSED) return false;
    this.settings = checkSettings(s);
    if (this.enc) this.enc.postMessage({ cmd: 'settings', settings: this.settings });
    return true;
  }

  // The source <video> for the next clip (IDLE or PAUSED only).
  setSource(video, kind) {
    if (this.state === ST.RECORDING || this.state === ST.PAUSING) return;
    this.video = video;
    this.source = kind;
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
    this.dropKinds = { enc: 0, page: 0, cap: 0 };
    this.bloomFrames = 0;
    this.camSkips = 0; // source frames that the camera did not give (not drops, R-19)
    this.viewSkips = 0; // live view pictures not shown (R-21); the file has these frames
    this.bloomFrames = 0; // repeated P-frames in this clip (Bloom)
    this.bloomOn = false;
    this.clipStartFrameTime = null;
    this.gate = null;
    this.lastPresented = null;
    this.chain = Promise.resolve();
    this.setState(ST.RECORDING);
    this.lockScreen();
    if (!this.startCapture()) {
      this.captureMode = 'page';
      this.loop();
    }
  }

  // R-14: frame timing from requestVideoFrameCallback, else requestAnimationFrame.
  loop() {
    const v = this.video;
    const useVfc = typeof v.requestVideoFrameCallback === 'function';
    const tick = (now, meta) => {
      if (this.state !== ST.RECORDING) return;
      if (useVfc) v.requestVideoFrameCallback(tick);
      else requestAnimationFrame(tick);
      // R-17: frame time. A file: the media time. The camera: the capture time.
      let t;
      if (this.source === 'file') t = (meta ? meta.mediaTime : v.currentTime) * 1000;
      else t = meta ? meta.captureTime ?? meta.expectedDisplayTime ?? now : performance.now();
      // R-19: source frames that the browser did not give to this callback (the main thread was late).
      let missed = 0;
      if (meta && meta.presentedFrames !== undefined) {
        if (this.lastPresented !== null) missed = Math.max(0, meta.presentedFrames - this.lastPresented - 1);
        this.lastPresented = meta.presentedFrames;
      }
      this.capture(t, missed);
    };
    if (useVfc) v.requestVideoFrameCallback(tick);
    else requestAnimationFrame(tick);
  }

  // missed: source frames that the frame callback did not see (R-19).
  capture(t, missed = 0) {
    const p = this.params;
    if (!this.gate) this.gate = new FrameGate(p.fps);
    const g = this.gate.next(t, missed);
    if (g.lost > 0) this.countDrops(g.lost, 'page');
    if (!g.keep) return;
    if (this.encInFlight >= MAX_IN_FLIGHT) {
      // R-18, R-19: an encoder drop. The previous frame becomes longer (R-20).
      this.countDrops(1, 'enc');
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

  countDrops(n, kind) {
    this.drops += n;
    this.clipDrops += n;
    this.dropKinds[kind] += n;
    if (this.on.drop) this.on.drop(this.drops);
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
      if (m.during === 'frame' || m.during === 'rgba') this.encInFlight--;
      this.fail(`Encoder: ${m.message}`);
      return this.checkIdle();
    }
    if (m.cmd !== 'packet') return;
    this.encInFlight--;
    if (m.pkt.bloom) this.bloomFrames++;
    else {
      // A bloom frame is not encoded (a copy): it does not count for the speed.
      this.encMs = this.encMs ? this.encMs * 0.9 + m.ms * 0.1 : m.ms;
      this.grabMs = this.grabMs ? this.grabMs * 0.9 + m.grabMs * 0.1 : m.grabMs;
    }
    if (m.capMs !== undefined) this.capMs = this.capMs ? this.capMs * 0.9 + m.capMs * 0.1 : m.capMs;
    const pkt = m.pkt;
    const index = this.frameCount++;
    if (pkt.type === 'hiddenI') this.cuts.push(index);
    this.clipFrames++;
    this.lastTsUs = m.tsUs;
    this.store.addFrame({
      sessionId: this.session.id, index, type: pkt.type, clip: this.clip, tsUs: m.tsUs, qp: pkt.qp,
      bits: pkt.bits, bitLen: pkt.bitLen, hdrBits: pkt.hdrBits, settings: pkt.settings, bloom: !!pkt.bloom,
    });
    // R-21: no preview bitmap when the decoder is late.
    // R-26: a write failed (for example the storage is full): stop at once.
    if (this.store.error && this.state === ST.RECORDING) this.pause();
    // R-21: the recording has priority over the live view. When the decoder is still busy with the
    // last frame, this frame gets no preview picture. The frame is decoded and stored all the same.
    const preview = this.decInFlight === 0 && this.state === ST.RECORDING;
    if (!preview && this.state === ST.RECORDING) this.viewSkips++;
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

  // Bloom (plan §15): while on, each frame repeats the last P-frame of this clip. Only while recording.
  setBloom(on) {
    on = !!on && this.state === ST.RECORDING;
    if (on === this.bloomOn) return;
    this.bloomOn = on;
    if (this.enc) this.enc.postMessage({ cmd: 'bloom', on });
    if (this.on.bloom) this.on.bloom(on);
  }

  // Plan §8.4.
  async pause(reason) {
    if (this.state !== ST.RECORDING) return;
    this.setBloomOff();
    this.setState(ST.PAUSING); // step 1: the capture loop stops
    this.unlockScreen();
    if (reason && this.on.toast) this.on.toast(reason);
    await this.stopCapture();
    await this.chain;
    // Steps 2 and 3: wait for the encoder and the decoder.
    await new Promise((resolve) => {
      this.idleWaiter = resolve;
      this.checkIdle();
    });
    if (this.state !== ST.PAUSING) return; // failed while waiting
    if (this.store.error) return this.storageFailed();
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

  // The frames of the last clip could not be stored: go back to the last complete pause point.
  async storageFailed() {
    const n = this.points;
    this.store.error = null;
    this.store.pending = [];
    if (this.on.toast) this.on.toast('The storage is full: the last clip was not saved. Export the video, or free some space.', 6000);
    if (n === 0) return this.discard();
    try {
      await this.revertTo(n);
    } catch {
      this.setState(ST.PAUSED);
    }
  }

  // Plan §8.4 steps 4, 6, and 7: a pause point at the current end of the session.
  async makePoint(drops) {
    const snap = await this.snapshot();
    const thumb = await makeThumb(snap.bitmap);
    try {
      await this.store.flush();
    } catch (e) {
      this.store.error = e;
      return this.storageFailed();
    }
    await this.putPoint({
      n: this.points + 1, frameIndex: this.frameCount, tsUs: this.sessionEndUs, drops, thumb,
      refY: snap.Y, refU: snap.U, refV: snap.V,
    });
    if (this.on.paused) this.on.paused(snap.bitmap, thumb);
    this.setState(ST.PAUSED);
  }

  async putPoint(p) {
    const point = { sessionId: this.session.id, settings: { ...this.settings }, ...p };
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
    try {
      await this.revertTo(n);
    } catch (e) {
      this.setState(ST.PAUSED); // a failed revert must not stay busy
      throw e;
    }
  }

  async revertTo(n) {
    const p = await this.store.getPoint(this.session.id, n);
    if (!p || !p.refY) throw new Error(`No pause point ${n}`);
    await this.store.truncate(this.session.id, p.frameIndex, n); // steps 1 and 2 (no audio: D20)
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
    navigator.wakeLock.request('screen').then((w) => {
      // The recording can pause before the lock arrives: then release it at once.
      if (this.state === ST.RECORDING) this.wake = w;
      else w.release().catch(() => {});
    }).catch(() => {});
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
