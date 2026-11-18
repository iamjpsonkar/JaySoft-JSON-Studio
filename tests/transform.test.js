const test = require('node:test');
const assert = require('node:assert');
const JSS = require('./helper');

const T = JSS.transform;
const P = (s) => { const r = JSS.parser.tryParse(s); assert.ok(r.ok, s); return r.node; };
const J = (n, indent) => JSS.fmt.toJSON(n, { indent: indent === undefined ? 0 : indent });
const run = (fn, src, opts) => { const r = fn(P(src), opts); return Object.assign({ json: r.node ? J(r.node) : null }, r); };

test('parsePath understands the tree path syntax, including odd keys', () => {
  assert.deepEqual(T.parsePath('a.b[0]["odd.key"].c'), ['a', 'b', 0, 'odd.key', 'c']);
  assert.deepEqual(T.parsePath('[0][1]'), [0, 1]);
  assert.deepEqual(T.parsePath('price'), ['price']);
  assert.equal(T.parsePath('a[x]'), null);
  assert.equal(T.parsePath('a["unterminated'), null);
});

test('sortKeys: deep, ascending / descending, natural order, case, stable for duplicates', () => {
  assert.equal(run(T.sortKeys, '{"b":1,"a":{"z":1,"y":2},"c":[{"q":1,"p":2}]}').json, '{"a":{"y":2,"z":1},"b":1,"c":[{"p":2,"q":1}]}');
  assert.equal(run(T.sortKeys, '{"a":1,"c":2,"b":3}', { order: 'desc' }).json, '{"c":2,"b":3,"a":1}');
  assert.equal(run(T.sortKeys, '{"k10":1,"k2":1,"k1":1}').json, '{"k1":1,"k2":1,"k10":1}', 'natural: k2 before k10');
  assert.equal(run(T.sortKeys, '{"b":1,"B":2,"a":3}', { caseInsensitive: true }).json, '{"a":3,"b":1,"B":2}');
  assert.equal(run(T.sortKeys, '{"b":{"y":1,"x":2},"a":1}', { deep: false }).json, '{"a":1,"b":{"y":1,"x":2}}', 'top level only');
  assert.ok(run(T.sortKeys, '{"a":1,"A":0,"a":2}').json.includes('"a":1,"a":2'), 'duplicate keys stay in their original relative order');
  const r = run(T.sortKeys, '{"a":1,"b":2}');
  assert.equal(r.changes, 0, 'already sorted: nothing to change');
  assert.equal(run(T.sortKeys, '{"b":1,"a":1,"c":{"y":1,"x":1}}').changes, 2, 'counts the objects that were reordered');
});

test('sortArrays: by value, by field (dotted / indexed), desc, missing last, mixed types, tuples untouched', () => {
  assert.equal(run(T.sortArrays, '[3,1,2]').json, '[1,2,3]');
  assert.equal(run(T.sortArrays, '[3,1,2]', { order: 'desc' }).json, '[3,2,1]');
  assert.equal(run(T.sortArrays, '["b","a10","a2"]').json, '["a2","a10","b"]', 'natural string order');
  assert.equal(run(T.sortArrays, '[true,null,"x",2,false]').json, '[2,"x",false,true,null]', 'numbers < strings < booleans < null');
  assert.equal(run(T.sortArrays, '[{"n":"b","p":2},{"n":"a","p":3},{"n":"c"}]', { by: 'n' }).json, '[{"n":"a","p":3},{"n":"b","p":2},{"n":"c"}]');
  assert.equal(run(T.sortArrays, '[{"n":"b","p":2},{"n":"a","p":3},{"n":"c"}]', { by: 'p', order: 'desc' }).json, '[{"n":"a","p":3},{"n":"b","p":2},{"n":"c"}]', 'items without the field stay last, even descending');
  assert.equal(run(T.sortArrays, '[{"o":{"v":2}},{"o":{"v":1}}]', { by: 'o.v' }).json, '[{"o":{"v":1}},{"o":{"v":2}}]');
  assert.equal(run(T.sortArrays, '[{"t":[5,1]},{"t":[3]}]', { by: 't[0]' }).json, '[{"t":[3]},{"t":[5,1]}]');
  assert.equal(run(T.sortArrays, '[{"p":10},{"p":9},{"p":100}]', { by: 'p' }).json, '[{"p":9},{"p":10},{"p":100}]', 'numbers sort numerically, not as text');
  assert.equal(run(T.sortArrays, '{"a":[2,1],"b":{"c":[4,3]}}').json, '{"a":[1,2],"b":{"c":[3,4]}}', 'every nested array');
  assert.equal(run(T.sortArrays, '[[2,1],[4,3]]', { deep: false }).json, '[[2,1],[4,3]]', 'top level only: nested arrays stay, arrays of arrays are not sorted by value');
  assert.equal(run(T.sortArrays, '{"a":[2,1]}', { deep: false }).changes, 0);
  assert.match(run(T.sortArrays, '{"a":[2,1]}', { deep: false }).note, /not an array/);
  assert.equal(run(T.sortArrays, '[2,1]', { by: 'a[' }).error.includes('not a valid field path'), true);
  const tuple = P("{'t': (3, 1, 2), 'l': [3, 1, 2]}");
  assert.equal(J(T.sortArrays(tuple).node), '{"t":[3,1,2],"l":[1,2,3]}', 'Python tuples are positional: never reordered');
  assert.equal(run(T.sortArrays, '[1,2,3]').changes, 0);
});

