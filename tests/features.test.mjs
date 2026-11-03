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
  {
    name: 'rear cameras (D28): lens chips, the selected lens opens, locked while recording; Android labels are numbers',
    async fn() {
      if (!chromium) return skip();
      // Three rear cameras (iPhone labels) and a front camera. Each opens the fake camera, and its
      // track reports the deviceId that was asked for.
      const init = () => {
        const labels = window.__labels || ['Back Camera', 'Back Ultra Wide Camera', 'Back Telephoto Camera', 'Back Dual Wide Camera', 'Front Camera'];
        const md = navigator.mediaDevices;
        const gum = md.getUserMedia.bind(md);
        window.__asked = [];
        md.enumerateDevices = async () => labels.map((label, i) => ({ kind: 'videoinput', deviceId: `cam${i}`, groupId: 'g', label }));
        md.getUserMedia = async (c) => {
          const v = c.video || {};
          const id = v.deviceId && v.deviceId.exact ? v.deviceId.exact : 'cam0';
          window.__asked.push(id);
          const s = await gum({ video: { width: v.width, height: v.height }, audio: false });
          const t = s.getVideoTracks()[0];
          const gs = t.getSettings.bind(t);
          t.getSettings = () => ({ ...gs(), deviceId: id });
          return s;
        };
      };
      const h = await openApp('lenses', { init });
      try {
        const { page } = h;
        await h.start();
        await page.waitForSelector('#lensBar:not([hidden])');
        const chips = () => page.$$eval('#lensBar button', (b) => b.map((x) => x.textContent + (x.classList.contains('active') ? '*' : '')).join(' '));
        assert(await chips() === '0.5× 1×* Tele', `iPhone lenses: ${await chips()}`);
        await page.click('#lensBar button:nth-child(3)');
        await page.waitForFunction(() => document.querySelector('#lensBar button.active') && document.querySelector('#lensBar button.active').textContent === 'Tele');
        assert((await page.evaluate(() => window.__asked)).slice(-1)[0] === 'cam2', 'the telephoto camera was asked for');
        const ready = () => page.waitForFunction(() => {
          const v = document.getElementById('preview');
          return v.readyState >= 2 && v.videoWidth > 0 && !document.getElementById('shutter').disabled;
        });
        await ready();
        await page.click('#shutter');
        await h.waitState('recording');
        assert(await page.$eval('#lensBar', (e) => e.hidden), 'no lens change while recording');
        await page.waitForTimeout(800);
        await page.click('#shutter');
        await h.waitState('paused');
        assert(!(await page.$eval('#lensBar', (e) => e.hidden)), 'the lenses show again while paused');
        await page.click('#lensBar button:nth-child(1)');
        await page.waitForFunction(() => document.querySelector('#lensBar button.active').textContent === '0.5×');
        await ready();
        await h.clip(800);
        const db = await h.db();
        assert(db.frames.length > 20 && db.points.length === 3, 'two clips with two lenses');
        assert(!h.errors.length, `page errors: ${h.errors.join(' | ')}`);
      } finally {
        await h.close();
      }
      // Android labels: numbers, in the order of the list.
      const android = `window.__labels = ['camera2 0, facing back', 'camera2 1, facing front', 'camera2 2, facing back', 'camera2 3, facing back'];(${init.toString()})();`;
      const h2 = await openApp('lenses2', { init: android });
      try {
        await h2.start();
        await h2.page.waitForSelector('#lensBar:not([hidden])');
        const c2 = await h2.page.$$eval('#lensBar button', (b) => b.map((x) => x.textContent + (x.classList.contains('active') ? '*' : '')).join(' '));
        assert(c2 === '1* 2 3', `Android lenses: ${c2}`);
      } finally {
        await h2.close();
      }
    },
  },
  {
    name: 'pinch zoom (D29): two fingers zoom within the camera range; the chip shows the level and goes back to 1×',
    async fn() {
      if (!chromium) return skip();
      // The fake camera gets a zoom range 1..8 (as one Android rear camera with all the lenses).
      const init = () => {
        window.__zoom = [];
        const P = MediaStreamTrack.prototype;
        const caps = P.getCapabilities, sets = P.getSettings, apply = P.applyConstraints;
        let z = 1;
        P.getCapabilities = function () { return { ...(caps ? caps.call(this) : {}), zoom: { min: 1, max: 8, step: 0.1 } }; };
        P.getSettings = function () { return { ...sets.call(this), zoom: z }; };
        P.applyConstraints = function (c) {
          const a = c && c.advanced && c.advanced[0];
          if (a && a.zoom !== undefined) {
            z = a.zoom;
            window.__zoom.push(a.zoom);
            return Promise.resolve();
          }
          return apply.call(this, c);
        };
      };
      const h = await openApp('zoom', { init });
      try {
        const { page } = h;
        await h.start();
        assert(await page.$eval('#zoomChip', (e) => e.hidden), 'no chip at 1×');
        // A pinch: two fingers 100 px apart, then 250 px apart: 2.5×.
        const pinch = (from, to) => page.evaluate(([from, to]) => {
          const f = document.getElementById('frame');
          const r = f.getBoundingClientRect();
          const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
          const ev = (type, id, x) => f.dispatchEvent(new PointerEvent(type, { pointerId: id, clientX: x, clientY: cy, bubbles: true, isPrimary: id === 1 }));
          ev('pointerdown', 1, cx - from / 2);
          ev('pointerdown', 2, cx + from / 2);
          for (let k = 1; k <= 5; k++) ev('pointermove', 2, cx - from / 2 + from + ((to - from) * k) / 5);
          ev('pointerup', 2, cx - from / 2 + to);
          ev('pointerup', 1, cx - from / 2);
        }, [from, to]);
        await pinch(100, 250);
        await page.waitForFunction(() => window.__zoom.length && Math.abs(window.__zoom[window.__zoom.length - 1] - 2.5) < 0.06);
        assert(await page.$eval('#zoomChip', (e) => !e.hidden && e.textContent === '2.5×'), `the chip shows 2.5×: ${await page.$eval('#zoomChip', (e) => e.textContent)}`);
        assert(await page.$eval('#focusBox', (b) => b.style.opacity !== '1'), 'a pinch is not a focus tap');
        // One finger is still a focus tap.
        await page.evaluate(() => {
          const f = document.getElementById('frame');
          const r = f.getBoundingClientRect();
          const o = { pointerId: 7, clientX: r.left + 60, clientY: r.top + 60, bubbles: true, isPrimary: true };
          f.dispatchEvent(new PointerEvent('pointerdown', o));
          f.dispatchEvent(new PointerEvent('pointerup', o));
        });
        assert(await page.$eval('#focusBox', (b) => b.style.opacity === '1'), 'one finger: a focus tap');
        // Far beyond the range: 8× at most.
        await pinch(50, 400);
        await page.waitForFunction(() => window.__zoom[window.__zoom.length - 1] === 8);
        // Zoom works while recording, too.
        await page.click('#shutter');
        await h.waitState('recording');
        await pinch(300, 100);
        await page.waitForFunction(() => Math.abs(window.__zoom[window.__zoom.length - 1] - 2.7) < 0.06);
        await page.click('#shutter');
        await h.waitState('paused');
        // The chip: back to 1×, and it hides.
        await page.click('#zoomChip');
        await page.waitForFunction(() => window.__zoom[window.__zoom.length - 1] === 1);
        await page.waitForFunction(() => document.getElementById('zoomChip').hidden, null, { timeout: 3000 });
        assert(!h.errors.length, `page errors: ${h.errors.join(' | ')}`);
      } finally {
        await h.close();
      }
    },
  },
];
