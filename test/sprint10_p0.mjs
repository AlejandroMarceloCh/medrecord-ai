// Sprint 10 — test al goal: "la PII no sale por ningún canal + backups recuperables
// + el token de subida no lee historias ajenas".
//
// Verifica:
//  1. WS sin sesión → rechazado (no recibe nada)
//  2. WS de A recibe SU grabación con PII; WS de B NO recibe la de A (aislamiento por canal)
//  3. device (Bearer): GET lista → vacía; GET :id → solo estado (sin PII); GET audio → 404
//  4. backup incluye la clave y, restaurado en una máquina limpia, descifra la historia
//
// Aislado en DATA_DIR temporal. Usa el paquete ws para mandar cookie en el handshake.
// Uso: node test/sprint10_p0.mjs   (no necesita Ollama)
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';

const PORT = 3405, PORT2 = 3406;
const BASE = `http://localhost:${PORT}`;
const WSURL = `ws://localhost:${PORT}`;
const TOKEN = 's10-device-token';
const work = mkdtempSync(join(tmpdir(), 'medrec-s10-'));
const DATA = join(work, 'recordings');
const KEY  = join(work, '.master.key');
mkdirSync(DATA, { recursive: true });

const results = [];
const add = (name, ok, detail) => results.push({ name, ok, detail });

