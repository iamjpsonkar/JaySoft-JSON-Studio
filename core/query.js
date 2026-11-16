/* JSON Studio core: JSONPath subset evaluated directly on the AST (no eval).
 *
 * Supported: $  .name  ..name  .*  [*]  ['a','b']  [0]  [-1]  [0,2]  [1:3]  [::2]
 *            [?(@.price < 10 && @.tag == 'x')]  with == != < <= > >= && || ! ( ) and @.a.b / @['a'][0]
 */
(function (root) {
  'use strict';
  const JSS = root.JSS;
  const { children, valueOf } = JSS.ast;

  const MAX_RESULTS = 10000;

  // ------------------------------------------------------------------ filter expressions
  const TOKEN = /\s*(&&|\|\||==|!=|<=|>=|<|>|!|\(|\)|@|\.[A-Za-z_$][\w$]*|\[(?:'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|-?\d+)\]|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|true|false|null)/y;

  function tokenize(src) {
    const out = [];
    TOKEN.lastIndex = 0;
    let pos = 0;
    while (pos < src.length) {
      if (/^\s*$/.test(src.slice(pos))) break;
      TOKEN.lastIndex = pos;
      const m = TOKEN.exec(src);
      if (!m) throw new Error(`Unexpected character in filter at "${src.slice(pos, pos + 12).trim()}"`);
      out.push(m[1]);
      pos = TOKEN.lastIndex;
    }
    return out;
  }

  const unq = (t) => t.slice(1, -1).replace(/\\(.)/g, '$1');

  function parseFilter(src) {
    const toks = tokenize(src);
    let i = 0;
    const peek = () => toks[i];
    const take = () => toks[i++];

    function parseOperand() {
      const t = take();
      if (t === undefined) throw new Error('Incomplete filter expression');
      if (t === '(') { const e = parseOr(); if (take() !== ')') throw new Error('Missing ) in filter'); return e; }
      if (t === '@') {
        const parts = [];
        while (peek() !== undefined && (peek()[0] === '.' || peek()[0] === '[')) {
          const p = take();
          if (p[0] === '.') parts.push(p.slice(1));
          else if (/^\[-?\d+\]$/.test(p)) parts.push(parseInt(p.slice(1, -1), 10));
          else parts.push(unq(p.slice(1, -1)));
        }
        return { type: 'path', parts };
      }
      if (t === 'true') return { type: 'lit', v: true };
      if (t === 'false') return { type: 'lit', v: false };
      if (t === 'null') return { type: 'lit', v: null };
      if (t[0] === "'" || t[0] === '"') return { type: 'lit', v: unq(t) };
      if (/^-?\d/.test(t)) return { type: 'lit', v: Number(t) };
      throw new Error(`Unexpected "${t}" in filter`);
    }
    function parseNot() {
      if (peek() === '!') { take(); return { type: 'not', e: parseNot() }; }
      return parseCmp();
    }
    function parseCmp() {
      const l = parseOperand();
      const op = peek();
      if (['==', '!=', '<', '<=', '>', '>='].includes(op)) { take(); return { type: 'cmp', op, l, r: parseOperand() }; }
      return l;
    }
    function parseAnd() {
      let l = parseNot();
      while (peek() === '&&') { take(); l = { type: 'and', l, r: parseNot() }; }
      return l;
    }
    function parseOr() {
      let l = parseAnd();
      while (peek() === '||') { take(); l = { type: 'or', l, r: parseAnd() }; }
      return l;
    }
    const e = parseOr();
    if (i < toks.length) throw new Error(`Unexpected "${toks[i]}" in filter`);
    return e;
  }

  const MISSING = undefined;
  function evalExpr(e, node) {
    switch (e.type) {
      case 'lit': return e.v;
      case 'path': {
        let cur = node;
        for (const p of e.parts) {
          if (!cur) return MISSING;
          if (cur.t === 'obj' && typeof p === 'string') { const en = cur.entries.find((x) => x.key === p); cur = en && en.value; }
          else if (cur.t === 'arr' && typeof p === 'number') cur = cur.items[p < 0 ? cur.items.length + p : p];
          else return MISSING;
        }
        if (!cur) return MISSING;
        return cur.t === 'obj' || cur.t === 'arr' ? { container: true } : valueOf(cur);
      }
      case 'not': return !truthy(evalExpr(e.e, node), e.e);
      case 'and': return truthy(evalExpr(e.l, node), e.l) && truthy(evalExpr(e.r, node), e.r);
      case 'or': return truthy(evalExpr(e.l, node), e.l) || truthy(evalExpr(e.r, node), e.r);
      case 'cmp': {
        const a = evalExpr(e.l, node), b = evalExpr(e.r, node);
        if (a === MISSING || b === MISSING || (a && a.container) || (b && b.container)) return e.op === '!=';
        switch (e.op) {
          case '==': return a === b;
          case '!=': return a !== b;
          default: {
            if (typeof a !== typeof b || (typeof a !== 'number' && typeof a !== 'string')) return false;
            if (e.op === '<') return a < b;
            if (e.op === '<=') return a <= b;
            if (e.op === '>') return a > b;
            return a >= b;
          }
        }
      }
      default: return false;
    }
  }
  // A bare path is an existence test; everything else uses JS truthiness of the boolean result.
  const truthy = (v, e) => (e && e.type === 'path' ? v !== MISSING : !!v);

  // ------------------------------------------------------------------ path parsing
  function splitTopLevel(s) {
    const out = [];
    let cur = '', q = null;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (q) { cur += c; if (c === '\\') { cur += s[++i] || ''; } else if (c === q) q = null; continue; }
      if (c === "'" || c === '"') { q = c; cur += c; } else if (c === ',') { out.push(cur.trim()); cur = ''; } else cur += c;
    }
    out.push(cur.trim());
    return out;
  }

  function parseBracket(inner) {
    const c = inner.trim();
    if (c === '*') return { type: 'wild' };
    if (c[0] === '?') {
      let ex = c.slice(1).trim();
      if (ex[0] === '(' && ex[ex.length - 1] === ')') ex = ex.slice(1, -1);
      return { type: 'filter', expr: parseFilter(ex) };
    }
    const sl = /^(-?\d*):(-?\d*)(?::(-?\d*))?$/.exec(c);
    if (sl) {
      const n = (x) => (x === undefined || x === '' ? null : parseInt(x, 10));
      return { type: 'slice', start: n(sl[1]), end: n(sl[2]), step: n(sl[3]) };
    }
    const items = splitTopLevel(c).map((p) => {
      if (/^-?\d+$/.test(p)) return { index: parseInt(p, 10) };
      if ((p[0] === "'" || p[0] === '"') && p[p.length - 1] === p[0] && p.length >= 2) return { name: unq(p) };
      throw new Error(`Cannot understand [${p}]`);
    });
    return { type: 'union', items };
  }

  function parsePath(src) {
    const s = src.trim();
    if (s[0] !== '$') throw new Error('A JSONPath must start with $');
    const steps = [];
    let i = 1;
    while (i < s.length) {
      let rec = false;
      if (s.startsWith('..', i)) { rec = true; i += 2; }
      else if (s[i] === '.') i++;
      else if (s[i] !== '[') throw new Error(`Unexpected "${s[i]}" at position ${i + 1}`);
      let sel;
      if (s[i] === '[') {
        let depth = 0, q = null, j = i;
        for (; j < s.length; j++) {
          const ch = s[j];
          if (q) { if (ch === '\\') j++; else if (ch === q) q = null; continue; }
          if (ch === "'" || ch === '"') q = ch;
          else if (ch === '[') depth++;
          else if (ch === ']') { depth--; if (depth === 0) break; }
        }
        if (j >= s.length) throw new Error('Missing ] in path');
        sel = parseBracket(s.slice(i + 1, j));
        i = j + 1;
      } else if (s[i] === '*') { sel = { type: 'wild' }; i++; }
      else {
        const m = /^[^.[\s]+/.exec(s.slice(i));
        if (!m) throw new Error(`Expected a name at position ${i + 1}`);
        sel = { type: 'union', items: [{ name: m[0] }] };
        i += m[0].length;
      }
      steps.push({ rec, sel });
    }
    return steps;
  }

  // ------------------------------------------------------------------ evaluation
  function applySel(sel, node, path, out) {
    switch (sel.type) {
      case 'wild':
        for (const [k, v] of children(node)) out.push([v, path.concat(k)]);
        return;
      case 'union':
        for (const it of sel.items) {
          if ('name' in it) {
            if (node.t === 'obj') for (const e of node.entries) if (e.key === it.name) out.push([e.value, path.concat(e.key)]);
          } else if (node.t === 'arr') {
            const idx = it.index < 0 ? node.items.length + it.index : it.index;
            if (idx >= 0 && idx < node.items.length) out.push([node.items[idx], path.concat(idx)]);
          } else if (node.t === 'obj' && node.entries[it.index]) { /* numeric index on objects: not supported */ }
        }
        return;
      case 'slice': {
        if (node.t !== 'arr') return;
        const len = node.items.length;
        const step = sel.step || 1;
        if (step === 0) return;
        const norm = (x, d) => (x === null ? d : x < 0 ? Math.max(len + x, 0) : Math.min(x, len));
        if (step > 0) for (let i = norm(sel.start, 0); i < norm(sel.end, len); i += step) out.push([node.items[i], path.concat(i)]);
        else for (let i = sel.start === null ? len - 1 : norm(sel.start, 0); i > (sel.end === null ? -1 : norm(sel.end, 0)); i += step) out.push([node.items[i], path.concat(i)]);
        return;
      }
      case 'filter':
        for (const [k, v] of children(node)) if (truthy(evalExpr(sel.expr, v), sel.expr)) out.push([v, path.concat(k)]);
        return;
      default:
    }
  }

  function descendants(node, path, out) {
    out.push([node, path]);
    for (const [k, v] of children(node)) descendants(v, path.concat(k), out);
  }

  /** query(rootNode, '$.a[?(@.x>1)].b') -> {results:[{path,node}], truncated, error?} */
  function query(rootNode, src) {
    let steps;
    try { steps = parsePath(src); } catch (e) { return { results: [], error: e.message }; }
    let cur = [[rootNode, []]];
    try {
      for (const step of steps) {
        const next = [];
        for (const [n, p] of cur) {
          if (step.rec) {
            const all = [];
            descendants(n, p, all);
            for (const [dn, dp] of all) applySel(step.sel, dn, dp, next);
          } else applySel(step.sel, n, p, next);
          if (next.length > MAX_RESULTS * 5) break;
        }
        cur = next;
      }
    } catch (e) { return { results: [], error: e.message }; }
    const truncated = cur.length > MAX_RESULTS;
    return { results: cur.slice(0, MAX_RESULTS).map(([node, path]) => ({ node, path })), truncated };
  }

  JSS.query = { query, parsePath };
  if (typeof module !== 'undefined' && module.exports) module.exports = JSS;
})(typeof self !== 'undefined' ? self : globalThis);
