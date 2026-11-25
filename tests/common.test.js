// Run: node tests/common.test.js
const assert = require("assert");
global.self = global;
require("../dist/common.js");
const F = self.RME;

const settings = F.normalizeSettings(null);
const m = F.buildMatchers(settings);
const a = (v) => F.analyzeStack(v, m);

let n = 0;
function t(name, fn) { fn(); n++; }

t("classifies single names", () => {
    assert.strictEqual(F.classifyName("arial", m), "sans");
    assert.strictEqual(F.classifyName("georgia", m), "serif");
    assert.strictEqual(F.classifyName("consolas", m), "mono");
    assert.strictEqual(F.classifyName("roboto mono", m), "mono");
    assert.strictEqual(F.classifyName("roboto slab", m), null);
    assert.strictEqual(F.classifyName("sfmono-regular", m), "mono");
    assert.strictEqual(F.classifyName("monotype corsiva", m), null);
    assert.strictEqual(F.classifyName("font awesome 5 free", m), "icon");
    assert.strictEqual(F.classifyName("material icons", m), "icon");
    assert.strictEqual(F.classifyName("segoe ui emoji", m), "icon");
    assert.strictEqual(F.classifyName("segoe ui", m), "sans");
    assert.strictEqual(F.classifyName("source serif pro", m), "serif");
    assert.strictEqual(F.classifyName("noto sans mono", m), "mono");
    assert.strictEqual(F.classifyName("internal", m), null);          // original unanchored /inter/ would match
});

t("splits families respecting quotes", () => {
    const s = F.splitFamilies('"Segoe UI", \'Helvetica Neue\' , Arial !important, sans-serif');
    assert.deepStrictEqual(s.map(x => x.name), ["Segoe UI", "Helvetica Neue", "Arial", "sans-serif"]);
    assert.deepStrictEqual(s.map(x => x.generic), [false, false, false, true]);
    assert.strictEqual(F.splitFamilies('"sans-serif"')[0].generic, false);   // quoted = real family name
});

t("analyzes stacks", () => {
    let r = a('-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Apple Color Emoji", sans-serif');
    assert.strictEqual(r.cat, "sans");
    assert.strictEqual(r.names.find(x => x.lower === "apple color emoji").cat, "icon");

    r = a("Arial, monospace");                         // contradictory stack: first family wins
    assert.strictEqual(r.cat, "sans");

    r = a('"Foobarface", sans-serif');                   // unknown name inherits category from fallback
    assert.strictEqual(r.cat, "sans"); assert.strictEqual(r.names[0].inferred, true); assert.strictEqual(r.unknown, null);

    r = a("Whitney");                                  // in manual list
    assert.strictEqual(r.cat, "sans");

    r = a("Totallyunknownface");                       // no fallback, not in list -> reported as missing
    assert.strictEqual(r.cat, null); assert.strictEqual(r.unknown, "Totallyunknownface");

    r = a('FontAwesome, sans-serif');
    assert.strictEqual(r.cat, "skip");

    r = a("sans-serif");
    assert.strictEqual(r.pure, true); assert.strictEqual(r.cat, "sans");

    r = a("system-ui, sans-serif");
    assert.strictEqual(r.pure, false);

    assert.strictEqual(a("inherit"), null);
    assert.strictEqual(a("var(--font)"), null);
    assert.strictEqual(a("cursive").cat, null);
});

t("custom property detection", () => {
    assert.ok(F.looksLikeFontStack('"Inter", system-ui, sans-serif', "--x"));
    assert.ok(F.looksLikeFontStack("Arial", "--font-body"));
    assert.ok(!F.looksLikeFontStack("16px", "--font-size"));
    assert.ok(!F.looksLikeFontStack("bold", "--font-weight"));
    assert.ok(!F.looksLikeFontStack("red", "--brand"));
    assert.ok(!F.looksLikeFontStack("0 0 4px rgba(0,0,0,.2)", "--shadow"));
});

