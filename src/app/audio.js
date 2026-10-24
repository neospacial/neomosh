// Audio (plan §10, D11): AAC check, capture with an AudioWorklet, PCM storage for each clip with
// the exact video clip length (R-30), and AAC encoding at export.

export const AAC_CONFIG = { codec: 'mp4a.40.2', numberOfChannels: 2, bitrate: 160000 };
const CHUNK_SECONDS = 1;

// The worklet collects blocks of about 2048 frames and posts them with the context frame of the
// first sample. It runs only while it is on (RECORDING).
const WORKLET_SRC = `
class NeomoshCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.on = false;
    this.n = 0;
    this.l = new Float32Array(2048);
    this.r = new Float32Array(2048);
    this.frame = 0;
    this.port.onmessage = (e) => {
      if (e.data === 'start') { this.on = true; this.n = 0; }
      if (e.data === 'stop') { this.flush(); this.on = false; this.port.postMessage({ done: true }); }
    };
  }
  flush() {
    if (!this.n) return;
    const l = this.l.slice(0, this.n), r = this.r.slice(0, this.n);
    this.port.postMessage({ frame: this.frame, l, r }, [l.buffer, r.buffer]);
    this.n = 0;
  }
  process(inputs) {
    if (!this.on) return true;
    const inp = inputs[0];
    const len = inp && inp.length ? inp[0].length : 128;
    // A full batch, or a gap in the frames (a skipped render quantum): post the batch first.
    if (this.n + len > this.l.length || (this.n && currentFrame !== this.frame + this.n)) this.flush();
    if (this.n === 0) this.frame = currentFrame;
    if (inp && inp.length) {
      this.l.set(inp[0], this.n);
      this.r.set(inp[1] || inp[0], this.n);
    } else {
      this.l.fill(0, this.n, this.n + len);
      this.r.fill(0, this.n, this.n + len);
    }
    this.n += len;
    return true;
  }
}
registerProcessor('neomosh-capture', NeomoshCapture);
`;

// At the gate (a user gesture): make the AudioContext and check for an AAC AudioEncoder.
// Returns { ctx, sampleRate } or { reason } when audio is off.
export async function checkAudio() {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC || typeof AudioEncoder === 'undefined') return { reason: 'aac' };
  let ctx;
  try {
    ctx = new AC();
    const s = await AudioEncoder.isConfigSupported({ ...AAC_CONFIG, sampleRate: ctx.sampleRate });
    if (!s.supported) throw new Error('AAC');
    const url = URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'text/javascript' }));
    await ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    await ctx.suspend(); // nothing runs until a recording starts
    return { ctx, sampleRate: ctx.sampleRate };
  } catch {
    if (ctx) ctx.close().catch(() => {});
    return { reason: 'aac' };
  }
}

// Capture for one AudioContext. The source node changes with the clip (microphone or file).
export class AudioCapture {
  constructor(ctx) {
    this.ctx = ctx;
    this.sampleRate = ctx.sampleRate;
    this.node = new AudioWorkletNode(ctx, 'neomosh-capture', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
    // The worklet output is silence. The connection to the destination makes the graph run.
    this.node.connect(ctx.destination);
    this.node.port.onmessage = (e) => this.onMessage(e.data);
    this.source = null;
    this.clip = null;
    this.fileSources = new WeakMap();
  }

  // The source node: a media element (file, never to the speakers: plan §10.2) or a stream (mic).
  sourceFor(kind, el, stream) {
    if (kind === 'file') {
      let s = this.fileSources.get(el);
      if (!s) {
        s = this.ctx.createMediaElementSource(el); // only one for each element
        this.fileSources.set(el, s);
      }
      el.muted = false; // the element sound goes to the graph, not to the speakers
      return s;
    }
    const track = stream && stream.getAudioTracks()[0];
    return track && track.readyState === 'live' ? this.ctx.createMediaStreamSource(new MediaStream([track])) : null;
  }

  // Start the capture for a clip. clip: a ClipAudio.
  async start(clip, kind, el, stream) {
    this.clip = clip;
    await this.ctx.resume();
    this.source = this.sourceFor(kind, el, stream);
    if (this.source) this.source.connect(this.node);
    // Context time = performance time (s) + offset, for the start of the video (R-30).
    this.offset = this.ctx.currentTime - performance.now() / 1000;
    this.node.port.postMessage('start');
  }

  // The context frame at a performance time (ms).
  frameAt(perfMs) {
    return Math.round((perfMs / 1000 + this.offset) * this.sampleRate);
  }

  // Stop the capture. Resolves when the last block arrived. The context is then suspended.
  stop() {
    return new Promise((resolve) => {
      this.stopWaiter = resolve;
      this.node.port.postMessage('stop');
    }).then(async () => {
      if (this.source) this.source.disconnect();
      this.source = null;
      await this.ctx.suspend();
    });
  }

  onMessage(m) {
    if (m.done) {
      if (this.stopWaiter) this.stopWaiter();
      this.stopWaiter = null;
      return;
    }
    if (this.clip) this.clip.addBlock(m.frame, m.l, m.r);
  }
}

const toS16 = (v) => {
  const x = Math.round(v * 32767);
  return x > 32767 ? 32767 : x < -32768 ? -32768 : x;
};

// The audio of one clip. Sample i of the clip = context frame startFrame + i. The clip starts at
// session sample base (the end of the previous clips). PCM goes to the store in chunks of about 1 s.
export class ClipAudio {
  constructor(store, sessionId, sampleRate, base) {
    this.store = store;
    this.id = sessionId;
    this.sr = sampleRate;
    this.base = base;
    this.startFrame = null;
    this.pending = []; // blocks before the start is known
    this.written = 0; // samples stored
    this.buf = new Int16Array(sampleRate * CHUNK_SECONDS * 2);
    this.bufLen = 0; // samples in buf
    this.writes = Promise.resolve();
  }

