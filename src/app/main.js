// neomosh app: user interface (plan §11). Camera, focus, and layout code are from neocamera v1.5.0.
/* global VERSION, WORKER_SRC */

import { remuxOriginal } from '../mux/remux.js';
import { upscaleConfig, upscaleExport } from './upscale.js';
import { selfTest } from './selftest.js';
import { sessionSize, fileStamp, formatTime } from './geometry.js';
import { Store } from './store.js';
import { Recorder, ST } from './recorder.js';
import { DEFAULT_SETTINGS, checkSettings } from '../codec/encoder.js';
import { Player } from './player.js';

const $ = (id) => document.getElementById(id);
const el = {
  body: document.body,
  stage: $('stage'), frame: $('frame'), preview: $('preview'), mosh: $('mosh'), overlay: $('overlay'),
  fileVideo: $('fileVideo'), fileInput: $('fileInput'), fileScrub: $('fileScrub'), fileTime: $('fileTime'),
  srcCamera: $('srcCamera'), srcFile: $('srcFile'), gateFile: $('gateFile'),
  toast: $('toast'), timer: $('timer'), clipLbl: $('clipLbl'), shutter: $('shutter'), flip: $('flip'),
  thumbBtn: $('thumbBtn'), thumbImg: $('thumbImg'), slider: $('opacity'), pct: $('pct'),
  orientBtn: $('orientBtn'), ratios: [...document.querySelectorAll('.ratio')],
  focusBox: $('focusBox'), expoSun: $('expoSun'),
  gearBtn: $('gearBtn'), exportBtn: $('exportBtn'), dropBadge: $('dropBadge'), dropN: $('dropN'),
  gate: $('gate'), gateTitle: $('gateTitle'), gateText: $('gateText'), gateBtn: $('gateBtn'), gateNew: $('gateNew'),
  player: $('player'), playBtn: $('playBtn'), scrub: $('scrub'), playTime: $('playTime'), cards: $('cards'),
  newVideo: $('newVideo'), confirmTitle: $('confirmTitle'), confirmText: $('confirmText'),
  confirmYes: $('confirmYes'), confirmNo: $('confirmNo'),
  sheetBack: $('sheetBack'), info: $('info'), lockHint: $('lockHint'), fpsHint: $('fpsHint'), storageInfo: $('storageInfo'),
  qp: $('qp'), qpVal: $('qpVal'), skipBias: $('skipBias'), skipVal: $('skipVal'), encReset: $('encReset'),
  debugGroup: $('debugGroup'), selfTest: $('selfTest'), selfTestOut: $('selfTestOut'),
  expMode: $('expMode'), expScale: $('expScale'), upRow: $('upRow'), upLbl: $('upLbl'),
  cutList: $('cutList'), allCuts: $('allCuts'), progress: $('progress').firstElementChild, exportMsg: $('exportMsg'),
  exportGo: $('exportGo'), exportCancel: $('exportCancel'), exportShare: $('exportShare'), exportDownload: $('exportDownload'),
};

// Display and session preferences. Kept in localStorage (a per-viewer convenience only).
const PREF_KEY = 'neomosh.prefs';
const S = {
  source: 'camera', // or 'file' (plan §11.5)
  fileUrl: '',
  facing: 'environment',
  aspect: '4:3',
  orient: 'auto', // auto, v, or h
  size: 480,
  fps: 30,
  preview: true,
  mirrorFront: true,
  enc: { ...DEFAULT_SETTINGS }, // the encoder settings for the next video (plan §7.2)
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
    const { aspect, size, fps, preview, mirrorFront, enc } = S;
    localStorage.setItem(PREF_KEY, JSON.stringify({ aspect, size, fps, preview, mirrorFront, enc }));
  } catch {
    /* storage not available */
  }
}

try {
  S.enc = checkSettings(S.enc);
} catch {
  S.enc = { ...DEFAULT_SETTINGS }; // stored values from another version
}

// D17: the encoder speed of this device, in ms for each megapixel (measured at each pause).
const SPEED_KEY = 'neomosh.speed';
function loadSpeed() {
  try {
    return Number(localStorage.getItem(SPEED_KEY)) || 0;
  } catch {
    return 0;
  }
}
function saveSpeed(msPerMp) {
  try {
    localStorage.setItem(SPEED_KEY, String(msPerMp));
  } catch {
    /* storage not available */
  }
}

