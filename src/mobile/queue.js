// queue.js — persistencia local del audio. Es lo único que impide perder una consulta.
//
// Dos almacenes:
//  - pending: grabaciones YA cerradas, esperando subir (con reintento y backoff).
//  - chunks : trozos de la grabación EN CURSO. MediaRecorder los entrega cada N segundos
//             y los escribimos al vuelo. Antes el audio vivía entero en RAM hasta el stop:
//             si iOS mataba la pestaña a los 18 minutos de consulta, se perdía todo. Ahora
//             lo peor que puede pasar es perder los últimos segundos.
const DB = 'medrecord-queue', VER = 2;
const PENDING = 'pending', CHUNKS = 'chunks';

function open() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, VER);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains(PENDING)) db.createObjectStore(PENDING, { keyPath: 'localId' });
      if (!db.objectStoreNames.contains(CHUNKS))  db.createObjectStore(CHUNKS,  { keyPath: 'key' });
    };
    r.onsuccess = () => res(r.result);
    r.onerror   = () => rej(r.error);
  });
}

function tx(store, mode, fn) {
  return open().then(db => new Promise((res, rej) => {
    const t = db.transaction(store, mode), s = t.objectStore(store);
    const out = fn(s);
    t.oncomplete = () => res(out instanceof IDBRequest ? out.result : out);
    t.onerror    = () => rej(t.error);
  }));
}

// Clave ordenable: el orden de los trozos ES el audio. Un sort lexicográfico mal hecho
// (chunk 10 antes que chunk 2) produciría una consulta con el diálogo desordenado.
const chunkKey = (draftId, seq) => `${draftId}:${String(seq).padStart(6, '0')}`;

export const MRQueue = {
  supported: typeof indexedDB !== 'undefined',

  // ── Grabaciones cerradas, pendientes de subir ──
  put: (item)    => tx(PENDING, 'readwrite', s => s.put(item)),
  del: (localId) => tx(PENDING, 'readwrite', s => s.delete(localId)),
  get: (localId) => tx(PENDING, 'readonly',  s => s.get(localId)),
  all: ()        => tx(PENDING, 'readonly',  s => s.getAll()),

  // ── Trozos de la grabación en curso ──
  // `type` es el mimeType REAL con el que graba este teléfono. Safari en iPhone graba
  // mp4, no webm: sin guardarlo, al recuperar un borrador armábamos el blob como webm y
  // subíamos bytes mp4 con extensión .webm. Whisper recibía un contenedor renombrado y la
  // transcripción salía basura — justo en el caso que esto existe para salvar.
  putChunk: (draftId, seq, blob, meta, type) =>
    tx(CHUNKS, 'readwrite', s => s.put({ key: chunkKey(draftId, seq), draftId, seq, blob, meta, type, at: Date.now() })),

  async chunksOf(draftId) {
    const all = await tx(CHUNKS, 'readonly', s => s.getAll());
    return (all || []).filter(c => c.draftId === draftId).sort((a, b) => a.seq - b.seq);
  },

  // Borradores huérfanos: la app se cerró (o iOS la mató) con una grabación en curso.
  async drafts() {
    const all = await tx(CHUNKS, 'readonly', s => s.getAll());
    const porDraft = new Map();
    for (const c of (all || [])) {
      if (!porDraft.has(c.draftId)) {
        porDraft.set(c.draftId, { draftId: c.draftId, meta: c.meta, type: c.type || '', chunks: [] });
      }
      porDraft.get(c.draftId).chunks.push(c);
    }
    for (const d of porDraft.values()) {
      d.chunks.sort((a, b) => a.seq - b.seq);
      // Duración real: del primer trozo al último, más lo que dura el último. El
      // `chunks.length * TROZO` de antes siempre sobreestimaba (el último trozo es parcial),
      // y esa duración se manda al servidor como dato clínico de la consulta.
      const ini = d.chunks[0], fin = d.chunks[d.chunks.length - 1];
      d.dur = ini && fin ? (fin.at - ini.at) / 1000 + 5 : 0;
    }
    return [...porDraft.values()];
  },

  // Basura: trozos de borradores que ya se ensamblaron y encolaron (la app murió entre el
  // enqueue y el delChunks). Sin esto, IndexedDB acumula el audio de cada consulta para
  // siempre en el teléfono — que además es PII de paciente.
  async limpiarHuerfanos(draftsVivos = []) {
    const vivos = new Set(draftsVivos);
    const pend = await tx(PENDING, 'readonly', s => s.getAll());
    const yaEncolados = new Set((pend || []).map(r => r.draftId).filter(Boolean));
    const all = await tx(CHUNKS, 'readonly', s => s.getAll());
    const basura = (all || []).filter(c => !vivos.has(c.draftId) && yaEncolados.has(c.draftId));
    if (!basura.length) return 0;
    await tx(CHUNKS, 'readwrite', s => { for (const c of basura) s.delete(c.key); });
    return basura.length;
  },

  async delChunks(draftId) {
    const all = await tx(CHUNKS, 'readonly', s => s.getAll());
    const keys = (all || []).filter(c => c.draftId === draftId).map(c => c.key);
    return tx(CHUNKS, 'readwrite', s => { for (const k of keys) s.delete(k); });
  },
};