test('removeEmpty: nulls, empty strings, empty containers, cascading; options; tuples kept', () => {
  const r = run(T.removeEmpty, '{"a":null,"b":"","c":[],"d":{},"e":{"f":null},"g":[null,1,""],"h":0,"i":false}');
  assert.deepEqual(JSON.parse(r.json), { g: [1], h: 0, i: false }, '0 and false are real values and stay; "e" disappears once its only child is gone');
  assert.equal(run(T.removeEmpty, '{"a":null,"b":""}', { nulls: true, strings: false, containers: false }).json, '{"b":""}');
  assert.equal(run(T.removeEmpty, '{"a":1}').changes, 0);
  assert.equal(J(T.removeEmpty(P("{'t': (None, 1)}")).node), '{"t":[null,1]}', 'tuple positions are kept');
  assert.equal(run(T.removeEmpty, '[null]').json, '[]', 'the root itself is never removed');
});

test('dedupe: deep equality ignoring key order, first wins, nested arrays, exact numbers', () => {
  assert.equal(run(T.dedupe, '[1,2,1,"1",2]').json, '[1,2,"1"]');
  assert.equal(run(T.dedupe, '[{"a":1,"b":2},{"b":2,"a":1},{"a":1}]').json, '[{"a":1,"b":2},{"a":1}]');
  assert.equal(run(T.dedupe, '{"x":[[1],[1],[2]]}').json, '{"x":[[1],[2]]}');
  assert.equal(run(T.dedupe, '[1.0,1]').changes, 1, '1.0 and 1 are the same number');
  assert.equal(run(T.dedupe, '[12345678901234567890,12345678901234567891]').changes, 0, 'big numbers are compared exactly');
  assert.equal(run(T.dedupe, '[1,2]').changes, 0);
});

test('flatten / unflatten round trip, odd keys, arrays, clashes, gaps', () => {
  const src = '{"a":{"b":[1,{"c":2}],"d":"x"},"e":[],"f.g":true,"h":{}}';
  const flat = run(T.flatten, src);
  assert.deepEqual(JSON.parse(flat.json), { 'a.b[0]': 1, 'a.b[1].c': 2, 'a.d': 'x', e: [], '["f.g"]': true, h: {} });
  const back = run(T.unflatten, flat.json);
  assert.deepEqual(JSON.parse(back.json), JSON.parse(src), 'unflatten(flatten(x)) == x');
  assert.deepEqual(JSON.parse(run(T.flatten, '[[1],[2]]').json), { '[0][0]': 1, '[1][0]': 2 });
  assert.deepEqual(JSON.parse(run(T.unflatten, '{"[0][0]":1,"[1][0]":2}').json), [[1], [2]]);
  assert.equal(run(T.flatten, '5').changes, 0);
  assert.equal(run(T.unflatten, '{"a":1,"b":2}').changes, 0, 'no nested keys: nothing to do');
  const clash = run(T.unflatten, '{"a":1,"a.b":2,"c.d":3}');
  assert.deepEqual(JSON.parse(clash.json), { a: 1, c: { d: 3 } });
  assert.match(clash.note, /1 key skipped/);
  const gap = run(T.unflatten, '{"a[2]":1}');
  assert.deepEqual(JSON.parse(gap.json), { a: [null, null, 1] });
  assert.match(gap.note, /2 missing array positions/);
  assert.equal(run(T.unflatten, '[1]').changes, 0);
});

test('stringify / unescape', () => {
  const s = run(T.stringify, '{"a": [1, 2], "b": "x\\"y"}');
  assert.equal(s.json, JSON.stringify('{"a":[1,2],"b":"x\\"y"}'));
  const u = T.unescape(P(s.json));
  assert.equal(J(u.node), '{"a":[1,2],"b":"x\\"y"}');
  assert.match(T.unescape(P('5')).error, /single JSON string/);
  assert.match(T.unescape(P('"not json"')).error, /does not contain valid JSON/);
});
