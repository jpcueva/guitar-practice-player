// Offline song library in IndexedDB.
// songs: {id, ...song.json fields, addedAt, bytes, prefs}
// files: {key: `${songId}/${path}`, songId, path, blob}

const DB_NAME = 'guitar-practice-player';
const DB_VERSION = 1;
let dbp = null;

function db() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains('songs')) d.createObjectStore('songs', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('files')) {
        const f = d.createObjectStore('files', { keyPath: 'key' });
        f.createIndex('songId', 'songId');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

function tx(stores, mode, fn) {
  return db().then(d => new Promise((resolve, reject) => {
    const t = d.transaction(stores, mode);
    let result;
    Promise.resolve(fn(t)).then(r => { result = r; });
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('Storage transaction aborted (the phone may be out of space).'));
  }));
}

const reqP = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

export async function listSongs() {
  const all = await tx(['songs'], 'readonly', t => reqP(t.objectStore('songs').getAll()));
  return all.sort((a, b) => (a.title || '').localeCompare(b.title || ''));
}

export async function getSong(id) {
  return tx(['songs'], 'readonly', t => reqP(t.objectStore('songs').get(id)));
}

export async function putSong(song) {
  return tx(['songs'], 'readwrite', t => reqP(t.objectStore('songs').put(song)));
}

/** Save files one per transaction so a big import doesn't hold one huge transaction. */
export async function putFiles(songId, files /* [{path, blob}] */, onProgress) {
  let i = 0;
  for (const f of files) {
    onProgress?.(i++, files.length, f.path);
    await tx(['files'], 'readwrite', t => reqP(t.objectStore('files').put({ key: `${songId}/${f.path}`, songId, path: f.path, blob: f.blob })));
  }
}

export async function getFile(songId, path) {
  const rec = await tx(['files'], 'readonly', t => reqP(t.objectStore('files').get(`${songId}/${path}`)));
  return rec ? rec.blob : null;
}

export async function deleteSong(id) {
  await tx(['songs', 'files'], 'readwrite', t => new Promise((resolve) => {
    t.objectStore('songs').delete(id);
    const idx = t.objectStore('files').index('songId');
    const cur = idx.openKeyCursor(IDBKeyRange.only(id));
    cur.onsuccess = () => {
      const c = cur.result;
      if (c) { t.objectStore('files').delete(c.primaryKey); c.continue(); } else resolve();
    };
  }));
}

/** Delete the song's files for which shouldDelete(path) is true; the song record stays. */
export async function deleteFiles(id, shouldDelete) {
  await tx(['files'], 'readwrite', t => new Promise((resolve) => {
    const idx = t.objectStore('files').index('songId');
    const cur = idx.openCursor(IDBKeyRange.only(id));
    cur.onsuccess = () => {
      const c = cur.result;
      if (!c) return resolve();
      if (shouldDelete(c.value.path)) c.delete();
      c.continue();
    };
  }));
}

export async function storageInfo() {
  const out = { usage: null, quota: null, persisted: null };
  try {
    if (navigator.storage?.estimate) Object.assign(out, await navigator.storage.estimate());
    if (navigator.storage?.persisted) out.persisted = await navigator.storage.persisted();
  } catch {}
  return out;
}

export async function requestPersist() {
  try { return navigator.storage?.persist ? await navigator.storage.persist() : false; } catch { return false; }
}
