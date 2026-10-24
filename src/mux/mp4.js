// MP4 muxer (plan §9.4). Video only in this version; the audio track comes in Phase 6.
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

function mp4a(a) {
  const b = new Bytes().zeros(6).u16(1).zeros(8).u16(a.channels).u16(16).u16(0).u16(0).u32(a.sampleRate * 65536);
  return box('mp4a', b, esds(a));
}

// esds (ISO/IEC 14496-1 ES_Descriptor) with the AudioSpecificConfig of the AAC stream.
function esds(a) {
  const desc = (tag, body) => new Bytes().u8(tag).u8(body.length).bytes(body.a || body);
  const dsi = desc(0x05, a.asc);
  const dcd = desc(0x04, new Bytes().u8(0x40).u8(0x15).u24(0).u32(a.bitrate || 0).u32(a.bitrate || 0).bytes(dsi.a));
  const sl = desc(0x06, [0x02]);
  const es = desc(0x03, new Bytes().u16(2).u8(0).bytes(dcd.a).bytes(sl.a));
  return fullBox('esds', 0, 0, es);
}

// Split the samples of a track into chunks of about chunkDur (timescale units).
function makeChunks(track, chunkDur) {
  const chunks = [];
  let cur = null, t = 0;
  track.samples.forEach((s, i) => {
    if (!cur) cur = { track, first: i, n: 0, bytes: 0, start: t / track.timescale, offset: 0 };
    cur.n++;
    cur.bytes += s.size;
    t += s.duration;
    if (t - cur.start * track.timescale >= chunkDur) {
      chunks.push(cur);
      cur = null;
    }
  });
  if (cur) chunks.push(cur);
  return chunks;
}

// Make the MP4 file.
// video = { width, height, timescale, sps, pps, samples: [{ data: Uint8Array | Blob, size, duration, key }] }
// audio (optional) = { sampleRate, channels, asc, bitrate, samples: [{ data, size, duration }] }, timescale = sampleRate
// opts.chunkDuration: chunk length in seconds (default 1). The chunks of the tracks are interleaved by time.
// opts.forceCo64, opts.forceLargeMdat: for tests only.
// Returns { parts, size }. parts: Uint8Array headers and the sample data, in file order.
export function muxMp4(video, opts = {}, audio = null) {
  if (!video.samples.length) throw new Error('No samples');
  const keys = [];
  video.samples.forEach((s, i) => s.key && keys.push(i + 1));
  if (keys[0] !== 1) throw new Error('The first sample must be a sync sample');
  const tracks = [{ ...video, kind: 'vide', id: 1 }];
  if (audio && audio.samples.length) tracks.push({ ...audio, timescale: audio.sampleRate, kind: 'soun', id: 2 });
  const chunkSec = opts.chunkDuration ?? 1;
  for (const t of tracks) {
    t.duration = t.samples.reduce((a, s) => a + s.duration, 0);
    t.chunks = makeChunks(t, chunkSec * t.timescale);
  }
  // File order of the chunks: by start time, video first at equal times.
  const order = tracks.flatMap((t) => t.chunks).sort((a, b) => a.start - b.start || a.track.id - b.track.id);
  let mdatPayload = 0;
  for (const c of order) mdatPayload += c.bytes;
  const largeMdat = opts.forceLargeMdat || mdatPayload + 8 > 0xffffffff;
  const mdatHeader = largeMdat
    ? new Uint8Array([0, 0, 0, 1, 0x6d, 0x64, 0x61, 0x74, ...new Bytes().u64(mdatPayload + 16).a])
    : new Uint8Array([...new Bytes().u32(mdatPayload + 8).a, 0x6d, 0x64, 0x61, 0x74]);
  const movieDur = Math.max(...tracks.map((t) => Math.round((t.duration * MOVIE_TIMESCALE) / t.timescale)));

  const head = ftyp();
  const trak = (t, use64) => {
    const isV = t.kind === 'vide';
    const tables = [
      fullBox('stsd', 0, 0, new Bytes().u32(1), isV ? avc1(t) : mp4a(t)),
      stts(t.samples.map((s) => s.duration)),
      ...(isV ? [stss(keys)] : []),
      stsc(t.chunks.map((c) => c.n)),
      stsz(t.samples.map((s) => s.size)),
      chunkOffsets(t.chunks.map((c) => c.offset), use64),
    ];
    const media = isV ? fullBox('vmhd', 0, 1, new Bytes().zeros(8)) : fullBox('smhd', 0, 0, new Bytes().u16(0).u16(0));
    const minf = box('minf', media, dinf(), box('stbl', ...tables));
    const mdia = box('mdia', mdhd(t.timescale, t.duration), hdlr(t.kind, isV ? 'neomosh video' : 'neomosh audio'), minf);
    const tdur = Math.round((t.duration * MOVIE_TIMESCALE) / t.timescale);
    return box('trak', tkhd(t.id, tdur, isV ? t.width : 0, isV ? t.height : 0, !isV), mdia);
  };
  const build = (use64) => {
    // The chunk offsets depend on the moov size. The moov size depends only on use64.
    const make = () => box('moov', mvhd(movieDur, tracks.length + 1), ...tracks.map((t) => trak(t, use64)));
    let o = head.length + make().length + mdatHeader.length;
    for (const c of order) {
      c.offset = o;
      o += c.bytes;
    }
    return { moov: make(), lastOffset: order[order.length - 1].offset };
  };
  let r = build(!!opts.forceCo64);
  if (!opts.forceCo64 && r.lastOffset > 0xffffffff) r = build(true);

  const parts = [head, r.moov, mdatHeader];
  for (const c of order) for (let i = c.first; i < c.first + c.n; i++) parts.push(c.track.samples[i].data);
  return { parts, size: head.length + r.moov.length + mdatHeader.length + mdatPayload };
}
