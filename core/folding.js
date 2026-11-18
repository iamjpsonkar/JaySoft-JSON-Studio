/* JSON Studio core: block folding for formatted text (JSON, Python, JavaScript, TypeScript types, JSON Schema).
 * A block is foldable when its opening bracket ( { [ ( ) has its partner on a later line. Brackets inside quoted strings are ignored.
 */
(function (root) {
  'use strict';
  const JSS = root.JSS;

  /** -> {lines, ranges: Map(startLine -> {end, depth, count}), maxDepth}. depth 1 is the outermost block; count is the number of lines between the brackets. */
  function foldRanges(text) {
    const lines = text.split('\n');
    const found = [];
    const stack = [];
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      let quote = null;
      for (let j = 0; j < l.length; j++) {
        const c = l[j];
        if (quote) { if (c === '\\') j++; else if (c === quote) quote = null; continue; }
        if (c === '"' || c === "'") { quote = c; continue; }
        if (c === '{' || c === '[' || c === '(') stack.push(i);
        else if ((c === '}' || c === ']' || c === ')') && stack.length) {
          const start = stack.pop();
          if (start < i) found.push({ start, end: i });
        }
      }
    }
    // one block per opening line (the outermost when a line opens several), with its nesting depth
    found.sort((a, b) => a.start - b.start || b.end - a.end);
    const ranges = new Map();
    const open = []; // ends of the enclosing blocks
    let maxDepth = 0;
    for (const r of found) {
      if (ranges.has(r.start)) continue;
      while (open.length && open[open.length - 1] < r.start) open.pop();
      const depth = open.length + 1;
      ranges.set(r.start, { end: r.end, depth, count: r.end - r.start - 1 });
      open.push(r.end);
      if (depth > maxDepth) maxDepth = depth;
    }
    return { lines, ranges, maxDepth };
  }

  /** The blocks to collapse so that `level` levels stay open (level 1 collapses even the outermost block). */
  function collapseToLevel(ranges, level) {
    const set = new Set();
    for (const [start, r] of ranges) if (r.depth >= level) set.add(start);
    return set;
  }

  /** Rows to show: [{line, folded, end?}]. A folded block shows its opening line only (the closing line is summarised on it). */
  function visibleRows(total, folded, ranges) {
    const rows = [];
    for (let i = 0; i < total;) {
      const r = ranges.get(i);
      if (r && folded.has(i)) { rows.push({ line: i, folded: true, end: r.end }); i = r.end + 1; } else { rows.push({ line: i, folded: false }); i++; }
    }
    return rows;
  }

  JSS.folding = { foldRanges, collapseToLevel, visibleRows };
  if (typeof module !== 'undefined' && module.exports) module.exports = JSS;
})(typeof self !== 'undefined' ? self : globalThis);