function waitHealth(base, timeout = 8000) {
  return new Promise((res, rej) => {
    const t0 = Date.now();
    const tick = async () => {
      try { const r = await fetch(`${base}/health`); if (r.ok) return res(true); } catch {}
      if (Date.now() - t0 > timeout) return rej(new Error('server no levantó'));
      setTimeout(tick, 250);
    };
    tick();
  });
}
const cookieOf = (res) => { const sc = res.headers.get('set-cookie'); return sc ? sc.split(';')[0] : null; };
const jpost = (url, body, cookie) => fetch(url, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
  body: JSON.stringify(body),
});
async function login(u, p) { const r = await jpost(`${BASE}/api/login`, { username: u, password: p }); return { cookie: cookieOf(r), body: await r.json().catch(()=>({})) }; }
async function upload(cookie, name) {
  const fd = new FormData();
  fd.append('audio', new Blob([Buffer.from('fake')], { type: 'audio/webm' }), 'c.webm');
  fd.append('patientName', name); fd.append('durationSec', '5');
  const r = await fetch(`${BASE}/api/recordings`, { method: 'POST', headers: { Cookie: cookie }, body: fd });
  return (await r.json()).id;
}
function wsOpen(cookie) {
  return new Promise((resolve) => {
    const ws = new WebSocket(WSURL, cookie ? { headers: { Cookie: cookie } } : undefined);
    ws._msgs = []; ws._closed = false;
    ws.on('message', (d) => { try { ws._msgs.push(JSON.parse(d.toString())); } catch {} });
    ws.on('close', () => { ws._closed = true; });
    ws.on('open', () => resolve(ws));
    ws.on('error', () => resolve(ws));   // un cierre 1008 dispara error/close; resolvemos igual
    setTimeout(() => resolve(ws), 1200); // fallback si nunca abre (rechazado)
  });
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const srv = spawn('node', ['server.js'], {
  env: { ...process.env, PORT: String(PORT), NODE_ENV: 'development',
         MEDRECORD_DATA_DIR: DATA, MEDRECORD_KEY_FILE: KEY,
         MEDRECORD_ADMIN_USER: 'admin', MEDRECORD_ADMIN_PASS: 'admin12345',
         MEDRECORD_TOKEN: TOKEN },
  stdio: 'ignore',
});

try {
  await waitHealth(BASE);
  const admin = await login('admin', 'admin12345');
  await jpost(`${BASE}/api/users`, { username: 'a', password: 'claveA1', name: 'Dra A', role: 'medico' }, admin.cookie);
  await jpost(`${BASE}/api/users`, { username: 'b', password: 'claveB1', name: 'Dr B', role: 'medico' }, admin.cookie);
  const a = await login('a', 'claveA1');
  const b = await login('b', 'claveB1');
  const recA = await upload(a.cookie, 'Ana Paciente');
  await upload(b.cookie, 'Bruno Paciente');

  // ── WS ──
  const wsA = await wsOpen(a.cookie);
  const wsB = await wsOpen(b.cookie);
  const wsAnon = await wsOpen(null);
  await sleep(200);

  // Dispara un evento sobre recA (PUT fields de A).
  await fetch(`${BASE}/api/recordings/${recA}/fields`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: a.cookie },
    body: JSON.stringify({ fields: { anamnesis: { motivo_consulta: 'control' } } }),
  });
  await sleep(500);

  const aGotRecA = wsA._msgs.some(m => m.recording && m.recording.id === recA && m.recording.patient);
  add('1 · WS sin sesión → rechazado', wsAnon._closed === true || wsAnon.readyState === 3,
    `closed=${wsAnon._closed} state=${wsAnon.readyState}`);
  add('2 · WS de A recibe SU grabación con PII', aGotRecA, `msgsA=${wsA._msgs.length}`);
  const bGotRecA = wsB._msgs.some(m => m.recording && m.recording.id === recA);
  add('2b · WS de B NO recibe la grabación de A', !bGotRecA, `B vio recA=${bGotRecA} (msgsB=${wsB._msgs.length})`);
  try { wsA.close(); wsB.close(); wsAnon.close(); } catch {}

  // ── device (Bearer) ──
  const dev = { Authorization: `Bearer ${TOKEN}` };
  const devList = await (await fetch(`${BASE}/api/recordings`, { headers: dev })).json();
  add('3 · device: lista vacía (no lee ajenas)', Array.isArray(devList) && devList.length === 0, `len=${devList.length}`);
  const devOne = await (await fetch(`${BASE}/api/recordings/${recA}`, { headers: dev })).json();
  const noPii = !devOne.patient && !devOne.fields && !devOne.transcript && !!devOne.status;
  add('3b · device: GET :id solo estado, sin PII', noPii, `keys=${Object.keys(devOne).join(',')}`);
  const devAudio = await fetch(`${BASE}/api/recordings/${recA}/audio`, { headers: dev });
  add('3c · device: GET audio → 404', devAudio.status === 404, `status=${devAudio.status}`);

  // ── backup + restore en máquina limpia ──
  const backupDir = join(work, 'backups');
  const bk = spawnSync('bash', ['scripts/backup.sh'], {
    env: { ...process.env, MEDRECORD_DATA_DIR: DATA, MEDRECORD_KEY_FILE: KEY, BACKUP_DIR: backupDir },
    encoding: 'utf8',
  });
  const tar = (readdirSync(backupDir).find(f => f.endsWith('.tar.gz')) || '');
  const restore = join(work, 'restore');
  mkdirSync(restore, { recursive: true });
  spawnSync('tar', ['-xzf', join(backupDir, tar), '-C', restore], { encoding: 'utf8' });

  // Server limpio que SOLO conoce el backup restaurado (datos + clave).
  const srv2 = spawn('node', ['server.js'], {
    env: { ...process.env, PORT: String(PORT2), NODE_ENV: 'development',
           MEDRECORD_DATA_DIR: join(restore, 'recordings'),
           MEDRECORD_KEY_FILE: join(restore, '.master.key') },
    stdio: 'ignore',
  });
  let restored = null;
  try {
    await waitHealth(`http://localhost:${PORT2}`);
    // El backup restaura también los usuarios (users.json), así que el server limpio
    // exige sesión: entramos como admin y leemos la historia para probar el descifrado.
    const r = await fetch(`http://localhost:${PORT2}/api/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin12345' }),
    });
    const c2 = cookieOf(r);
    restored = await (await fetch(`http://localhost:${PORT2}/api/recordings/${recA}`, { headers: { Cookie: c2 } })).json();
  } finally { srv2.kill('SIGKILL'); }
  add('4 · backup restaurado en máquina limpia descifra',
    !!tar && restored && restored.patient && restored.patient.name === 'Ana Paciente',
    `tar=${!!tar} name=${restored?.patient?.name}`);

} catch (e) {
  add('ejecución', false, String(e.message));
} finally {
  srv.kill('SIGKILL');
  try { rmSync(work, { recursive: true, force: true }); } catch {}
}

console.log('\nSprint 10 — test al goal "PII no sale + backup recuperable + device solo escritura":\n');
let pass = 0;
for (const r of results) {
  console.log(`  [${r.ok ? 'PASA' : 'FALLA'}]  ${r.name}\n           ${r.detail}`);
  if (r.ok) pass++;
}
console.log(`\n  ${pass}/${results.length} casos.  ${pass === results.length ? '✓ GOAL CUMPLIDO' : '✗ HAY FALLAS'}\n`);
process.exit(pass === results.length ? 0 : 1);
