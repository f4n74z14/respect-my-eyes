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
    if (oldSettings !== undefined || oldFonts !== undefined) await chrome.storage.local.remove(F.KEYS.legacy);
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
const MAX_TAB_HOSTS = 8;
const MAX_TAB_LEARNS = 20;
const MAX_TRACKED_TABS = 500;

let learnChain = Promise.resolve();
const tabLearned = new Map();   // tabId -> { hosts: Set, names: Set, learns: number, reloaded: boolean }

const callQuiet = (fn, arg) => {
    if (!fn) return;
    try { Promise.resolve(fn(arg)).catch(() => {}); } catch {}
};

function setBadge(tabId, active) {
    if (tabId == null || !chrome.action) return;
    if (active) {
        callQuiet(chrome.action.setBadgeBackgroundColor, { tabId, color: "#EBCB8B" });
        callQuiet(chrome.action.setBadgeTextColor, { tabId, color: "#2E3440" });
        callQuiet(chrome.action.setBadgeText, { tabId, text: "!" });
        callQuiet(chrome.action.setTitle, { tabId, title: "Respect My Eyes \u2014 Reload to apply font in editors" });
    }
    else {
        callQuiet(chrome.action.setBadgeText, { tabId, text: "" });
        callQuiet(chrome.action.setTitle, { tabId, title: "Respect My Eyes" });
    }
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

function verifiedLearnHost(rawHost, sender) {
    const host = F.cleanHostList([rawHost])[0];
    if (!host) return "";
    const originUrl = sender && (sender.origin || sender.url);
    if (typeof originUrl === "string") {
        if (originUrl === "null") return "";
        try {
            let protocol = "", hostname = "";
            if (typeof URL !== "undefined") {
                const u = new URL(originUrl);
                protocol = u.protocol;
                hostname = u.hostname;
            } else {
                const m = /^([a-z][a-z0-9+.-]*:)\/\/([^\/?#]+)/i.exec(originUrl.trim());
                if (!m) return "";
                protocol = m[1].toLowerCase();
                hostname = m[2].replace(/^.*@/, "").replace(/:\d+$/, "");
            }
            if (protocol !== "http:" && protocol !== "https:") return "";
            const senderHost = F.cleanHostList([hostname])[0];
            if (!senderHost || senderHost !== host) return "";
        }
        catch { return ""; }
    }
    return host;
}

function getTabEntry(tabId) {
    let entry = tabLearned.get(tabId);
    if (!entry) {
        if (tabLearned.size >= MAX_TRACKED_TABS) tabLearned.delete(tabLearned.keys().next().value);
        entry = { hosts: new Set(), names: new Set(), learns: 0, reloaded: false };
        tabLearned.set(tabId, entry);
    }
    return entry;
}

function learn(host, names, tabId) {
    const cleanNames = F.cleanNameList(names.filter(n => typeof n === "string").slice(0, 24));
    if (!cleanNames.length) return Promise.resolve();

    learnChain = learnChain.then(async () => {
        if (tabId != null) {
            const entry = getTabEntry(tabId);
            if (entry.learns >= MAX_TAB_LEARNS || (!entry.hosts.has(host) && entry.hosts.size >= MAX_TAB_HOSTS)) return;
            if (entry.hosts.has(host) && cleanNames.every(n => entry.names.has(n))) return;
            entry.learns++;
            entry.hosts.add(host);
            for (const n of cleanNames) entry.names.add(n);
            setBadge(tabId, entry.names.size > 0);
        }

        const stored = await chrome.storage.local.get([F.KEYS.hints, F.KEYS.settings]);
        const next = F.addHints(stored[F.KEYS.hints], host, cleanNames.slice(0, 20));
        if (next) await chrome.storage.local.set({ [F.KEYS.hints]: next });

        if (tabId == null) return;
        const entry = tabLearned.get(tabId);
        if (!entry) return;

        const raw = stored[F.KEYS.settings];
        const ed = raw && typeof raw === "object" && raw.editors && typeof raw.editors === "object" ? raw.editors : null;
        if ((!raw || raw.enabled !== false) && ed && ed.protect !== false && ed.autoReload === true &&
            !F.isExcluded(host, F.cleanHostList(ed.offSites)) && !entry.reloaded && chrome.tabs && chrome.tabs.reload) {
            entry.reloaded = true;
            setTimeout(() => {
                if (tabLearned.get(tabId) !== entry) return;
                callQuiet(chrome.tabs.reload, tabId);
            }, 120);
        }
    }).catch(() => { /* keep the chain alive */ });

    return learnChain;
}

const safeReply = (reply, value) => {
    if (!reply) return;
    try { reply(value); } catch {}
};

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
    if (!msg || typeof msg !== "object") return;
    const tabId = sender && sender.tab ? sender.tab.id : null;
    const isTopFrame = sender && (sender.frameId == null || sender.frameId === 0);

    if (msg.type === "rme:pageStart" && tabId != null && isTopFrame) {
        resetTab(tabId);
        safeReply(reply, true);
        return;
    }
    if (msg.type === "rme:tabState" && !(sender && sender.tab)) {
        const entry = typeof msg.tabId === "number" ? tabLearned.get(msg.tabId) : null;
        safeReply(reply, { learned: entry ? [...entry.names] : [], hosts: entry ? [...entry.hosts] : [] });
        return;
    }
    if (msg.type === "rme:learn" && typeof msg.host === "string" && Array.isArray(msg.names)) {
        const host = verifiedLearnHost(msg.host, sender);
        if (!host) return;
        learn(host, msg.names, tabId).then(() => safeReply(reply, true));
        return true;
    }
    if (msg.type === "rme:refresh" && !(sender && sender.tab)) {
        refresh().then(res => safeReply(reply, res), () => safeReply(reply, null));
        return true;
    }
});
