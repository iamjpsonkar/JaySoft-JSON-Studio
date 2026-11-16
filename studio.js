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
    theme: 'auto', mode: 'viewer', indent: '2', outStyle: 'auto', sort: false, tab: 'tree', depth: 2, ctab: 'tree',
    cmp: { order: true, array: 'index', arrayKey: 'id', ignore: '', tol: 0, caseI: false, trim: false, missing: false, collapse: true },
  };
  function loadPrefs() {
    try {
      const p = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}');
      Object.assign(prefs, p, { cmp: Object.assign(prefs.cmp, p.cmp || {}) });
    } catch (err) { log('warn', 'prefs-load-failed', { error: String(err) }); }
    if (!['viewer', 'compare'].includes(prefs.mode)) prefs.mode = 'viewer';
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

  // ====================================================================== VIEWER
  const el = {
    vInput: $('vInput'), vInfo: $('vInfo'), vName: $('vName'), vTree: $('vTree'), vMeta: $('vMeta'),
    vSearch: $('vSearch'), vSearchCount: $('vSearchCount'), vFilter: $('vFilter'), vQuery: $('vQuery'), vQueryBox: $('vQueryBox'),
    vFormatted: $('vFormatted'), vFormattedBox: $('vFormattedBox'), fNote: $('fNote'), vEmbedded: $('vEmbedded'),
  };
  const V = {
    text: '', res: null, seq: 0, pick: undefined, tab: 'tree', depth: 2, expanded: new Set(), collapsed: new Set(), limits: new Map(),
    term: '', matches: [], matchKeys: new Set(), visible: new Set(), idx: -1, curKey: null, filter: false,
    handle: null, name: 'Untitled', mtime: 0, dirty: false, embedded: 0, nodes: 0, query: null, repairInfo: null, fmtText: '',
  };
  const rowInfo = new WeakMap();
  const rowEls = new Map();

  const outputStyle = () => {
    if (prefs.outStyle !== 'auto') return prefs.outStyle;
    const f = V.res && V.res.format;
    return f === 'python' ? 'python' : f === 'javascript' || f === 'json5' ? 'js' : 'json';
  };
  const indentOpt = () => (prefs.indent === 'tab' ? 'tab' : Number(prefs.indent));
  const formattedOut = () => serialize(V.res.node, { style: outputStyle(), indent: indentOpt(), sortKeys: prefs.sort, nonFinite: 'keep' });

  async function reloadViewer(opts) {
    opts = opts || {};
    const text = el.vInput.value;
    V.text = text;
    const seq = ++V.seq;
    if (!text.trim()) {
      V.res = null; V.nodes = 0; V.embedded = 0;
      resetView();
      renderViewer();
      return;
    }
    setStatus('Parsing…');
    const res = await loadText(text, { pick: V.pick });
    if (seq !== V.seq) { log('debug', 'viewer-stale-result-dropped', { seq }); return; }
    setStatus('');
    V.res = res;
    V.nodes = res.ok ? countNodes(res.node) : 0;
    V.embedded = res.ok && text.length < 3000000 ? JSS.loader.findEmbedded(res.node, 200).length : 0;
    if (!opts.keepView) resetView();
    else if (V.term) runSearch(true);
    $('stLeft').textContent = res.ok ? `${res.label} · parsed in ${res.ms} ms` : 'Parse error';
    renderViewer();
  }
  const scheduleReload = debounce(() => reloadViewer(), 250);

  function resetView() {
    V.expanded.clear(); V.collapsed.clear(); V.limits.clear(); V.curKey = null; V.idx = -1;
    V.query = null;
    runSearch(true);
  }

  function renderViewer() {
    el.vInfo.replaceChildren();
    if (V.repairInfo) {
      el.vInfo.append(h('div', { class: 'info' }, h('div', { class: 'note-repair' },
        h('strong', { text: 'Repaired: ' }), V.repairInfo.changes.join('; '), ' ',
        h('button', { class: 'tb', text: 'Undo', onclick: undoRepair }))));
    }
    if (V.res) {
      el.vInfo.append(resultInfo(V.res, {
        goTo: (pos) => { el.vInput.focus(); el.vInput.setSelectionRange(pos, pos); const line = el.vInput.value.slice(0, pos).split('\n').length; el.vInput.scrollTop = Math.max(0, (line - 4) * 20.8); },
        repair: doRepair,
        pick: (i) => { V.pick = i; reloadViewer(); },
      }));
    }
    el.vName.textContent = V.name + (V.dirty && V.handle ? ' ●' : '');
    $('vTabs').querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.tab === V.tab));
    $('vTree').hidden = V.tab !== 'tree';
    el.vFormattedBox.hidden = V.tab !== 'formatted';
    el.vQueryBox.hidden = V.tab !== 'query';
    const ok = Boolean(V.res && V.res.ok);
    el.vMeta.textContent = ok ? `${plural(V.nodes, 'node')} · ${fmtBytes(V.text.length)}` : '';
    el.vEmbedded.hidden = !ok || V.embedded === 0;
    el.vEmbedded.textContent = `Expand embedded JSON (${V.embedded}${V.embedded >= 200 ? '+' : ''})`;
    $('vApply').disabled = !ok;
    $('vBar').querySelectorAll('button,input,select').forEach((c) => { if (c !== el.vEmbedded) c.disabled = !ok; });
    $('btnSave').disabled = !V.text;
    $('btnSaveAs').disabled = !V.text;
    if (V.tab === 'tree') renderTree();
    else if (V.tab === 'formatted') renderFormatted();
    else renderQuery();
  }

  function setTab(tab) {
    V.tab = tab;
    prefs.tab = tab;
    savePrefs();
    renderViewer();
  }

  // ---- repair
  function doRepair() {
    const r = JSS.loader.repair(el.vInput.value);
    if (!r) return toast('No automatic repair is possible for this input.', 'error');
    V.repairInfo = { before: el.vInput.value, changes: r.changes };
    el.vInput.value = r.text;
    log('info', 'repair-applied', { changes: r.changes.length });
    reloadViewer();
  }
  function undoRepair() {
    if (!V.repairInfo) return;
    el.vInput.value = V.repairInfo.before;
    V.repairInfo = null;
    reloadViewer();
  }

  // ---- tree
  const isOpen = (pk, depth) => (V.collapsed.has(pk) ? false : V.expanded.has(pk) ? true : depth < V.depth);
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

  function renderNode(parent, node, path, kinfo, depth, ctx) {
    if (ctx.budget <= 0) { ctx.over = true; return; }
    const pk = pathKey(path);
    if (V.filter && V.term && !V.visible.has(pk)) return;
    ctx.budget--;
    const container = node.t === 'obj' || node.t === 'arr';
    const open = container && isOpen(pk, depth);
    const row = h('div', { class: 'row', style: `padding-left:${8 + depth * 16}px` });
    row.dataset.pk = pk;
    if (V.matchKeys.has(pk)) row.classList.add('match');
    if (V.curKey === pk) row.classList.add('current');
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
    rowInfo.set(row, { node, path });
    rowEls.set(pk, row);
    if (open) renderChildren(parent, node, path, depth + 1, ctx, pk);
  }

  function renderChildren(parent, node, path, depth, ctx, pk) {
    const list = children(node);
    const limit = V.limits.get(pk) || 200;
    const filtering = V.filter && V.term;
    let shown = 0, i = 0;
    for (; i < list.length; i++) {
      if (!filtering && shown >= limit) break;
      const [k, v] = list[i];
      const before = ctx.budget;
      renderNode(parent, v, path.concat(k), {
        text: k, idx: node.t === 'arr', keyType: node.t === 'obj' ? node.entries[i].keyType : undefined,
      }, depth, ctx);
      if (ctx.budget !== before) shown++;
      if (ctx.budget <= 0) return;
    }
    if (!filtering && i < list.length) {
      const more = h('div', { class: 'more-row', style: `padding-left:${8 + depth * 16 + 18}px`, text: `… ${(list.length - i).toLocaleString()} more (click to show ${Math.min(200, list.length - i)} more)` });
      more.addEventListener('click', () => { V.limits.set(pk, limit + 200); renderTree(); });
      parent.append(more);
    }
  }

  function renderTree() {
    const tree = el.vTree;
    rowEls.clear();
    tree.replaceChildren();
    if (!V.res) { tree.append(h('div', { class: 'empty', text: 'Paste or open something on the left.' })); return; }
    if (!V.res.ok) { tree.append(h('div', { class: 'empty', text: 'Fix the error shown on the left to see the tree.' })); return; }
    const ctx = { budget: TREE_BUDGET, over: false };
    const frag = document.createDocumentFragment();
    const t0 = performance.now();
    renderNode(frag, V.res.node, [], null, 0, ctx);
    tree.append(frag);
    if (ctx.over) tree.append(h('div', { class: 'notice', text: `Showing the first ${TREE_BUDGET.toLocaleString()} rows to keep the page responsive. Collapse branches, lower the depth, or use search / JSONPath to reach the rest.` }));
    log('debug', 'tree-rendered', { rows: TREE_BUDGET - ctx.budget, ms: Math.round(performance.now() - t0) });
  }

  el.vTree.addEventListener('click', (e) => {
    const row = e.target.closest('.row');
    const more = e.target.closest('.more-row');
    if (more || !row) return;
    const info = rowInfo.get(row);
    if (!info) return;
    const act = e.target.closest('[data-act]');
    if (act) {
      if (act.dataset.act === 'path') copyText(pathToString(info.path), 'path');
      else copyText(serialize(info.node, { style: 'json', indent: 2 }).text, info.node.t === 'obj' || info.node.t === 'arr' ? 'subtree' : 'value');
      return;
    }
    if (e.target.closest('input')) return;
    if (info.node.t === 'obj' || info.node.t === 'arr') {
      const pk = row.dataset.pk;
      const depth = info.path.length;
      if (isOpen(pk, depth)) { V.collapsed.add(pk); V.expanded.delete(pk); } else { V.expanded.add(pk); V.collapsed.delete(pk); }
      renderTree();
    }
  });

  // in-tree editing of primitive values
  el.vTree.addEventListener('dblclick', (e) => {
    const span = e.target.closest('.val');
    if (!span) return;
    const info = rowInfo.get(span.closest('.row'));
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
      if (commit) commitEdit(n, input.value); else renderTree();
    };
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') { ev.preventDefault(); finish(true); } else if (ev.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(false));
  });

  function commitEdit(node, text) {
    const p = JSS.parser.tryParse(text.trim());
    let repl;
    if (p.ok && !(p.node.t === 'str' && p.node.tag === 'repr')) repl = p.node;
    else repl = JSS.ast.N.str(text);
    for (const k of Object.keys(node)) delete node[k];
    Object.assign(node, repl);
    log('info', 'tree-edit', { newType: repl.t });
    syncInputFromTree();
  }

  function syncInputFromTree() {
    const out = serialize(V.res.node, { style: outputStyle(), indent: indentOpt() === 0 ? 2 : indentOpt(), sortKeys: false });
    el.vInput.value = out.text;
    V.dirty = true;
    persistSession();
    reloadViewer({ keepView: true });
  }

  // ---- search
  function runSearch(silent) {
    V.term = el.vSearch.value.trim().toLowerCase();
    V.matches = []; V.matchKeys = new Set(); V.visible = new Set(); V.idx = -1; V.curKey = null;
    const t = V.term;
    if (t && V.res && V.res.ok) {
      walk(V.res.node, (n, path) => {
        if (V.matches.length >= 5000) return false;
        const last = path[path.length - 1];
        let hit = typeof last === 'string' && last.toLowerCase().includes(t);
        if (!hit) {
          if (n.t === 'str') hit = n.v.toLowerCase().includes(t);
          else if (n.t === 'num') hit = n.raw.toLowerCase().includes(t);
          else if (n.t === 'bool') hit = String(n.v).includes(t);
          else if (n.t === 'null') hit = 'null'.includes(t);
        }
        if (hit) V.matches.push(path);
        return undefined;
      });
      for (const p of V.matches) for (let i = 0; i <= p.length; i++) V.visible.add(pathKey(p.slice(0, i)));
      for (const p of V.matches) V.matchKeys.add(pathKey(p));
      // Open the branches of the first matches so they are visible and highlighted, not hidden in collapsed nodes.
      for (const p of V.matches.slice(0, 200)) expandAncestors(p);
    }
    el.vSearchCount.textContent = !t ? '' : V.matches.length ? `${V.matches.length}${V.matches.length >= 5000 ? '+' : ''} matches` : 'no matches';
    log('debug', 'search', { termLength: t.length, matches: V.matches.length });
    if (silent) return;
    if (V.matches.length) goToMatch(0); else renderViewer();
  }
  const runSearchDebounced = debounce(() => runSearch(), 200);

  function goToMatch(i) {
    if (!V.matches.length) return;
    V.idx = ((i % V.matches.length) + V.matches.length) % V.matches.length;
    const path = V.matches[V.idx];
    V.curKey = pathKey(path);
    el.vSearchCount.textContent = `${V.idx + 1} / ${V.matches.length}${V.matches.length >= 5000 ? '+' : ''}`;
    reveal(path);
  }

  /** Opens every ancestor of `path` and widens paged arrays so the row exists in the tree. */
  function expandAncestors(path) {
    const root = V.res.node;
    for (let i = 0; i < path.length; i++) {
      const anc = path.slice(0, i);
      const pk = pathKey(anc);
      V.expanded.add(pk); V.collapsed.delete(pk);
      const n = getAt(root, anc);
      if (n && n.t === 'arr' && typeof path[i] === 'number') V.limits.set(pk, Math.max(V.limits.get(pk) || 200, Math.ceil((path[i] + 1) / 200) * 200));
    }
  }

  function reveal(path) {
    expandAncestors(path);
    if (V.tab !== 'tree') { V.tab = 'tree'; renderViewer(); } else renderTree();
    const row = rowEls.get(pathKey(path));
    if (row) { row.scrollIntoView({ block: 'center' }); row.classList.add('flash'); }
  }

  // ---- formatted output
  function renderFormatted() {
    $('fStyle').value = prefs.outStyle; $('fIndent').value = prefs.indent; $('fSort').checked = prefs.sort;
    if (!V.res || !V.res.ok) { el.vFormatted.value = ''; el.fNote.textContent = ''; V.fmtText = ''; return; }
    const out = formattedOut();
    V.fmtText = out.text;
    el.vFormatted.value = out.text.length > 2000000 ? `${out.text.slice(0, 2000000)}\n… truncated in this view. Copy and Download give the full text.` : out.text;
    el.fNote.textContent = out.warnings.join(' · ');
  }

  // ---- query
  function runQuery() {
    const src = el.vQuery.value.trim();
    if (!src) { V.query = null; if (V.tab === 'query') setTab('tree'); else renderViewer(); return; }
    if (!V.res || !V.res.ok) return;
    const r = JSS.query.query(V.res.node, src);
    V.query = r;
    log('info', 'query', { results: r.results.length, error: Boolean(r.error) });
    V.tab = 'query'; // transient: the query tab is not saved as the preferred tab
    renderViewer();
  }
  function renderQuery() {
    const box = el.vQueryBox;
    box.replaceChildren();
    $('vQueryCount').textContent = V.query && !V.query.error ? `(${V.query.results.length}${V.query.truncated ? '+' : ''})` : '';
    if (!V.query) { box.append(h('div', { class: 'empty', text: 'Type a JSONPath above and press Enter.' })); return; }
    if (V.query.error) { box.append(h('div', { class: 'notice', text: `Query error: ${V.query.error}` })); return; }
    if (!V.query.results.length) { box.append(h('div', { class: 'empty', text: 'No results.' })); return; }
    const frag = document.createDocumentFragment();
    for (const r of V.query.results.slice(0, 2000)) {
      const preview = r.node.t === 'obj' || r.node.t === 'arr' ? JSS.ast.describe(r.node) : serialize(r.node, { style: 'json', indent: 0 }).text;
      const row = h('div', { class: 'q-row', title: 'Show in tree' }, h('span', { class: 'q-path', text: pathToString(r.path, { root: true }) }), h('span', { class: 'q-val', text: trunc(preview, 200) }));
      row.addEventListener('click', () => reveal(r.path));
      frag.append(row);
    }
    box.append(frag);
    if (V.query.results.length > 2000) box.append(h('div', { class: 'notice', text: 'Showing the first 2,000 results.' }));
  }

  // ---- viewer: file operations
  async function openIntoViewer() {
    try {
      const f = await pickFile();
      setViewerFile(f);
    } catch (err) {
      if (err.name === 'AbortError') return;
      log('error', 'open-failed', { error: String(err) });
      toast(`Open failed: ${err.message || err}`, 'error');
    }
  }
  function setViewerFile(f) {
    el.vInput.value = f.text;
    V.handle = f.handle || null; V.name = f.name; V.mtime = f.mtime || 0; V.dirty = false; V.pick = undefined; V.repairInfo = null;
    if (prefs.mode !== 'viewer') setMode('viewer');
    reloadViewer();
    persistSession();
  }
  async function saveViewer(as) {
    if (!V.text) return;
    try {
      let handle = V.handle;
      if (as || !handle) {
        if (!window.showSaveFilePicker) return toast('This browser does not support the File System Access API.', 'error');
        handle = await window.showSaveFilePicker({ suggestedName: V.name.includes('.') ? V.name : `${V.name}.json`, types: PICKER_TYPES });
      } else {
        if (!(await ensurePermission(handle, 'readwrite'))) return toast('Write permission was denied.', 'error');
        const cur = await handle.getFile();
        if (V.mtime && cur.lastModified > V.mtime && !confirm(`"${V.name}" changed on disk after you opened it.\n\nOverwrite it with your version?`)) return;
      }
      const w = await handle.createWritable();
      try { await w.write(el.vInput.value); } catch (err) { await w.abort().catch(() => {}); throw err; }
      await w.close();
      V.handle = handle; V.name = handle.name; V.mtime = (await handle.getFile()).lastModified; V.dirty = false;
      log('info', 'saved', { name: V.name, bytes: el.vInput.value.length });
      toast(`Saved ${V.name}`);
      renderViewer();
    } catch (err) {
      if (err.name === 'AbortError') return;
      log('error', 'save-failed', { error: String(err) });
      toast(`Save failed: ${err.message || err}`, 'error');
    }
  }

  // ---- viewer: wiring
  el.vInput.addEventListener('input', () => { V.pick = undefined; V.repairInfo = null; V.dirty = true; scheduleReload(); persistSession(); });
  $('vClear').addEventListener('click', () => {
    el.vInput.value = ''; V.handle = null; V.name = 'Untitled'; V.dirty = false; V.repairInfo = null; V.pick = undefined;
    reloadViewer(); persistSession(); el.vInput.focus();
  });
  async function pasteInto(textarea, after) {
    try {
      textarea.value = await navigator.clipboard.readText();
      after();
    } catch {
      textarea.focus();
      toast('Clipboard access was blocked. Press Ctrl/Cmd+V in the box instead.');
    }
  }
  $('vPaste').addEventListener('click', () => pasteInto(el.vInput, () => { V.dirty = true; reloadViewer(); persistSession(); }));
  $('vApply').addEventListener('click', () => {
    if (!V.res || !V.res.ok) return;
    el.vInput.value = formattedOut().text;
    V.repairInfo = null; V.dirty = true;
    reloadViewer({ keepView: true });
    persistSession();
    toast('Input replaced with the formatted output');
  });
  $('vTabs').addEventListener('click', (e) => { const b = e.target.closest('[data-tab]'); if (b) { if (b.dataset.tab === 'query' && !V.query) { el.vQuery.focus(); return; } setTab(b.dataset.tab); } });
  el.vSearch.addEventListener('input', runSearchDebounced);
  el.vSearch.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); if (V.term) goToMatch(V.idx + (e.shiftKey ? -1 : 1)); } });
  $('vNext').addEventListener('click', () => goToMatch(V.idx + 1));
  $('vPrev').addEventListener('click', () => goToMatch(V.idx - 1));
  el.vFilter.addEventListener('change', () => { V.filter = el.vFilter.checked; renderViewer(); });
  el.vQuery.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); runQuery(); } });
  el.vQuery.addEventListener('input', () => { if (!el.vQuery.value.trim()) runQuery(); });
  $('vExpandAll').addEventListener('click', () => { V.depth = 99; V.collapsed.clear(); V.expanded.clear(); $('vDepth').value = '99'; renderTree(); });
  $('vCollapseAll').addEventListener('click', () => { V.depth = 1; V.collapsed.clear(); V.expanded.clear(); $('vDepth').value = '1'; renderTree(); });
  $('vDepth').addEventListener('change', (e) => { V.depth = Number(e.target.value); prefs.depth = V.depth; savePrefs(); V.collapsed.clear(); V.expanded.clear(); renderTree(); });
  el.vEmbedded.addEventListener('click', () => {
    const n = JSS.loader.expandEmbedded(V.res.node);
    toast(`Expanded ${plural(n, 'embedded value')}`);
    syncInputFromTree();
  });
  $('fStyle').addEventListener('change', (e) => { prefs.outStyle = e.target.value; savePrefs(); renderFormatted(); });
  $('fIndent').addEventListener('change', (e) => { prefs.indent = e.target.value; savePrefs(); renderFormatted(); });
  $('fSort').addEventListener('change', (e) => { prefs.sort = e.target.checked; savePrefs(); renderFormatted(); });
  $('fCopy').addEventListener('click', () => V.fmtText && copyText(V.fmtText, 'formatted output'));
  $('fDownload').addEventListener('click', () => {
    if (!V.fmtText) return;
    const ext = { json: 'json', python: 'py', js: 'js' }[outputStyle()];
    const base = V.name.replace(/\.[^.]*$/, '') || 'document';
    const url = URL.createObjectURL(new Blob([V.fmtText], { type: 'text/plain' }));
    h('a', { href: url, download: `${base}.formatted.${ext}` }).click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  });
  $('btnOpen').addEventListener('click', openIntoViewer);
  $('btnSave').addEventListener('click', () => saveViewer(false));
  $('btnSaveAs').addEventListener('click', () => saveViewer(true));

  // ====================================================================== COMPARE
  const C = {
    a: { text: '', res: null, seq: 0, name: '' }, b: { text: '', res: null, seq: 0, name: '' },
    result: null, tab: 'tree', open: new Set(), closed: new Set(), cur: -1, blocks: [],
  };
  const pane = (side) => document.querySelector(`.cmp-in[data-side="${side}"]`);
  const pq = (side, sel) => pane(side).querySelector(sel);

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

  async function reloadSide(side) {
    const s = C[side];
    const text = pq(side, '[data-input]').value;
    s.text = text;
    const seq = ++s.seq;
    if (!text.trim()) { s.res = null; renderSide(side); scheduleCompare.now(); return; }
    setStatus('Parsing…');
    const res = await loadText(text, {});
    if (seq !== s.seq) return;
    setStatus('');
    s.res = res;
    renderSide(side);
    scheduleCompare();
  }
  function renderSide(side) {
    const s = C[side];
    const info = pq(side, '[data-info]');
    info.replaceChildren();
    if (s.res) {
      info.append(resultInfo(s.res, {
        goTo: (pos) => { const ta = pq(side, '[data-input]'); ta.focus(); ta.setSelectionRange(pos, pos); },
        repair: () => {
          const ta = pq(side, '[data-input]');
          const r = JSS.loader.repair(ta.value);
          if (!r) return toast('No automatic repair is possible for this input.', 'error');
          ta.value = r.text;
          toast(`Repaired: ${r.changes.join('; ')}`);
          reloadSide(side);
        },
        pick: undefined,
      }));
    }
    pq(side, '[data-name]').textContent = s.name;
  }
  const scheduleCompare = debounce(() => runCompare(), 200);

  function runCompare() {
    const a = C.a.res, b = C.b.res;
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

  // ---- aligned tree diff
  function cellFor(side, m, depth, ctx, container, open) {
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
      grid.append(h('div', { class: `drow ${klass}` }, cellFor('a', m, depth, ctx, container, container), cellFor('b', m, depth, ctx, container, container)));
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
    const row = h('div', { class: `drow ${cls}` }, cellFor('a', m, depth, ctx, container, open), cellFor('b', m, depth, ctx, container, open));
    row.dataset.pk = pk;
    ctx.rows.set(pk, row);
    if (container) {
      row.addEventListener('click', (e) => {
        if (e.target.closest('input,button')) return;
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
        if (hideSame && (c.status === 'same') && m.status === 'changed') { hiddenSame++; continue; }
        renderMerged(grid, c, depth + 1, ctx);
      }
      if (hiddenSame) grid.append(h('div', { class: 'drow' }, h('div', { class: 'cell v-sum', style: `padding-left:${8 + (depth + 1) * 16}px`, text: `${plural(hiddenSame, 'unchanged item')} hidden` }), h('div', { class: 'cell' })));
    } else if (m.status === 'same') plainRows(grid, m.a, m.path, depth + 1, 'same', 'ab', ctx);
    else if (m.status === 'added') plainRows(grid, m.b, m.path, depth + 1, 'added', 'b', ctx);
    else if (m.status === 'removed') plainRows(grid, m.a, m.path, depth + 1, 'removed', 'a', ctx);
  }

  function renderDiffTree() {
    const body = $('cBody');
    body.replaceChildren();
    const r = C.result;
    if (!r) {
      const bothEmpty = !C.a.res && !C.b.res;
      body.append(h('div', { class: 'empty', text: bothEmpty ? 'Paste or open a document on each side to compare them.' : 'Both sides need to be valid before they can be compared.' }));
      return;
    }
    const ctx = { budget: DIFF_BUDGET, over: false, rows: new Map() };
    const grid = h('div', { class: 'dgrid' });
    body.append(h('div', { class: 'hdr' }, h('div', { text: `A${C.a.name ? ` · ${C.a.name}` : ''}` }), h('div', { text: `B${C.b.name ? ` · ${C.b.name}` : ''}` })), grid);
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

  // ---- text diff
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
    const d = JSS.textdiff.diffLines(prep(C.a.res.node), prep(C.b.res.node));
    const ctxLines = 3;
    const hide = $('cCollapse').checked;
    const keep = new Array(d.rows.length).fill(!hide);
    if (hide) d.rows.forEach((r, i) => { if (r.kind !== 'eq') for (let j = Math.max(0, i - ctxLines); j <= Math.min(d.rows.length - 1, i + ctxLines); j++) keep[j] = true; });
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
    body.append(h('div', { class: 'hdr' }, h('div', { text: `A${C.a.name ? ` · ${C.a.name}` : ''}` }), h('div', { text: `B${C.b.name ? ` · ${C.b.name}` : ''}` })));
    if (d.truncated) body.append(h('div', { class: 'notice', text: 'The documents differ too much for a line-by-line alignment; the changed region is shown as replaced.' }));
    body.append(h('div', { class: 'notice', text: 'Text diff compares the formatted JSON. Case, trim, tolerance and array-mode options apply to the tree diff only.' }), grid);
    $('cPos').textContent = C.cur >= 0 ? `${C.cur + 1} / ${C.blocks.length}` : '';
  }

  function gotoDiff(delta) {
    const r = C.result;
    if (!r || !r.stats.total) return;
    if (C.tab === 'tree') {
      C.cur = (((C.cur < 0 ? (delta > 0 ? -1 : 0) : C.cur) + delta) % r.diffs.length + r.diffs.length) % r.diffs.length;
      const path = r.diffs[C.cur].path;
      for (let i = 0; i < path.length; i++) C.closed.delete(pathKey(path.slice(0, i)));
      renderCompare();
    } else {
      if (!C.blocks.length) return;
      C.cur = (((C.cur < 0 ? (delta > 0 ? -1 : 0) : C.cur) + delta) % C.blocks.length + C.blocks.length) % C.blocks.length;
      C.blocks.forEach((b) => b.classList.remove('current'));
      C.blocks[C.cur].classList.add('current');
      C.blocks[C.cur].scrollIntoView({ block: 'center' });
      $('cPos').textContent = `${C.cur + 1} / ${C.blocks.length}`;
    }
  }

  // ---- compare: wiring
  const scheduleSide = { a: debounce(() => reloadSide('a'), 250), b: debounce(() => reloadSide('b'), 250) };
  for (const side of ['a', 'b']) {
    const root = pane(side);
    root.querySelector('[data-input]').addEventListener('input', () => { scheduleSide[side](); persistSession(); });
    root.addEventListener('click', async (e) => {
      const act = e.target.closest('[data-act]');
      if (!act) return;
      const ta = root.querySelector('[data-input]');
      if (act.dataset.act === 'clear') { ta.value = ''; C[side].name = ''; reloadSide(side); persistSession(); }
      else if (act.dataset.act === 'paste') pasteInto(ta, () => { reloadSide(side); persistSession(); });
      else if (act.dataset.act === 'open') {
        try { const f = await pickFile(); ta.value = f.text; C[side].name = f.name; reloadSide(side); persistSession(); }
        catch (err) { if (err.name !== 'AbortError') { log('error', 'open-failed', { error: String(err) }); toast(`Open failed: ${err.message || err}`, 'error'); } }
      }
    });
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
    const ta = pq('a', '[data-input]'), tb = pq('b', '[data-input]');
    [ta.value, tb.value] = [tb.value, ta.value];
    [C.a.name, C.b.name] = [C.b.name, C.a.name];
    [C.a.res, C.b.res] = [C.b.res, C.a.res];
    [C.a.text, C.b.text] = [C.b.text, C.a.text];
    renderSide('a'); renderSide('b');
    runCompare();
    persistSession();
  });
  $('cToggleInputs').addEventListener('click', () => {
    const box = $('cInputs');
    box.hidden = !box.hidden;
    $('cToggleInputs').textContent = box.hidden ? 'Show inputs' : 'Hide inputs';
  });
  $('cCopyPaths').addEventListener('click', () => {
    if (!C.result) return;
    const lines = C.result.diffs.map((d) => {
      const pv = (n) => (n ? (n.t === 'obj' || n.t === 'arr' ? JSS.ast.describe(n) : serialize(n, { style: 'json', indent: 0 }).text) : '—');
      return `${d.kind}\t${pathToString(d.path, { root: true })}\tA=${trunc(pv(d.a), 80)}\tB=${trunc(pv(d.b), 80)}`;
    });
    copyText(lines.join('\n'), `${plural(lines.length, 'difference')}`);
  });
  $('cCopyPatch').addEventListener('click', () => {
    if (!C.result) return;
    // Check the option as selected now: the result itself is recomputed after a short debounce.
    if ($('oArray').value !== 'index') return toast('JSON Patch export needs the array mode “by index”: matched arrays do not map to patch indexes.', 'error');
    copyText(JSS.diff.toJsonPatch(C.result.diffs), 'JSON Patch');
  });

  // ====================================================================== mode, theme, session
  function setMode(mode) {
    prefs.mode = mode;
    savePrefs();
    $('viewer').hidden = mode !== 'viewer';
    $('compare').hidden = mode !== 'compare';
    document.querySelector('.viewer-only').hidden = mode !== 'viewer';
    $('modeSwitch').querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
    if (mode === 'compare') renderCompare(); else renderViewer();
    persistSession();
  }
  $('modeSwitch').addEventListener('click', (e) => { const b = e.target.closest('[data-mode]'); if (b) setMode(b.dataset.mode); });

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
    const payload = {
      viewer: { text: cap(el.vInput.value), name: V.name },
      a: { text: cap(pq('a', '[data-input]').value), name: C.a.name },
      b: { text: cap(pq('b', '[data-input]').value), name: C.b.name },
    };
    try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(payload)); } catch (err) { log('warn', 'session-persist-failed', { error: String(err) }); }
  }
  const persistSession = debounce(persistSessionNow, 500);
  function restoreSession() {
    try {
      const s = JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null');
      if (!s) return false;
      el.vInput.value = (s.viewer && s.viewer.text) || ''; V.name = (s.viewer && s.viewer.name) || 'Untitled';
      pq('a', '[data-input]').value = (s.a && s.a.text) || ''; C.a.name = (s.a && s.a.name) || '';
      pq('b', '[data-input]').value = (s.b && s.b.text) || ''; C.b.name = (s.b && s.b.name) || '';
      log('info', 'session-restored', {});
      return true;
    } catch (err) { log('warn', 'session-restore-failed', { error: String(err) }); return false; }
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
    const target = e.target.closest ? e.target.closest('.cmp-in') : null;
    log('info', 'drop', { count: items.length, mode: prefs.mode });
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
    if (prefs.mode === 'compare') {
      const sides = target ? [target.dataset.side] : ['a', 'b'];
      loaded.slice(0, sides.length).forEach((f, i) => {
        const side = sides[i];
        pq(side, '[data-input]').value = f.text; C[side].name = f.name; reloadSide(side);
      });
      persistSession();
    } else setViewerFile(loaded[0]);
  });

  // ====================================================================== hand-off & boot
  function applyPending(data) {
    if (!data) return;
    if (data.error) { toast(data.error, 'error'); return; }
    if (typeof data.text === 'string') {
      log('info', 'handoff-received', { chars: data.text.length, source: data.source });
      setViewerFile({ text: data.text, name: data.name || 'From page' });
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
      const name = decodeURIComponent(url.pathname.split('/').filter(Boolean).pop() || 'document.json');
      setViewerFile({ text, name });
    } catch (err) {
      log('error', 'open-url-failed', { error: String(err) });
      const allowed = await (window.chrome && chrome.extension && chrome.extension.isAllowedFileSchemeAccess ? chrome.extension.isAllowedFileSchemeAccess() : Promise.resolve(undefined)).catch(() => undefined);
      toast(`Could not load the file: ${err.message || err}.${allowed === false ? ' Turn on “Allow access to file URLs” for JSON Studio in chrome://extensions, or use Open.' : ''}`, 'error');
    }
  }

  window.addEventListener('beforeunload', persistSessionNow);
  document.addEventListener('visibilitychange', () => { if (document.hidden) persistSessionNow(); });
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 's' && prefs.mode === 'viewer') { e.preventDefault(); saveViewer(e.shiftKey); }
  });

  (async function boot() {
    log('info', 'boot', {});
    loadPrefs();
    V.depth = prefs.depth; V.tab = prefs.tab === 'query' ? 'tree' : prefs.tab; C.tab = prefs.ctab;
    $('vDepth').value = String(V.depth);
    const o = prefs.cmp;
    $('oOrder').checked = o.order; $('oArray').value = o.array; $('oArrayKey').value = o.arrayKey; $('oIgnore').value = o.ignore;
    $('oTol').value = o.tol; $('oCase').checked = o.caseI; $('oTrim').checked = o.trim; $('oMissing').checked = o.missing; $('cCollapse').checked = o.collapse;
    $('oArrayKey').hidden = o.array !== 'key';
    applyTheme();
    restoreSession();
    setMode(prefs.mode);

    const params = new URLSearchParams(location.search);
    const handoffId = params.get('h');
    const src = params.get('src');
    if (handoffId || src) history.replaceState(null, '', location.pathname);

    await Promise.all([reloadViewer(), reloadSide('a'), reloadSide('b')]);

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
