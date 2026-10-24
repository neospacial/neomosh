// Phase 0: the build makes standalone pages. R-10: the shipped files make no network requests.

import vm from 'node:vm';
import { buildPage, bundle, CODEC_MODULES, PAGES } from '../tools/build.mjs';
import { assert } from './lib/session.mjs';

export const tests = [
  {
    name: 'each page builds, with no external URLs',
    fn() {
      for (const [tpl] of PAGES) {
        const html = buildPage(tpl);
        assert(!/@(VERSION|WORKER|css|js|modules)/.test(html.replace(/@media/g, '')), `${tpl}: marker left`);
        assert(!/https?:\/\//i.test(html), `${tpl}: contains a URL`);
        assert(!/\b(fetch|XMLHttpRequest|importScripts|WebSocket)\s*\(/.test(html), `${tpl}: network API`);
        // Each inline script compiles.
        for (const m of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) new vm.Script(m[1], { filename: tpl });
      }
    },
  },
  {
    name: 'the codec bundle runs as a classic script (worker) and encodes/decodes',
    fn() {
      const code = bundle(CODEC_MODULES) + `
        const enc = new Encoder(32, 32), dec = new Decoder(32, 32);
        const Y = new Uint8Array(1024).fill(100), U = new Uint8Array(256).fill(128), V = new Uint8Array(256).fill(128);
        for (let t = 0; t < 3; t++) { Y[t * 40] = 200; dec.decodePacket(enc.encode(Y, U, V)); }
        result = dec.Y.every((v, i) => v === enc.recY[i]);`;
      const ctx = { result: false };
      vm.runInNewContext(code, ctx);
      assert(ctx.result === true, 'bundle encode/decode mismatch');
    },
  },
];