t("settings normalisation", () => {
    const s = F.normalizeSettings({ enabled: false, excludedSites: ["https://Example.com/path", "*.foo.org", "", "example.com"],
        fonts: { sans: { mode: "custom", custom: ' "Inter" ' }, serif: { mode: "bogus" } },
        mono: { sizeMode: "nope", customSize: 500 },
        manualFonts: [{ name: "Foo", category: "mono" }, { name: "foo", category: "sans" }, { name: "Bar", category: "x" }, null] });
    assert.strictEqual(s.enabled, false);
    assert.deepStrictEqual(s.excludedSites, ["example.com", "foo.org"]);
    assert.strictEqual(s.fonts.sans.custom, "Inter");
    assert.strictEqual(s.fonts.serif.mode, "browser");
    assert.strictEqual(s.mono.sizeMode, "browser");
    assert.strictEqual(s.mono.customSize, 72);
    assert.deepStrictEqual(s.manualFonts, [{ name: "Foo", category: "mono" }]);
    assert.ok(F.normalizeSettings("garbage").manualFonts.length > 10);
});

t("editor settings are validated", () => {
    const d = F.normalizeSettings(null);
    assert.deepStrictEqual([d.editors.protect, d.editors.autoReload, d.editors.selectors, d.editors.offSites], [true, false, [], []]);
    const e = F.normalizeSettings({ version: 4, editors: { protect: false, autoReload: true, selectors: [" .my-editor ", "a{color:red}", ".x;y", "@import", ".my-editor", ""], offSites: ["https://A.com/x", "a.com"] } });
    assert.strictEqual(e.editors.protect, false);
    assert.strictEqual(e.editors.autoReload, true);
    assert.strictEqual(F.normalizeSettings({ version: 4, editors: { autoReload: "yes" } }).editors.autoReload, false);
    assert.deepStrictEqual(e.editors.selectors, [".my-editor"]);
    assert.deepStrictEqual(e.editors.offSites, ["a.com"]);
    // v3 stored the built-in roots as well: only the user's own additions survive
    const v3 = F.normalizeSettings({ version: 3, editors: { selectors: [".monaco-editor", ".xterm", "[contenteditable]", ".mine"] } });
    assert.deepStrictEqual(v3.editors.selectors, [".mine"]);
});

t("editor boundary is automatic", () => {
    const b = F.editorBoundary([".mine"]);
    assert.ok(b.startsWith(':is(textarea,[contenteditable],[role="textbox"])[autocorrect="off"][spellcheck="false"],:has(> '), "hidden input + 2 ancestors");
    assert.ok(b.includes(":has(> * > :is(") && !b.includes(":has(> * > * >"));
    assert.ok(b.includes(".monaco-editor,.cm-editor,.CodeMirror,.ace_editor,.xterm,.mine"), "known roots + user additions");
});

t("old settings are migrated", () => {
    const m = F.normalizeSettings({ version: 2, mono: { textarea: true, sizeMode: "custom", customSize: 15 }, editors: { selectors: [".monaco-editor"] } });
    assert.strictEqual(m.mono.textarea, false, "textarea forcing was the old default and must not survive");
    assert.strictEqual(m.mono.customSize, 15, "other values are kept");
    assert.strictEqual(F.normalizeSettings({ version: 3, mono: { textarea: true } }).mono.textarea, true, "explicit opt-in is respected");
    assert.deepStrictEqual(F.cleanNameList([" Foo ", "foo", 'B"ar', ""]), ["Foo", "Bar"]);
    assert.strictEqual(F.DEFAULT_SETTINGS.mono.textarea, false);
});

t("parses pasted font lists", () => {
    const r = F.parseFontLines('Open Sans | sans\n"Fira Code"|MONOSPACE\nGotham\nWingdings\ticon\n# comment\nBad | wat\n | sans\nopen sans | serif\n', "serif");
    assert.deepStrictEqual(r.entries, [
        { name: "open sans", category: "serif" },        // duplicate name: last wins
        { name: "Fira Code", category: "mono" },
        { name: "Gotham", category: "serif" },           // default category
        { name: "Wingdings", category: "ignore" }]);
    assert.deepStrictEqual(r.invalid.map(x => [x.line, x.reason]), [[6, 'Unknown category "wat"'], [7, "Empty name"]]);
    });

