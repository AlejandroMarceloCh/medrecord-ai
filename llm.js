// llm.js — autollenado de campos clínicos con un LLM LOCAL (Ollama).
// Gratis, sin API key y la transcripción NUNCA sale de la máquina (data médica).
// Para testeo. Cambiar a Claude API después es trivial (mismo extractFields).
const cv = require('./clinical-values');
const OLLAMA = process.env.OLLAMA_URL || 'http://localhost:11434';
const MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:7b';
const TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS || 120000);

// Forma canónica de los campos. DEBE coincidir clave por clave con FIELD_SECTIONS
// de src/web/constants.js (el visor web). Si cambias uno, cambia el otro: el test
// sprint6 verifica que el autollenado puebla estos campos granulares.
function emptyFields() {
  return {
    filiacion: { nombre: '', documento: '', fecha_consulta: '', fecha_nacimiento: '', sexo: '', ocupacion: '' },
    anamnesis: { motivo_consulta: '', tiempo_enfermedad: '', sintomas: '', antecedentes_personales: '', antecedentes_familiares: '' },
    examen_fisico: { presion_arterial: '', frecuencia_cardiaca: '', temperatura: '', peso_talla: '', saturacion: '', hallazgos: '' },
    impresion_diagnostica: { diagnosticos: '', cie10: '' },
    plan: { tratamiento: '', examenes_solicitados: '', indicaciones: '' },
  };
}

const SYSTEM = [
  'Eres un asistente de documentación clínica. A partir de la TRANSCRIPCIÓN de una',
  'consulta médica en español, extrae los datos de la historia clínica y devuélvelos',
  'en JSON con EXACTAMENTE esta estructura y claves:',
  '{',
  '  "filiacion": {"nombre":"","documento":"","fecha_consulta":"","fecha_nacimiento":"","sexo":"","ocupacion":""},',
  '  "anamnesis": {"motivo_consulta":"","tiempo_enfermedad":"","sintomas":"","antecedentes_personales":"","antecedentes_familiares":""},',
  '  "examen_fisico": {"presion_arterial":"","frecuencia_cardiaca":"","temperatura":"","peso_talla":"","saturacion":"","hallazgos":""},',
  '  "impresion_diagnostica": {"diagnosticos":"","cie10":""},',
  '  "plan": {"tratamiento":"","examenes_solicitados":"","indicaciones":""},',
  '  "_fuentes": {}',
  '}',
  'Guía por campo: separa CADA signo vital en su campo. "presion_arterial" = PA en mmHg (ej. "120/80").',
  '"frecuencia_cardiaca" = FC en lpm (solo el número). "temperatura" = T° en °C. "saturacion" = SatO₂ en %.',
  '"sintomas" = síntomas y molestias referidos por el paciente. "tiempo_enfermedad" = cuánto lleva con el cuadro.',
  '"diagnosticos" = impresión diagnóstica en texto (uno o varios).',
  '"cie10": DEJA SIEMPRE la cadena vacía "". No inventes ni deduzcas códigos CIE-10.',
  '"antecedentes_personales" vs "antecedentes_familiares": sepáralos; no mezcles.',
  'Reglas: usa solo información presente en la transcripción. Si un dato no aparece,',
  'deja la cadena vacía "". NO inventes diagnósticos, dosis, códigos ni datos. Redacta en',
  'español clínico, conciso.',
  'La clave "_fuentes" es OBLIGATORIA y no puede faltar: cada clave suya es "seccion.campo" y',
  'su valor es el FRAGMENTO EXACTO de la transcripción (copiado palabra por palabra, sin',
  'parafrasear ni acortar) que justifica ese dato. Incluye una entrada por cada campo que llenes.',
  'Ejemplo: "_fuentes": {"impresion_diagnostica.diagnosticos": "se diagnostica neumonía adquirida en la comunidad"}.',
  'Responde SOLO con el JSON, sin texto adicional.',
].join('\n');

