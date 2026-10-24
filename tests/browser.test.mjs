// Browser decoders (plan §13.3 in Node form): WebCodecs VideoDecoder output must be byte-identical
// to our decoder, and a <video> element must play the MP4 to the end.
// This test is skipped when Playwright (with a Chromium that has H.264) is not available.

import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { simulate, verify, assert, OUT_DIR } from './lib/session.mjs';
import { avcC } from '../src/mux/mp4.js';
import { spsNal, ppsNal } from '../src/codec/headers.js';

let chromium = null;
try {
  chromium = createRequire(import.meta.url)('playwright').chromium;
} catch {
  chromium = null;
}

const CASES = [
  ['br_cuts', { w: 128, h: 96, script: [{ record: 6 }, { pause: true }, { record: 6, content: 'square' }, { pause: true }, { record: 5, content: 'zoom' }] }, ['mosh', 'clean']],
  ['br_quarter', { w: 852, h: 480, settings: { qp: 22, searchRange: 64, precision: 'quarter', skipBias: 30, heal: 'low' }, script: [{ record: 4, content: 'pan', opt: { vx: -7.25, vy: 3.5 } }, { pause: true }, { record: 4, content: 'noise' }] }, 'mosh'],
];

async function check(page, name, sim, cuts) {
  const { mp4, mp4File, outFrames } = verify(name, sim, cuts);
  const p = sim.params;
  const desc = avcC(spsNal(p), ppsNal()).subarray(8);
  // The samples keep their 4-byte length prefix (AVC format, described by avcC).
  const samples = mp4.samples.map((s) => ({ data: Buffer.from(s.data).toString('base64'), key: s.key, t: s.t, d: s.duration }));
  const res = await page.evaluate(async ({ desc, samples, w, h, file }) => {
    const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
    const out = [];
    let err = null;
    let calls = 0;
    const dec = new VideoDecoder({
      output: async (f) => {
        calls++;
        try {
          if (f.format !== 'I420') throw new Error('not I420');
          const buf = new Uint8Array(f.allocationSize());
          await f.copyTo(buf); // visibleRect, tightly packed planes Y, U, V
          out.push(buf);
        } catch (e) {
          err = `copyTo (format ${f.format}): ${e}`;
        }
        f.close();
      },
      error: (e) => (err = String(e)),
    });
    dec.configure({ codec: 'avc1.42C01E', codedWidth: w, codedHeight: h, description: b64(desc), optimizeForLatency: true });
    for (const s of samples) dec.decode(new EncodedVideoChunk({ type: s.key ? 'key' : 'delta', timestamp: Math.round(s.t / 0.09), duration: Math.round(s.d / 0.09), data: b64(s.data) }));
    try {
      await dec.flush();
    } catch (e) {
      err = 'flush: ' + e;
    }
    if (!calls && !err) err = `no output (state ${dec.state})`;
    await new Promise((r) => setTimeout(r, 50));
    let total = 0;
    for (const o of out) total += o.length;
    const all = new Uint8Array(total);
    let k = 0;
    for (const o of out) { all.set(o, k); k += o.length; }
    // Play the MP4 file to the end.
    const v = document.createElement('video');
    v.muted = true;
    v.src = URL.createObjectURL(new Blob([b64(file)], { type: 'video/mp4' }));
    const play = await new Promise((resolve) => {
      v.onended = () => resolve('ended');
      v.onerror = () => resolve('error ' + (v.error && v.error.message));
      v.play().catch((e) => resolve('play failed ' + e));
      setTimeout(() => resolve('timeout'), 20000);
    });
    let bin = '';
    for (let i = 0; i < all.length; i += 0x8000) bin += String.fromCharCode(...all.subarray(i, i + 0x8000));
    return { err, frames: out.length, data: btoa(bin), play, w: v.videoWidth, h: v.videoHeight };
  }, { desc: Buffer.from(desc).toString('base64'), samples, w: p.w, h: p.h, file: fs.readFileSync(mp4File).toString('base64') });
  assert(!res.err, `${name}: VideoDecoder error ${res.err}`);
  assert(res.frames === outFrames.length, `${name}: VideoDecoder gave ${res.frames} frames, expected ${outFrames.length}`);
  const ours = Buffer.concat(outFrames.flatMap((f) => [f.y, f.u, f.v].map((a) => Buffer.from(a))));
  assert(Buffer.compare(Buffer.from(res.data, 'base64'), ours) === 0, `${name}: VideoDecoder output differs from our decoder`);
  assert(res.play === 'ended' && res.w === p.w && res.h === p.h, `${name}: <video> playback: ${res.play} ${res.w}x${res.h}`);
}

export const tests = [
  {
    name: 'Chromium VideoDecoder is bit-exact and <video> plays to the end',
    async fn() {
      if (!chromium) {
        console.log('      (skipped: Playwright is not available)');
        return;
      }
      const browser = await chromium.launch();
      try {
        const page = await browser.newPage();
        // WebCodecs needs a secure context; a file: page is one (about:blank is not).
        fs.mkdirSync(OUT_DIR, { recursive: true });
        const blank = path.join(OUT_DIR, 'blank.html');
        fs.writeFileSync(blank, '<!doctype html><title>t</title>');
        await page.goto(pathToFileURL(blank).href);
        const ok = await page.evaluate(async () => typeof VideoDecoder !== 'undefined' &&
          (await VideoDecoder.isConfigSupported({ codec: 'avc1.42C01E', codedWidth: 64, codedHeight: 64 })).supported);
        if (!ok) {
          console.log('      (skipped: this Chromium has no H.264 decoder)');
          return;
        }
        for (const [name, spec, cuts] of CASES) {
          for (const c of Array.isArray(cuts) ? cuts : [cuts]) await check(page, `${name}_${c}`, simulate(spec), c);
        }
      } finally {
        await browser.close();
      }
    },
  },
];
