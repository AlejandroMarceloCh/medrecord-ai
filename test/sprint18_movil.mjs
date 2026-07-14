// Sprint 18 — test al goal: "La pantalla de grabación refleja el estado real del micrófono,
// y la app abre y graba sin conexión a internet."
//
// Autónomo: levanta su propio server y un Chromium con micrófono falso.
//
//  1. El móvil no carga NINGÚN recurso externo (antes: React dev + Babel desde unpkg)
//  2. Con la red cortada tras el primer load, la app abre igual (service worker)
//  3. El micrófono muere a mitad → la UI SALE del estado grabando y avisa (no miente)
//  4. La onda sale del micrófono real, no de una animación CSS
//  5. Grabación → los trozos se persisten en IndexedDB MIENTRAS graba (no al final)
//  6. Blob vacío → error visible, y el formulario NO se limpia (no parece un éxito)
//  7. Se puede grabar sin escribir el nombre (solo el consentimiento es obligatorio)
//
// Uso: node test/sprint18_movil.mjs
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freePort } from './_port.mjs';

const results = [];
const add = (name, ok, detail) => results.push({ name, ok, detail });
const src = (f) => readFileSync(new URL('../' + f, import.meta.url), 'utf8');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const PORT = await freePort();
const BASE = `http://localhost:${PORT}`;

