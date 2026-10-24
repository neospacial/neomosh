// Phase 3: the built app in Chromium with a fake camera. Record, pause, resume, pause, export.
// Skipped when Playwright is not available.

import { createRequire } from 'node:module';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildPage } from '../tools/build.mjs';
import { assert, OUT_DIR } from './lib/session.mjs';
import { yuv420ToRgba } from '../src/codec/color.js';

let chromium = null;
try {
  chromium = createRequire(import.meta.url)('playwright').chromium;
} catch {
  chromium = null;
}

function serve(dir) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const f = path.join(dir, path.basename(new URL(req.url, 'http://x').pathname) || 'index.html');
      if (!fs.existsSync(f)) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(fs.readFileSync(f));
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

const run = (cmd, args) => spawnSync(cmd, args, { maxBuffer: 1 << 30 });

export const tests = [
  {
    name: 'record, pause (overlay), resume (mosh), export a valid MP4',
    async fn() {
      if (!chromium) {
        console.log('      (skipped: Playwright is not available)');
        return;
      }
      fs.mkdirSync(OUT_DIR, { recursive: true });
      fs.writeFileSync(path.join(OUT_DIR, 'app.html'), buildPage('app/index.html'));
      const srv = await serve(OUT_DIR);
      const browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
      try {
        const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, acceptDownloads: true });
        const page = await ctx.newPage();
        const errors = [];
        page.on('pageerror', (e) => errors.push(e.message));
        page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
        await page.goto(`http://127.0.0.1:${srv.address().port}/app.html`);
        const waitState = (s) => page.waitForSelector(`body[data-state="${s}"]`, { timeout: 20000 });

        await page.click('#gateBtn');
        await waitState('idle');
        await page.waitForFunction(() => document.getElementById('preview').videoWidth > 0);
        await page.screenshot({ path: path.join(OUT_DIR, 'app_idle.png') });

        // Clip 1.
        await page.click('#shutter');
        await waitState('recording');
        await page.waitForTimeout(2000);
        assert(await page.isVisible('#mosh'), 'the decoded viewfinder is not visible while recording');
        await page.screenshot({ path: path.join(OUT_DIR, 'app_recording.png') });
        await page.click('#shutter');
        await waitState('paused');
        assert(await page.isVisible('#overlay') && await page.isVisible('#guideBar'), 'overlay or guide bar not visible when paused');
        assert(await page.$eval('#thumbImg', (i) => !!i.getAttribute('src')), 'no thumbnail');
        assert(await page.$eval('#orientBtn', (b) => b.disabled), 'the ratio bar must lock after the first frame');
        await page.screenshot({ path: path.join(OUT_DIR, 'app_paused.png') });

        // Clip 2 (a Mosh cut).
        await page.click('#shutter');
        await waitState('recording');
        await page.waitForTimeout(1500);
        await page.click('#shutter');
        await waitState('paused');
        assert(!(await page.isVisible('#mosh')), 'the decoded viewfinder must hide when paused');

        // The overlay picture (our decoder, last frame), for the comparison with the export.
        const overlay = await page.evaluate(() => {
          const c = document.getElementById('overlay');
          return { w: c.width, h: c.height, data: Array.from(c.getContext('2d').getImageData(0, 0, c.width, c.height).data) };
        });

        // IndexedDB content (plan §12).
        const db = await page.evaluate(() => new Promise((resolve) => {
          const r = indexedDB.open('neomosh');
          r.onsuccess = () => {
            const tx = r.result.transaction(['sessions', 'frames', 'points']);
            const out = {};
            let n = 3;
            const fin = () => --n === 0 && resolve(out);
            tx.objectStore('sessions').getAll().onsuccess = (e) => { out.sessions = e.target.result.length; out.session = e.target.result[0]; fin(); };
            tx.objectStore('frames').getAll().onsuccess = (e) => {
              const f = e.target.result;
              out.types = f.map((x) => x.type).join(',');
              out.ts = f.map((x) => x.tsUs);
              out.frames = f.length;
              fin();
            };
            tx.objectStore('points').getAll().onsuccess = (e) => { out.points = e.target.result.map((p) => p.frameIndex); out.hasRef = !!e.target.result[0].refY; fin(); };
          };
        }));
        assert(db.sessions === 1, 'one session');
        assert(db.frames > 40, `only ${db.frames} frames stored`);
        assert(/^idr(,p)+,hiddenI(,p)+$/.test(db.types), `frame types ${db.types.slice(0, 80)}`);
        assert(db.points.length === 2 && db.points[1] === db.frames && db.hasRef, `pause points ${db.points}`);
        for (let i = 1; i < db.ts.length; i++) assert(db.ts[i] > db.ts[i - 1], 'timestamps must increase');

        // Export (Original mode, all Mosh).
        await page.click('#exportBtn');
        await page.waitForSelector('body[data-sheet="export"]');
        assert((await page.$$('#cutList button')).length === 1, 'one cut in the export sheet');
        await page.screenshot({ path: path.join(OUT_DIR, 'app_export.png') });
        await page.click('#exportGo');
        await page.waitForSelector('#exportDownload:not([hidden])', { timeout: 30000 });
        const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#exportDownload')]);
        assert(/^neomosh_\d{8}_\d{6}\.mp4$/.test(dl.suggestedFilename()), `file name ${dl.suggestedFilename()}`);
        const mp4 = path.join(OUT_DIR, 'app_export.mp4');
        await dl.saveAs(mp4);

        const c2 = run('ffmpeg', ['-hide_banner', '-v', 'warning', '-i', mp4, '-fps_mode', 'passthrough', '-enc_time_base:v', 'demux', '-f', 'null', '-']);
        assert(c2.status === 0 && c2.stderr.toString().trim() === '', `ffmpeg: ${c2.stderr}`);
        const pr = run('ffprobe', ['-v', 'error', '-show_entries', 'frame=pict_type', '-of', 'csv=p=0', mp4]).stdout.toString().trim().split('\n');
        assert(pr.length === db.frames - 1, `exported ${pr.length} frames, expected ${db.frames - 1}`);
        assert(pr[0] === 'I' && pr.slice(1).every((t) => t === 'P'), 'Mosh export: one I-frame, then P-frames');

        // The last exported picture equals the overlay (the live decoder output).
        const { session } = db;
        const yuv = run('ffmpeg', ['-v', 'error', '-sseof', '-0.5', '-i', mp4, '-fps_mode', 'passthrough', '-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-']).stdout;
        const fsz = (session.w * session.h * 3) / 2;
        const last = yuv.subarray(yuv.length - fsz);
        const rgba = new Uint8Array(session.w * session.h * 4);
        const Y = last.subarray(0, session.w * session.h);
        const U = last.subarray(session.w * session.h, session.w * session.h * 1.25);
        const V = last.subarray(session.w * session.h * 1.25);
        // yuv420ToRgba wants a coded-width stride: use the visible width (the planes are cropped).
        yuv420ToRgba(Y, U, V, session.w, session.w, session.h, rgba);
        assert(overlay.w === session.w && overlay.h === session.h, 'overlay size');
        let maxd = 0;
        for (let i = 0; i < rgba.length; i++) maxd = Math.max(maxd, Math.abs(rgba[i] - overlay.data[i]));
        assert(maxd <= 2, `the overlay differs from the exported last frame (max ${maxd})`);

        assert(!errors.length, `page errors: ${errors.join(' | ')}`);
      } finally {
        await browser.close();
        srv.close();
      }
    },
  },
];
