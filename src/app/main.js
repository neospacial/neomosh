// neomosh app: user interface (plan §11). Camera, focus, and layout code are from neocamera v1.5.0.
/* global VERSION, WORKER_SRC */

import { remuxOriginal } from '../mux/remux.js';
import { sessionSize, fileStamp, formatTime } from './geometry.js';
import { Store } from './store.js';
import { Recorder, ST } from './recorder.js';

const $ = (id) => document.getElementById(id);
const el = {
  body: document.body,
  stage: $('stage'), frame: $('frame'), preview: $('preview'), mosh: $('mosh'), overlay: $('overlay'),
  toast: $('toast'), timer: $('timer'), clipLbl: $('clipLbl'), shutter: $('shutter'), flip: $('flip'),
  thumbBtn: $('thumbBtn'), thumbImg: $('thumbImg'), slider: $('opacity'), pct: $('pct'),
  orientBtn: $('orientBtn'), ratios: [...document.querySelectorAll('.ratio')],
  focusBox: $('focusBox'), expoSun: $('expoSun'),
  gearBtn: $('gearBtn'), exportBtn: $('exportBtn'), dropBadge: $('dropBadge'), dropN: $('dropN'), micBadge: $('micBadge'),
  gate: $('gate'), gateTitle: $('gateTitle'), gateText: $('gateText'), gateBtn: $('gateBtn'),
  sheetBack: $('sheetBack'), info: $('info'), lockHint: $('lockHint'),
  cutList: $('cutList'), allCuts: $('allCuts'), progress: $('progress').firstElementChild, exportMsg: $('exportMsg'),
  exportGo: $('exportGo'), exportCancel: $('exportCancel'), exportShare: $('exportShare'), exportDownload: $('exportDownload'),
};

// Display and session preferences. Kept in localStorage (a per-viewer convenience only).
const PREF_KEY = 'neomosh.prefs';
const S = {
  facing: 'environment',
  aspect: '4:3',
  orient: 'auto', // auto, v, or h
  size: 480,
  fps: 30,
  preview: true,
  mirrorFront: true,
  stream: null,
  hasVideo: false,
  multiCam: true,
  expoCap: null,
  expoVal: 0,
  locked: false,
  focusActive: false,
  focusTimers: [],
};
try {
  Object.assign(S, JSON.parse(localStorage.getItem(PREF_KEY) || '{}'));
} catch {
  /* no stored preferences */
}
function savePrefs() {
  try {
    const { aspect, size, fps, preview, mirrorFront } = S;
    localStorage.setItem(PREF_KEY, JSON.stringify({ aspect, size, fps, preview, mirrorFront }));
  } catch {
    /* storage not available */
  }
}

let store = null;
let rec = null;

/* ---------------- helpers ---------------- */

function toast(msg, ms = 2600) {
  el.toast.textContent = msg;
  el.toast.classList.add('show');
  clearTimeout(toast.id);
  toast.id = setTimeout(() => el.toast.classList.remove('show'), ms);
}

function save(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

const videoTrack = () => (S.stream ? S.stream.getVideoTracks()[0] || null : null);
const state = () => (rec ? rec.state : 'gate');
const sessionLocked = () => !!(rec && rec.hasFrames);
// D8: the front camera is mirrored as displayed, and encoded the same way.
const mirrored = () => S.facing === 'user' && S.mirrorFront;

/* ---------------- frame geometry ---------------- */

function isPortrait() {
  if (S.orient === 'v') return true;
  if (S.orient === 'h') return false;
  const r = el.stage.getBoundingClientRect();
  return r.height >= r.width;
}

// The picture size: the locked session size, or the size that the next recording will use.
function pictureSize() {
  if (sessionLocked()) return { w: rec.session.w, h: rec.session.h };
  return sessionSize(S.size, S.aspect, isPortrait());
}

function layoutFrame() {
  const r = el.stage.getBoundingClientRect();
  if (!r.width || !r.height) return;
  const { w: pw, h: ph } = pictureSize();
  const a = pw / ph;
  let w = r.width, h = w / a;
  if (h > r.height) {
    h = r.height;
    w = h * a;
  }
  el.frame.style.width = Math.round(w) + 'px';
  el.frame.style.height = Math.round(h) + 'px';
}

function setAspect(a) {
  if (sessionLocked()) return;
  S.aspect = a;
  savePrefs();
  relayout();
}

function setOrient() {
  if (sessionLocked()) return;
  S.orient = isPortrait() ? 'h' : 'v';
  relayout();
}

function updateRatioLabels() {
  const p = isPortrait();
  el.ratios.forEach((b) => {
    b.textContent = p ? b.dataset.v : b.dataset.a;
    b.classList.toggle('active', b.dataset.a === S.aspect);
  });
  el.orientBtn.textContent = p ? 'Vertical' : 'Horizontal';
}

function relayout() {
  updateRatioLabels();
  layoutFrame();
}

/* ---------------- camera ---------------- */

function videoWanted(facing) {
  return { facingMode: { ideal: facing }, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } };
}

