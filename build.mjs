import * as esbuild from 'esbuild';
import { copyFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root  = dirname(fileURLToPath(import.meta.url));
const watch = process.argv.includes('--watch');

const STATIC = [
  'icon.svg','icon-180.png','icon-192.png','icon-512.png','icon-maskable-512.png',
  'manifest.webmanifest','manifest-web.webmanifest','mobile.html','web.html','sw.js',
];

const base = {
  bundle:   true,
  format:   'iife',
  platform: 'browser',
  jsx:      'automatic',
  target:   'es2020',
};

// Dos apps: la consola del médico (web) y la grabadora (móvil). El móvil se compila igual
// que la web — antes cargaba React y Babel desde unpkg y transpilaba JSX en el navegador,
// así que sin internet no abría. Su promesa es la cola offline: tiene que existir offline.
const APPS = [
  { entry: 'src/web/index.jsx',    dev: 'public/app.js',    prod: 'app.js'    },
  { entry: 'src/mobile/index.jsx', dev: 'public/mobile.js', prod: 'mobile.js' },
];

if (watch) {
  for (const app of APPS) {
    const ctx = await esbuild.context({
      ...base,
      entryPoints: [join(root, app.entry)],
      outfile:   join(root, app.dev),
      define:    { 'process.env.NODE_ENV': '"development"' },
      sourcemap: 'inline',
    });
    await ctx.watch();
  }
  console.log('  esbuild watching  src/web/ → public/app.js  ·  src/mobile/ → public/mobile.js');
} else {
  const out = join(root, 'dist');
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });

  for (const app of APPS) {
    await esbuild.build({
      ...base,
      entryPoints: [join(root, app.entry)],
      outfile:   join(out, app.prod),
      define:    { 'process.env.NODE_ENV': '"production"' },
      minify:    true,
      sourcemap: false,
    });
    console.log('  ✓ ' + app.entry + ' → dist/' + app.prod);
  }

  for (const f of STATIC) {
    const src = join(root, 'public', f);
    if (existsSync(src)) { copyFileSync(src, join(out, f)); console.log('  ✓ ' + f); }
  }
  console.log('\nBuild listo. Producción: NODE_ENV=production node server.js\n');
}
