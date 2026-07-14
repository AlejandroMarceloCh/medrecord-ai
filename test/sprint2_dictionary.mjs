// Sprint 2 — test al goal: "que lo visible no mienta".
//  (1) El diccionario médico REESCRIBE de verdad la transcripción al mostrarla.
//  (2) El "linked evidence" falso (keyword matching) fue removido del código.
//
// Uso: con el server corriendo en :3331  →  node test/sprint2_dictionary.mjs
import { chromium } from 'playwright';
import { levantarServer } from './_server.mjs';
import { readFileSync } from 'node:fs';

// Autónomo: levanta su propio server (antes exigía uno en :3331 y por eso nunca
// corría en `npm test` — así fue como el Sprint 18 lo rompió sin que nadie lo viera).
const servidor = process.env.BASE ? null : await levantarServer({
  // El test necesita una historia revisada con transcripción. Se siembra, en vez de
  // depender de que haya consultas reales de pacientes en el disco del desarrollador.
  async seed(dataDir, keyFile) {
    process.env.MEDRECORD_KEY_FILE = keyFile;
    const { createRequire } = await import('node:module');
    const { join } = await import('node:path');
    const req = createRequire(import.meta.url);
    delete req.cache[req.resolve('../crypto.js')];
    const enc = req('../crypto.js');
    enc.writeEncrypted(join(dataDir, 'seed-dict.json'), JSON.stringify({
      id: 'seed-dict', patient: { name: 'Prueba Diccionario', dni: '' },
      status: 'reviewed', reviewed: true, reviewedAt: Date.now(),
      transcript: 'El paciente refiere cefalea intensa y presenta hipertension arterial marcada en el examen.',
      fields: { anamnesis: { motivo_consulta: 'cefalea' } },
      consent: { granted: true, at: Date.now() }, version: 1,
      createdAt: Date.now(), updatedAt: Date.now(),
    }));
    delete process.env.MEDRECORD_KEY_FILE;
  },
});
const BASE = process.env.BASE || servidor.base;
const RIGHT = 'DICCIONARIOOK';
const results = [];
const rec = (name, ok, detail) => results.push({ name, ok, detail });

// ── 1. Diccionario aplicado en la transcripción (runtime, navegador real) ─────
try {
  const list = await (await fetch(`${BASE}/api/recordings`)).json();
  const target = list.find(r => r.status === 'reviewed' && r.transcript && r.transcript.length > 40);
  if (!target) throw new Error('no hay grabación revisada con transcripción para probar');

  const nameLow = (target.patient?.name || '').toLowerCase();
  const words = target.transcript.toLowerCase().match(/[a-z]{6,12}/g) || [];
  const wrong = words.find(w => !nameLow.includes(w));
  if (!wrong) throw new Error('no encontré una palabra usable en la transcripción');

  const browser = await chromium.launch();
  const ctx = await browser.newContext();
  // Siembra el diccionario ANTES de que cargue la app.
  await ctx.addInitScript(arg => localStorage.setItem('medrecord.dict', JSON.stringify([{ wrong: arg.w, right: arg.r }])), { w: wrong, r: RIGHT });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/web`);

  // Sin pendientes, la app arranca en modo foco ("Todo al día"), no en el listado: hay que
  // entrar a Consultas antes de que exista el tab de Revisadas.
  await page.click('button:has-text("Consultas")');
  await page.click('button:has-text("Revisadas")');
  await page.click(`text=${JSON.stringify(target.patient.name)}`);
  await page.waitForSelector('span:has-text("Transcripción")', { timeout: 10000 });
  await page.waitForTimeout(300);

  // Lee SOLO el panel de transcripción (sin labels de campos).
  const tscript = await page.evaluate(() => {
    const hdr = [...document.querySelectorAll('span')].find(s => s.textContent === 'Transcripción');
    const panel = hdr ? hdr.closest('div').parentElement : null;
    return panel ? panel.innerText : '';
  });
  await browser.close();

  const hasRight = tscript.includes(RIGHT);
  const noWrong  = !new RegExp('\\b' + wrong + '\\b', 'i').test(tscript);
  rec('1 · el diccionario reescribe la transcripción', hasRight && noWrong,
    `"${wrong}" → "${RIGHT}": aparece corregido=${hasRight}, queda algún "${wrong}"=${!noWrong ? 'SÍ(mal)' : 'no ✓'}`);
} catch (e) { rec('1 · diccionario reescribe la transcripción', false, String(e.message)); }

// ── 2. El keyword-matching falso fue removido del código ──────────────────────
// (El linked-evidence REAL del Sprint 3 usa rec.sources, no estos símbolos del fake.)
try {
  const src = readFileSync(new URL('../src/web/transcript.jsx', import.meta.url), 'utf8');
  const dead = ['keywordMap', 'getFieldId'].filter(t => src.includes(t));
  rec('2 · keyword-matching falso removido', dead.length === 0,
    dead.length ? 'aún aparece: ' + dead.join(', ') : 'sin keyword-matching fingido ✓');
} catch (e) { rec('2 · keyword-matching falso removido', false, String(e.message)); }

console.log('\nSprint 2 — test al goal "que lo visible no mienta":\n');
let pass = 0;
for (const r of results) { console.log(`  [${r.ok ? 'PASA' : 'FALLA'}]  ${r.name}\n           ${r.detail}`); if (r.ok) pass++; }
console.log(`\n  ${pass}/${results.length} casos.  ${pass === results.length ? '✓ GOAL CUMPLIDO' : '✗ HAY FALLAS'}\n`);
if (servidor) servidor.cerrar();
process.exit(pass === results.length ? 0 : 1);