function stopStream() {
  if (!S.stream) return;
  S.stream.getTracks().forEach((t) => t.stop());
  S.stream = null;
}

async function startStream(facing) {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    showGate('Not available', 'This browser does not give access to the camera. Open the page with https or localhost.');
    return false;
  }
  stopStream();
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: videoWanted(facing), audio: false });
    applyStream(stream, facing);
    return true;
  } catch (err) {
    const why = err && err.name === 'NotAllowedError'
      ? 'Permission was refused. Give permission to the camera, then try again.'
      : 'No camera was found.';
    showGate('No access', why);
    return false;
  }
}

function applyStream(stream, facing) {
  S.stream = stream;
  S.facing = facing;
  S.hasVideo = stream.getVideoTracks().length > 0;
  clearFocus();
  el.preview.srcObject = stream;
  el.preview.classList.toggle('mirror', mirrored());
  const p = el.preview.play();
  if (p && p.catch) p.catch(() => {});
  readCapabilities();
  const t = videoTrack();
  // R-24: the camera stopped -> pause.
  if (t) t.addEventListener('ended', () => rec && rec.pause('The camera stopped. Recording paused.'));
  hideGate();
  refreshUI();
  countCameras();
  layoutFrame();
  setTimeout(layoutFrame, 150);
}

function readCapabilities() {
  const t = videoTrack();
  S.expoCap = null;
  if (!t || !t.getCapabilities) return;
  let caps;
  try {
    caps = t.getCapabilities() || {};
  } catch {
    return;
  }
  if (caps.exposureCompensation) S.expoCap = caps.exposureCompensation;
}

function countCameras() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
  navigator.mediaDevices.enumerateDevices().then((list) => {
    S.multiCam = list.filter((d) => d.kind === 'videoinput').length > 1;
    refreshUI();
  }).catch(() => {});
}

function flipCamera() {
  const st = state();
  if (!S.hasVideo || (st !== ST.IDLE && st !== ST.PAUSED)) return;
  el.flip.disabled = true;
  startStream(S.facing === 'user' ? 'environment' : 'user').then(refreshUI);
}

/* ---------------- focus, exposure, lock (camera source only) ---------------- */

function clearFocusTimers() {
  S.focusTimers.forEach(clearTimeout);
  S.focusTimers = [];
}

function clearFocus() {
  clearFocusTimers();
  S.locked = false;
  S.expoVal = 0;
  S.focusActive = false;
  el.body.setAttribute('data-lock', '0');
  el.focusBox.classList.remove('pop', 'expo');
  el.focusBox.style.opacity = '0';
  el.expoSun.style.transform = 'translateY(0)';
}

function showFocusBox(x, y, lock) {
  clearFocusTimers();
  const b = el.focusBox;
  b.style.left = x + 'px';
  b.style.top = y + 'px';
  b.classList.remove('pop');
  void b.offsetWidth;
  b.classList.toggle('expo', !!S.expoCap);
  b.style.opacity = '1';
  b.classList.add('pop');
  S.focusActive = true;
  S.locked = !!lock;
  el.body.setAttribute('data-lock', lock ? '1' : '0');
  // The animation holds its last frame, thus the class comes off before a fade.
  S.focusTimers.push(setTimeout(() => b.classList.remove('pop'), 320));
  S.focusTimers.push(setTimeout(() => {
    if (!S.locked) b.style.opacity = '0.6';
  }, 1100));
  if (!lock) {
    S.focusTimers.push(setTimeout(() => {
      b.style.opacity = '0';
      S.focusActive = false;
    }, 2800));
  }
}

