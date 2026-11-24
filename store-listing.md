# Chrome Web Store submission kit

Copy-paste material for the Developer Dashboard (listing text, screenshots and permission justifications are entered there by hand).

## Listing

**Name:** JSON Studio

**Summary:** View, format, edit and compare JSON and Python dictionaries in a fast, private tab. Everything runs in your browser.

**Category:** Developer Tools

**Description:**

JSON Studio is a fast, private JSON viewer, formatter and diff tool that runs entirely in your browser. It opens JSON as a clear, searchable tree and helps you read, edit and compare it. Click the toolbar icon on a JSON page or API response and it opens in a new tab.

It also reads data that is not strict JSON. Paste a Python dictionary, a JavaScript object or a log line that contains a JSON payload, and JSON Studio finds the data, shows how it was read and lets you format it as JSON. If the JSON is stringified or encoded, it unwraps it step by step, so you can see every change it made.

Numbers stay exact: large integers and decimals never lose digits.

Work in up to four independent panes. Each pane has Raw, Preview and Tree views, line numbers, tabs, find and replace, and undo. A built-in compare view shows what was added, removed or changed between two documents, with options to ignore key order or selected paths.

More tools: JSONPath queries, in-tree editing, JSON Schema validation, sorting and cleaning transforms, export to other formats, and a command palette (Ctrl/Cmd+K). Large files are parsed off the main thread so the page stays responsive.

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
