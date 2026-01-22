// encryptedSearch.js
// Lightweight encrypted local search index (uses browser IndexedDB)

const EncryptedSearch = (function () {
  const DB = 'local_search_db';
  const STORE = 'tokens';
  let deviceKey = null;

  // Open or create IndexedDB
  async function openDB() {
    return new Promise((res, rej) => {
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }

  // Ensure a per-device random key
  async function ensureKey() {
    if (deviceKey) return deviceKey;
    let k = localStorage.getItem('local_search_key');
    if (!k) {
      const arr = crypto.getRandomValues(new Uint8Array(32));
      k = Array.from(arr)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
      localStorage.setItem('local_search_key', k);
    }
    deviceKey = k;
    return k;
  }

  // Create a SHA-256 hash of the token + device key
  async function tokenHash(t) {
    await ensureKey();
    const msgUint8 = new TextEncoder().encode(t + deviceKey);
    const hashBuffer = await crypto.subtle.digest('SHA-256', msgUint8);
    return Array.from(new Uint8Array(hashBuffer))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }

  // Index one message into local search DB
  async function indexMessage(msgObj) {
    if (!msgObj?.msg) return;
    const db = await openDB();
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);

    const tokens = msgObj.msg.toLowerCase().split(/\s+/).filter(Boolean);
    for (const t of tokens) {
      const h = await tokenHash(t);

      // Get existing list safely
      const getReq = store.get(h);
      const existing = await new Promise((resolve) => {
        getReq.onsuccess = () => resolve(getReq.result || []);
        getReq.onerror = () => resolve([]);
      });

      let list = Array.isArray(existing) ? existing : [];
      if (!list.includes(msgObj.id)) list.push(msgObj.id);
      store.put(list, h);
    }
  }

  // Search messages locally
  async function search(query, allMessages) {
    if (!query) return [];
    const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (!tokens.length) return [];

    const db = await openDB();
    const tx = db.transaction(STORE, 'readonly');
    const store = tx.objectStore(STORE);

    const allSets = [];
    for (const t of tokens) {
      const h = await tokenHash(t);

      const getReq = store.get(h);
      const ids = await new Promise((resolve) => {
        getReq.onsuccess = () => resolve(getReq.result || []);
        getReq.onerror = () => resolve([]);
      });

      allSets.push(new Set(ids));
    }

    const intersection = allSets.reduce((acc, s) => {
      if (!acc) return s;
      return new Set([...acc].filter((x) => s.has(x)));
    }, null);

    return allMessages.filter((m) => intersection.has(m.id));
  }

  // Expose public methods
  return { indexMessage, search };
})();

export default EncryptedSearch;
