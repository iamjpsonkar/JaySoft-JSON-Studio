const test = require('node:test');
const assert = require('node:assert');
const JSS = require('./helper');

const { tryParse } = JSS.parser;
const { compare, toJsonPatch } = JSS.diff;
const { query } = JSS.query;
const { diffLines, myers } = JSS.textdiff;
const { toJSON } = JSS.fmt;
const { pathToString } = JSS.ast;

const P = (s) => { const r = tryParse(s); assert.ok(r.ok, s); return r.node; };
const cmp = (a, b, o) => compare(P(a), P(b), o);
const kinds = (r) => r.diffs.map((d) => `${d.kind}:${pathToString(d.path)}`).sort();

test('identical documents, key order ignored by default', () => {
  const r = cmp('{"a":1,"b":{"x":[1,2],"y":"s"}}', '{"b":{"y":"s","x":[1,2]},"a":1}');
  assert.equal(r.stats.total, 0);
  assert.equal(r.root.status, 'same');
});

test('added / removed / changed / type-changed', () => {
  const r = cmp('{"a":1,"b":"x","c":true,"d":[1,2]}', '{"a":2,"c":"true","d":[1,2,3],"e":null}');
  assert.deepEqual(kinds(r), ['added:d[2]', 'added:e', 'changed:a', 'removed:b', 'type:c']);
  assert.equal(r.stats.added, 2);
  assert.equal(r.stats.removed, 1);
});

test('numbers compare exactly: 1.0 == 1.00, but ids past 2^53 differ', () => {
  assert.equal(cmp('{"n":1.0,"m":15e-1}', '{"n":1.00,"m":1.5}').stats.total, 0);
  const big = cmp('{"id":9007199254740993}', '{"id":9007199254740992}');
  assert.deepEqual(kinds(big), ['changed:id'], 'JS floats would call these equal');
  assert.equal(cmp('{"v":1.001}', '{"v":1.002}', { numberTolerance: 0.01 }).stats.total, 0);
  assert.equal(cmp('{"v":1}', '{"v":"1"}').stats.type, 1);
});

test('Python dict vs JSON compare as the same structure (tuple == list, True == true)', () => {
  const r = cmp("{'a': True, 'b': None, 'c': (1, 2), 'd': {'e': 1.5}}", '{"a":true,"b":null,"c":[1,2],"d":{"e":1.5}}');
  assert.equal(r.stats.total, 0);
});

test('key order can be made significant', () => {
  const r = cmp('{"a":1,"b":2}', '{"b":2,"a":1}', { ignoreKeyOrder: false });
  assert.deepEqual(kinds(r), ['reordered:(root)']);
});

test('array mode: index, key, set', () => {
  const a = '{"u":[{"id":1,"n":"a"},{"id":2,"n":"b"},{"id":3,"n":"c"}]}';
  const b = '{"u":[{"id":3,"n":"c"},{"id":1,"n":"A"},{"id":4,"n":"d"}]}';
  assert.ok(cmp(a, b).stats.changed >= 3, 'by index everything shifts');

  const byKey = cmp(a, b, { arrayMode: 'key', arrayKey: 'id' });
  assert.deepEqual(kinds(byKey), ['added:u[2]', 'changed:u[0].n', 'removed:u[1]']);
  const labels = byKey.root.children[0].children.map((c) => c.idLabel);
  assert.deepEqual(labels, ['id=1', 'id=2', 'id=3', 'id=4'], 'aligned children carry their id label');

  const set = cmp('{"t":["a","b","c"]}', '{"t":["c","a","b"]}', { arrayMode: 'set' });
  assert.equal(set.stats.total, 0);
  const setDiff = cmp('{"t":["a","b","c"]}', '{"t":["c","a","x"]}', { arrayMode: 'set' });
  assert.deepEqual(kinds(setDiff), ['changed:t[1]'], 'leftovers are paired so the change is shown inside, not as add+remove');
  const dup = cmp('{"t":[1,1,2]}', '{"t":[1,2]}', { arrayMode: 'set' });
  assert.equal(dup.stats.removed, 1, 'set mode is a multiset, so a duplicate counts');
});