t("selector sweeps are dropped", () => {
    assert.deepStrictEqual(F.splitSelectorList('.a, [x="1,2"], :is(.b, .c) > p'), [".a", '[x="1,2"]', ":is(.b, .c) > p"]);
    assert.strictEqual(F.dropSweeps(".a, .a *, .b > *, .c:hover, .d *::before"), ".a,.c:hover,.d *::before");
    assert.strictEqual(F.dropSweeps('[x="a,b"] *, .e'), ".e");
    assert.strictEqual(F.dropSweeps(".only *"), "");
});

t("site hints", () => {
    let h = F.addHints({}, "Site.Test", ["Fira Code", "fira code", "Menlo", 'Bad"Name']);
    assert.deepStrictEqual(h, { "site.test": ["Fira Code", "Menlo", "BadName"] }, "cleaned and de-duplicated");
    assert.strictEqual(F.addHints(h, "site.test", ["menlo"]), null, "nothing new, nothing to write");
    assert.strictEqual(F.addHints(h, "", ["X"]), null);
    assert.strictEqual(F.addHints(h, "https://", ["X"]), null, "no usable host");

    h = F.addHints(h, "b.test", ["X"]);
    h = F.addHints(h, "site.test", ["Hack"]);
    assert.deepStrictEqual(Object.keys(h), ["b.test", "site.test"], "a refreshed site moves to the end");

    const names = Array.from({ length: 30 }, (_, i) => `Mono ${i}`);
    assert.strictEqual(F.addHints({}, "c.test", names)["c.test"].length, F.HINT_LIMITS.names, "names per site are capped");

    let many = {};
    for (let i = 0; i < F.HINT_LIMITS.hosts + 5; i++) many = F.addHints(many, `h${i}.test`, ["X"]);
    assert.strictEqual(Object.keys(many).length, F.HINT_LIMITS.hosts, "sites are capped");
    assert.ok(!("h0.test" in many) && "h304.test" in many, "oldest sites go first");
});

t("exclusion matching", () => {
    assert.ok(F.isExcluded("www.example.com", ["example.com"]));
    assert.ok(F.isExcluded("example.com", ["example.com"]));
    assert.ok(!F.isExcluded("notexample.com", ["example.com"]));
    assert.ok(!F.isExcluded("", ["example.com"]));
});

t("resolves fonts from browser settings", () => {
    const bf = { available: true, standard: "Times New Roman", serif: "Georgia", sansserif: "Verdana", fixed: "Consolas", fixedSize: 13, defaultSize: 16 };
    let r = F.resolveFonts(settings, bf);
    assert.deepStrictEqual([r.fonts.sans.name, r.fonts.serif.name, r.fonts.mono.name], ["Verdana", "Georgia", "Consolas"]);
    assert.strictEqual(r.fonts.sans.source, "browser");
    assert.strictEqual(r.monoSize, 13);
    assert.strictEqual(r.monoScale, 81.25);                                 // identical to the old hard-coded value

    const s2 = F.normalizeSettings({ fonts: { sans: { mode: "custom", custom: "Inter" } }, mono: { sizeMode: "off", scaleMode: "off" } });
    r = F.resolveFonts(s2, bf);
    assert.deepStrictEqual([r.fonts.sans.name, r.fonts.sans.source], ["Inter", "custom"]);
    assert.strictEqual(r.monoSize, null); assert.strictEqual(r.monoScale, null);

    r = F.resolveFonts(settings, null);                                     // API unavailable -> original defaults
    assert.deepStrictEqual([r.fonts.sans.name, r.fonts.serif.name, r.fonts.mono.name], ["Arial", "Georgia", "Courier New"]);

    r = F.resolveFonts(settings, { available: true, sansserif: "A", serif: "B", fixed: "C", fixedSize: 16, defaultSize: 16 });
    assert.strictEqual(r.monoScale, null);                                  // 100% = no size-adjust
});