let store = null;
let rec = null;
let player = null;
let restoreSession = null; // a stored session for "Continue last video" (plan §11.6)

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
// D8: the front camera is mirrored as displayed, and encoded the same way. A file is never mirrored.
const mirrored = () => S.source === 'camera' && S.facing === 'user' && S.mirrorFront;
const activeVideo = () => (S.source === 'file' ? el.fileVideo : el.preview);
const sourceReady = () => (S.source === 'file'
  ? !!S.fileUrl && el.fileVideo.readyState >= 2 && el.fileVideo.videoWidth > 0
  : S.hasVideo && el.preview.videoWidth > 0);

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
    showGate('Not available', 'This browser does not give access to the camera. Open the page with https or localhost.', true);
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
    showGate('No access', why, true);
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
  if (t) t.addEventListener('ended', () => rec && S.source === 'camera' && rec.pause('The camera stopped. Recording paused.'));
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
    if (!S.hasVideo || S.source !== 'camera') return;
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

let pillTimer = 0;

function onState(st) {
  el.body.setAttribute('data-state', st);
  // Plan §11.5 step 5: the file pauses with the recording.
  if (st !== ST.RECORDING && !el.fileVideo.paused) el.fileVideo.pause();
  if (S.source === 'file') updateFileBar();
  // The time in the pill changes only while recording. No timer runs in the other states.
  const ticking = st === ST.RECORDING || st === ST.PAUSING;
  if (ticking && !pillTimer) pillTimer = setInterval(updatePill, 250);
  if (!ticking && pillTimer) {
    clearInterval(pillTimer);
    pillTimer = 0;
  }
  if (rec && !rec.drops) el.body.removeAttribute('data-drops');
  if (rec && st === ST.IDLE && !rec.hasFrames && el.thumbImg.src) {
    URL.revokeObjectURL(el.thumbImg.src);
    el.thumbImg.removeAttribute('src');
  }
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
  // D17: measure the speed of this device (only after a clip of some length).
  if (rec && rec.session && rec.encMs && rec.clipFrames > 10) saveSpeed(frameMs() / ((rec.session.w * rec.session.h) / 1e6));
  checkStorage();
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
  if (!sourceReady()) {
    toast(S.source === 'file' ? 'The video file is not ready.' : 'The camera is not ready.');
    return;
  }
  const fv = el.fileVideo;
  if (S.source === 'file' && (fv.ended || fv.currentTime >= fv.duration - 0.05)) {
    toast('The file is at its end. Move the file position back.');
    return;
  }
  const { w, h } = pictureSize();
  el.shutter.disabled = true;
  try {
    rec.setSource(activeVideo(), S.source);
    await rec.record({ w, h, fps: S.fps, aspect: S.aspect, orient: isPortrait() ? 'v' : 'h', mirror: mirrored() });
    // Plan §11.5 step 4: the file plays at normal speed (R-32).
    if (S.source === 'file' && rec.state === ST.RECORDING) {
      await fv.play().catch(() => rec.pause('The video file did not play.'));
    }
  } catch (e) {
    toast('The recording did not start: ' + (e && e.message));
  }
  refreshUI();
}

/* ---------------- file source (plan §11.5) ---------------- */

function setSource(kind) {
  const st = state();
  if (st !== ST.IDLE && st !== ST.PAUSED) return;
  S.source = kind;
  el.body.setAttribute('data-source', kind);
  clearFocus();
  if (kind === 'camera') {
    el.fileVideo.pause();
    // The camera stream stayed open (step 7). Only its display was paused.
    const p = el.preview.play();
    if (p && p.catch) p.catch(() => {});
  } else el.preview.pause();
  if (rec) rec.setSource(activeVideo(), kind);
  updateFileBar();
  refreshUI();
  layoutFrame();
}

async function openFile(file) {
  el.fileInput.value = '';
  if (!file) return;
  const v = el.fileVideo;
  const url = URL.createObjectURL(file);
  const ok = await new Promise((resolve) => {
    v.onloadeddata = () => resolve(true);
    v.onerror = () => resolve(false);
    v.src = url;
    v.load();
  });
  v.onloadeddata = v.onerror = null;
  if (!ok || !v.videoWidth) {
    URL.revokeObjectURL(url);
    toast('This video file did not open. Try an MP4 or a MOV file.');
    if (S.fileUrl) v.src = S.fileUrl;
    return;
  }
  if (S.fileUrl) URL.revokeObjectURL(S.fileUrl);
  S.fileUrl = url;
  v.pause();
  hideGate();
  setSource('file');
  toast(file.name);
}

