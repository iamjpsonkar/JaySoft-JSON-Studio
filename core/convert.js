/* JSON Studio core: converters. AST -> YAML / CSV / TypeScript types / JSON Schema (all read-only exports).
 * Types and schema are inferred from the sample document: arrays of objects are merged into one shape,
 * keys missing from some items become optional.
 */
(function (root) {
  'use strict';
  const JSS = root.JSS;
  const { children } = JSS.ast;
  const isC = (n) => n.t === 'obj' || n.t === 'arr';
  const numOf = (n) => (n.t === 'num' ? Number(n.raw) : NaN);

  // ------------------------------------------------------------------ YAML
  const YAML_RESERVED = /^(true|false|null|yes|no|on|off|y|n|~|nan|inf|\.nan|\.inf|-\.inf)$/i;
  function yamlScalar(s) {
    if (s === '' || /^\s|\s$/.test(s) || /[\n\r\t"\\]/.test(s) || /^[-?:,[\]{}#&*!|>'"%@`]/.test(s) || /: |:$| #/.test(s) || YAML_RESERVED.test(s) || /^[-+]?(\d[\d_]*)?\.?\d+([eE][-+]?\d+)?$/.test(s) || /^0[xo]/i.test(s)) return JSON.stringify(s);
    return s;
  }
  function yamlPrim(n) {
    if (n.t === 'str') return yamlScalar(n.v);
    if (n.t === 'num') return n.raw === 'NaN' ? '.nan' : n.raw === 'Infinity' ? '.inf' : n.raw === '-Infinity' ? '-.inf' : n.raw;
    if (n.t === 'bool') return String(n.v);
    return 'null';
  }
  function yamlLines(n, indent, out) {
    const pad = ' '.repeat(indent);
    if (n.t === 'obj') {
      for (const e of n.entries) {
        const k = yamlScalar(String(e.key));
        if (isC(e.value) && children(e.value).length) {
          out.push(`${pad}${k}:`);
          yamlLines(e.value, indent + 2, out);
        } else out.push(`${pad}${k}: ${isC(e.value) ? (e.value.t === 'obj' ? '{}' : '[]') : yamlPrim(e.value)}`);
      }
    } else if (n.t === 'arr') {
      for (const v of n.items) {
        if (isC(v) && children(v).length) {
          const sub = [];
          yamlLines(v, 0, sub);
          if (v.t === 'obj') { out.push(`${pad}- ${sub[0]}`); for (const l of sub.slice(1)) out.push(`${pad}  ${l}`); }
          else { out.push(`${pad}-`); for (const l of sub) out.push(`${pad}  ${l}`); }
        } else out.push(`${pad}- ${isC(v) ? (v.t === 'obj' ? '{}' : '[]') : yamlPrim(v)}`);
      }
    }
  }
  function toYaml(node) {
    if (!isC(node) || !children(node).length) return `${isC(node) ? (node.t === 'obj' ? '{}' : '[]') : yamlPrim(node)}\n`;
    const out = [];
    yamlLines(node, 0, out);
    return `${out.join('\n')}\n`;
  }

  // ------------------------------------------------------------------ CSV
  function flatten(n, prefix, row) {
    if (n.t === 'obj' && n.entries.length) for (const e of n.entries) flatten(e.value, prefix ? `${prefix}.${e.key}` : String(e.key), row);
    else if (n.t === 'arr' && n.items.length) n.items.forEach((v, i) => flatten(v, `${prefix}[${i}]`, row));
    else row.set(prefix || 'value', n);
  }
  const csvCell = (n) => {
    if (!n) return '';
    const s = n.t === 'str' ? n.v : n.t === 'num' ? n.raw : n.t === 'bool' ? String(n.v) : n.t === 'null' ? '' : n.t === 'obj' ? '{}' : '[]';
    return /[",\r\n]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  /** An array of objects becomes one row per item; nested values are flattened to dotted / indexed column names. */
  function toCsv(node) {
    const items = node.t === 'arr' ? node.items : [node];
    const rows = items.map((it) => { const r = new Map(); flatten(it, '', r); return r; });
    const cols = [];
    const seen = new Set();
    for (const r of rows) for (const k of r.keys()) if (!seen.has(k)) { seen.add(k); cols.push(k); }
    const head = cols.map((c) => csvCell({ t: 'str', v: c })).join(',');
    return `${[head, ...rows.map((r) => cols.map((c) => csvCell(r.get(c))).join(','))].join('\n')}\n`;
  }

  // ------------------------------------------------------------------ shape inference (shared by TypeScript and JSON Schema)
  const newShape = () => ({ kinds: new Set(), obj: null, arr: null, arrSeen: false, n: 0 });
  function shapeOf(n, into) {
    const s = into || newShape();
    s.n++;
    if (n.t === 'str') s.kinds.add('string');
    else if (n.t === 'bool') s.kinds.add('boolean');
    else if (n.t === 'null') s.kinds.add('null');
    else if (n.t === 'num') s.kinds.add(Number.isInteger(numOf(n)) && !/[.eE]/.test(n.raw) ? 'integer' : 'number');
    else if (n.t === 'obj') {
      s.obj = s.obj || { count: 0, fields: new Map() };
      s.obj.count++;
      for (const e of n.entries) {
        const f = s.obj.fields.get(e.key) || { shape: newShape(), seen: 0 };
        f.seen++;
        shapeOf(e.value, f.shape);
        s.obj.fields.set(e.key, f);
      }
    } else if (n.t === 'arr') {
      s.arrSeen = true;
      s.arr = s.arr || newShape();
      for (const v of n.items) shapeOf(v, s.arr);
    }
    return s;
  }
  const hasNumber = (s) => s.kinds.has('integer') || s.kinds.has('number');

  // ------------------------------------------------------------------ TypeScript
  const pascal = (k) => String(k).replace(/(^|[^A-Za-z0-9]+)([A-Za-z0-9])/g, (_, __, c) => c.toUpperCase()).replace(/[^A-Za-z0-9]/g, '') || 'Item';
  const tsKey = (k) => (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k) ? k : JSON.stringify(k));
  function toTypeScript(node, rootName) {
    const decls = [];
    const names = new Set();
    const unique = (base) => { let nm = base, i = 2; while (names.has(nm)) nm = `${base}${i++}`; names.add(nm); return nm; };
    function typeOf(s, hint) {
      const parts = [];
      if (s.kinds.has('string')) parts.push('string');
      if (hasNumber(s)) parts.push('number');
      if (s.kinds.has('boolean')) parts.push('boolean');
      if (s.obj) parts.push(declare(s.obj, hint));
      if (s.arrSeen) {
        const inner = s.arr.n ? typeOf(s.arr, hint) : 'unknown';
        parts.push(/[|&]/.test(inner) ? `Array<${inner}>` : `${inner}[]`);
      }
      if (s.kinds.has('null')) parts.push('null');
      return parts.length ? parts.join(' | ') : 'unknown';
    }
    function declare(o, hint) {
      if (!o.fields.size) return 'Record<string, unknown>';
      const name = unique(pascal(hint));
      const idx = decls.push(null) - 1; // keep parents before children
      const lines = [];
      for (const [k, f] of o.fields) lines.push(`  ${tsKey(k)}${f.seen < o.count ? '?' : ''}: ${typeOf(f.shape, k)};`);
      decls[idx] = `export interface ${name} {\n${lines.join('\n')}\n}`;
      return name;
    }
    const top = typeOf(shapeOf(node), rootName || 'Root');
    if (!decls.length || !/^[A-Z][A-Za-z0-9]*$/.test(top) || !names.has(top)) decls.push(`export type ${unique(rootName || 'Root')} = ${top};`);
    return `${decls.join('\n\n')}\n`;
  }

  // ------------------------------------------------------------------ JSON Schema (draft 2020-12)
  function schemaOf(s) {
    const alts = [];
    const types = [];
    if (s.kinds.has('string')) types.push('string');
    if (s.kinds.has('number') || (s.kinds.has('integer') && s.kinds.has('number'))) types.push('number');
    else if (s.kinds.has('integer')) types.push('integer');
    if (s.kinds.has('boolean')) types.push('boolean');
    if (s.kinds.has('null')) types.push('null');
    if (s.obj) {
      const props = {}, required = [];
      for (const [k, f] of s.obj.fields) { props[k] = schemaOf(f.shape); if (f.seen === s.obj.count) required.push(k); }
      const o = { type: 'object' };
      if (Object.keys(props).length) o.properties = props;
      if (required.length) o.required = required;
      alts.push(o);
    }
    if (s.arrSeen) alts.push(Object.assign({ type: 'array' }, s.arr.n ? { items: schemaOf(s.arr) } : {}));
    if (!alts.length) return types.length === 0 ? {} : types.length === 1 ? { type: types[0] } : { type: types };
    if (!types.length && alts.length === 1) return alts[0];
    return { anyOf: types.map((t) => ({ type: t })).concat(alts) };
  }
  function toJsonSchema(node) {
    return `${JSON.stringify(Object.assign({ $schema: 'https://json-schema.org/draft/2020-12/schema' }, schemaOf(shapeOf(node))), null, 2)}\n`;
  }

  /** Converters offered in the Preview "Format" list. ext is the download extension. */
  const CONVERTERS = {
    yaml: { label: 'YAML (export)', ext: 'yaml', run: toYaml },
    csv: { label: 'CSV (export)', ext: 'csv', run: toCsv },
    ts: { label: 'TypeScript types (export)', ext: 'ts', run: (n) => toTypeScript(n) },
    schema: { label: 'JSON Schema (export)', ext: 'schema.json', run: toJsonSchema },
  };

  JSS.convert = { toYaml, toCsv, toTypeScript, toJsonSchema, CONVERTERS };
  if (typeof module !== 'undefined' && module.exports) module.exports = JSS;
})(typeof self !== 'undefined' ? self : globalThis);
