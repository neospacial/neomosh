// Review player (plan §11.4): plays the session with our decoder, in its own worker.
// The picture is the Mosh view (hidden I-frames are not shown), the same as the default export.
// Seek uses checkpoints: the pause point references (IndexedDB), and decoder snapshots that the
// player makes every 2 s during playback (RAM only).

const SNAPSHOT_EVERY_US = 2e6;
const MAX_SNAPSHOTS = 90;

export class Player {
  // on: { frame(bitmap), time(us), state(playing) }
  constructor({ workerSrc, store, on }) {
    this.workerSrc = workerSrc;
    this.store = store;
    this.on = on || {};
    this.worker = null;
    this.waiters = new Map();
    this.seq = 0;
  }

  // session: the session record. points: pause point meta [{ n, frameIndex, tsUs }]. endUs: session length.
  async open(session, points, frameCount, endUs) {
    this.close();
    this.session = session;
    this.points = points.filter(Boolean);
    this.frameCount = frameCount;
    this.endUs = endUs;
    this.snaps = []; // { frameIndex, keyUs, Y, U, V }
    this.cur = { index: 0, tsUs: 0 }; // next frame to decode; time of the picture now
    this.playing = false;
    this.busy = Promise.resolve();
    const url = URL.createObjectURL(new Blob([this.workerSrc], { type: 'text/javascript' }));
    this.worker = new Worker(url);
    URL.revokeObjectURL(url);
    this.worker.onmessage = (e) => {
      const m = e.data;
      const key = m.cmd === 'snapshot' ? 's' + m.id : m.cmd === 'decoded' ? 'd' + m.seq : m.cmd;
      const w = this.waiters.get(key);
      if (w) {
        this.waiters.delete(key);
        w(m);
      } else if (m.bitmap) m.bitmap.close();
    };
    const ready = this.wait('ready');
    this.worker.postMessage({ cmd: 'init', role: 'dec', w: session.w, h: session.h });
    await ready;
    await this.seek(0);
  }

  close() {
    this.playing = false;
    if (this.worker) this.worker.terminate();
    this.worker = null;
    this.waiters.clear();
    this.snaps = [];
  }

  wait(key) {
    return new Promise((resolve) => this.waiters.set(key, resolve));
  }

  // Decode one frame. Resolves with the 'decoded' message (with a bitmap when preview is set).
  decode(f, preview) {
    const seq = this.seq++;
    const p = this.wait('d' + seq);
    this.worker.postMessage({ cmd: 'packet', seq, pkt: f, preview });
    return p;
  }

  snapshot() {
    const id = this.seq++;
    const p = this.wait('s' + id);
    this.worker.postMessage({ cmd: 'snapshot', id });
    return p;
  }

  // Run one operation at a time.
  queue(fn) {
    this.busy = this.busy.then(fn, fn);
    return this.busy;
  }

  // Show the picture at session time t (the last frame with a timestamp <= t).
  seek(t) {
    this.target = t;
    return this.queue(async () => {
      if (this.target !== t || !this.worker) return; // a newer seek is waiting
      this.playing = false;
      // The best start: a checkpoint at or before t, or the current picture.
      let start = { frameIndex: 0, keyUs: -1, ref: null };
      for (const p of this.points) {
        if (p.n >= 1 && p.tsUs <= t && p.frameIndex > start.frameIndex) start = { frameIndex: p.frameIndex, keyUs: p.tsUs, point: p.n };
      }
      for (const s of this.snaps) if (s.keyUs <= t && s.frameIndex > start.frameIndex) start = s;
      const fromCurrent = this.cur.index > start.frameIndex && this.cur.tsUs <= t;
      if (!fromCurrent) {
        if (start.Y) this.worker.postMessage({ cmd: 'setRef', Y: start.Y, U: start.U, V: start.V });
        else if (start.point) {
          const p = await this.store.getPoint(this.session.id, start.point);
          this.worker.postMessage({ cmd: 'setRef', Y: p.refY, U: p.refU, V: p.refV });
        }
        this.cur = { index: start.frameIndex, tsUs: Math.max(0, start.keyUs) };
      }
      let last = null;
      for await (const f of this.store.readFrames(this.session.id, this.cur.index)) {
        if (f.tsUs > t || this.target !== t) break;
        last = this.decode(f, false);
        this.cur = { index: f.index + 1, tsUs: f.tsUs };
      }
      if (last) await last;
      const snap = await this.snapshot();
      if (snap.bitmap && this.on.frame) this.on.frame(snap.bitmap);
      else if (snap.bitmap) snap.bitmap.close();
      if (this.on.time) this.on.time(t);
    });
  }

  play() {
    if (this.playing || !this.worker) return;
    if (this.cur.index >= this.frameCount) this.seek(0);
    return this.queue(async () => {
      this.playing = true;
      if (this.on.state) this.on.state(true);
      const t0 = performance.now();
      let ts0 = this.cur.tsUs;
      let skipAt = null; // a hidden I-frame (Mosh cut): its time slot is not played, as in the export
      let lastSnap = this.snaps.length ? this.snaps[this.snaps.length - 1].keyUs : -Infinity;
      for await (const f of this.store.readFrames(this.session.id, this.cur.index)) {
        if (!this.playing) break;
        const m = await this.decode(f, true);
        this.cur = { index: f.index + 1, tsUs: f.tsUs };
        if (f.type === 'hiddenI') {
          if (m.bitmap) m.bitmap.close();
          if (skipAt === null) skipAt = f.tsUs;
          continue;
        }
        if (skipAt !== null) {
          ts0 += f.tsUs - skipAt;
          skipAt = null;
        }
        const due = t0 + (f.tsUs - ts0) / 1000;
        const wait = due - performance.now();
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        if (m.bitmap) {
          if (this.playing && this.on.frame) this.on.frame(m.bitmap);
          else m.bitmap.close();
        }
        if (this.on.time) this.on.time(f.tsUs);
        if (f.tsUs - lastSnap >= SNAPSHOT_EVERY_US && f.type !== 'hiddenI') {
          lastSnap = f.tsUs;
          await this.keepSnapshot();
        }
      }
      if (this.cur.index >= this.frameCount && this.on.time) this.on.time(this.endUs);
      this.playing = false;
      if (this.on.state) this.on.state(false);
    });
  }

  pause() {
    this.playing = false;
  }

  async keepSnapshot() {
    const s = await this.snapshot();
    if (s.bitmap) s.bitmap.close();
    if (this.snaps.some((x) => x.frameIndex === this.cur.index)) return;
    this.snaps.push({ frameIndex: this.cur.index, keyUs: this.cur.tsUs, Y: s.Y, U: s.U, V: s.V });
    this.snaps.sort((a, b) => a.frameIndex - b.frameIndex);
    // Keep the RAM use limited: remove every second snapshot.
    if (this.snaps.length > MAX_SNAPSHOTS) this.snaps = this.snaps.filter((_, i) => i % 2 === 0);
  }
}
