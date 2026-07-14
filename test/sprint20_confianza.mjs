// Sprint 20 — test al goal: "Ningún número clínico llega a la historia sin estar literalmente
// en la transcripción, y el médico ve de un vistazo qué campos son dudosos."
//
//  1. Los vitales los extrae un REGEX, no el LLM (incluso dictados en palabras)
//  2. Una cifra que el LLM inventó y NO está en el audio → se vacía y se marca
//  3. Las dosis del plan también se validan contra el audio
//  4. Confianza por desacuerdo: dos extracciones que divergen → campo dudoso
//  5. Un campo dudoso llega VACÍO, con la sugerencia al lado (no pre-rellenado)
//  6. El CIE-10 está apagado (lo inventaba un 7B sin catálogo)
//  7. Una cita verbatim pero IRRELEVANTE se descarta (evidencia decorativa = mentira)
//  8. Las fuentes no se inventan para campos que no salen del audio (nombre, DNI)
//  9. La UI marca los campos sin evidencia y ofrece la sugerencia
//
// Uso: node test/sprint20_confianza.mjs   (no necesita Ollama: se stubea el fetch)
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const results = [];
const add = (name, ok, detail) => results.push({ name, ok, detail });
const src = (f) => readFileSync(new URL('../' + f, import.meta.url), 'utf8');

const cv = require('../clinical-values.js');

// Una consulta real, con los vitales DICTADOS en palabras (como habla un médico).
const TRANSCRIPT = [
  'Buenos días doctor. Hace tres días que tengo un dolor de cabeza que no se me quita.',
  'Vamos a examinarla. La presión está en ciento cincuenta sobre noventa y cinco.',
  'La frecuencia cardíaca en ochenta y ocho por minuto. La temperatura treinta y seis punto ocho.',
  'La saturación en noventa y ocho por ciento.',
  'La impresión diagnóstica es una cefalea tensional.',
  'Le doy naproxeno quinientos miligramos cada doce horas por cinco días.',
].join('\n');

// ── 1. Los vitales salen de un regex, no del modelo ──
try {
  const v = cv.extraerVitales(TRANSCRIPT);
  add('1 · los signos vitales los extrae un regex, aunque se dicten en palabras',
    v.presion_arterial === '150/95' && v.frecuencia_cardiaca === '88'
      && v.temperatura === '36.8' && v.saturacion === '98',
    `PA=${v.presion_arterial} FC=${v.frecuencia_cardiaca} T=${v.temperatura} SatO2=${v.saturacion}`);
} catch (e) { add('1 · vitales por regex', false, String(e.message)); }

// ── 2. Una presión arterial inventada se vacía ──
// El escenario real: el médico dice "ciento cincuenta sobre noventa y cinco", Whisper
// transcribe mal o el modelo alucina, y emite 120/80. Si eso llega al médico y él confirma
// en cadena, firma una presión que nadie tomó.
try {
  const fields = {
    filiacion: {}, anamnesis: {},
    examen_fisico: { presion_arterial: '120/80', frecuencia_cardiaca: '88', temperatura: '36.8' },
    impresion_diagnostica: {}, plan: {},
  };
  const { fields: out, sinEvidencia } = cv.validarContraTranscripcion(fields, TRANSCRIPT);
  add('2 · una cifra que no está en el audio se vacía y se marca sin evidencia',
    out.examen_fisico.presion_arterial === ''
      && sinEvidencia.includes('examen_fisico.presion_arterial')
      && out.examen_fisico.frecuencia_cardiaca === '88',      // esta SÍ está: se conserva
    `PAinventada=${JSON.stringify(out.examen_fisico.presion_arterial)} FCreal=${JSON.stringify(out.examen_fisico.frecuencia_cardiaca)} marcados=${sinEvidencia.length}`);
} catch (e) { add('2 · cifra inventada', false, String(e.message)); }

