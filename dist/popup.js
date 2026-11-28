(() => {
    "use strict";

    const F = self.RME;
    const { $, el, segmented, bindSwitch, toast, applyFonts, refreshBrowserFonts, animDelay } = F.ui;

    const SITE_CATS = [["sans", "Sans"], ["serif", "Serif"], ["mono", "Mono"], ["ignore", "Icon"]];
    const BROWSER_STORES = new Set(["chromewebstore.google.com", "microsoftedge.microsoft.com"]);
    const UNKNOWN_PREVIEW = 4, UNKNOWN_FILTER_FROM = 6, MAX_UNKNOWN = 30, MAX_LIVE_ADDS = 30, LIVE_POLL_MS = 1200;

    let settings, bf, tab, host = "", report = null, baseBanner = "", lastTabLearned = [];
    let unknownList = [], unknownExpanded = false, unknownInitialized = false, liveAddedCount = 0;
    let pollTimer = 0, liveBusy = false, stopped = false, lastSiteSig = "", lastEditorsSig = "";
    const unknownCards = new Map();

    const save = () => F.storage.save(settings);
    const setSiteFlag = (list, active) => {
        const next = list.filter(x => host !== x && !host.endsWith(`.${x}`));
        if (!active) next.push(host);
        return next;
    };

    function needsReload(text = "Reload to apply changes.", persist = false) {
        if (persist) baseBanner = text;
        $("bannerText").textContent = text;
        $("banner").hidden = false;
    }

    function restoreBanner() {
        if (baseBanner) needsReload(baseBanner);
        else $("banner").hidden = true;
    }

    function openSettings(hash = "") {
        chrome.tabs.create({ url: chrome.runtime.getURL("options.html") + hash });
        window.close();
    }

    const sourceLabel = { browser: "Browser", custom: "Custom", default: "Default" };

    function renderFonts() {
        const { fonts } = F.resolveFonts(settings, bf);

        $("fonts").replaceChildren(...F.CATS.map(cat => {
            const face = el("span", "face", fonts[cat].name);
            face.style.fontFamily = F.familyValue(cat, fonts);

            const item = el("button", "font-item", null, { type: "button", title: "Change in settings", onclick: () => openSettings("#fonts") });
            item.append(el("span", "kind", F.CAT_LABEL[cat]), face, el("span", `badge ${fonts[cat].source}`, sourceLabel[fonts[cat].source]));
            return item;
        }));
    }

    // The switch only makes sense where the extension actually runs: not on browser pages or web stores, and not while
    // it is off. An excluded site keeps it, so it can be turned back on.
    function renderSite() {
        const show = !!(report && host && (report.active || report.reason === "excluded"));
        const on = show && !F.isExcluded(host, settings.excludedSites);
        const sig = `${show}|${host}|${on}`;
        if (sig === lastSiteSig) return;
        lastSiteSig = sig;

        $("site").hidden = !show;
        if (!show) return;

        $("host").textContent = host;
        $("host").title = host;
        $("siteHint").textContent = on ? "Fonts are replaced here" : "Paused on this site";

        bindSwitch("siteOn", on, async enable => {
            settings.excludedSites = setSiteFlag(settings.excludedSites, enable);
            if (!enable) needsReload("Reload to restore original fonts.");
            else restoreBanner();
            await save();
            renderSite();
        });
    }

    const formatCount = n => n === 1 ? "1 element" : `${n} elements`;
    const manualSet = () => new Set((settings.manualFonts || []).map(f => F.norm(f.name)));

    function getUnknownCard(item) {
        const cached = unknownCards.get(item.key);
        if (cached) {
            const label = formatCount(item.count);
            if (cached.countEl.textContent !== label) cached.countEl.textContent = label;
            return cached.card;
        }

        const { name, key } = item;
        let category = "sans";

        const seg = el("div", "seg", null, { role: "radiogroup", "aria-label": `Category of ${name}` });
        segmented(seg, SITE_CATS, category, v => { category = v; });

        const card = el("div", "card2");
        const countEl = el("span", "hint", formatCount(item.count));
        const add = el("button", "primary sm", "Add", {
            type: "button",
            async onclick() {
                const idx = settings.manualFonts.findIndex(f => F.norm(f.name) === key);
                if (idx === -1 && settings.manualFonts.length >= 500) {
                    toast("Font list limit (500) reached");
                    return;
                }
                const next = idx > -1
                    ? settings.manualFonts.map((f, i) => i === idx ? { name: f.name, category } : f)
                    : [...settings.manualFonts, { name, category }];
                settings.manualFonts = F.cleanManual(next);
                await save();

                unknownList = unknownList.filter(f => f.key !== key);
                unknownCards.delete(key);
                const finishRemove = () => drawUnknown();
                const delay = animDelay(160);
                if (!delay) finishRemove();
                else { card.classList.add("gone"); setTimeout(finishRemove, delay); }

                toast(`Added \u201c${name}\u201d as ${SITE_CATS.find(c => c[0] === category)[1].toLowerCase()}`);
                if (category === "ignore") needsReload("Reload to restore icon font.", true);
            }
        });

        const top = el("div", "top");
        top.append(el("span", "name", name, { title: name }), countEl);
        const bottom = el("div", "bottom");
        bottom.append(seg, add);
        card.append(top, bottom);

        unknownCards.set(key, { card, countEl });
        return card;
    }

    function drawUnknown() {
        const total = unknownList.length;
        $("attention").hidden = !total;
        if (!total) { $("unknown").replaceChildren(); return; }

        const filter = $("unknownFilter");
        filter.hidden = total < UNKNOWN_FILTER_FROM;
        if (filter.hidden) filter.value = "";

        const query = filter.hidden ? "" : filter.value.trim().toLowerCase();
        const matches = query ? unknownList.filter(f => f.name.toLowerCase().includes(query)) : unknownList;
        $("unknownCount").textContent = query ? `${matches.length} of ${total}` : String(total);
        const visible = query || unknownExpanded ? matches : matches.slice(0, UNKNOWN_PREVIEW);
        const hiddenCount = matches.length - visible.length;

        const nextNodes = visible.length ? visible.map(getUnknownCard) : [el("div", "empty", "No matching fonts.")];
        const cur = $("unknown").children;
        const sameOrder = cur.length === nextNodes.length && nextNodes.every((n, i) => cur[i] === n);
        if (!sameOrder) $("unknown").replaceChildren(...nextNodes);

        const more = $("unknownMore");
        const canToggle = !query && (hiddenCount > 0 || (unknownExpanded && matches.length > UNKNOWN_PREVIEW));
        more.hidden = !canToggle;
        if (canToggle) more.textContent = unknownExpanded ? "Show fewer" : `Show ${hiddenCount} more`;
    }

    // Merge incoming unclassified fonts without shifting or dropping existing items (append-only, session-capped)
    function mergeUnknown(incoming) {
        if (!Array.isArray(incoming)) return false;
        const manual = manualSet();
        const byKey = new Map(unknownList.map(x => [x.key, x]));
        let changed = false;

        for (const raw of incoming) {
            if (!raw || typeof raw.name !== "string") continue;
            const name = raw.name.trim().slice(0, 200);
            const key = name ? F.norm(name) : "";
            if (!key || manual.has(key)) continue;

            const count = Number.isFinite(raw.count) && raw.count > 0 ? Math.min(Math.floor(raw.count), 1e7) : 1;
            const existing = byKey.get(key);
            if (existing) {
                if (count > existing.count) { existing.count = count; changed = true; }
                continue;
            }
            if (unknownList.length >= MAX_UNKNOWN) continue;
            if (unknownInitialized && liveAddedCount >= MAX_LIVE_ADDS) continue;

            const entry = { key, name, count };
            unknownList.push(entry);
            byKey.set(key, entry);
            if (unknownInitialized) liveAddedCount++;
            changed = true;
        }
        unknownInitialized = true;
        return changed;
    }

    function resetUnknown() {
        unknownList = [];
        unknownCards.clear();
        unknownExpanded = false;
        unknownInitialized = false;
        liveAddedCount = 0;
        $("unknownFilter").value = "";
        drawUnknown();
    }

    // Fonts nobody could classify: prioritized preview with search & expand when a site has many
    function renderUnknown() {
        resetUnknown();
        if (report && report.active) {
            mergeUnknown(report.unknown);
            drawUnknown();
        }
    }

    const row = (text, trailing) => {
        const node = el("div", "ed");
        node.append(text, ...trailing);
        return node;
    };

    // Code editors found on the page, named by element, with one switch for the whole site. Monospace fonts they were
    // already using stay untouched until the next load (they are remembered automatically).
    function renderEditors(tabLearned = []) {
        const active = !!(report && report.active);
        const editors = active && Array.isArray(report.editors) ? report.editors.slice(0, 6) : [];
        const late = F.cleanNameList([...(active && Array.isArray(report.deferred) ? report.deferred : []), ...tabLearned]).slice(0, 24);
        const protectOn = settings.editors.protect;
        const autoReload = settings.editors.autoReload;
        const siteOff = !!(active && report.siteOff);
        const show = !!(editors.length || late.length || siteOff);

        const sig = show
            ? `${protectOn}|${autoReload}|${siteOff}|${editors.map(e => `${e.sample}:${e.count}`).join(",")}|${late.join(",")}`
            : "hidden";
        if (sig === lastEditorsSig) return;
        const hadLate = lastEditorsSig && lastEditorsSig !== "hidden" && !lastEditorsSig.endsWith("|");
        lastEditorsSig = sig;

        $("editorsBox").hidden = !show;
        if (!show) return;

        bindSwitch("edSwitch", !siteOff && protectOn, async protect => {
            settings.editors.offSites = setSiteFlag(settings.editors.offSites, protect);
            await save();
            needsReload(protect ? "Reload to protect editors." : "Reload to apply change.", true);
        });
        $("edSwitch").disabled = !protectOn;

        if ($("edAutoRow")) {
            $("edAutoRow").hidden = !protectOn;
            bindSwitch("edAutoReload", autoReload, async auto => {
                settings.editors.autoReload = auto;
                await save();
                toast(auto ? "Auto-reload on for new editors" : "Auto-reload off");
            });
        }

        const text = (main, hint) => {
            const box = el("div", "text");
            box.append(main, ...(hint ? [el("div", "hint", hint)] : []));
            return box;
        };

        $("editors").replaceChildren(
            ...(protectOn ? [] : [el("div", "hint", "Editor protection is off in Settings.")]),
            ...editors.map(({ sample, count }) => row(text(el("code", "", sample, { title: sample })), count > 1 ? [el("span", "hint", `\u00d7${count}`)] : [])),
            ...late.map(name => row(text(el("div", "name", name, { title: name })), [el("span", "badge browser", "Remembered")]))
        );

        if (late.length && !hadLate) needsReload("Reload once to use your font in editors.", true);
    }

    // Where the extension cannot run, and what to tell the user
    function explainNoReport(url) {
        const web = !!url && /^https?:$/.test(url.protocol) && !BROWSER_STORES.has(url.hostname) &&
            !(url.hostname === "chrome.google.com" && url.pathname.startsWith("/webstore"));

        $("note").hidden = false;

        if (web) {      // a tab that was open before the extension was installed, enabled, or updated
            $("note").textContent = "Extension not running yet \u2014 fonts replace after reload.";
            needsReload("Reload this page to start.", true);
        }
        else $("note").textContent = "Browser pages and the Web Store can't be changed.";

        return web ? url.hostname : "";
    }

    async function fetchTabInfo(live = false) {
        if (!tab) return { rep: null, state: null };
        const [rep, state] = await Promise.all([
            chrome.tabs.sendMessage(tab.id, live ? { type: "rme:report", live: true } : { type: "rme:report" }, { frameId: 0 }).catch(() => null),
            F.ui.send({ type: "rme:tabState", tabId: tab.id }).catch(() => null)
        ]);
        return { rep, state };
    }

    async function refreshLive() {
        if (stopped || !tab || liveBusy || (typeof document.hidden === "boolean" && document.hidden)) return;
        liveBusy = true;
        try {
            const { rep, state } = await fetchTabInfo(true);
            if (stopped) return;
            if (state && Array.isArray(state.learned)) lastTabLearned = state.learned;

            if (rep) {
                const hadNoReport = !report;
                const hostChanged = !!(host && rep.host && rep.host !== host);
                report = rep;

                if (hadNoReport || hostChanged) {
                    $("note").hidden = true;
                    if (hadNoReport && baseBanner === "Reload this page to start.") {
                        baseBanner = "";
                        restoreBanner();
                    }
                    host = rep.host || host;
                    lastSiteSig = "";
                    lastEditorsSig = "";
                    renderSite();
                    renderUnknown();
                    renderEditors(lastTabLearned);
                }
                else if (rep.active) {
                    renderSite();
                    if (mergeUnknown(rep.unknown)) drawUnknown();
                    renderEditors(lastTabLearned);
                }
                else if (settings.enabled) {
                    renderSite();
                    if (unknownList.length) resetUnknown();
                    renderEditors(lastTabLearned);
                }
            }
            else if (lastTabLearned.length) {
                renderEditors(lastTabLearned);
            }
        }
        finally {
            liveBusy = false;
        }
    }

    function schedulePoll() {
        clearTimeout(pollTimer);
        if (stopped || !tab || (typeof document.hidden === "boolean" && document.hidden)) return;
        pollTimer = setTimeout(async () => {
            await refreshLive();
            schedulePoll();
        }, LIVE_POLL_MS);
    }

    function stopPolling() {
        stopped = true;
        clearTimeout(pollTimer);
        pollTimer = 0;
    }

    window.addEventListener("pagehide", stopPolling);
    window.addEventListener("unload", stopPolling);
    document.addEventListener("visibilitychange", () => {
        if (document.hidden) clearTimeout(pollTimer);
        else if (!stopped && tab) { refreshLive().then(schedulePoll); }
    });

    async function main() {
        ({ settings, bf } = await F.storage.load());
        applyFonts(settings, bf);

        const initialEnabled = settings.enabled;
        bindSwitch("enabled", settings.enabled, async on => {
            settings.enabled = on;
            await save();
            $("app").classList.toggle("off", !on);
            if (!on) needsReload("Reload to restore original fonts.");
            else if (!initialEnabled) needsReload("Reload to apply your fonts.");
            else restoreBanner();
        });
        $("app").classList.toggle("off", !settings.enabled);
        $("options").onclick = () => openSettings();
        $("unknownFilter").oninput = drawUnknown;
        $("unknownMore").onclick = () => { unknownExpanded = !unknownExpanded; drawUnknown(); };
        $("reload").onclick = async () => {
            const target = tab || (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
            if (target) {
                try { await chrome.tabs.reload(target.id); } catch {}
            }
            stopPolling();
            window.close();
        };

        renderFonts();

        if (!bf) {
            const fresh = await refreshBrowserFonts();
            if (fresh) {
                bf = fresh;
                applyFonts(settings, bf);
                renderFonts();
            }
        }

        [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

        try {
            const { rep, state } = await fetchTabInfo(false);
            report = rep;
            if (state && Array.isArray(state.learned)) lastTabLearned = state.learned;
        }
        catch { report = null; }

        if (report) host = report.host;
        else {
            let url = null;
            try { url = new URL(tab && (tab.url || tab.pendingUrl)); } catch { /* no access to the url */ }
            host = explainNoReport(url);
        }

        renderSite();
        renderUnknown();
        renderEditors(lastTabLearned);
        schedulePoll();
    }

    F.storage.onChange(changes => {
        if (changes[F.KEYS.fonts]) bf = changes[F.KEYS.fonts].newValue;
        if (changes[F.KEYS.settings]) settings = F.normalizeSettings(changes[F.KEYS.settings].newValue);
        if (settings) {
            applyFonts(settings, bf);
            renderFonts();
            $("enabled").checked = settings.enabled;
            $("app").classList.toggle("off", !settings.enabled);

            const manual = manualSet();
            const before = unknownList.length;
            unknownList = unknownList.filter(f => {
                if (!manual.has(f.key)) return true;
                unknownCards.delete(f.key);
                return false;
            });
            if (unknownList.length !== before) drawUnknown();

            if (report !== null || host) {
                lastSiteSig = "";
                lastEditorsSig = "";
                renderSite();
                renderEditors(lastTabLearned);
            }
        }
    });

    main();
})();
