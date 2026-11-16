// Drives the real studio.html + studio.js + core in jsdom. jsdom has no layout, workers, or Chrome APIs,
// so those are stubbed; this verifies behaviour and DOM output, not visual layout or real-Chrome integration.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function boot({ search = '', session = {}, prefs } = {}) {
  const html = fs.readFileSync(path.join(ROOT, 'studio.html'), 'utf8').replace(/<script[^>]*src=[^>]*><\/script>/g, '');
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: `http://localhost/studio.html${search}`, pretendToBeVisual: true });
  const w = dom.window;
  const errors = [];
  w.console.error = (...a) => errors.push(a.join(' '));
  w.console.warn = () => {};
  w.matchMedia = () => ({ matches: false, addEventListener() {} });
  w.Element.prototype.scrollIntoView = function () { w.__scrolled = this; };
  Object.assign(w, { TextDecoder, TextEncoder, Blob, Response, DecompressionStream, URL: w.URL });
  w.__copied = [];
  Object.defineProperty(w.navigator, 'clipboard', { value: { writeText: async (t) => { w.__copied.push(t); }, readText: async () => w.__clip || '' } });
  w.chrome = { storage: { session: { get: async (k) => ({ [k]: session[k] }), remove: async (k) => { delete session[k]; } } } };
  if (prefs) w.localStorage.setItem('jsstudio.prefs.v1', JSON.stringify(prefs));
  for (const f of ['ast', 'parser', 'fmt', 'loader', 'diff', 'query', 'textdiff']) w.eval(fs.readFileSync(path.join(ROOT, 'core', `${f}.js`), 'utf8'));
  w.JSS.setLogLevel('error');
  w.eval(fs.readFileSync(path.join(ROOT, 'studio.js'), 'utf8'));
  await sleep(60);
  const $ = (id) => w.document.getElementById(id);
  const api = {
    w, $, errors,
    q: (sel, root) => (root || w.document).querySelector(sel),
    qa: (sel, root) => [...(root || w.document).querySelectorAll(sel)],
    click: (elOrSel) => (typeof elOrSel === 'string' ? $(elOrSel) || w.document.querySelector(elOrSel) : elOrSel).dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true })),
    async typeViewer(text) { $('vInput').value = text; $('vInput').dispatchEvent(new w.Event('input', { bubbles: true })); await sleep(380); },
    async typeSide(side, text) {
      const ta = w.document.querySelector(`.cmp-in[data-side="${side}"] [data-input]`);
      ta.value = text; ta.dispatchEvent(new w.Event('input', { bubbles: true })); await sleep(380);
    },
    rows: () => api.qa('#vTree .row'),
    // "▾ "key": value" without the hover buttons
    rowText: (r) => {
      const k = r.querySelector('.k');
      const rest = [...r.children].filter((c) => !c.matches('.caret, .k, .colon, .acts')).map((c) => c.textContent).join(' ');
      return `${r.querySelector('.caret').textContent}${k ? `${k.textContent}: ` : ''}${rest}`.trim();
    },
  };
  return api;
}

test('viewer: JSON renders as a tree with a format chip and size', async () => {
  const t = await boot();
  assert.equal(t.$('viewer').hidden, false);
  await t.typeViewer('{"name":"Ann","age":30,"tags":["a","b"],"nested":{"ok":true,"n":null}}');
  assert.match(t.q('#vInfo .chip').textContent, /^JSON$/);
  const rows = t.rows().map(t.rowText);
  assert.ok(rows[0].includes('{4}'), rows[0]);
  assert.ok(rows.some((r) => r === '"name": "Ann"'), rows.join(' | '));
  assert.ok(rows.some((r) => r.includes('"tags"') && r.includes('[2]')), rows.join(' | '));
  assert.match(t.$('vMeta').textContent, /nodes/);
  assert.deepEqual(t.errors, []);
});

