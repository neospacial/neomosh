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
