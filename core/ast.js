/* JSON Studio core: AST model, number canonicalisation, path helpers, logging.
 *
 * The AST (not native JS values) is the internal model so that nothing is lost:
 * key order, duplicate keys, exact number text (big ints / decimals) and source tags
 * (tuple, set, bytes, ...) all survive parsing, editing, diffing and re-serialising.
 *
 *   {t:'obj', entries:[{key, value, keyType?, keyRaw?}], tag?}
 *   {t:'arr', items:[...], tag?}
 *   {t:'str', v, tag?}   {t:'num', raw, tag?}   {t:'bool', v}   {t:'null', tag?}
 */
(function (root) {
  'use strict';
  const JSS = (root.JSS = root.JSS || {});

  // ------------------------------------------------------------------ logging
  // Only metadata is ever logged (sizes, formats, positions), never document content.
  const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
  let level = LEVELS.info;
  function setLogLevel(name) { if (name in LEVELS) level = LEVELS[name]; }
  function log(lvl, event, ctx) {
    if (LEVELS[lvl] < level) return;
    const c = root.console || console;
    c[lvl === 'debug' ? 'log' : lvl](`[json-studio] ${event}`, ctx || {});
  }

  // ------------------------------------------------------------------ constructors
  function withTag(n, tag) { if (tag) n.tag = tag; return n; }
  const N = {
    obj: (entries, tag) => withTag({ t: 'obj', entries }, tag),
    arr: (items, tag) => withTag({ t: 'arr', items }, tag),
    str: (v, tag) => withTag({ t: 'str', v }, tag),
    num: (raw, tag) => withTag({ t: 'num', raw }, tag),
    bool: (v) => ({ t: 'bool', v }),
    nul: (tag) => withTag({ t: 'null' }, tag),
  };

  const isContainer = (n) => n.t === 'obj' || n.t === 'arr';
  const isSpecialNum = (raw) => /^-?(Infinity|NaN)$/.test(raw);

  /** Canonical decimal form used for exact equality: '1.50' == '1.5' == '15e-1'. Never loses digits. */
  function numKey(raw) {
    if (isSpecialNum(raw)) return raw;
    const m = /^(-?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(raw);
    if (!m) return raw;
    const int = m[2] || '0';
    const frac = m[3] || '';
    const exp = parseInt(m[4] || '0', 10);
    let digits = int + frac;
    let point = int.length + exp;
    const lead = /^0*/.exec(digits)[0].length;
    digits = digits.slice(lead);
    point -= lead;
    digits = digits.replace(/0+$/, '');
    if (!digits) return '0';
    return `${m[1]}${digits}e${point - digits.length}`;
  }

  /** JS primitive for a primitive node (precision may be lost for numbers; use numKey for exactness). */
  function valueOf(n) {
    switch (n.t) {
      case 'str': return n.v;
      case 'bool': return n.v;
      case 'null': return null;
      case 'num': return Number(n.raw);
      default: return undefined;
    }
  }

  // ------------------------------------------------------------------ paths
  const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
  /** a.b[0]["odd key"]  (opts.root => prefix "$" for JSONPath style) */
  function pathToString(path, opts) {
    let s = opts && opts.root ? '$' : '';
    for (const seg of path) {
      if (typeof seg === 'number') s += `[${seg}]`;
      else if (IDENT_RE.test(seg)) s += s ? `.${seg}` : seg;
      else s += `[${JSON.stringify(seg)}]`;
    }
    return s || (opts && opts.root ? '$' : '(root)');
  }
  const pathKey = (path) => JSON.stringify(path);

  function children(n) {
    if (n.t === 'obj') return n.entries.map((e) => [e.key, e.value]);
    if (n.t === 'arr') return n.items.map((v, i) => [i, v]);
    return [];
  }

  function getAt(n, path) {
    let cur = n;
    for (const seg of path) {
      if (!cur) return undefined;
      if (cur.t === 'obj') { const e = cur.entries.find((x) => x.key === seg); cur = e && e.value; }
      else if (cur.t === 'arr') cur = cur.items[seg];
      else return undefined;
    }
    return cur;
  }

  function walk(n, fn, path) {
    path = path || [];
    if (fn(n, path) === false) return;
    if (n.t === 'obj') for (const e of n.entries) walk(e.value, fn, path.concat(e.key));
    else if (n.t === 'arr') n.items.forEach((v, i) => walk(v, fn, path.concat(i)));
  }

  function clone(n) {
    const c = Object.assign({}, n);
    if (n.t === 'obj') c.entries = n.entries.map((e) => Object.assign({}, e, { value: clone(e.value) }));
    else if (n.t === 'arr') c.items = n.items.map(clone);
    return c;
  }

  function countNodes(n) {
    let c = 0;
    walk(n, () => { c++; });
    return c;
  }

  function describe(n) {
    if (n.t === 'obj') return `{${n.entries.length}}`;
    if (n.t === 'arr') return `[${n.items.length}]`;
    return '';
  }

  JSS.ast = { N, isContainer, isSpecialNum, numKey, valueOf, pathToString, pathKey, children, getAt, walk, clone, countNodes, describe, IDENT_RE };
  JSS.log = log;
  JSS.setLogLevel = setLogLevel;
  if (typeof module !== 'undefined' && module.exports) module.exports = JSS;
})(typeof self !== 'undefined' ? self : globalThis);