function updateFileBar() {
  const v = el.fileVideo;
  const d = v.duration || 0;
  if (!fileScrubbing && d) el.fileScrub.value = Math.round((1000 * v.currentTime) / d);
  el.fileTime.textContent = `${formatTime(v.currentTime * 1e6)} / ${formatTime(d * 1e6)}`;
}

let fileScrubbing = false;
el.fileScrub.addEventListener('input', () => {
  const v = el.fileVideo;
  if (!v.duration || state() === ST.RECORDING) return;
  fileScrubbing = true;
  v.currentTime = (Number(el.fileScrub.value) / 1000) * v.duration;
  updateFileBar();
});
el.fileScrub.addEventListener('change', () => (fileScrubbing = false));
el.fileVideo.addEventListener('seeked', updateFileBar);
el.fileVideo.addEventListener('loadedmetadata', updateFileBar);
// Step 6: the end of the file pauses the recording.
el.fileVideo.addEventListener('ended', () => {
  if (rec && rec.state === ST.RECORDING && S.source === 'file') rec.pause('The file ended.');
  updateFileBar();
});
el.srcCamera.addEventListener('click', () => {
  if (!S.hasVideo) {
    toast('The camera is not available.');
    return;
  }
  setSource('camera');
});
el.srcFile.addEventListener('click', () => {
  const st = state();
  if (st !== ST.IDLE && st !== ST.PAUSED) return;
  // A second touch on FILE (or no file yet) selects a file.
  if (S.source === 'file' || !S.fileUrl) el.fileInput.click();
  else setSource('file');
});
el.fileInput.addEventListener('change', () => openFile(el.fileInput.files && el.fileInput.files[0]));

function refreshUI() {
  const st = state();
  const idleOrPaused = st === ST.IDLE || st === ST.PAUSED;
  el.shutter.disabled = !(S.source === 'file' ? !!S.fileUrl : S.hasVideo) || !(idleOrPaused || st === ST.RECORDING);
  el.srcCamera.disabled = el.srcFile.disabled = !idleOrPaused;
  el.srcCamera.classList.toggle('active', S.source === 'camera');
  el.srcFile.classList.toggle('active', S.source === 'file');
  el.shutter.setAttribute('aria-label', st === ST.RECORDING ? 'Pause' : st === ST.PAUSED ? 'Resume' : 'Record');
  el.flip.disabled = !S.hasVideo || !S.multiCam || !idleOrPaused || S.source !== 'camera';
  const locked = sessionLocked() || !idleOrPaused;
  el.orientBtn.disabled = locked;
  el.ratios.forEach((b) => (b.disabled = locked));
  el.exportBtn.disabled = !(rec && rec.hasFrames && idleOrPaused);
  el.preview.classList.toggle('mirror', mirrored());
  el.body.setAttribute('data-preview', S.preview ? '1' : '0');
  updateSettingsSheet();
}

/* ---------------- sheets ---------------- */

function openSheet(name) {
  el.body.setAttribute('data-sheet', name);
}

function closeSheet() {
  const sheet = el.body.getAttribute('data-sheet');
  if (sheet === 'export') {
    if (exportCtl) exportCtl.abort();
    exportBlob = null; // release the file from memory
  }
  if (sheet === 'review') closeReview();
  el.body.removeAttribute('data-sheet');
}

// A confirm sheet (custom UI, not confirm()). Resolves true for yes.
function ask(title, text, yes) {
  el.confirmTitle.textContent = title;
  el.confirmText.textContent = text;
  el.confirmYes.textContent = yes;
  el.body.setAttribute('data-confirm', '1');
  return new Promise((resolve) => {
    const end = (v) => {
      el.body.removeAttribute('data-confirm');
      el.confirmYes.onclick = el.confirmNo.onclick = null;
      resolve(v);
    };
    el.confirmYes.onclick = () => end(true);
    el.confirmNo.onclick = () => end(false);
  });
}

/* ---------------- review: player and history (plan §11.4) ---------------- */

let cardUrls = [];
let scrubbing = false;

