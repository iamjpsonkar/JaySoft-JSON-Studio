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
  for (const f of ['ast', 'parser', 'fmt', 'loader', 'diff', 'query', 'textdiff', 'find', 'editing', 'convert', 'schema', 'transform']) w.eval(fs.readFileSync(path.join(ROOT, 'core', `${f}.js`), 'utf8'));
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

test('both panes are identical: each has Raw / Preview / Tree / Split and Open, Paste, Clear, Save, Save as', async () => {
  const t = await boot();
  for (const p of [t.a, t.b]) {
    assert.deepEqual(p.qa('[data-views] button').map((b) => b.textContent), ['Raw', 'Preview', 'Tree', 'Split']);
    for (const act of ['open', 'paste', 'clear', 'save', 'saveas']) assert.ok(p.q(`[data-act="${act}"]`), `${p.root.dataset.pane}: ${act}`);
    assert.ok(p.input, 'has its own raw input');
    assert.deepEqual(p.visibleView(), ['raw'], 'a pane opens in Raw so JSON can be pasted straight in');
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

test('loading content into a pane (open / paste) keeps Raw, the default view', async () => {
  const t = await boot();
  const log = [];
  t.w.showOpenFilePicker = async () => [fakeHandle('a.json', '{"x": 1}', log)];
  t.a.act('open');
  await sleep(400);
  assert.deepEqual(t.a.visibleView(), ['raw']);
  assert.equal(t.a.input.value, '{"x": 1}');
  assert.equal(t.a.q('[data-name]').textContent, 'a.json');
  t.b.view('tree'); // a deliberate choice
  t.w.__clip = '{"y": 2}';
  t.b.act('paste');
  await sleep(450);
  assert.equal(t.b.input.value, '{"y": 2}');
  assert.deepEqual(t.b.visibleView(), ['tree'], 'a deliberate choice is not overridden');
  const t2 = await boot();
  t2.w.__clip = '{"z": 3}';
  t2.b.act('paste');
  await sleep(450);
  assert.deepEqual(t2.b.visibleView(), ['raw']);
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
  assert.match(t.a.q('[data-pinput]').value, /"tex$/, 'an unparsable document is shown as typed, so it can be fixed in the preview');

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
  assert.match(t.a.input.value, /"from":"page"/);
  t.a.view('tree');
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
  assert.deepEqual(t2.a.visibleView(), ['raw'], 'the saved per-pane view is kept');
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
  assert.ok(t.a.q('[data-pinput]').value.length > 100000, 'preview renders (plain text beyond the highlight limit)');
  assert.ok(t.a.q('[data-editor="preview"]').classList.contains('plain'), 'colour layer is dropped for very large text');
});

test('default view is Raw (both panes); the Preview editor of an empty pane accepts typing too', async () => {
  const t = await boot();
  assert.equal(t.a.activeBtn(), 'raw');
  assert.equal(t.b.activeBtn(), 'raw');
  t.a.view('preview');
  const ta = t.a.q('[data-pinput]');
  ta.value = '{"typed":"in preview"}';
  ta.dispatchEvent(new t.w.Event('input', { bubbles: true }));
  await sleep(380);
  assert.equal(t.a.input.value, '{"typed":"in preview"}', 'typing in the empty preview fills the document');
});

test('line numbers in Raw and Preview, and colours in Raw', async () => {
  const t = await boot();
  await t.a.type('{\n  "a": 1,\n  "b": "x",\n  "c": [true, null]\n}');
  t.a.view('raw');
  const gutter = t.a.q('[data-editor="raw"] .ed-gutter');
  assert.equal(gutter.textContent, '1\n2\n3\n4\n5');
  const hl = t.a.q('[data-editor="raw"] .ed-hl');
  assert.ok(hl.querySelector('.p-key') && hl.querySelector('.p-str') && hl.querySelector('.p-num') && hl.querySelector('.p-kw'), 'raw is coloured');
  assert.equal(hl.textContent, t.a.input.value, 'the colour layer mirrors the text exactly');
  await t.a.type('[1]');
  assert.equal(gutter.textContent, '1', 'numbers follow the text');
  t.a.view('preview');
  assert.equal(t.a.q('[data-editor="preview"] .ed-gutter').textContent, '1\n2\n3', 'preview has its own numbers (formatted output)');
});

test('line numbers in the tree: every row is numbered by a gutter rule, rows are indented past it', async () => {
  const css = fs.readFileSync(path.join(ROOT, 'studio.css'), 'utf8');
  assert.match(css, /\.row::before\s*\{[^}]*counter-increment: ln/);
  assert.match(css, /\.tree\s*\{[^}]*counter-reset: ln/);
  const t = await boot();
  await t.a.type('{"a": {"b": 1}}');
  t.a.view('tree');
  assert.match(t.a.rows()[0].style.paddingLeft, /^52px$/);
  assert.match(t.a.rows()[1].style.paddingLeft, /^68px$/);
});

test('preview is editable: edits become the raw text, are not re-formatted under the caret, and re-parse', async () => {
  const t = await boot();
  await t.a.type('{"a":1}');
  t.a.view('preview');
  const ta = t.a.q('[data-pinput]');
  assert.equal(ta.value, '{\n  "a": 1\n}');
  ta.value = '{\n  "a": 2, "z": [1,2]\n}';
  ta.dispatchEvent(new t.w.Event('input', { bubbles: true }));
  await sleep(400);
  assert.equal(t.a.input.value, '{\n  "a": 2, "z": [1,2]\n}', 'raw text = the edited preview text');
  assert.equal(ta.value, '{\n  "a": 2, "z": [1,2]\n}', 'the editor text is left as typed');
  assert.equal(t.a.q('[data-editor="preview"] .ed-gutter').textContent, '1\n2\n3');
  t.a.view('tree');
  assert.ok(t.a.rowTexts().includes('"a": 2'), t.a.rowTexts().join(' | '));
  t.a.view('preview');
  assert.equal(ta.value, '{\n  "a": 2,\n  "z": [\n    1,\n    2\n  ]\n}', 'entering the view formats again');
  ta.value = '{"broken": ';
  ta.dispatchEvent(new t.w.Event('input', { bubbles: true }));
  await sleep(400);
  assert.ok(t.a.q('[data-info] .err'), 'a half-typed document shows the error but keeps the text');
  assert.equal(ta.value, '{"broken": ');
  assert.equal(t.a.q('[data-editor="preview"] .ed-hl').textContent, '{"broken": ');
  assert.deepEqual(t.errors, []);
});

test('tree editing: rename a key, add to an object and an array, delete; Python dicts stay Python', async () => {
  const t = await boot();
  await t.a.type('{"a": 1, "list": [1, 2]}');
  t.a.view('tree');
  const rowOf = (re) => t.a.rows().find((r) => re.test(rowTextOf(r)));
  const rowTextOf = (r) => t.rowText(r);
  const dbl = (el) => el.dispatchEvent(new t.w.MouseEvent('dblclick', { bubbles: true }));
  const commit = async (text) => {
    const input = t.a.q('[data-tree] input.edit');
    input.value = text;
    input.dispatchEvent(new t.w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await sleep(400);
  };
  // rename
  dbl(rowOf(/^"a": 1/).querySelector('.k'));
  await commit('renamed');
  assert.match(t.a.input.value, /"renamed": 1/);
  // duplicate key is refused
  dbl(t.a.rows().find((r) => /"renamed"/.test(rowTextOf(r))).querySelector('.k'));
  await commit('list');
  assert.match(t.$('toast').textContent, /already exists/);
  assert.match(t.a.input.value, /"renamed": 1/);
  // add to the root object: new key opens for renaming
  t.click(t.a.rows()[0].querySelector('[data-act="add"]'));
  await sleep(400);
  assert.match(t.a.input.value, /"newKey": null/);
  assert.ok(t.a.q('[data-tree] input.edit'), 'the new key is open for typing');
  await commit('added');
  assert.match(t.a.input.value, /"added": null/);
  // append to the array: the value opens for typing
  t.click(rowOf(/^▾?▸?\s*"list"/).querySelector('[data-act="add"]'));
  await sleep(400);
  const listRow = () => rowOf(/"list"/);
  assert.ok(t.a.q('[data-tree] input.edit'), 'the new item is open for typing');
  await commit('42');
  assert.match(t.a.input.value, /"list": \[\s*1,\s*2,\s*42\s*\]/);
  assert.ok(listRow());
  // delete
  t.click(rowOf(/"added"/).querySelector('[data-act="delete"]'));
  await sleep(400);
  assert.ok(!/added/.test(t.a.input.value));
  assert.equal(t.a.rows()[0].querySelector('[data-act="delete"]'), null, 'the root cannot be deleted');
  // Python stays Python
  await t.b.type("{'k': True}");
  t.b.view('tree');
  t.click(t.b.rows()[0].querySelector('[data-act="add"]'));
  await sleep(400);
  assert.match(t.b.input.value, /'newKey': None/);
  assert.deepEqual(t.errors, []);
});

// ====================================================================== feature batch: resize, maximise, sync, tabs, recents, history, find, editing, export, validate, palette
const key = (w, el, k, o) => el.dispatchEvent(new w.KeyboardEvent('keydown', Object.assign({ key: k, bubbles: true, cancelable: true }, o)));
const ptr = (w, el, type, o) => el.dispatchEvent(new w.MouseEvent(type, Object.assign({ bubbles: true, cancelable: true, button: 0 }, o)));

test('resize by dragging the divider; keyboard and double-click; clamped and remembered', async () => {
  const t = await boot();
  const split = t.$('paneSplit');
  t.$('paneRow').getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 600 });
  ptr(t.w, split, 'pointerdown');
  ptr(t.w, split, 'pointermove', { clientX: 300 });
  const flex = (p) => p.root.style.flex.replace(/ 0px$/, ' 0'); // jsdom writes 0 as 0px
  assert.equal(flex(t.a), '0.3 1 0');
  assert.equal(flex(t.b), '0.7 1 0');
  ptr(t.w, split, 'pointermove', { clientX: 5 });
  assert.equal(flex(t.a), '0.15 1 0', 'a pane cannot be dragged away');
  ptr(t.w, split, 'pointerup');
  assert.equal(JSON.parse(t.w.localStorage.getItem('jsstudio.prefs.v1')).split, 0.15, 'remembered');
  key(t.w, split, 'ArrowRight');
  assert.equal(Math.round(JSON.parse(t.w.localStorage.getItem('jsstudio.prefs.v1')).split * 100), 17);
  split.dispatchEvent(new t.w.MouseEvent('dblclick', { bubbles: true }));
  assert.equal(flex(t.a), '0.5 1 0');
  // after a reload the saved size is applied
  ptr(t.w, split, 'pointerdown'); ptr(t.w, split, 'pointermove', { clientX: 400 }); ptr(t.w, split, 'pointerup');
  const t2 = await boot({ prefs: JSON.parse(t.w.localStorage.getItem('jsstudio.prefs.v1')) });
  assert.equal(flex(t2.a), '0.4 1 0');
  // the divider between the panes and the compare area exists only outside the viewer
  assert.equal(t.$('stageSplit').hidden, true);
  t.click(t.q('#modeSwitch [data-mode="compare"]'));
  assert.equal(t.$('stageSplit').hidden, false);
  t.$('stage').getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 1000 });
  ptr(t.w, t.$('stageSplit'), 'pointerdown'); ptr(t.w, t.$('stageSplit'), 'pointermove', { clientY: 600 }); ptr(t.w, t.$('stageSplit'), 'pointerup');
  assert.equal(t.$('paneRow').style.flex.replace(/ 0px /, ' 0 '), '0 0 60%');
  t.click('cToggleInputs');
  assert.equal(t.$('stageSplit').hidden, true, 'no divider while the panes are hidden');
  assert.deepEqual(t.errors, []);
});

test('maximise a pane; Escape restores', async () => {
  const t = await boot();
  t.a.act('max');
  assert.equal(t.$('paneRow').dataset.max, 'a');
  assert.equal(t.a.q('[data-act="max"]').getAttribute('aria-pressed'), 'true');
  t.w.document.dispatchEvent(new t.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(t.$('paneRow').dataset.max, undefined);
  t.b.act('max');
  assert.equal(t.$('paneRow').dataset.max, 'b');
  t.b.act('max');
  assert.equal(t.$('paneRow').dataset.max, undefined, 'the same button toggles it back');
});

test('synced scrolling mirrors the other pane, only while switched on', async () => {
  const t = await boot();
  t.a.input.scrollTop = 120;
  t.a.input.dispatchEvent(new t.w.Event('scroll'));
  assert.equal(t.b.input.scrollTop, 0, 'off by default');
  t.click('btnSync');
  assert.equal(t.$('btnSync').textContent, 'Sync scroll: on');
  t.a.input.scrollTop = 150;
  t.a.input.dispatchEvent(new t.w.Event('scroll'));
  assert.equal(t.b.input.scrollTop, 150);
  t.b.input.dispatchEvent(new t.w.Event('scroll')); // the echo from the mirrored pane is ignored
  assert.equal(t.a.input.scrollTop, 150);
  t.b.input.scrollTop = 40;
  t.b.input.dispatchEvent(new t.w.Event('scroll'));
  assert.equal(t.a.input.scrollTop, 40, 'works both ways');
  t.click('btnSync');
  t.a.input.scrollTop = 10;
  t.a.input.dispatchEvent(new t.w.Event('scroll'));
  assert.equal(t.b.input.scrollTop, 40, 'off again');
});

test('tabs: opening a file keeps the document already in the pane; switch, close, and survive a reload of the tab', async () => {
  const t = await boot();
  const log = [];
  await t.a.type('{"one": 1}');
  t.w.showOpenFilePicker = async () => [fakeHandle('two.json', '{"two": 2}', log)];
  t.a.act('open');
  await sleep(400);
  assert.deepEqual(t.a.qa('[data-tabs] .tab').map((x) => x.textContent), ['Untitled×', 'two.json×']);
  assert.equal(t.a.input.value, '{"two": 2}');
  t.click(t.a.q('[data-tab="0"]'));
  await sleep(380);
  assert.equal(t.a.input.value, '{"one": 1}', 'the first document is intact');
  assert.equal(t.a.q('[data-name]').textContent, 'Untitled');
  t.a.view('tree');
  assert.ok(t.a.rowTexts().includes('"one": 1'), 'the tree follows the tab');
  await sleep(600);
  const saved = JSON.parse(t.w.sessionStorage.getItem('jsstudio.session.v1'));
  assert.deepEqual(saved.a.tabs.map((x) => x.text), ['{"one": 1}', '{"two": 2}']);
  t.click(t.a.q('[data-close="0"]'));
  await sleep(380);
  assert.equal(t.a.qa('[data-tabs] .tab').length, 1);
  assert.equal(t.a.input.value, '{"two": 2}');
  assert.equal(t.a.q('[data-name]').textContent, 'two.json');
  t.a.act('newtab');
  await sleep(380);
  assert.equal(t.a.qa('[data-tabs] .tab').length, 2);
  assert.equal(t.a.input.value, '');
  t.click(t.a.q('[data-close="1"]'));
  await sleep(380);
  assert.equal(t.a.input.value, '{"two": 2}');
  assert.deepEqual(t.errors, []);
});

test('tabs are restored with the session', async () => {
  const session = { a: { text: '{"second": 2}', name: 'second', tab: 1, tabs: [{ text: '{"first": 1}', name: 'first' }, { text: '{"second": 2}', name: 'second' }] }, b: { text: '', name: 'Untitled' } };
  const t = await bootSeeded(session);
  assert.deepEqual(t.a.qa('[data-tabs] .tab').map((x) => x.textContent), ['first×', 'second×']);
  assert.equal(t.a.q('[data-tabs] .tab.active').dataset.tab, '1');
  assert.equal(t.a.input.value, '{"second": 2}');
  t.click(t.a.q('[data-tab="0"]'));
  await sleep(380);
  assert.equal(t.a.input.value, '{"first": 1}');
});
/** Like boot(), but sessionStorage is filled before studio.js runs (boot() cannot, the window does not exist yet). */
async function bootSeeded(session, extra) {
  extra = extra || {};
  const html = fs.readFileSync(path.join(ROOT, 'studio.html'), 'utf8').replace(/<script[^>]*src=[^>]*><\/script>/g, '');
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: extra.url || 'http://localhost/studio.html', pretendToBeVisual: true });
  const w = dom.window;
  if (session) w.sessionStorage.setItem('jsstudio.session.v1', JSON.stringify(session));
  for (const [k, v] of Object.entries(extra.local || {})) w.localStorage.setItem(k, JSON.stringify(v));
  w.console.warn = () => {};
  w.matchMedia = () => ({ matches: false, addEventListener() {} });
  w.Element.prototype.scrollIntoView = function () {};
  Object.assign(w, { TextDecoder, TextEncoder, Blob, Response, DecompressionStream });
  Object.defineProperty(w.navigator, 'clipboard', { value: { writeText: async () => {}, readText: async () => '' } });
  w.confirm = () => true;
  for (const f of ['ast', 'parser', 'fmt', 'loader', 'diff', 'query', 'textdiff', 'find', 'editing', 'convert', 'schema', 'transform']) w.eval(fs.readFileSync(path.join(ROOT, 'core', `${f}.js`), 'utf8'));
  w.JSS.setLogLevel('error');
  w.eval(fs.readFileSync(path.join(ROOT, 'studio.js'), 'utf8'));
  await sleep(120);
  const click = (el) => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));
  const root = w.document.querySelector('.docpane[data-pane="a"]');
  const rootB = w.document.querySelector('.docpane[data-pane="b"]');
  const side = (r) => ({ q: (x) => r.querySelector(x), qa: (x) => [...r.querySelectorAll(x)], input: r.querySelector('[data-input]') });
  return { w, click, a: side(root), b: side(rootB) };
}

