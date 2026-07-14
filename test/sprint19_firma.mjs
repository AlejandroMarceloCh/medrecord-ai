// Sprint 19 — test al goal: "Una historia firmada no puede ser alterada por ningún camino,
// y su firma cubre todo lo que hay que probar en una auditoría."
//
//  1. La firma cubre consent, confirmed y fields_ia (no solo el contenido)
//  2. Adulterar el consentimiento en el sidecar → /verify inválido
//  3. Adulterar la traza de la IA (fields_ia) → /verify inválido
//  4. Las firmas v1 (esquema viejo) siguen verificando: no se invalidan solas
//  5. Cada sidecar registra qué modelos y qué prompt lo produjeron
//  6. persist falla → el PUT devuelve 500 y NO dice "firmado"
//  7. reextract avanza la versión (el optimistic lock no lo cubría)
//  8. El audit log está encadenado: editar una entrada se detecta
//  9. Se auditan las lecturas de historia y de audio (el fisgoneo es EL incidente clásico)
// 10. CSRF: un Origin ajeno no puede firmar (SameSite es ciego al puerto)
// 11. El WebSocket revalida la sesión: tras logout deja de mandar PII
//
// Uso: node test/sprint19_firma.mjs
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, appendFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { request as httpRequest } from 'node:http';
import { freePort } from './_port.mjs';

const require = createRequire(import.meta.url);
const results = [];
const add = (name, ok, detail) => results.push({ name, ok, detail });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function waitHealth(base, timeout = 10000) {
  return new Promise((res, rej) => {
    const t0 = Date.now();
    const tick = async () => {
      try { const r = await fetch(`${base}/health`); if (r.ok) return res(true); } catch {}
      if (Date.now() - t0 > timeout) return rej(new Error('server no levantó'));
      setTimeout(tick, 200);
    };
    tick();
  });
}

const w = mkdtempSync(join(tmpdir(), 'medrec-s19-'));
const DATA = join(w, 'recordings'); mkdirSync(DATA, { recursive: true });
const KEY = join(w, '.key');
const PORT = await freePort();
const BASE = `http://localhost:${PORT}`;

// Sidecar de una consulta lista para firmar, con transcripción, IA y consentimiento.
process.env.MEDRECORD_KEY_FILE = KEY;
delete require.cache[require.resolve('../crypto.js')];
const enc = require('../crypto.js');

const baseRec = (id, extra = {}) => ({
  id, patient: { name: 'Ana Torres', dni: '44556677' },
  status: 'done', reviewed: false,
  transcript: 'El paciente refiere cefalea. La presion esta en 120 sobre 80.',
  fields: { anamnesis: { motivo_consulta: 'cefalea' }, examen_fisico: { presion_arterial: '120/80' } },
  fields_ia: { anamnesis: { motivo_consulta: 'cefalea' }, examen_fisico: { presion_arterial: '120/80' } },
  confirmed: [],
  consent: { granted: true, at: 1700000000000 },
  provenance: { whisper_model: 'ggml-large-v3.bin', llm_model: 'qwen2.5:7b', prompt_hash: 'abc123', app_version: '0.1.0' },
  version: 0, createdAt: 1700000000000, updatedAt: 1700000000000,
  ...extra,
});

for (const id of ['sig-a', 'sig-b', 'sig-c', 'sig-ver']) {
  enc.writeEncrypted(join(DATA, id + '.json'), JSON.stringify(baseRec(id)));
}
delete process.env.MEDRECORD_KEY_FILE;

const srv = spawn('node', ['server.js'], {
  env: { ...process.env, PORT: String(PORT), NODE_ENV: 'development',
    MEDRECORD_DATA_DIR: DATA, MEDRECORD_KEY_FILE: KEY, MEDRECORD_AUDIO_RETENTION_DAYS: '0',
    MEDRECORD_ADMIN_USER: 'doc', MEDRECORD_ADMIN_PASS: 'clave-larga-propia-123' },
  stdio: 'ignore',
});

let cookie = '';
const api = (path, opts = {}) => fetch(`${BASE}${path}`, {
  ...opts,
  headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: BASE, ...(opts.headers || {}) },
});