// ── 3. Las dosis también ──
try {
  const fields = {
    filiacion: {}, anamnesis: {}, examen_fisico: {}, impresion_diagnostica: {},
    plan: { tratamiento: 'naproxeno 850 mg cada 6 horas' },   // el audio dice 500 cada 12
  };
  const { fields: out, sinEvidencia } = cv.validarContraTranscripcion(fields, TRANSCRIPT);
  add('3 · una dosis que no está en el audio se vacía (el error más caro)',
    out.plan.tratamiento === '' && sinEvidencia.includes('plan.tratamiento'),
    `tratamiento=${JSON.stringify(out.plan.tratamiento)} (el audio dice 500 mg cada 12 h)`);
} catch (e) { add('3 · dosis inventada', false, String(e.message)); }

// ── 10. Los dígitos sueltos NO respaldan una presión arterial ──
// El agujero: si el modelo inventa "120/80" y el audio dice "hace 120 días" y "pesa 80
// kilos", los dos números existen en el texto. Buscarlos sueltos daba por buena una presión
// que nadie tomó. El par tiene que estar DICHO junto.
try {
  const audioSinPresion = 'El dolor empezo hace 120 dias. El paciente pesa 80 kilos. No le tomamos la presion hoy.';
  const inventada = { filiacion: {}, anamnesis: {}, examen_fisico: { presion_arterial: '120/80' },
    impresion_diagnostica: {}, plan: {} };
  const r1 = cv.validarContraTranscripcion(inventada, audioSinPresion);

  const audioConPresion = 'La presion esta en ciento veinte sobre ochenta.';
  const real = { filiacion: {}, anamnesis: {}, examen_fisico: { presion_arterial: '120/80' },
    impresion_diagnostica: {}, plan: {} };
  const r2 = cv.validarContraTranscripcion(real, audioConPresion);

  add('10 · una presión inventada no pasa por tener sus dígitos sueltos en otras frases',
    r1.fields.examen_fisico.presion_arterial === ''
      && r2.fields.examen_fisico.presion_arterial === '120/80',
    `inventada=${JSON.stringify(r1.fields.examen_fisico.presion_arterial)} (vacía) · real=${JSON.stringify(r2.fields.examen_fisico.presion_arterial)} (conservada)`);
} catch (e) { add('10 · dígitos sueltos', false, String(e.message)); }

// ── 11. Un dato que NO es del paciente no entra a su historia ──
// Sin diarización no sabemos quién habla. Ante la duda, nada: un campo vacío es barato.
try {
  const fetal    = cv.extraerVitales('la frecuencia cardiaca fetal de 140 por minuto');
  const propia   = cv.extraerVitales('la frecuencia cardiaca en 88 por minuto');
  const ambiente = cv.extraerVitales('la temperatura ambiente 30 grados');
  const corporal = cv.extraerVitales('la temperatura es 36.8');
  // Dos presiones en la consulta (la de la madre y la del paciente): no adivinamos cuál es.
  const dosPa    = cv.extraerVitales('la presion de la mama era 180 sobre 100, la del paciente 120 sobre 80');
  const unaPa    = cv.extraerVitales('la presion esta en 120 sobre 80');

  add('11 · un dato ajeno (FC fetal, temperatura ambiente, presión de la madre) no entra',
    !fetal.frecuencia_cardiaca && propia.frecuencia_cardiaca === '88'
      && !ambiente.temperatura && corporal.temperatura === '36.8'
      && !dosPa.presion_arterial && unaPa.presion_arterial === '120/80',
    `FCfetal=${JSON.stringify(fetal.frecuencia_cardiaca)} FCpaciente=${JSON.stringify(propia.frecuencia_cardiaca)} `
    + `Tambiente=${JSON.stringify(ambiente.temperatura)} Tcorporal=${JSON.stringify(corporal.temperatura)} `
    + `dosPresiones=${JSON.stringify(dosPa.presion_arterial)} unaPresion=${JSON.stringify(unaPa.presion_arterial)}`);
} catch (e) { add('11 · dato ajeno', false, String(e.message)); }

