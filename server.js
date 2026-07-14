// Los guardrails de arranque (clave maestra inválida, users.json indescifrable, todos
// los sidecars sin abrir) abortan lanzando. Sin esto el operador ve un stack trace de
// Node y lo lee como un crash, cuando en realidad es el sistema negándose a hacer algo
// destructivo. Se registra antes que nada para cubrir también los require() de abajo.
process.on('uncaughtException', (err) => {
  if (err && err.code === 'MEDRECORD_BOOT') {
    console.error('\n  MedRecord no arrancó:\n');
    console.error('  ' + err.message + '\n');
    process.exit(1);
  }
  throw err;   // un bug de verdad: que se vea el stack completo
});

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
const enc = require('./crypto');
const auth = require('./auth');

// Error de arranque: el sistema se niega a hacer algo destructivo. No es un bug.
function bootError(msg) { const e = new Error(msg); e.code = 'MEDRECORD_BOOT'; return e; }

// Para logs: nunca imprimas el id completo ni PII, solo un prefijo no identificable.
const shortId = (id) => String(id || '').slice(0, 8);

const PROD = process.env.NODE_ENV === 'production';
const distDir = path.join(__dirname, 'dist');
// Producción sirve dist/ (JSX precompilado); dev sirve public/ (Babel en navegador).
const STATIC_DIR = PROD && fs.existsSync(distDir) ? distDir : path.join(__dirname, 'public');

const DATA_DIR = process.env.MEDRECORD_DATA_DIR || path.join(__dirname, 'data', 'recordings');
fs.mkdirSync(DATA_DIR, { recursive: true });
auth.init(DATA_DIR);
auth.bootstrapAdmin();

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
  try {
    enc.writeEncrypted(dest, JSON.stringify(rec));   // AES-256-GCM, atómico (temp+rename)
  } catch (err) {
    console.error('No se pudo persistir', shortId(rec.id), err.message);
    try { fs.unlinkSync(dest + '.tmp'); } catch {}
  }
}

