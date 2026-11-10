/*
 * Force My Browser Fonts - shared logic
 *
 * Loaded by the content script, the service worker, the popup and the options page, so everything in here
 * must be free of DOM / chrome.* dependencies. Exposed as self.FMBF.
 */
(function (root) {
    "use strict";

    const CATS = ["sans", "serif", "mono"];
    const MANUAL_CATS = ["sans", "serif", "mono", "ignore"];
    const CAT_LABEL = { sans: "Sans-serif", serif: "Serif", mono: "Monospace", ignore: "Never touch (icon font)" };
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
        version: 2,
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
            textarea: true          // treat <textarea> as monospace
        },
        manualFonts: DEFAULT_MANUAL_FONTS,
        iconPatterns: []            // extra case-insensitive substrings that mark a font as an icon font
    };

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
            let t = p.trim().replace(/\s*!important$/i, "");
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

    function cleanHost(h) {
        return String(h || "").trim().toLowerCase()
            .replace(/^[a-z][a-z0-9+.-]*:\/\//, "").replace(/^\*\./, "").replace(/[\/?#].*$/, "").replace(/:\d+$/, "");
    }

    function cleanHostList(list) {
        const seen = new Set(), out = [];
        (Array.isArray(list) ? list : []).forEach(function (h) {
            h = cleanHost(h);
            if (h && !seen.has(h)) { seen.add(h); out.push(h); }
        });
        return out;
    }

    function cleanManual(list) {
        const seen = new Set(), out = [];
        list.forEach(function (f) {
            if (!f || typeof f.name !== "string") return;
            const name = f.name.trim().replace(/["\\]/g, "").slice(0, 120);
            const key = norm(name);
            if (!name || seen.has(key) || MANUAL_CATS.indexOf(f.category) === -1) return;
            seen.add(key);
            out.push({ name: name, category: f.category });
        });
        return out;
    }

    function normalizeSettings(raw) {
        const s = clone(DEFAULT_SETTINGS);
        if (!raw || typeof raw !== "object") return s;

        s.enabled = raw.enabled !== false;
        s.excludedSites = cleanHostList(raw.excludedSites);

        CATS.forEach(function (c) {
            const r = raw.fonts && raw.fonts[c];
            if (r && typeof r === "object") {
                s.fonts[c].mode = r.mode === "custom" ? "custom" : "browser";
                s.fonts[c].custom = typeof r.custom === "string" ? r.custom.trim().replace(/["\\]/g, "") : "";
            }
        });

        const m = raw.mono;
        if (m && typeof m === "object") {
            s.mono.sizeMode = ["browser", "custom", "off"].indexOf(m.sizeMode) > -1 ? m.sizeMode : "browser";
            s.mono.customSize = num(m.customSize, 13, 6, 72);
            s.mono.scaleMode = ["auto", "custom", "off"].indexOf(m.scaleMode) > -1 ? m.scaleMode : "auto";
            s.mono.customScale = num(m.customScale, 81.25, 25, 200);
            s.mono.textarea = m.textarea !== false;
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
     * Four @font-face rules per family instead of twenty: weight ranges replace the one-rule-per-weight approach.
     * Chromium treats 550+ as bold, so regular covers 100-549 and bold covers 550-900.
     */
    function fontFaceCss(family, cat, fontName, scalePct) {
        const fam = cssQuote(family);
        const adjust = cat === "mono" && scalePct ? " size-adjust:" + scalePct + "%;" : "";
        const L = function (suffix) { return "local(" + cssQuote(fontName + suffix) + ")"; };

        function face(weight, style, srcs) {
            return "@font-face{font-family:" + fam + ";font-weight:" + weight + ";font-style:" + style + ";src:" + srcs.join(",") + ";" + adjust + "}";
        }
        return [
            face("100 549", "normal", [L(""), L(" Regular")]),
            face("550 900", "normal", [L(" Bold"), L("")]),
            face("100 549", "italic", [L(" Italic"), L(" Oblique"), L("")]),
            face("550 900", "italic", [L(" Bold Italic"), L(" Bold Oblique"), L(" Bold"), L("")])
        ].join("\n");
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

    root.FMBF = {
        CATS: CATS, MANUAL_CATS: MANUAL_CATS, CAT_LABEL: CAT_LABEL, GENERIC_FALLBACK: GENERIC_FALLBACK,
        DEFAULT_SETTINGS: DEFAULT_SETTINGS, DEFAULT_MANUAL_FONTS: DEFAULT_MANUAL_FONTS,
        norm: norm, cssQuote: cssQuote, cleanHost: cleanHost, cleanHostList: cleanHostList, cleanManual: cleanManual,
        buildMatchers: buildMatchers, classifyName: classifyName, splitFamilies: splitFamilies,
        analyzeStack: analyzeStack, looksLikeFontStack: looksLikeFontStack,
        normalizeSettings: normalizeSettings, isExcluded: isExcluded, resolveFonts: resolveFonts,
        familyValue: familyValue, fontFaceCss: fontFaceCss, monoRule: monoRule, monoDefaultsCss: monoDefaultsCss
    };
})(typeof self !== "undefined" ? self : this);
