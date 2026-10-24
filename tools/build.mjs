// Build: inline all sources into one standalone HTML file for each page (R-10).
//   dist/neomosh-v<version>.html        the app
//   dist/neomosh-bench-v<version>.html  the benchmark page (plan §13.5)
// Usage: node tools/build.mjs
//
// HTML templates use these markers:
//   <!--@css:path-->      inline a stylesheet
//   <!--@js:path-->       inline a classic script
//   "@WORKER:a.js,b.js"   a JSON string with the bundled modules (for a Blob URL worker).
//                         The name "codec" means all CODEC_MODULES.
//   @VERSION@             the version from package.json

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'src');
export const VERSION = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;

// Codec modules in dependency order.
export const CODEC_MODULES = [
  'codec/bitio.js', 'codec/tables.js', 'codec/transform.js', 'codec/inter.js', 'codec/mvpred.js',
  'codec/cavlc.js', 'codec/headers.js', 'codec/color.js', 'codec/decoder.js', 'codec/encoder.js',
];

const IMPORT_RE = /^import\s[\s\S]*?from\s+['"][^'"]+['"];?[ \t]*$/gm;
const EXPORT_RE = /^export\s+((?:async\s+)?(?:function\*?|class|const|let|var)\s+([A-Za-z0-9_$]+))/gm;

// Bundle ES modules into one classic script. Each module runs in its own function scope.
// Its exports become top-level constants, which the next modules use in place of their imports.
export function bundle(files) {
  const parts = [];
  for (const f of files) {
    let code = fs.readFileSync(path.join(src, f), 'utf8');
    code = code.replace(IMPORT_RE, '');
    const names = [];
    code = code.replace(EXPORT_RE, (m, decl, name) => {
      names.push(name);
      return decl;
    });
    if (/^export\s/m.test(code)) throw new Error(`${f}: unsupported export form`);
    parts.push(`// ---- ${f}\nconst { ${names.join(', ')} } = (() => {\n${code}\nreturn { ${names.join(', ')} };\n})();\n`);
  }
  return parts.join('\n');
}

const safeScript = (s) => s.replace(/<\/script/gi, '<\\/script');

export function buildPage(template) {
  const dir = path.join(src, path.dirname(template));
  let html = fs.readFileSync(path.join(src, template), 'utf8');
  html = html.replace(/<!--@css:([^>]+?)-->/g, (m, f) => `<style>\n${fs.readFileSync(path.join(dir, f), 'utf8')}</style>`);
  html = html.replace(/<!--@js:([^>]+?)-->/g, (m, f) => `<script>\n${safeScript(fs.readFileSync(path.join(dir, f), 'utf8'))}</script>`);
  html = html.replace(/"@WORKER:([^"]+)"/g, (m, list) => safeScript(JSON.stringify(bundle(list.split(',').flatMap((s) => (s.trim() === 'codec' ? CODEC_MODULES : [s.trim()]))))));
  return html.replace(/@VERSION@/g, VERSION);
}

export const PAGES = [
  ['app/index.html', `neomosh-v${VERSION}.html`],
  ['bench/bench.html', `neomosh-bench-v${VERSION}.html`],
];

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dist = path.join(root, 'dist');
  fs.mkdirSync(dist, { recursive: true });
  for (const [tpl, out] of PAGES) {
    const html = buildPage(tpl);
    fs.writeFileSync(path.join(dist, out), html);
    console.log(`dist/${out} (${(html.length / 1024).toFixed(0)} KB)`);
  }
}
