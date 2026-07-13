// Sprint 8 — test al goal: "human-in-the-loop: no se firma sin confirmar la IA,
// y queda traza de IA vs médico".
//
// Verifica:
//  1. Firmar (reviewed) SIN confirmar campos de IA → 409 con la lista pendiente
//  2. Confirmar solo uno → sigue 409, pendiente el otro
//  3. Confirmar todos (uno editado, otro confirmado) → 200 reviewed
//  4. El registro guarda fields_ia (original IA) y fields (editado) distinguibles
//  5. Guardar BORRADOR (sin reviewed) no exige confirmación y no marca revisada
//
// Aislado en DATA_DIR temporal. No necesita Ollama.
// Uso: node test/sprint8_clinical_safety.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 3403;
const BASE = `http://localhost:${PORT}`;
const work = mkdtempSync(join(tmpdir(), 'medrec-s8-'));
const DATA = join(work, 'recordings');
const KEY  = join(work, 'master.key');
mkdirSync(DATA, { recursive: true });

const ID = 's8-demo';
const AI_PA  = 'examen_fisico.presion_arterial';
const AI_DX  = 'impresion_diagnostica.diagnosticos';
const baseFields = () => ({
  examen_fisico: { presion_arterial: '120/80', frecuencia_cardiaca: '', temperatura: '', peso_talla: '', saturacion: '', hallazgos: '' },
  impresion_diagnostica: { diagnosticos: 'cefalea tensional', cie10: '' },
});
// Sidecar legacy en claro (el server lo migra a cifrado al cargar).
writeFileSync(join(DATA, ID + '.json'), JSON.stringify({
  id: ID, patient: { name: 'Paciente Test', dni: '' }, durationSec: 10, status: 'done',
  transcript: 'PA 120/80, impresión cefalea tensional.',
  fields: baseFields(), fields_ia: baseFields(), confirmed: [],
  sources: null, error: null, fieldsError: null, reviewed: false,
  createdAt: Date.now(), updatedAt: Date.now(),
}));
// Registro aparte, NUNCA firmado, para probar el guardado de borrador.
const ID_DRAFT = 's8-draft';
writeFileSync(join(DATA, ID_DRAFT + '.json'), JSON.stringify({
  id: ID_DRAFT, patient: { name: 'Borrador', dni: '' }, durationSec: 10, status: 'done',
  transcript: 't', fields: baseFields(), fields_ia: baseFields(), confirmed: [],
  reviewed: false, createdAt: Date.now(), updatedAt: Date.now(),
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
const put = (body) => fetch(`${BASE}/api/recordings/${ID}/fields`, {
  method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

const srv = spawn('node', ['server.js'], {
  env: { ...process.env, MEDRECORD_OPEN: '1', PORT: String(PORT), NODE_ENV: 'development', MEDRECORD_DATA_DIR: DATA, MEDRECORD_KEY_FILE: KEY },
  stdio: 'ignore',
});

try {
  await waitHealth();

  // ── 1. Firmar sin confirmar nada → 409 + pending con ambos campos de IA ──
  const r1 = await put({ fields: baseFields(), reviewed: true, confirmed: [] });
  const b1 = await r1.json().catch(()=>({}));
  const has = (arr, k) => Array.isArray(arr) && arr.includes(k);
  add('1 · firmar sin confirmar → 409',
    r1.status === 409 && has(b1.pending, AI_PA) && has(b1.pending, AI_DX),
    `status=${r1.status} pending=${JSON.stringify(b1.pending)}`);

  // ── 2. Confirmar solo PA → sigue 409, pendiente DX ──
  const r2 = await put({ fields: baseFields(), reviewed: true, confirmed: [AI_PA] });
  const b2 = await r2.json().catch(()=>({}));
  add('2 · confirmar parcial → 409 con el resto',
    r2.status === 409 && has(b2.pending, AI_DX) && !has(b2.pending, AI_PA),
    `status=${r2.status} pending=${JSON.stringify(b2.pending)}`);

  // ── 3. Editar DX (cuenta como atender) + confirmar ambos → 200 reviewed ──
  const edited = baseFields();
  edited.impresion_diagnostica.diagnosticos = 'cefalea tensional + descartar migraña';   // el médico corrige
  const r3 = await put({ fields: edited, reviewed: true, confirmed: [AI_PA, AI_DX] });
  const b3 = await r3.json().catch(()=>({}));
  add('3 · confirmar todos → 200 reviewed',
    r3.status === 200 && b3.reviewed === true && b3.status === 'reviewed',
    `status=${r3.status} reviewed=${b3.reviewed}`);

  // ── 4. Traza: fields_ia original ≠ fields editado, ambos presentes ──
  const got = await (await fetch(`${BASE}/api/recordings/${ID}`)).json();
  const iaDx   = got.fields_ia?.impresion_diagnostica?.diagnosticos;
  const finalDx = got.fields?.impresion_diagnostica?.diagnosticos;
  add('4 · fields_ia (IA) vs fields (médico) distinguibles',
    iaDx === 'cefalea tensional' && finalDx === 'cefalea tensional + descartar migraña' && iaDx !== finalDx,
    `ia="${iaDx}" final="${finalDx}"`);

  // ── 5. Borrador (sin reviewed) no exige confirmación — sobre un registro NO firmado ──
  const r5 = await fetch(`${BASE}/api/recordings/${ID_DRAFT}/fields`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: edited, confirmed: [] }),   // sin reviewed
  });
  add('5 · borrador sin reviewed → 200 (no exige confirmar)',
    r5.status === 200, `status=${r5.status}`);

} catch (e) {
  add('ejecución', false, String(e.message));
} finally {
  srv.kill('SIGKILL');
  try { rmSync(work, { recursive: true, force: true }); } catch {}
}

console.log('\nSprint 8 — test al goal "human-in-the-loop + traza IA vs médico":\n');
let pass = 0;
for (const r of results) {
  console.log(`  [${r.ok ? 'PASA' : 'FALLA'}]  ${r.name}\n           ${r.detail}`);
  if (r.ok) pass++;
}
console.log(`\n  ${pass}/${results.length} casos.  ${pass === results.length ? '✓ GOAL CUMPLIDO' : '✗ HAY FALLAS'}\n`);
process.exit(pass === results.length ? 0 : 1);
