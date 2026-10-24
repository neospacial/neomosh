// R-14, R-19: the frame gate keeps the correct count of source frames, with camera jitter.

import { FrameGate } from '../src/app/recorder.js';
import path from 'node:path';
import { assert, OUT_DIR } from './lib/session.mjs';
import { chromium, openApp, run } from './lib/app.mjs';

// Source frames at srcFps with uniform jitter. Returns the kept times and the lost slots.
function simulate(srcFps, fps, jitter, n = 3000, skipEvery = 0) {
  let s = 7;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const g = new FrameGate(fps);
  const kept = [];
  let lost = 0, missed = 0;
  for (let i = 0; i < n; i++) {
    if (skipEvery && i % skipEvery === skipEvery - 1) { missed++; continue; } // the callback did not run
    const t = (i * 1000) / srcFps + (rnd() * 2 - 1) * jitter;
    const r = g.next(t, missed);
    missed = 0;
    lost += r.lost;
    if (r.keep) kept.push(t);
  }
  const span = ((n - 1) * 1000) / srcFps;
  return { kept, lost, rate: ((kept.length - 1) * 1000) / span, maxGap: Math.max(...kept.slice(1).map((t, i) => t - kept[i])) };
}

export const tests = [
  {
    name: 'frame gate: jitter loses no frames, and the output rate is the target rate',
    fn() {
      for (const [src, fps, jit] of [[30, 30, 0], [30, 30, 2], [30, 30, 5], [24, 24, 4], [29.97, 30, 1], [60, 60, 3]]) {
        const r = simulate(src, fps, jit);
        assert(r.kept.length === 3000, `${src}->${fps} ±${jit}: kept ${r.kept.length} of 3000`);
        assert(r.lost === 0, `${src}->${fps}: lost ${r.lost}`);
      }
      for (const [src, fps, jit] of [[30, 24, 0], [30, 24, 3], [30, 15, 3], [60, 30, 2], [60, 24, 2]]) {
        const r = simulate(src, fps, jit);
        assert(Math.abs(r.rate - fps) < 0.05, `${src}->${fps} ±${jit}: rate ${r.rate.toFixed(2)}`);
        assert(r.maxGap < (2000 / fps) + 2 * jit + 1, `${src}->${fps}: gap ${r.maxGap.toFixed(1)} ms`);
        assert(r.lost === 0, `${src}->${fps}: lost ${r.lost}`);
      }
    },
  },
  {
    name: 'frame gate: a slow source is not a drop; frames the callback missed are drops (R-19)',
    fn() {
      const slow = simulate(15, 30, 2);
      assert(slow.kept.length === 3000 && slow.lost === 0, 'a 15 fps source at 30 fps keeps all frames, no drops');
      const late = simulate(30, 30, 2, 3000, 10); // each 10th frame not seen (the last one has no next frame)
      assert(late.lost === 299, `missed frames counted: ${late.lost}`);
      assert(late.kept.length === 2700, `kept ${late.kept.length}`);
      // At 15 fps the next source frame fills the slot of a missed frame: the rate stays.
      const half = simulate(30, 15, 2, 3000, 10);
      assert(Math.abs(half.rate - 15) < 0.3, `15 fps: rate ${half.rate.toFixed(2)}`);
      assert(half.lost <= 150, `15 fps: lost ${half.lost}`);
    },
  },
  {
    name: 'app with a 30 fps camera: 30 fps and 24 fps give their rate; each source frame is stored or a drop',
    async fn() {
      if (!chromium) return console.log('      (skipped: Playwright is not available)');
      const y4m = path.join(OUT_DIR, 'cam30.y4m');
      run('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x480:rate=30', '-t', '6', '-pix_fmt', 'yuv420p', y4m]);
      for (const fps of [30, 24]) {
        // The source frames that the page got while recording (rVFC presentedFrames).
        const init = () => {
          window.__seen = [];
          const r = HTMLVideoElement.prototype.requestVideoFrameCallback;
          HTMLVideoElement.prototype.requestVideoFrameCallback = function (fn) {
            return r.call(this, (now, m) => {
              if (this.id === 'preview' && document.body.dataset.state === 'recording') window.__seen.push(m.presentedFrames);
              fn(now, m);
            });
          };
        };
        const h = await openApp(`cam${fps}`, { cameraFile: y4m, init });
        try {
          const { page } = h;
          await h.start();
          await page.click('#gearBtn');
          await page.click(`.seg[data-key="fps"] button[data-v="${fps}"]`);
          await page.click('#settingsSheet .done');
          await h.clip(3000);
          const f = (await h.db()).frames;
          const span = (f[f.length - 1].tsUs - f[0].tsUs) / 1e6;
          const rate = (f.length - 1) / span;
          const maxGap = Math.max(...f.slice(1).map((x, i) => (x.tsUs - f[i].tsUs) / 1000));
          const drops = Number(await page.$eval('#dropN', (e) => e.textContent));
          assert(Math.abs(rate - fps) < 0.6, `target ${fps}: ${rate.toFixed(2)} fps`);
          // At 30 fps each source frame is kept or counted as a drop. A long gap in the source
          // itself is not a drop (R-19).
          if (fps === 30) {
            const seen = await page.evaluate(() => window.__seen);
            const sourceFrames = seen[seen.length - 1] - seen[0] + 1;
            assert(Math.abs(f.length + drops - sourceFrames) <= 1,
              `${sourceFrames} source frames, ${f.length} stored, ${drops} drops shown (largest gap ${maxGap.toFixed(1)} ms)`);
          }
        } finally {
          await h.close();
        }
      }
    },
  },
];