test('recent files: opened files are listed and reopen in a new tab; the list can be cleared', async () => {
  const t = await boot();
  const log = [];
  t.w.showOpenFilePicker = async () => [fakeHandle('seen.json', '{"seen": true}', log)];
  t.a.act('open');
  await sleep(400);
  t.b.act('recent');
  await sleep(60);
  assert.deepEqual([...t.w.document.querySelectorAll('.menu button')].map((b) => b.textContent), ['seen.json', 'Clear recent files', 'Keep my documents between visits: off'], 'the list is shared by both panes');
  t.click(t.w.document.querySelector('.menu button'));
  await sleep(450);
  assert.equal(t.b.input.value, '{"seen": true}');
  assert.equal(t.w.document.querySelector('.menu'), null, 'the menu closes');
  t.a.act('recent');
  await sleep(60);
  t.click([...t.w.document.querySelectorAll('.menu button')].find((b) => /Clear/.test(b.textContent)));
  await sleep(30);
  t.a.act('recent');
  await sleep(60);
  assert.match(t.w.document.querySelector('.menu').textContent, /No recent files/);
  key(t.w, t.w.document.querySelector('.menu button') || t.w.document.querySelector('.menu'), 'Escape');
  assert.deepEqual(t.errors, []);
});

test('undo / redo of tree edits, apply format and clear', async () => {
  const t = await boot();
  await t.a.type('{"a":1}');
  t.a.view('tree');
  assert.equal(t.a.q('[data-act="undo"]').disabled, true, 'nothing to undo yet');
  t.a.rows()[1].querySelector('.val').dispatchEvent(new t.w.MouseEvent('dblclick', { bubbles: true }));
  const input = t.a.q('[data-tree] input.edit');
  input.value = '2';
  key(t.w, input, 'Enter');
  await sleep(400);
  assert.match(t.a.input.value, /"a": 2/);
  assert.equal(t.a.q('[data-act="undo"]').disabled, false);
  t.a.act('undo');
  await sleep(400);
  assert.equal(t.a.input.value, '{"a":1}', 'the exact original text is back');
  assert.equal(t.a.q('[data-act="redo"]').disabled, false);
  t.a.act('redo');
  await sleep(400);
  assert.match(t.a.input.value, /"a": 2/);
  key(t.w, t.a.q('[data-tree]'), 'z', { ctrlKey: true });
  await sleep(400);
  assert.equal(t.a.input.value, '{"a":1}', 'Ctrl+Z in the tree');
  key(t.w, t.a.q('[data-tree]'), 'z', { ctrlKey: true, shiftKey: true });
  await sleep(400);
  assert.match(t.a.input.value, /"a": 2/, 'Ctrl+Shift+Z');
  t.a.act('clear');
  await sleep(380);
  assert.equal(t.a.input.value, '');
  t.a.act('undo');
  await sleep(400);
  assert.match(t.a.input.value, /"a": 2/, 'even Clear can be undone');
  assert.deepEqual(t.errors, []);
});

