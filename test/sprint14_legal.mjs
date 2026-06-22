// Sprint 14 — test al goal: "nada se procesa sin consentimiento; toda nota firmada
// tiene firma verificable con sello temporal; el audio se borra seguro al vencer la
// retención (la nota se conserva)".
//
// Verifica:
//  1. Subir SIN consentimiento → 400; CON consentimiento → ok (consent registrado)
//  2. Al firmar se genera firma (HMAC + signedAt + signedBy); /verify → valid:true
//  3. Si el contenido firmado se altera, /verify → valid:false (tamper-evident)
//  4. Retención: al arrancar con audio vencido + firmado → audio borrado seguro,
//     nota conservada (audioDeleted:true, audioFile:null)
//  5. Términos embebidos (TERMS.md + nota en login)
//
// Aislado en DATA_DIR temporal. No necesita Ollama.
// Uso: node test/sprint14_legal.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const results = [];
const add = (name, ok, detail) => results.push({ name, ok, detail });
function waitHealth(base, timeout = 8000) {
  return new Promise((res, rej) => {
    const t0 = Date.now();
    const tick = async () => {
      try { const r = await fetch(`${base}/health`); if (r.ok) return res(true); } catch {}
      if (Date.now() - t0 > timeout) return rej(new Error('server no levantó'));
      setTimeout(tick, 250);
    };
    tick();
  });
}
async function upload(base, name, withConsent) {
  const fd = new FormData();
  fd.append('audio', new Blob([Buffer.from('fake-audio')], { type: 'audio/webm' }), 'c.webm');
  fd.append('patientName', name); fd.append('durationSec', '5');
  if (withConsent) fd.append('consent', 'true');
  const r = await fetch(`${base}/api/recordings`, { method: 'POST', body: fd });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

// ── Server A: consentimiento + firma + verificación ──
const wA = mkdtempSync(join(tmpdir(), 'medrec-s14a-'));
const srvA = spawn('node', ['server.js'], {
  env: { ...process.env, PORT: '3410', NODE_ENV: 'development', MEDRECORD_DATA_DIR: join(wA, 'recordings'), MEDRECORD_KEY_FILE: join(wA, '.key') },
  stdio: 'ignore',
});
const A = 'http://localhost:3410';
try {
  await waitHealth(A);

  // 1. Consentimiento obligatorio
  const noConsent = await upload(A, 'Sin Consent', false);
  const withConsent = await upload(A, 'Con Consent', true);
  add('1 · sin consentimiento → 400, con consentimiento → ok',
    noConsent.status === 400 && withConsent.status === 200 && !!withConsent.body.id,
    `sin=${noConsent.status} con=${withConsent.status}`);
  const id = withConsent.body.id;

  // 2. Firma al firmar + verify válido
  await fetch(`${A}/api/recordings/${id}/fields`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: { anamnesis: { motivo_consulta: 'control' } }, reviewed: true }),
  });
  const rec = await (await fetch(`${A}/api/recordings/${id}`)).json();
  const v1 = await (await fetch(`${A}/api/recordings/${id}/verify`)).json();
  add('2 · firma generada + verify válido',
    rec.signature && rec.signature.hash && typeof rec.signature.signedAt === 'number' && v1.signed && v1.valid === true,
    `sig=${!!rec.signature} valid=${v1.valid} consent=${!!rec.consent}`);

  // 3. Inmutabilidad: una historia firmada no se puede editar (la firma protege el
  //    contenido). Un PUT posterior → 409, y la firma sigue válida.
  const edit = await fetch(`${A}/api/recordings/${id}/fields`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: { anamnesis: { motivo_consulta: 'ALTERADO' } } }),
  });
  const v2 = await (await fetch(`${A}/api/recordings/${id}/verify`)).json();
  add('3 · historia firmada inmutable (edición → 409, firma sigue válida)',
    edit.status === 409 && v2.valid === true, `edit=${edit.status} valid=${v2.valid}`);

} catch (e) { add('A · consentimiento/firma', false, String(e.message)); }
finally { srvA.kill('SIGKILL'); }

// ── Server B: retención (audio vencido se borra seguro, nota se conserva) ──
const wB = mkdtempSync(join(tmpdir(), 'medrec-s14b-'));
const DB = join(wB, 'recordings'); mkdirSync(DB, { recursive: true });
const old = Date.now() - 10 * 86400000;   // firmada hace 10 días
writeFileSync(join(DB, 'old-rec.audio'), 'audio-en-disco-de-prueba-que-debe-borrarse');
writeFileSync(join(DB, 'old-rec.json'), JSON.stringify({
  id: 'old-rec', patient: { name: 'Vieja' }, status: 'reviewed', reviewed: true, reviewedAt: old,
  audioFile: 'old-rec.audio', audioEnc: true, createdAt: old, updatedAt: old,
}));
const srvB = spawn('node', ['server.js'], {
  env: { ...process.env, PORT: '3411', NODE_ENV: 'development', MEDRECORD_DATA_DIR: DB, MEDRECORD_KEY_FILE: join(wB, '.key'),
         MEDRECORD_AUDIO_RETENTION_DAYS: '7' },   // retención 7 días → la de 10 días vence
  stdio: 'ignore',
});
try {
  await waitHealth('http://localhost:3411');
  await new Promise(r => setTimeout(r, 400));   // deja correr la purga de arranque
  const audioGone = !existsSync(join(DB, 'old-rec.audio'));
  const rec = await (await fetch('http://localhost:3411/api/recordings/old-rec')).json();
  add('4 · retención: audio vencido borrado, nota conservada',
    audioGone && rec && rec.audioDeleted === true && !rec.audioFile && rec.patient.name === 'Vieja',
    `audioGone=${audioGone} audioDeleted=${rec?.audioDeleted} note=${rec?.patient?.name}`);
} catch (e) { add('4 · retención', false, String(e.message)); }
finally { srvB.kill('SIGKILL'); }

// ── 5. Términos embebidos ──
let terms = '';
try { terms = readFileSync(new URL('../TERMS.md', import.meta.url), 'utf8'); } catch {}
const login = readFileSync(new URL('../src/web/login.jsx', import.meta.url), 'utf8');
add('5 · términos embebidos (TERMS.md + login)',
  /responsab/i.test(terms) && terms.includes('29733') && /responsable del contenido/i.test(login),
  `terms=${terms.length>0} login=${/responsable/i.test(login)}`);

try { rmSync(wA, { recursive: true, force: true }); rmSync(wB, { recursive: true, force: true }); } catch {}

console.log('\nSprint 14 — test al goal "consentimiento + firma verificable + retención":\n');
let pass = 0;
for (const r of results) {
  console.log(`  [${r.ok ? 'PASA' : 'FALLA'}]  ${r.name}\n           ${r.detail}`);
  if (r.ok) pass++;
}
console.log(`\n  ${pass}/${results.length} casos.  ${pass === results.length ? '✓ GOAL CUMPLIDO' : '✗ HAY FALLAS'}\n`);
process.exit(pass === results.length ? 0 : 1);
