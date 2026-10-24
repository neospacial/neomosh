// Make sample MP4 files for device tests (plan §13.4, Phase 2: iOS Photos and QuickTime).
// Usage: node tools/sample.mjs  ->  samples/neomosh-sample-{mosh,clean}-v<version>.mp4
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { simulate } from '../tests/lib/session.mjs';
import { Remuxer } from '../src/mux/remux.js';
import { VERSION } from './build.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'samples');
fs.mkdirSync(out, { recursive: true });
// About 8 s at 30 fps, 640x480, three cuts, some dropped frames (variable durations).
const sim = simulate({
  w: 640, h: 480,
  duration: (k) => (k % 47 === 46 ? 66667 : 33333),
  script: [
    { record: 60, content: 'pan', opt: { vx: 3, vy: 1 } }, { pause: true },
    { record: 60, content: 'zoom' }, { pause: true },
    { record: 60, content: 'square', opt: { speed: 7, size: 120 } }, { pause: true },
    { record: 60, content: 'pan', opt: { vx: -4, vy: 2 } },
  ],
});
for (const cuts of ['mosh', 'clean']) {
  const rx = new Remuxer(sim.params, { cuts });
  for (const f of sim.frames) rx.add(f);
  const r = rx.finish();
  const file = path.join(out, `neomosh-sample-${cuts}-v${VERSION}.mp4`);
  fs.writeFileSync(file, Buffer.concat(r.parts.map((a) => Buffer.from(a.buffer, a.byteOffset, a.byteLength))));
  console.log(`${path.relative(root, file)} (${(r.size / 1024).toFixed(0)} KB, ${r.samples.length} frames)`);
}
