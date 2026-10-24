// Benchmark page: starts the worker (from a Blob URL, R-10) and shows the results.
(() => {
  const $ = (id) => document.getElementById(id);
  let text = '';

  function deviceInfo() {
    return `neomosh benchmark v${document.title.split(' ').pop()}\n${navigator.userAgent}\n` +
      `cores: ${navigator.hardwareConcurrency || '?'}, screen: ${screen.width}x${screen.height} @${devicePixelRatio}x\n`;
  }

  $('run').onclick = () => {
    $('run').disabled = true;
    $('copy').disabled = true;
    $('rows').textContent = '';
    $('out').textContent = '';
    const url = URL.createObjectURL(new Blob([WORKER_SRC], { type: 'text/javascript' }));
    const worker = new Worker(url);
    let n = 0;
    const t0 = performance.now();
    $('status').textContent = 'Running…';
    worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'result') {
        n++;
        const r = m.r;
        const tr = document.createElement('tr');
        const cls = m.verdict.startsWith('30') ? 'good' : m.verdict === 'too slow' ? 'bad' : 'mid';
        for (const [v, c] of [[`${r.w}×${r.h}`], [r.preset], [r.encMs.toFixed(1)], [r.encP95.toFixed(1)],
          [r.decMs.toFixed(1)], [r.kbPerFrame.toFixed(1)], [m.verdict, cls]]) {
          const td = document.createElement('td');
          td.textContent = v;
          if (c) td.className = c;
          tr.appendChild(td);
        }
        $('rows').appendChild(tr);
        $('status').textContent = `Running… ${n} of ${m.total}`;
      } else if (m.type === 'done' || m.type === 'error') {
        worker.terminate();
        URL.revokeObjectURL(url);
        $('run').disabled = false;
        const secs = ((performance.now() - t0) / 1000).toFixed(0);
        if (m.type === 'done') {
          text = `${deviceInfo()}frames per case: ${$('frames').value}, time: ${secs} s\n\n${m.text}\n`;
          $('status').textContent = `Done in ${secs} s. Tap "Copy results" and send the text to Ryan's repo or chat.`;
          $('copy').disabled = false;
        } else {
          text = `${deviceInfo()}ERROR\n${m.message}\n`;
          $('status').textContent = 'The benchmark stopped with an error.';
          $('copy').disabled = false;
        }
        $('out').textContent = text;
      }
    };
    worker.onerror = (e) => {
      $('status').textContent = `Worker error: ${e.message}`;
      $('run').disabled = false;
    };
    worker.postMessage({ frames: Number($('frames').value) });
  };

  $('copy').onclick = async () => {
    try {
      await navigator.clipboard.writeText(text);
      $('status').textContent = 'Copied.';
    } catch {
      const range = document.createRange();
      range.selectNodeContents($('out'));
      getSelection().removeAllRanges();
      getSelection().addRange(range);
      $('status').textContent = 'Select and copy the text below.';
    }
  };
})();