// ── 12. El ámbar es la EXCEPCIÓN, no la norma ──
// Si dos redacciones del mismo hecho se marcan dudosas, el ámbar aparece en cada consulta y
// el médico aprende a ignorarlo — el fallo que esta señal existe para evitar.
try {
  delete require.cache[require.resolve('../llm.js')];
  const llm = require('../llm.js');
  const mismaCosa   = llm.solapamiento('cefalea tensional', 'cefalea de tipo tensional');
  const mismaDosis  = llm.solapamiento('naproxeno 500 mg cada 12 horas', 'naproxeno 500 miligramos cada doce horas');
  const distintos   = llm.solapamiento('cefalea tensional', 'migraña con aura');
  add('12 · una redacción distinta del mismo hecho NO se marca dudosa (el ámbar debe ser raro)',
    mismaCosa >= 0.55 && mismaDosis >= 0.55 && distintos < 0.55,
    `mismaRedacción=${mismaCosa.toFixed(2)} mismaDosis=${mismaDosis.toFixed(2)} diagnósticosDistintos=${distintos.toFixed(2)} (umbral 0.55)`);
} catch (e) { add('12 · ámbar excepcional', false, String(e.message)); }

// ── 13. Una cifra correcta al final de una frase no se vacía ──
// "la temperatura 36.8." termina en punto de frase, no en decimal. Un falso negativo aquí
// borra un dato que el médico SÍ dijo.
try {
  const t = 'la temperatura 36.8. la saturacion en 98 por ciento.';
  const f = { filiacion: {}, anamnesis: {}, examen_fisico: { temperatura: '36.8', saturacion: '98' },
    impresion_diagnostica: {}, plan: {} };
  const r = cv.validarContraTranscripcion(f, t);
  add('13 · una cifra correcta al final de una frase se conserva (sin falsos negativos)',
    r.fields.examen_fisico.temperatura === '36.8' && r.fields.examen_fisico.saturacion === '98'
      && r.sinEvidencia.length === 0,
    `T=${JSON.stringify(r.fields.examen_fisico.temperatura)} SatO2=${JSON.stringify(r.fields.examen_fisico.saturacion)} vaciados=${r.sinEvidencia.length}`);
} catch (e) { add('13 · falso negativo', false, String(e.message)); }

// ── 4 + 5. Confianza por desacuerdo, con Ollama stubeado ──
// Dos respuestas distintas del modelo → el campo donde difieren es dudoso, llega VACÍO,
// y la sugerencia va al lado para que el médico decida.
try {
  const realFetch = globalThis.fetch;
  let llamada = 0;
  const respuesta = (fields) => ({
    ok: true,
    json: async () => ({ message: { content: JSON.stringify(fields) } }),
  });
  globalThis.fetch = async () => {
    llamada++;
    // Pasada 1 y pasada 2 discrepan en el diagnóstico; coinciden en el motivo.
    return llamada === 1
      ? respuesta({
          filiacion: {}, anamnesis: { motivo_consulta: 'dolor de cabeza' },
          examen_fisico: {}, impresion_diagnostica: { diagnosticos: 'cefalea tensional' }, plan: {},
        })
      : respuesta({
          filiacion: {}, anamnesis: { motivo_consulta: 'dolor de cabeza' },
          examen_fisico: {}, impresion_diagnostica: { diagnosticos: 'migraña con aura' }, plan: {},
        });
  };
  delete require.cache[require.resolve('../llm.js')];
  const llm = require('../llm.js');
  const ex = await llm.extractFields(TRANSCRIPT, { patient: { name: 'Ana' }, date: Date.now() });
  globalThis.fetch = realFetch;

  const dx = 'impresion_diagnostica.diagnosticos';
  add('4 · las dos pasadas divergen → el campo queda marcado como dudoso',
    ex.dudosos.includes(dx) && !ex.dudosos.includes('anamnesis.motivo_consulta'),
    `dudosos=${JSON.stringify(ex.dudosos)} (el motivo coincidía: no debe estar)`);

  add('5 · un campo dudoso llega VACÍO, con la sugerencia al lado (no pre-rellenado)',
    ex.fields.impresion_diagnostica.diagnosticos === '' && !!ex.sugerencias[dx],
    `valor=${JSON.stringify(ex.fields.impresion_diagnostica.diagnosticos)} sugerencia=${JSON.stringify(ex.sugerencias[dx])}`);
} catch (e) {
  add('4 · desacuerdo', false, String(e.message));
  add('5 · campo vacío', false, String(e.message));
}

