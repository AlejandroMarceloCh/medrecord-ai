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

function loadUsers() {
  users.clear();
  try {
    const json = enc.readEncrypted(usersFile).toString('utf8');
    for (const u of JSON.parse(json)) users.set(u.id, u);
  } catch { /* no existe aún */ }
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
  const user = {
    id: crypto.randomUUID(), username, salt, hash,
    name: String(name || username), role: role === 'admin' ? 'admin' : 'medico',
    createdAt: Date.now(),
  };
  users.set(user.id, user);
  saveUsers();
  return publicUser(user);
}

function publicUser(u) { return u && { id: u.id, username: u.username, name: u.name, role: u.role }; }
function listUsers() { return [...users.values()].map(publicUser); }
function countUsers() { return users.size; }

function authenticate(username, password) {
  username = String(username || '').trim().toLowerCase();
  const u = [...users.values()].find(x => x.username === username);
  if (!u || !verifyPassword(password, u.salt, u.hash)) return null;
  return u;
}

// Crea admin inicial desde variables de entorno si no hay ningún usuario.
function bootstrapAdmin() {
  if (users.size > 0) return;
  const u = process.env.MEDRECORD_ADMIN_USER, p = process.env.MEDRECORD_ADMIN_PASS;
  if (u && p) {
    createUser({ username: u, password: p, name: 'Administrador', role: 'admin' });
    console.log(`  Auth: usuario admin "${u}" creado desde variables de entorno`);
  }
}

// ── Sesiones ──
function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { userId, exp: Date.now() + SESSION_TTL_MS });
  return token;
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

// ── Audit log (JSONL, sin PII) ──
function audit(entry) {
  try { fs.appendFileSync(auditFile, JSON.stringify({ ts: Date.now(), ...entry }) + '\n'); }
  catch { /* no bloquea la operación */ }
}
function readAudit() {
  try {
    return fs.readFileSync(auditFile, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
  } catch { return []; }
}

module.exports = {
  init, bootstrapAdmin, createUser, listUsers, countUsers, authenticate, publicUser,
  createSession, getSessionUser, destroySession,
  parseCookies, sessionCookie, clearCookie, COOKIE,
  audit, readAudit,
};
