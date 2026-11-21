// Run: node tests/background.test.js
const assert = require("assert");
const fs = require("fs"), path = require("path"), vm = require("vm");

const store = { settings: { enabled: false, excludedSites: ["a.com"] }, browserFonts: { available: true, serif: "Old" } };
let installed, onMessage;
const ctx = {
  console, setTimeout, clearTimeout,
  importScripts: () => {},
  chrome: {
    storage: { local: {
      get: async keys => { const ks = [].concat(keys); const o = {}; ks.forEach(k => { if (k in store) o[k] = store[k]; }); return o; },
      set: async o => Object.assign(store, o),
      remove: async keys => [].concat(keys).forEach(k => delete store[k]) } },
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
  // editors report late monospace fonts from several frames at once
  await Promise.all([1, 2, 3].map(() => new Promise(r => onMessage({ type: "rme:learn", names: ["Editor Mono", "Other Mono"] }, {}, r))));
  const names = store.rmeSettings.manualFonts.filter(f => /Editor Mono|Other Mono/.test(f.name));
  assert.strictEqual(names.length, 2, "learned once, no duplicates");
  assert.ok(names.every(f => f.category === "mono"));

  store.rmeSettings.editors.autoLearn = false;
  await new Promise(r => onMessage({ type: "rme:learn", names: ["Nope Mono"] }, {}, r));
  assert.ok(!store.rmeSettings.manualFonts.some(f => f.name === "Nope Mono"), "autoLearn can be switched off");

  console.log("background.test.js: migration + refresh + learn ok");
})().catch(e => { console.error(e); process.exit(1); });
