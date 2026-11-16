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
  Object.assign(w, { TextDecoder, TextEncoder, Blob, Response, DecompressionStream });
  w.__copied = [];
  Object.defineProperty(w.navigator, 'clipboard', { value: { writeText: async (t) => { w.__copied.push(t); }, readText: async () => w.__clip || '' } });
  w.chrome = { storage: { session: { get: async (k) => ({ [k]: session[k] }), remove: async (k) => { delete session[k]; } } } };
  w.confirm = () => true;
  if (prefs) w.localStorage.setItem('jsstudio.prefs.v1', JSON.stringify(prefs));
  for (const f of ['ast', 'parser', 'fmt', 'loader', 'diff', 'query', 'textdiff']) w.eval(fs.readFileSync(path.join(ROOT, 'core', `${f}.js`), 'utf8'));
  w.JSS.setLogLevel('error');
  w.eval(fs.readFileSync(path.join(ROOT, 'studio.js'), 'utf8'));
  await sleep(60);

  const $ = (id) => w.document.getElementById(id);
  const click = (el) => (typeof el === 'string' ? $(el) || w.document.querySelector(el) : el).dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));
  const rowText = (r) => {
    const k = r.querySelector('.k');
    const rest = [...r.children].filter((c) => !c.matches('.caret, .k, .colon, .acts')).map((c) => c.textContent).join(' ');
    return `${r.querySelector('.caret').textContent}${k ? `${k.textContent}: ` : ''}${rest}`.trim();
  };
  const pane = (side) => {
    const root = w.document.querySelector(`.docpane[data-pane="${side}"]`);
    const p = {
      root,
      q: (sel) => root.querySelector(sel),
      qa: (sel) => [...root.querySelectorAll(sel)],
      input: root.querySelector('[data-input]'),
      async type(text) { p.input.value = text; p.input.dispatchEvent(new w.Event('input', { bubbles: true })); await sleep(380); },
      view: (v) => click(root.querySelector(`[data-views] [data-view="${v}"]`)),
      act: (name) => click(root.querySelector(`[data-act="${name}"]`)),
      rows: () => [...root.querySelectorAll('[data-tree] .row')],
      rowTexts: () => p.rows().map(rowText),
      visibleView: () => ['raw', 'preview', 'tree'].filter((v) => !root.querySelector(`[data-view-${v}]`).hidden),
      activeBtn: () => root.querySelector('[data-views] .active')?.dataset.view,
      chips: () => [...root.querySelectorAll('[data-info] .chip')].map((c) => c.textContent),
    };
    return p;
  };
  return { w, $, errors, click, pane, rowText, a: pane('a'), b: pane('b'), q: (s) => w.document.querySelector(s), qa: (s) => [...w.document.querySelectorAll(s)] };
}

/** A fake File System Access handle backed by a string. */
function fakeHandle(name, content, log) {
  let data = content, mtime = 1000;
  return {
    name, kind: 'file', get data() { return data; },
    queryPermission: async () => 'granted', requestPermission: async () => 'granted',
    getFile: async () => ({ name, size: data.length, lastModified: mtime, text: async () => data }),
    createWritable: async () => ({ write: async (t) => { log.push([name, t]); data = t; mtime += 5; }, close: async () => {}, abort: async () => {} }),
    touchOnDisk(t) { data = t; mtime += 100; },
  };
}

test('both panes are identical: each has Raw / Preview / Tree and Open, Paste, Clear, Save, Save as', async () => {
  const t = await boot();
  for (const p of [t.a, t.b]) {
    assert.deepEqual(p.qa('[data-views] button').map((b) => b.textContent), ['Raw', 'Preview', 'Tree']);
    for (const act of ['open', 'paste', 'clear', 'save', 'saveas']) assert.ok(p.q(`[data-act="${act}"]`), `${p.root.dataset.pane}: ${act}`);
    assert.ok(p.input, 'has its own raw input');
    assert.deepEqual(p.visibleView(), ['raw'], 'an empty pane starts in Raw so there is somewhere to paste');
  }
  assert.equal(t.a.q('[data-label]').textContent, 'A');
  assert.equal(t.b.q('[data-label]').textContent, 'B');
  assert.deepEqual(t.errors, []);
});

