// clinical-values.js — extracción y validación DETERMINISTA de cifras clínicas.
//
// Los números no deberían pasar por un LLM. Una presión arterial, una frecuencia cardiaca o
// una dosis son patrones, no lenguaje: un regex los saca sin inventar nada, y un 7B puede
// alucinarlos. El costo del error es asimétrico —un campo vacío que el médico llena a mano
// es barato; un número inventado que no detecta es catastrófico—, así que aquí preferimos
// siempre vaciar antes que adivinar.
//
// Dos trabajos:
//   1. extraerVitales(transcript) — saca los signos vitales del texto, incluso dictados en
//      palabras ("ciento veinte sobre ochenta").
//   2. validarContraTranscripcion(fields, transcript) — cualquier cifra que el LLM haya
//      puesto y que NO esté literalmente en el audio, se vacía y se marca sin evidencia.

// ── Números en palabras (el médico dicta, no escribe) ────────────────────────
const UNIDADES = {
  cero: 0, uno: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7,
  ocho: 8, nueve: 9, diez: 10, once: 11, doce: 12, trece: 13, catorce: 14, quince: 15,
  dieciseis: 16, diecisiete: 17, dieciocho: 18, diecinueve: 19, veinte: 20,
  veintiuno: 21, veintidos: 22, veintitres: 23, veinticuatro: 24, veinticinco: 25,
  veintiseis: 26, veintisiete: 27, veintiocho: 28, veintinueve: 29,
  treinta: 30, cuarenta: 40, cincuenta: 50, sesenta: 60, setenta: 70, ochenta: 80, noventa: 90,
  cien: 100, ciento: 100, doscientos: 200, trescientos: 300, cuatrocientos: 400,
  quinientos: 500, seiscientos: 600, setecientos: 700, ochocientos: 800, novecientos: 900,
  mil: 1000,
};

const sinTildes = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

// "ciento cuarenta y cinco" → 145. Suma acumulativa, que es como se dicen los números
// en español; suficiente para el rango clínico (0-300).
function palabrasANumero(texto) {
  const palabras = sinTildes(texto).split(/\s+|-/).filter(Boolean);
  let total = 0, hubo = false, previo = Infinity;
  for (const p of palabras) {
    if (p === 'y') continue;
    const v = UNIDADES[p];
    if (v === undefined) return null;
    // El español dice los números de mayor a menor: "ciento cuarenta y cinco". Sin esta
    // regla, "cinco veinte" daba 25 y "dos ciento" daba 102 — números plausibles, dentro
    // del rango fisiológico, y completamente inventados.
    if (v >= previo) return null;
    total += v;
    previo = v;
    hubo = true;
  }
  return hubo ? total : null;
}

// Convierte los números escritos en palabras a dígitos, dentro de todo el texto. Así el
// resto del pipeline (y la validación contra el audio) trabaja siempre con cifras.
function digitalizar(texto) {
  let t = sinTildes(texto);
  const nums = Object.keys(UNIDADES).sort((a, b) => b.length - a.length).join('|');
  // Secuencias de hasta 4 palabras-número seguidas: "ciento cuarenta y cinco".
  const re = new RegExp(`\\b(?:${nums})(?:\\s+(?:y\\s+)?(?:${nums})){0,3}\\b`, 'g');
  t = t.replace(re, (m) => {
    const n = palabrasANumero(m);
    return n === null ? m : String(n);
  });
  // El decimal dictado: "36 punto 8" → "36.8". Sin esto la temperatura perdía el decimal,
  // que en clínica es la diferencia entre febrícula y fiebre.
  t = t.replace(/(\d+)\s+(?:punto|coma)\s+(\d+)/g, '$1.$2');
  return t;
}

// ── Extracción de signos vitales ─────────────────────────────────────────────
// Rangos fisiológicos: fuera de ellos, lo más probable es que el patrón haya capturado
// otra cosa (una edad, una dosis). Preferimos no poner nada.
const RANGOS = {
  presion_arterial:    null,                    // se valida por partes
  frecuencia_cardiaca: [20, 250],
  temperatura:         [30, 45],
  saturacion:          [50, 100],
};

