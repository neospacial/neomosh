// MP4 / MOV reader (D25): the video track of a file, for the file source without real time. It gives
// the decoder configuration and each sample (offset, size, display time, sync flag), so a
// VideoDecoder can decode every frame of the file. Only what the file source needs: one video track,
// not fragmented. It returns null for other files (then the file plays in real time, plan §11.5).

const MAX_MOOV = 64 * 1048576;

const str4 = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
const hex2 = (v) => v.toString(16).padStart(2, '0');

// The boxes in b[from..to): [{ type, start (content), end }].
function boxes(b, from, to) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const out = [];
  let o = from;
  while (o + 8 <= to) {
    let size = dv.getUint32(o);
    const type = str4(b, o + 4);
    let head = 8;
    if (size === 1) {
      size = Number(dv.getBigUint64(o + 8));
      head = 16;
    } else if (size === 0) size = to - o;
    if (size < head || o + size > to) break;
    out.push({ type, start: o + head, end: o + size });
    o += size;
  }
  return out;
}

const child = (b, box, type) => boxes(b, box.start, box.end).find((x) => x.type === type);
const path = (b, box, ...types) => types.reduce((x, t) => (x ? child(b, x, t) : null), box);

// The top-level boxes of the file, read from their headers only.
async function topBoxes(blob) {
  const out = [];
  let o = 0;
  while (o + 8 <= blob.size) {
    const h = new Uint8Array(await blob.slice(o, Math.min(blob.size, o + 16)).arrayBuffer());
    const dv = new DataView(h.buffer);
    let size = dv.getUint32(0);
    let head = 8;
    if (size === 1 && h.length >= 16) {
      size = Number(dv.getBigUint64(8));
      head = 16;
    } else if (size === 0) size = blob.size - o;
    if (size < head) break;
    out.push({ type: str4(h, 4), start: o + head, end: Math.min(blob.size, o + size) });
    o += size;
  }
  return out;
}

// The codec string and the description for the VideoDecoder, from the sample entry.
function codecOf(b, entry) {
  const t = entry.type;
  const kids = boxes(b, entry.start + 78, entry.end); // after the VisualSampleEntry fields
  const k = (type) => kids.find((x) => x.type === type);
  if (t === 'avc1' || t === 'avc3') {
    const c = k('avcC');
    if (!c) return null;
    const d = b.slice(c.start, c.end);
    return { codec: `avc1.${hex2(d[1])}${hex2(d[2])}${hex2(d[3])}`, description: d };
  }
  if (t === 'hvc1' || t === 'hev1') {
    const c = k('hvcC');
    if (!c) return null;
    const d = b.slice(c.start, c.end);
    const space = ['', 'A', 'B', 'C'][d[1] >> 6];
    const tier = (d[1] >> 5) & 1 ? 'H' : 'L';
    let compat = ((d[2] << 24) | (d[3] << 16) | (d[4] << 8) | d[5]) >>> 0;
    let rev = 0;
    for (let i = 0; i < 32; i++, compat >>>= 1) rev = ((rev << 1) | (compat & 1)) >>> 0;
    const cons = Array.from(d.subarray(6, 12));
    while (cons.length && cons[cons.length - 1] === 0) cons.pop();
    const parts = [`${t}.${space}${d[1] & 31}`, rev.toString(16), `${tier}${d[12]}`, ...cons.map((x) => x.toString(16).toUpperCase())];
    return { codec: parts.join('.'), description: d };
  }
  if (t === 'vp09') {
    const c = k('vpcC');
    if (!c) return null;
    const d = b.subarray(c.start + 4, c.end); // after version and flags
    return { codec: `vp09.${String(d[0]).padStart(2, '0')}.${String(d[1]).padStart(2, '0')}.${String(d[2] >> 4).padStart(2, '0')}`, description: null };
  }
  if (t === 'av01') {
    const c = k('av1C');
    if (!c) return null;
    const d = b.slice(c.start, c.end);
    const profile = d[1] >> 5, level = d[1] & 31, tier = d[2] >> 7 ? 'H' : 'M';
    const depth = (d[2] >> 6) & 1 ? ((d[2] >> 5) & 1 ? 12 : 10) : 8;
    return { codec: `av01.${profile}.${String(level).padStart(2, '0')}${tier}.${String(depth).padStart(2, '0')}`, description: d };
  }
  return null;
}

