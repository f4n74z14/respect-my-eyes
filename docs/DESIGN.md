# Design snapshot

What the extension does, how, and what each decision costs. Behaviour is covered by the tests in `tests/`.

## Components

| File | Role |
| --- | --- |
| `dist/manifest.json` | Manifest V3. Permissions: `storage`, `fontSettings`. One content script on all URLs and frames, at `document_start`. |
| `dist/background.js` | Service worker. Reads `chrome.fontSettings`, caches it, migrates old storage keys, learns editor fonts. |
| `dist/content.js` | Page script. Scans, classifies, and injects the override CSS. |
| `dist/common.js` | Shared pure logic: classification, settings, CSS builders. Touches `chrome.*` only in `RME.storage`. |
| `dist/ui.js` | DOM helpers shared by the popup and settings page. |
| `dist/popup.*`, `dist/options.*` | Popup and settings page. |
| `dist/ui.css` | Shared styles (Nord palette, light and dark). Page-specific styles are in `popup.css` and `options.css`. |

Storage (`chrome.storage.local`): `rmeSettings` (user settings), `rmeBrowserFonts` (cache of the browser's font preferences, written by the service worker) and `rmeHints` (monospace fonts that editors used, per site). Keys from older builds (`settings`, `browserFonts`) are migrated on update.

## Reading the browser's fonts

Content scripts cannot call `chrome.fontSettings`, so the service worker reads the standard, serif, sans-serif and fixed-width families plus the fixed and default sizes, and caches them. It refreshes on `onFontChanged` and the size events, and skips the write when nothing changed, so tabs are not woken for nothing. Content scripts listen to storage and re-apply live.

Without the API, fallback fonts apply (Arial, Georgia, Courier New).

## Finding font names

Three independent sources, so a font is found however a site declares it:

1. **Stylesheets**, walked through the CSSOM: `@media`, `@supports`, `@layer`, `@import`, and font stacks in custom properties defined on `:root`, `html` and `body`. Scanning is incremental per sheet.
2. **Computed styles** of elements, sampled in chunks of 250 and de-duplicated by tag, class and inline style. Covers `var(--x)`, inline styles, open shadow DOM and CORS-blocked stylesheets.
3. **`document.fonts`**, which exposes descriptors even for blocked stylesheets and includes fonts created in JavaScript.

Each family name is classified on its own (icon / sans / serif / mono) by keyword. A name without a keyword inherits the category of the stack's generic fallback. A stack with no generic fallback and an unknown name is reported to the popup as unclassified.

## Replacing fonts

- A family name is overridden with `@font-face { src: local("<your font>") }`: four rules per family (regular, bold, italic, bold italic). The override is by name, so it also covers text the page styles from places we cannot see.
- A page's own `@font-face` rule for a replaced family is deleted where its sheet is readable.
- Where it cannot be deleted (blocked sheet), the browser merges faces with identical descriptors and the later one wins. So the descriptors the page declared (`font-weight: 1 1000`, `font-stretch: 25% 151%`...) are read from `document.fonts` and copied into our rules. This is what makes variable fonts replaceable.
- Selectors are mirrored (`!important` rule with the chosen font) only where a name cannot be replaced: stacks made of generic families such as `system-ui`, and monospace stacks (for the forced size). A named stack is replaced by name, which keeps the page's cascade intact; mirroring its selector would reorder the cascade and clobber descendants that set their own icon font (a page rule like `.mce-container *` is the classic case). Selectors ending in `*` are never mirrored. A stack that is purely `sans-serif`, `serif` or `monospace` is skipped, since it already follows the browser (unless a custom font is set).
- `html, body` follow the category detected on the body.
- All output lives in two constructed stylesheets (a base sheet applied at `document_start` and a site sheet rebuilt on change). They are exempt from page CSP and cheap to replace. A `<style>` fallback exists.

## Code editors

Editors measure the width of a character and cache it, then place the cursor from it. Anything that changes their font or size afterwards moves the cursor away from the text.

**Detection.** Every mainstream editor routes keyboard input through a hidden element with browser "magic" switched off (`autocorrect="off"`, `spellcheck="false"`): a `<textarea>` in Ace, xterm.js, CodeMirror 5 and classic Monaco; a `role="textbox"` element in CodeMirror 6 and Monaco's `EditContext` mode (default since 0.57). Checked against the sources of monaco-editor 0.57, @codemirror/view 6.43, codemirror 5.65, ace-builds 1.45 and @xterm/xterm 6.0. That element and its two nearest ancestors form the boundary, written as one CSS selector list (with `:has()`), plus a fallback list of well-known roots. No class names, no polling, and editors mounted late are covered.

**A late editor** announces itself: its hidden input runs a 1 ms no-op animation from the base sheet, and `animationstart` triggers a look at the fonts inside it.

**Protection.**
- Forced monospace size and letter-spacing never reach inside the boundary (`@scope (:root) to (...)`).
- A monospace font an editor was already using is not swapped under it. It is remembered (service worker, serialized) so the next load applies it from the first paint.
- The fonts a site's editor used are stored as a **hint for that site** (at most 300 sites, 12 names each, oldest dropped first). They are in the base sheet and therefore replaced before any page script runs, on that site only.
- A per-site switch and a *Protected areas* field (any selector; all selector-based rules stay out of it) cover misdetection and widgets that look wrong.

## Performance

- No bundled CSS parser. The CSSOM is read directly.
- **The font list is free until used.** A listed font is declared only when the page uses it (found by the sources above), so the cost per tab depends on the page, not on the list. The base sheet holds only the site's hints and a few fixed rules.
- Sheets are scanned incrementally; a page with nothing new does no work.
- Generated `@font-face` rules are cached per family and category; the CSS is rebuilt only when something new was found.
- `document.fonts` is re-read only when its size changed.
- Sampling is chunked and de-duplicated, so it never blocks the page.
- Page scripts (`common.js` + `content.js`) are about 53 KB.

## Trade-offs

| Decision | Benefit | Cost |
| --- | --- | --- |
| Mirror selectors only for generic stacks | Page cascade and icon fonts stay intact | A generic `system-ui` rule needs a mirror, so sweeps over descendants are skipped there |
| Replace by family name with `local()` | Covers text styled anywhere, consistent with what the page measures | A font that is not installed falls back to the page's next font |
| Copy descriptors from `document.fonts` | Beats unremovable page faces, including variable fonts | A split regular/bold range is approximated with two extra rules |
| Constructed stylesheets | Immune to page CSP, cheap to update | A page that reassigns `adoptedStyleSheets` can drop them until the next rescan |
| Hidden-input detection of editors | No class lists, works for new editors | The boundary includes two ancestors of the hidden input, so a few unrelated code blocks next to a search box lose forced sizing |
| Learn editor fonts per site | Fixed after one reload, no setup, the user's list is not touched | Hints are invisible; the first visit to a site shows the site's font in its editor |
| Declare listed fonts on demand | Cost independent of the list length | A listed font is replaced at the first scan (as soon as a stylesheet loads), not at `document_start` |
| `@scope` and `:has()` for protection | Pure CSS, no DOM changes | Needs Chromium 118+ |
| Text boxes are not forced to monospace | No drift on mirrored text boxes | Users who want it must switch it on |
| Four static faces per family | Small CSS | Other weights rely on the browser's nearest match unless the page declares them |
| Undo instead of confirm dialogs | Faster, safer editing | Changes apply before they are confirmed |

## Known limitations

- Pseudo-element-only fonts and closed shadow roots are not inspected directly (their names are still replaced when used or declared elsewhere).
- `system-ui` cannot be replaced by `@font-face`; it is handled with selector rules.
- A font registered by script after the overrides are built may win until the next rescan.

## Tests

| File | Covers |
| --- | --- |
| `tests/common.test.js` | Classification, settings validation and migration, list parsing, CSS builders |
| `tests/background.test.js` | Storage migration, font cache, editor-font learning |
| `tests/content.test.js` | The real content script on a simulated page: overrides, variable fonts, editors, switches |
| `tests/ui.test.js` | Popup and settings page behaviour |

The content and UI tests use jsdom, which has no layout or constructed stylesheets, so they verify logic, not rendering.