test('find and replace in Raw: marks, navigation, regex, case, replace one / all', async () => {
  const t = await boot();
  await t.a.type('{"name": "Ann", "alias": "ann", "n": 12, "m": 345}');
  const bar = t.a.q('[data-view-raw] .findbar');
  assert.equal(bar.hidden, true);
  t.a.act('find-raw');
  assert.equal(bar.hidden, false);
  const [term, repl] = bar.querySelectorAll('input.field');
  const [rx, cs] = bar.querySelectorAll('input[type="checkbox"]');
  const set = (el, v) => { el.value = v; el.dispatchEvent(new t.w.Event('input', { bubbles: true })); };
  const count = () => bar.querySelector('.meta').textContent;
  set(term, 'ann');
  assert.equal(count(), '1 / 2', 'case-insensitive by default');
  assert.equal(t.a.qa('[data-view-raw] .ed-find mark').length, 2);
  assert.equal(t.a.qa('[data-view-raw] .ed-find mark.cur').length, 1, 'the current match is distinct');
  assert.equal(t.a.q('[data-view-raw] .ed-find').textContent, t.a.input.value, 'marks mirror the text exactly');
  key(t.w, term, 'Enter');
  assert.equal(count(), '2 / 2');
  key(t.w, term, 'Enter', { shiftKey: true });
  assert.equal(count(), '1 / 2');
  cs.checked = true; cs.dispatchEvent(new t.w.Event('change'));
  assert.equal(count(), '1 / 1', 'match case');
  cs.checked = false; cs.dispatchEvent(new t.w.Event('change'));
  rx.checked = true; rx.dispatchEvent(new t.w.Event('change'));
  set(term, '\\d+');
  assert.equal(count(), '1 / 2');
  set(term, '(');
  assert.equal(count(), 'invalid regex');
  assert.ok(term.classList.contains('bad'));
  set(term, '(\\d)(\\d)');
  set(repl, '$2$1');
  const btn = (txt) => [...bar.querySelectorAll('button')].find((b) => b.textContent === txt);
  t.click(btn('Replace'));
  await sleep(380);
  assert.match(t.a.input.value, /"n": 21,/, 'replace the current match with capture groups');
  rx.checked = false; rx.dispatchEvent(new t.w.Event('change'));
  set(term, 'ann'); set(repl, 'Bob');
  t.click(btn('All'));
  await sleep(380);
  assert.match(t.a.input.value, /"name": "Bob", "alias": "Bob"/);
  assert.match(t.$('toast').textContent, /Replaced 2 matches/);
  assert.equal(t.a.chips()[0], 'JSON', 'the document re-parsed after replacing');
  key(t.w, term, 'Escape');
  assert.equal(bar.hidden, true);
  assert.equal(t.a.qa('[data-view-raw] .ed-find mark').length, 0, 'closing clears the marks');
  assert.deepEqual(t.errors, []);
});

test('Ctrl/Cmd+F opens find in the editor and prefills a selected word; Preview has its own find', async () => {
  const t = await boot();
  await t.a.type('{"findme": 1}');
  t.a.input.focus();
  t.a.input.setSelectionRange(2, 8);
  key(t.w, t.a.input, 'f', { ctrlKey: true });
  const bar = t.a.q('[data-view-raw] .findbar');
  assert.equal(bar.hidden, false);
  assert.equal(bar.querySelector('input.field').value, 'findme');
  t.a.view('preview');
  t.a.act('find-preview');
  assert.equal(t.a.q('[data-view-preview] .findbar').hidden, false);
});

test('editor: Enter keeps and adds indentation, Tab indents, bracket pairs are marked', async () => {
  const t = await boot();
  const ta = t.a.input;
  ta.focus();
  ta.value = '{'; ta.setSelectionRange(1, 1);
  key(t.w, ta, 'Enter');
  assert.equal(ta.value, '{\n  ');
  assert.equal(ta.selectionStart, 4);
  ta.value = '[]'; ta.setSelectionRange(1, 1);
  key(t.w, ta, 'Enter');
  assert.equal(ta.value, '[\n  \n]');
  assert.equal(ta.selectionStart, 4, 'the closer moves to its own line, caret in between');
  ta.value = 'a\nb'; ta.setSelectionRange(0, 3);
  key(t.w, ta, 'Tab');
  assert.equal(ta.value, '  a\n  b', 'multi-line indent');
  key(t.w, ta, 'Tab', { shiftKey: true });
  assert.equal(ta.value, 'a\nb', 'outdent');
  ta.value = 'x'; ta.setSelectionRange(1, 1);
  key(t.w, ta, 'Escape');
  const tab = new t.w.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
  ta.dispatchEvent(tab);
  assert.equal(tab.defaultPrevented, false, 'after Esc, Tab is left to the browser so focus can leave the editor');
  assert.equal(ta.value, 'x');
  const tab2 = new t.w.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
  ta.dispatchEvent(tab2);
  assert.equal(tab2.defaultPrevented, true, 'Tab indents again afterwards');
  assert.equal(ta.value, 'x  ');
  ta.value = '{"a": [1]}'; ta.setSelectionRange(1, 1);
  ta.dispatchEvent(new t.w.Event('input', { bubbles: true }));
  ta.setSelectionRange(1, 1);
  ta.dispatchEvent(new t.w.KeyboardEvent('keyup', { bubbles: true }));
  const marks = [...t.a.qa('[data-view-raw] .ed-brk mark')].map((m) => m.textContent);
  assert.deepEqual(marks, ['{', '}'], 'caret beside a bracket highlights its partner');
  ta.setSelectionRange(0, 3);
  ta.dispatchEvent(new t.w.KeyboardEvent('keyup', { bubbles: true }));
  assert.equal(t.a.qa('[data-view-raw] .ed-brk mark').length, 0, 'not while selecting');
});

