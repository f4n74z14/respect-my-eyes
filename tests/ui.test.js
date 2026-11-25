// Run: node tests/ui.test.js   (needs jsdom: npm i jsdom)
const assert = require("assert");
const fs = require("fs"), path = require("path");
const { JSDOM } = require(process.env.JSDOM_PATH || "jsdom");

const dist = path.join(__dirname, "..", "dist");
const wait = ms => new Promise(r => setTimeout(r, ms));
const BF = { available: true, standard: "Times New Roman", serif: "Georgia", sansserif: "Verdana", fixed: "Consolas", fixedSize: 13, defaultSize: 16 };

let sharedStore = { rmeBrowserFonts: BF };
async function page(file, { report, tabState, url = "https://site.test/", bf = BF } = {}) {
  const read = f => fs.readFileSync(path.join(dist, f), "utf8");
  const html = read(file);
  const w = new JSDOM(html.replace(/<script src="[^"]+"><\/script>/g, ""), { runScripts: "outside-only", url: "chrome-extension://x/" + file }).window;
  w.self = w;
  w.Element.prototype.scrollIntoView = function () {};   // missing in jsdom
  const created = [], events = [], storageListeners = [];
  w.close = () => { events.push("close"); };
  w.chrome = {
    storage: {
      local: {
        get: () => Promise.resolve(JSON.parse(JSON.stringify(sharedStore))),
        set: (o, cb) => {
          const clone = JSON.parse(JSON.stringify(o));
          const changes = {};
          for (const k of Object.keys(clone)) {
            changes[k] = { oldValue: sharedStore[k] ? JSON.parse(JSON.stringify(sharedStore[k])) : undefined, newValue: JSON.parse(JSON.stringify(clone[k])) };
            sharedStore[k] = clone[k];
          }
          cb && cb();
          queueMicrotask(() => {
            for (const fn of storageListeners) fn(JSON.parse(JSON.stringify(changes)), "local");
          });
          return Promise.resolve();
        }
      },
      onChanged: { addListener: fn => storageListeners.push(fn) }
    },
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
  return { w, d: w.document, store: sharedStore, created, events, storageListeners, $: id => w.document.getElementById(id), ev: (n, t) => t.dispatchEvent(new w.Event(n, { bubbles: true, cancelable: true })) };
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

  // segmented controls, switches, selector validation & persistence
  o.$("sizeSeg").children[1].click(); await wait(50);
  assert.strictEqual(o.store.rmeSettings.mono.sizeMode, "custom");
  assert.ok(o.$("sizeNum").classList.contains("show"), "custom size slides in");
  o.$("textarea").checked = true; o.ev("change", o.$("textarea")); await wait(50);
  assert.strictEqual(o.store.rmeSettings.mono.textarea, true);

  // edAutoReload saves immediately without waiting for debounce and survives stale storage.onChanged echoes and reloads
  o.$("edAutoReload").checked = true; o.ev("change", o.$("edAutoReload")); await wait(30);
  assert.strictEqual(o.store.rmeSettings.editors.autoReload, true, "edAutoReload setting is saved immediately");
  const o2 = await page("options.html");
  assert.strictEqual(o2.$("edAutoReload").checked, true, "edAutoReload switch state persists from storage on reload");
  o2.$("edAutoReload").checked = false; o2.ev("change", o2.$("edAutoReload")); await wait(30);
  assert.strictEqual(o.store.rmeSettings.editors.autoReload, false, "disabling edAutoReload is saved immediately");
  // simulate a stale storage.onChanged echo arriving right after enabling edAutoReload
  o2.$("edAutoReload").checked = true; o2.ev("change", o2.$("edAutoReload"));
  const staleSnap = JSON.parse(JSON.stringify(sharedStore.rmeSettings));
  staleSnap.editors.autoReload = false;
  o2.storageListeners.forEach(fn => fn({ rmeSettings: { newValue: staleSnap } }, "local"));
  await wait(30);
  assert.strictEqual(o2.$("edAutoReload").checked, true, "stale storage.onChanged echo does not reset edAutoReload");
  const o3 = await page("options.html");
  assert.strictEqual(o3.$("edAutoReload").checked, true, "edAutoReload stays enabled across reload");
  o3.$("edAutoReload").checked = false; o3.ev("change", o3.$("edAutoReload")); await wait(30);
  const o4 = await page("options.html");
  assert.strictEqual(o4.$("edAutoReload").checked, false, "disabled edAutoReload state persists across reload");

  o.$("edProtect").checked = false; o.ev("change", o.$("edProtect")); await wait(50);
  assert.strictEqual(o.store.rmeSettings.editors.protect, false);
  o.$("edSelectors").value = ".my-editor\n:::bad"; o.ev("input", o.$("edSelectors"));
  o.ev("pagehide", o.w); await wait(50);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(o.store.rmeSettings.editors.selectors)), [".my-editor", ":::bad"], "pagehide flushes pending debounced edits");
  o.$("resetAll").click(); await wait(50);
  assert.strictEqual(o.store.rmeSettings.mono.textarea, false, "reset everything");
  [...o.$("toasts").querySelectorAll("button")].pop().click(); await wait(50);
  assert.strictEqual(o.store.rmeSettings.mono.sizeMode, "custom", "reset can be undone");
  // leave clean factory defaults for the popup test suite
  o.$("resetAll").click(); await wait(50);

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
  assert.strictEqual(sharedStore.rmeSettings.editors.autoReload, true, "popup can toggle auto-reload");
  const p2 = await page("popup.html", { report });
  assert.strictEqual(p2.$("edAutoReload").checked, true, "popup edAutoReload setting persists from storage");

  // one switch for the whole site (still mutates live settings.editors even after storage.onChanged)
  const updated = JSON.parse(JSON.stringify(sharedStore.rmeSettings));
  updated.editors.autoReload = false;
  p.storageListeners.forEach(fn => fn({ rmeSettings: { newValue: updated } }, "local"));
  await wait(20);
  assert.strictEqual(p.$("edAutoReload").checked, false, "popup syncs edAutoReload on external storage change");
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

  // subframe-only learned editor fonts (like Monaco Playground preview iframe) are surfaced via rme:tabState without repeating hints
  p = await page("popup.html", {
    report: { host: "microsoft.github.io", active: true, reason: "", protect: true, siteOff: false, deferred: ["Iframe Mono A"], unknown: [], editors: [] },
    tabState: { learned: ["Iframe Mono A", "Iframe Mono B"], hosts: ["isolated-playground.github.io"] }
  });
  assert.strictEqual(p.$("editorsBox").hidden, false, "subframe learned font opens Code editors section");
  assert.ok(p.$("editors").textContent.includes("Iframe Mono A") && p.$("editors").textContent.includes("Iframe Mono B"));
  assert.ok(p.$("editors").textContent.includes("Remembered") && !p.$("editors").textContent.includes("Saved from an editor"), "no repetitive hint per remembered font");
  assert.strictEqual(p.$("banner").hidden, false, "subframe learned font shows reload banner");

  // without a usable browser font the system stack stays
  sharedStore.rmeBrowserFonts = { available: false };
  const plain = await page("popup.html", { report, bf: { available: false } });
  assert.strictEqual(plain.d.documentElement.style.getPropertyValue("--font-ui"), "", "no variable set, so the CSS default applies");
  assert.ok(plain.d.documentElement.classList.contains("ready"));
  sharedStore.rmeBrowserFonts = BF;

  // unsupported page
  p = await page("popup.html", { report: undefined, url: "chrome://extensions/" });
  assert.strictEqual(p.$("note").hidden, false);
  assert.ok(p.$("site").hidden && p.$("banner").hidden, "no site switch on browser pages");

  // manifest grants activeTab so tabs.query exposes tab.url when the popup opens on an already-open tab
  const manifest = JSON.parse(fs.readFileSync(path.join(dist, "manifest.json"), "utf8"));
  assert.ok(Array.isArray(manifest.permissions) && manifest.permissions.includes("activeTab"), "manifest includes activeTab for already-open tab URL detection");

  // a normal page that was open before the extension started/enabled: say so and offer a reload
  p = await page("popup.html", { report: undefined });
  assert.ok(/not running/.test(p.$("note").textContent) && /reload/i.test(p.$("note").textContent) && p.$("banner").hidden === false);
  assert.ok(!/Browser pages/.test(p.$("note").textContent), "does not misidentify an already-open web page as a browser page");
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

  // heavy site near limits: long font names truncate cleanly, scroll bounds exist in CSS, and 500-font cap does not lie
  assert.ok(/#unknown\s*\{[^}]*max-height:/.test(cssPopup) && /#editors\s*\{[^}]*max-height:/.test(cssPopup), "popup caps heavy lists with internal scrolling");
  const longName = "VeryLongObfuscatedEditorFontNameWithoutSpaces_" + "x".repeat(60);
  sharedStore.rmeSettings = { version: 4, manualFonts: Array.from({ length: 500 }, (_, i) => ({ name: `Cap Font ${i}`, category: "sans" })) };
  p = await page("popup.html", {
    report: { host: "heavy.test", active: true, protect: true, siteOff: false, deferred: [longName], unknown: [{ name: "New Heavy Font", count: 4200 }], editors: [] }
  });
  assert.strictEqual(p.$("editors").querySelector(".name").getAttribute("title"), longName, "long remembered editor font gets ellipsis class and full tooltip");
  p.$("unknown").querySelector("button.primary").click();
  await wait(30);
  assert.ok(p.$("toasts").textContent.includes("500"), "shows limit warning instead of falsely claiming font was added");
  assert.strictEqual(p.$("unknown").children.length, 1, "card is kept when 500-font cap prevents saving");

  // UI.md consistency: all in-body popup switches sit in .card > .setting rows and Settings footer stays pinned outside scrollable #app
  const appSwitches = [...p.$("app").querySelectorAll("label.switch")];
  assert.ok(appSwitches.length === 3 && appSwitches.every(sw => sw.closest(".card > .setting")), "all in-body popup switches use unified .card > .setting alignment");
  assert.strictEqual(p.d.querySelector("footer").closest("#app"), null, "footer sits outside scrollable #app");
  assert.ok(/#app\s*\{[^}]*overflow-y:\s*auto/.test(cssPopup) && /footer\s*\{[^}]*flex:\s*none/.test(cssPopup), "popup scrolls #app while pinning Settings footer");

  console.log("ui.test.js: all checks passed");
})().catch(e => { console.error(e); process.exit(1); });
