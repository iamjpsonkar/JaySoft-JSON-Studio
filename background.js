'use strict';

const STUDIO_PAGE = 'studio.html';
const PENDING_PREFIX = 'js:pending:';
const MAX_HANDOFF_CHARS = 8 * 1024 * 1024;
const FILE_SUFFIXES = ['.json', '.JSON', '.jsonc', '.json5', '.ndjson', '.jsonl', '.geojson'];

function log(level, event, ctx = {}) {
  // Never log page content or full URLs (they can carry tokens); only sizes and flags.
  console[level](`[json-studio:bg] ${event}`, ctx);
}

// Runs inside the active tab (activeTab grants this on click). Returns JSON-ish page text or the selection.
function grabPage() {
  const sel = String(window.getSelection ? window.getSelection() : '').trim();
  const ct = document.contentType || '';
  const isJsonDoc = /json/i.test(ct) || (/^text\/plain/i.test(ct) && /^\s*[[{]/.test(document.body ? document.body.innerText.slice(0, 200) : ''));
  if (isJsonDoc && document.body) {
    const pre = document.body.querySelector('pre');
    return { kind: 'page', contentType: ct, title: document.title || '', text: (pre || document.body).textContent };
  }
  if (sel) return { kind: 'selection', title: document.title || '', text: sel };
  return null;
}

// Every click opens its own tab. The payload is stored under a key unique to that tab (?h=<id>), so several
// studio tabs never see each other's data. The studio page reads and removes it on load.
async function openStudio(pending) {
  const studioUrl = chrome.runtime.getURL(STUDIO_PAGE);
  let target = studioUrl;
  if (pending) {
    const id = crypto.randomUUID();
    try {
      await chrome.storage.session.set({ [PENDING_PREFIX + id]: Object.assign({ ts: Date.now() }, pending) });
      target = `${studioUrl}?h=${id}`;
    } catch (err) {
      log('error', 'handoff-store-failed', { error: String(err) });
    }
  }
  log('info', 'create-studio-tab', { handoff: target !== studioUrl });
  await chrome.tabs.create({ url: target });
}

chrome.action.onClicked.addListener(async (tab) => {
  let pending = null;
  try {
    if (tab && tab.id !== undefined && /^(https?|file):/.test(tab.url || '')) {
      const [injection] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: grabPage });
      const got = injection && injection.result;
      if (got) {
        log('info', 'grabbed-from-tab', { kind: got.kind, chars: got.text.length });
        const name = (got.title || 'Page').slice(0, 80);
        pending = got.text.length > MAX_HANDOFF_CHARS
          ? { name, error: `The page is ${(got.text.length / 1048576).toFixed(1)} MB, too large to hand over. Save it and use Open instead.` }
          : { name, text: got.text, source: got.kind };
      } else {
        log('debug', 'nothing-to-grab', {});
      }
    }
  } catch (err) {
    // chrome:// pages, the Web Store, file:// without file access, ...
    log('warn', 'grab-failed', { error: String(err) });
  }
  try { await openStudio(pending); } catch (err) { log('error', 'open-studio-failed', { error: String(err) }); }
});

// Navigating straight to a local JSON file turns that tab into the studio (needs "Allow access to file URLs").
chrome.webNavigation.onBeforeNavigate.addListener(async (details) => {
  if (details.frameId !== 0) return;
  log('info', 'file-navigation-detected', { tabId: details.tabId });
  try {
    const target = `${chrome.runtime.getURL(STUDIO_PAGE)}?src=${encodeURIComponent(details.url)}`;
    await chrome.tabs.update(details.tabId, { url: target });
  } catch (err) {
    log('error', 'file-navigation-redirect-failed', { tabId: details.tabId, error: String(err) });
  }
}, { url: FILE_SUFFIXES.map((pathSuffix) => ({ schemes: ['file'], pathSuffix })) });
