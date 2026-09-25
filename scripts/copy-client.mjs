// Copies the hand-authored client bundle into lib/.
//
// The browser half is written directly against DSH's ModuleLoader format
// (`window.__ModuleLoader__.load({ id, factory })`) and imports React from the
// shell's shared module registry at runtime, so it needs no bundling step —
// only copying next to the host half that `exports["./client"]` points at.
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const from = join(root, 'src', 'client.js');
const to = join(root, 'lib', 'client.js');

mkdirSync(dirname(to), { recursive: true });
copyFileSync(from, to);
console.log(`client bundle: ${from} -> ${to}`);
