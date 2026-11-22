/*
 * Respect My Eyes - content script
 *
 * Forces the fonts configured in the browser (chrome://settings/fonts) onto every page without breaking icon fonts.
 *
 *   base sheet  (document_start)   manual fonts + monospace defaults, so the first paint is already right
 *   site sheet  (DOM ready, load,  built from what the page uses: stylesheets, computed styles, document.fonts.
 *                new stylesheets)  Names are overridden with @font-face local(), selectors with !important rules.
 *
 * Both sheets are constructed stylesheets: exempt from the page's CSP and cheap to replace.
 */
(() => {
    "use strict";

    const F = self.RME;

    if (!F || window.__rmeLoaded) return;
    window.__rmeLoaded = true;

    const { CATS, norm } = F;
    const isCat = cat => CATS.includes(cat);

    const VAR_SCOPE = /^(:root|html|body)\b/i;
    const CHUNK = 250;              // elements sampled per tick
    const SAMPLE_LIMIT = 6000;
    const REPORT_LIMIT = 8000;
    const RULE_TYPES = { CSSStyleRule: 1, CSSImportRule: 3, CSSFontFaceRule: 5, CSSKeyframesRule: 7 };   // legacy fallback

    // Our site and its top-level site, so an excluded site also excludes its iframes
    const HOSTS = (() => {
        const top = location.ancestorOrigins && location.ancestorOrigins.length
            ? [location.ancestorOrigins[location.ancestorOrigins.length - 1]] : [];
        return [location.hostname, ...top.map(o => { try { return new URL(o).hostname; } catch { return ""; } })];
    })();
    const matchesHosts = list => HOSTS.some(h => F.isExcluded(h, list));

    // Monospace fonts an editor was already using when found: they stay untouched for the rest of this page's life,
    // because the editor measured the old font. Survives configure().
    const lateNames = new Map();
    const learnQueue = new Set();

    let cfg = null;                 // resolved configuration, null while disabled or excluded
    let offReason = "disabled";

    const freshState = () => ({
        analysis: new Map(),        // font-family value -> analysis
        faceCss: new Map(),         // name|category -> generated @font-face rules
        processed: new WeakMap(),   // sheet -> number of rules already scanned
        unreadable: new WeakSet(),  // cross-origin sheets
        faces: new Map(),           // lower-case family -> { name, cat } to override
        pageFaces: new Map(),       // faces the page declared with non-standard descriptors
        faceKeys: new Set(),
        faceRules: [],              // page @font-face rules that may have to be removed
        sel: { sans: new Set(), serif: new Set(), mono: new Set() },
        vars: [],                   // custom property overrides
        sampled: new Set(),
        sampledOnce: false,
        fontCount: -1,
        bodyCat: null,
        lastCss: null
    });
    let st = freshState();

    // ---------------------------------------------------------------------------------------------------------------
    // Output: two constructed stylesheets, with a <style> fallback
    // ---------------------------------------------------------------------------------------------------------------

    class Sink {
        constructor() {
            this.el = null;
            try { this.sheet = new CSSStyleSheet(); } catch { this.sheet = null; }
        }

        set(css) {
            if (this.sheet) {
                try { this.sheet.replaceSync(css); return; } catch { this.sheet = null; }
            }
            if (!this.el) {
                this.el = document.createElement("style");
                this.el.setAttribute("data-rme", "");
            }
            this.el.textContent = css;
            if (!this.el.isConnected) (document.head || document.documentElement).appendChild(this.el);
        }
    }

    const baseSink = new Sink();
    const siteSink = new Sink();
    const ours = new Set([baseSink.sheet, siteSink.sheet]);

    // Keep our sheets last in the cascade; a page may have adopted its own since we looked
    function attach() {
        if (!baseSink.sheet || !siteSink.sheet) return;

        try {
            const current = [...document.adoptedStyleSheets];
            const wanted = [...current.filter(s => !ours.has(s)), baseSink.sheet, siteSink.sheet];

            if (wanted.some((s, i) => current[i] !== s) || current.length !== wanted.length) document.adoptedStyleSheets = wanted;
        }
        catch {
            baseSink.sheet = siteSink.sheet = null;     // adoption not possible here, fall back to <style>
        }
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Analysis
    // ---------------------------------------------------------------------------------------------------------------

    function analyze(value) {
        if (!st.analysis.has(value)) st.analysis.set(value, F.analyzeStack(value, cfg.matchers));
        return st.analysis.get(value);
    }

    // A pure "sans-serif" stack already follows the browser setting, so it is only forced for a custom font
    const overridable = a => !!a && isCat(a.cat) && !(a.pure && cfg.fonts[a.cat].source !== "custom");

    const familyOf = cat => F.familyValue(cat, cfg.fonts);

    /*
     * @param defer true for names found inside a self-measuring editor: a monospace font it was already using must not
     *              be swapped under it, unless it is in the base sheet (applied before any page script runs).
     */
    function registerNames(a, defer) {
        for (const n of a.names) {
            if (!isCat(n.cat) || cfg.chosenLower.has(n.lower) || st.faces.has(n.lower) || lateNames.has(n.lower)) continue;

            if (defer && n.cat === "mono" && !cfg.preFaces.has(n.lower)) {
                lateNames.set(n.lower, n.name);
                learnQueue.add(n.name);
            }
            else st.faces.set(n.lower, { name: n.name, cat: n.cat });
        }
    }

    // Our monospace rules must not reach into editors: they would resize and respace text the editor positions itself
    const wrap = css => cfg.protectSel ? `@scope (:root) to (${cfg.protectSel}){${css}}` : css;

    // ---------------------------------------------------------------------------------------------------------------
    // Stylesheet walking
    // ---------------------------------------------------------------------------------------------------------------

    function isRule(rule, ctor) {
        const C = self[ctor];
        return C ? rule instanceof C : rule.type === RULE_TYPES[ctor];
    }

    // Custom properties holding a font stack (--font-body: ...) are overridden where they are defined
    function overrideCustomProps(rule) {
        const { style } = rule;
        let decls = "";

        for (let i = 0; i < style.length; i++) {
            const prop = style[i];
            if (!prop.startsWith("--")) continue;

            const value = style.getPropertyValue(prop).trim();
            if (!value || value.length > 500 || value.includes("(") || !F.looksLikeFontStack(value, prop)) continue;

            const a = analyze(value);
            if (overridable(a)) {
                registerNames(a);
                decls += `${prop}:${familyOf(a.cat)}!important;`;
            }
        }
        if (decls) st.vars.push(`${rule.selectorText}{${decls}}`);
    }

    function onStyleRule(rule) {
        const sel = rule.selectorText;
        const a = rule.style.fontFamily && analyze(rule.style.fontFamily);

        if (a) {
            registerNames(a);
            if (overridable(a) && sel && sel[0] !== "*") st.sel[a.cat].add(sel);
        }
        if (sel && VAR_SCOPE.test(sel)) overrideCustomProps(rule);
    }

    function scanRule(rule, parent, depth) {
        if (isRule(rule, "CSSStyleRule")) onStyleRule(rule);               // first: style rules can have nested rules
        else if (isRule(rule, "CSSFontFaceRule")) st.faceRules.push({ rule, parent });
        else if (isRule(rule, "CSSImportRule")) { if (rule.styleSheet && depth < 4) scanSheet(rule.styleSheet, depth + 1); }
        else if (depth < 6 && rule.cssRules && !isRule(rule, "CSSKeyframesRule")) {    // @media, @supports, @layer...
            for (const child of rule.cssRules) scanRule(child, rule, depth + 1);
        }
    }

    // @return true when the sheet had rules we had not seen
    function scanSheet(sheet, depth = 0) {
        if (ours.has(sheet) || st.unreadable.has(sheet)) return false;

        let rules;
        try { rules = sheet.cssRules; }
        catch (e) {
            if (e && e.name === "SecurityError") st.unreadable.add(sheet);    // cross-origin; manual list and document.fonts cover it
            return false;
        }

        const start = st.processed.get(sheet) || 0;
        if (!rules || (st.processed.has(sheet) && rules.length === start)) return false;

        st.processed.set(sheet, rules.length);
        for (let i = start; i < rules.length; i++) scanRule(rules[i], sheet, depth);
        return true;
    }

    function scanDocument() {
        let changed = false;
        for (const sheet of [...document.styleSheets, ...document.adoptedStyleSheets]) changed = scanSheet(sheet) || changed;
        return changed;
    }

    const unquote = s => s.replace(/^\s*["']|["']\s*$/g, "");

    // Remove the page's own @font-face rules for families we override, so they cannot compete with ours
    function deleteFontFaces() {
        st.faceRules = st.faceRules.filter(({ rule, parent }) => {
            let family;
            try { family = norm(unquote(rule.style.getPropertyValue("font-family"))); } catch { return true; }

            if (!st.faces.has(family) && !cfg.preFaces.has(family)) return true;

            try {
                const idx = Array.prototype.indexOf.call(parent.cssRules, rule);
                const count = st.processed.get(parent);

                if (idx > -1) {
                    parent.deleteRule(idx);
                    if (count !== undefined && idx < count) st.processed.set(parent, count - 1);
                }
            }
            catch { /* cross-origin or read-only sheet */ }
            return false;
        });
    }

    // Faces the page declared, read from document.fonts: works for blocked stylesheets and for FontFace() made in JS
    function readPageFaces() {
        const fonts = document.fonts;
        if (!fonts || (fonts.size !== undefined && fonts.size === st.fontCount)) return false;

        st.fontCount = fonts.size;
        let changed = false;

        fonts.forEach(f => {
            const family = unquote(String(f.family));
            const lower = norm(family);
            const key = `${lower}|${f.weight}|${f.style}|${f.stretch}`;

            if (st.faceKeys.has(key)) return;           // also skips our own faces, which show up here too
            st.faceKeys.add(key);

            const desc = { family, lower, weight: f.weight, style: f.style, stretch: f.stretch };
            if (!F.isStandardFace(desc)) { st.pageFaces.set(key, desc); changed = true; }

            const cat = F.classifyName(lower, cfg.matchers);
            if (isCat(cat) && !cfg.chosenLower.has(lower) && !st.faces.has(lower) && !lateNames.has(lower)) {
                st.faces.set(lower, { name: family, cat });
                changed = true;
            }
        });
        return changed;
    }

    // ---------------------------------------------------------------------------------------------------------------
    // CSS generation
    // ---------------------------------------------------------------------------------------------------------------

    function faceCss(name, cat) {
        const key = `${name}|${cat}`;
        if (!st.faceCss.has(key)) st.faceCss.set(key, F.fontFaceCss(name, cat, cfg.fonts[cat].name, cfg.monoScale));
        return st.faceCss.get(key);
    }

    function buildBaseCss() {
        const out = [];

        for (const f of cfg.settings.manualFonts) {
            const k = norm(f.name);
            if (isCat(f.category) && !cfg.chosenLower.has(k) && !lateNames.has(k)) out.push(faceCss(f.name, f.category));
        }
        for (const name of cfg.seedNames) out.push(faceCss(name, "mono"));

        out.push(wrap(F.monoDefaultsCss(cfg)));

        // Editor detector: the hidden input of an editor runs a 1 ms no-op animation, which tells us it just appeared
        if (cfg.protectSel) {
            out.push("@keyframes rme-seen{from{outline-offset:0}to{outline-offset:0}}");
            out.push(`${F.EDITOR_PROXY}{animation:rme-seen .001s}`);
        }
        return out.join("\n");
    }

    function detectBodyCat() {
        if (st.bodyCat || !document.body) return;

        const a = analyze(getComputedStyle(document.body).fontFamily);
        if (a && isCat(a.cat)) st.bodyCat = a.cat;
    }

    function buildSiteCss() {
        const out = [];

        st.faces.forEach(f => out.push(faceCss(f.name, f.cat)));

        st.pageFaces.forEach(pf => {
            const known = st.faces.get(pf.lower);
            const cat = known ? known.cat : cfg.matchers.manual.get(pf.lower);
            const css = isCat(cat) && !cfg.chosenLower.has(pf.lower) && F.fontFaceExtraCss(pf.family, cat, cfg.fonts[cat].name, cfg.monoScale, pf);
            if (css) out.push(css);
        });

        for (const cat of CATS) {
            if (!st.sel[cat].size) continue;

            const selectors = [...st.sel[cat]].join(",");
            out.push(cat === "mono" ? wrap(F.monoRule(selectors, cfg)) : `${selectors}{font-family:${familyOf(cat)}!important}`);
        }

        out.push(...st.vars);

        detectBodyCat();
        if (st.bodyCat) out.push(`html,body{font-family:${familyOf(st.bodyCat)}!important}`);

        return out.join("\n");
    }

    function rebuild() {
        const css = buildSiteCss();

        if (css !== st.lastCss) {
            st.lastCss = css;
            siteSink.set(css);
        }
        attach();
    }

    // New families were found: regenerate the CSS and drop the page's competing rules
    function commit() {
        readPageFaces();
        rebuild();
        deleteFontFaces();
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Sampling computed styles: catches what the stylesheet walk cannot see (CORS-blocked CSS, var(--x), inline styles)
    // ---------------------------------------------------------------------------------------------------------------

    // Light DOM plus open shadow roots (custom-element sites such as developers.google.com)
    function collectElements(root, limit) {
        const out = [], stack = [root];

        while (stack.length && out.length < limit) {
            for (const el of stack.pop().querySelectorAll("*")) {
                if (out.length >= limit) break;
                out.push(el);
                if (el.shadowRoot) stack.push(el.shadowRoot);
            }
        }
        return out;
    }

    const inEditor = el => !!cfg.protectSel && el.closest(cfg.protectSel) !== null;

    // @return true when a new family was registered. Elements are de-duplicated by tag + class + inline style.
    function processElement(el, editor) {
        const key = `${el.nodeName}|${el.getAttribute("class") || ""}|${el.getAttribute("style") || ""}`;
        if (st.sampled.has(key)) return false;
        st.sampled.add(key);

        const a = analyze(getComputedStyle(el).fontFamily);
        if (!a) return false;

        const before = st.faces.size;
        registerNames(a, editor);
        return st.faces.size !== before;
    }

    // Tell the service worker which monospace fonts editors revealed, so the next load applies them from the first paint
    function flushLearn() {
        if (!learnQueue.size) return;

        const names = [...learnQueue];
        learnQueue.clear();

        try { Promise.resolve(chrome.runtime.sendMessage({ type: "rme:learn", names })).catch(() => {}); }
        catch { /* extension was reloaded: this script is orphaned */ }
    }

    // An editor appeared (its hidden input started the animation from the base sheet): look inside it right away
    function onEditorSeen(e) {
        if (e.animationName !== "rme-seen" || !cfg || !cfg.protectSel) return;

        let root = e.target;
        for (let i = 0; i < 2 && root.parentElement && root.parentElement !== document.body && root.parentElement !== document.documentElement; i++) {
            root = root.parentElement;
        }

        const els = [root, ...[...root.querySelectorAll("*")].slice(0, 400)];
        let added = false;

        for (const el of els) added = processElement(el, true) || added;

        flushLearn();
        if (added) commit();
    }

    let sampling = false, sampleAgain = false;

    function sample() {
        if (sampling) { sampleAgain = true; return; }
        if (!document.body) return;

        sampling = true;
        st.sampledOnce = true;

        const els = collectElements(document.body, SAMPLE_LIMIT);
        let i = 0, added = false;

        const chunk = () => {
            if (!cfg) { sampling = false; return; }

            for (const end = Math.min(i + CHUNK, els.length); i < end; i++) added = processElement(els[i], inEditor(els[i])) || added;
            if (i < els.length) { setTimeout(chunk, 0); return; }

            sampling = false;
            flushLearn();
            if (added) commit();
            if (sampleAgain) { sampleAgain = false; sample(); }
        };
        chunk();
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Scheduling
    // ---------------------------------------------------------------------------------------------------------------

    let timer = 0;

    function schedule(delay) {
        if (timer || !cfg) return;

        timer = setTimeout(() => { timer = 0; run(); }, delay);
    }

    function run() {
        if (!cfg) return;

        const changed = scanDocument() | readPageFaces();      // not ||: both must run

        if (changed || st.lastCss === null || !st.bodyCat) rebuild();
        if (changed) deleteFontFaces();
        if (changed || !st.sampledOnce) sample();
    }

    let listening = false;

    function listen() {
        if (listening) return;
        listening = true;

        const start = () => {
            schedule(0);
            setTimeout(() => schedule(0), 100);                 // some sites only settle after their first scripts ran

            if (document.head) {
                new MutationObserver(mutations => {
                    const styled = mutations.some(m => [...m.addedNodes].some(n => n.nodeName === "STYLE" || n.nodeName === "LINK"));
                    if (styled) schedule(150);
                }).observe(document.head, { childList: true });
            }
        };

        if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
        else start();

        document.addEventListener("animationstart", onEditorSeen, true);
        document.addEventListener("load", e => { if (e.target && e.target.nodeName === "LINK") schedule(50); }, true);   // its rules are readable now
        if (document.fonts) document.fonts.addEventListener("loadingdone", () => schedule(50));
        window.addEventListener("load", () => { schedule(50); setTimeout(() => schedule(0), 500); });
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Configuration
    // ---------------------------------------------------------------------------------------------------------------

    const validSelector = sel => {
        try { return !self.CSS || !CSS.supports || CSS.supports(`selector(${sel})`); } catch { return false; }
    };

    // Editors are found automatically (RME.editorBoundary); needs @scope and :has(), i.e. Chrome 118+
    function editorSelector(editors) {
        if (!editors.protect || matchesHosts(editors.offSites) || typeof CSSScopeRule === "undefined") return "";

        const sel = F.editorBoundary(editors.selectors.filter(validSelector));
        return validSelector(sel) ? sel : "";
    }

    function turnOff(reason) {
        cfg = null;
        offReason = reason;
        baseSink.set("");
        siteSink.set("");
        attach();
    }

    function configure(settings, bf) {
        st = freshState();

        if (!settings.enabled) return turnOff("disabled");
        if (matchesHosts(settings.excludedSites)) return turnOff("excluded");

        const { fonts, monoSize, monoScale } = F.resolveFonts(settings, bf);
        const chosenLower = new Set(CATS.map(c => norm(fonts[c].name)));
        const listed = new Set(settings.manualFonts.map(f => norm(f.name)));
        const seedNames = F.MONO_SEED.filter(n => !listed.has(norm(n)) && !chosenLower.has(norm(n)) && !lateNames.has(norm(n)));

        cfg = {
            settings, fonts, monoSize, monoScale, chosenLower, seedNames,
            matchers: F.buildMatchers(settings),
            protectSel: editorSelector(settings.editors),
            editorsOffSite: matchesHosts(settings.editors.offSites),
            // everything declared in the base sheet, i.e. in place before any page script runs
            preFaces: new Set([
                ...settings.manualFonts.filter(f => isCat(f.category) && !lateNames.has(norm(f.name))).map(f => norm(f.name)),
                ...seedNames.map(norm)
            ])
        };

        baseSink.set(buildBaseCss());
        attach();
        listen();

        if (document.readyState !== "loading") schedule(0);
    }

    const load = () => F.storage.load().then(({ settings, bf }) => configure(settings, bf)).catch(() => { /* orphaned */ });

    // ---------------------------------------------------------------------------------------------------------------
    // Report for the popup
    // ---------------------------------------------------------------------------------------------------------------

    function describe(el) {
        const classes = (typeof el.className === "string" ? el.className : "").trim().split(/\s+/).filter(Boolean).slice(0, 2);
        return (el.localName + (el.id ? `#${el.id}` : "") + classes.map(c => `.${c}`).join("")).slice(0, 60);
    }

    // Editors on the page, named by element. A hidden input only counts when its font is monospace, so ordinary
    // search boxes (which share the same attributes) are not listed.
    function findEditors() {
        const rootSel = [...F.EDITOR_ROOTS, ...cfg.settings.editors.selectors].join(",");
        const found = new Map();
        const add = el => {
            const name = describe(el);
            if (found.has(name)) found.get(name).count++; else found.set(name, { sample: name, count: 1 });
        };
        const isMono = el => { const a = el && analyze(getComputedStyle(el).fontFamily); return !!a && a.cat === "mono"; };

        try {
            document.querySelectorAll(rootSel).forEach(add);

            for (const input of [...document.querySelectorAll(F.EDITOR_PROXY)].slice(0, 50)) {
                if (!input.closest(rootSel) && (isMono(input) || isMono(input.parentElement))) add(input.parentElement || input);
            }
        }
        catch { /* invalid user selector */ }

        return [...found.values()].slice(0, 6);
    }

    // Font stacks on the page that could not be classified and have no generic fallback, most used first
    function findUnknownFonts() {
        const counts = new Map();

        for (const el of collectElements(document.body || document.documentElement, REPORT_LIMIT)) {
            const ff = getComputedStyle(el).fontFamily;
            counts.set(ff, (counts.get(ff) || 0) + 1);
        }

        const unknown = new Map();

        for (const [ff, count] of counts) {
            const a = analyze(ff);
            const key = a && a.unknown && norm(a.unknown);

            if (key && !cfg.matchers.manual.has(key)) unknown.set(key, { name: a.unknown, count: (unknown.has(key) ? unknown.get(key).count : 0) + count });
        }
        return [...unknown.values()].sort((a, b) => b.count - a.count).slice(0, 30);
    }

    function buildReport() {
        const report = { host: location.hostname, active: !!cfg, reason: offReason, unknown: [], deferred: [], editors: [], protect: false, siteOff: false };
        if (!cfg) return report;

        return Object.assign(report, {
            protect: !!cfg.protectSel,
            siteOff: cfg.settings.editors.protect && cfg.editorsOffSite,
            editors: findEditors(),
            deferred: [...lateNames.values()],
            unknown: findUnknownFonts()
        });
    }

    try {
        F.storage.onChange(load);       // apply live, no reload needed
        chrome.runtime.onMessage.addListener((msg, sender, reply) => {
            if (msg && msg.type === "rme:report" && window === window.top) reply(buildReport());
        });
    }
    catch { /* orphaned */ }

    load();
})();
