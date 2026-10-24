// Helpers for the browser tests of the built app (Playwright, Chromium with a fake camera).

import { createRequire } from 'node:module';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildPage } from '../../tools/build.mjs';
import { assert, OUT_DIR } from './session.mjs';
import { yuv420ToRgba } from '../../src/codec/color.js';

export let chromium = null;
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

export const run = (cmd, args) => spawnSync(cmd, args, { maxBuffer: 1 << 30 });

// Start the browser and the app page. Returns helpers.
// init: an extra init script (a function). hash: added to the page URL (for example '#debug').
export async function openApp(name, { camera = true, init = null, hash = '' } = {}) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'app.html'), buildPage('app/index.html'));
  const srv = await serve(OUT_DIR);
  const browser = await chromium.launch({ args: camera ? ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] : [] });
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
  if (init) await ctx.addInitScript(init);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  const url = `http://127.0.0.1:${srv.address().port}/app.html${hash}`;
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
    async exportMp4(file, cuts = 'mosh') {
      await page.click('#exportBtn');
      await page.waitForSelector('body[data-sheet="export"]');
      if ((await page.$$('#cutList button')).length) await page.click(`#allCuts button[data-v="${cuts}"]`);
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
export function checkMp4(mp4, w, h) {
  const c2 = run('ffmpeg', ['-hide_banner', '-v', 'warning', '-i', mp4, '-fps_mode', 'passthrough', '-enc_time_base:v', 'demux', '-f', 'null', '-']);
  assert(c2.status === 0 && c2.stderr.toString().trim() === '', `ffmpeg: ${c2.stderr}`);
  const types = run('ffprobe', ['-v', 'error', '-show_entries', 'frame=pict_type', '-of', 'csv=p=0', mp4]).stdout.toString().trim().split('\n');
  const yuv = run('ffmpeg', ['-v', 'error', '-i', mp4, '-fps_mode', 'passthrough', '-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-']).stdout;
  const fsz = (w * h * 3) / 2;
  assert(yuv.length === fsz * types.length, 'decoded size');
  return { types, frame: (i) => yuv.subarray(i * fsz, (i + 1) * fsz), count: types.length, yuv, fsz };
}

export function toRgba(yuvFrame, w, h) {
  const rgba = new Uint8Array(w * h * 4);
  yuv420ToRgba(yuvFrame.subarray(0, w * h), yuvFrame.subarray(w * h, w * h * 1.25), yuvFrame.subarray(w * h * 1.25), w, w, h, rgba);
  return rgba;
}

export function maxDiff(a, b) {
  assert(a.length === b.length, `size ${a.length} != ${b.length}`);
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
}

export function samePixels(a, b, what) {
  assert(a.w === b.w && a.h === b.h, `${what}: size`);
  assert(maxDiff(a.data, b.data) === 0, `${what}: pixels differ`);
}

