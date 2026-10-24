// Node benchmark (plan §13.5). Usage: node tools/bench.mjs [frames]
// For the phone measurement, open dist/neomosh-bench-v<version>.html on the phone.
import os from 'node:os';
import { BENCH_SIZES, BENCH_PRESETS, benchCase, formatResults, usesWasm } from '../src/bench/bench-core.js';

const frames = Number(process.argv[2]) || 30;
const results = [];
benchCase(320, 240, BENCH_PRESETS[2], 10); // Warm-up (JIT). Not reported.
for (const [w, h] of BENCH_SIZES) {
  for (const preset of BENCH_PRESETS) {
    const r = benchCase(w, h, preset, frames);
    results.push(r);
    console.log(formatResults([r]).split('\n')[1]);
  }
}
console.log('\n' + formatResults(results, `Node ${process.version}, ${os.cpus()[0].model}, codec: ${usesWasm() ? 'WebAssembly SIMD' : 'JavaScript'}`));