// ── 6. CIE-10 apagado ──
try {
  const llmSrc = src('llm.js');
  const apagado = /"cie10": DEJA SIEMPRE la cadena vacía/.test(llmSrc)
    && !/cie10.*solo si son claros/.test(llmSrc);
  add('6 · el CIE-10 está apagado (un 7B sin catálogo lo inventaba)',
    apagado, `prompt lo prohíbe=${apagado}`);
} catch (e) { add('6 · CIE-10', false, String(e.message)); }

// ── 7 + 8. Las citas irrelevantes se descartan ──
try {
  delete require.cache[require.resolve('../llm.js')];
  const llm = require('../llm.js');
  const parsed = {
    filiacion: { nombre: 'Ana Torres', documento: '44556677' },   // vienen del registro, NO del audio
    anamnesis: { motivo_consulta: 'dolor de cabeza' },
    examen_fisico: {}, impresion_diagnostica: {}, plan: {},
    _fuentes: {
      // Verbatim (está en el audio), pero no respalda NADA del nombre. El modelo hace esto.
      'filiacion.nombre': 'Buenos días doctor.',
      'anamnesis.motivo_consulta': 'un dolor de cabeza que no se me quita',
    },
  };
  const out = llm.normalize(parsed, { transcript: TRANSCRIPT, patient: { name: 'Ana Torres' }, date: Date.now() });
  const s = out.sources;
  add('7 · una cita verbatim pero irrelevante se descarta (evidencia decorativa = mentira)',
    !s['filiacion.nombre'],
    `citaBasuraDescartada=${!s['filiacion.nombre']}`);
  add('8 · el motivo de consulta SÍ conserva su cita real',
    !!s['anamnesis.motivo_consulta'] && TRANSCRIPT.includes(s['anamnesis.motivo_consulta']),
    `cita=${JSON.stringify(String(s['anamnesis.motivo_consulta'] || '').slice(0, 45))}`);
} catch (e) {
  add('7 · cita irrelevante', false, String(e.message));
  add('8 · cita real', false, String(e.message));
}

// ── 9. La UI muestra la señal ──
try {
  const ui = src('src/web/clinical.jsx');
  const marca = /SIN EVIDENCIA EN LA TRANSCRIPCIÓN/.test(ui)
    && /la IA propuso/.test(ui)
    && /campos dudosos.*revísalos primero|revísalos primero/.test(ui)
    && /dudoso=\{dudosos\.has\(id\)\}/.test(ui);
  add('9 · la UI marca lo dudoso, ofrece la sugerencia y lo pone arriba',
    marca, `marcaSinEvidencia+sugerencia+bannerArriba=${marca}`);
} catch (e) { add('9 · UI', false, String(e.message)); }

