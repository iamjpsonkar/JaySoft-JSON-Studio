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
  const DIFF_BUDGET = 6000;
  const WORKER_MIN_CHARS = 200000;
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
    theme: 'auto', mode: 'viewer', layout: 2, indent: '2', outStyle: 'auto', sort: false, depth: 2, ctab: 'tree',
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
    if (!['viewer', 'compare'].includes(prefs.mode)) prefs.mode = 'viewer';
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

  class DocPane {
    constructor(side) {
      this.side = side;
      this.root = $('paneTpl').content.firstElementChild.cloneNode(true);
      this.root.dataset.pane = side;
      this.q('[data-label]').textContent = side.toUpperCase();
      this.input = this.q('[data-input]');
      Object.assign(this, {
        text: '', res: null, seq: 0, pick: undefined, view: prefs.panes[side].view, depth: prefs.depth,
        expanded: new Set(), collapsed: new Set(), limits: new Map(), term: '', matches: [], matchKeys: new Set(), visible: new Set(),
        idx: -1, curKey: null, filter: false, handle: null, name: 'Untitled', mtime: 0, dirty: false, embedded: 0, nodes: 0,
        query: null, queryOpen: false, repairInfo: null, fmtText: '', onResult: () => {},
      });
      this.rowInfo = new WeakMap();
      this.rowEls = new Map();
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
      this.input.addEventListener('input', () => { this.pick = undefined; this.repairInfo = null; this.dirty = true; this.scheduleReload(); persistSession(); });
      this.root.addEventListener('focusin', () => setActive(this));
      this.root.addEventListener('mousedown', () => setActive(this));
      this.q('[data-views]').addEventListener('click', (e) => { const b = e.target.closest('[data-view]'); if (b) this.setView(b.dataset.view, true); });
      this.root.addEventListener('click', (e) => {
        const b = e.target.closest('[data-act]');
        if (!b) return;
        const actions = {
          open: () => this.open(), paste: () => this.paste(), clear: () => this.clear(),
          save: () => this.save(false), saveas: () => this.save(true), apply: () => this.applyFormat(),
          'copy-raw': () => this.input.value && copyText(this.input.value, 'raw text'),
          'copy-fmt': () => this.fmtText && copyText(this.fmtText, 'formatted output'),
          download: () => this.download(), 'save-fmt': () => this.saveFormatted(),
          prev: () => this.goToMatch(this.idx - 1), next: () => this.goToMatch(this.idx + 1),
          'expand-all': () => { this.depth = 99; this.collapsed.clear(); this.expanded.clear(); this.q('[data-depth]').value = '99'; this.renderTree(); },
          'collapse-all': () => { this.depth = 1; this.collapsed.clear(); this.expanded.clear(); this.q('[data-depth]').value = '1'; this.renderTree(); },
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
      this.q('[data-f-style]').addEventListener('change', (e) => { prefs.outStyle = e.target.value; savePrefs(); panes.a.refreshPreview(); panes.b.refreshPreview(); });
      this.q('[data-f-indent]').addEventListener('change', (e) => { prefs.indent = e.target.value; savePrefs(); panes.a.refreshPreview(); panes.b.refreshPreview(); });
      this.q('[data-f-sort]').addEventListener('change', (e) => { prefs.sort = e.target.checked; savePrefs(); panes.a.refreshPreview(); panes.b.refreshPreview(); });

      const tree = this.q('[data-tree]');
      tree.addEventListener('click', (e) => this.onTreeClick(e));
      tree.addEventListener('dblclick', (e) => this.onTreeDblClick(e));
    }

    // ---------------------------------------------------------------- loading
    async reload(opts) {
      opts = opts || {};
      const text = this.input.value;
      this.text = text;
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

    /** Switch to the tree the first time content arrives, unless the user chose a view for this pane. */
    autoSwitch() {
      if (!prefs.panes[this.side].picked && this.view === 'raw') this.setView('tree', false);
    }

    setFile(f) {
      this.input.value = f.text;
      this.handle = f.handle || null; this.name = f.name; this.mtime = f.mtime || 0; this.dirty = false; this.pick = undefined; this.repairInfo = null;
      this.autoSwitch();
      this.reload();
      persistSession();
    }

    setView(view, byUser) {
      this.view = view;
      prefs.panes[this.side].view = view;
      if (byUser) prefs.panes[this.side].picked = true;
      savePrefs();
      this.render();
    }

    // ---------------------------------------------------------------- rendering
    outputStyle() {
      if (prefs.outStyle !== 'auto') return prefs.outStyle;
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
            const line = this.input.value.slice(0, pos).split('\n').length;
            this.input.scrollTop = Math.max(0, (line - 4) * 20.8);
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
      if (this.view === 'tree') { if (this.queryOpen) this.renderQuery(); else this.renderTree(); } else if (this.view === 'preview') this.renderPreview();
    }

    refreshPreview() { if (this.view === 'preview') this.renderPreview(); }

    renderPreview() {
      this.q('[data-f-style]').value = prefs.outStyle; this.q('[data-f-indent]').value = prefs.indent; this.q('[data-f-sort]').checked = prefs.sort;
      const pre = this.q('[data-preview]');
      if (!this.ok) { pre.replaceChildren(h('span', { class: 'v-sum', text: this.res ? 'Fix the error shown above to see the preview.' : 'Nothing to preview yet.' })); this.fmtText = ''; this.q('[data-f-note]').textContent = ''; return; }
      const out = this.formattedOut();
      this.fmtText = out.text;
      highlightInto(pre, out.text);
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
      const row = h('div', { class: 'row', style: `padding-left:${8 + depth * 16}px` });
      row.dataset.pk = pk;
      if (this.matchKeys.has(pk)) row.classList.add('match');
      if (this.curKey === pk) row.classList.add('current');
      row.append(h('span', { class: `caret${container ? '' : ' leaf'}`, text: container ? (open ? '▾' : '▸') : '' }));
      if (kinfo) {
        const label = kinfo.idx ? String(kinfo.text) : (kinfo.keyType === 'num' || kinfo.keyType === 'tuple' ? kinfo.text : JSON.stringify(trunc(kinfo.text, 120)));
        row.append(h('span', { class: `k${kinfo.idx ? ' idx' : ''}`, text: label }), h('span', { class: 'colon', text: ':' }));
      }
      row.append(valueSpan(node, open), ...badges(node));
      row.append(h('span', { class: 'acts' },
        h('button', { 'data-act': 'path', title: 'Copy path', text: 'path' }),
        h('button', { 'data-act': 'copy', title: container ? 'Copy this subtree as JSON' : 'Copy value', text: 'copy' })));
      parent.append(row);
      this.rowInfo.set(row, { node, path });
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
          text: k, idx: node.t === 'arr', keyType: node.t === 'obj' ? node.entries[i].keyType : undefined,
        }, depth, ctx);
        if (ctx.budget !== before) shown++;
        if (ctx.budget <= 0) return;
      }
      if (!filtering && i < list.length) {
        const more = h('div', { class: 'more-row', style: `padding-left:${8 + depth * 16 + 18}px`, text: `… ${(list.length - i).toLocaleString()} more (click to show ${Math.min(200, list.length - i)} more)` });
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
      if (!this.res) { tree.append(h('div', { class: 'empty', text: 'Nothing here yet. Use Open or Paste above, or switch to Raw to type.' })); return; }
      if (!this.res.ok) { tree.append(h('div', { class: 'empty', text: 'Fix the error shown above to see the tree.' })); return; }
      const ctx = { budget: TREE_BUDGET, over: false };
      const frag = document.createDocumentFragment();
      const t0 = performance.now();
      this.renderNode(frag, this.res.node, [], null, 0, ctx);
      tree.append(frag);
      if (ctx.over) tree.append(h('div', { class: 'notice', text: `Showing the first ${TREE_BUDGET.toLocaleString()} rows to keep the page responsive. Collapse branches, lower the depth, or use search / JSONPath to reach the rest.` }));
      log('debug', 'tree-rendered', { pane: this.side, rows: TREE_BUDGET - ctx.budget, ms: Math.round(performance.now() - t0) });
    }

    onTreeClick(e) {
      const row = e.target.closest('.row');
      if (e.target.closest('.more-row') || !row) return;
      const info = this.rowInfo.get(row);
      if (!info) return;
      const act = e.target.closest('[data-act]');
      if (act) {
        if (act.dataset.act === 'path') copyText(pathToString(info.path), 'path');
        else if (act.dataset.act === 'copy') copyText(serialize(info.node, { style: 'json', indent: 2 }).text, info.node.t === 'obj' || info.node.t === 'arr' ? 'subtree' : 'value');
        return;
      }
      if (e.target.closest('input')) return;
      if (info.node.t === 'obj' || info.node.t === 'arr') {
        const pk = row.dataset.pk;
        if (this.isOpen(pk, info.path.length)) { this.collapsed.add(pk); this.expanded.delete(pk); } else { this.expanded.add(pk); this.collapsed.delete(pk); }
        this.renderTree();
      }
    }

    onTreeDblClick(e) {
      const span = e.target.closest('.val');
      if (!span) return;
      const info = this.rowInfo.get(span.closest('.row'));
      if (!info) return;
      const n = info.node;
      const input = h('input', { class: 'edit', value: n.t === 'str' ? JSON.stringify(n.v) : n.t === 'num' ? n.raw : n.t === 'bool' ? String(n.v) : 'null', 'aria-label': 'Edit value' });
      span.replaceWith(input);
      input.focus();
      input.select();
      let finished = false;
      const finish = (commit) => {
        if (finished) return;
        finished = true;
        if (commit) this.commitEdit(n, input.value); else this.renderTree();
      };
      input.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') { ev.preventDefault(); finish(true); } else if (ev.key === 'Escape') finish(false);
      });
      input.addEventListener('blur', () => finish(false));
    }

    commitEdit(node, text) {
      const p = JSS.parser.tryParse(text.trim());
      const repl = p.ok && !(p.node.t === 'str' && p.node.tag === 'repr') ? p.node : JSS.ast.N.str(text);
      for (const k of Object.keys(node)) delete node[k];
      Object.assign(node, repl);
      log('info', 'tree-edit', { pane: this.side, newType: repl.t });
      this.syncInputFromTree();
    }

    syncInputFromTree() {
      const out = serialize(this.res.node, { style: this.outputStyle(), indent: this.indentOpt() === 0 ? 2 : this.indentOpt(), sortKeys: false });
      this.input.value = out.text;
      this.dirty = true;
      persistSession();
      this.reload({ keepView: true });
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
      this.input.value = ''; this.handle = null; this.name = 'Untitled'; this.dirty = false; this.repairInfo = null; this.pick = undefined;
      this.reload(); persistSession(); this.input.focus();
    }
    async paste() {
      try {
        this.input.value = await navigator.clipboard.readText();
        this.dirty = true;
        this.autoSwitch();
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
        const ext = { json: 'json', python: 'py', js: 'js' }[this.outputStyle()];
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

    async write(handle, text) {
      const w = await handle.createWritable();
      try { await w.write(text); } catch (err) { await w.abort().catch(() => {}); throw err; }
      await w.close();
    }

    download() {
      if (!this.fmtText) return;
      const ext = { json: 'json', python: 'py', js: 'js' }[this.outputStyle()];
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
    panes[side].onResult = () => { if (prefs.mode === 'compare') scheduleCompare(); };
  }
  setActive(panes.a);

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

  const headerRow = () => h('div', { class: 'hdr' }, h('div', { text: `A${panes.a.name !== 'Untitled' ? ` · ${panes.a.name}` : ''}` }), h('div', { text: `B${panes.b.name !== 'Untitled' ? ` · ${panes.b.name}` : ''}` }));

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
  $('cSwap').addEventListener('click', () => {
    const a = panes.a, b = panes.b;
    for (const k of ['name', 'handle', 'mtime', 'dirty']) [a[k], b[k]] = [b[k], a[k]];
    [a.input.value, b.input.value] = [b.input.value, a.input.value];
    a.reload(); b.reload();
    persistSession();
  });
  $('cToggleInputs').addEventListener('click', () => {
    const row = $('paneRow');
    row.hidden = !row.hidden;
    $('cToggleInputs').textContent = row.hidden ? 'Show panes' : 'Hide panes';
  });
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

  // ====================================================================== mode, layout, theme, session
  function applyLayout() {
    const effective = prefs.mode === 'compare' ? 2 : prefs.layout;
    $('paneRow').dataset.layout = String(effective);
    $('layoutSwitch').hidden = prefs.mode === 'compare';
    $('layoutSwitch').querySelectorAll('button').forEach((b) => b.classList.toggle('active', Number(b.dataset.layout) === prefs.layout));
  }
  function setMode(mode) {
    prefs.mode = mode;
    savePrefs();
    $('stage').dataset.mode = mode;
    $('cmpPanel').hidden = mode !== 'compare';
    $('paneRow').hidden = false;
    $('cToggleInputs').textContent = 'Hide panes';
    $('modeSwitch').querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
    applyLayout();
    if (mode === 'compare') runCompare();
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
    for (const side of ['a', 'b']) payload[side] = { text: cap(panes[side].input.value), name: panes[side].name };
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
        // an empty pane always starts in Raw so there is somewhere to paste
        if (!p.text) panes[side].view = 'raw';
      }
      log('info', 'session-restored', {});
    } catch (err) { log('warn', 'session-restore-failed', { error: String(err) }); }
  }

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
    if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 's') {
      e.preventDefault();
      (activePane || panes.a).save(e.shiftKey);
    }
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
    restoreSession();
    setMode(prefs.mode);

    const params = new URLSearchParams(location.search);
    const handoffId = params.get('h');
    const src = params.get('src');
    if (handoffId || src) history.replaceState(null, '', location.pathname);

    await Promise.all([panes.a.reload(), panes.b.reload()]);
    // a pane that restored content should show it, not a stale empty-pane view
    for (const p of Object.values(panes)) if (p.text.trim() && p.view === 'raw' && !prefs.panes[p.side].picked) p.setView('tree', false);

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
