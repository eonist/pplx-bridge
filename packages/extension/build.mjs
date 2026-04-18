// esbuild bundler for the MV3 extension
import { build } from 'esbuild';
import { cpSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const out = resolve(__dirname, 'dist');

mkdirSync(out, { recursive: true });

// Bundle background service worker (handles capture + action injection)
await build({
  entryPoints: ['src/background.ts'],
  bundle: true,
  outfile: 'dist/background.js',
  format: 'esm',
  platform: 'browser',
  target: ['chrome120'],
  sourcemap: false,
  minify: false,
});

// Copy static files
cpSync('src/manifest.json', 'dist/manifest.json');

console.log('[extension] build complete → dist/');
