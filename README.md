# Respect My Eyes

Big thanks to the [Original Project](https://github.com/sysop84/force-my-browser-fonts)!

This is a major rewrite focused on browser-native font preferences, improved icon font compatibility, customization, and performance.

## Browser Font Preferences

- Automatically reads serif, sans-serif, fixed-width font families and fixed-width font size from browser settings.
- No need to configure fonts separately for individual websites.
- Font preferences are cached in the background and applied to open tabs when browser settings change.
- Includes fallback fonts for browsers that don't expose font preferences to extensions.
- Allows overriding individual font families with custom installed fonts.

## Custom Font Support

- **Popup:** scans the current website for unrecognized fonts and lets you classify them as sans-serif, serif, monospace, or protected icon fonts. Changes apply immediately.
- **Settings page:** provides an editable list of additional fonts, including support for bulk imports using the `Name|SANS-SERIF` format.
- Configure monospace font size and scaling.
- Exclude specific websites.
- Add custom icon font keywords.
- Import, export, and reset configuration.

## Dynamic Font Detection

Improved font detection handles cases that the original stylesheet-based approach could miss:

- Detects fonts referenced through CSS variables, such as `var(--font-family)`.
- Detects fonts specified in inline styles.
- Uses `getComputedStyle()` to inspect fonts actually applied to page elements, independently of how their styles were declared.
- Handles cross-origin stylesheets that cannot be directly inspected due to browser CORS restrictions.
- Processes elements incrementally in batches of 250 to reduce performance impact.
- Groups elements with matching tags, classes, and inline styles to avoid redundant processing.
- Applies detected font substitutions through the existing `@font-face` override mechanism.

This improves compatibility with modern websites using Tailwind CSS, CSS variables, dynamically injected styles, and external stylesheets.

## Performance and Compatibility

- Removed the bundled 80 KB CSS parser, reducing the page script to approximately 33 KB.
- Reduced generated `@font-face` rules from 20 to 4 per font using weight ranges.
- Added incremental stylesheet scanning to detect new rules and dynamically injected styles.
- Improved font-family classification to handle individual names correctly and avoid accidental partial matches.
- Migrated to **Manifest V3** for compatibility with current Chromium-based browsers.
- Uses a dedicated override layer instead of modifying websites' original CSS rules.

## Troubleshooting

If some text still uses an unexpected font:

1. Open the extension popup on the affected website.
2. Check the list of unrecognized fonts.
3. Add the missing font and assign it to the appropriate category.
4. For icon fonts, select **Icon font** to prevent them from being overridden.

Changes are applied dynamically, without requiring a browser restart.

## Development Notes

- Removed the optional `getRemoteCss` feature, which relied on blocking requests on the page's main thread and was disabled by default.
- Additional font configuration provides an alternative for handling cross-origin font stylesheets.
- Dynamic font detection uses computed styles to cover cases that cannot be discovered through direct stylesheet inspection alone.
