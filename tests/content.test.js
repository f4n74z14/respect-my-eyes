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
  * { font-family: Arial; }
  @media (min-width: 600px) { .wide { font-family: Verdana, sans-serif; } }
  @page { font-family: Arial; }
`;

function setup({ settings, bf, fonts = [], editor = false, host = "https://site.test/" }) {
  const dom = new JSDOM(`<!doctype html><html><head><style id="s">${PAGE_CSS}</style></head><body>
      <h1>t</h1><div id="inl" style="font-family: Quuxface, serif">q</div><i class="fa"></i><code class="hl">x</code><p class="brandy">b</p><p class="plain">p</p><p class="wide">w</p></body></html>`,
    { url: host, runScripts: "outside-only", pretendToBeVisual: true });
  const w = dom.window;
  w.self = w;
  if (editor) {   // @scope + selector() support, and a Monaco-like element whose font comes from an inline style
    w.CSSScopeRule = function () {};
    w.CSS = { supports: () => true };
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
      local: { get: (keys, cb) => cb({ rmeSettings: store.settings, rmeBrowserFonts: store.browserFonts }) },
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
  let ev = setup({ settings: undefined, bf: BF, fonts: [
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

  assert.ok(base.includes('font-family:"Whitney"') && base.includes('local("Verdana")'), "manual faces use browser sans font");
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
  assert.ok(/\.wide/.test(site), "rules nested in @media are handled");
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
  assert.ok(env.sheets()[0].includes('font-family:"Brand Face"') && env.sheets()[0].includes('local("Georgia")'), "manual font applied live");

  // --- 4. custom font beats browser, generic-only stacks are forced then --------------------------------------------
  env = setup({ settings: { fonts: { sans: { mode: "custom", custom: "Inter" } }, mono: { sizeMode: "custom", customSize: 15, scaleMode: "off" } }, bf: BF });
  await wait(400);
  let [b2, s2] = env.sheets();
  assert.ok(b2.includes('local("Inter")'), "custom sans used");
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
  assert.ok(env.sheets()[0].includes('local("Arial")'), "fallback sans = Arial");

  // --- 7. stylesheet added after load is picked up --------------------------------------------------------------------
  env = setup({ settings: undefined, bf: BF });
  await wait(400);
  const st = env.w.document.createElement("style");
  st.textContent = ".late { font-family: Tahoma, sans-serif; }";
  env.w.document.head.appendChild(st);
  await wait(500);
  assert.ok(env.sheets()[1].includes('font-family:"Tahoma"'), "late stylesheet processed incrementally");

  // --- 8. editors: protected from forced size, seeded names, late fonts deferred --------------------------------------
  env = setup({ settings: undefined, bf: BF, editor: true });
  await wait(500);
  const [b8, s8] = env.sheets();
  assert.ok(/@scope \(:root\) to \(\.monaco-editor,\.cm-editor,\.CodeMirror,\.ace_editor,\.xterm,\[contenteditable\]\)\{pre,code/.test(b8), "mono defaults are scoped away from editors");
  assert.ok(/@scope[^{]*\{code\.hl[^}]*font-size:13px/.test(s8), "page-derived mono rules are scoped away from editors too");
  assert.ok(b8.includes('font-family:"JetBrains Mono"') && b8.includes('font-family:"Menlo"'), "well-known monospace names applied from the first paint");
  assert.ok(!b8.includes('@font-face{font-family:"Consolas"'), "chosen font itself is not seeded");
  assert.ok(!s8.includes('"Editor Only Mono"'), "late monospace font found inside an editor is NOT swapped under it");
  env.w.__onMessage({ type: "rme:report" }, {}, r => (resp = r));
  assert.strictEqual(JSON.stringify(resp.editors), '[{"selector":".monaco-editor","count":1,"sample":"div.monaco-editor","enabled":true}]', "report names the editor element");
  assert.strictEqual(JSON.stringify(resp.deferred), '["Editor Only Mono"]');

  assert.strictEqual(JSON.stringify(env.w.__sent), '[{"type":"rme:learn","names":["Editor Only Mono"]}]', "late editor font is reported for learning");

  // the learned font lands in the settings while this page is still open: it must NOT be swapped under the editor now
  const learned = JSON.parse(JSON.stringify(env.store.settings || {}));
  learned.manualFonts = [{ name: "Editor Only Mono", category: "mono" }];
  env.store.settings = learned;
  env.listeners.forEach(fn => fn({ rmeSettings: {} }, "local"));
  await wait(300);
  assert.ok(!env.sheets()[0].includes('"Editor Only Mono"') && !env.sheets()[1].includes('"Editor Only Mono"'), "learned font waits for the next page load");

  // text boxes are not forced unless the user opts in
  env = setup({ settings: { version: 3, mono: { textarea: true } }, bf: BF });
  await wait(300);
  assert.ok(env.sheets()[0].includes("code *,textarea{"), "textarea forcing is opt-in");

  // user adds it -> it is part of the base sheet next time
  env = setup({ settings: { manualFonts: [{ name: "Editor Only Mono", category: "mono" }] }, bf: BF, editor: true });
  await wait(500);
  assert.ok(env.sheets()[0].includes('font-family:"Editor Only Mono"'), "manual mono font applied from the first paint");

  // one editor switched off from the popup: it is no longer scoped away, the others still are
  env = setup({ settings: { version: 3, editors: { off: [".monaco-editor"] } }, bf: BF, editor: true });
  await wait(400);
  assert.ok(!env.sheets()[0].includes("monaco-editor") && env.sheets()[0].includes("@scope"), "per-editor switch");
  env.w.__onMessage({ type: "rme:report" }, {}, r => (resp = r));
  assert.strictEqual(resp.editors[0].enabled, false);

  // seed switched off, protection switched off
  env = setup({ settings: { mono: { seed: false }, editors: { protect: false } }, bf: BF, editor: true });
  await wait(400);
  assert.ok(!env.sheets()[0].includes('"JetBrains Mono"') && !env.sheets()[0].includes("@scope"), "settings switch both features off");

  console.log("content.test.js: all checks passed");
})().catch(e => { console.error(e); process.exit(1); });