test('export formats in Preview: YAML, CSV, TypeScript, JSON Schema are read-only; switching back edits again', async () => {
  const t = await boot();
  await t.a.type('[{"id": 1, "tags": ["a"]}, {"id": 2}]');
  t.a.view('preview');
  const style = t.a.q('[data-f-style]');
  const ta = t.a.q('[data-pinput]');
  assert.ok([...style.querySelectorAll('optgroup option')].map((o) => o.value).includes('yaml'));
  const pick = (v) => { style.value = v; style.dispatchEvent(new t.w.Event('change')); };
  pick('yaml');
  assert.equal(ta.value, '- id: 1\n  tags:\n    - a\n- id: 2\n');
  assert.equal(ta.readOnly, true);
  assert.equal(t.a.q('[data-f-indent]').disabled, true);
  assert.match(t.a.q('[data-f-note]').textContent, /Read-only export/);
  pick('csv');
  assert.equal(ta.value, 'id,tags[0]\n1,a\n2,\n');
  pick('ts');
  assert.match(ta.value, /export interface Root \{\n {2}id: number;\n {2}tags\?: string\[\];\n\}/);
  pick('schema');
  assert.equal(JSON.parse(ta.value).type, 'array');
  assert.equal(t.a.input.value, '[{"id": 1, "tags": ["a"]}, {"id": 2}]', 'exports never touch the document');
  pick('json');
  assert.equal(ta.readOnly, false);
  assert.equal(t.a.q('[data-f-indent]').disabled, false);
  assert.match(ta.value, /^\[\n {2}\{/);
  pick('yaml');
  t.a.view('tree');
  await t.a.type("{'k': True}");
  t.a.view('tree');
  t.click(t.a.rows()[0].querySelector('[data-act="add"]'));
  await sleep(400);
  assert.match(t.a.input.value, /'newKey': None/, 'editing the tree while an export format is selected keeps the document\'s own format');
  assert.deepEqual(t.errors, []);
});

test('validate: A against the schema in B; errors link to the tree; infer; not-checked keywords are named', async () => {
  const t = await boot();
  t.click(t.q('#modeSwitch [data-mode="validate"]'));
  assert.equal(t.$('stage').dataset.mode, 'validate');
  assert.equal(t.$('valPanel').hidden, false);
  assert.equal(t.$('layoutSwitch').hidden, true);
  assert.match(t.$('vBody').textContent, /Put the document in pane A/);
  await t.a.type('{"id": "x", "tags": [1], "extra": true}');
  await t.b.type(JSON.stringify({ type: 'object', required: ['id', 'name'], additionalProperties: false, properties: { id: { type: 'integer' }, name: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } } }, dependentRequired: {} }));
  await sleep(300);
  assert.equal(t.q('#vStats .chip').textContent, '4 errors');
  assert.match(t.$('vStats').textContent, /not checked: dependentRequired/);
  const rows = t.qa('#vBody .v-row').map((r) => r.querySelector('.v-path').textContent + ' ' + r.querySelector('.chip').textContent);
  assert.deepEqual(rows.sort(), ['$ required', '$.extra additionalProperties', '$.id type', '$.tags[0] type'].sort());
  t.click(t.qa('#vBody .v-row').find((r) => /tags\[0\]/.test(r.textContent)));
  assert.deepEqual(t.a.visibleView(), ['tree'], 'clicking an error shows it in the tree of A');
  assert.ok(t.a.q('[data-tree] .row.flash, [data-tree] .row'), 'tree rendered');
  await t.a.type('{"id": 1, "name": "n"}');
  await sleep(300);
  assert.equal(t.q('#vStats .chip').textContent, 'Valid');
  await t.b.type('{broken');
  await sleep(300);
  assert.match(t.$('vBody').textContent, /Both panes need valid content/);
  t.click('vInfer');
  await sleep(450);
  assert.match(t.b.input.value, /\$schema/);
  assert.equal(t.q('#vStats .chip').textContent, 'Valid', 'the inferred schema accepts its own sample');
  assert.equal(t.b.qa('[data-tabs] .tab').length, 2, 'the broken schema was kept in its own tab');
  t.click(t.q('#modeSwitch [data-mode="viewer"]'));
  assert.equal(t.$('valPanel').hidden, true);
  assert.deepEqual(t.errors, []);
});

test('command palette: Ctrl/Cmd+K, filter, run, Escape; commands reflect state', async () => {
  const t = await boot();
  const doc = t.w.document;
  doc.dispatchEvent(new t.w.KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true, cancelable: true }));
  assert.equal(t.$('palette').hidden, false);
  assert.equal(doc.activeElement, t.$('palInput'));
  const titles = () => [...t.w.document.querySelectorAll('#palList li')].map((l) => l.firstChild.textContent);
  assert.ok(titles().includes('Mode: Compare'));
  assert.ok(!titles().includes('A: undo edit'), 'unavailable commands are not offered');
  assert.ok(!titles().includes('Mode: Viewer'), 'nor the state that is already active');
  const set = (v) => { t.$('palInput').value = v; t.$('palInput').dispatchEvent(new t.w.Event('input')); };
  set('compare');
  assert.deepEqual(titles(), ['Mode: Compare']);
  key(t.w, t.$('palInput'), 'Enter');
  assert.equal(t.$('stage').dataset.mode, 'compare');
  assert.equal(t.$('palette').hidden, true);
  // pane commands target the pane in use
  t.b.input.dispatchEvent(new t.w.Event('focusin', { bubbles: true }));
  doc.dispatchEvent(new t.w.KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true, cancelable: true }));
  set('show tree');
  assert.deepEqual(titles(), ['B: show Tree']);
  key(t.w, t.$('palInput'), 'Enter');
  assert.deepEqual(t.b.visibleView(), ['tree']);
  assert.deepEqual(t.a.visibleView(), ['raw']);
  // format options, arrows and Escape
  t.click('btnPalette');
  set('yaml');
  assert.deepEqual(titles(), ['Preview format: YAML (export)']);
  set('indent');
  key(t.w, t.$('palInput'), 'ArrowDown');
  assert.equal(t.w.document.querySelector('#palList li.sel').textContent.startsWith('Preview indent'), true);
  key(t.w, t.$('palInput'), 'Escape');
  assert.equal(t.$('palette').hidden, true);
  set('');
  t.click('btnPalette');
  set('indent: 4');
  key(t.w, t.$('palInput'), 'Enter');
  assert.equal(JSON.parse(t.w.localStorage.getItem('jsstudio.prefs.v1')).indent, '4');
  assert.deepEqual(t.errors, []);
});

test('tree keyboard: arrows move and fold, Enter edits, F2 renames, Delete removes', async () => {
  const t = await boot();
  await t.a.type('{"a": 1, "list": [10, 20], "z": "last"}');
  t.a.view('tree');
  const tree = t.a.q('[data-tree]');
  const sel = () => t.a.q('[data-tree] .row.sel') && t.rowText(t.a.q('[data-tree] .row.sel'));
  key(t.w, tree, 'ArrowDown');
  assert.equal(sel(), '▾{3}', 'first Down selects the first row');
  key(t.w, tree, 'ArrowDown');
  assert.equal(sel(), '"a": 1');
  key(t.w, tree, 'ArrowDown');
  assert.match(sel(), /^▾"list"/);
  key(t.w, tree, 'ArrowLeft');
  assert.match(sel(), /^▸"list"/, 'Left folds an open node');
  key(t.w, tree, 'ArrowRight');
  assert.match(sel(), /^▾"list"/, 'Right opens a closed node');
  key(t.w, tree, 'ArrowRight');
  assert.equal(sel(), '0: 10', 'Right on an open node enters it');
  key(t.w, tree, 'ArrowLeft');
  assert.match(sel(), /^▾"list"/, 'Left on a leaf goes to the parent');
  key(t.w, tree, 'End');
  assert.equal(sel(), '"z": "last"');
  key(t.w, tree, 'Home');
  assert.equal(sel(), '▾{3}');
  key(t.w, tree, 'ArrowDown');
  key(t.w, tree, 'Enter');
  const input = t.a.q('[data-tree] input.edit');
  assert.ok(input, 'Enter edits a value');
  input.value = '7';
  key(t.w, input, 'Enter');
  await sleep(400);
  assert.match(t.a.input.value, /"a": 7/);
  assert.equal(sel(), '"a": 7', 'the selection survives the edit');
  key(t.w, tree, 'F2');
  const kin = t.a.q('[data-tree] input.edit');
  assert.ok(kin, 'F2 renames the key');
  kin.value = 'first';
  key(t.w, kin, 'Enter');
  await sleep(400);
  assert.match(t.a.input.value, /"first": 7/);
  t.a.rows().find((r) => /"first"/.test(t.rowText(r))).dispatchEvent(new t.w.MouseEvent('click', { bubbles: true }));
  key(t.w, tree, 'Delete');
  await sleep(400);
  assert.ok(!/first/.test(t.a.input.value), 'Delete removes the selected entry');
  assert.deepEqual(t.errors, []);
});

