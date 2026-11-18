// Loads the core modules in dependency order and returns the shared JSS namespace.
const path = require('path');
const root = path.join(__dirname, '..', 'core');
for (const f of ['ast', 'parser', 'fmt', 'loader', 'diff', 'query', 'textdiff', 'find', 'editing', 'convert', 'schema']) {
  try { require(path.join(root, f + '.js')); } catch (e) { if (e.code !== 'MODULE_NOT_FOUND' || !String(e.message).includes(f + '.js')) throw e; }
}
globalThis.JSS.setLogLevel('error');
module.exports = globalThis.JSS;