// tkhd matrix -> 0, 90, 180, or 270 (clockwise, the way a player turns the picture).
function rotationOf(b, tkhd) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const m = tkhd.start + (b[tkhd.start] === 1 ? 52 : 40);
  const a = dv.getInt32(m), bb = dv.getInt32(m + 4);
  if (a === 0 && bb > 0) return 90;
  if (a < 0 && bb === 0) return 180;
  if (a === 0 && bb < 0) return 270;
  return 0;
}

// blob: the file. Returns { codec, description, codedWidth, codedHeight, rotation, samples, durationUs }
// or null. samples (decode order): [{ offset, size, us (display time, microseconds), key }].
export async function demuxMp4(blob) {
  let tops;
  try {
    tops = await topBoxes(blob);
  } catch {
    return null;
  }
  const moovTop = tops.find((x) => x.type === 'moov');
  if (!moovTop || moovTop.end - moovTop.start > MAX_MOOV) return null;
  if (tops.some((x) => x.type === 'moof')) return null; // fragmented: not supported here
  const b = new Uint8Array(await blob.slice(moovTop.start, moovTop.end).arrayBuffer());
  const dv = new DataView(b.buffer);
  for (const trak of boxes(b, 0, b.length).filter((x) => x.type === 'trak')) {
    const hdlr = path(b, trak, 'mdia', 'hdlr');
    if (!hdlr || str4(b, hdlr.start + 8) !== 'vide') continue;
    const mdhd = path(b, trak, 'mdia', 'mdhd');
    const stbl = path(b, trak, 'mdia', 'minf', 'stbl');
    const tkhd = child(b, trak, 'tkhd');
    if (!mdhd || !stbl || !tkhd) continue;
    const timescale = dv.getUint32(mdhd.start + (b[mdhd.start] === 1 ? 20 : 12));
    const stsd = child(b, stbl, 'stsd');
    const entry = stsd && boxes(b, stsd.start + 8, stsd.end)[0];
    const codec = entry && codecOf(b, entry);
    if (!codec) return null;
    const codedWidth = dv.getUint16(entry.start + 24), codedHeight = dv.getUint16(entry.start + 26);

    // Sample sizes.
    const stsz = child(b, stbl, 'stsz');
    if (!stsz) return null;
    const fixed = dv.getUint32(stsz.start + 4), count = dv.getUint32(stsz.start + 8);
    const sizes = new Array(count);
    for (let i = 0; i < count; i++) sizes[i] = fixed || dv.getUint32(stsz.start + 12 + 4 * i);
    // Chunk offsets and samples per chunk -> sample offsets.
    const stco = child(b, stbl, 'stco'), co64 = child(b, stbl, 'co64'), stsc = child(b, stbl, 'stsc');
    if ((!stco && !co64) || !stsc) return null;
    const co = stco || co64;
    const nChunks = dv.getUint32(co.start + 4);
    const chunkOff = (i) => (stco ? dv.getUint32(co.start + 8 + 4 * i) : Number(dv.getBigUint64(co.start + 8 + 8 * i)));
    const scN = dv.getUint32(stsc.start + 4);
    const offsets = new Array(count);
    let s = 0;
    for (let e = 0; e < scN && s < count; e++) {
      const first = dv.getUint32(stsc.start + 8 + 12 * e) - 1;
      const per = dv.getUint32(stsc.start + 12 + 12 * e);
      const last = e + 1 < scN ? dv.getUint32(stsc.start + 8 + 12 * (e + 1)) - 1 : nChunks;
      for (let c = first; c < last && s < count; c++) {
        let o = chunkOff(c);
        for (let j = 0; j < per && s < count; j++, s++) {
          offsets[s] = o;
          o += sizes[s];
        }
      }
    }
    if (s < count) return null;
    // Decode times, composition offsets, the edit list start.
    const stts = child(b, stbl, 'stts'), ctts = child(b, stbl, 'ctts'), stss = child(b, stbl, 'stss');
    if (!stts) return null;
    const dts = new Array(count);
    let t = 0, k = 0;
    for (let e = 0, n = dv.getUint32(stts.start + 4); e < n; e++) {
      const c = dv.getUint32(stts.start + 8 + 8 * e), d = dv.getUint32(stts.start + 12 + 8 * e);
      for (let j = 0; j < c && k < count; j++, k++, t += d) dts[k] = t;
    }
    for (; k < count; k++) dts[k] = t;
    const cto = new Array(count).fill(0);
    if (ctts) {
      k = 0;
      for (let e = 0, n = dv.getUint32(ctts.start + 4); e < n; e++) {
        const c = dv.getUint32(ctts.start + 8 + 8 * e), o = dv.getInt32(ctts.start + 12 + 8 * e);
        for (let j = 0; j < c && k < count; j++, k++) cto[k] = o;
      }
    }
    let shift = 0;
    const elst = path(b, trak, 'edts', 'elst');
    if (elst) {
      const v1 = b[elst.start] === 1;
      const n = dv.getUint32(elst.start + 4);
      for (let e = 0; e < n; e++) {
        const o = elst.start + 8 + e * (v1 ? 20 : 12);
        const mt = v1 ? Number(dv.getBigInt64(o + 8)) : dv.getInt32(o + 4);
        if (mt >= 0) {
          shift = mt;
          break;
        }
      }
    }
    const sync = stss ? new Set(Array.from({ length: dv.getUint32(stss.start + 4) }, (_, i) => dv.getUint32(stss.start + 8 + 4 * i) - 1)) : null;
    const samples = new Array(count);
    let maxUs = 0;
    for (let i = 0; i < count; i++) {
      const us = Math.round(((dts[i] + cto[i] - shift) * 1e6) / timescale);
      samples[i] = { offset: offsets[i], size: sizes[i], us, key: sync ? sync.has(i) : true };
      maxUs = Math.max(maxUs, us);
    }
    if (!count || !samples[0].key) return null;
    return { ...codec, codedWidth, codedHeight, rotation: rotationOf(b, tkhd), samples, durationUs: maxUs };
  }
  return null;
}

