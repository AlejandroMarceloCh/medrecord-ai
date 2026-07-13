// Sprint 4 — test al goal: "el médico exporta la consulta firmada en un click".
// Levanta un server propio (:3399) con una consulta revisada y completa, y verifica:
//  - el botón Exportar aparece, - en modo impresión solo se ve la historia (PrintDoc) con
//    todas las secciones + anexo de transcripción, - se genera un PDF real y legible.
//
// Uso: node test/sprint4_export.mjs   (no necesita Ollama)
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { writeFileSync, rmSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const PORT = 3399;
const BASE = `http://localhost:${PORT}`;
const DIR = join(process.cwd(), 'data', 'recordings');
const ID = 'sprint4-demo';
const SIDECAR = join(DIR, ID + '.json');
const PDF = '/tmp/sprint4_export.pdf';

const TRANSCRIPT =
  'Paciente mujer de 47 años, comerciante. Refiere cefalea tensional de una semana. ' +
  'Presión arterial 120 sobre 80, frecuencia cardíaca 72, temperatura 36.7 grados. ' +
  'Antecedente de migraña. Se indica paracetamol 1 gramo cada 8 horas y control en dos semanas.';

const now = Date.now();
const demo = {
  id: ID, patient: { name: 'Lucía Fernández', dni: '70654321' }, durationSec: 18,
  status: 'reviewed', transcript: TRANSCRIPT,
  fields: {
    filiacion: { nombre: 'Lucía Fernández', documento: '70654321', sexo: 'Femenino', ocupacion: 'Comerciante', fecha_consulta: '14 de junio de 2026' },
    anamnesis: { motivo_consulta: 'Cefalea tensional', tiempo_enfermedad: '1 semana', sintomas: 'Dolor de cabeza opresivo', antecedentes_personales: 'Migraña' },
    examen_fisico: { presion_arterial: '120/80 mmHg', frecuencia_cardiaca: '72 lpm', temperatura: '36.7 °C', saturacion: '98%' },
    impresion_diagnostica: { diagnosticos: 'Cefalea tensional', cie10: 'G44.2' },
    plan: { tratamiento: 'Paracetamol 1 g cada 8 horas', indicaciones: 'Control en dos semanas' },
  },
  sources: {}, error: null, fieldsError: null, reviewed: true, reviewedAt: now, createdAt: now, updatedAt: now,
};

const SECTION_TITLES = ['Filiación', 'Anamnesis', 'Examen físico', 'Impresión diagnóstica', 'Plan / Indicaciones'];
const VALUES_EXPECTED = ['Lucía Fernández', 'Cefalea tensional', '120/80 mmHg', 'G44.2', 'Control en dos semanas'];

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
const srv = spawn('node', ['server.js'], { env: { ...process.env, MEDRECORD_OPEN: '1', PORT: String(PORT), NODE_ENV: 'development' }, stdio: 'ignore' });

try {
  await waitHealth();
  const browser = await chromium.launch();
  const ctx = await browser.newContext();
  // Diccionario activo: la corrección debe llegar también al PDF (Sprint 2 ↦ export).
  await ctx.addInitScript(() => localStorage.setItem('medrecord.dict', JSON.stringify([{ wrong: 'paracetamol', right: 'PARACETAMOLOK' }])));
  const page = await ctx.newPage();
  await page.goto(`${BASE}/web`);
  await page.click('button:has-text("Revisadas")');
  await page.click('text="Lucía Fernández"');
  await page.waitForSelector('span:has-text("Transcripción")', { timeout: 10000 });

  // 1. Botón Exportar visible
  const btn = await page.getByRole('button', { name: /Exportar/ }).isVisible().catch(() => false);
  add('1 · botón "Exportar" visible en la consulta', btn, btn ? 'presente' : 'no aparece');

  // 2. En modo impresión: solo se ve la historia clínica (PrintDoc); la UI de pantalla se oculta
  await page.emulateMedia({ media: 'print' });
  const printVisible  = await page.locator('.print-doc').isVisible();
  const screenHidden  = !(await page.locator('span:has-text("Transcripción")').first().isVisible());
  add('2 · en impresión solo se ve la historia clínica', printVisible && screenHidden,
    `print-doc visible=${printVisible}, UI de pantalla oculta=${screenHidden}`);

  // 3. La historia trae todas las secciones + valores + anexo + corrección del diccionario
  // textContent (texto crudo del DOM) — innerText devolvería los títulos en MAYÚSCULA por el text-transform.
  const docText = await page.locator('.print-doc').textContent();
  const missSec = SECTION_TITLES.filter(t => !docText.includes(t));
  const missVal = VALUES_EXPECTED.filter(v => !docText.includes(v));
  const hasAnexo = docText.includes('Anexo') && docText.includes('cefalea tensional de una semana');
  const dictApplied = docText.includes('PARACETAMOLOK');
  const ok3 = !missSec.length && !missVal.length && hasAnexo && dictApplied;
  add('3 · contenido completo (secciones + valores + anexo + diccionario)', ok3,
    `faltan secciones=${missSec.length}, faltan valores=${missVal.length}, anexo=${hasAnexo}, diccionario=${dictApplied}`);

  // 4. Genera un PDF real, no vacío, con cabecera %PDF
  await page.pdf({ path: PDF, format: 'A4', printBackground: true });
  const size = statSync(PDF).size;
  const header = readFileSync(PDF).subarray(0, 5).toString();
  const ok4 = size > 3000 && header === '%PDF-';
  add('4 · genera un PDF real', ok4, `${size} bytes, cabecera=${header}`);

  await browser.close();
} catch (e) {
  add('ejecución', false, String(e.message));
} finally {
  srv.kill('SIGKILL');
  try { rmSync(SIDECAR, { force: true }); } catch {}
  try { rmSync(PDF, { force: true }); } catch {}
}

console.log('\nSprint 4 — test al goal "exportar la consulta en un click":\n');
let pass = 0;
for (const r of results) { console.log(`  [${r.ok ? 'PASA' : 'FALLA'}]  ${r.name}\n           ${r.detail}`); if (r.ok) pass++; }
console.log(`\n  ${pass}/${results.length} casos.  ${pass === results.length ? '✓ GOAL CUMPLIDO' : '✗ HAY FALLAS'}\n`);
process.exit(pass === results.length ? 0 : 1);