async function available() {
  try {
    const r = await fetch(OLLAMA + '/api/tags', { signal: AbortSignal.timeout(2000) });
    if (!r.ok) return false;
    const d = await r.json();
    // Match estricto: el modelo configurado debe estar de verdad. El startsWith laxo
    // daba falsos positivos ("LLM OK" con un qwen2.5 distinto) y el autollenado fallaba.
    const hasTag = MODEL.indexOf(':') !== -1;
    return (d.models || []).some(m =>
      m.name === MODEL || m.name === MODEL + ':latest' || (!hasTag && m.name.startsWith(MODEL + ':')));
  } catch { return false; }
}

// Índice de la transcripción con los espacios en blanco colapsados, más un mapa de vuelta
// a los offsets originales.
//
// Por qué hace falta: whisper.cpp separa los segmentos con saltos de línea, y el LLM cita
// las frases sin ellos. El indexOf literal fallaba en CUALQUIER cita que cruzara un salto,
// así que sobre audio real la validación descartaba TODAS las fuentes y el resaltado de
// evidencia quedaba vacío — en silencio. La feature que justifica confiar en la IA estaba
// muerta y ningún test lo veía (los tests usan transcripciones de una sola línea).
//
// Colapsar espacios NO relaja la garantía: seguimos exigiendo que la cita exista de verdad
// en el audio, solo dejamos de exigir que coincidan los saltos de línea.
function indexTranscript(transcript) {
  const chars = [];
  const map = [];           // posición i del texto normalizado → posición en el original
  let enEspacio = false;
  for (let i = 0; i < transcript.length; i++) {
    const c = transcript[i];
    if (/\s/.test(c)) {
      if (enEspacio) continue;              // colapsa runs de espacios/saltos en uno solo
      chars.push(' '); map.push(i); enEspacio = true;
    } else {
      chars.push(c); map.push(i); enEspacio = false;
    }
  }
  return { norm: chars.join('').toLowerCase(), map };
}

// Conserva SOLO las citas que existen literalmente en la transcripción (verificables).
// Una cita que el LLM parafraseó o inventó se descarta: preferimos no resaltar a mentir.
// Frase de la transcripción que contiene este valor. Es el respaldo cuando el modelo no
// manda la fuente: la evidencia no puede depender de que un 7B se acuerde de incluirla.
function fraseQueContiene(valor, transcript) {
  const v = String(valor || '').trim();
  if (v.length < 3) return null;
  const frases = transcript.split(/(?<=[.?!])\s+|\n/);
  const vLow = v.toLowerCase();
  // Coincidencia directa del valor (sirve para cifras: "150/95" o "150 sobre 95").
  for (const fr of frases) {
    if (fr.toLowerCase().includes(vLow)) return fr.trim();
  }
  // Si no, la frase que más palabras significativas comparte con el valor.
  const palabras = vLow.split(/\W+/).filter(w => w.length > 4);
  if (!palabras.length) return null;
  let mejor = null, mejorPuntaje = 0;
  for (const fr of frases) {
    const low = fr.toLowerCase();
    const puntaje = palabras.filter(w => low.includes(w)).length;
    if (puntaje > mejorPuntaje) { mejorPuntaje = puntaje; mejor = fr.trim(); }
  }
  return mejorPuntaje >= Math.ceil(palabras.length / 2) ? mejor : null;
}

// ¿La cita respalda de verdad este valor, o es una frase cualquiera del audio?
//
// El modelo devuelve citas VERBATIM pero irrelevantes: para `filiacion.nombre` citaba
// "Buenos días doctor". Es verbatim, así que pasaba la validación, y el médico veía una
// evidencia que no evidencia nada. Una cita decorativa es PEOR que ninguna: hace confiar
// en un campo que nadie dijo. Exigimos que compartan algo real.
function laCitaRespalda(valor, cita) {
  const v = String(valor || '').toLowerCase();
  const c = String(cita || '').toLowerCase();
  if (!v || !c) return false;
  if (c.includes(v)) return true;                       // el valor está en la cita: perfecto
  const tokens = v.split(/\W+/).filter(w => w.length > 4);
  if (!tokens.length) {
    // Valores cortos (cifras, "88", "36.8"): exigimos que aparezcan tal cual.
    const nums = v.match(/\d+/g) || [];
    return nums.length > 0 && nums.every(n => c.includes(n));
  }
  return tokens.some(t => c.includes(t));
}

