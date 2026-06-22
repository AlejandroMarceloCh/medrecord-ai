// crypto.js — cifrado en reposo (AES-256-GCM) del audio y los sidecar JSON.
// La data médica (nombre, DNI, transcripción, audio) NUNCA queda en claro en disco.
//
// Clave maestra: archivo binario de 32 bytes con permisos 0600. Por defecto en
// data/.master.key (fuera del control de versiones). Se genera al primer arranque.
// Para rotarla o respaldarla, copia ese archivo a un lugar seguro: si se pierde,
// los datos cifrados son irrecuperables.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;

function keyPath() {
  return process.env.MEDRECORD_KEY_FILE || path.join(__dirname, 'data', '.master.key');
}

function loadOrCreateKey() {
  const p = keyPath();
  try {
    const raw = fs.readFileSync(p);
    if (raw.length >= 32) return raw.subarray(0, 32);
  } catch { /* no existe → la creamos */ }
  const key = crypto.randomBytes(32);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, key, { mode: 0o600 });
  try { fs.chmodSync(p, 0o600); } catch { /* noop */ }
  return key;
}

const KEY = loadOrCreateKey();

// Formato del blob: [12 bytes IV][16 bytes auth tag][ciphertext]
function encryptBuffer(buf) {
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, KEY, iv);
  const enc = Buffer.concat([cipher.update(buf), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]);
}

function decryptBuffer(blob) {
  const iv = blob.subarray(0, IV_LEN);
  const tag = blob.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const data = blob.subarray(IV_LEN + TAG_LEN);
  const decipher = crypto.createDecipheriv(ALGO, KEY, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}

// Escritura atómica cifrada: write → fsync → rename. El fsync fuerza el flush a
// disco antes del rename, así un corte de luz no deja el destino truncado.
function writeEncrypted(destPath, data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
  const tmp = destPath + '.tmp';
  const payload = encryptBuffer(buf);
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, payload);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, destPath);
}

function readEncrypted(srcPath) {
  return decryptBuffer(fs.readFileSync(srcPath));
}

// ¿El archivo está cifrado con este módulo? Heurística: intenta descifrar.
// Sirve para migrar sidecars antiguos en claro sin romper nada.
function isEncrypted(srcPath) {
  try { decryptBuffer(fs.readFileSync(srcPath)); return true; }
  catch { return false; }
}

module.exports = { encryptBuffer, decryptBuffer, writeEncrypted, readEncrypted, isEncrypted, keyPath };