async function openReview() {
  if (!rec || rec.state !== ST.PAUSED || !rec.hasFrames) return;
  rec.setState(ST.REVIEW);
  renderCards();
  el.body.setAttribute('data-playing', '0');
  setPlayTime(0);
  openSheet('review');
  if (!player) {
    player = new Player({
      workerSrc: WORKER_SRC, store,
      on: {
        frame: drawPlayer,
        time: setPlayTime,
        state: (p) => el.body.setAttribute('data-playing', p ? '1' : '0'),
      },
    });
  }
  await player.open(rec.session, rec.pointList, rec.frameCount, rec.sessionEndUs);
}

function closeReview() {
  if (player) player.close();
  if (rec && rec.state === ST.REVIEW) rec.setState(ST.PAUSED);
}

function drawPlayer(bitmap) {
  const c = el.player;
  if (c.width !== bitmap.width || c.height !== bitmap.height) {
    c.width = bitmap.width;
    c.height = bitmap.height;
  }
  c.getContext('2d').drawImage(bitmap, 0, 0);
  bitmap.close();
}

function setPlayTime(t) {
  const end = rec ? rec.sessionEndUs : 0;
  if (!scrubbing && end) el.scrub.value = Math.round((1000 * t) / end);
  el.playTime.textContent = `${formatTime(t)} / ${formatTime(end)}`;
  el.player.dataset.t = t; // the time of the picture now (also used by the tests)
}

function renderCards() {
  cardUrls.forEach((u) => URL.revokeObjectURL(u));
  cardUrls = [];
  el.cards.textContent = '';
  for (const p of rec.pointList) {
    if (!p) continue;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'card' + (p.n === rec.points ? ' now' : '');
    const pic = document.createElement('span');
    pic.className = 'pic';
    if (p.thumb) {
      const u = URL.createObjectURL(p.thumb);
      cardUrls.push(u);
      pic.style.backgroundImage = `url("${u}")`;
    } else pic.textContent = 'Start';
    const title = document.createElement('b');
    title.textContent = p.n === 0 ? 'Start' : `Clip ${p.n}`;
    const time = document.createElement('small');
    time.textContent = formatTime(p.tsUs) + (p.n === rec.points ? ' · now' : '');
    b.append(pic, title, time);
    if (p.drops) {
      const d = document.createElement('small');
      d.className = 'warn';
      d.textContent = `${p.drops} dropped`;
      b.append(d);
    }
    b.addEventListener('click', () => revertTo(p.n));
    el.cards.appendChild(b);
  }
}

async function revertTo(n) {
  if (n === rec.points) {
    toast('This is the current point.');
    return;
  }
  if (!(await ask('Revert to here?', 'This deletes all clips after this point. You cannot undo this.', 'Revert'))) return;
  const job = rec.revert(n); // sets the busy state at once
  closeSheet();
  try {
    await job;
    toast(n === 0 ? 'Back at the start.' : `Back after clip ${n}.`);
  } catch (e) {
    toast('The revert failed: ' + (e && e.message), 5000);
  }
  relayout();
  refreshUI();
}

el.playBtn.addEventListener('click', () => {
  if (!player) return;
  if (el.body.getAttribute('data-playing') === '1') player.pause();
  else player.play();
});
el.scrub.addEventListener('input', () => {
  if (!player || !rec) return;
  scrubbing = true;
  player.pause();
  const t = (Number(el.scrub.value) / 1000) * rec.sessionEndUs;
  el.playTime.textContent = `${formatTime(t)} / ${formatTime(rec.sessionEndUs)}`;
  player.seek(t);
});
el.scrub.addEventListener('change', () => (scrubbing = false));
el.newVideo.addEventListener('click', async () => {
  if (!(await ask('New video?', 'This deletes the video and its history. You cannot undo this.', 'Delete'))) return;
  closeSheet();
  await rec.discard();
  relayout();
  refreshUI();
});

// Settings (plan §7.1 and §7.3; the encoder settings and the full Info section come in Phase 7).
const encSettings = () => (rec ? rec.settings : S.enc);
const canEdit = () => !rec || rec.state === ST.IDLE || rec.state === ST.PAUSED;

