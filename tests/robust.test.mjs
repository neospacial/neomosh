// Robustness: no live view pictures when the view is hidden (Mosh preview off), and the History player
// closed while it opens or plays (no hung work, no errors, it opens again).

import { assert } from './lib/session.mjs';
import { chromium, openApp, checkMp4 } from './lib/app.mjs';

const skip = () => console.log('      (skipped: Playwright is not available)');

// Count the pictures drawn on the decoded live view (#mosh).
function countMosh() {
  window.__moshDraws = 0;
  const draw = CanvasRenderingContext2D.prototype.drawImage;
  CanvasRenderingContext2D.prototype.drawImage = function (...a) {
    if (this.canvas && this.canvas.id === 'mosh') window.__moshDraws++;
    return draw.apply(this, a);
  };
}

export const tests = [
  {
    name: 'Mosh preview off: the decoder sends no live view pictures; the pause point and the export are the same',
    async fn() {
      if (!chromium) return skip();
      const h = await openApp('previewOff', { init: countMosh });
      try {
        const { page } = h;
        await h.start();
        await h.clip(1200);
        const on = await page.evaluate(() => window.__moshDraws);
        assert(on > 5, `preview on: ${on} pictures on the live view`);
        await page.click('#gearBtn');
        await page.click('.seg[data-key="preview"] button[data-v="0"]');
        await page.click('#settingsSheet .done');
        await page.evaluate(() => (window.__moshDraws = 0));
        await h.clip(1200);
        const off = await page.evaluate(() => window.__moshDraws);
        assert(off === 0, `preview off: ${off} pictures on the live view`);
        const overlay = await h.canvas('overlay');
        assert(overlay.data.some((v, i) => i % 4 !== 3 && v > 0), 'the pause overlay has the picture');
        const db = await h.db();
        assert(db.points.length === 3 && db.points.every((p) => p.n === 0 || p.ref), 'pause points with pictures');
        const s = db.sessions[0];
        const mp4 = await h.exportMp4('previewOff.mp4');
        assert(checkMp4(mp4, s.w, s.h).count === db.frames.filter((f) => f.type !== 'hiddenI').length, 'export frame count');
        assert(!h.errors.length, `page errors: ${h.errors.join(' | ')}`);
      } finally {
        await h.close();
      }
    },
  },
  {
    name: 'History: closed while it opens and while it plays, then opened again: seek and play work, no errors',
    async fn() {
      if (!chromium) return skip();
      const h = await openApp('playerClose');
      try {
        const { page } = h;
        await h.start();
        await h.clip(1500);
        await h.clip(1500);
        // Close at once, several times (the worker is still starting).
        for (let i = 0; i < 4; i++) {
          await page.click('#thumbBtn');
          await h.waitState('review');
          await page.click('#reviewSheet .done');
          await h.waitState('paused');
        }
        // Close while it plays.
        await page.click('#thumbBtn');
        await h.waitState('review');
        await page.waitForFunction(() => document.getElementById('player').dataset.t === '0', null, { timeout: 20000 });
        await page.click('#playBtn');
        await page.waitForSelector('body[data-playing="1"]');
        await page.waitForTimeout(300);
        await page.click('#reviewSheet .done');
        await h.waitState('paused');
        // Open again: seek to the middle, then play to the end.
        await page.click('#thumbBtn');
        await h.waitState('review');
        await page.waitForFunction(() => document.querySelectorAll('#cards .card').length === 3);
        await page.waitForFunction(() => document.getElementById('player').dataset.t === '0', null, { timeout: 20000 });
        await page.$eval('#scrub', (sc) => {
          sc.value = 500;
          sc.dispatchEvent(new Event('input'));
          sc.dispatchEvent(new Event('change'));
        });
        await page.waitForFunction(() => Number(document.getElementById('player').dataset.t) > 0, null, { timeout: 20000 });
        await page.click('#playBtn');
        await page.waitForSelector('body[data-playing="1"]');
        await page.waitForSelector('body[data-playing="0"]', { timeout: 20000 });
        const t = await page.evaluate(() => Number(document.getElementById('player').dataset.t));
        const end = (await h.db()).points.reduce((a, p) => Math.max(a, p.tsUs), 0);
        assert(t === end, `played to ${t} us, the end is ${end} us`);
        await page.click('#reviewSheet .done');
        await h.waitState('paused');
        await h.clip(800); // the recorder works after all this
        assert(!h.errors.length, `page errors: ${h.errors.join(' | ')}`);
      } finally {
        await h.close();
      }
    },
  },
];
