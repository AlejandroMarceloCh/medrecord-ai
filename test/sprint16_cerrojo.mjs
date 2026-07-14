// Sprint 16 — test al goal: "Ningún cliente sin credencial válida recibe PII por
// ningún canal, y ninguna clave maestra existente se regenera jamás."
//
// Ataca el GOAL, no las tareas:
//  1. .master.key de 10 bytes → el server aborta Y la key queda intacta (no se pisa)
//  2. users.json ilegible (cifrado con otra key) → el server aborta
//  3. Producción sin usuarios ni token ni MEDRECORD_OPEN → el server aborta
//  4. Con admin: sin sesión, GET /api/recordings → 401 (no una lista, no un 200 [])
//  5. DELETE → el ciphertext del sidecar ya no está en el disco (borrado seguro)
//  6. La retención de audio está activa por defecto (no "0 = apagada")
//
// Uso: node test/sprint16_cerrojo.mjs   (no necesita Ollama ni Whisper)
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freePort } from './_port.mjs';

const require = createRequire(import.meta.url);
const realFetch = globalThis.fetch;
const results = [];
const add = (name, ok, detail) => results.push({ name, ok, detail });
const src = (f) => readFileSync(new URL('../' + f, import.meta.url), 'utf8');

function waitHealth(base, timeout = 8000) {
  return new Promise((res, rej) => {
    const t0 = Date.now();
    const tick = async () => {
      try { const r = await realFetch(`${base}/health`); if (r.ok) return res(true); } catch {}
      if (Date.now() - t0 > timeout) return rej(new Error('server no levantó'));
      setTimeout(tick, 250);
    };
    tick();
  });
}
// Arranca el server y espera a que MUERA (para los casos de arranque abortado).
// Resuelve { code, waited:false } si murió, o { waited:true } si seguía vivo al timeout.
function spawnAndWaitExit(env, timeout = 6000) {
  return new Promise((res) => {
    const p = spawn('node', ['server.js'], { env, stdio: 'ignore' });
    let done = false;
    const t = setTimeout(() => { if (!done) { done = true; p.kill('SIGKILL'); res({ waited: true }); } }, timeout);
    p.on('exit', (code) => { if (!done) { done = true; clearTimeout(t); res({ waited: false, code }); } });
  });
}

// ── 1. .master.key truncada NO se regenera (goal: la data cifrada nunca se vuelve basura) ──
try {
  const w = mkdtempSync(join(tmpdir(), 'medrec-s16a-'));
  const keyFile = join(w, '.master.key');
  const truncated = Buffer.from('0123456789'); // 10 bytes
  writeFileSync(keyFile, truncated);
  const r = await spawnAndWaitExit({
    ...process.env, PORT: String(await freePort()), NODE_ENV: 'development',
    MEDRECORD_DATA_DIR: join(w, 'recordings'), MEDRECORD_KEY_FILE: keyFile, MEDRECORD_OPEN: '1',
  });
  const stillTruncated = readFileSync(keyFile);
  const intact = stillTruncated.length === 10 && stillTruncated.equals(truncated);
  add('1 · master key inválida → aborta y la key NO se regenera',
    r.waited === false && r.code !== 0 && intact,
    `exit=${r.code} keyLen=${stillTruncated.length} intacta=${intact}`);
  rmSync(w, { recursive: true, force: true });
} catch (e) { add('1 · master key inválida', false, String(e.message)); }

