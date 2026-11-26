/*
 * Respect My Eyes - content script
 *
 * Forces the fonts configured in the browser (chrome://settings/fonts) onto every page without breaking icon fonts.
 *
 *   base sheet  (document_start)   monospace defaults and the editor fonts learned for this site: the only fonts that
 *                                  must be in place before the page's scripts run
 *   site sheet  (DOM ready, load,  built from what the page uses: stylesheets, computed styles, document.fonts.
 *                new stylesheets)  Names are overridden with @font-face local(), selectors with !important rules.
 *                                  A font from the user's list costs nothing until the page actually uses it.
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

    const VAR_SCOPE = /^(?::root|:host|html|body)\b|^:(?:where|is)\(\s*(?::root|:host|html|body)\b/i;
    const SAFE_VAR_PROP = /^--[a-zA-Z0-9_-]{1,120}$/;
    const CHUNK = 250;              // elements sampled per tick
    const SAMPLE_LIMIT = 6000;
    const REPORT_LIMIT = 8000;
    const LIMITS = {
        analysis: 2000, faces: 1000, pageFaces: 1000, faceRules: 1000, selPerCat: 1500, vars: 1000,
        sampled: 5000, learnPerPage: 24, lateEditors: 25, rulesPerScan: 15000, sheetsPerScan: 200,
        propsPerRule: 400, selectorTouchChecks: 250, selectorLen: 2000, valueLen: 2000
    };
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

    const ourFaces = new WeakSet();
    const checkedJsFaces = new WeakMap();

    const freshState = () => ({
        analysis: new Map(),        // font-family value -> analysis
        faceCss: new Map(),         // name|category -> generated @font-face rules
        processed: new WeakMap(),   // sheet -> number of rules already scanned
        unreadable: new WeakSet(),  // cross-origin sheets
        scannedRoots: new WeakSet(),// open shadow roots whose stylesheets were scanned
        seenFaces: new WeakSet(),   // FontFace instances already indexed in this run
        faces: new Map(),           // lower-case family -> { name, cat } to override
        pageFaces: new Map(),       // faces the page declared with non-standard descriptors
        jsFaces: new Map(),         // JS-added FontFace descriptors (unconnected to CSS rules)
        ourJs: new Map(),           // key -> FontFace[] we added to document.fonts (removed on turnOff/configure)
        faceKeys: new Set(),
        faceRules: [],              // page @font-face rules that may have to be removed
        sel: { sans: new Set(), serif: new Set(), mono: new Set() },
        vars: [],                   // custom property overrides
        sampled: new Set(),
        sampledOnce: false,
        needsResample: false,
        fontsDirty: false,
        syncJs: false,
        initialDone: false,
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
            const current = document.adoptedStyleSheets;
            const len = current.length;
            if (len >= 2 && current[len - 2] === baseSink.sheet && current[len - 1] === siteSink.sheet) return;

            const wanted = current.filter(s => !ours.has(s));
            wanted.push(baseSink.sheet, siteSink.sheet);
            document.adoptedStyleSheets = wanted;
        }
        catch {
            baseSink.sheet = siteSink.sheet = null;     // adoption not possible here, fall back to <style>
        }
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Analysis
    // ---------------------------------------------------------------------------------------------------------------

    function analyze(value) {
        if (!value || value.length > LIMITS.valueLen) return null;
        if (!st.analysis.has(value)) {
            const res = F.analyzeStack(value, cfg.matchers);
            if (st.analysis.size < LIMITS.analysis) st.analysis.set(value, res);
            return res;
        }
        return st.analysis.get(value);
    }

    // A pure "sans-serif" stack already follows the browser setting, so it is only forced for a custom font
    const overridable = a => !!a && isCat(a.cat) && !(a.pure && cfg.fonts[a.cat].source !== "custom");

    const familyOf = cat => F.familyValue(cat, cfg.fonts);

    /*
     * @param defer true for names found inside a self-measuring editor: a monospace font it was already using must not
     *              be swapped under it, unless it is in the base sheet (applied before any page script runs).
     * @return true when a face was added to st.faces
     */
    function registerFace(name, lower, cat, defer) {
        if (!isCat(cat) || F.isReservedFamily(lower) || cfg.chosenLower.has(lower) || st.faces.has(lower) || lateNames.has(lower)) return false;

        if (defer && cat === "mono" && !cfg.preFaces.has(lower)) {
            if (lateNames.size < LIMITS.learnPerPage) {
                lateNames.set(lower, name);
                learnQueue.add(name);
            }
            return false;
        }
        if (st.faces.size >= LIMITS.faces) return false;
        st.faces.set(lower, { name, cat });
        if (st.jsFaces.size) st.syncJs = true;
        return true;
    }

    function registerNames(a, defer) {
        let added = false;
        for (const n of a.names) added = registerFace(n.name, n.lower, n.cat, defer) || added;
        return added;
    }

    const hasMonoFont = a => a.cat === "mono" || a.names.some(n => n.cat === "mono");

    // True when a stack contains any mono family not yet resolved in chosenLower / faces / lateNames / preFaces
    const hasUnregisteredMono = a => a.names.some(n => n.cat === "mono" && !cfg.chosenLower.has(n.lower) && !st.faces.has(n.lower) && !lateNames.has(n.lower));

    // Our monospace rules must not reach into editors: they would resize and respace text the editor positions itself
    const wrap = css => cfg.protectSel ? `@scope (:root) to (${cfg.protectSel}){${css}}` : css;

    // ---------------------------------------------------------------------------------------------------------------
    // Stylesheet walking
    // ---------------------------------------------------------------------------------------------------------------

    function isRule(rule, ctor) {
        const C = self[ctor];
        return C ? rule instanceof C : rule.type === RULE_TYPES[ctor];
    }

    // Memoized per synchronous scan pass to avoid repeated expensive :has() queries across rules
    let editorPresentCache = null;
    function hasEditor() {
        if (lateNames.size > 0) return true;
        if (!cfg.protectSel) return false;
        if (editorPresentCache === null) editorPresentCache = !!document.querySelector(cfg.protectSel);
        return editorPresentCache;
    }

    function ruleTouchesEditor(sel) {
        if (!cfg.protectSel || !sel || sel === "*" || sel.length > LIMITS.selectorLen || VAR_SCOPE.test(sel)) return false;
        try {
            let checked = 0;
            for (const el of document.querySelectorAll(sel)) {
                if (inEditor(el)) return true;
                if (++checked >= LIMITS.selectorTouchChecks) break;
            }
        }
        catch { /* invalid selector in page stylesheet */ }
        return false;
    }

    const safeRuleSelector = sel => !!sel && sel.length <= LIMITS.selectorLen && !/[{};@\\]/.test(sel);

    // Custom properties holding a font stack (--font-body: ...) are overridden where they are defined
    function overrideCustomProps(rule) {
        const sel = rule.selectorText;
        if (!safeRuleSelector(sel) || st.vars.length >= LIMITS.vars) return;

        const { style } = rule;
        const propLimit = Math.min(style.length, LIMITS.propsPerRule);
        let decls = "";

        for (let i = 0; i < propLimit; i++) {
            const prop = style[i];
            if (!SAFE_VAR_PROP.test(prop)) continue;

            const value = style.getPropertyValue(prop).trim();
            if (!value || value.length > 500 || value.includes("(") || !F.looksLikeFontStack(value, prop)) continue;

            const a = analyze(value);
            if (overridable(a)) {
                const defer = st.initialDone && hasMonoFont(a) && hasEditor();
                registerNames(a, defer);
                if (!defer) decls += `${prop}:${familyOf(a.cat)}!important;`;
            }
        }
        if (decls && !/^:host\b|^:(?:where|is)\(\s*:host\b/i.test(sel)) st.vars.push(`${sel}{${decls}}`);
    }

    function onStyleRule(rule, parentSel) {
        let sel = rule.selectorText;
        if (sel && sel.includes("&") && parentSel && sel.length + parentSel.length < LIMITS.selectorLen) {
            sel = sel.replaceAll("&", `:is(${parentSel})`);
        }
        const ff = rule.style.fontFamily;
        const a = ff && analyze(ff);

        if (a) {
            const defer = hasUnregisteredMono(a) && hasEditor() && (st.initialDone || ruleTouchesEditor(sel));
            registerNames(a, defer);

            /*
             * A named stack is already replaced by its name, which keeps the page's own cascade intact. Mirroring its
             * selector would reorder that cascade and clobber descendants that set their own (icon) font, e.g.
             * ".mce-container *". So selectors are mirrored only where a name cannot be replaced: stacks made of
             * generic families (system-ui...), and monospace stacks, for the forced size.
             */
            if (overridable(a) && safeRuleSelector(sel) && sel[0] !== "*" && !sel.includes("&") && (a.cat === "mono" || !a.names.length || a.firstGeneric) && st.sel[a.cat].size < LIMITS.selPerCat) {
                const safe = F.dropSweeps(sel);
                if (safe) st.sel[a.cat].add(safe);
            }
        }
        if (sel && VAR_SCOPE.test(sel)) overrideCustomProps(rule);
        return sel;
    }

    function scanRule(rule, parent, depth, budget, parentSel = "") {
        if (budget.rules >= LIMITS.rulesPerScan) return;
        budget.rules++;

        if (isRule(rule, "CSSStyleRule")) {
            const resolvedSel = onStyleRule(rule, parentSel);
            let nested = null;
            if (depth < 6) { try { nested = rule.cssRules; } catch {} }
            if (nested && nested.length) {
                const nextParent = safeRuleSelector(resolvedSel) && !resolvedSel.includes("&") ? resolvedSel : "";
                for (const child of nested) {
                    if (budget.rules >= LIMITS.rulesPerScan) break;
                    scanRule(child, rule, depth + 1, budget, nextParent);
                }
            }
        }
        else if (isRule(rule, "CSSFontFaceRule")) { if (st.faceRules.length < LIMITS.faceRules) st.faceRules.push({ rule, parent }); }
        else if (isRule(rule, "CSSImportRule")) { if (rule.styleSheet && depth < 4) scanSheet(rule.styleSheet, depth + 1, budget); }
        else if (depth < 6 && !isRule(rule, "CSSKeyframesRule")) {    // @media, @supports, @layer...
            let nested = null;
            try { nested = rule.cssRules; } catch {}
            if (nested) {
                for (const child of nested) {
                    if (budget.rules >= LIMITS.rulesPerScan) break;
                    scanRule(child, rule, depth + 1, budget, parentSel);
                }
            }
        }
    }

    // @return true when the sheet had rules we had not seen
    function scanSheet(sheet, depth = 0, budget = { sheets: 0, rules: 0, seen: new WeakSet() }) {
        if (ours.has(sheet) || st.unreadable.has(sheet) || budget.seen.has(sheet)) return false;
        if (budget.sheets >= LIMITS.sheetsPerScan || budget.rules >= LIMITS.rulesPerScan) return false;
        budget.seen.add(sheet);
        budget.sheets++;

        let rules;
        try { rules = sheet.cssRules; }
        catch (e) {
            if (e && e.name === "SecurityError") st.unreadable.add(sheet);    // cross-origin; manual list and document.fonts cover it
            return false;
        }

        const start = st.processed.get(sheet) || 0;
        if (!rules || (st.processed.has(sheet) && rules.length === start)) return false;

        let i = start;
        for (; i < rules.length && budget.rules < LIMITS.rulesPerScan; i++) scanRule(rules[i], sheet, depth, budget);
        st.processed.set(sheet, i);
        return i > start;
    }

    function scanDocument() {
        let changed = false;
        const budget = { sheets: 0, rules: 0, seen: new WeakSet() };
        for (const list of [document.styleSheets, document.adoptedStyleSheets]) {
            for (const sheet of list) {
                if (budget.sheets >= LIMITS.sheetsPerScan || budget.rules >= LIMITS.rulesPerScan) return changed;
                if (scanSheet(sheet, 0, budget)) changed = true;
            }
        }
        return changed;
    }

    function scanShadowRoot(sr) {
        if (!sr || st.scannedRoots.has(sr)) return false;
        st.scannedRoots.add(sr);
        let changed = false;
        const budget = { sheets: 0, rules: 0, seen: new WeakSet() };
        for (const list of [sr.styleSheets, sr.adoptedStyleSheets]) {
            if (!list) continue;
            for (const sheet of list) {
                if (budget.sheets >= LIMITS.sheetsPerScan || budget.rules >= LIMITS.rulesPerScan) return changed;
                if (scanSheet(sheet, 0, budget)) changed = true;
            }
        }
        return changed;
    }

    const unquote = s => s.replace(/^\s*["']|["']\s*$/g, "");

    // Remove the page's own @font-face rules for families we override in O(R) reverse-index passes per parent sheet
    function deleteFontFaces() {
        const byParent = new Map();
        const kept = [];

        for (const entry of st.faceRules) {
            let family;
            try { family = norm(unquote(entry.rule.style.getPropertyValue("font-family"))); } catch { kept.push(entry); continue; }

            if (!st.faces.has(family) && !cfg.preFaces.has(family)) { kept.push(entry); continue; }
            let targets = byParent.get(entry.parent);
            if (!targets) { targets = new Set(); byParent.set(entry.parent, targets); }
            targets.add(entry.rule);
        }
        st.faceRules = kept;

        for (const [parent, targets] of byParent) {
            try {
                const rules = parent.cssRules;
                let count = st.processed.get(parent);
                for (let i = rules.length - 1; i >= 0; i--) {
                    if (!targets.has(rules[i])) continue;
                    parent.deleteRule(i);
                    if (count !== undefined && i < count) count--;
                }
                if (count !== undefined) st.processed.set(parent, count);
            }
            catch { /* cross-origin or read-only sheet */ }
        }
    }

    // CSS-backed FontFace objects return false on fonts.delete(f), while JS-added FontFace objects return true.
    // Re-adding f keeps site references intact and lets syncJsFaces() append our shadow FontFace after it.
    function isJsFontFace(f, fonts) {
        if (ourFaces.has(f)) return false;
        if (checkedJsFaces.has(f)) return checkedJsFaces.get(f);
        if (f.status === "loading" || typeof fonts.delete !== "function") return false;

        let isJs = false;
        try {
            isJs = fonts.delete(f);
            if (isJs && typeof fonts.add === "function") fonts.add(f);
        }
        catch { isJs = false; }
        checkedJsFaces.set(f, isJs);
        return isJs;
    }

    // Faces the page declared, read from document.fonts: works for blocked stylesheets and for FontFace() made in JS
    function readPageFaces() {
        const fonts = document.fonts;
        if (!fonts || (!st.fontsDirty && fonts.size !== undefined && fonts.size === st.fontCount)) return false;

        st.fontsDirty = false;
        st.fontCount = fonts.size;
        let changed = false, scanned = 0;

        const batch = [];
        fonts.forEach(f => {
            if (++scanned > LIMITS.pageFaces * 2 || ourFaces.has(f) || st.seenFaces.has(f)) return;
            if (f.status === "loading") return;             // wait for loadingdone before inspecting/probing
            st.seenFaces.add(f);
            batch.push(f);
        });

        for (const f of batch) {
            const family = unquote(String(f.family || "")).slice(0, 200);
            const lower = norm(family);
            if (!lower) continue;

            const weight = String(f.weight || "").slice(0, 40), style = String(f.style || "").slice(0, 40), stretch = String(f.stretch || "").slice(0, 40);
            const key = `${lower}|${weight}|${style}|${stretch}`;
            const isJs = isJsFontFace(f, fonts);
            const desc = { family, lower, weight, style, stretch };

            if (isJs && st.jsFaces.size < LIMITS.pageFaces && !st.jsFaces.has(key)) {
                st.jsFaces.set(key, desc);
                st.syncJs = true;
                changed = true;
            }
            if (!st.faceKeys.has(key) && st.faceKeys.size < LIMITS.pageFaces * 2) {
                st.faceKeys.add(key);
                if (!F.isStandardFace(desc) && st.pageFaces.size < LIMITS.pageFaces) { st.pageFaces.set(key, desc); changed = true; }
            }

            const cat = F.classifyName(lower, cfg.matchers);
            if (registerFace(family, lower, cat, st.initialDone && hasEditor())) changed = true;
            else if (!cat && !F.isReservedFamily(lower) && !cfg.chosenLower.has(lower) && !st.faces.has(lower) && !lateNames.has(lower)) st.needsResample = true;
        }
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

        for (const name of cfg.hintNames) out.push(faceCss(name, "mono"));

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
            out.push(wrap(cat === "mono" ? F.monoRule(selectors, cfg) : `${selectors}{font-family:${familyOf(cat)}!important}`));
        }

        out.push(...st.vars);

        detectBodyCat();
        if (st.bodyCat) out.push(`html,body{font-family:${familyOf(st.bodyCat)}!important}`);

        return out.join("\n");
    }

    function clearJsFaces() {
        if (!st || !st.ourJs.size || !document.fonts || typeof document.fonts.delete !== "function") return;
        st.ourJs.forEach(list => list.forEach(jf => { try { document.fonts.delete(jf); } catch {} }));
        st.ourJs.clear();
    }

    function trackOwnFaces(fn) {
        const fonts = document.fonts;
        if (!fonts || typeof fonts.forEach !== "function") { fn(); return; }
        const prev = new Set();
        fonts.forEach(f => prev.add(f));
        fn();
        if (fonts.size > prev.size) {
            fonts.forEach(f => { if (!prev.has(f)) ourFaces.add(f); });
            if (st.fontCount >= 0) st.fontCount = fonts.size;
        }
    }

    function syncJsFaces() {
        st.syncJs = false;
        const fonts = document.fonts;
        if (!st.jsFaces.size || typeof FontFace !== "function" || !fonts || typeof fonts.add !== "function") return;

        let added = false;
        st.jsFaces.forEach((pf, key) => {
            if (st.ourJs.has(key) || cfg.chosenLower.has(pf.lower) || lateNames.has(pf.lower)) return;
            const known = st.faces.get(pf.lower);
            const cat = known ? known.cat : cfg.matchers.manual.get(pf.lower);
            if (!isCat(cat)) return;

            const specs = F.jsFontFaceSpecs(pf.family, cat, cfg.fonts[cat].name, cfg.monoScale, pf);
            if (!specs.length) return;

            const created = [];
            for (const s of specs) {
                try {
                    const jf = new FontFace(s.family, s.source, s.descriptors);
                    ourFaces.add(jf);
                    fonts.add(jf);
                    created.push(jf);
                    added = true;
                }
                catch { /* invalid descriptor in mock/legacy env */ }
            }
            if (created.length) st.ourJs.set(key, created);
        });
        if (added) st.fontCount = fonts.size;
    }

    function rebuild() {
        const css = buildSiteCss();

        trackOwnFaces(() => {
            if (css !== st.lastCss) {
                st.lastCss = css;
                siteSink.set(css);
            }
            attach();
        });
        syncJsFaces();
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

    // Light DOM plus open shadow roots (custom-element sites such as developers.google.com).
    // Streams elements to `fn` via TreeWalker so traversal stops immediately at `limit` with zero array allocation.
    function walkElements(root, limit, fn) {
        const stack = [root];
        let visited = 0;

        while (stack.length && visited < limit) {
            const walker = document.createTreeWalker(stack.pop(), 1);
            let el;
            while (visited < limit && (el = walker.nextNode())) {
                visited++;
                if (el.shadowRoot) stack.push(el.shadowRoot);
                fn(el);
            }
        }
    }

    const inEditor = el => !!cfg.protectSel && el.closest(cfg.protectSel) !== null;

    // 53-bit FNV-1a element signature hash: eliminates per-element string concatenation and ~1.5 MB/tab of retained keys
    function hashMix(h, s) {
        const len = s.length;
        h ^= len;
        h = Math.imul(h, 0x01000193);
        const cap = len < 512 ? len : 512;
        for (let i = 0; i < cap; i++) {
            h ^= s.charCodeAt(i);
            h = Math.imul(h, 0x01000193);
        }
        return h;
    }

    function elemHash(el) {
        const tag = el.nodeName;
        const cls = typeof el.className === "string" ? el.className : (el.getAttribute("class") || "");
        const stl = el.getAttribute("style") || "";
        let h1 = 0x811c9dc5, h2 = 0x9e3779b9;
        h1 = hashMix(hashMix(hashMix(h1, tag), cls), stl);
        h2 = hashMix(hashMix(hashMix(h2, stl), cls), tag);
        return (h1 >>> 0) * 2097152 + (h2 >>> 11);
    }

    // @return true when a new family was registered. Elements are de-duplicated by tag + class + inline style hash.
    function processElement(el, editorState) {
        if (st.sampled.size >= LIMITS.sampled) return false;
        const key = elemHash(el);
        if (st.sampled.has(key)) return false;
        st.sampled.add(key);

        const editor = editorState === null ? inEditor(el) : editorState;
        const a = analyze(getComputedStyle(el).fontFamily);
        return !!a && registerNames(a, editor);
    }

    // Tell the service worker which monospace fonts editors revealed, so the next load applies them from the first paint
    function flushLearn() {
        if (!learnQueue.size) return;

        const names = [...learnQueue].slice(0, LIMITS.learnPerPage);
        learnQueue.clear();

        try { Promise.resolve(chrome.runtime.sendMessage({ type: "rme:learn", host: location.hostname, names })).catch(() => {}); }
        catch { /* extension was reloaded: this script is orphaned */ }
    }

    const seenEditors = new WeakSet();
    let lateEditorScans = 0;

    // An editor appeared (its hidden input started the animation from the base sheet): look inside it right away
    function onEditorSeen(e) {
        if (e.animationName !== "rme-seen" || !cfg || !cfg.protectSel) return;
        const target = e.target;
        if (!target || target.nodeType !== 1 || lateEditorScans >= LIMITS.lateEditors) return;
        // Ignore spoofed animationstart events dispatched on non-editor elements like document.body
        let validTarget = false;
        try { validTarget = target.matches(F.EDITOR_PROXY) || inEditor(target); } catch { validTarget = false; }
        if (!validTarget || seenEditors.has(target)) return;
        seenEditors.add(target);

        let root = target;
        for (let i = 0; i < 2 && root.parentElement && root.parentElement !== document.body && root.parentElement !== document.documentElement; i++) {
            root = root.parentElement;
        }
        if (seenEditors.has(root)) return;
        seenEditors.add(root);
        lateEditorScans++;

        let added = processElement(root, true);
        walkElements(root, 2000, el => {
            if (el.shadowRoot && scanShadowRoot(el.shadowRoot)) added = true;
            if (processElement(el, true)) added = true;
        });

        flushLearn();
        if (added) commit();
    }

    let sampling = false, sampleAgain = false;
    const nextIdle = typeof requestIdleCallback === "function"
        ? fn => requestIdleCallback(fn, { timeout: 250 })
        : fn => setTimeout(() => fn(null), 0);

    function sample() {
        if (sampling) { sampleAgain = true; return; }
        if (!document.body || st.sampled.size >= LIMITS.sampled) return;

        sampling = true;
        st.sampledOnce = true;

        const stack = [document.body];
        let walker = null, visited = 0, added = false;

        const chunk = deadline => {
            if (!cfg) { sampling = false; return; }

            editorPresentCache = null;
            const editorState = hasEditor() ? null : false;
            const idleMode = !!(deadline && !deadline.didTimeout);
            let step = 0;

            while (visited < SAMPLE_LIMIT && st.sampled.size < LIMITS.sampled && (idleMode ? (step === 0 || deadline.timeRemaining() > 3) : step < CHUNK)) {
                if (!walker) {
                    if (!stack.length) break;
                    walker = document.createTreeWalker(stack.pop(), 1);
                }
                const el = walker.nextNode();
                if (!el) { walker = null; continue; }

                visited++;
                step++;
                if (el.shadowRoot) {
                    stack.push(el.shadowRoot);
                    if (scanShadowRoot(el.shadowRoot)) added = true;
                }
                if (processElement(el, editorState)) added = true;
            }

            if (visited < SAMPLE_LIMIT && st.sampled.size < LIMITS.sampled && (walker || stack.length)) { nextIdle(chunk); return; }

            sampling = false;
            st.needsResample = false;
            flushLearn();
            if (added) commit();
            if (sampleAgain) { sampleAgain = false; sample(); }
        };
        chunk(null);
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Scheduling
    // ---------------------------------------------------------------------------------------------------------------

    let timer = 0, runWindowStart = 0, runWindowCount = 0;

    function schedule(delay) {
        if (timer || !cfg) return;

        const now = Date.now();
        if (now - runWindowStart > 2000) { runWindowStart = now; runWindowCount = 0; }
        if (runWindowCount >= 15) delay = Math.max(delay, 500);     // damp hostile mutation/event storms

        timer = setTimeout(() => { timer = 0; run(); }, delay);
    }

    function run() {
        if (!cfg) return;

        runWindowCount++;
        editorPresentCache = null;
        const changed = scanDocument() | readPageFaces();      // not ||: both must run
        editorPresentCache = null;

        flushLearn();
        if (cfg.settings.mono.textarea) syncTextareaMirrors();
        if (changed || st.lastCss === null || !st.bodyCat || st.syncJs) rebuild();
        if (changed && st.faceRules.length) deleteFontFaces();
        if (changed || !st.sampledOnce || st.needsResample) sample();
        st.initialDone = true;
    }

    const PRE_WS = /^(pre|break-spaces)/;

    function clearTextareaMirrors() {
        try { document.querySelectorAll("[data-rme-mirror]").forEach(el => el.removeAttribute("data-rme-mirror")); } catch {}
    }

    // Tag overlapping DOM overlay backdrops (e.g. highlight-within-textarea / custom caret mirrors) so mono.textarea
    // styles both the <textarea> and its mirror identically without ever touching icon elements.
    function syncTextareaMirrors(onlyTa) {
        if (!cfg || !cfg.settings.mono.textarea || !document.body) return;
        let list;
        if (onlyTa) list = [onlyTa];
        else {
            try { list = document.querySelectorAll("textarea"); } catch { return; }
        }
        const limit = Math.min(list.length, 20);
        for (let i = 0; i < limit; i++) {
            const ta = list[i];
            if (!ta || ta.nodeType !== 1 || inEditor(ta)) continue;
            let tr;
            try { tr = ta.getBoundingClientRect(); } catch { continue; }
            if (!tr || tr.width < 40 || tr.height < 16) continue;

            let scope = ta.parentElement;
            for (let depth = 0; depth < 2 && scope && scope !== document.body && scope !== document.documentElement; depth++, scope = scope.parentElement) {
                for (const child of scope.children) {
                    if (child === ta || child.contains(ta) || child.hasAttribute("data-rme-mirror")) continue;
                    if (child.nodeName === "BUTTON" || child.nodeName === "INPUT" || child.nodeName === "SELECT" || child.nodeName === "SVG") continue;
                    const explicitCaret = child.hasAttribute("animating-caret") || (child.hasAttribute("data-before") && child.hasAttribute("data-after"));
                    const hiddenOrPass = child.getAttribute("aria-hidden") === "true" || getComputedStyle(child).pointerEvents === "none";
                    if (!explicitCaret && !hiddenOrPass) continue;

                    let er;
                    try { er = child.getBoundingClientRect(); } catch { continue; }
                    if (Math.abs(er.left - tr.left) > 10 || Math.abs(er.top - tr.top) > 10 ||
                        Math.abs(er.width - tr.width) > 24 || Math.abs(er.height - tr.height) > 24) continue;
                    if (!explicitCaret) {
                        if (child.querySelector("svg,button,input,select")) continue;
                        if (!PRE_WS.test(getComputedStyle(child).whiteSpace)) continue;
                    }
                    child.setAttribute("data-rme-mirror", "");
                }
            }
        }
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
                    for (const m of mutations) {
                        for (const n of m.addedNodes) {
                            if (n.nodeName === "STYLE" || n.nodeName === "LINK") { schedule(150); return; }
                        }
                    }
                }).observe(document.head, { childList: true });
            }
        };

        if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
        else start();

        document.addEventListener("animationstart", onEditorSeen, true);
        document.addEventListener("focusin", e => {
            if (cfg && cfg.settings.mono.textarea && e.target && e.target.nodeName === "TEXTAREA") syncTextareaMirrors(e.target);
        }, true);
        document.addEventListener("load", e => { if (e.target && e.target.nodeName === "LINK") schedule(0); }, true);    // its rules are readable now
        if (document.fonts) document.fonts.addEventListener("loadingdone", () => { st.fontsDirty = true; schedule(50); });
        window.addEventListener("load", () => { schedule(50); setTimeout(() => schedule(0), 500); }, { once: true });
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Configuration
    // ---------------------------------------------------------------------------------------------------------------

    // Editors are found automatically (RME.editorBoundary); needs @scope and :has(), i.e. Chrome 118+
    function editorSelector(editors, textareaMono) {
        if (!editors.protect || matchesHosts(editors.offSites) || typeof CSSScopeRule === "undefined") return "";

        const sel = F.editorBoundary(editors.selectors.filter(F.validSelector), !textareaMono);
        return F.validSelector(sel) ? sel : "";
    }

    function turnOff(reason) {
        cfg = null;
        offReason = reason;
        clearJsFaces();
        clearTextareaMirrors();
        baseSink.set("");
        siteSink.set("");
        attach();
    }

    function configure(settings, bf, hints) {
        clearJsFaces();
        st = freshState();
        runWindowCount = 0;

        if (!settings.enabled) return turnOff("disabled");
        if (matchesHosts(settings.excludedSites)) return turnOff("excluded");
        if (!settings.mono.textarea) clearTextareaMirrors();

        const { fonts, monoSize, monoScale } = F.resolveFonts(settings, bf);
        const chosenLower = new Set(CATS.map(c => norm(fonts[c].name)));
        const hostHints = hints && Object.hasOwn(hints, location.hostname) ? hints[location.hostname] : null;
        const hintNames = F.cleanNameList(hostHints).filter(n => !chosenLower.has(norm(n)) && !lateNames.has(norm(n)));

        cfg = {
            settings, fonts, monoSize, monoScale, chosenLower, hintNames,
            matchers: F.buildMatchers(settings),
            protectSel: editorSelector(settings.editors, settings.mono.textarea),
            editorsOffSite: matchesHosts(settings.editors.offSites),
            // everything declared in the base sheet, i.e. in place before any page script runs
            preFaces: new Set(hintNames.map(norm))
        };

        trackOwnFaces(() => {
            baseSink.set(buildBaseCss());
            attach();
        });
        listen();

        if (document.readyState !== "loading") schedule(0);
    }

    const load = () => F.storage.load().then(({ settings, bf, hints }) => configure(settings, bf, hints)).catch(() => { /* orphaned */ });

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
        const rootSel = [...F.EDITOR_ROOTS, ...cfg.settings.editors.selectors.filter(F.validSelector)].join(",");
        const found = new Map();
        const add = el => {
            const name = describe(el);
            if (found.has(name)) found.get(name).count++; else found.set(name, { sample: name, count: 1 });
        };
        const isMono = el => { const a = el && analyze(getComputedStyle(el).fontFamily); return !!a && a.cat === "mono"; };

        try {
            document.querySelectorAll(rootSel).forEach(add);

            let checked = 0;
            for (const input of document.querySelectorAll(F.EDITOR_PROXY)) {
                if (!input.closest(rootSel) && (isMono(input) || isMono(input.parentElement))) add(input.parentElement || input);
                if (++checked >= 50) break;
            }
        }
        catch { /* invalid user selector */ }

        return [...found.values()].slice(0, 6);
    }

    // Font stacks on the page that could not be classified and have no generic fallback, most used first
    function findUnknownFonts() {
        const root = document.body || document.documentElement;
        if (!root) return [];

        const counts = new Map();

        walkElements(root, REPORT_LIMIT, el => {
            const ff = getComputedStyle(el).fontFamily;
            if (ff && ff.length <= LIMITS.valueLen) counts.set(ff, (counts.get(ff) || 0) + 1);
        });

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
        if (window === window.top) Promise.resolve(chrome.runtime.sendMessage({ type: "rme:pageStart" })).catch(() => {});
        F.storage.onChange(load);       // apply live, no reload needed
        chrome.runtime.onMessage.addListener((msg, sender, reply) => {
            if (msg && msg.type === "rme:report" && window === window.top) reply(buildReport());
        });
    }
    catch { /* orphaned */ }

    load();
})();
