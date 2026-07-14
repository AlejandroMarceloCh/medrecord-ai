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
const { transcribe, checkEnv, MODEL: whisperModel } = require('./whisper');
const llm = require('./llm');
const enc = require('./crypto');
const auth = require('./auth');

// Error de arranque: el sistema se niega a hacer algo destructivo. No es un bug.
function bootError(msg) { const e = new Error(msg); e.code = 'MEDRECORD_BOOT'; return e; }

const APP_VERSION = require('./package.json').version;

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

// Persiste el sidecar. LANZA si no pudo escribir.
//
// Antes se tragaba el error: con el disco lleno o sin permisos, el PUT respondía 200 con la
// firma incluida, la UI decía "firmado", y al reiniciar loadAll() leía el sidecar viejo — la
// firma y las ediciones del médico desaparecían sin un solo aviso. Un guardado que falla
// tiene que fallar a la vista.
function persist(rec) {
  if (!recordings.has(rec.id)) return;
  const dest = metaPath(rec.id);
  try {
    enc.writeEncrypted(dest, JSON.stringify(rec));   // AES-256-GCM, atómico (temp+rename)
  } catch (err) {
    console.error('No se pudo persistir', shortId(rec.id), err.message);
    try { fs.unlinkSync(dest + '.tmp'); } catch {}
    const e = new Error('no se pudo guardar en disco');
    e.code = 'PERSIST_FAILED';
    throw e;
  }
}

// Para los caminos donde un fallo de escritura no debe tumbar el proceso (broadcasts de
// estado del pipeline): registra y sigue, pero deja marcado el registro.
function persistSoft(rec) {
  try { persist(rec); return true; }
  catch { rec.persistError = true; return false; }
}

// Procedencia: qué produjo esta historia. Sin esto, con firma inmutable, no hay forma de
// explicar por qué una consulta de marzo se ve distinta de una de mayo — y esa es la
// primera pregunta de cualquier auditoría.
function provenance() {
  return {
    whisper_model: path.basename(whisperModel || ''),
    llm_model: llm.MODEL,
    prompt_hash: llm.PROMPT_HASH,
    app_version: APP_VERSION,
  };
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
        persistSoft(rec);   // un fallo de disco no puede impedir que el server arranque
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
      // persistSoft, no persist: esto corre cada hora en segundo plano. Un throw aquí
      // tumbaría el servidor completo —matando el turno del médico— por un disco lleno.
      persistSoft(rec);
      auth.audit({ action: 'audio-purged', rec: rec.id });
      purged++;
    }
  }
  if (purged) console.log(`  ${purged} audio(s) borrados de forma segura por retención (${AUDIO_RETENTION_DAYS}d)`);
  return purged;
}

const app = express();
app.disable('x-powered-by');
// Detrás de un túnel (cloudflared) o un proxy, la petición llega por http pero el navegador
// la hizo por https. Sin esto, `req.protocol` dice 'http', el Origin comparado no coincide
// con el real, y la validación de CSRF bloquea el login legítimo: el deploy que el propio
// DEPLOY.md recomienda dejaría de funcionar sin que nadie entienda por qué.
app.set('trust proxy', true);
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

// ── CSRF: validación de Origin ───────────────────────────────────────────────
// La única defensa era `SameSite=Strict`, y "same-site" se calcula sobre el host
// registrable: IGNORA EL PUERTO. Cualquier otro servidor en la misma máquina (un Vite en
// :5173, otro proyecto en :8000) cuenta como same-site y su JavaScript podía firmar
// historias con la cookie del médico, o abrir un WebSocket y llevarse el stream de PII.
//
// Por eso el Origin se compara completo (esquema + host + puerto). Las peticiones sin
// Origin (curl, el propio móvil en algunos casos) se dejan pasar: no vienen de un
// navegador, así que no llevan la cookie de nadie por sorpresa.
const ORIGINS_OK = (process.env.MEDRECORD_ORIGINS || '')
  .split(',').map(o => o.trim()).filter(Boolean);

function origenPermitido(req) {
  const origin = req.headers.origin;
  if (!origin) return true;                       // no es una petición de navegador
  if (ORIGINS_OK.includes(origin)) return true;   // allowlist explícita (túnel, dominio propio)
  // Mismo origen que el host al que llegó la petición: es la app hablando consigo misma.
  const esperado = `${req.protocol}://${req.headers.host}`;
  return origin === esperado;
}

