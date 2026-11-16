const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');

// Runs background.js against a stubbed chrome API. `grab` is what executeScript returns for the clicked tab.
function setup({ grab, grabThrows, existingStudioTabs = [] } = {}) {
  const calls = { created: [], updated: [], stored: {}, queried: 0 };
  let onClick, onNav, navFilter;
  const chrome = {
    runtime: { getURL: (p) => `chrome-extension://abc/${p}` },
    action: { onClicked: { addListener: (f) => { onClick = f; } } },
    webNavigation: { onBeforeNavigate: { addListener: (f, filter) => { onNav = f; navFilter = filter; } } },
    scripting: { executeScript: async () => { if (grabThrows) throw new Error('Cannot access contents of the page'); return [{ result: grab }]; } },
    storage: { session: { set: async (o) => Object.assign(calls.stored, o) } },
    tabs: {
      create: async (o) => calls.created.push(o.url),
      update: async (id, o) => calls.updated.push([id, o.url]),
      query: async () => { calls.queried++; return existingStudioTabs; },
    },
  };
  const ctx = { chrome, console: { ...console, info() {}, warn() {}, debug() {}, error() {} }, URL, encodeURIComponent, crypto: require('crypto').webcrypto, String, Object, Date };
  vm.runInNewContext(SRC, ctx);
  return { calls, click: (tab) => onClick(tab), nav: (d) => onNav(d), navFilter };
}
const tab = { id: 5, url: 'https://api.example.com/v1/items' };

test('click on a JSON page opens a NEW tab carrying that JSON', async () => {
  const { calls, click } = setup({ grab: { kind: 'page', contentType: 'application/json', title: 'items', text: '{"a":1}' } });
  await click(tab);
  assert.equal(calls.created.length, 1);
  const m = /studio\.html\?h=([0-9a-f-]{36})$/.exec(calls.created[0]);
  assert.ok(m, calls.created[0]);
  const stored = calls.stored[`js:pending:${m[1]}`];
  assert.equal(stored.text, '{"a":1}');
  assert.equal(stored.name, 'items');
  assert.equal(stored.source, 'page');
});

test('every click opens its own tab; existing studio tabs are never reused or looked up', async () => {
  const { calls, click } = setup({ grab: { kind: 'page', title: 't', text: '[1]' }, existingStudioTabs: [{ id: 99, windowId: 1 }] });
  await click(tab);
  await click(tab);
  assert.equal(calls.created.length, 2);
  assert.notEqual(calls.created[0], calls.created[1], 'each tab gets its own hand-off key');
  assert.equal(Object.keys(calls.stored).length, 2);
  assert.equal(calls.queried, 0);
});

test('page with a text selection hands the selection over', async () => {
  const { calls, click } = setup({ grab: { kind: 'selection', title: 'Docs', text: "{'a': True}" } });
  await click(tab);
  assert.equal(Object.values(calls.stored)[0].source, 'selection');
});

test('non-JSON page, restricted page, or script failure: opens a blank studio tab', async () => {
  for (const opts of [{ grab: null }, { grabThrows: true }]) {
    const { calls, click } = setup(opts);
    await click(tab);
    assert.deepEqual(calls.created, ['chrome-extension://abc/studio.html']);
    assert.equal(Object.keys(calls.stored).length, 0);
  }
  const { calls, click } = setup({ grab: { kind: 'page', text: 'x' } });
  await click({ id: 1, url: 'chrome://extensions' });
  assert.deepEqual(calls.created, ['chrome-extension://abc/studio.html'], 'chrome:// pages are never scripted');
});

test('oversized pages are not stored; the studio is told why', async () => {
  const { calls, click } = setup({ grab: { kind: 'page', title: 'huge', text: 'x'.repeat(8 * 1024 * 1024 + 1) } });
  await click(tab);
  const stored = Object.values(calls.stored)[0];
  assert.equal(stored.text, undefined);
  assert.match(stored.error, /too large/);
});

test('navigating to a local .json file turns that very tab into the studio', async () => {
  const { calls, nav, navFilter } = setup();
  assert.ok(navFilter.url.some((f) => f.schemes[0] === 'file' && f.pathSuffix === '.json'));
  const url = 'file:///Users/me/data/a%20b.json';
  await nav({ frameId: 1, tabId: 7, url });
  assert.equal(calls.updated.length, 0, 'sub-frames are ignored');
  await nav({ frameId: 0, tabId: 7, url });
  assert.deepEqual(calls.updated, [[7, `chrome-extension://abc/studio.html?src=${encodeURIComponent(url)}`]]);
  assert.equal(calls.created.length, 0);
});
