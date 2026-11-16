const test = require('node:test');
const assert = require('node:assert');
const zlib = require('zlib');
const fs = require('fs');
const JSS = require('./helper');

const { load, repair, findEmbedded, expandEmbedded } = JSS.loader;
const { tryParse } = JSS.parser;
const { serialize, toJSON } = JSS.fmt;
const { numKey } = JSS.ast;

const json = (node, indent = 0) => toJSON(node, { indent });
const loaded = async (text, opts) => {
  const r = await load(text, opts);
  assert.ok(r.ok, `expected ok for ${JSON.stringify(text).slice(0, 80)}: ${r.error && r.error.message}`);
  return r;
};
const stepKinds = (r) => r.steps.map((s) => s.kind);

test('strict JSON: ok, and errors carry exact line/column', async () => {
  const ok = await loaded('{"a": [1, 2, {"b": null}]}');
  assert.equal(ok.format, 'json');
  assert.equal(ok.steps.length, 0);
  assert.equal(json(ok.node), '{"a":[1,2,{"b":null}]}');

  const bad = await load('{\n  "a": 1\n  "b": 2\n}');
  assert.equal(bad.ok, false);
  assert.equal(bad.error.line, 3);
  assert.equal(bad.error.col, 3);
  assert.match(bad.error.message, /Expected ','/);
  assert.match(bad.error.snippet, /"b": 2/);
});

test('exact numbers: big ints and decimals keep every digit', async () => {
  const r = await loaded('{"id": 12345678901234567890123, "p": 1.50, "e": 1E+3, "n": -0.0}');
  assert.equal(json(r.node), '{"id":12345678901234567890123,"p":1.50,"e":1E+3,"n":-0.0}');
  assert.equal(numKey('1.50'), numKey('1.5'));
  assert.equal(numKey('15e-1'), numKey('1.5'));
  assert.equal(numKey('0.0'), numKey('0'));
  assert.notEqual(numKey('12345678901234567890123'), numKey('12345678901234567890124'));
  // JS Number would collapse these two; the AST must not
  assert.notEqual(numKey('9007199254740993'), numKey('9007199254740992'));
});

test('duplicate keys are kept and reported', async () => {
  const r = await loaded('{"a": 1, "a": 2}');
  assert.equal(r.node.entries.length, 2);
  assert.ok(r.warnings.some((w) => w.type === 'duplicate-key'));
});

test('Python dict repr', async () => {
  const r = await loaded("{'name': 'Bob', 'ok': True, 'none': None, 'pair': (1, 2), 'one': (1,), 'tags': {'a', 'b'}, 3: 'three', (1, 2): 'tk', 'raw': r'a\\nb', 'b': b'hi'}");
  assert.equal(r.format, 'python');
  assert.ok(r.notStrict);
  const j = JSON.parse(json(r.node));
  assert.deepEqual(j.pair, [1, 2]);
  assert.deepEqual(j.one, [1]);
  assert.deepEqual(j.tags, ['a', 'b']);
  assert.equal(j['3'], 'three');
  assert.equal(j['(1, 2)'], 'tk');
  assert.equal(j.raw, 'a\\nb');
  assert.equal(j.ok, true);
  assert.equal(j.none, null);
  assert.ok(r.features.some((f) => f.name === 'python-booleans'));
});

test('Python: triple quotes, escapes, underscores, hex, nan/inf', async () => {
  const r = await loaded("{'t': '''line1\nline2''', 'e': 'tab\\there \\x41 \\u00e9 \\U0001F600', 'n': 1_000, 'h': 0xFF, 'f': float('nan')}".replace("float('nan')", 'nan'));
  const j = JSON.parse(json(r.node, 0).replace(/NaN/g, 'null'));
  assert.equal(j.t, 'line1\nline2');
  assert.equal(j.e, 'tab\there A é 😀');
  assert.equal(j.n, 1000);
  assert.equal(j.h, 255);
});

