// Real AAC-LC frames from FFmpeg (ADTS), for tests of the audio track.

import { spawnSync } from 'node:child_process';

const RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

// AudioSpecificConfig: AAC-LC (2), sampling frequency index, channel configuration.
export function makeAsc(sampleRate, channels) {
  const fi = RATES.indexOf(sampleRate);
  return new Uint8Array([(2 << 3) | (fi >> 1), ((fi & 1) << 7) | (channels << 3)]);
}

// Encode with FFmpeg. input: FFmpeg input arguments (for example a lavfi source).
// Returns { asc, frames: [Uint8Array raw AAC frame] }.
export function aacFrames(input, sampleRate) {
  const r = spawnSync('ffmpeg', ['-v', 'error', ...input, '-ar', String(sampleRate), '-ac', '2', '-c:a', 'aac', '-b:a', '160k', '-f', 'adts', '-'], { maxBuffer: 1 << 28 });
  if (r.status !== 0) throw new Error(r.stderr.toString());
  const b = r.stdout;
  const frames = [];
  let i = 0;
  while (i + 7 <= b.length) {
    if (b[i] !== 0xff || (b[i + 1] & 0xf0) !== 0xf0) throw new Error('ADTS sync');
    const crc = !(b[i + 1] & 1);
    const len = ((b[i + 3] & 3) << 11) | (b[i + 4] << 3) | (b[i + 5] >> 5);
    const hl = crc ? 9 : 7;
    frames.push(new Uint8Array(b.subarray(i + hl, i + len)));
    i += len;
  }
  return { asc: makeAsc(sampleRate, 2), frames };
}