// ── 1. Cero recursos externos (estático, sobre el build de producción) ──────────
try {
  if (!existsSync(new URL('../dist/mobile.html', import.meta.url))) {
    add('1 · el móvil no carga recursos externos', false, 'falta dist/: corre npm run build');
  } else {
    const html = src('dist/mobile.html');
    const js   = src('dist/mobile.js');
    // Etiquetas con src/href a un host externo (los comentarios no cuentan).
    const externos = (html.match(/(?:src|href)="https?:\/\/[^"]*"/g) || []);
    const babelEnBundle = /@babel\/standalone|transform\(/i.test(js) && js.includes('unpkg');
    add('1 · el móvil no carga recursos externos (ni React, ni Babel, ni fuentes)',
      externos.length === 0 && !babelEnBundle,
      `etiquetasExternas=${externos.length} ${externos.slice(0,2).join(' ')}`);
  }
} catch (e) { add('1 · sin recursos externos', false, String(e.message)); }

// ── Server + navegador con micrófono falso ─────────────────────────────────────
const w = mkdtempSync(join(tmpdir(), 'medrec-s18-'));
const DATA = join(w, 'recordings'); mkdirSync(DATA, { recursive: true });

const srv = spawn('node', ['server.js'], {
  env: { ...process.env, PORT: String(PORT), NODE_ENV: 'development',
    MEDRECORD_SERVE_DIST: '1',   // prueba el bundle real de producción, sin abrir producción
    MEDRECORD_OPEN: '1',
    MEDRECORD_DATA_DIR: DATA, MEDRECORD_KEY_FILE: join(w, '.key'),
    MEDRECORD_AUDIO_RETENTION_DAYS: '0' },
  stdio: 'ignore',
});

async function waitHealth(timeout = 10000) {
  const t0 = Date.now();
  for (;;) {
    try { const r = await fetch(`${BASE}/health`); if (r.ok) return; } catch {}
    if (Date.now() - t0 > timeout) throw new Error('server no levantó');
    await sleep(200);
  }
}

let browser;
try {
  await waitHealth();
  browser = await chromium.launch({
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
           '--autoplay-policy=no-user-gesture-required'],
  });
  const ctx = await browser.newContext({ permissions: ['microphone'] });

  // ── 3 + 4 + 5. Micrófono real, onda real, chunks al vuelo ────────────────────
  const page = await ctx.newPage();
  // Instrumentación SOLO del test: guardamos una referencia a los tracks que entrega
  // getUserMedia para poder matarlos a mitad de la consulta, como hace iOS cuando entra
  // una llamada. No toca el código de producción.
  await page.addInitScript(() => {
    const orig = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    window.__mrTracks = [];
    navigator.mediaDevices.getUserMedia = async (c) => {
      const s = await orig(c);
      window.__mrTracks.push(...s.getAudioTracks());
      return s;
    };
  });
  await page.goto(`${BASE}/mobile`);
  await page.waitForSelector('#mr-name', { timeout: 10000 });

  // 7. Sin nombre: solo el consentimiento habilita el botón.
  const botonSinConsent = await page.locator('button:has-text("Iniciar grabación")').isDisabled();
  await page.locator('input[type="checkbox"]').check();
  const botonConConsent = await page.locator('button:has-text("Iniciar grabación")').isEnabled();
  add('7 · se puede grabar sin nombre (solo el consentimiento es obligatorio)',
    botonSinConsent && botonConConsent,
    `sinConsent=deshabilitado(${botonSinConsent}) conConsent=habilitado(${botonConConsent})`);

  await page.locator('button:has-text("Iniciar grabación")').click();
  await page.waitForSelector('text=Grabando', { timeout: 8000 });

  // 4. La onda tiene que RESPONDER al micrófono. El dispositivo falso de Chromium emite
  //    pitidos intermitentes (~1 Hz), así que observamos una ventana de tiempo: si las
  //    barras se levantan cuando hay sonido, la onda está leyendo el micro de verdad.
  //    Una animación CSS daría alturas fijas, idénticas en todas las muestras.
  const leerBarras = () => page.$$eval('div[aria-hidden="true"] > div',
    els => els.map(e => parseFloat(e.style.height) || 0));
  const muestras = [];
  for (let i = 0; i < 16; i++) { await sleep(200); muestras.push(await leerBarras()); }

  const picoGlobal = Math.max(...muestras.flat());
  const distintas = new Set(muestras.map(m => JSON.stringify(m))).size;
  // Con sonido real, alguna barra tiene que superar claramente el piso de 4px.
  const respondeAlSonido = picoGlobal > 20 && distintas > 8;
  add('4 · la onda sale del micrófono real (responde al sonido), no de un @keyframes',
    respondeAlSonido,
    `barras=${muestras[0].length} picoMax=${picoGlobal.toFixed(0)}px muestrasDistintas=${distintas}/16`);

  // 5. Mientras sigue grabando, los trozos ya tienen que estar en IndexedDB.
  await sleep(6500);   // TROZO_MS = 5000: al menos un chunk debió persistirse
  const chunks = await page.evaluate(() => new Promise((res) => {
    const r = indexedDB.open('medrecord-queue', 2);
    r.onsuccess = () => {
      const db = r.result;
      const t = db.transaction('chunks', 'readonly').objectStore('chunks').getAll();
      t.onsuccess = () => res(t.result.map(c => ({ seq: c.seq, size: c.blob?.size || 0 })));
      t.onerror = () => res([]);
    };
    r.onerror = () => res([]);
  }));
  add('5 · los trozos se guardan MIENTRAS graba (no todo en RAM hasta el stop)',
    chunks.length >= 1 && chunks.every(c => c.size > 0),
    `chunksEnIndexedDB=${chunks.length} bytes=${chunks.reduce((a,c)=>a+c.size,0)}`);

  // 3. Matamos el micrófono a mitad de la consulta — es lo que hace iOS cuando entra una
  //    llamada. Antes la pantalla seguía diciendo "Grabando 14:32" con la onda bailando y
  //    el médico terminaba la consulta convencido de que había grabado.
  const enGrabacionAntes = await page.locator('text=Grabando').count();
  await page.evaluate(() => {
    // `stop()` no dispara onended (es una parada local), así que emitimos el evento igual
    // que lo haría el navegador al perder el dispositivo.
    for (const t of (window.__mrTracks || [])) {
      t.stop();
      t.dispatchEvent(new Event('ended'));
    }
  });
  await sleep(1200);

  const salioDeGrabando = (await page.locator('text=Grabando').count()) === 0;
  const avisa = await page.locator('text=/Se cortó el micrófono|Se interrumpió la grabación/').count();
  // Y lo grabado hasta el corte NO se pierde: tiene que quedar en la lista de la sesión.
  const enLista = await page.locator('text=Audios de esta sesión').count();
  add('3 · el micrófono muere → la UI sale de "grabando", avisa y conserva lo grabado',
    enGrabacionAntes > 0 && salioDeGrabando && avisa > 0 && enLista > 0,
    `estabaGrabando=${enGrabacionAntes>0} salió=${salioDeGrabando} avisó=${avisa>0} conservóAudio=${enLista>0}`);

  await page.close();

  // ── 6. Blob vacío → error visible y el formulario NO se limpia ───────────────
  const rec6 = src('src/mobile/recorder.jsx');
  const avisaVacio = /blob\.size === 0/.test(rec6) && /quedó vacía y no se envió/.test(rec6)
    && !/setName\(''\)[^]*?quedó vacía/.test(rec6);
  add('6 · blob vacío → error visible, no un falso éxito silencioso',
    avisaVacio, `avisaYConservaFormulario=${avisaVacio}`);

  // ── 2. Abre sin conexión (service worker) ────────────────────────────────────
  const ctx2 = await browser.newContext({ permissions: ['microphone'] });
  const p2 = await ctx2.newPage();
  await p2.goto(`${BASE}/mobile`);
  await p2.waitForSelector('#mr-name', { timeout: 10000 });
  // Esperar a que el SW tome control (si no, el segundo load no pasa por él).
  await p2.waitForFunction(() => navigator.serviceWorker && navigator.serviceWorker.controller, { timeout: 8000 })
    .catch(() => {});
  await ctx2.setOffline(true);
  await p2.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
  const abreOffline = await p2.locator('#mr-name').count().catch(() => 0);
  const botonOffline = await p2.locator('button:has-text("Iniciar grabación")').count().catch(() => 0);
  add('2 · con la red cortada, la app abre y puede grabar (antes: pantalla en blanco)',
    abreOffline > 0 && botonOffline > 0,
    `formularioVisible=${abreOffline>0} botónGrabarVisible=${botonOffline>0}`);
  await ctx2.setOffline(false);
  await ctx2.close();

} catch (e) {
  add('2-7 · móvil', false, String(e.message));
} finally {
  if (browser) await browser.close().catch(() => {});
  srv.kill('SIGKILL');
  try { rmSync(w, { recursive: true, force: true }); } catch {}
}

// ── 8. Una consulta nunca se sube DOS VECES ────────────────────────────────────
// "Detener" y la caída del micrófono pueden dispararse casi a la vez. Sin guard, las dos
// rutas ensamblaban el mismo audio y lo encolaban dos veces: dos consultas duplicadas.
try {
  const rec = src('src/mobile/recorder.jsx');
  const guard = /if \(cerrandoRef\.current\) return;/.test(rec)
    && /cerrandoRef\.current = true;/.test(rec)
    && rec.indexOf('if (cerrandoRef.current) return;') < rec.indexOf('await cerrarGrabacion');
  add('8 · el guard impide encolar la misma consulta dos veces (carrera stop/micro)',
    guard, `guardAntesDelPrimerAwait=${guard}`);
} catch (e) { add('8 · doble encolado', false, String(e.message)); }

// ── 9. El audio recuperado conserva su formato real (iPhone graba mp4, no webm) ──
try {
  const q = src('src/mobile/queue.js');
  const rec = src('src/mobile/recorder.jsx');
  const guardaTipo = /putChunk: \(draftId, seq, blob, meta, type\)/.test(q) && /type,\s*at: Date\.now\(\)/.test(q);
  const usaTipo = /const type = recuperado\.type \|\| 'audio\/webm';/.test(rec);
  const noHardcode = !/const type = 'audio\/webm';/.test(rec);
  add('9 · el borrador recuperado conserva su mimeType real (mp4 en iPhone)',
    guardaTipo && usaTipo && noHardcode,
    `guardaTipoPorTrozo=${guardaTipo} loUsaAlRecuperar=${usaTipo} sinHardcode=${noHardcode}`);
} catch (e) { add('9 · mimeType recuperado', false, String(e.message)); }

// ── 10. Un borrador sin consentimiento NO se sube ───────────────────────────────
try {
  const rec = src('src/mobile/recorder.jsx');
  // Lo que NO puede existir es el fallback que inventaba un consentimiento cuando el
  // borrador no traía meta. El `consent: true` de startRecording sí es legítimo: ahí el
  // médico acaba de marcar la casilla (canRecord lo exige).
  const sinFallbackInventado = !/\|\|\s*\{\s*name:\s*''.*consent:\s*true\s*\}/.test(rec);
  const rechaza = /if \(!meta \|\| !meta\.consent\)/.test(rec);
  add('10 · un borrador sin consentimiento no se sube (no se fabrica la base legal)',
    sinFallbackInventado && rechaza,
    `sinFallbackInventado=${sinFallbackInventado} rechazaExplícitamente=${rechaza}`);
} catch (e) { add('10 · consentimiento', false, String(e.message)); }

console.log('\nSprint 18 — test al goal "el móvil no miente":\n');
let pass = 0;
for (const r of results.sort((a, b) => a.name.localeCompare(b.name))) {
  console.log(`  [${r.ok ? 'PASA' : 'FALLA'}]  ${r.name}\n           ${r.detail}`);
  if (r.ok) pass++;
}
console.log(`\n  ${pass}/${results.length} casos.  ${pass === results.length ? '✓ GOAL CUMPLIDO' : '✗ HAY FALLAS'}\n`);
process.exit(pass === results.length ? 0 : 1);
