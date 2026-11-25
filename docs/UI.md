# UI Architecture & Consistency Rules

Concrete layout, alignment, and resilience rules for the popup and settings pages (`dist/ui.css`, `dist/popup.*`, `dist/options.*`). Referenced from `DESIGN.md`.

## 1. Shell & Fixed Chrome

- **Popup (`popup.html` / `popup.css`)** uses a `flex-direction: column` viewport shell (`width: 360px; max-height: 590px; overflow: hidden; padding: 0;`):
  - `<header>` is pinned at the top (`flex: none; padding: 12px 14px;`).
  - `<div id="banner">` sits outside `#app` (`flex: none; margin: 0 14px 10px; pointer-events: auto;`) so disabling the extension never dims or blocks Reload.
  - `<div id="app">` is the **only** top-level scroll container (`flex: 1 1 auto; min-height: 0; overflow-y: auto; overflow-x: hidden; padding: 0 14px 14px;`).
  - `<footer>` is pinned at the bottom (`flex: none; padding: 10px 14px 12px; border-top: 1px solid var(--line); background: var(--bg);`) so `Settings` never shifts or scrolls out of sight when lists expand or collapse.
- **Settings (`options.html` / `options.css`)** uses a sticky `<div class="topbar">` (`z-index: 10`) above a centered `main` (`max-width: 760px`).

## 2. Toggle Switch Placement (Two Levels Only)

Every `<label class="switch">` must follow one of these two placements—never place switches inside `<h2>` rows or unboxed divs with custom padding:

1. **Shell header switch**: Only the global `#enabled` master switch lives in `<header>`, aligned to the outer shell padding (`14px`).
2. **Card setting row (`.card > .setting`)**: Every toggle inside the body (`#siteOn`, `#edSwitch`, `#edAutoReload`, and all settings toggles) lives inside a `.card > .setting` flex row (`justify-content: space-between`), so every in-body switch aligns to the exact same vertical edge (`card` padding-inline: `12px` in popup, `18px` in options).

## 3. Spacing, Alignment & Radii

- **Strict 3-step border-radius tokens (`ui.css`)**:
  - `--radius-sm` (`7px`): inputs, selects, buttons, nav links, segmented controls (`calc(var(--radius-sm) - 2px)` for inner active buttons).
  - `--radius` (`10px`): cards, rows (`.font-item`, `.card2`, `.ed`, `.list-row`), banners, lists, toasts, preview box.
  - `--radius-lg` (`12px`): large desktop section cards (`options.css`) and modal `<dialog>`.
  - Avoid raw pixel radii outside these tokens (except circular dots/switch tracks and inline `<code>` tags).
- **Consistent inline card padding**:
  - Popup cards and rows (`.card`, `#note`, `.font-item`, `.card2`, `.ed`) all use `12px` horizontal padding so left text edges and right badges/switches align vertically.
  - Options cards (`.card`, `.card.pad`) all use `18px` horizontal padding; `.card.pad > .card-footer:last-child` trims extra bottom padding to match standard `.card` footers.
- **Flex gap over item bottom-margins**: Lists (`#fonts`, `#unknown`, `#editors`, `#app`) use CSS `gap` rather than per-item `margin-bottom`, preventing uneven double gaps before headings.

## 4. Truncation & Heavy-Site Bounds

Pages near content-script caps (hundreds of fonts, long obfuscated names, or dozens of unknown/editor items) must never stretch the popup or freeze the UI:

- **Overflow protection**: Long text slots (`.name`, `.host`, `.face`, `.ed code`) must carry `min-width: 0`, ellipsis truncation, and a `title` tooltip with the full string. Badges, switches, and counts must set `flex: none; white-space: nowrap;` and `font-variant-numeric: tabular-nums`.
- **Bounded scroll regions**: `#unknown` (`max-height: 220px`), `#editors` (`max-height: 165px`), `.list` (`max-height: 320px`), and `#impPreview` (`max-height: 190px`) isolate vertical scrolling with `overscroll-behavior: contain` and `scrollbar-width: thin`.
- **Rendering & input limits**: Use `content-visibility: auto` on list rows (`.list-row`, `.card2`, `.ed`), `contain: layout style` on `.list`, `.switch`, and options `section`s, cap rendered import preview rows (`200` valid, `100` invalid), cap invalid selector error lists, and check storage limits (e.g., 500 `manualFonts`) before showing positive confirmation toasts.
