(() => {
    "use strict";

    const F = self.RME;
    const { $, el, segmented, bindSwitch, toast } = F.ui;

    const SITE_CATS = [["sans", "Sans"], ["serif", "Serif"], ["mono", "Mono"], ["ignore", "Icon"]];
    const BROWSER_STORES = new Set(["chromewebstore.google.com", "microsoftedge.microsoft.com"]);
    const matches = (host, list) => list.filter(x => host === x || host.endsWith(`.${x}`));

    let settings, bf, tab, host = "", report = null;

    const save = () => F.storage.save(settings);

    function needsReload(text = "Reload the page to apply this.") {
        $("bannerText").textContent = text;
        $("banner").hidden = false;
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

        const on = !matches(host, settings.excludedSites).length;

        $("host").textContent = host;
        $("host").title = host;
        $("siteHint").textContent = on ? "Fonts are replaced here" : "Paused on this site";

        bindSwitch("siteOn", on, async enable => {
            const drop = new Set(matches(host, settings.excludedSites));

            settings.excludedSites = settings.excludedSites.filter(x => !drop.has(x));
            if (!enable) {
                settings.excludedSites.push(host);
                needsReload("Reload the page to see its original fonts.");
            }
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
                    settings.manualFonts = F.cleanManual([...settings.manualFonts, { name, category }]);
                    await save();

                    card.classList.add("gone");
                    setTimeout(() => { card.remove(); $("attention").hidden = !$("unknown").children.length; }, 180);

                    toast(`Added \u201c${name}\u201d as ${SITE_CATS.find(c => c[0] === category)[1].toLowerCase()}`);
                    if (category === "ignore") needsReload("Reload the page to bring the icon font back.");
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
    function renderEditors() {
        const active = !!(report && report.active);
        const editors = active ? report.editors : [];
        const late = active ? report.deferred : [];

        $("editorsBox").hidden = !(editors.length || late.length || (active && report.siteOff));
        if ($("editorsBox").hidden) return;

        const { editors: protection } = settings;

        bindSwitch("edSwitch", !report.siteOff && protection.protect, async protect => {
            const drop = new Set(matches(host, protection.offSites));

            protection.offSites = protection.offSites.filter(x => !drop.has(x));
            if (!protect) protection.offSites.push(host);

            await save();
            needsReload(protect ? "Reload the page to protect its editors." : "Reload the page for a clean result.");
        });
        $("edSwitch").disabled = !protection.protect;

        const text = (main, hint) => {
            const box = el("div", "text");
            box.append(main, ...(hint ? [el("div", "hint", hint)] : []));
            return box;
        };

        $("editors").replaceChildren(
            ...(protection.protect ? [] : [el("div", "hint", "Editor protection is off in Settings.")]),
            ...editors.map(({ sample, count }) => row(text(el("code", "", sample, { title: sample })), count > 1 ? [el("span", "hint", `\u00d7${count}`)] : [])),
            ...late.map(name => row(text(el("div", "", name), "Already in use by an editor. Applied after a reload."), [el("span", "badge browser", "Remembered")]))
        );

        if (late.length) needsReload("Reload the page to apply remembered fonts.");
    }

    // Where the extension cannot run, and what to tell the user
    function explainNoReport(url) {
        const web = !!url && /^https?:$/.test(url.protocol) && !BROWSER_STORES.has(url.hostname) &&
            !(url.hostname === "chrome.google.com" && url.pathname.startsWith("/webstore"));

        $("note").hidden = false;

        if (web) {      // a tab that was open before the extension was installed or updated
            $("note").textContent = "The extension is not running on this page yet.";
            needsReload("Reload the page to start it.");
        }
        else $("note").textContent = "Browser pages and the Web Store can't be changed by extensions.";

        return web ? url.hostname : "";
    }

    async function main() {
        ({ settings, bf } = await F.storage.load());

        bindSwitch("enabled", settings.enabled, async on => {
            settings.enabled = on;
            await save();
            $("app").classList.toggle("off", !on);
            if (!on) needsReload("Reload the page to restore its original fonts.");
        });
        $("app").classList.toggle("off", !settings.enabled);
        $("options").onclick = () => openSettings();
        $("reload").onclick = () => { if (tab) chrome.tabs.reload(tab.id); window.close(); };

        renderFonts();

        [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

        try { report = tab ? await chrome.tabs.sendMessage(tab.id, { type: "rme:report" }, { frameId: 0 }) : null; }
        catch { report = null; }

        if (report) host = report.host;
        else {
            let url = null;
            try { url = new URL(tab.url); } catch { /* no access to the url */ }
            host = explainNoReport(url);
        }

        renderSite();
        renderUnknown();
        renderEditors();
    }

    main();
})();
