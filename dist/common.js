/*
 * Respect My Eyes - shared logic
 *
 * Loaded by the content script, the service worker, the popup and the options page, so everything in here
 * must be free of DOM / chrome.* dependencies. Exposed as self.RME.
 */
(function (root) {
    "use strict";

    // chrome.storage.local keys (v1 used the unprefixed names, background.js migrates them)
    const KEYS = { settings: "rmeSettings", fonts: "rmeBrowserFonts", hints: "rmeHints", legacy: ["settings", "browserFonts"] };

    const CATS = ["sans", "serif", "mono"];
    const MANUAL_CATS = ["sans", "serif", "mono", "ignore"];
    const CAT_LABEL = { sans: "Sans-serif", serif: "Serif", mono: "Monospace", ignore: "Icon font" };
    const GENERIC_FALLBACK = { sans: "sans-serif", serif: "serif", mono: "monospace" };

    // Used only when chrome.fontSettings is unavailable and the user did not pick a custom font
    const FALLBACK_FONT = { sans: "Arial", serif: "Georgia", mono: "Courier New", standard: "Times New Roman" };

    // Seeded into the user's list on first run. Fonts the automatic detection cannot classify by itself,
    // i.e. sites that load CSS cross-origin or ship a font stack without any generic fallback.
    const DEFAULT_MANUAL_FONTS = [
        ["Skin-market-sans", "sans"],       // ebay.com/itm
        ["Market Sans", "sans"],            // ebay.com/sch
        ["Google Sans", "sans"],            // developers.google.com
        ["FS Industrie", "sans"],           // cbssports.com
        ["FS Industrie Nw", "sans"],        // cbssports.com
        ["Barlow", "sans"],                 // taxact.com
        ["Open Sans", "sans"],              // taxact.com
        ["Open Sans Condensed", "sans"],    // newegg.com
        ["FontinRegular", "sans"],          // pathofexile.com
        ["FontinSmallCaps", "sans"],        // poedb.tw
        ["ABC Ginto Normal", "sans"],       // discord.com
        ["Whitney", "sans"],                // discord.com
        ["Atlas Grotesk", "sans"],          // dropbox.com
        ["Atlas Grotesk Web", "sans"],      // dropbox.com
        ["Sharp Grotesk", "sans"],          // dropbox.com
        ["Roboto", "sans"],                 // unicode-table.com
        ["Noto Sans", "sans"],              // blizzard.com
        ["GeneralFont", "sans"],            // filterblade.xyz
        ["Motiva Sans", "sans"],            // store.steampowered.com
        ["Poppins", "sans"]                 // fantasypros.com
    ].map(function (f) { return { name: f[0], category: f[1] }; });

    const DEFAULT_SETTINGS = {
        version: 4,
        enabled: true,
        excludedSites: [],
        fonts: {
            sans:  { mode: "browser", custom: "" },
            serif: { mode: "browser", custom: "" },
            mono:  { mode: "browser", custom: "" }
        },
        mono: {
            sizeMode: "browser",    // browser | custom | off  (force a font-size on monospace elements)
            customSize: 13,
            scaleMode: "auto",      // auto | custom | off     (size-adjust for monospace @font-face overrides)
            customScale: 81.25,
            textarea: false         // force the monospace font on <textarea> (opt-in: many sites mirror their text boxes)
        },
        // Code editors measure their own font (cursor / selection / column math). They are found automatically (see
        // editorBoundary) and exempt from our forced size and letter-spacing; a monospace font they were already
        // using is not swapped under them, it is learned for the next load instead.
        editors: {
            protect: true,
            autoReload: false,      // reload the tab once when a new editor font is learned
            selectors: [],          // extra editor roots, for the rare editor the automatic detection misses
            offSites: []            // sites where protection is switched off (from the popup)
        },
        manualFonts: DEFAULT_MANUAL_FONTS,
        iconPatterns: []            // extra case-insensitive substrings that mark a font as an icon font
    };

    /*
     * Automatic detection of code editors. Every mainstream editor routes keyboard input through a hidden element with
     * browser "magic" switched off: Monaco (textarea, or a role=textbox div in EditContext mode), CodeMirror 6
     * (role=textbox contenteditable), CodeMirror 5, Ace and xterm.js (textareas). Verified against the sources of
     * monaco-editor 0.57, @codemirror/view 6.43, codemirror 5.65, ace-builds 1.45 and @xterm/xterm 6.0.
     * The input element and its two nearest ancestors are the boundary; no class names, no timing, pure CSS, so it also
     * covers editors that appear after the page loaded. Well-known roots are listed as a fallback.
     */
    const EDITOR_PROXY = ':is(textarea,[contenteditable],[role="textbox"])[autocorrect="off"][spellcheck="false"]';
    const EDITOR_ROOTS = [".monaco-editor", ".cm-editor", ".CodeMirror", ".ace_editor", ".xterm"];
    const CARET_MIRROR_SCOPE = ':has(> textarea):has(> :is([animating-caret],[data-before][data-after]))';

    function editorBoundary(extra, protectCaretMirrors) {
        const P = EDITOR_PROXY;
        const parts = [P, ":has(> " + P + ")", ":has(> * > " + P + ")"];
        if (protectCaretMirrors) parts.push(CARET_MIRROR_SCOPE);
        return parts.concat(EDITOR_ROOTS, extra || []).join(",");
    }

    // -----------------------------------------------------------------------------------------------------------------
    // Font name classification (applied to ONE family name at a time, lower-cased)
    // -----------------------------------------------------------------------------------------------------------------

    const ICON_SRC = [
        "icon", "awesome", "glyph", "symbol", "emoji", "dashicons", "fontello", "icomoon", "etmodules", "etbuilder",
        "cloudapp", "katfont", "pcgamer", "themify", "genericons", "eicons", "ligature", "^slick$", "^feather$",
        "typicons", "octicons", "codicon", "wingdings", "webdings"
    ];

    const MONO_RE = new RegExp([
        "mono(?![a-z])", "monospace", "consol", "courier", "menlo", "monaco", "\\bcode\\b", "cascadia", "jetbrains",
        "fira ?code", "^hack$", "terminal", "andale", "iosevka", "lucida console"
    ].join("|"), "i");

    const SANS_RE = new RegExp([
        "sans", "arial", "athletics", "barlow", "belwe", "grotesk", "grotesque", "helvetica", "impact",
        "^inter(?![a-z])", "montserrat", "oswald", "poppins", "^roboto$", "^segoe ui", "tahoma", "trebuchet",
        "urwdin", "verdana", "calibri", "candara", "corbel", "lucida grande", "^lato", "^nunito", "^raleway",
        "^rubik", "^ubuntu$", "^cantarell", "^proxima", "^gotham", "^avenir", "^futura", "^sf pro", "^manrope",
        "^-apple-system$", "^blinkmacsystemfont$"
    ].join("|"), "i");

    const SERIF_RE = new RegExp([
        "serif", "georgia", "\\btimes\\b", "garamond", "palatino", "cambria", "baskerville", "bookman", "didot",
        "merriweather", "playfair", "^lora$", "^charter$", "constantia", "cochin", "century schoolbook", "book antiqua"
    ].join("|"), "i");

    const GENERIC_CAT = {
        "serif": "serif", "sans-serif": "sans", "monospace": "mono",
        "system-ui": "sans", "ui-serif": "serif", "ui-sans-serif": "sans", "ui-monospace": "mono", "ui-rounded": "sans",
        "-apple-system": "sans", "blinkmacsystemfont": "sans",
        "cursive": null, "fantasy": null, "math": null, "emoji": null, "fangsong": null
    };
    const PURE_GENERICS = { "serif": 1, "sans-serif": 1, "monospace": 1 };
    const isReservedFamily = lower => Object.hasOwn(GENERIC_CAT, lower);

    // Values we must never touch
    const SKIP_VALUE = /\b(initial|inherit|unset|revert(-layer)?)\b|var\s*\(|[=&]|^a$/i;

    const DEFAULT_ICON_RE = new RegExp(ICON_SRC.join("|"), "i");

    function norm(name) { return (typeof name === "string" ? name : String(name)).trim().replace(/\s+/g, " ").toLowerCase(); }

    function cssQuote(name) { return '"' + String(name).replace(/[\x00-\x1f\x7f\\"]/g, "") + '"'; }

    function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

    function buildMatchers(settings) {
        const manual = new Map();
        (settings.manualFonts || []).forEach(function (f) { manual.set(norm(f.name), f.category); });

        const extras = settings.iconPatterns;
        let icon = DEFAULT_ICON_RE;
        if (extras && extras.length) {
            const parts = ICON_SRC.slice();
            for (let i = 0; i < extras.length; i++) if (extras[i]) parts.push(escapeRe(String(extras[i]).toLowerCase()));
            if (parts.length > ICON_SRC.length) icon = new RegExp(parts.join("|"), "i");
        }

        return { icon: icon, manual: manual };
    }

    // @return "icon" | "sans" | "serif" | "mono" | null
    function classifyName(lower, m) {
        const man = m.manual.get(lower);
        if (man) return man === "ignore" ? "icon" : man;
        if (m.icon.test(lower)) return "icon";
        if (MONO_RE.test(lower)) return "mono";
        if (SANS_RE.test(lower)) return "sans";
        if (SERIF_RE.test(lower)) return "serif";
        return null;
    }

    // Split a font-family value on top-level commas using index slices (avoids char-by-char string concat)
    function splitFamilies(value) {
        const out = [];
        let start = 0, quote = "";

        const pushPart = p => {
            if (out.length >= 64) return;
            let t = p.trim();
            if (t.includes("!")) t = t.replace(/\s*!important$/i, "");
            if (!t) return;
            const c0 = t.charCodeAt(0);
            const quoted = (c0 === 34 || c0 === 39) && t.charCodeAt(t.length - 1) === c0 && t.length >= 2;
            const name = quoted ? t.slice(1, -1).trim() : t;
            if (!name) return;
            const lower = norm(name);
            out.push({ name, lower, generic: !quoted && Object.hasOwn(GENERIC_CAT, lower) });
        };

        for (let i = 0; i < value.length; i++) {
            const ch = value[i];
            if (quote) { if (ch === quote) quote = ""; }
            else if (ch === '"' || ch === "'") quote = ch;
            else if (ch === ",") { pushPart(value.slice(start, i)); start = i + 1; if (out.length >= 64) return out; }
        }
        pushPart(value.slice(start));
        return out;
    }

    /*
     * Analyze a font-family value.
     *
     * @return null (ignore this value) or
     *   {
     *     names:  [{ name, lower, cat, inferred }]  non-generic family names; cat = icon|sans|serif|mono|null
     *     cat:    sans|serif|mono   category of the font that will actually render (first family, else generic)
     *             "skip"            first family is an icon font, leave the stack alone
     *             null              unknown
     *     pure:   true when the stack is nothing but serif / sans-serif / monospace
     *     unknown: name of the first family if we could not classify it AND the stack has no generic fallback
     *   }
     */
    function analyzeStack(value, m) {
        if (!value || SKIP_VALUE.test(value)) return null;

        const tokens = splitFamilies(value);
        if (!tokens.length) return null;

        let genericCat = null, pure = true;
        for (const t of tokens) {
            if (t.generic) {
                if (GENERIC_CAT[t.lower]) genericCat = GENERIC_CAT[t.lower];
                if (!PURE_GENERICS[t.lower]) pure = false;
            }
            else pure = false;
        }

        const names = [];
        for (const t of tokens) {
            if (t.generic) continue;
            let cat = classifyName(t.lower, m), inferred = false;
            if (!cat && genericCat) { cat = genericCat; inferred = true; }
            names.push({ name: t.name, lower: t.lower, cat, inferred });
        }

        const t0 = tokens[0];
        const firstGeneric = !!(t0 && t0.generic && !PURE_GENERICS[t0.lower] && GENERIC_CAT[t0.lower]);
        const cat = firstGeneric ? GENERIC_CAT[t0.lower]
            : (names.length ? (names[0].cat === "icon" ? "skip" : names[0].cat) : genericCat);
        return { names, cat, pure, firstGeneric, unknown: names.length && !names[0].cat ? names[0].name : null };
    }

    // Does a custom property value (--font-foo: ...) look like a font stack?
    function looksLikeFontStack(value, prop) {
        if (!value || /[{};@\\()\r\n]/.test(value) || !/[a-z\p{L}]/iu.test(value)) return false;

        const parts = splitFamilies(value);
        const last = parts[parts.length - 1];

        if (last && last.generic && GENERIC_CAT[last.lower]) return true;
        return /font|family|typeface/i.test(prop) && !/size|weight|style|height|spacing/i.test(prop);
    }

    // -----------------------------------------------------------------------------------------------------------------
    // Settings
    // -----------------------------------------------------------------------------------------------------------------

    const clone = typeof structuredClone === "function" ? o => structuredClone(o) : o => JSON.parse(JSON.stringify(o));

    function num(v, def, min, max) {
        v = parseFloat(v);
        return isFinite(v) ? Math.min(max, Math.max(min, v)) : def;
    }

    // Cleans each item (clean() returns a falsy value to drop it), removes duplicates and caps the length
    function uniqueList(list, clean, key, max) {
        const seen = new Set(), out = [];

        for (const item of Array.isArray(list) ? list : []) {
            const value = clean(item);
            const k = value && (key ? key(value) : value);

            if (!value || seen.has(k)) continue;
            seen.add(k);
            out.push(value);
            if (out.length >= max) break;
        }
        return out;
    }

    // Splits a selector list on top-level commas (not those inside (), [] or quotes) and checks delimiter balance
    function scanSelectorList(text) {
        const s = String(text || "");
        const parts = [];
        let depth = 0, quote = "", start = 0;

        for (let i = 0; i < s.length; i++) {
            const ch = s[i];
            if (quote) { if (ch === quote) quote = ""; }
            else if (ch === '"' || ch === "'") quote = ch;
            else if (ch === "(" || ch === "[") depth++;
            else if (ch === ")" || ch === "]") { if (--depth < 0) return { parts: [], balanced: false, hasEmpty: true }; }
            else if (ch === "," && depth === 0) { parts.push(s.slice(start, i).trim()); start = i + 1; }
        }
        parts.push(s.slice(start).trim());
        return { parts, balanced: depth === 0 && !quote, hasEmpty: parts.some(p => !p) };
    }

    const splitSelectorList = text => scanSelectorList(text).parts.filter(Boolean);

    // A selector ending in "*" sweeps over every descendant, icon elements included, so it is never mirrored
    const dropSweeps = text => splitSelectorList(text).filter(s => !/(^|[\s>+~])\*$/.test(s)).join(",");

    // Validates a CSS selector or comma-separated selector list for use in @scope limits and closest().
    // Chromium's CSS.supports("selector(...)") only accepts a single complex selector (comma-separated lists
    // return false), so each top-level item is checked inside :is(...) after rejecting empty slots or
    // unbalanced delimiters. :is() also rejects pseudo-elements (invalid in @scope limits).
    function validSelector(sel) {
        sel = String(sel || "").trim();
        if (!sel || /[{};@\\]/.test(sel)) return false;

        const { parts, balanced, hasEmpty } = scanSelectorList(sel);
        if (!balanced || hasEmpty) return false;

        try {
            if (typeof CSS === "undefined" || !CSS.supports) return true;
            return parts.every(p => CSS.supports(`selector(:is(${p}))`));
        }
        catch { return false; }
    }

    const BANNED_HOST_KEYS = new Set(["__proto__", "constructor", "prototype"]);

    // Font names end up inside CSS strings, so quotes, backslashes and control chars are dropped
    function cleanFontName(x) { return String(x || "").trim().replace(/[\x00-\x1f\x7f"\\]/g, "").slice(0, 120); }

    function cleanHost(h) {
        const cleaned = String(h || "").trim().toLowerCase()
            .replace(/^[a-z][a-z0-9+.-]*:\/\//, "").replace(/^\*\./, "").replace(/[\/?#].*$/, "").replace(/:\d+$/, "").slice(0, 253);
        return cleaned && !BANNED_HOST_KEYS.has(cleaned) ? cleaned : "";
    }

    // User-typed CSS selectors: reject anything that could break out of a selector
    function cleanSelector(x) {
        x = String(x || "").trim();
        return x.length <= 200 && !/[{};@\\]/.test(x) ? x : "";
    }

    function cleanManualFont(f) {
        const name = f && typeof f.name === "string" ? cleanFontName(f.name) : "";
        return name && MANUAL_CATS.includes(f.category) ? { name: name, category: f.category } : null;
    }

    const cleanHostList = list => uniqueList(list, cleanHost, null, 2000);
    const cleanSelectors = list => uniqueList(list, cleanSelector, null, 40);
    const cleanNameList = list => uniqueList(list, cleanFontName, norm, 200);
    const cleanManual = list => uniqueList(list, cleanManualFont, f => norm(f.name), 500);

    const CAT_ALIASES = {
        "sans": "sans", "sans-serif": "sans", "sansserif": "sans", "serif": "serif",
        "mono": "mono", "monospace": "mono", "ignore": "ignore", "icon": "ignore", "icon font": "ignore"
    };

    /*
     * Parses a pasted list: one font per line, optional category after "|" or a tab (spreadsheet paste).
     * Lines without a category get defCat. Accepts the old "Name|SANS-SERIF" format. "#" starts a comment.
     * @return { entries: [{name, category}] (de-duplicated, last wins), invalid: [{line, text, reason}] }
     */
    function parseFontLines(text, defCat) {
        const map = new Map(), invalid = [];
        const lines = String(text || "").split(/\r?\n/, 5000);

        for (let i = 0; i < lines.length; i++) {
            const raw = lines[i].trim();
            if (!raw || raw.charAt(0) === "#") continue;

            const parts = raw.split(/\s*[|\t]\s*/);
            const name = cleanFontName(parts[0].replace(/^["']|["']$/g, ""));
            let category = defCat;

            if (!name) { invalid.push({ line: i + 1, text: raw, reason: "Empty name" }); continue; }

            if (parts.length > 1 && parts[1].trim()) {
                category = CAT_ALIASES[parts[1].trim().toLowerCase()];
                if (!category) { invalid.push({ line: i + 1, text: raw, reason: "Unknown category \"" + parts[1].trim() + "\"" }); continue; }
            }
            map.set(norm(name), { name: name, category: category });
        }
        return { entries: Array.from(map.values()), invalid: invalid };
    }

    function normalizeSettings(raw) {
        const s = clone(DEFAULT_SETTINGS);
        if (!raw || typeof raw !== "object") return s;

        const ver = typeof raw.version === "number" ? raw.version : 2;     // < 3: textarea forcing was on by default

        s.enabled = raw.enabled !== false;
        s.excludedSites = cleanHostList(raw.excludedSites);

        CATS.forEach(function (c) {
            const r = raw.fonts && raw.fonts[c];
            if (r && typeof r === "object") {
                s.fonts[c].mode = r.mode === "custom" ? "custom" : "browser";
                s.fonts[c].custom = cleanFontName(r.custom);
            }
        });

        const m = raw.mono;
        if (m && typeof m === "object") {
            s.mono.sizeMode = ["browser", "custom", "off"].indexOf(m.sizeMode) > -1 ? m.sizeMode : "browser";
            s.mono.customSize = num(m.customSize, 13, 6, 72);
            s.mono.scaleMode = ["auto", "custom", "off"].indexOf(m.scaleMode) > -1 ? m.scaleMode : "auto";
            s.mono.customScale = num(m.customScale, 81.25, 25, 200);
            s.mono.textarea = ver >= 3 && m.textarea === true;
        }

        const e = raw.editors;
        if (e && typeof e === "object") {
            s.editors.protect = e.protect !== false;
            s.editors.autoReload = e.autoReload === true;
            s.editors.offSites = cleanHostList(e.offSites);
            // v3 stored the built-in roots too; only the user's own additions are kept now
            if (Array.isArray(e.selectors)) {
                s.editors.selectors = cleanSelectors(e.selectors).filter(function (x) { return EDITOR_ROOTS.indexOf(x) === -1 && x !== "[contenteditable]"; });
            }
        }

        if (Array.isArray(raw.manualFonts)) s.manualFonts = cleanManual(raw.manualFonts);
        if (Array.isArray(raw.iconPatterns)) {
            s.iconPatterns = raw.iconPatterns.map(p => String(p).trim().slice(0, 80)).filter(Boolean).slice(0, 200);
        }
        return s;
    }

    function isExcluded(hostname, list) {
        const h = String(hostname || "").toLowerCase();
        if (!h) return false;
        return list.some(function (x) { return h === x || h.endsWith("." + x); });
    }

    /*
     * Decide which fonts to use.
     *
     * @param settings normalized settings
     * @param bf       cached browser font settings written by the service worker:
     *                 { available, standard, serif, sansserif, fixed, fixedSize, defaultSize }
     * @return { fonts: {sans, serif, mono, standard}: {name, source}, monoSize: number|null, monoScale: number|null }
     */
    function resolveFonts(settings, bf) {
        if (!bf || !bf.available) bf = null;

        function pick(cat, key) {
            const f = settings.fonts[cat];
            if (f && f.mode === "custom" && f.custom) return { name: f.custom, source: "custom" };
            if (bf && bf[key]) return { name: bf[key], source: "browser" };
            return { name: FALLBACK_FONT[cat], source: "default" };
        }

        const fixedPx = (bf && bf.fixedSize) || 13;
        const stdPx = (bf && bf.defaultSize) || 16;
        const m = settings.mono;

        let monoSize = null, monoScale = null;

        if (m.sizeMode === "browser") monoSize = fixedPx;
        else if (m.sizeMode === "custom") monoSize = m.customSize;

        if (m.scaleMode === "auto") monoScale = Math.round(fixedPx / stdPx * 10000) / 100;
        else if (m.scaleMode === "custom") monoScale = m.customScale;
        if (monoScale === 100) monoScale = null;

        return {
            fonts: {
                sans: pick("sans", "sansserif"),
                serif: pick("serif", "serif"),
                mono: pick("mono", "fixed"),
                standard: bf && bf.standard ? { name: bf.standard, source: "browser" } : { name: FALLBACK_FONT.standard, source: "default" }
            },
            monoSize: monoSize,
            monoScale: monoScale
        };
    }

    // -----------------------------------------------------------------------------------------------------------------
    // CSS builders
    // -----------------------------------------------------------------------------------------------------------------

    // font-family value used for overrides, e.g. "Arial", sans-serif
    function familyValue(cat, fonts) { return cssQuote(fonts[cat].name) + ", " + GENERIC_FALLBACK[cat]; }

    /*
     * Static faces: regular + bold, upright + italic (4 rules per family). Chromium treats 600+ as bold, and for
     * system fonts the browser picks the nearest of the two for any other weight.
     * Any other descriptor the page declares (300, 500, variable ranges...) is replicated exactly by
     * fontFaceExtraCss(), so a page's own @font-face that cannot be removed (stylesheet blocked by CORS) is always
     * merged with ours and ours, declared later, wins.
     */
    const WEIGHTS = [400, 700];

    function srcFor(fontName, bold, italic) {
        const L = function (suffix) { return "local(" + cssQuote(fontName + suffix) + ")"; };

        if (!bold && !italic) return [L(""), L(" Regular")];
        if (bold && !italic) return [L(" Bold"), L("")];
        if (!bold && italic) return [L(" Italic"), L(" Oblique"), L("")];
        return [L(" Bold Italic"), L(" Bold Oblique"), L(" Bold"), L("")];
    }

    function faceRule(fam, weight, style, stretch, src, adjust) {
        return "@font-face{font-family:" + fam + ";font-weight:" + weight + ";font-style:" + style +
            (stretch && stretch !== "normal" ? ";font-stretch:" + stretch : "") + ";src:" + src.join(",") + ";" + adjust + "}";
    }

    function adjustDecl(cat, scalePct) { return cat === "mono" && scalePct ? "size-adjust:" + scalePct + "%;" : ""; }

    function fontFaceCss(family, cat, fontName, scalePct) {
        const fam = cssQuote(family), adjust = adjustDecl(cat, scalePct), out = [];

        WEIGHTS.forEach(function (w) {
            ["normal", "italic"].forEach(function (style) {
                out.push(faceRule(fam, w, style, null, srcFor(fontName, w >= 600, style === "italic"), adjust));
            });
        });
        return out.join("\n");
    }

    function weightBounds(weight) {
        const n = String(weight).split(/\s+/).map(function (x) { return x === "normal" ? 400 : x === "bold" ? 700 : parseFloat(x); }).filter(isFinite);
        return n.length ? [n[0], n[n.length - 1]] : null;
    }

    // true when fontFaceCss() already produces a rule with exactly these descriptors
    function isStandardFace(d) {
        const b = weightBounds(d.weight);
        return !!b && b[0] === b[1] && WEIGHTS.indexOf(b[0]) > -1 && /^(normal|italic)$/.test(d.style) && /^(normal|100%)$/.test(d.stretch || "normal");
    }

    function fontFaceVariants(cat, fontName, scalePct, d) {
        const weight = String(d.weight), style = String(d.style), stretch = String(d.stretch || "normal");
        const b = weightBounds(weight);

        if (!b || weight.length > 40 || style.length > 40 || stretch.length > 40 ||
            !/^[\d.\s]+$|^(normal|bold)$/.test(weight) || !/^[a-z0-9 .\-]+$/i.test(style) || !/^[a-z0-9 .%\-]+$/i.test(stretch)) return null;

        const italic = /^(italic|oblique)/i.test(style);
        const adj = cat === "mono" && scalePct ? scalePct : null;
        const out = [{ weight, style, stretch, src: srcFor(fontName, b[0] >= 600, italic), scalePct: adj }];

        if (b[0] < 600 && b[1] >= 600) {      // a range spanning both: also offer a real bold for the upper half
            out.push({ weight: b[0] + " 599", style, stretch, src: srcFor(fontName, false, italic), scalePct: adj });
            out.push({ weight: "600 " + b[1], style, stretch, src: srcFor(fontName, true, italic), scalePct: adj });
        }
        return out;
    }

    /*
     * Replicates the descriptors of a face the PAGE declared (read from document.fonts, which works even when the
     * stylesheet itself is blocked by CORS). Identical descriptors make the browser merge our face with the page's
     * one, and the later declaration wins. This also replaces variable fonts (font-weight: 1 1000, font-stretch: 25% 151%).
     * Values come from the page, so they are validated before being put into CSS.
     */
    function fontFaceExtraCss(family, cat, fontName, scalePct, d) {
        const variants = fontFaceVariants(cat, fontName, scalePct, d);
        if (!variants) return "";

        const fam = cssQuote(family);
        return variants.map(function (v) {
            return faceRule(fam, v.weight, v.style, v.stretch, v.src, v.scalePct ? "size-adjust:" + v.scalePct + "%;" : "");
        }).join("\n");
    }

    // Builds descriptor specs for JS `new FontFace(family, source, descriptors)` shadows added to document.fonts,
    // which otherwise outrank CSS @font-face rules in Chromium's font cascade.
    function jsFontFaceSpecs(family, cat, fontName, scalePct, d) {
        const fam = cleanFontName(family);
        const variants = fam && fontFaceVariants(cat, fontName, scalePct, d);
        if (!variants) return [];

        return variants.map(function (v) {
            const desc = { weight: v.weight, style: v.style, stretch: v.stretch };
            if (v.scalePct) desc.sizeAdjust = v.scalePct + "%";
            return { family: fam, source: v.src.join(","), descriptors: desc };
        });
    }

    function monoSizeDecl(cfg) {
        return (cfg.monoSize ? "font-size:" + cfg.monoSize + "px!important;" : "") + "letter-spacing:normal!important;";
    }

    // Selector rule that forces our monospace font + size onto the given selector list
    function monoRule(selectors, cfg) {
        return selectors + "{font-family:" + familyValue("mono", cfg.fonts) + "!important;" + monoSizeDecl(cfg) + "}";
    }

    const TEXTAREA_MIRROR = ":has(> textarea) > :is([animating-caret],[data-before][data-after]),textarea ~ :is([animating-caret],[data-before][data-after]),[data-rme-mirror],[data-rme-mirror] *";
    const TEXTAREA_MIRROR_PSEUDO = ":has(> textarea) > :is([animating-caret],[data-before][data-after])::before,:has(> textarea) > :is([animating-caret],[data-before][data-after])::after,textarea ~ :is([animating-caret],[data-before][data-after])::before,textarea ~ :is([animating-caret],[data-before][data-after])::after,[data-rme-mirror]::before,[data-rme-mirror]::after";

    function monoDefaultsCss(cfg) {
        let sel = "pre,code,kbd,samp,pre *,code *";
        if (!cfg.settings.mono.textarea) return monoRule(sel, cfg);

        sel += ",textarea";
        const mirrors = TEXTAREA_MIRROR + "," + TEXTAREA_MIRROR_PSEUDO;
        return monoRule(sel, cfg) + "\n" + monoRule(mirrors, cfg) +
            "\ntextarea," + mirrors + "{font-variant-ligatures:none!important;font-kerning:none!important;}";
    }

    /*
     * Site hints: which monospace fonts a site's code editor used. They are replaced from the first paint on that
     * site only, so the cost of a font list never depends on how long it is. Oldest sites are dropped first.
     *
     * @return the updated hints, or null when nothing changed
     */
    const HINT_LIMITS = { hosts: 300, names: 12 };

    function addHints(hints, host, names) {
        host = cleanHostList([host])[0];
        if (!host) return null;

        const safeHints = hints && typeof hints === "object" ? hints : null;
        const current = safeHints && Object.hasOwn(safeHints, host) && Array.isArray(safeHints[host])
            ? cleanNameList(safeHints[host]) : [];
        const list = Array.isArray(names) ? names : [];
        const merged = cleanNameList([...current, ...list]).slice(0, HINT_LIMITS.names);

        if (merged.length === current.length) return null;

        const next = { ...safeHints };
        delete next[host];                      // re-insert last: object keys keep insertion order
        next[host] = merged;

        const keys = Object.keys(next);
        for (let i = 0; i < keys.length - HINT_LIMITS.hosts; i++) delete next[keys[i]];
        return next;
    }

    // chrome.storage.local access shared by the content script, service worker, popup and options page.
    // Writes execute immediately when idle and serialize when overlapping so rapid toggles never commit out of order.
    let saveChain = null;
    const storage = {
        async load() {
            const data = await chrome.storage.local.get([KEYS.settings, KEYS.fonts, KEYS.hints]);
            return { settings: normalizeSettings(data[KEYS.settings]), bf: data[KEYS.fonts] || null, hints: data[KEYS.hints] || {} };
        },
        save(settings) {
            const snapshot = normalizeSettings(settings);
            const write = () => chrome.storage.local.set({ [KEYS.settings]: snapshot });
            const p = (saveChain ? saveChain.catch(() => {}).then(write) : Promise.resolve(write()))
                .finally(() => { if (saveChain === p) saveChain = null; });
            saveChain = p;
            return p;
        },
        // fn(changes) runs when the settings or the cached browser fonts changed
        onChange(fn) {
            chrome.storage.onChanged.addListener((changes, area) => {
                if (area === "local" && (changes[KEYS.settings] || changes[KEYS.fonts])) fn(changes);
            });
        }
    };

    root.RME = {
        // data
        KEYS, CATS, MANUAL_CATS, CAT_LABEL, DEFAULT_SETTINGS, EDITOR_PROXY, EDITOR_ROOTS,
        // settings
        normalizeSettings, resolveFonts, storage, isExcluded,
        addHints, HINT_LIMITS, cleanFontName, cleanHostList, cleanSelectors, cleanNameList, cleanManual, parseFontLines,
        // font names
        norm, cssQuote, isReservedFamily, buildMatchers, classifyName, splitFamilies, analyzeStack, looksLikeFontStack,
        // css
        editorBoundary, splitSelectorList, dropSweeps, validSelector, familyValue, fontFaceCss, fontFaceExtraCss, jsFontFaceSpecs, isStandardFace, monoRule, monoDefaultsCss
    };
})(typeof self !== "undefined" ? self : this);
