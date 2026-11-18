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

## Two panes, each with Raw / Preview / Tree

The studio has two identical, independent panes (**A** and **B**). Use **1 pane / 2 panes** in the top bar to show one or both.

Every pane can take JSON on its own (paste, **Open**, drag and drop onto it, or the toolbar click for pane A) and has its own view switch:

- **Raw**: the exact text, editable, with line numbers, syntax colours, live parsing, the "what did the loader do" steps, and **Apply format** to replace the text with the formatted output.
- **Preview**: syntax-coloured formatted output as JSON, Python or JavaScript, with line numbers, indent (2, 4, tab or minified) and sorted keys. It is **editable**: what you type becomes the pane's text (it is not re-formatted while you type; switching views or changing the format options formats it again). An unparsable document is shown as typed so you can fix it in place.
- **Tree**: collapsible tree with type colours and counts, search over keys and values (next/previous and a "filter" mode), expand/collapse and depth control, **JSONPath** queries, copy of a node's path / value / subtree, row numbers, and editing: **double-click** a value or a key to change it, **+ add** on an object or array, **delete** on any entry (hover a row). Edits rewrite the pane's text in its own format (a Python dict stays a Python dict). Large arrays are paged and the page stays responsive.

Saving, per pane: **Save** and **Save as** write the pane's raw text with the File System Access API (a warning appears if the file changed on disk after you opened it, and invalid text can be saved too). In Preview, **Save formatted…** writes the formatted output and **Download** saves it as a file. `Ctrl/Cmd+S` saves the pane you are working in. Copy buttons are in every view.

Every pane opens in Raw so you can paste JSON straight in; loading content never switches the view. Your per-pane view choice is remembered.

## Working with several documents

- **Resize**: drag the divider between the panes (and the one between the panes and the Compare / Validate area). Arrow keys move it when it has focus, double-click resets it. Sizes are remembered.
- **Maximise**: the ⤢ button gives one pane the whole window; the same button or `Esc` restores it. **Sync scroll** (top bar) scrolls both panes together.
- **Tabs**: each pane holds several documents. **Open**, a drop or a toolbar hand-off adds a tab when the pane already has content, so nothing is replaced. **+** starts an empty one. Tabs, with their text, survive a reload of the studio tab (session storage); file handles do not.
- **Recent**: the files you opened or saved, reopened in a new tab (browser permission is asked again when needed). File handles are kept in this browser's IndexedDB; **Clear recent files** empties the list.
- **Undo / redo** (Tree toolbar, or `Ctrl/Cmd+Z`, `Ctrl/Cmd+Shift+Z` in the tree) covers tree edits, Apply format, Repair and Clear, per document. Typing in Raw / Preview keeps the browser's own undo.
- **Command palette**: `Ctrl/Cmd+K` (or the ⌘K button) lists every action: views, file actions, modes, layout, formats. Type to filter, arrows and Enter to run.

### Editors (Raw and Preview)

Line numbers and colours; **Find / replace** (`Ctrl/Cmd+F` or **Find**) with match case, regular expressions (`$1` in replacements), match highlighting, next / previous, replace one / all; bracket-pair highlighting; Enter keeps the indentation and adds a level after `{`, `[`, `(`; Tab / Shift+Tab indent and outdent (press `Esc` first to Tab out of the editor). Above 200,000 characters the editors drop colours and highlighting and stay plain. There is no code folding in the editors (use the Tree to fold).

### Tree keyboard

Click a row (or focus the tree), then: `↑ ↓ Home End` move, `→` opens or enters, `←` closes or goes to the parent, `Enter` edits a value or folds, `F2` renames a key, `Delete` removes the entry.

### Export formats (Preview)

The Preview **Format** list also offers read-only exports of the current document: **YAML**, **CSV** (one row per array item, nested keys flattened to `a.b` / `a[0]`), **TypeScript types** and **JSON Schema** (draft 2020-12). Types and schema are inferred from the sample: arrays of objects merge into one shape and keys missing from some items become optional. Exports never change the document; **Copy**, **Download** and **Save formatted…** use them.

## Validate

**Validate** mode checks pane **A** against the JSON Schema in pane **B**. Errors list the path, the failing keyword and a message; click one to jump to it in A's tree. **Infer schema from A → B** writes a starting schema. Supported keywords: `type, enum, const, properties, required, additionalProperties, patternProperties, propertyNames, items, prefixItems, contains, min/maxItems, uniqueItems, min/maxLength, pattern, minimum/maximum, exclusiveMinimum/Maximum, multipleOf, min/maxProperties, allOf, anyOf, oneOf, not, if/then/else`, local `$ref`, and the formats `email, uuid, date, date-time, ipv4`. Anything else in the schema is listed as "not checked", never silently treated as passed. Remote `$ref`s are not fetched (no network access). Numbers inside the schema go through `JSON.parse`, so constants beyond 2^53 lose precision there.

## Compare

Compare uses the same two panes, each accepting any supported format, so you can compare a Python dict with JSON. Each pane keeps its own view while you compare, and the diff re-runs as you edit.

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
- `studio.html|css|js`: the UI (one `DocPane` class, instantiated twice), `worker.js`: off-thread parsing, `background.js`: toolbar click and file navigation
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
