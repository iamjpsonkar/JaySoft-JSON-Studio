const test = require('node:test');
const assert = require('node:assert');
const JSS = require('./helper');

const P = (s) => { const r = JSS.parser.tryParse(s); assert.ok(r.ok, s); return r.node; };

// ---------------------------------------------------------------- find / replace
test('find: plain, case, regex, invalid regex, empty matches', () => {
  const { findAll, replaceAll, replaceOne } = JSS.find;
  assert.deepEqual(findAll('aAa', 'a').matches.map((m) => m.start), [0, 1, 2]);
  assert.deepEqual(findAll('aAa', 'a', { caseSensitive: true }).matches.map((m) => m.start), [0, 2]);
  assert.deepEqual(findAll('a.b', '.').matches, [{ start: 1, end: 2 }], 'plain mode escapes the term');
  assert.equal(findAll('a1b22', '\\d+', { regex: true }).matches.length, 2);
  assert.ok(findAll('x', '(', { regex: true }).error, 'bad regex is reported, not thrown');
  assert.equal(findAll('abc', 'x*', { regex: true }).matches.length, 0, 'empty matches are skipped');
  assert.equal(findAll('', 'a').matches.length, 0);
  assert.deepEqual(replaceAll('a.b.c', '.', '-'), { text: 'a-b-c', count: 2, truncated: false });
  assert.equal(replaceAll('k1=v1 k2=v2', '(\\w)(\\d)', '$2$1', { regex: true }).text, '1k=1v 2k=2v', 'capture groups');
  assert.equal(replaceAll('a$1', 'a', '$&$&').text, '$&$&$1', 'plain replacement is literal');
  const m = findAll('foo bar foo', 'foo').matches[1];
  assert.deepEqual(replaceOne('foo bar foo', m, 'foo', 'X'), { text: 'foo bar X', caret: 9 });
});

// ---------------------------------------------------------------- editing helpers
test('editing: enter keeps indentation, indents after an opener, splits a pair', () => {
  const { enter } = JSS.editing;
  assert.deepEqual(enter('  x', 3, 3), { text: '  x\n  ', caret: 6 });
  assert.deepEqual(enter('{', 1, 1), { text: '{\n  ', caret: 4 });
  assert.deepEqual(enter('{}', 1, 1), { text: '{\n  \n}', caret: 4 });
  assert.deepEqual(enter('  [1', 4, 4), { text: '  [1\n  ', caret: 7 }, 'an opener earlier on the line does not indent');
});
test('editing: tab / shift+tab', () => {
  const { tab } = JSS.editing;
  assert.deepEqual(tab('ab', 1, 1, false), { text: 'a  b', start: 3, end: 3 });
  assert.equal(tab('a\nb', 0, 3, false).text, '  a\n  b');
  assert.equal(tab('  a\n  b', 0, 7, true).text, 'a\nb');
  assert.equal(tab('a', 0, 1, true).text, 'a', 'nothing to outdent');
});
test('editing: bracket matching skips strings and works both ways', () => {
  const { matchBracket, bracketPair } = JSS.editing;
  const t = '{"a": "}", "b": [1, {"c": ")"}]}';
  assert.equal(matchBracket(t, 0), t.length - 1);
  assert.equal(matchBracket(t, t.length - 1), 0);
  assert.equal(matchBracket(t, t.indexOf('[')), t.indexOf(']'));
  assert.equal(matchBracket(t, 6), -1, 'a bracket inside a string is not a bracket');
  assert.deepEqual(bracketPair('[1]', 3), [0, 2], 'caret after the closer');
  assert.deepEqual(bracketPair('[1]', 0), [0, 2], 'caret before the opener');
  assert.equal(bracketPair('[1', 1), null, 'unbalanced');
});