test('Python reprs: Decimal, datetime, date, UUID, OrderedDict, defaultdict, namedtuple, <object>', async () => {
  const src = "{'amt': Decimal('1.50'), 'when': datetime.datetime(2024, 1, 2, 3, 4, tzinfo=datetime.timezone.utc), 'naive': datetime.datetime(2024, 1, 2, 3, 4, 5, 6), 'd': datetime.date(2024, 1, 2), 'id': UUID('12345678-1234-5678-1234-567812345678'), 'od': OrderedDict([('a', 1), ('b', 2)]), 'dd': defaultdict(<class 'list'>, {'k': [1]}), 'nt': Point(x=1, y=2), 'obj': <Foo object at 0x7f12>, 'td': datetime.timedelta(days=1)}";
  const r = await loaded(src);
  const j = JSON.parse(json(r.node));
  assert.equal(j.amt, 1.5);
  assert.equal(json(r.node).includes('"amt":1.50'), true, 'Decimal keeps its exact digits');
  assert.equal(j.when, '2024-01-02T03:04:00+00:00');
  assert.equal(j.naive, '2024-01-02T03:04:05.000006');
  assert.equal(j.d, '2024-01-02');
  assert.equal(j.id, '12345678-1234-5678-1234-567812345678');
  assert.deepEqual(j.od, { a: 1, b: 2 });
  assert.deepEqual(j.dd, { k: [1] });
  assert.deepEqual(j.nt, { x: 1, y: 2 });
  assert.equal(j.obj, '<Foo object at 0x7f12>');
  assert.equal(j.td, 'datetime.timedelta(days=1)');
  assert.ok(r.warnings.length >= 2, 'non-literal values are reported, not silently dropped');
});

test('Python sample file: tz-aware datetime has no spurious warning, real non-literals are still reported', async () => {
  const r = await loaded(fs.readFileSync(require('path').join(__dirname, 'samples', 'python-dict.txt'), 'utf8'));
  assert.deepEqual(r.warnings.map((w) => w.type), ['non-literal']);
  const j = JSON.parse(json(r.node));
  assert.equal(j.created, '2024-01-02T03:04:05+00:00');
  assert.equal(j.meta.per_page, 50);
});

