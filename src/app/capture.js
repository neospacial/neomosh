// Frame selection for the target frame rate (R-14, R-19). The page (rVFC) and the capture worker use it.

// R-14: select the source frames for the target frame rate. The timeline has one slot each
// 1000/fps ms. A frame is kept when it is not more than half a slot before its slot, so camera
// jitter does not lose frames, and a 30 fps source at 24 fps gives 24 fps.
// next(t, missed) -> { keep, lost }. missed: source frames that the frame callback did not see.
// lost: empty slots because of those frames (R-19). A slow source alone gives no lost slots.
export class FrameGate {
  constructor(fps) {
    this.period = 1000 / fps;
    this.due = null;
  }

  next(t, missed = 0) {
    const period = this.period;
    if (this.due === null) this.due = t;
    if (t < this.due - period / 2) return { keep: false, lost: 0 }; // before its slot
    const lost = missed > 0 ? Math.min(missed, Math.max(0, Math.floor((t - this.due) / period + 0.5))) : 0;
    // After a gap, the timeline starts again from this frame (no burst of frames to catch up).
    this.due = Math.max(this.due + period, t + period / 2);
    return { keep: true, lost };
  }
}

// R-19 (D22): frames that the camera stream left out because the capture worker was late (a
// MediaStreamTrackProcessor drops old frames when they are not read in time). The source interval is
// the median of the last intervals, so a camera that is slow all the time (low light) gives no drops.
// next(t) -> the number of source frames missed before this one.
export class SourceGaps {
  constructor(n = 15) {
    this.n = n;
    this.dts = [];
    this.last = null;
  }

  next(t) {
    const prev = this.last;
    this.last = t;
    if (prev === null) return 0;
    const dt = t - prev;
    let missed = 0;
    if (this.dts.length >= 5) {
      const s = this.dts.slice().sort((a, b) => a - b);
      const med = s[s.length >> 1];
      if (dt > 1.5 * med) missed = Math.round(dt / med) - 1;
    }
    // The raw interval goes into the history, so the median follows a lasting change of the rate.
    this.dts.push(dt);
    if (this.dts.length > this.n) this.dts.shift();
    return missed;
  }
}
