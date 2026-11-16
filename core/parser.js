/* JSON Studio core: one recursive-descent parser for JSON and dict-like literals
 * (JSON5/JS, Python, Ruby, PHP). In `strict` mode every non-JSON extension throws, so the
 * same code path gives strict JSON validation with line/column errors.
 *
 * SAFETY: this is a parser only. Nothing is ever evaluated (no eval / Function / ast.literal_eval
 * style execution), depth is capped, and unknown calls are kept as text.
 */
(function (root) {
  'use strict';
  const JSS = root.JSS;
  const { N, numKey } = JSS.ast;

  class ParseError extends Error {
    constructor(message, pos, text) {
      super(message);
      this.name = 'ParseError';
      this.pos = pos;
      let line = 1, last = -1;
      for (let i = text.indexOf('\n'); i !== -1 && i < pos; i = text.indexOf('\n', i + 1)) { line++; last = i; }
      this.line = line;
      this.col = pos - last;
    }
  }

  const FEATURE_LABELS = {
    'comments': 'comments',
    'hash-comments': '# comments',
    'trailing-commas': 'trailing commas',
    'single-quoted-strings': 'single-quoted strings',
    'backtick-strings': 'backtick strings',
    'unquoted-keys': 'unquoted keys',
    'non-string-keys': 'non-string keys',
    'hex-numbers': 'hex numbers',
    'octal-numbers': 'octal numbers',
    'binary-numbers': 'binary numbers',
    'numeric-underscores': 'numeric underscores',
    'leading-dot-number': 'numbers like .5',
    'trailing-dot-number': 'numbers like 5.',
    'plus-sign': 'leading + sign',
    'leading-zeros': 'leading zeros in numbers',
    'non-finite-numbers': 'NaN / Infinity',
    'python-booleans': 'Python True/False',
    'python-none': 'Python None',
    'python-set': 'set literals',
    'tuples': 'tuples',
    'triple-quoted-strings': 'triple-quoted strings',
    'string-prefix': 'string prefixes (r/b/u)',
    'python-call': 'call expressions such as Decimal(...) / datetime(...)',
    'non-literal-repr': 'non-literal <repr> values',
    'dotted-names': 'dotted identifiers',
    'ruby-nil': 'Ruby nil',
    'ruby-symbols': 'Ruby symbols',
    'ruby-hash-rocket': 'Ruby => hash rocket',
    'php-array-call': 'PHP array()',
    'php-keyed-array': 'PHP [key => value] arrays',
    'php-constants': 'PHP TRUE/FALSE/NULL',
    'js-undefined': 'JS undefined',
    'unicode-whitespace': 'unicode whitespace',
    'non-json-escape': 'non-JSON string escapes',
    'raw-newline-in-string': 'raw newlines inside strings',
    'line-continuation': 'backslash line continuation',
  };

  const IDENT = /[\p{L}_$][\p{L}\p{N}_$]*/uy;
  const IDENT_CHAR = /[\p{L}\p{N}_$]/u;
  const SPECIAL = /(Infinity|NaN|inf|nan)(?![\p{L}\p{N}_$])/iuy;
  const NUM = /(\d+(?:_\d+)*)?(\.(?:\d+(?:_\d+)*)?)?([eE][+-]?\d+(?:_\d+)*)?/y;
  const PREFIX = /^(r|b|u|br|rb)$/i;
  const UTC_REPR = /^(datetime\.)?(timezone\.utc|UTC)$/;
  const pad = (n, w) => String(n).padStart(w, '0');
  const show = (c) => (c === undefined ? 'end of input' : `'${c}'`);

  class Parser {
    constructor(text, opts) {
      opts = opts || {};
      this.s = text;
      this.i = 0;
      this.strict = !!opts.strict;
      this.features = new Map();
      this.warnings = [];
      this.depth = 0;
      this.maxDepth = opts.maxDepth || 500;
    }

    err(msg, pos, code) {
      const e = new ParseError(msg, pos === undefined ? this.i : pos, this.s);
      if (code) e.code = code;
      return e;
    }
    feature(name, pos, strictMsg) {
      if (this.strict) throw this.err(strictMsg || `${FEATURE_LABELS[name] || name} is not valid JSON`, pos);
      if (!this.features.has(name)) this.features.set(name, pos);
    }
    warn(type, message, pos) {
      if (this.warnings.length < 200) this.warnings.push({ type, message, pos });
    }

    // ---------------------------------------------------------------- entry points
    parseDocument() {
      const v = this.parseValue();
      this.skipWs();
      if (this.i < this.s.length) {
        throw this.err(`Unexpected token ${show(this.s[this.i])} after the top-level value`, this.i, 'trailing');
      }
      return v;
    }
    /** Parse one value starting at `start` without requiring end of input. */
    parseAt(start) {
      this.i = start;
      const node = this.parseValue();
      return { node, end: this.i };
    }
    /** Concatenated values: NDJSON, `{..}{..}`. */
    parseMany() {
      const out = [];
      for (;;) {
        this.skipWs();
        if (this.i >= this.s.length) break;
        out.push(this.parseValue());
      }
      return out;
    }

    // ---------------------------------------------------------------- whitespace & comments
    skipWs() {
      const s = this.s;
      for (;;) {
        const c = s.charCodeAt(this.i);
        if (c === 32 || c === 9 || c === 10 || c === 13) { this.i++; continue; }
        if (c === 47) { // '/'
          const n = s[this.i + 1];
          if (n === '/') {
            this.feature('comments', this.i);
            const e = s.indexOf('\n', this.i);
            this.i = e === -1 ? s.length : e + 1;
            continue;
          }
          if (n === '*') {
            this.feature('comments', this.i);
            const e = s.indexOf('*/', this.i + 2);
            if (e === -1) throw this.err('Unterminated comment', this.i);
            this.i = e + 2;
            continue;
          }
          return;
        }
        if (c === 35) { // '#'
          this.feature('hash-comments', this.i);
          const e = s.indexOf('\n', this.i);
          this.i = e === -1 ? s.length : e + 1;
          continue;
        }
        if (c === 0xfeff || c === 0xa0 || c === 0x2028 || c === 0x2029 || c === 0x3000 || (c >= 0x2000 && c <= 0x200a)) {
          this.feature('unicode-whitespace', this.i);
          this.i++;
          continue;
        }
        return;
      }
    }

    // ---------------------------------------------------------------- values
    parseValue() {
      this.skipWs();
      const s = this.s, i = this.i, c = s[i];
      if (c === undefined) throw this.err('Unexpected end of input', i);
      if (++this.depth > this.maxDepth) throw this.err(`Nesting is deeper than ${this.maxDepth} levels`, i);
      try {
        if (c === '{') return this.parseBrace();
        if (c === '[') return this.parseBracket();
        if (c === '(') return this.parseParen();
        if (c === '"' || c === "'" || c === '`') return this.parseString('');
        if (c === '<') return this.parseAngle();
        if (c === ':' && /[\p{L}_$"']/u.test(s[i + 1] || '')) return this.parseSymbol();
        if (c === '-' || c === '+' || c === '.' || (c >= '0' && c <= '9')) return this.parseNumber();
        if (/[\p{L}_$]/u.test(c)) {
          SPECIAL.lastIndex = i;
          if (SPECIAL.test(s)) return this.parseNumber();
          return this.parseWord();
        }
        throw this.err(`Unexpected token ${show(c)}`, i);
      } finally {
        this.depth--;
      }
    }

    parseSymbol() {
      const s = this.s, start = this.i;
      this.feature('ruby-symbols', start, `Unexpected token ':'`);
      this.i++;
      if (s[this.i] === '"' || s[this.i] === "'") {
        const n = this.parseString('');
        return N.str(n.v, 'symbol');
      }
      IDENT.lastIndex = this.i;
      const m = IDENT.exec(s);
      if (!m) throw this.err(`Unexpected token ':'`, start);
      this.i += m[0].length;
      return N.str(m[0], 'symbol');
    }

    parseAngle() {
      const s = this.s, start = this.i;
      let depth = 0, j = start;
      for (; j < s.length; j++) {
        const ch = s[j];
        if (ch === "'" || ch === '"') { // skip quoted segment
          const e = s.indexOf(ch, j + 1);
          if (e === -1) break;
          j = e;
        } else if (ch === '<') depth++;
        else if (ch === '>') { depth--; if (depth === 0) break; }
      }
      if (depth !== 0 || j >= s.length) throw this.err(`Unexpected token '<'`, start);
      this.feature('non-literal-repr', start, `Unexpected token '<'`);
      this.i = j + 1;
      const text = s.slice(start, this.i);
      this.warn('non-literal', `Non-literal value ${text.length > 40 ? text.slice(0, 40) + '…' : text} kept as text`, start);
      return N.str(text, 'repr');
    }

    // ---------------------------------------------------------------- strings
    parseString(prefix) {
      const s = this.s, start = this.i, q = s[this.i];
      const raw = /r/i.test(prefix), bytes = /b/i.test(prefix);
      if (q === "'") this.feature('single-quoted-strings', start, `Unexpected token ''', strings must use double quotes`);
      if (q === '`') this.feature('backtick-strings', start, `Unexpected token '\`', strings must use double quotes`);
      if (prefix) this.feature('string-prefix', start);
      const triple = s.startsWith(q + q + q, start);
      if (triple) this.feature('triple-quoted-strings', start);
      const delim = triple ? q + q + q : q;
      let i = start + delim.length;
      let out = '';
      for (;;) {
        if (i >= s.length) throw this.err('Unterminated string', start);
        const c = s[i];
        if (s.startsWith(delim, i)) { i += delim.length; break; }
        if (c === '\\' && !raw) {
          const e = s[i + 1];
          if (e === undefined) throw this.err('Unterminated string', start);
          const simple = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '\\': '\\', '"': '"', "'": "'", '/': '/' };
          if (e in simple) {
            if ((e === "'" || e === '/') && this.strict && e === "'") throw this.err(`Bad escaped character`, i);
            out += simple[e]; i += 2;
          } else if (e === 'u') {
            const hex4 = /^[0-9a-fA-F]{4}/.exec(s.slice(i + 2, i + 6));
            if (hex4) { out += String.fromCharCode(parseInt(hex4[0], 16)); i += 6; }
            else {
              const br = /^\{([0-9a-fA-F]{1,6})\}/.exec(s.slice(i + 2, i + 11));
              if (!br) throw this.err('Bad Unicode escape', i);
              this.feature('non-json-escape', i, 'Bad Unicode escape');
              out += String.fromCodePoint(parseInt(br[1], 16)); i += 2 + br[0].length;
            }
          } else if (e === 'x') {
            const h = /^[0-9a-fA-F]{2}/.exec(s.slice(i + 2, i + 4));
            if (!h) throw this.err('Bad hexadecimal escape', i);
            this.feature('non-json-escape', i, 'Bad escaped character');
            out += String.fromCharCode(parseInt(h[0], 16)); i += 4;
          } else if (e === 'U') {
            const h = /^[0-9a-fA-F]{8}/.exec(s.slice(i + 2, i + 10));
            if (!h) throw this.err('Bad Unicode escape', i);
            this.feature('non-json-escape', i, 'Bad escaped character');
            const cp = parseInt(h[0], 16);
            if (cp > 0x10ffff) throw this.err('Unicode escape out of range', i);
            out += String.fromCodePoint(cp); i += 10;
          } else if (e === 'v' || e === 'a') {
            this.feature('non-json-escape', i, 'Bad escaped character');
            out += e === 'v' ? '\v' : '\x07'; i += 2;
          } else if (e >= '0' && e <= '7') {
            this.feature('non-json-escape', i, 'Bad escaped character');
            const o = /^[0-7]{1,3}/.exec(s.slice(i + 1, i + 4))[0];
            out += String.fromCharCode(parseInt(o, 8)); i += 1 + o.length;
          } else if (e === '\n' || (e === '\r' && s[i + 2] === '\n')) {
            this.feature('line-continuation', i, 'Bad escaped character');
            i += e === '\r' ? 3 : 2;
          } else {
            this.feature('non-json-escape', i, 'Bad escaped character');
            this.warn('unknown-escape', `Unknown escape \\${e} kept as written`, i);
            out += '\\' + e; i += 2;
          }
          continue;
        }
        const code = c.charCodeAt(0);
        if (code < 0x20) {
          if (this.strict) throw this.err('Bad control character in string literal', i);
          if (code === 10 || code === 13 || code === 9) this.feature('raw-newline-in-string', i);
        }
        out += c; i++;
      }
      this.i = i;
      return N.str(out, bytes ? 'bytes' : undefined);
    }

    // ---------------------------------------------------------------- numbers
    parseNumber() {
      const s = this.s, start = this.i;
      let i = start, neg = false;
      if (s[i] === '-' || s[i] === '+') {
        if (s[i] === '+') this.feature('plus-sign', i, `Unexpected token '+'`);
        neg = s[i] === '-';
        i++;
      }
      SPECIAL.lastIndex = i;
      const sp = SPECIAL.exec(s);
      if (sp) {
        this.feature('non-finite-numbers', i, `Unexpected token '${sp[1][0]}'`);
        this.i = i + sp[0].length;
        return N.num(/^nan$/i.test(sp[1]) ? 'NaN' : (neg ? '-Infinity' : 'Infinity'));
      }
      const radix = /^0([xXoObB])/.exec(s.slice(i, i + 2));
      if (radix) {
        const kind = radix[1].toLowerCase();
        const re = kind === 'x' ? /[0-9a-fA-F_]+/y : kind === 'o' ? /[0-7_]+/y : /[01_]+/y;
        re.lastIndex = i + 2;
        const m = re.exec(s);
        if (m && m.index === i + 2) {
          this.feature(kind === 'x' ? 'hex-numbers' : kind === 'o' ? 'octal-numbers' : 'binary-numbers', i, `Unexpected number`);
          const big = BigInt(`0${kind}${m[0].replace(/_/g, '')}`);
          this.i = i + 2 + m[0].length;
          this.checkNumberEnd();
          return N.num(`${neg ? '-' : ''}${big.toString()}`);
        }
      }
      NUM.lastIndex = i;
      const m = NUM.exec(s);
      const intPart = m[1] || '';
      const hasFracDigits = m[2] && m[2].length > 1;
      if (!m[0] || (!intPart && !hasFracDigits)) throw this.err(`Unexpected token ${show(s[start])}`, start);
      if (intPart.includes('_') || (m[2] || '').includes('_') || (m[3] || '').includes('_')) this.feature('numeric-underscores', i);
      if (!intPart) this.feature('leading-dot-number', i, 'Unexpected token \'.\', numbers need a leading digit');
      if (m[2] === '.') this.feature('trailing-dot-number', i, 'Unterminated fractional number');
      const intClean = (intPart || '0').replace(/_/g, '');
      if (intClean.length > 1 && intClean[0] === '0') this.feature('leading-zeros', i, 'Unexpected number (leading zeros are not allowed)');
      const frac = hasFracDigits ? '.' + m[2].slice(1).replace(/_/g, '') : '';
      const exp = m[3] ? m[3].replace(/_/g, '') : '';
      this.i = i + m[0].length;
      this.checkNumberEnd();
      return N.num(`${neg ? '-' : ''}${intClean.replace(/^0+(?=\d)/, '')}${frac}${exp}`);
    }
    checkNumberEnd() {
      const c = this.s[this.i];
      if (c !== undefined && IDENT_CHAR.test(c)) throw this.err(`Unexpected token ${show(c)} in number`, this.i);
    }

    // ---------------------------------------------------------------- identifiers / keywords / calls
    parseWord() {
      const s = this.s, start = this.i;
      IDENT.lastIndex = start;
      const word = IDENT.exec(s)[0];
      this.i = start + word.length;
      const q = s[this.i];
      if ((q === '"' || q === "'") && PREFIX.test(word)) return this.parseString(word);

      switch (word) {
        case 'true': return N.bool(true);
        case 'false': return N.bool(false);
        case 'null': return N.nul();
        case 'True': this.feature('python-booleans', start, `Unexpected token 'T'`); return N.bool(true);
        case 'False': this.feature('python-booleans', start, `Unexpected token 'F'`); return N.bool(false);
        case 'None': this.feature('python-none', start, `Unexpected token 'N'`); return N.nul();
        case 'nil': this.feature('ruby-nil', start, `Unexpected token 'n'`); return N.nul();
        case 'NULL': this.feature('php-constants', start, `Unexpected token 'N'`); return N.nul();
        case 'TRUE': case 'FALSE': this.feature('php-constants', start, `Unexpected token '${word[0]}'`); return N.bool(word === 'TRUE');
        case 'undefined': this.feature('js-undefined', start, `Unexpected token 'u'`); return N.nul('undefined');
        default:
      }

      let name = word;
      for (;;) {
        if (s[this.i] !== '.') break;
        IDENT.lastIndex = this.i + 1;
        const m = IDENT.exec(s);
        if (!m || m.index !== this.i + 1) break;
        name += '.' + m[0];
        this.i += 1 + m[0].length;
      }
      if (s[this.i] === '(') return this.parseCall(name, start);
      if (name.includes('.')) {
        this.feature('dotted-names', start, `Unexpected token '${word[0]}'`);
        this.warn('dotted-name', `Identifier ${name} kept as text`, start);
        return N.str(name, 'repr');
      }
      throw this.err(`Unexpected identifier '${word}'`, start);
    }

    skipBalanced(open) {
      const s = this.s;
      let depth = 0;
      for (let j = open; j < s.length; j++) {
        const ch = s[j];
        if (ch === '"' || ch === "'") {
          for (j++; j < s.length && s[j] !== ch; j++) if (s[j] === '\\') j++;
        } else if (ch === '(') depth++;
        else if (ch === ')') { depth--; if (depth === 0) return j + 1; }
      }
      return -1;
    }

    parseCall(name, start) {
      const open = this.i;
      const isPhpArray = name === 'array';
      if (isPhpArray) this.feature('php-array-call', start, `Unexpected identifier 'array'`);
      else this.feature('python-call', start, `Unexpected identifier '${name}'`);
      const warnMark = this.warnings.length;
      this.i++;
      let items;
      try {
        items = this.parseElements(')', isPhpArray ? 'php' : 'call');
      } catch (e) {
        if (!(e instanceof ParseError) || isPhpArray) throw e;
        const end = this.skipBalanced(open);
        if (end < 0) throw e;
        this.warnings.length = warnMark;
        this.i = end;
        this.warn('call-kept-as-text', `Could not parse the arguments of ${name}(…); kept as text`, start);
        return N.str(this.s.slice(start, end), 'repr');
      }
      if (isPhpArray) return this.elementsToNode(items);
      return this.buildCall(name, items, start);
    }

    buildCall(name, items, start) {
      const base = name.split('.').pop();
      const pos = items.filter((e) => !e.kw && !e.key).map((e) => e.value);
      const kws = items.filter((e) => e.kw);
      const text = this.s.slice(start, this.i);
      const asText = () => {
        this.warn('call-kept-as-text', `${name}(…) kept as text`, start);
        return N.str(text, 'repr');
      };
      const isInt = (n) => n && n.t === 'num' && /^-?\d+$/.test(n.raw);

      switch (base) {
        case 'Decimal': {
          const a = pos[0];
          const raw = a && (a.t === 'str' ? a.v.trim() : a.t === 'num' ? a.raw : null);
          if (raw !== null && raw !== undefined && pos.length === 1) {
            if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(raw)) {
              const m = /^([+-]?)(\d*)(\.\d*)?(.*)$/.exec(raw);
              const intPart = (m[2] || '0').replace(/^0+(?=\d)/, '');
              const frac = m[3] && m[3].length > 1 ? m[3] : '';
              return N.num(`${m[1] === '-' ? '-' : ''}${intPart}${frac}${m[4]}`, 'decimal');
            }
            if (/^[+-]?(nan|inf|infinity)$/i.test(raw)) return N.num(/nan/i.test(raw) ? 'NaN' : (raw[0] === '-' ? '-Infinity' : 'Infinity'), 'decimal');
          }
          return asText();
        }
        case 'UUID':
          if (pos.length === 1 && pos[0].t === 'str') return N.str(pos[0].v, 'uuid');
          return asText();
        case 'OrderedDict': case 'dict': case 'defaultdict': case 'Counter': {
          const target = base === 'defaultdict' ? pos[1] : pos[0];
          if (!target) {
            if (kws.length) return N.obj(kws.map((k) => ({ key: k.kw, value: k.value })), base);
            return N.obj([], base);
          }
          if (target.t === 'obj') { target.tag = base; return target; }
          if (target.t === 'arr' && target.items.every((it) => it.t === 'arr' && it.items.length === 2 && (it.items[0].t === 'str' || it.items[0].t === 'num'))) {
            return N.obj(target.items.map((it) => ({
              key: it.items[0].t === 'str' ? it.items[0].v : it.items[0].raw,
              value: it.items[1],
              keyType: it.items[0].t === 'num' ? 'num' : undefined,
            })), base);
          }
          return asText();
        }
        case 'set': case 'frozenset': {
          if (!pos[0]) return N.arr([], 'set');
          if (pos[0].t === 'arr') { pos[0].tag = 'set'; return pos[0]; }
          return asText();
        }
        case 'list': case 'deque': {
          if (!pos[0]) return N.arr([], base === 'deque' ? 'deque' : undefined);
          if (pos[0].t === 'arr') { if (base === 'deque') pos[0].tag = 'deque'; else delete pos[0].tag; return pos[0]; }
          return asText();
        }
        case 'tuple': {
          if (!pos[0]) return N.arr([], 'tuple');
          if (pos[0].t === 'arr') { pos[0].tag = 'tuple'; return pos[0]; }
          return asText();
        }
        case 'datetime': {
          if ((name === 'datetime.datetime' || name === 'datetime') && pos.length >= 3 && pos.length <= 7 && pos.every(isInt)) {
            const [y, mo, d, h = 0, mi = 0, sec = 0, us = 0] = pos.map((n) => parseInt(n.raw, 10));
            let iso = `${pad(y, 4)}-${pad(mo, 2)}-${pad(d, 2)}T${pad(h, 2)}:${pad(mi, 2)}:${pad(sec, 2)}`;
            if (us) iso += `.${pad(us, 6)}`;
            const tz = kws.find((k) => k.kw === 'tzinfo');
            const other = kws.filter((k) => k.kw !== 'tzinfo' && k.kw !== 'fold');
            if (other.length) return asText();
            if (tz) {
              if (tz.value.t === 'str' && UTC_REPR.test(tz.value.v)) {
                iso += '+00:00';
                // the dotted name was consumed by this call, so its "kept as text" warning no longer applies
                this.warnings = this.warnings.filter((w) => !(w.type === 'dotted-name' && w.message === `Identifier ${tz.value.v} kept as text`));
              }
              else return asText();
            }
            return N.str(iso, 'datetime');
          }
          return asText();
        }
        case 'timedelta':
          return asText();
        case 'date':
          if ((name === 'datetime.date' || name === 'date') && pos.length === 3 && !kws.length && pos.every(isInt)) {
            const [y, mo, d] = pos.map((n) => parseInt(n.raw, 10));
            return N.str(`${pad(y, 4)}-${pad(mo, 2)}-${pad(d, 2)}`, 'date');
          }
          return asText();
        case 'time':
          if (name === 'datetime.time' && pos.length >= 1 && pos.length <= 4 && !kws.length && pos.every(isInt)) {
            const [h, mi = 0, sec = 0, us = 0] = pos.map((n) => parseInt(n.raw, 10));
            return N.str(`${pad(h, 2)}:${pad(mi, 2)}:${pad(sec, 2)}${us ? '.' + pad(us, 6) : ''}`, 'time');
          }
          return asText();
        default:
          if (kws.length && !pos.length) return N.obj(kws.map((k) => ({ key: k.kw, value: k.value })), base);
          return asText();
      }
    }

    // ---------------------------------------------------------------- containers
    /** Elements of [..], (..) calls and PHP array(..): value, `key => value`, or (calls) `name=value`. */
    parseElements(close, ctx) {
      const s = this.s;
      const items = [];
      for (;;) {
        this.skipWs();
        if (this.i >= s.length) throw this.err(`Unexpected end of input, expected '${close}'`, this.i);
        if (s[this.i] === close) { this.i++; return items; }
        const el = {};
        if (ctx === 'call') {
          IDENT.lastIndex = this.i;
          const m = IDENT.exec(s);
          if (m && m.index === this.i) {
            let j = this.i + m[0].length;
            while (s[j] === ' ' || s[j] === '\t') j++;
            if (s[j] === '=' && s[j + 1] !== '=' && s[j + 1] !== '>') { el.kw = m[0]; this.i = j + 1; }
          }
        }
        const v = this.parseValue();
        this.skipWs();
        if (!el.kw && s.startsWith('=>', this.i)) {
          this.feature('php-keyed-array', this.i, `Unexpected token '='`);
          this.i += 2;
          el.key = v;
          el.value = this.parseValue();
          this.skipWs();
        } else el.value = v;
        items.push(el);
        const c = s[this.i];
        if (c === ',') {
          const commaAt = this.i;
          this.i++;
          this.skipWs();
          if (s[this.i] === close) this.feature('trailing-commas', commaAt, `Unexpected token '${close}', trailing commas are not allowed`);
        } else if (c !== close) {
          throw this.err(`Expected ',' or '${close}'${c === undefined ? ', reached end of input' : `, found ${show(c)}`}`, this.i);
        }
      }
    }

    elementsToNode(items, tag) {
      if (!items.some((e) => e.key)) return N.arr(items.map((e) => e.value), tag);
      let next = 0;
      const entries = [];
      for (const e of items) {
        if (e.key) {
          const k = e.key;
          let key;
          if (k.t === 'str') key = k.v;
          else if (k.t === 'num') { key = k.raw; if (/^\d+$/.test(key)) next = Math.max(next, parseInt(key, 10) + 1); }
          else if (k.t === 'bool') key = k.v ? '1' : '0';
          else if (k.t === 'null') key = '';
          else throw this.err('Illegal array key', this.i);
          entries.push({ key, value: e.value, keyType: k.t === 'num' ? 'num' : undefined });
        } else {
          entries.push({ key: String(next), value: e.value, keyType: 'num' });
          next++;
        }
      }
      return N.obj(entries.map((e) => (e.keyType ? e : { key: e.key, value: e.value })), tag);
    }

    parseBracket() {
      this.i++;
      return this.elementsToNode(this.parseElements(']', 'bracket'));
    }

    parseParen() {
      const s = this.s, start = this.i;
      this.feature('tuples', start, `Unexpected token '('`);
      this.i++;
      this.skipWs();
      if (s[this.i] === ')') { this.i++; return N.arr([], 'tuple'); }
      const first = this.parseValue();
      this.skipWs();
      if (s[this.i] === ')') { this.i++; return first; } // plain grouping
      if (s[this.i] !== ',') throw this.err(`Expected ',' or ')'`, this.i);
      const items = [first];
      while (s[this.i] === ',') {
        this.i++;
        this.skipWs();
        if (s[this.i] === ')') break;
        items.push(this.parseValue());
        this.skipWs();
      }
      if (s[this.i] !== ')') throw this.err(`Expected ',' or ')'`, this.i);
      this.i++;
      return N.arr(items, 'tuple');
    }

    parseKey() {
      const s = this.s, start = this.i;
      IDENT.lastIndex = start;
      const m = IDENT.exec(s);
      if (m && m.index === start && m[0] !== 'True' && m[0] !== 'False' && m[0] !== 'None') {
        let j = start + m[0].length;
        while (s[j] === ' ' || s[j] === '\t') j++;
        if (s[j] === ':' && s[j + 1] !== ':') {
          this.feature('unquoted-keys', start, 'Property names must be double-quoted strings');
          this.i = j;
          return { key: m[0], bare: true };
        }
      }
      const node = this.parseValue();
      const raw = s.slice(start, this.i).trim();
      switch (node.t) {
        case 'str': return { key: node.v, node };
        case 'num':
          this.feature('non-string-keys', start, 'Property names must be double-quoted strings');
          return { key: node.raw, keyType: 'num', keyRaw: raw, node };
        case 'bool':
          this.feature('non-string-keys', start, 'Property names must be double-quoted strings');
          return { key: node.v ? 'true' : 'false', keyType: 'bool', keyRaw: raw, node };
        case 'null':
          this.feature('non-string-keys', start, 'Property names must be double-quoted strings');
          return { key: 'null', keyType: 'null', keyRaw: raw, node };
        case 'arr':
          if (node.tag === 'tuple') {
            this.feature('non-string-keys', start, 'Property names must be double-quoted strings');
            return { key: raw, keyType: 'tuple', keyRaw: raw, node };
          }
          // fallthrough
        default:
          throw this.err('Invalid object key', start);
      }
    }

    parseBrace() {
      const s = this.s, start = this.i;
      this.i++;
      const entries = [], setItems = [], seen = new Map();
      let isSet = null;
      this.skipWs();
      if (s[this.i] === '}') { this.i++; return N.obj([]); }
      for (;;) {
        this.skipWs();
        if (this.i >= s.length) throw this.err(`Unexpected end of input, expected '}'`, this.i);
        const k = this.parseKey();
        this.skipWs();
        const c = s[this.i];
        if (isSet !== true && (c === ':' || s.startsWith('=>', this.i))) {
          isSet = false;
          if (c === ':') this.i++;
          else { this.feature('ruby-hash-rocket', this.i, `Unexpected token '='`); this.i += 2; }
          const value = this.parseValue();
          const entry = { key: k.key, value };
          if (k.keyType) { entry.keyType = k.keyType; entry.keyRaw = k.keyRaw; }
          const n = (seen.get(k.key) || 0) + 1;
          seen.set(k.key, n);
          if (n === 2) this.warn('duplicate-key', `Duplicate key "${k.key}"`, this.i);
          entries.push(entry);
        } else if (!k.bare && isSet !== false && (c === ',' || c === '}')) {
          isSet = true;
          this.feature('python-set', start, `Expected ':' after property name`);
          setItems.push(k.node);
        } else {
          throw this.err(`Expected ':' after property name${c === undefined ? ', reached end of input' : `, found ${show(c)}`}`, this.i);
        }
        this.skipWs();
        const d = s[this.i];
        if (d === ',') {
          const commaAt = this.i;
          this.i++;
          this.skipWs();
          if (s[this.i] === '}') {
            this.feature('trailing-commas', commaAt, `Unexpected token '}', trailing commas are not allowed`);
            this.i++;
            break;
          }
        } else if (d === '}') {
          this.i++;
          break;
        } else {
          throw this.err(`Expected ',' or '}'${d === undefined ? ', reached end of input' : `, found ${show(d)}`}`, this.i);
        }
      }
      return isSet ? N.arr(setItems, 'set') : N.obj(entries);
    }
  }

  // ---------------------------------------------------------------- format inference
  function inferFormat(features) {
    const f = new Set(features.keys());
    const has = (...n) => n.some((x) => f.has(x));
    if (!f.size) return { format: 'json', alternatives: [] };
    if (has('php-array-call', 'php-keyed-array', 'php-constants')) return { format: 'php', alternatives: [] };
    if (has('ruby-nil', 'ruby-symbols', 'ruby-hash-rocket')) return { format: 'ruby', alternatives: [] };
    if (has('python-booleans', 'python-none', 'python-set', 'tuples', 'python-call', 'non-literal-repr', 'triple-quoted-strings', 'string-prefix', 'dotted-names')) {
      return { format: 'python', alternatives: [] };
    }
    if (has('js-undefined', 'backtick-strings')) return { format: 'javascript', alternatives: ['json5'] };
    const jsonish = new Set(['comments', 'trailing-commas', 'unicode-whitespace', 'raw-newline-in-string']);
    if ([...f].every((x) => jsonish.has(x))) return { format: has('comments') ? 'jsonc' : 'json-lenient', alternatives: [] };
    if (has('hash-comments')) return { format: 'python', alternatives: ['ruby'] };
    if (has('unquoted-keys', 'hex-numbers', 'plus-sign', 'leading-dot-number', 'trailing-dot-number', 'non-finite-numbers', 'comments')) {
      return { format: 'json5', alternatives: ['javascript'] };
    }
    return { format: 'python', alternatives: ['javascript'] }; // single quotes / non-string keys only: most often a Python repr
  }

  const FORMAT_LABELS = {
    'json': 'JSON',
    'json-lenient': 'JSON (relaxed: trailing commas / raw newlines)',
    'jsonc': 'JSON with comments',
    'json5': 'JSON5 / JS object',
    'javascript': 'JavaScript object',
    'python': 'Python literal (dict repr)',
    'ruby': 'Ruby hash',
    'php': 'PHP array',
  };

  /** Strict JSON first, then the lenient dict-literal parser. Returns {ok,...} (never throws ParseError). */
  function tryParse(text) {
    const strict = new Parser(text, { strict: true });
    try {
      const node = strict.parseDocument();
      return { ok: true, node, format: 'json', alternatives: [], features: new Map(), warnings: strict.warnings };
    } catch (e) {
      if (!(e instanceof ParseError)) throw e;
    }
    const p = new Parser(text, {});
    try {
      const node = p.parseDocument();
      const inf = inferFormat(p.features);
      return { ok: true, node, format: inf.format, alternatives: inf.alternatives, features: p.features, warnings: p.warnings, notStrict: true };
    } catch (e) {
      if (!(e instanceof ParseError)) throw e;
      return { ok: false, error: e };
    }
  }

  JSS.parser = { Parser, ParseError, FEATURE_LABELS, FORMAT_LABELS, inferFormat, tryParse, numKey };
  if (typeof module !== 'undefined' && module.exports) module.exports = JSS;
})(typeof self !== 'undefined' ? self : globalThis);