test('ignore paths: bare name, glob, array index wildcard, regex', () => {
  const a = '{"id":1,"meta":{"updated_at":"x","k":1},"items":[{"ts":1,"v":1},{"ts":2,"v":2}]}';
  const b = '{"id":1,"meta":{"updated_at":"y","k":1},"items":[{"ts":9,"v":1},{"ts":8,"v":2}]}';
  assert.ok(cmp(a, b).stats.total > 0);
  assert.equal(cmp(a, b, { ignorePaths: ['updated_at', 'items[*].ts'] }).stats.total, 0);
  assert.equal(cmp(a, b, { ignorePaths: ['$.meta.updated_at', '$.items.*.ts'] }).stats.total, 0);
  assert.equal(cmp(a, b, { ignorePaths: ['/updated_at|\\.ts$/'] }).stats.total, 0);
  assert.equal(cmp(a, b, { ignorePaths: ['**.ts', 'meta.updated_at'] }).stats.total, 0);
  assert.equal(cmp(a, b, { ignorePaths: ['meta'] }).stats.total, 2, 'ignoring meta still reports items');
  const bad = cmp(a, b, { ignorePaths: ['/(/'] });
  assert.equal(bad.errors.length, 1, 'invalid regex is reported, not thrown');
});

test('string options and missing = null', () => {
  assert.equal(cmp('{"a":"Hello "}', '{"a":"hello"}', { caseInsensitive: true, trimStrings: true }).stats.total, 0);
  assert.equal(cmp('{"a":"Hello"}', '{"a":"hello"}').stats.total, 1);
  assert.equal(cmp('{"a":1}', '{"a":1,"b":null}', { missingEqualsNull: true }).stats.total, 0);
  assert.equal(cmp('{"a":1}', '{"a":1,"b":null}').stats.total, 1);
});

test('duplicate keys are paired by occurrence', () => {
  const r = cmp('{"a":1,"a":2}', '{"a":1,"a":3}');
  assert.deepEqual(kinds(r), ['changed:a']);
});

test('JSON Patch export (array mode index) keeps exact numbers', () => {
  const r = cmp('{"a":1,"b":[1,2,3],"gone":true}', '{"a":12345678901234567890,"b":[1,9],"new":{"x":1}}');
  const patch = JSON.parse(toJsonPatch(r.diffs));
  const ops = patch.map((o) => `${o.op} ${o.path}`);
  assert.deepEqual(ops, ['replace /a', 'replace /b/1', 'remove /gone', 'remove /b/2', 'add /new']);
  assert.ok(toJsonPatch(r.diffs).includes('12345678901234567890'));
  // applying the patch to A must give B
  const apply = (doc, patch) => {
    for (const o of patch) {
      const segs = o.path.split('/').slice(1).map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'));
      const last = segs.pop();
      let cur = doc;
      for (const s of segs) cur = cur[s];
      if (o.op === 'remove') { Array.isArray(cur) ? cur.splice(+last, 1) : delete cur[last]; }
      else if (o.op === 'add') { Array.isArray(cur) ? cur.splice(+last, 0, o.value) : (cur[last] = o.value); }
      else cur[last] = o.value;
    }
    return doc;
  };
  const a = JSON.parse('{"a":1,"b":[1,2,3],"gone":true}');
  const expected = JSON.parse('{"a":12345678901234567890,"b":[1,9],"new":{"x":1}}');
  assert.deepEqual(apply(a, patch), expected);
});

test('large compare is fast', () => {
  const mk = (flip) => JSON.stringify(Array.from({ length: 30000 }, (_, i) => ({ id: i, v: i % 100, s: `x${i}`, f: flip && i % 1000 === 0 ? 'changed' : 'same' })));
  const t0 = Date.now();
  const r = compare(P(mk(false)), P(mk(true)));
  const ms = Date.now() - t0;
  console.log(`      perf: compared 2 x 30000-row arrays in ${ms} ms, ${r.stats.total} diffs`);
  assert.equal(r.stats.changed, 30);
  assert.ok(ms < 5000);
});

// ---------------------------------------------------------------- JSONPath
const Q = (doc, path) => {
  const r = query(P(doc), path);
  assert.ok(!r.error, `${path}: ${r.error}`);
  return r.results.map((x) => toJSON(x.node, { indent: 0 }));
};
const DOC = JSON.stringify({
  store: {
    book: [
      { title: 'A', price: 8.95, tag: 'x', isbn: '1' },
      { title: 'B', price: 12.99, tag: 'y' },
      { title: 'C', price: 22.99, tag: 'x' },
    ],
    bicycle: { color: 'red', price: 19.95 },
  },
  'odd key': [1, 2, 3, 4, 5],
});

