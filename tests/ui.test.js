// Run: node tests/ui.test.js   (needs jsdom: npm i jsdom)
const assert = require("assert");
const fs = require("fs"), path = require("path");
const { JSDOM } = require(process.env.JSDOM_PATH || "jsdom");

const dist = path.join(__dirname, "..", "dist");
const wait = ms => new Promise(r => setTimeout(r, ms));
const BF = { available: true, standard: "Times New Roman", serif: "Georgia", sansserif: "Verdana", fixed: "Consolas", fixedSize: 13, defaultSize: 16 };

async function page(file, { report, tabState, url = "https://site.test/", bf = BF } = {}) {
  const read = f => fs.readFileSync(path.join(dist, f), "utf8");
  const html = read(file);
  const w = new JSDOM(html.replace(/<script src="[^"]+"><\/script>/g, ""), { runScripts: "outside-only", url: "chrome-extension://x/" + file }).window;
  w.self = w;
  w.Element.prototype.scrollIntoView = function () {};   // missing in jsdom
  const store = { rmeBrowserFonts: bf };
  const created = [], events = [];
  w.close = () => { events.push("close"); };
  w.chrome = {
    storage: { local: { get: () => Promise.resolve({ ...store }), set: (o, cb) => { Object.assign(store, o); cb && cb(); return Promise.resolve(); } }, onChanged: { addListener() {} } },
    runtime: {
      sendMessage: async m => {
        if (m && m.type === "rme:tabState") return tabState || { learned: [], hosts: [] };
        return bf;
      },
      getURL: p => "chrome-extension://x/" + p,
      openOptionsPage() {}
    },
    tabs: {
      query: async () => [{ id: 1, url }],
      sendMessage: async () => report,
      create: o => created.push(o.url),
      reload: async id => { await wait(20); events.push("reload:" + id); }
    }
  };
  // load the scripts in the order the page lists them, like the browser does
  for (const [, src] of html.matchAll(/<script src="([^"]+)"><\/script>/g)) w.eval(read(src));
  await wait(150);
  return { w, d: w.document, store, created, events, $: id => w.document.getElementById(id), ev: (n, t) => t.dispatchEvent(new w.Event(n, { bubbles: true, cancelable: true })) };
}
const fonts = s => JSON.parse(JSON.stringify(s.rmeSettings.manualFonts));

(async () => {
  // ---------------------------------------------------------------- options
  const o = await page("options.html");
  assert.strictEqual(o.d.querySelectorAll("#fontRows .font-row").length, 3);
  assert.strictEqual(o.d.querySelectorAll("#preview .sample").length, 3, "live preview");
  assert.ok(o.$("preview").firstChild.style.fontFamily.includes("Verdana"), "preview uses the browser font");
  assert.strictEqual(o.d.querySelectorAll("#nav a").length, 6, "a short list of sections");
  assert.ok(o.$("protect").contains(o.$("edProtect")) && o.$("protect").contains(o.$("edAutoReload")) && o.$("protect").contains(o.$("edSelectors")), "protection has its own section");
  assert.ok(!o.$("monospace").contains(o.$("edProtect")), "and is no longer part of Monospace");
  assert.ok(!o.d.getElementById("seed") && !o.d.getElementById("autoLearn") && !o.d.getElementById("seedNames"), "internal knobs are gone");
  assert.ok(!o.$("sizeNum").classList.contains("show") && !o.$("scaleNum").classList.contains("show"), "custom numbers are hidden until Custom");
  assert.strictEqual(o.d.querySelectorAll("#manualList .list-row").length, 20);
  assert.strictEqual(o.$("count").textContent, "20 fonts");
  assert.strictEqual(o.$("filter").hidden, false, "filter appears for long lists");

  // the extension follows its own rule: its pages use your fonts (browser sans / fixed-width) + @font-face local() alias
  const rootStyle = o.d.documentElement.style;
  const uiFacesText = () => {
    const el = o.d.querySelector("style[data-rme-ui]");
    if (el) return el.textContent;
    return (o.d.adoptedStyleSheets || []).map(s => Array.from(s.cssRules || []).map(r => r.cssText).join("\n")).join("\n");
  };
  assert.ok(rootStyle.getPropertyValue("--font-ui").includes('"Verdana"') && rootStyle.getPropertyValue("--font-ui").endsWith("sans-serif"), "UI font = browser sans-serif font");
  assert.ok(rootStyle.getPropertyValue("--font-mono").includes('"Consolas"'), "code font = browser fixed-width font");
  assert.ok(/local\("?Verdana"?\)/.test(uiFacesText()) && /local\("?Consolas"?\)/.test(uiFacesText()), "UI injects local() @font-face aliases too");
  assert.ok(o.d.documentElement.classList.contains("ready"), "page is shown once the fonts are applied");
  const modeSelect = o.$("fontRows").querySelector("select");
  modeSelect.value = "custom"; o.ev("change", modeSelect);
  const customInput = o.$("fontRows").querySelector("input");
  customInput.value = "Inter"; o.ev("input", customInput);
  assert.ok(rootStyle.getPropertyValue("--font-ui").includes('"Inter"'), "choosing a custom font changes the page at once");
  assert.ok(/local\("?Inter"?\)/.test(uiFacesText()), "UI @font-face alias updates to custom font");

  // filter
  o.$("filter").value = "poppins"; o.ev("input", o.$("filter"));
  assert.strictEqual(o.d.querySelectorAll("#manualList .list-row").length, 1);
  assert.strictEqual(o.$("count").textContent, "1 of 20 fonts");
  o.$("filter").value = "zzz"; o.ev("input", o.$("filter"));
  assert.ok(o.$("manualList").textContent.includes("No fonts match"));
  o.$("filter").value = ""; o.ev("input", o.$("filter"));

  // add (+ duplicate updates category), clears the filter, shows a toast
  o.$("newName").value = "Gotham Rounded"; o.$("newCat").value = "mono"; o.ev("submit", o.$("addForm"));
  await wait(50);
  assert.deepStrictEqual(fonts(o.store).slice(-1)[0], { name: "Gotham Rounded", category: "mono" });
  assert.ok(o.$("toasts").textContent.includes("Added"));
  assert.ok(o.$("manualList").querySelector(".flash"), "new row is highlighted");
  o.$("newName").value = "gotham rounded"; o.$("newCat").value = "serif"; o.ev("submit", o.$("addForm"));
  assert.strictEqual(fonts(o.store).filter(f => /gotham rounded/i.test(f.name)).length, 1);
  assert.strictEqual(fonts(o.store).find(f => /gotham rounded/i.test(f.name)).category, "serif");

  // remove + undo
  const n0 = fonts(o.store).length;
  o.$("manualList").querySelector(".icon").click();
  await wait(300);
  assert.strictEqual(fonts(o.store).length, n0 - 1, "removed");
  const undo = [...o.$("toasts").querySelectorAll("button")].pop();
  assert.ok(undo && undo.textContent === "Undo", "removal can be undone");
  undo.click(); await wait(50);
  assert.strictEqual(fonts(o.store).length, n0, "undo restores it");

  // import dialog: live preview, default category, invalid lines, undo
  o.$("openImport").click();
  assert.strictEqual(o.$("impGo").disabled, true);
  o.$("impText").value = "Brand New Sans | sans\nFira Code | mono\nPoppins | serif\nPlain Name\nBroken | wat\n";
  o.ev("input", o.$("impText"));
  const rows = [...o.$("impPreview").querySelectorAll(".list-row")].map(r => r.textContent);
  assert.ok(rows.some(r => /Brand New Sans.*new/.test(r)) && rows.some(r => /Poppins.*changes category/.test(r)) && rows.some(r => /Line 5/.test(r)));
  assert.ok(/3 new/.test(o.$("impSummary").textContent) || /2 new/.test(o.$("impSummary").textContent), o.$("impSummary").textContent);
  assert.strictEqual(o.$("impGo").disabled, false);
  assert.ok(/^Import \d+ fonts?$/.test(o.$("impGo").textContent));
  o.$("impCatSeg").children[2].click();                       // default category -> Mono
  assert.ok([...o.$("impPreview").querySelectorAll(".list-row")].some(r => /Plain Name.*Mono/.test(r.textContent)), "default category applies");
  o.ev("submit", o.$("impForm")); await wait(50);
  assert.ok(fonts(o.store).some(f => f.name === "Plain Name" && f.category === "mono"));
  assert.strictEqual(fonts(o.store).find(f => f.name === "Poppins").category, "serif");
  const undoImport = [...o.$("toasts").querySelectorAll("button")].pop();
  undoImport.click(); await wait(50);
  assert.ok(!fonts(o.store).some(f => f.name === "Plain Name"), "import can be undone");
  assert.strictEqual(fonts(o.store).find(f => f.name === "Poppins").category, "sans");

  // segmented controls, switches, selector validation
  o.$("sizeSeg").children[1].click(); await wait(300);
  assert.strictEqual(o.store.rmeSettings.mono.sizeMode, "custom");
  assert.ok(o.$("sizeNum").classList.contains("show"), "custom size slides in");
  o.$("textarea").checked = true; o.ev("change", o.$("textarea")); await wait(300);
  assert.strictEqual(o.store.rmeSettings.mono.textarea, true);
  o.$("edAutoReload").checked = true; o.ev("change", o.$("edAutoReload")); await wait(300);
  assert.strictEqual(o.store.rmeSettings.editors.autoReload, true);
  o.$("edProtect").checked = false; o.ev("change", o.$("edProtect")); await wait(300);
  assert.strictEqual(o.store.rmeSettings.editors.protect, false);
  o.$("edSelectors").value = ".my-editor\n:::bad"; o.ev("input", o.$("edSelectors")); await wait(300);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(o.store.rmeSettings.editors.selectors)), [".my-editor", ":::bad"]);
  o.$("resetAll").click(); await wait(50);
  assert.strictEqual(o.store.rmeSettings.mono.textarea, false, "reset everything");
  [...o.$("toasts").querySelectorAll("button")].pop().click(); await wait(50);
  assert.strictEqual(o.store.rmeSettings.mono.sizeMode, "custom", "reset can be undone");

  // ---------------------------------------------------------------- popup
  const report = { host: "site.test", active: true, reason: "", protect: true, siteOff: false, deferred: ["Late Mono"],
    unknown: [{ name: "Gotham", count: 12 }, { name: "Whitney X", count: 1 }],
    editors: [{ sample: "div#editor.monaco-editor.vs-dark", count: 1 }, { sample: "div.cm-editor", count: 3 }] };
  let p = await page("popup.html", { report });
  assert.strictEqual(p.d.querySelectorAll("#fonts .font-item").length, 3);
  assert.strictEqual(p.$("host").textContent, "site.test");
  assert.strictEqual(p.$("siteOn").checked, true);
  assert.strictEqual(p.d.querySelectorAll("#unknown .card2").length, 2);
  assert.strictEqual(p.d.querySelectorAll("#editors .ed").length, 3, "2 editors + 1 late font");
  assert.ok(p.$("editors").textContent.includes("div#editor.monaco-editor.vs-dark"), "the element is named");
  assert.ok(p.$("editors").textContent.includes("\u00d73"), "with a count");
  assert.ok(p.$("editors").textContent.includes("Remembered"), "late editor font is remembered automatically");
  assert.strictEqual(p.$("banner").hidden, false, "which needs a reload");
  assert.strictEqual(p.$("edSwitch").checked, true);
  assert.strictEqual(p.$("edAutoReload").checked, false);
  p.$("edAutoReload").checked = true; p.ev("change", p.$("edAutoReload")); await wait(50);
  assert.strictEqual(p.store.rmeSettings.editors.autoReload, true, "popup can toggle auto-reload");

  // one switch for the whole site
  p.$("edSwitch").checked = false; p.ev("change", p.$("edSwitch")); await wait(50);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(p.store.rmeSettings.editors.offSites)), ["site.test"]);
  p.$("edSwitch").checked = true; p.ev("change", p.$("edSwitch")); await wait(50);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(p.store.rmeSettings.editors.offSites)), []);

  // classify an unknown font: choose Mono, Add
  const card = p.$("unknown").children[0];
  card.querySelector(".seg").children[2].click();
  card.querySelector("button.primary").click(); await wait(300);
  assert.deepStrictEqual(fonts(p.store).slice(-1)[0], { name: "Gotham", category: "mono" });
  assert.strictEqual(p.$("unknown").children.length, 1);
  assert.ok(p.$("toasts").textContent.includes("Gotham"));

  // pause the site / global switch
  p.$("siteOn").checked = false; p.ev("change", p.$("siteOn")); await wait(50);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(p.store.rmeSettings.excludedSites)), ["site.test"]);
  assert.ok(p.$("siteHint").textContent.includes("Paused"));
  p.$("enabled").checked = false; p.ev("change", p.$("enabled")); await wait(50);
  assert.ok(p.$("app").classList.contains("off"));

  // the popup uses the fonts too, and its reload banner stays clickable when everything is switched off
  assert.ok(p.d.documentElement.style.getPropertyValue("--font-ui").includes('"Verdana"'), "popup uses the browser's sans font");
  assert.strictEqual(p.$("banner").closest("#app"), null, "the banner is outside the dimmed area");
  assert.strictEqual(p.$("banner").hidden, false, "and it is shown after switching the extension off");
  assert.ok(!p.$("reload").disabled);
  const cssPopup = fs.readFileSync(path.join(dist, "popup.css"), "utf8");
  const cssUi = fs.readFileSync(path.join(dist, "ui.css"), "utf8");
  assert.ok(/#app\.off|\.off\b/.test(cssPopup) && /\.banner[^{]*\{[^}]*pointer-events:\s*auto/.test(cssPopup) && cssUi.includes("--font-ui"), "dimming is applied to #app only and banner forces pointer-events: auto");
  p.$("reload").click();
  await wait(60);
  assert.deepStrictEqual(p.events, ["reload:1", "close"], "reload button awaits tabs.reload before closing the popup");

  // subframe-only learned editor font (like Monaco Playground preview iframe) is surfaced via rme:tabState
  p = await page("popup.html", {
    report: { host: "microsoft.github.io", active: true, reason: "", protect: true, siteOff: false, deferred: [], unknown: [], editors: [] },
    tabState: { learned: ["Iframe Editor Mono"], hosts: ["isolated-playground.github.io"] }
  });
  assert.strictEqual(p.$("editorsBox").hidden, false, "subframe learned font opens Code editors section");
  assert.ok(p.$("editors").textContent.includes("Iframe Editor Mono") && p.$("editors").textContent.includes("Remembered"));
  assert.strictEqual(p.$("banner").hidden, false, "subframe learned font shows reload banner");

  // without a usable browser font the system stack stays
  const plain = await page("popup.html", { report, bf: { available: false } });
  assert.strictEqual(plain.d.documentElement.style.getPropertyValue("--font-ui"), "", "no variable set, so the CSS default applies");
  assert.ok(plain.d.documentElement.classList.contains("ready"));

  // unsupported page
  p = await page("popup.html", { report: undefined, url: "chrome://extensions/" });
  assert.strictEqual(p.$("note").hidden, false);
  assert.ok(p.$("site").hidden && p.$("banner").hidden, "no site switch on browser pages");

  // a normal page that was open before the extension started: say so and offer a reload
  p = await page("popup.html", { report: undefined });
  assert.ok(/not running/.test(p.$("note").textContent) && p.$("banner").hidden === false);
  assert.ok(p.$("site").hidden, "no site switch where the extension is not running");

  // web stores: http(s), but extensions cannot run there
  p = await page("popup.html", { report: undefined, url: "https://chromewebstore.google.com/detail/x" });
  assert.ok(p.$("site").hidden && p.$("banner").hidden && /can't be changed/.test(p.$("note").textContent), "web store is treated like a browser page");

  // globally disabled: nothing to switch per site; an excluded site keeps the switch so it can be re-enabled
  p = await page("popup.html", { report: { host: "x.test", active: false, reason: "disabled", unknown: [], deferred: [], editors: [] } });
  assert.ok(p.$("site").hidden, "hidden while the extension is off");
  p = await page("popup.html", { report: { host: "x.test", active: false, reason: "excluded", unknown: [], deferred: [], editors: [] } });
  assert.strictEqual(p.$("site").hidden, false, "shown on an excluded site");

  // the hidden attribute must really hide: a display rule on the element used to beat the browser's default
  assert.ok(/\[hidden\]\s*\{\s*display:\s*none\s*!important/.test(cssUi), "[hidden] always wins");

  // nothing to show: no empty sections
  p = await page("popup.html", { report: { host: "x.test", active: true, protect: true, siteOff: false, deferred: [], unknown: [], editors: [] } });
  assert.ok(p.$("attention").hidden && p.$("editorsBox").hidden, "empty sections stay hidden");

  console.log("ui.test.js: all checks passed");
})().catch(e => { console.error(e); process.exit(1); });