// ── 2. users.json ilegible → aborta (goal: no arrancar con la auth desactivada en silencio) ──
try {
  const w = mkdtempSync(join(tmpdir(), 'medrec-s16b-'));
  const D = join(w, 'recordings'); mkdirSync(D, { recursive: true });
  // users.json cifrado con OTRA clave → indescifrable con la de este server
  const otherKey = join(w, '.other.key');
  writeFileSync(otherKey, require('node:crypto').randomBytes(32));
  process.env.MEDRECORD_KEY_FILE = otherKey;
  delete require.cache[require.resolve('../crypto.js')];
  const encOther = require('../crypto.js');
  encOther.writeEncrypted(join(D, 'users.json'), JSON.stringify([{ id: 'x', username: 'a' }]));
  const r = await spawnAndWaitExit({
    ...process.env, PORT: String(await freePort()), NODE_ENV: 'development',
    MEDRECORD_DATA_DIR: D, MEDRECORD_KEY_FILE: join(w, '.master.key'), MEDRECORD_OPEN: '1',
  });
  add('2 · users.json indescifrable → aborta (no arranca sin auth)',
    r.waited === false && r.code !== 0, `exit=${r.code}`);
  rmSync(w, { recursive: true, force: true });
} catch (e) { add('2 · users.json indescifrable', false, String(e.message)); }
finally { delete process.env.MEDRECORD_KEY_FILE; delete require.cache[require.resolve('../crypto.js')]; }

// ── 3. Sin usuarios, sin token, sin OPEN → aborta (el fail-open del deploy documentado) ──
try {
  const w = mkdtempSync(join(tmpdir(), 'medrec-s16c-'));
  const env = { ...process.env, PORT: String(await freePort()), NODE_ENV: 'production',
    MEDRECORD_DATA_DIR: join(w, 'recordings'), MEDRECORD_KEY_FILE: join(w, '.key') };
  delete env.MEDRECORD_ADMIN_USER; delete env.MEDRECORD_ADMIN_PASS;
  delete env.MEDRECORD_TOKEN; delete env.MEDRECORD_OPEN;
  const r = await spawnAndWaitExit(env);
  add('3 · prod sin credenciales → aborta (no sirve historias abiertas)',
    r.waited === false && r.code !== 0, `exit=${r.code}`);
  rmSync(w, { recursive: true, force: true });
} catch (e) { add('3 · fail-closed', false, String(e.message)); }

// ── 4+5+6. Con admin: 401 sin sesión, DELETE con borrado seguro, retención activa ──
const w4 = mkdtempSync(join(tmpdir(), 'medrec-s16d-'));
const D4 = join(w4, 'recordings'); mkdirSync(D4, { recursive: true });
const P4 = await freePort();
const srv = spawn('node', ['server.js'], {
  env: { ...process.env, PORT: String(P4), NODE_ENV: 'development',
    MEDRECORD_DATA_DIR: D4, MEDRECORD_KEY_FILE: join(w4, '.key'),
    MEDRECORD_ADMIN_USER: 'doc', MEDRECORD_ADMIN_PASS: 'clave-larga-123' },
  stdio: 'ignore',
});
try {
  await waitHealth(`http://localhost:${P4}`);
  const base = `http://localhost:${P4}`;

  // 4. Sin cookie de sesión, la lista de historias no se sirve.
  const anon = await realFetch(`${base}/api/recordings`);
  add('4 · sin sesión → 401 (no un 200 con la lista)', anon.status === 401, `status=${anon.status}`);

  // Login para las pruebas de escritura.
  const login = await realFetch(`${base}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'doc', password: 'clave-larga-123' }),
  });
  const cookie = (login.headers.get('set-cookie') || '').split(';')[0];

  // 5. Crear un sidecar a mano, borrarlo por la API, verificar que el ciphertext no queda.
  //    (Escribimos el sidecar con la MISMA clave del server para que lo cargue al vuelo.)
  process.env.MEDRECORD_KEY_FILE = join(w4, '.key');
  delete require.cache[require.resolve('../crypto.js')];
  const enc = require('../crypto.js');
  const recId = 'del-target';
  const sidecar = join(D4, recId + '.json');
  enc.writeEncrypted(sidecar, JSON.stringify({
    id: recId, patient: { name: 'Borrar', dni: '12345678' }, status: 'done',
    reviewed: false, createdAt: Date.now(),   // sin firmar: una firmada NO se puede borrar (S19)
  }));
  const before = readFileSync(sidecar); // ciphertext en disco
  // El server no lo tiene en RAM (se creó después del loadAll); forzamos recarga vía retry no aplica.
  // En su lugar reiniciamos NO; usamos que loadAll corre al arranque → reiniciamos el server.
  srv.kill('SIGKILL');
  const P5 = await freePort();
  const srv2 = spawn('node', ['server.js'], {
    env: { ...process.env, PORT: String(P5), NODE_ENV: 'development',
      MEDRECORD_DATA_DIR: D4, MEDRECORD_KEY_FILE: join(w4, '.key'),
      MEDRECORD_ADMIN_USER: 'doc', MEDRECORD_ADMIN_PASS: 'clave-larga-123' },
    stdio: 'ignore',
  });
  await waitHealth(`http://localhost:${P5}`);
  const login2 = await realFetch(`http://localhost:${P5}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'doc', password: 'clave-larga-123' }),
  });
  const cookie2 = (login2.headers.get('set-cookie') || '').split(';')[0];
  const del = await realFetch(`http://localhost:${P5}/api/recordings/` + recId, {
    method: 'DELETE', headers: { Cookie: cookie2 },
  });
  const gone = !existsSync(sidecar);
  add('5 · DELETE → sidecar borrado (ciphertext fuera del disco)',
    del.status === 200 && gone && before.length > 0, `del=${del.status} gone=${gone}`);
  srv2.kill('SIGKILL');

} catch (e) { add('4-5 · con admin', false, String(e.message)); srv.kill('SIGKILL'); }
finally {
  delete process.env.MEDRECORD_KEY_FILE;
  try { delete require.cache[require.resolve('../crypto.js')]; } catch {}
  try { rmSync(w4, { recursive: true, force: true }); } catch {}
}

