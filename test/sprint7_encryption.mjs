// Sprint 7 — test al goal: "cifrado en reposo + sin PII en logs".
//
// Verifica:
//  1. El sidecar JSON en disco NO contiene nombre/DNI/transcripción en claro
//  2. El audio en disco NO contiene los bytes originales en claro
//  3. El endpoint devuelve los datos descifrados correctamente (ida y vuelta)
//  4. stdout/stderr del server NO contienen PII durante el flujo
//  5. La clave maestra se crea con permisos 0600
//  6. Migración: un sidecar legacy EN CLARO se re-cifra al arrancar
//
// Corre aislado en un DATA_DIR temporal (no toca data/ real). No necesita Ollama.
// Uso: node test/sprint7_encryption.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 3402;
const BASE = `http://localhost:${PORT}`;
const NAME = 'Ana García Pérez';
const DNI  = '47829163';
const AUDIO_MARKER = 'ESTE-AUDIO-EN-CLARO-NO-DEBE-APARECER';

const work = mkdtempSync(join(tmpdir(), 'medrec-s7-'));
const DATA = join(work, 'recordings');
const KEY  = join(work, 'master.key');
import { mkdirSync } from 'node:fs';
mkdirSync(DATA, { recursive: true });

// Sidecar legacy EN CLARO para probar migración (id distinto, sin audio).
const legacyId = 'legacy-plain';
writeFileSync(join(DATA, legacyId + '.json'), JSON.stringify({ id: legacyId, patient: { name: 'Legacy User' }, transcript: 'viejo en claro' }));

const results = [];
const add = (name, ok, detail) => results.push({ name, ok, detail });
let logBuf = '';

function waitHealth(timeout = 8000) {
  return new Promise((res, rej) => {
    const t0 = Date.now();
    const tick = async () => {
      try { const r = await fetch(`${BASE}/health`); if (r.ok) return res(true); } catch {}
      if (Date.now() - t0 > timeout) return rej(new Error('server no levantó'));
      setTimeout(tick, 250);
    };
    tick();
  });
}

const srv = spawn('node', ['server.js'], {
  env: { ...process.env, MEDRECORD_OPEN: '1', PORT: String(PORT), NODE_ENV: 'development',
         MEDRECORD_DATA_DIR: DATA, MEDRECORD_KEY_FILE: KEY },
  stdio: ['ignore', 'pipe', 'pipe'],
});
srv.stdout.on('data', d => { logBuf += d; });
srv.stderr.on('data', d => { logBuf += d; });

try {
  await waitHealth();

  // Sube una grabación con audio que contiene un marcador conocido en claro.
  const audioBytes = Buffer.from(`${AUDIO_MARKER} ${'\x00\x01\x02'.repeat(100)}`);
  const fd = new FormData();
  fd.append('audio', new Blob([audioBytes], { type: 'audio/webm' }), 'consulta.webm');
  fd.append('patientName', NAME);
  fd.append('patientDni', DNI);
  fd.append('durationSec', '12');
  fd.append('consent', 'true');
  const up = await fetch(`${BASE}/api/recordings`, { method: 'POST', body: fd });
  const { id } = await up.json();

  // Espera a que persista (el POST persiste sincrónicamente antes de responder).
  await new Promise(r => setTimeout(r, 300));

  // ── 1. Sidecar en disco sin PII en claro ──
  const sidecarRaw = readFileSync(join(DATA, id + '.json'));
  const sidecarStr = sidecarRaw.toString('latin1');
  const sidecarClean = !sidecarStr.includes(NAME) && !sidecarStr.includes(DNI) && !sidecarStr.includes('"patient"');
  add('1 · sidecar cifrado (sin PII en claro)', sidecarClean,
    sidecarClean ? 'no aparece nombre/DNI/estructura' : 'PII LEGIBLE en el sidecar');

  // ── 2. Audio en disco sin los bytes originales ──
  const audioRaw = readFileSync(join(DATA, id + '.audio')).toString('latin1');
  const audioClean = !audioRaw.includes(AUDIO_MARKER);
  add('2 · audio cifrado (sin marcador en claro)', audioClean,
    audioClean ? 'marcador no aparece' : 'AUDIO LEGIBLE en disco');

  // ── 3. Ida y vuelta: el endpoint descifra ──
  const got = await (await fetch(`${BASE}/api/recordings/${id}`)).json();
  const rtOk = got.patient.name === NAME && got.patient.dni === DNI;
  add('3 · endpoint devuelve descifrado', rtOk, `name=${got.patient.name} dni=${got.patient.dni}`);
  const audioBack = Buffer.from(await (await fetch(`${BASE}/api/recordings/${id}/audio`)).arrayBuffer());
  add('3b · audio descifrado ida y vuelta', audioBack.equals(audioBytes),
    audioBack.equals(audioBytes) ? 'bytes idénticos' : `len ${audioBack.length} vs ${audioBytes.length}`);

  // ── 4. Logs sin PII ──
  const logClean = !logBuf.includes(NAME) && !logBuf.includes(DNI) && !logBuf.includes(AUDIO_MARKER);
  add('4 · logs sin PII', logClean, logClean ? 'limpios' : 'PII EN LOGS');

  // ── 5. Permisos 0600 de la clave ──
  const mode = statSync(KEY).mode & 0o777;
  add('5 · master.key con permisos 0600', mode === 0o600, '0' + mode.toString(8));

  // ── 6. Migración del sidecar legacy en claro ──
  const legacyRaw = readFileSync(join(DATA, legacyId + '.json')).toString('latin1');
  const migrated = !legacyRaw.includes('Legacy User') && !legacyRaw.includes('viejo en claro');
  add('6 · sidecar legacy re-cifrado al arrancar', migrated,
    migrated ? 'migrado a cifrado' : 'sigue en claro');

} catch (e) {
  add('ejecución', false, String(e.message));
} finally {
  srv.kill('SIGKILL');
  try { rmSync(work, { recursive: true, force: true }); } catch {}
}

console.log('\nSprint 7 — test al goal "cifrado en reposo + sin PII en logs":\n');
let pass = 0;
for (const r of results) {
  console.log(`  [${r.ok ? 'PASA' : 'FALLA'}]  ${r.name}\n           ${r.detail}`);
  if (r.ok) pass++;
}
console.log(`\n  ${pass}/${results.length} casos.  ${pass === results.length ? '✓ GOAL CUMPLIDO' : '✗ HAY FALLAS'}\n`);
process.exit(pass === results.length ? 0 : 1);
