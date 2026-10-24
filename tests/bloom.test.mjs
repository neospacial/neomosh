// Bloom (plan §15): a repeated P-frame. The stream stays valid, FFmpeg gives the same pictures as our
// decoder, and the encoder reference follows the decoder, so the frames after a bloom are correct.

import { simulate, verify, assert } from './lib/session.mjs';
import { Decoder } from '../src/codec/decoder.js';

export const tests = [
  {
    name: 'bloom: repeated P-frames decode the same in FFmpeg and our decoder; recording continues correctly',
    fn() {
      const sim = simulate({ w: 96, h: 64, script: [{ record: 10, content: 'square' }, { bloom: 8 }, { record: 6, content: 'square' }] });
      const blooms = sim.frames.filter((f) => f.bloom);
      assert(blooms.length === 8 && blooms.every((f) => f.type === 'p'), 'bloom frames');
      // The bits of each bloom frame are the same as the last P-frame before it.
      const src = sim.frames[9];
      assert(blooms.every((f) => f.bitLen === src.bitLen && Buffer.compare(Buffer.from(f.bits), Buffer.from(src.bits)) === 0), 'bloom bits');
      // The picture changes with each repeat (the motion is applied again).
      const dec = new Decoder(96, 64);
      const pics = sim.frames.map((f) => (dec.decodePacket(f), dec.Y.slice()));
      assert(Buffer.compare(Buffer.from(pics[10]), Buffer.from(pics[11])) !== 0, 'a repeat must move the picture');
      verify('bloom', sim); // recon = decoder at each frame, FFmpeg identical, valid MP4
    },
  },
  {
    name: 'bloom clip while paused (D24): with I_PCM heal blocks, then a cut; Mosh and Clean',
    fn() {
      // As in the app: record, pause, bloom (a clip of its own), pause point, record (hidden I-frame).
      const sim = simulate({
        w: 128, h: 96, settings: { qp: 30, searchRange: 16, precision: 'quarter', skipBias: 20, heal: 'high' },
        script: [{ record: 6, content: 'zoom' }, { pause: true }, { bloom: 5 }, { pause: true }, { record: 4, content: 'square' },
          { pause: true }, { bloom: 6 }, { pause: true }, { record: 4, content: 'noise' }],
      });
      const types = sim.frames.map((f) => (f.bloom ? 'b' : f.type[0])).join('');
      assert(types === 'ipppppbbbbbhpppbbbbbbhppp', `frame order ${types}`);
      for (const cuts of ['mosh', 'clean']) verify(`bloom_${cuts}`, sim, cuts);
    },
  },
];
