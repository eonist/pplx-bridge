// esbuild bundler for the MV3 extension
// MV3 content scripts and service workers cannot use ES module imports,
// so we bundle each entry point into a single self-contained JS file.
import { build } from 'esbuild';
import { cpSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const out = resolve(__dirname, 'dist');

mkdirSync(out, { recursive: true });

// Bundle recorder (content script)
await build({
  entryPoints: ['src/recorder.ts'],
  bundle: true,
  outfile: 'dist/recorder.js',
  format: 'iife',          // self-contained IIFE, no imports at runtime
  platform: 'browser',
  target: ['chrome120'],
  sourcemap: false,
  minify: false,           // keep readable for debugging
  define: { 'process.env.NODE_ENV': '"production"' },
});

// Bundle background service worker
await build({
  entryPoints: ['src/background.ts'],
  bundle: true,
  outfile: 'dist/background.js',
  format: 'esm',           // service workers support ESM in Chrome 120+
  platform: 'browser',
  target: ['chrome120'],
  sourcemap: false,
  minify: false,
});

// Copy static files
cpSync('src/manifest.json', 'dist/manifest.json');

console.log('[extension] build complete → dist/');