test('Python: unparseable call arguments fall back to text instead of failing the document', async () => {
  const r = await loaded("{'a': Weird(1, <x>, ???), 'b': 2}".replace('???', '@@'));
  const j = JSON.parse(json(r.node));
  assert.equal(j.b, 2);
  assert.match(j.a, /^Weird\(/);
});

test('Ruby hash, PHP array, JS object / JSON5', async () => {
  const ruby = await loaded('{a: 1, "b" => :sym, :c => nil, "d" => [1, 2.5]}');
  assert.equal(ruby.format, 'ruby');
  assert.deepEqual(JSON.parse(json(ruby.node)), { a: 1, b: 'sym', c: null, d: [1, 2.5] });

  const php = await loaded("array('a' => 1, 'b' => array(1, 2), 'c' => TRUE, 'd' => NULL)");
  assert.equal(php.format, 'php');
  assert.deepEqual(JSON.parse(json(php.node)), { a: 1, b: [1, 2], c: true, d: null });

  const phpShort = await loaded("['x' => 1, 5 => 'five', 'six']");
  assert.deepEqual(JSON.parse(json(phpShort.node)), { x: 1, 5: 'five', 6: 'six' });

  const js = await loaded("{// note\n a: 0xFF, b: .5, c: +1, d: 'x', e: [1,2,], f: undefined, /* c */ g: Infinity}");
  assert.equal(js.format, 'javascript');
  const out = serialize(js.node, { style: 'json', indent: 0, nonFinite: 'null' });
  assert.deepEqual(JSON.parse(out.text), { a: 255, b: 0.5, c: 1, d: 'x', e: [1, 2], f: null, g: null });
  assert.ok(out.warnings.length > 0);
});

test('JSON with trailing commas / comments is labelled, not mislabelled as Python', async () => {
  assert.equal((await loaded('{"a":1,}')).format, 'json-lenient');
  assert.equal((await loaded('{"a":1 /* c */}')).format, 'jsonc');
  assert.equal((await loaded('{"a":"x\ny"}')).format, 'json-lenient');
});

test('stringified JSON and multi-layer encoding', async () => {
  const obj = { a: 1, b: [1, 2], c: { d: 'x' } };
  const once = JSON.stringify(JSON.stringify(obj));
  const twice = JSON.stringify(once);
  const thrice = JSON.stringify(twice);
  for (const [text, layers] of [[once, 1], [twice, 2], [thrice, 3]]) {
    const r = await loaded(text);
    assert.deepEqual(JSON.parse(json(r.node)), obj, `layers=${layers}`);
    assert.ok(r.steps.length >= 1);
  }
  // a plain string must stay a string
  const s = await loaded('"hello world"');
  assert.equal(s.node.t, 'str');
  assert.equal(s.steps.length, 0);
  const notJson = await loaded('"[INFO] started"');
  assert.equal(notJson.node.t, 'str');
});

test('backslash-escaped copy (no outer quotes)', async () => {
  const r = await loaded('{\\"a\\": 1, \\"b\\": \\"x\\\\ny\\"}');
  assert.deepEqual(JSON.parse(json(r.node)), { a: 1, b: 'x\ny' });
  assert.ok(stepKinds(r).includes('unescape'));
});

test('JSON inside log lines, with several candidates', async () => {
  const r = await loaded('2026-11-16 12:00:01 INFO request={"id": 7, "tags": ["a"]} status=200 done');
  assert.deepEqual(JSON.parse(json(r.node)), { id: 7, tags: ['a'] });
  assert.ok(stepKinds(r).includes('extract'));

  const multi = await loaded('a={"x":1} b={"yy":2,"zz":[1,2,3]}');
  assert.equal(multi.candidates.length, 2);
  assert.deepEqual(JSON.parse(json(multi.node)), { yy: 2, zz: [1, 2, 3] }, 'longest candidate is preselected');
  const first = await loaded('a={"x":1} b={"yy":2,"zz":[1,2,3]}', { pick: 0 });
  assert.deepEqual(JSON.parse(json(first.node)), { x: 1 });
});

test('log line whose payload contains an escaped string: the payload is extracted, not a fragment', async () => {
  const line = fs.readFileSync(require('path').join(__dirname, 'samples', 'log-line.txt'), 'utf8');
  const r = await loaded(line);
  const j = JSON.parse(json(r.node).replace('12345678901234567890', '"BIG"'));
  assert.equal(j.order_id, 'BIG');
  assert.deepEqual(j.items, [{ sku: 'A1', qty: 2 }]);
  assert.equal(j.note, '{"inner": true}', 'the nested escaped string stays a string until the user expands it');
  assert.ok(json(r.node).includes('12345678901234567890'), 'exact big number kept');
  assert.ok(!stepKinds(r).includes('unescape'));
  assert.equal(r.candidates, undefined, 'a nested string is not offered as a separate candidate');
  assert.equal(expandEmbedded(r.node), 1);
  assert.deepEqual(JSON.parse(json(r.node).replace('12345678901234567890', '1')).note, { inner: true });
  // text that really is an escaped copy, even with a prefix, still works through the loose fallback
  const prefixed = await loaded('Body: {\\"a\\": [1, 2]}');
  assert.deepEqual(JSON.parse(json(prefixed.node)), { a: [1, 2] });
});

test('wrappers: JSON.parse(...), json.loads(...), curl -d', async () => {
  const a = await loaded('JSON.parse(\'{"a":1,"b":"x"}\')');
  assert.deepEqual(JSON.parse(json(a.node)), { a: 1, b: 'x' });
  assert.match(a.steps[0].desc, /parse\/loads/);

  const b = await loaded('data = json.loads("{\\"a\\": [1, 2], \\"ok\\": true}")');
  assert.deepEqual(JSON.parse(json(b.node)), { a: [1, 2], ok: true });

  const c = await loaded("curl -X POST https://x.test/api -H 'Content-Type: application/json' -d '{\"name\":\"n\",\"n\":[1]}'");
  assert.deepEqual(JSON.parse(json(c.node)), { name: 'n', n: [1] });
  assert.match(c.steps[0].desc, /curl/);
});

test('concatenated JSON and NDJSON become a list', async () => {
  const nd = await loaded('{"a":1}\n{"a":2}\n{"a":3}\n');
  assert.equal(nd.node.t, 'arr');
  assert.equal(nd.node.items.length, 3);
  assert.equal(stepKinds(nd)[0], 'documents');
  const cat = await loaded('{"a":1}{"b":2} [3]');
  assert.equal(cat.node.items.length, 3);
});

test('Base64, gzip+Base64, URL-encoded, HTML entities, JWT, query string', async () => {
  const obj = { hello: 'wörld', n: [1, 2, 3] };
  const text = JSON.stringify(obj);

  const b64 = await loaded(Buffer.from(text).toString('base64'));
  assert.deepEqual(JSON.parse(json(b64.node)), obj);
  assert.equal(stepKinds(b64)[0], 'base64');

  const b64url = await loaded(Buffer.from(text).toString('base64url'));
  assert.deepEqual(JSON.parse(json(b64url.node)), obj);

  const gz = await loaded(zlib.gzipSync(text).toString('base64'));
  assert.deepEqual(JSON.parse(json(gz.node)), obj);
  assert.equal(stepKinds(gz)[0], 'gzip');

  const url = await loaded(encodeURIComponent(text));
  assert.deepEqual(JSON.parse(json(url.node)), obj);
  assert.equal(stepKinds(url)[0], 'url');

  const html = await loaded('{&quot;a&quot;:&quot;x &amp; y&quot;,&quot;n&quot;:1}');
  assert.deepEqual(JSON.parse(json(html.node)), { a: 'x & y', n: 1 });
  assert.equal(stepKinds(html)[0], 'html');

  const header = Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url');
  const payload = Buffer.from('{"sub":"123","exp":1700000000}').toString('base64url');
  const jwt = await loaded(`${header}.${payload}.c2ln`);
  const jj = JSON.parse(json(jwt.node));
  assert.equal(jj.payload.sub, '123');
  assert.equal(jj.header.alg, 'HS256');
  assert.match(jwt.steps[0].desc, /NOT verified/);
  const bearer = await loaded(`Bearer ${header}.${payload}.c2ln`);
  assert.equal(JSON.parse(json(bearer.node)).payload.exp, 1700000000);

  const q = await loaded('?a=1&b=hello%20world&c=x+y');
  assert.deepEqual(JSON.parse(json(q.node)), { a: '1', b: 'hello world', c: 'x y' });
  assert.equal(q.format, 'query');
});

test('plain words are not mistaken for Base64 or anything else', async () => {
  for (const t of ['hello', 'abcdefghij', 'just some text', 'nope==']) {
    const r = await load(t);
    assert.equal(r.ok, false, `${t} should fail, not be decoded`);
  }
});

test('embedded JSON inside string values can be found and expanded', async () => {
  const r = await loaded(JSON.stringify({ id: 1, body: '{"a":[1,2],"deep":"{\\"z\\":true}"}', note: 'not json', arr: '[1,2]' }));
  const found = findEmbedded(r.node);
  assert.deepEqual(found.map((f) => f.path.join('.')).sort(), ['arr', 'body']);
  const n = expandEmbedded(r.node);
  assert.equal(n, 3, 'body, arr and the nested layer inside body');
  assert.deepEqual(JSON.parse(json(r.node)), { id: 1, body: { a: [1, 2], deep: { z: true } }, note: 'not json', arr: [1, 2] });
});

test('repair: truncated input and typographic quotes, never silent', async () => {
  const trunc = repair('{"a": [1, 2, {"b": "tex');
  assert.ok(trunc);
  assert.ok(tryParse(trunc.text).ok);
  assert.ok(trunc.changes.length > 0);
  assert.deepEqual(JSON.parse(trunc.text), { a: [1, 2, { b: 'tex' }] });

  const dangling = repair('{"a": 1, "b": ');
  assert.deepEqual(JSON.parse(dangling.text), { a: 1, b: null });

  const half = repair('{"a": 1, "bb');
  assert.deepEqual(JSON.parse(half.text), { a: 1 });

  const quotes = repair('{“a”: “b”}');
  assert.deepEqual(JSON.parse(quotes.text), { a: 'b' });

  assert.equal(repair('{"a": 1 "b": 2}'), null, 'does not guess at missing commas');

  const failed = await load('{"a": [1, 2');
  assert.equal(failed.ok, false);
  assert.equal(failed.repairable, true);
});

test('errors never throw; empty and huge inputs are handled', async () => {
  const empty = await load('   ');
  assert.equal(empty.ok, false);
  const big = await load('x'.repeat(100), { maxChars: 50 });
  assert.equal(big.ok, false);
  assert.match(big.error.message, /too large/);
  const deep = await load('['.repeat(2000) + ']'.repeat(2000));
  assert.equal(deep.ok, false);
  assert.match(deep.error.message, /deeper than/);
});

test('output formats: Python and JS styles round-trip', async () => {
  const src = "{'a': True, 'b': None, 'c': (1, 2), 'd': {'x', 'y'}, 'e': \"it's\", 'f': 'q\"q', 3: [1.5, -2], 'u': 'é\\n', 'bytes': b'ab'}";
  const r = await loaded(src);
  for (const style of ['python', 'js']) {
    for (const indent of [0, 2, 4, 'tab']) {
      const out = serialize(r.node, { style, indent }).text;
      const again = tryParse(out);
      assert.ok(again.ok, `${style}/${indent} must re-parse: ${again.error && again.error.message}`);
      assert.equal(json(again.node), json(r.node), `${style}/${indent} round trip`);
    }
  }
  const py = serialize(r.node, { style: 'python', indent: 0 }).text;
  assert.match(py, /'a': True/);
  assert.match(py, /'c': \(1, 2\)/);
  assert.match(py, /"it's"/);
  assert.match(py, /3: \[1\.5, -2\]/);
  assert.match(py, /b'ab'/);
  assert.equal(serialize(JSS.ast.N.arr([JSS.ast.N.num('1')], 'tuple'), { style: 'python', indent: 0 }).text, '(1,)');
  assert.equal(serialize(JSS.ast.N.arr([], 'set'), { style: 'python', indent: 0 }).text, 'set()');
});

test('sortKeys and indent options', async () => {
  const r = await loaded('{"b":1,"a":{"d":1,"c":[3,2]}}');
  assert.equal(toJSON(r.node, { indent: 0, sortKeys: true }), '{"a":{"c":[3,2],"d":1},"b":1}');
  assert.equal(toJSON(r.node, { indent: 2 }), '{\n  "b": 1,\n  "a": {\n    "d": 1,\n    "c": [\n      3,\n      2\n    ]\n  }\n}');
  assert.equal(toJSON(r.node, { indent: 'tab' }).split('\n')[1], '\t"b": 1,');
});

test('sample files in the repo load', async () => {
  const fs = require('fs');
  const dir = require('path').join(__dirname, 'samples');
  if (!fs.existsSync(dir)) return;
  for (const f of fs.readdirSync(dir)) {
    const r = await load(fs.readFileSync(require('path').join(dir, f), 'utf8'));
    assert.ok(r.ok, `${f}: ${r.error && r.error.message}`);
  }
});

test('performance: multi-MB JSON parses in a reasonable time', async () => {
  const rows = [];
  for (let i = 0; i < 60000; i++) rows.push({ id: i, name: `item-${i}`, tags: ['a', 'b', 'c'], price: i * 1.25, nested: { ok: true, n: null } });
  const text = JSON.stringify(rows);
  const r = await load(text);
  assert.ok(r.ok);
  console.log(`      perf: ${(text.length / 1048576).toFixed(1)} MB parsed in ${r.ms} ms`);
  assert.ok(r.ms < 8000, `took ${r.ms} ms`);
});