test('viewer: Python dict is detected and formatted back as Python', async () => {
  const t = await boot();
  await t.typeViewer("{'name': 'Bob', 'ok': True, 'none': None, 'pair': (1, 2), 'tags': {'x'}}");
  assert.match(t.q('#vInfo .chip').textContent, /Python/);
  assert.ok(t.qa('#vInfo .chip').some((c) => /not strict JSON/.test(c.textContent)));
  t.click(t.q('#vTabs [data-tab="formatted"]'));
  const out = t.$('vFormatted').value;
  assert.match(out, /'ok': True/);
  assert.match(out, /'none': None/);
  assert.match(out, /\(\s*1,\s*2\s*\)/);
  // switch the output style and indent
  t.$('fStyle').value = 'json';
  t.$('fStyle').dispatchEvent(new t.w.Event('change'));
  t.$('fIndent').value = '0';
  t.$('fIndent').dispatchEvent(new t.w.Event('change'));
  assert.equal(t.$('vFormatted').value, '{"name":"Bob","ok":true,"none":null,"pair":[1,2],"tags":["x"]}');
});

test('viewer: stringified JSON shows the unwrapping steps', async () => {
  const t = await boot();
  await t.typeViewer(JSON.stringify(JSON.stringify({ a: 1, b: [1, 2] })));
  assert.ok(t.qa('#vInfo .steps li').length >= 1);
  assert.match(t.q('#vInfo .steps').textContent, /string/i);
  assert.ok(t.rows().map(t.rowText).some((r) => r.includes('"a": 1')));
});

