// Phase 6: audio in the built app (plan §10). This Chromium has no AAC encoder, so a stand-in
// (tests/lib/app.mjs aacShim) receives the PCM, and gives real silent AAC frames from FFmpeg.
// Skipped when Playwright is not available.

import fs from 'node:fs';
import path from 'node:path';
import { assert, OUT_DIR } from './lib/session.mjs';
import { chromium, openApp, checkMp4, run } from './lib/app.mjs';
import { aacFrames } from './lib/aac.mjs';

function silentAac(sampleRate) {
  const { asc, frames } = aacFrames(['-f', 'lavfi', '-i', `anullsrc=r=${sampleRate}:cl=stereo`, '-t', '0.5'], sampleRate);
  return { asc, frame: frames[Math.floor(frames.length / 2)] };
}

// A 4 s test video: a white flash and a 1 kHz click, both at exactly 2.0 s.
function flashVideo() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const f = path.join(OUT_DIR, 'source_flash.mp4');
  if (!fs.existsSync(f)) {
    const r = run('ffmpeg', ['-v', 'error', '-y',
      '-f', 'lavfi', '-i', "color=c=black:s=640x480:r=30:d=4,drawbox=x=0:y=0:w=640:h=480:color=white:t=fill:enable='between(t,2,2.099)'",
      '-f', 'lavfi', '-i', "aevalsrc='if(between(t,2,2.1),0.8*sin(2*PI*1000*t),0)|if(between(t,2,2.1),0.8*sin(2*PI*1000*t),0)':s=48000:d=4",
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '30', '-c:a', 'aac', '-b:a', '160k', '-shortest', '-movflags', '+faststart', f]);
    assert(r.status === 0, `ffmpeg: ${r.stderr}`);
  }
  return f;
}

// The stored audio: total samples, and the PCM, from IndexedDB.
const storedAudio = (page) => page.evaluate(() => new Promise((resolve) => {
  const r = indexedDB.open('neomosh');
  r.onsuccess = () => {
    const tx = r.result.transaction(['audio', 'points', 'sessions']);
    const out = {};
    let n = 3;
    const fin = () => --n === 0 && resolve(out);
    tx.objectStore('audio').getAll().onsuccess = (e) => {
      const c = e.target.result.sort((a, b) => a.startSample - b.startSample);
      out.chunks = c.map((x) => [x.startSample, x.pcm.length / 2]);
      let peak = 0;
      for (const x of c) for (let i = 0; i < x.pcm.length; i++) peak = Math.max(peak, Math.abs(x.pcm[i]));
      out.peak = peak;
      fin();
    };
    tx.objectStore('points').getAll().onsuccess = (e) => { out.points = e.target.result.map((p) => ({ n: p.n, tsUs: p.tsUs, audioSamples: p.audioSamples })); fin(); };
    tx.objectStore('sessions').getAll().onsuccess = (e) => { out.session = e.target.result[0]; fin(); };
  };
}));

function checkContiguous(a) {
  let next = 0;
  for (const [start, len] of a.chunks) {
    assert(start === next, `audio gap or overlap at sample ${start} (expected ${next})`);
    next = start + len;
  }
  return next;
}

