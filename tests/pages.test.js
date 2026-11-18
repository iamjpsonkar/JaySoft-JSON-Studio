// The web version served by GitHub Pages (main branch, folder "/ (root)") is index.html at the repository root,
// generated from studio.html. Everything else it loads is the extension's own files.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { indexHtml, CSP } = require('../scripts/build-pages');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

test('index.html is up to date: regenerate with `npm run build:pages` if this fails', () => {
  assert.equal(read('index.html'), indexHtml(), 'index.html differs from studio.html + CSP');
});

test('the web page loads only its own files, has a strict CSP, and the site is not run through Jekyll', () => {
  const html = read('index.html');
  assert.ok(html.includes(`content="${CSP}"`), 'CSP meta tag');
  assert.match(CSP, /script-src 'self'/);
  assert.match(CSP, /connect-src 'none'/, 'no network from the page');
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/, 'no inline scripts (the CSP would block them)');
  const refs = [...html.matchAll(/(?:src|href)="([^"#]+)"/g)].map((m) => m[1]).filter((u) => !/^https?:/.test(u));
  assert.ok(refs.length >= 10, 'finds the scripts, stylesheet and icon');
  for (const r of refs) assert.ok(fs.existsSync(path.join(ROOT, r)), `${r} exists next to index.html`);
  assert.ok(refs.every((r) => !r.startsWith('/') && !r.startsWith('..')), 'relative paths only, so it works under /JaySoft-JSON-Studio/');
  const worker = read('worker.js');
  for (const m of worker.matchAll(/'(core\/[^']+)'/g)) assert.ok(fs.existsSync(path.join(ROOT, m[1])), `worker imports ${m[1]}`);
  assert.ok(fs.existsSync(path.join(ROOT, '.nojekyll')), '.nojekyll at the root');
});

test('the extension package does not ship the web page (release.yml copies an explicit list)', () => {
  const wf = read('.github/workflows/release.yml');
  const cp = /cp -r ([^\n]+) build\/json-studio\//.exec(wf);
  assert.ok(cp, 'finds the staging command');
  assert.ok(!cp[1].split(/\s+/).includes('index.html'));
  assert.ok(cp[1].split(/\s+/).includes('studio.html'));
});

test('the landing page (at /docs/) links to the web app at the site root', () => {
  const html = read('docs/index.html');
  assert.match(html, /href="\.\.\/"/);
  assert.doesNotMatch(html, /href="app\/"/);
});