test('both panes accept JSON independently, in any format', async () => {
  const t = await boot();
  await t.a.type('{"name":"Ann","tags":["a","b"]}');
  await t.b.type("{'name': 'Bob', 'ok': True, 'pair': (1, 2)}");
  assert.equal(t.a.chips()[0], 'JSON');
  assert.match(t.b.chips()[0], /Python/);
  t.a.view('tree');
  t.b.view('tree');
  assert.ok(t.a.rowTexts().includes('"name": "Ann"'), t.a.rowTexts().join(' | '));
  assert.ok(t.b.rowTexts().includes('"name": "Bob"'), t.b.rowTexts().join(' | '));
  assert.ok(!t.a.rowTexts().some((r) => r.includes('Bob')), 'A is unaffected by B');
  assert.ok(!t.b.rowTexts().some((r) => r.includes('Ann')), 'B is unaffected by A');
  t.b.act('clear');
  await sleep(380);
  assert.equal(t.b.input.value, '');
  assert.ok(t.a.rowTexts().includes('"name": "Ann"'), 'clearing B leaves A alone');
});

test('each pane switches between Raw, Preview and Tree on its own', async () => {
  const t = await boot();
  await t.a.type('{"a":1,"b":[1,2]}');
  await t.b.type('[1,2,3]');
  t.a.view('tree');
  t.b.view('preview');
  assert.deepEqual(t.a.visibleView(), ['tree']);
  assert.deepEqual(t.b.visibleView(), ['preview']);
  assert.equal(t.a.activeBtn(), 'tree');
  assert.equal(t.b.activeBtn(), 'preview');
  t.a.view('raw');
  assert.deepEqual(t.a.visibleView(), ['raw']);
  assert.deepEqual(t.b.visibleView(), ['preview'], 'B did not move');
  assert.equal(t.a.input.value, '{"a":1,"b":[1,2]}', 'Raw keeps the exact original text');
  const saved = JSON.parse(t.w.localStorage.getItem('jsstudio.prefs.v1'));
  assert.equal(saved.panes.a.view, 'raw');
  assert.equal(saved.panes.b.view, 'preview');
  assert.equal(saved.panes.a.picked, true);
});

test('preview: formatted, syntax-coloured, never markup; options apply', async () => {
  const t = await boot();
  await t.a.type("{'name': 'Bob', 'ok': True, 'none': None, 'n': 12, 'pair': (1, 2), 'html': '<b>x</b>'}");
  t.a.view('preview');
  const pre = t.a.q('[data-preview]');
  assert.match(pre.textContent, /'ok': True/);
  assert.match(pre.textContent, /'none': None/);
  assert.ok(pre.querySelector('.p-key') && pre.querySelector('.p-str') && pre.querySelector('.p-num') && pre.querySelector('.p-kw'), 'tokens are coloured');
  assert.equal(pre.querySelectorAll('b').length, 0, 'content is text, not HTML');
  const style = t.a.q('[data-f-style]'), indent = t.a.q('[data-f-indent]');
  style.value = 'json'; style.dispatchEvent(new t.w.Event('change'));
  indent.value = '0'; indent.dispatchEvent(new t.w.Event('change'));
  assert.equal(pre.textContent, '{"name":"Bob","ok":true,"none":null,"n":12,"pair":[1,2],"html":"<b>x</b>"}');
  t.a.act('copy-fmt');
  await sleep(20);
  assert.equal(t.w.__copied.slice(-1)[0], pre.textContent);
});

test('loading content into an empty pane (open / paste) shows a tree, unless a view was picked', async () => {
  const t = await boot();
  const log = [];
  t.w.showOpenFilePicker = async () => [fakeHandle('a.json', '{"x": 1}', log)];
  t.a.act('open');
  await sleep(400);
  assert.deepEqual(t.a.visibleView(), ['tree']);
  assert.equal(t.a.q('[data-name]').textContent, 'a.json');
  t.b.view('raw'); // a deliberate choice
  t.w.__clip = '{"y": 2}';
  t.b.act('paste');
  await sleep(450);
  assert.equal(t.b.input.value, '{"y": 2}');
  assert.deepEqual(t.b.visibleView(), ['raw'], 'a deliberate choice is not overridden');
  const t2 = await boot();
  t2.w.__clip = '{"z": 3}';
  t2.b.act('paste');
  await sleep(450);
  assert.deepEqual(t2.b.visibleView(), ['tree']);
});