function extraerVitales(transcript) {
  const t = digitalizar(transcript);
  const out = {};

  // Presión arterial: "120/80", "120 sobre 80".
  //
  // Si en la consulta se dicen DOS presiones ("la de la mamá era 180 sobre 100, la del
  // paciente 120 sobre 80"), no hay forma de saber cuál es cuál sin diarización — y Whisper
  // no diariza. Antes tomábamos la primera, que en una consulta con acompañante puede ser la
  // de otra persona. Ahora no ponemos ninguna: que la escriba el médico.
  const todas = [...t.matchAll(/(\d{2,3})\s*(?:\/|sobre)\s*(\d{2,3})/g)].filter(m => {
    const sis = Number(m[1]), dia = Number(m[2]);
    return sis >= 60 && sis <= 260 && dia >= 30 && dia <= 160 && sis > dia;
  });
  if (todas.length === 1) {
    out.presion_arterial = `${Number(todas[0][1])}/${Number(todas[0][2])}`;
  }

  // Un dato que NO es del paciente. Sin diarización no sabemos quién habla, así que ante la
  // duda no ponemos nada: un campo vacío es barato, uno equivocado no.
  //   · "frecuencia cardíaca FETAL de 140" — 140 lpm es normal en un feto y taquicardia
  //     franca en un adulto. Meterla como FC del paciente es un error clínico grave.
  //   · "temperatura AMBIENTE 30 grados" — 30 °C entra en el rango fisiológico y pasaba.
  const AJENO = /\b(fetal|ambiente|habitacion|cuarto|sala|mama|madre|padre|acompanante|hijo|hija)\b/;

  const cap = (re, campo, contexto = 26) => {
    const m = t.match(re);
    if (!m) return;
    // Ventana alrededor del match: si ahí aparece un descriptor ajeno, no es del paciente.
    const ini = Math.max(0, m.index - contexto);
    const ventana = t.slice(ini, m.index + m[0].length + 8);
    if (AJENO.test(ventana)) return;

    const v = Number(String(m[1]).replace(',', '.'));
    const [min, max] = RANGOS[campo];
    if (Number.isFinite(v) && v >= min && v <= max) out[campo] = String(m[1]).replace(',', '.');
  };

  cap(/(?:frecuencia\s+cardiaca|pulso|fc)\D{0,12}?(\d{2,3})/, 'frecuencia_cardiaca');
  cap(/(?:temperatura|temp)\D{0,12}?(\d{2}(?:[.,]\d)?)/, 'temperatura');
  cap(/(?:saturacion|satura|sato2|spo2|sat)\D{0,12}?(\d{2,3})/, 'saturacion');

  return out;
}

// ── Validación contra la transcripción ───────────────────────────────────────
// El goal dice "NINGÚN número clínico". Una lista de seis campos no es "ninguno": una dosis
// inventada entraba tranquilamente por `plan.indicaciones` ("paracetamol 1000 mg cada 8
// horas"), por `anamnesis.sintomas` ("fiebre de 39") o por el diagnóstico. Cualquier campo
// que salga del audio se valida.
//
// Los que NO salen del audio quedan fuera: el nombre, el documento y la fecha los pone el
// registro del médico y la app, no el paciente hablando. Validarlos contra el audio los
// vaciaría siempre.
const NO_SALEN_DEL_AUDIO = new Set([
  'filiacion.nombre', 'filiacion.documento', 'filiacion.fecha_consulta',
]);

function camposAValidar(fields) {
  const out = [];
  for (const sec of Object.keys(fields || {})) {
    for (const campo of Object.keys(fields[sec] || {})) {
      const clave = `${sec}.${campo}`;
      if (!NO_SALEN_DEL_AUDIO.has(clave)) out.push(clave);
    }
  }
  return out;
}

