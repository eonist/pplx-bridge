// Copies viewer/public into relay/dist/public after tsc build
// so the relay can serve live.html from __dirname at runtime.
import { cpSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const src  = resolve(__dirname, '../viewer/public');
const dest = resolve(__dirname, 'dist/public');

mkdirSync(dest, { recursive: true });
cpSync(src, dest, { recursive: true });
console.log('[relay] viewer assets copied → dist/public/');
