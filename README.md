# JSON Studio

A Chrome extension to view, format, query and compare JSON, **Python dicts** and other dict-like data. Paste almost anything and it works out what it is.

## Install (unpacked)

1. Clone or download this repository.
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and select the repository folder (the one containing `manifest.json`).
4. Click the JSON Studio toolbar icon.

**Every click opens a new tab.** If the page you are on is JSON (an API response, a `.json` URL, a local file), that JSON is loaded straight into the new tab. If you have text selected on any page, the selection is loaded instead. On any other page you get a blank studio.

### Open local `.json` files by URL

1. On `chrome://extensions`, open JSON Studio's **Details**.
2. Turn on **Allow access to file URLs**.

After that, navigating to a local file such as `file:///Users/you/data/a.json` (also `.jsonc`, `.json5`, `.ndjson`, `.jsonl`, `.geojson`) opens it in the studio automatically. Without that setting use **Open**, drag and drop, or paste.

## What it loads (the smart loader)

Paste it, drop it, or open it. The loader tries strict JSON first, then everything below, and always shows which steps it applied.

| Input | Handling |
| --- | --- |
| JSON, JSONC, JSON5, trailing commas | detected and labelled; strict-JSON errors give exact line and column |
| **Python dict / list repr** | `True/False/None`, tuples, sets, `b'..'`, triple quotes, `1_000`, hex, non-string keys, `Decimal(..)`, `datetime(..)`, `date(..)`, `UUID(..)`, `OrderedDict(..)`, `defaultdict(..)`, `Point(x=1)`; `<object at 0x..>` is kept as text and reported |
| JavaScript objects | unquoted keys, single quotes, comments, `undefined`, `NaN`, `Infinity` |
| Ruby hashes, PHP arrays | `=>`, `:symbol`, `nil`, `array(..)`, `[k => v]` |
| Stringified JSON | `"{\"a\":1}"`, including several layers |
| Backslash-escaped copies | `{\"a\": 1}` |
| JSON inside log lines and wrappers | `payload={...}`, `JSON.parse('..')`, `json.loads("..")`, `curl -d '..'`; if there are several candidates you pick one |
| NDJSON / concatenated JSON | loaded as a list |
| Encodings | Base64 and URL-safe Base64, gzip + Base64, URL-encoding, HTML entities, **JWT** (header and payload; the signature is *not* verified), URL query strings |
| JSON stored inside string values | one click: **Expand embedded JSON** |
| Truncated JSON, curly quotes | **Try repair** shows exactly what it changed and offers **Undo**; it is never applied silently |

Notes that matter:

- **Numbers are exact.** `12345678901234567890123` and `1.50` keep every digit through view, edit, format and compare. JavaScript's `JSON.parse` would round integers beyond 2^53.
- **Nothing is evaluated.** It is a parser only (no `eval`, no code execution), with a nesting-depth limit.
- Duplicate keys are kept and reported. Python-only values (tuples, sets, bytes, `Decimal`, `datetime`) are tagged in the tree and converted sensibly when you output JSON.

## Viewer

- **Tree** with type colours, counts, search over keys and values (with next/previous and a "filter" mode), expand/collapse and depth control. Large arrays are paged and the page stays responsive.
- **Copy** a node's path (`items[7].id`), value or subtree. **Double-click** a value to edit it.
- **JSONPath** queries (`$..book[?(@.price<10)].title`) with results you can jump to.
- **Formatted** output as JSON, Python or JavaScript, with indent (2, 4, tab or minified) and sorted keys; copy, download, or apply it back to the input.
- Open and **save** files with the File System Access API (a warning appears if the file changed on disk).

## Compare

Two inputs, each accepting any supported format, so you can compare a Python dict with JSON.

- Aligned **tree diff** (added, removed, changed, type changed) and a **text diff**, with next/previous navigation and a swap button.
- Options: ignore key order (default); arrays **by index**, **matched by a key** (such as `id`) or **unordered**; ignore paths (`updated_at`, `items[*].ts`, `**.name`, `/regex/`); number tolerance; case-insensitive and trimmed strings; "missing equals null".
- Numbers compare exactly, so two ids that differ only past 2^53 are reported as different.
- Copy the list of differing paths, or export an RFC 6902 **JSON Patch** (array mode "by index").

## Privacy

Everything runs locally. See the [privacy policy](https://iamjpsonkar.github.io/JaySoft-JSON-Studio/privacy.html). In short: no servers, no analytics, no network requests. The toolbar click reads the active tab's text only at that moment.

Debug logging: in the studio tab's console run `localStorage['jsstudio.logLevel']='debug'`. Logs contain sizes and flags, never your data.

## Development

No build step. Node 18+ for the tests.

```sh
npm install
npm test
```

- `core/`: the parser, loader, serialisers, diff and JSONPath (plain scripts shared by the page, the web worker and the tests)
- `studio.html|css|js`: the UI, `worker.js`: off-thread parsing, `background.js`: toolbar click and file navigation
- `tests/`: unit tests for the core, the background worker, and the UI in jsdom, plus `tests/samples/`

The UI tests run in jsdom, which has no layout, workers or Chrome APIs (those are stubbed), so visual layout and real-browser behaviour are checked by hand.

## Releases

Pushing a tag that equals the manifest version builds a release (`.github/workflows/release.yml`). It runs the tests first and publishes `json-studio-vX.Y.Z.zip` and `SHA256SUMS.txt`.

```sh
# bump "version" in manifest.json and commit, then
git tag v1.0.0
git push origin v1.0.0
```

Unzip the release and use **Load unpacked**, or upload the zip to the Chrome Web Store (see `store-listing.md`).
