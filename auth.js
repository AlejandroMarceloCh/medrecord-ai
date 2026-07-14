// auth.js — usuarios, sesiones y audit log. Sin dependencias externas (stdlib).
//
// - Usuarios: archivo cifrado (data/users.json) vía crypto.js. Password con scrypt.
// - Sesiones: en memoria (token → userId + expiración). Se pierden al reiniciar
//   (el médico vuelve a entrar); aceptable para un piloto. Cookie HttpOnly.
// - Audit log: JSONL en data/audit.log. Solo ids + acción + timestamp: SIN PII,
//   por eso va en claro y es legible para auditoría/compliance.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const enc = require('./crypto');

// Error de arranque: el sistema se niega a hacer algo destructivo. No es un bug.
function bootError(msg) { const e = new Error(msg); e.code = 'MEDRECORD_BOOT'; return e; }

const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS || 12 * 60 * 60 * 1000); // 12 h
const COOKIE = 'medrecord.sid';

let DATA_DIR = null;
let usersFile = null;
let auditFile = null;
const users = new Map();             // id → user
const sessions = new Map();          // token → { userId, exp }

function init(dataDir) {
  DATA_DIR = dataDir;
  usersFile = path.join(dataDir, 'users.json');
  auditFile = path.join(dataDir, 'audit.log');
  fs.mkdirSync(dataDir, { recursive: true });
  loadUsers();
}

// "No hay archivo" y "no puedo descifrarlo" son cosas distintas. Confundirlas hace que
// una clave rotada o un disco con errores arranquen el server con CERO usuarios, lo que
// desactivaría la autenticación en silencio. Si el archivo existe y no abre, abortamos.
function loadUsers() {
  users.clear();
  let raw = null;
  try {
    raw = fs.readFileSync(usersFile);
  } catch (err) {
    if (err.code === 'ENOENT') return;     // primer arranque: aún no hay usuarios
    throw bootError(`No se pudo leer ${usersFile}: ${err.message}`);
  }
  // Archivo vacío = todavía no hay usuarios (un tar interrumpido, un touch). No es
  // corrupción: tratarlo como tal dejaría el server caído sin necesidad.
  if (raw.length === 0) return;
  let json;
  try {
    json = enc.decryptBuffer(raw).toString('utf8');
  } catch (err) {
    throw bootError(
      `No se pudo descifrar ${usersFile} (${err.message}). ` +
      `La clave maestra no corresponde a estos datos, o el archivo está dañado. ` +
      `Arrancar así desactivaría la autenticación: abortando.`
    );
  }
  for (const u of JSON.parse(json)) users.set(u.id, u);
}

function saveUsers() {
  try { enc.writeEncrypted(usersFile, JSON.stringify([...users.values()])); }
  catch (e) { console.error('No se pudo guardar usuarios', e.message); }
}