export const tests = [
  {
    name: 'no AAC encoder: the badge shows, and the export is video only',
    async fn() {
      if (!chromium) return console.log('      (skipped: Playwright is not available)');
      const h = await openApp('noaac');
      try {
        const { page } = h;
        await h.start();
        assert((await page.getAttribute('body', 'data-noaudio')) === '1', 'the audio badge must show');
        await page.click('#micBadge');
        await page.waitForFunction(() => /no AAC encoder/.test(document.getElementById('toast').textContent));
        await h.clip(1000);
        const db = await h.db();
        assert(db.sessions[0].audio === false, 'session.audio must be false');
        const mp4 = await h.exportMp4('noaac.mp4');
        const streams = run('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', mp4]).stdout.toString().trim();
        assert(streams === 'video', `streams: ${streams}`);
      } finally {
        await h.close();
      }
    },
  },
  {
    name: 'microphone audio: exact clip length at each pause, revert, export with AAC',
    async fn() {
      if (!chromium) return console.log('      (skipped: Playwright is not available)');
      const h = await openApp('aacmic', { aac: silentAac(44100) });
      try {
        const { page } = h;
        await h.start();
        assert((await page.getAttribute('body', 'data-noaudio')) === '0', 'audio must be on');
        await h.clip(2000);
        await h.clip(1500);
        await h.clip(1200);
        // While paused, the audio does not run (the AudioContext is suspended).
        const ctxStates = await page.evaluate(() => window.__audioContexts.map((c) => c.state));
        assert(ctxStates.length && ctxStates.every((x) => x === 'suspended'), `AudioContext states while paused: ${ctxStates}`);
        let a = await storedAudio(page);
        const sr = a.session.sampleRate;
        assert(a.session.audio === true && sr > 0, 'session audio');
        // R-30: at each pause point, audio = video length.
        for (const p of a.points) {
          assert(p.audioSamples === Math.round((p.tsUs * sr) / 1e6), `point ${p.n}: ${p.audioSamples} samples for ${p.tsUs} us`);
        }
        const last = a.points.reduce((x, p) => (p.n > x.n ? p : x));
        assert(checkContiguous(a) === last.audioSamples, 'stored audio length');
        assert(a.peak > 1000, `the microphone gave no sound (peak ${a.peak})`);

        // Revert to point 2: the audio is cut at point 2.
        await page.click('#thumbBtn');
        await h.waitState('review');
        await page.waitForFunction(() => document.querySelectorAll('#cards .card').length === 4);
        await page.click('#cards .card:nth-child(3)');
        await page.click('#confirmYes');
        await h.waitState('paused');
        a = await storedAudio(page);
        const p2 = a.points.find((p) => p.n === 2);
        assert(checkContiguous(a) === p2.audioSamples, 'audio after the revert');
        await h.clip(1000);
        a = await storedAudio(page);
        const end = a.points.reduce((x, p) => (p.n > x.n ? p : x));
        assert(checkContiguous(a) === end.audioSamples, 'audio after a new clip');

        // Export: the encoder gets all samples in order, and the file has an AAC track.
        const mp4 = await h.exportMp4('aacmic.mp4');
        const got = await page.evaluate(() => window.__aac.chunks.map((c) => [c.ts, c.frames]));
        let n = 0;
        for (const [ts, frames] of got) {
          assert(Math.abs(ts - (n * 1e6) / sr) <= 1, 'AudioData timestamps');
          n += frames;
        }
        assert(n === end.audioSamples, `encoded ${n} samples, expected ${end.audioSamples}`);
        const pr = JSON.parse(run('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,duration', '-of', 'json', mp4]).stdout).streams;
        const va = pr.find((s) => s.codec_type === 'video'), au = pr.find((s) => s.codec_type === 'audio');
        assert(au && au.codec_name === 'aac', 'no AAC track');
        assert(Math.abs(Number(au.duration) - Number(va.duration)) < 0.1, `durations ${au.duration} / ${va.duration}`);
        checkMp4(mp4, a.session.w, a.session.h);

        // The app closes during a recording: after "Continue", the audio is cut or padded to the
        // recovered video.
        await page.click('#shutter');
        await h.waitState('recording');
        await page.waitForTimeout(1800);
        await page.reload();
        await page.waitForSelector('#gateNew:not([hidden])');
        await page.click('#gateBtn');
        await h.waitState('paused');
        a = await storedAudio(page);
        const rp = a.points.reduce((x, p) => (p.n > x.n ? p : x));
        assert(rp.n === end.n + 1, 'restore must make a new pause point');
        assert(rp.audioSamples === Math.round((rp.tsUs * sr) / 1e6), 'restored point audio');
        assert(checkContiguous(a) === rp.audioSamples, 'audio after the restore');
        await h.clip(1000);
        a = await storedAudio(page);
        const rp2 = a.points.reduce((x, p) => (p.n > x.n ? p : x));
        assert(checkContiguous(a) === rp2.audioSamples, 'audio of a clip after the restore');
        assert(!h.errors.length, `page errors: ${h.errors.join(' | ')}`);
      } finally {
        await h.close();
      }
    },
  },
  {
    name: 'audio in sync after a cut: camera clip, then a file clip with a flash and a click at 2.0 s',
    async fn() {
      if (!chromium) return console.log('      (skipped: Playwright is not available)');
      const h = await openApp('aacsync', { aac: silentAac(44100) });
      try {
        const { page } = h;
        await h.start();
        await h.clip(1300); // clip 1: the camera and the microphone
        const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('#srcFile')]);
        await chooser.setFiles(flashVideo());
        await page.waitForFunction(() => document.getElementById('fileVideo').readyState >= 2);
        await page.evaluate(() => new Promise((res) => {
          const v = document.getElementById('fileVideo');
          v.addEventListener('seeked', res, { once: true });
          v.currentTime = 1.0;
        }));
        await h.clip(2200);
        const db = await h.db();
        const s = db.sessions[0];
        // Clean cuts: the export keeps all frames (index = stored frame index), and the flash is visible.
        const mp4 = await h.exportMp4('aacsync.mp4', 'clean');
        // Video: the time of the first white frame (from the stored timestamps).
        const m = checkMp4(mp4, s.w, s.h);
        let flash = -1;
        for (let i = 0; i < m.count && flash < 0; i++) {
          const f = m.frame(i);
          let sum = 0;
          for (let k = 0; k < s.w * s.h; k += 97) sum += f[k];
          if (sum / Math.ceil((s.w * s.h) / 97) > 128) flash = i;
        }
        assert(flash > 0, 'no flash in the video');
        const vt = db.frames[flash].tsUs / 1e6;
        // Audio: the time of the first loud sample (the PCM that the encoder received).
        // Only in clip 2 (clip 1 has the beeps of the fake microphone).
        const clip2 = db.points.find((p) => p.n === 1).tsUs / 1e6;
        const at = await page.evaluate((from) => {
          const a = window.__aac;
          let n = 0;
          for (const c of a.chunks) {
            for (let i = 0; i < c.frames; i++) {
              if ((n + i) / a.sampleRate >= from && Math.abs(c.pcm[2 * i]) > 8000) return (n + i) / a.sampleRate;
            }
            n += c.frames;
          }
          return -1;
        }, clip2);
        assert(at > 0, 'no click in the audio');
        console.log(`      flash at ${(vt * 1000).toFixed(1)} ms, click at ${(at * 1000).toFixed(1)} ms, offset ${((at - vt) * 1000).toFixed(1)} ms`);
        // One video frame is 33 ms. The flash shows in the first frame at or after 2.0 s.
        assert(Math.abs(at - vt) <= 0.06, `audio and video are out of sync by ${((at - vt) * 1000).toFixed(0)} ms`);
        assert(!h.errors.length, `page errors: ${h.errors.join(' | ')}`);
      } finally {
        await h.close();
      }
    },
  },
];