function applyFocus(nx, ny, lock) {
  const t = videoTrack();
  if (!t || !t.applyConstraints) return;
  let caps = {};
  try {
    caps = (t.getCapabilities && t.getCapabilities()) || {};
  } catch {
    /* no capabilities */
  }
  const adv = {};
  if (caps.pointsOfInterest) adv.pointsOfInterest = [{ x: nx, y: ny }];
  if (caps.focusMode && caps.focusMode.indexOf('single-shot') >= 0) adv.focusMode = 'single-shot';
  if (caps.exposureMode) {
    const want = lock ? 'single-shot' : 'continuous';
    if (caps.exposureMode.indexOf(want) >= 0) adv.exposureMode = want;
  }
  if (!Object.keys(adv).length) return;
  t.applyConstraints({ advanced: [adv] }).catch(() => {});
}

function nudgeExposure(dy) {
  if (!S.expoCap) return;
  const span = S.expoCap.max - S.expoCap.min || 1;
  const step = S.expoCap.step || span / 32;
  let val = S.expoVal - (dy / 90) * span;
  val = Math.max(S.expoCap.min, Math.min(S.expoCap.max, val));
  val = Math.round(val / step) * step;
  if (val === S.expoVal) return;
  S.expoVal = val;
  const t = videoTrack();
  if (t && t.applyConstraints) t.applyConstraints({ advanced: [{ exposureCompensation: val }] }).catch(() => {});
  const mid = (S.expoCap.max + S.expoCap.min) / 2;
  const off = -((val - mid) / (span / 2)) * 32;
  el.expoSun.style.transform = 'translateY(' + off.toFixed(1) + 'px)';
}

(() => {
  let start = null, moved = false, longFired = false, longId = 0, lastY = 0;

  el.frame.addEventListener('pointerdown', (e) => {
    if (!S.hasVideo) return;
    start = { x: e.clientX, y: e.clientY };
    moved = false;
    longFired = false;
    lastY = e.clientY;
    if (el.frame.setPointerCapture) el.frame.setPointerCapture(e.pointerId);
    longId = setTimeout(() => {
      if (moved || !start) return;
      longFired = true;
      focusHere(start.x, start.y, true);
      if (navigator.vibrate) navigator.vibrate(12);
      toast('Focus and exposure are locked.');
    }, 520);
  });

  el.frame.addEventListener('pointermove', (e) => {
    if (!start) return;
    const dx = e.clientX - start.x, dy = e.clientY - start.y;
    if (!moved && Math.abs(dx) + Math.abs(dy) > 10) {
      moved = true;
      clearTimeout(longId);
    }
    if (moved && S.focusActive && Math.abs(dy) > Math.abs(dx)) nudgeExposure(e.clientY - lastY);
    lastY = e.clientY;
  });

  el.frame.addEventListener('pointerup', () => {
    if (!start) return;
    clearTimeout(longId);
    const s = start;
    start = null;
    if (longFired || moved) return; // the long press set the lock, a drag set the exposure
    focusHere(s.x, s.y, false);
  });

  el.frame.addEventListener('pointercancel', () => {
    clearTimeout(longId);
    start = null;
  });

  function focusHere(cx, cy, lock) {
    const r = el.frame.getBoundingClientRect();
    const x = Math.max(0, Math.min(r.width, cx - r.left));
    const y = Math.max(0, Math.min(r.height, cy - r.top));
    S.expoVal = 0;
    el.expoSun.style.transform = 'translateY(0)';
    showFocusBox(x, y, lock);
    applyFocus(x / r.width, y / r.height, lock);
  }
})();

/* ---------------- recorder ---------------- */

function onState(st) {
  el.body.setAttribute('data-state', st);
  if (rec && !rec.drops) el.body.removeAttribute('data-drops');
  refreshUI();
  updatePill();
}

