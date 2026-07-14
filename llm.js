// llm.js — autollenado de campos clínicos con un LLM LOCAL (Ollama).
// Gratis, sin API key y la transcripción NUNCA sale de la máquina (data médica).
// Para testeo. Cambiar a Claude API después es trivial (mismo extractFields).
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
  '  "plan": {"tratamiento":"","examenes_solicitados":"","indicaciones":""}',
  '}',
  'Guía por campo: separa CADA signo vital en su campo. "presion_arterial" = PA en mmHg (ej. "120/80").',
  '"frecuencia_cardiaca" = FC en lpm (solo el número). "temperatura" = T° en °C. "saturacion" = SatO₂ en %.',
  '"sintomas" = síntomas y molestias referidos por el paciente. "tiempo_enfermedad" = cuánto lleva con el cuadro.',
  '"diagnosticos" = impresión diagnóstica en texto (uno o varios). "cie10" = código(s) CIE-10 solo si son claros.',
  '"antecedentes_personales" vs "antecedentes_familiares": sepáralos; no mezcles.',
  'Reglas: usa solo información presente en la transcripción. Si un dato no aparece,',
  'deja la cadena vacía "". NO inventes diagnósticos, dosis, códigos ni datos. Redacta en',
  'español clínico, conciso.',
  'Además incluye una clave "_fuentes": un objeto donde cada clave es "seccion.campo" y el',
  'valor es el FRAGMENTO EXACTO de la transcripción (copiado palabra por palabra, sin',
  'parafrasear ni acortar) que justifica ese dato. Incluye solo los campos que llenaste.',
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
function buildSources(parsed, transcript) {
  const out = {};
  const f = parsed && parsed._fuentes;
  const base = emptyFields();
  if (!f || typeof f !== 'object' || !transcript) return out;
  const { norm, map } = indexTranscript(transcript);
  for (const key of Object.keys(f)) {
    const [sec, field] = String(key).split('.');
    if (!base[sec] || !(field in base[sec])) continue;     // clave fuera del esquema → descarta
    const quote = String(f[key] || '').trim();
    if (quote.length < 4) continue;
    const q = quote.replace(/\s+/g, ' ').toLowerCase();
    const i = norm.indexOf(q);
    if (i === -1) continue;                                // no está en el audio → descarta
    const ini = map[i];
    const fin = map[i + q.length - 1] + 1;                 // devolvemos el tramo REAL del transcript,
    out[key] = transcript.slice(ini, fin);                 // con sus saltos y su acentuación originales
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
  // La fecha de consulta la conocemos por el momento de la grabación, no por el audio.
  if (!out.filiacion.fecha_consulta && date) {
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

// Extrae campos clínicos de una transcripción. Lanza si Ollama falla.
async function extractFields(transcript, { patient, date } = {}) {
  const num_ctx = contextFor(transcript);
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
        `TRANSCRIPCIÓN:\n"""\n${transcript}\n"""\n\nDevuelve solo el JSON.` },
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

// Huella del prompt del sistema. Cambiarlo cambia lo que el modelo extrae; sin registrar
// cuál se usó, una historia de marzo y una de mayo son incomparables y nadie puede explicar
// por qué. Con firma inmutable, eso es un problema legal, no estético.
const PROMPT_HASH = require('node:crypto').createHash('sha256').update(SYSTEM).digest('hex').slice(0, 12);

module.exports = { extractFields, available, emptyFields, normalize, MODEL, contextFor, estimateTokens, CTX_MAX, PROMPT_HASH };