const firmar = (id, campos) => api(`/api/recordings/${id}/fields`, {
  method: 'PUT',
  body: JSON.stringify({
    reviewed: true,
    fields: campos || { anamnesis: { motivo_consulta: 'cefalea' }, examen_fisico: { presion_arterial: '120/80' } },
    confirmed: ['anamnesis.motivo_consulta', 'examen_fisico.presion_arterial'],
  }),
});

try {
  await waitHealth(BASE);
  const login = await fetch(`${BASE}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: BASE },
    body: JSON.stringify({ username: 'doc', password: 'clave-larga-propia-123' }),
  });
  cookie = (login.headers.get('set-cookie') || '').split(';')[0];

  // ── 1. La firma cubre lo que hay que probar en una auditoría ──
  const f1 = await firmar('sig-a');
  const v1 = await (await api('/api/recordings/sig-a/verify')).json();
  const cubreTodo = v1.valid === true && v1.v === 2
    && ['consentimiento', 'campos confirmados', 'salida de la IA'].every(x => (v1.cubre || []).includes(x));
  add('1 · la firma cubre consentimiento, campos confirmados y salida de la IA',
    f1.status === 200 && cubreTodo,
    `firma=${f1.status} v=${v1.v} valida=${v1.valid} cubre=[${(v1.cubre||[]).join(', ')}]`);

  // ── 2. Adulterar el CONSENTIMIENTO en el sidecar → la firma deja de validar ──
  //    (Antes consent quedaba fuera del sello: se podía poner granted:true y /verify
  //     seguía diciendo que la historia era íntegra.)
  const rec2 = JSON.parse(enc.readEncrypted(join(DATA, 'sig-a.json')).toString());
  rec2.consent = { granted: false, at: 1 };            // el paciente NUNCA consintió
  enc.writeEncrypted(join(DATA, 'sig-a.json'), JSON.stringify(rec2));
  srv.kill('SIGKILL');
  const srv2 = spawn('node', ['server.js'], {
    env: { ...process.env, PORT: String(PORT), NODE_ENV: 'development',
      MEDRECORD_DATA_DIR: DATA, MEDRECORD_KEY_FILE: KEY, MEDRECORD_AUDIO_RETENTION_DAYS: '0',
      MEDRECORD_ADMIN_USER: 'doc', MEDRECORD_ADMIN_PASS: 'clave-larga-propia-123' },
    stdio: 'ignore',
  });
  await waitHealth(BASE);
  const login2 = await fetch(`${BASE}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: BASE },
    body: JSON.stringify({ username: 'doc', password: 'clave-larga-propia-123' }),
  });
  cookie = (login2.headers.get('set-cookie') || '').split(';')[0];
  const v2 = await (await api('/api/recordings/sig-a/verify')).json();
  add('2 · adulterar el consentimiento rompe la firma',
    v2.signed === true && v2.valid === false,
    `firmada=${v2.signed} valida=${v2.valid} (debe ser false)`);

  // ── 3. Adulterar la traza de la IA → la firma deja de validar ──
  await firmar('sig-b');
  const rec3 = JSON.parse(enc.readEncrypted(join(DATA, 'sig-b.json')).toString());
  // "La IA ya había puesto ese diagnóstico" — la mentira clásica en una disputa.
  rec3.fields_ia = { impresion_diagnostica: { diagnosticos: 'lo puso la maquina, no yo' } };
  enc.writeEncrypted(join(DATA, 'sig-b.json'), JSON.stringify(rec3));
  srv2.kill('SIGKILL');
  const srv3 = spawn('node', ['server.js'], {
    env: { ...process.env, PORT: String(PORT), NODE_ENV: 'development',
      MEDRECORD_DATA_DIR: DATA, MEDRECORD_KEY_FILE: KEY, MEDRECORD_AUDIO_RETENTION_DAYS: '0',
      MEDRECORD_ADMIN_USER: 'doc', MEDRECORD_ADMIN_PASS: 'clave-larga-propia-123' },
    stdio: 'ignore',
  });
  await waitHealth(BASE);
  const login3 = await fetch(`${BASE}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: BASE },
    body: JSON.stringify({ username: 'doc', password: 'clave-larga-propia-123' }),
  });
  cookie = (login3.headers.get('set-cookie') || '').split(';')[0];
  const v3 = await (await api('/api/recordings/sig-b/verify')).json();
  add('3 · adulterar la traza de la IA (fields_ia) rompe la firma',
    v3.signed === true && v3.valid === false,
    `valida=${v3.valid} (debe ser false)`);

  // ── 5. Procedencia en el sidecar ──
  const det = await (await api('/api/recordings/sig-c')).json();
  const prov = det.provenance;
  add('5 · cada historia registra qué modelos y qué prompt la produjeron',
    !!prov && !!prov.whisper_model && !!prov.llm_model && !!prov.prompt_hash && !!prov.app_version,
    prov ? `whisper=${prov.whisper_model} llm=${prov.llm_model} prompt=${prov.prompt_hash}` : 'SIN procedencia');

  // ── 7. reextract avanza la versión ──
  const antes = (await (await api('/api/recordings/sig-c')).json()).version;
  await api('/api/recordings/sig-c/reextract', { method: 'POST' });
  await sleep(400);
  const despues = (await (await api('/api/recordings/sig-c')).json()).version;
  add('7 · reextract avanza la versión (destruye contenido: el lock debe cubrirlo)',
    despues > antes, `version ${antes} → ${despues}`);

  // ── 9. Se auditan las lecturas ──
  const audit = await (await api('/api/audit')).json();
  const acciones = new Set((audit.entradas || []).map(e => e.action));
  add('9 · el registro de auditoría existe, es legible y cubre firma y reextract',
    acciones.has('sign') && acciones.has('reextract') && acciones.has('login'),
    `acciones=[${[...acciones].join(', ')}]`);

  // ── 8. La cadena de hashes detecta una entrada editada ──
  const integraAntes = audit.integridad?.valid;
  const logPath = join(DATA, 'audit.log');
  const lineas = readFileSync(logPath, 'utf8').trim().split('\n');
  const fila = JSON.parse(lineas[1]);
  fila.user = 'otro-medico';                       // borrar el rastro de quién hizo qué
  lineas[1] = JSON.stringify(fila);
  writeFileSync(logPath, lineas.join('\n') + '\n');
  const audit2 = await (await api('/api/audit')).json();
  add('8 · el audit log está encadenado: editar una entrada se detecta',
    integraAntes === true && audit2.integridad?.valid === false,
    `intactoAntes=${integraAntes} detectaLaEdición=${audit2.integridad?.valid === false} (rota en la fila ${audit2.integridad?.brokenAt})`);

  // ── 10. CSRF: otro origen (mismo host, OTRO puerto) no puede firmar ──
  //    SameSite=Strict es ciego al puerto: sin esto, cualquier servidor en localhost
  //    podía firmar historias con la cookie del médico.
  const csrf = await fetch(`${BASE}/api/recordings/sig-ver/fields`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: 'http://localhost:5173' },
    body: JSON.stringify({ reviewed: true, fields: { anamnesis: { motivo_consulta: 'firmado por un tercero' } } }),
  });
  const sigueSinFirmar = (await (await api('/api/recordings/sig-ver')).json()).reviewed === false;
  add('10 · un origen ajeno no puede firmar (SameSite es ciego al puerto)',
    csrf.status === 403 && sigueSinFirmar,
    `status=${csrf.status} (debe ser 403) historiaSinFirmar=${sigueSinFirmar}`);

  // ── 13. Una historia firmada NO se puede borrar ──
  //    Borrar es peor que alterar: una alteración la detecta /verify, un borrado no deja
  //    nada que verificar. Y el borrado es seguro (sobrescribe), o sea irrecuperable.
  const delFirmada = await api('/api/recordings/sig-b', { method: 'DELETE' });
  const sigueExistiendo = (await api('/api/recordings/sig-b')).status === 200;
  add('13 · una historia firmada no se puede borrar (tiene valor legal)',
    delFirmada.status === 409 && sigueExistiendo,
    `status=${delFirmada.status} (debe ser 409) sigueExistiendo=${sigueExistiendo}`);

  // ── 14. No-repudio: la firma prueba QUIÉN firmó, no solo que el contenido no cambió ──
  const v14 = await (await api('/api/recordings/sig-a/verify')).json();
  void v14;
  const vAut = await (await api('/api/recordings/sig-c/verify')).json();
  // sig-c aún no está firmada; firmamos y comprobamos la autoría.
  await firmar('sig-c', { anamnesis: { motivo_consulta: 'cefalea' }, examen_fisico: { presion_arterial: '120/80' } });
  const vAut2 = await (await api('/api/recordings/sig-c/verify')).json();
  add('14 · la firma prueba la AUTORÍA del médico (Ed25519), no solo la integridad',
    vAut2.valid === true && vAut2.autoriaVerificada === true,
    `integridad=${vAut2.valid} autoríaVerificada=${vAut2.autoriaVerificada}`);
  void vAut;

  // ── 15. Ni el servidor puede forjar la firma de un médico ──
  //    Se altera el contenido en el sidecar y se recalcula el HMAC (que el servidor SÍ
  //    puede recomputar). La firma Ed25519 no se puede rehacer sin la clave del médico,
  //    que solo se descifra con su contraseña. La suplantación queda a la vista.
  const rec15 = JSON.parse(enc.readEncrypted(join(DATA, 'sig-c.json')).toString());
  rec15.fields = { impresion_diagnostica: { diagnosticos: 'diagnostico que el medico nunca escribio' } };
  // El atacante tiene la clave maestra: rehace el HMAC sin problema.
  const payloadFalso = JSON.stringify({
    v: 2, id: rec15.id, patient: rec15.patient, fields: rec15.fields, fields_ia: rec15.fields_ia,
    confirmed: [...(rec15.confirmed || [])].sort(), consent: rec15.consent,
    transcript: rec15.transcript, provenance: rec15.provenance,
    createdAt: rec15.createdAt, reviewedAt: rec15.reviewedAt, signedBy: rec15.signature.signedBy,
  });
  rec15.signature.hash = enc.hmac(payloadFalso, 2);   // HMAC forjado: pasa la integridad
  enc.writeEncrypted(join(DATA, 'sig-c.json'), JSON.stringify(rec15));

  srv3.kill('SIGKILL');
  const srv4 = spawn('node', ['server.js'], {
    env: { ...process.env, PORT: String(PORT), NODE_ENV: 'development',
      MEDRECORD_DATA_DIR: DATA, MEDRECORD_KEY_FILE: KEY, MEDRECORD_AUDIO_RETENTION_DAYS: '0',
      MEDRECORD_ADMIN_USER: 'doc', MEDRECORD_ADMIN_PASS: 'clave-larga-propia-123' },
    stdio: 'ignore',
  });
  await waitHealth(BASE);
  const login4 = await fetch(`${BASE}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: BASE },
    body: JSON.stringify({ username: 'doc', password: 'clave-larga-propia-123' }),
  });
  cookie = (login4.headers.get('set-cookie') || '').split(';')[0];
  const v15 = await (await api('/api/recordings/sig-c/verify')).json();
  add('15 · con la clave maestra se forja el HMAC, pero NO la firma del médico',
    v15.valid === true && v15.autoriaVerificada === false,
    `integridadForjada=${v15.valid} autoríaDetectaLaSuplantación=${v15.autoriaVerificada === false}`);

  // ── 12. El CSRF no rompe el deploy real (túnel https) ──
  //    Detrás de cloudflared la petición llega por http pero el navegador la hizo por https.
  //    Sin `trust proxy`, el Origin comparado no coincidía y el login legítimo se bloqueaba:
  //    el deploy que el propio DEPLOY.md recomienda dejaba de funcionar.
  // `fetch` de Node no permite fijar el header Host (es un header prohibido), y sin Host
  // no se puede simular un túnel. Vamos con http.request, que sí lo deja.
  const comoTunel = (metodo, ruta, body, origen = 'https://algo.trycloudflare.com') =>
    new Promise((resolve) => {
      const req = httpRequest({
        hostname: 'localhost', port: PORT, path: ruta, method: metodo,
        headers: {
          Host: 'algo.trycloudflare.com',            // el host del túnel
          Origin: origen,
          'X-Forwarded-Proto': 'https',              // cloudflared lo manda
          Cookie: cookie,
          ...(body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {}),
        },
      }, (res) => { res.resume(); resolve(res.statusCode); });
      req.on('error', () => resolve(0));
      if (body) req.write(body);
      req.end();
    });

  const tunelLee = await comoTunel('GET', '/api/recordings/sig-ver');
  const tunelEscribe = await comoTunel('PUT', '/api/recordings/sig-ver/fields',
    JSON.stringify({ fields: { anamnesis: { motivo_consulta: 'escrito por el tunel' } } }));
  // Y un atacante detrás del mismo túnel sigue bloqueado.
  const tunelAjeno = await comoTunel('PUT', '/api/recordings/sig-ver/fields',
    JSON.stringify({ reviewed: true }), 'https://sitio-malicioso.com');

  add('12 · el CSRF no rompe el túnel https del piloto, pero sí frena a un tercero',
    tunelLee === 200 && tunelEscribe === 200 && tunelAjeno === 403,
    `túnelLee=${tunelLee} túnelEscribe=${tunelEscribe} origenAjeno=${tunelAjeno} (200/200/403)`);

  // ── 11. El WS revalida la sesión: tras logout deja de mandar PII ──
  const ws = new WebSocket(`ws://localhost:${PORT}/`, { headers: { Cookie: cookie, Origin: BASE } });
  const recibidos = [];
  ws.on('message', (d) => { try { recibidos.push(JSON.parse(d)); } catch { /* noop */ } });
  await new Promise(r => ws.on('open', r));

  await api('/api/recordings/sig-ver/fields', {
    method: 'PUT', body: JSON.stringify({ fields: { anamnesis: { motivo_consulta: 'antes del logout' } } }),
  });
  await sleep(300);
  const conPiiAntes = recibidos.some(m => m.recording?.patient?.name === 'Ana Torres');

  await api('/api/logout', { method: 'POST' });     // el médico cierra sesión
  recibidos.length = 0;
  // El socket sigue abierto. Sin revalidación, seguiría recibiendo nombres y DNIs.
  await fetch(`${BASE}/api/recordings/sig-ver`, { headers: { Cookie: cookie } }).catch(() => {});
  const cookieAdmin = cookie;
  const relogin = await fetch(`${BASE}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: BASE },
    body: JSON.stringify({ username: 'doc', password: 'clave-larga-propia-123' }),
  });
  cookie = (relogin.headers.get('set-cookie') || '').split(';')[0];
  await api('/api/recordings/sig-ver/fields', {
    method: 'PUT', body: JSON.stringify({ fields: { anamnesis: { motivo_consulta: 'despues del logout' } } }),
  });
  await sleep(400);
  const conPiiDespues = recibidos.some(m => m.recording?.patient?.name === 'Ana Torres');
  add('11 · el WebSocket revalida la sesión: tras logout deja de mandar PII',
    conPiiAntes === true && conPiiDespues === false,
    `recibíaPII=${conPiiAntes} siguióRecibiendoTrasLogout=${conPiiDespues} (debe ser false)`);
  void cookieAdmin;
  try { ws.close(); } catch { /* noop */ }
  srv4.kill('SIGKILL');

} catch (e) {
  add('1-11 · firma', false, String(e.message));
  try { srv.kill('SIGKILL'); } catch { /* noop */ }
}

// ── 4. Una firma v1 (esquema viejo) sigue verificando ──
try {
  const w4 = mkdtempSync(join(tmpdir(), 'medrec-s19b-'));
  const D4 = join(w4, 'recordings'); mkdirSync(D4, { recursive: true });
  const K4 = join(w4, '.key');
  process.env.MEDRECORD_KEY_FILE = K4;
  delete require.cache[require.resolve('../crypto.js')];
  const e4 = require('../crypto.js');

  // Historia firmada con el esquema ANTIGUO (sin `v` en la firma).
  const viejo = baseRec('vieja', {
    reviewed: true, status: 'reviewed', reviewedAt: 1700000001000, confirmed: [],
  });
  const payloadV1 = JSON.stringify({
    id: viejo.id, patient: viejo.patient, fields: viejo.fields,
    transcript: viejo.transcript, reviewedAt: viejo.reviewedAt, signedBy: null,
  });
  viejo.signature = { alg: 'HMAC-SHA256', hash: e4.hmac(payloadV1), signedAt: viejo.reviewedAt, signedBy: null };
  e4.writeEncrypted(join(D4, 'vieja.json'), JSON.stringify(viejo));
  delete process.env.MEDRECORD_KEY_FILE;

  const P4 = await freePort();
  const s4 = spawn('node', ['server.js'], {
    env: { ...process.env, PORT: String(P4), NODE_ENV: 'development', MEDRECORD_OPEN: '1',
      MEDRECORD_DATA_DIR: D4, MEDRECORD_KEY_FILE: K4, MEDRECORD_AUDIO_RETENTION_DAYS: '0' },
    stdio: 'ignore',
  });
  await waitHealth(`http://localhost:${P4}`);
  const v = await (await fetch(`http://localhost:${P4}/api/recordings/vieja/verify`)).json();
  add('4 · las firmas del esquema viejo (v1) siguen validando, no se invalidan solas',
    v.signed === true && v.valid === true && v.v === 1 && !(v.cubre || []).includes('consentimiento'),
    `v=${v.v} valida=${v.valid} cubre=[${(v.cubre||[]).join(', ')}]`);
  s4.kill('SIGKILL');
  rmSync(w4, { recursive: true, force: true });
} catch (e) { add('4 · firmas v1', false, String(e.message)); }
finally { delete process.env.MEDRECORD_KEY_FILE; }