function updatePill() {
  if (!rec) return;
  const st = rec.state;
  if (st === ST.PAUSED || st === ST.EXPORTING || st === ST.PAUSING) {
    el.timer.textContent = st === ST.PAUSING ? formatTime(rec.timeUs) : 'PAUSED';
  } else el.timer.textContent = formatTime(rec.timeUs);
  el.clipLbl.textContent = rec.clip ? '· clip ' + rec.clip : '';
}
setInterval(updatePill, 250);

function onDecoded(bitmap) {
  const c = el.mosh;
  if (c.width !== bitmap.width || c.height !== bitmap.height) {
    c.width = bitmap.width;
    c.height = bitmap.height;
  }
  c.getContext('2d').drawImage(bitmap, 0, 0);
  bitmap.close();
}

function onPaused(bitmap, thumb) {
  // Plan §8.4 step 7, R-22: the overlay has the same size and crop as the viewfinder.
  const c = el.overlay;
  if (bitmap) {
    c.width = bitmap.width;
    c.height = bitmap.height;
    c.getContext('2d').drawImage(bitmap, 0, 0);
    bitmap.close();
  }
  setOpacity(el.slider.value);
  if (thumb) {
    if (el.thumbImg.src) URL.revokeObjectURL(el.thumbImg.src);
    el.thumbImg.src = URL.createObjectURL(thumb);
  }
}

let pulseId = 0;
function onDrop(n) {
  el.dropN.textContent = n;
  el.body.setAttribute('data-drops', '1');
  el.body.setAttribute('data-pulse', '0');
  void el.dropBadge.offsetWidth;
  el.body.setAttribute('data-pulse', '1');
  clearTimeout(pulseId);
  pulseId = setTimeout(() => el.body.setAttribute('data-pulse', '0'), 700);
}

function setOpacity(v) {
  el.overlay.style.opacity = (v / 100).toString();
  el.pct.textContent = Math.round(v) + '%';
}

async function shutter() {
  if (!rec) return;
  const st = rec.state;
  if (st === ST.RECORDING) return rec.pause();
  if (st !== ST.IDLE && st !== ST.PAUSED) return;
  if (!S.hasVideo || !el.preview.videoWidth) {
    toast('The camera is not ready.');
    return;
  }
  const { w, h } = pictureSize();
  el.shutter.disabled = true;
  try {
    await rec.record({ w, h, fps: S.fps, aspect: S.aspect, orient: isPortrait() ? 'v' : 'h', mirror: mirrored() });
  } catch (e) {
    toast('The recording did not start: ' + (e && e.message));
  }
  refreshUI();
}

function refreshUI() {
  const st = state();
  const idleOrPaused = st === ST.IDLE || st === ST.PAUSED;
  el.shutter.disabled = !S.hasVideo || !(idleOrPaused || st === ST.RECORDING);
  el.shutter.setAttribute('aria-label', st === ST.RECORDING ? 'Pause' : st === ST.PAUSED ? 'Resume' : 'Record');
  el.flip.disabled = !S.hasVideo || !S.multiCam || !idleOrPaused;
  const locked = sessionLocked() || !idleOrPaused;
  el.orientBtn.disabled = locked;
  el.ratios.forEach((b) => (b.disabled = locked));
  el.exportBtn.disabled = !(rec && rec.hasFrames && idleOrPaused);
  el.gearBtn.disabled = st === ST.RECORDING || st === ST.PAUSING;
  el.preview.classList.toggle('mirror', mirrored());
  el.body.setAttribute('data-preview', S.preview ? '1' : '0');
  el.body.setAttribute('data-noaudio', '1');
  updateSettingsSheet();
}

/* ---------------- sheets ---------------- */

function openSheet(name) {
  el.body.setAttribute('data-sheet', name);
}

function closeSheet() {
  if (el.body.getAttribute('data-sheet') === 'export' && exportCtl) exportCtl.abort();
  el.body.removeAttribute('data-sheet');
}

