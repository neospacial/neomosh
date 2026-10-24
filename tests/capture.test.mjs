// R-14, R-19: the frame gate keeps the correct count of source frames, with camera jitter.

import { FrameGate, SourceGaps } from '../src/app/capture.js';
import { colourMatrix } from '../src/app/camyuv.js';
import { Kernels } from '../src/codec/wasm.js';
import path from 'node:path';
import { assert, OUT_DIR } from './lib/session.mjs';
import { chromium, openApp, run, checkMp4 } from './lib/app.mjs';

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

// Run the scale_yuv kernel. src: { y, u, v } planar, or NV12 when uv is given.
function scaleYuv(k, src, sw, sh, w, h, mirror, M) {
  const cw = (w + 15 & ~15), chh = (h + 15 & ~15);
  const n = cw * chh, cn = n >> 2;
  const sy = k.alloc(sw * sh), sc = k.alloc(sw * sh), out = k.alloc(n * 1.5), mp = k.alloc(40);
  const scratch = k.alloc(4 * 8 * w), half = k.alloc(sw * sh);
  k.u8(sy, sw * sh).set(src.y);
  let su, sv, sus, step;
  if (src.uv) {
    k.u8(sc, src.uv.length).set(src.uv);
    [su, sv, sus, step] = [sc, sc + 1, sw, 2];
  } else {
    k.u8(sc, src.u.length).set(src.u);
    k.u8(sc + src.u.length, src.v.length).set(src.v);
    [su, sv, sus, step] = [sc, sc + src.u.length, sw >> 1, 1];
  }
  k.i32(mp, 10).set(M);
  k.x.scale_yuv(sy, sw, su, sv, sus, step, sw, sh, out, out + n, out + n + cn, w, h, cw, chh, mirror ? 1 : 0, mp, scratch, half);
  const o = k.u8(out, n * 1.5).slice();
  const crop = (off, pw, ph, stride) => {
    const r = new Uint8Array(pw * ph);
    for (let y = 0; y < ph; y++) r.set(o.subarray(off + y * stride, off + y * stride + pw), y * pw);
    return r;
  };
  return { y: crop(0, w, h, cw), u: crop(n, w >> 1, h >> 1, cw >> 1), v: crop(n + cn, w >> 1, h >> 1, cw >> 1) };
}

const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

