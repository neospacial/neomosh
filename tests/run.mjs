// Test runner. Each tests/*.test.mjs file exports `tests`: [{ name, fn }].
// Usage: node tests/run.mjs [filter]
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const dir = path.dirname(new URL(import.meta.url).pathname);
const filter = process.argv[2] || '';
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.test.mjs')).sort();
let pass = 0;
let fail = 0;
const t0 = Date.now();
for (const f of files) {
  const mod = await import(pathToFileURL(path.join(dir, f)));
  for (const t of mod.tests) {
    const name = `${f.replace('.test.mjs', '')}: ${t.name}`;
    if (filter && !name.includes(filter)) continue;
    const s = Date.now();
    try {
      await t.fn();
      pass++;
      console.log(`ok    ${name} (${Date.now() - s} ms)`);
    } catch (e) {
      fail++;
      console.log(`FAIL  ${name}\n      ${e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n      ') : e}`);
    }
  }
}
console.log(`\n${pass} passed, ${fail} failed (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
process.exit(fail ? 1 : 0);