// Settings (plan §7.1 and §7.3; the encoder settings and the full Info section come in Phase 7).
function updateSettingsSheet() {
  const locked = sessionLocked();
  const val = { size: S.size, fps: S.fps, preview: S.preview ? 1 : 0, mirror: S.mirrorFront ? 1 : 0 };
  if (locked) {
    val.size = Math.min(rec.session.w, rec.session.h);
    val.fps = rec.session.fps;
  }
  document.querySelectorAll('#settingsSheet .seg').forEach((seg) => {
    const k = seg.dataset.key;
    seg.querySelectorAll('button').forEach((b) => {
      b.classList.toggle('active', Number(b.dataset.v) === val[k]);
      b.disabled = (k === 'size' || k === 'fps') && locked;
    });
  });
  el.lockHint.textContent = locked
    ? 'Size and frame rate are locked for this video.'
    : 'Size, frame rate, and shape lock at the first recorded frame.';
  if (rec) {
    el.info.textContent = `Encoder: ${rec.encMs ? rec.encMs.toFixed(1) : '–'} ms per frame ` +
      `(budget ${(1000 / (locked ? rec.session.fps : S.fps)).toFixed(1)} ms). ` +
      `Dropped frames: ${rec.drops} (this clip ${rec.clipDrops}). Frames: ${rec.frameCount}. neomosh v${VERSION}`;
  }
}

document.querySelectorAll('#settingsSheet .seg button').forEach((b) => {
  b.addEventListener('click', () => {
    const k = b.parentElement.dataset.key;
    const v = Number(b.dataset.v);
    if (k === 'size' && !sessionLocked()) S.size = v;
    if (k === 'fps' && !sessionLocked()) S.fps = v;
    if (k === 'preview') S.preview = v === 1;
    if (k === 'mirror') S.mirrorFront = v === 1; // a change while paused applies to the next clip
    savePrefs();
    relayout();
    refreshUI();
  });
});

// Export (plan §9.1, §9.2: Original mode).
let exportCtl = null;
let exportBlob = null;
let exportName = '';
let cutModes = [];

function renderCuts() {
  el.cutList.textContent = '';
  cutModes.forEach((m, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = m;
    b.textContent = `Cut ${i + 1} · ${m === 'clean' ? 'Clean' : 'Mosh'}`;
    b.addEventListener('click', () => {
      cutModes[i] = m === 'clean' ? 'mosh' : 'clean';
      renderCuts();
    });
    el.cutList.appendChild(b);
  });
  el.allCuts.parentElement.style.display = cutModes.length ? '' : 'none';
  el.allCuts.querySelectorAll('button').forEach((b) => b.classList.toggle('active', cutModes.every((m) => m === b.dataset.v)));
}

function exportButtons(phase) {
  el.exportGo.hidden = phase !== 'ready';
  el.exportCancel.hidden = phase !== 'running';
  el.exportShare.hidden = phase !== 'done' || !canShareFile();
  el.exportDownload.hidden = phase !== 'done';
}

function canShareFile() {
  if (!exportBlob || !navigator.canShare) return false;
  try {
    return navigator.canShare({ files: [new File([exportBlob], exportName, { type: 'video/mp4' })] });
  } catch {
    return false;
  }
}

function openExport() {
  if (!rec || !rec.hasFrames || (rec.state !== ST.PAUSED && rec.state !== ST.IDLE)) return;
  if (cutModes.length !== rec.cuts.length) cutModes = rec.cuts.map((_, i) => cutModes[i] || 'mosh');
  exportBlob = null;
  el.progress.style.width = '0';
  el.exportMsg.textContent = `${rec.frameCount} frames, ${rec.cuts.length} cuts.`;
  renderCuts();
  exportButtons('ready');
  openSheet('export');
}

