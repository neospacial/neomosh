// Phases 3 and 4: the built app in Chromium with a fake camera.
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

// Start the browser and the app page. Returns helpers.
async function openApp(name) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'app.html'), buildPage('app/index.html'));
  const srv = await serve(OUT_DIR);
  const browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, acceptDownloads: true });
  // Count the JavaScript callbacks (timers, frames) and the messages to the workers.
  await ctx.addInitScript(() => {
    window.__activity = { timers: 0, frames: 0, workerPosts: 0 };
    const a = window.__activity;
    const wrap = (fn, key) => (typeof fn === 'function' ? function (...x) { a[key]++; return fn.apply(this, x); } : fn);
    const st = window.setTimeout, si = window.setInterval, raf = window.requestAnimationFrame;
    window.setTimeout = (fn, ...r) => st(wrap(fn, 'timers'), ...r);
    window.setInterval = (fn, ...r) => si(wrap(fn, 'timers'), ...r);
    window.requestAnimationFrame = (fn) => raf(wrap(fn, 'frames'));
    const rvfc = HTMLVideoElement.prototype.requestVideoFrameCallback;
    if (rvfc) HTMLVideoElement.prototype.requestVideoFrameCallback = function (fn) { return rvfc.call(this, wrap(fn, 'frames')); };
    const post = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (...x) { a.workerPosts++; return post.apply(this, x); };
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  const url = `http://127.0.0.1:${srv.address().port}/app.html`;
  await page.goto(url);
  let shot = 0;
  const h = {
    page, errors, url,
    waitState: (s) => page.waitForSelector(`body[data-state="${s}"]`, { timeout: 30000 }),
    shot: (label) => page.screenshot({ path: path.join(OUT_DIR, `${name}_${++shot}_${label}.png`) }),
    async close() {
      await browser.close();
      srv.close();
    },
    async start() {
      await page.click('#gateBtn');
      await h.waitState('idle');
      await page.waitForFunction(() => document.getElementById('preview').videoWidth > 0);
    },
    async clip(ms) {
      await page.click('#shutter');
      await h.waitState('recording');
      await page.waitForTimeout(ms);
      await page.click('#shutter');
      await h.waitState('paused');
    },
    canvas: (id) => page.evaluate((id) => {
      const c = document.getElementById(id);
      return { w: c.width, h: c.height, data: Array.from(c.getContext('2d').getImageData(0, 0, c.width, c.height).data) };
    }, id),
    db: () => page.evaluate(() => new Promise((resolve) => {
      const r = indexedDB.open('neomosh');
      r.onsuccess = () => {
        const tx = r.result.transaction(['sessions', 'frames', 'points']);
        const out = {};
        let n = 3;
        const fin = () => --n === 0 && resolve(out);
        tx.objectStore('sessions').getAll().onsuccess = (e) => { out.sessions = e.target.result; fin(); };
        tx.objectStore('frames').getAll().onsuccess = (e) => {
          const f = e.target.result;
          out.frames = f.map((x) => ({ index: x.index, type: x.type, tsUs: x.tsUs }));
          fin();
        };
        tx.objectStore('points').getAll().onsuccess = (e) => {
          out.points = e.target.result.map((p) => ({ n: p.n, frameIndex: p.frameIndex, tsUs: p.tsUs, ref: !!p.refY }));
          fin();
        };
      };
    })),
    async exportMp4(file) {
      await page.click('#exportBtn');
      await page.waitForSelector('body[data-sheet="export"]');
      await page.click('#exportGo');
      await page.waitForSelector('#exportDownload:not([hidden])', { timeout: 30000 });
      const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#exportDownload')]);
      assert(/^neomosh_\d{8}_\d{6}\.mp4$/.test(dl.suggestedFilename()), `file name ${dl.suggestedFilename()}`);
      const mp4 = path.join(OUT_DIR, file);
      await dl.saveAs(mp4);
      await page.click('#exportSheet .done');
      await h.waitState('paused');
      return mp4;
    },
  };
  return h;
}

// FFmpeg checks (§13.1 checks 2 and 5) and the decoded frames (yuv420p, visible size).
function checkMp4(mp4, w, h) {
  const c2 = run('ffmpeg', ['-hide_banner', '-v', 'warning', '-i', mp4, '-fps_mode', 'passthrough', '-enc_time_base:v', 'demux', '-f', 'null', '-']);
  assert(c2.status === 0 && c2.stderr.toString().trim() === '', `ffmpeg: ${c2.stderr}`);
  const types = run('ffprobe', ['-v', 'error', '-show_entries', 'frame=pict_type', '-of', 'csv=p=0', mp4]).stdout.toString().trim().split('\n');
  const yuv = run('ffmpeg', ['-v', 'error', '-i', mp4, '-fps_mode', 'passthrough', '-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-']).stdout;
  const fsz = (w * h * 3) / 2;
  assert(yuv.length === fsz * types.length, 'decoded size');
  return { types, frame: (i) => yuv.subarray(i * fsz, (i + 1) * fsz), count: types.length, yuv, fsz };
}

function toRgba(yuvFrame, w, h) {
  const rgba = new Uint8Array(w * h * 4);
  yuv420ToRgba(yuvFrame.subarray(0, w * h), yuvFrame.subarray(w * h, w * h * 1.25), yuvFrame.subarray(w * h * 1.25), w, w, h, rgba);
  return rgba;
}

function maxDiff(a, b) {
  assert(a.length === b.length, `size ${a.length} != ${b.length}`);
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
}

function samePixels(a, b, what) {
  assert(a.w === b.w && a.h === b.h, `${what}: size`);
  assert(maxDiff(a.data, b.data) === 0, `${what}: pixels differ`);
}

export const tests = [
  {
    name: 'record, pause (overlay), resume (mosh), export a valid MP4',
    async fn() {
      if (!chromium) return console.log('      (skipped: Playwright is not available)');
      const h = await openApp('app');
      try {
        const { page } = h;
        await h.start();
        await h.shot('idle');
        await page.click('#shutter');
        await h.waitState('recording');
        await page.waitForTimeout(2000);
        assert(await page.isVisible('#mosh'), 'the decoded viewfinder is not visible while recording');
        await h.shot('recording');
        await page.click('#shutter');
        await h.waitState('paused');
        assert(await page.isVisible('#overlay') && await page.isVisible('#guideBar'), 'overlay or guide bar not visible when paused');
        assert(await page.$eval('#thumbImg', (i) => !!i.getAttribute('src')), 'no thumbnail');
        assert(await page.$eval('#orientBtn', (b) => b.disabled), 'the ratio bar must lock after the first frame');
        await h.shot('paused');
        await h.clip(1500);
        assert(!(await page.isVisible('#mosh')), 'the decoded viewfinder must hide when paused');
        // Nothing runs while paused: no timers, no frame callbacks, no work for the workers.
        await page.waitForTimeout(3000); // the last toast and storage timers end
        const act0 = await page.evaluate(() => ({ ...window.__activity }));
        await page.waitForTimeout(2000);
        const act1 = await page.evaluate(() => ({ ...window.__activity }));
        assert(JSON.stringify(act0) === JSON.stringify(act1), `activity while paused: ${JSON.stringify(act0)} -> ${JSON.stringify(act1)}`);
        const overlay = await h.canvas('overlay');

        const db = await h.db();
        const s = db.sessions[0];
        assert(db.sessions.length === 1, 'one session');
        assert(db.frames.length > 40, `only ${db.frames.length} frames stored`);
        assert(/^idr(,p)+,hiddenI(,p)+$/.test(db.frames.map((f) => f.type).join(',')), 'frame types');
        assert(db.points.map((p) => p.frameIndex).join() === `0,${db.points[1].frameIndex},${db.frames.length}`, 'pause points');
        for (let i = 1; i < db.frames.length; i++) assert(db.frames[i].tsUs > db.frames[i - 1].tsUs, 'timestamps must increase');

        const mp4 = await h.exportMp4('app_export.mp4');
        const m = checkMp4(mp4, s.w, s.h);
        assert(m.count === db.frames.length - 1, `exported ${m.count} frames, expected ${db.frames.length - 1}`);
        assert(m.types[0] === 'I' && m.types.slice(1).every((t) => t === 'P'), 'Mosh export: one I-frame, then P-frames');
        // The last exported picture equals the overlay (the live decoder output).
        assert(overlay.w === s.w && overlay.h === s.h, 'overlay size');
        assert(maxDiff(toRgba(m.frame(m.count - 1), s.w, s.h), overlay.data) <= 2, 'the overlay differs from the exported last frame');
        assert(!h.errors.length, `page errors: ${h.errors.join(' | ')}`);
      } finally {
        await h.close();
      }
    },
  },
  {
    name: 'history: player seek, revert to each point, export after a revert, restore',
    async fn() {
      if (!chromium) return console.log('      (skipped: Playwright is not available)');
      const h = await openApp('hist');
      try {
        const { page } = h;
        await h.start();
        await h.clip(1500);
        const over1 = await h.canvas('overlay');
        await h.clip(1500);
        const over2 = await h.canvas('overlay');
        const mp4A = await h.exportMp4('hist_A.mp4');
        await h.clip(1500);
        const db3 = await h.db();
        const s = db3.sessions[0];
        const A = checkMp4(mp4A, s.w, s.h);

        // Review: four cards (Start and three pause points).
        await page.click('#thumbBtn');
        await h.waitState('review');
        await page.waitForFunction(() => document.querySelectorAll('#cards .card').length === 4);
        await page.waitForTimeout(400);
        await h.shot('review');
        // Seek: the player shows the same picture as the export (first in clip 1, then after the Mosh cut).
        const pts = Object.fromEntries(db3.points.map((p) => [p.n, p]));
        const endUs = pts[3].tsUs; // the session end = the last pause point
        const exported = db3.frames.filter((f) => f.type !== 'hiddenI');
        for (const goal of [pts[1].tsUs * 0.5, pts[1].tsUs + (pts[2].tsUs - pts[1].tsUs) * 0.3, pts[2].tsUs - 1, pts[1].tsUs * 0.2]) {
          const value = Math.round((1000 * goal) / endUs);
          const t = (value / 1000) * endUs;
          await page.$eval('#scrub', (sc, v) => {
            sc.value = v;
            sc.dispatchEvent(new Event('input'));
            sc.dispatchEvent(new Event('change'));
          }, value);
          await page.waitForFunction((t) => Math.abs(Number(document.getElementById('player').dataset.t) - t) < 1, t, { timeout: 20000 });
          let k = -1;
          exported.forEach((f, i) => f.tsUs <= t && (k = i));
          if (k >= A.count) continue; // after the end of export A
          const pic = await h.canvas('player');
          assert(maxDiff(toRgba(A.frame(k), s.w, s.h), pic.data) <= 2, `player picture at ${t} us differs from export frame ${k}`);
        }
        // Playback runs and changes the picture.
        const before = await h.canvas('player');
        await page.click('#playBtn');
        await page.waitForSelector('body[data-playing="1"]');
        await page.waitForTimeout(800);
        await page.click('#playBtn');
        await page.waitForSelector('body[data-playing="0"]');
        assert(maxDiff(before.data, (await h.canvas('player')).data) > 0, 'playback did not change the picture');

        // Revert to point 2 (custom confirm sheet).
        const revert = async (n) => {
          if (!(await page.isVisible('#reviewSheet header'))) {
            await page.click('#thumbBtn');
            await h.waitState('review');
          }
          await page.waitForFunction(() => document.querySelectorAll('#cards .card').length > 0);
          await page.click(`#cards .card:nth-child(${n + 1})`);
          await page.waitForSelector('body[data-confirm="1"]');
          await page.waitForTimeout(300);
          await h.shot(`confirm${n}`);
          const scrolled = await page.evaluate(() => document.getElementById('app').scrollTop + document.body.scrollTop + document.documentElement.scrollTop);
          assert(scrolled === 0, `the page scrolled (${scrolled} px)`);
          await page.click('#confirmYes');
          await h.waitState(n === 0 ? 'idle' : 'paused');
        };
        await revert(2);
        samePixels(await h.canvas('overlay'), over2, 'overlay after revert to 2');
        let db = await h.db();
        assert(db.frames.length === pts[2].frameIndex && db.points.length === 3, `revert 2: ${db.frames.length} frames, ${db.points.length} points`);

        // A new clip after the revert; its export starts with the same pictures as export A.
        await h.clip(1500);
        const mp4B = await h.exportMp4('hist_B.mp4');
        const B = checkMp4(mp4B, s.w, s.h);
        assert(B.count > A.count, 'export B is longer');
        assert(Buffer.compare(B.yuv.subarray(0, A.count * A.fsz), A.yuv) === 0, 'export B does not start with export A');
        assert(B.types[0] === 'I' && B.types.slice(1).every((x) => x === 'P'), 'export B frame types');

        // Revert to point 1, then to the start.
        await revert(1);
        samePixels(await h.canvas('overlay'), over1, 'overlay after revert to 1');
        db = await h.db();
        assert(db.frames.length === pts[1].frameIndex && db.points.length === 2, 'revert 1');
        await revert(0);
        db = await h.db();
        assert(!db.sessions.length && !db.frames.length && !db.points.length, 'revert 0 must delete the session');
        assert(!(await page.$eval('#orientBtn', (b) => b.disabled)), 'the session settings must unlock after revert to 0');

        // Restore after a normal pause (reload the page).
        await h.clip(1500);
        await h.clip(1000);
        const overP = await h.canvas('overlay');
        const dbP = await h.db();
        await page.reload();
        await page.waitForSelector('#gateNew:not([hidden])');
        assert((await page.textContent('#gateBtn')) === 'Continue last video', 'gate button text');
        await page.click('#gateBtn');
        await h.waitState('paused');
        samePixels(await h.canvas('overlay'), overP, 'overlay after restore');
        assert((await h.db()).frames.length === dbP.frames.length, 'frames after restore');

        // Restore after the app closed while recording: the frames after the last point are decoded.
        await page.click('#shutter');
        await h.waitState('recording');
        await page.waitForTimeout(2500);
        await page.reload();
        await page.waitForSelector('#gateNew:not([hidden])');
        await page.click('#gateBtn');
        await h.waitState('paused');
        const dbR = await h.db();
        assert(dbR.frames.length > dbP.frames.length, 'no frames were recovered');
        assert(dbR.points[dbR.points.length - 1].frameIndex === dbR.frames.length, 'restore must make a new pause point');
        const overR = await h.canvas('overlay');
        const mp4R = await h.exportMp4('hist_R.mp4');
        const R = checkMp4(mp4R, s.w, s.h);
        assert(maxDiff(toRgba(R.frame(R.count - 1), s.w, s.h), overR.data) <= 2, 'the restored overlay differs from the export');
        // Recording continues after a restore with a hidden I-frame (a Mosh cut), not an IDR.
        await h.clip(1000);
        const types = (await h.db()).frames.map((f) => f.type);
        assert(types.filter((x) => x === 'idr').length === 1, 'only one IDR after a restore');
        const mp4C = await h.exportMp4('hist_C.mp4');
        checkMp4(mp4C, s.w, s.h);

        // "Start new" deletes the stored video.
        await page.reload();
        await page.waitForSelector('#gateNew:not([hidden])');
        await page.click('#gateNew');
        await h.waitState('idle');
        assert(!(await h.db()).frames.length, 'Start new must delete the video');
        assert(!h.errors.length, `page errors: ${h.errors.join(' | ')}`);
      } finally {
        await h.close();
      }
    },
  },
];
