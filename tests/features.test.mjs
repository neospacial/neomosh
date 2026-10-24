// 1080 size (D23) and Bloom (D24, plan §15) in the app.

import path from 'node:path';
import fs from 'node:fs';
import { assert, simulate, verify, OUT_DIR } from './lib/session.mjs';
import { chromium, openApp, checkMp4, run, toRgba, maxDiff } from './lib/app.mjs';
import { sessionSize } from '../src/app/geometry.js';
import { streamParams } from '../src/codec/headers.js';

const skip = () => console.log('      (skipped: Playwright is not available)');

export const tests = [
  {
    name: '1080: sizes, levels (4.0 at most), and a 1920x1080 stream that FFmpeg decodes the same',
    fn() {
      for (const a of ['1:1', '4:3', '3:2', '16:9']) {
        for (const v of [false, true]) {
          const { w, h } = sessionSize(1080, a, v);
          assert(Math.min(w, h) === 1080, `${a}: ${w}x${h}`);
          // The lowest level that fits: at most 4.0 (smaller shapes and rates can fit 3.1 or 3.2).
          for (const fps of [15, 24, 30]) assert(streamParams(w, h, fps).level <= 40, `${w}x${h}@${fps}: level ${streamParams(w, h, fps).level}`);
        }
      }
      assert(streamParams(1920, 1080, 30).level === 40, '1920x1080 at 30 fps: level 4.0');
      const sim = simulate({ w: 1920, h: 1080, script: [{ record: 4, content: 'square' }, { pause: true }, { record: 2, content: 'pan' }] });
      verify('size1080', sim);
    },
  },
  {
    name: 'app at 1080: records, and the export is 1080 (level 4.0); no Upscale option',
    async fn() {
      if (!chromium) return skip();
      const y4m = path.join(OUT_DIR, 'cam1080s.y4m');
      if (!fs.existsSync(y4m)) {
        run('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30,eq=contrast=0.75:saturation=0.6', '-t', '2', '-pix_fmt', 'yuv420p', y4m]);
      }
      const h = await openApp('r1080', { cameraFile: y4m });
      try {
        const { page } = h;
        await h.start();
        await page.click('#gearBtn');
        await page.click('.seg[data-key="size"] button[data-v="1080"]');
        await page.click('#settingsSheet .done');
        await page.click('.ratio[data-a="16:9"]');
        await h.clip(1500);
        const db = await h.db();
        const s = db.sessions[0];
        assert(Math.min(s.w, s.h) === 1080 && Math.max(s.w, s.h) === 1920, `session ${s.w}x${s.h}`);
        await page.click('#exportBtn');
        await page.waitForSelector('body[data-sheet="export"]');
        await page.waitForTimeout(1000);
        assert(await page.$eval('#expMode', (e) => e.parentElement.hidden), 'no Upscale option for a 1080 session');
        await page.click('#exportSheet .done');
        const mp4 = await h.exportMp4('r1080.mp4');
        const m = checkMp4(mp4, s.w, s.h);
        assert(m.count === db.frames.length, 'frame count');
        const lv = run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=level,width,height', '-of', 'csv=p=0', mp4]).stdout.toString().trim();
        assert(lv === `${s.w},${s.h},40`, `stream ${lv}`);
        assert(!h.errors.length, `page errors: ${h.errors.join(' | ')}`);
      } finally {
        await h.close();
      }
    },
  },
  {
    name: 'Bloom clip (D24): hold the button while paused; a new pause point; the next clip starts from the bloomed picture',
    async fn() {
      if (!chromium) return skip();
      const h = await openApp('bloom');
      try {
        const { page } = h;
        await h.start();
        assert(!(await page.isVisible('#bloomBtn')), 'no Bloom button before the first clip');
        await page.click('#shutter');
        await h.waitState('recording');
        assert(!(await page.isVisible('#bloomBtn')), 'no Bloom button while recording');
        await page.waitForTimeout(1200);
        await page.click('#shutter');
        await h.waitState('paused');
        const db0 = await h.db();
        assert(await page.isVisible('#bloomBtn'), 'the Bloom button shows while paused');
        const box = await page.$eval('#bloomBtn', (e) => { const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
        await page.mouse.move(box.x, box.y);
        await page.mouse.down();
        await h.waitState('blooming');
        await page.waitForTimeout(800);
        assert(await page.$eval('#bloomBtn', (e) => e.classList.contains('on')), 'the button shows that Bloom is on');
        await page.mouse.up();
        await h.waitState('paused');
        const overBloom = await h.canvas('overlay');
        const frames = await page.evaluate(() => new Promise((resolve) => {
          const r = indexedDB.open('neomosh');
          r.onsuccess = () => {
            r.result.transaction('frames').objectStore('frames').getAll().onsuccess = (e) => resolve(e.target.result.map((f) => ({ bloom: f.bloom, type: f.type, bits: Array.from(f.bits.slice(0, 64)).join(), bitLen: f.bitLen })));
          };
        }));
        const blooms = frames.slice(db0.frames.length);
        assert(blooms.length >= 10 && blooms.every((f) => f.bloom && f.type === 'p'), `bloom clip: ${blooms.length} frames`);
        const src = frames.slice(0, db0.frames.length).reverse().find((f) => f.type === 'p');
        assert(blooms.every((f) => f.bitLen === src.bitLen && f.bits === src.bits), 'each bloom frame is a copy of the last recorded P-frame');
        const db1 = await h.db();
        assert(db1.points.length === db0.points.length + 1 && db1.points[db1.points.length - 1].frameIndex === frames.length, 'the bloom clip makes a pause point');
        // The bloomed picture is the overlay and the last picture of the export (Mosh).
        const s = db1.sessions[0];
        const A = checkMp4(await h.exportMp4('bloom_a.mp4'), s.w, s.h);
        assert(maxDiff(toRgba(A.frame(A.count - 1), s.w, s.h), overBloom.data) <= 2, 'the overlay is the bloomed picture');
        // The next clip starts with a hidden I-frame (a cut); the export stays valid.
        await h.clip(800);
        const db2 = await h.db();
        assert(db2.frames[frames.length].type === 'hiddenI', 'the next clip starts with a hidden I-frame');
        const B = checkMp4(await h.exportMp4('bloom_b.mp4'), s.w, s.h);
        assert(B.count === db2.frames.filter((f) => f.type !== 'hiddenI').length, 'frame count');
        assert(!h.errors.length, `page errors: ${h.errors.join(' | ')}`);
      } finally {
        await h.close();
      }
    },
  },
];