// The source rectangle (frame coordinates) and the drawing transform for a crop in display
// coordinates of a frame that is shown turned by 'rotation' degrees (clockwise). fw, fh: the frame
// size (not turned). c: { sx, sy, sw, sh } in display coordinates. w, h: the output size.
// Returns { sx, sy, sw, sh, m: [a, b, c, d, e, f], dw, dh } for setTransform(...m) and drawImage(frame,
// sx, sy, sw, sh, 0, 0, dw, dh).
export function turnedCrop(rotation, fw, fh, c, w, h) {
  switch (rotation) {
    case 90:
      return { sx: c.sy, sy: fh - c.sx - c.sw, sw: c.sh, sh: c.sw, m: [0, 1, -1, 0, w, 0], dw: h, dh: w };
    case 180:
      return { sx: fw - c.sx - c.sw, sy: fh - c.sy - c.sh, sw: c.sw, sh: c.sh, m: [-1, 0, 0, -1, w, h], dw: w, dh: h };
    case 270:
      return { sx: fw - c.sy - c.sh, sy: c.sx, sw: c.sh, sh: c.sw, m: [0, -1, 1, 0, 0, h], dw: h, dh: w };
    default:
      return { sx: c.sx, sy: c.sy, sw: c.sw, sh: c.sh, m: [1, 0, 0, 1, 0, 0], dw: w, dh: h };
  }
}