test('a lone pane (1 pane layout, or maximised) fills the whole row despite a saved split', () => {
  const css = fs.readFileSync(path.join(ROOT, 'studio.css'), 'utf8');
  assert.match(css, /#paneRow\[data-layout="1"\] \.docpane, #paneRow\[data-max\] \.docpane \{ flex: 1 1 0 !important; \}/);
});

test('every tab keeps its own view: switching tabs switches Raw / Preview / Tree', async () => {
  const t = await boot();
  await t.a.type('{"one": 1}');
  t.a.view('preview');
  t.a.act('newtab');
  await sleep(380);
  assert.deepEqual(t.a.visibleView(), ['raw'], 'a new tab starts in Raw');
  await t.a.type('{"two": 2}');
  t.a.view('tree');
  assert.deepEqual(t.a.visibleView(), ['tree']);
  t.click(t.a.q('[data-tab="0"]'));
  await sleep(380);
  assert.deepEqual(t.a.visibleView(), ['preview'], 'tab 1 is back in Preview');
  assert.equal(t.a.activeBtn(), 'preview');
  assert.match(t.a.q('[data-pinput]').value, /"one": 1/);
  t.click(t.a.q('[data-tab="1"]'));
  await sleep(380);
  assert.deepEqual(t.a.visibleView(), ['tree'], 'tab 2 is back in Tree');
  assert.ok(t.a.rowTexts().includes('"two": 2'));
  t.b.view('tree');
  assert.deepEqual(t.a.visibleView(), ['tree'], 'the other pane has its own tabs and views');
  await sleep(600);
  const saved = JSON.parse(t.w.sessionStorage.getItem('jsstudio.session.v1'));
  assert.deepEqual(saved.a.tabs.map((x) => x.view), ['preview', 'tree'], 'views are part of the saved session');
  const t2 = await bootSeeded(saved);
  const active = (x) => x.a.q('[data-views] .active').dataset.view;
  assert.equal(active(t2), 'tree', 'the restored tab opens in its own view');
  t2.click(t2.a.q('[data-tab="0"]'));
  await sleep(380);
  assert.equal(active(t2), 'preview');
});

test('new tabs are numbered, and a name can be given by double-clicking the tab', async () => {
  const t = await boot();
  const names = () => t.a.qa('[data-tabs] .tab').map((x) => x.firstChild.textContent);
  t.a.act('newtab'); await sleep(380);
  t.a.act('newtab'); await sleep(380);
  assert.deepEqual(names(), ['Untitled', 'Untitled 2', 'Untitled 3']);
  t.click(t.a.q('[data-close="1"]')); await sleep(380);
  t.a.act('newtab'); await sleep(380);
  assert.deepEqual(names(), ['Untitled', 'Untitled 3', 'Untitled 2'], 'the lowest free number is reused');

  // rename the current tab
  const dbl = (el) => el.dispatchEvent(new t.w.MouseEvent('dblclick', { bubbles: true }));
  const saves = [];
  t.w.showSaveFilePicker = async (o) => { saves.push(o.suggestedName); throw Object.assign(new Error('cancelled'), { name: 'AbortError' }); };
  await t.a.type('{"n": 1}');
  dbl(t.a.q('[data-tab="2"]'));
  const input = t.a.q('[data-tabs] input.tab-edit');
  assert.ok(input, 'a name box opens in the tab');
  input.value = 'orders.json';
  key(t.w, input, 'Enter');
  assert.deepEqual(names(), ['Untitled', 'Untitled 3', 'orders.json']);
  assert.equal(t.a.q('[data-name]').textContent, 'orders.json', 'the pane header shows the new name');
  t.a.act('save');
  await sleep(60);
  assert.deepEqual(saves, ['orders.json'], 'Save suggests the chosen name');

  // Escape cancels, an empty name changes nothing
  dbl(t.a.q('[data-tab="2"]'));
  let box = t.a.q('[data-tabs] input.tab-edit');
  box.value = 'nope'; key(t.w, box, 'Escape');
  assert.equal(names()[2], 'orders.json');
  dbl(t.a.q('[data-tab="2"]'));
  box = t.a.q('[data-tabs] input.tab-edit');
  box.value = '   '; key(t.w, box, 'Enter');
  assert.equal(names()[2], 'orders.json');
  // path separators cannot sneak into a name
  dbl(t.a.q('[data-tab="2"]'));
  box = t.a.q('[data-tabs] input.tab-edit');
  box.value = 'a/b\\c.json'; key(t.w, box, 'Enter');
  assert.equal(names()[2], 'a-b-c.json');

  // renaming another tab switches to it first
  dbl(t.a.q('[data-tab="0"]'));
  box = t.a.q('[data-tabs] input.tab-edit');
  box.value = 'first'; key(t.w, box, 'Enter');
  assert.deepEqual(names(), ['first', 'Untitled 3', 'a-b-c.json']);
  assert.equal(t.a.q('[data-tabs] .tab.active').dataset.tab, '0');
  // the palette offers it too
  t.w.document.dispatchEvent(new t.w.KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true, cancelable: true }));
  t.$('palInput').value = 'rename'; t.$('palInput').dispatchEvent(new t.w.Event('input'));
  key(t.w, t.$('palInput'), 'Enter');
  assert.ok(t.a.q('[data-tabs] input.tab-edit'));
  key(t.w, t.a.q('[data-tabs] input.tab-edit'), 'Escape');
  assert.deepEqual(t.errors, []);
});

test('renaming a tab that is linked to a file detaches it (after confirmation): Save no longer overwrites the file', async () => {
  const t = await boot();
  const log = [];
  const h = fakeHandle('real.json', '{"x": 1}', log);
  t.w.showOpenFilePicker = async () => [h];
  t.a.act('open');
  await sleep(400);
  const picked = [];
  t.w.showSaveFilePicker = async (o) => { picked.push(o.suggestedName); throw Object.assign(new Error('cancelled'), { name: 'AbortError' }); };
  const dbl = (el) => el.dispatchEvent(new t.w.MouseEvent('dblclick', { bubbles: true }));
  t.w.confirm = () => false;
  dbl(t.a.q('[data-tab="0"]'));
  let box = t.a.q('[data-tabs] input.tab-edit');
  box.value = 'copy.json'; key(t.w, box, 'Enter');
  assert.equal(t.a.q('[data-name]').textContent, 'real.json', 'declining the warning keeps the file link and the name');
  t.w.confirm = () => true;
  dbl(t.a.q('[data-tab="0"]'));
  box = t.a.q('[data-tabs] input.tab-edit');
  box.value = 'copy.json'; key(t.w, box, 'Enter');
  assert.equal(t.a.q('[data-name]').textContent, 'copy.json');
  t.a.act('save');
  await sleep(80);
  assert.deepEqual(picked, ['copy.json'], 'Save now asks where, suggesting the new name');
  assert.deepEqual(log, [], 'the original file was never written');
  assert.deepEqual(t.errors, []);
});

// ====================================================================== transforms
test('Transform menu: sort keys, minify, pretty-print; unchanged text is reported, not rewritten; history can undo', async () => {
  const t = await boot();
  const items = () => [...t.w.document.querySelectorAll('.menu button')].map((b) => b.textContent);
  const pick = async (label) => { t.click([...t.w.document.querySelectorAll('.menu button')].find((b) => b.textContent === label)); await sleep(420); };
  const open = () => { t.a.act('transform'); };
  await t.a.type('{"b": 2, "a": {"z": 1, "y": [3, 1, 2]}}');
  open();
  assert.deepEqual(items().filter((x) => /^(Sort|Minify|Pretty|Remove|Flatten|Unflatten|Stringify|Parse|Convert)/.test(x)).length, 16, 'the menu lists every transform');
  assert.equal(t.w.document.querySelectorAll('.menu .menu-sep').length, 3, 'in groups');
  await pick('Sort keys A → Z');
  assert.equal(t.a.input.value, '{\n  "a": {\n    "y": [\n      3,\n      1,\n      2\n    ],\n    "z": 1\n  },\n  "b": 2\n}');
  assert.match(t.$('toast').textContent, /Sort keys: reordered the keys of 2 objects/);
  open(); await pick('Sort keys A → Z');
  assert.match(t.$('toast').textContent, /already in that order/, 'nothing is rewritten when nothing changes');
  open(); await pick('Minify');
  assert.equal(t.a.input.value, '{"a":{"y":[3,1,2],"z":1},"b":2}');
  open(); await pick('Minify');
  assert.match(t.$('toast').textContent, /nothing to change/);
  open(); await pick('Pretty-print (tabs)');
  assert.match(t.a.input.value, /^\{\n\t"a": \{\n\t\t"y"/);
  open(); await pick('Sort keys Z → A');
  assert.match(t.a.input.value, /^\{\n\t"b": 2,\n\t"a"/, 'keeps the tab indentation it was given');
  await t.a.type('{"y": 1,\n    "x": 2}');
  open(); await pick('Sort keys A → Z');
  assert.equal(t.a.input.value, '{\n    "x": 2,\n    "y": 1\n}', 'and 4 spaces stay 4 spaces');
  t.a.view('tree');
  t.a.act('undo'); await sleep(420);
  assert.equal(t.a.input.value, '{"y": 1,\n    "x": 2}', 'undo returns to the text as it was before the last transform');
  assert.deepEqual(t.errors, []);
});

test('Transform: Sort arrays dialog (by field, order, scope), cancel, bad path; other clean-ups', async () => {
  const t = await boot();
  const pick = async (label) => { t.a.act('transform'); t.click([...t.w.document.querySelectorAll('.menu button')].find((b) => b.textContent === label)); await sleep(420); };
  const val = () => JSON.parse(t.a.input.value);
  await t.a.type('{"items": [{"n": "b", "p": 2}, {"n": "a", "p": 10}, {"n": "c"}], "nums": [3, 1, 2]}');
  await pick('Sort arrays…');
  const dlg = () => t.w.document.querySelector('.modal');
  assert.ok(dlg(), 'a dialog opens');
  assert.equal(t.w.document.activeElement, dlg().querySelector('input'), 'focus is in the first field');
  key(t.w, dlg().parentElement, 'Escape');
  assert.equal(dlg(), null, 'Esc cancels');
  assert.equal(t.a.input.value, '{"items": [{"n": "b", "p": 2}, {"n": "a", "p": 10}, {"n": "c"}], "nums": [3, 1, 2]}', 'cancelling changes nothing');
  const fill = async (by, order, scope) => {
    await pick('Sort arrays…');
    const [inp, ord, sc] = [dlg().querySelector('input'), ...dlg().querySelectorAll('select')];
    inp.value = by; ord.value = order; sc.value = scope;
    dlg().dispatchEvent(new t.w.Event('submit', { cancelable: true }));
    await sleep(420);
  };
  await fill('p', 'desc', 'all');
  assert.deepEqual(val().items.map((x) => x.n), ['a', 'b', 'c'], 'by p descending (10, 2); the item without p stays last');
  assert.deepEqual(val().nums, [3, 1, 2], 'arrays of values are untouched when sorting by a field of objects');
  await fill('', 'asc', 'all');
  assert.deepEqual(val().nums, [1, 2, 3], 'blank field sorts the values themselves');
  await fill('n', 'asc', 'top');
  assert.match(t.$('toast').textContent, /not an array/, 'top-level scope on an object says why nothing happened');
  await fill('a[', 'asc', 'all');
  assert.match(t.$('toast').textContent, /not a valid field path/);
  assert.deepEqual(t.errors, []);

  await t.b.type('{"a": null, "b": "", "c": [1, 1, 2], "d": {"e": {}}, "f.g": 1}');
  const pickB = async (label) => { t.b.act('transform'); t.click([...t.w.document.querySelectorAll('.menu button')].find((b) => b.textContent === label)); await sleep(420); };
  await pickB('Remove nulls and empty values');
  assert.deepEqual(JSON.parse(t.b.input.value), { c: [1, 1, 2], 'f.g': 1 });
  await pickB('Remove duplicate array items');
  assert.deepEqual(JSON.parse(t.b.input.value).c, [1, 2]);
  await pickB('Flatten to dotted keys');
  assert.deepEqual(JSON.parse(t.b.input.value), { 'c[0]': 1, 'c[1]': 2, '["f.g"]': 1 });
  await pickB('Unflatten dotted keys');
  assert.deepEqual(JSON.parse(t.b.input.value), { c: [1, 2], 'f.g': 1 });
  await pickB('Stringify (escape as a JSON string)');
  assert.equal(JSON.parse(t.b.input.value), '{"c":[1,2],"f.g":1}');
  await pickB('Parse a JSON string (unescape)');
  assert.deepEqual(JSON.parse(t.b.input.value), { c: [1, 2], 'f.g': 1 });
  await pickB('Convert to Python');
  await t.b.type("{'t': True, 'n': None, 'b': 1, 'a': 2}");
  await pickB('Sort keys A → Z');
  assert.match(t.b.input.value, /^\{\n {2}'a': 2,\n {2}'b': 1,\n {2}'n': None,\n {2}'t': True\n\}$/, 'a Python document stays Python');
  await pickB('Convert to JSON');
  assert.match(t.b.input.value, /"n": null/);
  await pickB('Convert to JavaScript');
  assert.match(t.b.input.value, /^\{\n {2}a: 2,/);
  await pickB('Parse a JSON string (unescape)');
  assert.match(t.$('toast').textContent, /single JSON string/, 'a mismatch is explained, nothing is changed');
  assert.deepEqual(t.errors, []);
});

test('transforms need a valid document; the palette offers them for the pane in use', async () => {
  const t = await boot();
  assert.equal(t.a.q('[data-act="transform"]').disabled, true, 'nothing to transform in an empty pane');
  await t.a.type('{"broken": ');
  assert.equal(t.a.q('[data-act="transform"]').disabled, true, 'nor in an invalid one');
  await t.a.type('{"b": 1, "a": 2}');
  assert.equal(t.a.q('[data-act="transform"]').disabled, false);
  assert.equal(t.qa('[data-act="transform"]').length, 6, 'one button in each of Raw, Preview and Tree, in both panes');
  t.w.document.dispatchEvent(new t.w.KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true, cancelable: true }));
  t.$('palInput').value = 'a: sort keys'; t.$('palInput').dispatchEvent(new t.w.Event('input'));
  assert.deepEqual([...t.w.document.querySelectorAll('#palList li')].map((l) => l.firstChild.textContent), ['A: Sort keys A → Z', 'A: Sort keys Z → A']);
  key(t.w, t.$('palInput'), 'Enter');
  await sleep(420);
  assert.match(t.a.input.value, /^\{\n {2}"a": 2,\n {2}"b": 1\n\}$/);
  await t.b.type('{"x": ');
  t.b.input.dispatchEvent(new t.w.Event('focusin', { bubbles: true }));
  t.w.document.dispatchEvent(new t.w.KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true, cancelable: true }));
  t.$('palInput').value = 'minify'; t.$('palInput').dispatchEvent(new t.w.Event('input'));
  assert.equal(t.w.document.querySelectorAll('#palList li:not(.none)').length, 0, 'not offered while the pane has an error');
  key(t.w, t.$('palInput'), 'Escape');
  assert.deepEqual(t.errors, []);
});

