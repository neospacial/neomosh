// D33: coded I-frames (Intra 16x16). FFmpeg gives the same pictures as our decoder, the encoder
// reconstruction is the decoder output, and the frames are much smaller than I_PCM.

import { simulate, verify, assert } from './lib/session.mjs';
import { DEFAULT_SETTINGS } from '../src/codec/encoder.js';

const S = (o) => ({ ...DEFAULT_SETTINGS, ...o });

export const tests = [
  {
    name: 'Intra 16x16: all contents, odd sizes, QP 16 to 44 (the app range; 36 and more: the other DC scaling), Mosh and Clean cuts, FFmpeg identical',
    fn() {
      const cases = [
        { w: 176, h: 144, qp: 28 }, { w: 90, h: 62, qp: 16 }, { w: 130, h: 98, qp: 44 }, { w: 64, h: 48, qp: 38 }, { w: 320, h: 240, qp: 20 },
      ];
      for (const c of cases) {
        for (const content of ['pan', 'noise', 'square', 'zoom', 'gradient', 'sceneChange']) {
          const sim = simulate({
            w: c.w, h: c.h, settings: S({ qp: c.qp }),
            script: [{ record: 2, content }, { pause: true }, { record: 2, content: 'noise' }, { pause: true }, { record: 2, content }],
          });
          assert(sim.frames.filter((f) => f.type !== 'p').every((f) => f.stats.intra > 0 && !f.stats.pcm), 'the I-frames are Intra 16x16');
          for (const cuts of ['mosh', 'clean']) verify(`intra_${c.w}x${c.h}_q${c.qp}_${content}_${cuts}`, sim, cuts);
        }
      }
    },
  },
  {
    name: 'Intra 16x16 I-frames are much smaller than I_PCM; I_PCM (old sessions) still decodes',
    fn() {
      const spec = { w: 320, h: 240, script: [{ record: 2, content: 'zoom' }] };
      const coded = simulate(spec).frames[0], pcm = simulate({ ...spec, debug: { pcmI: true } });
      assert(coded.bits.length * 4 < pcm.frames[0].bits.length, `Intra 16x16 ${coded.bits.length} B, I_PCM ${pcm.frames[0].bits.length} B`);
      verify('intra_pcm_old', pcm, 'clean');
    },
  },
];