// ── 6. Clave de 32 bytes pero EQUIVOCADA → aborta, no manda todo a cuarentena ──
// El caso del restore con la key errada: el tamaño es válido, así que la validación de
// longitud no lo atrapa. Antes el server arrancaba y renombraba toda la historia clínica
// a .corrupt en silencio. Es tan destructivo como regenerar la clave.
try {
  const w = mkdtempSync(join(tmpdir(), 'medrec-s16e-'));
  const D = join(w, 'recordings'); mkdirSync(D, { recursive: true });
  const realKey = join(w, '.real.key');
  writeFileSync(realKey, require('node:crypto').randomBytes(32));
  process.env.MEDRECORD_KEY_FILE = realKey;
  delete require.cache[require.resolve('../crypto.js')];
  const encReal = require('../crypto.js');
  encReal.writeEncrypted(join(D, 'rec-a.json'), JSON.stringify({ id: 'rec-a', patient: { name: 'Ana' }, createdAt: Date.now() }));
  encReal.writeEncrypted(join(D, 'rec-b.json'), JSON.stringify({ id: 'rec-b', patient: { name: 'Beto' }, createdAt: Date.now() }));

  // Otra clave, del tamaño correcto: el server no debe arrancar ni tocar los sidecars.
  const wrongKey = join(w, '.wrong.key');
  writeFileSync(wrongKey, require('node:crypto').randomBytes(32));
  const r = await spawnAndWaitExit({
    ...process.env, PORT: String(await freePort()), NODE_ENV: 'development',
    MEDRECORD_DATA_DIR: D, MEDRECORD_KEY_FILE: wrongKey, MEDRECORD_OPEN: '1',
  });
  const intactos = existsSync(join(D, 'rec-a.json')) && existsSync(join(D, 'rec-b.json'))
    && !existsSync(join(D, 'rec-a.json.corrupt'));
  add('6 · clave de 32B equivocada → aborta, historias NO van a cuarentena',
    r.waited === false && r.code !== 0 && intactos,
    `exit=${r.code} sidecarsIntactos=${intactos}`);
  rmSync(w, { recursive: true, force: true });
} catch (e) { add('6 · clave equivocada', false, String(e.message)); }
finally { delete process.env.MEDRECORD_KEY_FILE; try { delete require.cache[require.resolve('../crypto.js')]; } catch {} }

