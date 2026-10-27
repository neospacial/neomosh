// Phase 2: MP4 muxer and lossless export (plan §9.2, §9.4, §13.1 checks 2, 3, 5).

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { simulate, verify, probeStream, assert, OUT_DIR } from './lib/session.mjs';
import { Remuxer, remuxOriginal, VIDEO_TIMESCALE } from '../src/mux/remux.js';
import { Encoder } from '../src/codec/encoder.js';
import { streamParams, annexB } from '../src/codec/headers.js';
import { muxMp4 } from '../src/mux/mp4.js';
import { upscaleSamples } from '../src/app/upscale.js';

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const concat = (parts) => Buffer.concat(parts.map((a) => Buffer.from(a.buffer, a.byteOffset, a.byteLength)));

function hasBox(buf, type) {
  return buf.indexOf(Buffer.from(type, 'latin1')) >= 0;
}

export const tests = [
  {
    name: 'stream description in the MP4',
    fn() {
      const { mp4File } = verify('mp4_desc', simulate({ w: 852, h: 480, script: [{ record: 3 }] }));
      const p = probeStream(mp4File, false);
      assert(p.profile === 'Constrained Baseline' && p.width === 852 && p.height === 480, 'profile or size');
      assert(p.color_range === 'tv' && p.color_space === 'bt709' && p.color_primaries === 'bt709', 'colour');
      const buf = fs.readFileSync(mp4File);
      for (const b of ['ftyp', 'moov', 'mvhd', 'tkhd', 'avc1', 'avcC', 'colr', 'stts', 'stss', 'stsc', 'stsz', 'stco', 'mdat']) {
        assert(hasBox(buf, b), `no ${b} box`);
      }
      assert(buf.indexOf('moov') < buf.indexOf('mdat'), 'moov must come before mdat');
    },
  },
  {
    name: 'variable frame durations (drops and jitter), Mosh and Clean cuts',
    fn() {
      const r = rng(9);
      const duration = () => {
        const base = 33333 + Math.round((r() - 0.5) * 4000);
        const x = r();
        return x < 0.15 ? 2 * base : x < 0.2 ? 3 * base : base; // dropped frames (R-20)
      };
      const sim = simulate({
        w: 128, h: 96, duration,
        script: [{ record: 12 }, { pause: true }, { record: 10, content: 'square' }, { pause: true }, { record: 8, content: 'zoom' }],
      });
      for (const cuts of ['mosh', 'clean', ['clean', 'mosh']]) {
        const { mp4 } = verify(`vfr_${Array.isArray(cuts) ? cuts.join('-') : cuts}`, sim, cuts);
        // A Mosh cut: the hidden I-frame and its time slot are not in the file; the next frames move
        // earlier by that slot (no hold of the last picture before the cut). Clean: no change.
        const isKept = (f) => f.type !== 'hiddenI' || cuts === 'clean' || (Array.isArray(cuts) && f === sim.frames[12]);
        const want = [];
        let shift = 0;
        sim.frames.forEach((f, i) => {
          if (isKept(f)) want.push(f.tsUs - shift);
          else shift += sim.frames[i + 1].tsUs - f.tsUs;
        });
        mp4.samples.forEach((s, i) => assert(s.t === Math.round((want[i] * 9) / 100), `sample ${i} time`));
      }
      // 24 and 15 fps sessions: the last frame lasts 1/fps.
      for (const fps of [24, 15]) {
        const s2 = simulate({ w: 64, h: 48, fps, script: [{ record: 5 }] });
        const { mp4 } = verify(`fps${fps}`, s2);
        assert(mp4.samples[4].duration === VIDEO_TIMESCALE / fps, 'last duration');
      }
    },
  },
  {
    name: 'durations at 30 fps do not drift (rounding error carried forward)',
    fn() {
      // 1e6/30 is not an integer number of microseconds or of 90 kHz ticks... in exact time.
      const sim = simulate({ w: 32, h: 32, duration: (k) => Math.round(((k + 1) * 1e6) / 30) - Math.round((k * 1e6) / 30), debug: { forceMode: 'skip' }, script: [{ record: 300 }] });
      const rx = new Remuxer(sim.params);
      for (const f of sim.frames) rx.add(f);
      const { samples } = rx.finish();
      const total = samples.reduce((a, s) => a + s.duration, 0);
      assert(total === 300 * 3000, `total ${total}`);
      assert(samples.every((s) => s.duration === 3000), 'each duration 3000');
    },
  },
  {
    name: 'co64, 64-bit mdat size, and small chunks',
    fn() {
      const sim = simulate({ w: 96, h: 64, script: [{ record: 6 }, { pause: true }, { record: 6, content: 'square' }] });
      for (const [name, opts] of [
        ['mp4_co64', { forceCo64: true }],
        ['mp4_largemdat', { forceLargeMdat: true, forceCo64: true }],
        ['mp4_chunks', { chunkDuration: 7000 }],
      ]) {
        const { mp4File } = verify(name, sim, 'clean', opts);
        const buf = fs.readFileSync(mp4File);
        if (opts.forceCo64) assert(hasBox(buf, 'co64') && !hasBox(buf, 'stco'), 'co64');
      }
    },
  },
  {
    name: 'frame_num wraps after 65536 frames',
    fn() {
      const w = 32, h = 32;
      const params = streamParams(w, h, 30);
      const enc = new Encoder(w, h);
      enc.debug.forceMode = 'skip';
      const Y = new Uint8Array(1024).fill(90), U = new Uint8Array(256).fill(120), V = new Uint8Array(256).fill(140);
      const idr = enc.encode(Y, U, V);
      const p = enc.encode(Y, U, V);
      const n = 65536 + 50;
      const frames = [{ ...idr, tsUs: 0 }];
      for (let i = 1; i < n; i++) frames.push({ ...p, tsUs: Math.round((i * 1e6) / 30) });
      const file = path.join(OUT_DIR, 'framenum_wrap.264');
      fs.writeFileSync(file, annexB(params, frames));
      const rx = new Remuxer(params);
      for (const f of frames) rx.add(f);
      const mp4File = path.join(OUT_DIR, 'framenum_wrap.mp4');
      fs.writeFileSync(mp4File, concat(rx.finish().parts));
      for (const args of [['-f', 'h264', '-i', file], ['-i', mp4File]]) {
        const r = spawnSync('ffmpeg', ['-hide_banner', '-v', 'warning', ...args, '-f', 'null', '-']);
        assert(r.status === 0 && r.stderr.toString().trim() === '', `ffmpeg: ${r.stderr}`);
        const c = spawnSync('ffprobe', ['-v', 'error', ...args.slice(0, -2), '-count_frames', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', args[args.length - 1]]);
        assert(Number(c.stdout.toString().trim()) === n, `frame count ${c.stdout}`);
      }
    },
  },
  {
    name: 'async export from an async source, with progress and cancel',
    async fn() {
      const sim = simulate({ w: 64, h: 48, script: [{ record: 5 }, { pause: true }, { record: 5, content: 'square' }] });
      async function* source() {
        for (const f of sim.frames) {
          await null;
          yield f;
        }
      }
      let progress = 0;
      const r = await remuxOriginal(sim.params, source(), { onProgress: (n) => (progress = n) });
      assert(progress === sim.frames.length && r.samples.length === sim.frames.length - 1, 'progress or sample count');
      const rx = new Remuxer(sim.params);
      for (const f of sim.frames) rx.add(f);
      assert(Buffer.compare(concat(r.parts), concat(rx.finish().parts)) === 0, 'async and sync results differ');
      const ac = new AbortController();
      ac.abort();
      let failed = false;
      try {
        await remuxOriginal(sim.params, source(), { signal: ac.signal });
      } catch {
        failed = true;
      }
      assert(failed, 'cancel did not stop the export');
    },
  },
  {
    name: 'MP4 pictures equal our decoder after a revert (plan Phase 4 rule, checked now)',
    fn() {
      const sim = simulate({
        w: 96, h: 64,
        script: [{ record: 4 }, { pause: true }, { record: 4, content: 'noise' }, { pause: true }, { revert: 1 }, { record: 4, content: 'square' }],
      });
      const { mp4 } = verify('mp4_revert', sim, 'mosh');
      // The timeline after a revert continues from the pause point. At the Mosh cut, the time slot
      // of the hidden I-frame is removed: all frames keep their normal duration.
      const d = mp4.samples.map((s) => s.duration);
      assert(d.join() === '3000,3000,3000,3000,3000,3000,3000', `durations ${d}`);
    },
  },
  {
    name: 'Upscale export with B-frames (desktop encoders): ctts and edit list; FFmpeg times and pictures are correct',
    fn() {
      // A real stream with B-frames from libx264, with access unit delimiters to split the frames.
      const ref = path.join(OUT_DIR, 'bframes_ref.mp4');
      const es = path.join(OUT_DIR, 'bframes.h264');
      const enc = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=160x120:rate=30', '-frames:v', '40',
        '-c:v', 'libx264', '-bf', '3', '-g', '15', '-x264-params', 'aud=1', '-pix_fmt', 'yuv420p', ref]);
      if (enc.status !== 0) return console.log('      (skipped: no libx264 in FFmpeg)');
      spawnSync('ffmpeg', ['-v', 'error', '-y', '-i', ref, '-c', 'copy', '-bsf:v', 'h264_mp4toannexb', '-f', 'h264', es]);
      const pk = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts_time,flags', '-of', 'csv=p=0', ref])
        .stdout.toString().trim().split('\n').map((l) => l.split(','));
      // Split the Annex B stream into NAL units, then into access units at each delimiter (type 9).
      const buf = fs.readFileSync(es);
      const nals = [];
      for (let i = 0, start = -1; i <= buf.length; i++) {
        const sc = i + 3 <= buf.length && buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 1;
        if (sc || i === buf.length) {
          if (start >= 0) {
            let end = i;
            while (end > start && buf[end - 1] === 0) end--;
            nals.push(buf.subarray(start, end));
          }
          if (sc) {
            start = i + 3;
            i += 2;
          }
        }
      }
      let sps, pps;
      const aus = [];
      for (const n of nals) {
        const t = n[0] & 31;
        if (t === 9) aus.push([]);
        else if (t === 7) sps = sps || n;
        else if (t === 8) pps = pps || n;
        else if (t !== 6) aus[aus.length - 1].push(n);
      }
      assert(aus.length === 40 && pk.length === 40, `${aus.length} access units, ${pk.length} packets`);
      const chunks = aus.map((list, i) => {
        const size = list.reduce((a, n) => a + 4 + n.length, 0);
        const data = new Uint8Array(size);
        let o = 0;
        for (const n of list) {
          new DataView(data.buffer).setUint32(o, n.length);
          data.set(n, o + 4);
          o += 4 + n.length;
        }
        return { data, key: pk[i][1].startsWith('K'), ts: Math.round(Number(pk[i][0]) * 1e6) };
      });
      const t0 = Math.min(...chunks.map((c) => c.ts));
      for (const c of chunks) c.ts -= t0;
      assert(chunks.some((c, i) => i && c.ts < chunks[i - 1].ts), 'the reference has B-frames (out of display order)');
      const { samples, mediaTime } = upscaleSamples(chunks, 3000);
      assert(mediaTime > 0, 'a delay for the B-frames');
      const r = muxMp4({ width: 160, height: 120, timescale: VIDEO_TIMESCALE, sps, pps, samples, mediaTime });
      const out = path.join(OUT_DIR, 'bframes_ours.mp4');
      fs.writeFileSync(out, Buffer.concat(r.parts.map((a) => Buffer.from(a.buffer, a.byteOffset, a.byteLength))));
      const warn = spawnSync('ffmpeg', ['-hide_banner', '-v', 'warning', '-i', out, '-f', 'null', '-']);
      assert(warn.status === 0 && warn.stderr.toString().trim() === '', `ffmpeg: ${warn.stderr}`);
      // The pictures, in display order, are the same as the reference file.
      const raw = (f) => spawnSync('ffmpeg', ['-v', 'error', '-i', f, '-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-'], { maxBuffer: 1 << 28 }).stdout;
      assert(Buffer.compare(raw(out), raw(ref)) === 0, 'the pictures differ from the reference');
      // The display times: from 0, one frame each 1/30 s, in display order.
      const times = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'frame=pts_time', '-of', 'csv=p=0', out])
        .stdout.toString().trim().split('\n').map(Number);
      assert(times.length === 40 && times.every((t, i) => Math.abs(t - i / 30) < 0.002), `display times ${times.slice(0, 6)}`);
      // In display order already (as on Android): no ctts, no edit list.
      const plain = upscaleSamples(chunks.slice().sort((a, b) => a.ts - b.ts).slice(0, 5).map((c, i) => ({ ...c, ts: i * 33333 })), 3000);
      assert(plain.mediaTime === 0 && plain.samples.every((s) => s.cto === 0), 'ordered chunks: no offsets');
    },
  },
];
