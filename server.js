const express = require('express');
const compression = require('compression');
const multer = require('multer');
const { createServer } = require('http');
const { WebSocketServer } = require('ws');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { transcribe, checkEnv } = require('./whisper');
const llm = require('./llm');

const PROD = process.env.NODE_ENV === 'production';
const distDir = path.join(__dirname, 'dist');
// Producción sirve dist/ (JSX precompilado); dev sirve public/ (Babel en navegador).
const STATIC_DIR = PROD && fs.existsSync(distDir) ? distDir : path.join(__dirname, 'public');

const DATA_DIR = path.join(__dirname, 'data', 'recordings');
fs.mkdirSync(DATA_DIR, { recursive: true });

// Dirección LAN (para que la web muestre el enlace al móvil en el estado vacío).
function lanAddress() {
  const ifaces = os.networkInterfaces();
  const lan = Object.values(ifaces).flat().find(i => i && i.family === 'IPv4' && !i.internal);
  return lan ? lan.address : null;
}
const LAN = lanAddress();

// ── Almacén de grabaciones (en RAM + sidecar JSON en disco; el audio va a disco) ──
// El audio vive en data/recordings/<id>.<ext> y los metadatos en data/recordings/<id>.json.
// Persistimos en cada cambio de estado para que un reinicio del server NO pierda el trabajo.
const recordings = new Map(); // id → rec

function metaPath(id) { return path.join(DATA_DIR, id + '.json'); }

function persist(rec) {
  if (!recordings.has(rec.id)) return;
  const dest = metaPath(rec.id);
  const tmp  = dest + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(rec));
    fs.renameSync(tmp, dest);
  } catch (err) {
    console.error('No se pudo persistir', rec.id, err.message);
    try { fs.unlinkSync(tmp); } catch {}
  }
}

// Reconstruye el Map desde los sidecar JSON al arrancar y re-dispara las que
// quedaron a medias (received/processing/filling) cuando el server se cayó.
function loadAll() {
  let files = [];
  try { files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.json')); } catch { /* noop */ }
  for (const f of files) {
    try {
      const rec = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8'));
      if (rec && rec.id) recordings.set(rec.id, rec);
    } catch (err) { console.error('Sidecar corrupto', f, err.message); }
  }
  // Reanudar las que quedaron en un estado intermedio.
  for (const rec of recordings.values()) {
    if (rec.status === 'received' || rec.status === 'processing' || rec.status === 'filling') {
      if (rec.audioFile && fs.existsSync(path.join(DATA_DIR, rec.audioFile))) {
        rec.status = 'received';
        processRecording(rec).catch(() => {});
      } else {
        rec.status = 'error';
        rec.error = 'Se perdió el audio al reiniciar el servidor.';
        persist(rec);
      }
    }
  }
  if (recordings.size) console.log(`  Restauradas ${recordings.size} grabaciones desde disco`);
}

const app = express();
app.disable('x-powered-by');
app.use(compression());
app.use(express.json({ limit: '2mb' }));

app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'microphone=(self)');
  next();
});

app.get('/health', async (_req, res) => res.json({
  ok: true,
  whisper: checkEnv().length === 0,
  llm: await llm.available(),
  llmModel: llm.MODEL,
  lan: LAN,
  port: PORT,
  ts: Date.now(),
}));

// ── Auth (opcional: solo activo si MEDRECORD_TOKEN está seteado) ──────────────
const REQUIRED_TOKEN = process.env.MEDRECORD_TOKEN || '';
if (REQUIRED_TOKEN) {
  app.use('/api', (req, res, next) => {
    const auth = req.headers['authorization'] || '';
    const [scheme, provided] = auth.split(' ');
    if (scheme === 'Bearer' && provided === REQUIRED_TOKEN) return next();
    res.status(401).json({ error: 'no autorizado' });
  });
}

// ── Subida de audio desde el móvil ──
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, DATA_DIR),
  filename: (req, file, cb) => {
    const id = crypto.randomUUID();
    req._recId = id;
    const ext = (path.extname(file.originalname || '') || '.webm').toLowerCase();
    cb(null, id + ext);
  },
});
const upload = multer({ storage, limits: { fileSize: 100 * 1024 * 1024 } });