// Campos que NO salen del audio: los rellena el registro del médico. Citarlos es mentir.
const NO_VIENEN_DEL_AUDIO = new Set(['filiacion.nombre', 'filiacion.documento', 'filiacion.fecha_consulta']);

function buildSources(parsed, transcript) {
  const out = {};
  const f = (parsed && parsed._fuentes) || {};
  const base = emptyFields();
  if (typeof f !== 'object' || !transcript) return out;
  const { norm, map } = indexTranscript(transcript);
  for (const key of Object.keys(f)) {
    const [sec, field] = String(key).split('.');
    if (!base[sec] || !(field in base[sec])) continue;     // clave fuera del esquema → descarta
    const quote = String(f[key] || '').trim();
    if (quote.length < 4) continue;
    const q = quote.replace(/\s+/g, ' ').toLowerCase();
    const i = norm.indexOf(q);
    if (i === -1) continue;                                // no está en el audio → descarta
    if (NO_VIENEN_DEL_AUDIO.has(key)) continue;            // el nombre lo puso el médico, no el audio
    const ini = map[i];
    const fin = map[i + q.length - 1] + 1;                 // el tramo REAL del transcript,
    const cita = transcript.slice(ini, fin);               // con sus saltos y su acentuación originales
    const valor = parsed[sec] && parsed[sec][field];
    if (!laCitaRespalda(valor, cita)) continue;            // verbatim pero irrelevante → fuera
    out[key] = cita;
  }

  // Respaldo: los campos que quedaron sin fuente, la buscamos nosotros en el texto.
  for (const sec of Object.keys(base)) {
    for (const campo of Object.keys(base[sec])) {
      const clave = `${sec}.${campo}`;
      if (out[clave] || NO_VIENEN_DEL_AUDIO.has(clave)) continue;
      const valor = parsed && parsed[sec] && parsed[sec][campo];
      if (!valor || !String(valor).trim()) continue;
      const frase = fraseQueContiene(valor, transcript);
      if (frase && laCitaRespalda(valor, frase)) out[clave] = frase;
    }
  }
  return out;
}

// Compatibilidad: algunos modelos devuelven un "signos_vitales" combinado en vez de
// los campos granulares (PA/FC/T°/SatO₂), o "enfermedad_actual" en vez de "sintomas".
// Desempaquetamos ese formato viejo para no perder el dato (el bug del autollenado vacío).
function unpackLegacy(src) {
  const ana = src.anamnesis || {};
  if (ana.enfermedad_actual && !ana.sintomas) ana.sintomas = ana.enfermedad_actual;

  const ex = src.examen_fisico || {};
  const sv = ex.signos_vitales;
  if (sv && typeof sv === 'string') {
    const grab = (re) => { const m = sv.match(re); return m ? m[1].trim() : ''; };
    if (!ex.presion_arterial)   ex.presion_arterial   = grab(/(\d{2,3}\s*\/\s*\d{2,3})/);
    if (!ex.frecuencia_cardiaca) ex.frecuencia_cardiaca = grab(/(?:fc|frecuencia\s*card\w*)\D{0,4}(\d{2,3})/i);
    if (!ex.temperatura)        ex.temperatura        = grab(/(?:t°?|temp\w*)\D{0,4}(\d{2}(?:[.,]\d)?)/i);
    if (!ex.saturacion)         ex.saturacion         = grab(/(?:sat\w*|spo)\D{0,4}(\d{2,3})/i);
    // Si no se pudo descomponer nada, conserva el texto crudo en hallazgos.
    if (!ex.presion_arterial && !ex.frecuencia_cardiaca && !ex.temperatura && !ex.saturacion && !ex.hallazgos) {
      ex.hallazgos = sv;
    }
  }
  return src;
}

