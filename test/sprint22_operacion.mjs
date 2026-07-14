// Sprint 22 — test al goal: "El sistema sobrevive un reinicio de la Mac sin intervención
// humana, y tenemos el baseline medido antes de que el médico use la app por primera vez."
//
//  1. El server se levanta solo tras caerse (LaunchAgent con KeepAlive)
//  2. El backup se VERIFICA a sí mismo: restaura y descifra de verdad
//  3. El backup avisa si lo estás guardando en el mismo disco que los datos
//  4. El healthcheck detecta el servidor caído y no repite la alarma cada 5 minutos
//  5. Las métricas del piloto existen y miden lo que decide si el negocio existe
//  6. Se registra cuándo el médico ABRE la consulta (sin eso no se puede medir nada)
//  7. El audit log rota, y la cadena de hashes SOBREVIVE a la rotación
//  8. El .env se carga ANTES de los require (si no, la clave maestra se busca mal)
//  9. Los toasts de error tienen tope (12 fallos no pueden tapar la pantalla)
//
// Uso: node test/sprint22_operacion.mjs
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freePort } from './_port.mjs';

const require = createRequire(import.meta.url);
const results = [];
const add = (name, ok, detail) => results.push({ name, ok, detail });
const src = (f) => readFileSync(new URL('../' + f, import.meta.url), 'utf8');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const RAIZ = new URL('..', import.meta.url).pathname;

// ── 1. El server RESUCITA de verdad al matarlo ──
//
// Leer el .plist y comprobar que dice "KeepAlive" no prueba nada: el LaunchAgent puede estar
// perfectamente escrito y no levantar nada (pasó — ver el caso 1b). Así que aquí se mata el
// proceso de verdad y se comprueba que vuelve, con el mismo mecanismo que usa el .plist.
try {
  const w = mkdtempSync(join(tmpdir(), 'medrec-s22ka-'));
  const data = join(w, 'recordings'); mkdirSync(data, { recursive: true });
  const puerto = await freePort();
  const base = `http://localhost:${puerto}`;
  const env = { ...process.env, PORT: String(puerto), MEDRECORD_OPEN: '1',
    MEDRECORD_SKIP_DOTENV: '1', MEDRECORD_DATA_DIR: data,
    MEDRECORD_KEY_FILE: join(w, '.key'), MEDRECORD_AUDIO_RETENTION_DAYS: '0' };

  // Supervisor equivalente al KeepAlive del .plist: si el hijo muere, lo vuelve a arrancar.
  let hijo = null, muertes = 0, parar = false;
  const arrancar = () => {
    hijo = spawn('node', ['server.js'], { cwd: RAIZ, env, stdio: 'ignore' });
    hijo.on('exit', () => { muertes++; if (!parar) setTimeout(arrancar, 250); });
  };
  arrancar();

  const vivo = async () => { try { const r = await fetch(`${base}/health`); return r.ok; } catch { return false; } };
  const esperarVivo = async (ms = 12000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (await vivo()) return true; await sleep(200); }
    return false;
  };

  const arrancoSolo = await esperarVivo();
  hijo.kill('SIGKILL');                       // el servidor se cae (o macOS lo mata)
  await sleep(400);
  const cayo = !(await vivo());
  const resucito = await esperarVivo();       // ¿vuelve solo, sin que nadie toque nada?
  parar = true;
  try { hijo.kill('SIGKILL'); } catch { /* noop */ }
  rmSync(w, { recursive: true, force: true });

  add('1 · el server RESUCITA solo tras caerse (no basta con que el .plist lo diga)',
    arrancoSolo && cayo && resucito && muertes >= 1,
    `arrancó=${arrancoSolo} murió=${cayo} volvióSolo=${resucito} reinicios=${muertes}`);
} catch (e) { add('1 · resucita', false, String(e.message)); }

