const test = require('node:test');
const assert = require('node:assert');
const JSS = require('./helper');
const F = JSS.folding;

const doc = JSON.stringify({ a: { b: [1, 2], c: { d: 1 } }, e: [3] }, null, 2); // 14 lines
// 0 {  1 "a": {  2 "b": [  3 1,  4 2  5 ],  6 "c": {  7 "d": 1  8 }  9 },  10 "e": [  11 3  12 ]  13 }

test('foldRanges finds multi-line blocks with their end, depth and size', () => {
  const { ranges, lines, maxDepth } = F.foldRanges(doc);
  assert.equal(lines.length, 14);
  assert.deepEqual([...ranges].map(([s, r]) => [s, r.end, r.depth, r.count]), [[0, 13, 1, 12], [1, 9, 2, 7], [2, 5, 3, 2], [6, 8, 3, 1], [10, 12, 2, 1]]);
  assert.equal(maxDepth, 3);
});

test('nothing to fold in minified text, empty blocks or scalars; strings never confuse it', () => {
  assert.equal(F.foldRanges('{"a":[1,2],"b":{}}').ranges.size, 0);
  assert.equal(F.foldRanges('[]').ranges.size, 0);
  assert.equal(F.foldRanges('42').ranges.size, 0);
  assert.equal(F.foldRanges('').ranges.size, 0);
  const tricky = '{\n  "s": "has } and [ and \\" a quote {",\n  "t": \'it\\\'s ]\',\n  "u": [\n    1\n  ]\n}';
  assert.deepEqual([...F.foldRanges(tricky).ranges.keys()], [0, 3], 'brackets inside strings are not blocks');
  assert.equal(F.foldRanges('{\n  "a": 1\n').ranges.size, 0, 'an unclosed block is not foldable');
  assert.equal(F.foldRanges('}\n]\n)').ranges.size, 0, 'stray closers are ignored');
});

test('works for Python, JavaScript and tab-indented output; a line opening two blocks folds the outer one', () => {
  const py = "{\n  'a': (\n    1,\n    2\n  ),\n  'b': {\n    'c': True\n  }\n}";
  assert.deepEqual([...F.foldRanges(py).ranges].map(([s, r]) => [s, r.end]), [[0, 8], [1, 4], [5, 7]]);
  assert.equal(F.foldRanges('{\n\t"a": [\n\t\t1\n\t]\n}').ranges.size, 2);
  const two = '[{\n  "a": 1\n}]';
  assert.deepEqual([...F.foldRanges(two).ranges].map(([s, r]) => [s, r.end, r.depth]), [[0, 2, 1]]);
});

test('collapseToLevel keeps N levels open; visibleRows hides folded blocks and summarises them on their first line', () => {
  const { ranges, lines } = F.foldRanges(doc);
  assert.deepEqual([...F.collapseToLevel(ranges, 1)], [0, 1, 2, 6, 10], 'level 1: everything, down to the outermost block');
  assert.deepEqual([...F.collapseToLevel(ranges, 2)], [1, 2, 6, 10]);
  assert.deepEqual([...F.collapseToLevel(ranges, 3)], [2, 6]);
  assert.deepEqual([...F.collapseToLevel(ranges, 4)], []);
  assert.deepEqual(F.visibleRows(lines.length, new Set(), ranges).map((r) => r.line), [...Array(14).keys()]);
  const rows = F.visibleRows(lines.length, new Set([2]), ranges);
  assert.deepEqual(rows.map((r) => r.line), [0, 1, 2, 6, 7, 8, 9, 10, 11, 12, 13], 'the lines inside the folded block are gone');
  assert.deepEqual(rows[2], { line: 2, folded: true, end: 5 });
  assert.deepEqual(F.visibleRows(lines.length, new Set([0]), ranges), [{ line: 0, folded: true, end: 13 }], 'folding the root leaves one row');
  assert.deepEqual(F.visibleRows(lines.length, new Set([1, 2]), ranges).map((r) => r.line), [0, 1, 10, 11, 12, 13], 'a block folded inside a folded block costs nothing');
  assert.deepEqual(F.visibleRows(5, new Set([3]), new Map()), [0, 1, 2, 3, 4].map((line) => ({ line, folded: false })), 'unknown fold points are ignored');
});
