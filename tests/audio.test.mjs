// Phase 6: the AAC audio track in the MP4 muxer (plan §9.4). Real AAC frames from FFmpeg.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { simulate, assert, OUT_DIR } from './lib/session.mjs';
import { Remuxer } from '../src/mux/remux.js';
import { Decoder } from '../src/codec/decoder.js';
import { aacFrames } from './lib/aac.mjs';

const run = (cmd, args) => spawnSync(cmd, args, { maxBuffer: 1 << 30 });
const concat = (parts) => Buffer.concat(parts.map((a) => Buffer.from(a.buffer, a.byteOffset, a.byteLength)));

export const tests = [
  {
    name: 'MP4 with video and AAC audio: valid, interleaved, same length, video still bit-exact',
    fn() {
      for (const sr of [48000, 44100]) {
        const sim = simulate({ w: 128, h: 96, script: [{ record: 45 }, { pause: true }, { record: 45, content: 'square' }] });
        const endUs = sim.frames[sim.frames.length - 1].tsUs + Math.round(1e6 / 30);
        const seconds = endUs / 1e6;
        const { asc, frames } = aacFrames(['-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=${sr}:duration=${seconds}`], sr);
        const audio = { sampleRate: sr, channels: 2, asc, bitrate: 160000, samples: frames.map((d) => ({ data: d, size: d.length, duration: 1024 })) };
        const rx = new Remuxer(sim.params, { cuts: 'mosh' });
        for (const f of sim.frames) rx.add(f);
        const r = rx.finish(undefined, audio);
        const file = path.join(OUT_DIR, `audio_${sr}.mp4`);
        const buf = concat(r.parts);
        assert(buf.length === r.size, 'size');
        fs.writeFileSync(file, buf);

        const c = run('ffmpeg', ['-hide_banner', '-v', 'warning', '-i', file, '-fps_mode', 'passthrough', '-enc_time_base:v', 'demux', '-f', 'null', '-']);
        assert(c.status === 0 && c.stderr.toString().trim() === '', `ffmpeg: ${c.stderr}`);
        const pr = JSON.parse(run('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,sample_rate,channels,duration', '-of', 'json', file]).stdout);
        const a = pr.streams.find((s) => s.codec_type === 'audio');
        const v = pr.streams.find((s) => s.codec_type === 'video');
        assert(a && a.codec_name === 'aac' && Number(a.sample_rate) === sr && a.channels === 2, `audio stream ${JSON.stringify(a)}`);
        assert(Math.abs(Number(a.duration) - Number(v.duration)) < 0.1, `durations: audio ${a.duration}, video ${v.duration}`);

        // The audio decodes to the tone (440 Hz: count the zero crossings in 1 s).
        const pcm = run('ffmpeg', ['-v', 'error', '-i', file, '-map', '0:a', '-ac', '1', '-f', 's16le', '-']).stdout;
        const smp = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.length >> 1);
        let zc = 0;
        for (let i = sr * 0.5 + 1; i < sr * 1.5; i++) if ((smp[i - 1] < 0) !== (smp[i] < 0)) zc++;
        assert(Math.abs(zc - 880) < 10, `zero crossings ${zc}`);

        // Interleaved: audio packets lie between video packets in the file.
        const pk = run('ffprobe', ['-v', 'error', '-show_entries', 'packet=codec_type,pos', '-of', 'csv=p=0', file]).stdout.toString().trim().split('\n').map((l) => l.split(','));
        const firstA = Math.min(...pk.filter((p) => p[0] === 'audio').map((p) => Number(p[1])));
        const lastV = Math.max(...pk.filter((p) => p[0] === 'video').map((p) => Number(p[1])));
        assert(firstA < lastV, 'the tracks are not interleaved');

        // The video track is unchanged: FFmpeg output = our decoder output.
        const dec = new Decoder(128, 96);
        const ours = [];
        for (const f of sim.frames) if (dec.decodePacket(f)) {
          const p = dec.getFrame();
          ours.push(Buffer.from(p.y), Buffer.from(p.u), Buffer.from(p.v));
        }
        const ff = run('ffmpeg', ['-v', 'error', '-i', file, '-map', '0:v', '-fps_mode', 'passthrough', '-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-']).stdout;
        assert(Buffer.compare(ff, Buffer.concat(ours)) === 0, 'video differs with the audio track');
      }
    },
  },
];
