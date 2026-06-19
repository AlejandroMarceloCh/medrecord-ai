// Sprint 3 — test al goal: "cada campo apunta a su evidencia real en la transcripción".
// Levanta un server propio (:3399) con una grabación sintética que trae `sources` verificados
// y comprueba en Chromium que el hover resalta la CITA EXACTA del LLM, no un párrafo por keyword.
//
// Uso: node test/sprint3_evidence.mjs   (no necesita Ollama)
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const PORT = 3399;
const BASE = `http://localhost:${PORT}`;
const DIR = join(process.cwd(), 'data', 'recordings');
const ID = 'sprint3-demo';
const SIDECAR = join(DIR, ID + '.json');

const TRANSCRIPT =
  'Paciente varón de 54 años. Refiere dolor torácico opresivo desde hace dos días. ' +
  'Al examen se encuentra presión arterial de 150 sobre 95 milímetros de mercurio. ' +
  'Se diagnostica angina de pecho estable. Se indica aspirina 100 miligramos al día.';

const SOURCES = {
  'anamnesis.motivo_consulta':            'dolor torácico opresivo desde hace dos días',
  'examen_fisico.presion_arterial':       'presión arterial de 150 sobre 95 milímetros de mercurio',
  'impresion_diagnostica.diagnosticos':   'Se diagnostica angina de pecho estable',
  'plan.tratamiento':                     'Se indica aspirina 100 miligramos al día',
};

const now = Date.now();
const demo = {
  id: ID, patient: { name: 'Sprint3 Demo', dni: '' }, durationSec: 12,
  status: 'reviewed', transcript: TRANSCRIPT,
  fields: {
    filiacion: { nombre: 'Sprint3 Demo' },
    anamnesis: { motivo_consulta: 'Dolor torácico opresivo, 2 días' },
    examen_fisico: { presion_arterial: '150/95 mmHg' },
    impresion_diagnostica: { diagnosticos: 'Angina de pecho estable' },
    plan: { tratamiento: 'Aspirina 100 mg/día' },
  },
  sources: SOURCES,
  error: null, fieldsError: null, reviewed: true, reviewedAt: now, createdAt: now, updatedAt: now,
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
const srv = spawn('node', ['server.js'], { env: { ...process.env, PORT: String(PORT), NODE_ENV: 'development' }, stdio: 'ignore' });

try {
  await waitHealth();
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(`${BASE}/web`);
  await page.click('button:has-text("Revisadas")');
  await page.click('text="Sprint3 Demo"');
  await page.waitForSelector('span:has-text("Transcripción")', { timeout: 10000 });

  // Hover un campo por su label y devuelve el texto resaltado (<mark>) en la transcripción.
  async function highlightFor(label) {
    await page.getByText(label, { exact: true }).first().hover();
    await page.waitForTimeout(200);
    return page.locator('mark').allInnerTexts();
  }

  const cases = [
    ['Motivo de consulta', SOURCES['anamnesis.motivo_consulta']],
    ['Presión arterial',   SOURCES['examen_fisico.presion_arterial']],
    ['Diagnósticos',       SOURCES['impresion_diagnostica.diagnosticos']],
    ['Tratamiento',        SOURCES['plan.tratamiento']],
  ];
  for (const [label, expected] of cases) {
    const marks = await highlightFor(label);
    const ok = marks.length === 1 && marks[0].trim() === expected;
    add(`hover "${label}" → cita exacta`, ok, ok ? `resalta «${expected.slice(0, 40)}…»` : `marks=${JSON.stringify(marks)}`);
  }

  // Negativo: un campo SIN fuente no resalta nada (no inventa evidencia).
  await page.getByText('Síntomas referidos', { exact: true }).first().hover();
  await page.waitForTimeout(200);
  const noMarks = await page.locator('mark').allInnerTexts();
  add('campo sin fuente → no resalta (no miente)', noMarks.length === 0, `marks=${noMarks.length}`);

  await browser.close();
} catch (e) {
  add('ejecución', false, String(e.message));
} finally {
  srv.kill('SIGKILL');
  try { rmSync(SIDECAR, { force: true }); } catch {}
}

console.log('\nSprint 3 — test al goal "evidencia real por campo":\n');
let pass = 0;
for (const r of results) { console.log(`  [${r.ok ? 'PASA' : 'FALLA'}]  ${r.name}\n           ${r.detail}`); if (r.ok) pass++; }
console.log(`\n  ${pass}/${results.length} casos.  ${pass === results.length ? '✓ GOAL CUMPLIDO' : '✗ HAY FALLAS'}\n`);
process.exit(pass === results.length ? 0 : 1);