// ── 1b. El instalador se NIEGA si el proyecto está donde macOS lo bloqueará ──
//
// macOS bloquea por TCC el acceso de launchd a Desktop/Documents/Downloads. Un LaunchAgent
// que apunte ahí ARRANCA Y MUERE con EPERM, en silencio: `launchctl list` marca
// LastExitStatus=256 y el servidor simplemente no está. El médico llega a una app muerta y
// nadie sabe por qué. Lo verificó el QA instalándolo de verdad: no levanta.
try {
  const sh = src('scripts/install-launchagent.sh');
  const detectaTCC = /Desktop\/\*\|.*Documents\/\*\|.*Downloads\/\*/.test(sh)
    && /protegida por macOS \(TCC\)/.test(sh);
  const vuelve = /<key>KeepAlive<\/key><true\/>/.test(sh);
  const arranca = /<key>RunAtLoad<\/key><true\/>/.test(sh);
  const noDuerme = /caffeinate/.test(sh);
  add('1b · el instalador se niega si macOS va a bloquear el servicio (Desktop/Documents)',
    detectaTCC && vuelve && arranca && noDuerme,
    `detectaTCC=${detectaTCC} KeepAlive=${vuelve} RunAtLoad=${arranca} caffeinate=${noDuerme}`);
} catch (e) { add('1b · TCC', false, String(e.message)); }

// ── 2 + 3. El backup se prueba a sí mismo ──
// Un backup que nunca se restauró no es un backup: es un archivo con esperanza dentro.
try {
  const w = mkdtempSync(join(tmpdir(), 'medrec-s22bk-'));
  const data = join(w, 'recordings'); mkdirSync(data, { recursive: true });
  const key = join(w, '.key');
  process.env.MEDRECORD_KEY_FILE = key;
  delete require.cache[require.resolve('../crypto.js')];
  const enc = require('../crypto.js');
  enc.writeEncrypted(join(data, 'una.json'), JSON.stringify({ id: 'una', patient: { name: 'Prueba' } }));
  delete process.env.MEDRECORD_KEY_FILE;

  const salida = execFileSync('bash', [join(RAIZ, 'scripts/backup.sh')], {
    env: { ...process.env, MEDRECORD_DATA_DIR: data, MEDRECORD_KEY_FILE: key, BACKUP_DIR: join(w, 'bk') },
    encoding: 'utf8',
  });
  const verificado = /Verificado: el backup restaura y descifra correctamente/.test(salida);
  const conChecksum = readdirSync(join(w, 'bk')).some(f => f.endsWith('.sha256'));
  add('2 · el backup se verifica a sí mismo: restaura y descifra de verdad',
    verificado && conChecksum,
    `restauraYDescifra=${verificado} conChecksum=${conChecksum}`);

  // Guardar el backup al lado de los datos no protege de nada: un disco que muere se lleva
  // las dos cosas, y el tar lleva la clave maestra dentro.
  const salida2 = execFileSync('bash', [join(RAIZ, 'scripts/backup.sh')], {
    env: { ...process.env, MEDRECORD_DATA_DIR: data, MEDRECORD_KEY_FILE: key, BACKUP_DIR: '' },
    encoding: 'utf8',
  });
  add('3 · el backup avisa si lo guardas en el mismo disco que los datos',
    /AVISO: estás respaldando al MISMO disco/.test(salida2),
    `avisa=${/AVISO/.test(salida2)}`);
  rmSync(w, { recursive: true, force: true });
} catch (e) { add('2 · backup verificado', false, String(e.message)); add('3 · aviso de disco', false, String(e.message)); }

// ── 4. El healthcheck no cansa ──
try {
  const sh = src('scripts/healthcheck.sh');
  const detectaCaida = /El servidor no responde/.test(sh);
  const detectaOllama = /Ollama caído/.test(sh);
  // Una alerta cada 5 minutos durante un fin de semana entrena a ignorarlas.
  const soloAlCambiar = /ESTADO/.test(sh) && /!= "caido"/.test(sh);
  add('4 · el healthcheck avisa al CAMBIAR de estado, no cada 5 minutos',
    detectaCaida && detectaOllama && soloAlCambiar,
    `detectaCaída=${detectaCaida} detectaOllama=${detectaOllama} soloAlCambiar=${soloAlCambiar}`);
} catch (e) { add('4 · healthcheck', false, String(e.message)); }

// ── 5 + 6. Las métricas del piloto ──
const w5 = mkdtempSync(join(tmpdir(), 'medrec-s22m-'));
const D5 = join(w5, 'recordings'); mkdirSync(D5, { recursive: true });
const K5 = join(w5, '.key');
process.env.MEDRECORD_KEY_FILE = K5;
delete require.cache[require.resolve('../crypto.js')];
const enc5 = require('../crypto.js');

