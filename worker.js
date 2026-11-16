/* Parses off the main thread so large documents do not freeze the page. */
'use strict';
importScripts('core/ast.js', 'core/parser.js', 'core/fmt.js', 'core/loader.js');

self.onmessage = async (e) => {
  const { id, text, opts } = e.data;
  try {
    const result = await self.JSS.loader.load(text, opts);
    self.postMessage({ id, result });
  } catch (err) {
    self.postMessage({ id, result: { ok: false, steps: [], error: { message: `Worker error: ${err && err.message ? err.message : err}`, line: 1, col: 1, pos: 0 } } });
  }
};