const MUTANTES = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
app.use('/api', (req, res, next) => {
  if (!MUTANTES.has(req.method)) return next();
  if (origenPermitido(req)) return next();
  auth.audit({ action: 'denied', what: 'csrf', user: req.identity?.id || null });
  res.status(403).json({ error: 'origen no permitido' });
});

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
  // Desbloquea la clave de firma del médico con su contraseña. Solo vive en esta sesión.
  const privada = auth.unlockPrivateKey(u, password);
  const token = auth.createSession(u.id, privada);
  res.setHeader('Set-Cookie', auth.sessionCookie(token, { secure: cookieSecure }));
  auth.audit({ action: 'login', user: u.id });
  res.json({ user: auth.publicUser(u) });
});

app.post('/api/logout', (req, res) => {
  const cookies = auth.parseCookies(req);
  auth.audit({ action: 'logout', user: req.identity?.id || null });
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

// Registro de auditoría (solo admin). `readAudit` existía desde el sprint 9 y NADIE podía
// llamarlo: un log que no se puede leer no es evidencia, es un archivo.
app.get('/api/audit', requireAdmin, (req, res) => {
  const limite = Math.min(Number(req.query.limit) || 200, 1000);
  const filas = auth.readAudit();
  res.json({
    integridad: auth.verifyAudit(),          // ¿alguien editó el log?
    total: filas.length,
    entradas: filas.slice(-limite),
  });
});
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
  try {
    persist(rec);
  } catch {
    // Sin sidecar la grabación no sobrevive a un reinicio: mejor rechazarla ahora, con el
    // médico delante, que dejar un fantasma que se evapora al reiniciar.
    recordings.delete(id);
    try { enc.secureDelete(path.join(DATA_DIR, audioFile)); } catch { /* noop */ }
    return res.status(500).json({ error: 'no se pudo guardar la consulta en disco' });
  }
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
  persistSoft(rec);
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
  rec.provenance = provenance();     // qué Whisper, qué LLM y qué prompt produjeron esto
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
    provenance: r.provenance || null,   // qué modelos y qué prompt produjeron esta historia
    createdAt: r.createdAt, updatedAt: r.updatedAt || r.createdAt,
  };
}

// Contenido canónico que firma el médico. La firma sella este snapshot exacto.
// Payload firmado, versión 2.
//
// La v1 sellaba solo id/patient/fields/transcript/reviewedAt/signedBy. Quedaban FUERA del
// sello justo las tres cosas que hay que probar en una auditoría:
//
//   consent    — la base legal de todo el procesamiento (Ley 29733). Sin ella en la firma,
//                cualquiera con acceso al sidecar podía poner granted:true y /verify seguía
//                diciendo que la historia era íntegra.
//   confirmed  — qué campos de IA atestó el médico. Es la prueba del human-in-the-loop.
//   fields_ia  — qué generó la máquina. Sin esto no se puede demostrar qué escribió el
//                médico y qué escribió el modelo, que es LA pregunta de una disputa.
//
// También entra la procedencia (qué Whisper, qué LLM, qué prompt), porque una historia
// firmada en marzo y otra en mayo pueden diferir solo porque cambió el prompt.
const SIG_VERSION = 2;