function normalize(parsed, { patient, date, transcript } = {}) {
  const base = emptyFields();
  const out = emptyFields();
  if (parsed && typeof parsed === 'object') unpackLegacy(parsed);
  for (const sec of Object.keys(base)) {
    const src = (parsed && parsed[sec]) || {};
    for (const k of Object.keys(base[sec])) {
      const v = src[k];
      out[sec][k] = (v == null) ? '' : String(v).trim();
    }
  }
  // Lo que ya sabemos del registro del médico tiene prioridad si el LLM no lo sacó.
  if (!out.filiacion.nombre && patient && patient.name) out.filiacion.nombre = patient.name;
  if (!out.filiacion.documento && patient && patient.dni) out.filiacion.documento = patient.dni;
  // La fecha de consulta la conocemos por el momento de la grabación. La del modelo se
  // descarta SIEMPRE: no hay razón para creerle un dato que ya sabemos, y metía trozos de
  // la transcripción ahí.
  if (date) {
    try { out.filiacion.fecha_consulta = new Date(date).toLocaleDateString('es-PE', { day: '2-digit', month: 'long', year: 'numeric' }); }
    catch { /* noop */ }
  }
  return { fields: out, sources: buildSources(parsed, transcript) };
}

// Ventana de contexto. Un num_ctx fijo de 8192 desbordaba con una consulta de 25-30 min
// (~2.500-3.500 palabras), y Ollama trunca DESCARTANDO TOKENS DEL INICIO: se come el
// system con el esquema, o el principio del audio —que es donde están la filiación y el
// motivo de consulta—. El resultado son campos vacíos, indistinguibles de "no se mencionó".
//
// Así que la medimos y la ajustamos. Y si de verdad no cabe, fallamos con un mensaje que
// el médico entiende, en vez de devolver media historia clínica en silencio.
const CTX_MIN = 8192;
const CTX_MAX = Number(process.env.OLLAMA_NUM_CTX_MAX || 32768);   // qwen2.5 soporta 32k
const CTX_RESERVE = 1500;              // system (~500) + JSON de salida (~600) + margen
const CHARS_PER_TOKEN = 3.5;           // español, aproximación conservadora

function estimateTokens(text) {
  return Math.ceil(String(text || '').length / CHARS_PER_TOKEN);
}

// Ventana necesaria para esta transcripción, o un error si no hay ninguna que alcance.
function contextFor(transcript) {
  const needed = estimateTokens(transcript) + CTX_RESERVE;
  if (needed > CTX_MAX) {
    const err = new Error(
      `La transcripción es demasiado larga para el modelo (~${needed} tokens, el máximo es ${CTX_MAX}). ` +
      `No se autollenó nada para no darte una historia a medias: revísala con la transcripción al lado.`
    );
    err.code = 'TRANSCRIPT_TOO_LONG';
    throw err;
  }
  return Math.min(CTX_MAX, Math.max(CTX_MIN, Math.ceil(needed * 1.15)));
}

// Una pasada del modelo. `variante` cambia la forma de preguntar, no el contenido: es lo
// que permite medir el DESACUERDO (ver extractFields).
async function unaPasada(transcript, { patient, date }, variante = 'extraer') {
  const num_ctx = contextFor(transcript);
  const instruccion = variante === 'citar'
    // Segunda forma de preguntar: obliga a partir de la evidencia, no del esquema. Un dato
    // que solo aparece cuando preguntas de una manera y no de la otra, es un dato dudoso.
    ? `Lee la TRANSCRIPCIÓN y, para cada dato de la historia clínica que se mencione EXPLÍCITAMENTE, `
      + `anótalo. Si algo no se dice en el audio, deja la cadena vacía. No completes, no supongas, `
      + `no infieras. Devuelve el JSON con la estructura indicada.`
    : `Devuelve solo el JSON.`;
  const body = {
    model: MODEL,
    stream: false,
    format: 'json',
    // keep_alive: mantén el modelo cargado entre pacientes (evita recarga en frío
    // de ~5 s cada autollenado). No '-1' porque la Mac es de uso dual.
    keep_alive: process.env.OLLAMA_KEEP_ALIVE || '30m',
    options: { temperature: 0.1, num_ctx },
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content:
        `Datos conocidos del paciente (del registro del médico): nombre="${patient?.name || ''}", documento="${patient?.dni || ''}".\n\n` +
        `TRANSCRIPCIÓN:\n"""\n${transcript}\n"""\n\n${instruccion}` },
    ],
  };
  const r = await fetch(OLLAMA + '/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!r.ok) throw new Error('ollama HTTP ' + r.status);
  const d = await r.json();
  let parsed;
  try { parsed = JSON.parse(d.message.content); }
  catch { throw new Error('el LLM no devolvió JSON válido'); }
  return normalize(parsed, { patient, date, transcript });
}