test('JSONPath selectors', () => {
  assert.deepEqual(Q(DOC, '$.store.bicycle.color'), ['"red"']);
  assert.deepEqual(Q(DOC, '$.store.book[*].title'), ['"A"', '"B"', '"C"']);
  assert.deepEqual(Q(DOC, '$..price'), ['8.95', '12.99', '22.99', '19.95']);
  assert.deepEqual(Q(DOC, '$.store.book[-1].title'), ['"C"']);
  assert.deepEqual(Q(DOC, '$.store.book[0,2].title'), ['"A"', '"C"']);
  assert.deepEqual(Q(DOC, "$['odd key'][1:3]"), ['2', '3']);
  assert.deepEqual(Q(DOC, "$['odd key'][::2]"), ['1', '3', '5']);
  assert.deepEqual(Q(DOC, "$['odd key'][-2:]"), ['4', '5']);
  assert.deepEqual(Q(DOC, '$.store.*.price').length, 1);
  assert.deepEqual(Q(DOC, '$..book[?(@.price < 20)].title'), ['"A"', '"B"']);
  assert.deepEqual(Q(DOC, "$..book[?(@.tag == 'x' && @.price > 10)].title"), ['"C"']);
  assert.deepEqual(Q(DOC, '$..book[?(@.isbn)].title'), ['"A"'], 'bare path is an existence test');
  assert.deepEqual(Q(DOC, '$..book[?(!@.isbn)].title'), ['"B"', '"C"']);
  assert.deepEqual(Q(DOC, "$..book[?(@.tag == 'y' || @.price > 20)].title"), ['"B"', '"C"']);
  assert.deepEqual(Q(DOC, '$.nothing.here'), []);
});

test('JSONPath errors are reported, not thrown, and report paths', () => {
  for (const bad of ['store', '$.a[', '$[?(@.a ===)]', "$['a'", '$.a[?(@.x <)]']) {
    const r = query(P(DOC), bad);
    assert.ok(r.error, `${bad} should report an error`);
  }
  const r = query(P(DOC), '$.store.book[1]');
  assert.deepEqual(r.results[0].path, ['store', 'book', 1]);
  assert.equal(pathToString(r.results[0].path, { root: true }), '$.store.book[1]');
});

// ---------------------------------------------------------------- text diff
test('Myers diff reconstructs both sides (randomised)', () => {
  let seed = 12345;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  for (let round = 0; round < 300; round++) {
    const a = Array.from({ length: rnd(25) }, () => String(rnd(6)));
    const b = Array.from({ length: rnd(25) }, () => String(rnd(6)));
    const ops = myers(a, b, 1000);
    const outA = [], outB = [];
    for (const [k, i, j] of ops) {
      if (k === 'eq') { assert.equal(a[i], b[j]); outA.push(a[i]); outB.push(b[j]); }
      else if (k === 'del') outA.push(a[i]);
      else outB.push(b[j]);
    }
    assert.deepEqual(outA, a, `round ${round}`);
    assert.deepEqual(outB, b, `round ${round}`);
  }
});

test('diffLines aligns rows with line numbers', () => {
  const r = diffLines('a\nb\nc\nd', 'a\nB\nc\nd\ne');
  assert.deepEqual(r.rows.map((x) => x.kind), ['eq', 'change', 'eq', 'eq', 'add']);
  assert.equal(r.rows[1].a.n, 2);
  assert.equal(r.rows[1].b.text, 'B');
  assert.equal(r.rows[4].a, null);
  assert.deepEqual(r.stats, { added: 1, removed: 0, changed: 1 });
  assert.equal(diffLines('x', 'x').rows.every((x) => x.kind === 'eq'), true);
  const trunc = diffLines(Array.from({ length: 50 }, (_, i) => i).join('\n'), Array.from({ length: 50 }, (_, i) => `z${i}`).join('\n'), { maxD: 10 });
  assert.equal(trunc.truncated, true);
  assert.equal(trunc.rows.length, 50);
});
