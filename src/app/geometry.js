// Session picture size and capture crop (plan §7.1, R-15).

// Visible sizes (horizontal). For a vertical session, swap width and height.
export const SIZE_TABLE = {
  360: { '1:1': [360, 360], '4:3': [480, 360], '3:2': [540, 360], '16:9': [640, 360] },
  480: { '1:1': [480, 480], '4:3': [640, 480], '3:2': [720, 480], '16:9': [852, 480] },
  720: { '1:1': [720, 720], '4:3': [960, 720], '3:2': [1080, 720], '16:9': [1280, 720] },
  // D23: 1080 for fast devices. Level 4.0 (1920x1088 at 30 fps = 244800 MB/s, the limit is 245760).
  1080: { '1:1': [1080, 1080], '4:3': [1440, 1080], '3:2': [1620, 1080], '16:9': [1920, 1080] },
};

export const ASPECTS = ['1:1', '4:3', '3:2', '16:9'];

// The picture size of a session. short: 360 | 480 | 720 | 1080. vertical: bool.
export function sessionSize(short, aspect, vertical) {
  const [w, h] = SIZE_TABLE[short][aspect];
  return vertical ? { w: h, h: w } : { w, h };
}

// Center "cover" crop of a source (vw x vh) to the aspect w / h. The viewfinder (object-fit:
// cover) shows the same area, so the file agrees with the screen.
export function coverCrop(vw, vh, w, h) {
  const a = w / h;
  let sw = vw, sh = vw / a;
  if (sh > vh) {
    sh = vh;
    sw = vh * a;
  }
  sw = Math.max(1, Math.round(sw));
  sh = Math.max(1, Math.round(sh));
  return { sx: Math.round((vw - sw) / 2), sy: Math.round((vh - sh) / 2), sw, sh };
}

export function fileStamp(d = new Date()) {
  const p = (n) => (n < 10 ? '0' : '') + n;
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function formatTime(us) {
  const s = Math.floor(us / 1e6);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  const p = (n) => (n < 10 ? '0' : '') + n;
  return (h ? p(h) + ':' : '') + p(m) + ':' + p(r);
}
