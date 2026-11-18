'use strict';

(() => {
  const JSS = window.JSS;
  const { pathKey, pathToString, getAt, walk, children, countNodes } = JSS.ast;
  const { serialize } = JSS.fmt;
  const { FORMAT_LABELS } = JSS.parser;
  const log = JSS.log;

  // Verbose logging: localStorage['jsstudio.logLevel'] = 'debug'. Only sizes/flags are logged, never document content.
  JSS.setLogLevel(localStorage.getItem('jsstudio.logLevel') || 'info');

  const $ = (id) => document.getElementById(id);
  const PREFS_KEY = 'jsstudio.prefs.v1';
  const SESSION_KEY = 'jsstudio.session.v1'; // sessionStorage: per tab, so several studio tabs never clash
  const PENDING_PREFIX = 'js:pending:';
  const MAX_FILE_BYTES = 50 * 1024 * 1024;
  const TREE_BUDGET = 4000;
  const GUTTER_PX = 52; // room for the row-number gutter at the left of every tree row (matches .row::before in studio.css)
  const DIFF_BUDGET = 6000;
  const WORKER_MIN_CHARS = 200000;
  const VIEWS = ['raw', 'preview', 'tree'];
  const isUntitled = (n) => /^Untitled( \d+)?$/.test(n);
  const PICKER_TYPES = [{
    description: 'JSON / text',
    accept: {
      'application/json': ['.json', '.jsonc', '.json5', '.ndjson', '.jsonl', '.geojson'],
      'text/plain': ['.txt', '.log', '.py', '.rb', '.php', '.js'],
    },
  }];

  function h(tag, props, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) e.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    return e;
  }
  const debounce = (fn, ms) => { let t; const w = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; w.now = (...a) => { clearTimeout(t); fn(...a); }; return w; };
  const fmtBytes = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);
  /** 2, 4 or 'tab' when the text is already indented that way, else null (so edits keep the document's own layout). */
  function detectIndent(text) {
    const m = /\n([ \t]+)\S/.exec(text.slice(0, 20000));
    if (!m) return null;
    return m[1][0] === '\t' ? 'tab' : m[1].length === 2 ? 2 : m[1].length === 4 ? 4 : null;
  }
  const clampRatio = (v, dflt) => (Number.isFinite(Number(v)) && v !== null ? Math.min(0.85, Math.max(0.15, Number(v))) : dflt);
  const plural = (n, w) => `${n.toLocaleString()} ${w}${n === 1 ? '' : 's'}`;

  let toastTimer;
  function toast(msg, kind) {
    const t = $('toast');
    t.textContent = msg;
    t.className = `toast${kind === 'error' ? ' error' : ''}`;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, kind === 'error' ? 7000 : 2800);
  }
  const setStatus = (msg) => { $('status').textContent = msg || ''; };

  // ------------------------------------------------------------------ prefs
  const prefs = {
    theme: 'auto', mode: 'viewer', layout: 2, split: 0.5, stageSplit: 0.42, syncScroll: false, indent: '2', outStyle: 'auto', sort: false, depth: 2, ctab: 'tree',
    panes: { a: { view: 'raw', picked: false }, b: { view: 'raw', picked: false } },
    cmp: { order: true, array: 'index', arrayKey: 'id', ignore: '', tol: 0, caseI: false, trim: false, missing: false, collapse: true },
  };
  function loadPrefs() {
    try {
      const p = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}');
      Object.assign(prefs, p, {
        cmp: Object.assign(prefs.cmp, p.cmp || {}),
        panes: { a: Object.assign(prefs.panes.a, (p.panes || {}).a), b: Object.assign(prefs.panes.b, (p.panes || {}).b) },
      });
    } catch (err) { log('warn', 'prefs-load-failed', { error: String(err) }); }
    if (!['viewer', 'compare', 'validate'].includes(prefs.mode)) prefs.mode = 'viewer';
    prefs.split = clampRatio(prefs.split, 0.5);
    prefs.stageSplit = clampRatio(prefs.stageSplit, 0.42);
    prefs.syncScroll = prefs.syncScroll === true;
    prefs.layout = Number(prefs.layout) === 1 ? 1 : 2;
    for (const side of ['a', 'b']) if (!['raw', 'preview', 'tree'].includes(prefs.panes[side].view)) prefs.panes[side].view = 'raw';
  }
  const savePrefs = () => {
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch (err) { log('warn', 'prefs-save-failed', { error: String(err) }); }
  };

  // ------------------------------------------------------------------ parser worker
  let worker = null, wseq = 0;
  const pendingJobs = new Map();
  function getWorker() {
    if (worker !== null) return worker;
    if (typeof Worker === 'undefined') return (worker = false);
    try {
      worker = new Worker('worker.js');
      worker.onmessage = (e) => {
        const done = pendingJobs.get(e.data.id);
        if (done) { pendingJobs.delete(e.data.id); done(e.data.result); }
      };
      worker.onerror = (ev) => {
        log('error', 'worker-failed', { message: ev.message });
        for (const done of pendingJobs.values()) done({ ok: false, steps: [], error: { message: `Parser worker failed: ${ev.message}`, line: 1, col: 1, pos: 0 } });
        pendingJobs.clear();
        worker = false;
      };
    } catch (err) {
      log('warn', 'worker-unavailable', { error: String(err) });
      worker = false;
    }
    return worker;
  }
  function loadText(text, opts) {
    const w = text.length >= WORKER_MIN_CHARS ? getWorker() : false;
    if (!w) return JSS.loader.load(text, opts);
    return new Promise((resolve) => { const id = ++wseq; pendingJobs.set(id, resolve); w.postMessage({ id, text, opts }); });
  }

  // ------------------------------------------------------------------ clipboard & files
  async function copyText(text, what) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = h('textarea', { style: 'position:fixed;left:-9999px' });
      ta.value = text;
      document.body.append(ta);
      ta.select();
      const ok = document.execCommand && document.execCommand('copy');
      ta.remove();
      if (!ok) return toast('Could not copy to the clipboard.', 'error');
    }
    log('debug', 'copied', { what, chars: text.length });
    toast(`Copied ${what}`);
  }

  async function pickFile() {
    if (!window.showOpenFilePicker) throw new Error('This browser does not support the File System Access API.');
    const [handle] = await window.showOpenFilePicker({ types: PICKER_TYPES, excludeAcceptAllOption: false });
    const file = await handle.getFile();
    if (file.size > MAX_FILE_BYTES) throw new Error(`File is too large (${fmtBytes(file.size)}, limit ${fmtBytes(MAX_FILE_BYTES)}).`);
    log('info', 'file-picked', { name: file.name, bytes: file.size });
    return { handle, name: file.name, text: await file.text(), mtime: file.lastModified };
  }

  async function ensurePermission(handle, mode) {
    try {
      if ((await handle.queryPermission({ mode })) === 'granted') return true;
      return (await handle.requestPermission({ mode })) === 'granted';
    } catch (err) { log('error', 'permission-failed', { error: String(err) }); return false; }
  }

  // ------------------------------------------------------------------ recent files
  // File handles are kept in IndexedDB (they are structured-cloneable); without IndexedDB the list lives in memory for the session.
  const RECENT_MAX = 12;
  const recents = (() => {
    let mem = [];
    const idb = () => new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') return reject(new Error('no indexedDB'));
      const req = indexedDB.open('jsstudio', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('recent', { keyPath: 'name' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const tx = (db, mode, fn) => new Promise((resolve, reject) => {
      const t = db.transaction('recent', mode);
      const out = fn(t.objectStore('recent'));
      t.oncomplete = () => resolve(out && out.result);
      t.onerror = () => reject(t.error);
    });
    return {
      async add(handle) {
        const entry = { name: handle.name, handle, ts: Date.now() };
        mem = [entry, ...mem.filter((e) => e.name !== entry.name)].slice(0, RECENT_MAX);
        try {
          const db = await idb();
          await tx(db, 'readwrite', (st) => st.put(entry));
          const all = await tx(db, 'readonly', (st) => st.getAll());
          for (const old of all.sort((a, b) => b.ts - a.ts).slice(RECENT_MAX)) await tx(db, 'readwrite', (st) => st.delete(old.name));
        } catch (err) { log('debug', 'recent-store-unavailable', { error: String(err) }); }
      },
      async list() {
        try { const all = await tx(await idb(), 'readonly', (st) => st.getAll()); return all.sort((a, b) => b.ts - a.ts); } catch { return mem; }
      },
      async clear() {
        mem = [];
        try { await tx(await idb(), 'readwrite', (st) => st.clear()); } catch (err) { log('debug', 'recent-clear-skipped', { error: String(err) }); }
      },
    };
  })();

  /** A small popup menu anchored under `anchor`; closes on outside click or Escape. items: [{label, run}] */
  let openMenu = null;
  function showMenu(anchor, items, emptyText) {
    closeMenu();
    const r = anchor.getBoundingClientRect();
    const menu = h('div', { class: 'menu', role: 'menu', style: `left:${Math.max(4, Math.min(r.left, innerWidth - 240))}px;top:${r.bottom + 4}px` });
    if (!items.length) menu.append(h('div', { class: 'empty-item', text: emptyText }));
    for (const it of items) menu.append(it.sep ? h('div', { class: 'menu-sep', role: 'separator' }) : h('button', { role: 'menuitem', title: it.title || null, text: it.label, onclick: () => { closeMenu(); it.run(); } }));
    document.body.append(menu);
    openMenu = menu;
    const first = menu.querySelector('button');
    if (first) first.focus();
    setTimeout(() => document.addEventListener('mousedown', outside, true), 0);
    function outside(e) { if (!menu.contains(e.target)) closeMenu(); }
    menu.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); closeMenu(); anchor.focus(); } });
    menu.outside = outside;
  }
  function closeMenu() {
    if (!openMenu) return;
    document.removeEventListener('mousedown', openMenu.outside, true);
    openMenu.remove();
    openMenu = null;
  }

  // ------------------------------------------------------------------ result info (chips, steps, errors)
  function resultInfo(res, ctx) {
    const box = h('div', { class: 'info' });
    if (!res) return box;
    if (!res.ok) {
      const e = res.error;
      const err = h('div', { class: 'err' }, h('strong', { text: `Line ${e.line}, column ${e.col}: ` }), e.message);
      if (e.snippet !== undefined) err.append(h('pre', { text: `${e.snippet}\n${' '.repeat(Math.max(0, e.snippetCol))}^` }));
      const acts = h('div', { class: 'actions' });
      if (ctx.goTo && e.pos !== undefined) acts.append(h('button', { class: 'tb', text: 'Go to error', onclick: () => ctx.goTo(e.pos) }));
      if (res.repairable && ctx.repair) acts.append(h('button', { class: 'tb accent', text: 'Try repair…', onclick: ctx.repair }));
      if (acts.childNodes.length) err.append(acts);
      box.append(err);
      return box;
    }
    const chips = h('div', { class: 'chips' }, h('span', { class: 'chip', text: res.label }));
    if (res.alternatives && res.alternatives.length) {
      chips.append(h('span', { class: 'chip warn', title: 'The text is also valid in these formats', text: `or ${res.alternatives.map((a) => FORMAT_LABELS[a] || a).join(' / ')}` }));
    }
    if (res.notStrict) chips.append(h('span', { class: 'chip warn', text: 'not strict JSON' }));
    if (res.warnings.length) chips.append(h('span', { class: 'chip warn', text: plural(res.warnings.length, 'warning') }));
    box.append(chips);
    if (res.steps.length) box.append(h('ol', { class: 'steps' }, res.steps.map((s) => h('li', { text: s.desc }))));
    if (res.candidates && res.candidates.length > 1 && ctx.pick) {
      box.append(h('label', { class: 'check' }, 'JSON candidates: ',
        h('select', { class: 'field', onchange: (ev) => ctx.pick(parseInt(ev.target.value, 10)) },
          res.candidates.map((c, i) => h('option', { value: String(i), selected: i === res.picked, text: `#${i + 1} (chars ${c.start + 1}–${c.end}) ${c.preview}` })))));
    }
    const loc = (x) => (x.line ? ` (line ${x.line}, col ${x.col})` : '');
    const rows = [];
    if (res.notStrict && res.features.length) rows.push(h('li', {}, h('strong', { text: 'Not strict JSON: ' }), res.features.map((f) => f.label + loc(f)).join('; ')));
    for (const w of res.warnings.slice(0, 30)) rows.push(h('li', { text: w.message + loc(w) }));
    if (rows.length) box.append(h('details', { class: 'more' }, h('summary', { text: 'Details' }), h('ul', {}, rows)));
    return box;
  }

  // ====================================================================== preview highlighting
  const HIGHLIGHT_MAX = 600000;
  const PREVIEW_MAX = 2000000;
  const TOKEN_RE = /("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*')(\s*:)?|\b(?:true|false|null|True|False|None|undefined)\b|-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b|NaN|-?Infinity/g;
  /** Colours tokens with spans built from text nodes (never innerHTML). Plain text beyond HIGHLIGHT_MAX. */
  function highlightInto(pre, text) {
    pre.replaceChildren();
    if (text.length > HIGHLIGHT_MAX) { pre.textContent = text.length > PREVIEW_MAX ? `${text.slice(0, PREVIEW_MAX)}\n… truncated in this view. Copy, Download and Save formatted give the full text.` : text; return; }
    const frag = document.createDocumentFragment();
    let last = 0, m;
    TOKEN_RE.lastIndex = 0;
    while ((m = TOKEN_RE.exec(text))) {
      if (m.index > last) frag.append(text.slice(last, m.index));
      const cls = m[1] ? (m[2] ? 'p-key' : 'p-str') : /^-?\d|Infinity|NaN/.test(m[0]) ? 'p-num' : 'p-kw';
      frag.append(h('span', { class: cls, text: m[1] || m[0] }));
      if (m[2]) frag.append(m[2]);
      last = TOKEN_RE.lastIndex;
    }
    if (last < text.length) frag.append(text.slice(last));
    pre.append(frag);
  }

  /** A small modal form. Resolves to {name: value} on submit, or null when cancelled (Esc, click outside, Cancel). */
  function askForm(title, fields, submitLabel) {
    return new Promise((resolve) => {
      const prev = document.activeElement;
      const controls = {};
      const rows = fields.map((f) => {
        const c = f.type === 'select'
          ? h('select', { class: 'field' }, f.options.map(([v, l]) => h('option', { value: v, selected: v === f.value, text: l })))
          : h('input', { class: 'field', type: 'text', value: f.value || '', placeholder: f.placeholder || null, spellcheck: 'false', autocomplete: 'off' });
        controls[f.name] = c;
        return h('label', { class: 'modal-row' }, h('span', { text: f.label }), c, f.hint ? h('small', { class: 'meta', text: f.hint }) : null);
      });
      const done = (vals) => { overlay.remove(); if (prev && prev.focus && document.contains(prev)) prev.focus(); resolve(vals); };
      const form = h('form', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
        h('h2', { text: title }), ...rows,
        h('div', { class: 'modal-actions' }, h('button', { type: 'button', class: 'btn', text: 'Cancel', onclick: () => done(null) }), h('button', { type: 'submit', class: 'btn primary', text: submitLabel || 'OK' })));
      const overlay = h('div', { class: 'modal-overlay' }, form);
      form.addEventListener('submit', (e) => { e.preventDefault(); done(Object.fromEntries(Object.entries(controls).map(([k, c]) => [k, c.value]))); });
      overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(null); } });
      overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) done(null); });
      document.body.append(overlay);
      Object.values(controls)[0].focus();
    });
  }

  /** The Transform menu (also the palette's transform commands). Every entry rewrites the pane's document text. */
  function transformDefs(p) {
    const T = JSS.transform;
    const run = (label, fn) => () => p.runTransform(label, fn);
    return [
      { label: 'Sort keys A → Z', title: 'Alphabetical (natural: k2 before k10), at every depth', run: run('Sort keys', (n) => T.sortKeys(n, { order: 'asc' })) },
      { label: 'Sort keys Z → A', run: run('Sort keys', (n) => T.sortKeys(n, { order: 'desc' })) },
      { label: 'Sort arrays…', title: 'By a field (price, owner.name) or by value, ascending or descending', run: () => p.askSortArrays() },
      { sep: true },
      { label: 'Pretty-print (2 spaces)', run: run('Pretty-print', (n) => ({ node: n, changes: 1, indent: 2 })) },
      { label: 'Pretty-print (4 spaces)', run: run('Pretty-print', (n) => ({ node: n, changes: 1, indent: 4 })) },
      { label: 'Pretty-print (tabs)', run: run('Pretty-print', (n) => ({ node: n, changes: 1, indent: 'tab' })) },
      { label: 'Minify', title: 'Remove all whitespace', run: run('Minify', (n) => ({ node: n, changes: 1, indent: 0 })) },
      { sep: true },
      { label: 'Remove nulls and empty values', title: 'null, "", [] and {} (a container emptied by this is removed too)', run: run('Remove empty values', (n) => T.removeEmpty(n)) },
      { label: 'Remove duplicate array items', run: run('Remove duplicates', (n) => T.dedupe(n)) },
      { label: 'Flatten to dotted keys', title: '{"a": {"b": 1}} becomes {"a.b": 1}', run: run('Flatten', (n) => T.flatten(n)) },
      { label: 'Unflatten dotted keys', title: '{"a.b": 1} becomes {"a": {"b": 1}}', run: run('Unflatten', (n) => T.unflatten(n)) },
      { label: 'Stringify (escape as a JSON string)', run: run('Stringify', (n) => T.stringify(n)) },
      { label: 'Parse a JSON string (unescape)', title: 'Replace escaped / quoted JSON text with the document it contains', run: run('Parse string', (n) => (p.res.steps.some((st) => ['string', 'unescape', 'url', 'html'].includes(st.kind)) ? { node: n, changes: 1, note: 'the unwrapped document replaced the escaped text' } : T.unescape(n))) },
      { sep: true },
      { label: 'Convert to JSON', run: run('Convert to JSON', (n) => ({ node: n, changes: 1, style: 'json' })) },
      { label: 'Convert to Python', run: run('Convert to Python', (n) => ({ node: n, changes: 1, style: 'python' })) },
      { label: 'Convert to JavaScript', run: run('Convert to JavaScript', (n) => ({ node: n, changes: 1, style: 'js' })) },
    ];
  }

  // ====================================================================== code editor (line numbers, colours, find, brackets)
  const EDITOR_HL_MAX = 200000; // beyond this the colour layers are dropped and the textarea shows plain text
  const LINE_H = 20; // must match line-height in studio.css (.ed-gutter, .ed-hl, .editor textarea)

  /** Draws `ranges` ([{start,end,cls?}], sorted, non-overlapping) as <mark>s over a copy of `text` in `pre`. */
  function drawMarks(pre, text, ranges) {
    if (!ranges.length) { pre.replaceChildren(); return; }
    const frag = document.createDocumentFragment();
    let last = 0;
    for (const r of ranges) {
      if (r.start > last) frag.append(text.slice(last, r.start));
      frag.append(h('mark', { class: r.cls || null, text: text.slice(r.start, r.end) }));
      last = r.end;
    }
    frag.append(text.slice(last));
    pre.replaceChildren(frag);
  }

  /** Wraps `.editor` markup: a transparent textarea over coloured / find / bracket layers, plus a line-number gutter, all scrolled together. */
  class Editor {
    constructor(root, name) {
      this.root = root; this.name = name;
      this.ta = root.querySelector('textarea');
      this.hl = root.querySelector('.ed-hl');
      this.findLayer = root.querySelector('.ed-find');
      this.brkLayer = root.querySelector('.ed-brk');
      this.gutter = root.querySelector('.ed-gutter');
      this.layers = [this.hl, this.findLayer, this.brkLayer];
      this.text = null; this.lines = 0;
      this.find = { open: false, matches: [], idx: -1, regex: false, cs: false };
      this.releaseTab = false;
      this.buildFindBar();
      this.ta.addEventListener('scroll', () => this.sync());
      this.ta.addEventListener('keydown', (e) => this.onKey(e));
      for (const ev of ['keyup', 'mouseup', 'focus']) this.ta.addEventListener(ev, () => this.drawBracket());
      this.ta.addEventListener('blur', () => { this.releaseTab = false; this.brkLayer.replaceChildren(); });
    }
    sync() {
      const top = this.ta.scrollTop, left = this.ta.scrollLeft;
      this.gutter.scrollTop = top;
      for (const l of this.layers) { l.scrollTop = top; l.scrollLeft = left; }
    }
    /** Re-colour and renumber from the textarea value; a no-op when the text did not change. */
    refresh() {
      const text = this.ta.value;
      if (text === this.text) return;
      this.text = text;
      let n = 1;
      for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) n++;
      if (n !== this.lines) {
        this.lines = n;
        this.gutter.textContent = Array.from({ length: n }, (_, i) => i + 1).join('\n');
      }
      const plain = text.length > EDITOR_HL_MAX;
      this.root.classList.toggle('plain', plain);
      if (plain) this.hl.replaceChildren(); else highlightInto(this.hl, text);
      if (this.find.open) this.runFind(false);
      this.drawBracket();
      this.sync();
    }
    scrollToLine(line) { this.ta.scrollTop = Math.max(0, (line - 4) * LINE_H); }
    lineOf(pos) { let n = 1; for (let i = this.ta.value.indexOf('\n'); i !== -1 && i < pos; i = this.ta.value.indexOf('\n', i + 1)) n++; return n; }

    // ------------------------------------------------------------ brackets
    drawBracket() {
      const ta = this.ta, text = ta.value;
      if (text.length > EDITOR_HL_MAX || document.activeElement !== ta || ta.selectionStart !== ta.selectionEnd) { this.brkLayer.replaceChildren(); return; }
      const pair = JSS.editing.bracketPair(text, ta.selectionStart);
      if (!pair) { this.brkLayer.replaceChildren(); return; }
      drawMarks(this.brkLayer, text, [{ start: pair[0], end: pair[0] + 1 }, { start: pair[1], end: pair[1] + 1 }]);
    }

    // ------------------------------------------------------------ keys: Enter, Tab, find
    /** Replace [from,to) with `ins` through the browser's edit stack (keeps native undo), falling back to setRangeText. */
    insert(from, to, ins) {
      const ta = this.ta;
      ta.setSelectionRange(from, to);
      if (!(document.execCommand && document.execCommand('insertText', false, ins) && ta.value.slice(from, from + ins.length) === ins)) {
        ta.setRangeText(ins, from, to, 'end');
        ta.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }
    onKey(e) {
      const ta = this.ta, mod = e.ctrlKey || e.metaKey;
      if (e.isComposing) return;
      if (mod && !e.altKey && e.key.toLowerCase() === 'f') { e.preventDefault(); this.openFind(); return; }
      if (e.key === 'Escape') { if (this.find.open) { this.closeFind(); e.stopPropagation(); } else this.releaseTab = true; return; }
      if (mod || e.altKey) return;
      const start = ta.selectionStart, end = ta.selectionEnd, value = ta.value;
      if (e.key === 'Enter' && !e.shiftKey && !ta.readOnly) {
        e.preventDefault();
        const r = JSS.editing.enter(value, start, end);
        const ins = r.text.slice(start, r.text.length - (value.length - end));
        this.insert(start, end, ins);
        ta.setSelectionRange(r.caret, r.caret);
        this.drawBracket();
      } else if (e.key === 'Tab' && !ta.readOnly) {
        if (this.releaseTab) { this.releaseTab = false; return; } // Esc then Tab leaves the editor (keyboard users are never trapped)
        e.preventDefault();
        const r = JSS.editing.tab(value, start, end, e.shiftKey);
        const from = value.slice(start, end).includes('\n') || e.shiftKey ? value.lastIndexOf('\n', start - 1) + 1 : start;
        const to = value.slice(start, end).includes('\n') || e.shiftKey ? end : end;
        this.insert(from, to, r.text.slice(from, r.text.length - (value.length - to)));
        ta.setSelectionRange(r.start, r.end);
      }
    }

    // ------------------------------------------------------------ find / replace
    buildFindBar() {
      const f = this.find;
      const term = h('input', { type: 'text', class: 'field', placeholder: 'Find', 'aria-label': 'Find', spellcheck: 'false' });
      const repl = h('input', { type: 'text', class: 'field', placeholder: 'Replace with', 'aria-label': 'Replace with', spellcheck: 'false' });
      const rx = h('input', { type: 'checkbox', 'aria-label': 'Regular expression' });
      const cs = h('input', { type: 'checkbox', 'aria-label': 'Match case' });
      const count = h('span', { class: 'meta', role: 'status' });
      const btn = (text, title, fn) => h('button', { class: 'tb', text, title, onclick: fn });
      this.fb = { term, repl, count };
      this.bar = h('div', { class: 'findbar', hidden: true },
        term, h('label', { class: 'check', title: 'Regular expression' }, rx, '.*'), h('label', { class: 'check', title: 'Match case' }, cs, 'Aa'), count,
        btn('↑', 'Previous match (Shift+Enter)', () => this.step(-1)), btn('↓', 'Next match (Enter)', () => this.step(1)),
        repl, btn('Replace', 'Replace the current match', () => this.replaceCurrent()), btn('All', 'Replace every match', () => this.replaceEvery()),
        btn('✕', 'Close (Esc)', () => this.closeFind()));
      this.root.before(this.bar);
      term.addEventListener('input', () => this.runFind(true));
      rx.addEventListener('change', () => { f.regex = rx.checked; this.runFind(true); });
      cs.addEventListener('change', () => { f.cs = cs.checked; this.runFind(true); });
      for (const el of [term, repl]) el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); if (el === repl) this.replaceCurrent(); else this.step(e.shiftKey ? -1 : 1); }
        else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.closeFind(); }
      });
    }
    openFind() {
      const sel = this.ta.value.slice(this.ta.selectionStart, this.ta.selectionEnd);
      this.find.open = true;
      this.bar.hidden = false;
      if (sel && !sel.includes('\n') && sel.length < 200) this.fb.term.value = sel;
      this.fb.term.focus();
      this.fb.term.select();
      this.runFind(true);
      log('debug', 'find-open', { editor: this.name });
    }
    closeFind() {
      this.find.open = false;
      this.bar.hidden = true;
      this.findLayer.replaceChildren();
      this.ta.focus();
    }
    runFind(jump) {
      const f = this.find, text = this.ta.value, termText = this.fb.term.value;
      const r = JSS.find.findAll(text, termText, { regex: f.regex, caseSensitive: f.cs });
      f.matches = r.matches;
      this.fb.term.classList.toggle('bad', Boolean(r.error));
      if (jump || f.idx >= f.matches.length || f.idx < 0) {
        const at = this.ta.selectionStart;
        const i = f.matches.findIndex((m) => m.start >= at);
        f.idx = f.matches.length ? (i === -1 ? 0 : i) : -1;
      }
      this.drawFind(jump && f.idx >= 0);
      this.fb.count.textContent = r.error ? 'invalid regex' : !termText ? '' : f.matches.length ? `${f.idx + 1} / ${f.matches.length}${r.truncated ? '+' : ''}` : 'no matches';
      log('debug', 'find-run', { editor: this.name, termLength: termText.length, matches: f.matches.length, regex: f.regex });
    }
    drawFind(reveal) {
      const f = this.find, text = this.ta.value;
      if (text.length > EDITOR_HL_MAX) this.findLayer.replaceChildren();
      else drawMarks(this.findLayer, text, f.matches.map((m, i) => ({ start: m.start, end: m.end, cls: i === f.idx ? 'cur' : null })));
      if (reveal && f.idx >= 0) {
        const m = f.matches[f.idx];
        this.ta.setSelectionRange(m.start, m.end);
        const line = this.lineOf(m.start);
        const top = (line - 1) * LINE_H;
        if (top < this.ta.scrollTop || top > this.ta.scrollTop + this.ta.clientHeight - 3 * LINE_H) this.ta.scrollTop = Math.max(0, top - this.ta.clientHeight / 2);
      }
      this.sync();
    }
    step(d) {
      const f = this.find;
      if (!f.matches.length) return;
      f.idx = (f.idx + d + f.matches.length) % f.matches.length;
      this.drawFind(true);
      this.fb.count.textContent = `${f.idx + 1} / ${f.matches.length}`;
    }
    replaceCurrent() {
      const f = this.find;
      if (this.ta.readOnly || f.idx < 0 || !f.matches[f.idx]) return;
      const m = f.matches[f.idx];
      const r = JSS.find.replaceOne(this.ta.value, m, this.fb.term.value, this.fb.repl.value, { regex: f.regex, caseSensitive: f.cs });
      const ins = r.text.slice(m.start, r.caret);
      this.insert(m.start, m.end, ins);
      this.ta.setSelectionRange(r.caret, r.caret);
      this.refresh();
      this.runFind(true);
      log('info', 'find-replace-one', { editor: this.name });
    }
    replaceEvery() {
      const f = this.find;
      if (this.ta.readOnly) return toast('This view is a read-only export. Replace in Raw instead.', 'error');
      const r = JSS.find.replaceAll(this.ta.value, this.fb.term.value, this.fb.repl.value, { regex: f.regex, caseSensitive: f.cs });
      if (!r.count) return;
      this.ta.setSelectionRange(0, this.ta.value.length);
      if (!(document.execCommand && document.execCommand('insertText', false, r.text) && this.ta.value === r.text)) {
        this.ta.value = r.text;
        this.ta.dispatchEvent(new Event('input', { bubbles: true }));
      }
      this.refresh();
      this.runFind(true);
      toast(`Replaced ${r.count.toLocaleString()} ${r.count === 1 ? 'match' : 'matches'}${r.truncated ? ' (the first ' + JSS.find.MAX_MATCHES + ')' : ''}`);
      log('info', 'find-replace-all', { editor: this.name, count: r.count });
    }
  }

  // ====================================================================== DOCUMENT PANE (two instances: A and B)
  const trunc = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s);

  function valueSpan(n, open) {
    switch (n.t) {
      case 'str': {
        const full = JSON.stringify(n.v);
        return h('span', { class: 'val v-str', title: full.length > 300 ? trunc(n.v, 2000) : null, text: trunc(full, 300) });
      }
      case 'num': return h('span', { class: 'val v-num', text: n.raw });
      case 'bool': return h('span', { class: 'val v-bool', text: String(n.v) });
      case 'null': return h('span', { class: 'val v-null', text: n.tag === 'undefined' ? 'undefined' : 'null' });
      default: {
        const count = n.t === 'obj' ? n.entries.length : n.items.length;
        let text = n.t === 'obj' ? `{${count}}` : `[${count}]`;
        if (!open && n.t === 'obj' && count) text += ` { ${n.entries.slice(0, 4).map((e) => e.key).join(', ')}${count > 4 ? ', …' : ''} }`;
        return h('span', { class: 'v-sum', text });
      }
    }
  }
  function badges(n) {
    const out = [];
    if (n.tag && n.tag !== 'documents') out.push(h('span', { class: `badge${n.tag === 'repr' ? ' warn' : ''}`, title: n.tag === 'repr' ? 'Not a literal: kept as text' : null, text: n.tag }));
    if (n.embedded) out.push(h('span', { class: 'badge', title: 'Parsed from a JSON string', text: 'parsed from string' }));
    return out;
  }

  const panes = {};
  let activePane = null;
  let maxSide = null; // pane filling the whole row, or null

  class DocPane {
    constructor(side) {
      this.side = side;
      this.root = $('paneTpl').content.firstElementChild.cloneNode(true);
      this.root.dataset.pane = side;
      this.q('[data-label]').textContent = side.toUpperCase();
      this.input = this.q('[data-input]');
      this.pinput = this.q('[data-pinput]');
      this.rawEd = new Editor(this.q('[data-editor="raw"]'), `${side}:raw`);
      this.prevEd = new Editor(this.q('[data-editor="preview"]'), `${side}:preview`);
      Object.assign(this, {
        undo: [], redo: [], selKey: null, // per-document edit history (whole-document snapshots) and the keyboard-selected tree row
        tabs: [null], tab: 0, skipScroll: null, renaming: false,
        pvKeep: null, // text typed in the Preview editor; kept as shown (not re-formatted) while it equals the raw text
        pendingEdit: null,
        text: '', res: null, seq: 0, pick: undefined, view: prefs.panes[side].view, depth: prefs.depth,
        expanded: new Set(), collapsed: new Set(), limits: new Map(), term: '', matches: [], matchKeys: new Set(), visible: new Set(),
        idx: -1, curKey: null, filter: false, handle: null, name: 'Untitled', mtime: 0, dirty: false, embedded: 0, nodes: 0,
        query: null, queryOpen: false, repairInfo: null, fmtText: '', onResult: () => {},
      });
      this.rowInfo = new WeakMap();
      this.rowEls = new Map();
      const conv = h('optgroup', { label: 'Export (read-only)' }, Object.entries(JSS.convert.CONVERTERS).map(([k, c]) => h('option', { value: k, text: c.label })));
      this.q('[data-f-style]').append(conv);
      this.scheduleReload = debounce(() => this.reload(), 250);
      this.runSearchDebounced = debounce(() => this.runSearch(), 200);
      this.bind();
    }
    q(sel) { return this.root.querySelector(sel); }
    qa(sel) { return [...this.root.querySelectorAll(sel)]; }
    get ok() { return Boolean(this.res && this.res.ok); }
    label() { return this.side.toUpperCase(); }

    // ---------------------------------------------------------------- wiring
    bind() {
      this.input.addEventListener('input', () => { this.rawEd.refresh(); this.pick = undefined; this.repairInfo = null; this.dirty = true; this.scheduleReload(); persistSession(); });
      // editing the Preview edits the document: the text as shown becomes the raw text
      this.pinput.addEventListener('input', () => {
        this.input.value = this.pinput.value;
        this.pvKeep = this.pinput.value;
        this.prevEd.refresh(); this.rawEd.refresh();
        this.pick = undefined; this.repairInfo = null; this.dirty = true;
        log('debug', 'preview-edit', { pane: this.side, chars: this.pinput.value.length });
        this.scheduleReload(); persistSession();
      });
      this.root.addEventListener('focusin', () => setActive(this));
      this.root.addEventListener('mousedown', () => setActive(this));
      this.q('[data-views]').addEventListener('click', (e) => { const b = e.target.closest('[data-view]'); if (b) this.setView(b.dataset.view, true); });
      this.q('[data-tabs]').addEventListener('click', (e) => {
        const close = e.target.closest('[data-close]');
        if (close) { e.stopPropagation(); return this.closeTab(Number(close.dataset.close)); }
        const t = e.target.closest('[data-tab]');
        if (t) this.loadTab(Number(t.dataset.tab));
      });
      this.q('[data-tabs]').addEventListener('dblclick', (e) => {
        const t = e.target.closest('[data-tab]');
        if (t && !e.target.closest('[data-close]')) this.renameTab(Number(t.dataset.tab));
      });
      for (const [el, name] of [[this.input, 'raw'], [this.pinput, 'preview'], [this.q('[data-tree]'), 'tree']]) el.addEventListener('scroll', () => this.onScroll(el, name));
      this.q('[data-tree]').addEventListener('keydown', (e) => this.onTreeKey(e));
      this.root.addEventListener('click', (e) => {
        const b = e.target.closest('[data-act]');
        if (!b) return;
        const actions = {
          open: () => this.open(), paste: () => this.paste(), clear: () => this.clear(),
          save: () => this.save(false), saveas: () => this.save(true), apply: () => this.applyFormat(),
          'copy-raw': () => this.input.value && copyText(this.input.value, 'raw text'),
          'copy-fmt': () => this.fmtText && copyText(this.fmtText, 'formatted output'),
          download: () => this.download(), 'save-fmt': () => this.saveFormatted(),
          'find-raw': () => this.rawEd.openFind(), 'find-preview': () => this.prevEd.openFind(),
          undo: () => this.undoEdit(), redo: () => this.redoEdit(),
          transform: () => showMenu(b, transformDefs(this), ''),
          max: () => setMax(maxSide === this.side ? null : this.side),
          newtab: () => this.newTab(), recent: () => this.showRecent(b),
          prev: () => this.goToMatch(this.idx - 1), next: () => this.goToMatch(this.idx + 1),
          'expand-all': () => this.act_expand(),
          'collapse-all': () => this.act_collapse(),
          embedded: () => {
            const n = JSS.loader.expandEmbedded(this.res.node);
            toast(`Expanded ${plural(n, 'embedded value')}`);
            this.syncInputFromTree();
          },
        };
        if (actions[b.dataset.act]) actions[b.dataset.act]();
      });
      this.q('[data-search]').addEventListener('input', () => this.runSearchDebounced());
      this.q('[data-search]').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); if (this.term) this.goToMatch(this.idx + (e.shiftKey ? -1 : 1)); } });
      this.q('[data-filter]').addEventListener('change', (e) => { this.filter = e.target.checked; this.render(); });
      this.q('[data-query]').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); this.runQuery(); } });
      this.q('[data-query]').addEventListener('input', (e) => { if (!e.target.value.trim()) this.runQuery(); });
      this.q('[data-depth]').addEventListener('change', (e) => { this.depth = Number(e.target.value); prefs.depth = this.depth; savePrefs(); this.collapsed.clear(); this.expanded.clear(); this.renderTree(); });
      this.q('[data-f-style]').addEventListener('change', (e) => { panes.a.pvKeep = panes.b.pvKeep = null; prefs.outStyle = e.target.value; savePrefs(); panes.a.refreshPreview(); panes.b.refreshPreview(); });
      this.q('[data-f-indent]').addEventListener('change', (e) => { panes.a.pvKeep = panes.b.pvKeep = null; prefs.indent = e.target.value; savePrefs(); panes.a.refreshPreview(); panes.b.refreshPreview(); });
      this.q('[data-f-sort]').addEventListener('change', (e) => { panes.a.pvKeep = panes.b.pvKeep = null; prefs.sort = e.target.checked; savePrefs(); panes.a.refreshPreview(); panes.b.refreshPreview(); });

      const tree = this.q('[data-tree]');
      tree.addEventListener('click', (e) => this.onTreeClick(e));
      tree.addEventListener('dblclick', (e) => this.onTreeDblClick(e));
    }

    act_expand() { this.depth = 99; this.collapsed.clear(); this.expanded.clear(); this.q('[data-depth]').value = '99'; this.renderTree(); }
    act_collapse() { this.depth = 1; this.collapsed.clear(); this.expanded.clear(); this.q('[data-depth]').value = '1'; this.renderTree(); }

    // ---------------------------------------------------------------- loading
    async reload(opts) {
      opts = opts || {};
      const text = this.input.value;
      this.text = text;
      this.rawEd.refresh(); // colours + line numbers also for programmatic changes (open, paste, repair, tree edits)
      const seq = ++this.seq;
      if (!text.trim()) {
        this.res = null; this.nodes = 0; this.embedded = 0;
        this.resetView();
        this.render();
        this.onResult();
        return;
      }
      setStatus('Parsing…');
      const res = await loadText(text, { pick: this.pick });
      if (seq !== this.seq) { log('debug', 'stale-result-dropped', { pane: this.side, seq }); return; }
      setStatus('');
      this.res = res;
      this.nodes = res.ok ? countNodes(res.node) : 0;
      this.embedded = res.ok && text.length < 3000000 ? JSS.loader.findEmbedded(res.node, 200).length : 0;
      if (!opts.keepView) this.resetView(); else if (this.term) this.runSearch(true);
      $('stLeft').textContent = res.ok ? `${this.label()}: ${res.label} · parsed in ${res.ms} ms` : `${this.label()}: parse error`;
      this.render();
      this.onResult();
    }

    resetView() {
      this.expanded.clear(); this.collapsed.clear(); this.limits.clear(); this.curKey = null; this.idx = -1;
      this.query = null; this.queryOpen = false;
      this.runSearch(true);
    }

    setFile(f) {
      if (this.input.value.trim()) this.pushBlankTab(); // keep the document that is already here; the file opens in its own tab
      this.input.value = f.text;
      if (f.handle) recents.add(f.handle);
      this.handle = f.handle || null; this.name = f.name; this.mtime = f.mtime || 0; this.dirty = false; this.pick = undefined; this.repairInfo = null;
      this.reload();
      persistSession();
    }

    // ---------------------------------------------------------------- tabs (several documents per pane)
    snapshot() {
      this.tabs[this.tab] = { text: this.input.value, name: this.name, view: this.view, handle: this.handle, mtime: this.mtime, dirty: this.dirty, undo: this.undo, redo: this.redo };
    }
    applyDoc(d) {
      this.input.value = d.text; this.name = d.name; this.handle = d.handle; this.mtime = d.mtime; this.dirty = d.dirty;
      this.undo = d.undo; this.redo = d.redo;
      // every tab keeps its own view: switching tabs switches Raw / Preview / Tree with it
      this.view = VIEWS.includes(d.view) ? d.view : 'raw';
      prefs.panes[this.side].view = this.view;
      this.pick = undefined; this.repairInfo = null; this.pvKeep = null; this.selKey = null;
    }
    blankDoc() { return { text: '', name: this.nextUntitled(), view: 'raw', handle: null, mtime: 0, dirty: false, undo: [], redo: [] }; }
    /** 'Untitled' for the first, then 'Untitled 2', 'Untitled 3'… (the lowest number not in use in this pane). */
    nextUntitled() {
      const used = new Set(this.tabs.map((d, i) => (i === this.tab ? this.name : d && d.name)));
      if (!used.has('Untitled')) return 'Untitled';
      for (let n = 2; ; n++) if (!used.has(`Untitled ${n}`)) return `Untitled ${n}`;
    }
    /** Inline rename of tab `i` (double-click the tab, or the palette). A tab linked to a file on disk is detached from it. */
    renameTab(i) {
      const strip = this.q('[data-tabs]');
      const btn = strip.querySelector(`[data-tab="${i}"]`);
      if (!btn || this.renaming) return;
      if (i !== this.tab) this.loadTab(i);
      const cur = this.q(`[data-tab="${i}"]`);
      const input = h('input', { class: 'field tab-edit', value: this.name, 'aria-label': 'Document name', maxlength: '80', size: String(Math.max(8, Math.min(30, this.name.length + 2))) });
      this.renaming = true;
      cur.replaceWith(input);
      input.focus();
      input.select();
      let done = false;
      const finish = (commit) => {
        if (done) return;
        done = true;
        this.renaming = false;
        const name = input.value.trim().replace(/[\\/\u0000-\u001f]/g, '-');
        if (commit && name && name !== this.name) {
          if (this.handle && !confirm(`"${this.name}" is linked to a file on disk. Renaming detaches this tab from it: Save will ask where to save "${name}".\n\nContinue?`)) { this.renderTabs(); return; }
          log('info', 'tab-rename', { pane: this.side, detached: Boolean(this.handle) });
          this.name = name;
          if (this.handle) { this.handle = null; this.mtime = 0; }
          this.dirty = false;
          persistSession();
        }
        this.render();
      };
      input.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); finish(true); } else if (e.key === 'Escape') { e.preventDefault(); finish(false); } });
      input.addEventListener('blur', () => finish(true));
    }
    /** Adds an empty document and makes it current, without re-parsing (the caller fills it in). */
    pushBlankTab() {
      this.snapshot();
      this.tabs.push(this.blankDoc());
      this.tab = this.tabs.length - 1;
      this.applyDoc(this.tabs[this.tab]);
      log('info', 'tab-new', { pane: this.side, tabs: this.tabs.length });
    }
    newTab() { this.pushBlankTab(); this.reload(); persistSession(); if (this.view === 'raw') this.input.focus(); }
    loadTab(i) {
      if (i === this.tab || !this.tabs[i]) return;
      this.snapshot();
      this.tab = i;
      this.applyDoc(this.tabs[i]);
      log('debug', 'tab-switch', { pane: this.side, tab: i });
      this.reload();
      persistSession();
    }
    closeTab(i) {
      if (!this.tabs[i]) return;
      const d = i === this.tab ? { name: this.name, handle: this.handle, dirty: this.dirty } : this.tabs[i];
      if (d.dirty && d.handle && !confirm(`"${d.name}" has unsaved changes. Close it anyway?`)) return;
      this.snapshot();
      this.tabs.splice(i, 1);
      if (!this.tabs.length) this.tabs.push(this.blankDoc());
      this.tab = Math.min(i < this.tab ? this.tab - 1 : this.tab, this.tabs.length - 1);
      log('info', 'tab-close', { pane: this.side, tabs: this.tabs.length });
      this.applyDoc(this.tabs[this.tab]);
      this.reload();
      persistSession();
    }
    stepTab(d) { if (this.tabs.length > 1) this.loadTab((this.tab + d + this.tabs.length) % this.tabs.length); }
    renderTabs() {
      if (this.renaming) return; // keep the name box alive while it is open
      const strip = this.q('[data-tabs]');
      strip.replaceChildren();
      this.tabs.forEach((doc, i) => {
        const cur = i === this.tab;
        const name = cur ? this.name : doc.name;
        const dirty = cur ? this.dirty && this.handle : doc.dirty && doc.handle;
        strip.append(h('button', { class: `tab${cur ? ' active' : ''}`, role: 'tab', 'aria-selected': String(cur), 'data-tab': String(i), title: `${name} (double-click to rename)` },
          trunc(name, 22) + (dirty ? ' ●' : ''), h('span', { class: 'x', 'data-close': String(i), title: 'Close', 'aria-label': `Close ${name}`, text: '×' })));
      });
      strip.append(h('button', { class: 'tab-add', 'data-act': 'newtab', title: 'New document in this pane', 'aria-label': 'New document', text: '+' }));
    }

    async showRecent(anchor) {
      const list = await recents.list();
      const items = list.map((e) => ({ label: e.name, title: 'Open in a new tab', run: () => this.openRecent(e) }));
      if (list.length) items.push({ label: 'Clear recent files', run: () => recents.clear() });
      showMenu(anchor, items, 'No recent files yet. Files you open or save appear here.');
    }
    async openRecent(entry) {
      try {
        if (!(await ensurePermission(entry.handle, 'read'))) return toast('Read permission was denied.', 'error');
        const file = await entry.handle.getFile();
        if (file.size > MAX_FILE_BYTES) throw new Error(`File is too large (${fmtBytes(file.size)}).`);
        log('info', 'recent-open', { pane: this.side, bytes: file.size });
        this.setFile({ handle: entry.handle, name: file.name, text: await file.text(), mtime: file.lastModified });
      } catch (err) {
        log('error', 'recent-open-failed', { pane: this.side, error: String(err) });
        toast(`Could not open ${entry.name}: ${err.message || err}`, 'error');
      }
    }

    // ---------------------------------------------------------------- edit history (undo / redo of whole-document edits)
    pushHistory() {
      const cur = this.input.value;
      if (this.undo[this.undo.length - 1] !== cur) this.undo.push(cur);
      if (this.undo.length > 100) this.undo.shift();
      this.redo.length = 0;
    }
    restoreText(text, what) {
      this.input.value = text;
      this.repairInfo = null; this.dirty = true; this.pick = undefined;
      log('info', what, { pane: this.side, undo: this.undo.length, redo: this.redo.length });
      this.reload({ keepView: true });
      persistSession();
    }
    undoEdit() {
      if (!this.undo.length) return toast('Nothing to undo in this document.');
      this.redo.push(this.input.value);
      this.restoreText(this.undo.pop(), 'history-undo');
    }
    redoEdit() {
      if (!this.redo.length) return toast('Nothing to redo.');
      this.undo.push(this.input.value);
      this.restoreText(this.redo.pop(), 'history-redo');
    }

    // ---------------------------------------------------------------- synced scrolling
    activeScroller() { return this.view === 'raw' ? this.input : this.view === 'preview' ? this.pinput : this.q('[data-tree]'); }
    onScroll(el, name) {
      if (this.skipScroll === el) { this.skipScroll = null; return; }
      if (!prefs.syncScroll || this.view !== name) return;
      const other = panes[this.side === 'a' ? 'b' : 'a'];
      if (!other) return;
      const target = other.activeScroller();
      const t0 = target.scrollTop, l0 = target.scrollLeft;
      if (t0 === el.scrollTop && l0 === el.scrollLeft) return;
      target.scrollTop = el.scrollTop; target.scrollLeft = el.scrollLeft;
      // a scroll event only follows when the position really changed; that echo must not bounce back
      if (target.scrollTop !== t0 || target.scrollLeft !== l0) other.skipScroll = target;
    }

    setView(view, byUser) {
      this.view = view;
      this.pvKeep = null; // entering a view shows the freshly formatted text
      prefs.panes[this.side].view = view;
      if (byUser) prefs.panes[this.side].picked = true;
      savePrefs();
      this.render();
    }

    // ---------------------------------------------------------------- rendering
    converter() { return JSS.convert.CONVERTERS[prefs.outStyle] || null; }
    outputStyle() {
      if (prefs.outStyle !== 'auto' && !this.converter()) return prefs.outStyle;
      const f = this.res && this.res.format;
      return f === 'python' ? 'python' : f === 'javascript' || f === 'json5' ? 'js' : 'json';
    }
    indentOpt() { return prefs.indent === 'tab' ? 'tab' : Number(prefs.indent); }
    formattedOut() { return serialize(this.res.node, { style: this.outputStyle(), indent: this.indentOpt(), sortKeys: prefs.sort, nonFinite: 'keep' }); }

    render() {
      const ok = this.ok;
      const info = this.q('[data-info]');
      info.replaceChildren();
      if (this.repairInfo) {
        info.append(h('div', { class: 'info' }, h('div', { class: 'note-repair' },
          h('strong', { text: 'Repaired: ' }), this.repairInfo.changes.join('; '), ' ',
          h('button', { class: 'tb', text: 'Undo', onclick: () => this.undoRepair() }))));
      }
      if (this.res) {
        info.append(resultInfo(this.res, {
          goTo: (pos) => {
            this.setView('raw', true);
            this.input.focus(); this.input.setSelectionRange(pos, pos);
            this.rawEd.scrollToLine(this.input.value.slice(0, pos).split('\n').length);
          },
          repair: () => this.doRepair(),
          pick: (i) => { this.pick = i; this.reload(); },
        }));
      }
      this.q('[data-name]').textContent = this.name + (this.dirty && this.handle ? ' ●' : '');
      this.qa('[data-views] button').forEach((b) => b.classList.toggle('active', b.dataset.view === this.view));
      this.q('[data-view-raw]').hidden = this.view !== 'raw';
      this.q('[data-view-preview]').hidden = this.view !== 'preview';
      this.q('[data-view-tree]').hidden = this.view !== 'tree';
      const meta = this.text ? `${fmtBytes(this.text.length)}${ok ? ` · ${plural(this.nodes, 'node')}` : ''}` : '';
      this.q('[data-meta-raw]').textContent = meta;
      this.q('[data-meta-tree]').textContent = meta;
      const emb = this.q('[data-act="embedded"]');
      emb.hidden = !ok || this.embedded === 0;
      emb.textContent = `Expand embedded JSON (${this.embedded}${this.embedded >= 200 ? '+' : ''})`;
      this.q('[data-act="apply"]').disabled = !ok;
      this.q('[data-act="save"]').disabled = !this.text;
      this.q('[data-act="saveas"]').disabled = !this.text;
      this.qa('[data-view-preview] .toolbar2 button, [data-view-preview] .toolbar2 select, [data-view-preview] .toolbar2 input').forEach((c) => { c.disabled = !ok; });
      this.qa('[data-tree-bar] button, [data-tree-bar] input, [data-tree-bar] select').forEach((c) => { if (c !== emb) c.disabled = !ok; });
      this.qa('[data-act="transform"]').forEach((c) => { c.disabled = !ok; });
      this.q('[data-act="undo"]').disabled = !ok || !this.undo.length;
      this.q('[data-act="redo"]').disabled = !ok || !this.redo.length;
      this.q('[data-act="max"]').setAttribute('aria-pressed', String(maxSide === this.side));
      this.renderTabs();
      if (this.view === 'tree') { if (this.queryOpen) this.renderQuery(); else this.renderTree(); } else if (this.view === 'preview') this.renderPreview();
      if (this.view === 'raw') this.rawEd.sync();
    }

    refreshPreview() { if (this.view === 'preview') this.renderPreview(); }

    renderPreview() {
      this.q('[data-f-style]').value = prefs.outStyle; this.q('[data-f-indent]').value = prefs.indent; this.q('[data-f-sort]').checked = prefs.sort;
      const ta = this.pinput;
      const conv = this.converter();
      ta.readOnly = Boolean(conv && this.ok);
      this.q('[data-f-indent]').disabled = !this.ok || Boolean(conv);
      this.q('[data-f-sort]').disabled = !this.ok || Boolean(conv);
      const typed = !conv && this.pvKeep !== null && this.pvKeep === this.input.value; // the user is editing here: do not re-format under the caret
      if (!this.ok) {
        // nothing to format: show the raw text so it can be fixed right here (the error is listed above)
        if (!typed) ta.value = this.input.value;
        this.fmtText = ''; this.q('[data-f-note]').textContent = '';
        this.prevEd.refresh();
        return;
      }
      if (conv) {
        ta.value = conv.run(this.res.node);
        this.fmtText = ta.value;
        this.prevEd.refresh();
        this.q('[data-f-note]').textContent = 'Read-only export: pick a JSON, Python or JavaScript format to edit';
        return;
      }
      const out = this.formattedOut();
      if (!typed) ta.value = out.text;
      this.fmtText = ta.value;
      this.prevEd.refresh();
      this.q('[data-f-note]').textContent = out.warnings.join(' · ');
    }

    // ---------------------------------------------------------------- tree
    isOpen(pk, depth) { return this.collapsed.has(pk) ? false : this.expanded.has(pk) ? true : depth < this.depth; }

    renderNode(parent, node, path, kinfo, depth, ctx) {
      if (ctx.budget <= 0) { ctx.over = true; return; }
      const pk = pathKey(path);
      if (this.filter && this.term && !this.visible.has(pk)) return;
      ctx.budget--;
      const container = node.t === 'obj' || node.t === 'arr';
      const open = container && this.isOpen(pk, depth);
      const row = h('div', { class: 'row', style: `padding-left:${GUTTER_PX + depth * 16}px` });
      row.dataset.pk = pk;
      if (this.matchKeys.has(pk)) row.classList.add('match');
      if (this.curKey === pk) row.classList.add('current');
      if (this.selKey === pk) row.classList.add('sel');
      row.append(h('span', { class: `caret${container ? '' : ' leaf'}`, text: container ? (open ? '▾' : '▸') : '' }));
      if (kinfo) {
        const label = kinfo.idx ? String(kinfo.text) : (kinfo.keyType === 'num' || kinfo.keyType === 'tuple' ? kinfo.text : JSON.stringify(trunc(kinfo.text, 120)));
        row.append(h('span', { class: `k${kinfo.idx ? ' idx' : ''}`, text: label }), h('span', { class: 'colon', text: ':' }));
      }
      row.append(valueSpan(node, open), ...badges(node));
      row.append(h('span', { class: 'acts' },
        h('button', { 'data-act': 'path', title: 'Copy path', text: 'path' }),
        h('button', { 'data-act': 'copy', title: container ? 'Copy this subtree as JSON' : 'Copy value', text: 'copy' }),
        container ? h('button', { 'data-act': 'add', title: node.t === 'obj' ? 'Add a key' : 'Append an item', text: '+ add' }) : h('button', { 'data-act': 'edit', title: 'Edit this value (or double-click it)', text: 'edit' }),
        kinfo ? h('button', { 'data-act': 'delete', class: 'danger', title: 'Delete this entry', text: 'delete' }) : null));
      parent.append(row);
      this.rowInfo.set(row, { node, path, parent: kinfo && kinfo.parent, index: kinfo && kinfo.index });
      this.rowEls.set(pk, row);
      if (open) this.renderChildren(parent, node, path, depth + 1, ctx, pk);
    }

    renderChildren(parent, node, path, depth, ctx, pk) {
      const list = children(node);
      const limit = this.limits.get(pk) || 200;
      const filtering = this.filter && this.term;
      let shown = 0, i = 0;
      for (; i < list.length; i++) {
        if (!filtering && shown >= limit) break;
        const [k, v] = list[i];
        const before = ctx.budget;
        this.renderNode(parent, v, path.concat(k), {
          text: k, idx: node.t === 'arr', keyType: node.t === 'obj' ? node.entries[i].keyType : undefined, parent: node, index: i,
        }, depth, ctx);
        if (ctx.budget !== before) shown++;
        if (ctx.budget <= 0) return;
      }
      if (!filtering && i < list.length) {
        const more = h('div', { class: 'more-row', style: `padding-left:${GUTTER_PX + depth * 16 + 18}px`, text: `… ${(list.length - i).toLocaleString()} more (click to show ${Math.min(200, list.length - i)} more)` });
        more.addEventListener('click', () => { this.limits.set(pk, limit + 200); this.renderTree(); });
        parent.append(more);
      }
    }

    renderTree() {
      const tree = this.q('[data-tree]');
      this.q('[data-query-box]').hidden = true;
      tree.hidden = false;
      this.rowEls.clear();
      tree.replaceChildren();
      if (!this.res) { tree.append(h('div', { class: 'empty', text: 'Nothing here yet. Use Open or Paste above, or type in Raw or Preview.' })); return; }
      if (!this.res.ok) { tree.append(h('div', { class: 'empty', text: 'Fix the error shown above to see the tree.' })); return; }
      const ctx = { budget: TREE_BUDGET, over: false };
      const frag = document.createDocumentFragment();
      const t0 = performance.now();
      this.renderNode(frag, this.res.node, [], null, 0, ctx);
      tree.append(frag);
      if (ctx.over) tree.append(h('div', { class: 'notice', text: `Showing the first ${TREE_BUDGET.toLocaleString()} rows to keep the page responsive. Collapse branches, lower the depth, or use search / JSONPath to reach the rest.` }));
      log('debug', 'tree-rendered', { pane: this.side, rows: TREE_BUDGET - ctx.budget, ms: Math.round(performance.now() - t0) });
      if (this.pendingEdit) { // a row was just added: open its key (objects) or value (arrays) for typing
        const { pk, what } = this.pendingEdit;
        this.pendingEdit = null;
        const row = this.rowEls.get(pk);
        const span = row && row.querySelector(what === 'key' ? '.k' : '.val');
        if (span) { row.scrollIntoView({ block: 'center' }); (what === 'key' ? this.editKey : this.editValue).call(this, row, span); }
      }
    }

    onTreeClick(e) {
      const row = e.target.closest('.row');
      if (e.target.closest('.more-row') || !row) return;
      const info = this.rowInfo.get(row);
      if (!info) return;
      this.setSel(row.dataset.pk, false);
      const act = e.target.closest('[data-act]');
      if (act) {
        if (act.dataset.act === 'path') copyText(pathToString(info.path), 'path');
        else if (act.dataset.act === 'copy') copyText(serialize(info.node, { style: 'json', indent: 2 }).text, info.node.t === 'obj' || info.node.t === 'arr' ? 'subtree' : 'value');
        else if (act.dataset.act === 'edit') { const span = row.querySelector('.val'); if (span) this.editValue(row, span); }
        else if (act.dataset.act === 'add') this.addChild(info);
        else if (act.dataset.act === 'delete') this.deleteEntry(info);
        return;
      }
      if (e.target.closest('input')) return;
      if (info.node.t === 'obj' || info.node.t === 'arr') {
        const pk = row.dataset.pk;
        if (this.isOpen(pk, info.path.length)) { this.collapsed.add(pk); this.expanded.delete(pk); } else { this.expanded.add(pk); this.collapsed.delete(pk); }
        this.renderTree();
      }
    }

    setSel(pk, scroll) {
      const prev = this.rowEls.get(this.selKey);
      if (prev) prev.classList.remove('sel');
      this.selKey = pk;
      const row = this.rowEls.get(pk);
      if (row) { row.classList.add('sel'); if (scroll) row.scrollIntoView({ block: 'nearest' }); }
    }

    toggleRow(pk, open, depth) {
      if (open === this.isOpen(pk, depth)) return;
      if (open) { this.expanded.add(pk); this.collapsed.delete(pk); } else { this.collapsed.add(pk); this.expanded.delete(pk); }
      this.renderTree();
    }

    /** Keyboard control of the tree: arrows move / fold, Enter edits or folds, F2 renames a key, Delete removes, Ctrl+Z undoes. */
    onTreeKey(e) {
      if (e.target.closest('input')) return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && !e.altKey && e.key.toLowerCase() === 'z') { e.preventDefault(); return e.shiftKey ? this.redoEdit() : this.undoEdit(); }
      if (mod && !e.altKey && e.key.toLowerCase() === 'y') { e.preventDefault(); return this.redoEdit(); }
      if (mod || e.altKey || !this.ok) return;
      const rows = [...this.q('[data-tree]').querySelectorAll('.row')];
      if (!rows.length) return;
      let i = rows.findIndex((r) => r.dataset.pk === this.selKey);
      const select = (j) => { const r = rows[Math.max(0, Math.min(rows.length - 1, j))]; this.setSel(r.dataset.pk, true); };
      const row = i >= 0 ? rows[i] : null;
      const info = row && this.rowInfo.get(row);
      const container = info && (info.node.t === 'obj' || info.node.t === 'arr');
      const open = container && this.isOpen(row.dataset.pk, info.path.length);
      switch (e.key) {
        case 'ArrowDown': e.preventDefault(); select(i < 0 ? 0 : i + 1); break;
        case 'ArrowUp': e.preventDefault(); select(i < 0 ? 0 : i - 1); break;
        case 'Home': e.preventDefault(); select(0); break;
        case 'End': e.preventDefault(); select(rows.length - 1); break;
        case 'ArrowRight':
          e.preventDefault();
          if (!container) break;
          if (!open) this.toggleRow(row.dataset.pk, true, info.path.length); else select(i + 1);
          break;
        case 'ArrowLeft':
          e.preventDefault();
          if (!info) break;
          if (open) this.toggleRow(row.dataset.pk, false, info.path.length);
          else if (info.path.length) this.setSel(pathKey(info.path.slice(0, -1)), true);
          break;
        case 'Enter': case ' ':
          e.preventDefault();
          if (!info) break;
          if (container) this.toggleRow(row.dataset.pk, !open, info.path.length);
          else if (e.key === 'Enter') { const span = row.querySelector('.val'); if (span) this.editValue(row, span); }
          break;
        case 'F2': { e.preventDefault(); const k = row && row.querySelector('.k'); if (k) this.editKey(row, k); break; }
        case 'Delete': case 'Backspace':
          if (info && info.parent) { e.preventDefault(); this.selKey = pathKey(info.path.slice(0, -1)); this.deleteEntry(info); }
          break;
        default: return;
      }
    }

    onTreeDblClick(e) {
      const row = e.target.closest('.row');
      if (!row || !this.rowInfo.get(row)) return;
      const val = e.target.closest('.val');
      if (val) return this.editValue(row, val);
      const key = e.target.closest('.k');
      if (key) this.editKey(row, key);
    }

    /** Replaces `span` with a text box; Enter commits, Escape or leaving the box cancels. */
    inlineEdit(span, initial, label, commit) {
      const input = h('input', { class: 'edit', value: initial, 'aria-label': label });
      span.replaceWith(input);
      input.focus();
      input.select();
      let finished = false;
      const finish = (ok) => {
        if (finished) return;
        finished = true;
        if (ok) commit(input.value); else this.renderTree();
      };
      input.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') { ev.preventDefault(); finish(true); } else if (ev.key === 'Escape') finish(false);
      });
      input.addEventListener('blur', () => finish(false));
    }

    editValue(row, span) {
      const info = this.rowInfo.get(row);
      const n = info && info.node;
      if (!n || n.t === 'obj' || n.t === 'arr') return;
      const initial = n.t === 'str' ? JSON.stringify(n.v) : n.t === 'num' ? n.raw : n.t === 'bool' ? String(n.v) : 'null';
      this.inlineEdit(span, initial, 'Edit value', (text) => this.commitEdit(n, text));
    }

    /** Rename an object key (array indexes cannot be renamed). */
    editKey(row, span) {
      const info = this.rowInfo.get(row);
      if (!info || !info.parent || info.parent.t !== 'obj') return;
      const entry = info.parent.entries[info.index];
      this.inlineEdit(span, entry.key, 'Edit key', (text) => this.commitKey(info.parent, entry, text));
    }

    commitEdit(node, text) {
      const p = JSS.parser.tryParse(text.trim());
      const repl = p.ok && !(p.node.t === 'str' && p.node.tag === 'repr') ? p.node : JSS.ast.N.str(text);
      for (const k of Object.keys(node)) delete node[k];
      Object.assign(node, repl);
      log('info', 'tree-edit', { pane: this.side, newType: repl.t });
      this.syncInputFromTree();
    }

    commitKey(parent, entry, text) {
      if (text === entry.key) return this.renderTree();
      if (parent.entries.some((e) => e !== entry && e.key === text)) {
        toast(`The key "${trunc(text, 60)}" already exists in this object.`, 'error');
        log('warn', 'tree-rename-duplicate', { pane: this.side });
        return this.renderTree();
      }
      entry.key = text;
      delete entry.keyType; delete entry.keyRaw; // the new key is plain text
      log('info', 'tree-rename-key', { pane: this.side });
      this.syncInputFromTree();
    }

    /** Adds `null` to an object (under a unique key, which opens for renaming) or appends it to an array (value opens for typing). */
    addChild(info) {
      const node = info.node;
      let key;
      if (node.t === 'obj') {
        key = 'newKey';
        for (let i = 2; node.entries.some((e) => e.key === key); i++) key = `newKey${i}`;
        node.entries.push({ key, value: JSS.ast.N.nul() });
      } else {
        node.items.push(JSS.ast.N.nul());
        key = node.items.length - 1;
      }
      const childPath = info.path.concat(key);
      this.expandAncestors(childPath);
      this.pendingEdit = { pk: pathKey(childPath), what: node.t === 'obj' ? 'key' : 'value' };
      log('info', 'tree-add', { pane: this.side, into: node.t });
      this.syncInputFromTree();
    }

    deleteEntry(info) {
      const { parent, index } = info;
      if (!parent) return;
      if (parent.t === 'obj') parent.entries.splice(index, 1); else parent.items.splice(index, 1);
      log('info', 'tree-delete', { pane: this.side, from: parent.t });
      this.syncInputFromTree();
    }

    /** The document's own format ('json' | 'python' | 'js'), whatever the Preview happens to show. */
    sourceStyle() {
      const f = this.res && this.res.format;
      return f === 'python' ? 'python' : f === 'javascript' || f === 'json5' ? 'js' : 'json';
    }

    /**
     * Writes `node` back as the pane's text (own format unless o.style, o.indent overrides), with history and a re-parse.
     * With o.skipIfSame, returns null instead of rewriting when the text would not change.
     */
    writeNode(node, o) {
      o = o || {};
      const own = detectIndent(this.input.value);
      const indent = o.indent !== undefined ? o.indent : own !== null ? own : this.indentOpt() === 0 ? 2 : this.indentOpt();
      const out = serialize(node, { style: o.style || this.sourceStyle(), indent, sortKeys: false });
      if (o.skipIfSame && out.text.trim() === this.input.value.trim()) return null;
      this.pushHistory();
      this.input.value = out.text;
      this.repairInfo = null;
      this.dirty = true;
      persistSession();
      this.reload({ keepView: true });
      return out;
    }

    syncInputFromTree() { this.writeNode(this.res.node); }

    // ---------------------------------------------------------------- transforms (sort, minify, clean up, convert)
    runTransform(label, fn) {
      if (!this.ok) return toast('Fix the error shown above first: transforms need a valid document.', 'error');
      const t0 = performance.now();
      let r;
      try { r = fn(JSS.ast.clone(this.res.node)); } catch (err) {
        log('error', 'transform-failed', { pane: this.side, op: label, error: String(err) });
        return toast(`${label} failed: ${err.message || err}`, 'error');
      }
      if (r.error) { log('warn', 'transform-rejected', { pane: this.side, op: label }); return toast(r.error, 'error'); }
      if (!r.changes) return toast(`${label}: ${r.note || 'nothing to change'}`);
      const out = this.writeNode(r.node, { indent: r.indent, style: r.style, skipIfSame: true });
      log('info', 'transform', { pane: this.side, op: label, changes: r.changes, written: Boolean(out), ms: Math.round(performance.now() - t0) });
      if (!out) return toast(`${label}: nothing to change, the text is already like that.`);
      const warn = out.warnings && out.warnings.length ? ` (${out.warnings.slice(0, 2).join('; ')})` : '';
      toast(`${label}: ${r.note || plural(r.changes, 'change')}${warn}. Undo is in the Tree toolbar.`);
    }

    async askSortArrays() {
      if (!this.ok) return toast('Fix the error shown above first: transforms need a valid document.', 'error');
      const v = await askForm('Sort arrays', [
        { name: 'by', label: 'Sort by field', placeholder: 'e.g. price, owner.name, items[0].id', hint: 'Leave blank to sort the values themselves (numbers, then strings). Items without the field go last.', value: '' },
        { name: 'order', type: 'select', label: 'Order', value: 'asc', options: [['asc', 'Ascending (A → Z, 1 → 9)'], ['desc', 'Descending (Z → A, 9 → 1)']] },
        { name: 'scope', type: 'select', label: 'Apply to', value: 'all', options: [['all', 'Every array in the document'], ['top', 'Only the top-level array']] },
      ], 'Sort');
      if (!v) return;
      this.runTransform('Sort arrays', (n) => JSS.transform.sortArrays(n, { by: v.by, order: v.order, deep: v.scope === 'all' }));
    }

    // ---------------------------------------------------------------- search
    runSearch(silent) {
      this.term = this.q('[data-search]').value.trim().toLowerCase();
      this.matches = []; this.matchKeys = new Set(); this.visible = new Set(); this.idx = -1; this.curKey = null;
      const t = this.term;
      if (t && this.ok) {
        walk(this.res.node, (n, path) => {
          if (this.matches.length >= 5000) return false;
          const last = path[path.length - 1];
          let hit = typeof last === 'string' && last.toLowerCase().includes(t);
          if (!hit) {
            if (n.t === 'str') hit = n.v.toLowerCase().includes(t);
            else if (n.t === 'num') hit = n.raw.toLowerCase().includes(t);
            else if (n.t === 'bool') hit = String(n.v).includes(t);
            else if (n.t === 'null') hit = 'null'.includes(t);
          }
          if (hit) this.matches.push(path);
          return undefined;
        });
        for (const p of this.matches) for (let i = 0; i <= p.length; i++) this.visible.add(pathKey(p.slice(0, i)));
        for (const p of this.matches) this.matchKeys.add(pathKey(p));
        for (const p of this.matches.slice(0, 200)) this.expandAncestors(p); // open the first matches' branches so they are visible
      }
      this.q('[data-search-count]').textContent = !t ? '' : this.matches.length ? `${this.matches.length}${this.matches.length >= 5000 ? '+' : ''} matches` : 'no matches';
      log('debug', 'search', { pane: this.side, termLength: t.length, matches: this.matches.length });
      if (silent) return;
      if (this.matches.length) this.goToMatch(0); else this.render();
    }

    goToMatch(i) {
      if (!this.matches.length) return;
      this.idx = ((i % this.matches.length) + this.matches.length) % this.matches.length;
      const path = this.matches[this.idx];
      this.curKey = pathKey(path);
      this.q('[data-search-count]').textContent = `${this.idx + 1} / ${this.matches.length}${this.matches.length >= 5000 ? '+' : ''}`;
      this.reveal(path);
    }

    /** Opens every ancestor of `path` and widens paged arrays so the row exists in the tree. */
    expandAncestors(path) {
      const root = this.res.node;
      for (let i = 0; i < path.length; i++) {
        const anc = path.slice(0, i);
        const pk = pathKey(anc);
        this.expanded.add(pk); this.collapsed.delete(pk);
        const n = getAt(root, anc);
        if (n && n.t === 'arr' && typeof path[i] === 'number') this.limits.set(pk, Math.max(this.limits.get(pk) || 200, Math.ceil((path[i] + 1) / 200) * 200));
      }
    }

    reveal(path) {
      this.expandAncestors(path);
      this.queryOpen = false;
      if (this.view !== 'tree') this.view = 'tree';
      this.render();
      const row = this.rowEls.get(pathKey(path));
      if (row) { row.scrollIntoView({ block: 'center' }); row.classList.add('flash'); }
    }

    // ---------------------------------------------------------------- JSONPath
    runQuery() {
      const src = this.q('[data-query]').value.trim();
      if (!src) { this.query = null; this.queryOpen = false; this.render(); return; }
      if (!this.ok) return;
      const r = JSS.query.query(this.res.node, src);
      this.query = r;
      this.queryOpen = true;
      log('info', 'query', { pane: this.side, results: r.results.length, error: Boolean(r.error) });
      this.render();
    }

    renderQuery() {
      const box = this.q('[data-query-box]');
      this.q('[data-tree]').hidden = true;
      box.hidden = false;
      box.replaceChildren();
      const head = h('div', { class: 'q-head' },
        h('strong', { text: this.query && !this.query.error ? `${this.query.results.length}${this.query.truncated ? '+' : ''} result${this.query.results.length === 1 ? '' : 's'}` : 'Query' }),
        h('button', { class: 'tb', text: '← Back to tree', onclick: () => { this.queryOpen = false; this.render(); } }));
      box.append(head);
      if (!this.query) return;
      if (this.query.error) { box.append(h('div', { class: 'notice', text: `Query error: ${this.query.error}` })); return; }
      if (!this.query.results.length) { box.append(h('div', { class: 'empty', text: 'No results.' })); return; }
      const frag = document.createDocumentFragment();
      for (const r of this.query.results.slice(0, 2000)) {
        const preview = r.node.t === 'obj' || r.node.t === 'arr' ? JSS.ast.describe(r.node) : serialize(r.node, { style: 'json', indent: 0 }).text;
        const row = h('div', { class: 'q-row', title: 'Show in tree' }, h('span', { class: 'q-path', text: pathToString(r.path, { root: true }) }), h('span', { class: 'q-val', text: trunc(preview, 200) }));
        row.addEventListener('click', () => this.reveal(r.path));
        frag.append(row);
      }
      box.append(frag);
      if (this.query.results.length > 2000) box.append(h('div', { class: 'notice', text: 'Showing the first 2,000 results.' }));
    }

    // ---------------------------------------------------------------- repair
    doRepair() {
      const r = JSS.loader.repair(this.input.value);
      if (!r) return toast('No automatic repair is possible for this input.', 'error');
      this.pushHistory();
      this.repairInfo = { before: this.input.value, changes: r.changes };
      this.input.value = r.text;
      log('info', 'repair-applied', { pane: this.side, changes: r.changes.length });
      this.reload();
    }
    undoRepair() {
      if (!this.repairInfo) return;
      this.input.value = this.repairInfo.before;
      this.repairInfo = null;
      this.reload();
    }

    // ---------------------------------------------------------------- input actions
    clear() {
      this.pushHistory();
      this.input.value = ''; this.handle = null; this.name = 'Untitled'; this.dirty = false; this.repairInfo = null; this.pick = undefined;
      this.reload(); persistSession(); this.input.focus();
    }
    async paste() {
      try {
        this.input.value = await navigator.clipboard.readText();
        this.dirty = true;
          this.reload();
        persistSession();
      } catch {
        this.setView('raw', true);
        this.input.focus();
        toast('Clipboard access was blocked. Press Ctrl/Cmd+V in the box instead.');
      }
    }
    applyFormat() {
      if (!this.ok) return;
      this.pushHistory();
      this.input.value = this.formattedOut().text;
      this.repairInfo = null; this.dirty = true;
      this.reload({ keepView: true });
      persistSession();
      toast('Raw text replaced with the formatted output');
    }

    // ---------------------------------------------------------------- files
    async open() {
      try {
        this.setFile(await pickFile());
      } catch (err) {
        if (err.name === 'AbortError') return;
        log('error', 'open-failed', { pane: this.side, error: String(err) });
        toast(`Open failed: ${err.message || err}`, 'error');
      }
    }

    async save(as) {
      if (!this.input.value) return;
      try {
        let handle = this.handle;
        if (as || !handle) {
          if (!window.showSaveFilePicker) return toast('This browser does not support the File System Access API.', 'error');
          handle = await window.showSaveFilePicker({ suggestedName: this.name.includes('.') ? this.name : `${this.name}.json`, types: PICKER_TYPES });
        } else {
          if (!(await ensurePermission(handle, 'readwrite'))) return toast('Write permission was denied.', 'error');
          const cur = await handle.getFile();
          if (this.mtime && cur.lastModified > this.mtime && !confirm(`"${this.name}" changed on disk after you opened it.\n\nOverwrite it with your version?`)) return;
        }
        await this.write(handle, this.input.value);
        recents.add(handle);
        this.handle = handle; this.name = handle.name; this.mtime = (await handle.getFile()).lastModified; this.dirty = false;
        log('info', 'saved', { pane: this.side, name: this.name, bytes: this.input.value.length });
        toast(`${this.label()}: saved ${this.name}`);
        this.render();
        persistSession();
      } catch (err) {
        if (err.name === 'AbortError') return;
        log('error', 'save-failed', { pane: this.side, error: String(err) });
        toast(`Save failed: ${err.message || err}`, 'error');
      }
    }

    async saveFormatted() {
      if (!this.fmtText) return;
      try {
        if (!window.showSaveFilePicker) return toast('This browser does not support the File System Access API.', 'error');
        const ext = this.fmtExt();
        const base = this.name.replace(/\.[^.]*$/, '') || 'document';
        const handle = await window.showSaveFilePicker({ suggestedName: `${base}.formatted.${ext}`, types: PICKER_TYPES });
        await this.write(handle, this.fmtText);
        log('info', 'saved-formatted', { pane: this.side, bytes: this.fmtText.length });
        toast(`${this.label()}: saved ${handle.name}`);
      } catch (err) {
        if (err.name === 'AbortError') return;
        log('error', 'save-formatted-failed', { pane: this.side, error: String(err) });
        toast(`Save failed: ${err.message || err}`, 'error');
      }
    }

    fmtExt() { const c = this.converter(); return c ? c.ext : { json: 'json', python: 'py', js: 'js' }[this.outputStyle()]; }

    async write(handle, text) {
      const w = await handle.createWritable();
      try { await w.write(text); } catch (err) { await w.abort().catch(() => {}); throw err; }
      await w.close();
    }

    download() {
      if (!this.fmtText) return;
      const ext = this.fmtExt();
      const base = this.name.replace(/\.[^.]*$/, '') || 'document';
      const url = URL.createObjectURL(new Blob([this.fmtText], { type: 'text/plain' }));
      h('a', { href: url, download: `${base}.formatted.${ext}` }).click();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    }
  }

  function setActive(p) {
    if (activePane === p) return;
    activePane = p;
    Object.values(panes).forEach((x) => x.root.classList.toggle('active', x === p));
  }

  loadPrefs();
  for (const side of ['a', 'b']) {
    panes[side] = new DocPane(side);
    $('paneRow').append(panes[side].root);
    panes[side].onResult = () => { if (prefs.mode === 'compare') scheduleCompare(); else if (prefs.mode === 'validate') scheduleValidate(); };
  }
  setActive(panes.a);

  // ====================================================================== resizing, maximise, synced scrolling
  const paneSplit = h('div', { class: 'vsplit', id: 'paneSplit', role: 'separator', 'aria-orientation': 'vertical', tabindex: '0', title: 'Drag to resize; double-click to reset', 'aria-label': 'Resize panes' });
  $('paneRow').insertBefore(paneSplit, panes.b.root);

  function applyRatios() {
    panes.a.root.style.flex = `${prefs.split} 1 0`;
    panes.b.root.style.flex = `${1 - prefs.split} 1 0`;
    paneSplit.setAttribute('aria-valuenow', String(Math.round(prefs.split * 100)));
  }
  function applyStage() {
    const row = $('paneRow'), split = $('stageSplit');
    const stacked = prefs.mode !== 'viewer';
    row.style.flex = stacked && !row.hidden ? `0 0 ${prefs.stageSplit * 100}%` : '';
    split.hidden = !stacked || row.hidden;
    split.setAttribute('aria-valuenow', String(Math.round(prefs.stageSplit * 100)));
  }
  /** Pointer drag plus arrow keys (Shift = bigger steps, Home / double-click = reset) for a separator element. */
  function makeSplitter(el, { ratioFrom, get, set, reset, dec, inc }) {
    let drag = false;
    const finish = () => { if (!drag) return; drag = false; el.classList.remove('drag'); document.body.classList.remove('resizing'); savePrefs(); log('debug', 'resize-done', { id: el.id, ratio: get() }); };
    el.addEventListener('pointerdown', (e) => {
      if (e.button) return;
      drag = true; el.classList.add('drag'); document.body.classList.add('resizing');
      if (el.setPointerCapture && e.pointerId !== undefined) { try { el.setPointerCapture(e.pointerId); } catch { /* synthetic events have no active pointer */ } }
      e.preventDefault();
    });
    el.addEventListener('pointermove', (e) => { if (drag) set(clampRatio(ratioFrom(e), get())); });
    el.addEventListener('pointerup', finish);
    el.addEventListener('pointercancel', finish);
    el.addEventListener('lostpointercapture', finish);
    el.addEventListener('dblclick', () => { reset(); savePrefs(); });
    el.addEventListener('keydown', (e) => {
      const step = e.shiftKey ? 0.1 : 0.02;
      if (e.key === dec) set(clampRatio(get() - step, get()));
      else if (e.key === inc) set(clampRatio(get() + step, get()));
      else if (e.key === 'Home') reset();
      else return;
      e.preventDefault();
      savePrefs();
    });
  }
  makeSplitter(paneSplit, {
    ratioFrom: (e) => { const r = $('paneRow').getBoundingClientRect(); return (e.clientX - r.left) / (r.width || 1); },
    get: () => prefs.split, set: (v) => { prefs.split = v; applyRatios(); }, reset: () => { prefs.split = 0.5; applyRatios(); }, dec: 'ArrowLeft', inc: 'ArrowRight',
  });
  makeSplitter($('stageSplit'), {
    ratioFrom: (e) => { const r = $('stage').getBoundingClientRect(); return (e.clientY - r.top) / (r.height || 1); },
    get: () => prefs.stageSplit, set: (v) => { prefs.stageSplit = v; applyStage(); }, reset: () => { prefs.stageSplit = 0.42; applyStage(); }, dec: 'ArrowUp', inc: 'ArrowDown',
  });

  function setMax(side) {
    maxSide = side;
    const row = $('paneRow');
    if (side) row.dataset.max = side; else delete row.dataset.max;
    for (const p of Object.values(panes)) p.q('[data-act="max"]').setAttribute('aria-pressed', String(p.side === side));
    log('info', 'maximise', { pane: side });
  }

  function applySync() {
    const b = $('btnSync');
    b.setAttribute('aria-pressed', String(prefs.syncScroll));
    b.textContent = `Sync scroll: ${prefs.syncScroll ? 'on' : 'off'}`;
  }
  $('btnSync').addEventListener('click', () => { prefs.syncScroll = !prefs.syncScroll; savePrefs(); applySync(); log('info', 'sync-scroll', { on: prefs.syncScroll }); });

  // ====================================================================== COMPARE (diff of pane A and pane B)
  const C = { result: null, tab: 'tree', open: new Set(), closed: new Set(), cur: -1, blocks: [], rows: new Map() };

  function cmpOptions() {
    return {
      ignoreKeyOrder: $('oOrder').checked,
      arrayMode: $('oArray').value,
      arrayKey: $('oArrayKey').value.trim() || 'id',
      ignorePaths: $('oIgnore').value.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean),
      numberTolerance: Math.max(0, Number($('oTol').value) || 0),
      caseInsensitive: $('oCase').checked, trimStrings: $('oTrim').checked, missingEqualsNull: $('oMissing').checked,
    };
  }
  function syncOptionsToPrefs() {
    Object.assign(prefs.cmp, {
      order: $('oOrder').checked, array: $('oArray').value, arrayKey: $('oArrayKey').value, ignore: $('oIgnore').value,
      tol: Number($('oTol').value) || 0, caseI: $('oCase').checked, trim: $('oTrim').checked, missing: $('oMissing').checked, collapse: $('cCollapse').checked,
    });
    savePrefs();
  }
  const scheduleCompare = debounce(() => runCompare(), 200);

  function runCompare() {
    const a = panes.a.res, b = panes.b.res;
    if (!(a && a.ok && b && b.ok)) { C.result = null; C.cur = -1; renderCompare(); return; }
    const t0 = performance.now();
    C.result = JSS.diff.compare(a.node, b.node, cmpOptions());
    C.cur = -1;
    const ms = Math.round(performance.now() - t0);
    log('info', 'compare-done', { ms, diffs: C.result.stats.total });
    if (C.result.errors.length) toast(C.result.errors[0], 'error');
    $('stLeft').textContent = `Compared in ${ms} ms`;
    renderCompare();
  }

  function renderCompare() {
    const r = C.result;
    $('cTabs').querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.ctab === C.tab));
    const stats = $('cStats');
    stats.replaceChildren();
    if (r) {
      const st = r.stats;
      if (!st.total) stats.append(h('span', { class: 'chip ok', text: 'Identical' }));
      else {
        if (st.added) stats.append(h('span', { class: 'chip add', text: `+${st.added} added` }));
        if (st.removed) stats.append(h('span', { class: 'chip del', text: `−${st.removed} removed` }));
        if (st.changed) stats.append(h('span', { class: 'chip chg', text: `~${st.changed} changed` }));
        if (st.type) stats.append(h('span', { class: 'chip typ', text: `⇄${st.type} type` }));
        if (st.reordered) stats.append(h('span', { class: 'chip warn', text: 'key order differs' }));
      }
    }
    const has = Boolean(r && r.stats.total);
    ['cPrev', 'cNext', 'cCopyPaths', 'cCopyPatch'].forEach((id) => { $(id).disabled = !has; });
    $('cPos').textContent = C.cur >= 0 && r ? `${C.cur + 1} / ${C.tab === 'tree' ? r.diffs.length : C.blocks.length}` : '';
    if (C.tab === 'tree') renderDiffTree(); else renderTextDiff();
  }

  function cellFor(side, m, depth, container, open) {
    const n = side === 'a' ? m.a : m.b;
    const cell = h('div', { class: `cell ${side}`, style: `padding-left:${8 + depth * 16}px` });
    if (!n) return cell;
    cell.append(h('span', { class: `caret${container ? '' : ' leaf'}`, text: container ? (open ? '▾' : '▸') : '' }));
    if (m.key !== null && m.key !== undefined) {
      const arrayItem = typeof m.key === 'number';
      cell.append(h('span', { class: `k${arrayItem ? ' idx' : ''}`, text: arrayItem ? `${m.idLabel ? `[${m.idLabel}]` : m.key}` : JSON.stringify(trunc(String(m.key), 100)) }), h('span', { class: 'colon', text: ':' }));
    }
    cell.append(valueSpan(n, open), ...badges(n));
    if (side === 'b') cell.append(h('span', { class: 'tag-mark', text: { added: '+ added', removed: '− removed', changed: '~ changed', type: `⇄ ${m.a ? m.a.t : ''}→${m.b ? m.b.t : ''}` }[m.status] || '' }));
    return cell;
  }

  function plainRows(grid, node, path, depth, klass, sides, ctx) {
    if (depth > 8) return;
    const list = children(node);
    let i = 0;
    for (; i < list.length && i < 200; i++) {
      if (ctx.budget <= 0) { ctx.over = true; return; }
      ctx.budget--;
      const [k, v] = list[i];
      const container = v.t === 'obj' || v.t === 'arr';
      const m = { key: k, a: sides.includes('a') ? v : null, b: sides.includes('b') ? v : null, status: klass, path: path.concat(k) };
      grid.append(h('div', { class: `drow ${klass}` }, cellFor('a', m, depth, container, container), cellFor('b', m, depth, container, container)));
      if (container) plainRows(grid, v, path.concat(k), depth + 1, klass, sides, ctx);
    }
    if (i < list.length) grid.append(h('div', { class: 'drow' }, h('div', { class: 'cell', style: `padding-left:${8 + depth * 16}px`, text: `… ${list.length - i} more` }), h('div', { class: 'cell' })));
  }

  function renderMerged(grid, m, depth, ctx) {
    if (ctx.budget <= 0) { ctx.over = true; return; }
    ctx.budget--;
    const pk = pathKey(m.path);
    const sample = m.a || m.b;
    const container = sample && (sample.t === 'obj' || sample.t === 'arr') && (!m.a || !m.b || m.a.t === m.b.t);
    const hideSame = $('cCollapse').checked;
    let open = false;
    if (container) {
      if (m.status === 'changed' && m.children) open = !C.closed.has(pk);
      else if (m.status === 'same') open = C.open.has(pk) || (!hideSame && depth < 3);
      else open = C.open.has(pk);
    }
    const cls = m.status === 'changed' && m.children ? 'container-changed' : m.status;
    const row = h('div', { class: `drow ${cls}` }, cellFor('a', m, depth, container, open), cellFor('b', m, depth, container, open));
    row.dataset.pk = pk;
    ctx.rows.set(pk, row);
    if (container) {
      row.addEventListener('click', () => {
        if (m.status === 'changed' && m.children) { if (C.closed.has(pk)) C.closed.delete(pk); else C.closed.add(pk); }
        else if (C.open.has(pk)) C.open.delete(pk); else C.open.add(pk);
        renderDiffTree();
      });
      row.style.cursor = 'pointer';
    }
    grid.append(row);
    if (!open) return;
    if (m.children) {
      let hiddenSame = 0;
      for (const c of m.children) {
        if (hideSame && c.status === 'same' && m.status === 'changed') { hiddenSame++; continue; }
        renderMerged(grid, c, depth + 1, ctx);
      }
      if (hiddenSame) grid.append(h('div', { class: 'drow' }, h('div', { class: 'cell v-sum', style: `padding-left:${8 + (depth + 1) * 16}px`, text: `${plural(hiddenSame, 'unchanged item')} hidden` }), h('div', { class: 'cell' })));
    } else if (m.status === 'same') plainRows(grid, m.a, m.path, depth + 1, 'same', 'ab', ctx);
    else if (m.status === 'added') plainRows(grid, m.b, m.path, depth + 1, 'added', 'b', ctx);
    else if (m.status === 'removed') plainRows(grid, m.a, m.path, depth + 1, 'removed', 'a', ctx);
  }

  const headerRow = () => h('div', { class: 'hdr' }, h('div', { text: `A${!isUntitled(panes.a.name) ? ` · ${panes.a.name}` : ''}` }), h('div', { text: `B${!isUntitled(panes.b.name) ? ` · ${panes.b.name}` : ''}` }));

  function renderDiffTree() {
    const body = $('cBody');
    body.replaceChildren();
    const r = C.result;
    if (!r) {
      const neither = !panes.a.res && !panes.b.res;
      body.append(h('div', { class: 'empty', text: neither ? 'Add a document to pane A and to pane B to compare them.' : 'Both panes need valid content before they can be compared.' }));
      return;
    }
    const ctx = { budget: DIFF_BUDGET, over: false, rows: new Map() };
    const grid = h('div', { class: 'dgrid' });
    body.append(headerRow(), grid);
    const t0 = performance.now();
    renderMerged(grid, r.root, 0, ctx);
    if (ctx.over) body.append(h('div', { class: 'notice', text: `Showing the first ${DIFF_BUDGET.toLocaleString()} rows. Turn on “hide unchanged”, collapse branches, or use the next/previous buttons to jump between differences.` }));
    C.rows = ctx.rows;
    log('debug', 'diff-tree-rendered', { rows: DIFF_BUDGET - ctx.budget, ms: Math.round(performance.now() - t0) });
    if (C.cur >= 0 && r.diffs[C.cur]) {
      const row = ctx.rows.get(pathKey(r.diffs[C.cur].path));
      if (row) { row.classList.add('current'); row.scrollIntoView({ block: 'center' }); }
    }
  }

  function pruneIgnored(n, test, path) {
    if (n.t === 'obj') {
      n.entries = n.entries.filter((e) => !test(path.concat(e.key)));
      n.entries.forEach((e) => pruneIgnored(e.value, test, path.concat(e.key)));
    } else if (n.t === 'arr') n.items.forEach((v, i) => pruneIgnored(v, test, path.concat(i)));
  }

  function renderTextDiff() {
    const body = $('cBody');
    body.replaceChildren();
    C.blocks = [];
    if (!C.result) { renderDiffTree(); return; }
    const o = cmpOptions();
    const ig = JSS.diff.compileIgnore(o.ignorePaths);
    const prep = (node) => { const c = JSS.ast.clone(node); if (ig.active) pruneIgnored(c, ig.test, []); return serialize(c, { style: 'json', indent: 2, sortKeys: o.ignoreKeyOrder }).text; };
    const d = JSS.textdiff.diffLines(prep(panes.a.res.node), prep(panes.b.res.node));
    const hide = $('cCollapse').checked;
    const keep = new Array(d.rows.length).fill(!hide);
    if (hide) d.rows.forEach((r, i) => { if (r.kind !== 'eq') for (let j = Math.max(0, i - 3); j <= Math.min(d.rows.length - 1, i + 3); j++) keep[j] = true; });
    const grid = h('div', { class: 'tdiff' });
    let budget = 8000, skipped = 0, prevChange = false;
    const flush = () => { if (skipped) { grid.append(h('div', { class: 'trow' }, h('div', { class: 'n' }), h('div', { class: 't v-sum', text: `… ${plural(skipped, 'unchanged line')}` }), h('div', { class: 'n' }), h('div', { class: 't' }))); skipped = 0; } };
    for (let i = 0; i < d.rows.length; i++) {
      const r = d.rows[i];
      if (!keep[i]) { skipped++; prevChange = false; continue; }
      flush();
      if (budget-- <= 0) { grid.append(h('div', { class: 'notice', text: 'Output limited to 8,000 lines. Narrow the comparison with the ignore options.' })); break; }
      const row = h('div', { class: `trow ${r.kind}` }, h('div', { class: 'n', text: r.a ? r.a.n : '' }), h('div', { class: 't a', text: r.a ? r.a.text : '' }), h('div', { class: 'n', text: r.b ? r.b.n : '' }), h('div', { class: 't b', text: r.b ? r.b.text : '' }));
      if (r.kind !== 'eq') { if (!prevChange) { row.dataset.block = String(C.blocks.length); C.blocks.push(row); } prevChange = true; } else prevChange = false;
      grid.append(row);
    }
    flush();
    body.append(headerRow());
    if (d.truncated) body.append(h('div', { class: 'notice', text: 'The documents differ too much for a line-by-line alignment; the changed region is shown as replaced.' }));
    body.append(h('div', { class: 'notice', text: 'Text diff compares the formatted JSON. Case, trim, tolerance and array-mode options apply to the tree diff only.' }), grid);
    $('cPos').textContent = C.cur >= 0 ? `${C.cur + 1} / ${C.blocks.length}` : '';
  }

  function gotoDiff(delta) {
    const r = C.result;
    if (!r || !r.stats.total) return;
    const wrap = (cur, n) => ((((cur < 0 ? (delta > 0 ? -1 : 0) : cur) + delta) % n) + n) % n;
    if (C.tab === 'tree') {
      C.cur = wrap(C.cur, r.diffs.length);
      const path = r.diffs[C.cur].path;
      for (let i = 0; i < path.length; i++) C.closed.delete(pathKey(path.slice(0, i)));
      renderCompare();
    } else {
      if (!C.blocks.length) return;
      C.cur = wrap(C.cur, C.blocks.length);
      C.blocks.forEach((b) => b.classList.remove('current'));
      C.blocks[C.cur].classList.add('current');
      C.blocks[C.cur].scrollIntoView({ block: 'center' });
      $('cPos').textContent = `${C.cur + 1} / ${C.blocks.length}`;
    }
  }

  ['oOrder', 'oArray', 'oArrayKey', 'oIgnore', 'oTol', 'oCase', 'oTrim', 'oMissing'].forEach((id) => {
    $(id).addEventListener(id === 'oIgnore' || id === 'oArrayKey' || id === 'oTol' ? 'input' : 'change', () => {
      $('oArrayKey').hidden = $('oArray').value !== 'key';
      syncOptionsToPrefs();
      scheduleCompare();
    });
  });
  $('cCollapse').addEventListener('change', () => { syncOptionsToPrefs(); renderCompare(); });
  $('cTabs').addEventListener('click', (e) => { const b = e.target.closest('[data-ctab]'); if (b) { C.tab = b.dataset.ctab; prefs.ctab = C.tab; savePrefs(); C.cur = -1; renderCompare(); } });
  $('cNext').addEventListener('click', () => gotoDiff(1));
  $('cPrev').addEventListener('click', () => gotoDiff(-1));
  function swapPanes() {
    const a = panes.a, b = panes.b;
    for (const k of ['name', 'handle', 'mtime', 'dirty', 'undo', 'redo']) [a[k], b[k]] = [b[k], a[k]];
    [a.input.value, b.input.value] = [b.input.value, a.input.value];
    a.pvKeep = b.pvKeep = null; a.selKey = b.selKey = null;
    a.reload(); b.reload();
    persistSession();
  }
  function toggleInputs() {
    const row = $('paneRow');
    row.hidden = !row.hidden;
    for (const id of ['cToggleInputs', 'vToggleInputs']) $(id).textContent = row.hidden ? 'Show panes' : 'Hide panes';
    applyStage();
  }
  $('cSwap').addEventListener('click', swapPanes);
  $('vSwap').addEventListener('click', swapPanes);
  $('cToggleInputs').addEventListener('click', toggleInputs);
  $('vToggleInputs').addEventListener('click', toggleInputs);
  $('cCopyPaths').addEventListener('click', () => {
    if (!C.result) return;
    const lines = C.result.diffs.map((d) => {
      const pv = (n) => (n ? (n.t === 'obj' || n.t === 'arr' ? JSS.ast.describe(n) : serialize(n, { style: 'json', indent: 0 }).text) : '—');
      return `${d.kind}\t${pathToString(d.path, { root: true })}\tA=${trunc(pv(d.a), 80)}\tB=${trunc(pv(d.b), 80)}`;
    });
    copyText(lines.join('\n'), plural(lines.length, 'difference'));
  });
  $('cCopyPatch').addEventListener('click', () => {
    if (!C.result) return;
    // Check the option as selected now: the result itself is recomputed after a short debounce.
    if ($('oArray').value !== 'index') return toast('JSON Patch export needs the array mode “by index”: matched arrays do not map to patch indexes.', 'error');
    copyText(JSS.diff.toJsonPatch(C.result.diffs), 'JSON Patch');
  });

  // ====================================================================== VALIDATE (document A against the JSON Schema in B)
  const VAL = { result: null, note: '' };
  const scheduleValidate = debounce(() => runValidate(), 250);

  function runValidate() {
    const a = panes.a.res, b = panes.b.res;
    VAL.result = null;
    if (!(a && a.ok && b && b.ok)) {
      VAL.note = !a && !b ? 'Put the document in pane A and a JSON Schema in pane B.' : 'Both panes need valid content before A can be validated against B.';
    } else {
      let schema;
      try { schema = JSON.parse(serialize(b.node, { style: 'json', indent: 0, nonFinite: 'null' }).text); } catch (err) { schema = undefined; VAL.note = `Pane B cannot be used as a schema: ${err.message}`; }
      if (schema !== undefined) {
        if (schema === null || (typeof schema !== 'object' && typeof schema !== 'boolean')) VAL.note = 'A JSON Schema must be an object (or true / false).';
        else {
          const t0 = performance.now();
          VAL.result = JSS.schema.validate(a.node, schema);
          VAL.note = '';
          log('info', 'validate-done', { ms: Math.round(performance.now() - t0), errors: VAL.result.errors.length, ignored: VAL.result.ignored.length });
        }
      }
    }
    renderValidate();
  }

  function renderValidate() {
    const stats = $('vStats'), body = $('vBody');
    stats.replaceChildren(); body.replaceChildren();
    const r = VAL.result;
    if (!r) { body.append(h('div', { class: 'empty', text: VAL.note || 'Put the document in pane A and a JSON Schema in pane B.' })); return; }
    stats.append(r.valid ? h('span', { class: 'chip ok', text: 'Valid' }) : h('span', { class: 'chip del', text: `${plural(r.errors.length, 'error')}${r.truncated ? '+' : ''}` }));
    if (r.ignored.length) stats.append(h('span', { class: 'chip warn', title: 'These keywords are not checked by this validator', text: `not checked: ${r.ignored.join(', ')}` }));
    if (r.valid) body.append(h('div', { class: 'empty', text: 'A conforms to the schema in B.' }));
    for (const e of r.errors) {
      const row = h('div', { class: 'v-row', title: 'Show in the tree of A' }, h('span', { class: 'v-path', text: pathToString(e.path, { root: true }) }), h('span', { class: 'chip typ', text: e.keyword }), h('span', { class: 'v-msg', text: e.message }));
      row.addEventListener('click', () => { panes.a.reveal(e.path); setActive(panes.a); });
      body.append(row);
    }
    if (r.truncated) body.append(h('div', { class: 'notice', text: 'Showing the first 500 errors.' }));
  }
  $('vInfer').addEventListener('click', () => {
    if (!panes.a.ok) return toast('Pane A needs valid content to infer a schema from.', 'error');
    panes.b.setFile({ text: JSS.convert.toJsonSchema(panes.a.res.node), name: 'schema.json' });
    toast('Inferred a schema from A into B. Tighten it (formats, minimums, enums) to make validation meaningful.');
    log('info', 'schema-inferred', {});
  });

  // ====================================================================== mode, layout, theme, session
  function applyLayout() {
    const effective = prefs.mode !== 'viewer' ? 2 : prefs.layout;
    $('paneRow').dataset.layout = String(effective);
    $('layoutSwitch').hidden = prefs.mode !== 'viewer';
    $('layoutSwitch').querySelectorAll('button').forEach((b) => b.classList.toggle('active', Number(b.dataset.layout) === prefs.layout));
  }
  function setMode(mode) {
    prefs.mode = mode;
    savePrefs();
    $('stage').dataset.mode = mode;
    $('cmpPanel').hidden = mode !== 'compare';
    $('valPanel').hidden = mode !== 'validate';
    $('paneRow').hidden = false;
    for (const id of ['cToggleInputs', 'vToggleInputs']) $(id).textContent = 'Hide panes';
    applyStage();
    $('modeSwitch').querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
    applyLayout();
    if (mode === 'compare') runCompare();
    if (mode === 'validate') runValidate();
    log('info', 'mode', { mode });
    persistSession();
  }
  $('modeSwitch').addEventListener('click', (e) => { const b = e.target.closest('[data-mode]'); if (b) setMode(b.dataset.mode); });
  $('layoutSwitch').addEventListener('click', (e) => { const b = e.target.closest('[data-layout]'); if (b) { prefs.layout = Number(b.dataset.layout); savePrefs(); applyLayout(); } });

  const THEMES = ['auto', 'light', 'dark'];
  const darkQuery = matchMedia('(prefers-color-scheme: dark)');
  function applyTheme() {
    const dark = prefs.theme === 'dark' || (prefs.theme === 'auto' && darkQuery.matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    $('btnTheme').textContent = prefs.theme[0].toUpperCase() + prefs.theme.slice(1);
  }
  darkQuery.addEventListener('change', applyTheme);
  $('btnTheme').addEventListener('click', () => { prefs.theme = THEMES[(THEMES.indexOf(prefs.theme) + 1) % THEMES.length]; savePrefs(); applyTheme(); });

  function persistSessionNow() {
    const cap = (t) => (t.length > 1500000 ? '' : t);
    const payload = {};
    for (const side of ['a', 'b']) {
      const p = panes[side];
      p.snapshot();
      payload[side] = { text: cap(p.input.value), name: p.name, tab: p.tab, view: p.view, tabs: p.tabs.map((d) => ({ text: cap(d.text), name: d.name, view: d.view })) };
    }
    try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(payload)); } catch (err) { log('warn', 'session-persist-failed', { error: String(err) }); }
  }
  const persistSession = debounce(persistSessionNow, 500);
  function restoreSession() {
    try {
      const s = JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null');
      if (!s) return;
      for (const side of ['a', 'b']) {
        const p = s[side] || {};
        panes[side].input.value = p.text || '';
        panes[side].name = p.name || 'Untitled';
        if (Array.isArray(p.tabs) && p.tabs.length > 1) {
          panes[side].tabs = p.tabs.map((d) => ({ text: String(d.text || ''), name: d.name || 'Untitled', view: VIEWS.includes(d.view) ? d.view : 'raw', handle: null, mtime: 0, dirty: false, undo: [], redo: [] }));
          panes[side].tab = Math.min(Math.max(0, Number(p.tab) || 0), panes[side].tabs.length - 1);
          panes[side].view = panes[side].tabs[panes[side].tab].view;
        }
      }
      log('info', 'session-restored', {});
    } catch (err) { log('warn', 'session-restore-failed', { error: String(err) }); }
  }

  // ====================================================================== command palette (Ctrl/Cmd+K)
  const pal = { items: [], sel: 0, prev: null };
  function setFormat(partial) {
    Object.assign(prefs, partial);
    savePrefs();
    for (const p of Object.values(panes)) { p.pvKeep = null; p.refreshPreview(); }
  }
  function paletteCommands() {
    const p = activePane || panes.a;
    const L = p.label();
    const hasText = Boolean(p.input.value);
    const cmds = [];
    const add = (title, run, o) => cmds.push(Object.assign({ title, run }, o));
    for (const [v, name] of [['raw', 'Raw'], ['preview', 'Preview'], ['tree', 'Tree']]) add(`${L}: show ${name}`, () => p.setView(v, true), { hint: 'view', enabled: p.view !== v });
    add(`${L}: open file…`, () => p.open(), { hint: 'file' });
    add(`${L}: recent files…`, () => p.showRecent(p.q('[data-act="recent"]')), { hint: 'file' });
    add(`${L}: paste from clipboard`, () => p.paste(), { hint: 'file' });
    add(`${L}: save`, () => p.save(false), { hint: 'Ctrl/Cmd+S', enabled: hasText });
    add(`${L}: save as…`, () => p.save(true), { hint: 'file', enabled: hasText });
    add(`${L}: clear`, () => p.clear(), { hint: 'edit', enabled: hasText });
    for (const it of transformDefs(p)) if (!it.sep) add(`${L}: ${it.label}`, it.run, { hint: 'transform', enabled: p.ok });
    add(`${L}: apply format to raw text`, () => p.applyFormat(), { hint: 'edit', enabled: p.ok });
    add(`${L}: copy raw text`, () => copyText(p.input.value, 'raw text'), { hint: 'copy', enabled: hasText });
    add(`${L}: copy formatted output`, () => { if (p.view !== 'preview') p.setView('preview', true); copyText(p.fmtText, 'formatted output'); }, { hint: 'copy', enabled: p.ok });
    add(`${L}: find and replace`, () => { if (p.view === 'tree') p.setView('raw', true); (p.view === 'preview' ? p.prevEd : p.rawEd).openFind(); }, { hint: 'Ctrl/Cmd+F' });
    add(`${L}: undo edit`, () => p.undoEdit(), { hint: 'Ctrl/Cmd+Z in tree', enabled: p.undo.length > 0 });
    add(`${L}: redo edit`, () => p.redoEdit(), { hint: 'Ctrl/Cmd+Shift+Z', enabled: p.redo.length > 0 });
    add(`${L}: expand all`, () => { p.setView('tree', true); p.act_expand(); }, { hint: 'tree', enabled: p.ok });
    add(`${L}: collapse all`, () => { p.setView('tree', true); p.act_collapse(); }, { hint: 'tree', enabled: p.ok });
    add(`${L}: expand embedded JSON`, () => p.q('[data-act="embedded"]').click(), { hint: 'tree', enabled: p.ok && p.embedded > 0 });
    add(`${L}: new document tab`, () => p.newTab(), { hint: 'tabs' });
    add(`${L}: close document tab`, () => p.closeTab(p.tab), { hint: 'tabs' });
    add(`${L}: rename document tab`, () => p.renameTab(p.tab), { hint: 'tabs' });
    add(`${L}: next document tab`, () => p.stepTab(1), { hint: 'tabs', enabled: p.tabs.length > 1 });
    add(`${L}: previous document tab`, () => p.stepTab(-1), { hint: 'tabs', enabled: p.tabs.length > 1 });
    add(maxSide === p.side ? `${L}: restore size` : `${L}: maximise`, () => setMax(maxSide === p.side ? null : p.side), { hint: 'layout' });
    for (const [m, name] of [['viewer', 'Viewer'], ['compare', 'Compare'], ['validate', 'Validate against schema']]) add(`Mode: ${name}`, () => setMode(m), { hint: 'mode', enabled: prefs.mode !== m });
    add('Layout: one pane', () => { prefs.layout = 1; savePrefs(); applyLayout(); }, { hint: 'layout', enabled: prefs.layout !== 1 });
    add('Layout: two panes', () => { prefs.layout = 2; savePrefs(); applyLayout(); }, { hint: 'layout', enabled: prefs.layout !== 2 });
    add('Layout: reset pane sizes', () => { prefs.split = 0.5; prefs.stageSplit = 0.42; applyRatios(); applyStage(); savePrefs(); }, { hint: 'layout' });
    add('Swap A and B', swapPanes, { hint: 'panes' });
    add(prefs.syncScroll ? 'Turn off synced scrolling' : 'Turn on synced scrolling', () => $('btnSync').click(), { hint: 'panes' });
    add('Theme: cycle auto / light / dark', () => $('btnTheme').click(), { hint: 'theme' });
    for (const [k, name] of [['auto', 'same as input'], ['json', 'JSON'], ['python', 'Python'], ['js', 'JavaScript / JSON5'], ...Object.entries(JSS.convert.CONVERTERS).map(([key, c]) => [key, c.label])]) add(`Preview format: ${name}`, () => setFormat({ outStyle: k }), { hint: 'format', enabled: prefs.outStyle !== k });
    for (const [k, name] of [['2', '2 spaces'], ['4', '4 spaces'], ['tab', 'tab'], ['0', 'minified']]) add(`Preview indent: ${name}`, () => setFormat({ indent: k }), { hint: 'format', enabled: prefs.indent !== k });
    add(prefs.sort ? 'Preview: do not sort keys' : 'Preview: sort keys', () => setFormat({ sort: !prefs.sort }), { hint: 'format' });
    return cmds.filter((c) => c.enabled !== false);
  }
  function renderPalette() {
    const words = $('palInput').value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    pal.items = paletteCommands()
      .map((c) => ({ c, hay: `${c.title} ${c.hint || ''}`.toLowerCase() }))
      .filter((x) => words.every((w) => x.hay.includes(w)))
      .sort((a, b) => (words.length ? a.hay.indexOf(words[0]) - b.hay.indexOf(words[0]) : 0))
      .map((x) => x.c);
    pal.sel = Math.min(pal.sel, Math.max(0, pal.items.length - 1));
    const list = $('palList');
    list.replaceChildren();
    if (!pal.items.length) list.append(h('li', { class: 'none', text: 'No matching command' }));
    pal.items.forEach((c, i) => {
      const li = h('li', { role: 'option', id: `pal-${i}`, 'aria-selected': String(i === pal.sel), class: i === pal.sel ? 'sel' : null }, h('span', { text: c.title }), h('span', { class: 'hint', text: c.hint || '' }));
      li.addEventListener('mousedown', (e) => { e.preventDefault(); runPalette(i); });
      list.append(li);
    });
    $('palInput').setAttribute('aria-activedescendant', pal.items.length ? `pal-${pal.sel}` : '');
    const cur = list.querySelector('.sel');
    if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: 'nearest' });
  }
  function openPalette() {
    pal.prev = document.activeElement;
    pal.sel = 0;
    $('palette').hidden = false;
    $('palInput').value = '';
    renderPalette();
    $('palInput').focus();
    log('debug', 'palette-open', {});
  }
  function closePalette(refocus) {
    $('palette').hidden = true;
    if (refocus && pal.prev && pal.prev.focus && document.contains(pal.prev)) pal.prev.focus();
  }
  function runPalette(i) {
    const c = pal.items[i];
    if (!c) return;
    closePalette(true);
    log('info', 'palette-run', { command: c.title });
    try { c.run(); } catch (err) { log('error', 'palette-command-failed', { command: c.title, error: String(err) }); toast(`Command failed: ${err.message || err}`, 'error'); }
  }
  $('palInput').addEventListener('input', () => { pal.sel = 0; renderPalette(); });
  $('palInput').addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); if (pal.items.length) { pal.sel = (pal.sel + (e.key === 'ArrowDown' ? 1 : -1) + pal.items.length) % pal.items.length; renderPalette(); } }
    else if (e.key === 'Enter') { e.preventDefault(); runPalette(pal.sel); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closePalette(true); }
  });
  $('palette').addEventListener('mousedown', (e) => { if (e.target === $('palette')) closePalette(true); });
  $('btnPalette').addEventListener('click', openPalette);

  // ====================================================================== drag & drop
  let dragDepth = 0;
  const hasFiles = (e) => [...((e.dataTransfer && e.dataTransfer.types) || [])].includes('Files');
  window.addEventListener('dragenter', (e) => { if (hasFiles(e)) { dragDepth++; $('dropOverlay').hidden = false; } });
  window.addEventListener('dragleave', (e) => { if (hasFiles(e) && --dragDepth <= 0) { dragDepth = 0; $('dropOverlay').hidden = true; } });
  window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener('drop', async (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    $('dropOverlay').hidden = true;
    const items = [...e.dataTransfer.items].filter((i) => i.kind === 'file');
    const targetEl = e.target.closest ? e.target.closest('.docpane') : null;
    log('info', 'drop', { count: items.length, onPane: targetEl ? targetEl.dataset.pane : null });
    // File handles must be requested synchronously inside the event.
    const pending = items.map((i) => ({ handle: i.getAsFileSystemHandle ? i.getAsFileSystemHandle() : Promise.resolve(null), file: i.getAsFile() }));
    const loaded = [];
    for (const p of pending) {
      try {
        const handle = await p.handle;
        if (handle && handle.kind === 'directory') { toast('Folders are not supported, drop files instead.', 'error'); continue; }
        const file = handle ? await handle.getFile() : p.file;
        if (file.size > MAX_FILE_BYTES) { toast(`${file.name} is too large (${fmtBytes(file.size)}).`, 'error'); continue; }
        loaded.push({ handle: handle && handle.kind === 'file' ? handle : null, name: file.name, text: await file.text(), mtime: file.lastModified });
      } catch (err) { log('error', 'drop-failed', { error: String(err) }); toast(`Could not read the file: ${err.message || err}`, 'error'); }
    }
    if (!loaded.length) return;
    const twoPanes = prefs.mode === 'compare' || prefs.layout === 2;
    let order;
    if (targetEl) { const first = panes[targetEl.dataset.pane]; order = [first, first === panes.a ? panes.b : panes.a]; }
    else if (twoPanes && loaded.length === 1) order = [panes.a.text.trim() && !panes.b.text.trim() ? panes.b : panes.a];
    else order = twoPanes ? [panes.a, panes.b] : [panes.a];
    loaded.slice(0, order.length).forEach((f, i) => order[i].setFile(f));
  });

  // ====================================================================== hand-off & boot
  function applyPending(data) {
    if (!data) return;
    if (data.error) { toast(data.error, 'error'); return; }
    if (typeof data.text === 'string') {
      log('info', 'handoff-received', { chars: data.text.length, source: data.source });
      panes.a.setFile({ text: data.text, name: data.name || 'From page' });
      toast(data.source === 'selection' ? 'Loaded the selected text' : 'Loaded the JSON from the page');
    }
  }
  async function openFromUrl(src) {
    let url;
    try { url = new URL(src); } catch { return toast('Invalid URL.', 'error'); }
    if (url.protocol !== 'file:') return toast('Only file:// URLs can be opened this way.', 'error');
    log('info', 'open-url', { protocol: url.protocol });
    try {
      const res = await fetch(src, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      if (text.length > MAX_FILE_BYTES) throw new Error('File is larger than the 50 MB limit.');
      panes.a.setFile({ text, name: decodeURIComponent(url.pathname.split('/').filter(Boolean).pop() || 'document.json') });
    } catch (err) {
      log('error', 'open-url-failed', { error: String(err) });
      const allowed = await (window.chrome && chrome.extension && chrome.extension.isAllowedFileSchemeAccess ? chrome.extension.isAllowedFileSchemeAccess() : Promise.resolve(undefined)).catch(() => undefined);
      toast(`Could not load the file: ${err.message || err}.${allowed === false ? ' Turn on “Allow access to file URLs” for JSON Studio in chrome://extensions, or use Open.' : ''}`, 'error');
    }
  }

  window.addEventListener('beforeunload', persistSessionNow);
  document.addEventListener('visibilitychange', () => { if (document.hidden) persistSessionNow(); });
  document.addEventListener('keydown', (e) => {
    const mod = (e.metaKey || e.ctrlKey) && !e.altKey;
    if (mod && e.key.toLowerCase() === 's') {
      e.preventDefault();
      (activePane || panes.a).save(e.shiftKey);
    } else if (mod && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      if ($('palette').hidden) openPalette(); else closePalette(true);
    } else if (e.key === 'Escape' && maxSide && $('palette').hidden && !openMenu) setMax(null);
  });

  (async function boot() {
    log('info', 'boot', {});
    C.tab = prefs.ctab;
    const o = prefs.cmp;
    $('oOrder').checked = o.order; $('oArray').value = o.array; $('oArrayKey').value = o.arrayKey; $('oIgnore').value = o.ignore;
    $('oTol').value = o.tol; $('oCase').checked = o.caseI; $('oTrim').checked = o.trim; $('oMissing').checked = o.missing; $('cCollapse').checked = o.collapse;
    $('oArrayKey').hidden = o.array !== 'key';
    for (const p of Object.values(panes)) p.q('[data-depth]').value = String(p.depth);
    applyTheme();
    applyRatios();
    applySync();
    restoreSession();
    setMode(prefs.mode);

    const params = new URLSearchParams(location.search);
    const handoffId = params.get('h');
    const src = params.get('src');
    if (handoffId || src) history.replaceState(null, '', location.pathname);

    await Promise.all([panes.a.reload(), panes.b.reload()]);

    if (handoffId && window.chrome && chrome.storage && chrome.storage.session) {
      try {
        const key = PENDING_PREFIX + handoffId;
        const got = await chrome.storage.session.get(key);
        await chrome.storage.session.remove(key);
        if (got[key]) applyPending(got[key]); else log('warn', 'handoff-missing', {});
      } catch (err) { log('error', 'handoff-read-failed', { error: String(err) }); }
    }
    if (src) await openFromUrl(src);
  })();
})();
