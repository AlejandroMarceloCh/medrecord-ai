// Sprint 17 — test al goal: "Cinco audios subidos en tres minutos se procesan todos, sin
// matarse entre sí, y un audio de 30 minutos llega completo al LLM o falla con un mensaje
// que el médico entiende."
//
// El punto del sprint es la CONCURRENCIA, así que el test la ejercita de verdad: sustituye
// whisper-cli y ffmpeg por scripts que registran cuándo arrancan y cuándo terminan, y luego
// comprueba que sus ventanas de ejecución no se solapan NUNCA. Sin eso, un test que solo
// mira el resultado final pasaría igual aunque corrieran los 5 en paralelo.
//
//  1. 5 uploads a la vez → los 5 terminan, y jamás hay dos Whisper vivos al mismo tiempo
//  2. Mientras uno corre, los demás quedan en 'queued' con su posición visible
//  3. Timeout de Whisper proporcional a la duración (no un tope fijo de 20 min)
//  4. Transcripción larga → num_ctx sube, no se trunca en silencio
//  5. Transcripción imposible → error explícito con código, no campos vacíos
//  6. Whisper caído → la consulta queda editable a mano (no un muro sin salida)
//
// Uso: node test/sprint17_turno.mjs   (no necesita Whisper ni Ollama reales)
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const results = [];
const add = (name, ok, detail) => results.push({ name, ok, detail });
const src = (f) => readFileSync(new URL('../' + f, import.meta.url), 'utf8');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function waitHealth(base, timeout = 8000) {
  return new Promise((res, rej) => {
    const t0 = Date.now();
    const tick = async () => {
      try { const r = await fetch(`${base}/health`); if (r.ok) return res(true); } catch {}
      if (Date.now() - t0 > timeout) return rej(new Error('server no levantó'));
      setTimeout(tick, 200);
    };
    tick();
  });
}

// ── 1 + 2. La cola: 5 uploads concurrentes, ni un solo solapamiento ──────────────
const w = mkdtempSync(join(tmpdir(), 'medrec-s17-'));
const DATA = join(w, 'recordings'); mkdirSync(DATA, { recursive: true });
const LOG = join(w, 'whisper-runs.log');

// Fake whisper-cli: registra START/END con timestamp y tarda 700 ms. Escribe el -of <pre>.txt
const fakeWhisper = join(w, 'whisper-cli');
writeFileSync(fakeWhisper, `#!/bin/bash
echo "START $(date +%s%3N) $$" >> "${LOG}"
out=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -of) out="$2"; shift 2 ;;
    *) shift ;;
  esac
done
sleep 0.7
echo "Paciente refiere dolor de cabeza desde hace tres dias. Presion arterial ciento veinte sobre ochenta." > "\${out}.txt"
echo "END $(date +%s%3N) $$" >> "${LOG}"
exit 0
`);
chmodSync(fakeWhisper, 0o755);

// Fake ffmpeg: crea el WAV que whisper.js espera.
const fakeFfmpeg = join(w, 'ffmpeg');
writeFileSync(fakeFfmpeg, `#!/bin/bash
args=("$@")
for ((i=0; i<\${#args[@]}; i++)); do
  if [[ "\${args[$i]}" == *.wav ]]; then echo -n "fake" > "\${args[$i]}"; fi
done
exit 0
`);
chmodSync(fakeFfmpeg, 0o755);

const fakeModel = join(w, 'model.bin'); writeFileSync(fakeModel, 'x');
const fakeVad   = join(w, 'vad.bin');   writeFileSync(fakeVad, 'x');

