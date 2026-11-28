/*
 * Respect My Eyes - content script
 *
 * Forces browser/custom fonts onto every page without breaking icon fonts or code editors:
 *   - baseSink (document_start): monospace defaults, learned editor hints, and editor detector animation
 *   - siteSink (DOM ready/load): on-demand @font-face local() rules, selector mirrors, and CSS variables
 *   - document.fonts shadows: unquoted local() FontFace shadows for programmatic JS FontFace() entries
 */
(() => {
    "use strict";

    const F = self.RME;
    if (!F || window.__rmeLoaded) return;
    window.__rmeLoaded = true;

    const { CATS, norm } = F;
    const isCat = cat => CATS.includes(cat);
    const unquote = s => s.replace(/^\s*["']|["']\s*$/g, "");

    const VAR_SCOPE = /^(?::root|:host|html|body)\b|^:(?:where|is)\(\s*(?::root|:host|html|body)\b/i;
    const SAFE_VAR_PROP = /^--[a-zA-Z0-9_-]{1,120}$/;
    const PRE_WS = /^(pre|break-spaces)/;
    const SKIP_TAGS = new Set([
        "svg", "path", "circle", "rect", "polygon", "line", "polyline", "ellipse", "g", "use", "defs",
        "clippath", "lineargradient", "radialgradient", "stop", "mask", "pattern", "symbol", "marker",
        "img", "picture", "source", "track", "video", "audio", "canvas", "br", "hr", "wbr",
        "script", "style", "link", "meta", "noscript", "template", "head", "title", "base"
    ]);
    const isStyleLink = n => n && n.nodeName === "LINK" && (!!n.sheet || /\bstylesheet\b/i.test(n.rel || ""));
    const { CSSStyleRule: CStyle, CSSFontFaceRule: CFace, CSSImportRule: CImport, CSSKeyframesRule: CKey } = self;

    const LIMITS = {
        chunk: 250, sampleDom: 6000, reportDom: 8000, analysis: 2000, faces: 1000, pageFaces: 1000,
        faceRules: 1000, selPerCat: 1500, vars: 1000, sampled: 5000, learnPerPage: 24, lateEditors: 25,
        rulesPerScan: 15000, sheetsPerScan: 200, propsPerRule: 400, touchChecks: 250, selectorLen: 2000, valueLen: 2000
    };

    const HOSTS = (() => {
        const top = location.ancestorOrigins && location.ancestorOrigins.length
            ? [location.ancestorOrigins[location.ancestorOrigins.length - 1]] : [];
        return [location.hostname, ...top.map(o => { try { return new URL(o).hostname; } catch { return ""; } })];
    })();
    const matchesHosts = list => HOSTS.some(h => F.isExcluded(h, list));

    // Page-lifetime state (survives live settings reloads)
    const page = {
        lateNames: new Map(),           // mono fonts revealed by running editors: left untouched until reload
        learnQueue: new Set(),
        ourFaces: new WeakSet(),        // FontFaces belonging to baseSink, siteSink, or syncJsFaces
        checkedJs: new WeakMap(),       // memoized CSS-backed (false) vs JS-added (true) probe result
        seenEditors: new WeakSet(),
        lateEditorScans: 0,
        listening: false
    };

    let cfg = null;                     // null while globally off or site excluded
    let offReason = "disabled";
    let st = null;

    const freshState = () => ({
        analysis: new Map(),
        faceCss: new Map(),
        processed: new WeakMap(),
        unreadable: new WeakSet(),
        scannedRoots: new WeakSet(),
        seenFaces: new WeakSet(),
        faces: new Map(),               // lower -> { name, cat }
        pageFaces: new Map(),           // non-standard descriptors read from document.fonts
        jsFaces: new Map(),             // programmatic JS FontFaces (key -> descriptor)
        ourJs: new Map(),               // key -> FontFace[] injected into document.fonts
        faceKeys: new Set(),
        faceRules: [],                  // page @font-face rules queued for deletion
        sel: { sans: new Set(), serif: new Set(), mono: new Set() },
        vars: [],
        varSels: new Set(),
        varSelsOverflow: false,
        sampled: new Set(),
        hasUnreadable: false,
        sampledOnce: false,
        needsResample: false,
        fontsDirty: false,
        syncJs: false,
        initialDone: false,
        sampling: false,
        sampleAgain: false,
        timer: 0,
        winStart: 0,
        winCount: 0,
        fontCount: -1,
        bodyCat: null,
        lastCss: null,
        lastReport: null,
        lastReportAt: 0
    });

    // -----------------------------------------------------------------------------------------------------------------
    // Stylesheet sinks (constructed stylesheets with <style> fallback) & own-face tracking
    // -----------------------------------------------------------------------------------------------------------------

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
    const ourSheets = new Set([baseSink.sheet, siteSink.sheet]);

    function attach() {
        if (!baseSink.sheet || !siteSink.sheet) return;
        try {
            const cur = document.adoptedStyleSheets, len = cur.length;
            if (len >= 2 && cur[len - 2] === baseSink.sheet && cur[len - 1] === siteSink.sheet) return;
            document.adoptedStyleSheets = [...cur.filter(s => !ourSheets.has(s)), baseSink.sheet, siteSink.sheet];
        }
        catch { baseSink.sheet = siteSink.sheet = null; }
    }

    // Constructed CSSStyleSheet updates populate document.fonts synchronously; tag them so readPageFaces() skips them
    function trackOwnFaces(fn) {
        const fonts = document.fonts;
        if (!fonts || typeof fonts.forEach !== "function") { fn(); return; }
        const prev = new Set();
        fonts.forEach(f => prev.add(f));
        fn();
        if (fonts.size > prev.size) {
            fonts.forEach(f => { if (!prev.has(f)) page.ourFaces.add(f); });
            if (st && st.fontCount >= 0) st.fontCount = fonts.size;
        }
    }

    // -----------------------------------------------------------------------------------------------------------------
    // Font analysis & registration
    // -----------------------------------------------------------------------------------------------------------------

    function analyze(value) {
        if (!value || value.length > LIMITS.valueLen) return null;
        if (!st.analysis.has(value)) {
            const res = F.analyzeStack(value, cfg.matchers);
            if (st.analysis.size < LIMITS.analysis) st.analysis.set(value, res);
            return res;
        }
        return st.analysis.get(value);
    }

    const overridable = a => !!a && isCat(a.cat) && !(a.pure && cfg.fonts[a.cat].source !== "custom");
    const familyOf = cat => F.familyValue(cat, cfg.fonts);
    const wrap = css => cfg.protectSel ? `@scope (:root) to (${cfg.protectSel}){${css}}` : css;
    const inEditor = el => !!cfg.protectSel && el.closest(cfg.protectSel) !== null;
    const safeSelector = sel => !!sel && sel.length <= LIMITS.selectorLen && !/[{};@\\]/.test(sel);

    let editorPresentCache = null;
    function hasEditor() {
        if (page.lateNames.size > 0) return true;
        if (!cfg || !cfg.settings.editors.protect || !cfg.editorRootSel) return false;
        if (editorPresentCache === null) editorPresentCache = !!document.querySelector(cfg.editorRootSel);
        return editorPresentCache;
    }

    function ruleTouchesEditor(sel) {
        if (!cfg.protectSel || !sel || sel === "*" || sel.length > LIMITS.selectorLen || VAR_SCOPE.test(sel)) return false;
        try {
            let n = 0;
            for (const el of document.querySelectorAll(sel)) {
                if (inEditor(el)) return true;
                if (++n >= LIMITS.touchChecks) break;
            }
        }
        catch {}
        return false;
    }

    function registerFace(name, lower, cat, defer) {
        if (!isCat(cat) || F.isReservedFamily(lower) || cfg.chosenLower.has(lower) || st.faces.has(lower) || page.lateNames.has(lower)) return false;
        if (defer && cat === "mono" && !cfg.preFaces.has(lower)) {
            if (page.lateNames.size < LIMITS.learnPerPage) {
                page.lateNames.set(lower, name);
                page.learnQueue.add(name);
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
    const hasUnregisteredMono = a => a.names.some(n => n.cat === "mono" && !cfg.chosenLower.has(n.lower) && !st.faces.has(n.lower) && !page.lateNames.has(n.lower));

    // -----------------------------------------------------------------------------------------------------------------
    // CSSOM & open shadow DOM scanning
    // -----------------------------------------------------------------------------------------------------------------

    const isRule = (rule, ctor, id) => ctor ? rule instanceof ctor : rule.type === id;

    function overrideCustomProps(style, sel) {
        if (!style.length || !safeSelector(sel) || st.vars.length >= LIMITS.vars) return;

        const limit = Math.min(style.length, LIMITS.propsPerRule);
        let decls = "";

        for (let i = 0; i < limit; i++) {
            const prop = style[i];
            if (!prop.startsWith("--") || !SAFE_VAR_PROP.test(prop)) continue;
            const value = style.getPropertyValue(prop).trim();
            if (!value || value.length > 500 || value.includes("(") || !F.looksLikeFontStack(value, prop)) continue;

            const a = analyze(value);
            if (!overridable(a)) continue;
            const defer = st.initialDone && hasMonoFont(a) && hasEditor();
            registerNames(a, defer);
            if (!defer) decls += `${prop}:${familyOf(a.cat)}!important;`;
        }
        if (decls && !/^:host\b|^:(?:where|is)\(\s*:host\b/i.test(sel)) st.vars.push(`${sel}{${decls}}`);
    }

    function addVarSel(sel) {
        if (!safeSelector(sel)) return;
        if (st.varSels.size < 200) st.varSels.add(sel);
        else st.varSelsOverflow = true;
    }

    function onStyleRule(rule, parentSel) {
        let sel = rule.selectorText;
        if (sel && sel.includes("&") && parentSel && sel.length + parentSel.length < LIMITS.selectorLen) {
            sel = sel.replaceAll("&", `:is(${parentSel})`);
        }
        const style = rule.style;
        const ff = style.fontFamily;
        if (ff) {
            if (ff.includes("var(")) addVarSel(sel);
            const a = analyze(ff);
            if (a) {
                const defer = hasUnregisteredMono(a) && hasEditor() && (st.initialDone || ruleTouchesEditor(sel));
                registerNames(a, defer);

                const mirror = overridable(a) && safeSelector(sel) && sel[0] !== "*" && !sel.includes("&") &&
                    (a.cat === "mono" || !a.names.length || a.firstGeneric) && st.sel[a.cat].size < LIMITS.selPerCat;
                if (mirror) {
                    const safe = F.dropSweeps(sel);
                    if (safe) st.sel[a.cat].add(safe);
                }
            }
        }
        else if (style.font && style.font.includes("var(")) addVarSel(sel);

        if (sel && VAR_SCOPE.test(sel)) overrideCustomProps(style, sel);
        return sel;
    }

    function scanRule(rule, parent, depth, budget, parentSel = "") {
        if (budget.rules >= LIMITS.rulesPerScan) return;
        budget.rules++;

        if (isRule(rule, CStyle, 1)) {
            const resolved = onStyleRule(rule, parentSel);
            let nested = null;
            if (depth < 6) { try { nested = rule.cssRules; } catch {} }
            if (nested && nested.length) {
                const nextParent = safeSelector(resolved) && !resolved.includes("&") ? resolved : "";
                for (const child of nested) {
                    if (budget.rules >= LIMITS.rulesPerScan) break;
                    scanRule(child, rule, depth + 1, budget, nextParent);
                }
            }
        }
        else if (isRule(rule, CFace, 5)) {
            if (st.faceRules.length < LIMITS.faceRules) st.faceRules.push({ rule, parent });
        }
        else if (isRule(rule, CImport, 3)) {
            if (rule.styleSheet && depth < 4) scanSheet(rule.styleSheet, depth + 1, budget);
        }
        else if (depth < 6 && !isRule(rule, CKey, 7)) {
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

    function scanSheet(sheet, depth, budget) {
        if (ourSheets.has(sheet) || st.unreadable.has(sheet) || budget.seen.has(sheet)) return false;
        if (budget.sheets >= LIMITS.sheetsPerScan || budget.rules >= LIMITS.rulesPerScan) return false;
        budget.seen.add(sheet);
        budget.sheets++;

        let rules;
        try { rules = sheet.cssRules; }
        catch (e) { if (e && e.name === "SecurityError") { st.unreadable.add(sheet); st.hasUnreadable = true; } return false; }

        const start = st.processed.get(sheet) || 0;
        if (!rules || (st.processed.has(sheet) && rules.length === start)) return false;

        let i = start;
        for (; i < rules.length && budget.rules < LIMITS.rulesPerScan; i++) scanRule(rules[i], sheet, depth, budget);
        st.processed.set(sheet, i);
        return i > start;
    }

    function scanLists(root) {
        let changed = false;
        const budget = { sheets: 0, rules: 0, seen: new WeakSet() };
        for (const list of [root.styleSheets, root.adoptedStyleSheets]) {
            if (!list) continue;
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
        return scanLists(sr);
    }

    function deleteFontFaces() {
        const byParent = new Map(), kept = [];
        for (const entry of st.faceRules) {
            let family;
            try { family = norm(unquote(entry.rule.style.getPropertyValue("font-family"))); } catch { kept.push(entry); continue; }
            if (!st.faces.has(family) && !cfg.preFaces.has(family)) { kept.push(entry); continue; }
            let targets = byParent.get(entry.parent);
            if (!targets) byParent.set(entry.parent, (targets = new Set()));
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
            catch {}
        }
        if (byParent.size && document.fonts && st && st.fontCount >= 0) st.fontCount = document.fonts.size;
    }

    // -----------------------------------------------------------------------------------------------------------------
    // Programmatic document.fonts inspection & shadowing
    // -----------------------------------------------------------------------------------------------------------------

    // CSS-backed FontFaces return false on fonts.delete(f); JS-added ones return true and are immediately re-added.
    function isJsFontFace(f, fonts) {
        if (page.ourFaces.has(f)) return false;
        if (page.checkedJs.has(f)) return page.checkedJs.get(f);
        if (f.status === "loading" || typeof fonts.delete !== "function") return false;

        let isJs = false;
        try {
            isJs = fonts.delete(f);
            if (isJs && typeof fonts.add === "function") fonts.add(f);
        }
        catch { isJs = false; }
        page.checkedJs.set(f, isJs);
        return isJs;
    }

    function readPageFaces() {
        const fonts = document.fonts;
        if (!fonts || (!st.fontsDirty && fonts.size !== undefined && fonts.size === st.fontCount)) return false;

        st.fontsDirty = false;
        st.fontCount = fonts.size;
        const batch = [];
        let changed = false, scanned = 0;

        fonts.forEach(f => {
            if (++scanned > LIMITS.pageFaces * 2 || page.ourFaces.has(f) || st.seenFaces.has(f) || f.status === "loading") return;
            st.seenFaces.add(f);
            batch.push(f);
        });

        for (const f of batch) {
            const family = unquote(String(f.family || "")).slice(0, 200);
            const lower = norm(family);
            if (!lower) continue;

            const weight = String(f.weight || "").slice(0, 40), style = String(f.style || "").slice(0, 40), stretch = String(f.stretch || "").slice(0, 40);
            const key = `${lower}|${weight}|${style}|${stretch}`;
            const desc = { family, lower, weight, style, stretch };

            if (isJsFontFace(f, fonts)) {
                const shadows = st.ourJs.get(key);
                if (shadows) {
                    for (const jf of shadows) {
                        try { fonts.delete(jf); if (typeof fonts.add === "function") fonts.add(jf); } catch {}
                    }
                }
                else if (st.jsFaces.size < LIMITS.pageFaces && !st.jsFaces.has(key)) {
                    st.jsFaces.set(key, desc);
                    st.syncJs = true;
                    changed = true;
                }
            }
            if (!st.faceKeys.has(key) && st.faceKeys.size < LIMITS.pageFaces * 2) {
                st.faceKeys.add(key);
                if (!F.isStandardFace(desc) && st.pageFaces.size < LIMITS.pageFaces) {
                    st.pageFaces.set(key, desc);
                    changed = true;
                }
            }

            if (!cfg.chosenLower.has(lower) && !st.faces.has(lower) && !page.lateNames.has(lower) && !F.isReservedFamily(lower)) {
                const cat = F.classifyName(lower, cfg.matchers);
                if (registerFace(family, lower, cat, st.initialDone && hasEditor())) changed = true;
                else if (!cat) st.needsResample = true;
            }
        }
        return changed;
    }

    function clearJsFaces() {
        if (!st || !st.ourJs.size || !document.fonts || typeof document.fonts.delete !== "function") return;
        st.ourJs.forEach(list => list.forEach(jf => { try { document.fonts.delete(jf); } catch {} }));
        st.ourJs.clear();
    }

    function syncJsFaces() {
        st.syncJs = false;
        const fonts = document.fonts;
        if (!st.jsFaces.size || typeof FontFace !== "function" || !fonts || typeof fonts.add !== "function") return;

        let added = false;
        st.jsFaces.forEach((pf, key) => {
            if (st.ourJs.has(key) || cfg.chosenLower.has(pf.lower) || page.lateNames.has(pf.lower)) return;
            const known = st.faces.get(pf.lower);
            const cat = known ? known.cat : cfg.matchers.manual.get(pf.lower);
            if (!isCat(cat)) return;

            const created = [];
            for (const s of F.jsFontFaceSpecs(pf.family, cat, cfg.fonts[cat].name, cfg.monoScale, pf)) {
                try {
                    const jf = new FontFace(s.family, s.source, s.descriptors);
                    page.ourFaces.add(jf);
                    fonts.add(jf);
                    created.push(jf);
                    added = true;
                }
                catch {}
            }
            if (created.length) st.ourJs.set(key, created);
        });
        if (added) st.fontCount = fonts.size;
    }

    // -----------------------------------------------------------------------------------------------------------------
    // CSS generation
    // -----------------------------------------------------------------------------------------------------------------

    function faceCss(name, cat) {
        const key = `${name}|${cat}`;
        if (!st.faceCss.has(key)) st.faceCss.set(key, F.fontFaceCss(name, cat, cfg.fonts[cat].name, cfg.monoScale));
        return st.faceCss.get(key);
    }

    function buildBaseCss() {
        const out = [...cfg.hintNames.map(n => faceCss(n, "mono")), wrap(F.monoDefaultsCss(cfg))];
        if (cfg.protectSel) {
            out.push("@keyframes rme-seen{from{outline-offset:0}to{outline-offset:0}}");
            out.push(`${F.EDITOR_PROXY}{animation:rme-seen .001s}`);
        }
        return out.join("\n");
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

        if (!st.bodyCat && document.body) {
            const a = analyze(getComputedStyle(document.body).fontFamily);
            if (a && isCat(a.cat)) st.bodyCat = a.cat;
        }
        if (st.bodyCat) out.push(`html,body{font-family:${familyOf(st.bodyCat)}!important}`);
        return out.join("\n");
    }

    function rebuild() {
        const css = buildSiteCss();
        if (css !== st.lastCss) {
            st.lastCss = css;
            if (st.faces.size || st.pageFaces.size) trackOwnFaces(() => { siteSink.set(css); attach(); });
            else { siteSink.set(css); attach(); }
        }
        else attach();
        syncJsFaces();
    }

    function commit() {
        readPageFaces();
        rebuild();
        deleteFontFaces();
    }

    // -----------------------------------------------------------------------------------------------------------------
    // DOM sampling, editor learning & textarea mirror syncing
    // -----------------------------------------------------------------------------------------------------------------

    function nextElement(cursor) {
        while (cursor.walker || cursor.stack.length) {
            if (!cursor.walker) cursor.walker = document.createTreeWalker(cursor.stack.pop(), 1);
            const el = cursor.walker.nextNode();
            if (el) {
                if (el.shadowRoot) cursor.stack.push(el.shadowRoot);
                return el;
            }
            cursor.walker = null;
        }
        return null;
    }

    function walkElements(root, limit, fn) {
        const cursor = { stack: [root], walker: null };
        for (let n = 0, el; n < limit && (el = nextElement(cursor)); n++) fn(el);
    }

    function hashMix(h, s) {
        const cap = s.length < 512 ? s.length : 512;
        h = Math.imul(h ^ s.length, 0x01000193);
        for (let i = 0; i < cap; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
        return h;
    }

    function elemHash(el, extra = "") {
        const tag = el.nodeName;
        const cls = typeof el.className === "string" ? el.className : (el.getAttribute("class") || "");
        const stl = el.getAttribute("style") || "";
        let h1 = hashMix(hashMix(hashMix(0x811c9dc5, tag), cls), stl);
        let h2 = hashMix(hashMix(hashMix(0x9e3779b9, stl), cls), tag);
        if (extra) { h1 = hashMix(h1, extra); h2 = hashMix(h2, extra); }
        return (h1 >>> 0) * 2097152 + (h2 >>> 11);
    }

    function registerComputed(ff, el, editorState) {
        const a = ff && analyze(ff);
        if (!a) return false;
        const defer = editorState === null ? (hasUnregisteredMono(a) && inEditor(el)) : editorState;
        return registerNames(a, defer);
    }

    function processElement(el, editorState, forceComputed = false) {
        if (st.sampled.size >= LIMITS.sampled || SKIP_TAGS.has(el.localName)) return false;
        const key = elemHash(el);
        if (st.sampled.has(key)) return false;
        st.sampled.add(key);

        if (!forceComputed) {
            const stInline = el.style;
            const iff = stInline && stInline.fontFamily;
            if (iff && !iff.includes("var(")) return registerComputed(iff, el, editorState);
            if (!(stInline && stInline.font)) return false;
        }
        return registerComputed(getComputedStyle(el).fontFamily, el, editorState);
    }

    function flushLearn() {
        if (!page.learnQueue.size) return;
        const names = [...page.learnQueue].slice(0, LIMITS.learnPerPage);
        page.learnQueue.clear();
        try { Promise.resolve(chrome.runtime.sendMessage({ type: "rme:learn", host: location.hostname, names })).catch(() => {}); }
        catch {}
    }

    function onEditorSeen(e) {
        if (e.animationName !== "rme-seen" || !cfg || !cfg.protectSel) return;
        const target = e.target;
        if (!target || target.nodeType !== 1 || page.lateEditorScans >= LIMITS.lateEditors) return;

        let valid = false;
        try { valid = target.matches(F.EDITOR_PROXY) || inEditor(target); } catch {}
        if (!valid || page.seenEditors.has(target)) return;
        page.seenEditors.add(target);

        let root = target;
        for (let i = 0; i < 2 && root.parentElement && root.parentElement !== document.body && root.parentElement !== document.documentElement; i++) {
            root = root.parentElement;
        }
        if (page.seenEditors.has(root)) return;
        page.seenEditors.add(root);
        page.lateEditorScans++;

        let added = false;
        walkElements(root, 2000, el => {
            if (el.shadowRoot && scanShadowRoot(el.shadowRoot)) added = true;
            if (processElement(el, true, true)) added = true;
        });
        flushLearn();
        if (added) commit();
    }

    const nextIdle = typeof requestIdleCallback === "function"
        ? fn => requestIdleCallback(fn, { timeout: 250 })
        : fn => setTimeout(() => fn(null), 0);

    function sampleVarSelectors(editorState) {
        if (!st.varSels.size) return false;
        let added = false;
        for (const sel of st.varSels) {
            try {
                let n = 0;
                for (const el of document.querySelectorAll(sel)) {
                    if (processElement(el, editorState, true)) added = true;
                    if (++n >= 16 || st.sampled.size >= LIMITS.sampled) break;
                }
            }
            catch {}
            if (st.sampled.size >= LIMITS.sampled) break;
        }
        return added;
    }

    function sample() {
        if (!st) return;
        if (st.sampling) { st.sampleAgain = true; return; }
        if (!document.body || st.sampled.size >= LIMITS.sampled) return;

        st.sampling = true;
        st.sampledOnce = true;

        const cursor = { stack: [document.body], walker: null };
        let visited = 0, added = false, varsDone = false;

        const chunk = deadline => {
            if (!cfg) return;
            editorPresentCache = null;
            const editorState = hasEditor() ? null : false;
            if (!varsDone && !st.hasUnreadable && !st.needsResample) {
                varsDone = true;
                if (sampleVarSelectors(editorState)) added = true;
            }
            const full = st.hasUnreadable || st.varSelsOverflow;
            const idle = !!(deadline && !deadline.didTimeout);
            let step = 0, el = null;

            while (visited < LIMITS.sampleDom && st.sampled.size < LIMITS.sampled &&
                (idle ? (step === 0 || deadline.timeRemaining() > 3) : step < LIMITS.chunk) &&
                (el = nextElement(cursor))) {
                visited++;
                step++;
                if (el.shadowRoot && scanShadowRoot(el.shadowRoot)) added = true;
                const inlineFont = !full && el.hasAttribute("style") && el.style && (el.style.fontFamily || el.style.font);
                if ((full || inlineFont) && processElement(el, editorState, full)) added = true;
            }

            if (el && visited < LIMITS.sampleDom && st.sampled.size < LIMITS.sampled) { nextIdle(chunk); return; }

            st.sampling = false;
            st.needsResample = false;
            flushLearn();
            if (added) commit();
            if (st.sampleAgain) { st.sampleAgain = false; sample(); }
        };
        nextIdle(chunk);
    }

    const clearTextareaMirrors = () => {
        try { document.querySelectorAll("[data-rme-mirror]").forEach(el => el.removeAttribute("data-rme-mirror")); } catch {}
    };

    function isMirrorOverlay(el, ta, tr) {
        if (el === ta || el.contains(ta) || el.hasAttribute("data-rme-mirror")) return false;
        if (/^(BUTTON|INPUT|SELECT|SVG)$/.test(el.nodeName)) return false;

        const explicit = el.hasAttribute("animating-caret") || (el.hasAttribute("data-before") && el.hasAttribute("data-after"));
        const passThrough = el.getAttribute("aria-hidden") === "true" || getComputedStyle(el).pointerEvents === "none";
        if (!explicit && !passThrough) return false;

        let er;
        try { er = el.getBoundingClientRect(); } catch { return false; }
        if (Math.abs(er.left - tr.left) > 10 || Math.abs(er.top - tr.top) > 10 ||
            Math.abs(er.width - tr.width) > 24 || Math.abs(er.height - tr.height) > 24) return false;

        return explicit || (!el.querySelector("svg,button,input,select") && PRE_WS.test(getComputedStyle(el).whiteSpace));
    }

    function syncTextareaMirrors(onlyTa) {
        if (!cfg || !cfg.settings.mono.textarea || !document.body) return;
        let list;
        if (onlyTa) list = [onlyTa];
        else { try { list = document.querySelectorAll("textarea"); } catch { return; } }

        for (let i = 0; i < Math.min(list.length, 20); i++) {
            const ta = list[i];
            if (!ta || ta.nodeType !== 1 || inEditor(ta)) continue;
            let tr;
            try { tr = ta.getBoundingClientRect(); } catch { continue; }
            if (!tr || tr.width < 40 || tr.height < 16) continue;

            let scope = ta.parentElement;
            for (let depth = 0; depth < 2 && scope && scope !== document.body && scope !== document.documentElement; depth++, scope = scope.parentElement) {
                for (const child of scope.children) {
                    if (isMirrorOverlay(child, ta, tr)) child.setAttribute("data-rme-mirror", "");
                }
            }
        }
    }

    // -----------------------------------------------------------------------------------------------------------------
    // Scheduling, lifecycle & popup report
    // -----------------------------------------------------------------------------------------------------------------

    function schedule(delay) {
        if (!cfg || st.timer) return;
        const now = Date.now();
        if (now - st.winStart > 2000) { st.winStart = now; st.winCount = 0; }
        if (st.winCount >= 15) delay = Math.max(delay, 500);
        st.timer = setTimeout(() => { st.timer = 0; run(); }, delay);
    }

    function run() {
        if (!cfg) return;
        st.winCount++;
        editorPresentCache = null;
        const changed = scanLists(document) | readPageFaces();
        editorPresentCache = null;

        flushLearn();
        if (cfg.settings.mono.textarea) syncTextareaMirrors();
        if (changed || st.lastCss === null || !st.bodyCat || st.syncJs) rebuild();
        if (changed && st.faceRules.length) deleteFontFaces();
        if (changed || !st.sampledOnce || st.needsResample) sample();
        st.initialDone = true;
    }

    function listen() {
        if (page.listening) return;
        page.listening = true;

        const start = () => {
            schedule(0);
            setTimeout(() => { if (cfg && st && !st.initialDone) schedule(0); }, 100);
            if (document.head) {
                new MutationObserver(muts => {
                    for (const m of muts) {
                        for (const n of m.addedNodes) {
                            if (n.nodeName === "STYLE" || isStyleLink(n)) { schedule(150); return; }
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
        document.addEventListener("load", e => { if (isStyleLink(e.target)) schedule(16); }, true);
        if (document.fonts) document.fonts.addEventListener("loadingdone", () => { if (st) { st.fontsDirty = true; schedule(50); } });
        window.addEventListener("load", () => { schedule(50); setTimeout(() => schedule(0), 500); }, { once: true });
    }

    function editorSelector(editors, textareaMono) {
        if (!editors.protect || matchesHosts(editors.offSites) || typeof CSSScopeRule === "undefined") return "";
        const sel = F.editorBoundary(editors.selectors.filter(F.validSelector), !textareaMono);
        return F.validSelector(sel) ? sel : "";
    }

    function turnOff(reason) {
        cfg = null;
        offReason = reason;
        if (st) {
            if (st.timer) clearTimeout(st.timer);
            st.lastReport = null;
            st.lastReportAt = 0;
        }
        clearJsFaces();
        clearTextareaMirrors();
        baseSink.set("");
        siteSink.set("");
        attach();
    }

    function configure(settings, bf, hints) {
        clearJsFaces();
        if (st && st.timer) clearTimeout(st.timer);
        st = freshState();

        if (!settings.enabled) return turnOff("disabled");
        if (matchesHosts(settings.excludedSites)) return turnOff("excluded");
        if (!settings.mono.textarea) clearTextareaMirrors();

        const { fonts, monoSize, monoScale } = F.resolveFonts(settings, bf);
        const chosenLower = new Set(CATS.map(c => norm(fonts[c].name)));
        const hostHints = hints && Object.hasOwn(hints, location.hostname) ? hints[location.hostname] : null;
        const hintNames = F.cleanNameList(hostHints).filter(n => !chosenLower.has(norm(n)) && !page.lateNames.has(norm(n)));

        cfg = {
            settings, fonts, monoSize, monoScale, chosenLower, hintNames,
            matchers: F.buildMatchers(settings),
            protectSel: editorSelector(settings.editors, settings.mono.textarea),
            editorRootSel: [...F.EDITOR_ROOTS, ...settings.editors.selectors.filter(F.validSelector)].join(","),
            editorsOffSite: matchesHosts(settings.editors.offSites),
            preFaces: new Set(hintNames.map(norm))
        };

        const applyBase = () => { baseSink.set(buildBaseCss()); attach(); };
        if (hintNames.length) trackOwnFaces(applyBase);
        else applyBase();
        listen();
        if (document.readyState !== "loading") schedule(0);
    }

    const load = () => F.storage.load().then(({ settings, bf, hints }) => configure(settings, bf, hints)).catch(() => {});

    function describe(el) {
        const classes = (typeof el.className === "string" ? el.className : "").trim().split(/\s+/).filter(Boolean).slice(0, 2);
        return (el.localName + (el.id ? `#${el.id}` : "") + classes.map(c => `.${c}`).join("")).slice(0, 60);
    }

    function findEditors() {
        const rootSel = cfg.editorRootSel;
        const found = new Map();
        const add = el => {
            const name = describe(el);
            if (found.has(name)) found.get(name).count++; else found.set(name, { sample: name, count: 1 });
        };
        const isMono = el => { const a = el && analyze(getComputedStyle(el).fontFamily); return !!a && a.cat === "mono"; };

        try {
            if (rootSel) document.querySelectorAll(rootSel).forEach(add);
            let n = 0;
            for (const input of document.querySelectorAll(F.EDITOR_PROXY)) {
                if ((!rootSel || !input.closest(rootSel)) && (isMono(input) || isMono(input.parentElement))) add(input.parentElement || input);
                if (++n >= 50) break;
            }
        }
        catch {}
        return [...found.values()].slice(0, 6);
    }

    function hasDirectText(el) {
        for (let n = el.firstChild; n; n = n.nextSibling) {
            if (n.nodeType === 3 && /\S/.test(n.nodeValue)) return true;
        }
        const t = el.localName;
        return t === "input" || t === "textarea" || t === "select" || el.isContentEditable;
    }

    function findUnknownFonts() {
        const root = document.body || document.documentElement;
        if (!root) return [];
        const counts = new Map(), unknown = new Map(), byShape = new Map();

        walkElements(root, LIMITS.reportDom, el => {
            if (SKIP_TAGS.has(el.localName) || !hasDirectText(el)) return;
            let ff;
            const iff = el.hasAttribute("style") && el.style && el.style.fontFamily;
            if (iff && !iff.includes("var(")) ff = iff;
            else {
                const key = elemHash(el, el.parentElement ? el.parentElement.nodeName : "");
                ff = byShape.get(key);
                if (ff === undefined) {
                    ff = getComputedStyle(el).fontFamily;
                    byShape.set(key, ff);
                }
            }
            if (ff && ff.length <= LIMITS.valueLen) counts.set(ff, (counts.get(ff) || 0) + 1);
        });
        for (const [ff, count] of counts) {
            const a = analyze(ff);
            const key = a && a.unknown && norm(a.unknown);
            if (key && !cfg.matchers.manual.has(key)) unknown.set(key, { name: a.unknown, count: (unknown.has(key) ? unknown.get(key).count : 0) + count });
        }
        return [...unknown.values()].sort((a, b) => b.count - a.count).slice(0, 30);
    }

    function buildReport(live = false) {
        const base = { host: location.hostname, active: !!cfg, reason: offReason, unknown: [], deferred: [], editors: [], protect: false, siteOff: false };
        if (!cfg) return base;
        const now = Date.now();
        if (live && st && st.lastReport && now - st.lastReportAt < 900) return st.lastReport;

        if (document.fonts && st && st.fontCount >= 0 && document.fonts.size !== st.fontCount) schedule(0);
        const rep = {
            ...base,
            protect: !!cfg.protectSel,
            siteOff: cfg.settings.editors.protect && cfg.editorsOffSite,
            editors: findEditors(),
            deferred: [...page.lateNames.values()],
            unknown: findUnknownFonts()
        };
        if (st) { st.lastReport = rep; st.lastReportAt = now; }
        return rep;
    }

    try {
        if (window === window.top) Promise.resolve(chrome.runtime.sendMessage({ type: "rme:pageStart" })).catch(() => {});
        F.storage.onChange(load);
        chrome.runtime.onMessage.addListener((msg, sender, reply) => {
            if (msg && msg.type === "rme:report" && window === window.top) reply(buildReport(!!msg.live));
        });
    }
    catch {}

    load();
})();