test('saving: each pane saves its own raw text, to its own file', async () => {
  const t = await boot();
  const log = [];
  const hA = fakeHandle('a.json', '{"a": 1}', log), hB = fakeHandle('b.json', '{"b": 1}', log);
  const queue = [[hA], [hB]];
  t.w.showOpenFilePicker = async () => queue.shift();
  t.a.act('open'); await sleep(300);
  t.b.act('open'); await sleep(300);
  t.a.view('raw');
  await t.a.type('{"a": 2, "edited": true}');
  assert.match(t.a.q('[data-name]').textContent, /a\.json ●/, 'unsaved marker');
  t.a.act('save');
  await sleep(100);
  assert.deepEqual(log, [['a.json', '{"a": 2, "edited": true}']]);
  assert.equal(hB.data, '{"b": 1}', 'B untouched');
  assert.doesNotMatch(t.a.q('[data-name]').textContent, /●/);
  t.b.view('raw');
  await t.b.type('[1, 2]');
  t.b.act('save');
  await sleep(100);
  assert.deepEqual(log.slice(-1)[0], ['b.json', '[1, 2]']);
  assert.equal(hA.data, '{"a": 2, "edited": true}');
});

test('saving: Save with no file asks where; Save as always asks; conflicts confirm; invalid text can be saved', async () => {
  const t = await boot();
  const log = [];
  const picked = fakeHandle('new.json', '', log);
  let asked = null;
  t.w.showSaveFilePicker = async (o) => { asked = o; return picked; };
  await t.a.type('{"fresh": true}');
  t.a.act('save');
  await sleep(100);
  assert.match(asked.suggestedName, /^Untitled\.json$/);
  assert.deepEqual(log, [['new.json', '{"fresh": true}']]);
  assert.equal(t.a.q('[data-name]').textContent, 'new.json');
  picked.touchOnDisk('{"someone": "else"}');
  let prompts = 0;
  t.w.confirm = () => { prompts++; return false; };
  await t.a.type('{"fresh": false}');
  t.a.act('save');
  await sleep(100);
  assert.equal(prompts, 1);
  assert.equal(log.length, 1, 'declined overwrite: nothing written');
  t.w.confirm = () => true;
  t.a.act('save');
  await sleep(100);
  assert.equal(log.length, 2);
  asked = null;
  t.a.act('saveas');
  await sleep(100);
  assert.ok(asked, 'Save as always asks for a file');
  await t.b.type('{"broken": ');
  t.w.showSaveFilePicker = async () => fakeHandle('broken.json', '', log);
  t.b.act('save');
  await sleep(100);
  assert.deepEqual(log.slice(-1)[0], ['broken.json', '{"broken": ']);
});

test('saving: the formatted preview can be saved too, separately from the raw text', async () => {
  const t = await boot();
  const log = [];
  await t.a.type("{'b': 1, 'a': True}");
  t.a.view('preview');
  t.w.showSaveFilePicker = async (o) => { log.push(['picker', o.suggestedName]); return fakeHandle(o.suggestedName, '', log); };
  t.a.act('save-fmt');
  await sleep(100);
  assert.equal(log[0][1], 'Untitled.formatted.py', 'Python input is saved as Python by default');
  assert.match(log[1][1], /'a': True/);
  assert.equal(t.a.input.value, "{'b': 1, 'a': True}", 'raw text untouched');
  const style = t.a.q('[data-f-style]');
  style.value = 'json'; style.dispatchEvent(new t.w.Event('change'));
  t.a.act('save-fmt');
  await sleep(100);
  assert.equal(log[2][1], 'Untitled.formatted.json');
  assert.match(log[3][1], /"a": true/);
});

