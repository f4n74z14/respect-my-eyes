# UI Architecture & Consistency Rules

Concrete layout, alignment, and resilience rules for the popup and settings pages (`dist/ui.css`, `dist/popup.*`, `dist/options.*`). Referenced from `DESIGN.md`.

## 1. Shell & Fixed Chrome

- **Popup (`popup.html` / `popup.css`)** uses a `flex-direction: column` viewport shell (`html { overflow: hidden; }`, `body { width: 360px; max-height: min(590px, 100vh); overflow: hidden; padding: 0; }`):
  - `<header>` is pinned at the top (`flex: none; padding: 12px 14px;`).
  - `<div id="banner">` sits outside `#app` (`flex: none; margin: 0 14px 10px; pointer-events: auto;`) so disabling the extension never dims or blocks Reload.
  - `<div id="app">` is the **only** scroll container in the popup (`flex: 1 1 auto; min-height: 0; overflow-y: auto; overflow-x: hidden; overscroll-behavior: contain; padding: 0 14px 14px;`); `#unknown` and `#editors` flow directly inside `#app` without nested scrollbars.
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
- **Bounded scroll regions**: `.list` (`max-height: 320px; overflow-y: auto; overflow-x: hidden;`) keeps the 500-entry Extra fonts list compact on the full-tab Settings page with `overscroll-behavior: contain` and `scrollbar-width: thin`, while `#unknown`/`#editors` flow inside `#app` and `#impPreview` flows inside `.dlg-body` (`max-height: none; overflow: visible;`) so neither the popup nor the import dialog shows nested scrollbars.
- **Rendering & input limits**: Use `content-visibility: auto` on list rows (`.list-row`, `.card2`, `.ed`), `contain: layout style` on `.list`, `.switch`, and options `section`s, cap rendered import preview rows (`200` valid, `100` invalid), cap invalid selector error lists, and check storage limits (e.g., 500 `manualFonts`) before showing positive confirmation toasts.

## 5. Motion & Reduced Motion

All UI transitions must be symmetric between open/show and close/hide states and never trap users behind leftover delays:

- **Timing tokens**: Use `--fast` (`150ms`), `--slow` (`220ms`), and `--ease` (`cubic-bezier(.2, .8, .2, 1)`). Avoid arbitrary one-off durations.
- **Symmetric open + close**:
  - Top-layer `<dialog>` and `dialog::backdrop` must animate both opening and closing via `@starting-style` and `transition-behavior: allow-discrete`.
  - `.banner[hidden]` pairs `[hidden] { display: none !important; }` with `allow-discrete` + `@starting-style` so both showing and dismissing animate cleanly while `.hidden` stays synchronous in JS.
  - `<details class="adv">` uses progressive `interpolate-size: allow-keywords` + `::details-content` transitions for smooth expand and collapse.
  - `.fade` (open) resets `visibility` delay to `0s` while `.fade.hide` (close) delays `visibility: hidden` by `--fast`, ensuring opacity fades smoothly in both directions.
  - JS-removed items (`.toast.out`, `.list-row.removing`, `.card2.gone`) must match `--fast` (`150ms`) with a `160ms` timeout via `F.ui.animDelay(160)` so exit animations are never clipped.
- **`prefers-reduced-motion: reduce`**:
  - CSS zeroes `transition-duration`, `transition-delay`, `animation-duration`, and `animation-delay` (`.001ms` / `0s`) and sets `html { scroll-behavior: auto; }` so hidden/delayed states resolve immediately.
  - JS exit timers use `F.ui.animDelay()`, returning `0` under `prefers-reduced-motion: reduce` to remove dismissed elements immediately without phantom waits.
