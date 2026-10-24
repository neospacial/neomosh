// Session storage in IndexedDB (plan §12).
// R-33: frames are written in batches, about every 1 s, in one transaction. Only meta stays in RAM.
// R-34: the export reads frames in sequence, in batches. It does not load all frames.

export const DB_NAME = 'neomosh';
export const DB_VERSION = 1;

function req(r) {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function done(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
  });
}

export function openDb() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, DB_VERSION);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains('sessions')) db.createObjectStore('sessions', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('frames')) db.createObjectStore('frames', { keyPath: ['sessionId', 'index'] });
      if (!db.objectStoreNames.contains('points')) db.createObjectStore('points', { keyPath: ['sessionId', 'n'] });
      if (!db.objectStoreNames.contains('audio')) db.createObjectStore('audio', { keyPath: ['sessionId', 'chunk'] });
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.onblocked = () => reject(new Error('The database is in use by another tab'));
  });
}

// All keys [id, n] for n >= from.
const range = (id, from = 0, to = Infinity) => IDBKeyRange.bound([id, from], [id, to]);

export class Store {
  constructor(db) {
    this.db = db;
    this.pending = [];
    this.flushing = null;
    this.timer = 0;
    this.error = null;
  }

  static async open() {
    return new Store(await openDb());
  }

  async listSessions() {
    const tx = this.db.transaction('sessions');
    return req(tx.objectStore('sessions').getAll());
  }

  async putSession(s) {
    const tx = this.db.transaction('sessions', 'readwrite');
    tx.objectStore('sessions').put(s);
    return done(tx);
  }

  async deleteSession(id) {
    const tx = this.db.transaction(['sessions', 'frames', 'points', 'audio'], 'readwrite');
    tx.objectStore('sessions').delete(id);
    for (const s of ['frames', 'points', 'audio']) tx.objectStore(s).delete(range(id));
    return done(tx);
  }

  // Queue a frame. It is written with the next batch (R-33).
  addFrame(frame) {
    this.pending.push(frame);
    if (!this.timer) this.timer = setTimeout(() => this.flush().catch((e) => (this.error = e)), 1000);
  }

  // Write all queued frames. Resolves when they are stored.
  async flush() {
    clearTimeout(this.timer);
    this.timer = 0;
    if (this.flushing) await this.flushing;
    if (!this.pending.length) return;
    const batch = this.pending;
    this.pending = [];
    const tx = this.db.transaction('frames', 'readwrite');
    const os = tx.objectStore('frames');
    for (const f of batch) os.put(f);
    this.flushing = done(tx).finally(() => (this.flushing = null));
    return this.flushing;
  }

  async countFrames(id) {
    const tx = this.db.transaction('frames');
    return req(tx.objectStore('frames').count(range(id)));
  }

  // Plan §12.3 steps 1 and 2: delete the frames from frameIndex and the points after n.
  // (Step 3, the audio, comes with the audio in Phase 6.)
  async truncate(id, frameIndex, n) {
    this.pending = this.pending.filter((f) => f.index < frameIndex);
    await this.flush();
    const tx = this.db.transaction(['frames', 'points'], 'readwrite');
    tx.objectStore('frames').delete(range(id, frameIndex));
    tx.objectStore('points').delete(range(id, n + 1));
    return done(tx);
  }

  async getPoint(id, n) {
    const tx = this.db.transaction('points');
    return req(tx.objectStore('points').get([id, n]));
  }

  async putPoint(p) {
    const tx = this.db.transaction('points', 'readwrite');
    tx.objectStore('points').put(p);
    return done(tx);
  }

  async getPoints(id) {
    const tx = this.db.transaction('points');
    return req(tx.objectStore('points').getAll(range(id)));
  }

  // Frames from..to (inclusive) in index order, read in batches.
  async *readFrames(id, from = 0, to = Infinity, batch = 120) {
    let i = from;
    while (i <= to) {
      const tx = this.db.transaction('frames');
      const list = await req(tx.objectStore('frames').getAll(range(id, i, Math.min(to, i + batch - 1))));
      if (!list.length) return;
      for (const f of list) yield f;
      i = list[list.length - 1].index + 1;
    }
  }

  // Bytes used and free (navigator.storage.estimate()), or null.
  static async estimate() {
    try {
      const e = await navigator.storage.estimate();
      return { used: e.usage, free: e.quota - e.usage };
    } catch {
      return null;
    }
  }
}
