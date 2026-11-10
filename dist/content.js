/*
 * Respect My Eyes - content script
 *
 * Forces the fonts configured in the browser (chrome://settings/fonts) onto every page, without breaking icon fonts.
 *
 *   Phase 1 (document_start)  manual font overrides + monospace defaults, so the first paint is already right.
 *   Phase 2 (DOM ready, load, stylesheets added later)
 *                             walk the stylesheets once (incrementally), classify every font-family found, override
 *                             the names via @font-face local() and the selectors via !important rules.
 *
 * All generated CSS lives in two constructed stylesheets, so it is exempt from page CSP and can be replaced cheaply.
 */
(function () {
    "use strict";

    const F = self.RME;

    if (!F || window.__rmeLoaded) return;
    window.__rmeLoaded = true;

    const CATS = F.CATS;
    const K = F.KEYS;

    let cfg = null;                 // resolved configuration, null while disabled / excluded
    let offReason = "disabled";

    let analysisCache, processed, unreadable, acc, bodyCat, lastSiteCss, baseCss;

    // ---------------------------------------------------------------------------------------------------------------
    // Output: two constructed stylesheets (with a <style> fallback)
    // ---------------------------------------------------------------------------------------------------------------

    function Sink() {
        this.sheet = null;
        this.el = null;
        try { this.sheet = new CSSStyleSheet(); } catch (e) { /* fallback to <style> */ }
    }

    const baseSink = new Sink();
    const siteSink = new Sink();
    const ours = new Set([baseSink.sheet, siteSink.sheet]);

    Sink.prototype.set = function (css) {
        if (this.sheet) {
            try { this.sheet.replaceSync(css); return; }
            catch (e) { this.sheet = null; }
        }
        if (!this.el) {
            this.el = document.createElement("style");
            this.el.setAttribute("data-rme", "");
        }
        this.el.textContent = css;
        if (!this.el.isConnected) (document.head || document.documentElement).appendChild(this.el);
    };

    // Keep our sheets last in the cascade (a page may have adopted its own sheets since we last looked)
    function attach() {
        if (!baseSink.sheet || !siteSink.sheet) return;
        try {
            const cur = document.adoptedStyleSheets;
            const want = Array.prototype.filter.call(cur, function (s) { return !ours.has(s); }).concat([baseSink.sheet, siteSink.sheet]);

            if (cur.length !== want.length || want.some(function (s, i) { return cur[i] !== s; })) {
                document.adoptedStyleSheets = want;
            }
        }
        catch (e) {
            baseSink.sheet = siteSink.sheet = null;     // adoption not possible here, use <style> elements
        }
    }

    function clearOutput() {
        baseSink.set("");
        siteSink.set("");
        attach();
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Analysis helpers
    // ---------------------------------------------------------------------------------------------------------------

    function analyze(value) {
        let a = analysisCache.get(value);

        if (a === undefined) {
            a = F.analyzeStack(value, cfg.matchers);
            analysisCache.set(value, a);
        }
        return a;
    }

    function registerNames(a) {
        for (let i = 0; i < a.names.length; i++) {
            const n = a.names[i];

            if (CATS.indexOf(n.cat) > -1 && !cfg.chosenLower.has(n.lower) && !acc.faces.has(n.lower)) {
                acc.faces.set(n.lower, { name: n.name, cat: n.cat });
            }
        }
    }

    function isA(rule, ctor, legacyType) {
        const C = self[ctor];
        return C ? rule instanceof C : rule.type === legacyType;
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Stylesheet walking
    // ---------------------------------------------------------------------------------------------------------------

    const VAR_SCOPE = /^(:root|html|body)\b/i;

    function onStyleRule(rule) {
        const sel = rule.selectorText;
        const ff = rule.style.fontFamily;

        if (ff) {
            const a = analyze(ff);

            if (a) {
                registerNames(a);

                if (CATS.indexOf(a.cat) > -1 && sel && sel.charAt(0) !== "*" && !(a.pure && cfg.fonts[a.cat].source !== "custom")) {
                    acc.sel[a.cat].add(sel);    // a pure "sans-serif" stack already follows the browser setting
                }
            }
        }

        if (sel && VAR_SCOPE.test(sel)) {
            const style = rule.style;
            let decls = "";

            for (let i = 0; i < style.length; i++) {
                const p = style[i];

                if (p.charCodeAt(0) !== 45 || p.charCodeAt(1) !== 45) continue;     // custom properties only

                const v = style.getPropertyValue(p).trim();

                if (!v || v.length > 500 || v.indexOf("(") > -1 || !F.looksLikeFontStack(v, p)) continue;

                const a = analyze(v);

                if (a && CATS.indexOf(a.cat) > -1 && !(a.pure && cfg.fonts[a.cat].source !== "custom")) {
                    registerNames(a);
                    decls += p + ":" + F.familyValue(a.cat, cfg.fonts) + "!important;";
                }
            }
            if (decls) acc.vars.push(sel + "{" + decls + "}");
        }
    }

    function scanRule(rule, parent, depth) {
        if (isA(rule, "CSSStyleRule", 1)) {                             // check first: style rules can have nested rules
            onStyleRule(rule);
        }
        else if (isA(rule, "CSSFontFaceRule", 5)) {
            acc.faceRules.push({ rule: rule, parent: parent });
        }
        else if (isA(rule, "CSSImportRule", 3)) {
            if (rule.styleSheet && depth < 4) scanSheet(rule.styleSheet, depth + 1);
        }
        else if (depth < 6 && rule.cssRules && !isA(rule, "CSSKeyframesRule", 7)) {   // @media, @supports, @layer, @container...
            for (let i = 0; i < rule.cssRules.length; i++) scanRule(rule.cssRules[i], rule, depth + 1);
        }
    }

    // Returns true if the sheet had new rules
    function scanSheet(sheet, depth) {
        if (ours.has(sheet) || unreadable.has(sheet)) return false;

        let rules;

        try { rules = sheet.cssRules; }
        catch (e) {
            if (e && e.name === "SecurityError") unreadable.add(sheet);     // cross-origin, the manual list covers these
            return false;
        }
        if (!rules) return false;

        const start = processed.get(sheet) || 0;
        const n = rules.length;

        if (processed.has(sheet) && n === start) return false;

        processed.set(sheet, n);

        for (let i = start; i < n; i++) scanRule(rules[i], sheet, depth);

        return true;
    }

    function scanDocument() {
        let changed = false;
        const sheets = document.styleSheets;

        for (let i = 0; i < sheets.length; i++) changed = scanSheet(sheets[i], 0) || changed;

        const adopted = document.adoptedStyleSheets;

        for (let i = 0; i < adopted.length; i++) changed = scanSheet(adopted[i], 0) || changed;

        return changed;
    }

    // Remove the page's own @font-face rules for families we override, so they cannot compete with ours
    function deleteFontFaces() {
        for (let i = acc.faceRules.length - 1; i >= 0; i--) {
            const item = acc.faceRules[i];
            let family = "";

            try { family = item.rule.style.getPropertyValue("font-family"); } catch (e) { continue; }

            family = F.norm(family.replace(/^\s*["']|["']\s*$/g, ""));

            if (!acc.faces.has(family) && !cfg.manualFaces.has(family)) continue;

            acc.faceRules.splice(i, 1);

            try {
                const rules = item.parent.cssRules;
                const idx = Array.prototype.indexOf.call(rules, item.rule);

                if (idx > -1) {
                    const cnt = processed.get(item.parent);
                    item.parent.deleteRule(idx);
                    if (cnt !== undefined && idx < cnt) processed.set(item.parent, cnt - 1);
                }
            }
            catch (e) { /* cross-origin or read-only sheet */ }
        }
    }

    // Faces the page declared, read from document.fonts. Works for stylesheets blocked by CORS and for FontFace() created in JS.
    function readPageFaces() {
        let changed = false;

        try {
            document.fonts.forEach(function (f) {
                const family = String(f.family).replace(/^\s*["']|["']\s*$/g, "");
                const lower = F.norm(family);
                const key = lower + "|" + f.weight + "|" + f.style + "|" + f.stretch;

                if (acc.faceKeys.has(key)) return;     // also skips our own faces, which show up in document.fonts too

                acc.faceKeys.add(key);

                const desc = { family: family, lower: lower, weight: f.weight, style: f.style, stretch: f.stretch };

                if (!F.isStandardFace(desc)) { acc.pageFaces.set(key, desc); changed = true; }

                const cat = F.classifyName(lower, cfg.matchers);

                if (CATS.indexOf(cat) > -1 && !cfg.chosenLower.has(lower) && !acc.faces.has(lower)) {
                    acc.faces.set(lower, { name: family, cat: cat });
                    changed = true;
                }
            });
        }
        catch (e) { /* document.fonts unavailable */ }

        return changed;
    }

    // ---------------------------------------------------------------------------------------------------------------
    // CSS generation
    // ---------------------------------------------------------------------------------------------------------------

    function faceCss(name, cat) {
        return F.fontFaceCss(name, cat, cfg.fonts[cat].name, cfg.monoScale);
    }

    function buildBaseCss() {
        const out = [];

        cfg.settings.manualFonts.forEach(function (f) {
            if (CATS.indexOf(f.category) > -1 && !cfg.chosenLower.has(F.norm(f.name))) out.push(faceCss(f.name, f.category));
        });
        out.push(F.monoDefaultsCss(cfg));

        return out.join("\n");
    }

    function detectBodyCat() {
        if (bodyCat || !document.body) return;

        const a = analyze(getComputedStyle(document.body).fontFamily);

        if (a && CATS.indexOf(a.cat) > -1) bodyCat = a.cat;
    }

    function buildSiteCss() {
        const out = [];

        acc.faces.forEach(function (f) { out.push(faceCss(f.name, f.cat)); });

        acc.pageFaces.forEach(function (pf) {
            if (F.isStandardFace(pf)) return;

            const known = acc.faces.get(pf.lower);
            const cat = known ? known.cat : cfg.matchers.manual.get(pf.lower);

            if (CATS.indexOf(cat) > -1 && !cfg.chosenLower.has(pf.lower)) {
                const css = F.fontFaceExtraCss(pf.family, cat, cfg.fonts[cat].name, cfg.monoScale, pf);
                if (css) out.push(css);
            }
        });

        CATS.forEach(function (cat) {
            if (!acc.sel[cat].size) return;

            const selectors = Array.from(acc.sel[cat]).join(",");

            out.push(cat === "mono" ? F.monoRule(selectors, cfg) : selectors + "{font-family:" + F.familyValue(cat, cfg.fonts) + "!important}");
        });

        out.push.apply(out, acc.vars);

        detectBodyCat();

        if (bodyCat) out.push("html,body{font-family:" + F.familyValue(bodyCat, cfg.fonts) + "!important}");

        return out.join("\n");
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Scheduling
    // ---------------------------------------------------------------------------------------------------------------

    let timer = 0;

    function schedule(delay) {
        if (timer || !cfg) return;

        timer = setTimeout(function () {
            timer = 0;
            run();
        }, delay);
    }

    function rebuild() {
        const css = buildSiteCss();

        if (css !== lastSiteCss) {
            lastSiteCss = css;
            siteSink.set(css);
        }
        attach();
    }

    /*
     * Second source of truth: the fonts the browser actually computed for the page's elements.
     * This catches everything the stylesheet walk cannot see: stylesheets blocked by CORS (CDN-hosted CSS),
     * font-family: var(--x), inline styles. Elements are de-duplicated by tag + class + style and processed in small
     * chunks so the page never stutters. Names found here are overridden through @font-face, like all others.
     */
    // Light DOM plus open shadow roots (custom-element sites such as developers.google.com)
    function collectElements(root, limit) {
        const out = [], stack = [root];

        while (stack.length && out.length < limit) {
            const node = stack.pop();
            const all = node.querySelectorAll("*");

            for (let i = 0; i < all.length && out.length < limit; i++) {
                out.push(all[i]);
                if (all[i].shadowRoot) stack.push(all[i].shadowRoot);
            }
        }
        return out;
    }

    let sampling = false, sampleAgain = false, sampledKeys, sampledOnce;

    function sample() {
        if (sampling) { sampleAgain = true; return; }
        if (!document.body) return;

        sampling = true;
        sampledOnce = true;

        const els = collectElements(document.body, 6000);
        const max = els.length;
        let i = 0, added = false;

        (function chunk() {
            if (!cfg) { sampling = false; return; }

            const end = Math.min(i + 250, max);

            for (; i < end; i++) {
                const el = els[i];
                const key = el.nodeName + "|" + (el.getAttribute("class") || "") + "|" + (el.getAttribute("style") || "");

                if (sampledKeys.has(key)) continue;
                sampledKeys.add(key);

                const a = analyze(getComputedStyle(el).fontFamily);

                if (a) {
                    const before = acc.faces.size;
                    registerNames(a);
                    if (acc.faces.size !== before) added = true;
                }
            }

            if (i < max) { setTimeout(chunk, 0); return; }

            sampling = false;

            if (added) { readPageFaces(); rebuild(); deleteFontFaces(); }
            if (sampleAgain) { sampleAgain = false; sample(); }
        })();
    }

    function run() {
        if (!cfg) return;

        const changed = scanDocument() | readPageFaces();      // not ||: both must run

        if (changed || lastSiteCss === null || !bodyCat) rebuild();     // nothing new, nothing to regenerate

        if (changed) deleteFontFaces();
        if (changed || !sampledOnce) sample();
    }

    let listening = false;

    function listen() {
        if (listening) return;
        listening = true;

        const start = function () {
            schedule(0);
            setTimeout(function () { schedule(0); }, 100);      // some sites only settle after their first scripts ran

            const head = document.head;

            if (head) {
                new MutationObserver(function (muts) {
                    for (let i = 0; i < muts.length; i++) {
                        const added = muts[i].addedNodes;

                        for (let n = 0; n < added.length; n++) {
                            const tag = added[n].nodeName;
                            if (tag === "STYLE" || tag === "LINK") { schedule(150); return; }
                        }
                    }
                }).observe(head, { childList: true });
            }
        };

        if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
        else start();

        // <link rel=stylesheet> finished loading, so its rules are readable now
        document.addEventListener("load", function (e) {
            if (e.target && e.target.nodeName === "LINK") schedule(50);
        }, true);

        try { document.fonts.addEventListener("loadingdone", function () { schedule(50); }); } catch (e) { /* optional */ }

        window.addEventListener("load", function () { schedule(50); setTimeout(function () { schedule(0); }, 500); });
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Configuration
    // ---------------------------------------------------------------------------------------------------------------

    function hostsToCheck() {
        const hosts = [location.hostname];

        try {
            const ao = location.ancestorOrigins;    // let an excluded top-level site also exclude its iframes
            if (ao && ao.length) hosts.push(new URL(ao[ao.length - 1]).hostname);
        }
        catch (e) { /* ignore */ }

        return hosts;
    }

    function configure(rawSettings, bf) {
        const settings = F.normalizeSettings(rawSettings);

        analysisCache = new Map();
        processed = new WeakMap();
        unreadable = new WeakSet();
        acc = { faces: new Map(), pageFaces: new Map(), faceKeys: new Set(), faceRules: [], sel: { sans: new Set(), serif: new Set(), mono: new Set() }, vars: [] };
        bodyCat = null;
        sampledKeys = new Set();
        sampledOnce = false;
        lastSiteCss = null;
        baseCss = null;

        if (!settings.enabled) { cfg = null; offReason = "disabled"; clearOutput(); return; }

        if (hostsToCheck().some(function (h) { return F.isExcluded(h, settings.excludedSites); })) {
            cfg = null; offReason = "excluded"; clearOutput(); return;
        }

        const r = F.resolveFonts(settings, bf);

        cfg = {
            settings: settings,
            fonts: r.fonts,
            monoSize: r.monoSize,
            monoScale: r.monoScale,
            matchers: F.buildMatchers(settings),
            chosenLower: new Set(F.CATS.map(function (c) { return F.norm(r.fonts[c].name); })),
            manualFaces: new Set(settings.manualFonts.filter(function (f) { return CATS.indexOf(f.category) > -1; }).map(function (f) { return F.norm(f.name); }))
        };

        baseCss = buildBaseCss();
        baseSink.set(baseCss);
        attach();

        listen();

        if (document.readyState !== "loading") schedule(0);
    }

    function load() {
        try {
            chrome.storage.local.get([K.settings, K.fonts], function (data) {
                if (chrome.runtime.lastError) return;

                const wasOn = !!cfg;

                configure(data[K.settings], data[K.fonts]);

                if (!wasOn && cfg) schedule(0);
            });
        }
        catch (e) { /* extension was reloaded, this script is orphaned */ }
    }

    try {
        chrome.storage.onChanged.addListener(function (changes, area) {
            if (area === "local" && (changes[K.settings] || changes[K.fonts])) load();     // apply live, no reload needed
        });

        // The popup asks the top frame which fonts on this page could not be classified
        chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
            if (!msg || msg.type !== "rme:report" || window !== window.top) return;

            sendResponse(buildReport());
        });
    }
    catch (e) { /* orphaned */ }

    function buildReport() {
        const report = { host: location.hostname, active: !!cfg, reason: offReason, unknown: [] };

        if (!cfg) return report;

        const counts = new Map();
        const els = document.querySelectorAll("*");
        const max = Math.min(els.length, 8000);

        for (let i = 0; i < max; i++) {
            const ff = getComputedStyle(els[i]).fontFamily;
            counts.set(ff, (counts.get(ff) || 0) + 1);
        }

        const unknown = new Map();

        counts.forEach(function (count, ff) {
            const a = analyze(ff);

            if (a && a.unknown && !cfg.matchers.manual.has(F.norm(a.unknown))) {
                const key = F.norm(a.unknown);
                const cur = unknown.get(key);
                unknown.set(key, { name: a.unknown, count: (cur ? cur.count : 0) + count });
            }
        });

        report.unknown = Array.from(unknown.values()).sort(function (a, b) { return b.count - a.count; }).slice(0, 30);

        return report;
    }

    load();
})();