test('viewer: errors show line/column, snippet, go-to and repair with undo', async () => {
  const t = await boot();
  await t.typeViewer('{"a": [1, 2,\n "b": {"c": "tex');
  const err = t.q('#vInfo .err');
  assert.ok(err, 'error banner shown');
  assert.match(err.textContent, /Line 2/);
  assert.ok(t.qa('#vInfo .err button').some((b) => /repair/i.test(b.textContent)), 'repair offered for truncated input');
  t.click(t.qa('#vInfo .err button').find((b) => /repair/i.test(b.textContent)));
  await sleep(380);
  assert.ok(t.q('#vInfo .note-repair'), 'repair is announced, never silent');
  assert.equal(t.q('#vInfo .err'), null);
  t.click(t.qa('#vInfo .note-repair button')[0]);
  await sleep(380);
  assert.ok(t.q('#vInfo .err'), 'undo restores the original (broken) text');
  assert.match(t.$('vInput').value, /"tex$/);
  assert.equal(t.rows().length, 0, 'no rows while the input is invalid');
  assert.ok(t.q('#vTree .empty'), 'placeholder shown instead');
});

test('viewer: search, navigation and filter', async () => {
  const t = await boot();
  await t.typeViewer(JSON.stringify({ users: [{ name: 'alice', city: 'Paris' }, { name: 'bob', city: 'Berlin' }, { name: 'carol', city: 'Paris' }], other: { x: 1 } }));
  t.$('vSearch').value = 'paris';
  t.$('vSearch').dispatchEvent(new t.w.Event('input'));
  await sleep(300);
  assert.match(t.$('vSearchCount').textContent, /1 \/ 2/);
  assert.equal(t.qa('#vTree .row.match').length, 2);
  assert.equal(t.qa('#vTree .row.current').length, 1);
  t.click('vNext');
  assert.match(t.$('vSearchCount').textContent, /2 \/ 2/);
  t.$('vFilter').checked = true;
  t.$('vFilter').dispatchEvent(new t.w.Event('change'));
  const filtered = t.rows().map(t.rowText);
  assert.ok(!filtered.some((r) => r.includes('"other"')), 'unmatched branches are hidden');
  assert.ok(!filtered.some((r) => r.includes('bob') || r.includes('Berlin')));
  assert.ok(filtered.some((r) => r.includes('Paris')));
});

test('viewer: JSONPath query lists results and reveals them in the tree', async () => {
  const t = await boot();
  await t.typeViewer(JSON.stringify({ store: { book: [{ t: 'A', price: 8 }, { t: 'B', price: 30 }, { t: 'C', price: 12 }] } }));
  t.$('vQuery').value = '$.store.book[?(@.price < 20)].t';
  t.$('vQuery').dispatchEvent(new t.w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  assert.equal(t.$('vQueryBox').hidden, false);
  assert.match(t.$('vQueryCount').textContent, /\(2\)/);
  const items = t.qa('#vQueryBox .q-row');
  assert.equal(items.length, 2);
  assert.match(items[0].textContent, /\$\.store\.book\[0\]\.t/);
  t.click(items[1]);
  assert.equal(t.$('vTree').hidden, false, 'back to the tree');
  assert.ok(t.qa('#vTree .row.flash, #vTree .row').some((r) => /"t": "C"/.test(t.rowText(r))), 'target row is rendered');
  // an invalid query reports an error instead of throwing
  t.$('vQuery').value = '$.a[';
  t.$('vQuery').dispatchEvent(new t.w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  assert.match(t.$('vQueryBox').textContent, /Query error/);
});

test('viewer: copy path, collapse/expand, and large arrays are paged', async () => {
  const t = await boot();
  await t.typeViewer(JSON.stringify({ items: Array.from({ length: 500 }, (_, i) => ({ id: i })) }));
  t.click('vExpandAll');
  const more = t.q('#vTree .more-row');
  assert.ok(more && /300 more/.test(more.textContent), more && more.textContent);
  t.click(more);
  assert.ok(t.rows().length > 200);
  const idRow = t.rows().find((r) => /^"id": 7$/.test(t.rowText(r)));
  assert.ok(idRow, 'row for items[7].id is rendered');
  t.click(t.q('[data-act="path"]', idRow));
  await sleep(20);
  assert.deepEqual(t.w.__copied.slice(-1), ['items[7].id']);
  t.click('vCollapseAll');
  assert.equal(t.rows().length, 2, 'root + items');
});

test('viewer: editing a value in the tree rewrites the input', async () => {
  const t = await boot();
  await t.typeViewer('{"a": 1, "b": "x"}');
  const row = t.rows().find((r) => /"a": 1/.test(t.rowText(r)));
  row.querySelector('.val').dispatchEvent(new t.w.MouseEvent('dblclick', { bubbles: true }));
  const input = t.q('#vTree input.edit');
  assert.ok(input);
  input.value = '12345678901234567890';
  input.dispatchEvent(new t.w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await sleep(120);
  assert.match(t.$('vInput').value, /"a": 12345678901234567890/, 'big numbers survive an edit untouched');
  const row2 = t.rows().find((r) => /"b"/.test(t.rowText(r)));
  row2.querySelector('.val').dispatchEvent(new t.w.MouseEvent('dblclick', { bubbles: true }));
  const input2 = t.q('#vTree input.edit');
  input2.value = 'plain text';
  input2.dispatchEvent(new t.w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await sleep(120);
  assert.match(t.$('vInput').value, /"b": "plain text"/);
});

test('viewer: expand embedded JSON', async () => {
  const t = await boot();
  await t.typeViewer(JSON.stringify({ id: 1, body: '{"a":[1,2]}', note: 'hi' }));
  assert.equal(t.$('vEmbedded').hidden, false);
  assert.match(t.$('vEmbedded').textContent, /\(1\)/);
  t.click('vEmbedded');
  await sleep(380);
  assert.match(t.$('vInput').value, /"body": \{\s*"a": \[/);
  assert.equal(t.$('vEmbedded').hidden, true);
});

test('viewer: apply format replaces the input', async () => {
  const t = await boot();
  await t.typeViewer("{'b': 1, 'a': [1,2]}");
  t.$('fSort').checked = true;
  t.$('fSort').dispatchEvent(new t.w.Event('change'));
  t.click('vApply');
  await sleep(380);
  assert.match(t.$('vInput').value, /^\{\n {2}'a': \[/);
});

test('compare: aligned tree diff, stats, navigation, swap and options', async () => {
  const t = await boot();
  t.click(t.q('#modeSwitch [data-mode="compare"]'));
  assert.equal(t.$('compare').hidden, false);
  assert.equal(t.$('viewer').hidden, true);
  // written as text: a JS number literal would already have been rounded to ...992 before reaching the app
  await t.typeSide('a', '{"id": 1, "name": "x", "n": 9007199254740993, "tags": ["a", "b"], "gone": true, "same": {"k": 1}}');
  await t.typeSide('b', "{'id': 1, 'name': 'y', 'n': 9007199254740992, 'tags': ['a', 'b', 'c'], 'new': None, 'same': {'k': 1}}");
  await sleep(300);
  const chips = t.qa('#cStats .chip').map((c) => c.textContent);
  assert.ok(chips.some((c) => /\+2 added/.test(c)), chips.join(' | '));
  assert.ok(chips.some((c) => /−1 removed/.test(c)));
  assert.ok(chips.some((c) => /~2 changed/.test(c)), 'name and the big id (2^53 apart)');
  const rows = t.qa('#cBody .drow');
  assert.ok(rows.some((r) => r.classList.contains('changed')));
  assert.ok(rows.some((r) => r.classList.contains('added')));
  assert.ok(rows.some((r) => r.classList.contains('removed')));
  assert.ok(!rows.some((r) => /"same"/.test(r.textContent) && r.classList.contains('changed')));
  t.click('cNext');
  assert.match(t.$('cPos').textContent, /^1 \/ 5$/);
  assert.equal(t.qa('#cBody .drow.current').length, 1);
  t.click('cNext');
  assert.match(t.$('cPos').textContent, /^2 \/ 5$/);

  // options: ignoring keys, and key order
  t.$('oIgnore').value = 'name, n, tags, gone, new';
  t.$('oIgnore').dispatchEvent(new t.w.Event('input'));
  await sleep(350);
  assert.equal(t.q('#cStats .chip').textContent, 'Identical');

  // swap flips A and B
  t.$('oIgnore').value = '';
  t.$('oIgnore').dispatchEvent(new t.w.Event('input'));
  await sleep(350);
  t.click('cSwap');
  await sleep(100);
  const chips2 = t.qa('#cStats .chip').map((c) => c.textContent);
  assert.ok(chips2.some((c) => /\+1 added/.test(c)) && chips2.some((c) => /−2 removed/.test(c)), chips2.join(' | '));

  // text diff view
  t.click(t.q('#cTabs [data-ctab="text"]'));
  assert.ok(t.qa('#cBody .trow.change, #cBody .trow.add, #cBody .trow.del').length >= 3);
  t.click('cNext');
  assert.equal(t.qa('#cBody .trow.current').length, 1);

  // exports
  t.click('cCopyPaths');
  await sleep(20);
  assert.match(t.w.__copied.slice(-1)[0], /^(added|removed|changed)\t\$\./m);
  t.click('cCopyPatch');
  await sleep(20);
  assert.match(t.w.__copied.slice(-1)[0], /"op":"/);
  t.$('oArray').value = 'set';
  t.$('oArray').dispatchEvent(new t.w.Event('change'));
  t.click('cCopyPatch');
  assert.match(t.$('toast').textContent, /by index/);
});

test('compare: invalid side blocks the diff and says why', async () => {
  const t = await boot();
  t.click(t.q('#modeSwitch [data-mode="compare"]'));
  await t.typeSide('a', '{"a": 1}');
  await t.typeSide('b', '{"a": ');
  assert.match(t.q('.cmp-in[data-side="b"] .err').textContent, /Line 1/);
  assert.match(t.$('cBody').textContent, /valid/);
});

test('hand-off from the toolbar click (?h=) loads the page JSON; the key is consumed', async () => {
  const session = { 'js:pending:abc123': { text: '{"from":"page","n":[1,2]}', name: 'api response', source: 'page' } };
  const t = await boot({ search: '?h=abc123', session });
  await sleep(120);
  assert.ok(t.rows().map(t.rowText).some((r) => r.includes('"from": "page"')));
  assert.equal(t.$('vName').textContent.trim(), 'api response');
  assert.equal(session['js:pending:abc123'], undefined, 'payload removed after reading');
  assert.equal(t.w.location.search, '', 'URL cleaned');
});

test('hand-off errors are shown, and a missing key is harmless', async () => {
  const t = await boot({ search: '?h=zzz', session: { 'js:pending:zzz': { name: 'big', error: 'The page is 20.0 MB, too large to hand over.' } } });
  await sleep(120);
  assert.match(t.$('toast').textContent, /too large/);
  const t2 = await boot({ search: '?h=missing' });
  await sleep(120);
  assert.deepEqual(t2.errors, []);
});

test('each tab keeps its own session (sessionStorage); preferences are shared', async () => {
  const t = await boot();
  await t.typeViewer('{"restored": true}');
  await sleep(600);
  const saved = t.w.sessionStorage.getItem('jsstudio.session.v1');
  assert.match(saved, /restored/);
  const prefsRaw = t.w.localStorage.getItem('jsstudio.prefs.v1');
  assert.ok(prefsRaw);
  // a fresh tab (new sessionStorage) starts empty even though localStorage prefs exist
  const t2 = await boot({ prefs: JSON.parse(prefsRaw) });
  assert.equal(t2.$('vInput').value, '');
});

test('theme and mode switching', async () => {
  const t = await boot();
  t.click('btnTheme');
  assert.equal(t.w.document.documentElement.dataset.theme, 'light');
  t.click('btnTheme');
  assert.equal(t.w.document.documentElement.dataset.theme, 'dark');
  t.click(t.q('#modeSwitch [data-mode="compare"]'));
  assert.equal(t.q('.viewer-only').hidden, true);
  t.click(t.q('#modeSwitch [data-mode="viewer"]'));
  assert.equal(t.q('.viewer-only').hidden, false);
});

test('safety: hostile content is rendered as text, never as markup', async () => {
  const t = await boot();
  await t.typeViewer(JSON.stringify({ '<img src=x onerror=alert(1)>': '<script>alert(1)</script>', ok: '<b>bold</b>' }));
  assert.equal(t.qa('#vTree img, #vTree script, #vTree b').length, 0);
  assert.ok(t.rows().map(t.rowText).some((r) => r.includes('<script>alert(1)</script>')));
  t.click(t.q('#vTabs [data-tab="formatted"]'));
  assert.equal(t.qa('#vFormattedBox script').length, 0);
});

test('large document: parsed and rendered within the row budget', async () => {
  const t = await boot();
  const big = JSON.stringify(Array.from({ length: 20000 }, (_, i) => ({ id: i, name: `n${i}`, tags: ['a', 'b'] })));
  t.$('vInput').value = big;
  const t0 = Date.now();
  t.$('vInput').dispatchEvent(new t.w.Event('input'));
  while (!/nodes/.test(t.$('vMeta').textContent) && Date.now() - t0 < 10000) await sleep(25);
  const ms = Date.now() - t0;
  console.log(`      perf: ${(big.length / 1048576).toFixed(1)} MB loaded + rendered in ${ms} ms (includes the 250 ms input debounce)`);
  assert.ok(ms < 5000);
  assert.ok(t.rows().length <= 4001);
  assert.match(t.$('vMeta').textContent, /nodes/);
  t.click('vExpandAll');
  assert.ok(t.rows().length <= 4001);
  assert.ok(t.q('#vTree .notice, #vTree .more-row'), 'user is told rows were limited');
});
