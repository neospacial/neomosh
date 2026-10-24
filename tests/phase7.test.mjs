// Phase 7: encoder settings, storage full, Upscale export, and the in-browser self-test (plan §13.3).
// Skipped when Playwright is not available.

import { assert } from './lib/session.mjs';
import { chromium, openApp, checkMp4, run } from './lib/app.mjs';

const skip = () => console.log('      (skipped: Playwright is not available)');

// Open the settings sheet, run fn(page), close it.
async function settings(h, fn) {
  await h.page.click('#gearBtn');
  await h.page.waitForSelector('body[data-sheet="settings"]');
  await fn(h.page);
  await h.page.click('#settingsSheet .done');
}
const setRange = (page, id, v) => page.$eval(`#${id}`, (e, v) => {
  e.value = String(v);
  e.dispatchEvent(new Event('input'));
}, v);

export const tests = [
  {
    name: 'settings: encoder settings at both ends of their ranges, locked while recording',
    async fn() {
      if (!chromium) return skip();
      const h = await openApp('set');
      try {
        const { page } = h;
        await h.start();
        const looks = [
          { qp: 44, searchRange: '8', precision: 'full', skipBias: 0, heal: 'high' },
          { qp: 16, searchRange: '64', precision: 'quarter', skipBias: 100, heal: 'low' },
          { qp: 30, searchRange: '16', precision: 'half', skipBias: 50, heal: 'off' },
        ];
        for (const l of looks) {
          await settings(h, async (p) => {
            await setRange(p, 'qp', l.qp);
            await setRange(p, 'skipBias', l.skipBias);
            for (const k of ['searchRange', 'precision', 'heal']) await p.click(`.seg[data-key="${k}"] button[data-v="${l[k]}"]`);
            assert(await p.$eval('#qpVal', (e) => e.textContent) === String(l.qp), 'QP value label');
          });
          await page.click('#shutter');
          await h.waitState('recording');
          await page.waitForTimeout(1200);
          assert(await page.$eval('#qp', (e) => e.disabled), 'QP must lock while recording (R-12)');
          await page.click('#shutter');
          await h.waitState('paused');
        }
        // The encoder settings are kept for each pause point (R-12).
        const looksStored = await page.evaluate(() => new Promise((resolve) => {
          const r = indexedDB.open('neomosh');
          r.onsuccess = () => {
            r.result.transaction('points').objectStore('points').getAll().onsuccess = (e) => resolve(e.target.result.map((p) => p.settings));
          };
        }));
        assert(looksStored.length === 4, `points: ${looksStored.length}`);
        looks.forEach((l, i) => assert(looksStored[i + 1].qp === l.qp && looksStored[i + 1].heal === l.heal, `point ${i + 1} settings`));
        const db = await h.db();
        const s = db.sessions[0];
        const mp4 = await h.exportMp4('set_export.mp4');
        const m = checkMp4(mp4, s.w, s.h);
        assert(m.count === db.frames.filter((f) => f.type !== 'hiddenI').length, 'frame count');
        // Default look button.
        await settings(h, async (p) => {
          await p.click('#encReset');
          assert(await p.$eval('#qp', (e) => e.value) === '28', 'default QP');
        });
        assert(!h.errors.length, `page errors: ${h.errors.join(' | ')}`);
      } finally {
        await h.close();
      }
    },
  },
  {
    name: 'storage full: pause, keep the clips before, toast, then record again',
    async fn() {
      if (!chromium) return skip();
      const init = () => {
        const put = IDBObjectStore.prototype.put;
        IDBObjectStore.prototype.put = function (...a) {
          if (window.__full && this.name === 'frames') throw new DOMException('The quota is full', 'QuotaExceededError');
          return put.apply(this, a);
        };
      };
      const h = await openApp('full', { init });
      try {
        const { page } = h;
        await h.start();
        await h.clip(1200);
        const before = await h.db();
        await page.click('#shutter');
        await h.waitState('recording');
        await page.evaluate(() => (window.__full = true));
        await h.waitState('paused');
        await page.waitForFunction(() => /storage is full/.test(document.getElementById('toast').textContent));
        const after = await h.db();
        assert(after.frames.length === before.frames.length, `frames ${before.frames.length} -> ${after.frames.length}`);
        assert(after.points.length === before.points.length, 'points');
        await page.evaluate(() => (window.__full = false));
        await h.clip(1200);
        const db = await h.db();
        const s = db.sessions[0];
        const m = checkMp4(await h.exportMp4('full_export.mp4'), s.w, s.h);
        assert(m.count === db.frames.filter((f) => f.type !== 'hiddenI').length, 'frame count');
      } finally {
        await h.close();
      }
    },
  },
  {
    name: 'Upscale export: 1080 short side, H.264 from the browser, valid MP4',
    async fn() {
      if (!chromium) return skip();
      const h = await openApp('up');
      try {
        const { page } = h;
        await h.start();
        await h.clip(1500);
        await h.clip(1000);
        await page.click('#exportBtn');
        await page.waitForSelector('body[data-sheet="export"]');
        try {
          await page.waitForSelector('#expMode button[data-v="upscale"]:visible', { timeout: 5000 });
        } catch {
          await page.click('#exportSheet .done');
          return console.log('      (skipped: no H.264 VideoEncoder in this browser)');
        }
        await page.click('#expMode button[data-v="upscale"]');
        await page.click('#expScale button[data-v="smooth"]');
        await page.click('#exportGo');
        await page.waitForSelector('#exportDownload:not([hidden])', { timeout: 60000 });
        const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#exportDownload')]);
        const mp4 = `${process.cwd()}/tests/out/up_export.mp4`;
        await dl.saveAs(mp4);
        const db = await h.db();
        const s = db.sessions[0];
        const dims = run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,nb_frames', '-of', 'csv=p=0', mp4]).stdout.toString().trim().split(',').map(Number);
        const short = Math.min(dims[0], dims[1]);
        assert(short === 1080, `short side ${short}`);
        assert((dims[0] > dims[1]) === (s.w > s.h), 'shape');
        const kept = db.frames.filter((f) => f.type !== 'hiddenI').length;
        assert(dims[2] === kept, `frames ${dims[2]}, expected ${kept}`);
        const c = run('ffmpeg', ['-hide_banner', '-v', 'warning', '-i', mp4, '-f', 'null', '-']);
        assert(c.status === 0 && c.stderr.toString().trim() === '', `ffmpeg: ${c.stderr}`);
        assert(!h.errors.length, `page errors: ${h.errors.join(' | ')}`);
      } finally {
        await h.close();
      }
    },
  },
  {
    name: 'self-test (#debug): the browser VideoDecoder output is identical to ours',
    async fn() {
      if (!chromium) return skip();
      const h = await openApp('self', { hash: '#debug' });
      try {
        const { page } = h;
        await h.start();
        await h.clip(1500);
        await h.clip(1000);
        await page.click('#gearBtn');
        await page.waitForSelector('#selfTest:visible');
        await page.click('#selfTest');
        await page.waitForSelector('#selfTestOut[data-result]', { timeout: 60000 });
        const out = await page.$eval('#selfTestOut', (e) => e.textContent);
        console.log(`      ${out}`);
        assert(await page.$eval('#selfTestOut', (e) => e.dataset.result) === 'pass', out);
        assert(!h.errors.length, `page errors: ${h.errors.join(' | ')}`);
      } finally {
        await h.close();
      }
    },
  },
];
