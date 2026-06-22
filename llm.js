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

// Conserva SOLO las citas que existen literalmente en la transcripción (verificables).
// Una cita que el LLM parafraseó o inventó se descarta: preferimos no resaltar a mentir.
function buildSources(parsed, transcript) {
  const out = {};
  const f = parsed && parsed._fuentes;
  const base = emptyFields();
  if (!f || typeof f !== 'object' || !transcript) return out;
  const low = transcript.toLowerCase();
  for (const key of Object.keys(f)) {
    const [sec, field] = String(key).split('.');
    if (!base[sec] || !(field in base[sec])) continue;     // clave fuera del esquema → descarta
    const quote = String(f[key] || '').trim();
    if (quote.length < 4) continue;
    const i = low.indexOf(quote.toLowerCase());
    if (i === -1) continue;                                  // no es verbatim → descarta (fallback)
    out[key] = transcript.slice(i, i + quote.length);        // substring real, con su acentuación original
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

// Extrae campos clínicos de una transcripción. Lanza si Ollama falla.
async function extractFields(transcript, { patient, date } = {}) {
  const body = {
    model: MODEL,
    stream: false,
    format: 'json',
    // keep_alive: mantén el modelo cargado entre pacientes (evita recarga en frío
    // de ~5 s cada autollenado). No '-1' porque la Mac es de uso dual.
    keep_alive: process.env.OLLAMA_KEEP_ALIVE || '30m',
    options: { temperature: 0.1, num_ctx: 8192 },
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

module.exports = { extractFields, available, emptyFields, normalize, MODEL };
