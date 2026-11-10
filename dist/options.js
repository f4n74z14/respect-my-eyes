(function () {
    "use strict";

    const F = self.FMBF;
    const $ = function (id) { return document.getElementById(id); };

    let settings = F.normalizeSettings(null);
    let bf = null;
    let saveTimer = 0;

    // -----------------------------------------------------------------------------------------------------------------

    function save() {
        clearTimeout(saveTimer);
        saveTimer = setTimeout(function () {
            chrome.storage.local.set({ settings: settings }, function () {
                const el = $("saved");
                el.classList.add("show");
                setTimeout(function () { el.classList.remove("show"); }, 900);
            });
        }, 250);
    }

    function catOptions(select, cats) {
        select.innerHTML = "";
        cats.forEach(function (c) {
            const o = document.createElement("option");
            o.value = c;
            o.textContent = F.CAT_LABEL[c];
            select.appendChild(o);
        });
    }

    // -----------------------------------------------------------------------------------------------------------------
    // Fonts
    // -----------------------------------------------------------------------------------------------------------------

    const BF_KEY = { sans: "sansserif", serif: "serif", mono: "fixed" };

    function renderBrowserStatus() {
        const el = $("bfStatus");

        if (bf && bf.available) {
            el.className = "muted";
            el.textContent = "Fonts are read from your browser's font settings, so they follow whatever you configure there. Choose \"Custom\" to override a single family.";
        }
        else {
            el.className = "warn";
            el.textContent = "This browser does not expose its font settings to extensions, so built-in defaults are used. Choose \"Custom\" below to set your fonts.";
        }
    }

    function renderFonts() {
        const grid = $("fontGrid");
        grid.innerHTML = "";

        F.CATS.forEach(function (cat) {
            const f = settings.fonts[cat];
            const browserName = bf && bf.available ? bf[BF_KEY[cat]] : "";
            const tr = document.createElement("tr");

            const label = document.createElement("td");
            label.textContent = F.CAT_LABEL[cat];

            const sel = document.createElement("select");
            [["browser", browserName ? "Browser setting (" + browserName + ")" : "Browser setting (unavailable)"], ["custom", "Custom"]].forEach(function (o) {
                const opt = document.createElement("option");
                opt.value = o[0];
                opt.textContent = o[1];
                sel.appendChild(opt);
            });
            sel.value = f.mode;

            const input = document.createElement("input");
            input.type = "text";
            input.setAttribute("list", "installed");
            input.placeholder = "Installed font name";
            input.value = f.custom;
            input.disabled = f.mode !== "custom";

            sel.addEventListener("change", function () {
                f.mode = sel.value;
                input.disabled = f.mode !== "custom";
                if (f.mode === "custom") input.focus();
                save();
            });
            input.addEventListener("input", function () { f.custom = input.value.trim().replace(/["\\]/g, ""); save(); });

            const td2 = document.createElement("td"), td3 = document.createElement("td");
            td2.appendChild(sel);
            td3.appendChild(input);
            tr.append(label, td2, td3);
            grid.appendChild(tr);
        });
    }

    async function loadInstalledFonts() {
        if (!chrome.fontSettings || !chrome.fontSettings.getFontList) return;

        try {
            const list = await chrome.fontSettings.getFontList();
            const dl = $("installed");

            list.forEach(function (f) {
                const o = document.createElement("option");
                o.value = f.displayName || f.fontId;
                dl.appendChild(o);
            });
        }
        catch (e) { /* optional */ }
    }

    // -----------------------------------------------------------------------------------------------------------------
    // Monospace
    // -----------------------------------------------------------------------------------------------------------------

    function bindMono() {
        const m = settings.mono;

        $("sizeMode").value = m.sizeMode;
        $("customSize").value = m.customSize;
        $("scaleMode").value = m.scaleMode;
        $("customScale").value = m.customScale;
        $("textarea").checked = m.textarea;

        const sync = function () {
            $("customSize").disabled = m.sizeMode !== "custom";
            $("customScale").disabled = m.scaleMode !== "custom";
        };
        sync();

        $("sizeMode").onchange = function () { m.sizeMode = this.value; sync(); save(); };
        $("scaleMode").onchange = function () { m.scaleMode = this.value; sync(); save(); };
        $("customSize").oninput = function () { m.customSize = parseFloat(this.value) || 13; save(); };
        $("customScale").oninput = function () { m.customScale = parseFloat(this.value) || 81.25; save(); };
        $("textarea").onchange = function () { m.textarea = this.checked; save(); };
    }

    // -----------------------------------------------------------------------------------------------------------------
    // Extra fonts
    // -----------------------------------------------------------------------------------------------------------------

    function renderManual() {
        const table = $("manualTable");
        table.innerHTML = "";

        if (!settings.manualFonts.length) {
            table.innerHTML = '<tr><td class="muted">No extra fonts.</td></tr>';
            return;
        }

        settings.manualFonts.forEach(function (f, i) {
            const tr = document.createElement("tr");

            const name = document.createElement("td");
            name.textContent = f.name;

            const catTd = document.createElement("td");
            const sel = document.createElement("select");
            catOptions(sel, F.MANUAL_CATS);
            sel.value = f.category;
            sel.addEventListener("change", function () { f.category = sel.value; save(); });
            catTd.appendChild(sel);

            const delTd = document.createElement("td");
            const del = document.createElement("button");
            del.textContent = "\u2715";
            del.title = "Remove";
            del.addEventListener("click", function () { settings.manualFonts.splice(i, 1); renderManual(); save(); });
            delTd.appendChild(del);

            tr.append(name, catTd, delTd);
            table.appendChild(tr);
        });
    }

    function addManual(entries) {
        const before = settings.manualFonts.length;
        const byKey = new Map(settings.manualFonts.map(function (f) { return [F.norm(f.name), f]; }));

        entries.forEach(function (e) {
            const existing = byKey.get(F.norm(e.name));
            if (existing) existing.category = e.category;
            else settings.manualFonts.push(e);
        });
        settings.manualFonts = F.cleanManual(settings.manualFonts);
        renderManual();
        save();
        return settings.manualFonts.length - before;
    }

    function parseBulk(text) {
        const map = { "sans-serif": "sans", "sans": "sans", "serif": "serif", "monospace": "mono", "mono": "mono", "ignore": "ignore", "icon": "ignore" };
        const out = [];

        text.split(/\r?\n/).forEach(function (line) {
            const parts = line.split("|");
            const name = parts[0].trim();
            const cat = map[(parts[1] || "sans").trim().toLowerCase()];
            if (name && cat) out.push({ name: name, category: cat });
        });
        return out;
    }

    function bindManual() {
        catOptions($("newCat"), F.MANUAL_CATS);

        const add = function () {
            const name = $("newName").value.trim();
            if (!name) return;
            addManual([{ name: name, category: $("newCat").value }]);
            $("newName").value = "";
            $("newName").focus();
        };
        $("addFont").onclick = add;
        $("newName").onkeydown = function (e) { if (e.key === "Enter") add(); };

        $("bulkAdd").onclick = function () {
            addManual(parseBulk($("bulk").value));
            $("bulk").value = "";
        };
        $("resetManual").onclick = function () {
            if (!confirm("Replace your extra fonts list with the defaults?")) return;
            settings.manualFonts = F.normalizeSettings(null).manualFonts;
            renderManual();
            save();
        };
    }

    // -----------------------------------------------------------------------------------------------------------------
    // Everything else
    // -----------------------------------------------------------------------------------------------------------------

    function bindGeneral() {
        $("enabled").checked = settings.enabled;
        $("excluded").value = settings.excludedSites.join("\n");
        $("iconPatterns").value = settings.iconPatterns.join("\n");

        $("enabled").onchange = function () { settings.enabled = this.checked; save(); };
        $("excluded").oninput = function () { settings.excludedSites = F.cleanHostList(this.value.split(/\r?\n/)); save(); };
        $("iconPatterns").oninput = function () { settings.iconPatterns = this.value.split(/\r?\n/).map(function (s) { return s.trim(); }).filter(Boolean); save(); };

        $("openBrowserFonts").onclick = function () { chrome.tabs.create({ url: "chrome://settings/fonts" }); };
        $("refreshBf").onclick = function () {
            chrome.runtime.sendMessage({ type: "fmbf:refresh" }, function (r) {
                bf = r || bf;
                renderBrowserStatus();
                renderFonts();
            });
        };

        $("export").onclick = function () {
            const blob = new Blob([JSON.stringify(settings, null, 2)], { type: "application/json" });
            const a = document.createElement("a");
            a.href = URL.createObjectURL(blob);
            a.download = "respect-my-eyes.json";
            a.click();
            setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
        };
        $("import").onclick = function () { $("importFile").click(); };
        $("importFile").onchange = function () {
            const file = this.files[0];
            if (!file) return;

            file.text().then(function (text) {
                settings = F.normalizeSettings(JSON.parse(text));
                renderAll();
                save();
            }).catch(function () { alert("That file is not a valid settings export."); });
            this.value = "";
        };
        $("resetAll").onclick = function () {
            if (!confirm("Reset all settings to their defaults?")) return;
            settings = F.normalizeSettings(null);
            renderAll();
            save();
        };
    }

    function renderAll() {
        bindGeneral();
        renderBrowserStatus();
        renderFonts();
        bindMono();
        renderManual();
    }

    chrome.storage.local.get(["settings", "browserFonts"], function (data) {
        settings = F.normalizeSettings(data.settings);
        bf = data.browserFonts || null;

        bindManual();
        renderAll();
        loadInstalledFonts();

        if (!bf) chrome.runtime.sendMessage({ type: "fmbf:refresh" }, function (r) { bf = r; renderBrowserStatus(); renderFonts(); });
    });

    // Keep the "browser setting" labels current if the user changes chrome://settings/fonts while this page is open
    chrome.storage.onChanged.addListener(function (changes, area) {
        if (area === "local" && changes.browserFonts) {
            bf = changes.browserFonts.newValue;
            renderBrowserStatus();
            renderFonts();
        }
    });
})();