export const tests = [
  {
    name: 'camera YUV kernel: identity, mirror, NV12 = I420, colour matrix (D22)',
    fn() {
      const k = Kernels.create();
      if (!k) return console.log('      (skipped: no WebAssembly)');
      const M709 = colourMatrix({ matrix: 'bt709', fullRange: false });
      assert(same(Array.from(M709), [4096, 0, 0, 0, 4096, 0, 0, 0, 4096, 16]), `709 limited is the identity: ${Array.from(M709)}`);
      const w = 64, h = 48;
      const y = new Uint8Array(w * h).map((_, i) => 16 + ((i * 7) % 220));
      const u = new Uint8Array(w * h / 4).map((_, i) => 60 + ((i * 3) % 130));
      const v = new Uint8Array(w * h / 4).map((_, i) => 190 - ((i * 5) % 120));
      const id = scaleYuv(k, { y, u, v }, w, h, w, h, false, M709);
      assert(same(id.y, y) && same(id.u, u) && same(id.v, v), 'same size, same colour space: a copy');
      const mir = scaleYuv(k, { y, u, v }, w, h, w, h, true, M709);
      for (let r = 0; r < h; r++) for (let x = 0; x < w; x++) assert(mir.y[r * w + x] === y[r * w + w - 1 - x], 'mirror');
      const uv = new Uint8Array(w * h / 2);
      for (let i = 0; i < u.length; i++) [uv[2 * i], uv[2 * i + 1]] = [u[i], v[i]];
      const nv = scaleYuv(k, { y, uv }, w, h, 40, 30, false, M709);
      const pl = scaleYuv(k, { y, u, v }, w, h, 40, 30, false, M709);
      assert(same(nv.y, pl.y) && same(nv.u, pl.u) && same(nv.v, pl.v), 'NV12 and I420 give the same output');
      // A 4x reduction (two box halvings) of a flat picture stays flat.
      const flat = scaleYuv(k, { y: new Uint8Array(256 * 192).fill(100), u: new Uint8Array(128 * 96).fill(90), v: new Uint8Array(128 * 96).fill(170) }, 256, 192, 64, 48, false, M709);
      assert(flat.y.every((x) => x === 100) && flat.u.every((x) => x === 90) && flat.v.every((x) => x === 170), 'flat after 4x reduction');
      // BT.601 full range to BT.709 limited: compare with a float reference on flat colours.
      const M = colourMatrix({ matrix: 'smpte170m', fullRange: true });
      for (const [Y, U, V] of [[0, 128, 128], [255, 128, 128], [128, 128, 128], [82, 90, 240], [145, 54, 34], [41, 240, 110]]) {
        const r = scaleYuv(k, { y: new Uint8Array(16 * 16).fill(Y), u: new Uint8Array(64).fill(U), v: new Uint8Array(64).fill(V) }, 16, 16, 16, 16, false, M);
        const yn = Y / 255, un = (U - 128) / 255, vn = (V - 128) / 255;
        const R = yn + 1.402 * vn, B = yn + 1.772 * un, G = (yn - 0.299 * R - 0.114 * B) / 0.587;
        const Y7 = 0.2126 * R + 0.7152 * G + 0.0722 * B;
        const want = [16 + 219 * Y7, 128 + 224 * (B - Y7) / 1.8556, 128 + 224 * (R - Y7) / 1.5748].map((x) => Math.min(255, Math.max(0, Math.round(x))));
        const got = [r.y[0], r.u[0], r.v[0]];
        assert(got.every((g, i) => Math.abs(g - want[i]) <= 1), `601 full (${Y},${U},${V}) -> ${got}, want ${want}`);
      }
    },
  },
  {
    name: 'source gaps: missed frames are counted; a slow or jittery source is not',
    fn() {
      let s = 3;
      const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
      const count = (fps, n, skip, jitter = 2) => {
        const g = new SourceGaps();
        let missed = 0;
        for (let i = 0; i < n; i++) {
          if (skip(i)) continue;
          missed += g.next((i * 1000) / fps + (rnd() * 2 - 1) * jitter);
        }
        return missed;
      };
      assert(count(30, 900, () => false) === 0, 'jitter only');
      assert(count(15, 900, () => false) === 0, 'slow source');
      assert(count(30, 900, (i) => i % 20 === 19) === 44, `each 20th missed: ${count(30, 900, (i) => i % 20 === 19)}`);
      assert(count(30, 900, (i) => i >= 300 && i < 303) === 3, 'a gap of 3 frames');
      // The camera changes from 30 to 15 fps (low light): only a few frames count while it adapts.
      const change = count(30, 900, (i) => i >= 450 && i % 2 === 1);
      assert(change <= 10, `rate change: ${change}`);
    },
  },
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
            await page.click('#gearBtn');
            const info = await page.$eval('#info', (e) => e.textContent);
            await page.click('#settingsSheet .done');
            let sourceFrames;
            if (/Capture: worker/.test(info)) {
              sourceFrames = Math.round(span * 30) + 1; // the y4m camera gives exactly 30 fps
            } else {
              const seen = await page.evaluate(() => window.__seen);
              sourceFrames = seen[seen.length - 1] - seen[0] + 1;
            }
            assert(Math.abs(f.length + drops - sourceFrames) <= 1,
              `${sourceFrames} source frames, ${f.length} stored, ${drops} drops shown (largest gap ${maxGap.toFixed(1)} ms; ${info})`);
            assert(maxGap < 40 || drops > 0, `a gap of ${maxGap.toFixed(1)} ms with no drop`);
          }
        } finally {
          await h.close();
        }
      }
    },
  },
  {
    name: 'app without MediaStreamTrackProcessor on the page (as Safari): records at 30 fps, valid info',
    async fn() {
      if (!chromium) return console.log('      (skipped: Playwright is not available)');
      const y4m = path.join(OUT_DIR, 'cam30.y4m');
      const h = await openApp('nomstp', { cameraFile: y4m, init: () => { delete window.MediaStreamTrackProcessor; } });
      try {
        const { page } = h;
        await h.start();
        await h.clip(2500);
        await h.clip(1500); // a second clip: the capture path starts again
        const f = (await h.db()).frames;
        const clip2 = f.filter((x) => x.type !== 'hiddenI').slice(-30);
        const rate = (clip2.length - 1) / ((clip2[clip2.length - 1].tsUs - clip2[0].tsUs) / 1e6);
        assert(Math.abs(rate - 30) < 1, `rate ${rate.toFixed(2)}`);
        await page.click('#gearBtn');
        const info = await page.$eval('#info', (e) => e.textContent);
        console.log(`      ${info.match(/Capture: \w+/)[0]}`);
        assert(!h.errors.length, `page errors: ${h.errors.join(' | ')}`);
      } finally {
        await h.close();
      }
    },
  },
  {
    name: 'app with a camera-like source: the YUV colour check passes, the fastest way wins; forced YUV records at 30 fps',
    async fn() {
      if (!chromium) return console.log('      (skipped: Playwright is not available)');
      const y4m = path.join(OUT_DIR, 'camnat540.y4m');
      run('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=960x540:rate=30,eq=contrast=0.75:saturation=0.6,noise=alls=14:allf=t',
        '-t', '4', '-pix_fmt', 'yuv420p', y4m]);
      // The automatic choice: the colour check passes, and the way with the least time wins.
      const h0 = await openApp('camauto', { cameraFile: y4m });
      try {
        await h0.start();
        await h0.clip(2500);
        await h0.page.click('#gearBtn');
        const info = await h0.page.$eval('#info', (e) => e.textContent);
        const m = info.match(/Capture: worker \(([a-z]+); ([^;]*); yuv check Y ([\d.]+), U ([\d.]+), V ([\d.]+)/);
        console.log(`      ${m ? m[0] : info}`);
        assert(m && Number(m[3]) < 3 && Number(m[4]) < 3 && Number(m[5]) < 3, 'the YUV colour check must pass');
        const times = Object.fromEntries(m[2].split(', ').map((t) => t.split(' ')).map(([k, v]) => [k, Number(v)]));
        assert(times[m[1]] === Math.min(...Object.values(times)), `the chosen way is not the fastest: ${m[2]}`);
      } finally {
        await h0.close();
      }
      // The YUV way (forced): records at 30 fps, valid export.
      const h = await openApp('camyuv', { cameraFile: y4m, hash: '#capture=yuv' });
      try {
        const { page } = h;
        await h.start();
        await h.clip(2500);
        await h.clip(2500);
        await page.click('#gearBtn');
        const info = await page.$eval('#info', (e) => e.textContent);
        await page.click('#settingsSheet .done');
        assert(/Capture: worker \(yuv/.test(info), `the YUV way was not used: ${info}`);
        const f = (await h.db()).frames.filter((x) => x.type !== 'hiddenI').slice(-40);
        const rate = (f.length - 1) / ((f[f.length - 1].tsUs - f[0].tsUs) / 1e6);
        assert(Math.abs(rate - 30) < 1, `rate ${rate.toFixed(2)}`);
        const db = await h.db();
        const mp4 = await h.exportMp4('camyuv.mp4');
        const s = db.sessions[0];
        const c = checkMp4(mp4, s.w, s.h);
        assert(c.count === db.frames.filter((x) => x.type !== 'hiddenI').length, 'frame count');
        assert(!h.errors.length, `page errors: ${h.errors.join(' | ')}`);
      } finally {
        await h.close();
      }
    },
  },
];