app.post('/api/recordings', upload.single('audio'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'falta el audio' });
  const id = req._recId;
  const rec = {
    id,
    patient: { name: (req.body.patientName || '').trim(), dni: (req.body.patientDni || '').trim() },
    durationSec: Number(req.body.durationSec) || 0,
    status: 'received',
    transcript: null,
    error: null,
    fields: null,
    sources: null,
    fieldsError: null,
    reviewed: false,
    audioFile: req.file.filename,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  recordings.set(id, rec);
  persist(rec);
  res.json({ id, status: rec.status });

  broadcast({ type: 'recording:received', recording: publicRec(rec) });
  processRecording(rec).catch(() => {});
});

// Mínimo de caracteres para considerar una transcripción válida (filtra silencio/ruido).
const MIN_TRANSCRIPT = 10;

function setStatus(rec, status, evt) {
  // No emitas ni persistas estados de una grabación ya descartada (proceso en vuelo + DELETE).
  if (!recordings.has(rec.id)) return;
  rec.status = status;
  rec.updatedAt = Date.now();
  persist(rec);
  broadcast({ type: evt || ('recording:' + status), recording: publicRec(rec) });
}

// Corre Whisper, luego (si hay LLM local) autollena campos. Dispara eventos a la web.
async function processRecording(rec) {
  setStatus(rec, 'processing', 'recording:processing');
  let text;
  try {
    ({ text } = await transcribe(path.join(DATA_DIR, rec.audioFile)));
    rec.transcript = text;
  } catch (err) {
    rec.error = String(err.message || err);
    setStatus(rec, 'error', 'recording:error');
    return;
  }

  // Audio sin voz: Whisper puede devolver vacío. No es éxito — pedir regrabar.
  if (!text || text.trim().length < MIN_TRANSCRIPT) {
    rec.error = 'No se detectó voz en el audio. Vuelve a grabar más cerca del micrófono.';
    setStatus(rec, 'error', 'recording:error');
    return;
  }

  // Fase 1: transcripción lista (la web ya puede mostrarla)
  const llmOk = await llm.available();
  rec.fieldsError = null;
  setStatus(rec, llmOk ? 'filling' : 'done', 'recording:transcribed');
  if (!llmOk) return;

  // Fase 2: autollenado de campos con el LLM local
  try {
    const ex = await llm.extractFields(text, { patient: rec.patient, date: rec.createdAt });
    rec.fields = ex.fields;
    rec.sources = ex.sources;
  } catch (err) {
    rec.fieldsError = String(err.message || err);
  }
  setStatus(rec, 'done', 'recording:filled');
}

function publicRec(r) {
  return {
    id: r.id, patient: r.patient, durationSec: r.durationSec,
    status: r.status, transcript: r.transcript, fields: r.fields || null,
    sources: r.sources || null,
    error: r.error, fieldsError: r.fieldsError || null,
    reviewed: !!r.reviewed, createdAt: r.createdAt, updatedAt: r.updatedAt || r.createdAt,
  };
}

// ── Lectura desde la web ──
app.get('/api/recordings', (_req, res) => {
  const list = [...recordings.values()].sort((a, b) => b.createdAt - a.createdAt).map(publicRec);
  res.json(list);
});
app.get('/api/recordings/:id', (req, res) => {
  const r = recordings.get(req.params.id);
  if (!r) return res.status(404).json({ error: 'no existe' });
  res.json(publicRec(r));
});
app.get('/api/recordings/:id/audio', (req, res) => {
  const r = recordings.get(req.params.id);
  if (!r) return res.sendStatus(404);
  res.sendFile(path.join(DATA_DIR, r.audioFile));
});

// ── Escritura: guardar revisión del médico ──
// El médico edita los campos en el visor y guarda. Guardamos sus ediciones como
// fuente de verdad y marcamos la consulta como revisada.
app.put('/api/recordings/:id/fields', (req, res) => {
  const r = recordings.get(req.params.id);
  if (!r) return res.status(404).json({ error: 'no existe' });
  const fields = req.body && req.body.fields;
  if (fields && typeof fields === 'object') r.fields = fields;
  if (req.body && req.body.patient && typeof req.body.patient === 'object') {
    r.patient = { name: String(req.body.patient.name || '').trim(), dni: String(req.body.patient.dni || '').trim() };
  }
  r.reviewed = true;
  r.reviewedAt = Date.now();
  setStatus(r, 'reviewed', 'recording:updated');
  res.json(publicRec(r));
});

