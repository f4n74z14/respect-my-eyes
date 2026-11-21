(function () {
    "use strict";

    const F = self.RME;
    const $ = function (id) { return document.getElementById(id); };
    const BF_KEY = { sans: "sansserif", serif: "serif", mono: "fixed" };
    const CAT_NAMES = { sans: "Sans", serif: "Serif", mono: "Mono", ignore: "Icon font" };

    let settings = F.normalizeSettings(null);
    let bf = null;
    let saveTimer = 0;

    function el(tag, cls, text) {
        const e = document.createElement(tag);
        if (cls) e.className = cls;
        if (text != null) e.textContent = text;
        return e;
    }

    function plural(n, one, many) { return n + " " + (n === 1 ? one : many); }

    // -----------------------------------------------------------------------------------------------------------------
    // Saving, feedback, undo
    // -----------------------------------------------------------------------------------------------------------------

    let savedTimer = 0;

    function flashSaved() {
        const s = $("saved");
        s.classList.add("show");
        clearTimeout(savedTimer);
        savedTimer = setTimeout(function () { s.classList.remove("show"); }, 1400);
    }

    function write() { chrome.storage.local.set({ [F.KEYS.settings]: settings }, flashSaved); }

    function save() {                          // debounced: typing in a textarea
        clearTimeout(saveTimer);
        saveTimer = setTimeout(function () { saveTimer = 0; write(); }, 250);
    }

    function saveNow() { clearTimeout(saveTimer); saveTimer = 0; write(); }

    function toast(message, undo) {
        const box = $("toasts");
        const t = el("div", "toast");
        let timer;

        t.setAttribute("role", "status");
        t.appendChild(el("span", "", message));

        const close = function () {
            clearTimeout(timer);
            t.classList.add("out");
            setTimeout(function () { t.remove(); }, 200);
        };

        if (undo) {
            const b = el("button", "", "Undo");
            b.type = "button";
            b.onclick = function () { undo(); close(); };
            t.appendChild(b);
        }

        while (box.children.length >= 3) box.firstChild.remove();
        box.appendChild(t);
        timer = setTimeout(close, undo ? 8000 : 2600);
    }

    // Destructive actions apply immediately and can be undone, which is faster and safer than a confirm() dialog
    function withUndo(message, mutate) {
        const before = JSON.stringify(settings);

        mutate();
        renderAll();
        saveNow();

        toast(message, function () {
            settings = F.normalizeSettings(JSON.parse(before));
            renderAll();
            saveNow();
        });
    }

    // -----------------------------------------------------------------------------------------------------------------
    // Segmented control
    // -----------------------------------------------------------------------------------------------------------------

    function segmented(box, options, value, onChange) {
        box.innerHTML = "";

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

    // -----------------------------------------------------------------------------------------------------------------
    // General
    // -----------------------------------------------------------------------------------------------------------------

    function renderGeneral() {
        $("enabled").checked = settings.enabled;
        $("enabled").onchange = function () { settings.enabled = this.checked; save(); };

        const count = function () { $("exCount").textContent = settings.excludedSites.length ? "(" + settings.excludedSites.length + " listed)" : ""; };
        $("excluded").value = settings.excludedSites.join("\n");
        $("excluded").oninput = function () { settings.excludedSites = F.cleanHostList(this.value.split(/\r?\n/)); count(); save(); };
        count();
    }

    // -----------------------------------------------------------------------------------------------------------------
    // Fonts
    // -----------------------------------------------------------------------------------------------------------------

    function renderBrowserStatus() {
        const ok = !!(bf && bf.available);

        $("bfStatus").previousElementSibling.className = "dot " + (ok ? "ok" : "warn");
        $("bfStatus").textContent = ok
            ? "Following your browser's font settings. Choose Custom to override a family."
            : "Browser font settings are unavailable here, so defaults are used. Choose Custom to set your fonts.";
    }

    function renderPreview() {
        const r = F.resolveFonts(settings, bf);
        const box = $("preview");
        box.innerHTML = "";

        F.CATS.forEach(function (cat) {
            const row = el("div", "sample");
            row.style.fontFamily = F.familyValue(cat, r.fonts);
            if (cat === "mono" && r.monoSize) row.style.fontSize = r.monoSize + "px";
            row.append(el("span", "tag", F.CAT_LABEL[cat].replace("-serif", "")), "The quick brown fox jumps over the lazy dog 0123456789");
            box.appendChild(row);
        });
    }

    function renderFonts() {
        const box = $("fontRows");
        box.innerHTML = "";

        F.CATS.forEach(function (cat) {
            const f = settings.fonts[cat];
            const browserName = bf && bf.available ? bf[BF_KEY[cat]] : "";
            const row = el("div", "font-row");

            const sel = el("select");
            sel.setAttribute("aria-label", F.CAT_LABEL[cat] + " source");
            [["browser", browserName ? "Browser (" + browserName + ")" : "Browser (unavailable)"], ["custom", "Custom"]].forEach(function (o) {
                const opt = el("option", "", o[1]);
                opt.value = o[0];
                sel.appendChild(opt);
            });
            sel.value = f.mode;

            const input = el("input");
            input.type = "text";
            input.setAttribute("list", "installed");
            input.setAttribute("aria-label", "Custom " + F.CAT_LABEL[cat] + " font");
            input.placeholder = "Installed font name";
            input.value = f.custom;
            input.disabled = f.mode !== "custom";

            sel.onchange = function () {
                f.mode = sel.value;
                input.disabled = f.mode !== "custom";
                if (f.mode === "custom") input.focus();
                renderPreview();
                save();
            };
            input.oninput = function () { f.custom = input.value.trim().replace(/["\\]/g, ""); renderPreview(); save(); };

            row.append(el("span", "label", F.CAT_LABEL[cat]), sel, input);
            box.appendChild(row);
        });

        renderPreview();
    }

    async function loadInstalledFonts() {
        if (!chrome.fontSettings || !chrome.fontSettings.getFontList) return;

        try {
            const list = await chrome.fontSettings.getFontList();
            const dl = $("installed");

            list.forEach(function (f) { const o = el("option"); o.value = f.displayName || f.fontId; dl.appendChild(o); });
        }
        catch (e) { /* optional */ }
    }

    // -----------------------------------------------------------------------------------------------------------------
    // Monospace
    // -----------------------------------------------------------------------------------------------------------------

    function renderMono() {
        const m = settings.mono;
        const sync = function () {
            $("customSize").disabled = m.sizeMode !== "custom";
            $("customScale").disabled = m.scaleMode !== "custom";
        };

        segmented($("sizeSeg"), [["browser", "Browser"], ["custom", "Custom"], ["off", "Off"]], m.sizeMode, function (v) { m.sizeMode = v; sync(); renderPreview(); save(); });
        segmented($("scaleSeg"), [["auto", "Auto"], ["custom", "Custom"], ["off", "None"]], m.scaleMode, function (v) { m.scaleMode = v; sync(); save(); });

        $("customSize").value = m.customSize;
        $("customScale").value = m.customScale;
        $("textarea").checked = m.textarea;
        sync();

        $("customSize").oninput = function () { m.customSize = parseFloat(this.value) || 13; renderPreview(); save(); };
        $("customScale").oninput = function () { m.customScale = parseFloat(this.value) || 81.25; save(); };
        $("textarea").onchange = function () { m.textarea = this.checked; save(); };
    }

    // -----------------------------------------------------------------------------------------------------------------
    // Editors
    // -----------------------------------------------------------------------------------------------------------------

    function validSelector(s) {
        try { return !self.CSS || !CSS.supports || CSS.supports("selector(" + s + ")"); }
        catch (e) { return false; }
    }

    function renderEditors() {
        const ed = settings.editors, m = settings.mono;

        $("edProtect").checked = ed.protect;
        $("autoLearn").checked = ed.autoLearn;
        $("seed").checked = m.seed;
        $("edSelectors").value = ed.selectors.join("\n");
        $("seedNames").value = m.seedNames.join("\n");

        $("edProtect").onchange = function () { ed.protect = this.checked; save(); };
        $("autoLearn").onchange = function () { ed.autoLearn = this.checked; save(); };
        $("seed").onchange = function () { m.seed = this.checked; save(); };

        const hint = function () {
            const bad = ed.selectors.filter(function (s) { return !validSelector(s); });
            $("selHint").textContent = bad.length ? "Ignored, not a valid selector: " + bad.join(", ") : "";
        };
        $("edSelectors").oninput = function () { ed.selectors = F.cleanSelectors(this.value.split(/\r?\n/)); hint(); save(); };
        hint();

        $("seedNames").oninput = function () { m.seedNames = F.cleanNameList(this.value.split(/\r?\n/)); save(); };
        $("seedReset").onclick = function () { withUndo("Default names restored", function () { settings.mono.seedNames = F.MONO_SEED.slice(); }); };
    }

    // -----------------------------------------------------------------------------------------------------------------
    // Extra fonts
    // -----------------------------------------------------------------------------------------------------------------

    function catSelect(value) {
        const s = el("select");
        F.MANUAL_CATS.forEach(function (c) { const o = el("option", "", CAT_NAMES[c]); o.value = c; s.appendChild(o); });
        s.value = value;
        return s;
    }

    function findManual(key) {
        for (let i = 0; i < settings.manualFonts.length; i++) if (F.norm(settings.manualFonts[i].name) === key) return i;
        return -1;
    }

    function renderManual(flashKey) {
        const list = $("manualList");
        const total = settings.manualFonts.length;
        const q = $("filter").value.trim().toLowerCase();

        $("filter").hidden = total <= 8;
        if (total <= 8) $("filter").value = "";

        const items = settings.manualFonts
            .filter(function (f) { return !q || f.name.toLowerCase().indexOf(q) > -1; })
            .sort(function (a, b) { return a.name.localeCompare(b.name); });

        $("count").textContent = q ? items.length + " of " + plural(total, "font", "fonts") : plural(total, "font", "fonts");
        list.innerHTML = "";

        if (!items.length) {
            list.appendChild(el("div", "empty", total ? "No fonts match." : "Nothing here yet. Add a font below or import a list."));
            return;
        }

        let flashEl = null;

        items.forEach(function (f) {
            const key = F.norm(f.name);
            const row = el("div", "list-row");
            const name = el("span", "name", f.name);
            name.title = f.name;

            const sel = catSelect(f.category);
            sel.setAttribute("aria-label", "Category of " + f.name);
            sel.onchange = function () { f.category = sel.value; save(); };

            const del = el("button", "icon", "\u2715");
            del.type = "button";
            del.title = "Remove";
            del.setAttribute("aria-label", "Remove " + f.name);
            del.onclick = function () {
                row.classList.add("removing");
                setTimeout(function () {
                    withUndo("Removed \u201c" + f.name + "\u201d", function () { const i = findManual(key); if (i > -1) settings.manualFonts.splice(i, 1); });
                }, 160);
            };

            row.append(name, sel, del);
            list.appendChild(row);
            if (key === flashKey) flashEl = row;
        });

        if (flashEl) {
            flashEl.classList.add("flash");
            flashEl.scrollIntoView({ block: "nearest" });
        }
    }

    // @return {added, changed, same}
    function applyEntries(entries) {
        const r = { added: 0, changed: 0, same: 0 };

        entries.forEach(function (e) {
            const i = findManual(F.norm(e.name));

            if (i === -1) { settings.manualFonts.push({ name: e.name, category: e.category }); r.added++; }
            else if (settings.manualFonts[i].category !== e.category) { settings.manualFonts[i].category = e.category; r.changed++; }
            else r.same++;
        });
        settings.manualFonts = F.cleanManual(settings.manualFonts);
        return r;
    }

    function bindAddForm() {
        F.MANUAL_CATS.forEach(function (c) { const o = el("option", "", CAT_NAMES[c]); o.value = c; $("newCat").appendChild(o); });

        $("addForm").onsubmit = function (e) {
            e.preventDefault();

            const parsed = F.parseFontLines($("newName").value.replace(/[|\t]/g, " "), $("newCat").value);
            if (!parsed.entries.length) return;

            const entry = parsed.entries[0];
            const existed = findManual(F.norm(entry.name)) > -1;

            $("filter").value = "";
            applyEntries([entry]);
            renderManual(F.norm(entry.name));
            saveNow();
            toast(existed ? "Updated \u201c" + entry.name + "\u201d" : "Added \u201c" + entry.name + "\u201d");

            $("newName").value = "";
            $("newName").focus();
        };

        $("filter").oninput = function () { renderManual(); };
        $("resetManual").onclick = function () { withUndo("Default fonts restored", function () { settings.manualFonts = F.normalizeSettings(null).manualFonts; }); };
    }

    // -----------------------------------------------------------------------------------------------------------------
    // Import dialog
    // -----------------------------------------------------------------------------------------------------------------

    let impCat = "sans";

    function importState() {
        const parsed = F.parseFontLines($("impText").value, impCat);

        parsed.entries.forEach(function (e) {
            const i = findManual(F.norm(e.name));
            e.state = i === -1 ? "new" : settings.manualFonts[i].category !== e.category ? "update" : "same";
        });
        return parsed;
    }

    function renderImportPreview() {
        const p = importState();
        const box = $("impPreview");
        const count = function (s) { return p.entries.filter(function (e) { return e.state === s; }).length; };
        const n = count("new"), u = count("update"), same = count("same");

        box.innerHTML = "";
        box.hidden = !p.entries.length && !p.invalid.length;

        p.entries.slice(0, 200).forEach(function (e) {
            const row = el("div", "list-row");
            row.style.animation = "none";
            row.append(el("span", "name", e.name), el("span", "badge " + (e.category === "ignore" ? "" : "browser"), CAT_NAMES[e.category]),
                el("span", "badge" + (e.state === "update" ? " custom" : ""), e.state === "new" ? "new" : e.state === "update" ? "changes category" : "already there"));
            box.appendChild(row);
        });
        p.invalid.forEach(function (x) {
            const row = el("div", "list-row");
            row.style.animation = "none";
            const name = el("span", "name", "Line " + x.line + ": " + x.text);
            name.title = x.text;
            row.append(name, el("span", "hint warn", x.reason));
            box.appendChild(row);
        });

        const parts = [];
        if (n) parts.push(n + " new");
        if (u) parts.push(u + " changed");
        if (same) parts.push(same + " already there");
        if (p.invalid.length) parts.push(plural(p.invalid.length, "line", "lines") + " ignored");

        $("impSummary").textContent = parts.join(" \u00b7 ");
        $("impGo").disabled = n + u === 0;
        $("impGo").textContent = n + u ? "Import " + plural(n + u, "font", "fonts") : "Import";
    }

    function bindImport() {
        const dlg = $("importDlg");

        segmented($("impCatSeg"), [["sans", "Sans"], ["serif", "Serif"], ["mono", "Mono"], ["ignore", "Icon font"]], impCat, function (v) { impCat = v; renderImportPreview(); });

        $("openImport").onclick = function () {
            $("impText").value = "";
            renderImportPreview();
            if (dlg.showModal) dlg.showModal(); else dlg.setAttribute("open", "");
            $("impText").focus();
        };
        $("impText").oninput = renderImportPreview;
        $("impCancel").onclick = function () { dlg.close ? dlg.close() : dlg.removeAttribute("open"); };
        dlg.addEventListener("click", function (e) { if (e.target === dlg) $("impCancel").click(); });      // click on the backdrop

        $("impForm").onsubmit = function (e) {
            e.preventDefault();

            const p = importState();
            const todo = p.entries.filter(function (x) { return x.state !== "same"; });
            if (!todo.length) return;

            $("impCancel").click();
            withUndo("Imported " + plural(todo.length, "font", "fonts"), function () { applyEntries(todo); });
        };
    }

    // -----------------------------------------------------------------------------------------------------------------
    // Icon fonts, backup, navigation
    // -----------------------------------------------------------------------------------------------------------------

    function renderIcons() {
        $("iconPatterns").value = settings.iconPatterns.join("\n");
        $("iconPatterns").oninput = function () { settings.iconPatterns = this.value.split(/\r?\n/).map(function (s) { return s.trim(); }).filter(Boolean); save(); };
    }

    function bindBackup() {
        $("export").onclick = function () {
            const blob = new Blob([JSON.stringify(settings, null, 2)], { type: "application/json" });
            const a = document.createElement("a");
            a.href = URL.createObjectURL(blob);
            a.download = "respect-my-eyes-settings.json";
            a.click();
            setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
        };
        $("import").onclick = function () { $("importFile").click(); };
        $("importFile").onchange = function () {
            const file = this.files[0];
            this.value = "";
            if (!file) return;

            file.text().then(function (text) {
                const next = F.normalizeSettings(JSON.parse(text));
                withUndo("Settings imported", function () { settings = next; });
            }).catch(function () { toast("That is not a valid settings file"); });
        };
        $("resetAll").onclick = function () { withUndo("Settings reset", function () { settings = F.normalizeSettings(null); }); };

        $("openBrowserFonts").onclick = function () { chrome.tabs.create({ url: "chrome://settings/fonts" }); };
        $("refreshBf").onclick = function () {
            chrome.runtime.sendMessage({ type: "rme:refresh" }, function (r) {
                bf = r || bf;
                renderBrowserStatus();
                renderFonts();
                toast("Font settings re-read");
            });
        };
    }

    function bindNav() {
        if (typeof IntersectionObserver === "undefined") return;

        const links = Array.prototype.slice.call(document.querySelectorAll("#nav a"));
        const visible = new Set();

        const io = new IntersectionObserver(function (entries) {
            entries.forEach(function (e) { e.isIntersecting ? visible.add(e.target.id) : visible.delete(e.target.id); });

            const current = links.map(function (a) { return a.getAttribute("href").slice(1); }).find(function (id) { return visible.has(id); });
            links.forEach(function (a) { a.classList.toggle("active", a.getAttribute("href") === "#" + current); });
        }, { rootMargin: "-60px 0px -60% 0px" });

        links.forEach(function (a) { const s = document.querySelector(a.getAttribute("href")); if (s) io.observe(s); });
    }

    // -----------------------------------------------------------------------------------------------------------------

    function renderAll() {
        renderGeneral();
        renderBrowserStatus();
        renderFonts();
        renderMono();
        renderEditors();
        renderManual();
        renderIcons();
    }

    chrome.storage.local.get([F.KEYS.settings, F.KEYS.fonts], function (data) {
        settings = F.normalizeSettings(data[F.KEYS.settings]);
        bf = data[F.KEYS.fonts] || null;

        bindAddForm();
        bindImport();
        bindBackup();
        renderAll();
        loadInstalledFonts();
        bindNav();

        if (!bf) chrome.runtime.sendMessage({ type: "rme:refresh" }, function (r) { bf = r; renderBrowserStatus(); renderFonts(); });
    });

    // The popup, the learning service worker or another tab may change things while this page is open
    chrome.storage.onChanged.addListener(function (changes, area) {
        if (area !== "local") return;

        if (changes[F.KEYS.fonts]) {
            bf = changes[F.KEYS.fonts].newValue;
            renderBrowserStatus();
            renderFonts();
        }
        if (changes[F.KEYS.settings] && !saveTimer) {
            const next = F.normalizeSettings(changes[F.KEYS.settings].newValue);

            if (JSON.stringify(next) !== JSON.stringify(F.normalizeSettings(settings))) {
                settings = next;
                renderAll();
            }
        }
    });
})();