// Compara dos extracciones campo a campo. Coinciden → confiable. Divergen → dudoso.
//
// La confianza NO sale del modelo: los logprobs de un 7B están mal calibrados, su "estoy 90%
// seguro" no significa nada. Sale del DESACUERDO entre dos formas de preguntar lo mismo. Es
// la Selection Policy del curso: cuatro modelos que coinciden → CONFIDENT; que divergen →
// UNSURE. Aquí son dos pasadas del mismo modelo con prompts distintos, que es lo que se
// puede pagar en la Mac de un consultorio.
// Los campos narrativos NO se comparan por igualdad exacta. "cefalea tensional" y "cefalea
// de tipo tensional" son el mismo hecho clínico dicho distinto, y marcarlos como dudosos
// convertiría el ámbar en el estado normal: el médico aprendería a ignorarlo, que es
// exactamente el fallo que esta señal existe para evitar.
//
// Para narrativa medimos SOLAPAMIENTO de contenido (Jaccard sobre las palabras que
// significan algo). Para campos cortos y estructurados sí exigimos igualdad.
const NARRATIVOS = new Set([
  'anamnesis.sintomas', 'anamnesis.antecedentes_personales', 'anamnesis.antecedentes_familiares',
  'anamnesis.motivo_consulta', 'anamnesis.tiempo_enfermedad',
  'examen_fisico.hallazgos',
  'impresion_diagnostica.diagnosticos',
  'plan.tratamiento', 'plan.examenes_solicitados', 'plan.indicaciones',
]);
const UMBRAL_SOLAPAMIENTO = 0.55;

const VACIAS = new Set(['de', 'del', 'la', 'el', 'los', 'las', 'un', 'una', 'y', 'o', 'en',
  'con', 'por', 'para', 'que', 'se', 'su', 'al', 'tipo', 'sin', 'mas']);

