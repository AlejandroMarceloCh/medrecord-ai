// Levanta un server propio para los tests de Playwright.
//
// sprint1 y sprint2 exigían un server ya corriendo en :3331, así que NUNCA entraron en
// `npm test`. El resultado era predecible: el Sprint 18 reescribió el móvil, el arnés de
// "una grabación nunca se pierde" quedó pasando 1/9, y nadie se enteró durante días.
// Un test que no corre no protege nada.
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freePort } from './_port.mjs';

// `seed(dataDir, keyFile)` corre ANTES de arrancar el server, para sembrar sidecars que
// loadAll() encontrará. Sirve para probar estados (una historia ya procesada, por ejemplo)
// sin depender de que Whisper y Ollama estén instalados — ni, peor, de las grabaciones
// reales de pacientes que haya en el disco del desarrollador.
export async function levantarServer({ env = {}, seed = null } = {}) {
  const w = mkdtempSync(join(tmpdir(), 'medrec-t-'));
  const data = join(w, 'recordings');
  mkdirSync(data, { recursive: true });
  const keyFile = join(w, '.key');
  const port = await freePort();

  if (seed) await seed(data, keyFile);

  const proc = spawn('node', ['server.js'], {
    env: {
      ...process.env,
      PORT: String(port),
      MEDRECORD_SERVE_DIST: '1',        // sirve dist/: probamos lo que usa el médico
      MEDRECORD_SKIP_DOTENV: '1',
      MEDRECORD_OPEN: '1',
      MEDRECORD_DATA_DIR: data,
      MEDRECORD_KEY_FILE: keyFile,
      MEDRECORD_AUDIO_RETENTION_DAYS: '0',
      ...env,
    },
    stdio: 'ignore',
  });

  const base = `http://localhost:${port}`;
  const t0 = Date.now();
  for (;;) {
    try { const r = await fetch(`${base}/health`); if (r.ok) break; } catch { /* aún no */ }
    if (Date.now() - t0 > 12000) { proc.kill('SIGKILL'); throw new Error('el server no levantó'); }
    await new Promise(r => setTimeout(r, 200));
  }

  return {
    base, data, keyFile,
    cerrar() {
      proc.kill('SIGKILL');
      try { rmSync(w, { recursive: true, force: true }); } catch { /* noop */ }
    },
  };
}
