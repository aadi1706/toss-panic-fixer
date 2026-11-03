// Bundles the app into a single static dist/index.html (JS and CSS inlined).
import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');

const out = await build({
  entryPoints: [new URL('src/app.js', root).pathname],
  bundle: true, minify: true, write: false, format: 'iife', target: 'es2020',
});
// "</script" inside the bundle would end the inline script early.
const js = out.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const css = read('src/style.css');
const html = read('src/index.template.html').replace('/*CSS*/', () => css).replace('/*JS*/', () => js);

mkdirSync(new URL('dist/', root), { recursive: true });
writeFileSync(new URL('dist/index.html', root), html);
console.log(`dist/index.html ${(html.length / 1024).toFixed(0)} KB`);