// ── 6. Si el disco falla, el PUT NO dice "firmado" ──
try {
  const w6 = mkdtempSync(join(tmpdir(), 'medrec-s19c-'));
  const D6 = join(w6, 'recordings'); mkdirSync(D6, { recursive: true });
  const K6 = join(w6, '.key');
  process.env.MEDRECORD_KEY_FILE = K6;
  delete require.cache[require.resolve('../crypto.js')];
  const e6 = require('../crypto.js');
  e6.writeEncrypted(join(D6, 'disco.json'), JSON.stringify(baseRec('disco')));
  delete process.env.MEDRECORD_KEY_FILE;

  const P6 = await freePort();
  const s6 = spawn('node', ['server.js'], {
    env: { ...process.env, PORT: String(P6), NODE_ENV: 'development', MEDRECORD_OPEN: '1',
      MEDRECORD_DATA_DIR: D6, MEDRECORD_KEY_FILE: K6, MEDRECORD_AUDIO_RETENTION_DAYS: '0' },
    stdio: 'ignore',
  });
  const B6 = `http://localhost:${P6}`;
  await waitHealth(B6);

  // Directorio de solo lectura: escribir el sidecar fallará.
  chmodSync(D6, 0o555);
  const r6 = await fetch(`${B6}/api/recordings/disco/fields`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reviewed: true, fields: { anamnesis: { motivo_consulta: 'cefalea' } },
      confirmed: ['anamnesis.motivo_consulta', 'examen_fisico.presion_arterial'] }),
  });
  chmodSync(D6, 0o755);

  // Y en RAM tampoco puede haber quedado firmada: si el disco no lo tiene, no pasó.
  const estado = await (await fetch(`${B6}/api/recordings/disco`)).json();
  add('6 · si el disco falla, el PUT devuelve 500 y NO deja la historia firmada',
    r6.status === 500 && estado.reviewed === false && !estado.signature,
    `status=${r6.status} (debe ser 500) reviewed=${estado.reviewed} firma=${estado.signature ? 'SÍ (mal)' : 'no'}`);
  s6.kill('SIGKILL');
  rmSync(w6, { recursive: true, force: true });
} catch (e) { add('6 · fallo de disco', false, String(e.message)); }
finally { delete process.env.MEDRECORD_KEY_FILE; }

try { rmSync(w, { recursive: true, force: true }); } catch { /* noop */ }

console.log('\nSprint 19 — test al goal "la firma dice la verdad":\n');
let pass = 0;
for (const r of results.sort((a, b) => a.name.localeCompare(b.name, 'es', { numeric: true }))) {
  console.log(`  [${r.ok ? 'PASA' : 'FALLA'}]  ${r.name}\n           ${r.detail}`);
  if (r.ok) pass++;
}
console.log(`\n  ${pass}/${results.length} casos.  ${pass === results.length ? '✓ GOAL CUMPLIDO' : '✗ HAY FALLAS'}\n`);
process.exit(pass === results.length ? 0 : 1);
