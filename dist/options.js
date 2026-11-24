(() => {
    "use strict";

    const F = self.RME;
    const { $, el, plural, select, segmented, bindSwitch, bindNumber, bindLines, toast, send, applyFonts } = F.ui;

    const BROWSER_KEY = { sans: "sansserif", serif: "serif", mono: "fixed" };
    const CAT_NAMES = { sans: "Sans", serif: "Serif", mono: "Mono", ignore: "Icon font" };
    const CAT_OPTIONS = F.MANUAL_CATS.map(c => [c, CAT_NAMES[c]]);
    const FILTER_FROM = 8;          // the filter box appears for longer lists
    const quoted = name => `\u201c${name}\u201d`;

    let settings = F.normalizeSettings(null);
    let bf = null;                  // cached browser font settings
    let pending = 0;                // timer of a debounced save

    // -----------------------------------------------------------------------------------------------------------------
    // Saving and undo
    // -----------------------------------------------------------------------------------------------------------------

    let savedTimer;
    function flashSaved() {
        $("saved").classList.add("show");
        clearTimeout(savedTimer);
        savedTimer = setTimeout(() => $("saved").classList.remove("show"), 1400);
    }

    function saveNow() {
        clearTimeout(pending);
        pending = 0;
        return F.storage.save(settings).then(flashSaved);
    }

    // For typing: wait for a pause
    function save() {
        clearTimeout(pending);
        pending = setTimeout(saveNow, 250);
    }

    // Destructive actions apply at once and can be undone, which beats a confirm() dialog
    function withUndo(message, mutate) {
        const before = JSON.stringify(settings);

        mutate();
        renderAll();
        saveNow();

        toast(message, () => {
            settings = F.normalizeSettings(JSON.parse(before));
            renderAll();
            saveNow();
        });
    }

    // -----------------------------------------------------------------------------------------------------------------
    // General
    // -----------------------------------------------------------------------------------------------------------------

    function renderGeneral() {
        const showCount = () => { $("exCount").textContent = settings.excludedSites.length ? `(${settings.excludedSites.length} listed)` : ""; };

        bindSwitch("enabled", settings.enabled, v => { settings.enabled = v; save(); });
        bindLines("excluded", settings.excludedSites, lines => { settings.excludedSites = F.cleanHostList(lines); showCount(); save(); });
        showCount();
    }

    // -----------------------------------------------------------------------------------------------------------------
    // Fonts
    // -----------------------------------------------------------------------------------------------------------------

    function renderBrowserStatus() {
        const ok = !!(bf && bf.available);

        $("bfStatus").previousElementSibling.className = `dot ${ok ? "ok" : "warn"}`;
        $("bfStatus").textContent = ok
            ? "Following your browser's font settings. Choose Custom to override a family."
            : "Browser font settings are unavailable here, so defaults are used. Choose Custom to set your fonts.";
    }

    function renderPreview() {
        applyFonts(settings, bf);       // the page itself follows the fonts being chosen

        const { fonts, monoSize } = F.resolveFonts(settings, bf);

        $("preview").replaceChildren(...F.CATS.map(cat => {
            const row = el("div", "sample", null);
            row.style.fontFamily = F.familyValue(cat, fonts);
            if (cat === "mono" && monoSize) row.style.fontSize = `${monoSize}px`;

            row.append(el("span", "tag", F.CAT_LABEL[cat].replace("-serif", "")), "The quick brown fox jumps over the lazy dog 0123456789");
            return row;
        }));
    }

    function renderFonts() {
        $("fontRows").replaceChildren(...F.CATS.map(cat => {
            const font = settings.fonts[cat];
            const label = F.CAT_LABEL[cat];
            const browserName = bf && bf.available ? bf[BROWSER_KEY[cat]] : "";

            const mode = select([["browser", `Browser (${browserName || "unavailable"})`], ["custom", "Custom"]], font.mode, { "aria-label": `${label} source` });
            const input = el("input", "fade", null, { type: "text", list: "installed", placeholder: "Installed font name", value: font.custom, "aria-label": `Custom ${label} font` });

            const sync = () => {
                input.disabled = font.mode !== "custom";
                input.classList.toggle("hide", input.disabled);
            };
            sync();

            mode.onchange = () => {
                font.mode = mode.value;
                sync();
                if (!input.disabled) input.focus();
                renderPreview();
                save();
            };
            input.oninput = () => { font.custom = F.cleanFontName(input.value); renderPreview(); save(); };

            const row = el("div", "font-row");
            row.append(el("span", "label", label), mode, input);
            return row;
        }));

        renderPreview();
    }

    async function loadInstalledFonts() {
        try {
            const list = await chrome.fontSettings.getFontList();
            $("installed").replaceChildren(...list.map(f => el("option", "", null, { value: f.displayName || f.fontId })));
        }
        catch { /* the API is optional */ }
    }

    // -----------------------------------------------------------------------------------------------------------------
    // Monospace and code editors
    // -----------------------------------------------------------------------------------------------------------------

    function renderMono() {
        const m = settings.mono;
        const reveal = () => {
            $("sizeNum").classList.toggle("show", m.sizeMode === "custom");
            $("scaleNum").classList.toggle("show", m.scaleMode === "custom");
        };

        segmented($("sizeSeg"), [["browser", "Browser"], ["custom", "Custom"], ["off", "Off"]], m.sizeMode, v => { m.sizeMode = v; reveal(); renderPreview(); save(); });
        segmented($("scaleSeg"), [["auto", "Auto"], ["custom", "Custom"], ["off", "None"]], m.scaleMode, v => { m.scaleMode = v; reveal(); save(); });
        bindNumber("customSize", m.customSize, 13, v => { m.customSize = v; renderPreview(); save(); });
        bindNumber("customScale", m.customScale, 81.25, v => { m.customScale = v; save(); });
        bindSwitch("textarea", m.textarea, v => { m.textarea = v; save(); });
        reveal();
    }

    function renderEditors() {
        const ed = settings.editors;
        const warn = () => {
            const bad = ed.selectors.filter(s => !F.validSelector(s));
            $("selHint").textContent = bad.length ? `Ignored, not a valid selector: ${bad.join(", ")}` : "";
        };

        bindSwitch("edProtect", ed.protect, v => { ed.protect = v; save(); });
        bindSwitch("edAutoReload", ed.autoReload, v => { ed.autoReload = v; save(); });
        bindLines("edSelectors", ed.selectors, lines => { ed.selectors = F.cleanSelectors(lines); warn(); save(); });
        warn();
    }

    // -----------------------------------------------------------------------------------------------------------------
    // Extra fonts
    // -----------------------------------------------------------------------------------------------------------------

    const findManual = key => settings.manualFonts.findIndex(f => F.norm(f.name) === key);

    function removeManual(key) {
        const i = findManual(key);
        if (i > -1) settings.manualFonts.splice(i, 1);
    }

    function renderManual(flashKey) {
        const total = settings.manualFonts.length;
        const query = $("filter").value.trim().toLowerCase();

        $("filter").hidden = total <= FILTER_FROM;
        if ($("filter").hidden) $("filter").value = "";

        const items = settings.manualFonts
            .filter(f => !query || f.name.toLowerCase().includes(query))
            .sort((a, b) => a.name.localeCompare(b.name));

        $("count").textContent = query ? `${items.length} of ${plural(total, "font", "fonts")}` : plural(total, "font", "fonts");

        if (!items.length) {
            $("manualList").replaceChildren(el("div", "empty", total ? "No fonts match." : "Nothing here yet. Add a font below or import a list."));
            return;
        }

        const rows = items.map(font => {
            const key = F.norm(font.name);
            const row = el("div", "list-row", null, { "data-key": key });
            const category = select(CAT_OPTIONS, font.category, { "aria-label": `Category of ${font.name}` });

            category.onchange = () => { font.category = category.value; save(); };

            const remove = el("button", "icon", "\u2715", {
                type: "button", title: "Remove", "aria-label": `Remove ${font.name}`,
                onclick() {
                    row.classList.add("removing");
                    setTimeout(() => withUndo(`Removed ${quoted(font.name)}`, () => removeManual(key)), 160);
                }
            });

            row.append(el("span", "name", font.name, { title: font.name }), category, remove);
            return row;
        });

        $("manualList").replaceChildren(...rows);

        const added = rows.find(r => r.dataset.key === flashKey);
        if (added) {
            added.classList.add("flash");
            added.scrollIntoView({ block: "nearest" });
        }
    }

    // Adds new fonts and updates the category of known ones
    function applyEntries(entries) {
        for (const { name, category } of entries) {
            const i = findManual(F.norm(name));

            if (i === -1) settings.manualFonts.push({ name, category });
            else settings.manualFonts[i].category = category;
        }
        settings.manualFonts = F.cleanManual(settings.manualFonts);
    }

    function bindAddForm() {
        $("newCat").replaceChildren(...CAT_OPTIONS.map(([v, label]) => el("option", "", label, { value: v })));

        $("addForm").onsubmit = e => {
            e.preventDefault();

            const [entry] = F.parseFontLines($("newName").value.replace(/[|\t]/g, " "), $("newCat").value).entries;
            if (!entry) return;

            const existed = findManual(F.norm(entry.name)) > -1;

            $("filter").value = "";
            applyEntries([entry]);
            renderManual(F.norm(entry.name));
            saveNow();
            toast(`${existed ? "Updated" : "Added"} ${quoted(entry.name)}`);

            $("newName").value = "";
            $("newName").focus();
        };

        $("filter").oninput = () => renderManual();
        $("resetManual").onclick = () => withUndo("Default fonts restored", () => { settings.manualFonts = F.normalizeSettings(null).manualFonts; });
    }

    // -----------------------------------------------------------------------------------------------------------------
    // Import dialog
    // -----------------------------------------------------------------------------------------------------------------

    const STATE_LABEL = { new: "new", update: "changes category", same: "already there" };
    let importCat = "sans";

    // Each parsed entry is compared with the current list: new, update (category changes) or same
    function parseImport() {
        const parsed = F.parseFontLines($("impText").value, importCat);

        for (const e of parsed.entries) {
            const i = findManual(F.norm(e.name));
            e.state = i === -1 ? "new" : settings.manualFonts[i].category !== e.category ? "update" : "same";
        }
        return parsed;
    }

    function renderImportPreview() {
        const { entries, invalid } = parseImport();
        const count = state => entries.filter(e => e.state === state).length;
        const [added, changed, same] = ["new", "update", "same"].map(count);
        const row = (...children) => { const r = el("div", "list-row static"); r.append(...children); return r; };

        $("impPreview").hidden = !entries.length && !invalid.length;
        $("impPreview").replaceChildren(
            ...entries.slice(0, 200).map(e => row(
                el("span", "name", e.name),
                el("span", `badge${e.category === "ignore" ? "" : " browser"}`, CAT_NAMES[e.category]),
                el("span", `badge${e.state === "update" ? " custom" : ""}`, STATE_LABEL[e.state]))),
            ...invalid.map(x => row(
                el("span", "name", `Line ${x.line}: ${x.text}`, { title: x.text }),
                el("span", "hint warn", x.reason)))
        );

        $("impSummary").textContent = [
            added && `${added} new`, changed && `${changed} changed`, same && `${same} already there`,
            invalid.length && `${plural(invalid.length, "line", "lines")} ignored`
        ].filter(Boolean).join(" \u00b7 ");

        $("impGo").disabled = added + changed === 0;
        $("impGo").textContent = added + changed ? `Import ${plural(added + changed, "font", "fonts")}` : "Import";
    }

    function bindImport() {
        const dialog = $("importDlg");
        const close = () => dialog.close ? dialog.close() : dialog.removeAttribute("open");

        segmented($("impCatSeg"), CAT_OPTIONS, importCat, v => { importCat = v; renderImportPreview(); });

        $("openImport").onclick = () => {
            $("impText").value = "";
            renderImportPreview();
            if (dialog.showModal) dialog.showModal(); else dialog.setAttribute("open", "");
            $("impText").focus();
        };
        $("impText").oninput = renderImportPreview;
        $("impCancel").onclick = close;
        dialog.addEventListener("click", e => { if (e.target === dialog) close(); });       // the backdrop

        $("impForm").onsubmit = e => {
            e.preventDefault();

            const todo = parseImport().entries.filter(x => x.state !== "same");
            if (!todo.length) return;

            close();
            withUndo(`Imported ${plural(todo.length, "font", "fonts")}`, () => applyEntries(todo));
        };
    }

    // -----------------------------------------------------------------------------------------------------------------
    // Icon fonts, backup, navigation
    // -----------------------------------------------------------------------------------------------------------------

    const renderIcons = () => bindLines("iconPatterns", settings.iconPatterns, lines => {
        settings.iconPatterns = lines.map(s => s.trim()).filter(Boolean);
        save();
    });

    function bindBackup() {
        $("export").onclick = () => {
            const link = el("a", "", null, {
                href: URL.createObjectURL(new Blob([JSON.stringify(settings, null, 2)], { type: "application/json" })),
                download: "respect-my-eyes-settings.json"
            });
            link.click();
            setTimeout(() => URL.revokeObjectURL(link.href), 1000);
        };

        $("import").onclick = () => $("importFile").click();
        $("importFile").onchange = async function () {
            const [file] = this.files;
            this.value = "";
            if (!file) return;

            try {
                const next = F.normalizeSettings(JSON.parse(await file.text()));
                withUndo("Settings imported", () => { settings = next; });
            }
            catch { toast("That is not a valid settings file"); }
        };

        $("resetAll").onclick = () => withUndo("Settings reset", () => { settings = F.normalizeSettings(null); });
        $("openBrowserFonts").onclick = () => chrome.tabs.create({ url: "chrome://settings/fonts" });
        $("refreshBf").onclick = async () => {
            bf = (await send({ type: "rme:refresh" })) || bf;
            renderBrowserStatus();
            renderFonts();
            toast("Font settings re-read");
        };
    }

    // Highlights the nav link of the section being read
    function bindNav() {
        if (typeof IntersectionObserver === "undefined") return;

        const links = [...document.querySelectorAll("#nav a")];
        const visible = new Set();

        const observer = new IntersectionObserver(entries => {
            for (const e of entries) e.isIntersecting ? visible.add(e.target.id) : visible.delete(e.target.id);

            const current = links.find(a => visible.has(a.hash.slice(1)));
            for (const a of links) a.classList.toggle("active", a === current);
        }, { rootMargin: "-60px 0px -60% 0px" });

        for (const a of links) observer.observe(document.querySelector(a.hash));
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

    (async () => {
        ({ settings, bf } = await F.storage.load());

        bindAddForm();
        bindImport();
        bindBackup();
        renderAll();
        loadInstalledFonts();
        bindNav();

        if (!bf) {
            bf = await send({ type: "rme:refresh" });
            renderBrowserStatus();
            renderFonts();
        }
    })();

    // The popup, the learning service worker or another tab may change things while this page is open
    F.storage.onChange(changes => {
        if (changes[F.KEYS.fonts]) {
            bf = changes[F.KEYS.fonts].newValue;
            renderBrowserStatus();
            renderFonts();
        }

        const incoming = changes[F.KEYS.settings];
        if (incoming && !pending) {
            const next = F.normalizeSettings(incoming.newValue);

            if (JSON.stringify(next) !== JSON.stringify(F.normalizeSettings(settings))) {
                settings = next;
                renderAll();
            }
        }
    });
})();