const ahora = Date.now();
// Una firmada en 45 s (bien), una en 8 s (firmó sin leer), una abandonada hace 2 días.
enc5.writeEncrypted(join(D5, 'ok.json'), JSON.stringify({
  id: 'ok', patient: { name: 'A' }, status: 'reviewed', reviewed: true,
  openedAt: ahora - 45000, reviewedAt: ahora,
  fields: { anamnesis: { motivo_consulta: 'cefalea' } },
  fields_ia: { anamnesis: { motivo_consulta: 'cefalea' } },
  consent: { granted: true, at: ahora }, version: 1, createdAt: ahora - 60000, updatedAt: ahora,
}));
enc5.writeEncrypted(join(D5, 'rapida.json'), JSON.stringify({
  id: 'rapida', patient: { name: 'B' }, status: 'reviewed', reviewed: true,
  openedAt: ahora - 8000, reviewedAt: ahora,       // 8 s: firmó sin leer
  fields: { anamnesis: { motivo_consulta: 'gripe' } },
  fields_ia: { anamnesis: { motivo_consulta: 'resfrio' } },   // el médico lo editó
  consent: { granted: true, at: ahora }, version: 1, createdAt: ahora - 60000, updatedAt: ahora,
}));
enc5.writeEncrypted(join(D5, 'abandonada.json'), JSON.stringify({
  id: 'abandonada', patient: { name: 'C' }, status: 'done', reviewed: false,
  fields: { anamnesis: { motivo_consulta: 'x' } },
  consent: { granted: true, at: ahora }, version: 0,
  createdAt: ahora - 2 * 24 * 3600 * 1000, updatedAt: ahora - 2 * 24 * 3600 * 1000,
}));
delete process.env.MEDRECORD_KEY_FILE;

const P5 = await freePort();
const B5 = `http://localhost:${P5}`;
const srv = spawn('node', ['server.js'], {
  cwd: RAIZ,
  env: { ...process.env, PORT: String(P5), NODE_ENV: 'development',
    MEDRECORD_DATA_DIR: D5, MEDRECORD_KEY_FILE: K5, MEDRECORD_AUDIO_RETENTION_DAYS: '0',
    MEDRECORD_ADMIN_USER: 'doc', MEDRECORD_ADMIN_PASS: 'clave-propia-del-piloto' },
  stdio: 'ignore',
});