test('word wrap: on by default, one toggle for every editor, remembered, also in the palette', async () => {
  const t = await boot();
  const eds = () => t.qa('.editor');
  assert.equal(eds().length, 4, 'Raw and Preview in both panes');
  assert.ok(eds().every((e) => e.dataset.wrap === 'on' && e.querySelector('textarea').getAttribute('wrap') === 'soft'), 'wrapping by default');
  assert.ok(t.qa('[data-act="wrap"]').every((b) => b.getAttribute('aria-pressed') === 'true'));
  t.a.act('wrap');
  assert.ok(eds().every((e) => e.dataset.wrap === 'off' && e.querySelector('textarea').getAttribute('wrap') === 'off'), 'the button switches all editors, in both panes');
  assert.ok(t.qa('[data-act="wrap"]').every((b) => b.getAttribute('aria-pressed') === 'false'));
  assert.equal(JSON.parse(t.w.localStorage.getItem('jsstudio.prefs.v1')).wrap, false);
  const t2 = await boot({ prefs: JSON.parse(t.w.localStorage.getItem('jsstudio.prefs.v1')) });
  assert.equal(t2.qa('.editor')[0].dataset.wrap, 'off', 'remembered');
  t2.w.document.dispatchEvent(new t2.w.KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true, cancelable: true }));
  t2.$('palInput').value = 'word wrap'; t2.$('palInput').dispatchEvent(new t2.w.Event('input'));
  assert.deepEqual([...t2.w.document.querySelectorAll('#palList li')].map((l) => l.firstChild.textContent), ['Word wrap: turn on']);
  key(t2.w, t2.$('palInput'), 'Enter');
  assert.equal(t2.qa('.editor')[0].dataset.wrap, 'on');
  const css = fs.readFileSync(path.join(ROOT, 'studio.css'), 'utf8');
  assert.match(css, /\.editor\[data-wrap="on"\] textarea \{ white-space: pre-wrap/);
  assert.deepEqual(t.errors, []);
});

// ====================================================================== MD Studio parity, batch 1: line endings, binary files, multi-open, Ctrl+E, status bar
test('line endings: CRLF files are saved as CRLF; the status bar shows and switches it; mixed endings are announced', async () => {
  const t = await boot();
  const log = [];
  const crlf = fakeHandle('win.json', '{\r\n  "a": 1\r\n}\r\n', log);
  t.w.showOpenFilePicker = async () => [crlf];
  t.a.act('open');
  await sleep(450);
  assert.equal(t.a.input.value, '{\n  "a": 1\n}\n', 'the editor itself always works with \\n');
  await sleep(80);
  assert.equal(t.$('stEol').textContent, 'CRLF');
  await t.a.type('{\n  "a": 2\n}\n');
  t.a.act('save');
  await sleep(150);
  assert.deepEqual(log, [['win.json', '{\r\n  "a": 2\r\n}\r\n']], 'saved with the line ending the file came with');
  t.$('stEol').click();
  assert.equal(t.$('stEol').textContent, 'LF', 'click switches to LF');
  assert.match(t.$('toast').textContent, /LF endings/);
  t.a.act('save');
  await sleep(150);
  assert.equal(log[1][1], '{\n  "a": 2\n}\n', 'and the switch applies to the next save');
  // a new document and pasted text
  t.b.act('newtab'); await sleep(380);
  assert.equal(t.$('stEol').textContent, 'LF', 'new documents start with LF');
  // mixed endings
  t.w.showOpenFilePicker = async () => [fakeHandle('mixed.json', '{\r\n"a": 1,\r\n"b": 2,\n"c": 3\r\n}', [])];
  t.b.act('open');
  await sleep(450);
  assert.match(t.$('toast').textContent, /mixes CRLF and LF.*CRLF/);
  assert.deepEqual(t.errors, []);
});

test('binary and oversized files are refused with a reason, the pane is left alone', async () => {
  const t = await boot();
  await t.a.type('{"keep": true}');
  t.w.showOpenFilePicker = async () => [fakeHandle('pic.png', 'PNG\u0000\u0001\u0002data', [])];
  t.a.act('open');
  await sleep(400);
  assert.match(t.$('toast').textContent, /pic\.png looks like a binary file/);
  assert.equal(t.a.input.value, '{"keep": true}');
  assert.equal(t.a.qa('[data-tabs] .tab').length, 1, 'no tab was added');
  const big = fakeHandle('big.json', '{}', []);
  const f = big.getFile;
  big.getFile = async () => Object.assign(await f(), { size: 60 * 1024 * 1024 });
  t.w.showOpenFilePicker = async () => [big];
  t.a.act('open');
  await sleep(400);
  assert.match(t.$('toast').textContent, /big\.json is too large/);
  assert.deepEqual(t.errors, []);
});

test('Open accepts several files: each gets its own tab; a bad one does not stop the rest', async () => {
  const t = await boot();
  let opts;
  t.w.showOpenFilePicker = async (o) => { opts = o; return [fakeHandle('one.json', '{"n": 1}', []), fakeHandle('bad.bin', 'x\u0000y', []), fakeHandle('two.json', '{"n": 2}', []), fakeHandle('three.json', '{"n": 3}', [])]; };
  t.a.act('open');
  await sleep(600);
  assert.equal(opts.multiple, true, 'the picker allows multiple files');
  assert.deepEqual(t.a.qa('[data-tabs] .tab').map((x) => x.firstChild.textContent), ['one.json', 'two.json', 'three.json']);
  assert.equal(t.a.input.value, '{"n": 3}', 'the last file is the one shown');
  assert.match(t.$('toast').textContent, /bad\.bin looks like a binary file/);
  assert.deepEqual(t.errors, []);
});