// ── Password (scrypt, stdlib) ──
function hashPassword(password, salt) {
  salt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return { salt, hash };
}
function verifyPassword(password, salt, hash) {
  const h = crypto.scryptSync(String(password), salt, 64).toString('hex');
  const a = Buffer.from(h), b = Buffer.from(hash);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ── Usuarios ──
function createUser({ username, password, name, role }) {
  username = String(username || '').trim().toLowerCase();
  if (!username || !password) throw new Error('faltan usuario o contraseña');
  if ([...users.values()].some(u => u.username === username)) throw new Error('el usuario ya existe');
  const { salt, hash } = hashPassword(password);
  // Par de claves del médico. La privada NO se guarda en claro: se cifra con una clave
  // derivada de su contraseña, así que el servidor no puede firmar por él sin que él entre.
  // Eso es lo que convierte la firma en no-repudio: un admin no puede suplantarlo.
  const par = enc.generarParDeClaves();
  const keySalt = crypto.randomBytes(16).toString('hex');
  const user = {
    id: crypto.randomUUID(), username, salt, hash,
    name: String(name || username), role: role === 'admin' ? 'admin' : 'medico',
    publicKey: par.publicKey,
    privateKeyEnc: enc.cifrarConPassword(par.privateKey, password, keySalt),
    keySalt,
    createdAt: Date.now(),
  };
  users.set(user.id, user);
  saveUsers();
  return publicUser(user);
}

function publicUser(u) { return u && { id: u.id, username: u.username, name: u.name, role: u.role }; }
function listUsers() { return [...users.values()].map(publicUser); }
function countUsers() { return users.size; }

// Salt y hash señuelo: cuando el usuario NO existe corremos scrypt igual, contra esto.
// Sin ello, "usuario inexistente" respondía en ~0 ms y "usuario válido, clave mala" gastaba
// los ~50 ms del scrypt: la diferencia es trivial de medir y permite enumerar quién trabaja
// en la clínica.
const SENUELO = hashPassword(crypto.randomBytes(32).toString('hex'));

function authenticate(username, password) {
  username = String(username || '').trim().toLowerCase();
  const u = [...users.values()].find(x => x.username === username);
  if (!u) {
    verifyPassword(password, SENUELO.salt, SENUELO.hash);   // gasta el mismo tiempo
    return null;
  }
  if (!verifyPassword(password, u.salt, u.hash)) return null;
  return u;
}

// Contraseñas que aparecen en la documentación del repo: si alguien las usa de verdad,
// la credencial es pública. Rechazarlas es más útil que confiar en que se acuerde.
const PLACEHOLDER_PASSWORDS = new Set([
  'cambia-esta-clave',
  'una-clave-larga-que-elijas-tu',
  'una-clave-larga-de-verdad',
]);

// Crea admin inicial desde variables de entorno si no hay ningún usuario.
function bootstrapAdmin() {
  if (users.size > 0) return;
  const u = process.env.MEDRECORD_ADMIN_USER, p = process.env.MEDRECORD_ADMIN_PASS;
  if (!u || !p) return;
  if (PLACEHOLDER_PASSWORDS.has(p)) {
    throw bootError(
      `MEDRECORD_ADMIN_PASS es la contraseña de ejemplo de la documentación, o sea que es pública. ` +
      `Elige una clave propia antes de arrancar.`
    );
  }
  createUser({ username: u, password: p, name: 'Administrador', role: 'admin' });
  console.log(`  Auth: usuario admin "${u}" creado desde variables de entorno`);
}

// ── Sesiones ──
function createSession(userId, privateKey = null) {
  const token = crypto.randomBytes(32).toString('hex');
  // La clave privada vive en RAM mientras dure la sesión. Al cerrar sesión (o al reiniciar
  // el servidor) desaparece: nadie puede firmar en nombre del médico si él no está.
  sessions.set(token, { userId, privateKey, exp: Date.now() + SESSION_TTL_MS });
  return token;
}

// Clave privada del médico de esta sesión, para firmar. Null si no la tiene.
function sessionPrivateKey(token) {
  const s = token && sessions.get(token);
  if (!s || s.exp < Date.now()) return null;
  return s.privateKey || null;
}

// Descifra la privada del médico con su contraseña (solo en el login).
function unlockPrivateKey(user, password) {
  if (!user.privateKeyEnc || !user.keySalt) return null;   // usuario creado antes de las claves
  try { return enc.descifrarConPassword(user.privateKeyEnc, password, user.keySalt); }
  catch { return null; }
}

function publicKeyOf(userId) {
  const u = users.get(userId);
  return (u && u.publicKey) || null;
}
function getSessionUser(token) {
  const s = token && sessions.get(token);
  if (!s) return null;
  if (s.exp < Date.now()) { sessions.delete(token); return null; }
  return users.get(s.userId) || null;
}
function destroySession(token) { if (token) sessions.delete(token); }

// ── Cookies ──
function parseCookies(req) {
  const out = {};
  const h = req.headers.cookie;
  if (!h) return out;
  for (const part of h.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function sessionCookie(token, { secure } = {}) {
  const bits = [`${COOKIE}=${token}`, 'HttpOnly', 'Path=/', 'SameSite=Strict', `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`];
  if (secure) bits.push('Secure');
  return bits.join('; ');
}
function clearCookie() {
  return `${COOKIE}=; HttpOnly; Path=/; SameSite=Strict; Max-Age=0`;
}

// ── Audit log (JSONL, sin PII, encadenado) ──
//
// Cada entrada lleva el hash de la anterior. Antes era un JSONL suelto: quien tuviera acceso
// al disco podía reescribirlo entero sin dejar rastro, y un audit log que se puede reescribir
// no sirve como evidencia — que es lo único para lo que existe.
//
// La cadena no impide que alguien borre el archivo; impide que lo EDITE sin que se note:
// cambiar o quitar una entrada rompe el encadenado de todas las siguientes.
let ultimoHash = null;

function hashEntrada(entrada) {
  return crypto.createHash('sha256').update(JSON.stringify(entrada)).digest('hex').slice(0, 16);
}

function audit(entry) {
  try {
    if (ultimoHash === null) {
      const previas = readAudit();
      ultimoHash = previas.length ? previas[previas.length - 1].h : '';
    }
    const e = { ts: Date.now(), ...entry, prev: ultimoHash };
    e.h = hashEntrada(e);
    fs.appendFileSync(auditFile, JSON.stringify(e) + '\n');
    ultimoHash = e.h;
  } catch { /* no bloquea la operación clínica */ }
}

function readAudit() {
  try {
    return fs.readFileSync(auditFile, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
  } catch { return []; }
}

// ¿La cadena está intacta? Devuelve la primera entrada adulterada, si la hay.
function verifyAudit() {
  const filas = readAudit();
  let prev = '';
  for (let i = 0; i < filas.length; i++) {
    const f = filas[i];
    const { h, ...sinHash } = f;
    if (f.prev !== prev || hashEntrada(sinHash) !== h) {
      return { valid: false, brokenAt: i, total: filas.length };
    }
    prev = h;
  }
  return { valid: true, total: filas.length };
}

module.exports = {
  init, bootstrapAdmin, createUser, listUsers, countUsers, authenticate, publicUser,
  createSession, getSessionUser, destroySession, sessionPrivateKey, unlockPrivateKey, publicKeyOf,
  parseCookies, sessionCookie, clearCookie, COOKIE,
  audit, readAudit, verifyAudit,
};