try {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`${B5}/health`); if (r.ok) break; } catch {}
    await sleep(200);
  }
  const login = await fetch(`${B5}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: B5 },
    body: JSON.stringify({ username: 'doc', password: 'clave-propia-del-piloto' }),
  });
  const cookie = (login.headers.get('set-cookie') || '').split(';')[0];

  const m = await (await fetch(`${B5}/api/metrics`, { headers: { Cookie: cookie } })).json();
  add('5 · las métricas miden lo que decide si el negocio existe',
    m.revision?.mediana_segundos !== null
      && m.revision?.pct_sin_leer === 50            // 1 de 2 firmadas en <20 s
      && m.consultas?.abandonadas === 1             // grabó y nunca firmó
      && m.autollenado?.pct_editados === 50,        // editó 1 de 2 campos de la IA
    `medianaRevisión=${m.revision?.mediana_segundos}s firmóSinLeer=${m.revision?.pct_sin_leer}% abandonadas=${m.consultas?.abandonadas} editados=${m.autollenado?.pct_editados}%`);

  // 6. Abrir la consulta marca el reloj: sin eso no se puede medir cuánto tarda en revisar.
  const antes = JSON.parse(enc5.readEncrypted(join(D5, 'abandonada.json')).toString());
  await fetch(`${B5}/api/recordings/abandonada`, { headers: { Cookie: cookie } });
  await sleep(300);
  const despues = JSON.parse(enc5.readEncrypted(join(D5, 'abandonada.json')).toString());
  add('6 · abrir una consulta marca el reloj de la revisión',
    !antes.openedAt && !!despues.openedAt,
    `antes=${antes.openedAt || 'sin marcar'} despuésDeAbrir=${despues.openedAt ? 'marcado' : 'SIGUE SIN MARCAR'}`);
} catch (e) {
  add('5 · métricas', false, String(e.message));
  add('6 · reloj de revisión', false, String(e.message));
} finally {
  srv.kill('SIGKILL');
  try { rmSync(w5, { recursive: true, force: true }); } catch {}
}

// ── 7. El audit log rota, y la cadena sobrevive ──
// Verificar contra una cadena vacía tras rotar habría reportado como ADULTERADO un log
// perfectamente íntegro: un falso positivo en el mecanismo de integridad enseña a ignorarlo.
try {
  const w = mkdtempSync(join(tmpdir(), 'medrec-s22a-'));
  process.env.MEDRECORD_KEY_FILE = join(w, '.key');
  process.env.MEDRECORD_AUDIT_MAX_BYTES = '900';
  delete require.cache[require.resolve('../crypto.js')];
  delete require.cache[require.resolve('../auth.js')];
  const auth = require('../auth.js');
  auth.init(w);
  for (let i = 0; i < 40; i++) auth.audit({ action: 'test', n: i });
  const v = auth.verifyAudit();
  const rotados = readdirSync(w).filter(f => f.startsWith('audit.log.'));
  add('7 · el audit log rota, y la cadena de hashes sobrevive a la rotación',
    rotados.length >= 1 && v.valid === true && v.desdeRotacion === true,
    `archivosRotados=${rotados.length} cadenaÍntegra=${v.valid} continúaDelViejo=${v.desdeRotacion}`);
  rmSync(w, { recursive: true, force: true });
} catch (e) { add('7 · rotación', false, String(e.message)); }
finally { delete process.env.MEDRECORD_AUDIT_MAX_BYTES; delete process.env.MEDRECORD_KEY_FILE; }

// ── 10. Borrar el PRINCIPIO del audit log también se detecta ──
// Arrancar la verificación desde la primera fila (para sobrevivir a la rotación) abría un
// agujero: el atacante recorta el principio del log —justo donde está el rastro que quiere
// borrar— y el resto de la cadena sigue cuadrando. La primera fila tiene que apuntar a un
// eslabón que EXISTA: o el inicio, o el final del log rotado.
try {
  const w = mkdtempSync(join(tmpdir(), 'medrec-s22r-'));
  process.env.MEDRECORD_KEY_FILE = join(w, '.key');
  delete require.cache[require.resolve('../crypto.js')];
  delete require.cache[require.resolve('../auth.js')];
  const auth = require('../auth.js');
  auth.init(w);
  for (let i = 0; i < 10; i++) auth.audit({ action: 'sign', n: i });
  const antes = auth.verifyAudit().valid;

  // El atacante borra las 3 primeras entradas.
  const log = join(w, 'audit.log');
  const lineas = readFileSync(log, 'utf8').trim().split('\n');
  writeFileSync(log, lineas.slice(3).join('\n') + '\n');
  const despues = auth.verifyAudit();

  add('10 · borrar el PRINCIPIO del audit log también se detecta',
    antes === true && despues.valid === false && /se borró el principio/.test(despues.motivo || ''),
    `íntegroAntes=${antes} detectaElRecorte=${despues.valid === false} motivo=${JSON.stringify(despues.motivo || '')}`);
  rmSync(w, { recursive: true, force: true });
} catch (e) { add('10 · recorte del log', false, String(e.message)); }
finally { delete process.env.MEDRECORD_KEY_FILE; }

// ── 8. El .env se carga ANTES de los require ──
// crypto.js lee MEDRECORD_KEY_FILE al importarse: cargarlo después buscaría la clave maestra
// en la ruta equivocada, y el server generaría una nueva sobre datos que no puede descifrar.
try {
  const s = src('server.js');
  const iCarga = s.indexOf('cargarEnv');
  const iCrypto = s.indexOf("require('./crypto')");
  add('8 · el .env se carga ANTES de los require (si no, la clave maestra se busca mal)',
    iCarga > 0 && iCarga < iCrypto,
    `posiciónCargaEnv=${iCarga} posiciónRequireCrypto=${iCrypto}`);
} catch (e) { add('8 · carga de .env', false, String(e.message)); }

// ── 9. Los toasts tienen tope ──
try {
  const app = src('src/web/app.jsx');
  add('9 · los toasts de error tienen tope (12 fallos no tapan la pantalla)',
    /\.slice\(-3\)/.test(app), `tope=${/\.slice\(-3\)/.test(app)}`);
} catch (e) { add('9 · toasts', false, String(e.message)); }

console.log('\nSprint 22 — test al goal "operación y arranque del piloto":\n');
let pass = 0;
for (const r of results.sort((a, b) => a.name.localeCompare(b.name, 'es', { numeric: true }))) {
  console.log(`  [${r.ok ? 'PASA' : 'FALLA'}]  ${r.name}\n           ${r.detail}`);
  if (r.ok) pass++;
}
console.log(`\n  ${pass}/${results.length} casos.  ${pass === results.length ? '✓ GOAL CUMPLIDO' : '✗ HAY FALLAS'}\n`);
process.exit(pass === results.length ? 0 : 1);
