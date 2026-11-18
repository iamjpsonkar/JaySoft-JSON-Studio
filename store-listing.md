# Chrome Web Store submission kit

Copy-paste material for the Developer Dashboard (listing text, screenshots and permission justifications are entered there by hand).

## Listing

**Name:** JSON Studio

**Summary:** View, format, query and compare JSON, Python dicts and more. Paste stringified JSON, logs, Base64 or a JWT.

**Category:** Developer Tools

**Description:**

JSON Studio is a fast, private JSON viewer, formatter and diff tool that runs entirely in your browser.

- Click the toolbar icon on a JSON page or API response: it opens in a new tab as a searchable tree
- Paste almost anything: JSON, JSON5, Python dict/list reprs (True/None/tuples/sets/Decimal/datetime), JavaScript objects, Ruby hashes, PHP arrays
- Unwraps stringified and multi-layer encoded JSON, finds JSON inside log lines and curl or JSON.parse calls, decodes Base64, gzip+Base64, URL-encoding, HTML entities and JWTs
- Exact numbers: big integers and decimals never lose digits
- Two independent panes, each with Raw / Preview / Tree views (all with line numbers, all editable), and Open / Paste / Save per pane
- Resizable and maximisable panes, several documents per pane (tabs, recent files), find and replace, undo, command palette (Ctrl/Cmd+K)
- Transform menu: sort keys, sort arrays by a field, minify, remove nulls / duplicates, flatten / unflatten, stringify, convert to JSON / Python / JS
- Validate against a JSON Schema; export as YAML, CSV, TypeScript types or JSON Schema
- Side-by-side compare with tree and text diff: ignore key order, match arrays by key, ignore paths, number tolerance, JSON Patch export
- JSONPath queries, search, in-tree editing, format as JSON, Python or JavaScript
- Large files are parsed off the main thread

Your data never leaves your computer. No accounts, no analytics, no tracking, and it never executes the data you load.

To open local files by URL, enable "Allow access to file URLs" for JSON Studio on chrome://extensions.

**Single purpose:** View, format, query and compare JSON and similar structured data.

## Permission justifications

| Permission | Justification |
| --- | --- |
| `activeTab` | When the user clicks the toolbar icon, allows reading the clicked tab so its JSON can be opened in the studio. |
| `scripting` | Runs one small function in the clicked tab to read the page's JSON text or the user's text selection. Only on click, never in the background. |
| `storage` | Passes the read text to the newly opened tab through in-memory session storage (removed once read) and saves interface preferences. |
| `webNavigation` | Detects top-level navigation to a local `file://` URL ending in a JSON extension and opens it in the studio. |
| Host `file:///*` | Reads local JSON files the user opens or navigates to. Chrome also requires the user to enable "Allow access to file URLs". |

**Remote code:** none. Everything is packaged in the extension.

**Data usage (suggested answers):** collects no user data; does not sell or transfer data; no data used for unrelated purposes.

## Privacy policy

Use this URL once GitHub Pages is enabled (source: `docs/privacy.html`, Pages from branch `main`, folder `/ (root)`):

https://iamjpsonkar.github.io/JaySoft-JSON-Studio/docs/privacy.html

The policy lists the GitHub issues page as contact, so no personal email is published. The dashboard asks for a separate contact email, which is not shown in the policy.

## Publishing steps

1. Register at the Chrome Web Store Developer Dashboard (a one-time registration fee applies; check the current amount on the registration page).
2. Create a new item and upload `json-studio-vX.Y.Z.zip` from the GitHub release.
3. Fill in the listing from this file. Add at least one screenshot (take them of the running extension) and the 128x128 icon (`icons/icon128.png`).
4. Paste the permission justifications, privacy answers and the privacy policy URL.
5. Submit for review.

Review risk (my assessment, not a documented rule): `scripting` plus `file:///*` plus `webNavigation` is a broad-looking combination, so expect scrutiny. The justifications above are written to address that.
