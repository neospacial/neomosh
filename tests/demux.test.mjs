// D25: the MP4/MOV reader of the file source, against FFmpeg (ffprobe packets and frames).

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { assert, OUT_DIR } from './lib/session.mjs';
import { demuxMp4, turnedCrop } from '../src/mux/demux.js';

const ff = (args) => spawnSync('ffmpeg', ['-v', 'error', '-y', ...args]);
const probe = (file, what) => spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', what, '-of', 'csv=p=0', file])
  .stdout.toString().trim().split('\n').map((l) => l.split(','));

async function check(name, args, want = {}) {
  const file = path.join(OUT_DIR, name);
  const r = ff([...args, file]);
  if (r.status !== 0) return console.log(`      (skipped ${name}: ${r.stderr.toString().trim().split('\n').pop()})`);
  const d = await demuxMp4(await fs.openAsBlob(file));
  assert(d, `${name}: not read`);
  const pk = probe(file, 'packet=size,pos,flags'); // ffprobe gives size, then pos
  assert(d.samples.length === pk.length, `${name}: ${d.samples.length} samples, ${pk.length} packets`);
  d.samples.forEach((s, i) => {
    assert(s.size === Number(pk[i][0]) && s.offset === Number(pk[i][1]), `${name}: sample ${i} position`);
    assert(s.key === pk[i][2].startsWith('K'), `${name}: sample ${i} sync`);
  });
  // The display times, in display order, are the frame times of FFmpeg.
  const fr = probe(file, 'frame=pts_time').map((x) => Math.round(Number(x[0]) * 1e6));
  const us = d.samples.map((s) => s.us).sort((a, b) => a - b);
  assert(fr.length === us.length && fr.every((t, i) => Math.abs(t - us[i]) <= 1), `${name}: times ${us.slice(0, 5)} / ${fr.slice(0, 5)}`);
  if (want.codec) assert(want.codec.test(d.codec), `${name}: codec ${d.codec}`);
  if (want.rotation !== undefined) assert(d.rotation === want.rotation, `${name}: rotation ${d.rotation}`);
  return d;
}

const src = ['-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=30', '-frames:v', '45', '-pix_fmt', 'yuv420p'];

export const tests = [
  {
    name: 'MP4/MOV reader: H.264 with B-frames, MOV, rotation, HEVC, moov at the end',
    async fn() {
      await check('dmx_h264.mp4', [...src, '-c:v', 'libx264', '-bf', '3', '-g', '12', '-movflags', '+faststart'], { codec: /^avc1\.64/, rotation: 0 });
      await check('dmx_end.mp4', [...src, '-c:v', 'libx264', '-bf', '0'], { codec: /^avc1\./ });
      await check('dmx.mov', [...src, '-c:v', 'libx264', '-bf', '2'], { codec: /^avc1\./ });
      // A turned file: -display_rotation (on a stream copy) is counterclockwise; a player turns the
      // picture clockwise by r = 360 - that angle.
      const plain = path.join(OUT_DIR, 'dmx_plain.mp4');
      ff([...src, '-c:v', 'libx264', plain]);
      for (const r of [90, 180, 270]) await check(`dmx_rot${r}.mp4`, ['-display_rotation', String(360 - r), '-i', plain, '-c', 'copy'], { rotation: r });
      await check('dmx_hevc.mp4', [...src, '-c:v', 'libx265', '-tag:v', 'hvc1', '-x265-params', 'log-level=error'], { codec: /^hvc1\.1\.6\.L\d+/ });
      // Not an MP4: null (the file plays in real time).
      const webm = path.join(OUT_DIR, 'dmx.webm');
      if (ff([...src, '-c:v', 'libvpx', webm]).status === 0) assert((await demuxMp4(await fs.openAsBlob(webm))) === null, 'webm: null');
    },
  },
  {
    name: 'turned crop: each rotation maps the display crop to the frame and back',
    fn() {
      // A frame 400x300 shown turned; a display crop; check the corners with the transform.
      for (const rot of [0, 90, 180, 270]) {
        const [fw, fh] = [400, 300];
        const [dw0, dh0] = rot % 180 ? [fh, fw] : [fw, fh];
        const c = { sx: 20, sy: 40, sw: dw0 - 60, sh: dh0 - 100 };
        const w = 100, h = Math.round((100 * c.sh) / c.sw);
        const t = turnedCrop(rot, fw, fh, c, w, h);
        // A frame point -> display point (how a player turns it).
        const disp = (x, y) => (rot === 90 ? [fh - y, x] : rot === 180 ? [fw - x, fh - y] : rot === 270 ? [y, fw - x] : [x, y]);
        // Source rect corner -> drawing point -> output (setTransform).
        const out = (x, y) => {
          const u = ((x - t.sx) * t.dw) / t.sw, v = ((y - t.sy) * t.dh) / t.sh;
          const [a, b, cc, d, e, f] = t.m;
          return [a * u + cc * v + e, b * u + d * v + f];
        };
        for (const [x, y] of [[t.sx, t.sy], [t.sx + t.sw, t.sy], [t.sx, t.sy + t.sh], [t.sx + t.sw, t.sy + t.sh]]) {
          const [dx, dy] = disp(x, y);
          const [ox, oy] = out(x, y);
          // The output point is the display point, moved and scaled by the crop.
          const ex = ((dx - c.sx) * w) / c.sw, ey = ((dy - c.sy) * h) / c.sh;
          assert(Math.abs(ox - ex) < 0.6 && Math.abs(oy - ey) < 0.6, `rotation ${rot}: (${x},${y}) -> (${ox},${oy}), want (${ex},${ey})`);
        }
      }
    },
  },
];
