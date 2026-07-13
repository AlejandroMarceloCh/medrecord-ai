// Sprint 13 — test al goal: "sobrevive corrupción/reinicios sin perder datos en
// silencio; login no DoS-able; pipeline LLM más barato/honesto".
//
// Reales:
//  1. Sidecar corrupto → cuarentena (.corrupt), las grabaciones buenas igual cargan
//  2. Login: tras N fallos → 429; otro usuario no queda bloqueado
//  3. llm.available(): match estricto (qwen2.5:3b NO cuenta como qwen2.5:7b)
//  4. crypto.writeEncrypted sigue siendo round-trip (con fsync)
// Smoke (wiring sobre el fuente):
//  5. resume serializado, keep_alive de Ollama, default de Whisper turbo
//
// Uso: node test/sprint13_robustez.mjs   (no necesita Ollama)
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
const jpost = (base, path, body) => realFetch(`${base}${path}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

// ── Server 1: cuarentena de corrupto (abierto, sin usuarios) ──
const w1 = mkdtempSync(join(tmpdir(), 'medrec-s13a-'));
const D1 = join(w1, 'recordings'); mkdirSync(D1, { recursive: true });
writeFileSync(join(D1, 'corrupt-one.json'), '{esto no es json ni descifrable');
writeFileSync(join(D1, 'good-rec.json'), JSON.stringify({ id: 'good-rec', patient: { name: 'Buena' }, status: 'reviewed', reviewed: true, createdAt: Date.now() }));

const srv1 = spawn('node', ['server.js'], {
  env: { ...process.env, PORT: '3408', NODE_ENV: 'development', MEDRECORD_OPEN: '1', MEDRECORD_DATA_DIR: D1, MEDRECORD_KEY_FILE: join(w1, '.key') },
  stdio: 'ignore',
});
try {
  await waitHealth('http://localhost:3408');
  const quarantined = existsSync(join(D1, 'corrupt-one.json.corrupt')) && !existsSync(join(D1, 'corrupt-one.json'));
  const good = await (await realFetch('http://localhost:3408/api/recordings/good-rec')).json();
  add('1 · sidecar corrupto en cuarentena, buenas cargan',
    quarantined && good && good.patient && good.patient.name === 'Buena',
    `quarantined=${quarantined} good=${good?.patient?.name}`);
} catch (e) { add('1 · cuarentena', false, String(e.message)); }
finally { srv1.kill('SIGKILL'); }

// ── Server 2: throttle de login ──
const w2 = mkdtempSync(join(tmpdir(), 'medrec-s13b-'));
const srv2 = spawn('node', ['server.js'], {
  env: { ...process.env, PORT: '3409', NODE_ENV: 'development',
         MEDRECORD_DATA_DIR: join(w2, 'recordings'), MEDRECORD_KEY_FILE: join(w2, '.key'),
         MEDRECORD_ADMIN_USER: 'admin', MEDRECORD_ADMIN_PASS: 'secreto123',
         LOGIN_MAX_FAILS: '3', LOGIN_LOCK_MS: '3000' },
  stdio: 'ignore',
});
try {
  await waitHealth('http://localhost:3409');
  const codes = [];
  for (let i = 0; i < 3; i++) codes.push((await jpost('http://localhost:3409', '/api/login', { username: 'admin', password: 'malo' })).status);
  const locked = (await jpost('http://localhost:3409', '/api/login', { username: 'admin', password: 'malo' })).status;       // 4º → 429
  const lockedEvenIfRight = (await jpost('http://localhost:3409', '/api/login', { username: 'admin', password: 'secreto123' })).status; // bloqueado aunque acierte
  const otherUser = (await jpost('http://localhost:3409', '/api/login', { username: 'otro', password: 'x' })).status;          // otro user no bloqueado → 401
  add('2 · login throttle → 429 tras N fallos (otro user libre)',
    codes.every(c => c === 401) && locked === 429 && lockedEvenIfRight === 429 && otherUser === 401,
    `fails=${codes} locked=${locked} aunqueAcierte=${lockedEvenIfRight} otro=${otherUser}`);
} catch (e) { add('2 · throttle', false, String(e.message)); }
finally { srv2.kill('SIGKILL'); }

// ── 3. llm.available() match estricto (stub de fetch) ──
try {
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ models: [{ name: 'qwen2.5:3b' }] }) });
  const llm = require('../llm.js');   // MODEL por defecto = qwen2.5:7b
  const only3b = await llm.available();
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ models: [{ name: 'qwen2.5:7b' }] }) });
  const has7b = await llm.available();
  add('3 · available() estricto (3b ≠ 7b)', only3b === false && has7b === true, `only3b=${only3b} has7b=${has7b}`);
} catch (e) { add('3 · available estricto', false, String(e.message)); }
finally { globalThis.fetch = realFetch; }

// ── 4. writeEncrypted round-trip (con fsync) ──
try {
  const w4 = mkdtempSync(join(tmpdir(), 'medrec-s13c-'));
  process.env.MEDRECORD_KEY_FILE = join(w4, '.key');
  const enc = require('../crypto.js');
  const dest = join(w4, 'x.bin');
  enc.writeEncrypted(dest, JSON.stringify({ hola: 'mundo' }));
  const back = JSON.parse(enc.readEncrypted(dest).toString());
  add('4 · writeEncrypted round-trip con fsync', back.hola === 'mundo', `back=${back.hola}`);
  rmSync(w4, { recursive: true, force: true });
} catch (e) { add('4 · writeEncrypted', false, String(e.message)); }

// ── 5. Smoke de wiring ──
const crypto = src('crypto.js'), server = src('server.js'), llmSrc = src('llm.js'), whisper = src('whisper.js');
add('5 · fsync en writeEncrypted', /fsyncSync/.test(crypto), 'fsyncSync presente');
add('5b · resume serializado (for await)', server.includes('toResume') && /for\s*\(const rec of toResume\)/.test(server), 'toResume + for await');
add('5c · keep_alive de Ollama', llmSrc.includes('keep_alive'), 'keep_alive presente');
add('5d · Whisper prefiere turbo si existe', whisper.includes('defaultModel') && whisper.includes('large-v3-turbo'), 'defaultModel + turbo');

try { rmSync(w1, { recursive: true, force: true }); rmSync(w2, { recursive: true, force: true }); } catch {}

console.log('\nSprint 13 — test al goal "robustez operativa + costo del pipeline":\n');
let pass = 0;
for (const r of results) {
  console.log(`  [${r.ok ? 'PASA' : 'FALLA'}]  ${r.name}\n           ${r.detail}`);
  if (r.ok) pass++;
}
console.log(`\n  ${pass}/${results.length} casos.  ${pass === results.length ? '✓ GOAL CUMPLIDO' : '✗ HAY FALLAS'}\n`);
process.exit(pass === results.length ? 0 : 1);
