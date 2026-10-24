// Session simulation and the §13.1 checks with FFmpeg.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Encoder, DEFAULT_SETTINGS } from '../../src/codec/encoder.js';
import { Decoder } from '../../src/codec/decoder.js';
import { annexB, keptFrames, streamParams } from '../../src/codec/headers.js';
import { CONTENT } from './synth.mjs';
import { Remuxer } from '../../src/mux/remux.js';

export const OUT_DIR = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'out');

export function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// Run a recorder script on the encoder.
// spec: { w, h, fps, settings, script: [op...] }. Ops:
//   { record: n, content, opt }   encode n frames (time continues across clips)
//   { pause: true }               make a pause point
//   { settings: {...} }           change the encoder settings (while paused)
//   { revert: N }                 revert to pause point N (0 = start)
// spec.duration(k): duration in microseconds of the k-th encoded frame (default 1/fps). It makes
// the frame timestamps tsUs (session time, plan R-17). Longer durations act as dropped frames.
// Returns { params, frames, recon, points, encoder }.
export function simulate(spec) {
  const { w, h } = spec;
  const params = streamParams(w, h, spec.fps ?? 30);
  const enc = new Encoder(w, h, spec.settings ?? DEFAULT_SETTINGS);
  if (spec.debug) Object.assign(enc.debug, spec.debug);
  const frames = [];
  const recon = [];
  const points = [{ frameIndex: 0 }];
  let t = 0;
  let paused = false;
  let tsUs = 0;
  let k = 0;
  const duration = spec.duration ?? (() => Math.round(1e6 / params.fps));
  for (const op of spec.script) {
    if (op.record) {
      if (paused) enc.newClip();
      paused = false;
      for (let i = 0; i < op.record; i++, t++) {
        const f = CONTENT[op.content ?? 'pan'](w, h, op.t0 !== undefined ? op.t0 + i : t, op.opt ?? {});
        const pkt = enc.encode(f.Y, f.U, f.V);
        pkt.tsUs = tsUs;
        tsUs += duration(k++);
        frames.push(pkt);
        recon.push({ Y: enc.recY.slice(), U: enc.recU.slice(), V: enc.recV.slice() });
      }
    } else if (op.pause) {
      paused = true;
      points.push({ frameIndex: frames.length });
    } else if (op.settings) {
      enc.setSettings({ ...enc.settings, ...op.settings });
    } else if (op.revert !== undefined) {
      const p = points[op.revert];
      tsUs = p.frameIndex < frames.length ? frames[p.frameIndex].tsUs : tsUs;
      frames.length = p.frameIndex;
      recon.length = p.frameIndex;
      points.length = op.revert + 1;
      if (op.revert === 0) enc.restart();
      else enc.newClip();
      paused = op.revert !== 0;
    }
  }
  return { params, frames, recon, points, encoder: enc };
}

function run(cmd, args) {
  const r = spawnSync(cmd, args, { maxBuffer: 1 << 30 });
  if (r.error) throw r.error;
  return { status: r.status, stdout: r.stdout, stderr: r.stderr.toString() };
}

function cutMode(cuts, k) {
  return typeof cuts === 'string' ? cuts : cuts[k] || 'mosh';
}