  // The context frame of the first video frame of the clip.
  setStart(frame) {
    if (this.startFrame !== null) return;
    this.startFrame = frame;
    const p = this.pending;
    this.pending = [];
    for (const b of p) this.addBlock(b.frame, b.l, b.r);
  }

  addBlock(frame, l, r) {
    if (this.startFrame === null) {
      this.pending.push({ frame, l, r });
      return;
    }
    const expected = this.startFrame + this.written + this.bufLen;
    let from = 0;
    if (frame > expected) this.pushSilence(frame - expected); // a gap: silence keeps the sync
    else from = expected - frame; // the samples before the start (or a repeat)
    for (let i = from; i < l.length; i++) this.push(toS16(l[i]), toS16(r[i]));
  }

  push(a, b) {
    const k = this.bufLen * 2;
    this.buf[k] = a;
    this.buf[k + 1] = b;
    if (++this.bufLen * 2 === this.buf.length) this.flush();
  }

  pushSilence(n) {
    for (let i = 0; i < n; i++) this.push(0, 0);
  }

  flush() {
    if (!this.bufLen) return;
    const pcm = this.buf.slice(0, this.bufLen * 2);
    const start = this.base + this.written;
    this.written += this.bufLen;
    this.bufLen = 0;
    this.writes = this.writes.then(() => this.store.putAudio(this.id, start, pcm));
  }

  // R-30: trim or pad the clip audio to exactly len samples, and store all of it.
  async finish(len) {
    if (this.startFrame === null) this.setStart(this.pending.length ? this.pending[0].frame : 0);
    const have = this.written + this.bufLen;
    if (have < len) this.pushSilence(len - have);
    else if (len >= this.written) this.bufLen = len - this.written;
    else this.bufLen = 0;
    this.flush();
    await this.writes;
    if (this.written > len) await this.store.truncateAudio(this.id, this.base + len);
    return this.base + len;
  }
}

// Silence for a clip without a sound source (for example the microphone is off).
export async function storeSilence(store, id, sampleRate, base, len) {
  const clip = new ClipAudio(store, id, sampleRate, base);
  clip.setStart(0);
  return clip.finish(len);
}

// Export (plan §10.3): encode the stored PCM to AAC. Returns a track for muxMp4, or null.
export async function encodeAudio(store, id, sampleRate, totalSamples, { signal, onProgress } = {}) {
  const out = [];
  let asc = null;
  let error = null;
  const enc = new AudioEncoder({
    output: (chunk, meta) => {
      if (meta && meta.decoderConfig && meta.decoderConfig.description) asc = new Uint8Array(meta.decoderConfig.description);
      const d = new Uint8Array(chunk.byteLength);
      chunk.copyTo(d);
      out.push(d);
    },
    error: (e) => (error = e),
  });
  enc.configure({ ...AAC_CONFIG, sampleRate });
  let done = 0;
  for await (const c of store.readAudio(id)) {
    if (signal && signal.aborted) throw new Error('Export cancelled');
    if (error) throw error;
    if (c.startSample >= totalSamples) break;
    const n = Math.min(c.pcm.length / 2, totalSamples - c.startSample);
    const data = new AudioData({
      format: 's16', sampleRate, numberOfFrames: n, numberOfChannels: 2,
      timestamp: Math.round((c.startSample * 1e6) / sampleRate), data: c.pcm.subarray(0, n * 2),
    });
    enc.encode(data);
    data.close();
    done = c.startSample + n;
    if (onProgress) onProgress(done / totalSamples);
    while (enc.encodeQueueSize > 4) await new Promise((r) => setTimeout(r, 5));
  }
  await enc.flush();
  enc.close();
  if (error) throw error;
  if (!out.length) return null;
  return {
    sampleRate, channels: 2, bitrate: AAC_CONFIG.bitrate, asc: asc || makeAsc(sampleRate, 2),
    samples: out.map((d) => ({ data: d, size: d.length, duration: 1024 })),
  };
}

const RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

// AudioSpecificConfig for AAC-LC.
export function makeAsc(sampleRate, channels) {
  const fi = RATES.indexOf(sampleRate);
  return new Uint8Array([(2 << 3) | (fi >> 1), ((fi & 1) << 7) | (channels << 3)]);
}
