// =============================================================================
// make-artifact.mjs — prepares the version published on claude.ai.
//
// claude.ai adds its own <html>, <head> and <body> around a published page,
// so this script copies index.html WITHOUT those wrapper tags into
// dist-artifact/index.html. All other files (src/, data/, translations/) are
// published next to it unchanged.
//
// Run:  node tools/make-artifact.mjs
// =============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'dist-artifact');

let html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
html = html
  .replace(/<!doctype html>\s*/i, '')
  .replace(/<html[^>]*>\s*/i, '')
  .replace(/<\/html>\s*/i, '')
  .replace(/<head>\s*/i, '')
  .replace(/<\/head>\s*/i, '')
  .replace(/<body[^>]*>\s*/i, '')
  .replace(/<\/body>\s*/i, '')
  .replace(/<meta charset[^>]*>\s*/i, '')
  .replace(/<meta name="viewport"[^>]*>\s*/i, '');

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'index.html'), html);
console.log('Written dist-artifact/index.html');