// Compatibilidad: los campos numéricos "duros" (los que además valida el regex).
const CAMPOS_NUMERICOS = [
  'examen_fisico.presion_arterial',
  'examen_fisico.frecuencia_cardiaca',
  'examen_fisico.temperatura',
  'examen_fisico.saturacion',
  'examen_fisico.peso_talla',
  'plan.tratamiento',
];

// ¿El valor está respaldado por el audio?
//
// Buscar los dígitos SUELTOS no basta y es peligroso: si el modelo inventa una presión de
// "120/80", el audio dice "hace 120 días" y "pesa 80 kilos", los dos números existen y la
// presión inventada pasaba la validación. Una presión que nadie tomó, firmada por el médico.
//
// Así que la presión se valida como PAR (el patrón sistólica/diastólica tiene que estar en
// el audio), y los demás números tienen que aparecer con su contexto o al menos como cifra
// aislada, no como parte de otro número ("8" dentro de "80").
// ¿El número aparece como cifra propia, no como parte de otra?
//
// Ojo con el punto final: "la temperatura 36.8." termina en punto de frase, no en decimal.
// Un lookahead que rechazara cualquier "." vaciaba una temperatura correcta — un falso
// negativo también es un fallo: borra un dato que el médico SÍ dijo.
function numeroSuelto(n, texto) {
  const esc = n.replace('.', '\\.');
  return new RegExp(`(?<![\\d.])${esc}(?!\\d)(?!\\.\\d)`).test(texto);
}

function numerosRespaldados(valor, transcriptDigitalizado, clave) {
  const v = String(valor);

  // Presión arterial: el PAR tiene que estar dicho junto. No vale que los dos números
  // anden sueltos por el audio en frases que no tienen nada que ver.
  if (clave === 'examen_fisico.presion_arterial') {
    const m = v.match(/(\d{2,3})\s*\/\s*(\d{2,3})/);
    if (!m) return false;
    const par = new RegExp(`${m[1]}\\s*(?:\\/|sobre)\\s*${m[2]}`);
    return par.test(transcriptDigitalizado);
  }

  const numeros = v.match(/\d+(?:[.,]\d+)?/g);
  if (!numeros) return true;                       // sin cifras, nada que validar aquí
  return numeros.every(n => {
    const limpio = n.replace(',', '.');
    // Como cifra aislada, o su parte entera ("36.8" dicho como "36 punto 8" ya viene
    // digitalizado, pero el modelo puede escribir "36" a secas).
    return numeroSuelto(limpio, transcriptDigitalizado)
        || numeroSuelto(limpio.split('.')[0], transcriptDigitalizado);
  });
}

// Vacía las cifras que no están en el audio y devuelve qué campos se marcaron.
// Devuelve { fields, sinEvidencia: ['examen_fisico.presion_arterial', ...] }
function validarContraTranscripcion(fields, transcript) {
  const sinEvidencia = [];
  if (!fields || !transcript) return { fields, sinEvidencia };
  const t = digitalizar(transcript);

  for (const clave of camposAValidar(fields)) {
    const [sec, campo] = clave.split('.');
    const valor = fields[sec] && fields[sec][campo];
    if (!valor || !String(valor).trim()) continue;
    if (numerosRespaldados(valor, t, clave)) continue;

    // El número NO está en el audio: lo más probable es que el modelo lo haya inventado, o
    // que Whisper haya transcrito mal. Vaciarlo y decirlo. Un campo vacío es barato; una
    // presión arterial inventada que el médico confirma en cadena, no.
    fields[sec][campo] = '';
    sinEvidencia.push(clave);
  }
  return { fields, sinEvidencia };
}

module.exports = {
  extraerVitales, validarContraTranscripcion, digitalizar, palabrasANumero,
  CAMPOS_NUMERICOS, camposAValidar, NO_SALEN_DEL_AUDIO,
};
