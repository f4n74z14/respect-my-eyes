(function () {
    "use strict";

    const F = self.RME;
    const $ = function (id) { return document.getElementById(id); };

    let settings, bf, tab, host = "";

    function save() {
        return chrome.storage.local.set({ [F.KEYS.settings]: settings });
    }

    function say(text) { $("msg").textContent = text; }

    function matchingEntries(h) {
        return settings.excludedSites.filter(function (x) { return h === x || h.endsWith("." + x); });
    }

    function renderFonts() {
        const r = F.resolveFonts(settings, bf);
        const t = $("fonts");
        t.innerHTML = "";

        F.CATS.forEach(function (cat) {
            const tr = document.createElement("tr");
            const a = document.createElement("td"), b = document.createElement("td");
            const badge = document.createElement("span");

            a.textContent = F.CAT_LABEL[cat];
            b.textContent = r.fonts[cat].name + " ";
            badge.className = "badge " + r.fonts[cat].source;
            badge.textContent = r.fonts[cat].source;
            b.appendChild(badge);
            tr.append(a, b);
            t.appendChild(tr);
        });
    }

    function renderSite(report) {
        const excluded = host && matchingEntries(host).length > 0;

        $("host").textContent = host || "This page";
        $("toggleSite").style.display = host ? "" : "none";
        $("toggleSite").textContent = excluded ? "Enable on this site" : "Disable on this site";
        $("toggleSite").onclick = async function () {
            if (excluded) {
                const drop = new Set(matchingEntries(host));
                settings.excludedSites = settings.excludedSites.filter(function (x) { return !drop.has(x); });
            }
            else settings.excludedSites.push(host);

            await save();
            say("Saved. Reload the page to see the original fonts again.");
            renderSite(report);
        };
    }

    function renderUnknown(report) {
        const box = $("unknown");
        box.innerHTML = "";

        if (!report) {
            box.textContent = "This page cannot be scanned (browser pages and the Web Store are off limits to extensions).";
            return;
        }
        if (!report.active) {
            box.textContent = report.reason === "excluded" ? "Disabled on this site." : "The extension is turned off.";
            return;
        }
        if (!report.unknown.length) {
            box.textContent = "None, every font on this page was recognised.";
            return;
        }

        report.unknown.forEach(function (u) {
            const row = document.createElement("div");
            row.className = "unknown";

            const name = document.createElement("span");
            name.className = "name";
            name.textContent = u.name;
            name.title = u.name + " (" + u.count + " elements)";

            const sel = document.createElement("select");
            F.MANUAL_CATS.forEach(function (c) {
                const o = document.createElement("option");
                o.value = c;
                o.textContent = c === "ignore" ? "Icon font" : F.CAT_LABEL[c];
                sel.appendChild(o);
            });

            const add = document.createElement("button");
            add.className = "primary";
            add.textContent = "Add";
            add.onclick = async function () {
                settings.manualFonts = F.cleanManual(settings.manualFonts.concat([{ name: u.name, category: sel.value }]));
                await save();
                row.remove();
                say(sel.value === "ignore" ? "Saved. Reload the page to bring the font back." : "Saved and applied.");
            };

            row.append(name, sel, add);
            box.appendChild(row);
        });
    }

    async function main() {
        const data = await chrome.storage.local.get([F.KEYS.settings, F.KEYS.fonts]);
        settings = F.normalizeSettings(data[F.KEYS.settings]);
        bf = data[F.KEYS.fonts];

        $("enabled").checked = settings.enabled;
        $("enabled").onchange = async function () { settings.enabled = this.checked; await save(); say(this.checked ? "Enabled." : "Disabled. Reload to restore original fonts."); };
        $("options").onclick = function () { chrome.runtime.openOptionsPage(); window.close(); };
        $("reload").onclick = function () { if (tab) chrome.tabs.reload(tab.id); window.close(); };

        renderFonts();

        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        tab = tabs[0];

        let report = null;

        try { report = tab ? await chrome.tabs.sendMessage(tab.id, { type: "rme:report" }, { frameId: 0 }) : null; }
        catch (e) { report = null; }

        if (report) host = report.host;
        else { try { host = new URL(tab.url).hostname; } catch (e) { host = ""; } }

        renderSite(report);
        renderUnknown(report);
    }

    main();
})();
