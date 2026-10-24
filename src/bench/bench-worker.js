// Benchmark worker (R-06: the codec runs in a worker, not on the main thread).
import { BENCH_SIZES, BENCH_PRESETS, benchCase, formatResults, verdict } from './bench-core.js';

self.onmessage = (e) => {
  const frames = e.data.frames || 30;
  const results = [];
  try {
    benchCase(320, 240, BENCH_PRESETS[2], 10); // Warm-up (JIT). Not reported.
    for (const [w, h] of BENCH_SIZES) {
      for (const preset of BENCH_PRESETS) {
        const r = benchCase(w, h, preset, frames);
        results.push(r);
        self.postMessage({ type: 'result', r, verdict: verdict(r), total: BENCH_SIZES.length * BENCH_PRESETS.length });
      }
    }
    self.postMessage({ type: 'done', text: formatResults(results) });
  } catch (err) {
    self.postMessage({ type: 'error', message: String(err && err.stack ? err.stack : err) });
  }
};
