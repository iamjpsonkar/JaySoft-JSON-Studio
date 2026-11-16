/* JSON Studio core: serialisers. AST -> JSON / Python literal / JavaScript (JSON5-style) text.
 * Exact number text is written verbatim, so big integers and decimals never lose digits.
 */
(function (root) {
  'use strict';
  const JSS = root.JSS;
  const { IDENT_RE, isSpecialNum } = JSS.ast;

  const RESERVED = new Set(['break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do', 'else',
    'enum', 'export', 'extends', 'false', 'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof', 'new', 'null', 'return',
    'super', 'switch', 'this', 'throw', 'true', 'try', 'typeof', 'var', 'void', 'while', 'with', 'let', 'static', 'yield', 'await']);

  function escapeChar(ch, quote, style) {
    const cp = ch.codePointAt(0);
    if (ch === quote || ch === '\\') return '\\' + ch;
    if (ch === '\n') return '\\n';
    if (ch === '\r') return '\\r';
    if (ch === '\t') return '\\t';
    if (cp < 0x20 || cp === 0x7f) return style === 'js' ? `\\x${cp.toString(16).padStart(2, '0')}` : `\\x${cp.toString(16).padStart(2, '0')}`;
    if (cp >= 0xd800 && cp <= 0xdfff) return `\\u${cp.toString(16).padStart(4, '0')}`; // lone surrogate
    if (cp === 0x2028 || cp === 0x2029) return `\\u${cp.toString(16)}`;
    return ch;
  }

  /** Python repr() quoting rules: prefer single quotes unless the text has ' and no ". */
  function pyStr(s) {
    const q = s.includes("'") && !s.includes('"') ? '"' : "'";
    let out = q;
    for (const ch of s) out += escapeChar(ch, q, 'python');
    return out + q;
  }
  function jsStr(s) {
    const q = s.includes("'") && !s.includes('"') ? '"' : "'";
    let out = q;
    for (const ch of s) out += escapeChar(ch, q, 'js');
    return out + q;
  }

  /**
   * serialize(node, {style:'json'|'python'|'js', indent:0|2|4|'tab', sortKeys, nonFinite:'keep'|'null'|'string'})
   * -> {text, warnings:[string]}
   * indent 0: JSON/JS are minified, Python gets repr-like single-line output.
   */
  function serialize(node, opts) {
    const o = Object.assign({ style: 'json', indent: 2, sortKeys: false, nonFinite: 'keep' }, opts);
    const unit = o.indent === 'tab' ? '\t' : ' '.repeat(Number(o.indent) || 0);
    const pretty = unit !== '';
    const warnings = new Set();
    const py = o.style === 'python', js = o.style === 'js';
    const comma = pretty ? ',' : (py ? ', ' : ',');
    const colon = pretty || py ? ': ' : ':';

    function num(n) {
      if (!isSpecialNum(n.raw)) return n.raw;
      if (py) return n.raw === 'NaN' ? "float('nan')" : n.raw[0] === '-' ? "float('-inf')" : "float('inf')";
      if (js) return n.raw;
      if (o.nonFinite === 'null') { warnings.add(`${n.raw} written as null (JSON has no NaN/Infinity)`); return 'null'; }
      if (o.nonFinite === 'string') { warnings.add(`${n.raw} written as a string (JSON has no NaN/Infinity)`); return JSON.stringify(n.raw); }
      warnings.add(`${n.raw} is not valid JSON`);
      return n.raw;
    }

    function key(e) {
      if (py) {
        if (e.keyType === 'num') return e.key;
        if (e.keyType === 'bool') return e.key === 'true' ? 'True' : 'False';
        if (e.keyType === 'null') return 'None';
        if (e.keyType === 'tuple' && e.keyRaw) return e.keyRaw;
        return pyStr(e.key);
      }
      if (js) return IDENT_RE.test(e.key) && !RESERVED.has(e.key) ? e.key : jsStr(e.key);
      return JSON.stringify(e.key);
    }

    function wrap(open, close, parts, depth) {
      if (!parts.length) return open + close;
      if (!pretty) return open + parts.join(comma) + close;
      const inner = unit.repeat(depth + 1);
      return `${open}\n${parts.map((p) => inner + p).join(',\n')}\n${unit.repeat(depth)}${close}`;
    }

    function emit(n, depth) {
      switch (n.t) {
        case 'null': return py ? 'None' : js && n.tag === 'undefined' ? 'undefined' : 'null';
        case 'bool': return py ? (n.v ? 'True' : 'False') : String(n.v);
        case 'num': return num(n);
        case 'str':
          if (py) return (n.tag === 'bytes' ? 'b' : '') + pyStr(n.v);
          return js ? jsStr(n.v) : JSON.stringify(n.v);
        case 'arr': {
          const parts = n.items.map((v) => emit(v, depth + 1));
          if (py && n.tag === 'tuple') {
            if (!parts.length) return '()';
            if (parts.length === 1 && !pretty) return `(${parts[0]},)`;
            if (parts.length === 1) return `(\n${unit.repeat(depth + 1)}${parts[0]},\n${unit.repeat(depth)})`;
            return wrap('(', ')', parts, depth);
          }
          if (py && n.tag === 'set') return parts.length ? wrap('{', '}', parts, depth) : 'set()';
          return wrap('[', ']', parts, depth);
        }
        case 'obj': {
          let entries = n.entries;
          if (o.sortKeys) entries = entries.slice().sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
          return wrap('{', '}', entries.map((e) => key(e) + colon + emit(e.value, depth + 1)), depth);
        }
        default: return 'null';
      }
    }

    const text = emit(node, 0);
    return { text, warnings: [...warnings] };
  }

  const toJSON = (node, opts) => serialize(node, Object.assign({}, opts, { style: 'json' })).text;

  JSS.fmt = { serialize, toJSON, pyStr, jsStr };
  if (typeof module !== 'undefined' && module.exports) module.exports = JSS;
})(typeof self !== 'undefined' ? self : globalThis);
