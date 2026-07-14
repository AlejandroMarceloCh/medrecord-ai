// Sprint 1 — suite al goal: "una grabación nunca se pierde".
// Prueba adversarial del móvil: persistencia en IndexedDB, cola con reintentos+backoff,
// recuperación tras recarga / caída de red, integridad byte a byte, y recuperación de
// estado sin evento WS. Corre en Chromium real (Playwright) contra el server en :3331.
//
// Uso: con el server corriendo  →  node test/sprint1_mobile_recovery.mjs
import { chromium } from 'playwright';
import { levantarServer } from './_server.mjs';
import { readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Autónomo: levanta su propio server (antes exigía uno en :3331 y por eso nunca
// corría en `npm test` — así fue como el Sprint 18 lo rompió sin que nadie lo viera).
const servidor = process.env.BASE ? null : await levantarServer({
  // Caso 7 necesita una historia ya procesada. La sembramos en vez de exigir que Whisper y
  // Ollama estén instalados (y en vez de leer las consultas reales que haya en el disco).
  async seed(dataDir, keyFile) {
    process.env.MEDRECORD_KEY_FILE = keyFile;
    const { createRequire } = await import('node:module');
    const req = createRequire(import.meta.url);
    delete req.cache[req.resolve('../crypto.js')];
    const enc = req('../crypto.js');
    enc.writeEncrypted(join(dataDir, 'seed-done.json'), JSON.stringify({
      id: 'seed-done', patient: { name: 'Historia Sembrada', dni: '' },
      status: 'done', reviewed: false, transcript: 'Transcripcion de prueba.',
      consent: { granted: true, at: Date.now() }, version: 0,
      createdAt: Date.now(), updatedAt: Date.now(),
    }));
    delete process.env.MEDRECORD_KEY_FILE;
  },
});
const BASE = process.env.BASE || servidor.base;
const LEN = 4096;

// ── helpers en Node ───────────────────────────────────────────────────────────
async function findOnServer(name, timeoutMs = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const list = await (await fetch(`${BASE}/api/recordings`)).json();
    const hit = list.find(r => r.patient?.name === name);
    if (hit) return hit;
    await new Promise(r => setTimeout(r, 400));
  }
  return null;
}
function checksumBytes(buf) { let s = 0; for (let i = 0; i < buf.length; i++) s = (s + buf[i]) % 1e9; return s; }
async function audioOnServer(id) {
  const buf = new Uint8Array(await (await fetch(`${BASE}/api/recordings/${id}/audio`)).arrayBuffer());
  return { len: buf.length, sum: checksumBytes(buf) };
}
async function cleanupByPrefix(prefix) {
  const list = await (await fetch(`${BASE}/api/recordings`)).json();
  for (const r of list) if ((r.patient?.name || '').startsWith(prefix)) await fetch(`${BASE}/api/recordings/${r.id}`, { method: 'DELETE' }).catch(() => {});
}

// ── helpers en página (browser) ───────────────────────────────────────────────
function seedInPage({ name, len, seed }) {
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = (i * 7 + 3 + seed) % 251;
  let sum = 0; for (let i = 0; i < len; i++) sum = (sum + bytes[i]) % 1e9;
  const localId = 'PW' + Date.now() + Math.floor(Math.random() * 1e6);
  return window.MRQueue.put({
    localId, serverId: null, uploaded: false, blob: new Blob([bytes], { type: 'audio/ogg' }),
    type: 'audio/ogg', meta: { name, dni: '', consent: true }, dur: 5, createdAt: Date.now(), tries: 0,
  }).then(() => ({ localId, sum }));
}
async function clearIdbInPage() { const all = await window.MRQueue.all(); for (const r of all) await window.MRQueue.del(r.localId); }

const SEL = 'input[placeholder="Ej. María Pérez"]';
const results = [];
const rec = (name, ok, detail) => results.push({ name, ok, detail });

const browser = await chromium.launch();
const ctx = await browser.newContext();
const page = await ctx.newPage();
await page.goto(`${BASE}/mobile`);
await page.waitForSelector(SEL, { timeout: 15000 });

// ── 1. Helper IndexedDB: put/get/all/del + get inexistente ────────────────────
try {
  await page.evaluate(clearIdbInPage);
  const r = await page.evaluate(async () => {
    await window.MRQueue.put({ localId: 'u1', uploaded: false, meta: { name: 'x' }, createdAt: 1 });
    const got = await window.MRQueue.get('u1');
    const missing = await window.MRQueue.get('nope');
    const all1 = await window.MRQueue.all();
    await window.MRQueue.del('u1');
    const all2 = await window.MRQueue.all();
    return { gotOk: got && got.localId === 'u1', missingUndef: missing === undefined, all1: all1.length, all2: all2.length };
  });
  const ok = r.gotOk && r.missingUndef && r.all1 === 1 && r.all2 === 0;
  rec('1 · helper IndexedDB (put/get/del, get inexistente→undefined)', ok, `get=${r.gotOk} missing=${r.missingUndef} all ${r.all1}→${r.all2}`);
} catch (e) { rec('1 · helper IndexedDB', false, String(e.message)); }

// ── 2. Recarga a media subida → audio íntegro + blob liberado tras éxito ──────
try {
  await page.evaluate(clearIdbInPage);
  const name = 'PWTEST_reload_' + Date.now();
  const { localId, sum } = await page.evaluate(seedInPage, { name, len: LEN, seed: 1 });
  await page.reload(); await page.waitForSelector(SEL, { timeout: 15000 });
  const r = await findOnServer(name);
  let ok = false, detail = 'no llegó al server';
  if (r) {
    const c = await audioOnServer(r.id);
    const after = await page.evaluate(id => window.MRQueue.get(id), localId);
    const intact = c.len === LEN && c.sum === sum;
    const freed = after && after.uploaded === true && after.blob == null;   // blob liberado, registro vivo
    ok = intact && freed;
    detail = `íntegro=${intact} · tras éxito uploaded=${after?.uploaded} blob=${after?.blob == null ? 'liberado' : 'PRESENTE(mal)'}`;
  }
  rec('2 · recarga a media subida → íntegro + blob liberado', ok, detail);
} catch (e) { rec('2 · recarga a media subida', false, String(e.message)); }

// ── 3. Caída de red → queda en cola → reconecta → íntegro ─────────────────────
try {
  await page.evaluate(clearIdbInPage);
  const name = 'PWTEST_offline_' + Date.now();
  await ctx.setOffline(true);
  const { sum } = await page.evaluate(seedInPage, { name, len: LEN, seed: 2 });
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  await new Promise(r => setTimeout(r, 1200));
  const before = await findOnServer(name, 1500);
  await ctx.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  const r = await findOnServer(name);
  let ok = false, detail = 'no llegó tras reconectar';
  if (r) { const c = await audioOnServer(r.id); const intact = c.len === LEN && c.sum === sum; ok = intact && !before; detail = `offline:${before ? 'subió antes(MAL)' : 'en cola ✓'} · reconecta íntegro=${intact}`; }
  rec('3 · caída y retorno de red', ok, detail);
} catch (e) { rec('3 · caída y retorno de red', false, String(e.message)); }

// ── 4. Cola con 3 audios simultáneos → los 3 íntegros ────────────────────────
try {
  await page.evaluate(clearIdbInPage);
  const stamp = Date.now();
  const seeds = [[`PWTEST_q1_${stamp}`, 11], [`PWTEST_q2_${stamp}`, 22], [`PWTEST_q3_${stamp}`, 33]];
  const expect = {};
  for (const [name, seed] of seeds) { const { sum } = await page.evaluate(seedInPage, { name, len: LEN, seed }); expect[name] = sum; }
  await page.reload(); await page.waitForSelector(SEL, { timeout: 15000 });
  let allOk = true, parts = [];
  for (const [name] of seeds) { const r = await findOnServer(name); const c = r ? await audioOnServer(r.id) : null; const ok = c && c.sum === expect[name] && c.len === LEN; allOk = allOk && ok; parts.push(`${name.split('_')[1]}:${ok ? '✓' : '✗'}`); }
  rec('4 · cola múltiple (3 audios) → todos íntegros', allOk, parts.join(' '));
} catch (e) { rec('4 · cola múltiple', false, String(e.message)); }

// ── 5. Reintento automático: el POST falla 2 veces y al 3er intento sube ──────
try {
  await page.evaluate(clearIdbInPage);
  let aborts = 0;
  await page.route('**/api/recordings', route => {
    if (route.request().method() === 'POST' && aborts < 2) { aborts++; return route.abort(); }
    return route.continue();
  });
  const name = 'PWTEST_retry_' + Date.now();
  const { sum } = await page.evaluate(seedInPage, { name, len: LEN, seed: 7 });
  await page.evaluate(() => window.dispatchEvent(new Event('online')));   // dispara tryUpload
  const r = await findOnServer(name, 20000);
  await page.unroute('**/api/recordings');
  let ok = false, detail = 'no subió pese a reintentar';
  if (r) { const c = await audioOnServer(r.id); ok = c.sum === sum && c.len === LEN && aborts === 2; detail = `fallos forzados=${aborts}, subió al 3er intento, íntegro=${c.sum === sum}`; }
  rec('5 · reintento automático tras fallos transitorios', ok, detail);
} catch (e) { rec('5 · reintento automático', false, String(e.message)); }

// ── 6. Mientras el POST falla, el blob NUNCA se borra de IndexedDB ────────────
try {
  await page.evaluate(clearIdbInPage);
  await page.route('**/api/recordings', route => route.request().method() === 'POST' ? route.abort() : route.continue());
  const name = 'PWTEST_keep_' + Date.now();
  const { localId } = await page.evaluate(seedInPage, { name, len: LEN, seed: 9 });
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await new Promise(r => setTimeout(r, 3500));   // deja correr 2-3 reintentos
  const kept = await page.evaluate(id => window.MRQueue.get(id), localId);
  await page.unroute('**/api/recordings');
  const ok = !!kept && kept.uploaded === false && kept.blob != null && kept.tries >= 1;
  rec('6 · el blob se conserva mientras la subida falla', ok, `presente=${!!kept} uploaded=${kept?.uploaded} blob=${kept?.blob != null ? 'intacto✓' : 'BORRADO(mal)'} tries=${kept?.tries}`);
} catch (e) { rec('6 · blob conservado en fallo', false, String(e.message)); }

// ── 7. Recuperación de estado SIN evento WS (syncStatusOnce on reload) ─────────
try {
  await page.evaluate(clearIdbInPage);
  const list = await (await fetch(`${BASE}/api/recordings`)).json();
  const reviewed = list.find(r => r.status === 'reviewed' || r.status === 'done');
  if (!reviewed) { rec('7 · recupera estado sin evento WS', false, 'no hay grabación done/reviewed para la prueba'); }
  else {
    await page.evaluate((sid) => window.MRQueue.put({
      localId: 'PWsync' + Date.now(), serverId: sid, uploaded: true, blob: undefined,
      type: 'audio/ogg', meta: { name: 'PWTEST_sync', consent: true }, dur: 5, createdAt: Date.now(), tries: 0,
    }), reviewed.id);
    await page.reload(); await page.waitForSelector(SEL, { timeout: 15000 });
    // resumeAll → ensureWs + syncStatusOnce(serverId) → la fila debe mostrar "Listo …"
    const ok = await page.waitForSelector('text=Listo · revísalo en la web', { timeout: 8000 }).then(() => true).catch(() => false);
    rec('7 · recupera estado sin evento WS (GET de respaldo)', ok, ok ? 'la fila pasó a "Listo" vía syncStatusOnce' : 'no se sincronizó el estado');
    await page.evaluate(clearIdbInPage);
  }
} catch (e) { rec('7 · recupera estado sin evento WS', false, String(e.message)); }

// ── 8. Audio REAL (.ogg de disco) sube íntegro ────────────────────────────────
try {
  await page.evaluate(clearIdbInPage);
  // Audio REAL generado al vuelo con ffmpeg. Antes este caso leía un .ogg de
  // data/recordings, o sea usaba grabaciones de pacientes reales como fixture de test —
  // y además hacía que el test no corriera en una máquina limpia.
  const wavTmp = join(tmpdir(), 'medrec-fixture-' + Date.now() + '.ogg');
  let bytes = null;
  try {
    execFileSync('ffmpeg', ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=3',
      '-ac', '1', '-ar', '16000', '-y', wavTmp], { stdio: 'ignore' });
    bytes = readFileSync(wavTmp);
  } catch { /* sin ffmpeg no podemos generar el fixture */ }
  if (!bytes) { rec('8 · audio real íntegro', false, 'ffmpeg no disponible para generar el audio de prueba'); }
  else {
    const realSum = checksumBytes(new Uint8Array(bytes));
    const name = 'PWTEST_real_' + Date.now();
    await page.evaluate(async ({ name, b64 }) => {
      const bin = atob(b64); const arr = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      await window.MRQueue.put({ localId: 'PWreal' + Date.now(), serverId: null, uploaded: false, blob: new Blob([arr], { type: 'audio/ogg' }), type: 'audio/ogg', meta: { name, dni: '', consent: true }, dur: 8, createdAt: Date.now(), tries: 0 });
    }, { name, b64: bytes.toString('base64') });
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    const r = await findOnServer(name, 20000);
    let ok = false, detail = 'no llegó';
    if (r) { const c = await audioOnServer(r.id); ok = c.len === bytes.length && c.sum === realSum; detail = `${bytes.length}B, checksum ${ok ? 'coincide' : 'NO'}`; }
    rec('8 · audio real íntegro (byte a byte)', ok, detail);
    try { rmSync(wavTmp, { force: true }); } catch { /* noop */ }
  }
} catch (e) { rec('8 · audio real íntegro', false, String(e.message)); }

