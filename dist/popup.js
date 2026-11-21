(function () {
    "use strict";

    const F = self.RME;
    const $ = function (id) { return document.getElementById(id); };
    const CAT_NAMES = { sans: "Sans", serif: "Serif", mono: "Mono", ignore: "Icon" };

    let settings, bf, tab, host = "", report = null;

    function el(tag, cls, text) {
        const e = document.createElement(tag);
        if (cls) e.className = cls;
        if (text != null) e.textContent = text;
        return e;
    }

    function save() { return chrome.storage.local.set({ [F.KEYS.settings]: settings }); }

    function toast(message) {
        const box = $("toasts");
        const t = el("div", "toast", message);

        while (box.children.length >= 2) box.firstChild.remove();
        box.appendChild(t);
        setTimeout(function () { t.classList.add("out"); setTimeout(function () { t.remove(); }, 200); }, 2200);
    }

    function needsReload(text) {
        $("bannerText").textContent = text || "Reload the page to apply this.";
        $("banner").hidden = false;
    }

    function openSettings(hash) {
        chrome.tabs.create({ url: chrome.runtime.getURL("options.html") + (hash || "") });
        window.close();
    }

    // -----------------------------------------------------------------------------------------------------------------

    function renderFonts() {
        const r = F.resolveFonts(settings, bf);
        const box = $("fonts");
        box.innerHTML = "";

        F.CATS.forEach(function (cat) {
            const item = el("button", "font-item");
            item.type = "button";
            item.title = "Change in settings";

            const face = el("span", "face", r.fonts[cat].name);
            face.style.fontFamily = F.familyValue(cat, r.fonts);

            const badge = el("span", "badge " + r.fonts[cat].source, r.fonts[cat].source === "browser" ? "Browser" : r.fonts[cat].source === "custom" ? "Custom" : "Default");

            item.append(el("span", "kind", F.CAT_LABEL[cat]), face, badge);
            item.onclick = function () { openSettings("#fonts"); };
            box.appendChild(item);
        });
    }

    function matchingEntries(h) {
        return settings.excludedSites.filter(function (x) { return h === x || h.endsWith("." + x); });
    }

    function renderSite() {
        const site = $("site");
        site.hidden = !host;
        if (!host) return;

        const on = matchingEntries(host).length === 0;

        $("host").textContent = host;
        $("host").title = host;
        $("siteHint").textContent = on ? "Fonts are replaced here" : "Paused on this site";
        $("siteOn").checked = on;
        $("siteOn").onchange = async function () {
            if (this.checked) {
                const drop = new Set(matchingEntries(host));
                settings.excludedSites = settings.excludedSites.filter(function (x) { return !drop.has(x); });
            }
            else {
                settings.excludedSites.push(host);
                needsReload("Reload the page to see its original fonts.");
            }
            await save();
            renderSite();
        };
    }

    function segmented(box, options, value, onChange) {
        options.forEach(function (o) {
            const b = el("button", "", o[1]);
            b.type = "button";
            b.setAttribute("role", "radio");
            b.setAttribute("aria-checked", String(o[0] === value));
            b.onclick = function () {
                Array.prototype.forEach.call(box.children, function (c) { c.setAttribute("aria-checked", String(c === b)); });
                onChange(o[0]);
            };
            box.appendChild(b);
        });
    }

    // Fonts nobody could classify: one card each, pick a category and add
    function renderUnknown() {
        const box = $("unknown");
        box.innerHTML = "";

        const list = report && report.active ? report.unknown : [];
        $("attention").hidden = !list.length;

        list.forEach(function (u) {
            let category = "sans";
            const card = el("div", "card2");
            const top = el("div", "top");
            const name = el("span", "name", u.name);
            name.title = u.name;
            top.append(name, el("span", "hint", u.count === 1 ? "1 element" : u.count + " elements"));

            const seg = el("div", "seg");
            seg.setAttribute("role", "radiogroup");
            seg.setAttribute("aria-label", "Category of " + u.name);
            segmented(seg, [["sans", "Sans"], ["serif", "Serif"], ["mono", "Mono"], ["ignore", "Icon"]], category, function (v) { category = v; });

            const add = el("button", "primary sm", "Add");
            add.type = "button";
            add.onclick = async function () {
                settings.manualFonts = F.cleanManual(settings.manualFonts.concat([{ name: u.name, category: category }]));
                await save();

                card.classList.add("gone");
                setTimeout(function () { card.remove(); if (!box.children.length) $("attention").hidden = true; }, 180);

                toast("Added \u201c" + u.name + "\u201d as " + CAT_NAMES[category].toLowerCase());
                if (category === "ignore") needsReload("Reload the page to bring the icon font back.");
            };

            const bottom = el("div", "bottom");
            bottom.append(seg, add);
            card.append(top, bottom);
            box.appendChild(card);
        });
    }

    // Editors found on this page (named, with a switch each) and monospace fonts they were already using
    function renderEditors() {
        const box = $("editors");
        box.innerHTML = "";

        const eds = report && report.active ? report.editors : [];
        const late = report && report.active ? report.deferred : [];

        $("editorsBox").hidden = !eds.length && !late.length;

        if (eds.length && !report.protect) {
            const row = el("div", "ed");
            const text = el("div", "text");
            text.append(el("div", "", "Editor protection is off"), el("div", "hint", "Turn it on so editors keep their own font metrics."));
            const on = el("button", "primary sm", "Turn on");
            on.type = "button";
            on.onclick = async function () { settings.editors.protect = true; await save(); on.disabled = true; row.remove(); needsReload("Reload the page to apply this."); };
            row.append(text, on);
            box.appendChild(row);
        }
        else {
            eds.forEach(function (ed) {
                const row = el("div", "ed");
                const text = el("div", "text");
                const code = el("code", "", ed.sample);
                code.title = ed.sample;
                text.append(code, el("div", "hint", ed.selector + (ed.count > 1 ? " \u00d7" + ed.count : "")));

                const sw = el("label", "switch");
                sw.title = "Protect this editor from font changes";
                const input = el("input");
                input.type = "checkbox";
                input.checked = ed.enabled;
                input.setAttribute("aria-label", "Protect " + ed.sample);
                input.onchange = async function () {
                    const off = new Set(settings.editors.off);
                    input.checked ? off.delete(ed.selector) : off.add(ed.selector);
                    settings.editors.off = Array.from(off);
                    await save();
                    needsReload(input.checked ? "Reload the page to apply this." : "Reload the page for a clean result.");
                };
                sw.append(input, el("span"));

                row.append(text, sw);
                box.appendChild(row);
            });
        }

        late.forEach(function (name) {
            const row = el("div", "ed");
            const text = el("div", "text");
            text.append(el("div", "", name), el("div", "hint", report.learned ? "Already in use by an editor. Remembered, applied after reload." : "Already in use by an editor, so left as is."));

            if (report.learned) { row.append(text, el("span", "badge browser", "Remembered")); box.appendChild(row); return; }

            const b = el("button", "primary sm", "Remember");
            b.type = "button";
            b.onclick = async function () {
                settings.manualFonts = F.cleanManual(settings.manualFonts.concat([{ name: name, category: "mono" }]));
                await save();
                b.replaceWith(el("span", "badge browser", "Remembered"));
                needsReload("Reload the page to apply it from the first paint.");
            };
            row.append(text, b);
            box.appendChild(row);
        });

        if (late.length && report.learned) needsReload("Reload the page to apply remembered fonts.");
    }

    async function main() {
        const data = await chrome.storage.local.get([F.KEYS.settings, F.KEYS.fonts]);
        settings = F.normalizeSettings(data[F.KEYS.settings]);
        bf = data[F.KEYS.fonts];

        const master = function () { $("app").classList.toggle("off", !settings.enabled); };

        $("enabled").checked = settings.enabled;
        master();
        $("enabled").onchange = async function () {
            settings.enabled = this.checked;
            await save();
            master();
            if (!this.checked) needsReload("Reload the page to restore its original fonts.");
        };
        $("options").onclick = function () { openSettings(""); };
        $("reload").onclick = function () { if (tab) chrome.tabs.reload(tab.id); window.close(); };

        renderFonts();

        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        tab = tabs[0];

        try { report = tab ? await chrome.tabs.sendMessage(tab.id, { type: "rme:report" }, { frameId: 0 }) : null; }
        catch (e) { report = null; }

        let url = null;
        try { url = new URL(tab.url); } catch (e) { /* no access to the url */ }
        const web = !!url && /^https?:$/.test(url.protocol);

        if (report) host = report.host;
        else if (web) host = url.hostname;

        if (!report) {
            $("note").hidden = false;

            if (web) {   // a tab that was open before the extension was installed or updated
                $("note").textContent = "The extension is not running on this page yet.";
                needsReload("Reload the page to start it.");
            }
            else $("note").textContent = "Browser pages and the Web Store can't be changed by extensions.";
        }

        renderSite();
        renderUnknown();
        renderEditors();
    }

    main();
})();
