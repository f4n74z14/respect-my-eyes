/*
 * Respect My Eyes - shared pure logic (loaded by content script, service worker, popup, and options).
 * Must remain free of DOM dependencies and chrome.* except RME.storage. Exposed as self.RME.
 */
(root => {
    "use strict";

    // chrome.storage.local keys (v1 used unprefixed keys, background.js migrates them)
    const KEYS = { settings: "rmeSettings", fonts: "rmeBrowserFonts", hints: "rmeHints", legacy: ["settings", "browserFonts"] };

    const CATS = ["sans", "serif", "mono"];
    const MANUAL_CATS = ["sans", "serif", "mono", "ignore"];
    const CAT_LABEL = { sans: "Sans-serif", serif: "Serif", mono: "Monospace", ignore: "Icon font" };
    const GENERIC_FALLBACK = { sans: "sans-serif", serif: "serif", mono: "monospace" };

    // Used only when chrome.fontSettings is unavailable and no custom font is chosen
    const FALLBACK_FONT = { sans: "Arial", serif: "Georgia", mono: "Courier New", standard: "Times New Roman" };

    // Seeded on first run for common sites using cross-origin CSS or stacks without generic fallbacks
    const DEFAULT_MANUAL_FONTS = [
        ["Skin-market-sans", "sans"], ["Market Sans", "sans"], ["Google Sans", "sans"],
        ["FS Industrie", "sans"], ["FS Industrie Nw", "sans"], ["Barlow", "sans"],
        ["Open Sans", "sans"], ["Open Sans Condensed", "sans"], ["FontinRegular", "sans"],
        ["FontinSmallCaps", "sans"], ["ABC Ginto Normal", "sans"], ["Whitney", "sans"],
        ["Atlas Grotesk", "sans"], ["Atlas Grotesk Web", "sans"], ["Sharp Grotesk", "sans"],
        ["Roboto", "sans"], ["Noto Sans", "sans"], ["GeneralFont", "sans"],
        ["Motiva Sans", "sans"], ["Poppins", "sans"]
    ].map(([name, category]) => ({ name, category }));

    const DEFAULT_SETTINGS = {
        version: 4,
        enabled: true,
        excludedSites: [],
        fonts: {
            sans: { mode: "browser", custom: "" },
            serif: { mode: "browser", custom: "" },
            mono: { mode: "browser", custom: "" }
        },
        mono: {
            sizeMode: "browser",    // browser | custom | off
            customSize: 13,
            scaleMode: "auto",      // auto | custom | off
            customScale: 81.25,
            textarea: false         // opt-in: many sites mirror their textareas
        },
        editors: {
            protect: true,
            autoReload: false,
            selectors: [],
            offSites: []
        },
        manualFonts: DEFAULT_MANUAL_FONTS,
        iconPatterns: []
    };

    /*
     * Automatic editor detection: every mainstream code editor (Monaco, CodeMirror 5/6, Ace, xterm.js)
     * routes input through a hidden element with autocorrect="off" and spellcheck="false". That proxy plus
     * two ancestors form the @scope boundary, supplemented by well-known roots.
     */
    const EDITOR_PROXY = ':is(textarea,[contenteditable],[role="textbox"])[autocorrect="off"][spellcheck="false"]';
    const EDITOR_ROOTS = [".monaco-editor", ".cm-editor", ".CodeMirror", ".ace_editor", ".xterm"];
    const CARET_MIRROR_SCOPE = ":has(> textarea):has(> :is([animating-caret],[data-before][data-after]))";

    function editorBoundary(extra, protectCaretMirrors) {
        const parts = [EDITOR_PROXY, `:has(> ${EDITOR_PROXY})`, `:has(> * > ${EDITOR_PROXY})`];
        if (protectCaretMirrors) parts.push(CARET_MIRROR_SCOPE);
        return parts.concat(EDITOR_ROOTS, extra || []).join(",");
    }

    // -----------------------------------------------------------------------------------------------------------------
    // Font name classification (applied to one normalized family name at a time)
    // -----------------------------------------------------------------------------------------------------------------

    const ICON_SRC = [
        "icon", "awesome", "glyph", "symbol", "emoji", "dashicons", "fontello", "icomoon", "etmodules", "etbuilder",
        "cloudapp", "katfont", "pcgamer", "themify", "genericons", "eicons", "ligature", "^slick$", "^feather$",
        "typicons", "octicons", "codicon", "wingdings", "webdings"
    ];

    const listRe = items => new RegExp(items.join("|"), "i");

    const MONO_RE = listRe([
        "mono(?![a-z])", "monospace", "consol", "courier", "menlo", "monaco", "\\bcode\\b", "cascadia",
        "jetbrains", "fira ?code", "^hack$", "terminal", "andale", "iosevka", "lucida console"
    ]);
    const SANS_RE = listRe([
        "sans", "arial", "athletics", "barlow", "belwe", "grotesk", "grotesque", "helvetica", "impact",
        "^inter(?![a-z])", "montserrat", "oswald", "poppins", "^roboto$", "^segoe ui", "tahoma", "trebuchet",
        "urwdin", "verdana", "calibri", "candara", "corbel", "lucida grande", "^lato", "^nunito", "^raleway",
        "^rubik", "^ubuntu$", "^cantarell$", "^proxima", "^gotham", "^avenir", "^futura", "^sf pro", "^manrope",
        "^-apple-system$", "^blinkmacsystemfont$"
    ]);
    const SERIF_RE = listRe([
        "serif", "georgia", "\\btimes\\b", "garamond", "palatino", "cambria", "baskerville", "bookman",
        "didot", "merriweather", "playfair", "^lora$", "^charter$", "constantia", "cochin",
        "century schoolbook", "book antiqua"
    ]);

    const GENERIC_CAT = {
        "serif": "serif", "sans-serif": "sans", "monospace": "mono",
        "system-ui": "sans", "ui-serif": "serif", "ui-sans-serif": "sans", "ui-monospace": "mono", "ui-rounded": "sans",
        "-apple-system": "sans", "blinkmacsystemfont": "sans",
        "cursive": null, "fantasy": null, "math": null, "emoji": null, "fangsong": null
    };
    const PURE_GENERICS = { "serif": 1, "sans-serif": 1, "monospace": 1 };
    const isReservedFamily = lower => Object.hasOwn(GENERIC_CAT, lower);

    const SKIP_VALUE = /\b(initial|inherit|unset|revert(-layer)?)\b|var\s*\(|[=&]|^a$/i;
    const DEFAULT_ICON_RE = listRe(ICON_SRC);

    const norm = name => String(name).trim().replace(/\s+/g, " ").toLowerCase();
    const cssQuote = name => `"${String(name).replace(/[\x00-\x1f\x7f\\"]/g, "")}"`;
    const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    function buildMatchers(settings) {
        const manual = new Map();
        for (const f of settings.manualFonts || []) manual.set(norm(f.name), f.category);

        const extras = (settings.iconPatterns || []).filter(Boolean).map(p => escapeRe(String(p).toLowerCase()));
        const icon = extras.length ? listRe([...ICON_SRC, ...extras]) : DEFAULT_ICON_RE;
        return { icon, manual };
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

    // Split a font-family value on top-level commas using index slices
    function splitFamilies(value) {
        const out = [];
        let start = 0, quote = "";

        const pushPart = part => {
            if (out.length >= 64) return;
            let t = part.trim();
            if (t.includes("!")) t = t.replace(/\s*!important$/i, "");
            if (!t) return;

            const q = t[0];
            const quoted = (q === '"' || q === "'") && t[t.length - 1] === q && t.length >= 2;
            const name = quoted ? t.slice(1, -1).trim() : t;
            if (!name) return;

            const lower = norm(name);
            out.push({ name, lower, generic: !quoted && isReservedFamily(lower) });
        };

        for (let i = 0; i < value.length && out.length < 64; i++) {
            const ch = value[i];
            if (quote) { if (ch === quote) quote = ""; }
            else if (ch === '"' || ch === "'") quote = ch;
            else if (ch === ",") { pushPart(value.slice(start, i)); start = i + 1; }
        }
        pushPart(value.slice(start));
        return out;
    }

    /*
     * Analyze a font-family value.
     * @return null (ignore) or { names, cat ("sans"|"serif"|"mono"|"skip"|null), pure, firstGeneric, unknown }
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

    const FONT_PROP = /font|family|typeface/i;
    const NON_FONT_PROP = /size|weight|style|height|spacing/i;
    const NON_FONT_START = /^[#.\d]|^-\d/;
    const HAS_LETTER = /[a-z\p{L}]/iu;

    function looksLikeFontStack(value, prop) {
        if (!value || NON_FONT_START.test(value) || /[{};@\\()\r\n]/.test(value) || !HAS_LETTER.test(value)) return false;
        const fontProp = FONT_PROP.test(prop) && !NON_FONT_PROP.test(prop);
        if (fontProp) return true;
        if (!value.includes(",")) return !!GENERIC_CAT[norm(value)];
        const last = splitFamilies(value).pop();
        return !!(last && last.generic && GENERIC_CAT[last.lower]);
    }

    // -----------------------------------------------------------------------------------------------------------------
    // Validation & settings normalization
    // -----------------------------------------------------------------------------------------------------------------

    const clone = typeof structuredClone === "function" ? o => structuredClone(o) : o => JSON.parse(JSON.stringify(o));
    const clampNum = (v, def, min, max) => isFinite(v = parseFloat(v)) ? Math.min(max, Math.max(min, v)) : def;
    const pickEnum = (v, allowed, def) => allowed.includes(v) ? v : def;

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

    // Splits a selector list on top-level commas (outside (), [] or quotes) and checks delimiter balance
    function scanSelectorList(text) {
        const s = String(text || ""), parts = [];
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
    const dropSweeps = text => splitSelectorList(text).filter(s => !/(^|[\s>+~])\*$/.test(s)).join(",");

    // Chromium's CSS.supports("selector(...)") rejects comma-separated lists, so check each item inside :is(...)
    function validSelector(sel) {
        sel = String(sel || "").trim();
        if (!sel || /[{};@\\]/.test(sel)) return false;
        const { parts, balanced, hasEmpty } = scanSelectorList(sel);
        if (!balanced || hasEmpty) return false;
        try {
            return typeof CSS === "undefined" || !CSS.supports || parts.every(p => CSS.supports(`selector(:is(${p}))`));
        }
        catch { return false; }
    }

    const BANNED_HOST_KEYS = new Set(["__proto__", "constructor", "prototype"]);
    const cleanFontName = x => String(x || "").trim().replace(/[\x00-\x1f\x7f"\\]/g, "").slice(0, 120);

    function cleanHost(h) {
        const cleaned = String(h || "").trim().toLowerCase()
            .replace(/^[a-z][a-z0-9+.-]*:\/\//, "").replace(/^\*\./, "").replace(/[\/?#].*$/, "").replace(/:\d+$/, "").slice(0, 253);
        return cleaned && !BANNED_HOST_KEYS.has(cleaned) ? cleaned : "";
    }

    const cleanSelector = x => {
        x = String(x || "").trim();
        return x.length <= 200 && !/[{};@\\]/.test(x) ? x : "";
    };

    const cleanManualFont = f => {
        const name = f && typeof f.name === "string" ? cleanFontName(f.name) : "";
        return name && MANUAL_CATS.includes(f.category) ? { name, category: f.category } : null;
    };

    const cleanHostList = list => uniqueList(list, cleanHost, null, 2000);
    const cleanSelectors = list => uniqueList(list, cleanSelector, null, 40);
    const cleanNameList = list => uniqueList(list, cleanFontName, norm, 200);
    const cleanManual = list => uniqueList(list, cleanManualFont, f => norm(f.name), 500);

    const CAT_ALIASES = {
        sans: "sans", "sans-serif": "sans", sansserif: "sans", serif: "serif",
        mono: "mono", monospace: "mono", ignore: "ignore", icon: "ignore", "icon font": "ignore"
    };

    function parseFontLines(text, defCat) {
        const map = new Map(), invalid = [];
        const lines = String(text || "").split(/\r?\n/, 5000);

        for (let i = 0; i < lines.length; i++) {
            const raw = lines[i].trim();
            if (!raw || raw[0] === "#") continue;

            const [rawName, rawCat = ""] = raw.split(/\s*[|\t]\s*/);
            const name = cleanFontName(rawName.replace(/^["']|["']$/g, ""));
            if (!name) { invalid.push({ line: i + 1, text: raw, reason: "Empty name" }); continue; }

            const catText = rawCat.trim();
            const category = catText ? CAT_ALIASES[catText.toLowerCase()] : defCat;
            if (!category) { invalid.push({ line: i + 1, text: raw, reason: `Unknown category "${catText}"` }); continue; }

            map.set(norm(name), { name, category });
        }
        return { entries: [...map.values()], invalid };
    }

    function normalizeSettings(raw) {
        const s = clone(DEFAULT_SETTINGS);
        if (!raw || typeof raw !== "object") return s;

        const ver = typeof raw.version === "number" ? raw.version : 2;
        s.enabled = raw.enabled !== false;
        s.excludedSites = cleanHostList(raw.excludedSites);

        for (const c of CATS) {
            const r = raw.fonts && raw.fonts[c];
            if (r && typeof r === "object") {
                s.fonts[c].mode = r.mode === "custom" ? "custom" : "browser";
                s.fonts[c].custom = cleanFontName(r.custom);
            }
        }

        const m = raw.mono;
        if (m && typeof m === "object") {
            s.mono.sizeMode = pickEnum(m.sizeMode, ["browser", "custom", "off"], "browser");
            s.mono.customSize = clampNum(m.customSize, 13, 6, 72);
            s.mono.scaleMode = pickEnum(m.scaleMode, ["auto", "custom", "off"], "auto");
            s.mono.customScale = clampNum(m.customScale, 81.25, 25, 200);
            s.mono.textarea = ver >= 3 && m.textarea === true;
        }

        const e = raw.editors;
        if (e && typeof e === "object") {
            s.editors.protect = e.protect !== false;
            s.editors.autoReload = e.autoReload === true;
            s.editors.offSites = cleanHostList(e.offSites);
            if (Array.isArray(e.selectors)) {
                s.editors.selectors = cleanSelectors(e.selectors).filter(x => !EDITOR_ROOTS.includes(x) && x !== "[contenteditable]");
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
        return !!h && list.some(x => h === x || h.endsWith("." + x));
    }

    function resolveFonts(settings, bf) {
        const safeBf = bf && bf.available ? bf : null;
        const pick = (cat, key) => {
            const f = settings.fonts[cat];
            if (f && f.mode === "custom" && f.custom) return { name: f.custom, source: "custom" };
            if (safeBf && safeBf[key]) return { name: safeBf[key], source: "browser" };
            return { name: FALLBACK_FONT[cat], source: "default" };
        };

        const fixedPx = (safeBf && safeBf.fixedSize) || 13;
        const stdPx = (safeBf && safeBf.defaultSize) || 16;
        const m = settings.mono;

        const monoSize = m.sizeMode === "browser" ? fixedPx : m.sizeMode === "custom" ? m.customSize : null;
        let monoScale = m.scaleMode === "auto" ? Math.round(fixedPx / stdPx * 10000) / 100
            : m.scaleMode === "custom" ? m.customScale : null;
        if (monoScale === 100) monoScale = null;

        return {
            fonts: {
                sans: pick("sans", "sansserif"),
                serif: pick("serif", "serif"),
                mono: pick("mono", "fixed"),
                standard: safeBf && safeBf.standard ? { name: safeBf.standard, source: "browser" } : { name: FALLBACK_FONT.standard, source: "default" }
            },
            monoSize,
            monoScale
        };
    }

    // -----------------------------------------------------------------------------------------------------------------
    // CSS & JS FontFace builders
    // -----------------------------------------------------------------------------------------------------------------

    const WEIGHTS = [400, 700];
    const familyValue = (cat, fonts) => `${cssQuote(fonts[cat].name)}, ${GENERIC_FALLBACK[cat]}`;

    function srcFor(fontName, bold, italic) {
        const L = suffix => `local(${cssQuote(fontName + suffix)})`;
        if (!bold && !italic) return [L(""), L(" Regular")];
        if (bold && !italic) return [L(" Bold"), L("")];
        if (!bold && italic) return [L(" Italic"), L(" Oblique"), L("")];
        return [L(" Bold Italic"), L(" Bold Oblique"), L(" Bold"), L("")];
    }

    function faceRule(fam, weight, style, stretch, src, scalePct) {
        const stretchDecl = stretch && stretch !== "normal" ? `;font-stretch:${stretch}` : "";
        const adjustDecl = scalePct ? `size-adjust:${scalePct}%;` : "";
        return `@font-face{font-family:${fam};font-weight:${weight};font-style:${style}${stretchDecl};src:${src.join(",")};${adjustDecl}}`;
    }

    function weightBounds(weight) {
        let first = NaN, last = NaN;
        for (const part of String(weight).trim().split(/\s+/)) {
            const v = part === "normal" ? 400 : part === "bold" ? 700 : parseFloat(part);
            if (!isFinite(v)) continue;
            if (isNaN(first)) first = v;
            last = v;
        }
        return isNaN(first) ? null : [first, last];
    }

    function isStandardFace(d) {
        const w = d.weight, s = d.style, st = d.stretch || "normal";
        if ((s !== "normal" && s !== "italic") || (st !== "normal" && st !== "100%")) return false;
        if (w === "400" || w === "700" || w === "normal" || w === "bold") return true;
        const b = weightBounds(w);
        return !!b && b[0] === b[1] && WEIGHTS.includes(b[0]);
    }

    function fontFaceCss(family, cat, fontName, scalePct) {
        const fam = cssQuote(family), adj = cat === "mono" ? scalePct : null, out = [];
        for (const w of WEIGHTS) {
            for (const style of ["normal", "italic"]) {
                out.push(faceRule(fam, w, style, null, srcFor(fontName, w >= 600, style === "italic"), adj));
            }
        }
        return out.join("\n");
    }

    function fontFaceVariants(cat, fontName, scalePct, d) {
        const weight = String(d.weight), style = String(d.style), stretch = String(d.stretch || "normal");
        const b = weightBounds(weight);
        if (!b || weight.length > 40 || style.length > 40 || stretch.length > 40 ||
            !/^[\d.\s]+$|^(normal|bold)$/.test(weight) || !/^[a-z0-9 .\-]+$/i.test(style) || !/^[a-z0-9 .%\-]+$/i.test(stretch)) return null;

        const italic = /^(italic|oblique)/i.test(style);
        const adj = (cat === "mono" && scalePct) || null;
        const out = [{ weight, style, stretch, src: srcFor(fontName, b[0] >= 600, italic), scalePct: adj }];

        if (b[0] < 600 && b[1] >= 600) {
            out.push({ weight: `${b[0]} 599`, style, stretch, src: srcFor(fontName, false, italic), scalePct: adj });
            out.push({ weight: `600 ${b[1]}`, style, stretch, src: srcFor(fontName, true, italic), scalePct: adj });
        }
        return out;
    }

    function fontFaceExtraCss(family, cat, fontName, scalePct, d) {
        const variants = fontFaceVariants(cat, fontName, scalePct, d);
        if (!variants) return "";
        const fam = cssQuote(family);
        return variants.map(v => faceRule(fam, v.weight, v.style, v.stretch, v.src, v.scalePct)).join("\n");
    }

    function jsFontFaceSpecs(family, cat, fontName, scalePct, d) {
        const fam = cleanFontName(family);
        const variants = fam && fontFaceVariants(cat, fontName, scalePct, d);
        if (!variants) return [];
        return variants.map(v => {
            const descriptors = { weight: v.weight, style: v.style, stretch: v.stretch };
            if (v.scalePct) descriptors.sizeAdjust = `${v.scalePct}%`;
            return { family: fam, source: v.src.join(","), descriptors };
        });
    }

    function monoRule(selectors, cfg) {
        const sizeDecl = cfg.monoSize ? `font-size:${cfg.monoSize}px!important;` : "";
        return `${selectors}{font-family:${familyValue("mono", cfg.fonts)}!important;${sizeDecl}letter-spacing:normal!important;}`;
    }

    const CARET_SEL = ":is([animating-caret],[data-before][data-after])";
    const MIRROR_BASES = [`:has(> textarea) > ${CARET_SEL}`, `textarea ~ ${CARET_SEL}`, "[data-rme-mirror]"];
    const MIRROR_TARGETS = [...MIRROR_BASES, "[data-rme-mirror] *", ...MIRROR_BASES.flatMap(s => [`${s}::before`, `${s}::after`])].join(",");

    function monoDefaultsCss(cfg) {
        const base = "pre,code,kbd,samp,pre *,code *";
        if (!cfg.settings.mono.textarea) return monoRule(base, cfg);
        return `${monoRule(`${base},textarea`, cfg)}\n${monoRule(MIRROR_TARGETS, cfg)}\ntextarea,${MIRROR_TARGETS}{font-variant-ligatures:none!important;font-kerning:none!important;}`;
    }

    // -----------------------------------------------------------------------------------------------------------------
    // Site hints & serialized chrome.storage access
    // -----------------------------------------------------------------------------------------------------------------

    const HINT_LIMITS = { hosts: 300, names: 12 };

    function addHints(hints, host, names) {
        host = cleanHostList([host])[0];
        if (!host) return null;

        const safeHints = hints && typeof hints === "object" ? hints : null;
        const current = safeHints && Object.hasOwn(safeHints, host) && Array.isArray(safeHints[host]) ? cleanNameList(safeHints[host]) : [];
        const merged = cleanNameList([...current, ...(Array.isArray(names) ? names : [])]).slice(0, HINT_LIMITS.names);
        if (merged.length === current.length) return null;

        const next = { ...safeHints };
        delete next[host];                      // re-insert last to preserve insertion-order LRU
        next[host] = merged;

        const keys = Object.keys(next);
        for (let i = 0; i < keys.length - HINT_LIMITS.hosts; i++) delete next[keys[i]];
        return next;
    }

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
        onChange(fn) {
            chrome.storage.onChanged.addListener((changes, area) => {
                if (area === "local" && (changes[KEYS.settings] || changes[KEYS.fonts])) fn(changes);
            });
        }
    };

    root.RME = {
        KEYS, CATS, MANUAL_CATS, CAT_LABEL, DEFAULT_SETTINGS, EDITOR_PROXY, EDITOR_ROOTS,
        normalizeSettings, resolveFonts, storage, isExcluded,
        addHints, HINT_LIMITS, cleanFontName, cleanHostList, cleanSelectors, cleanNameList, cleanManual, parseFontLines,
        norm, cssQuote, isReservedFamily, buildMatchers, classifyName, splitFamilies, analyzeStack, looksLikeFontStack,
        editorBoundary, splitSelectorList, dropSweeps, validSelector, familyValue,
        fontFaceCss, fontFaceExtraCss, jsFontFaceSpecs, isStandardFace, monoRule, monoDefaultsCss
    };
})(typeof self !== "undefined" ? self : this);