t("generates compact @font-face rules", () => {
    const css = F.fontFaceCss("Open Sans", "mono", "Consolas", 81.25);
    assert.strictEqual(css.split("\n").length, 4);
    assert.ok(css.includes("font-weight:400;font-style:normal") && css.includes("font-weight:700;font-style:italic") && F.isStandardFace({ weight: "700", style: "italic", stretch: "normal" }) && !F.isStandardFace({ weight: "500", style: "normal", stretch: "normal" }) && !F.isStandardFace({ weight: "400", style: "normal", stretch: "50%" }));
    assert.ok(css.includes('font-family:"Open Sans"'));
    assert.ok(css.includes('local("Consolas Bold")'));
    assert.ok(css.includes("size-adjust:81.25%"));
    assert.ok(!F.fontFaceCss("X", "sans", "Arial", 81.25).includes("size-adjust"));
    assert.ok(!F.cssQuote('a"b\\c').includes('\\'));
});

t("validates selector lists", () => {
    const prevCss = global.CSS;
    try {
        global.CSS = {
            supports: expr => {
                const m = /^selector\(([\s\S]*)\)$/.exec(String(expr).trim());
                if (!m) return false;
                const inner = m[1].trim();
                let d = 0, q = "";
                for (const ch of inner) {
                    if (q) { if (ch === q) q = ""; }
                    else if (ch === '"' || ch === "'") q = ch;
                    else if ("([".includes(ch)) d++;
                    else if (")]".includes(ch)) d--;
                    else if (ch === "," && d === 0) return false;
                }
                return d === 0 && !/:::|::before|::after/.test(inner);
            }
        };
        assert.strictEqual(F.validSelector(".monaco-editor"), true);
        assert.strictEqual(F.validSelector(F.editorBoundary([".mine"])), true, "comma-separated boundary passes in real Chromium CSS.supports");
        assert.strictEqual(F.validSelector(".a, .b"), true);
        assert.strictEqual(F.validSelector(""), false);
        assert.strictEqual(F.validSelector(".a,"), false, "trailing comma rejected");
        assert.strictEqual(F.validSelector(", .a"), false, "leading comma rejected");
        assert.strictEqual(F.validSelector("div):where(span"), false, "unbalanced parens rejected");
        assert.strictEqual(F.validSelector(".a::before"), false, "pseudo-elements unsuitable for @scope rejected");
        assert.strictEqual(F.validSelector(":::bad"), false);
    } finally {
        global.CSS = prevCss;
    }
});

t("security hardening limits", () => {
    assert.strictEqual(F.cssQuote('Evil\n\r\x00"\\Face'), '"EvilFace"', "strips control chars, quotes and backslashes");
    assert.deepStrictEqual(F.cleanHostList(["__proto__", "constructor", "prototype", "good.test", "https://EVIL.test/path"]), ["good.test", "evil.test"]);
    assert.strictEqual(F.cleanHostList(["a".repeat(300)])[0].length, 253, "hostname capped at 253 chars");

    const protoBefore = ({}).polluted;
    const baseHints = Object.assign({}, { "keep.test": ["Hack"] });
    assert.strictEqual(F.addHints(baseHints, "__proto__", ["Mono"]), null, "prototype key rejected");
    assert.strictEqual(F.addHints(baseHints, "constructor", ["Mono"]), null);
    assert.strictEqual(F.addHints(baseHints, "toString.test", "not-an-array"), null, "non-array names safely ignored");
    assert.strictEqual(({}).polluted, protoBefore);

    const manyFamilies = Array.from({ length: 100 }, (_, i) => `Font${i}`).join(", ") + ", sans-serif";
    assert.strictEqual(F.splitFamilies(manyFamilies).length, 64, "font-family list capped at 64");

    assert.strictEqual(F.fontFaceExtraCss("X", "sans", "Arial", null, { weight: "1 ".repeat(25), style: "normal", stretch: "normal" }), "", "overlong weight descriptor rejected");
});

console.log("common.test.js: " + n + " groups passed");
