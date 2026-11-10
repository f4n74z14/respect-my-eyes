/*
 * Force My Browser Fonts - service worker
 *
 * chrome.fontSettings is not available to content scripts, so this worker reads the fonts configured in
 * chrome://settings/fonts once and caches them in chrome.storage.local. Every content script then reads the cache
 * instead of anything being configured per site. The cache is refreshed whenever the browser setting changes.
 */
importScripts("common.js");

const F = self.FMBF;

async function readBrowserFonts() {
    const result = { available: false, standard: "", serif: "", sansserif: "", fixed: "", fixedSize: 0, defaultSize: 0, updated: Date.now() };

    if (!chrome.fontSettings) return result;

    const font = async function (genericFamily) {
        try {
            const r = await chrome.fontSettings.getFont({ genericFamily: genericFamily });
            return (r && r.fontId) || "";
        }
        catch (e) { return ""; }
    };
    const size = async function (fn) {
        try {
            const r = await fn();
            return (r && r.pixelSize) || 0;
        }
        catch (e) { return 0; }
    };

    const all = await Promise.all([
        font("standard"), font("serif"), font("sansserif"), font("fixed"),
        size(function () { return chrome.fontSettings.getDefaultFixedFontSize(); }),
        size(function () { return chrome.fontSettings.getDefaultFontSize(); })
    ]);

    result.standard = all[0];
    result.serif = all[1];
    result.sansserif = all[2];
    result.fixed = all[3];
    result.fixedSize = all[4];
    result.defaultSize = all[5];
    result.available = !!(result.serif || result.sansserif || result.fixed);

    return result;
}

let refreshTimer = null;

async function refresh() {
    const bf = await readBrowserFonts();
    const old = (await chrome.storage.local.get("browserFonts")).browserFonts;

    // Avoid waking every tab's content script when nothing changed
    if (old && ["available", "standard", "serif", "sansserif", "fixed", "fixedSize", "defaultSize"].every(function (k) { return old[k] === bf[k]; })) {
        return old;
    }
    await chrome.storage.local.set({ browserFonts: bf });
    return bf;
}

function refreshSoon() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(refresh, 200);
}

chrome.runtime.onInstalled.addListener(async function () {
    const data = await chrome.storage.local.get("settings");
    await chrome.storage.local.set({ settings: F.normalizeSettings(data.settings) });
    await refresh();
});

chrome.runtime.onStartup.addListener(refresh);

if (chrome.fontSettings) {
    ["onFontChanged", "onDefaultFontSizeChanged", "onDefaultFixedFontSizeChanged"].forEach(function (name) {
        if (chrome.fontSettings[name]) chrome.fontSettings[name].addListener(refreshSoon);
    });
}

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (msg && msg.type === "fmbf:refresh") {
        refresh().then(sendResponse, function () { sendResponse(null); });
        return true;
    }
});