test('Ctrl/Cmd+S saves the pane you are working in', async () => {
  const t = await boot();
  const log = [];
  t.w.showSaveFilePicker = async () => fakeHandle('x.json', '', log);
  await t.b.type('{"in": "B"}');
  t.b.input.dispatchEvent(new t.w.Event('focusin', { bubbles: true }));
  t.w.document.dispatchEvent(new t.w.KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true }));
  await sleep(100);
  assert.deepEqual(log, [['x.json', '{"in": "B"}']]);
});

test('1 pane / 2 panes layout; compare always shows both', async () => {
  const t = await boot();
  assert.equal(t.$('paneRow').dataset.layout, '2');
  t.click(t.q('#layoutSwitch [data-layout="1"]'));
  assert.equal(t.$('paneRow').dataset.layout, '1');
  assert.equal(JSON.parse(t.w.localStorage.getItem('jsstudio.prefs.v1')).layout, 1);
  t.click(t.q('#modeSwitch [data-mode="compare"]'));
  assert.equal(t.$('paneRow').dataset.layout, '2', 'compare needs both panes');
  assert.equal(t.$('layoutSwitch').hidden, true);
  t.click(t.q('#modeSwitch [data-mode="viewer"]'));
  assert.equal(t.$('paneRow').dataset.layout, '1', 'back to the chosen layout');
});

test('tree: counts, copy path, big arrays are paged', async () => {
  const t = await boot();
  await t.a.type(JSON.stringify({ items: Array.from({ length: 500 }, (_, i) => ({ id: i })) }));
  t.a.view('tree');
  assert.ok(t.a.rowTexts()[0].includes('{1}'));
  t.a.act('expand-all');
  const more = t.a.q('[data-tree] .more-row');
  assert.ok(more && /300 more/.test(more.textContent), more && more.textContent);
  t.click(more);
  const idRow = t.a.rows().find((r) => /^"id": 7$/.test(t.rowText(r)));
  assert.ok(idRow, 'items[7].id rendered');
  t.click(idRow.querySelector('[data-act="path"]'));
  await sleep(20);
  assert.deepEqual(t.w.__copied.slice(-1), ['items[7].id']);
  t.a.act('collapse-all');
  assert.equal(t.a.rows().length, 2);
});

test('tree: search, navigation and filter work per pane', async () => {
  const t = await boot();
  await t.a.type(JSON.stringify({ users: [{ name: 'alice', city: 'Paris' }, { name: 'bob', city: 'Berlin' }, { name: 'carol', city: 'Paris' }], other: { x: 1 } }));
  await t.b.type(JSON.stringify({ users: [{ name: 'dave', city: 'Paris' }] }));
  t.a.view('tree'); t.b.view('tree');
  const s = t.a.q('[data-search]');
  s.value = 'paris'; s.dispatchEvent(new t.w.Event('input'));
  await sleep(300);
  assert.match(t.a.q('[data-search-count]').textContent, /1 \/ 2/);
  assert.equal(t.a.qa('[data-tree] .row.match').length, 2);
  assert.equal(t.b.q('[data-search-count]').textContent, '', 'B has its own, untouched search');
  t.a.act('next');
  assert.match(t.a.q('[data-search-count]').textContent, /2 \/ 2/);
  const f = t.a.q('[data-filter]');
  f.checked = true; f.dispatchEvent(new t.w.Event('change'));
  const rows = t.a.rowTexts();
  assert.ok(!rows.some((r) => r.includes('"other"') || r.includes('bob')), rows.join(' | '));
});