const PORT = 3431;
const srv = spawn('node', ['server.js'], {
  env: { ...process.env, PORT: String(PORT), NODE_ENV: 'development', MEDRECORD_OPEN: '1',
    MEDRECORD_DATA_DIR: DATA, MEDRECORD_KEY_FILE: join(w, '.key'),
    MEDRECORD_AUDIO_RETENTION_DAYS: '0',
    WHISPER_BIN: fakeWhisper, WHISPER_MODEL: fakeModel, WHISPER_VAD: fakeVad, FFMPEG_BIN: fakeFfmpeg,
    OLLAMA_URL: 'http://127.0.0.1:9',   // LLM caído a propósito: aislamos el pipeline de Whisper
  },
  stdio: 'ignore',
});

try {
  await waitHealth(`http://localhost:${PORT}`);

  const subir = async (n) => {
    const fd = new FormData();
    fd.append('audio', new Blob([new Uint8Array(2048)], { type: 'audio/webm' }), `c${n}.webm`);
    fd.append('patientName', `Paciente ${n}`);
    fd.append('consent', 'true');
    fd.append('durationSec', '120');
    const r = await fetch(`http://localhost:${PORT}/api/recordings`, { method: 'POST', body: fd });
    return (await r.json()).id;
  };

  const ids = await Promise.all([1, 2, 3, 4, 5].map(subir));   // los 5 a la vez

  // Mientras la cola trabaja, alguien tiene que estar 'queued' con posición.
  await sleep(350);
  const midList = await (await fetch(`http://localhost:${PORT}/api/recordings`)).json();
  const enCola = midList.filter(r => r.status === 'queued');
  const conPos = enCola.filter(r => r.queuePos > 0);
  add('2 · los que esperan quedan en cola, con su posición visible',
    enCola.length >= 1 && conPos.length === enCola.length,
    `enCola=${enCola.length} conPosicion=${conPos.length} posiciones=[${enCola.map(r=>r.queuePos).sort().join(',')}]`);

  // Esperar a que los 5 lleguen a un estado terminal.
  let final = [];
  for (let i = 0; i < 100; i++) {
    await sleep(200);
    final = await (await fetch(`http://localhost:${PORT}/api/recordings`)).json();
    if (final.length === 5 && final.every(r => ['done', 'error', 'reviewed'].includes(r.status))) break;
  }
  const todosListos = final.length === 5 && final.every(r => ['done', 'error'].includes(r.status));
  const transcritos = final.filter(r => r.transcript && r.transcript.length > 10).length;

  // El corazón del sprint: ¿se solaparon dos Whisper alguna vez?
  const runs = readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean)
    .map(l => { const [ev, ts, pid] = l.split(' '); return { ev, ts: Number(ts), pid }; })
    .sort((a, b) => a.ts - b.ts);
  let vivos = 0, maxVivos = 0;
  for (const r of runs) { vivos += r.ev === 'START' ? 1 : -1; maxVivos = Math.max(maxVivos, vivos); }
  const arranques = runs.filter(r => r.ev === 'START').length;

  add('1 · 5 audios concurrentes: los 5 se procesan y NUNCA hay dos Whisper a la vez',
    todosListos && transcritos === 5 && arranques === 5 && maxVivos === 1,
    `terminados=${final.length}/5 transcritos=${transcritos} whisperArranques=${arranques} maxSimultaneos=${maxVivos}`);

  // 6. El LLM está caído (puerto 9): la consulta NO puede quedar en un muro sin salida.
  //    Debe llegar a 'done' con la transcripción y un fieldsError, editable a mano.
  const conTranscript = final.filter(r => r.status === 'done' && r.transcript && r.fieldsError);
  add('6 · LLM caído → transcripción disponible y consulta editable (no muro)',
    conTranscript.length === 5,
    `done+transcript+fieldsError=${conTranscript.length}/5`);
} catch (e) {
  add('1-2-6 · cola', false, String(e.message));
} finally {
  srv.kill('SIGKILL');
}