// ---------------------------------------------------------------- converters
test('yaml: nesting, sequences, quoting', () => {
  const y = JSS.convert.toYaml(P('{"name":"Ann","m":1.5,"ok":true,"none":null,"tags":["a","b"],"o":{"k":"v"},"e":{},"ea":[],"yes":"yes","num":"123","colon":"a: b","multi":"l1\\nl2","list":[{"x":1,"z":[1,2]},{"x":2}]}'));
  assert.equal(y, [
    'name: Ann', 'm: 1.5', 'ok: true', 'none: null', 'tags:', '  - a', '  - b', 'o:', '  k: v', 'e: {}', 'ea: []',
    '"yes": "yes"', 'num: "123"', 'colon: "a: b"', 'multi: "l1\\nl2"', 'list:', '  - x: 1', '    z:', '      - 1', '      - 2', '  - x: 2', '',
  ].join('\n'));
  assert.equal(JSS.convert.toYaml(P('[]')), '[]\n');
  assert.equal(JSS.convert.toYaml(P('"x"')), 'x\n');
  assert.equal(JSS.convert.toYaml(P('[[1,2],[3]]')), '-\n  - 1\n  - 2\n-\n  - 3\n');
  assert.match(JSS.convert.toYaml(P('{"n":1}')), /^"n": 1/, 'YAML 1.1 treats a bare n as a boolean, so it is quoted');
});
test('csv: one row per item, nested keys flattened, quoting', () => {
  assert.equal(JSS.convert.toCsv(P('[{"a":1,"b":{"c":"x,y"}},{"a":2,"d":"q\\"r"}]')), 'a,b.c,d\n1,"x,y",\n2,,"q""r"\n');
  assert.equal(JSS.convert.toCsv(P('{"a":1,"t":[1,2]}')), 'a,t[0],t[1]\n1,1,2\n');
  assert.equal(JSS.convert.toCsv(P('[1,2]')), 'value\n1\n2\n');
});
test('typescript: interfaces, optional keys, unions, arrays', () => {
  const ts = JSS.convert.toTypeScript(P('{"id":1,"name":"a","tags":["x"],"owner":{"id":2,"email":null},"items":[{"sku":"a","qty":1},{"sku":"b"}],"mixed":[1,"a"],"empty":[]}'));
  assert.match(ts, /export interface Root \{[^}]*id: number;[^}]*tags: string\[\];[^}]*owner: Owner;[^}]*items: Items\[\];[^}]*mixed: Array<string \| number>;[^}]*empty: unknown\[\];/s);
  assert.match(ts, /export interface Owner \{\n {2}id: number;\n {2}email: null;/);
  assert.match(ts, /export interface Items \{\n {2}sku: string;\n {2}qty\?: number;/);
  assert.equal(JSS.convert.toTypeScript(P('[1,2]')), 'export type Root = number[];\n');
  assert.equal(JSS.convert.toTypeScript(P('"x"')), 'export type Root = string;\n');
});
test('json schema: inferred from a sample, validates the sample', () => {
  const doc = '{"id":1,"price":1.5,"tags":["a"],"items":[{"sku":"a","qty":1},{"sku":"b"}],"note":null}';
  const schema = JSON.parse(JSS.convert.toJsonSchema(P(doc)));
  assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
  assert.equal(schema.properties.id.type, 'integer');
  assert.equal(schema.properties.price.type, 'number');
  assert.deepEqual(schema.properties.items.items.required, ['sku'], 'keys missing from some items are optional');
  assert.deepEqual(schema.required.sort(), ['id', 'items', 'note', 'price', 'tags']);
  assert.equal(JSS.schema.validate(P(doc), schema).valid, true);
});

// ---------------------------------------------------------------- schema validation
const V = (doc, schema, o) => JSS.schema.validate(P(doc), schema, o);
const paths = (r) => r.errors.map((e) => `${JSS.ast.pathToString(e.path)}:${e.keyword}`);

