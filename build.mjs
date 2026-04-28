import esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';

const watch = process.argv.includes('--watch');
const distDir = path.resolve('dist');
fs.mkdirSync(distDir, { recursive: true });

const codeOptions = {
  entryPoints: ['src/code.ts'],
  bundle: true,
  outfile: 'dist/code.js',
  target: 'es2020',
  platform: 'browser',
  format: 'iife',
  logLevel: 'info',
};

const uiOptions = {
  entryPoints: ['ui/ui.ts'],
  bundle: true,
  outfile: 'dist/ui.js',
  target: 'es2020',
  platform: 'browser',
  format: 'iife',
  logLevel: 'info',
};

function inlineHtml() {
  const html = fs.readFileSync('ui/ui.html', 'utf8');
  const js = fs.readFileSync('dist/ui.js', 'utf8');
  // Inject the bundled JS in place of the placeholder.
  const out = html.replace('<!--SCRIPT-->', () => `<script>${js}</script>`);
  fs.writeFileSync('dist/ui.html', out);
  console.log('wrote dist/ui.html');
}

if (watch) {
  const codeCtx = await esbuild.context(codeOptions);
  const uiCtx = await esbuild.context({
    ...uiOptions,
    plugins: [
      {
        name: 'inline-html',
        setup(build) {
          build.onEnd((result) => {
            if (!result.errors.length) inlineHtml();
          });
        },
      },
    ],
  });
  await codeCtx.watch();
  await uiCtx.watch();
  console.log('Watching for changes...');
} else {
  await esbuild.build(codeOptions);
  await esbuild.build(uiOptions);
  inlineHtml();
  console.log('Build complete.');
}
