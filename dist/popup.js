(() => {
    "use strict";

    const F = self.RME;
    const { $, el, segmented, bindSwitch, toast, applyFonts, refreshBrowserFonts } = F.ui;

    const SITE_CATS = [["sans", "Sans"], ["serif", "Serif"], ["mono", "Mono"], ["ignore", "Icon"]];
    const BROWSER_STORES = new Set(["chromewebstore.google.com", "microsoftedge.microsoft.com"]);

    let settings, bf, tab, host = "", report = null, baseBanner = "", lastTabLearned = [];

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
        $("site").hidden = !(report && host && (report.active || report.reason === "excluded"));
        if ($("site").hidden) return;

        const on = !F.isExcluded(host, settings.excludedSites);

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

    // Fonts nobody could classify: one card each, pick a category and add
    function renderUnknown() {
        const list = report && report.active ? report.unknown : [];

        $("attention").hidden = !list.length;
        $("unknown").replaceChildren(...list.map(({ name, count }) => {
            let category = "sans";

            const seg = el("div", "seg", null, { role: "radiogroup", "aria-label": `Category of ${name}` });
            segmented(seg, SITE_CATS, category, v => { category = v; });

            const card = el("div", "card2");
            const add = el("button", "primary sm", "Add", {
                type: "button",
                async onclick() {
                    const key = F.norm(name);
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

                    card.classList.add("gone");
                    setTimeout(() => { card.remove(); $("attention").hidden = !$("unknown").children.length; }, 180);

                    toast(`Added \u201c${name}\u201d as ${SITE_CATS.find(c => c[0] === category)[1].toLowerCase()}`);
                    if (category === "ignore") needsReload("Reload to restore icon font.", true);
                }
            });

            const top = el("div", "top");
            top.append(el("span", "name", name, { title: name }), el("span", "hint", count === 1 ? "1 element" : `${count} elements`));
            const bottom = el("div", "bottom");
            bottom.append(seg, add);
            card.append(top, bottom);
            return card;
        }));
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
        const editors = active ? report.editors : [];
        const late = F.cleanNameList([...(active ? report.deferred : []), ...tabLearned]);

        $("editorsBox").hidden = !(editors.length || late.length || (active && report.siteOff));
        if ($("editorsBox").hidden) return;

        const protectOn = settings.editors.protect;

        bindSwitch("edSwitch", !report.siteOff && protectOn, async protect => {
            settings.editors.offSites = setSiteFlag(settings.editors.offSites, protect);
            await save();
            needsReload(protect ? "Reload to protect editors." : "Reload to apply change.", true);
        });
        $("edSwitch").disabled = !protectOn;

        if ($("edAutoRow")) {
            $("edAutoRow").hidden = !protectOn;
            bindSwitch("edAutoReload", settings.editors.autoReload, async auto => {
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

        if (late.length) needsReload("Reload once to use your font in editors.", true);
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
        $("reload").onclick = async () => {
            const target = tab || (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
            if (target) {
                try { await chrome.tabs.reload(target.id); } catch {}
            }
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
            const [rep, state] = await Promise.all([
                tab ? chrome.tabs.sendMessage(tab.id, { type: "rme:report" }, { frameId: 0 }).catch(() => null) : null,
                tab ? F.ui.send({ type: "rme:tabState", tabId: tab.id }).catch(() => null) : null
            ]);
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
    }

    F.storage.onChange(changes => {
        if (changes[F.KEYS.fonts]) bf = changes[F.KEYS.fonts].newValue;
        if (changes[F.KEYS.settings]) settings = F.normalizeSettings(changes[F.KEYS.settings].newValue);
        if (settings) {
            applyFonts(settings, bf);
            renderFonts();
            $("enabled").checked = settings.enabled;
            $("app").classList.toggle("off", !settings.enabled);
            if (report !== null || host) {
                renderSite();
                renderEditors(lastTabLearned);
            }
        }
    });

    main();
})();
