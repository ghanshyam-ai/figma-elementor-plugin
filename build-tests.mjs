// Bundles each TypeScript test in `tests/` into a single CommonJS file
// under `dist/tests/` so Node's built-in test runner (`node --test`) can
// execute it without needing tsx, vitest, or any other extra dev dep.
//
// The Figma plugin's source modules reference `figma.*` inside function
// bodies — those are never called by the unit tests, but the references
// would crash at module load if `figma` were undefined. We inject a tiny
// global shim before each bundle so the references resolve to harmless
// stubs.

import esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const outDir = path.resolve(__dirname, 'dist', 'tests');
fs.mkdirSync(outDir, { recursive: true });
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

const testsDir = path.resolve(__dirname, 'tests');
const entries = fs
  .readdirSync(testsDir)
  .filter((f) => f.endsWith('.test.ts'))
  .map((f) => path.join(testsDir, f));

if (entries.length === 0) {
  console.error('No tests found in tests/.');
  process.exit(1);
}

await esbuild.build({
  entryPoints: entries,
  bundle: true,
  outdir: outDir,
  outExtension: { '.js': '.cjs' },
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  // Stub the Figma global so any unused-but-bundled `figma.mixed` reference
  // resolves to a sentinel symbol instead of a ReferenceError.
  banner: {
    js: 'globalThis.figma = globalThis.figma || { mixed: Symbol("figma.mixed") };',
  },
  external: [],
  logLevel: 'info',
});

console.log(`Built ${entries.length} test bundle(s) to ${outDir}.`);
