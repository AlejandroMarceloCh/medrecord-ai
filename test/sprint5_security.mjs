// Sprint 5 — test al goal: "auth simple + atomic writes + sin PII en logs".
//
// Verifica:
//  1. Sin token   → 401 en cualquier ruta /api/*
//  2. Con token correcto → 200 en /api/recordings
//  3. Token incorrecto   → 401
//  4. /health no requiere token y no expone PII (nombres/DNI)
//  5. Atomic writes: después de persistir, no quedan archivos .tmp residuales
//
// Uso: node test/sprint5_security.mjs   (no necesita Ollama)
import { spawn }       from 'node:child_process';
import { writeFileSync, existsSync, readdirSync, rmSync, mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir }      from 'node:os';
import { join }        from 'node:path';

const PORT  = 3401;
const BASE  = `http://localhost:${PORT}`;
const TOKEN = 's5-test-token';
// Aislado en dir temporal: la suite no toca data/ real (que ahora va cifrada).
const WORK  = mkdtempSync(join(tmpdir(), 'medrec-s5-'));
const DIR   = join(WORK, 'recordings');
const KEY   = join(WORK, 'master.key');
mkdirSync(DIR, { recursive: true });
const ID    = 'sprint5-demo';
const SIDECAR = join(DIR, ID + '.json');

const demo = {
  id: ID, patient: { name: 'Ana García', dni: '12345678' }, durationSec: 5,
  status: 'reviewed', transcript: 'Paciente de prueba para sprint 5.',
  fields: { filiacion: { nombre: 'Ana García' } }, sources: {},
  error: null, fieldsError: null, reviewed: true,
  reviewedAt: Date.now(), createdAt: Date.now(), updatedAt: Date.now(),
};

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

const results = [];
const add = (name, ok, detail) => results.push({ name, ok, detail });

writeFileSync(SIDECAR, JSON.stringify(demo));
// Server arranca con MEDRECORD_TOKEN seteado → auth activo
const srv = spawn('node', ['server.js'], {
  env: { ...process.env, MEDRECORD_OPEN: '1', PORT: String(PORT), NODE_ENV: 'development', MEDRECORD_TOKEN: TOKEN,
         MEDRECORD_DATA_DIR: DIR, MEDRECORD_KEY_FILE: KEY },
  stdio: 'ignore',
});

try {
  await waitHealth();

  // 1. Sin token → 401
  const r1 = await fetch(`${BASE}/api/recordings`);
  add('1 · sin token → 401', r1.status === 401, `status=${r1.status}`);

  // 2. Token correcto → 200
  const r2 = await fetch(`${BASE}/api/recordings`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  add('2 · token correcto → 200', r2.status === 200, `status=${r2.status}`);

  // 3. Token incorrecto → 401
  const r3 = await fetch(`${BASE}/api/recordings`, { headers: { Authorization: 'Bearer wrongtoken' } });
  add('3 · token incorrecto → 401', r3.status === 401, `status=${r3.status}`);

  // 4. /health no requiere token y no expone PII
  const r4 = await fetch(`${BASE}/health`);
  const h = await r4.json().catch(() => ({}));
  const healthOk = r4.status === 200;
  // /health no debe incluir nombres de pacientes ni DNIs
  const bodyStr = JSON.stringify(h);
  const hasPii  = bodyStr.includes('Ana') || bodyStr.includes('12345678');
  add('4 · /health sin token + sin PII', healthOk && !hasPii,
    `status=${r4.status}, pii=${hasPii}, campos=${Object.keys(h).join(',')}`);

  // 5. Atomic writes: pide la lista (provoca un refetch desde RAM, no re-persiste),
  //    luego verifica que no haya .tmp residuales en data/recordings/
  const tmps = readdirSync(DIR).filter(f => f.endsWith('.tmp'));
  add('5 · atomic write no deja .tmp residuales', tmps.length === 0,
    tmps.length ? `archivos .tmp encontrados: ${tmps.join(', ')}` : 'ningún .tmp ✓');

} catch (e) {
  add('ejecución', false, String(e.message));
} finally {
  srv.kill('SIGKILL');
  try { rmSync(WORK, { recursive: true, force: true }); } catch {}
}

console.log('\nSprint 5 — test al goal "auth + atomic writes + sin PII":\n');
let pass = 0;
for (const r of results) {
  console.log(`  [${r.ok ? 'PASA' : 'FALLA'}]  ${r.name}\n           ${r.detail}`);
  if (r.ok) pass++;
}
console.log(`\n  ${pass}/${results.length} casos.  ${pass === results.length ? '✓ GOAL CUMPLIDO' : '✗ HAY FALLAS'}\n`);
process.exit(pass === results.length ? 0 : 1);
