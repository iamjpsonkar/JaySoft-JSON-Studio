/* JSON Studio core: a JSON Schema validator over the AST (so errors carry real paths).
 * Supported: type, enum, const, properties, required, additionalProperties, patternProperties, propertyNames,
 * items, prefixItems, contains, minItems/maxItems, uniqueItems, minLength/maxLength, pattern, minimum/maximum,
 * exclusiveMinimum/exclusiveMaximum, multipleOf, minProperties/maxProperties, allOf/anyOf/oneOf/not,
 * if/then/else, local $ref (#, #/a/b, $defs, definitions), and the formats email, uuid, date, date-time, ipv4.
 * Other keywords are listed in `ignored`, never silently passed off as checked.
 */
(function (root) {
  'use strict';
  const JSS = root.JSS;
  const { numKey } = JSS.ast;

  const KNOWN = new Set(['$schema', '$id', '$ref', '$defs', 'definitions', '$comment', 'title', 'description', 'default', 'examples', 'deprecated', 'readOnly', 'writeOnly',
    'type', 'enum', 'const', 'properties', 'required', 'additionalProperties', 'patternProperties', 'propertyNames', 'items', 'prefixItems', 'contains', 'minContains', 'maxContains',
    'minItems', 'maxItems', 'uniqueItems', 'minLength', 'maxLength', 'pattern', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf',
    'minProperties', 'maxProperties', 'allOf', 'anyOf', 'oneOf', 'not', 'if', 'then', 'else', 'format']);
  const FORMATS = {
    email: (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s),
    uuid: (s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s),
    date: (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s)),
    'date-time': (s) => /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?([Zz]|[+-]\d{2}:\d{2})$/.test(s) && !Number.isNaN(Date.parse(s)),
    ipv4: (s) => /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/.test(s),
  };

  /** Deep equality between an AST node and a plain JSON value (numbers compared exactly by canonical form). */
  function eq(n, v) {
    if (n.t === 'null') return v === null;
    if (n.t === 'bool') return v === n.v;
    if (n.t === 'str') return v === n.v;
    if (n.t === 'num') return typeof v === 'number' && numKey(n.raw) === numKey(String(v));
    if (n.t === 'arr') return Array.isArray(v) && v.length === n.items.length && n.items.every((x, i) => eq(x, v[i]));
    if (n.t === 'obj') return v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === n.entries.length && n.entries.every((e) => Object.prototype.hasOwnProperty.call(v, e.key) && eq(e.value, v[e.key]));
    return false;
  }
  function nodeEq(a, b) {
    if (a.t !== b.t) return false;
    if (a.t === 'null') return true;
    if (a.t === 'bool' || a.t === 'str') return a.v === b.v;
    if (a.t === 'num') return numKey(a.raw) === numKey(b.raw);
    if (a.t === 'arr') return a.items.length === b.items.length && a.items.every((x, i) => nodeEq(x, b.items[i]));
    return a.entries.length === b.entries.length && a.entries.every((e) => { const o = b.entries.find((x) => x.key === e.key); return o && nodeEq(e.value, o.value); });
  }
  const typeOk = (n, t) => (t === 'integer' ? n.t === 'num' && Number.isInteger(Number(n.raw)) : t === 'number' ? n.t === 'num' : t === 'string' ? n.t === 'str' : t === 'boolean' ? n.t === 'bool'
    : t === 'null' ? n.t === 'null' : t === 'object' ? n.t === 'obj' : t === 'array' ? n.t === 'arr' : false);
  const typeName = (n) => (n.t === 'num' ? (Number.isInteger(Number(n.raw)) ? 'integer' : 'number') : { str: 'string', bool: 'boolean', null: 'null', obj: 'object', arr: 'array' }[n.t]);
  const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x);

  /** validate(dataNode, schema) -> {valid, errors:[{path, keyword, message}], ignored:[keyword], truncated} */
  function validate(data, schema, opts) {
    const max = (opts && opts.maxErrors) || 500;
    const errors = [];
    const ignored = new Set();
    let truncated = false;
    const rootSchema = schema;

    function resolveRef(ref) {
      if (ref === '#') return rootSchema;
      if (!ref.startsWith('#/')) return undefined;
      let cur = rootSchema;
      for (const seg of ref.slice(2).split('/')) { cur = cur && cur[decodeURIComponent(seg).replace(/~1/g, '/').replace(/~0/g, '~')]; }
      return cur;
    }

    // returns true when n is valid against sch; collects errors only when `emit`
    function check(n, sch, path, emit, depth) {
      if (sch === true || sch === undefined) return true;
      if (sch === false) { if (emit) add(path, 'false', 'No value is allowed here (schema is false)'); return false; }
      if (!isObj(sch)) return true;
      if (depth > 60) { if (emit) add(path, '$ref', 'Schema nesting is too deep (circular $ref?)'); return false; }
      let ok = true;
      const fail = (kw, msg) => { ok = false; if (emit) add(path, kw, msg); };
      for (const k of Object.keys(sch)) if (!KNOWN.has(k)) ignored.add(k);

      if (sch.$ref !== undefined) {
        const target = resolveRef(sch.$ref);
        if (target === undefined) fail('$ref', `Cannot resolve $ref ${JSON.stringify(sch.$ref)} (only local references are supported)`);
        else if (!check(n, target, path, emit, depth + 1)) ok = false;
      }
      if (sch.type !== undefined) {
        const ts = Array.isArray(sch.type) ? sch.type : [sch.type];
        if (!ts.some((t) => typeOk(n, t))) fail('type', `Expected ${ts.join(' or ')}, found ${typeName(n)}`);
      }
      if (Array.isArray(sch.enum) && !sch.enum.some((v) => eq(n, v))) fail('enum', `Must be one of ${trunc(JSON.stringify(sch.enum))}`);
      if ('const' in sch && !eq(n, sch.const)) fail('const', `Must equal ${trunc(JSON.stringify(sch.const))}`);

      if (n.t === 'str') {
        const len = [...n.v].length;
        if (typeof sch.minLength === 'number' && len < sch.minLength) fail('minLength', `Shorter than ${sch.minLength} characters`);
        if (typeof sch.maxLength === 'number' && len > sch.maxLength) fail('maxLength', `Longer than ${sch.maxLength} characters`);
        if (typeof sch.pattern === 'string') {
          try { if (!new RegExp(sch.pattern, 'u').test(n.v)) fail('pattern', `Does not match /${sch.pattern}/`); } catch { ignored.add('pattern (invalid regex)'); }
        }
        if (typeof sch.format === 'string') { if (FORMATS[sch.format]) { if (!FORMATS[sch.format](n.v)) fail('format', `Not a valid ${sch.format}`); } else ignored.add(`format:${sch.format}`); }
      }
      if (n.t === 'num') {
        const v = Number(n.raw);
        if (typeof sch.minimum === 'number' && v < sch.minimum) fail('minimum', `Less than the minimum ${sch.minimum}`);
        if (typeof sch.maximum === 'number' && v > sch.maximum) fail('maximum', `Greater than the maximum ${sch.maximum}`);
        if (typeof sch.exclusiveMinimum === 'number' && v <= sch.exclusiveMinimum) fail('exclusiveMinimum', `Must be greater than ${sch.exclusiveMinimum}`);
        if (typeof sch.exclusiveMaximum === 'number' && v >= sch.exclusiveMaximum) fail('exclusiveMaximum', `Must be less than ${sch.exclusiveMaximum}`);
        if (typeof sch.multipleOf === 'number' && sch.multipleOf > 0) { const q = v / sch.multipleOf; if (Math.abs(q - Math.round(q)) > 1e-9) fail('multipleOf', `Not a multiple of ${sch.multipleOf}`); }
      }
      if (n.t === 'obj') {
        const keys = n.entries.map((e) => e.key);
        if (Array.isArray(sch.required)) for (const r of sch.required) if (!keys.includes(r)) fail('required', `Missing required property ${JSON.stringify(r)}`);
        if (typeof sch.minProperties === 'number' && keys.length < sch.minProperties) fail('minProperties', `Fewer than ${sch.minProperties} properties`);
        if (typeof sch.maxProperties === 'number' && keys.length > sch.maxProperties) fail('maxProperties', `More than ${sch.maxProperties} properties`);
        const props = isObj(sch.properties) ? sch.properties : {};
        const pats = isObj(sch.patternProperties) ? Object.keys(sch.patternProperties).map((p) => { try { return [new RegExp(p, 'u'), sch.patternProperties[p]]; } catch { ignored.add('patternProperties (invalid regex)'); return null; } }).filter(Boolean) : [];
        for (const e of n.entries) {
          const sub = path.concat(e.key);
          let matched = false;
          if (Object.prototype.hasOwnProperty.call(props, e.key)) { matched = true; if (!check(e.value, props[e.key], sub, emit, depth + 1)) ok = false; }
          for (const [re, s2] of pats) if (re.test(e.key)) { matched = true; if (!check(e.value, s2, sub, emit, depth + 1)) ok = false; }
          if (!matched && sch.additionalProperties !== undefined) {
            if (sch.additionalProperties === false) fail2(sub, 'additionalProperties', `Property ${JSON.stringify(e.key)} is not allowed`);
            else if (!check(e.value, sch.additionalProperties, sub, emit, depth + 1)) ok = false;
          }
          if (sch.propertyNames !== undefined && !check({ t: 'str', v: e.key }, sch.propertyNames, sub, false, depth + 1)) fail2(sub, 'propertyNames', `Key ${JSON.stringify(e.key)} is not allowed`);
        }
      }
      if (n.t === 'arr') {
        const items = n.items;
        if (typeof sch.minItems === 'number' && items.length < sch.minItems) fail('minItems', `Fewer than ${sch.minItems} items`);
        if (typeof sch.maxItems === 'number' && items.length > sch.maxItems) fail('maxItems', `More than ${sch.maxItems} items`);
        if (sch.uniqueItems === true) {
          outer: for (let i = 1; i < items.length; i++) for (let j = 0; j < i; j++) if (nodeEq(items[i], items[j])) { fail2(path.concat(i), 'uniqueItems', `Duplicate of item ${j}`); break outer; }
        }
        const prefix = Array.isArray(sch.prefixItems) ? sch.prefixItems : [];
        items.forEach((it, i) => {
          if (i < prefix.length) { if (!check(it, prefix[i], path.concat(i), emit, depth + 1)) ok = false; }
          else if (sch.items !== undefined && !Array.isArray(sch.items) && !check(it, sch.items, path.concat(i), emit, depth + 1)) ok = false;
          else if (Array.isArray(sch.items) && i < sch.items.length && !check(it, sch.items[i], path.concat(i), emit, depth + 1)) ok = false; // draft-07 tuple form
        });
        if (sch.contains !== undefined) {
          const hits = items.filter((it) => check(it, sch.contains, path, false, depth + 1)).length;
          const min = typeof sch.minContains === 'number' ? sch.minContains : 1;
          if (hits < min) fail('contains', `Needs at least ${min} matching item${min === 1 ? '' : 's'}, found ${hits}`);
          if (typeof sch.maxContains === 'number' && hits > sch.maxContains) fail('maxContains', `More than ${sch.maxContains} matching items`);
        }
      }
      if (Array.isArray(sch.allOf)) for (const s2 of sch.allOf) if (!check(n, s2, path, emit, depth + 1)) ok = false;
      if (Array.isArray(sch.anyOf) && !sch.anyOf.some((s2) => check(n, s2, path, false, depth + 1))) fail('anyOf', 'Does not match any of the allowed schemas');
      if (Array.isArray(sch.oneOf)) {
        const hits = sch.oneOf.filter((s2) => check(n, s2, path, false, depth + 1)).length;
        if (hits !== 1) fail('oneOf', hits === 0 ? 'Does not match any of the allowed schemas' : `Matches ${hits} schemas, exactly one is allowed`);
      }
      if (sch.not !== undefined && check(n, sch.not, path, false, depth + 1)) fail('not', 'Matches a schema it must not match');
      if (sch.if !== undefined) {
        const branch = check(n, sch.if, path, false, depth + 1) ? sch.then : sch.else;
        if (branch !== undefined && !check(n, branch, path, emit, depth + 1)) ok = false;
      }
      return ok;

      function fail2(p, kw, msg) { ok = false; if (emit) add(p, kw, msg); }
    }
    function add(path, keyword, message) {
      if (errors.length >= max) { truncated = true; return; }
      errors.push({ path, keyword, message });
    }
    const trunc = (s) => (s.length > 80 ? `${s.slice(0, 80)}…` : s);

    check(data, schema, [], true, 0);
    return { valid: errors.length === 0, errors, ignored: [...ignored].sort(), truncated };
  }

  JSS.schema = { validate };
  if (typeof module !== 'undefined' && module.exports) module.exports = JSS;
})(typeof self !== 'undefined' ? self : globalThis);
