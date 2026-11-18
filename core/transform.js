/* JSON Studio core: document transforms. Each takes an AST (the caller passes a clone) and returns
 * {node, changes, note?} or {error}. `changes` is 0 when nothing would change, so callers can say so
 * instead of rewriting the text. Arrays tagged `tuple` (Python) are positional and are never reordered or thinned.
 */
(function (root) {
  'use strict';
  const JSS = root.JSS;
  const { N, children, pathToString } = JSS.ast;
  const isC = (n) => n.t === 'obj' || n.t === 'arr';
  const movable = (n) => n.t === 'arr' && n.tag !== 'tuple';
  const plural = (n, w) => `${n.toLocaleString()} ${w}${n === 1 ? '' : 's'}`;
  const collator = (o) => new Intl.Collator(undefined, { numeric: o.natural !== false, sensitivity: o.caseInsensitive ? 'base' : 'variant' });

  // ------------------------------------------------------------------ paths: a.b[0]["odd key"]  (the format pathToString writes)
  const RE_IDENT = /[^.[\]]+/y, RE_IDX = /\[(\d+)\]/y, RE_STR = /\[("(?:\\.|[^"\\])*")\]/y;
  /** -> array of keys / indexes, or null when the text is not a valid path. */
  function parsePath(s) {
    const out = [];
    let i = 0;
    while (i < s.length) {
      if (s[i] === '.') { i++; continue; }
      let m;
      RE_STR.lastIndex = i; RE_IDX.lastIndex = i; RE_IDENT.lastIndex = i;
      if (s[i] === '[') {
        if ((m = RE_STR.exec(s))) { try { out.push(JSON.parse(m[1])); } catch { return null; } } else if ((m = RE_IDX.exec(s))) out.push(Number(m[1])); else return null;
      } else if ((m = RE_IDENT.exec(s))) out.push(m[0]); else return null;
      i = (m.index) + m[0].length;
    }
    return out;
  }
  function getPath(n, path) {
    let cur = n;
    for (const seg of path) {
      if (!cur) return undefined;
      if (cur.t === 'obj') { const e = cur.entries.find((x) => x.key === seg || String(x.key) === String(seg)); cur = e && e.value; }
      else if (cur.t === 'arr' && typeof seg === 'number') cur = cur.items[seg];
      else return undefined;
    }
    return cur;
  }

  // ------------------------------------------------------------------ ordering
  const rankOf = (n) => (n.t === 'num' ? 0 : n.t === 'str' ? 1 : n.t === 'bool' ? 2 : n.t === 'null' ? 3 : 4);
  const valueOf = (n) => (n.t === 'num' ? Number(n.raw) : n.t === 'str' ? n.v : n.t === 'bool' ? (n.v ? 1 : 0) : 0);
  /** numbers < strings < booleans < null < containers; numbers numerically, strings with natural ("a2" < "a10") collation */
  function compareNodes(a, b, coll) {
    const ra = rankOf(a), rb = rankOf(b);
    if (ra !== rb) return ra - rb;
    const va = valueOf(a), vb = valueOf(b);
    if (ra === 1) return coll.compare(va, vb);
    return va < vb ? -1 : va > vb ? 1 : 0;
  }

  /** Sort object keys. opts: {order:'asc'|'desc', deep:true, natural:true, caseInsensitive:false} */
  function sortKeys(node, opts) {
    const o = Object.assign({ order: 'asc', deep: true }, opts);
    const coll = collator(o), dir = o.order === 'desc' ? -1 : 1;
    let changed = 0;
    (function visit(n, depth) {
      if (!o.deep && depth > 0) return;
      if (n.t === 'obj') {
        const before = n.entries.map((e) => String(e.key));
        n.entries = n.entries.map((e, i) => [e, i]).sort((x, y) => dir * coll.compare(String(x[0].key), String(y[0].key)) || x[1] - y[1]).map((x) => x[0]);
        if (n.entries.some((e, i) => String(e.key) !== before[i])) changed++;
      }
      for (const [, v] of children(n)) visit(v, depth + 1);
    })(node, 0);
    return { node, changes: changed, note: changed ? `reordered the keys of ${plural(changed, 'object')}` : 'keys are already in that order' };
  }

  /**
   * Sort arrays. opts: {by:'field.path' | '' (the values themselves), order, deep:true (every array) | false (only the top-level one), natural}
   * With `by`, items that lack the field go last (in either order). Without it, only arrays of plain values are sorted.
   */
  function sortArrays(node, opts) {
    const o = Object.assign({ by: '', order: 'asc', deep: true }, opts);
    const coll = collator(o), dir = o.order === 'desc' ? -1 : 1;
    const by = String(o.by || '').trim();
    const path = by ? parsePath(by.replace(/^\$\.?/, '')) : null;
    if (by && (!path || !path.length)) return { error: `"${by}" is not a valid field path. Use names like price, owner.name or items[0].id.` };
    let changed = 0;
    const sortOne = (arr) => {
      const present = [], rest = [];
      arr.items.forEach((v, i) => {
        if (path) { const f = isC(v) ? getPath(v, path) : undefined; (f === undefined ? rest : present).push({ v, i, f }); }
        else (isC(v) ? rest : present).push({ v, i, f: v });
      });
      present.sort((x, y) => dir * compareNodes(x.f, y.f, coll) || x.i - y.i);
      const next = present.concat(rest).map((x) => x.v);
      if (next.some((v, i) => v !== arr.items[i])) { arr.items = next; changed++; }
    };
    (function visit(n, depth) {
      if (!o.deep && depth > 0) return;
      if (movable(n)) sortOne(n);
      for (const [, v] of children(n)) visit(v, depth + 1);
    })(node, 0);
    if (!o.deep && node.t !== 'arr') return { node, changes: 0, note: 'the top level is not an array (choose "every array" to sort nested ones)' };
    return { node, changes: changed, note: changed ? `sorted ${plural(changed, 'array')}${by ? ` by ${by}` : ''}` : 'arrays are already in that order' };
  }

  /** Remove nulls, empty strings and empty objects / arrays (deeply; a container emptied by this is removed too). */
  function removeEmpty(node, opts) {
    const o = Object.assign({ nulls: true, strings: true, containers: true }, opts);
    let removed = 0;
    const empty = (n) => (o.nulls && n.t === 'null') || (o.strings && n.t === 'str' && n.v === '') || (o.containers && ((n.t === 'obj' && !n.entries.length) || (n.t === 'arr' && !n.items.length)));
    (function visit(n) {
      for (const [, v] of children(n)) visit(v);
      if (n.t === 'obj') n.entries = n.entries.filter((e) => { if (empty(e.value)) { removed++; return false; } return true; });
      else if (movable(n)) n.items = n.items.filter((v) => { if (empty(v)) { removed++; return false; } return true; });
    })(node);
    return { node, changes: removed, note: removed ? `removed ${plural(removed, 'empty value')}` : 'no nulls or empty values found' };
  }

  function nodeEq(a, b) {
    if (a.t !== b.t) return false;
    if (a.t === 'null') return true;
    if (a.t === 'bool' || a.t === 'str') return a.v === b.v;
    if (a.t === 'num') return JSS.ast.numKey(a.raw) === JSS.ast.numKey(b.raw);
    if (a.t === 'arr') return a.items.length === b.items.length && a.items.every((x, i) => nodeEq(x, b.items[i]));
    return a.entries.length === b.entries.length && a.entries.every((e) => { const m = b.entries.find((x) => x.key === e.key); return m && nodeEq(e.value, m.value); });
  }
  /** Remove repeated items from arrays (deep equality, key order inside objects ignored); the first of each is kept. */
  function dedupe(node) {
    let removed = 0;
    (function visit(n) {
      for (const [, v] of children(n)) visit(v);
      if (movable(n)) {
        const kept = [];
        for (const v of n.items) { if (kept.some((k) => nodeEq(k, v))) removed++; else kept.push(v); }
        n.items = kept;
      }
    })(node);
    return { node, changes: removed, note: removed ? `removed ${plural(removed, 'duplicate item')}` : 'no duplicate items found' };
  }

  /** {"a": {"b": [1]}} -> {"a.b[0]": 1}. Keys use the same path syntax as the tree's "path" button. */
  function flatten(node) {
    if (!isC(node)) return { node, changes: 0, note: 'nothing to flatten: the document is a single value' };
    const entries = [];
    (function visit(n, path) {
      if (isC(n) && children(n).length) { for (const [k, v] of children(n)) visit(v, path.concat(k)); return; }
      entries.push({ key: pathToString(path), value: n });
    })(node, []);
    return { node: N.obj(entries), changes: entries.length, note: `${plural(entries.length, 'key')} at one level` };
  }

  /** The reverse of flatten: {"a.b[0]": 1} -> {"a": {"b": [1]}}. Keys that cannot be nested without a clash are reported. */
  function unflatten(node) {
    if (node.t !== 'obj') return { node, changes: 0, note: 'unflatten needs an object at the top level' };
    const mk = (kind) => ({ kind, kids: new Map() });
    const rootB = mk(null);
    let conflicts = 0, nested = 0;
    for (const e of node.entries) {
      const path = parsePath(String(e.key));
      const p = path && path.length ? path : [e.key];
      if (p.length > 1) nested++;
      if (rootB.kind === null) rootB.kind = typeof p[0] === 'number' ? 'arr' : 'obj';
      let cur = rootB, ok = true;
      for (let i = 0; i < p.length && ok; i++) {
        const seg = p[i], last = i === p.length - 1;
        if ((typeof seg === 'number') !== (cur.kind === 'arr')) { ok = false; break; }
        const have = cur.kids.get(seg);
        if (last) { if (have) ok = false; else cur.kids.set(seg, { leaf: e.value }); } else {
          const want = typeof p[i + 1] === 'number' ? 'arr' : 'obj';
          if (!have) { const b = mk(want); cur.kids.set(seg, b); cur = b; } else if (have.leaf || have.kind !== want) ok = false; else cur = have;
        }
      }
      if (!ok) conflicts++;
    }
    if (!nested) return { node, changes: 0, note: 'no nested keys found (keys like a.b or a[0])' };
    let gaps = 0;
    const build = (b) => {
      if (b.leaf) return b.leaf;
      if (b.kind === 'arr') {
        const max = Math.max(-1, ...b.kids.keys());
        const items = [];
        for (let i = 0; i <= max; i++) { if (b.kids.has(i)) items.push(build(b.kids.get(i))); else { gaps++; items.push(N.nul()); } }
        return N.arr(items);
      }
      return N.obj([...b.kids].map(([k, v]) => ({ key: k, value: build(v) })));
    };
    const out = build(rootB);
    const notes = [`rebuilt ${plural(nested, 'nested key')}`];
    if (conflicts) notes.push(`${plural(conflicts, 'key')} skipped because they clash with another key`);
    if (gaps) notes.push(`${plural(gaps, 'missing array position')} filled with null`);
    return { node: out, changes: nested, note: notes.join('; ') };
  }

  /** The document becomes one JSON string (minified JSON text inside quotes), ready to embed in another document. */
  function stringify(node) {
    return { node: N.str(JSS.fmt.serialize(node, { style: 'json', indent: 0, nonFinite: 'null' }).text), changes: 1, note: 'the document is now a JSON string' };
  }
  /** The reverse: a document that is one string holding JSON becomes that JSON. */
  function unescape(node) {
    if (node.t !== 'str') return { error: 'The document must be a single JSON string (for example "{\\"a\\":1}") to be parsed.' };
    const p = JSS.parser.tryParse(node.v.trim());
    if (!p.ok) return { error: `The string does not contain valid JSON (${p.error.message}).` };
    return { node: p.node, changes: 1, note: 'the string was parsed' };
  }

  JSS.transform = { sortKeys, sortArrays, removeEmpty, dedupe, flatten, unflatten, stringify, unescape, parsePath, getPath, compareNodes };
  if (typeof module !== 'undefined' && module.exports) module.exports = JSS;
})(typeof self !== 'undefined' ? self : globalThis);
