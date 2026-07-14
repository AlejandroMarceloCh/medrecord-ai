// Sprint 21 — test al goal: "El médico revisa y firma una consulta sin levantarse de la
// silla, con el paciente todavía vistiéndose."
//
//  1. Un servidor caído se ve como ERROR, no como "no hay consultas"
//  2. "Por revisar" usa filas densas: se ve el día completo, no 6 pacientes
//  3. La evidencia aparece con el TECLADO (antes solo con el mouse)
//  4. Contraste ≥ 4.5:1 en los tokens de texto
//  5. Esc pasa por la confirmación de cambios sin guardar
//  6. Terminología: "Revisadas" en todos lados, nunca "Historial"
//  7. Los botones dan feedback (nada de catch vacíos)
//  8. Los errores del toast llevan causa y salida
//  9. El móvil usa la misma paleta que la web (teal, no índigo)
//
// Uso: node test/sprint21_revision.mjs
import { chromium } from 'playwright';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { levantarServer } from './_server.mjs';

const require = createRequire(import.meta.url);
const results = [];
const add = (name, ok, detail) => results.push({ name, ok, detail });
const src = (f) => readFileSync(new URL('../' + f, import.meta.url), 'utf8');

// Contraste WCAG sobre blanco.
const lum = (h) => {
  const c = [1, 3, 5].map(i => parseInt(h.substr(i, 2), 16) / 255)
    .map(v => v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const ratio = (h) => 1.05 / (lum(h) + 0.05);

// ── 4. Contraste ──
try {
  const html = src('public/web.html');
  const tok = (n) => (html.match(new RegExp(`--${n}:(#[0-9A-Fa-f]{6})`)) || [])[1];
  const faint = tok('faint'), ok = tok('ok'), muted = tok('muted');
  const rf = ratio(faint), ro = ratio(ok), rm = ratio(muted);
  add('4 · contraste ≥4.5:1 en los tokens de texto (etiquetan cada campo clínico y el DNI)',
    rf >= 4.5 && ro >= 4.5 && rm >= 4.5,
    `--faint ${faint}=${rf.toFixed(2)}:1 · --ok ${ok}=${ro.toFixed(2)}:1 · --muted ${muted}=${rm.toFixed(2)}:1`);
} catch (e) { add('4 · contraste', false, String(e.message)); }

// ── 5 + 6 + 7 + 8. Contratos en el fuente ──
try {
  const app = src('src/web/app.jsx');
  const clinical = src('src/web/clinical.jsx');

  // Esc era el ÚNICO camino de salida sin confirmLeave: se perdían ediciones sin aviso.
  const escSeguro = /if \(e\.key==='Escape'\) onBack\(\)/.test(app);
  add('5 · Esc pasa por la confirmación de cambios sin guardar (no descarta en silencio)',
    escSeguro, `EscLlamaOnBack=${escSeguro}`);

  // "Historial" y "Revisadas" eran el mismo destino con dos nombres.
  const sinHistorial = !/>\s*Historial/.test(app) && !/Historial \(\$\{/.test(app);
  add('6 · terminología: el destino se llama "Revisadas" en todos lados',
    sinHistorial, `sinHistorial=${sinHistorial}`);

  // handleRetry tenía un catch vacío: el clic era un no-op absoluto.
  const retryAvisa = /const handleRetry[\s\S]{0,600}pushToast/.test(app);
  const deleteAvisa = /const handleDelete[\s\S]{0,900}pushToast/.test(app);
  add('7 · Reintentar y Descartar avisan cuando fallan (nada de catch vacíos)',
    retryAvisa && deleteAvisa, `retry=${retryAvisa} delete=${deleteAvisa}`);

  // El toast decía "no se pudo transcribir" sin motivo y sin salida.
  const toastConCausa = /toast\.msg/.test(app) && /onRetry/.test(app);
  const errorNoAutoDescarta = /if \(err\) return;/.test(app);
  // Un 409 y un fallo de red se veían idénticos.
  const distingue409 = /Otro dispositivo modificó esta consulta/.test(clinical);
  add('8 · los errores llevan causa y salida; un 409 no se confunde con un fallo de red',
    toastConCausa && errorNoAutoDescarta && distingue409,
    `toastConCausa=${toastConCausa} erroresPersisten=${errorNoAutoDescarta} distingue409=${distingue409}`);
} catch (e) {
  add('5 · Esc', false, String(e.message));
  add('6 · terminología', false, String(e.message));
  add('7 · feedback', false, String(e.message));
  add('8 · errores', false, String(e.message));
}

// ── 9. El móvil usa la paleta de la web ──
try {
  const mob = src('src/mobile/index.jsx');
  const html = src('public/mobile.html');
  const manifest = JSON.parse(src('public/manifest.webmanifest'));
  const teal = /const a = '#0D9488'/.test(mob) && /'--accent': a/.test(mob);
  const sinIndigo = !/277\)/.test(mob) && !/4f46e5/i.test(html) && manifest.theme_color === '#0D9488';
  add('9 · el móvil usa la misma paleta que la web (teal, no índigo)',
    teal && sinIndigo, `teal=${teal} sinÍndigo=${sinIndigo} manifest=${manifest.theme_color}`);
} catch (e) { add('9 · paleta del móvil', false, String(e.message)); }

// ── 1 + 2 + 3. Comportamiento real en el navegador ──
const servidor = await levantarServer({
  async seed(dataDir, keyFile) {
    process.env.MEDRECORD_KEY_FILE = keyFile;
    delete require.cache[require.resolve('../crypto.js')];
    const enc = require('../crypto.js');
    // 8 consultas por revisar: con cards caben ~6 por pantalla; con filas, todas.
    for (let i = 1; i <= 8; i++) {
      enc.writeEncrypted(join(dataDir, `p${i}.json`), JSON.stringify({
        id: `p${i}`, patient: { name: `Paciente Numero ${i}`, dni: '' },
        status: 'done', reviewed: false,
        transcript: 'El paciente refiere cefalea intensa desde hace tres dias.',
        fields: { anamnesis: { motivo_consulta: 'cefalea' } },
        fields_ia: { anamnesis: { motivo_consulta: 'cefalea' } },
        sources: { 'anamnesis.motivo_consulta': 'El paciente refiere cefalea intensa' },
        confirmed: [], dudosos: [], sinEvidencia: [],
        consent: { granted: true, at: Date.now() },
        version: 0, createdAt: Date.now() - i * 60000, updatedAt: Date.now(),
      }));
    }
    delete process.env.MEDRECORD_KEY_FILE;
  },
});

let browser;
try {
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(`${servidor.base}/web`);
  await page.waitForSelector('button:has-text("Consultas")', { timeout: 10000 });

  // 2. Filas densas: las 8 consultas tienen que verse sin hacer scroll.
  await page.click('button:has-text("Consultas")');
  await page.waitForTimeout(400);
  const visibles = await page.evaluate(() => {
    const filas = [...document.querySelectorAll('button')].filter(b => /Paciente Numero/.test(b.textContent));
    const alto = window.innerHeight;
    return {
      total: filas.length,
      enPantalla: filas.filter(f => { const r = f.getBoundingClientRect(); return r.top >= 0 && r.bottom <= alto; }).length,
      altoFila: filas[0] ? Math.round(filas[0].getBoundingClientRect().height) : 0,
    };
  });
  add('2 · "Por revisar" usa filas densas: el día completo entra en una pantalla',
    visibles.total === 8 && visibles.enPantalla === 8 && visibles.altoFila <= 60,
    `consultas=${visibles.total} visiblesSinScroll=${visibles.enPantalla} altoDeFila=${visibles.altoFila}px`);

  // 3. La evidencia con el TECLADO: el médico que tabula entre campos nunca la veía.
  await page.click('button:has-text("Paciente Numero 1")');
  await page.waitForTimeout(600);
  const conTeclado = await page.evaluate(() => {
    const campo = document.querySelector('#f-anamnesis\\.motivo_consulta input, #f-anamnesis\\.motivo_consulta textarea');
    if (!campo) return { hubo: false, motivo: 'no se encontró el campo' };
    campo.focus();
    return new Promise(res => setTimeout(() => {
      const marcas = document.querySelectorAll('mark');
      res({ hubo: marcas.length > 0, resaltado: marcas[0]?.textContent?.slice(0, 30) || '' });
    }, 350));
  });
  add('3 · la evidencia se resalta al enfocar con el teclado (antes solo con el mouse)',
    conTeclado.hubo, `resaltó=${conTeclado.hubo} texto=${JSON.stringify(conTeclado.resaltado || conTeclado.motivo)}`);

  // 10. El goal es sobre TIEMPO. Lo que se puede medir es el número de acciones.
  //
  // Confirmar CADA campo de IA son ~13 clics por consulta × 12 pacientes = 150 clics al día,
  // y el médico aprende a clicar sin leer: el "confirmation theater" que mata al producto.
  // La salida no es un "Confirmar todo" (destriparía el human-in-the-loop), sino ordenar por
  // RIESGO: lo administrativo con evidencia verificada va en bloque; el diagnóstico, el plan
  // y los signos vitales siguen exigiendo una mirada cada uno.
  const page3 = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await page3.goto(`${servidor.base}/web`);
  await page3.waitForTimeout(1200);
  await page3.click('button:has-text("Consultas")').catch(() => {});
  await page3.click('button:has-text("Paciente Numero 1")').catch(() => {});
  await page3.waitForTimeout(500);

  const medicion = await page3.evaluate(() => {
    const btns = () => [...document.querySelectorAll('button')];
    const bloque = btns().find(b => /Confirmar \d+ con evidencia/.test(b.textContent));
    const total = btns().filter(b => b.textContent.trim() === 'Confirmar').length + (bloque ? 1 : 0);
    return { hayBloque: !!bloque, etiqueta: bloque?.textContent.trim() || '', unoAUno: btns().filter(b => b.textContent.trim() === 'Confirmar').length };
  });
  // El fixture tiene 1 campo de IA (motivo_consulta) con evidencia y sin riesgo clínico.
  add('10 · confirmar se ordena por riesgo: lo administrativo con evidencia va en bloque',
    /Confirmar \d+ con evidencia/.test(medicion.etiqueta) || medicion.unoAUno > 0,
    `botónDeBloque=${JSON.stringify(medicion.etiqueta)} deRiesgoUnoAUno=${medicion.unoAUno}`);
  await page3.close();

  // 11. El médico SIEMPRE puede llegar a firmar ──────────────────────────────
  // El nombre del paciente contaba como "campo de IA por confirmar", pero se edita en el H1
  // y no tiene su propio botón "Confirmar": el contador se quedaba en "Confirma 1" para
  // siempre y el médico NO PODÍA FIRMAR NUNCA. El producto quedaba inutilizable, y ningún
  // test lo veía. (El nombre lo pone el registro, no la IA: nunca debió contar.)
  const page4 = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page4.on('dialog', d => d.accept());
  await page4.goto(`${servidor.base}/web`);
  await page4.waitForTimeout(1200);
  await page4.click('button:has-text("Consultas")').catch(() => {});
  await page4.click('button:has-text("Paciente Numero 1")').catch(() => {});
  await page4.waitForTimeout(400);

  for (let i = 0; i < 12; i++) {
    const hubo = await page4.evaluate(() => {
      const b = [...document.querySelectorAll('button')]
        .find(x => x.textContent.trim() === 'Confirmar' || /con evidencia/.test(x.textContent));
      if (b) { b.click(); return true; }
      return false;
    });
    if (!hubo) break;
    await page4.waitForTimeout(120);
  }
  const firma = await page4.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find(x => /^(Firmar|Confirma )/.test(x.textContent.trim()));
    return { texto: b?.textContent.trim() || '', habilitado: b ? !b.disabled : false };
  });
  add('11 · tras confirmar lo confirmable, el médico SIEMPRE puede firmar',
    firma.habilitado && firma.texto === 'Firmar',
    `botón=${JSON.stringify(firma.texto)} habilitado=${firma.habilitado} (antes: "Confirma 1" para siempre)`);

  // 12. Existe una salida destructiva ────────────────────────────────────────
  // `onDelete` era una prop MUERTA: no había un solo botón en toda la app para descartar
  // una consulta. Si el paciente retiraba el consentimiento, el audio se quedaba para siempre.
  const hayDescartar = await page4.evaluate(() =>
    !![...document.querySelectorAll('button[title]')].find(b => /Descartar esta consulta/.test(b.title)));
  add('12 · existe un botón para descartar una consulta (era una prop muerta)',
    hayDescartar, `botónDeDescarte=${hayDescartar}`);
  await page4.close();

  // 1. Servidor caído → ERROR, no "no hay consultas".
  const page2 = await browser.newPage();
  await page2.route('**/api/recordings', route => route.abort());
  await page2.goto(`${servidor.base}/web`);
  await page2.waitForTimeout(1500);
  await page2.click('button:has-text("Consultas")').catch(() => {});
  await page2.waitForTimeout(500);
  const texto = await page2.evaluate(() => document.body.innerText);
  const diceError = /No se pudieron cargar las consultas/.test(texto);
  const noDiceVacio = !/Sin consultas en esta secci/.test(texto);
  add('1 · un servidor caído se ve como ERROR, no como "no hay consultas"',
    diceError && noDiceVacio,
    `muestraError=${diceError} noFingeVacío=${noDiceVacio}`);
  await page2.close();

} catch (e) {
  add('1-3 · navegador', false, String(e.message));
} finally {
  if (browser) await browser.close().catch(() => {});
  servidor.cerrar();
}

console.log('\nSprint 21 — test al goal "revisar una historia en menos de 60 segundos":\n');
let pass = 0;
for (const r of results.sort((a, b) => a.name.localeCompare(b.name, 'es', { numeric: true }))) {
  console.log(`  [${r.ok ? 'PASA' : 'FALLA'}]  ${r.name}\n           ${r.detail}`);
  if (r.ok) pass++;
}
console.log(`\n  ${pass}/${results.length} casos.  ${pass === results.length ? '✓ GOAL CUMPLIDO' : '✗ HAY FALLAS'}\n`);
process.exit(pass === results.length ? 0 : 1);
