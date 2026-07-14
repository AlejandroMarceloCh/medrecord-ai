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

// Error de arranque: el sistema se niega a hacer algo destructivo. No es un bug.
function bootError(msg) { const e = new Error(msg); e.code = 'MEDRECORD_BOOT'; return e; }

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;

function keyPath() {
  return process.env.MEDRECORD_KEY_FILE || path.join(__dirname, 'data', '.master.key');
}

// Una clave existente NUNCA se regenera. Si el archivo está presente pero es inválido
// (copia interrumpida, restore a medias, disco lleno al escribirla), abortamos: pisarlo
// con una clave nueva volvería irrecuperable toda la data cifrada, sin aviso.
function loadOrCreateKey() {
  const p = keyPath();
  let raw = null;
  try {
    raw = fs.readFileSync(p);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      throw bootError(`No se pudo leer la clave maestra en ${p}: ${err.message}. NO se genera una nueva (destruiría los datos cifrados).`);
    }
  }
  if (raw) {
    if (raw.length !== 32) {
      throw bootError(
        `Clave maestra inválida en ${p}: ${raw.length} bytes, se esperaban 32. ` +
        `NO se regenera. Restaura la clave correcta desde el backup (ver RESTORE.md).`
      );
    }
    return raw;
  }
  const key = crypto.randomBytes(32);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, key, { mode: 0o600 });
  try { fs.chmodSync(p, 0o600); } catch { /* noop */ }
  return key;
}

const MASTER = loadOrCreateKey();

// Subclaves separadas por dominio. Antes la MISMA clave cifraba y firmaba (HMAC): una fuga
// por un lado comprometía el otro. HKDF las deriva de la maestra sin que ninguna revele la
// otra, y no rompe nada existente porque el cifrado sigue usando la misma clave que antes.
const KEY = MASTER;                                              // AES-256-GCM (compatibilidad)
const MAC_KEY = crypto.hkdfSync('sha256', MASTER, Buffer.alloc(0), 'medrecord-mac-v1', 32);

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

// Firma de integridad (HMAC-SHA256). Es tamper-evidence, NO una firma legalmente
// vinculante: para eso está la firma Ed25519 del médico, más abajo.
//
// OJO con la clave: las firmas v1 se calcularon con la clave MAESTRA. Cambiarles la clave
// las invalidaría TODAS de golpe —una historia legítima pasaría a reportarse como
// adulterada—, así que la v1 conserva la suya. La separación de dominios (MAC_KEY derivada
// por HKDF) se aplica solo a las firmas nuevas.
function hmac(data, version = 1) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
  const clave = version >= 2 ? Buffer.from(MAC_KEY) : KEY;
  return crypto.createHmac('sha256', clave).update(buf).digest('hex');
}

// ── Firma del médico (Ed25519) ───────────────────────────────────────────────
// El HMAC prueba que el contenido no cambió, pero NO da no-repudio: la clave la conoce el
// servidor, así que un admin podría forjar la firma de cualquier médico. Y TERMS.md promete
// justo lo contrario — que la responsabilidad del contenido recae en quien firma.
//
// Cada médico tiene su par Ed25519. La privada se guarda cifrada con una clave derivada de
// SU contraseña: el servidor no puede firmar por él sin que él inicie sesión.
function generarParDeClaves() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  };
}

// Cifra/descifra la clave privada con la contraseña del médico (scrypt → AES-256-GCM).
function cifrarConPassword(texto, password, salt) {
  const k = crypto.scryptSync(String(password), salt, 32);
  const iv = crypto.randomBytes(IV_LEN);
  const c = crypto.createCipheriv(ALGO, k, iv);
  const enc = Buffer.concat([c.update(Buffer.from(texto, 'utf8')), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64');
}
function descifrarConPassword(b64, password, salt) {
  const blob = Buffer.from(b64, 'base64');
  const k = crypto.scryptSync(String(password), salt, 32);
  const iv = blob.subarray(0, IV_LEN);
  const tag = blob.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const d = crypto.createDecipheriv(ALGO, k, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(blob.subarray(IV_LEN + TAG_LEN)), d.final()]).toString('utf8');
}

function firmarEd25519(payload, privateKeyPem) {
  const key = crypto.createPrivateKey(privateKeyPem);
  return crypto.sign(null, Buffer.from(payload, 'utf8'), key).toString('base64');
}
function verificarEd25519(payload, firmaB64, publicKeyPem) {
  try {
    const key = crypto.createPublicKey(publicKeyPem);
    return crypto.verify(null, Buffer.from(payload, 'utf8'), key, Buffer.from(firmaB64, 'base64'));
  } catch { return false; }
}

// Borrado seguro: sobrescribe el archivo con bytes aleatorios (+fsync) antes de
// eliminarlo, para que el contenido no quede recuperable del disco.
function secureDelete(filePath) {
  try {
    const sz = fs.statSync(filePath).size;
    if (sz > 0) {
      const fd = fs.openSync(filePath, 'r+');
      try { fs.writeSync(fd, crypto.randomBytes(sz), 0, sz, 0); fs.fsyncSync(fd); }
      finally { fs.closeSync(fd); }
    }
    fs.unlinkSync(filePath);
    return true;
  } catch { try { fs.unlinkSync(filePath); } catch { /* noop */ } return false; }
}

module.exports = {
  encryptBuffer, decryptBuffer, writeEncrypted, readEncrypted, isEncrypted, keyPath, hmac, secureDelete,
  generarParDeClaves, cifrarConPassword, descifrarConPassword, firmarEd25519, verificarEd25519,
};