// The §13.1 checks 1, 3, 4, 5 on an Annex B stream (checks 2 and 5-timestamps need the MP4 muxer,
// Phase 2). Returns some data for more checks.
export function verify(name, sim, cuts = 'mosh', muxOpts) {
  const { params, frames, recon } = sim;
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, `${name}.264`);
  fs.writeFileSync(file, annexB(params, frames, cuts));

  // Our decoder output for the kept frames.
  const dec = new Decoder(params.w, params.h);
  const ours = [];
  const outFrames = [];
  let cut = 0;
  let firstCutSeen = false;
  let allClean = true;
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    let show = false;
    if (f.type === 'hiddenI') {
      show = cutMode(cuts, cut) === 'clean';
      if (!show) {
        firstCutSeen = true;
        allClean = false;
      }
      cut++;
    }
    const changed = dec.decodePacket(f, show);
    if (!changed) continue;
    const pic = dec.getFrame();
    ours.push(pic.y, pic.u, pic.v);
    outFrames.push(pic);
    // Check 4: encoder reconstruction = decoder output, until the first Mosh cut.
    if (!firstCutSeen || allClean) {
      const r = recon[i];
      assert(Buffer.compare(Buffer.from(r.Y), Buffer.from(dec.Y)) === 0 &&
        Buffer.compare(Buffer.from(r.U), Buffer.from(dec.U)) === 0 &&
        Buffer.compare(Buffer.from(r.V), Buffer.from(dec.V)) === 0,
      `${name}: encoder reconstruction differs from decoder output at frame ${i}`);
    }
  }
  const oursBuf = Buffer.concat(ours.map((a) => Buffer.from(a.buffer, a.byteOffset, a.byteLength)));

  // Check 1: FFmpeg decodes with no errors and no warnings.
  const c1 = run('ffmpeg', ['-hide_banner', '-v', 'error', '-f', 'h264', '-i', file, '-f', 'null', '-']);
  assert(c1.status === 0 && c1.stderr.trim() === '', `${name}: ffmpeg reports: ${c1.stderr}`);

  // Check 3: FFmpeg output is byte-identical to our decoder output.
  const c3 = run('ffmpeg', ['-hide_banner', '-v', 'error', '-f', 'h264', '-i', file,
    '-fps_mode', 'passthrough', '-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-']);
  assert(c3.status === 0, `${name}: ffmpeg decode failed: ${c3.stderr}`);
  const ff = c3.stdout;
  if (Buffer.compare(ff, oursBuf) !== 0) {
    const fsz = (params.w * params.h * 3) >> 1;
    let k = 0;
    while (k < Math.min(ff.length, oursBuf.length) && ff[k] === oursBuf[k]) k++;
    throw new Error(`${name}: FFmpeg output differs (ffmpeg ${ff.length} B, ours ${oursBuf.length} B, ` +
      `first difference in output frame ${Math.floor(k / fsz)}, byte ${k % fsz})`);
  }

  // MP4 (Phase 2): lossless remux of the same frames.
  const rx = new Remuxer(params, { cuts });
  for (const f of frames) rx.add(f);
  const mp4 = rx.finish(muxOpts);
  const mp4File = path.join(OUT_DIR, `${name}.mp4`);
  const mp4Buf = Buffer.concat(mp4.parts.map((a) => Buffer.from(a.buffer, a.byteOffset, a.byteLength)));
  assert(mp4Buf.length === mp4.size, `${name}: MP4 size ${mp4Buf.length} != ${mp4.size}`);
  fs.writeFileSync(mp4File, mp4Buf);

  // Check 2: FFmpeg reads the MP4 with no errors and no warnings.
  const c2 = run('ffmpeg', ['-hide_banner', '-v', 'warning', '-i', mp4File, '-fps_mode', 'passthrough',
    '-enc_time_base:v', 'demux', '-f', 'null', '-']);
  assert(c2.status === 0 && c2.stderr.trim() === '', `${name}: ffmpeg reports on the MP4: ${c2.stderr}`);

  // Check 3 (MP4): FFmpeg output is byte-identical to our decoder output.
  const c3m = run('ffmpeg', ['-hide_banner', '-v', 'error', '-i', mp4File,
    '-fps_mode', 'passthrough', '-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-']);
  assert(c3m.status === 0 && Buffer.compare(c3m.stdout, oursBuf) === 0, `${name}: FFmpeg output of the MP4 differs`);

  // Check 5 (MP4): one packet for each kept frame, with the expected time, duration, and sync flag.
  const c5m = run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries',
    'packet=pts,dts,duration,flags', '-of', 'csv=p=0', mp4File]);
  const pk = c5m.stdout.toString().trim().split('\n').map((l) => l.trim().split(','));
  assert(pk.length === mp4.samples.length, `${name}: MP4 has ${pk.length} packets, expected ${mp4.samples.length}`);
  mp4.samples.forEach((smp, i) => {
    const [pts, dts, dur, flags] = pk[i];
    assert(Number(pts) === smp.t && Number(dts) === smp.t, `${name}: packet ${i} pts ${pts}, expected ${smp.t}`);
    assert(Number(dur) === smp.duration, `${name}: packet ${i} duration ${dur}, expected ${smp.duration}`);
    assert(flags.startsWith('K') === smp.key, `${name}: packet ${i} sync flag ${flags}`);
  });

  // Check 5: frame count and frame types.
  const c5 = run('ffprobe', ['-v', 'error', '-f', 'h264', '-show_entries', 'frame=pict_type,key_frame',
    '-of', 'csv=p=0', file]);
  const got = c5.stdout.toString().trim().split('\n').map((l) => l.trim());
  const want = [...keptFrames(frames, cuts)].map((k) => (k.frame.type === 'p' ? '0,P' : `${k.frame.type === 'idr' ? 1 : 0},I`));
  assert(got.length === want.length, `${name}: ffprobe shows ${got.length} frames, expected ${want.length}`);
  for (let i = 0; i < want.length; i++) {
    // key_frame is 1 only for the IDR. FFmpeg can mark a non-IDR I picture as key, so check only the type.
    assert(got[i].split(',')[1] === want[i].split(',')[1], `${name}: frame ${i} type ${got[i]}, expected ${want[i]}`);
  }
  return { file, mp4File, mp4, outFrames, decoder: dec };
}

export function probeStream(file, annexB = true) {
  const r = run('ffprobe', ['-v', 'error', ...(annexB ? ['-f', 'h264'] : []), '-select_streams', 'v:0', '-show_entries',
    'stream=profile,level,width,height,pix_fmt,color_range,color_space,color_primaries,color_transfer,has_b_frames',
    '-of', 'json', file]);
  return JSON.parse(r.stdout.toString()).streams[0];
}
