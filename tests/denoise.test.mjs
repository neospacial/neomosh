// D35: denoise before the encoder. The stream stays valid (FFmpeg gives the same pictures as our
// decoder), the noise costs fewer bits, and the caller's planes do not change.

import { simulate, verify, assert } from './lib/session.mjs';
import { DEFAULT_SETTINGS, Encoder } from '../src/codec/encoder.js';

const S = (o) => ({ ...DEFAULT_SETTINGS, ...o });

export const tests = [
  {
    name: 'denoise: valid streams (Mosh and Clean), fewer bits on noise, the input planes do not change',
    fn() {
      const script = [{ record: 6, content: 'noise' }, { pause: true }, { record: 4, content: 'pan' }];
      const size = (sim) => sim.frames.slice(1).reduce((a, f) => a + f.bits.length, 0);
      const sims = {};
      for (const denoise of ['off', 'low', 'high']) {
        sims[denoise] = simulate({ w: 160, h: 120, settings: S({ denoise }), script });
        for (const cuts of ['mosh', 'clean']) verify(`denoise_${denoise}_${cuts}`, sims[denoise], cuts);
      }
      assert(size(sims.high) < 0.9 * size(sims.off), `high ${size(sims.high)} B, off ${size(sims.off)} B`);
      // The caller's planes are not changed by the filter.
      const enc = new Encoder(64, 48, S({ denoise: 'high' }));
      const Y = new Uint8Array(64 * 48).map((_, i) => (i * 37) & 255), U = new Uint8Array(32 * 24).fill(100), V = new Uint8Array(32 * 24).fill(150);
      const y0 = Y.slice();
      for (let k = 0; k < 3; k++) enc.encode(Y, U, V);
      assert(Buffer.compare(Buffer.from(Y), Buffer.from(y0)) === 0, 'the input plane changed');
    },
  },
];
