/* JSON Studio core: the "smart loader". Paste anything, get an AST plus the list of steps applied.
 *
 * Handles: plain JSON and dict-like literals (see parser.js), stringified / multi-layer encoded JSON,
 * backslash-escaped copies, JSON inside log lines and wrappers (JSON.parse('..'), json.loads(".."),
 * curl -d '..'), concatenated JSON / NDJSON, JWT, Base64, gzip+Base64, URL-encoding, HTML entities and
 * URL query strings. Nothing is evaluated. A best-effort repair for truncated JSON is offered separately
 * (repair()) and is never applied silently.
 */
(function (root) {
  'use strict';
  const JSS = root.JSS;
  const { N, getAt, walk } = JSS.ast;
  const { Parser, ParseError, tryParse, inferFormat, FORMAT_LABELS, FEATURE_LABELS } = JSS.parser;
  const log = JSS.log;

  FORMAT_LABELS.query = 'URL query string';
  FORMAT_LABELS.jwt = 'JWT (decoded)';

  const MAX_LAYERS = 8;
  const SCAN_LIMIT = 500000; // do not scan bigger inputs for embedded JSON
  const isContainerNode = (n) => n && (n.t === 'obj' || n.t === 'arr');

  function okResult(p, steps) {
    return {
      ok: true, node: p.node, format: p.format, alternatives: p.alternatives || [],
      features: p.features || new Map(), warnings: p.warnings || [], notStrict: !!p.notStrict, steps,
    };
  }
  const withSteps = (r, first) => Object.assign({}, r, { steps: [].concat(first, r.steps || []) });

  // ------------------------------------------------------------------ text helpers
  const SIMPLE_ESC = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '/': '/', '"': '"', "'": "'", '\\': '\\' };
  function unescapeLoose(s) {
    return s.replace(/\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[\s\S])/g, (m, g) => {
      if (g[0] === 'u' && g.length === 5) return String.fromCharCode(parseInt(g.slice(1), 16));
      if (g[0] === 'x' && g.length === 3) return String.fromCharCode(parseInt(g.slice(1), 16));
      return g in SIMPLE_ESC ? SIMPLE_ESC[g] : m;
    });
  }

  const NAMED_ENTITIES = { quot: '"', amp: '&', lt: '<', gt: '>', apos: "'" };
  function decodeEntities(s) {
    return s.replace(/&(quot|amp|lt|gt|apos|#\d+|#x[0-9a-fA-F]+);/g, (m, g) => {
      if (g in NAMED_ENTITIES) return NAMED_ENTITIES[g];
      const cp = g[1] === 'x' ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10);
      try { return String.fromCodePoint(cp); } catch { return m; }
    });
  }

  function b64ToBytes(b64) {
    let s = b64.replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function bytesToText(bytes) {
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return null; }
  }
  async function gunzip(bytes) {
    if (typeof DecompressionStream === 'undefined' || typeof Blob === 'undefined' || typeof Response === 'undefined') return null;
    try {
      const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
      return await new Response(stream).text();
    } catch { return null; }
  }

  // ------------------------------------------------------------------ strategies
  /** A string value that itself holds JSON / an encoded payload. Direct parse only: no log scraping. */
  async function unwrapString(content, layer) {
    if (layer >= MAX_LAYERS) return null;
    const t = content.trim();
    if (/^[[{"]/.test(t)) {
      const p = tryParse(content);
      if (p.ok) {
        if (isContainerNode(p.node)) return okResult(p, []);
        if (p.node.t === 'str') {
          const deeper = await unwrapString(p.node.v, layer + 1);
          if (deeper) return withSteps(deeper, { kind: 'string', desc: `Unwrapped a nested JSON string (layer ${layer + 2})` });
        }
      }
    }
    if (t.length >= 12 && !/\s/.test(t)) {
      const r = await decodeEncodings(content, layer + 1);
      if (r && isContainerNode(r.node)) return r;
    }
    return null;
  }

  async function concatenated(text, err) {
    if (err.code !== 'trailing' || !/^\s*[[{]/.test(text)) return null;
    const p = new Parser(text, {});
    let nodes;
    try { nodes = p.parseMany(); } catch (e) { if (e instanceof ParseError) return null; throw e; }
    if (nodes.length < 2) return null;
    const inf = inferFormat(p.features);
    return okResult({
      node: N.arr(nodes, 'documents'), format: inf.format, alternatives: inf.alternatives,
      features: p.features, warnings: p.warnings, notStrict: p.features.size > 0,
    }, [{ kind: 'documents', desc: `Loaded ${nodes.length} concatenated / line-delimited documents as a list` }]);
  }

  /**
   * Backslash-escaped copy of a document: {\"a\": 1}. The strict form only fires when the text STARTS that way or
   * has no unescaped quotes at all, so a log line that merely contains one escaped string is not un-escaped as a whole. The loose form is a
   * last resort, after extraction found nothing.
   */
  const ESCAPED_START = /^\s*[[{]?\s*\\["']/;
  // every quote in the text is escaped (and there is at least one): it is an escaped copy even with a prefix
  const fullyEscaped = (t) => /\\"/.test(t) && !/(^|[^\\])"/.test(t);
  async function escapedCopy(text, err, layer, opts, loose) {
    const t = text.trim();
    if (!t.includes('\\"') && !t.includes("\\'")) return null;
    if (!loose && !ESCAPED_START.test(t) && !fullyEscaped(t)) return null;
    const un = unescapeLoose(t);
    if (un === t) return null;
    const r = await loadInner(un, layer + 1, opts);
    if (r.ok && isContainerNode(r.node)) return withSteps(r, { kind: 'unescape', desc: 'Unescaped backslash-escaped text' });
    return null;
  }

  function decodeJwt(t) {
    const [h, p, sig] = t.split('.');
    try {
      const head = bytesToText(b64ToBytes(h)), body = bytesToText(b64ToBytes(p));
      if (head === null || body === null) return null;
      const hp = new Parser(head, { strict: true }).parseDocument();
      const bp = new Parser(body, { strict: true }).parseDocument();
      if (hp.t !== 'obj' || bp.t !== 'obj' || !hp.entries.some((e) => e.key === 'alg' || e.key === 'typ')) return null;
      return okResult({
        node: N.obj([{ key: 'header', value: hp }, { key: 'payload', value: bp }, { key: 'signature', value: N.str(sig) }], 'jwt'),
        format: 'json', alternatives: [],
      }, [{ kind: 'jwt', desc: 'Decoded a JWT (header and payload only; the signature is NOT verified)' }]);
    } catch { return null; }
  }

  /** JWT, gzip+Base64, Base64, URL-encoding, HTML entities. Each must yield real JSON to be accepted. */
  async function decodeEncodings(text, layer, opts) {
    if (layer >= MAX_LAYERS) return null;
    const t = text.trim().replace(/^Bearer\s+/i, '');
    if (!t) return null;

    if (/^[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*$/.test(t)) {
      const r = decodeJwt(t);
      if (r) return r;
    }
    const compact = t.replace(/\s+/g, '');
    if (compact.length >= 8 && /^[A-Za-z0-9+/_-]+={0,2}$/.test(compact)) {
      try {
        const bytes = b64ToBytes(compact);
        let decoded = null, kind = 'base64', desc = 'Decoded Base64';
        if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
          decoded = await gunzip(bytes);
          kind = 'gzip'; desc = 'Decoded Base64 and decompressed gzip';
        } else {
          decoded = bytesToText(bytes);
          if (decoded !== null && !/^\s*[[{"]/.test(decoded)) decoded = null;
        }
        if (decoded !== null) {
          const r = await loadInner(decoded, layer + 1, opts || {});
          if (r.ok && isContainerNode(r.node)) return withSteps(r, { kind, desc });
        }
      } catch { /* not base64 */ }
    }
    if (/%[0-9A-Fa-f]{2}/.test(t)) {
      try {
        const dec = decodeURIComponent(t);
        if (dec !== t) {
          const r = await loadInner(dec, layer + 1, opts || {});
          if (r.ok && isContainerNode(r.node)) return withSteps(r, { kind: 'url', desc: 'Decoded URL-encoding (%XX)' });
        }
      } catch { /* malformed escape */ }
    }
    if (/&(quot|amp|lt|gt|apos|#\d+|#x[0-9a-fA-F]+);/.test(t)) {
      const dec = decodeEntities(t);
      if (dec !== t) {
        const r = await loadInner(dec, layer + 1, opts || {});
        if (r.ok && isContainerNode(r.node)) return withSteps(r, { kind: 'html', desc: 'Decoded HTML entities' });
      }
    }
    return null;
  }

  const PREFIX_LABELS = [
    [/(?:JSON\.parse|json\.loads|loads|parse)\s*\(\s*$/, 'Extracted the JSON string passed to a parse/loads call'],
    [/(?:-d|--data|--data-raw|--data-binary|--json)\s*=?\s*$/, 'Extracted the request body from a curl command'],
  ];

  /** JSON inside quoted strings or embedded in surrounding text (logs, code, curl). Lists every candidate. */
  async function extract(text, err, layer, opts) {
    if (text.length > SCAN_LIMIT) return null;
    const cands = [];

    // phase 1: quoted strings whose content is JSON (handles JSON.parse('{\"a\":1}'), "payload":"{\"a\":1}")
    let attempts = 0;
    for (let i = 0; i < text.length && attempts < 400; i++) {
      const c = text[i];
      if (c !== '"' && c !== "'" && c !== '`') continue;
      if (i > 0 && text[i - 1] === '\\') continue;
      attempts++;
      const p = new Parser(text, {});
      p.i = i;
      let sn;
      try { sn = p.parseString(''); } catch (e) { if (e instanceof ParseError) continue; throw e; }
      const end = p.i;
      if (!/^[[{]/.test(sn.v.trim())) { i = end - 1; continue; }
      const r = await unwrapString(sn.v, layer);
      if (r) { cands.push({ start: i, end, kind: 'string', res: r }); i = end - 1; }
    }

    // phase 2: bare {...} / [...] embedded in text
    const taken = (i) => cands.some((c) => i >= c.start && i < c.end);
    attempts = 0;
    for (let i = 0; i < text.length && attempts < 300; i++) {
      const c = text[i];
      if (c !== '{' && c !== '[') continue;
      if (taken(i)) continue;
      attempts++;
      const p = new Parser(text, {});
      let r;
      try { r = p.parseAt(i); } catch (e) { if (e instanceof ParseError) continue; throw e; }
      const empty = (r.node.t === 'obj' && !r.node.entries.length) || (r.node.t === 'arr' && !r.node.items.length);
      if (empty || r.end - i < 2) continue;
      const inf = inferFormat(p.features);
      cands.push({
        start: i, end: r.end, kind: 'embedded',
        res: okResult({ node: r.node, format: inf.format, alternatives: inf.alternatives, features: p.features, warnings: p.warnings, notStrict: p.features.size > 0 }, []),
      });
      i = r.end - 1;
    }
    if (!cands.length) return null;

    cands.sort((a, b) => a.start - b.start || b.end - a.end);
    // A candidate that sits inside a bigger one is part of it (e.g. an escaped string inside the payload object).
    for (let i = cands.length - 1; i >= 0; i--) {
      const c = cands[i];
      if (cands.some((o) => o !== c && o.start <= c.start && o.end >= c.end && (o.end - o.start) > (c.end - c.start))) cands.splice(i, 1);
    }
    let pick = Number.isInteger(opts && opts.pick) && opts.pick >= 0 && opts.pick < cands.length ? opts.pick : -1;
    if (pick < 0) {
      pick = 0;
      cands.forEach((c, i) => { if (c.end - c.start > cands[pick].end - cands[pick].start) pick = i; });
    }
    const chosen = cands[pick];
    const before = text.slice(Math.max(0, chosen.start - 60), chosen.start);
    let desc = chosen.start === 0 && chosen.end >= text.trim().length
      ? 'Extracted the JSON value' : `Extracted JSON from surrounding text (characters ${chosen.start + 1}–${chosen.end})`;
    for (const [re, label] of PREFIX_LABELS) if (re.test(before)) { desc = label; break; }
    const out = withSteps(chosen.res, { kind: 'extract', desc });
    if (cands.length > 1) {
      out.candidates = cands.map((c) => ({
        start: c.start, end: c.end, kind: c.kind,
        preview: text.slice(c.start, c.start + 70).replace(/\s+/g, ' '),
      }));
      out.picked = pick;
    }
    return out;
  }

  async function queryString(text) {
    const t = text.trim();
    if (!/^\??[\w.\-[\]%+]+=(?!=)[^\s&#]*(?:&[\w.\-[\]%+]+=(?!=)[^\s&#]*)*$/.test(t)) return null;
    const dec = (s) => { const x = s.replace(/\+/g, ' '); try { return decodeURIComponent(x); } catch { return x; } };
    const entries = t.replace(/^\?/, '').split('&').map((pair) => {
      const i = pair.indexOf('=');
      return { key: dec(pair.slice(0, i)), value: N.str(dec(pair.slice(i + 1))) };
    });
    return okResult({ node: N.obj(entries, 'query'), format: 'query', alternatives: [] },
      [{ kind: 'query', desc: 'Interpreted as a URL query string' }]);
  }

  const STRATEGIES = [
    concatenated,
    (t, e, l, o) => escapedCopy(t, e, l, o, false),
    (t, e, l, o) => decodeEncodings(t, l, o),
    extract,
    (t, e, l, o) => escapedCopy(t, e, l, o, true),
    (t) => queryString(t),
  ];

  async function loadInner(text, layer, opts) {
    if (!text.trim()) return { ok: false, error: new ParseError('Input is empty', 0, text) };
    const p = tryParse(text);
    // A root that is only a call / dotted name kept as text (JSON.parse('..'), a.b.c) is not a real result:
    // let the wrapper / encoding strategies look inside it first.
    const rootIsRepr = p.ok && p.node.t === 'str' && p.node.tag === 'repr';
    if (rootIsRepr && layer < MAX_LAYERS) {
      const err = new ParseError('Expression kept as text', 0, text);
      for (const strat of STRATEGIES) {
        const r = await strat(text, err, layer, opts);
        if (r) return r;
      }
      return okResult(p, []);
    }
    if (p.ok) {
      if (p.node.t === 'str' && layer < MAX_LAYERS) {
        const inner = await unwrapString(p.node.v, layer);
        if (inner) return withSteps(inner, { kind: 'string', desc: 'Unquoted and unescaped a JSON string literal' });
      }
      return okResult(p, []);
    }
    if (layer < MAX_LAYERS) {
      for (const strat of STRATEGIES) {
        const r = await strat(text, p.error, layer, opts);
        if (r) return r;
      }
    }
    return { ok: false, error: p.error };
  }

  // ------------------------------------------------------------------ repair (explicit, never automatic)
  function scanOpen(s) {
    const stack = [];
    let q = null, lastComma = -1;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (q) {
        if (c === '\\') i++;
        else if (c === q) q = null;
        continue;
      }
      if (c === '"' || c === "'") q = c;
      else if (c === '{' || c === '[' || c === '(') stack.push(c);
      else if (c === '}' || c === ']' || c === ')') stack.pop();
      else if (c === ',') lastComma = i;
    }
    return { stack, inString: q, lastComma };
  }

  /** Best-effort fixes for typographic quotes and truncated input. Returns {text, changes} or null. */
  function repair(input) {
    const changes = [];
    let s = input;
    const quoted = s.replace(/[“”„‟]/g, '"').replace(/[‘’‚‛]/g, "'");
    if (quoted !== s) { changes.push('Replaced typographic quotes with straight quotes'); s = quoted; }
    if (changes.length && tryParse(s).ok) return { text: s, changes };

    const CLOSE = { '{': '}', '[': ']', '(': ')' };
    for (let attempt = 0; attempt < 40; attempt++) {
      const st = scanOpen(s);
      const notes = [];
      let cand = s.replace(/\s+$/, '');
      if (st.inString) { cand += st.inString; notes.push('Closed an unterminated string'); }
      const trimmed = cand.replace(/[,\s]+$/, '');
      if (trimmed !== cand) { cand = trimmed; notes.push('Removed a trailing comma'); }
      if (/:$/.test(cand)) { cand += ' null'; notes.push('Gave a dangling key the value null'); }
      const closers = st.stack.slice().reverse().map((c) => CLOSE[c]).join('');
      if (closers) notes.push(`Appended ${closers.length} missing closing bracket${closers.length > 1 ? 's' : ''} "${closers}"`);
      const test = cand + closers;
      if (test !== input && tryParse(test).ok) return { text: test, changes: changes.concat(notes) };
      if (st.lastComma < 0) return null;
      changes.push('Dropped a trailing incomplete item');
      s = s.slice(0, st.lastComma);
    }
    return null;
  }

  // ------------------------------------------------------------------ embedded JSON inside string values
  function findEmbedded(root, limit) {
    const out = [];
    walk(root, (n, path) => {
      if (out.length >= (limit || 500)) return false;
      if (n.t !== 'str') return undefined;
      const t = n.v.trim();
      if (t.length < 2 || !((t[0] === '{' && t[t.length - 1] === '}') || (t[0] === '[' && t[t.length - 1] === ']'))) return undefined;
      const p = tryParse(n.v);
      if (p.ok && isContainerNode(p.node) && p.format !== 'python') out.push({ path, node: p.node });
      return undefined;
    });
    return out;
  }

  /** Replaces JSON-looking string values by their parsed content, in place (repeats for nested layers). */
  function expandEmbedded(root, maxRounds) {
    let total = 0;
    for (let round = 0; round < (maxRounds || 5); round++) {
      const found = findEmbedded(root);
      if (!found.length) break;
      for (const f of found) {
        const target = getAt(root, f.path);
        if (!target || target.t !== 'str') continue;
        for (const k of Object.keys(target)) delete target[k];
        Object.assign(target, f.node, { embedded: true });
        total++;
      }
    }
    log('info', 'expand-embedded', { replaced: total });
    return total;
  }

  // ------------------------------------------------------------------ public API
  function lineCol(text, pos) {
    let line = 1, last = -1;
    for (let i = text.indexOf('\n'); i !== -1 && i < pos; i = text.indexOf('\n', i + 1)) { line++; last = i; }
    return { line, col: pos - last };
  }
  function snippet(text, pos) {
    const ls = text.lastIndexOf('\n', pos - 1) + 1;
    let le = text.indexOf('\n', pos);
    if (le === -1) le = text.length;
    let line = text.slice(ls, le);
    let col = pos - ls;
    if (line.length > 140) { const from = Math.max(0, col - 60); line = (from ? '…' : '') + line.slice(from, from + 120); col = col - from + (from ? 1 : 0); }
    return { text: line, col };
  }

  async function load(input, opts) {
    opts = opts || {};
    const t0 = Date.now();
    let text = String(input);
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const maxChars = opts.maxChars || 50 * 1024 * 1024;
    if (text.length > maxChars) {
      return { ok: false, length: text.length, ms: 0, error: { message: `Input is too large (${(text.length / 1048576).toFixed(1)} MB, limit ${(maxChars / 1048576).toFixed(0)} MB)`, line: 1, col: 1, pos: 0 }, steps: [] };
    }
    let r;
    try {
      r = await loadInner(text, 0, opts);
    } catch (e) {
      log('error', 'load-crashed', { error: String(e), length: text.length });
      return { ok: false, length: text.length, ms: Date.now() - t0, error: { message: `Internal error: ${e.message || e}`, line: 1, col: 1, pos: 0 }, steps: [] };
    }
    const out = { ok: r.ok, length: text.length, ms: Date.now() - t0 };
    if (!r.ok) {
      const e = r.error;
      const sn = snippet(text, e.pos);
      out.error = { message: e.message, pos: e.pos, line: e.line, col: e.col, snippet: sn.text, snippetCol: sn.col };
      out.steps = [];
      out.repairable = !!repair(text);
      log('info', 'load-failed', { length: text.length, ms: out.ms, line: e.line, col: e.col, repairable: out.repairable });
      return out;
    }
    out.node = r.node;
    out.format = r.format;
    out.label = FORMAT_LABELS[r.format] || r.format;
    out.alternatives = r.alternatives;
    out.notStrict = r.notStrict;
    out.steps = r.steps;
    const direct = r.steps.length === 0;
    out.features = [...r.features].map(([name, pos]) => Object.assign(
      { name, label: FEATURE_LABELS[name] || name }, direct ? lineCol(text, pos) : {}));
    out.warnings = r.warnings.map((w) => Object.assign({ type: w.type, message: w.message }, direct ? lineCol(text, w.pos) : {}));
    if (r.candidates) { out.candidates = r.candidates; out.picked = r.picked; }
    log('info', 'load-ok', { format: r.format, steps: r.steps.map((s) => s.kind), length: text.length, ms: out.ms, warnings: out.warnings.length });
    return out;
  }

  JSS.loader = { load, repair, findEmbedded, expandEmbedded, unescapeLoose, decodeEntities };
  if (typeof module !== 'undefined' && module.exports) module.exports = JSS;
})(typeof self !== 'undefined' ? self : globalThis);