// ── 7. La contraseña de ejemplo del repo es rechazada ──
// Sin esto, `cp .env.example .env && npm start` crea un admin con una clave pública.
try {
  const w = mkdtempSync(join(tmpdir(), 'medrec-s16f-'));
  const r = await spawnAndWaitExit({
    ...process.env, PORT: String(await freePort()), NODE_ENV: 'development',
    MEDRECORD_DATA_DIR: join(w, 'recordings'), MEDRECORD_KEY_FILE: join(w, '.key'),
    MEDRECORD_ADMIN_USER: 'admin', MEDRECORD_ADMIN_PASS: 'cambia-esta-clave',
  });
  add('7 · contraseña de ejemplo del repo → aborta',
    r.waited === false && r.code !== 0, `exit=${r.code}`);
  rmSync(w, { recursive: true, force: true });
} catch (e) { add('7 · password placeholder', false, String(e.message)); }

// ── 8. Actualizar el código NO borra audio preexistente ──
// La retención se exige explícita: un default silencioso destruiría audio de consultas
// ya guardadas en el primer arranque tras un `git pull`.
try {
  const w = mkdtempSync(join(tmpdir(), 'medrec-s16g-'));
  const D = join(w, 'recordings'); mkdirSync(D, { recursive: true });
  process.env.MEDRECORD_KEY_FILE = join(w, '.key');
  delete require.cache[require.resolve('../crypto.js')];
  const e2 = require('../crypto.js');
  const audioFile = 'viejo.ogg';
  e2.writeEncrypted(join(D, audioFile), Buffer.from('audio-de-consulta-antigua'));
  e2.writeEncrypted(join(D, 'viejo.json'), JSON.stringify({
    id: 'viejo', patient: { name: 'Antiguo' }, status: 'reviewed', reviewed: true,
    audioFile, audioEnc: true, createdAt: Date.now() - 200 * 86400000,
    reviewedAt: Date.now() - 200 * 86400000,
  }));
  const P8 = await freePort();
  const env = { ...process.env, PORT: String(P8), NODE_ENV: 'development',
    MEDRECORD_DATA_DIR: D, MEDRECORD_KEY_FILE: join(w, '.key'),
    MEDRECORD_ADMIN_USER: 'doc', MEDRECORD_ADMIN_PASS: 'clave-larga-123' };
  delete env.MEDRECORD_AUDIO_RETENTION_DAYS;          // sin política configurada
  const p = spawn('node', ['server.js'], { env, stdio: 'ignore' });
  await waitHealth(`http://localhost:${P8}`);
  const sobrevive = existsSync(join(D, audioFile));
  add('8 · sin política de retención, el audio viejo NO se borra al arrancar',
    sobrevive, `audioSobrevive=${sobrevive}`);
  p.kill('SIGKILL');
  rmSync(w, { recursive: true, force: true });
} catch (e) { add('8 · retención no destructiva', false, String(e.message)); }
finally { delete process.env.MEDRECORD_KEY_FILE; try { delete require.cache[require.resolve('../crypto.js')]; } catch {} }

console.log('\nSprint 16 — test al goal "nadie sin credencial ve PII; ninguna clave se regenera":\n');
let pass = 0;
for (const r of results) {
  console.log(`  [${r.ok ? 'PASA' : 'FALLA'}]  ${r.name}\n           ${r.detail}`);
  if (r.ok) pass++;
}
console.log(`\n  ${pass}/${results.length} casos.  ${pass === results.length ? '✓ GOAL CUMPLIDO' : '✗ HAY FALLAS'}\n`);
process.exit(pass === results.length ? 0 : 1);
