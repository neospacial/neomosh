// MP4 muxer (plan §9.4). Video only (no audio: D20).
// Layout: ftyp, moov, mdat. The moov comes first, so all sample sizes must be known first.
// R-27: the file is returned as a list of parts (for a Blob). There is no one large buffer.
// R-28: co64 when a chunk offset is 4 GB or more, else stco.
// R-29: stss lists only the samples marked as key (IDR and Clean I-frames).

const MOVIE_TIMESCALE = 1000;

// Big-endian byte builder.
class Bytes {
  constructor() {
    this.a = [];
  }
  u8(v) { this.a.push(v & 255); return this; }
  u16(v) { this.a.push((v >>> 8) & 255, v & 255); return this; }
  u24(v) { this.a.push((v >>> 16) & 255, (v >>> 8) & 255, v & 255); return this; }
  u32(v) { this.a.push((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255); return this; }
  u64(v) { return this.u32(Math.floor(v / 4294967296)).u32(v >>> 0); }
  str(s) { for (let i = 0; i < s.length; i++) this.a.push(s.charCodeAt(i) & 255); return this; }
  bytes(b) { for (let i = 0; i < b.length; i++) this.a.push(b[i]); return this; }
  zeros(n) { for (let i = 0; i < n; i++) this.a.push(0); return this; }
  get length() { return this.a.length; }
}

// A box: size, type, then the content (Bytes or arrays of child boxes as Uint8Array).
function box(type, ...content) {
  let len = 8;
  for (const c of content) len += c.length;
  const out = new Uint8Array(len);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, len);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  let o = 8;
  for (const c of content) {
    out.set(c instanceof Bytes ? c.a : c, o);
    o += c.length;
  }
  return out;
}

function fullBox(type, version, flags, ...content) {
  return box(type, new Bytes().u8(version).u24(flags), ...content);
}

const MATRIX = [0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000];

function ftyp() {
  return box('ftyp', new Bytes().str('isom').u32(512).str('isom').str('iso2').str('avc1').str('mp41'));
}

function mvhd(duration, nextTrackId) {
  const b = new Bytes().u32(0).u32(0).u32(MOVIE_TIMESCALE).u32(duration)
    .u32(0x00010000).u16(0x0100).zeros(10);
  for (const m of MATRIX) b.u32(m);
  return fullBox('mvhd', 0, 0, b.zeros(24).u32(nextTrackId));
}

function tkhd(trackId, duration, width, height, isAudio) {
  const b = new Bytes().u32(0).u32(0).u32(trackId).u32(0).u32(duration).zeros(8)
    .u16(0).u16(isAudio ? 1 : 0).u16(isAudio ? 0x0100 : 0).u16(0);
  for (const m of MATRIX) b.u32(m);
  return fullBox('tkhd', 0, 3, b.u32(width * 65536).u32(height * 65536));
}

function mdhd(timescale, duration) {
  return fullBox('mdhd', 0, 0, new Bytes().u32(0).u32(0).u32(timescale).u32(duration).u16(0x55c4).u16(0));
}

function hdlr(type, name) {
  return fullBox('hdlr', 0, 0, new Bytes().u32(0).str(type).zeros(12).str(name).u8(0));
}

function dinf() {
  return box('dinf', fullBox('dref', 0, 0, new Bytes().u32(1), fullBox('url ', 0, 1)));
}

// avcC (ISO/IEC 14496-15 5.3.3.1) from one SPS and one PPS NAL unit (without start codes).
export function avcC(sps, pps) {
  return box('avcC', new Bytes().u8(1).u8(sps[1]).u8(sps[2]).u8(sps[3]).u8(0xff).u8(0xe1)
    .u16(sps.length).bytes(sps).u8(1).u16(pps.length).bytes(pps));
}

function avc1(v) {
  const b = new Bytes().zeros(6).u16(1).zeros(16).u16(v.width).u16(v.height)
    .u32(0x00480000).u32(0x00480000).u32(0).u16(1).zeros(32).u16(0x0018).u16(0xffff);
  // colr nclx: BT.709 primaries, transfer, and matrix; limited range (plan §6.1).
  const colr = box('colr', new Bytes().str('nclx').u16(1).u16(1).u16(1).u8(0));
  const pasp = box('pasp', new Bytes().u32(1).u32(1));
  // v.avcc: an existing avcC record (for example from a VideoEncoder), else made from the SPS and PPS.
  // The colour of a VideoEncoder stream is in its own SPS, so there is no colr box for it.
  if (v.avcc) return box('avc1', b, box('avcC', v.avcc), pasp);
  return box('avc1', b, avcC(v.sps, v.pps), colr, pasp);
}

function stts(durations) {
  const runs = [];
  for (const d of durations) {
    const last = runs[runs.length - 1];
    if (last && last[1] === d) last[0]++;
    else runs.push([1, d]);
  }
  const b = new Bytes().u32(runs.length);
  for (const [n, d] of runs) b.u32(n).u32(d);
  return fullBox('stts', 0, 0, b);
}

// Composition offsets (ctts version 0): display time - decode time of each sample, for an encoder
// with B-frames (frames in decode order, not display order). Only the Upscale export needs it.
function ctts(offsets) {
  const runs = [];
  for (const o of offsets) {
    const last = runs[runs.length - 1];
    if (last && last[1] === o) last[0]++;
    else runs.push([1, o]);
  }
  const b = new Bytes().u32(runs.length);
  for (const [n, o] of runs) b.u32(n).u32(o);
  return fullBox('ctts', 0, 0, b);
}

