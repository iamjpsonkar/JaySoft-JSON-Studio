/* JSON Studio core: structural compare of two ASTs.
 *
 * compare(a, b, opts) -> {root, diffs, stats, errors}
 *   root:  merged, aligned tree. Every node: {key, path, a, b, status, children?}
 *          status: same | changed | added | removed | type | ignored
 *   diffs: flat list [{kind, path, a, b}] (kind adds 'reordered' when key order is significant)
 * Numbers compare by exact canonical decimal text (numKey), never through JS floats, unless a tolerance is set.
 */
(function (root) {
  'use strict';
  const JSS = root.JSS;
  const { numKey, isSpecialNum } = JSS.ast;

  const DEFAULTS = {
    ignoreKeyOrder: true,
    arrayMode: 'index', // 'index' | 'key' | 'set'
    arrayKey: 'id',
    ignorePaths: [],
    numberTolerance: 0,
    caseInsensitive: false,
    trimStrings: false,
    missingEqualsNull: false,
  };

  // ------------------------------------------------------------------ ignore patterns
  function segMatcher(p) {
    if (p === '*') return () => true;
    if (!p.includes('*')) return (s) => s === p;
    const re = new RegExp('^' + p.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
    return (s) => re.test(s);
  }

  /** Patterns: `$.a.b[0].c`, `a.*.id`, `**.updated_at`, a bare `name` (any depth), or `/regex/` on the dotted path. */
  function compileIgnore(patterns) {
    const errors = [];
    const tests = [];
    for (const raw of patterns || []) {
      const p = String(raw).trim();
      if (!p) continue;
      const rx = /^\/(.+)\/([a-z]*)$/.exec(p);
      if (rx) {
        try { const re = new RegExp(rx[1], rx[2]); tests.push((path) => re.test(path.join('.'))); }
        catch (e) { errors.push(`Invalid regular expression ${p}: ${e.message}`); }
        continue;
      }
      let g = p.replace(/^\$\.?/, '').replace(/\[(\d+|\*)\]/g, '.$1').replace(/^\./, '');
      if (!g.includes('.') && !g.includes('*')) g = '**.' + g;
      const segs = g.split('.').map((s) => (s === '**' ? '**' : segMatcher(s)));
      const match = (pi, path, si) => {
        for (; pi < segs.length; pi++) {
          if (segs[pi] === '**') {
            if (pi === segs.length - 1) return true;
            for (let k = si; k <= path.length; k++) if (match(pi + 1, path, k)) return true;
            return false;
          }
          if (si >= path.length || !segs[pi](String(path[si]))) return false;
          si++;
        }
        return si === path.length;
      };
      tests.push((path) => match(0, path, 0));
    }
    return { test: (path) => tests.some((t) => t(path)), errors, active: tests.length > 0 };
  }

  // ------------------------------------------------------------------ compare
  function compare(a, b, userOpts) {
    const o = Object.assign({}, DEFAULTS, userOpts);
    const ig = compileIgnore(o.ignorePaths);
    const canonCache = new Map();
    const norm = (s) => { if (o.trimStrings) s = s.trim(); if (o.caseInsensitive) s = s.toLowerCase(); return s; };

    function canon(n, path) {
      const hit = canonCache.get(n);
      if (hit !== undefined) return hit;
      let r;
      switch (n.t) {
        case 'null': r = 'z'; break;
        case 'bool': r = n.v ? 't' : 'f'; break;
        case 'num': r = 'n' + numKey(n.raw); break;
        case 'str': r = 's' + JSON.stringify(norm(n.v)); break;
        case 'arr': {
          const parts = n.items.map((x, i) => canon(x, path.concat(i)));
          if (o.arrayMode !== 'index') parts.sort();
          r = '[' + parts.join(',') + ']';
          break;
        }
        default: {
          const parts = [];
          for (const e of n.entries) {
            const p2 = path.concat(e.key);
            if (ig.test(p2)) continue;
            if (o.missingEqualsNull && e.value.t === 'null') continue;
            parts.push(JSON.stringify(e.key) + ':' + canon(e.value, p2));
          }
          if (o.ignoreKeyOrder) parts.sort();
          r = '{' + parts.join(',') + '}';
        }
      }
      canonCache.set(n, r);
      return r;
    }

    function leafEqual(x, y) {
      switch (x.t) {
        case 'null': return true;
        case 'bool': return x.v === y.v;
        case 'num':
          if (isSpecialNum(x.raw) || isSpecialNum(y.raw)) return x.raw === y.raw;
          if (o.numberTolerance > 0) return Math.abs(Number(x.raw) - Number(y.raw)) <= o.numberTolerance;
          return numKey(x.raw) === numKey(y.raw);
        default: return norm(x.v) === norm(y.v);
      }
    }

    const groupByKey = (entries) => {
      const g = new Map();
      for (const e of entries) { const l = g.get(e.key); if (l) l.push(e); else g.set(e.key, [e]); }
      return g;
    };

    function keyedSig(n) {
      if (n.t !== 'obj') return null;
      const e = n.entries.find((x) => x.key === o.arrayKey);
      if (!e || e.value.t === 'obj' || e.value.t === 'arr') return null;
      return canon(e.value, []);
    }

    function idLabelOf(x) {
      const v = x.entries.find((e) => e.key === o.arrayKey).value;
      return `${o.arrayKey}=${v.t === 'str' ? v.v : v.t === 'num' ? v.raw : v.t === 'bool' ? String(v.v) : 'null'}`;
    }

    function mergeObject(m, a, b, path) {
      const ga = groupByKey(a.entries), gb = groupByKey(b.entries);
      const order = [...ga.keys(), ...[...gb.keys()].filter((k) => !ga.has(k))];
      const kids = [];
      for (const k of order) {
        const la = ga.get(k) || [], lb = gb.get(k) || [];
        for (let i = 0, n = Math.max(la.length, lb.length); i < n; i++) {
          const ea = la[i], eb = lb[i], p2 = path.concat(k);
          const av = ea && ea.value, bv = eb && eb.value;
          if (ig.test(p2)) { kids.push({ key: k, path: p2, a: av, b: bv, status: 'ignored' }); continue; }
          if (o.missingEqualsNull && ((!ea && bv.t === 'null') || (!eb && av.t === 'null'))) {
            kids.push({ key: k, path: p2, a: av, b: bv, status: 'same', note: 'missing = null' });
            continue;
          }
          kids.push(merge(av, bv, p2, k));
        }
      }
      if (!o.ignoreKeyOrder) {
        const ca = a.entries.map((e) => e.key).filter((k) => gb.has(k));
        const cb = b.entries.map((e) => e.key).filter((k) => ga.has(k));
        if (ca.join('\u0000') !== cb.join('\u0000')) m.reordered = true;
      }
      return kids;
    }

    function mergeArray(a, b, path) {
      const kids = [];
      const A = a.items, B = b.items;
      if (o.arrayMode === 'set') {
        const buckets = new Map();
        B.forEach((x, j) => { const c = canon(x, path.concat(j)); const l = buckets.get(c); if (l) l.push(j); else buckets.set(c, [j]); });
        const matchOf = new Array(A.length).fill(-1);
        const usedB = new Set();
        A.forEach((x, i) => {
          const l = buckets.get(canon(x, path.concat(i)));
          if (l && l.length) { const j = l.shift(); matchOf[i] = j; usedB.add(j); }
        });
        const leftA = [], leftB = [];
        A.forEach((_, i) => { if (matchOf[i] < 0) leftA.push(i); });
        B.forEach((_, j) => { if (!usedB.has(j)) leftB.push(j); });
        leftA.forEach((i, k) => { if (k < leftB.length) { matchOf[i] = leftB[k]; usedB.add(leftB[k]); } });
        A.forEach((x, i) => kids.push(merge(x, matchOf[i] >= 0 ? B[matchOf[i]] : null, path.concat(i), i)));
        B.forEach((x, j) => { if (!usedB.has(j)) kids.push(merge(null, x, path.concat(j), j)); });
        return kids;
      }
      if (o.arrayMode === 'key') {
        const bKeyed = new Map();
        const bKeyless = [];
        B.forEach((x, j) => {
          const s = keyedSig(x);
          if (s === null) bKeyless.push(j);
          else { const l = bKeyed.get(s); if (l) l.push(j); else bKeyed.set(s, [j]); }
        });
        const used = new Set();
        let kl = 0;
        A.forEach((x, i) => {
          const s = keyedSig(x);
          let j = -1;
          if (s !== null) { const l = bKeyed.get(s); if (l && l.length) j = l.shift(); }
          else if (kl < bKeyless.length) j = bKeyless[kl++];
          if (j >= 0) used.add(j);
          const child = merge(x, j >= 0 ? B[j] : null, path.concat(i), i);
          if (s !== null) child.idLabel = idLabelOf(x);
          kids.push(child);
        });
        B.forEach((x, j) => {
          if (used.has(j)) return;
          const child = merge(null, x, path.concat(j), j);
          if (keyedSig(x) !== null) child.idLabel = idLabelOf(x);
          kids.push(child);
        });
        return kids;
      }
      for (let i = 0, n = Math.max(A.length, B.length); i < n; i++) kids.push(merge(A[i], B[i], path.concat(i), i));
      return kids;
    }

    function merge(av, bv, path, key) {
      const m = { key, path, a: av || null, b: bv || null };
      if (av && !bv) { m.status = 'removed'; return m; }
      if (!av && bv) { m.status = 'added'; return m; }
      if (av.t !== bv.t) { m.status = 'type'; return m; }
      if (av.t === 'obj' || av.t === 'arr') {
        const kids = av.t === 'obj' ? mergeObject(m, av, bv, path) : mergeArray(av, bv, path);
        const same = !m.reordered && kids.every((c) => c.status === 'same' || c.status === 'ignored');
        if (same) { m.status = 'same'; if (kids.some((c) => c.status === 'ignored')) m.children = kids; } else { m.status = 'changed'; m.children = kids; }
        return m;
      }
      m.status = leafEqual(av, bv) ? 'same' : 'changed';
      return m;
    }

    const rootNode = merge(a, b, [], null);
    const diffs = flatten(rootNode);
    const stats = { added: 0, removed: 0, changed: 0, type: 0, reordered: 0, total: diffs.length };
    diffs.forEach((d) => { stats[d.kind]++; });
    return { root: rootNode, diffs, stats, errors: ig.errors, options: o };
  }

  function flatten(rootNode) {
    const out = [];
    (function rec(m) {
      switch (m.status) {
        case 'added': case 'removed': case 'type':
          out.push({ kind: m.status, path: m.path, a: m.a, b: m.b });
          return;
        case 'changed':
          if (m.children) {
            if (m.reordered) out.push({ kind: 'reordered', path: m.path, a: m.a, b: m.b });
            m.children.forEach(rec);
          } else out.push({ kind: 'changed', path: m.path, a: m.a, b: m.b });
          return;
        default:
      }
    })(rootNode);
    return out;
  }

  // ------------------------------------------------------------------ JSON Patch (RFC 6902)
  const pointer = (path) => path.map((s) => '/' + String(s).replace(/~/g, '~0').replace(/\//g, '~1')).join('');
  function cmpPath(x, y) {
    for (let i = 0; i < Math.min(x.length, y.length); i++) {
      if (x[i] === y[i]) continue;
      if (typeof x[i] === 'number' && typeof y[i] === 'number') return x[i] - y[i];
      return String(x[i]) < String(y[i]) ? -1 : 1;
    }
    return x.length - y.length;
  }

  /** Only meaningful for arrayMode 'index'. Values are emitted as exact JSON text (no float round-trip). */
  function toJsonPatch(diffs) {
    const val = (n) => JSS.fmt.toJSON(n, { indent: 0 });
    const op = (o, path, n) => `{"op":"${o}","path":${JSON.stringify(pointer(path))}${n ? `,"value":${val(n)}` : ''}}`;
    const replaces = diffs.filter((d) => d.kind === 'changed' || d.kind === 'type').map((d) => op('replace', d.path, d.b));
    const removes = diffs.filter((d) => d.kind === 'removed').sort((x, y) => cmpPath(y.path, x.path)).map((d) => op('remove', d.path));
    const adds = diffs.filter((d) => d.kind === 'added').sort((x, y) => cmpPath(x.path, y.path)).map((d) => op('add', d.path, d.b));
    const ops = replaces.concat(removes, adds);
    return ops.length ? `[\n  ${ops.join(',\n  ')}\n]` : '[]';
  }

  JSS.diff = { compare, compileIgnore, flatten, toJsonPatch, pointer, DEFAULTS };
  if (typeof module !== 'undefined' && module.exports) module.exports = JSS;
})(typeof self !== 'undefined' ? self : globalThis);
