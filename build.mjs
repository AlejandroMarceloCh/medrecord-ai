import * as esbuild from 'esbuild';
import { copyFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root  = dirname(fileURLToPath(import.meta.url));
const watch = process.argv.includes('--watch');

const STATIC = [
  'icon.svg','icon-180.png','icon-192.png','icon-512.png','icon-maskable-512.png',
  'manifest.webmanifest','manifest-web.webmanifest','mobile.html','web.html',
];

const shared = {
  entryPoints: [join(root,'src/web/index.jsx')],
  bundle:   true,
  format:   'iife',
  platform: 'browser',
  jsx:      'automatic',
  target:   'es2020',
};

if (watch) {
  const ctx = await esbuild.context({
    ...shared,
    outfile:   join(root,'public/app.js'),
    define:    { 'process.env.NODE_ENV':'"development"' },
    sourcemap: 'inline',
  });
  await ctx.watch();
  console.log('  esbuild watching src/web/ → public/app.js  (Ctrl+C para parar)');
} else {
  const out = join(root,'dist');
  rmSync(out, { recursive:true, force:true });
  mkdirSync(out, { recursive:true });

  await esbuild.build({
    ...shared,
    outfile:   join(out,'app.js'),
    define:    { 'process.env.NODE_ENV':'"production"' },
    minify:    true,
    sourcemap: false,
  });
  console.log('  ✓ src/web/ → dist/app.js');

  for (const f of STATIC) {
    const src = join(root,'public',f);
    if (existsSync(src)) { copyFileSync(src, join(out,f)); console.log('  ✓ '+f); }
  }
  console.log('\nBuild listo. Producción: NODE_ENV=production node server.js\n');
}