function updateSettingsSheet() {
  const locked = sessionLocked();
  const edit = canEdit(); // R-12: while recording, the values show but do not change
  const enc = encSettings();
  const val = { size: S.size, fps: S.fps, preview: S.preview ? 1 : 0, mirror: S.mirrorFront ? 1 : 0, ...enc };
  if (locked) {
    val.size = Math.min(rec.session.w, rec.session.h);
    val.fps = rec.session.fps;
  }
  document.querySelectorAll('#settingsSheet .seg').forEach((seg) => {
    const k = seg.dataset.key;
    seg.querySelectorAll('button').forEach((b) => {
      b.classList.toggle('active', b.dataset.v === String(val[k]));
      b.disabled = ((k === 'size' || k === 'fps') && locked) || (k in enc && !edit);
    });
  });
  el.qp.value = enc.qp;
  el.qpVal.textContent = enc.qp;
  el.skipBias.value = enc.skipBias;
  el.skipVal.textContent = enc.skipBias;
  el.qp.disabled = el.skipBias.disabled = el.encReset.disabled = !edit;
  el.lockHint.textContent = locked
    ? 'Size and frame rate are locked for this video.'
    : 'Size, frame rate, and shape lock at the first recorded frame.';
  updateFpsHint();
  if (rec) {
    const worker = rec.captureMode === 'worker' && rec.capMs;
    el.info.textContent = (worker
      ? `Capture worker: ${rec.capMs.toFixed(1)} ms. Encoder worker: ${rec.encMs.toFixed(1)} ms ` +
        `(RGB to YUV ${rec.grabMs.toFixed(1)}, encode ${(rec.encMs - rec.grabMs).toFixed(1)}). They work in parallel, each per frame `
      : `Encoder: ${rec.encMs ? rec.encMs.toFixed(1) : '–'} ms per frame ` +
        (rec.encMs ? `(capture ${rec.grabMs.toFixed(1)}, encode ${(rec.encMs - rec.grabMs).toFixed(1)}) ` : '')) +
      `(budget ${(1000 / (locked ? rec.session.fps : S.fps)).toFixed(1)} ms). ` +
      `Dropped frames: ${rec.drops} (this clip ${rec.clipDrops}: encoder busy ${rec.dropKinds.enc}, page late ${rec.dropKinds.page}, capture late ${rec.dropKinds.cap}). ` +
      `Frames: ${rec.frameCount}. Capture: ${rec.captureMode === 'worker' ? `worker${rec.capMethod ? ` (${rec.capMethod})` : ''}` : rec.captureMode === 'page' ? `page${rec.capReason ? ` (${rec.capReason})` : ''}` : '–'}. ` +
      `Codec: ${rec.wasm === undefined ? '–' : rec.wasm ? 'WebAssembly SIMD' : 'JavaScript'}. ` +
      `Browser: ${browserName()}${typeof VideoDecoder === 'undefined' ? ', no WebCodecs' : ''}. neomosh v${VERSION}`;
  }
}

// The browser name and version, for the info section (the capture path depends on the browser).
function browserName() {
  const ua = navigator.userAgent;
  const m = ua.match(/(SamsungBrowser|Firefox|FxiOS|EdgA?|OPR|CriOS|Chrome)\/(\d+)/);
  if (m) return `${m[1]} ${m[2]}${/; wv\)/.test(ua) ? ' (WebView)' : ''}`;
  const s = ua.match(/Version\/(\d+(\.\d+)?).*Safari/);
  return s ? `Safari ${s[1]}` : ua.slice(0, 60);
}

// The time for each frame of the slowest worker. The capture worker and the encoder work in parallel.
function frameMs() {
  return rec.captureMode === 'worker' ? Math.max(rec.encMs, rec.capMs) : rec.encMs;
}

// D17: a hint when the frame rate is more than this device can hold at this size.
function updateFpsHint() {
  const rate = loadSpeed();
  const { w, h } = pictureSize();
  const fps = sessionLocked() ? rec.session.fps : S.fps;
  const est = (rate * w * h) / 1e6;
  const fits = (f) => est <= 0.85 * (1000 / f);
  if (!rate || fits(fps)) {
    el.fpsHint.hidden = true;
    return;
  }
  const lower = [24, 15].filter((f) => f < fps && fits(f));
  el.fpsHint.textContent = `${Math.min(w, h)} at ${fps} fps can drop frames on this device (about ${est.toFixed(0)} ms for each frame). ` +
    (lower.length ? `${lower.join(' or ')} fps is safer.` : 'A smaller size is safer.');
  el.fpsHint.hidden = false;
}

