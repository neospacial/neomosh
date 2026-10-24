// D21: the WebAssembly kernels give exactly the same streams and pictures as the JavaScript codec.

import { simulate, assert } from './lib/session.mjs';
import { setWasmEnabled, Kernels } from '../src/codec/wasm.js';
import { Decoder } from '../src/codec/decoder.js';
import { DEFAULT_SETTINGS } from '../src/codec/encoder.js';

const S = (o) => ({ ...DEFAULT_SETTINGS, ...o });

const SPECS = {
  qp16_quarter: { w: 100, h: 60, settings: S({ qp: 16, precision: 'quarter', searchRange: 64 }), script: [{ record: 8, content: 'pan', opt: { vx: -7.3, vy: 4.6 } }] },
  qp44_full: { w: 128, h: 96, settings: S({ qp: 44, precision: 'full', searchRange: 8 }), script: [{ record: 8, content: 'zoom' }] },
  heal_scene: { w: 128, h: 96, settings: S({ heal: 'high', skipBias: 90 }), script: [{ record: 8, content: 'sceneChange' }] },
  skipbias0: { w: 96, h: 64, settings: S({ skipBias: 0 }), script: [{ record: 6, content: 'noise' }] },
  forced_skip: { w: 96, h: 64, debug: { forceMode: 'skip' }, script: [{ record: 5, content: 'pan' }] },
  forced_nores: { w: 96, h: 64, debug: { forceMode: 'noResidual' }, script: [{ record: 5, content: 'square' }] },
  forced_mv: {
    w: 64, h: 48, script: [{ record: 6, content: 'noise' }],
    debug: { forceMv: (mbx, mby) => [[-1200, -333, -70, 3, 61, 250, 1023][(mbx * 3 + mby) % 7] + (mbx & 3), 37 - mby * 41] },
  },
  cuts_revert: {
    w: 112, h: 80,
    script: [
      { record: 4 }, { pause: true }, { settings: { precision: 'quarter', qp: 22 } }, { record: 4, content: 'square' }, { pause: true },
      { record: 3, content: 'gradient' }, { pause: true }, { revert: 1 }, { record: 4, content: 'zoom' },
    ],
  },
  size_720: { w: 1280, h: 720, script: [{ record: 3, content: 'pan' }] },
};

function run(spec, wasm) {
  setWasmEnabled(wasm);
  try {
    const sim = simulate(spec);
    assert(!!sim.encoder.k === wasm, `encoder kernels: expected ${wasm}`);
    const dec = new Decoder(spec.w, spec.h);
    assert(!!dec.k === wasm, `decoder kernels: expected ${wasm}`);
    const pics = [];
    for (const f of sim.frames) {
      dec.decodePacket(f, f.type === 'hiddenI');
      pics.push(Buffer.from(dec.Y), Buffer.from(dec.U), Buffer.from(dec.V));
    }
    return { frames: sim.frames, recon: sim.recon, pics: Buffer.concat(pics) };
  } finally {
    setWasmEnabled(true);
  }
}

export const tests = [
  {
    name: 'the kernels are available in Node',
    fn() {
      assert(Kernels.create() !== null, 'WebAssembly SIMD kernels did not load');
    },
  },
  {
    name: 'WebAssembly and JavaScript give bit-identical streams, reconstructions, and decoded pictures',
    fn() {
      for (const [name, spec] of Object.entries(SPECS)) {
        const a = run(spec, true), b = run(spec, false);
        assert(a.frames.length === b.frames.length, `${name}: frame count`);
        a.frames.forEach((f, i) => {
          const g = b.frames[i];
          assert(f.type === g.type && f.bitLen === g.bitLen && f.hdrBits === g.hdrBits && Buffer.compare(Buffer.from(f.bits), Buffer.from(g.bits)) === 0,
            `${name}: frame ${i} (${f.type}) differs: ${f.bitLen} / ${g.bitLen} bits`);
          assert(JSON.stringify(f.stats) === JSON.stringify(g.stats), `${name}: frame ${i} stats`);
          for (const k of ['Y', 'U', 'V']) assert(Buffer.compare(Buffer.from(a.recon[i][k]), Buffer.from(b.recon[i][k])) === 0, `${name}: frame ${i} recon ${k}`);
        });
        assert(Buffer.compare(a.pics, b.pics) === 0, `${name}: decoded pictures differ`);
      }
    },
  },
];