test('Ctrl/Cmd+E cycles the view of the pane in use', async () => {
  const t = await boot();
  const doc = t.w.document;
  const press = () => doc.dispatchEvent(new t.w.KeyboardEvent('keydown', { key: 'e', ctrlKey: true, bubbles: true, cancelable: true }));
  assert.equal(t.a.activeBtn(), 'raw');
  press(); assert.equal(t.a.activeBtn(), 'preview');
  press(); assert.equal(t.a.activeBtn(), 'tree');
  press(); assert.equal(t.a.activeBtn(), 'split');
  press(); assert.equal(t.a.activeBtn(), 'raw', 'and round again');
  press(); press(); press();
  t.b.input.dispatchEvent(new t.w.Event('focusin', { bubbles: true }));
  press(); assert.equal(t.b.activeBtn(), 'preview', 'acts on the active pane (B)');
  assert.equal(t.a.activeBtn(), 'split', 'A did not move');
});

test('status bar: caret, selection, selected tree path, document stats', async () => {
  const t = await boot();
  const st = (id) => t.$(id).textContent;
  await t.a.type('{\n  "a": {"b": [1, 2]},\n  "c": "x"\n}');
  t.a.input.focus();
  t.a.input.setSelectionRange(8, 8);
  t.a.input.dispatchEvent(new t.w.Event('keyup', { bubbles: true }));
  await sleep(120);
  assert.equal(st('stPos'), 'A · Ln 2, Col 7');
  t.a.input.setSelectionRange(4, 12);
  t.a.input.dispatchEvent(new t.w.Event('select', { bubbles: true }));
  await sleep(120);
  assert.equal(st('stPos'), 'A · Ln 2, Col 3 (8 selected)');
  assert.match(st('stDoc'), /^JSON · .* B · 6 nodes · depth 3$/);
  assert.equal(t.$('stPath').hidden, true);
  t.a.view('tree');
  t.a.rows().find((r) => /^▾?\s*"b"|"b"/.test(t.rowText(r))).dispatchEvent(new t.w.MouseEvent('click', { bubbles: true }));
  await sleep(120);
  assert.equal(t.$('stPath').hidden, false);
  assert.equal(st('stPath'), '$.a.b');
  t.$('stPath').click();
  await sleep(40);
  assert.equal(t.w.__copied.slice(-1)[0], '$.a.b');
  t.b.input.dispatchEvent(new t.w.Event('focusin', { bubbles: true }));
  await sleep(120);
  assert.equal(st('stDoc'), '', 'follows the pane in use: B is empty');
  assert.match(st('stPos'), /^B/);
  await t.b.type('{broken');
  t.b.input.dispatchEvent(new t.w.Event('keyup', { bubbles: true }));
  await sleep(120);
  assert.equal(st('stDoc'), 'parse error');
  assert.deepEqual(t.errors, []);
});

// ====================================================================== MD Studio parity, batch 2: split view, outline
test('Split view: Raw and Tree side by side; typing updates the tree without collapsing it; scrolling stays in step', async () => {
  const t = await boot();
  await t.a.type('{"a": {"x": 1, "y": {"deep": true}}, "b": [1, 2, 3]}');
  t.a.view('split');
  assert.deepEqual(t.a.visibleView(), ['raw', 'tree'], 'both are shown');
  assert.equal(t.a.activeBtn(), 'split');
  assert.ok(t.a.q('.pane-body').hasAttribute('data-split'));
  assert.ok(t.a.rowTexts().some((r) => /"a": \{2\}/.test(r)), 'the tree is rendered at once');
  // open a deeper branch, then edit the text: the tree must keep it open
  t.a.rows().find((r) => /"y"/.test(t.rowText(r))).querySelector('.caret').click();
  assert.ok(t.a.rowTexts().some((r) => /"deep": true/.test(r)));
  await t.a.type('{"a": {"x": 2, "y": {"deep": true}}, "b": [1, 2, 3]}');
  assert.ok(t.a.rowTexts().some((r) => /"deep": true/.test(r)), 'typing in Raw keeps the opened branch open');
  assert.ok(t.a.rowTexts().includes('"x": 2'), 'and shows the new value');
  // proportional scroll sync between the two halves
  const raw = t.a.input, tree = t.a.q('[data-tree]');
  const dim = (el, sh, ch) => { Object.defineProperty(el, 'scrollHeight', { value: sh, configurable: true }); Object.defineProperty(el, 'clientHeight', { value: ch, configurable: true }); };
  dim(raw, 1000, 200); dim(tree, 2000, 200);
  raw.scrollTop = 400;
  raw.dispatchEvent(new t.w.Event('scroll'));
  assert.equal(tree.scrollTop, 900, 'half way down the text is half way down the tree (400/800 of 1800)');
  tree.dispatchEvent(new t.w.Event('scroll')); // the echo is ignored
  assert.equal(raw.scrollTop, 400);
  tree.scrollTop = 1800;
  tree.dispatchEvent(new t.w.Event('scroll'));
  assert.equal(raw.scrollTop, 800, 'and the other way');
  // the choice belongs to the tab and is remembered
  assert.equal(JSON.parse(t.w.localStorage.getItem('jsstudio.prefs.v1')).panes.a.view, 'split');
  t.a.act('newtab'); await sleep(380);
  assert.deepEqual(t.a.visibleView(), ['raw'], 'a new tab starts in Raw');
  t.click(t.a.q('[data-tab="0"]')); await sleep(380);
  assert.deepEqual(t.a.visibleView(), ['raw', 'tree'], 'tab 1 is back in Split');
  assert.deepEqual(t.errors, []);
});

test('Outline: lists the top-level structure, jumps to a key, remembers the setting', async () => {
  const t = await boot();
  await t.a.type(JSON.stringify({ name: 'Ann', tags: ['a', 'b', 'c'], owner: { id: 7, team: { lead: 'x' } }, active: true }));
  t.a.view('tree');
  const box = t.a.q('[data-outline]');
  assert.equal(box.hidden, true, 'off by default');
  t.a.act('outline');
  assert.equal(box.hidden, false);
  assert.equal(t.a.q('[data-act="outline"]').getAttribute('aria-pressed'), 'true');
  const items = () => [...box.querySelectorAll('.ol-item')].map((b) => `${b.querySelector('.ol-key').textContent} ${b.querySelector('.ol-meta').textContent}`);
  assert.deepEqual(items(), ['name "Ann"', 'tags [3]', '[0] "a"', '[1] "b"', '[2] "c"', 'owner {2}', 'id 7', 'team {1}', 'active true']);
  // jump: collapse everything, then click a nested outline entry
  t.a.act('collapse-all');
  assert.ok(!t.a.rowTexts().some((r) => /"lead"/.test(r)));
  t.click([...box.querySelectorAll('.ol-item')].find((b) => b.querySelector('.ol-key').textContent === 'team'));
  assert.ok(t.a.rowTexts().some((r) => /"team"/.test(r)), 'the branch is opened so the row exists');
  assert.ok(t.w.__scrolled && /"team"/.test(t.w.__scrolled.textContent), 'and scrolled to');
  assert.equal(JSON.parse(t.w.localStorage.getItem('jsstudio.prefs.v1')).outline, true);
  // it follows the view: hidden in Raw, shown in Split
  t.a.view('raw');
  assert.equal(box.hidden, true);
  t.a.view('split');
  assert.equal(box.hidden, false);
  // large top level is cut off, with a note
  await t.b.type(JSON.stringify(Object.fromEntries(Array.from({ length: 350 }, (_, i) => [`k${i}`, i]))));
  t.b.view('tree');
  assert.equal(t.b.qa('[data-outline] .ol-item').length, 300);
  assert.match(t.b.q('[data-outline] .ol-more').textContent, /50 more/);
  // errors and the palette
  await t.b.type('{broken');
  assert.equal(t.b.q('[data-outline]').hidden, true, 'nothing to outline for an invalid document');
  t.a.act('outline');
  assert.equal(box.hidden, true);
  assert.deepEqual(t.errors, []);
});


// ====================================================================== MD Studio parity, batch 3: file links, kept documents, caret and scroll per tab
test('the session records what is needed to come back exactly: ids, file link, unsaved state, caret, scroll', async () => {
  const t = await boot();
  const log = [];
  t.w.showOpenFilePicker = async () => [fakeHandle('doc.json', '{"a": 1, "b": 2}', log)];
  t.a.act('open');
  await sleep(450);
  await t.a.type('{"a": 1, "b": 22}');
  t.a.input.setSelectionRange(5, 9);
  t.a.input.scrollTop = 60;
  await sleep(700);
  const saved = JSON.parse(t.w.sessionStorage.getItem('jsstudio.session.v1')).a;
  assert.equal(typeof saved.id, 'string');
  assert.equal(saved.hasHandle, true, 'knows the document is linked to a file (the handle itself is kept by the browser, not in the session)');
  assert.equal(saved.dirty, true, 'and that it has unsaved changes');
  assert.ok(saved.mtime > 0, 'and when the file was last seen on disk, so the overwrite warning still works');
  assert.deepEqual(saved.sel, [5, 9]);
  assert.equal(saved.scroll, 60);
  assert.equal(saved.tabs.length, 1);
  assert.equal(saved.tabs[0].id, saved.id);
  assert.ok(!JSON.stringify(saved).includes('FileSystem'), 'no handle objects in the session');
});