async function runExport() {
  const prev = rec.state;
  rec.setState(ST.EXPORTING);
  exportButtons('running');
  exportCtl = new AbortController();
  const total = rec.frameCount;
  try {
    await rec.store.flush();
    const r = await remuxOriginal(rec.params, rec.store.readFrames(rec.session.id), {
      cuts: cutModes.slice(),
      signal: exportCtl.signal,
      onProgress: (n) => (el.progress.style.width = ((100 * n) / total).toFixed(1) + '%'),
    });
    exportBlob = new Blob(r.parts, { type: 'video/mp4' });
    exportName = `neomosh_${fileStamp()}.mp4`;
    el.exportMsg.textContent = `${exportName} · ${(exportBlob.size / 1048576).toFixed(1)} MB`;
    exportButtons('done');
  } catch (e) {
    el.exportMsg.textContent = exportCtl.signal.aborted ? 'The export was cancelled.' : 'The export failed: ' + (e && e.message);
    exportButtons('ready');
  } finally {
    exportCtl = null;
    rec.setState(prev);
  }
}

el.allCuts.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
  cutModes = cutModes.map(() => b.dataset.v);
  renderCuts();
}));
el.exportGo.addEventListener('click', runExport);
el.exportCancel.addEventListener('click', () => exportCtl && exportCtl.abort());
el.exportDownload.addEventListener('click', () => exportBlob && save(exportBlob, exportName));
el.exportShare.addEventListener('click', () => {
  if (!exportBlob) return;
  const file = new File([exportBlob], exportName, { type: 'video/mp4' });
  navigator.share({ files: [file] }).catch(() => {});
});

/* ---------------- gate ---------------- */

function showGate(title, text) {
  el.gateTitle.textContent = title;
  el.gateText.textContent = text;
  el.gateBtn.disabled = false;
  el.gate.classList.add('show');
}
function hideGate() {
  el.gate.classList.remove('show');
}

async function start() {
  el.gateBtn.disabled = true;
  try {
    if (!store) store = await Store.open();
  } catch (e) {
    showGate('No storage', 'This browser does not give storage (IndexedDB) to this page. ' + (e && e.message ? e.message : ''));
    return;
  }
  if (!rec) {
    rec = new Recorder({
      workerSrc: WORKER_SRC, store, video: el.preview,
      on: { state: onState, decoded: onDecoded, paused: onPaused, drop: onDrop, toast, error: (m) => toast(m, 5000) },
    });
  }
  if (await startStream(S.facing)) onState(rec.state);
}

/* ---------------- events ---------------- */

el.gateBtn.addEventListener('click', start);
el.shutter.addEventListener('click', shutter);
el.flip.addEventListener('click', flipCamera);
el.ratios.forEach((b) => b.addEventListener('click', () => setAspect(b.dataset.a)));
el.orientBtn.addEventListener('click', setOrient);
el.slider.addEventListener('input', () => setOpacity(el.slider.value));
el.gearBtn.addEventListener('click', () => {
  refreshUI();
  openSheet('settings');
});
el.exportBtn.addEventListener('click', openExport);
el.sheetBack.addEventListener('click', closeSheet);
document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', closeSheet));
el.thumbBtn.addEventListener('click', () => toast('The history view comes in a later version.'));
el.dropBadge.addEventListener('click', () => toast(`The encoder dropped ${rec ? rec.drops : 0} frames. ` +
  'Use a smaller size, a smaller search range, or a lower frame rate.', 4500));
el.micBadge.addEventListener('click', () => toast('No audio. Audio comes in a later version of neomosh.'));

el.preview.addEventListener('loadedmetadata', layoutFrame);
el.preview.addEventListener('resize', layoutFrame);
el.preview.addEventListener('playing', layoutFrame);
window.addEventListener('resize', relayout);
window.addEventListener('orientationchange', () => setTimeout(relayout, 260));

document.addEventListener('keydown', (e) => {
  if (e.key === ' ' || e.key === 'Enter') {
    if (document.activeElement && document.activeElement.tagName === 'BUTTON') return;
    if (el.body.hasAttribute('data-sheet')) return;
    e.preventDefault();
    el.shutter.click();
  }
});

// R-24: the page is hidden -> pause, not stop.
document.addEventListener('visibilitychange', () => {
  if (document.hidden && rec && rec.state === ST.RECORDING) rec.pause('Recording paused.');
});
window.addEventListener('pagehide', () => {
  if (rec && rec.state === ST.RECORDING) rec.pause();
  if (store) store.flush().catch(() => {});
});

/* ---------------- start ---------------- */

document.title = 'neomosh ' + VERSION;
relayout();
