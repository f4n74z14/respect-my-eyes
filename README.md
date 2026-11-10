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

- **Popup:** scans the current website for unrecognized fonts and lets you classify them as sans-serif, serif, monospace, or protected icon fonts. Changes apply immediately.
- **Settings page:** provides an editable list of additional fonts, including support for bulk imports using the `Name|SANS-SERIF` format.
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

## Troubleshooting

If some text still uses an unexpected font:

1. Open the extension popup on the affected website.
2. Check the list of unrecognized fonts.
3. Add the missing font and assign it to the appropriate category.
4. For icon fonts, select **Icon font** to prevent them from being overridden.

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