test('validate: type, required, additionalProperties, nested paths', () => {
  const schema = { type: 'object', required: ['id', 'name'], additionalProperties: false, properties: { id: { type: 'integer' }, name: { type: 'string', minLength: 2 }, tags: { type: 'array', items: { type: 'string' }, uniqueItems: true } } };
  assert.equal(V('{"id":1,"name":"ab","tags":["x"]}', schema).valid, true);
  const r = V('{"id":1.5,"tags":["x",2,"x"],"extra":1}', schema);
  assert.deepEqual(paths(r).sort(), ['(root):required', 'extra:additionalProperties', 'id:type', 'tags[2]:uniqueItems', 'tags[1]:type'].sort());
  assert.equal(V('[]', schema).errors[0].keyword, 'type');
});
test('validate: numbers, strings, enum/const, formats', () => {
  assert.deepEqual(paths(V('5', { minimum: 6 })), ['(root):minimum']);
  assert.deepEqual(paths(V('6', { exclusiveMinimum: 6 })), ['(root):exclusiveMinimum']);
  assert.deepEqual(paths(V('7', { multipleOf: 2 })), ['(root):multipleOf']);
  assert.equal(V('0.3', { multipleOf: 0.1 }).valid, true, 'float tolerance');
  assert.deepEqual(paths(V('"abc"', { pattern: '^\\d+$' })), ['(root):pattern']);
  assert.deepEqual(paths(V('"c"', { enum: ['a', 'b'] })), ['(root):enum']);
  assert.equal(V('{"a":[1,2]}', { const: { a: [1, 2] } }).valid, true);
  assert.equal(V('{"a":[1,3]}', { const: { a: [1, 2] } }).valid, false);
  assert.deepEqual(paths(V('"nope"', { format: 'email' })), ['(root):format']);
  assert.equal(V('"a@b.co"', { format: 'email' }).valid, true);
  assert.equal(V('12345678901234567890', { type: 'integer' }).valid, true, 'big integers in the data are fine');
});
test('validate: combinators, if/then/else, $ref, contains, tuples', () => {
  assert.equal(V('1', { anyOf: [{ type: 'string' }, { type: 'integer' }] }).valid, true);
  assert.deepEqual(paths(V('true', { anyOf: [{ type: 'string' }, { type: 'integer' }] })), ['(root):anyOf']);
  assert.deepEqual(paths(V('5', { oneOf: [{ type: 'integer' }, { minimum: 0 }] })), ['(root):oneOf']);
  assert.deepEqual(paths(V('5', { not: { type: 'integer' } })), ['(root):not']);
  assert.deepEqual(paths(V('{"k":"a"}', { if: { properties: { k: { const: 'a' } } }, then: { required: ['z'] } })), ['(root):required']);
  const refSchema = { $defs: { pos: { type: 'integer', minimum: 1 } }, type: 'object', properties: { a: { $ref: '#/$defs/pos' }, b: { $ref: '#/$defs/pos' } } };
  assert.deepEqual(paths(V('{"a":1,"b":0}', refSchema)), ['b:minimum']);
  assert.deepEqual(paths(V('1', { $ref: '#/nope' })), ['(root):$ref']);
  assert.deepEqual(paths(V('[1,2]', { contains: { const: 3 } })), ['(root):contains']);
  assert.deepEqual(paths(V('[1,"a",true]', { prefixItems: [{ type: 'integer' }, { type: 'integer' }], items: { type: 'boolean' } })), ['[1]:type']);
  assert.equal(V('[1]', { type: 'array', minItems: 2 }).valid, false);
});
test('validate: unknown keywords are reported as ignored; errors are capped; circular $ref is bounded', () => {
  const r = V('"h"', { type: 'string', dependentRequired: {}, format: 'hostname' });
  assert.deepEqual(r.ignored, ['dependentRequired', 'format:hostname']);
  const many = V(JSON.stringify(Array.from({ length: 600 }, () => 'x')), { items: { type: 'integer' } });
  assert.equal(many.errors.length, 500);
  assert.equal(many.truncated, true);
  const circ = V('1', { $ref: '#' });
  assert.equal(circ.valid, false);
  assert.match(circ.errors[0].message, /too deep/);
});

test('wrapRows: visual rows per logical line for soft wrap (monospace, hard break at the column, tab stops)', () => {
  const { wrapRows } = JSS.editing;
  assert.deepEqual(wrapRows('a\n\nbbbb', 10), [1, 1, 1]);
  assert.deepEqual(wrapRows('x'.repeat(10), 10), [1], 'exactly one row when it fits');
  assert.deepEqual(wrapRows('x'.repeat(11), 10), [2]);
  assert.deepEqual(wrapRows(`${'x'.repeat(25)}\nshort\n${'y'.repeat(20)}`, 10), [3, 1, 2]);
  assert.deepEqual(wrapRows('\t\tx', 3, 2), [2], 'tabs advance to tab stops: 2 + 2 + 1 = 5 columns');
  assert.deepEqual(wrapRows('abc\tx', 100, 2), [1]);
  assert.deepEqual(wrapRows('', 10), [1]);
  assert.deepEqual(wrapRows('abc', 0), [1], 'an unmeasurable width never produces zero or infinite rows');
});

test('editing: bracket matching can ignore quotes (prose: an apostrophe is not a string)', () => {
  const { matchBracket, bracketPair } = JSS.editing;
  const prose = "it's (see [the docs]) and don't";
  assert.equal(matchBracket(prose, prose.indexOf('(')), -1, "with string awareness the two apostrophes hide the brackets, as intended for JSON");
  assert.equal(matchBracket(prose, prose.indexOf('('), { strings: false }), prose.indexOf(')'));
  assert.deepEqual(bracketPair(prose, prose.indexOf('[') + 1, { strings: false }), [prose.indexOf('['), prose.indexOf(']')]);
  assert.equal(matchBracket('{"a": "}"}', 0), 9, 'default behaviour is unchanged for JSON');
});