test('tree: JSONPath query lists results and reveals them; errors are reported', async () => {
  const t = await boot();
  await t.a.type(JSON.stringify({ store: { book: [{ t: 'A', price: 8 }, { t: 'B', price: 30 }, { t: 'C', price: 12 }] } }));
  t.a.view('tree');
  const qi = t.a.q('[data-query]');
  qi.value = '$.store.book[?(@.price < 20)].t';
  qi.dispatchEvent(new t.w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  const box = t.a.q('[data-query-box]');
  assert.equal(box.hidden, false);
  assert.match(box.querySelector('.q-head').textContent, /2 results/);
  const items = [...box.querySelectorAll('.q-row')];
  assert.match(items[0].textContent, /\$\.store\.book\[0\]\.t/);
  t.click(items[1]);
  assert.equal(box.hidden, true, 'back to the tree');
  assert.ok(t.a.rowTexts().some((r) => /"t": "C"/.test(r)));
  qi.value = '$.a[';
  qi.dispatchEvent(new t.w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  assert.match(box.textContent, /Query error/);
  t.click(box.querySelector('.q-head button'));
  assert.equal(box.hidden, true);
});

test('tree: editing a value rewrites the raw text; big numbers survive', async () => {
  const t = await boot();
  await t.a.type('{"a": 1, "b": "x"}');
  t.a.view('tree');
  const row = t.a.rows().find((r) => /"a": 1/.test(t.rowText(r)));
  row.querySelector('.val').dispatchEvent(new t.w.MouseEvent('dblclick', { bubbles: true }));
  const input = t.a.q('[data-tree] input.edit');
  input.value = '12345678901234567890';
  input.dispatchEvent(new t.w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await sleep(120);
  assert.match(t.a.input.value, /"a": 12345678901234567890/);
  const row2 = t.a.rows().find((r) => /"b"/.test(t.rowText(r)));
  row2.querySelector('.val').dispatchEvent(new t.w.MouseEvent('dblclick', { bubbles: true }));
  const input2 = t.a.q('[data-tree] input.edit');
  input2.value = 'plain text';
  input2.dispatchEvent(new t.w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await sleep(120);
  assert.match(t.a.input.value, /"b": "plain text"/);
});

test('raw: errors show line/column, repair is announced and can be undone; expand embedded; apply format', async () => {
  const t = await boot();
  await t.a.type('{"a": [1, 2,\n "b": {"c": "tex');
  const err = t.a.q('[data-info] .err');
  assert.match(err.textContent, /Line 2/);
  const repair = [...err.querySelectorAll('button')].find((b) => /repair/i.test(b.textContent));
  assert.ok(repair, 'repair offered');
  t.click(repair);
  await sleep(380);
  assert.ok(t.a.q('[data-info] .note-repair'), 'repair is announced, never silent');
  t.click(t.a.q('.note-repair button'));
  await sleep(380);
  assert.ok(t.a.q('[data-info] .err'), 'undo restores the original, broken, text');
  assert.match(t.a.input.value, /"tex$/);
  t.a.view('tree');
  assert.ok(t.a.q('[data-tree] .empty'));
  t.a.view('preview');
  assert.match(t.a.q('[data-preview]').textContent, /Fix the error/);

  await t.b.type(JSON.stringify({ id: 1, body: '{"a":[1,2]}' }));
  t.b.view('tree');
  const emb = t.b.q('[data-act="embedded"]');
  assert.equal(emb.hidden, false);
  t.click(emb);
  await sleep(380);
  assert.match(t.b.input.value, /"body": \{\s*"a": \[/);

  await t.b.type("{'b': 1, 'a': [1,2]}");
  t.b.view('raw');
  t.click(t.b.q('[data-act="apply"]'));
  await sleep(380);
  assert.match(t.b.input.value, /^\{\n {2}'b': 1,/);
});

test('safety: hostile content is text in every view, never markup', async () => {
  const t = await boot();
  await t.a.type(JSON.stringify({ '<img src=x onerror=alert(1)>': '<script>alert(1)</script>', ok: '<b>bold</b>' }));
  for (const v of ['tree', 'preview', 'raw']) {
    t.a.view(v);
    assert.equal(t.a.qa('img, script, b').length, 0, v);
  }
  t.a.view('tree');
  assert.ok(t.a.rowTexts().some((r) => r.includes('<script>alert(1)</script>')));
});

test('compare uses the same two panes: aligned diff, stats, navigation, swap and options', async () => {
  const t = await boot();
  await t.a.type('{"id": 1, "name": "x", "n": 9007199254740993, "tags": ["a", "b"], "gone": true, "same": {"k": 1}}');
  await t.b.type("{'id': 1, 'name': 'y', 'n': 9007199254740992, 'tags': ['a', 'b', 'c'], 'new': None, 'same': {'k': 1}}");
  t.click(t.q('#modeSwitch [data-mode="compare"]'));
  await sleep(300);
  assert.equal(t.$('cmpPanel').hidden, false);
  assert.ok(t.a.input.value.includes('"gone"') && t.b.input.value.includes("'new'"), 'the panes kept their content');
  const chips = t.qa('#cStats .chip').map((c) => c.textContent);
  assert.ok(chips.some((c) => /\+2 added/.test(c)), chips.join(' | '));
  assert.ok(chips.some((c) => /−1 removed/.test(c)));
  assert.ok(chips.some((c) => /~2 changed/.test(c)), 'name, and the id that differs only past 2^53');
  const rows = t.qa('#cBody .drow');
  assert.ok(rows.some((r) => r.classList.contains('changed')) && rows.some((r) => r.classList.contains('added')) && rows.some((r) => r.classList.contains('removed')));
  t.click('cNext');
  assert.match(t.$('cPos').textContent, /^1 \/ 5$/);
  assert.equal(t.qa('#cBody .drow.current').length, 1);

  t.a.view('tree');
  assert.deepEqual(t.a.visibleView(), ['tree'], 'a pane can change view while comparing');
  assert.ok(t.qa('#cBody .drow').length > 0, 'the diff is still there');

  await t.b.type('{"id": 1, "name": "x", "n": 9007199254740993, "tags": ["a", "b"], "gone": true, "same": {"k": 1}}');
  await sleep(300);
  assert.equal(t.q('#cStats .chip').textContent, 'Identical', 'editing a pane re-runs the diff');

  await t.b.type('{"id": 1, "name": "y", "n": 1, "tags": [], "same": {"k": 1}, "extra": 1}');
  await sleep(300);
  t.$('oIgnore').value = 'name, n, tags, gone, extra';
  t.$('oIgnore').dispatchEvent(new t.w.Event('input'));
  await sleep(350);
  assert.equal(t.q('#cStats .chip').textContent, 'Identical');
  t.$('oIgnore').value = '';
  t.$('oIgnore').dispatchEvent(new t.w.Event('input'));
  await sleep(350);

  const aBefore = t.a.input.value, bBefore = t.b.input.value;
  t.click('cSwap');
  await sleep(450);
  assert.equal(t.a.input.value, bBefore);
  assert.equal(t.b.input.value, aBefore);

  t.click(t.q('#cTabs [data-ctab="text"]'));
  assert.ok(t.qa('#cBody .trow.change, #cBody .trow.add, #cBody .trow.del').length >= 2);
  t.click('cNext');
  assert.equal(t.qa('#cBody .trow.current').length, 1);
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

test('compare: an invalid pane blocks the diff and says why; panes can be hidden', async () => {
  const t = await boot();
  t.click(t.q('#modeSwitch [data-mode="compare"]'));
  await t.a.type('{"a": 1}');
  await t.b.type('{"a": ');
  assert.match(t.b.q('[data-info] .err').textContent, /Line 1/);
  assert.match(t.$('cBody').textContent, /valid/);
  t.click('cToggleInputs');
  assert.equal(t.$('paneRow').hidden, true, 'hide the panes to give the diff the whole screen');
});

test('hand-off from the toolbar click (?h=) loads pane A; the key is consumed', async () => {
  const session = { 'js:pending:abc123': { text: '{"from":"page","n":[1,2]}', name: 'api response', source: 'page' } };
  const t = await boot({ search: '?h=abc123', session });
  await sleep(150);
  assert.ok(t.a.rowTexts().includes('"from": "page"'), t.a.rowTexts().join(' | '));
  assert.equal(t.a.q('[data-name]').textContent.trim(), 'api response');
  assert.equal(t.b.input.value, '', 'pane B stays empty');
  assert.equal(session['js:pending:abc123'], undefined, 'payload removed after reading');
  assert.equal(t.w.location.search, '', 'URL cleaned');
});

test('hand-off errors are shown, and a missing key is harmless', async () => {
  const t = await boot({ search: '?h=zzz', session: { 'js:pending:zzz': { name: 'big', error: 'The page is 20.0 MB, too large to hand over.' } } });
  await sleep(150);
  assert.match(t.$('toast').textContent, /too large/);
  const t2 = await boot({ search: '?h=missing' });
  await sleep(150);
  assert.deepEqual(t2.errors, []);
});

test('dropping files: onto a pane loads that pane; two files fill A and B', async () => {
  const t = await boot();
  const drop = async (target, files) => {
    const ev = new t.w.Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'dataTransfer', { value: { types: ['Files'], items: files.map((f) => ({ kind: 'file', getAsFile: () => f })) } });
    target.dispatchEvent(ev);
    await sleep(450);
  };
  // jsdom's File has no text(); real Chrome files do, so use a minimal stand-in
  const file = (name, text) => ({ name, size: text.length, text: async () => text });
  await drop(t.b.root, [file('b.json', '{"onB": true}')]);
  assert.equal(t.b.input.value, '{"onB": true}');
  assert.equal(t.a.input.value, '');
  await drop(t.w.document.body, [file('one.json', '{"one": 1}'), file('two.json', '{"two": 2}')]);
  assert.equal(t.a.input.value, '{"one": 1}');
  assert.equal(t.b.input.value, '{"two": 2}');
  assert.equal(t.a.q('[data-name]').textContent, 'one.json');
});

test('each tab keeps its own session (sessionStorage); preferences are shared', async () => {
  const t = await boot();
  await t.a.type('{"restored": "A"}');
  await t.b.type('[1, 2, 3]');
  await sleep(600);
  const saved = JSON.parse(t.w.sessionStorage.getItem('jsstudio.session.v1'));
  assert.equal(saved.a.text, '{"restored": "A"}');
  assert.equal(saved.b.text, '[1, 2, 3]');
  const prefsRaw = t.w.localStorage.getItem('jsstudio.prefs.v1');
  assert.ok(prefsRaw);
  const t2 = await boot({ prefs: JSON.parse(prefsRaw) });
  assert.equal(t2.a.input.value, '');
  assert.equal(t2.b.input.value, '');
  assert.deepEqual(t2.a.visibleView(), ['raw'], 'an empty pane starts in Raw even if Tree was saved');
});

test('theme and mode switching', async () => {
  const t = await boot();
  t.click('btnTheme');
  assert.equal(t.w.document.documentElement.dataset.theme, 'light');
  t.click('btnTheme');
  assert.equal(t.w.document.documentElement.dataset.theme, 'dark');
  t.click(t.q('#modeSwitch [data-mode="compare"]'));
  assert.equal(t.$('stage').dataset.mode, 'compare');
  t.click(t.q('#modeSwitch [data-mode="viewer"]'));
  assert.equal(t.$('cmpPanel').hidden, true);
});

test('large document: parsed and rendered within the row budget', async () => {
  const t = await boot();
  const big = JSON.stringify(Array.from({ length: 20000 }, (_, i) => ({ id: i, name: `n${i}`, tags: ['a', 'b'] })));
  t.a.input.value = big;
  const t0 = Date.now();
  t.a.input.dispatchEvent(new t.w.Event('input'));
  while (!/nodes/.test(t.a.q('[data-meta-raw]').textContent) && Date.now() - t0 < 10000) await sleep(25);
  const ms = Date.now() - t0;
  console.log(`      perf: ${(big.length / 1048576).toFixed(1)} MB loaded in ${ms} ms (includes the 250 ms input debounce)`);
  assert.ok(ms < 5000);
  t.a.view('tree');
  assert.ok(t.a.rows().length <= 4001);
  t.a.act('expand-all');
  assert.ok(t.a.rows().length <= 4001);
  assert.ok(t.a.q('[data-tree] .notice, [data-tree] .more-row'), 'the user is told rows were limited');
  t.a.view('preview');
  assert.ok(t.a.q('[data-preview]').textContent.length > 100000, 'preview renders (plain text beyond the highlight limit)');
});