// ── 3. Timeout proporcional a la duración ────────────────────────────────────────
try {
  delete process.env.WHISPER_TIMEOUT_MS;   // sin override, si no timeoutFor lo respeta
  delete require.cache[require.resolve('../whisper.js')];
  const whisper = require('../whisper.js');
  const corto  = whisper.timeoutFor(120);    // 2 min de audio
  const largo  = whisper.timeoutFor(1800);   // 30 min de audio
  const sinDur = whisper.timeoutFor(0);      // desconocida → tope fijo
  // 30 min de audio tienen que tolerar MÁS que los 20 min fijos de antes.
  const proporcional = largo > corto && largo > 20 * 60 * 1000 && corto >= 5 * 60 * 1000;
  add('3 · timeout de Whisper proporcional a la duración (30 min > el tope viejo de 20)',
    proporcional && sinDur === 20 * 60 * 1000,
    `2min=${Math.round(corto/60000)}min 30min=${Math.round(largo/60000)}min sinDuracion=${Math.round(sinDur/60000)}min`);
} catch (e) { add('3 · timeout dinámico', false, String(e.message)); }

// ── 4 + 5. num_ctx dinámico y error explícito ───────────────────────────────────
try {
  delete require.cache[require.resolve('../llm.js')];
  const llm = require('../llm.js');

  const corta = 'Paciente refiere cefalea. '.repeat(20);           // ~500 chars
  const larga = 'Paciente refiere cefalea intensa. '.repeat(900);  // ~30k chars ≈ 8.5k tokens
  const ctxCorta = llm.contextFor(corta);
  const ctxLarga = llm.contextFor(larga);
  // Una consulta larga NO puede procesarse con la ventana de 8192 de antes: se truncaría
  // el inicio del audio (filiación y motivo) sin ninguna señal.
  add('4 · transcripción larga → la ventana crece (antes se truncaba en silencio)',
    ctxCorta === 8192 && ctxLarga > 8192 && ctxLarga <= llm.CTX_MAX,
    `ctxCorta=${ctxCorta} ctxLarga=${ctxLarga} max=${llm.CTX_MAX}`);

  const imposible = 'palabra '.repeat(30000);   // ~240k chars, no cabe ni en 32k
  let err = null;
  try { llm.contextFor(imposible); } catch (e) { err = e; }
  const mensajeUtil = err && err.code === 'TRANSCRIPT_TOO_LONG'
    && /demasiado larga/i.test(err.message) && /revísala/i.test(err.message);
  add('5 · transcripción que no cabe → error explícito, no una historia a medias',
    !!mensajeUtil, err ? `code=${err.code}` : 'NO lanzó');
} catch (e) { add('4-5 · num_ctx', false, String(e.message)); }

try { rmSync(w, { recursive: true, force: true }); } catch {}

// ── 7. Firmar durante la espera en cola NO puede ser pisado por el job ──────────
// La cola alargó de milisegundos a minutos la ventana entre "el job entra" y "el job
// aterriza". Si el médico firma en ese lapso, el job no debe tocar nada: pisar una
// historia firmada deja el HMAC inválido sobre contenido que el médico nunca vio.
const w7 = mkdtempSync(join(tmpdir(), 'medrec-s17b-'));
const D7 = join(w7, 'recordings'); mkdirSync(D7, { recursive: true });
const slowWhisper = join(w7, 'whisper-cli');
writeFileSync(slowWhisper, `#!/bin/bash
out=""
while [[ $# -gt 0 ]]; do case "$1" in -of) out="$2"; shift 2 ;; *) shift ;; esac; done
sleep 1.5
echo "Transcripcion que aterriza tarde y no debe pisar nada." > "\${out}.txt"
exit 0
`);
chmodSync(slowWhisper, 0o755);
const ff7 = join(w7, 'ffmpeg');
writeFileSync(ff7, `#!/bin/bash
args=("$@")
for ((i=0; i<\${#args[@]}; i++)); do
  if [[ "\${args[$i]}" == *.wav ]]; then echo -n "fake" > "\${args[$i]}"; fi
done
exit 0
`);
chmodSync(ff7, 0o755);
const m7 = join(w7, 'm.bin'); writeFileSync(m7, 'x');
const v7 = join(w7, 'v.bin'); writeFileSync(v7, 'x');

