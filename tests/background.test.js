// Run: node tests/background.test.js
const assert = require("assert");
const fs = require("fs"), path = require("path"), vm = require("vm");

const store = { settings: { enabled: false, excludedSites: ["a.com"] }, browserFonts: { available: true, serif: "Old" } };
let installed, onMessage;
const badges = new Map(), titles = new Map(), reloads = [];
const ctx = {
  console, setTimeout, clearTimeout,
  importScripts: () => {},
  chrome: {
    storage: { local: {
      get: async keys => { const ks = [].concat(keys); const o = {}; ks.forEach(k => { if (k in store) o[k] = store[k]; }); return o; },
      set: async o => Object.assign(store, o),
      remove: async keys => [].concat(keys).forEach(k => delete store[k]) } },
    action: {
      setBadgeText: ({ tabId, text }) => badges.set(tabId, text),
      setBadgeBackgroundColor: () => {},
      setBadgeTextColor: () => {},
      setTitle: ({ tabId, title }) => titles.set(tabId, title)
    },
    tabs: {
      reload: async tabId => reloads.push(tabId),
      onRemoved: { addListener() {} },
      onUpdated: { addListener() {} }
    },
    runtime: { onInstalled: { addListener: fn => (installed = fn) }, onStartup: { addListener() {} }, onMessage: { addListener: fn => (onMessage = fn) } },
    fontSettings: { getFont: async ({ genericFamily }) => ({ fontId: genericFamily + "-font" }), getDefaultFixedFontSize: async () => ({ pixelSize: 14 }), getDefaultFontSize: async () => ({ pixelSize: 16 }) }
  }
};
ctx.self = ctx;
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, "../dist/common.js"), "utf8"), ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, "../dist/background.js"), "utf8"), ctx);

(async () => {
  await installed();
  assert.ok(!("settings" in store) && !("browserFonts" in store), "legacy keys removed");
  assert.strictEqual(store.rmeSettings.enabled, false, "user settings survive the migration");
  assert.deepStrictEqual(JSON.parse(JSON.stringify(store.rmeSettings.excludedSites)), ["a.com"]);
  assert.strictEqual(store.rmeBrowserFonts.sansserif, "sansserif-font", "browser fonts refreshed from chrome.fontSettings");
  assert.strictEqual(store.rmeBrowserFonts.fixedSize, 14);
  // editors report late monospace fonts from several frames at once; they are remembered per site, not in the user's list
  const before = JSON.stringify(store.rmeSettings.manualFonts);
  await Promise.all([1, 2, 3].map(() => new Promise(r => onMessage({ type: "rme:learn", host: "Site.Test", names: ["Editor Mono", "Other Mono"] }, { tab: { id: 7 } }, r))));
  assert.deepStrictEqual(JSON.parse(JSON.stringify(store.rmeHints)), { "site.test": ["Editor Mono", "Other Mono"] }, "learned once, no duplicates");
  assert.strictEqual(JSON.stringify(store.rmeSettings.manualFonts), before, "the user's font list is not touched");
  assert.strictEqual(badges.get(7), "!", "sets toolbar badge when a new editor font is learned");
  let tabState;
  onMessage({ type: "rme:tabState", tabId: 7 }, {}, res => (tabState = res));
  assert.deepStrictEqual(JSON.parse(JSON.stringify(tabState)), { learned: ["Editor Mono", "Other Mono"], hosts: ["site.test"] }, "reports subframe/top learned fonts per tab");
  assert.strictEqual(reloads.length, 0, "does not auto-reload when autoReload is false");

  onMessage({ type: "rme:pageStart" }, { tab: { id: 7 } }, () => {});
  assert.strictEqual(badges.get(7), "", "top-frame pageStart clears the badge");
  onMessage({ type: "rme:tabState", tabId: 7 }, {}, res => (tabState = res));
  assert.deepStrictEqual(JSON.parse(JSON.stringify(tabState)), { learned: [], hosts: [] }, "and clears per-tab learned list");

  // opt-in autoReload reloads once per tab navigation when enabled and protection is active
  store.rmeSettings.enabled = true;
  store.rmeSettings.editors.protect = true;
  store.rmeSettings.editors.autoReload = true;
  await new Promise(r => onMessage({ type: "rme:learn", host: "subframe.test", names: ["Iframe Mono"] }, { tab: { id: 9 } }, r));
  await new Promise(r => onMessage({ type: "rme:learn", host: "subframe2.test", names: ["Another Mono"] }, { tab: { id: 9 } }, r));
  await new Promise(r => setTimeout(r, 180));
  assert.deepStrictEqual(reloads, [9], "auto-reloads once for the tab when editors.autoReload is enabled");

  await new Promise(r => onMessage({ type: "rme:learn", host: "b.test", names: ["Other Mono"] }, {}, r));
  assert.deepStrictEqual(Object.keys(store.rmeHints), ["site.test", "subframe.test", "subframe2.test", "b.test"], "each site has its own hints");

  assert.strictEqual(onMessage({ type: "rme:learn", names: ["No Host"] }, {}, () => {}), undefined, "a report without a site is ignored");
  assert.strictEqual(onMessage({ type: "rme:learn", host: "x.test", names: "nope" }, {}, () => {}), undefined);

  console.log("background.test.js: migration + refresh + site hints + badge/autoReload ok");
})().catch(e => { console.error(e); process.exit(1); });
