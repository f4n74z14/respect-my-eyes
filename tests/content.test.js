// Run: node tests/content.test.js   (needs jsdom: npm i jsdom)
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { JSDOM } = require(process.env.JSDOM_PATH || "jsdom");

const dist = path.join(__dirname, "..", "dist");
const common = fs.readFileSync(path.join(dist, "common.js"), "utf8");
const content = fs.readFileSync(path.join(dist, "content.js"), "utf8");

const PAGE_CSS = `
  @font-face { font-family: "Open Sans"; src: url(x.woff2); font-weight: 400; }
  @font-face { font-family: "FontAwesome"; src: url(fa.woff2); }
  @font-face { font-family: "Brand Face"; src: url(b.woff2); }
  :root { --font-body: "Inter", system-ui, sans-serif; --font-mono: SFMono-Regular, Menlo, monospace; --font-size: 16px; --brand: red; }
  body { font-family: "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; }
  h1 { font-family: "Open Sans", sans-serif; }
  .fa { font-family: FontAwesome, sans-serif; }
  code.hl { font: 12px/1.2 "Fira Code", monospace; }
  .brandy { font-family: "Brand Face"; }
  .plain { font-family: sans-serif; }
  .sys { font-family: system-ui, sans-serif; }
  .serifish { font-family: Georgia, "Times New Roman", serif; }
  .wh { font-family: Whitney; }
  .mce-container, .mce-container * { font-family: Arial, sans-serif; }
  .mce-ico { font-family: 'tinymce', Arial; }
  .sweep *, .sys { font-family: system-ui, sans-serif; }
  * { font-family: Arial; }
  @media (min-width: 600px) { .wide { font-family: "Lucida Grande", sans-serif; } }
  @page { font-family: Arial; }
`;