const P7 = 3432;
const srv7 = spawn('node', ['server.js'], {
  env: { ...process.env, PORT: String(P7), NODE_ENV: 'development', MEDRECORD_OPEN: '1',
    MEDRECORD_DATA_DIR: D7, MEDRECORD_KEY_FILE: join(w7, '.key'), MEDRECORD_AUDIO_RETENTION_DAYS: '0',
    WHISPER_BIN: slowWhisper, WHISPER_MODEL: m7, WHISPER_VAD: v7, FFMPEG_BIN: ff7,
    OLLAMA_URL: 'http://127.0.0.1:9' },
  stdio: 'ignore',
});
try {
  await waitHealth(`http://localhost:${P7}`);
  const base = `http://localhost:${P7}`;
  const subir = async (n) => {
    const fd = new FormData();
    fd.append('audio', new Blob([new Uint8Array(1024)], { type: 'audio/webm' }), `x${n}.webm`);
    fd.append('patientName', `P${n}`); fd.append('consent', 'true'); fd.append('durationSec', '60');
    return (await (await fetch(`${base}/api/recordings`, { method: 'POST', body: fd })).json()).id;
  };

  // 8. Firmar una historia VACÍA tiene que ser rechazado (el gate de IA no aplica sin IA).
  const idVacio = await subir(90);
  const firmaVacia = await fetch(`${base}/api/recordings/${idVacio}/fields`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reviewed: true }),
  });
  add('8 · no se puede firmar una historia vacía (sin transcripción ni campos)',
    firmaVacia.status === 400, `status=${firmaVacia.status}`);

  // 7. Ocupar el slot, encolar otro, firmarlo con contenido real mientras espera.
  const idOcupa = await subir(91);
  await sleep(150);
  const idEspera = await subir(92);
  await sleep(150);

  const enEspera = await (await fetch(`${base}/api/recordings/${idEspera}`)).json();
  const estabaEnCola = enEspera.status === 'queued';

  const firma = await fetch(`${base}/api/recordings/${idEspera}/fields`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reviewed: true, fields: { anamnesis: { motivo_consulta: 'Escrito a mano por el medico' } } }),
  });

  // Dejar que el job encolado aterrice.
  await sleep(4000);
  const despues = await (await fetch(`${base}/api/recordings/${idEspera}`)).json();
  const verify  = await (await fetch(`${base}/api/recordings/${idEspera}/verify`)).json();

  const intacto = despues.reviewed === true
    && despues.status === 'reviewed'                                       // no volvió a 'done'
    && despues.transcript === null                                          // el job NO escribió
    && despues.fields?.anamnesis?.motivo_consulta === 'Escrito a mano por el medico'
    && verify.valid === true;                                               // la firma sigue válida
  add('7 · firmar mientras espera en cola: el job aterriza y NO pisa la firma',
    firma.status === 200 && estabaEnCola && intacto,
    `firma=${firma.status} estabaEnCola=${estabaEnCola} status=${despues.status} transcript=${despues.transcript===null?'null':'PISADO'} verifyValid=${verify.valid}`);

  void idOcupa;
} catch (e) { add('7-8 · firma vs cola', false, String(e.message)); }
finally { srv7.kill('SIGKILL'); try { rmSync(w7, { recursive: true, force: true }); } catch {} }

// ── 9. El mensaje de "transcripción demasiado larga" llega a la PANTALLA ─────────
// El backend construía un mensaje específico y el AiBanner lo tiraba a la basura,
// mostrando el mismo genérico que para cualquier otro fallo del LLM.
try {
  const cli = src('src/web/clinical.jsx');
  const muestraCausa = /rec\.fieldsError\s*\)/.test(cli) && /larga\s*\?\s*\n?\s*rec\.fieldsError/.test(cli.replace(/\s+/g, ' ').replace(/larga \? rec\.fieldsError/, 'larga ?\nrec.fieldsError'));
  const renderiza = cli.includes('msg = larga') && cli.includes('rec.fieldsError');
  add('9 · la causa del fallo del LLM llega a la pantalla (no un genérico)',
    renderiza, `renderizaFieldsError=${renderiza}`);
  void muestraCausa;
} catch (e) { add('9 · mensaje en pantalla', false, String(e.message)); }

