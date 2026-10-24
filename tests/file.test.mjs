// Phase 5: the file source (plan §11.5). A session mixes camera and file clips in any order, and
// the export is valid. Skipped when Playwright is not available.

import fs from 'node:fs';
import path from 'node:path';
import { assert, OUT_DIR } from './lib/session.mjs';
import { chromium, openApp, checkMp4, run } from './lib/app.mjs';

// A 6 s test video (30 fps, colour bars with a moving pattern), made with FFmpeg.
function testVideo() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const f = path.join(OUT_DIR, 'source_testsrc.mp4');
  if (!fs.existsSync(f)) {
    const r = run('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x480:rate=30:duration=6',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '30', '-movflags', '+faststart', f]);
    assert(r.status === 0, `ffmpeg: ${r.stderr}`);
  }
  return f;
}

// Select a file with the FILE button (the real file picker flow).
async function pickFile(page, file, button = '#srcFile') {
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click(button)]);
  await chooser.setFiles(file);
  await page.waitForSelector('body[data-source="file"]');
  await page.waitForFunction(() => document.getElementById('fileVideo').readyState >= 2);
}

async function seekFile(page, seconds) {
  await page.evaluate((t) => new Promise((resolve) => {
    const v = document.getElementById('fileVideo');
    const sc = document.getElementById('fileScrub');
    v.addEventListener('seeked', () => resolve(), { once: true });
    sc.value = Math.round((1000 * t) / v.duration);
    sc.dispatchEvent(new Event('input'));
    sc.dispatchEvent(new Event('change'));
  }), seconds);
}

const fileState = (page) => page.evaluate(() => {
  const v = document.getElementById('fileVideo');
  return { paused: v.paused, t: v.currentTime, d: v.duration };
});

// Mean of each plane of a yuv420p frame.
function means(frame, w, h) {
  const n = w * h, m = [0, 0, 0];
  for (let i = 0; i < n; i++) m[0] += frame[i];
  for (let i = 0; i < n / 4; i++) {
    m[1] += frame[n + i];
    m[2] += frame[n * 1.25 + i];
  }
  return [m[0] / n, (4 * m[1]) / n, (4 * m[2]) / n];
}

export const tests = [
  {
    name: 'file and camera clips in any order, file end pauses, export valid',
    async fn() {
      if (!chromium) return console.log('      (skipped: Playwright is not available)');
      const video = testVideo();
      const h = await openApp('file');
      try {
        const { page } = h;
        await h.start();
        // Clip 1: the file, from 1.0 s. It starts in IDLE.
        await pickFile(page, video);
        assert(await page.isVisible('#fileBar'), 'the file scrubber must show in IDLE');
        assert(await page.$eval('#flip', (b) => b.disabled), 'the camera switch must be disabled with a file');
        await seekFile(page, 1.0);
        await h.clip(1500);
        let fs1 = await fileState(page);
        assert(fs1.paused, 'the file must pause with the recording');
        assert(fs1.t > 1.8 && fs1.t < 3.4, `the file played from 1.0 s to ${fs1.t} s`);
        assert(await page.isVisible('#fileBar') && await page.isVisible('#overlay'), 'scrubber and overlay when paused');
        await h.shot('file_paused');

        // Clip 2: the camera.
        await page.click('#srcCamera');
        await page.waitForSelector('body[data-source="camera"]');
        assert(!(await page.isVisible('#fileBar')), 'no file scrubber with the camera');
        await h.clip(1500);

        // Clip 3: the file again (no new picker), to its end: an automatic pause.
        await page.click('#srcFile');
        await page.waitForSelector('body[data-source="file"]');
        await seekFile(page, 5.0);
        await page.click('#shutter');
        await h.waitState('recording');
        await page.waitForFunction(() => document.getElementById('toast').textContent === 'The file ended.', null, { timeout: 10000 });
        await h.waitState('paused');
        fs1 = await fileState(page);
        assert(fs1.t > fs1.d - 0.2, 'the file is at its end');
        // At the end, recording does not start again.
        await page.click('#shutter');
        await page.waitForFunction(() => /at its end/.test(document.getElementById('toast').textContent));
        assert((await page.getAttribute('body', 'data-state')) === 'paused', 'no recording at the end of the file');

        // Timestamps: in a file clip, they follow the media time (30 fps file).
        const db = await h.db();
        const s = db.sessions[0];
        const clip1 = db.frames.filter((f) => f.index < db.points[1].frameIndex);
        const d = [];
        for (let i = 1; i < clip1.length; i++) d.push(clip1[i].tsUs - clip1[i - 1].tsUs);
        d.sort((a, b) => a - b);
        const med = d[d.length >> 1];
        assert(Math.abs(med - 33333) < 1500, `median frame time in the file clip ${med} us`);
        for (let i = 1; i < db.frames.length; i++) assert(db.frames[i].tsUs > db.frames[i - 1].tsUs, 'timestamps must increase');
        assert(db.points.length === 4, 'three clips');

        // Export, Mosh and Clean. Clean shows the true content of each clip.
        const mosh = checkMp4(await h.exportMp4('file_mosh.mp4'), s.w, s.h);
        assert(mosh.types[0] === 'I' && mosh.types.slice(1).every((t) => t === 'P'), 'Mosh export frame types');
        const clean = checkMp4(await h.exportMp4('file_clean.mp4', 'clean'), s.w, s.h);
        assert(clean.count === db.frames.length, 'Clean export keeps all frames');
        assert(clean.types.filter((t) => t === 'I').length === 3, 'Clean export: an I-frame at each clip start');
        const iFile = 5, iCam = db.points[1].frameIndex + 5;
        const a = means(clean.frame(iFile), s.w, s.h), b = means(clean.frame(iCam), s.w, s.h);
        const diff = Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
        assert(diff > 15, `the file clip and the camera clip look the same (${a} vs ${b})`);
        assert(!h.errors.length, `page errors: ${h.errors.join(' | ')}`);
      } finally {
        await h.close();
      }
    },
  },
  {
    name: 'no camera: the gate offers a video file, and a file-only session exports',
    async fn() {
      if (!chromium) return console.log('      (skipped: Playwright is not available)');
      const video = testVideo();
      const h = await openApp('nocam', { camera: false });
      try {
        const { page } = h;
        await page.click('#gateBtn');
        await page.waitForSelector('#gateFile:not([hidden])', { timeout: 15000 });
        await h.shot('gate');
        await pickFile(page, video, '#gateFile');
        assert(!(await page.isVisible('#gate')), 'the gate must close');
        await h.waitState('idle');
        await h.clip(1200);
        await seekFile(page, 4.0);
        await h.clip(1200);
        const db = await h.db();
        const s = db.sessions[0];
        const m = checkMp4(await h.exportMp4('nocam.mp4'), s.w, s.h);
        assert(m.count === db.frames.length - 1, 'one cut, Mosh');
        const cam = await page.$eval('#srcCamera', (b) => b.click() || document.body.dataset.source);
        assert(cam === 'file', 'without a camera, CAMERA must not switch the source');
        assert(!h.errors.length, `page errors: ${h.errors.join(' | ')}`);
      } finally {
        await h.close();
      }
    },
  },
];