function tokens(v) {
  return new Set(
    String(v || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .split(/\W+/).filter(w => w.length > 2 && !VACIAS.has(w))
  );
}

function solapamiento(a, b) {
  const ta = tokens(a), tb = tokens(b);
  if (!ta.size && !tb.size) return 1;
  if (!ta.size || !tb.size) return 0;
  let comunes = 0;
  for (const t of ta) if (tb.has(t)) comunes++;
  return comunes / (ta.size + tb.size - comunes);   // Jaccard
}

function compararPasadas(a, b) {
  const dudosos = [];
  const norm = (v) => String(v || '').trim().toLowerCase().replace(/\s+/g, ' ');
  for (const sec of Object.keys(a)) {
    for (const campo of Object.keys(a[sec] || {})) {
      const clave = `${sec}.${campo}`;
      const va = norm(a[sec][campo]);
      const vb = norm((b[sec] || {})[campo]);
      if (!va && !vb) continue;                     // ambos vacíos: de acuerdo
      if (va === vb) continue;                      // idénticos

      // Uno lo llenó y el otro no: eso SÍ es desacuerdo real sobre si el dato está en el audio.
      if (!va || !vb) { dudosos.push(clave); continue; }

      if (NARRATIVOS.has(clave)) {
        if (solapamiento(va, vb) < UMBRAL_SOLAPAMIENTO) dudosos.push(clave);
        continue;
      }
      dudosos.push(clave);                          // campo corto/estructurado: exigimos igualdad
    }
  }
  return dudosos;
}

// Extrae campos clínicos. Devuelve además qué campos son dudosos y cuáles se vaciaron por
// no tener respaldo en el audio.
//
// Orden de operaciones (importa):
//   1. Dos pasadas del LLM con prompts distintos → desacuerdo = campos dudosos.
//   2. Las cifras clínicas se sobrescriben con la extracción DETERMINISTA (regex): una
//      presión arterial es un patrón, no lenguaje, y un 7B puede alucinarla.
//   3. Todo número que no esté en el audio se vacía y se marca.
//   4. Los campos dudosos se vacían: llegan al médico VACÍOS, con la sugerencia al lado.
//      Pre-rellenarlos invita a confirmar sin leer, que es el fallo que mata al producto.
async function extractFields(transcript, { patient, date, ensemble = true } = {}) {
  const principal = await unaPasada(transcript, { patient, date }, 'extraer');

  let dudosos = [];
  if (ensemble) {
    try {
      const segunda = await unaPasada(transcript, { patient, date }, 'citar');
      dudosos = compararPasadas(principal.fields, segunda.fields);
    } catch { /* si la segunda pasada falla, seguimos sin señal de confianza */ }
  }

  const fields = principal.fields;

  // Las cifras las manda el regex, no el modelo.
  const vitales = cv.extraerVitales(transcript);
  for (const [campo, valor] of Object.entries(vitales)) {
    if (valor) fields.examen_fisico[campo] = valor;
  }

  // SNAPSHOT antes de vaciar nada. Esto es `fields_ia`: lo que la máquina generó de verdad.
  //
  // Vaciar primero y copiar después tenía dos consecuencias graves: (a) un campo dudoso ya
  // no contaba como "poblado por la IA", así que el gate de human-in-the-loop NO obligaba a
  // confirmarlo — el médico podía firmar sin mirar justamente los campos sospechosos; y (b)
  // la firma sellaba un `fields_ia` sin el valor disputado, o sea que dejaba de probar qué
  // había propuesto la máquina, que es LA pregunta de una disputa.
  const fields_ia = JSON.parse(JSON.stringify(fields));

  // Lo que no esté en el audio, no existe.
  const { sinEvidencia } = cv.validarContraTranscripcion(fields, transcript);

  // Un campo dudoso llega VACÍO, con lo que el modelo propuso al costado.
  const sugerencias = {};
  const vaciados = [];
  for (const clave of dudosos) {
    const [sec, campo] = clave.split('.');
    if (!fields[sec]) continue;
    const propuesto = fields[sec][campo];
    if (!String(propuesto || '').trim()) continue;   // ya está vacío: nada que sugerir
    if (vitales[campo]) continue;                    // lo puso el regex: no es dudoso
    sugerencias[clave] = propuesto;
    fields[sec][campo] = '';
    vaciados.push(clave);
  }
  // Las cifras sin respaldo también dejan su propuesta a la vista: el médico decide.
  for (const clave of sinEvidencia) {
    const [sec, campo] = clave.split('.');
    const propuesto = fields_ia[sec] && fields_ia[sec][campo];
    if (propuesto && !sugerencias[clave]) sugerencias[clave] = propuesto;
  }

  return {
    fields,
    fields_ia,                           // lo que la IA generó, ANTES de vaciar nada
    sources: principal.sources,
    dudosos: vaciados,
    sugerencias,
    sinEvidencia,
  };
}

// Huella del prompt del sistema. Cambiarlo cambia lo que el modelo extrae; sin registrar
// cuál se usó, una historia de marzo y una de mayo son incomparables y nadie puede explicar
// por qué. Con firma inmutable, eso es un problema legal, no estético.
const PROMPT_HASH = require('node:crypto').createHash('sha256').update(SYSTEM).digest('hex').slice(0, 12);

module.exports = { extractFields, available, emptyFields, normalize, compararPasadas, solapamiento, MODEL, contextFor, estimateTokens, CTX_MAX, PROMPT_HASH };