// Edit list: the presentation starts at mediaTime (the delay that the composition offsets add), so
// the first picture shows at time 0.
function edts(movieDur, mediaTime) {
  return box('edts', fullBox('elst', 0, 0, new Bytes().u32(1).u32(movieDur).u32(mediaTime).u16(1).u16(0)));
}

function stss(keys) {
  const b = new Bytes().u32(keys.length);
  for (const k of keys) b.u32(k);
  return fullBox('stss', 0, 0, b);
}

function stsc(chunkSizes) {
  const runs = [];
  chunkSizes.forEach((n, i) => {
    if (!runs.length || runs[runs.length - 1][1] !== n) runs.push([i + 1, n]);
  });
  const b = new Bytes().u32(runs.length);
  for (const [first, n] of runs) b.u32(first).u32(n).u32(1);
  return fullBox('stsc', 0, 0, b);
}

function stsz(sizes) {
  const b = new Bytes().u32(0).u32(sizes.length);
  for (const s of sizes) b.u32(s);
  return fullBox('stsz', 0, 0, b);
}

function chunkOffsets(offsets, use64) {
  const b = new Bytes().u32(offsets.length);
  for (const o of offsets) (use64 ? b.u64(o) : b.u32(o));
  return fullBox(use64 ? 'co64' : 'stco', 0, 0, b);
}

// Make the MP4 file.
// video = { width, height, timescale, sps, pps, samples: [{ data: Uint8Array | Blob, size, duration, key, cto }] }
// The samples are in decode order. duration: the decode time to the next sample. cto (optional): the
// composition offset (display time - decode time, >= 0). video.mediaTime: the edit list start (the
// largest delay), when the samples have composition offsets.
// opts.chunkDuration: chunk length in timescale units (default 1 s).
// opts.forceCo64, opts.forceLargeMdat: for tests only.
// Returns { parts, size }. parts: Uint8Array headers and the sample data, in file order.
export function muxMp4(video, opts = {}) {
  const samples = video.samples;
  if (!samples.length) throw new Error('No samples');
  const ts = video.timescale;
  const chunkDur = opts.chunkDuration ?? ts;

  // Chunks: consecutive samples, about chunkDur long.
  const chunkSizes = [];
  const chunkBytes = [];
  let n = 0, dur = 0, bytes = 0;
  for (const s of samples) {
    n++;
    dur += s.duration;
    bytes += s.size;
    if (dur >= chunkDur) {
      chunkSizes.push(n);
      chunkBytes.push(bytes);
      n = dur = bytes = 0;
    }
  }
  if (n) {
    chunkSizes.push(n);
    chunkBytes.push(bytes);
  }
  let mdatPayload = 0;
  for (const b of chunkBytes) mdatPayload += b;
  const largeMdat = opts.forceLargeMdat || mdatPayload + 8 > 0xffffffff;
  const mdatHeader = largeMdat
    ? new Uint8Array([0, 0, 0, 1, 0x6d, 0x64, 0x61, 0x74, ...new Bytes().u64(mdatPayload + 16).a])
    : new Uint8Array([...new Bytes().u32(mdatPayload + 8).a, 0x6d, 0x64, 0x61, 0x74]);

  const durations = samples.map((s) => s.duration);
  const totalDur = durations.reduce((a, b) => a + b, 0);
  const movieDur = Math.round((totalDur * MOVIE_TIMESCALE) / ts);
  const reordered = samples.some((s) => s.cto);
  const keys = [];
  samples.forEach((s, i) => s.key && keys.push(i + 1));
  if (keys[0] !== 1) throw new Error('The first sample must be a sync sample');

  const head = ftyp();
  const build = (use64) => {
    // The chunk offsets depend on the moov size. The moov size depends only on use64.
    const offsets = chunkBytes.map(() => 0);
    const make = () => {
      const stbl = box('stbl',
        fullBox('stsd', 0, 0, new Bytes().u32(1), avc1(video)),
        stts(durations), ...(reordered ? [ctts(samples.map((s) => s.cto || 0))] : []),
        stss(keys), stsc(chunkSizes), stsz(samples.map((s) => s.size)),
        chunkOffsets(offsets, use64));
      const minf = box('minf', fullBox('vmhd', 0, 1, new Bytes().zeros(8)), dinf(), stbl);
      const mdia = box('mdia', mdhd(ts, totalDur), hdlr('vide', 'neomosh video'), minf);
      const trak = box('trak', tkhd(1, movieDur, video.width, video.height, false),
        ...(reordered ? [edts(movieDur, video.mediaTime || 0)] : []), mdia);
      return box('moov', mvhd(movieDur, 2), trak);
    };
    let moov = make();
    let o = head.length + moov.length + mdatHeader.length;
    for (let i = 0; i < chunkBytes.length; i++) {
      offsets[i] = o;
      o += chunkBytes[i];
    }
    moov = make();
    return { moov, lastOffset: offsets[offsets.length - 1] };
  };
  let r = build(!!opts.forceCo64);
  if (!opts.forceCo64 && r.lastOffset > 0xffffffff) r = build(true);

  const parts = [head, r.moov, mdatHeader];
  for (const s of samples) parts.push(s.data);
  return { parts, size: head.length + r.moov.length + mdatHeader.length + mdatPayload };
}