function setup({ settings, bf, hints, fonts = [], editor = false, host = "https://site.test/" }) {
  const dom = new JSDOM(`<!doctype html><html><head><style id="s">${PAGE_CSS}</style></head><body>
      <h1>t</h1><div id="inl" style="font-family: Quuxface, serif">q</div><i class="fa"></i><code class="hl">x</code><p class="brandy">b</p><p class="plain">p</p><p class="wh">w</p><p class="wide">w</p></body></html>`,
    { url: host, runScripts: "outside-only", pretendToBeVisual: true });
  const w = dom.window;
  w.self = w;
  if (editor) {   // @scope + selector() support matching real Chromium (top-level comma lists return false), and a Monaco-like element
    w.CSSScopeRule = function () {};
    w.CSS = {
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
    const d = w.document.createElement("div");
    d.className = "monaco-editor";
    d.innerHTML = '<div class="view-lines" style="font-family: \'Editor Only Mono\', monospace">x</div>';
    w.document.body.appendChild(d);
  }

  // constructed stylesheet shim (jsdom has none)
  w.CSSStyleSheet = class { constructor() { this.text = ""; } replaceSync(t) { this.text = t; } };
  let adopted = [];
  Object.defineProperty(w.document, "adoptedStyleSheets", { get: () => adopted, set: v => { adopted = Array.from(v); }, configurable: true });

  w.__fonts = fonts;
  w.__sent = [];
  Object.defineProperty(w.document, "fonts", { value: { forEach: cb => w.__fonts.forEach(cb), addEventListener() {} }, configurable: true });

  const store = { settings, browserFonts: bf };
  const listeners = [];
  w.chrome = {
    runtime: { lastError: null, onMessage: { addListener: fn => (w.__onMessage = fn) }, sendMessage: (m, cb) => { w.__sent.push(m); cb && cb(); } },
    storage: {
      local: { get: () => Promise.resolve({ rmeSettings: store.settings, rmeBrowserFonts: store.browserFonts, rmeHints: hints }) },
      onChanged: { addListener: fn => listeners.push(fn) }
    }
  };
  w.eval(common);
  w.eval(content);
  return { w, store, listeners, sheets: () => adopted.map(s => s.text), adopted: () => adopted };
}

const wait = ms => new Promise(r => setTimeout(r, ms));
const BF = { available: true, standard: "Times New Roman", serif: "Georgia", sansserif: "Verdana", fixed: "Consolas", fixedSize: 13, defaultSize: 16 };

(async () => {
  // --- 0. variable fonts from a blocked stylesheet: descriptors replicated from document.fonts -----------------------
  const ev = setup({ settings: undefined, bf: BF, fonts: [
    { family: '"Google Sans Flex"', weight: "1 1000", style: "normal", stretch: "25% 151%" },
    { family: "Google Sans Code", weight: "300 800", style: "italic", stretch: "100%" },
    { family: "Inter", weight: "500", style: "normal", stretch: "normal" },
    { family: "Inter", weight: "400", style: "normal", stretch: "normal" },
    { family: "Google Symbols", weight: "400", style: "normal", stretch: "normal" },
    { family: "Evil", weight: "400;}body{display:none", style: "normal", stretch: "normal" } ] });
  await wait(400);
  const vs = ev.sheets()[1];
  assert.ok(vs.includes('@font-face{font-family:"Google Sans Flex";font-weight:1 1000;font-style:normal;font-stretch:25% 151%;src:local("Verdana Bold")') === false, "range starts regular");
  assert.ok(/@font-face\{font-family:"Google Sans Flex";font-weight:1 1000;font-style:normal;font-stretch:25% 151%;src:local\("Verdana"\)/.test(vs), "variable face replicated with identical descriptors");
  assert.ok(vs.includes('font-weight:600 1000;font-style:normal;font-stretch:25% 151%;src:local("Verdana Bold")'), "bold half offered");
  assert.ok(/Google Sans Code";font-weight:300 800;font-style:italic;font-stretch:100%;src:local\("Consolas Italic"\)[^}]*size-adjust:81.25%/.test(vs), "mono variable italic face replicated with size-adjust");
  assert.ok(/@font-face\{font-family:"Inter";font-weight:500;font-style:normal;src:local\("Verdana"\)/.test(vs), "page weight 500 replicated");
  assert.ok(!/font-family:"Inter";font-weight:400;font-style:normal;src[^}]*\}[\s\S]*font-family:"Inter";font-weight:400;font-style:normal/.test(vs), "standard weights are not emitted twice");
  assert.ok(!vs.includes("Google Symbols"), "icon font untouched");
  assert.ok(!vs.includes("display:none"), "page-controlled descriptors are validated");

  // --- 1. normal run using browser fonts ------------------------------------------------------------------------
  let env = setup({ settings: undefined, bf: BF });
  await wait(400);
  const [base, site] = env.sheets();

  assert.ok(!base.includes('"Whitney"') && !base.includes('"Poppins"'), "the font list is NOT put into the base sheet");
  assert.ok(site.includes('@font-face{font-family:"Whitney"') && site.includes('local("Verdana")'), "a listed font the page uses is replaced, with the browser sans font");
  assert.ok(!site.includes('"Poppins"') && !site.includes('"Open Sans Condensed"') && !site.includes('"Google Sans"'), "listed fonts the page does not use cost nothing");
  assert.ok(base.includes('pre,code,kbd,samp,pre *,code *{font-family:"Consolas", monospace!important;font-size:13px!important'), "mono defaults from browser, textarea no longer forced");

  assert.ok(site.includes('font-family:"Segoe UI"') && site.includes('local("Verdana")'), "page names overridden");
  assert.ok(site.includes('font-family:"Helvetica Neue"'), "later names in stack overridden too");
  assert.ok(!/@font-face\{font-family:"Verdana"/.test(site), "chosen font is never mapped to itself");
  assert.ok(site.includes('@font-face{font-family:"Georgia"') === false, "chosen serif not re-declared");
  assert.ok(site.includes('font-family:"Times New Roman"'), "other serif names overridden");
  assert.ok(site.includes('font-family:"Fira Code"') && site.includes("size-adjust:81.25%"), "mono face gets size-adjust derived from browser");
  assert.ok(site.includes('"Inter"') === false || site.includes('--font-body:"Verdana", sans-serif!important'), "css var overridden");
  assert.ok(site.includes('--font-mono:"Consolas", monospace!important'), "mono css var overridden");
  assert.ok(!site.includes("--font-size") && !site.includes("--brand"), "non-font custom props untouched");
  assert.ok(!/FontAwesome/i.test(site.replace(/\.fa\b/g, "")), "icon font untouched");
  assert.ok(!/\.fa[{,]/.test(site), "icon selector untouched");
  assert.ok(site.includes("code.hl") && /code\.hl[^}]*font-size:13px!important/.test(site), "mono selector forced with browser size");
  assert.ok(!/\.plain/.test(site), "pure sans-serif stack left to the browser");
  assert.ok(/\.sys/.test(site), "system-ui stack is forced");
  assert.ok(site.includes('@font-face{font-family:"Lucida Grande"'), "rules nested in @media are handled by name");
  assert.ok(!/\.wide/.test(site), "a named stack is replaced by name, its selector is not mirrored");
  assert.ok(!/mce-container|mce-ico/.test(site), "page rules like .mce-container * never clobber descendants that have their own icon font");
  assert.ok(/(^|[}{,\n])\.sys[,{]/.test(site) && !/\.sweep/.test(site), "generic stacks are mirrored, but never as a sweep over every descendant");
  assert.ok(!/(^|,)\*[,{]/.test(site) && !site.includes(":first"), "universal selector and @page skipped");
  assert.ok(/html,body\{font-family:"Verdana", sans-serif!important\}/.test(site), "html/body follows detected category");
  assert.ok(!/Brand Face/.test(site), "unknown face without fallback is not guessed");

  const styleEl = env.w.document.getElementById("s");
  const faceNames = Array.from(styleEl.sheet.cssRules).filter(r => r.type === 5).map(r => r.style.getPropertyValue("font-family"));
  assert.ok(!faceNames.some(n => /Open Sans/.test(n)), "page's @font-face for overridden family deleted");
  assert.ok(faceNames.some(n => /FontAwesome/.test(n)) && faceNames.some(n => /Brand Face/.test(n)), "icon + unknown @font-face kept");

  assert.ok(site.includes('font-family:"Quuxface"') || env.sheets()[1].includes('font-family:"Quuxface"'), "inline-style font found via computed styles");

  // --- 2. popup report finds the unclassified font --------------------------------------------------------------
  let resp; env.w.__onMessage({ type: "rme:report" }, {}, r => (resp = r));
  assert.ok(resp && resp.active);
  assert.strictEqual(JSON.stringify(resp.unknown.map(u => u.name)), '["Brand Face"]', "reports only the truly unknown font");

  // --- 3. adding it as a manual font applies live -----------------------------------------------------------------
  const s = JSON.parse(JSON.stringify(env.store.settings || {}));
  s.manualFonts = [{ name: "Brand Face", category: "serif" }];
  env.store.settings = s;
  env.listeners.forEach(fn => fn({ rmeSettings: {} }, "local"));
  await wait(200);
  assert.ok(env.sheets()[1].includes('@font-face{font-family:"Brand Face"') && env.sheets()[1].includes('local("Georgia")'), "font added to the list is applied live, because the page uses it");
  assert.ok(!env.sheets()[0].includes('"Brand Face"'), "without touching the base sheet");

  // --- 4. custom font beats browser, generic-only stacks are forced then --------------------------------------------
  env = setup({ settings: { fonts: { sans: { mode: "custom", custom: "Inter" } }, mono: { sizeMode: "custom", customSize: 15, scaleMode: "off" } }, bf: BF });
  await wait(400);
  const [b2, s2] = env.sheets();
  assert.ok(s2.includes('local("Inter")'), "custom sans used for the families the page uses");
  assert.ok(/\.plain[^{]*\{font-family:"Inter", sans-serif!important/.test(s2), "generic-only stack forced when custom font set");
  assert.ok(b2.includes("font-size:15px") && !s2.includes("size-adjust"), "custom mono size, scaling off");

  // --- 5. disabled / excluded ---------------------------------------------------------------------------------------
  env = setup({ settings: { enabled: false }, bf: BF });
  await wait(300);
  assert.deepStrictEqual(env.sheets().map(x => x.trim()), ["", ""], "disabled produces no CSS");

  env = setup({ settings: { excludedSites: ["site.test"] }, bf: BF });
  await wait(300);
  assert.deepStrictEqual(env.sheets().map(x => x.trim()), ["", ""], "excluded site produces no CSS");
  env.w.__onMessage({ type: "rme:report" }, {}, r => (resp = r));
  assert.strictEqual(resp.reason, "excluded");

  // --- 6. API unavailable falls back to original defaults ------------------------------------------------------------
  env = setup({ settings: undefined, bf: undefined });
  await wait(400);
  assert.ok(env.sheets()[1].includes('local("Arial")'), "fallback sans = Arial");

  // --- 7. stylesheet added after load is picked up --------------------------------------------------------------------
  env = setup({ settings: undefined, bf: BF });
  await wait(400);
  const st = env.w.document.createElement("style");
  st.textContent = ".late { font-family: Tahoma, sans-serif; }";
  env.w.document.head.appendChild(st);
  await wait(500);
  assert.ok(env.sheets()[1].includes('font-family:"Tahoma"'), "late stylesheet processed incrementally");

  // --- 8. editors: found automatically, protected from forced size, late fonts deferred ---------------------------------
  env = setup({ settings: undefined, bf: BF, editor: true });
  await wait(500);
  const [b8, s8] = env.sheets();
  const PROXY = ':is(textarea,[contenteditable],[role="textbox"])[autocorrect="off"][spellcheck="false"]';
  assert.ok(b8.includes("@scope (:root) to (" + PROXY + ",:has(> " + PROXY + ")"), "boundary is the hidden input element, no class names needed");
  assert.ok(/@scope[^{]*\.monaco-editor,\.cm-editor,\.CodeMirror,\.ace_editor,\.xterm\)\{pre,code/.test(b8), "mono defaults are scoped away from editors");
  assert.ok(/@scope[^{]*\{code\.hl[^}]*font-size:13px/.test(s8), "page-derived mono rules are scoped away from editors too");
  assert.ok(b8.includes("@keyframes rme-seen") && b8.includes(PROXY + "{animation:rme-seen .001s}"), "detector for editors that appear later");
  assert.ok(!b8.includes('@font-face'), "nothing is declared up front for a site without hints");
  assert.ok(!b8.includes('@font-face{font-family:"Consolas"'), "the chosen font itself needs no rule");
  assert.ok(!s8.includes('"Editor Only Mono"'), "late monospace font found inside an editor is NOT swapped under it");
  env.w.__onMessage({ type: "rme:report" }, {}, r => (resp = r));
  assert.strictEqual(JSON.stringify(resp.editors), '[{"sample":"div.monaco-editor","count":1}]', "report names the editor element");
  assert.strictEqual(resp.protect, true);
  assert.strictEqual(JSON.stringify(resp.deferred), '["Editor Only Mono"]');
  assert.strictEqual(env.w.__sent[0] && env.w.__sent[0].type, "rme:pageStart", "top frame announces pageStart to reset tab badge/state");
  assert.strictEqual(JSON.stringify(env.w.__sent.filter(m => m.type === "rme:learn")), '[{"type":"rme:learn","host":"site.test","names":["Editor Only Mono"]}]', "late editor font is reported for learning, with its site");

  // changing settings while the editor is open must not swap the font under it either
  env.listeners.forEach(fn => fn({ rmeSettings: {} }, "local"));
  await wait(300);
  assert.ok(!env.sheets()[0].includes('"Editor Only Mono"') && !env.sheets()[1].includes('"Editor Only Mono"'), "still left alone for the rest of this page's life");

  // next visit: the site's hint puts the editor's font into the base sheet, before any page script runs
  env = setup({ settings: undefined, bf: BF, hints: { "site.test": ["Editor Only Mono", "Consolas"] }, editor: true });
  await wait(500);
  assert.ok(env.sheets()[0].includes('@font-face{font-family:"Editor Only Mono"') && env.sheets()[0].includes('local("Consolas")'), "hinted font is applied from the first paint");
  assert.ok(!env.sheets()[0].includes('@font-face{font-family:"Consolas"'), "the chosen font itself needs no rule");
  env.w.__onMessage({ type: "rme:report" }, {}, r => (resp = r));
  assert.strictEqual(resp.deferred.length, 0, "so nothing is left over for the editor");
  assert.strictEqual(env.w.__sent.filter(m => m.type === "rme:learn").length, 0, "and nothing is learned twice");
  env = setup({ settings: undefined, bf: BF, hints: { "other.test": ["Editor Only Mono"] }, editor: true });
  await wait(400);
  assert.ok(!env.sheets()[0].includes('"Editor Only Mono"'), "hints are per site");

  // an editor with NO known class that mounts after load: its hidden input announces it
  env = setup({ settings: undefined, bf: BF, editor: true });
  await wait(400);
  const mount = env.w.document.createElement("div");
  mount.innerHTML = '<div class="a"><div class="b"><div class="lines" style="font-family: \'Brand New Mono\', monospace">x</div><textarea autocorrect="off" spellcheck="false"></textarea></div></div>';
  env.w.document.body.appendChild(mount);
  const ta = mount.querySelector("textarea");
  const seen = new env.w.Event("animationstart", { bubbles: true });
  seen.animationName = "rme-seen";
  ta.dispatchEvent(seen);
  await wait(100);
  assert.ok(env.w.__sent.some(m => m.names && m.names.includes("Brand New Mono")), "unknown editor found through its hidden input, font learned");
  assert.ok(!env.sheets()[1].includes('"Brand New Mono"'), "and not swapped under it");

  // text boxes are not forced unless the user opts in
  env = setup({ settings: { version: 4, mono: { textarea: true } }, bf: BF });
  await wait(300);
  assert.ok(env.sheets()[0].includes("code *,textarea{"), "textarea forcing is opt-in");

  // the base sheet does not grow with the font list: 20 listed fonts or 520, the same
  const many = n => ({ manualFonts: Array.from({ length: n }, (_, i) => ({ name: `Listed Font ${i}`, category: i % 2 ? "mono" : "sans" })) });
  const small = setup({ settings: many(20), bf: BF });
  const large = setup({ settings: many(500), bf: BF });
  await wait(400);
  assert.strictEqual(small.sheets()[0], large.sheets()[0], "base sheet is independent of the list size");
  assert.strictEqual(small.sheets()[1], large.sheets()[1], "and so is the site sheet, as long as the page does not use them");

  // protection switched off for this site, and globally
  env = setup({ settings: { version: 4, editors: { offSites: ["site.test"] } }, bf: BF, editor: true });
  await wait(400);
  assert.ok(!env.sheets()[0].includes("@scope") && !env.sheets()[0].includes("rme-seen"), "site switch turns protection off");
  env.w.__onMessage({ type: "rme:report" }, {}, r => (resp = r));
  assert.strictEqual(resp.siteOff, true);
  env = setup({ settings: { version: 4, editors: { protect: false } }, bf: BF, editor: true });
  await wait(400);
  assert.ok(!env.sheets()[0].includes("@scope"), "global switch turns protection off");

  // custom mono font + editor: comma-separated extra selectors work, Visit 1 protects/learns, Visit 2 applies custom font from base sheet
  env = setup({
    settings: { version: 4, fonts: { mono: { mode: "custom", custom: "JetBrains Mono" } }, editors: { selectors: [".ed-a, .ed-b"] } },
    bf: BF,
    editor: true
  });
  await wait(500);
  assert.ok(env.sheets()[0].includes("@scope (:root) to (") && env.sheets()[0].includes(".ed-a, .ed-b"), "comma-separated protected selector keeps @scope active");
  assert.ok(!env.sheets()[1].includes('"Editor Only Mono"'), "Visit 1 does not swap editor font under running editor");
  assert.ok(env.w.__sent.some(m => m.names && m.names.includes("Editor Only Mono")), "Visit 1 learns editor font");

  // late stylesheet or late FontFace added while an editor is already mounted must also defer mono fonts instead of swapping mid-session
  const lateEdStyle = env.w.document.createElement("style");
  lateEdStyle.textContent = ".late-ed-box { font-family: 'Late Sheet Mono', monospace; }";
  env.w.document.head.appendChild(lateEdStyle);
  env.w.__fonts.push({ family: "Late JS Mono", weight: "400", style: "normal", stretch: "normal" });
  await wait(400);
  assert.ok(!env.sheets()[1].includes('"Late Sheet Mono"') && !env.sheets()[1].includes('"Late JS Mono"'), "late mono stylesheet/FontFace does not swap while editor is mounted");
  assert.ok(env.w.__sent.some(m => m.names && m.names.includes("Late Sheet Mono")) && env.w.__sent.some(m => m.names && m.names.includes("Late JS Mono")), "late mono fonts are learned for next load");

  // Visit 2 with custom mono font applies the learned editor font from base sheet at document_start
  env = setup({
    settings: { version: 4, fonts: { mono: { mode: "custom", custom: "JetBrains Mono" } } },
    bf: BF,
    hints: { "site.test": ["Editor Only Mono"] },
    editor: true
  });
  await wait(500);
  assert.ok(env.sheets()[0].includes('@font-face{font-family:"Editor Only Mono"') && env.sheets()[0].includes('local("JetBrains Mono")') && env.sheets()[0].includes("size-adjust:81.25%"), "Visit 2 applies user custom mono font cleanly from base sheet");

  console.log("content.test.js: all checks passed");
})().catch(e => { console.error(e); process.exit(1); });
