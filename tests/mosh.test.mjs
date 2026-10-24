// Plan §13.2: after a Mosh cut, the new P-frames move the old picture. Only the area along the
// path of the moving square changes. The rest stays the old picture.

import { simulate, verify, assert } from './lib/session.mjs';
import { DEFAULT_SETTINGS } from '../src/codec/encoder.js';

export const tests = [
  {
    name: 'mosh check: still old scene, then a moving square on a flat field',
    fn() {
      const w = 160, h = 96;
      const speed = 4, size = 24, n = 6;
      for (const precision of ['full', 'half', 'quarter']) {
        const sim = simulate({
          w, h, settings: { ...DEFAULT_SETTINGS, precision },
          script: [
            { record: 4, content: 'still' }, { pause: true },
            { record: n, content: 'square', t0: 0, opt: { speed, size } },
          ],
        });
        // FFmpeg must show the same moshed pictures (verify() checks bit-exact equality).
        const { outFrames } = verify(`mosh_check_${precision}`, sim, 'mosh');
        const old = outFrames[3];
        const after = outFrames.slice(4);
        assert(after.length === n - 1, 'the hidden I-frame must not be shown');
        // Bounding box of the square path (synth.mjs: x = 8 + speed*t, y = 6 + ceil(speed/2)*t), plus a margin.
        const margin = 32;
        const x1 = 8 + speed * (n - 1) + size + margin, y1 = 6 + Math.ceil(speed / 2) * (n - 1) + size + margin;
        let changedOnPath = 0;
        for (const f of after) {
          for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
              const i = y * w + x;
              if (x >= x1 || y >= y1) {
                assert(f.y[i] === old.y[i], `${precision}: pixel (${x},${y}) outside the path changed`);
              } else if (f.y[i] !== old.y[i]) changedOnPath++;
            }
          }
          for (let y = 0; y < h >> 1; y++) {
            for (let x = 0; x < w >> 1; x++) {
              if (2 * x >= x1 || 2 * y >= y1) {
                const i = y * (w >> 1) + x;
                assert(f.u[i] === old.u[i] && f.v[i] === old.v[i], `${precision}: chroma outside the path changed`);
              }
            }
          }
        }
        assert(changedOnPath > 500, `${precision}: the moving square must move the old pixels (${changedOnPath} changed)`);
        // The decoded picture is not the new scene: the flat field (Y = 80) does not appear.
        const last = after[after.length - 1];
        let flat = 0;
        for (let i = 0; i < last.y.length; i++) if (last.y[i] === 80) flat++;
        assert(flat < last.y.length / 20, `${precision}: the new scene is visible (${flat} flat samples)`);
      }
    },
  },
];
