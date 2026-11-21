// Run: node tests/ui.test.js   (needs jsdom: npm i jsdom)
const assert = require("assert");
const fs = require("fs"), path = require("path");
const { JSDOM } = require(process.env.JSDOM_PATH || "jsdom");

const dist = path.join(__dirname, "..", "dist");
const wait = ms => new Promise(r => setTimeout(r, ms));
const BF = { available: true, standard: "Times New Roman", serif: "Georgia", sansserif: "Verdana", fixed: "Consolas", fixedSize: 13, defaultSize: 16 };

async function page(file, { report, url = "https://site.test/" } = {}) {
  const html = fs.readFileSync(path.join(dist, file), "utf8").replace(/<script src="[^"]+"><\/script>/g, "");
  const w = new JSDOM(html, { runScripts: "outside-only", url: "chrome-extension://x/" + file }).window;
  w.self = w;
  w.Element.prototype.scrollIntoView = function () {};   // missing in jsdom
  const store = { rmeBrowserFonts: BF };
  const created = [];
  w.chrome = {
    storage: { local: { get: (k, cb) => { const r = { ...store }; return cb ? cb(r) : Promise.resolve(r); }, set: (o, cb) => { Object.assign(store, o); cb && cb(); return Promise.resolve(); } }, onChanged: { addListener() {} } },
    runtime: { sendMessage: (m, cb) => cb && cb(BF), getURL: p => "chrome-extension://x/" + p, openOptionsPage() {} },
    tabs: { query: async () => [{ id: 1, url }], sendMessage: async () => report, create: o => created.push(o.url), reload() {} }
  };
  w.eval(fs.readFileSync(path.join(dist, "common.js"), "utf8"));
  w.eval(fs.readFileSync(path.join(dist, file.replace(".html", ".js")), "utf8"));
  await wait(150);
  return { w, d: w.document, store, created, $: id => w.document.getElementById(id), ev: (n, t) => t.dispatchEvent(new w.Event(n, { bubbles: true, cancelable: true })) };
}
const fonts = s => JSON.parse(JSON.stringify(s.rmeSettings.manualFonts));

(async () => {
  // ---------------------------------------------------------------- options
  let o = await page("options.html");
  assert.strictEqual(o.d.querySelectorAll("#fontRows .font-row").length, 3);
  assert.strictEqual(o.d.querySelectorAll("#preview .sample").length, 3, "live preview");
  assert.ok(o.$("preview").firstChild.style.fontFamily.includes("Verdana"), "preview uses the browser font");
  assert.strictEqual(o.d.querySelectorAll("#nav a").length, 7);
  assert.strictEqual(o.d.querySelectorAll("#manualList .list-row").length, 20);
  assert.strictEqual(o.$("count").textContent, "20 fonts");
  assert.strictEqual(o.$("filter").hidden, false, "filter appears for long lists");

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
  assert.strictEqual(o.$("customSize").disabled, false);
  o.$("textarea").checked = true; o.ev("change", o.$("textarea")); await wait(300);
  assert.strictEqual(o.store.rmeSettings.mono.textarea, true);
  o.$("seedReset").click(); await wait(50);
  o.$("resetAll").click(); await wait(50);
  assert.strictEqual(o.store.rmeSettings.mono.textarea, false, "reset everything");
  [...o.$("toasts").querySelectorAll("button")].pop().click(); await wait(50);
  assert.strictEqual(o.store.rmeSettings.mono.sizeMode, "custom", "reset can be undone");

  // ---------------------------------------------------------------- popup
  const report = { host: "site.test", active: true, reason: "", protect: true, learned: true, deferred: ["Late Mono"],
    unknown: [{ name: "Gotham", count: 12 }, { name: "Whitney X", count: 1 }],
    editors: [{ selector: ".monaco-editor", count: 1, sample: "div#editor.monaco-editor.vs-dark", enabled: true }, { selector: "[contenteditable]", count: 3, sample: "div.ProseMirror", enabled: true }] };
  let p = await page("popup.html", { report });
  assert.strictEqual(p.d.querySelectorAll("#fonts .font-item").length, 3);
  assert.strictEqual(p.$("host").textContent, "site.test");
  assert.strictEqual(p.$("siteOn").checked, true);
  assert.strictEqual(p.d.querySelectorAll("#unknown .card2").length, 2);
  assert.strictEqual(p.d.querySelectorAll("#editors .ed").length, 3, "2 editors + 1 late font");
  assert.ok(p.$("editors").textContent.includes("div#editor.monaco-editor.vs-dark"), "the element is named");
  assert.ok(p.$("editors").textContent.includes("\u00d73"), "with a count");
  assert.strictEqual(p.$("banner").hidden, false, "remembered editor font asks for a reload");

  // quick switch for one editor
  const sw = p.$("editors").querySelector(".ed input");
  sw.checked = false; p.ev("change", sw); await wait(50);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(p.store.rmeSettings.editors.off)), [".monaco-editor"]);

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

  // unsupported page
  p = await page("popup.html", { report: undefined, url: "chrome://extensions/" });
  assert.strictEqual(p.$("note").hidden, false);
  assert.ok(p.$("site").hidden && p.$("banner").hidden, "no site switch on browser pages");

  // a normal page that was open before the extension started: say so and offer a reload
  p = await page("popup.html", { report: undefined });
  assert.ok(/not running/.test(p.$("note").textContent) && p.$("banner").hidden === false && p.$("site").hidden === false);

  // nothing to show: no empty sections
  p = await page("popup.html", { report: { host: "x.test", active: true, protect: true, learned: true, deferred: [], unknown: [], editors: [] } });
  assert.ok(p.$("attention").hidden && p.$("editorsBox").hidden, "empty sections stay hidden");

  console.log("ui.test.js: all checks passed");
})().catch(e => { console.error(e); process.exit(1); });
