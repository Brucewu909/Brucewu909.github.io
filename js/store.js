// Store / don't-store. Off: data lives only in memory and is gone on reload.
// On: data is encrypted with a passphrase (PBKDF2 -> AES-GCM, Web Crypto) and kept in this
// browser's IndexedDB. Exports are the same encrypted blob. Nothing is ever sent anywhere.

const DB = "travels", OS = "vault", KEY = "data";
const ITERATIONS = 310000;
const enc = new TextEncoder(), dec = new TextDecoder();

function b64(buf) {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(OS);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idb(mode, fn) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(OS, mode);
      const req = fn(tx.objectStore(OS));
      tx.oncomplete = () => resolve(req?.result);
      tx.onerror = () => reject(tx.error);
    });
  } finally { db.close(); }
}

async function deriveKey(passphrase, salt) {
  const base = await crypto.subtle.importKey("raw", enc.encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: ITERATIONS, hash: "SHA-256" },
    base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

async function seal(key, salt, data) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(JSON.stringify(data)));
  return { app: "travels", v: 1, kdf: "PBKDF2-SHA256", iterations: ITERATIONS,
           salt: b64(salt), iv: b64(iv), ct: b64(ct) };
}

async function open(blob, passphrase) {
  if (blob?.app !== "travels" || blob.v !== 1) throw new Error("Not a travels backup file.");
  const salt = unb64(blob.salt);
  const key = await deriveKey(passphrase, salt);
  try {
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(blob.iv) }, key, unb64(blob.ct));
    return { key, salt, data: JSON.parse(dec.decode(pt)) };
  } catch { throw new Error("Wrong passphrase."); }
}

export class Vault {
  key = null; salt = null;
  get enabled() { return !!this.key; }

  /** Is there an encrypted copy saved in this browser? */
  async hasSaved() { return !!(await idb("readonly", (s) => s.get(KEY))); }

  async unlock(passphrase) {
    const r = await open(await idb("readonly", (s) => s.get(KEY)), passphrase);
    this.key = r.key; this.salt = r.salt;
    return r.data;
  }

  async enable(passphrase, data) {
    this.salt = crypto.getRandomValues(new Uint8Array(16));
    this.key = await deriveKey(passphrase, this.salt);
    await this.save(data);
  }

  async save(data) {
    if (!this.key) return;
    const blob = await seal(this.key, this.salt, data);
    await idb("readwrite", (s) => s.put(blob, KEY));
  }

  /** Turn storage off and wipe the saved copy from this browser. */
  async disable() {
    this.key = null; this.salt = null;
    await idb("readwrite", (s) => s.delete(KEY));
  }

  /** Encrypted backup. Uses the vault key if storage is on, otherwise a one-off passphrase. */
  async exportBlob(data, passphrase) {
    if (passphrase) {
      const salt = crypto.getRandomValues(new Uint8Array(16));
      return seal(await deriveKey(passphrase, salt), salt, data);
    }
    return seal(this.key, this.salt, data);
  }

  async importBlob(blob, passphrase) { return (await open(blob, passphrase)).data; }
}
