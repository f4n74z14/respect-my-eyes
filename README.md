# Respect My Eyes

Big thanks to the [Original Project](https://github.com/sysop84/force-my-browser-fonts)!

This is a major rewrite focused on browser-native font preferences, improved icon font compatibility, customization, and performance. Like the original, it is licensed under the GNU GPL v3 (see [`LICENSE`](LICENSE)).

## Install

1. Open `chrome://extensions` and enable **Developer mode**.
2. Click **Load unpacked** and select the `dist` folder.

Works in Chromium-based browsers. Browsers that don't implement `chrome.fontSettings` use fallback fonts (see below).

## Browser Font Preferences

- Automatically reads serif, sans-serif, fixed-width font families and fixed-width font size from browser settings (`chrome://settings/fonts`).
- No need to configure fonts separately for individual websites.
- Font preferences are cached in the background and applied to open tabs when browser settings change.
- Includes fallback fonts (Arial, Georgia, Courier New) for browsers that don't expose font preferences to extensions.
- Allows overriding individual font families with custom installed fonts.

## Custom Font Support

- **Popup:** shows the site switch, the fonts in use, the unrecognized fonts of the page (pick Sans / Serif / Mono / Icon and press Add), and the code editors found on the page, named by element, with a switch for each. Changes apply immediately.
- **Settings page:** sticky section navigation, a live preview of the chosen fonts, and an editable list of additional fonts with filter and sorting. **Import list** opens a dialog with a live preview of what will be added, changed or ignored; the old `Name|SANS-SERIF` format still works.
- Destructive actions (remove, restore defaults, import, reset) apply instantly and show an **Undo** toast instead of a confirmation dialog.
- Configure monospace font size and scaling.
- Exclude specific websites.
- Add custom icon font keywords.
- Import, export, and reset configuration.

## Dynamic Font Detection

Font names are collected from three independent sources, so fonts are found regardless of how a site declares them:

- **Stylesheets:** walked directly through the CSSOM, including `@media`, `@supports`, `@layer`, `@import` and font stacks stored in CSS custom properties.
- **Computed styles:** `getComputedStyle()` is used to inspect fonts actually applied to page elements. This covers `var(--font-family)`, inline styles, open shadow DOM and stylesheets blocked by CORS. Elements are processed incrementally in batches of 250 and grouped by tag, class and inline style to avoid redundant work.
- **`document.fonts`:** lists every font face the page declares, even from stylesheets that cannot be read, and includes fonts created in JavaScript.

Each family name is classified individually (icon / sans-serif / serif / monospace). Names without a recognizable keyword inherit the category of the stack's generic fallback, so `"Foo", sans-serif` is treated as sans-serif.

## Variable and Multi-Weight Fonts

Replacements are applied through `@font-face` overrides using `local()` fonts. If a page's own `@font-face` cannot be removed (its stylesheet is blocked by CORS), the browser merges faces with identical descriptors and the one declared later wins. For that reason, the descriptors the page declares (for example `font-weight: 1 1000` or `font-stretch: 25% 151%`) are read from `document.fonts` and copied into the override rules. This is what makes variable fonts such as Google Sans Flex replaceable.

## Performance and Compatibility

- Removed the bundled 80 KB CSS parser; the page scripts total about 41 KB.
- Only 4 static `@font-face` rules per font (regular, bold, italic, bold italic) instead of 20; other weights and ranges are generated only when a page actually declares them.
- Incremental stylesheet scanning detects new rules and dynamically injected styles; unchanged pages cost nothing.
- Improved font-family classification handles individual names correctly and avoids accidental partial matches.
- Migrated to **Manifest V3** for compatibility with current Chromium-based browsers.
- Uses dedicated constructed stylesheets as an override layer instead of modifying websites' original CSS rules (the page's own `@font-face` rules are removed only for families that are being replaced).

## Code Editors and Text Boxes

Editors (Monaco, CodeMirror, Ace, xterm) and rich text boxes measure the width of a character themselves, or mirror their text into a second element, and use that to place the cursor and selection. Changing their font or size behind their back makes the cursor drift away from the text. To avoid that:

- Our forced monospace size and letter-spacing never reach inside protected containers (done with `@scope (:root) to (...)`, Chrome 118+). The container list is editable in settings. Defaults: `.monaco-editor`, `.cm-editor`, `.CodeMirror`, `.ace_editor`, `.xterm`, `[contenteditable]`.
- `<textarea>` is **not** forced to monospace any more (opt-in switch in settings); many sites, Google Search AI mode among them, mirror their text boxes.
- Monospace fonts are replaced from the very first paint, before any page script runs, so an editor measures your font from the start. This covers every monospace font in *Extra fonts* plus an editable list of well-known names (Consolas, Menlo, JetBrains Mono...).
- **Self-learning.** A monospace font that an editor was already using when we discovered it is not swapped under it (it measured and cached the old one). It is remembered automatically (can be switched off), so after one reload it is applied from the first paint like the rest of your list. The popup shows these fonts.
- If an editor keeps the site's configured size, set *Scaling* to *None* in the monospace settings.

## Troubleshooting

If some text still uses an unexpected font:

1. Open the extension popup on the affected website.
2. Check the list of unrecognized fonts.
3. Add the missing font and assign it to the appropriate category.
4. For icon fonts, select **Icon font** to prevent them from being overridden.

If the cursor of an editor or text box is misplaced, see *Code Editors and Text Boxes* above: add the element's root selector to the protected list.

Changes are applied dynamically, without requiring a browser restart. Re-enabling a site or un-hiding an icon font may need a page reload.

Known limitations: fonts used only in `::before` / `::after` pseudo-elements or closed shadow roots are not inspected directly, `system-ui` is handled with selector rules because `@font-face` cannot replace it, and a font registered by a site's JavaScript after the overrides were generated may win until the next rescan.

## Storage

Everything is stored in `chrome.storage.local`:

| Key | Content |
| --- | --- |
| `rmeSettings` | user settings |
| `rmeBrowserFonts` | cache of the browser's font preferences |

Settings from older builds (`settings`, `browserFonts`) are migrated automatically on update.

## Development Notes

- Removed the optional `getRemoteCss` feature, which relied on blocking requests on the page's main thread and was disabled by default.
- The additional font list and the dynamic detection above replace it for cross-origin stylesheets.
- Shared logic (classification, settings, CSS generation) lives in `dist/common.js` without DOM or `chrome.*` dependencies, which keeps it unit-testable.
- Tests: `node tests/common.test.js`, `node tests/background.test.js`, `node tests/ui.test.js`, and `npm i jsdom && node tests/content.test.js` (the last two run the real content script against a simulated CSSOM, so verify changes in a real browser too).