// ── 9. Recientes: localStorage → chips render → click rellena el input ────────
try {
  await page.evaluate(() => localStorage.setItem('mr.recentPatients', JSON.stringify([{ name: 'Recién Uno', dni: '12345678' }, { name: 'Recién Dos', dni: '' }])));
  await page.reload(); await page.waitForSelector(SEL, { timeout: 15000 });
  const chip = await page.waitForSelector('button:has-text("Recién Uno")', { timeout: 5000 }).then(() => true).catch(() => false);
  let filled = false;
  if (chip) { await page.click('button:has-text("Recién Uno")'); filled = (await page.inputValue(SEL)) === 'Recién Uno'; }
  await page.evaluate(() => localStorage.removeItem('mr.recentPatients'));
  rec('9 · recientes (chips render + click rellena)', chip && filled, `chip=${chip} rellena=${filled}`);
} catch (e) { rec('9 · recientes', false, String(e.message)); }

await browser.close();
await cleanupByPrefix('PWTEST');

console.log('\nSprint 1 — suite al goal "nunca se pierde una grabación":\n');
let pass = 0;
for (const r of results) { console.log(`  [${r.ok ? 'PASA' : 'FALLA'}]  ${r.name}\n           ${r.detail}`); if (r.ok) pass++; }
console.log(`\n  ${pass}/${results.length} casos.  ${pass === results.length ? '✓ GOAL CUMPLIDO' : '✗ HAY FALLAS'}\n`);
if (servidor) servidor.cerrar();
process.exit(pass === results.length ? 0 : 1);