test('restoring a session: text, unsaved flag, line ending, view, caret and scroll come back; a missing file link degrades to Save as', async () => {
  const session = { a: { id: 'doc-1', text: '{"a": 1,\n "b": 2}', name: 'kept.json', view: 'raw', eol: '\r\n', hasHandle: true, mtime: 123456, dirty: true, sel: [3, 6], scroll: 40, tab: 0,
    tabs: [{ id: 'doc-1', text: '{"a": 1,\n "b": 2}', name: 'kept.json', view: 'raw', eol: '\r\n', hasHandle: true, mtime: 123456, dirty: true, sel: [3, 6], scroll: 40 }] }, b: { text: '', name: 'Untitled' } };
  const t = await bootSeeded(session);
  assert.equal(t.a.input.value, '{"a": 1,\n "b": 2}');
  assert.equal(t.a.input.selectionStart, 3);
  assert.equal(t.a.input.selectionEnd, 6);
  assert.equal(t.a.input.scrollTop, 40);
  assert.equal(t.a.q('[data-name]').textContent, 'kept.json', 'no file link was found, so no unsaved marker on a link that does not exist');
  assert.equal(t.w.document.getElementById('stEol').textContent, 'CRLF');
  // Save has no file to write to now: it asks where
  let asked = 0;
  t.w.showSaveFilePicker = async (o) => { asked++; assert.equal(o.suggestedName, 'kept.json'); throw Object.assign(new Error('cancel'), { name: 'AbortError' }); };
  t.a.q('[data-act="save"]').click();
  await sleep(80);
  assert.equal(asked, 1);
});

test('each tab brings back its own caret and scroll position when you switch to it', async () => {
  const t = await boot();
  await t.a.type('{"one": 1, "pad": "' + 'x'.repeat(50) + '"}');
  t.a.input.setSelectionRange(4, 7);
  t.a.input.scrollTop = 33;
  t.a.act('newtab'); await sleep(380);
  await t.a.type('{"two": 2}');
  t.a.input.setSelectionRange(2, 2);
  t.a.input.scrollTop = 5;
  t.click(t.a.q('[data-tab="0"]')); await sleep(420);
  assert.equal(t.a.input.selectionStart, 4);
  assert.equal(t.a.input.selectionEnd, 7);
  assert.equal(t.a.input.scrollTop, 33);
  t.click(t.a.q('[data-tab="1"]')); await sleep(420);
  assert.equal(t.a.input.selectionStart, 2);
  assert.equal(t.a.input.scrollTop, 5);
});

test('"Keep my documents between visits": off by default and nothing stored; on stores them; a new visit restores them; off erases them', async () => {
  const t = await boot();
  const KEY = 'jsstudio.recover.v1';
  await t.a.type('{"keep": "me"}');
  await sleep(700);
  assert.equal(t.w.localStorage.getItem(KEY), null, 'nothing is written to localStorage by default');
  t.a.act('recent'); await sleep(60);
  const item = () => [...t.w.document.querySelectorAll('.menu button')].find((b) => /Keep my documents/.test(b.textContent));
  assert.match(item().textContent, /: off$/);
  t.click(item());
  assert.match(t.$('toast').textContent, /kept in this browser/);
  const stored = JSON.parse(t.w.localStorage.getItem(KEY));
  assert.equal(stored.a.text, '{"keep": "me"}', 'written at once');
  assert.equal(JSON.parse(t.w.localStorage.getItem('jsstudio.prefs.v1')).keepDocs, true);
  await t.a.type('{"keep": "more"}');
  await sleep(700);
  assert.equal(JSON.parse(t.w.localStorage.getItem(KEY)).a.text, '{"keep": "more"}', 'and kept up to date');

  // a brand new visit (no session of its own): the kept documents come back
  const fresh = await bootSeeded(null, { local: { [KEY]: stored.a ? { a: { ...stored.a, text: '{"restored": true}', tabs: [{ ...stored.a, text: '{"restored": true}' }] }, b: { text: '', name: 'Untitled' } } : {}, 'jsstudio.prefs.v1': { keepDocs: true } } });
  assert.equal(fresh.a.input.value, '{"restored": true}');
  // not opted in: the same data is ignored
  const notOptedIn = await bootSeeded(null, { local: { [KEY]: { a: { text: '{"ignored": true}', name: 'x' }, b: { text: '', name: 'Untitled' } } } });
  assert.equal(notOptedIn.a.input.value, '', 'without the setting, a stored copy is never loaded');

  // turning it off erases the stored copy
  t.a.act('recent'); await sleep(60);
  t.click(item());
  assert.equal(t.w.localStorage.getItem(KEY), null, 'erased');
  assert.match(t.$('toast').textContent, /erased/);
  assert.deepEqual(t.errors, []);
});

// ====================================================================== web version: browsers without the File System Access API, shared github.io storage
test('without the File System Access API, Open uses a file input (several files, binary refused, cancel is harmless)', async () => {
  const t = await boot(); // jsdom has no showOpenFilePicker, like Firefox and Safari
  assert.equal(t.w.showOpenFilePicker, undefined);
  const input = t.$('fileInput');
  const file = (name, text) => ({ name, size: text.length, lastModified: 1000, text: async () => text });
  const choose = async (files) => { Object.defineProperty(input, 'files', { value: files, configurable: true }); await sleep(20); input.dispatchEvent(new t.w.Event('change')); await sleep(450); };
  t.a.act('open');
  await choose([file('a.json', '{"a":\r\n1}'), file('pic.bin', 'x\u0000y'), file('b.json', '{"b": 2}')]);
  assert.deepEqual(t.a.qa('[data-tabs] .tab').map((x) => x.firstChild.textContent), ['a.json', 'b.json']);
  assert.equal(t.a.input.value, '{"b": 2}');
  assert.match(t.$('toast').textContent, /pic\.bin looks like a binary file/);
  t.a.act('open');
  await sleep(20);
  input.dispatchEvent(new t.w.Event('cancel'));
  await sleep(100);
  assert.equal(t.a.qa('[data-tabs] .tab').length, 2, 'cancelling opens nothing');
  t.a.act('open'); t.a.act('open'); // a second click abandons the first dialog instead of piling up listeners
  await choose([file('c.json', '{"c": 3}')]);
  assert.equal(t.a.qa('[data-tabs] .tab').length, 3, 'opened once, not twice');
  assert.ok(t.qa('[data-act="recent"]').every((b) => b.hidden), 'Recent needs file handles: hidden here');
  assert.equal(t.$('linkExt').hidden, false, 'the web version points to the extension');
  assert.deepEqual(t.errors, []);
});

test('without the File System Access API, Save and Save formatted download a copy (line endings kept)', async () => {
  const t = await boot();
  const downloads = [];
  t.w.URL.createObjectURL = (blob) => { downloads.push({ blob }); return `blob:fake${downloads.length}`; };
  t.w.URL.revokeObjectURL = () => {};
  const click = t.w.HTMLAnchorElement.prototype.click;
  t.w.HTMLAnchorElement.prototype.click = function () { downloads[downloads.length - 1].name = this.getAttribute('download'); };
  await t.a.type('{"a": 1}');
  t.a.act('save');
  await sleep(100);
  assert.equal(downloads.length, 1);
  assert.equal(downloads[0].name, 'Untitled.json');
  assert.equal(await downloads[0].blob.text(), '{"a": 1}');
  assert.match(t.$('toast').textContent, /Downloaded Untitled\.json.*cannot save over the original file/);
  // a CRLF document is downloaded as CRLF
  t.$('stEol').click();
  t.a.act('saveas');
  await sleep(100);
  assert.equal(await downloads[1].blob.text(), '{"a": 1}'.replace(/\n/g, '\r\n'));
  assert.equal(t.a.q('[data-name]').textContent, 'Untitled', 'no file link is created');
  t.a.view('preview');
  t.a.act('save-fmt');
  await sleep(100);
  assert.equal(downloads[2].name, 'Untitled.formatted.json');
  assert.match(await downloads[2].blob.text(), /^\{\r\n {2}"a": 1\r\n\}$/);
  t.w.HTMLAnchorElement.prototype.click = click;
  assert.deepEqual(t.errors, []);
});

test('on github.io (storage shared with other pages) documents are never kept between visits', async () => {
  const KEY = 'jsstudio.recover.v1';
  const t = await bootSeeded(null, { url: 'https://someone.github.io/JaySoft-JSON-Studio/app/', local: { 'jsstudio.prefs.v1': { keepDocs: true }, [KEY]: { a: { text: '{"stale": true}', name: 'x' }, b: { text: '', name: 'Untitled' } } } });
  assert.equal(t.a.input.value, '', 'a stored copy and a stored opt-in are both ignored here');
  t.a.q('[data-act="recent"]').click();
  await sleep(80);
  const item = [...t.w.document.querySelectorAll('.menu button')].find((b) => /Keep my documents/.test(b.textContent));
  assert.match(item.textContent, /not available here/);
  item.click();
  assert.match(t.w.document.getElementById('toast').textContent, /shared|readable by those pages/);
  await sleep(700);
  assert.equal(t.w.localStorage.getItem(KEY) === null || JSON.parse(t.w.localStorage.getItem(KEY)).a.text === '{"stale": true}', true, 'nothing new was written');
  assert.notEqual(JSON.parse(t.w.localStorage.getItem('jsstudio.prefs.v1')).keepDocs, true, 'a stored opt-in is switched off here, never honoured');
});