// ── 14. "NINGÚN número clínico": también los de texto libre ──
// Validar solo seis campos no es "ninguno". Una dosis inventada entraba tranquila por
// `plan.indicaciones` ("paracetamol 1000 mg cada 8 horas"), o una fiebre por `sintomas`.
try {
  const t = 'El paciente refiere dolor de cabeza hace tres dias. La presion esta en 150 sobre 95.';
  const f = {
    filiacion: { nombre: 'Ana Torres', documento: '44556677', fecha_consulta: '13 de julio de 2026' },
    anamnesis: { sintomas: 'cefalea con fiebre de 39 grados' },        // 39 no se dijo
    examen_fisico: { presion_arterial: '150/95' },                     // sí se dijo
    impresion_diagnostica: { diagnosticos: 'cefalea tensional' },      // sin cifras
    plan: { indicaciones: 'paracetamol 1000 mg cada 8 horas' },        // 1000 no se dijo
  };
  const r = cv.validarContraTranscripcion(f, t);
  add('14 · ninguna cifra inventada entra, tampoco por los campos de texto libre',
    r.fields.anamnesis.sintomas === ''
      && r.fields.plan.indicaciones === ''
      && r.fields.examen_fisico.presion_arterial === '150/95'
      && r.fields.filiacion.nombre === 'Ana Torres'                    // del registro: no se toca
      && r.fields.filiacion.fecha_consulta === '13 de julio de 2026'   // de la app: no se toca
      && r.fields.impresion_diagnostica.diagnosticos === 'cefalea tensional',
    `síntomas(fiebre 39)=${JSON.stringify(r.fields.anamnesis.sintomas)} indicaciones(1000mg)=${JSON.stringify(r.fields.plan.indicaciones)} PAreal=${JSON.stringify(r.fields.examen_fisico.presion_arterial)} nombre=${JSON.stringify(r.fields.filiacion.nombre)}`);
} catch (e) { add('14 · texto libre', false, String(e.message)); }

// ── 15. Un campo dudoso SIGUE exigiendo confirmación del médico ──
// El agujero: al vaciar el campo dudoso ANTES de copiar fields_ia, dejaba de contar como
// "poblado por la IA" — y el médico podía firmar sin mirar justo los campos sospechosos.
try {
  const realFetch = globalThis.fetch;
  let n = 0;
  globalThis.fetch = async () => {
    n++;
    const fields = n === 1
      ? { filiacion: {}, anamnesis: {}, examen_fisico: {}, impresion_diagnostica: { diagnosticos: 'cefalea tensional' }, plan: {} }
      : { filiacion: {}, anamnesis: {}, examen_fisico: {}, impresion_diagnostica: { diagnosticos: 'migraña con aura' }, plan: {} };
    return { ok: true, json: async () => ({ message: { content: JSON.stringify(fields) } }) };
  };
  delete require.cache[require.resolve('../llm.js')];
  const llm = require('../llm.js');
  const ex = await llm.extractFields(TRANSCRIPT, { patient: { name: 'Ana' }, date: Date.now() });
  globalThis.fetch = realFetch;

  const dx = 'impresion_diagnostica.diagnosticos';
  const vacioEnFields = ex.fields.impresion_diagnostica.diagnosticos === '';
  const presenteEnIa  = !!String(ex.fields_ia?.impresion_diagnostica?.diagnosticos || '').trim();
  add('15 · el campo dudoso llega vacío PERO fields_ia conserva lo que la IA propuso',
    vacioEnFields && presenteEnIa && !!ex.sugerencias[dx],
    `vacíoParaElMédico=${vacioEnFields} enFieldsIA=${JSON.stringify(ex.fields_ia?.impresion_diagnostica?.diagnosticos)} → el gate de confirmación lo ve`);
} catch (e) { add('15 · fields_ia', false, String(e.message)); }

console.log('\nSprint 20 — test al goal "confianza por campo":\n');
let pass = 0;
for (const r of results.sort((a, b) => a.name.localeCompare(b.name, 'es', { numeric: true }))) {
  console.log(`  [${r.ok ? 'PASA' : 'FALLA'}]  ${r.name}\n           ${r.detail}`);
  if (r.ok) pass++;
}
console.log(`\n  ${pass}/${results.length} casos.  ${pass === results.length ? '✓ GOAL CUMPLIDO' : '✗ HAY FALLAS'}\n`);
process.exit(pass === results.length ? 0 : 1);