// R-26: warn when free storage is low (at each pause).
async function checkStorage() {
  const e = await Store.estimate();
  if (e && e.free < 200 * 1048576) toast(`Free storage is low: ${(e.free / 1048576).toFixed(0)} MB. Export the video soon.`, 4500);
}

// Plan §7.4: storage used and free.
async function updateStorageInfo() {
  const e = await Store.estimate();
  el.storageInfo.textContent = e ? `Storage: ${(e.used / 1048576).toFixed(0)} MB used, ${(e.free / 1048576).toFixed(0)} MB free.` : '';
}

function setEnc(change) {
  if (!canEdit()) return;
  const next = checkSettings({ ...encSettings(), ...change });
  if (rec) rec.setSettings(next);
  S.enc = next;
  savePrefs();
  updateSettingsSheet();
}

document.querySelectorAll('#settingsSheet .seg button').forEach((b) => {
  b.addEventListener('click', () => {
    const k = b.parentElement.dataset.key;
    const v = b.dataset.v;
    if (k === 'searchRange') return setEnc({ searchRange: Number(v) });
    if (k === 'precision' || k === 'heal') return setEnc({ [k]: v });
    if (k === 'size' && !sessionLocked()) S.size = Number(v);
    if (k === 'fps' && !sessionLocked()) S.fps = Number(v);
    if (k === 'preview') S.preview = v === '1';
    if (k === 'mirror') S.mirrorFront = v === '1'; // a change while paused applies to the next clip
    savePrefs();
    relayout();
    refreshUI();
  });
});
el.qp.addEventListener('input', () => setEnc({ qp: Number(el.qp.value) }));
el.skipBias.addEventListener('input', () => setEnc({ skipBias: Number(el.skipBias.value) }));
el.encReset.addEventListener('click', () => setEnc({ ...DEFAULT_SETTINGS }));

// Export (plan §9.1, §9.2: Original mode).
let exportCtl = null;
let exportBlob = null;
let exportName = '';
let cutModes = [];
let expMode = 'original'; // plan §9.1
let expSmooth = false;
let upConfig = null; // the VideoEncoder configuration, or null: no Upscale mode (plan §9.3)

function renderMode() {
  el.expMode.parentElement.hidden = !upConfig;
  if (!upConfig) expMode = 'original';
  el.upRow.hidden = expMode !== 'upscale';
  if (upConfig) el.upLbl.textContent = `${upConfig.outW}×${upConfig.outH}`;
  el.expMode.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.v === expMode));
  el.expScale.querySelectorAll('button').forEach((b) => b.classList.toggle('active', (b.dataset.v === 'smooth') === expSmooth));
}

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
  upConfig = null;
  renderMode();
  exportButtons('ready');
  openSheet('export');
  const p = rec.params;
  upscaleConfig(p.w, p.h, p.fps).then((c) => {
    upConfig = c;
    renderMode();
  });
}

async function runExport() {
  const prev = rec.state;
  rec.setState(ST.EXPORTING);
  exportButtons('running');
  exportCtl = new AbortController();
  const total = rec.frameCount;
  try {
    await rec.store.flush();
    const opts = {
      cuts: cutModes.slice(),
      smooth: expSmooth,
      signal: exportCtl.signal,
      onProgress: (n) => (el.progress.style.width = ((100 * n) / total).toFixed(1) + '%'),
    };
    const frames = rec.store.readFrames(rec.session.id);
    const r = expMode === 'upscale' && upConfig
      ? await upscaleExport(WORKER_SRC, rec.params, upConfig, frames, opts)
      : await remuxOriginal(rec.params, frames, opts);
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
el.expMode.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
  expMode = b.dataset.v;
  renderMode();
}));
el.expScale.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
  expSmooth = b.dataset.v === 'smooth';
  renderMode();
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

// allowFile: show "Use a video file" (no camera: the file source still works, plan §4).
function showGate(title, text, allowFile = false) {
  el.gateTitle.textContent = title;
  el.gateText.textContent = text;
  el.gateFile.hidden = !allowFile;
  el.gateBtn.disabled = el.gateNew.disabled = false;
  el.gate.classList.add('show');
}
function hideGate() {
  el.gate.classList.remove('show');
}

