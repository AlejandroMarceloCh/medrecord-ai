// whisper.js — transcripción local con whisper.cpp.
// Reusa la receta validada de Transcripciones/scripts/transcribe.sh:
//   ffmpeg → WAV 16kHz mono → whisper-cli con VAD silero + prompt de dominio.
// Rutas configurables por env; por defecto apuntan al build existente del usuario.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOME = os.homedir();
const WHISPER_HOME = process.env.WHISPER_HOME
  || path.join(HOME, 'Desktop/PROYECTOS_2026/Transcripciones/whisper.cpp');

const BIN   = process.env.WHISPER_BIN   || path.join(WHISPER_HOME, 'build/bin/whisper-cli');
// Modelo: turbo es ~3-4x más rápido que large-v3 con calidad similar. Lo usamos por
// defecto SI el archivo existe (no rompe instalaciones que solo tienen v3). Para fijarlo
// o forzar v3, usa WHISPER_MODEL. Conviene benchmarkear 2-3 audios reales en español.
function defaultModel() {
  const turbo = path.join(WHISPER_HOME, 'models/ggml-large-v3-turbo.bin');
  const v3    = path.join(WHISPER_HOME, 'models/ggml-large-v3.bin');
  return fs.existsSync(turbo) ? turbo : v3;
}
const MODEL = process.env.WHISPER_MODEL || defaultModel();
const VAD   = process.env.WHISPER_VAD   || path.join(WHISPER_HOME, 'models/ggml-silero-v5.1.2-v6.2.1-ggml.bin');
const FFMPEG = process.env.FFMPEG_BIN || 'ffmpeg';
const LANG = process.env.WHISPER_LANG || 'es';
const TIMEOUT_MS = Number(process.env.WHISPER_TIMEOUT_MS || 20 * 60 * 1000);

// Vocabulario clínico: sin esto whisper transcribe mal los términos médicos.
const MEDICAL_PROMPT = process.env.WHISPER_PROMPT || [
  'Transcripción de una consulta médica en español.',
  'Vocabulario: anamnesis, antecedentes, motivo de consulta, signos vitales,',
  'presión arterial, frecuencia cardíaca, frecuencia respiratoria, saturación de oxígeno,',
  'temperatura, taquicardia, bradicardia, disnea, cefalea, náuseas, dolor abdominal,',
  'hipertensión arterial, diabetes mellitus, examen físico, auscultación, murmullo vesicular,',
  'abdomen blando, impresión diagnóstica, diagnóstico, tratamiento, indicaciones, receta,',
  'miligramos, paracetamol, ibuprofeno, amoxicilina, omeprazol, losartán, metformina, CIE-10.',
].join(' ');

function run(cmd, args, { timeout } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timer = timeout ? setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`${path.basename(cmd)} timeout`)); }, timeout) : null;
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('error', (e) => { if (timer) clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (code === 0) resolve({ out, err });
      else reject(new Error(`${path.basename(cmd)} salió con código ${code}: ${err.slice(-500)}`));
    });
  });
}

// Colapsa runs de líneas idénticas consecutivas (red anti-bucle de whisper).
function dedupeLines(text) {
  const lines = text.split('\n');
  const out = [];
  let prev = null;
  for (const l of lines) {
    const norm = l.trim();
    if (norm && norm === prev) continue;
    out.push(l);
    prev = norm;
  }
  return out.join('\n');
}

function checkEnv() {
  const missing = [];
  if (!fs.existsSync(BIN)) missing.push(`whisper-cli (${BIN})`);
  if (!fs.existsSync(MODEL)) missing.push(`modelo (${MODEL})`);
  if (!fs.existsSync(VAD)) missing.push(`VAD (${VAD})`);
  return missing;
}

// Transcribe un archivo de audio (cualquier formato que ffmpeg entienda).
// Devuelve { text, wavPath }. Lanza si falta el entorno o falla whisper.
async function transcribe(inputPath, { lang = LANG, prompt = MEDICAL_PROMPT } = {}) {
  const missing = checkEnv();
  if (missing.length) throw new Error('Whisper no configurado: falta ' + missing.join(', '));

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'medrec-'));
  const wav = path.join(tmp, 'audio.wav');
  const outPrefix = path.join(tmp, 'out');

  try {
    // 1) ffmpeg → WAV 16kHz mono PCM
    await run(FFMPEG, ['-i', inputPath, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', '-y', wav, '-loglevel', 'error'],
      { timeout: 2 * 60 * 1000 });

    // 2) whisper-cli (receta "standard" anti-bucle + VAD + prompt de dominio)
    const ncpu = String(os.cpus().length || 4);
    const args = [
      '-m', MODEL, '-f', wav, '-of', outPrefix, '-otxt',
      '-l', lang, '--vad', '--vad-model', VAD, '--suppress-nst',
      '-bs', '1', '-bo', '1',
      '--temperature', '0.2', '--entropy-thold', '2.8', '--logprob-thold', '-0.5',
      '-t', ncpu,
    ];
    if (prompt) args.push('--prompt', prompt, '--carry-initial-prompt');
    await run(BIN, args, { timeout: TIMEOUT_MS });

    const txtPath = outPrefix + '.txt';
    if (!fs.existsSync(txtPath)) throw new Error('whisper no generó transcripción');
    const text = dedupeLines(fs.readFileSync(txtPath, 'utf8')).trim();
    return { text };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

module.exports = { transcribe, checkEnv, MEDICAL_PROMPT };
