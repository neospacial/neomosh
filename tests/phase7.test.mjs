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
  {
    name: 'self-test with RGB decoder output (as Chrome on Android): the luma is compared, PASS',
    async fn() {
      if (!chromium) return skip();
      // The VideoDecoder output becomes an RGB VideoFrame (drawn on a canvas), as on Android.
      const init = () => {
        const VD = window.VideoDecoder;
        if (!VD) return;
        window.VideoDecoder = class extends VD {
          constructor(init) {
            const c = new OffscreenCanvas(16, 16);
            const ctx = c.getContext('2d');
            super({
              ...init,
              output: (f) => {
                c.width = f.displayWidth;
                c.height = f.displayHeight;
                ctx.drawImage(f, 0, 0);
                const g = new VideoFrame(c, { timestamp: f.timestamp });
                f.close();
                init.output(g);
              },
            });
          }
        };
      };
      const h = await openApp('selfrgb', { hash: '#debug', init });
      try {
        const { page } = h;
        await h.start();
        await h.clip(1500);
        await h.clip(1000);
        await page.click('#gearBtn');
        await page.click('#selfTest');
        await page.waitForSelector('#selfTestOut[data-result]', { timeout: 90000 });
        const out = await page.$eval('#selfTestOut', (e) => e.textContent);
        console.log(`      ${out.replace(/\n/g, '\n      ')}`);
        assert(/Close: \d+ frames \(the browser gives RGB/.test(out), 'the RGB path was not used');
        assert(await page.$eval('#selfTestOut', (e) => e.dataset.result) === 'pass', out);
      } finally {
        await h.close();
      }
    },
  },
  {
    name: 'settings (D26): themes, the info section (closed, plain), the frame-rate hint only after a clip',
    async fn() {
      if (!chromium) return skip();
      // A very slow saved speed: before a clip, it must not show a hint.
      const init = () => localStorage.setItem('neomosh.speed2', JSON.stringify({ enc: 900, cap: 900 }));
      const h = await openApp('themes', { init });
      try {
        const { page } = h;
        await h.start();
        const accent = () => page.$eval('.seg[data-key="theme"] button.active', (b) => getComputedStyle(b).backgroundColor);
        const core = () => page.$eval('#core', (c) => getComputedStyle(c).backgroundColor);
        await page.click('#gearBtn');
        assert(await page.$eval('html', (e) => e.dataset.theme) === 'default', 'the default theme');
        assert(await accent() === 'rgb(153, 255, 0)', 'Default: #99ff00 accent');
        // D27: Default: the red of the UI is #ff0080; the record button is the orb (the core is clear).
        assert(await page.$eval('#recDot', (e) => getComputedStyle(e).backgroundColor) === 'rgb(255, 0, 128)', 'Default: #ff0080 recording dot');
        assert(await core() === 'rgba(0, 0, 0, 0)' && await page.$eval('.orb', (e) => getComputedStyle(e).display === 'block' && getComputedStyle(e).opacity === '1'), 'Default: the orb when not recording');
        // The info section: closed, with the plain lines; the details only with #debug.
        assert(await page.$eval('#infoBox', (d) => !d.open), 'the info section is closed by default');
        assert(await page.$eval('#info', (e) => e.hidden), 'the details are hidden without #debug');
        assert(await page.$eval('#fpsHint', (e) => e.hidden), 'no frame-rate hint before the first clip');
        await page.click('#infoBox summary');
        const plain = await page.$eval('#infoBox', (d) => d.innerText);
        assert(/Dropped frames/.test(plain) && /Storage: \d+ MB used/.test(plain) && /(reads|scales|takes) the camera|reads the raw camera/.test(plain), `info: ${plain}`);
        // Recording (Default): the orb goes, the core is the green square.
        await page.click('#settingsSheet .done');
        await page.click('#shutter');
        await h.waitState('recording');
        await page.waitForTimeout(400);
        assert(await core() === 'rgb(153, 255, 0)' && await page.$eval('.orb', (e) => getComputedStyle(e).opacity === '0'), 'Default: the green square while recording');
        await page.click('#shutter');
        await h.waitState('paused');
        await page.click('#gearBtn');
        // The dropped-frames badge has the warning colour of the theme.
        const warn = () => page.$eval('#dropBadge', (e) => getComputedStyle(e).color);
        assert(await warn() === 'rgb(255, 0, 128)', `Default: the badge is #ff0080: ${await warn()}`);
        const want = { os: ['rgb(255, 214, 10)', 'rgb(255, 59, 48)', 'rgb(255, 159, 10)'], contrast: ['rgb(255, 255, 255)', 'rgb(255, 255, 255)', 'rgb(255, 255, 255)'],
          night: ['rgb(232, 178, 125)', 'rgb(217, 120, 90)', 'rgb(217, 160, 91)'] };
        for (const [t, [a, r, wn]] of Object.entries(want)) {
          await page.click(`.seg[data-key="theme"] button[data-v="${t}"]`);
          await page.waitForTimeout(300); // the record colour fades in (.18 s)
          assert(await accent() === a && await core() === r, `${t}: accent ${await accent()}, record ${await core()}`);
          assert(await warn() === wn, `${t}: badge ${await warn()}`);
          assert(await page.$eval('.orb', (e) => getComputedStyle(e).display === 'none'), `${t}: no orb`);
        }
        await page.click('#settingsSheet .done');
        // D27: reduced motion: no orb, the solid green button.
        await page.click('#gearBtn');
        await page.click(`.seg[data-key="theme"] button[data-v="default"]`);
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await page.waitForTimeout(300);
        assert(await page.$eval('.orb', (e) => getComputedStyle(e).display === 'none') && await core() === 'rgb(153, 255, 0)', 'reduced motion: the solid green button');
        await page.emulateMedia({ reducedMotion: 'no-preference' });
        await page.click(`.seg[data-key="theme"] button[data-v="night"]`);
        await page.click('#settingsSheet .done');
        // The theme stays after a reload.
        await page.reload();
        await page.waitForSelector('#gate');
        assert(await page.$eval('html', (e) => e.dataset.theme) === 'night', 'the theme is kept');
        assert(!h.errors.length, `page errors: ${h.errors.join(' | ')}`);
      } finally {
        await h.close();
      }
    },
  },
];