// Plan §11.6: when a stored session has frames, the gate offers "Continue last video" and "Start new".
async function initGate() {
  try {
    store = await Store.open();
    const list = (await store.listSessions()).sort((a, b) => b.created - a.created);
    for (const s of list) {
      if (await store.countFrames(s.id)) {
        restoreSession = s;
        break;
      }
    }
  } catch {
    return;
  }
  if (restoreSession) {
    el.gateText.textContent = 'You have a video that is not finished.';
    el.gateBtn.textContent = 'Continue last video';
    el.gateNew.hidden = false;
  }
}

async function start(fresh) {
  el.gateBtn.disabled = el.gateNew.disabled = true;
  if (fresh && store) {
    for (const s of await store.listSessions()) await store.deleteSession(s.id);
    restoreSession = null;
  }
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
    rec.settings = { ...S.enc };
  }
  await startStream(S.facing); // without a camera, the gate offers a video file
  if (restoreSession) {
    const s = restoreSession;
    restoreSession = null;
    S.aspect = s.aspect;
    S.orient = s.orient === 'v' ? 'v' : 'h';
    try {
      if (await rec.restore(s)) toast(`Continued: ${rec.frameCount} frames, clip ${rec.clip}.`);
    } catch (e) {
      toast('The last video did not open: ' + (e && e.message), 5000);
    }
  }
  onState(rec.state);
  relayout();
}

/* ---------------- events ---------------- */

el.gateBtn.addEventListener('click', () => start(false));
el.gateNew.addEventListener('click', () => start(true));
el.gateFile.addEventListener('click', () => el.fileInput.click());
el.shutter.addEventListener('click', shutter);
el.flip.addEventListener('click', flipCamera);
el.ratios.forEach((b) => b.addEventListener('click', () => setAspect(b.dataset.a)));
el.orientBtn.addEventListener('click', setOrient);
el.slider.addEventListener('input', () => setOpacity(el.slider.value));
el.gearBtn.addEventListener('click', () => {
  refreshUI();
  updateStorageInfo();
  openSheet('settings');
});
el.exportBtn.addEventListener('click', openExport);

// Plan §13.3: the self-test is a hidden debug setting. Open the page with #debug to show it.
el.debugGroup.hidden = location.hash !== '#debug';
el.selfTest.addEventListener('click', async () => {
  if (!rec || !rec.hasFrames || (rec.state !== ST.PAUSED && rec.state !== ST.IDLE)) {
    el.selfTestOut.textContent = 'Record a video first. Then pause and run the self-test.';
    return;
  }
  const prev = rec.state;
  rec.setState(ST.EXPORTING);
  el.selfTest.disabled = true;
  el.selfTestOut.textContent = 'Running…';
  try {
    await rec.store.flush();
    // Software decoder: exact. Hardware decoder: the one that players use (plan §13.3).
    const lines = [];
    let ok = true;
    for (const [hw, name] of [['prefer-software', 'Software decoder'], ['prefer-hardware', 'Hardware decoder']]) {
      const r = await selfTest(WORKER_SRC, rec.params, rec.store.readFrames(rec.session.id),
        (n) => (el.selfTestOut.textContent = [...lines, `${name}: running… ${n} frames`].join('\n')), hw);
      lines.push(`${name}: ${r.ok ? 'PASS' : 'FAIL'}. ${r.message}`);
      ok = ok && r.ok;
    }
    el.selfTestOut.textContent = lines.join('\n');
    el.selfTestOut.dataset.result = ok ? 'pass' : 'fail';
  } finally {
    el.selfTest.disabled = false;
    rec.setState(prev);
  }
});
el.sheetBack.addEventListener('click', closeSheet);
document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', closeSheet));
el.thumbBtn.addEventListener('click', openReview);
// R-19: the help depends on the cause of the drops in this clip.
el.dropBadge.addEventListener('click', () => {
  const k = rec ? rec.dropKinds : { enc: 0, page: 0, cap: 0 };
  const help = k.enc >= k.page + k.cap
    ? 'The encoder was busy. Use a smaller size, a smaller search range, or a lower frame rate.'
    : 'The app did not get all camera frames in time. Close other apps, or use a smaller size or a lower frame rate.';
  toast(`${rec ? rec.drops : 0} frames dropped (this clip: encoder busy ${k.enc}, page late ${k.page}, capture late ${k.cap}). ${help}`, 5000);
});

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
initGate();
