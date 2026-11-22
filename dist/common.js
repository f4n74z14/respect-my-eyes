/*
 * Respect My Eyes - shared logic
 *
 * Loaded by the content script, the service worker, the popup and the options page, so everything in here
 * must be free of DOM / chrome.* dependencies. Exposed as self.RME.
 */
(function (root) {
    "use strict";

    // chrome.storage.local keys (v1 used the unprefixed names, background.js migrates them)
    const KEYS = { settings: "rmeSettings", fonts: "rmeBrowserFonts", legacy: ["settings", "browserFonts"] };

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

    // Names code editors ask for by default. Applying them before the page's scripts run means an editor measures
    // our font from the start, instead of measuring the site's font and being surprised later.
    const MONO_SEED = [
        "Consolas", "Courier New", "Courier", "Menlo", "Monaco", "Droid Sans Mono", "DejaVu Sans Mono", "Liberation Mono",
        "Lucida Console", "SF Mono", "SFMono-Regular", "Cascadia Code", "Cascadia Mono", "JetBrains Mono", "Fira Code",
        "Fira Mono", "Source Code Pro", "Roboto Mono", "Ubuntu Mono", "IBM Plex Mono", "Inconsolata", "Hack",
        "Noto Sans Mono", "Andale Mono"
    ];

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

    function editorBoundary(extra) {
        const P = EDITOR_PROXY;
        return [P, ":has(> " + P + ")", ":has(> * > " + P + ")"].concat(EDITOR_ROOTS, extra || []).join(",");
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
        "cursive": null, "fantasy": null, "math": null, "emoji": null, "fangsong": null
    };
    const PURE_GENERICS = { "serif": 1, "sans-serif": 1, "monospace": 1 };

    // Values we must never touch
    const SKIP_VALUE = /\b(initial|inherit|unset|revert(-layer)?)\b|var\s*\(|[=&]|^a$/i;

    function norm(name) { return String(name).trim().replace(/\s+/g, " ").toLowerCase(); }

    function cssQuote(name) { return '"' + String(name).replace(/[\\"\r\n]/g, "") + '"'; }

    function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

    function buildMatchers(settings) {
        const manual = new Map();
        (settings.manualFonts || []).forEach(function (f) { manual.set(norm(f.name), f.category); });

        const icon = ICON_SRC.slice();
        (settings.iconPatterns || []).forEach(function (p) { if (p) icon.push(escapeRe(String(p).toLowerCase())); });

        return { icon: new RegExp(icon.join("|"), "i"), manual: manual };
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

    // Split a font-family value on top-level commas
    function splitFamilies(value) {
        const parts = [];
        let cur = "", quote = "";

        for (let i = 0; i < value.length; i++) {
            const ch = value[i];
            if (quote) { cur += ch; if (ch === quote) quote = ""; }
            else if (ch === '"' || ch === "'") { quote = ch; cur += ch; }
            else if (ch === ",") { parts.push(cur); cur = ""; }
            else cur += ch;
        }
        parts.push(cur);

        const out = [];
        parts.forEach(function (p) {
            const t = p.trim().replace(/\s*!important$/i, "");
            if (!t) return;
            const q = /^(["'])(.*)\1$/.exec(t);
            const name = q ? q[2].trim() : t;
            const lower = norm(name);
            out.push({ name: name, lower: lower, generic: !q && Object.prototype.hasOwnProperty.call(GENERIC_CAT, lower) });
        });
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
        tokens.forEach(function (t) {
            if (t.generic) {
                if (GENERIC_CAT[t.lower]) genericCat = GENERIC_CAT[t.lower];
                if (!PURE_GENERICS[t.lower]) pure = false;
            }
            else pure = false;
        });

        const names = [];
        tokens.forEach(function (t) {
            if (t.generic) return;
            let cat = classifyName(t.lower, m), inferred = false;
            if (!cat && genericCat) { cat = genericCat; inferred = true; }
            names.push({ name: t.name, lower: t.lower, cat: cat, inferred: inferred });
        });

        let cat;
        if (names.length) cat = names[0].cat === "icon" ? "skip" : names[0].cat;
        else cat = genericCat;

        return { names: names, cat: cat, pure: pure, unknown: names.length && !names[0].cat ? names[0].name : null };
    }

    // Does a custom property value (--font-foo: ...) look like a font stack?
    function looksLikeFontStack(value, prop) {
        if (!/^[\w\s"'.,\-]+$/.test(value) || !/[a-z]/i.test(value)) return false;

        const parts = splitFamilies(value);
        const last = parts[parts.length - 1];

        if (last && last.generic && GENERIC_CAT[last.lower]) return true;
        return /font|family|typeface/i.test(prop) && !/size|weight|style|height|spacing/i.test(prop);
    }

    // -----------------------------------------------------------------------------------------------------------------
    // Settings
    // -----------------------------------------------------------------------------------------------------------------

    function clone(o) { return JSON.parse(JSON.stringify(o)); }

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

    // Font names end up inside CSS strings, so quotes and backslashes are dropped
    function cleanFontName(x) { return String(x || "").trim().replace(/["\\]/g, "").slice(0, 120); }

    function cleanHost(h) {
        return String(h || "").trim().toLowerCase()
            .replace(/^[a-z][a-z0-9+.-]*:\/\//, "").replace(/^\*\./, "").replace(/[\/?#].*$/, "").replace(/:\d+$/, "");
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

    const cleanHostList = list => uniqueList(list, cleanHost, null, Infinity);
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

        String(text || "").split(/\r?\n/).forEach(function (line, i) {
            const raw = line.trim();
            if (!raw || raw.charAt(0) === "#") return;

            const parts = raw.split(/\s*[|\t]\s*/);
            const name = cleanFontName(parts[0].replace(/^["']|["']$/g, ""));
            let category = defCat;

            if (!name) { invalid.push({ line: i + 1, text: raw, reason: "Empty name" }); return; }

            if (parts.length > 1 && parts[1].trim()) {
                category = CAT_ALIASES[parts[1].trim().toLowerCase()];
                if (!category) { invalid.push({ line: i + 1, text: raw, reason: "Unknown category \"" + parts[1].trim() + "\"" }); return; }
            }
            map.set(norm(name), { name: name, category: category });
        });
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
            s.editors.offSites = cleanHostList(e.offSites);
            // v3 stored the built-in roots too; only the user's own additions are kept now
            if (Array.isArray(e.selectors)) {
                s.editors.selectors = cleanSelectors(e.selectors).filter(function (x) { return EDITOR_ROOTS.indexOf(x) === -1 && x !== "[contenteditable]"; });
            }
        }

        if (Array.isArray(raw.manualFonts)) s.manualFonts = cleanManual(raw.manualFonts);
        if (Array.isArray(raw.iconPatterns)) {
            s.iconPatterns = raw.iconPatterns.map(function (p) { return String(p).trim(); }).filter(Boolean).slice(0, 200);
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

    /*
     * Replicates the descriptors of a face the PAGE declared (read from document.fonts, which works even when the
     * stylesheet itself is blocked by CORS). Identical descriptors make the browser merge our face with the page's
     * one, and the later declaration wins. This also replaces variable fonts (font-weight: 1 1000, font-stretch: 25% 151%).
     * Values come from the page, so they are validated before being put into CSS.
     */
    function fontFaceExtraCss(family, cat, fontName, scalePct, d) {
        const weight = String(d.weight), style = String(d.style), stretch = String(d.stretch || "normal");
        const b = weightBounds(weight);

        if (!b || !/^[\d.\s]+$|^(normal|bold)$/.test(weight) || !/^[a-z0-9 .\-]+$/i.test(style) || !/^[a-z0-9 .%\-]+$/i.test(stretch)) return "";

        const fam = cssQuote(family), adjust = adjustDecl(cat, scalePct);
        const italic = /^(italic|oblique)/i.test(style);
        const out = [faceRule(fam, weight, style, stretch, srcFor(fontName, b[0] >= 600, italic), adjust)];

        if (b[0] < 600 && b[1] >= 600) {      // a range spanning both: also offer a real bold for the upper half
            out.push(faceRule(fam, b[0] + " 599", style, stretch, srcFor(fontName, false, italic), adjust));
            out.push(faceRule(fam, "600 " + b[1], style, stretch, srcFor(fontName, true, italic), adjust));
        }
        return out.join("\n");
    }

    function monoSizeDecl(cfg) {
        return (cfg.monoSize ? "font-size:" + cfg.monoSize + "px!important;" : "") + "letter-spacing:normal!important;";
    }

    // Selector rule that forces our monospace font + size onto the given selector list
    function monoRule(selectors, cfg) {
        return selectors + "{font-family:" + familyValue("mono", cfg.fonts) + "!important;" + monoSizeDecl(cfg) + "}";
    }

    function monoDefaultsCss(cfg) {
        let sel = "pre,code,kbd,samp,pre *,code *";
        if (cfg.settings.mono.textarea) sel += ",textarea";
        return monoRule(sel, cfg);
    }

    // chrome.storage.local access shared by the content script, service worker, popup and options page
    const storage = {
        async load() {
            const data = await chrome.storage.local.get([KEYS.settings, KEYS.fonts]);
            return { settings: normalizeSettings(data[KEYS.settings]), bf: data[KEYS.fonts] || null };
        },
        save(settings) { return chrome.storage.local.set({ [KEYS.settings]: settings }); },
        // fn(changes) runs when the settings or the cached browser fonts changed
        onChange(fn) {
            chrome.storage.onChanged.addListener((changes, area) => {
                if (area === "local" && (changes[KEYS.settings] || changes[KEYS.fonts])) fn(changes);
            });
        }
    };

    root.RME = {
        // data
        KEYS, CATS, MANUAL_CATS, CAT_LABEL, MONO_SEED, DEFAULT_SETTINGS, EDITOR_PROXY, EDITOR_ROOTS,
        // settings
        normalizeSettings, resolveFonts, storage, isExcluded,
        cleanFontName, cleanHostList, cleanSelectors, cleanNameList, cleanManual, parseFontLines,
        // font names
        norm, cssQuote, buildMatchers, classifyName, splitFamilies, analyzeStack, looksLikeFontStack,
        // css
        editorBoundary, familyValue, fontFaceCss, fontFaceExtraCss, isStandardFace, monoRule, monoDefaultsCss
    };
})(typeof self !== "undefined" ? self : this);