// Reintentar todo el pipeline (re-transcribe el audio en disco).
app.post('/api/recordings/:id/retry', (req, res) => {
  const r = recordings.get(req.params.id);
  if (!r) return res.status(404).json({ error: 'no existe' });
  if (!r.audioFile || !fs.existsSync(path.join(DATA_DIR, r.audioFile))) {
    return res.status(409).json({ error: 'no hay audio para reprocesar' });
  }
  r.error = null; r.fieldsError = null; r.transcript = null; r.fields = null; r.sources = null; r.reviewed = false;
  res.json({ ok: true });
  processRecording(r).catch(() => {});
});

// Reintentar SOLO el autollenado (reusa la transcripción ya hecha, no re-transcribe).
app.post('/api/recordings/:id/reextract', async (req, res) => {
  const r = recordings.get(req.params.id);
  if (!r) return res.status(404).json({ error: 'no existe' });
  if (!r.transcript) return res.status(409).json({ error: 'no hay transcripción' });
  res.json({ ok: true });
  setStatus(r, 'filling', 'recording:filling');
  try {
    const ex = await llm.extractFields(r.transcript, { patient: r.patient, date: r.createdAt });
    r.fields = ex.fields;
    r.sources = ex.sources;
    r.fieldsError = null;
  } catch (err) {
    r.fieldsError = String(err.message || err);
  }
  setStatus(r, 'done', 'recording:filled');
});

// Descartar una grabación (Map + sidecar + audio).
app.delete('/api/recordings/:id', (req, res) => {
  const r = recordings.get(req.params.id);
  if (!r) return res.status(404).json({ error: 'no existe' });
  recordings.delete(r.id);
  try { fs.rmSync(metaPath(r.id), { force: true }); } catch { /* noop */ }
  if (r.audioFile) { try { fs.rmSync(path.join(DATA_DIR, r.audioFile), { force: true }); } catch { /* noop */ } }
  broadcast({ type: 'recording:deleted', id: r.id });
  res.json({ ok: true });
});

// ── Estáticos + páginas ──
app.use(express.static(STATIC_DIR, {
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
    else res.setHeader('Cache-Control', 'public, max-age=86400');
  },
}));
const sendPage = (file) => (_req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(STATIC_DIR, file));
};
app.get('/', (_req, res) => res.redirect('/web'));
app.get('/web', sendPage('web.html'));
app.get('/mobile', sendPage('mobile.html'));

// ── WebSocket (push de triggers a la web) ──
const server = createServer(app);
const wss = new WebSocketServer({ server });
const clients = new Set();

function broadcast(data) {
  const msg = JSON.stringify(data);
  for (const ws of clients) if (ws.readyState === 1) ws.send(msg);
}

wss.on('connection', (ws) => {
  clients.add(ws);
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('close', () => clients.delete(ws));
  ws.on('error', () => clients.delete(ws));
});

const ping = setInterval(() => {
  for (const ws of clients) {
    if (ws.isAlive === false) { ws.terminate(); clients.delete(ws); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch { /* noop */ }
  }
}, 30000);
wss.on('close', () => clearInterval(ping));

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
server.listen(PORT, HOST, () => {
  const whisperOk = checkEnv().length === 0;
  console.log(`\n  MedRecord AI — ${PROD ? 'producción' : 'desarrollo'} (sirviendo ${path.basename(STATIC_DIR)}/)`);
  console.log(`  Whisper: ${whisperOk ? 'OK' : 'NO configurado → ' + checkEnv().join(', ')}`);
  llm.available().then(ok => console.log(`  LLM: ${ok ? 'OK (' + llm.MODEL + ', Ollama local)' : 'no disponible (campos a mano)'}`));
  loadAll();
  console.log(`  Web:    http://localhost:${PORT}/web`);
  console.log(`  Móvil:  http://localhost:${PORT}/mobile`);
  if (LAN) console.log(`  LAN:    http://${LAN}:${PORT}/mobile   ← abrir en el celular (el micrófono necesita https)`);
  console.log();
});

function shutdown() {
  clearInterval(ping);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