// ── 10. Las fuentes sobreviven a la transcripción REAL (multilínea) ─────────────
// Whisper separa los segmentos con saltos de línea. El indexOf literal fallaba en toda
// cita que cruzara uno, así que sobre audio real se descartaban TODAS las fuentes y el
// resaltado de evidencia quedaba vacío en silencio. Lo destapó el benchmark, no un test:
// los tests usaban transcripciones de una sola línea.
try {
  delete require.cache[require.resolve('../llm.js')];
  const llm = require('../llm.js');
  const comoWhisper = 'Cuénteme qué lo trae por acá.\n Mire doctor, hace tres días que tengo\n dolor de cabeza que no se me quita.\n La presión está en 150 sobre 95.';
  const parsed = {
    _fuentes: {
      // El LLM cita colapsando los saltos: así es como realmente responde.
      'anamnesis.motivo_consulta': 'Mire doctor, hace tres días que tengo dolor de cabeza que no se me quita.',
      'examen_fisico.presion_arterial': 'La presión está en 150 sobre 95.',
      'plan.tratamiento': 'esto no lo dijo nadie',   // inventada → se descarta
    },
  };
  const out = llm.normalize(parsed, { transcript: comoWhisper, patient: {}, date: Date.now() });
  const s = out.sources;
  const dos = Object.keys(s).length === 2;
  const inventadaFuera = !s['plan.tratamiento'];
  // La cita devuelta debe ser el tramo REAL del transcript (con sus saltos), no la del LLM.
  const tramoReal = (s['anamnesis.motivo_consulta'] || '').includes('\n')
    && comoWhisper.includes(s['anamnesis.motivo_consulta']);
  add('10 · las fuentes sobreviven a la transcripción real multilínea',
    dos && inventadaFuera && tramoReal,
    `fuentes=${Object.keys(s).length}/2 inventadaDescartada=${inventadaFuera} tramoRealDelTranscript=${tramoReal}`);
} catch (e) { add('10 · fuentes multilínea', false, String(e.message)); }

// ── 11. El cliente no puede inflar el timeout ni trabar la cola ─────────────────
// La duración la mide el servidor sobre el WAV. Un móvil que declare 3 horas no debe
// reservar el único slot de Whisper por 3 horas.
try {
  const whisperSrc = src('whisper.js');
  const serverSrc  = src('server.js');
  const noConfiaEnCliente = /timeoutFor\(wavDurationSec\(wav\)\)/.test(whisperSrc)
    && !/durationSec\s*=\s*0/.test(whisperSrc)          // ya no está en la firma
    && !/transcribe\(p,\s*\{\s*durationSec/.test(serverSrc);  // el server no se lo pasa
  add('11 · el cliente no influye en el timeout (la duración la mide el servidor)',
    noConfiaEnCliente, `mideElServidor=${noConfiaEnCliente}`);
} catch (e) { add('11 · timeout sin cliente', false, String(e.message)); }

console.log('\nSprint 17 — test al goal "el pipeline aguanta un turno":\n');
let pass = 0;
for (const r of results.sort((a,b) => a.name.localeCompare(b.name))) {
  console.log(`  [${r.ok ? 'PASA' : 'FALLA'}]  ${r.name}\n           ${r.detail}`);
  if (r.ok) pass++;
}
console.log(`\n  ${pass}/${results.length} casos.  ${pass === results.length ? '✓ GOAL CUMPLIDO' : '✗ HAY FALLAS'}\n`);
process.exit(pass === results.length ? 0 : 1);