function signaturePayload(r, signedBy, version = SIG_VERSION) {
  if (version === 1) {
    // Las historias firmadas antes de este cambio se verifican con su esquema original.
    return JSON.stringify({
      id: r.id, patient: r.patient, fields: r.fields || null,
      transcript: r.transcript || null, reviewedAt: r.reviewedAt, signedBy: signedBy || null,
    });
  }
  return JSON.stringify({
    v: 2,
    id: r.id,
    patient: r.patient,
    fields: r.fields || null,
    fields_ia: r.fields_ia || null,
    confirmed: [...(r.confirmed || [])].sort(),   // orden estable: el mismo contenido, la misma firma
    consent: r.consent || null,
    transcript: r.transcript || null,
    provenance: r.provenance || null,
    createdAt: r.createdAt,
    reviewedAt: r.reviewedAt,
    signedBy: signedBy || null,
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
  if (!canSee(req.identity, r) && req.identity?.kind !== 'device') {
    auth.audit({ action: 'denied', what: 'read', user: req.identity?.id || null, rec: r.id });
  }
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
  const v = r.signature.v || 1;   // sin `v` es una firma vieja (esquema 1)
  const payload = signaturePayload(r, r.signature.signedBy, v);
  const expected = enc.hmac(payload, v);

  // Autoría: ¿la firmó de verdad ESE médico? El HMAC no lo prueba (el servidor conoce la
  // clave); la firma Ed25519 sí, porque su privada solo se descifra con su contraseña.
  let autoria = null;
  if (r.signature.sig && r.signature.signedBy) {
    const pub = auth.publicKeyOf(r.signature.signedBy);
    autoria = pub ? enc.verificarEd25519(payload, r.signature.sig, pub) : null;
  }

  auth.audit({ action: 'verify', user: req.identity?.id || null, rec: r.id });
  res.json({
    signed: true, valid: expected === r.signature.hash, v,
    autoriaVerificada: autoria,   // true = la firmó ese médico · null = firma sin autoría
    alg: r.signature.alg, signedAt: r.signature.signedAt, signedBy: r.signature.signedBy,
    // Qué cubre la firma: para una auditoría, saber qué NO está sellado importa tanto
    // como el hash. Una firma v1 no prueba el consentimiento ni la traza de la IA.
    cubre: v >= 2
      ? ['contenido', 'consentimiento', 'campos confirmados', 'salida de la IA', 'procedencia']
      : ['contenido'],
  });
});
app.get('/api/recordings/:id/audio', (req, res) => {
  const r = recordings.get(req.params.id);
  if (!r || !r.audioFile || !canSee(req.identity, r)) {
    if (r) auth.audit({ action: 'denied', what: 'audio', user: req.identity?.id || null, rec: r.id });
    return res.sendStatus(404);
  }
  auth.audit({ action: 'read-audio', user: req.identity?.id || null, rec: r.id });
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

  // Copia del estado antes de tocar nada: si el disco falla, hay que dejar la RAM como estaba.
  const previo = {
    fields: r.fields, confirmed: r.confirmed, patient: r.patient, reviewed: r.reviewed,
    reviewedAt: r.reviewedAt, signature: r.signature, version: r.version,
    updatedAt: r.updatedAt, status: r.status,
  };

  if (fields && typeof fields === 'object') r.fields = coerceFields(fields);
  if (confirmed) r.confirmed = confirmed;   // qué confirmó el médico (trazabilidad)
  if (req.body && req.body.patient && typeof req.body.patient === 'object') {
    r.patient = { name: String(req.body.patient.name || '').trim(), dni: String(req.body.patient.dni || '').trim() };
  }
  if (wantReview) {
    r.reviewed = true; r.reviewedAt = Date.now();
    // Firma de integridad: sella el contenido firmado (tamper-evidence verificable).
    // `v` queda dentro de la firma para que /verify sepa con qué esquema recomputar: las
    // historias firmadas con la v1 se siguen validando con la v1, no se invalidan solas.
    const signedBy = req.identity?.id || null;
    const payload = signaturePayload(r, signedBy, SIG_VERSION);
    r.signature = {
      alg: 'HMAC-SHA256', v: SIG_VERSION,
      hash: enc.hmac(payload, SIG_VERSION),          // integridad: ¿cambió el contenido?
      signedAt: r.reviewedAt, signedBy,
    };
    // Firma del médico con SU clave. El HMAC lo puede recalcular el servidor; esto no.
    // Es lo que permite sostener lo que promete TERMS.md: que el contenido es suyo.
    const privada = auth.sessionPrivateKey(auth.parseCookies(req)[auth.COOKIE]);
    if (privada) {
      r.signature.sig = enc.firmarEd25519(payload, privada);
      r.signature.sigAlg = 'Ed25519';
    }
  }
  r.version = (r.version || 0) + 1;            // avanza la versión en cada escritura
  r.updatedAt = Date.now();

  // El disco manda. Si la firma no llegó al sidecar, NO existe: responder 200 aquí dejaba
  // a la UI diciendo "firmado" con una firma que vivía solo en RAM, y al reiniciar el
  // servidor desaparecía junto con las ediciones del médico.
  try {
    persist(r);
  } catch (err) {
    Object.assign(r, previo);                  // deshacer el cambio en RAM
    console.error('PUT /fields no pudo persistir', shortId(r.id), err.message);
    return res.status(500).json({ error: 'no se pudo guardar en disco: no se firmó nada' });
  }

  auth.audit({
    action: wantReview ? 'sign' : 'edit', user: req.identity?.id || null, rec: r.id,
    version: r.version, hash: wantReview ? r.signature?.hash : undefined,
  });
  if (wantReview) r.status = 'reviewed';
  broadcastRec('recording:updated', r);
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
  // Reextraer DESTRUYE los campos y las confirmaciones: avanza la versión, o una web que
  // tenía el registro abierto pasa el optimistic lock y sobrescribe con datos que ya no existen.
  r.version = (r.version || 0) + 1;
  auth.audit({ action: 'reextract', user: req.identity?.id || null, rec: r.id, version: r.version });
  res.json({ ok: true });
  setStatus(r, 'filling', 'recording:filling');

  let ex = null, err = null;
  try {
    ex = await llm.extractFields(r.transcript, { patient: r.patient, date: r.createdAt });
  } catch (e) {
    err = String(e.message || e);
  }
  // Igual que el pipeline: el LLM tarda, y en ese lapso el médico pudo firmar o borrar.
  // Sin esta guarda, la salida cruda de la IA pisaba una historia ya firmada.
  if (!jobVigente(r)) return;
  if (ex) {
    r.fields = ex.fields;
    r.sources = ex.sources;
    r.fields_ia = deepCopy(ex.fields);   // nuevo snapshot de IA → reinicia confirmaciones
    r.confirmed = [];
    r.fieldsError = null;
    r.provenance = provenance();
  } else {
    r.fieldsError = err;
  }
  setStatus(r, 'done', 'recording:filled');
});

// Descartar una grabación (Map + sidecar + audio).
app.delete('/api/recordings/:id', (req, res) => {
  const r = recordings.get(req.params.id);
  if (!r || !canSee(req.identity, r)) return res.status(404).json({ error: 'no existe' });

  // Una historia FIRMADA no se borra. Tiene valor legal y el establecimiento es su custodio;
  // además el borrado aquí es seguro (sobrescribe antes de desenlazar), o sea irrecuperable.
  //
  // Y es peor que una alteración: una historia adulterada la detecta /verify, pero una
  // historia destruida no deja nada que verificar. Borrar un borrador sin firmar sí es
  // legítimo (el paciente retira el consentimiento, se grabó al paciente equivocado).
  if (r.reviewed) {
    auth.audit({ action: 'denied', what: 'delete-signed', user: req.identity?.id || null, rec: r.id });
    return res.status(409).json({
      error: 'una historia firmada no se puede borrar: tiene valor legal y el establecimiento es su custodio',
    });
  }

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
// maxPayload: el default de `ws` son 100 MiB por frame. Nadie nos manda nada por este
// canal (es push del servidor al cliente), así que 64 KB sobra y corta el DoS trivial.
const wss = new WebSocketServer({ server, maxPayload: 64 * 1024 });
const clients = new Set();
const MAX_WS_CLIENTS = Number(process.env.MEDRECORD_MAX_WS || 50);

// Identidad del WS desde el handshake: cookie de sesión (web) o ?token= (móvil).
// El navegador no puede mandar headers en el WS, por eso el móvil usa query param.
// El WS guarda el TOKEN de sesión, no la identidad ya resuelta: la identidad se recalcula
// en CADA envío. Antes se congelaba en el handshake, así que un socket abierto seguía
// recibiendo nombres, DNIs y transcripciones indefinidamente aunque el médico hubiera
// cerrado sesión o su sesión hubiera expirado. Quien capturara la cookie una vez conservaba
// el feed de PII para siempre.
function wsCredencial(req) {
  const cookies = auth.parseCookies(req);
  const sid = cookies[auth.COOKIE];
  if (sid && auth.getSessionUser(sid)) return { sid };
  try {
    const token = new URL(req.url, 'http://localhost').searchParams.get('token');
    if (REQUIRED_TOKEN && token === REQUIRED_TOKEN) return { device: true };
  } catch { /* noop */ }
  return null;
}

// Identidad VIGENTE de este socket, ahora mismo. Null si la sesión murió.
function wsIdentityAhora(ws) {
  if (ws.cred?.device) return { kind: 'device', id: 'device', role: 'device' };
  const u = ws.cred?.sid && auth.getSessionUser(ws.cred.sid);
  if (u) return { kind: 'user', id: u.id, role: u.role };
  return null;
}

// Broadcast de eventos de grabación: a cada cliente según su visibilidad.
// device → solo estado (sin PII); usuario que puede ver → publicRec completo; resto → nada.
function broadcastRec(type, rec) {
  for (const ws of clients) {
    if (ws.readyState !== 1) continue;
    const identity = wsIdentityAhora(ws);          // se recalcula: logout y expiración cortan
    if (authRequired() && !identity) {
      try { ws.close(1008, 'sesión terminada'); } catch { /* noop */ }
      continue;
    }
    if (identity && identity.kind === 'device') {
      ws.send(JSON.stringify({ type, recording: { id: rec.id, status: rec.status, error: rec.error || null, updatedAt: rec.updatedAt || rec.createdAt } }));
    } else if (canSee(identity, rec)) {
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
  // Origin: un WebSocket NO respeta SameSite, así que sin esto cualquier página abierta en
  // el navegador del médico podía conectarse y llevarse el stream completo de historias.
  const origin = req.headers.origin;
  if (origin && !ORIGINS_OK.includes(origin) && origin !== `http://${req.headers.host}` && origin !== `https://${req.headers.host}`) {
    try { ws.close(1008, 'origen no permitido'); } catch { /* noop */ }
    return;
  }
  ws.cred = wsCredencial(req);
  // Si la auth está activa y el handshake no trae credencial → cerrar (1008 policy).
  if (authRequired() && !wsIdentityAhora(ws)) { try { ws.close(1008, 'no autorizado'); } catch { /* noop */ } return; }
  if (clients.size >= MAX_WS_CLIENTS) { try { ws.close(1013, 'demasiadas conexiones'); } catch { /* noop */ } return; }
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