// Descifra el audio a un archivo temporal para pasarlo a ffmpeg/whisper y lo borra
// al terminar. Para grabaciones legacy (en claro) usa la ruta directa.
async function withAudioFile(rec, fn) {
  const stored = path.join(DATA_DIR, rec.audioFile);
  if (!rec.audioEnc) return fn(stored);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'medrec-audio-'));
  const tmpFile = path.join(tmpDir, 'audio');
  try {
    fs.writeFileSync(tmpFile, enc.readEncrypted(stored));
    return await fn(tmpFile);
  } finally {
    // El audio queda en claro en /tmp mientras Whisper lo procesa: sobrescribirlo antes
    // de borrarlo, o el contenido sigue siendo recuperable del disco.
    enc.secureDelete(tmpFile);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// Reconstruye el Map desde los sidecar JSON al arrancar y re-dispara las que
// quedaron a medias (received/processing/filling) cuando el server se cayó.
function loadAll() {
  let files = [];
  try { files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.json')); } catch { /* noop */ }
  let corrupt = 0;
  const failed = [];
  for (const f of files) {
    const fp = path.join(DATA_DIR, f);
    try {
      let json, wasEncrypted = true;
      try { json = enc.readEncrypted(fp).toString('utf8'); }
      catch { json = fs.readFileSync(fp, 'utf8'); wasEncrypted = false; }  // sidecar legacy en claro
      const rec = JSON.parse(json);
      if (rec && rec.id) {
        recordings.set(rec.id, rec);
        if (!wasEncrypted) { try { enc.writeEncrypted(fp, JSON.stringify(rec)); } catch { /* noop */ } } // migra a cifrado
      }
    } catch {
      // No se pudo descifrar ni parsear: ponlo en cuarentena en vez de perderlo en silencio.
      corrupt++;
      failed.push(fp);
    }
  }

  // Un sidecar suelto que no abre es corrupción. TODOS los sidecars sin abrir no es
  // corrupción: es la clave maestra equivocada. Poner en cuarentena la historia clínica
  // completa por un restore con la key errada sería catastrófico y silencioso — abortamos.
  if (files.length && corrupt === files.length) {
    throw bootError(
      `Ninguno de los ${files.length} sidecars de ${DATA_DIR} se pudo descifrar. ` +
      `La clave maestra no corresponde a estos datos (¿restore con la key equivocada?). ` +
      `NO se ponen en cuarentena: restaura la clave correcta (ver RESTORE.md).`
    );
  }
  for (const fp of failed) {
    try { fs.renameSync(fp, fp + '.corrupt'); } catch { /* noop */ }
    console.error('Sidecar corrupto movido a .corrupt:', shortId(path.basename(fp)));  // sin contenido
  }

  // Reanudar las que quedaron a medias. Van por la MISMA cola que las subidas en vivo:
  // es la única forma de que un crash con 10 pendientes no arranque 10 Whisper a la vez.
  const toResume = [];
  for (const rec of recordings.values()) {
    if (rec.status === 'received' || rec.status === 'processing' || rec.status === 'filling' || rec.status === 'queued') {
      if (rec.audioFile && fs.existsSync(path.join(DATA_DIR, rec.audioFile))) {
        rec.status = 'received';
        toResume.push(rec);
      } else {
        rec.status = 'error';
        rec.error = 'Se perdió el audio al reiniciar el servidor.';
        persist(rec);
      }
    }
  }
  for (const rec of toResume) enqueueProcess(rec);
  if (corrupt) console.log(`  ${corrupt} grabación(es) corrupta(s) puestas en cuarentena (.corrupt)`);
  if (recordings.size) console.log(`  Restauradas ${recordings.size} grabaciones desde disco`);
}

// Retención de audio: tras el período configurado, borra de forma SEGURA el audio de
// las consultas ya firmadas (la nota se conserva).
//
// La política se EXIGE explícitamente: no hay default. Un default silencioso borraría
// audio ya existente en el primer arranque tras actualizar el código —destruir datos de
// salud como efecto secundario de un `git pull` es inaceptable—, y un default de "nunca
// borrar" incumple la minimización (el audio de una consulta es dato sensible). Así que
// el operador decide y lo dice, y si no lo dice, se lo recordamos en cada arranque.
const RETENTION_SET = process.env.MEDRECORD_AUDIO_RETENTION_DAYS !== undefined;
const AUDIO_RETENTION_DAYS = RETENTION_SET
  ? Number(process.env.MEDRECORD_AUDIO_RETENTION_DAYS)
  : 0;
if (!RETENTION_SET) {
  console.warn('  Retención de audio SIN CONFIGURAR: el audio de las consultas se guarda indefinidamente.');
  console.warn('  Es dato de salud. Define MEDRECORD_AUDIO_RETENTION_DAYS=90 (o el plazo que decidas).');
}
function purgeExpiredAudio() {
  if (!AUDIO_RETENTION_DAYS) return 0;
  const cutoff = Date.now() - AUDIO_RETENTION_DAYS * 86400000;
  let purged = 0;
  for (const rec of recordings.values()) {
    if (rec.audioFile && !rec.audioDeleted && rec.reviewed && (rec.reviewedAt || rec.createdAt) < cutoff) {
      enc.secureDelete(path.join(DATA_DIR, rec.audioFile));
      rec.audioDeleted = true; rec.audioFile = null;
      persist(rec);
      auth.audit({ action: 'audio-purged', rec: rec.id });
      purged++;
    }
  }
  if (purged) console.log(`  ${purged} audio(s) borrados de forma segura por retención (${AUDIO_RETENTION_DAYS}d)`);
  return purged;
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

// ── Auth: identidad + sesiones ────────────────────────────────────────────────
// Identidad por sesión (cookie) o, legacy, por Bearer MEDRECORD_TOKEN (dispositivo
// de grabación). La autenticación se EXIGE si hay usuarios creados o token seteado;
// si no hay ninguno (dev), las rutas quedan abiertas para no romper el flujo local.
const REQUIRED_TOKEN = process.env.MEDRECORD_TOKEN || '';
const cookieSecure = PROD;

// Modo abierto (sin autenticación). Es OPT-IN EXPLÍCITO, nunca un default: antes, no
// configurar un admin dejaba /api y el WebSocket sirviendo historias completas a
// cualquiera que alcanzara el puerto — que es exactamente lo que pasa detrás de un túnel.
const OPEN_MODE = process.env.MEDRECORD_OPEN === '1';

// Resuelve req.identity en cada request a /api.
app.use('/api', (req, _res, next) => {
  const cookies = auth.parseCookies(req);
  const user = auth.getSessionUser(cookies[auth.COOKIE]);
  if (user) { req.identity = { kind: 'user', id: user.id, role: user.role, name: user.name }; return next(); }
  const hdr = req.headers['authorization'] || '';
  const [scheme, provided] = hdr.split(' ');
  if (REQUIRED_TOKEN && scheme === 'Bearer' && provided === REQUIRED_TOKEN) {
    req.identity = { kind: 'device', id: 'device', role: 'device' };
  } else {
    req.identity = null;
  }
  next();
});

// Throttle de login: limita intentos fallidos por usuario. Cada intento gasta CPU
// (scrypt), así que sin freno es un mini-DoS. Tras MAX_FAILS, bloquea LOCK_MS.
const loginFails = new Map();   // username → { fails, lockUntil }
const LOGIN_MAX_FAILS = Number(process.env.LOGIN_MAX_FAILS || 5);
const LOGIN_LOCK_MS = Number(process.env.LOGIN_LOCK_MS || 60000);

// Login: valida credenciales y entrega cookie de sesión. No requiere auth previa.
app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const key = String(username || '').trim().toLowerCase();
  const fr = loginFails.get(key);
  if (fr && fr.lockUntil > Date.now()) {
    return res.status(429).json({ error: 'demasiados intentos, espera un momento' });
  }
  const u = auth.authenticate(username, password);
  if (!u) {
    const fails = (fr && fr.fails || 0) + 1;
    loginFails.set(key, { fails, lockUntil: fails >= LOGIN_MAX_FAILS ? Date.now() + LOGIN_LOCK_MS : 0 });
    auth.audit({ action: 'login-fail', user: shortId(key) });
    return res.status(401).json({ error: 'credenciales inválidas' });
  }
  loginFails.delete(key);   // reset al autenticar bien
  const token = auth.createSession(u.id);
  res.setHeader('Set-Cookie', auth.sessionCookie(token, { secure: cookieSecure }));
  auth.audit({ action: 'login', user: u.id });
  res.json({ user: auth.publicUser(u) });
});

app.post('/api/logout', (req, res) => {
  const cookies = auth.parseCookies(req);
  auth.destroySession(cookies[auth.COOKIE]);
  res.setHeader('Set-Cookie', auth.clearCookie());
  res.json({ ok: true });
});

const authRequired = () => auth.countUsers() > 0 || !!REQUIRED_TOKEN;

// Fail-closed: sin usuarios, sin token y sin opt-in explícito, el server NO sirve.
// Antes arrancaba abierto y `npm start` + túnel (el deploy que documentábamos) dejaba
// todas las historias accesibles sin una sola credencial.
if (!authRequired() && !OPEN_MODE) {
  console.error('\n  MedRecord no puede arrancar sin autenticación.\n');
  console.error('  No hay usuarios creados ni MEDRECORD_TOKEN configurado. Arrancar así');
  console.error('  dejaría las historias clínicas accesibles sin credenciales.\n');
  console.error('  Crea el admin inicial:');
  console.error('    MEDRECORD_ADMIN_USER=... MEDRECORD_ADMIN_PASS=... npm start\n');
  console.error('  O, solo para desarrollo local, acepta el riesgo explícitamente:');
  console.error('    MEDRECORD_OPEN=1 npm run dev\n');
  process.exit(1);
}

app.get('/api/whoami', (req, res) => {
  if (req.identity && req.identity.kind === 'user') {
    return res.json({ user: { id: req.identity.id, name: req.identity.name, role: req.identity.role }, required: authRequired() });
  }
  res.json({ user: null, device: req.identity?.kind === 'device', required: authRequired() });
});

// Gate: si hay usuarios o token configurado, exige identidad para el resto de /api.
const OPEN_PATHS = new Set(['/login', '/logout', '/whoami']);
app.use('/api', (req, res, next) => {
  if (OPEN_PATHS.has(req.path)) return next();
  if (req.identity) return next();
  if (!authRequired() && OPEN_MODE) return next();   // dev con opt-in explícito
  res.status(401).json({ error: 'no autorizado' });
});

// Gestión de usuarios (solo admin). El primer admin se crea por env (bootstrapAdmin).
function requireAdmin(req, res, next) {
  if (req.identity && req.identity.role === 'admin') return next();
  res.status(403).json({ error: 'solo admin' });
}
app.get('/api/users', requireAdmin, (_req, res) => res.json(auth.listUsers()));
app.post('/api/users', requireAdmin, (req, res) => {
  try {
    const u = auth.createUser(req.body || {});
    auth.audit({ action: 'user-create', user: req.identity.id, target: u.id });
    res.json(u);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ── Subida de audio desde el móvil ──
// memoryStorage: el audio entra a RAM y se cifra antes de tocar el disco; nunca
// queda en claro en data/. Para audios grandes esto usa memoria proporcional al
// tamaño (límite 100 MB), aceptable para una consulta a la vez.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });

app.post('/api/recordings', upload.single('audio'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'falta el audio' });
  // Consentimiento del paciente (Ley 29733 art. 13.6: escrito para datos sensibles).
  // Sin consentimiento registrado NO se procesa la grabación.
  const consent = req.body.consent === 'true' || req.body.consent === true;
  if (!consent) return res.status(400).json({ error: 'falta el consentimiento del paciente' });
  const id = crypto.randomUUID();
  const audioFile = id + '.audio';
  try {
    enc.writeEncrypted(path.join(DATA_DIR, audioFile), req.file.buffer);   // cifrado en reposo
  } catch (err) {
    console.error('No se pudo guardar el audio', shortId(id), err.message);
    return res.status(500).json({ error: 'no se pudo guardar el audio' });
  }
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
    audioFile,
    audioMime: req.file.mimetype || 'audio/webm',
    audioEnc: true,
    consent: { granted: true, at: Date.now() },   // consentimiento registrado por grabación
    ownerId: req.identity && req.identity.kind === 'user' ? req.identity.id : null,
    version: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  recordings.set(id, rec);
  persist(rec);
  auth.audit({ action: 'create', user: req.identity?.id || null, rec: id });
  res.json({ id, status: rec.status });

  broadcastRec('recording:received', rec);
  enqueueProcess(rec);   // la cola serializa: nunca dos Whisper a la vez
});

// ── Cola del pipeline (concurrencia 1) ──────────────────────────────────────────
// Whisper carga un modelo de ~3 GB POR PROCESO y corre con todos los cores; Ollama
// mantiene otros ~4.7 GB residentes. Dos transcripciones a la vez en una Mac de 16 GB
// mandan la máquina a swap y cada job se vuelve 3-5x más lento — y con el timeout
// corriendo, se matan entre sí en cascada. En emergencia llegan 5 audios en 3 minutos.
//
// loadAll() ya serializaba el resume tras un crash ("el resto del pipeline asume una a
// la vez"), pero el camino en vivo no lo hacía. Ahora todo pasa por esta cola.
const jobQueue = [];        // ids en espera, en orden de llegada
let jobRunning = null;      // id del que está corriendo, o null

// La posición en la cola es lo que el médico necesita ver: "vas 3 de 5".
function refreshQueuePositions() {
  jobQueue.forEach((id, i) => {
    const rec = recordings.get(id);
    if (!rec) return;
    const pos = i + 1;
    if (rec.queuePos !== pos) {
      rec.queuePos = pos;
      broadcastRec('recording:queued', rec);
    }
  });
}

function enqueueProcess(rec) {
  if (!recordings.has(rec.id)) return;
  if (jobRunning === rec.id || jobQueue.includes(rec.id)) return;   // ya está en vuelo
  jobQueue.push(rec.id);
  if (jobRunning) {
    rec.queuePos = jobQueue.length;
    setStatus(rec, 'queued', 'recording:queued');
  }
  runNextJob();
}

async function runNextJob() {
  if (jobRunning) return;
  const id = jobQueue.shift();
  if (!id) return;
  const rec = recordings.get(id);       // pudo borrarse mientras esperaba
  if (!rec) return runNextJob();
  jobRunning = id;
  rec.queuePos = 0;
  refreshQueuePositions();
  try {
    await processRecording(rec);
  } catch (err) {
    console.error('proc error', shortId(id), err.message);
  } finally {
    jobRunning = null;
    runNextJob();
  }
}

// Mínimo de caracteres para considerar una transcripción válida (filtra silencio/ruido).
const MIN_TRANSCRIPT = 10;

function setStatus(rec, status, evt) {
  // No emitas ni persistas estados de una grabación ya descartada (proceso en vuelo + DELETE).
  if (!recordings.has(rec.id)) return;
  rec.status = status;
  rec.updatedAt = Date.now();
  persist(rec);
  broadcastRec(evt || ('recording:' + status), rec);
}

// Corre Whisper, luego (si hay LLM local) autollena campos. Dispara eventos a la web.
// ¿Sigue siendo legítimo escribir sobre este registro? Se pregunta DESPUÉS de cada await:
// entre que el job entró a la cola y aterriza pueden pasar minutos, y en ese lapso el
// médico pudo borrar la grabación o firmar la historia. Pisar una historia firmada deja la
// firma HMAC inválida sobre un contenido que el médico nunca vio — /verify la reporta como
// adulterada. La cola de este sprint alargó esa ventana de milisegundos a minutos.
function jobVigente(rec) {
  if (recordings.get(rec.id) !== rec) return false;   // borrada (o reemplazada) mientras esperaba
  if (rec.reviewed) return false;                     // firmada mientras esperaba: es inmutable
  return true;
}

async function processRecording(rec) {
  if (!jobVigente(rec)) return;
  setStatus(rec, 'processing', 'recording:processing');
  let text;
  try {
    // El timeout lo decide whisper.js midiendo el WAV; el durationSec del cliente no influye.
    ({ text } = await withAudioFile(rec, (p) => transcribe(p)));
  } catch (err) {
    if (!jobVigente(rec)) return;
    rec.error = String(err.message || err);
    setStatus(rec, 'error', 'recording:error');
    return;
  }
  if (!jobVigente(rec)) return;      // se firmó/borró mientras Whisper corría
  rec.transcript = text;

  // Audio sin voz: Whisper puede devolver vacío. No es éxito — pedir regrabar.
  if (!text || text.trim().length < MIN_TRANSCRIPT) {
    rec.error = 'No se detectó voz en el audio. Vuelve a grabar más cerca del micrófono.';
    setStatus(rec, 'error', 'recording:error');
    return;
  }

  // Fase 1: transcripción lista (la web ya puede mostrarla).
  // Sin gate available() (un probe lento daba 'done' falso sin campos ni ruta de
  // reintento). Intentamos el autollenado directo; si el LLM no está, falla rápido
  // (conexión rechazada) y queda fieldsError con su botón de Reintentar en la UI.
  rec.fieldsError = null;
  setStatus(rec, 'filling', 'recording:transcribed');

  // Fase 2: autollenado de campos con el LLM local
  let ex = null, fieldsErr = null;
  try {
    ex = await llm.extractFields(text, { patient: rec.patient, date: rec.createdAt });
  } catch (err) {
    fieldsErr = String(err.message || err);
  }
  if (!jobVigente(rec)) return;      // se firmó/borró mientras el LLM corría
  if (ex) {
    rec.fields = ex.fields;
    rec.sources = ex.sources;
    rec.fields_ia = deepCopy(ex.fields);   // snapshot intacto de lo que generó la IA (trazabilidad)
    rec.confirmed = [];
  } else {
    rec.fieldsError = fieldsErr;
  }
  setStatus(rec, 'done', 'recording:filled');
}

function deepCopy(o) { try { return JSON.parse(JSON.stringify(o)); } catch { return null; } }

// Aplana { seccion: { campo: valor } } → { "seccion.campo": valor }.
function flattenFields(f) {
  const out = {};
  if (!f || typeof f !== 'object') return out;
  for (const sec of Object.keys(f)) {
    const s = f[sec];
    if (!s || typeof s !== 'object') continue;
    for (const k of Object.keys(s)) out[sec + '.' + k] = s[k];
  }
  return out;
}

// Claves de campos que la IA pobló (no vacíos). Son los que el médico debe confirmar.
function aiPopulatedKeys(fieldsIa) {
  return Object.entries(flattenFields(fieldsIa))
    .filter(([, v]) => String(v == null ? '' : v).trim())
    .map(([k]) => k);
}

function publicRec(r) {
  return {
    id: r.id, patient: r.patient, durationSec: r.durationSec,
    status: r.status, transcript: r.transcript, fields: r.fields || null,
    sources: r.sources || null,
    fields_ia: r.fields_ia || null, confirmed: r.confirmed || null,
    error: r.error, fieldsError: r.fieldsError || null,
    reviewed: !!r.reviewed, reviewedAt: r.reviewedAt || null,
    signature: r.signature || null, consent: r.consent || null, audioDeleted: !!r.audioDeleted,
    ownerId: r.ownerId || null, version: r.version || 0,
    queuePos: r.queuePos || 0,   // "vas 3 de 5" mientras espera su turno de Whisper
    createdAt: r.createdAt, updatedAt: r.updatedAt || r.createdAt,
  };
}

// Contenido canónico que firma el médico. La firma sella este snapshot exacto.
function signaturePayload(r, signedBy) {
  return JSON.stringify({
    id: r.id, patient: r.patient, fields: r.fields || null,
    transcript: r.transcript || null, reviewedAt: r.reviewedAt, signedBy: signedBy || null,
  });
}

// Fuerza los campos al esquema canónico (descarta claves fuera de esquema).
// Garantiza que una historia firmada no quede con claves basura inyectadas.
function coerceFields(fields) {
  const base = llm.emptyFields();
  const out = llm.emptyFields();
  if (!fields || typeof fields !== 'object') return out;
  for (const sec of Object.keys(base)) {
    const src = fields[sec] || {};
    for (const k of Object.keys(base[sec])) {
      const v = src[k];
      out[sec][k] = (v == null) ? '' : String(v).trim();
    }
  }
  return out;
}

// ¿Esta identidad puede LEER este registro? Aislamiento por dueño.
// El device (token de subida del móvil) es SOLO ESCRITURA: no lee historias.
function canSee(identity, rec) {
  if (!identity) return OPEN_MODE;            // sin identidad solo se lee en modo abierto
  if (identity.kind === 'device') return false;
  if (identity.role === 'admin') return true;
  return rec.ownerId === identity.id;
}

// ── Lectura desde la web ──
app.get('/api/recordings', (req, res) => {
  const list = [...recordings.values()]
    .filter(r => canSee(req.identity, r))
    .sort((a, b) => b.createdAt - a.createdAt).map(publicRec);
  res.json(list);
});
app.get('/api/recordings/:id', (req, res) => {
  const r = recordings.get(req.params.id);
  if (!r) return res.status(404).json({ error: 'no existe' });
  // El device (móvil) puede consultar SOLO el estado de lo que sube, sin PII.
  if (req.identity && req.identity.kind === 'device') {
    return res.json({ id: r.id, status: r.status, error: r.error || null });
  }
  if (!canSee(req.identity, r)) return res.status(404).json({ error: 'no existe' });
  res.json(publicRec(r));
});
// Verifica la firma de integridad: recomputa el HMAC del contenido y lo compara.
app.get('/api/recordings/:id/verify', (req, res) => {
  const r = recordings.get(req.params.id);
  if (!r || !canSee(req.identity, r)) return res.status(404).json({ error: 'no existe' });
  if (!r.signature) return res.json({ signed: false, valid: false });
  const expected = enc.hmac(signaturePayload(r, r.signature.signedBy));
  res.json({
    signed: true, valid: expected === r.signature.hash,
    alg: r.signature.alg, signedAt: r.signature.signedAt, signedBy: r.signature.signedBy,
  });
});
app.get('/api/recordings/:id/audio', (req, res) => {
  const r = recordings.get(req.params.id);
  if (!r || !r.audioFile || !canSee(req.identity, r)) return res.sendStatus(404);
  const fp = path.join(DATA_DIR, r.audioFile);
  if (!r.audioEnc) return res.sendFile(fp);   // legacy en claro
  try {
    res.setHeader('Content-Type', r.audioMime || 'audio/webm');
    res.send(enc.readEncrypted(fp));
  } catch (err) {
    console.error('No se pudo leer el audio', shortId(r.id), err.message);
    res.sendStatus(404);
  }
});

// ── Escritura: guardar revisión del médico ──
// El médico edita los campos en el visor y guarda. Guardamos sus ediciones como
// fuente de verdad y marcamos la consulta como revisada.
app.put('/api/recordings/:id/fields', (req, res) => {
  const r = recordings.get(req.params.id);
  if (!r || !canSee(req.identity, r)) return res.status(404).json({ error: 'no existe' });
  // Una historia firmada es inmutable: no se edita más (la firma quedaría desincronizada).
  if (r.reviewed) return res.status(409).json({ error: 'la consulta ya está firmada' });
  const fields = req.body && req.body.fields;
  const wantReview = !!(req.body && req.body.reviewed);
  const confirmed = Array.isArray(req.body && req.body.confirmed) ? req.body.confirmed : null;

  // Optimistic locking: si el cliente manda version, debe coincidir con la actual.
  // Evita que dos ediciones concurrentes se pisen (la segunda recibe 409).
  if (typeof (req.body && req.body.version) === 'number' && req.body.version !== (r.version || 0)) {
    return res.status(409).json({ error: 'conflicto de versión', currentVersion: r.version || 0 });
  }

  // Human-in-the-loop: no se puede FIRMAR si algún campo poblado por la IA no fue
  // confirmado por el médico. Guardar borrador (sin reviewed) no exige confirmación.
  if (wantReview && r.fields_ia) {
    const need = aiPopulatedKeys(r.fields_ia);
    const ok = new Set(confirmed || []);
    const pending = need.filter(k => !ok.has(k));
    if (pending.length) {
      return res.status(409).json({ error: 'campos de IA sin confirmar', pending });
    }
  }

  // Una historia firmada tiene valor legal: no puede estar VACÍA. El gate de arriba solo
  // corre si hubo IA (`fields_ia`); cuando Whisper falla no hay IA, así que sin este
  // segundo gate se podía firmar un cascarón sin transcripción y sin un solo campo.
  // Llenar a mano tras un fallo de Whisper es legítimo — firmar la nada, no.
  if (wantReview) {
    const propuestos = (fields && typeof fields === 'object') ? coerceFields(fields) : r.fields;
    const hayContenido = propuestos && Object.values(propuestos)
      .some(sec => sec && Object.values(sec).some(v => String(v || '').trim()));
    if (!hayContenido) {
      return res.status(400).json({ error: 'no se puede firmar una historia vacía: escribe al menos un campo' });
    }
  }

  if (fields && typeof fields === 'object') r.fields = coerceFields(fields);
  if (confirmed) r.confirmed = confirmed;   // qué confirmó el médico (trazabilidad)
  if (req.body && req.body.patient && typeof req.body.patient === 'object') {
    r.patient = { name: String(req.body.patient.name || '').trim(), dni: String(req.body.patient.dni || '').trim() };
  }
  if (wantReview) {
    r.reviewed = true; r.reviewedAt = Date.now();
    // Firma de integridad: sella el contenido firmado (tamper-evidence verificable).
    const signedBy = req.identity?.id || null;
    r.signature = { alg: 'HMAC-SHA256', hash: enc.hmac(signaturePayload(r, signedBy)), signedAt: r.reviewedAt, signedBy };
  }
  r.version = (r.version || 0) + 1;            // avanza la versión en cada escritura
  r.updatedAt = Date.now();
  auth.audit({ action: wantReview ? 'sign' : 'edit', user: req.identity?.id || null, rec: r.id, version: r.version });
  setStatus(r, wantReview ? 'reviewed' : r.status, 'recording:updated');
  res.json(publicRec(r));
});

// Reintentar todo el pipeline (re-transcribe el audio en disco).
app.post('/api/recordings/:id/retry', (req, res) => {
  const r = recordings.get(req.params.id);
  if (!r || !canSee(req.identity, r)) return res.status(404).json({ error: 'no existe' });
  // Una historia ya firmada es inmutable: no se puede reprocesar (destruiría la firma).
  if (r.reviewed) return res.status(409).json({ error: 'la consulta ya está firmada' });
  if (!r.audioFile || !fs.existsSync(path.join(DATA_DIR, r.audioFile))) {
    return res.status(409).json({ error: 'no hay audio para reprocesar' });
  }
  r.error = null; r.fieldsError = null; r.transcript = null; r.fields = null; r.sources = null; r.fields_ia = null; r.confirmed = []; r.reviewed = false;
  // El retry DESTRUYE contenido (transcripción y campos). Si no avanza la versión, una web
  // que tenía el registro abierto sigue creyendo que va en la versión vieja, pasa el
  // optimistic lock y sobrescribe con datos que ya no existen. Lost update sin ningún 409.
  r.version = (r.version || 0) + 1;
  res.json({ ok: true });
  enqueueProcess(r);   // el reintento también compite por el único slot de Whisper
});

// Reintentar SOLO el autollenado (reusa la transcripción ya hecha, no re-transcribe).
app.post('/api/recordings/:id/reextract', async (req, res) => {
  const r = recordings.get(req.params.id);
  if (!r || !canSee(req.identity, r)) return res.status(404).json({ error: 'no existe' });
  if (r.reviewed) return res.status(409).json({ error: 'la consulta ya está firmada' });
  if (!r.transcript) return res.status(409).json({ error: 'no hay transcripción' });
  res.json({ ok: true });
  setStatus(r, 'filling', 'recording:filling');
  try {
    const ex = await llm.extractFields(r.transcript, { patient: r.patient, date: r.createdAt });
    r.fields = ex.fields;
    r.sources = ex.sources;
    r.fields_ia = deepCopy(ex.fields);   // nuevo snapshot de IA → reinicia confirmaciones
    r.confirmed = [];
    r.fieldsError = null;
  } catch (err) {
    r.fieldsError = String(err.message || err);
  }
  setStatus(r, 'done', 'recording:filled');
});

// Descartar una grabación (Map + sidecar + audio).
app.delete('/api/recordings/:id', (req, res) => {
  const r = recordings.get(req.params.id);
  if (!r || !canSee(req.identity, r)) return res.status(404).json({ error: 'no existe' });
  recordings.delete(r.id);
  // Borrado SEGURO (sobrescribe antes de desenlazar), igual que la purga por retención:
  // este es el camino por el que el paciente ejerce su derecho de supresión. Un rmSync
  // deja el ciphertext recuperable del disco, y la clave está en la misma máquina.
  enc.secureDelete(metaPath(r.id));
  try { fs.rmSync(metaPath(r.id) + '.tmp', { force: true }); } catch { /* noop */ }
  if (r.audioFile) enc.secureDelete(path.join(DATA_DIR, r.audioFile));
  auth.audit({ action: 'delete', user: req.identity?.id || null, rec: r.id });
  broadcastRaw({ type: 'recording:deleted', id: r.id });   // solo id, sin PII
  res.json({ ok: true });
});

// ── Estáticos + páginas ──
// El service worker se sirve SIN cache: si el navegador se queda con una copia vieja de
// sw.js, la app puede quedar congelada en una versión antigua durante días. Y va desde la
// raíz porque un SW solo controla su propio directorio hacia abajo.
app.get('/sw.js', (_req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.sendFile(path.join(STATIC_DIR, 'sw.js'));
});
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

// Identidad del WS desde el handshake: cookie de sesión (web) o ?token= (móvil).
// El navegador no puede mandar headers en el WS, por eso el móvil usa query param.
function wsIdentity(req) {
  const cookies = auth.parseCookies(req);
  const user = auth.getSessionUser(cookies[auth.COOKIE]);
  if (user) return { kind: 'user', id: user.id, role: user.role };
  try {
    const token = new URL(req.url, 'http://localhost').searchParams.get('token');
    if (REQUIRED_TOKEN && token === REQUIRED_TOKEN) return { kind: 'device', id: 'device', role: 'device' };
  } catch { /* noop */ }
  return null;
}

// Broadcast de eventos de grabación: a cada cliente según su visibilidad.
// device → solo estado (sin PII); usuario que puede ver → publicRec completo; resto → nada.
function broadcastRec(type, rec) {
  for (const ws of clients) {
    if (ws.readyState !== 1) continue;
    if (ws.identity && ws.identity.kind === 'device') {
      ws.send(JSON.stringify({ type, recording: { id: rec.id, status: rec.status, error: rec.error || null, updatedAt: rec.updatedAt || rec.createdAt } }));
    } else if (canSee(ws.identity, rec)) {
      ws.send(JSON.stringify({ type, recording: publicRec(rec) }));
    }
  }
}

// Mensajes sin PII (solo id): se pueden mandar a todos los clientes conectados.
function broadcastRaw(data) {
  const msg = JSON.stringify(data);
  for (const ws of clients) if (ws.readyState === 1) ws.send(msg);
}

wss.on('connection', (ws, req) => {
  ws.identity = wsIdentity(req);
  // Si la auth está activa y el handshake no trae identidad → cerrar (1008 policy).
  if (authRequired() && !ws.identity) { try { ws.close(1008, 'no autorizado'); } catch { /* noop */ } return; }
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
  purgeExpiredAudio();                                   // al arrancar
  setInterval(purgeExpiredAudio, 60 * 60 * 1000).unref(); // y cada hora
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
