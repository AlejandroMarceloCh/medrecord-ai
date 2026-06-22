// Sprint 9 — test al goal: "multiusuario: aislamiento + audit log + optimistic lock".
//
// Verifica:
//  1. Sin sesión → 401 (auth exigida porque hay usuarios)
//  2. Login admin → crea dos médicos; cada uno inicia sesión
//  3. whoami devuelve la identidad correcta por cookie
//  4. Aislamiento: A no ve las grabaciones de B (y viceversa); admin ve ambas
//  5. Acceso cruzado directo a la grabación de B con sesión de A → 404
//  6. Optimistic lock: segundo PUT con versión vieja → 409
//  7. Audit log registró login / create / sign con el userId correcto
//
// Aislado en DATA_DIR temporal. No necesita Ollama.
// Uso: node test/sprint9_multiuser.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 3404;
const BASE = `http://localhost:${PORT}`;
const work = mkdtempSync(join(tmpdir(), 'medrec-s9-'));
const DATA = join(work, 'recordings');
const KEY  = join(work, 'master.key');
mkdirSync(DATA, { recursive: true });

const results = [];
const add = (name, ok, detail) => results.push({ name, ok, detail });

function waitHealth(timeout = 8000) {
  return new Promise((res, rej) => {
    const t0 = Date.now();
    const tick = async () => {
      try { const r = await fetch(`${BASE}/health`); if (r.ok) return res(true); } catch {}
      if (Date.now() - t0 > timeout) return rej(new Error('server no levantó'));
      setTimeout(tick, 250);
    };
    tick();
  });
}
const cookieOf = (res) => { const sc = res.headers.get('set-cookie'); return sc ? sc.split(';')[0] : null; };
const jget = (url, cookie) => fetch(url, cookie ? { headers: { Cookie: cookie } } : {});
const jpost = (url, body, cookie) => fetch(url, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
  body: JSON.stringify(body),
});
async function login(username, password) {
  const r = await jpost(`${BASE}/api/login`, { username, password });
  return { cookie: cookieOf(r), body: await r.json().catch(()=>({})), status: r.status };
}
async function upload(cookie) {
  const fd = new FormData();
  fd.append('audio', new Blob([Buffer.from('fake-audio-bytes')], { type: 'audio/webm' }), 'c.webm');
  fd.append('durationSec', '5');
  fd.append('consent', 'true');
  const r = await fetch(`${BASE}/api/recordings`, { method: 'POST', headers: { Cookie: cookie }, body: fd });
  return (await r.json()).id;
}

const srv = spawn('node', ['server.js'], {
  env: { ...process.env, PORT: String(PORT), NODE_ENV: 'development',
         MEDRECORD_DATA_DIR: DATA, MEDRECORD_KEY_FILE: KEY,
         MEDRECORD_ADMIN_USER: 'admin', MEDRECORD_ADMIN_PASS: 'admin12345' },
  stdio: 'ignore',
});

try {
  await waitHealth();

  // ── 1. Sin sesión → 401 ──
  const anon = await jget(`${BASE}/api/recordings`);
  add('1 · sin sesión → 401', anon.status === 401, `status=${anon.status}`);

  // ── 2. Login admin + crear dos médicos ──
  const admin = await login('admin', 'admin12345');
  const okAdmin = admin.status === 200 && admin.body.user?.role === 'admin';
  const A = await jpost(`${BASE}/api/users`, { username: 'dra.a', password: 'claveA1', name: 'Dra A', role: 'medico' }, admin.cookie);
  const B = await jpost(`${BASE}/api/users`, { username: 'dr.b', password: 'claveB1', name: 'Dr B', role: 'medico' }, admin.cookie);
  const idA = (await A.json()).id, idB = (await B.json()).id;
  add('2 · admin crea dos médicos', okAdmin && !!idA && !!idB && idA !== idB, `admin=${okAdmin} idA=${shortOk(idA)} idB=${shortOk(idB)}`);

  const a = await login('dra.a', 'claveA1');
  const b = await login('dr.b', 'claveB1');

  // ── 3. whoami por cookie ──
  const who = await (await jget(`${BASE}/api/whoami`, a.cookie)).json();
  add('3 · whoami devuelve la identidad correcta', who.user?.id === idA, `id=${shortOk(who.user?.id)} esperado=${shortOk(idA)}`);

  // ── 4/5. Aislamiento ──
  const recA = await upload(a.cookie);
  const recB = await upload(b.cookie);
  const listA = await (await jget(`${BASE}/api/recordings`, a.cookie)).json();
  const listB = await (await jget(`${BASE}/api/recordings`, b.cookie)).json();
  const listAdmin = await (await jget(`${BASE}/api/recordings`, admin.cookie)).json();
  const aSeesOnlyOwn = listA.length === 1 && listA[0].id === recA;
  const bSeesOnlyOwn = listB.length === 1 && listB[0].id === recB;
  const adminSeesBoth = listAdmin.length === 2;
  add('4 · aislamiento por dueño (A↔B), admin ve todo',
    aSeesOnlyOwn && bSeesOnlyOwn && adminSeesBoth,
    `A=${listA.length} B=${listB.length} admin=${listAdmin.length}`);

  const cross = await jget(`${BASE}/api/recordings/${recB}`, a.cookie);
  add('5 · acceso cruzado A→grabación de B → 404', cross.status === 404, `status=${cross.status}`);

  // ── 6. Optimistic lock ──
  const p1 = await fetch(`${BASE}/api/recordings/${recA}/fields`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: a.cookie },
    body: JSON.stringify({ fields: { anamnesis: { motivo_consulta: 'control' } }, version: 0 }),
  });
  const p2 = await fetch(`${BASE}/api/recordings/${recA}/fields`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: a.cookie },
    body: JSON.stringify({ fields: { anamnesis: { motivo_consulta: 'otro' } }, version: 0 }),  // versión vieja
  });
  add('6 · segundo PUT con versión vieja → 409', p1.status === 200 && p2.status === 409, `p1=${p1.status} p2=${p2.status}`);

  // ── 7. Audit log ──
  const audit = readFileSync(join(DATA, 'audit.log'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  const hasLoginA = audit.some(e => e.action === 'login' && e.user === idA);
  const hasCreateRec = audit.some(e => e.action === 'create' && e.user === idA && e.rec === recA);
  const hasEdit = audit.some(e => (e.action === 'edit' || e.action === 'sign') && e.user === idA && e.rec === recA);
  const noPiiInAudit = !audit.some(e => JSON.stringify(e).includes('claveA1') || JSON.stringify(e).includes('Dra A'));
  add('7 · audit log con userId correcto y sin PII',
    hasLoginA && hasCreateRec && hasEdit && noPiiInAudit,
    `login=${hasLoginA} create=${hasCreateRec} edit=${hasEdit} sinPII=${noPiiInAudit}`);

} catch (e) {
  add('ejecución', false, String(e.message));
} finally {
  srv.kill('SIGKILL');
  try { rmSync(work, { recursive: true, force: true }); } catch {}
}

function shortOk(x) { return x ? String(x).slice(0, 6) : '∅'; }

console.log('\nSprint 9 — test al goal "multiusuario + aislamiento + audit + lock":\n');
let pass = 0;
for (const r of results) {
  console.log(`  [${r.ok ? 'PASA' : 'FALLA'}]  ${r.name}\n           ${r.detail}`);
  if (r.ok) pass++;
}
console.log(`\n  ${pass}/${results.length} casos.  ${pass === results.length ? '✓ GOAL CUMPLIDO' : '✗ HAY FALLAS'}\n`);
process.exit(pass === results.length ? 0 : 1);
