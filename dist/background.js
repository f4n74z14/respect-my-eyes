/*
 * Respect My Eyes - service worker
 *
 * chrome.fontSettings is not available to content scripts, so this worker reads the fonts configured in
 * chrome://settings/fonts and caches them in chrome.storage.local. Content scripts read the cache, so nothing is
 * configured per site, and the cache is refreshed whenever the browser setting changes.
 */
importScripts("common.js");

const { RME: F } = self;
const FONT_KEYS = ["available", "standard", "serif", "sansserif", "fixed", "fixedSize", "defaultSize"];

const attempt = async (call, pick, fallback) => {
    try { return pick(await call()) || fallback; } catch { return fallback; }
};

async function readBrowserFonts() {
    const fonts = { available: false, standard: "", serif: "", sansserif: "", fixed: "", fixedSize: 0, defaultSize: 0 };
    const api = chrome.fontSettings;

    if (!api) return fonts;

    const font = genericFamily => attempt(() => api.getFont({ genericFamily }), r => r.fontId, "");
    const size = call => attempt(call, r => r.pixelSize, 0);

    [fonts.standard, fonts.serif, fonts.sansserif, fonts.fixed, fonts.fixedSize, fonts.defaultSize] = await Promise.all([
        font("standard"), font("serif"), font("sansserif"), font("fixed"),
        size(() => api.getDefaultFixedFontSize()), size(() => api.getDefaultFontSize())
    ]);
    fonts.available = !!(fonts.serif || fonts.sansserif || fonts.fixed);

    return fonts;
}

async function refresh() {
    const fonts = await readBrowserFonts();
    const cached = (await chrome.storage.local.get(F.KEYS.fonts))[F.KEYS.fonts];

    // Writing identical values would wake every tab's content script for nothing
    if (cached && FONT_KEYS.every(k => cached[k] === fonts[k])) return cached;

    await chrome.storage.local.set({ [F.KEYS.fonts]: fonts });
    return fonts;
}

let refreshTimer;
const refreshSoon = () => {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(refresh, 200);
};

// v1 stored "settings" and "browserFonts"; move them to the prefixed keys once
async function migrate() {
    const all = await chrome.storage.local.get([F.KEYS.settings, F.KEYS.fonts, ...F.KEYS.legacy]);
    const [oldSettings, oldFonts] = F.KEYS.legacy.map(k => all[k]);
    const move = {};

    if (oldSettings && !all[F.KEYS.settings]) move[F.KEYS.settings] = oldSettings;
    if (oldFonts && !all[F.KEYS.fonts]) move[F.KEYS.fonts] = oldFonts;

    if (Object.keys(move).length) await chrome.storage.local.set(move);
    await chrome.storage.local.remove(F.KEYS.legacy);
}

chrome.runtime.onInstalled.addListener(async () => {
    await migrate();
    await F.storage.save((await F.storage.load()).settings);       // writes defaults and upgrades old settings
    await refresh();
});

chrome.runtime.onStartup.addListener(() => migrate().then(refresh));

if (chrome.fontSettings) {
    for (const event of ["onFontChanged", "onDefaultFontSizeChanged", "onDefaultFixedFontSizeChanged"]) {
        if (chrome.fontSettings[event]) chrome.fontSettings[event].addListener(refreshSoon);
    }
}

// Editors reveal monospace fonts late; remember them for that site so its next load applies them from the first paint.
// Serialized, because several frames can report at once and storage has no atomic read-modify-write.
let learnChain = Promise.resolve();
const tabLearned = new Map();   // tabId -> { hosts: Set, names: Set, reloaded: boolean }

function setBadge(tabId, active) {
    if (tabId == null || !chrome.action) return;
    try {
        if (active) {
            if (chrome.action.setBadgeBackgroundColor) chrome.action.setBadgeBackgroundColor({ tabId, color: "#EBCB8B" });
            if (chrome.action.setBadgeTextColor) chrome.action.setBadgeTextColor({ tabId, color: "#2E3440" });
            if (chrome.action.setBadgeText) chrome.action.setBadgeText({ tabId, text: "!" });
            if (chrome.action.setTitle) chrome.action.setTitle({ tabId, title: "Respect My Eyes — Reload once to apply your font in code editors" });
        }
        else {
            if (chrome.action.setBadgeText) chrome.action.setBadgeText({ tabId, text: "" });
            if (chrome.action.setTitle) chrome.action.setTitle({ tabId, title: "Respect My Eyes" });
        }
    }
    catch { /* action API unavailable or tab already closed */ }
}

function resetTab(tabId) {
    if (tabId == null) return;
    tabLearned.delete(tabId);
    setBadge(tabId, false);
}

if (chrome.tabs) {
    if (chrome.tabs.onRemoved) chrome.tabs.onRemoved.addListener(tabId => tabLearned.delete(tabId));
    if (chrome.tabs.onUpdated) {
        chrome.tabs.onUpdated.addListener((tabId, info) => {
            if (info && info.status === "loading") resetTab(tabId);
        });
    }
}

function learn(host, names, tabId) {
    learnChain = learnChain.then(async () => {
        const stored = await chrome.storage.local.get([F.KEYS.hints, F.KEYS.settings]);
        const next = F.addHints(stored[F.KEYS.hints], host, names.slice(0, 20));

        if (!next) return;
        await chrome.storage.local.set({ [F.KEYS.hints]: next });

        if (tabId == null) return;
        let entry = tabLearned.get(tabId);
        if (!entry) { entry = { hosts: new Set(), names: new Set(), reloaded: false }; tabLearned.set(tabId, entry); }

        const hostNorm = F.cleanHostList([host])[0];
        if (hostNorm) entry.hosts.add(hostNorm);
        for (const n of F.cleanNameList(names)) entry.names.add(n);
        setBadge(tabId, entry.names.size > 0);

        const settings = F.normalizeSettings(stored[F.KEYS.settings]);
        if (settings.enabled && settings.editors.protect && settings.editors.autoReload && !entry.reloaded && chrome.tabs && chrome.tabs.reload) {
            entry.reloaded = true;
            setTimeout(() => {
                try { Promise.resolve(chrome.tabs.reload(tabId)).catch(() => {}); } catch {}
            }, 120);
        }
    }).catch(() => { /* keep the chain alive */ });

    return learnChain;
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
    const tabId = sender && sender.tab ? sender.tab.id : null;

    if (msg && msg.type === "rme:pageStart" && tabId != null) {
        resetTab(tabId);
        reply && reply(true);
        return;
    }
    if (msg && msg.type === "rme:tabState") {
        const entry = tabLearned.get(msg.tabId);
        reply({ learned: entry ? [...entry.names] : [], hosts: entry ? [...entry.hosts] : [] });
        return;
    }
    if (msg && msg.type === "rme:learn" && typeof msg.host === "string" && Array.isArray(msg.names)) {
        learn(msg.host, msg.names, tabId).then(() => reply(true));
        return true;
    }
    if (msg && msg.type === "rme:refresh") {
        refresh().then(reply, () => reply(null));
        return true;
    }
});
