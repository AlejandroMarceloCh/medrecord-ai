// Sprint 11 — test al goal: "una historia firmada es inmutable y canónica;
// el PDF declara IA + firma".
//
// Verifica:
//  1. retry sobre un registro firmado → 409 (no lo destruye)
//  2. reextract sobre un registro firmado → 409
//  3. PUT con claves fuera de esquema → se descartan; se conservan las canónicas
//  4. Al firmar, el registro expone reviewedAt (dato que usa la atestación del PDF)
//  5. PrintDoc declara asistencia por IA y estado de firma (smoke sobre el fuente)
//
// Aislado en DATA_DIR temporal. No necesita Ollama.
// Uso: node test/sprint11_integridad.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 3407;
const BASE = `http://localhost:${PORT}`;
const work = mkdtempSync(join(tmpdir(), 'medrec-s11-'));
const DATA = join(work, 'recordings');
const KEY  = join(work, '.master.key');
mkdirSync(DATA, { recursive: true });

// Registro YA firmado (inmutable).
writeFileSync(join(DATA, 's11-signed.json'), JSON.stringify({
  id: 's11-signed', patient: { name: 'Firmado', dni: '' }, status: 'reviewed',
  transcript: 'consulta firmada', audioFile: 's11-signed.audio', reviewed: true,
  reviewedAt: Date.now(), createdAt: Date.now(), updatedAt: Date.now(),
}));
// Borrador para probar normalización de campos.
writeFileSync(join(DATA, 's11-draft.json'), JSON.stringify({
  id: 's11-draft', patient: { name: 'Borrador', dni: '' }, status: 'done',
  transcript: 't', fields: null, fields_ia: null, reviewed: false,
  createdAt: Date.now(), updatedAt: Date.now(),
}));

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

const srv = spawn('node', ['server.js'], {
  env: { ...process.env, MEDRECORD_OPEN: '1', PORT: String(PORT), NODE_ENV: 'development', MEDRECORD_DATA_DIR: DATA, MEDRECORD_KEY_FILE: KEY },
  stdio: 'ignore',
});

try {
  await waitHealth();

  // ── 1/2. Firmado es inmutable ──
  const retry = await fetch(`${BASE}/api/recordings/s11-signed/retry`, { method: 'POST' });
  add('1 · retry sobre firmado → 409', retry.status === 409, `status=${retry.status}`);
  const reext = await fetch(`${BASE}/api/recordings/s11-signed/reextract`, { method: 'POST' });
  add('2 · reextract sobre firmado → 409', reext.status === 409, `status=${reext.status}`);

  // ── 3/4. Normalización de campos + reviewedAt ──
  const put = await fetch(`${BASE}/api/recordings/s11-draft/fields`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      fields: { anamnesis: { motivo_consulta: 'cefalea', JUNK: 'x' }, BOGUS: { a: 'b' } },
      reviewed: true,
    }),
  });
  const saved = await put.json().catch(() => ({}));
  const f = saved.fields || {};
  const keptCanonical = f.anamnesis && f.anamnesis.motivo_consulta === 'cefalea';
  const droppedJunk = f.anamnesis && !('JUNK' in f.anamnesis) && !('BOGUS' in f);
  add('3 · claves fuera de esquema descartadas, canónicas conservadas',
    keptCanonical && droppedJunk,
    `motivo=${f.anamnesis?.motivo_consulta} JUNK=${f.anamnesis && ('JUNK' in f.anamnesis)} BOGUS=${'BOGUS' in f}`);
  add('4 · firmar expone reviewedAt', typeof saved.reviewedAt === 'number' && saved.reviewed === true,
    `reviewedAt=${typeof saved.reviewedAt} reviewed=${saved.reviewed}`);

  // ── 5. Atestación en el PDF (smoke sobre el fuente) ──
  const src = readFileSync(new URL('../src/web/clinical.jsx', import.meta.url), 'utf8');
  const hasAttest = src.includes('asistencia de IA') && /firmad/i.test(src) && src.includes('rec.reviewedAt');
  add('5 · PrintDoc declara IA + firma', hasAttest, hasAttest ? 'presente' : 'falta atestación en PrintDoc');

} catch (e) {
  add('ejecución', false, String(e.message));
} finally {
  srv.kill('SIGKILL');
  try { rmSync(work, { recursive: true, force: true }); } catch {}
}

console.log('\nSprint 11 — test al goal "historia firmada inmutable y canónica + atestación":\n');
let pass = 0;
for (const r of results) {
  console.log(`  [${r.ok ? 'PASA' : 'FALLA'}]  ${r.name}\n           ${r.detail}`);
  if (r.ok) pass++;
}
console.log(`\n  ${pass}/${results.length} casos.  ${pass === results.length ? '✓ GOAL CUMPLIDO' : '✗ HAY FALLAS'}\n`);
process.exit(pass === results.length ? 0 : 1);
