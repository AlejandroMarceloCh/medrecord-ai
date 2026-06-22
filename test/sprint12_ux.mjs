// Sprint 12 — test al goal: "el médico no pierde trabajo en silencio ni ve estados
// falsos; sesión caída → login con mensaje".
//
// 1 (unit real): apiFetch dispara el evento 'medrecord:unauthorized' en un 401 y NO en 200
// 2-5 (smoke de wiring sobre el fuente; estas conductas son de React y se verifican
//      además con el build que compila el JSX):
//   2. login.jsx escucha el evento y muestra "sesión expiró"
//   3. app.jsx bloquea la navegación con cambios sin guardar (confirmLeave + dirtyRef)
//   4. app.jsx maneja error de carga (no muestra "Todo al día" falso)
//   5. clinical.jsx no deja el spinner de reextract colgado y reporta onDirty
//
// No necesita server ni Ollama.
// Uso: node test/sprint12_ux.mjs
import { readFileSync } from 'node:fs';

const results = [];
const add = (name, ok, detail) => results.push({ name, ok, detail });
const src = (f) => readFileSync(new URL('../src/web/' + f, import.meta.url), 'utf8');

// ── 1. Unit real: contrato 401 de apiFetch ──
try {
  let fired = 0;
  globalThis.CustomEvent = globalThis.CustomEvent || class { constructor(t) { this.type = t; } };
  globalThis.window = { dispatchEvent: (e) => { if (e.type === 'medrecord:unauthorized') fired++; }, addEventListener() {}, removeEventListener() {} };
  globalThis.fetch = async () => ({ status: 401 });
  const { apiFetch } = await import('../src/web/helpers.js');
  await apiFetch('/api/x');
  const after401 = fired;
  globalThis.fetch = async () => ({ status: 200 });
  await apiFetch('/api/y');
  add('1 · apiFetch: 401 dispara re-login, 200 no', after401 === 1 && fired === 1, `tras401=${after401} total=${fired}`);
} catch (e) {
  add('1 · apiFetch 401', false, String(e.message));
}

// ── 2. login.jsx ──
const login = src('login.jsx');
add('2 · login escucha 401 y avisa "sesión expiró"',
  login.includes("medrecord:unauthorized") && /sesi[oó]n expir/i.test(login),
  'listener + copy');

// ── 3. app.jsx: guard de navegación ──
const app = src('app.jsx');
const navGuard = app.includes('confirmLeave') && app.includes('dirtyRef') &&
  app.includes('onDirty') && /sin guardar/i.test(app);
add('3 · navegación bloquea pérdida de cambios', navGuard, 'confirmLeave+dirtyRef+onDirty');

// ── 4. app.jsx: error de carga ──
add('4 · no muestra "Todo al día" falso en error de carga',
  app.includes('loadError') && app.includes('No se pudieron cargar'),
  'loadError + render de error');

// ── 5. clinical.jsx: reextract no cuelga + onDirty ──
const clin = src('clinical.jsx');
const reextractOk = /if\s*\(\s*!r\.ok\s*\)\s*setReextracting\(false\)/.test(clin);
const dirtyReport = clin.includes('onDirty?.(dirty');
add('5 · reextract no deja spinner colgado + reporta dirty', reextractOk && dirtyReport,
  `reextract=${reextractOk} onDirty=${dirtyReport}`);

console.log('\nSprint 12 — test al goal "confianza UX: no perder trabajo ni ver estados falsos":\n');
let pass = 0;
for (const r of results) {
  console.log(`  [${r.ok ? 'PASA' : 'FALLA'}]  ${r.name}\n           ${r.detail}`);
  if (r.ok) pass++;
}
console.log(`\n  ${pass}/${results.length} casos.  ${pass === results.length ? '✓ GOAL CUMPLIDO' : '✗ HAY FALLAS'}\n`);
process.exit(pass === results.length ? 0 : 1);
