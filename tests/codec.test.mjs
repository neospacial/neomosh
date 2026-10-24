// Plan §13.1: encoder -> Annex B -> FFmpeg, compared bit-exact with our decoder.

import { simulate, verify, probeStream, assert } from './lib/session.mjs';
import { DEFAULT_SETTINGS } from '../src/codec/encoder.js';

const S = (o) => ({ ...DEFAULT_SETTINGS, ...o });

// Visible sizes of plan §7.1 (horizontal).
const SIZES = [
  [360, 360], [480, 360], [540, 360], [640, 360],
  [480, 480], [640, 480], [720, 480], [852, 480],
  [720, 720], [960, 720], [1080, 720], [1280, 720],
];

function one(name, spec, cuts = 'mosh') {
  return verify(name, simulate(spec), cuts);
}

export const tests = [
  // Phase 1 steps 1-2.
  {
    name: 'step 2: IDR of all I_PCM, then P-frames of all P_Skip',
    fn() {
      const sim = simulate({ w: 96, h: 64, debug: { forceMode: 'skip' }, script: [{ record: 5, content: 'pan' }] });
      for (const f of sim.frames.slice(1)) assert(f.stats.skip === 24 && f.stats.inter === 0, 'not all skip');
      const { file } = verify('step2_skip', sim);
      const p = probeStream(file);
      assert(p.profile === 'Constrained Baseline', `profile ${p.profile}`);
      assert(p.width === 96 && p.height === 64, 'size');
      assert(p.color_range === 'tv' && p.color_space === 'bt709' && p.color_primaries === 'bt709' && p.color_transfer === 'bt709', 'colour');
      assert(p.has_b_frames === 0, 'has_b_frames');
    },
  },
  // Phase 1 step 3.
  {
    name: 'step 3: P_L0_16x16, full-sample vectors, no residual',
    fn() {
      for (const content of ['pan', 'square', 'noise']) {
        one(`step3_${content}`, {
          w: 112, h: 80, settings: S({ precision: 'full' }), debug: { forceMode: 'noResidual' },
          script: [{ record: 6, content, opt: { vx: 3, vy: -2 } }],
        });
      }
    },
  },
  // Phase 1 step 4.
  {
    name: 'step 4: residual (luma, chroma DC/AC), each QP',
    fn() {
      for (const qp of [16, 22, 28, 34, 40, 44]) {
        for (const content of ['pan', 'gradient', 'noise']) {
          const sim = simulate({ w: 100, h: 60, settings: S({ qp, precision: 'full' }), script: [{ record: 6, content }] });
          verify(`qp${qp}_${content}`, sim);
        }
      }
    },
  },
  // Phase 1 step 5.
  {
    name: 'step 5: each motion precision',
    fn() {
      for (const precision of ['full', 'half', 'quarter']) {
        for (const content of ['pan', 'zoom', 'gradient']) {
          one(`prec_${precision}_${content}`, { w: 128, h: 96, settings: S({ precision }), script: [{ record: 8, content }] });
        }
      }
    },
  },
  {
    name: 'step 5: motion vectors that point outside the picture',
    fn() {
      // Forced vectors: far outside (all clamped), near the edges, and every fraction.
      let k = 0;
      const forceMv = (mbx, mby) => {
        k++;
        const big = [-1200, -333, -70, -5, 0, 3, 61, 250, 1023][k % 9];
        return [big + (k % 4), -big + ((k >> 2) % 4) - (mbx + mby)];
      };
      one('mv_outside_forced', { w: 64, h: 48, debug: { forceMv }, script: [{ record: 6, content: 'noise' }] });
      // Natural motion at the edges: a fast pan.
      for (const precision of ['full', 'half', 'quarter']) {
        one(`mv_outside_pan_${precision}`, {
          w: 96, h: 64, settings: S({ precision, searchRange: 64 }),
          script: [{ record: 6, content: 'pan', opt: { vx: -9.5, vy: 7.25 } }],
        });
      }
    },
  },
  // Phase 1 step 6.
  {
    name: 'step 6: each search range and skip bias',
    fn() {
      for (const searchRange of [8, 16, 32, 64]) {
        one(`range${searchRange}`, {
          w: 160, h: 96, settings: S({ searchRange, precision: 'quarter' }),
          script: [{ record: 8, content: 'square', opt: { speed: 13, size: 40 } }],
        });
      }
      let prevSkips = -1;
      for (const skipBias of [0, 50, 100]) {
        const sim = simulate({ w: 128, h: 96, settings: S({ skipBias, qp: 34 }), script: [{ record: 6, content: 'pan', opt: { vx: 1, vy: 0 } }] });
        const skips = sim.frames.reduce((a, f) => a + f.stats.skip, 0);
        if (skipBias === 0) assert(skips === 0, 'skip bias 0 must give no P_Skip');
        assert(skips >= prevSkips, 'more skip bias must not give fewer P_Skip');
        prevSkips = skips;
        verify(`skipbias${skipBias}`, sim);
      }
    },
  },
  // Phase 1 step 7.
  {
    name: 'step 7: heal Off, Low, High (scene change, R-01, R-03)',
    fn() {
      const pcm = {};
      for (const heal of ['off', 'low', 'high']) {
        const sim = simulate({ w: 128, h: 96, settings: S({ heal }), script: [{ record: 8, content: 'sceneChange' }] });
        // R-01, R-02: one IDR, then only P-frames, also at the scene change.
        assert(sim.frames[0].type === 'idr' && sim.frames.slice(1).every((f) => f.type === 'p'), 'frame types');
        pcm[heal] = sim.frames.slice(1).reduce((a, f) => a + f.stats.pcm, 0);
        verify(`heal_${heal}`, sim);
      }
      assert(pcm.off === 0, 'R-03: Heal Off must not code intra macroblocks');
      assert(pcm.high > 0 && pcm.high >= pcm.low, `heal must code I_PCM at the scene change (low ${pcm.low}, high ${pcm.high})`);
    },
  },
  // Phase 1 step 8.
  {
    name: 'step 8: one cut, as Mosh and as Clean',
    fn() {
      const spec = {
        w: 128, h: 96,
        script: [{ record: 5, content: 'pan' }, { pause: true }, { record: 5, content: 'square', opt: { speed: 4 } }],
      };
      for (const cuts of ['mosh', 'clean']) one(`cut1_${cuts}`, spec, cuts);
    },
  },
  {
    name: 'step 8: many cuts, mixed Mosh and Clean, settings changed while paused',
    fn() {
      const script = [];
      const contents = ['pan', 'zoom', 'square', 'noise', 'gradient', 'pan'];
      const settings = [{}, { qp: 40, precision: 'full' }, { qp: 20, precision: 'quarter', searchRange: 8 }, { heal: 'low' }, { skipBias: 90 }, { qp: 28 }];
      contents.forEach((content, i) => {
        if (i) script.push({ pause: true }, { settings: settings[i] });
        script.push({ record: 3 + (i % 3), content });
      });
      const sim = simulate({ w: 112, h: 80, script });
      for (const cuts of ['mosh', 'clean', ['clean', 'mosh', 'clean', 'mosh', 'mosh'], ['mosh', 'clean', 'clean', 'mosh', 'clean']]) {
        verify(`cuts_many_${Array.isArray(cuts) ? cuts.join('-') : cuts}`, sim, cuts);
      }
    },
  },
  {
    name: 'step 8: cut on frame 1 of a clip (one-frame clips)',
    fn() {
      // Clip 1 = only the IDR. Clip 2 = only its hidden I-frame. Then a normal clip.
      const sim = simulate({
        w: 96, h: 64,
        script: [{ record: 1 }, { pause: true }, { record: 1, content: 'zoom' }, { pause: true }, { record: 4, content: 'square' }],
      });
      assert(sim.frames.map((f) => f.type).join() === 'idr,hiddenI,hiddenI,p,p,p', 'frame types');
      for (const cuts of ['mosh', 'clean', ['clean', 'mosh'], ['mosh', 'clean']]) {
        verify(`cut_frame1_${Array.isArray(cuts) ? cuts.join('-') : cuts}`, sim, cuts);
      }
    },
  },
  {
    name: 'revert to a pause point, then more clips',
    fn() {
      const sim = simulate({
        w: 96, h: 64,
        script: [
          { record: 4 }, { pause: true }, { record: 3, content: 'square' }, { pause: true }, { record: 3, content: 'noise' }, { pause: true },
          { revert: 1 }, { record: 4, content: 'zoom' }, { pause: true }, { record: 2, content: 'gradient' },
        ],
      });
      assert(sim.frames.map((f) => f.type).join() === 'idr,p,p,p,hiddenI,p,p,p,hiddenI,p', 'frame types after revert');
      for (const cuts of ['mosh', 'clean']) verify(`revert1_${cuts}`, sim, cuts);
      const sim0 = simulate({
        w: 96, h: 64,
        script: [{ record: 3 }, { pause: true }, { record: 3, content: 'square' }, { pause: true }, { revert: 0 }, { record: 3, content: 'zoom' }, { pause: true }, { record: 3 }],
      });
      assert(sim0.frames.map((f) => f.type).join() === 'idr,p,p,hiddenI,p,p', 'frame types after revert to start');
      verify('revert0', sim0);
    },
  },
  {
    name: 'each visible size of plan §7.1, both orientations (cropping)',
    fn() {
      for (const [a, b] of SIZES) {
        for (const [w, h] of a === b ? [[a, b]] : [[a, b], [b, a]]) {
          one(`size_${w}x${h}`, { w, h, script: [{ record: 2, content: 'pan' }, { pause: true }, { record: 2, content: 'zoom' }] });
        }
      }
    },
  },
];
