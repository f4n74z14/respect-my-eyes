(() => {
    "use strict";

    const F = self.RME;
    const { $, el, plural, select, segmented, bindSwitch, bindNumber, bindLines, toast, applyFonts, refreshBrowserFonts, animDelay } = F.ui;

    const BROWSER_KEY = { sans: "sansserif", serif: "serif", mono: "fixed" };
    const CAT_NAMES = { sans: "Sans", serif: "Serif", mono: "Mono", ignore: "Icon font" };
    const CAT_OPTIONS = F.MANUAL_CATS.map(c => [c, CAT_NAMES[c]]);
    const FILTER_FROM = 8;          // the filter box appears for longer lists
    const quoted = name => `\u201c${name}\u201d`;
    const COLLATOR = new Intl.Collator();
    const catSelectTpl = select(CAT_OPTIONS, "sans");

    let settings = F.normalizeSettings(null);
    let bf = null;                  // cached browser font settings
    let pending = 0;                // timer of a debounced save
    let savingCount = 0;            // in-flight storage.save() count to guard onChange against stale echoes
    let lastSavedJson = "";

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
        savingCount++;
        lastSavedJson = JSON.stringify(F.normalizeSettings(settings));
        return F.storage.save(settings)
            .then(flashSaved)
            .finally(() => { savingCount = Math.max(0, savingCount - 1); });
    }

    // For typing: wait for a pause
    function save() {
        clearTimeout(pending);
        pending = setTimeout(saveNow, 250);
    }

    const flushPending = () => { if (pending) saveNow(); };
    window.addEventListener("pagehide", flushPending);
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flushPending(); });

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

        bindSwitch("enabled", settings.enabled, v => { settings.enabled = v; saveNow(); });
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
            ? "Using browser font settings. Choose Custom to override."
            : "Browser fonts unavailable; using defaults. Choose Custom to override.";
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
            const label = F.CAT_LABEL[cat];
            const browserName = bf && bf.available ? bf[BROWSER_KEY[cat]] : "";

            const mode = select([["browser", `Browser (${browserName || "unavailable"})`], ["custom", "Custom"]], settings.fonts[cat].mode, { "aria-label": `${label} source` });
            const input = el("input", "fade", null, { type: "text", list: "installed", placeholder: "Installed font name", value: settings.fonts[cat].custom, "aria-label": `Custom ${label} font` });

            const sync = () => {
                input.disabled = settings.fonts[cat].mode !== "custom";
                input.classList.toggle("hide", input.disabled);
            };
            sync();

            mode.onchange = () => {
                settings.fonts[cat].mode = mode.value;
                sync();
                if (!input.disabled) input.focus();
                renderPreview();
                saveNow();
            };
            input.oninput = () => { settings.fonts[cat].custom = F.cleanFontName(input.value); renderPreview(); save(); };

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
        const reveal = () => {
            $("sizeNum").classList.toggle("show", settings.mono.sizeMode === "custom");
            $("scaleNum").classList.toggle("show", settings.mono.scaleMode === "custom");
        };

        segmented($("sizeSeg"), [["browser", "Browser"], ["custom", "Custom"], ["off", "Off"]], settings.mono.sizeMode, v => { settings.mono.sizeMode = v; reveal(); renderPreview(); saveNow(); });
        segmented($("scaleSeg"), [["auto", "Auto"], ["custom", "Custom"], ["off", "None"]], settings.mono.scaleMode, v => { settings.mono.scaleMode = v; reveal(); saveNow(); });
        bindNumber("customSize", settings.mono.customSize, 13, v => { settings.mono.customSize = v; renderPreview(); save(); });
        bindNumber("customScale", settings.mono.customScale, 81.25, v => { settings.mono.customScale = v; save(); });
        bindSwitch("textarea", settings.mono.textarea, v => { settings.mono.textarea = v; saveNow(); });
        reveal();
    }

    function renderEditors() {
        const warn = () => {
            const bad = settings.editors.selectors.filter(s => !F.validSelector(s));
            $("selHint").textContent = bad.length
                ? `Invalid selector (ignored): ${bad.slice(0, 3).join(", ")}${bad.length > 3 ? ` (+${bad.length - 3} more)` : ""}`
                : "";
        };

        bindSwitch("edProtect", settings.editors.protect, v => { settings.editors.protect = v; saveNow(); });
        bindSwitch("edAutoReload", settings.editors.autoReload, v => { settings.editors.autoReload = v; saveNow(); });
        bindLines("edSelectors", settings.editors.selectors, lines => { settings.editors.selectors = F.cleanSelectors(lines); warn(); save(); });
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
            .sort((a, b) => COLLATOR.compare(a.name, b.name));

        $("count").textContent = query ? `${items.length} of ${plural(total, "font", "fonts")}` : plural(total, "font", "fonts");

        if (!items.length) {
            $("manualList").replaceChildren(el("div", "empty", total ? "No fonts match." : "Nothing here yet. Add a font below or import a list."));
            return;
        }

        const rows = items.map(font => {
            const key = F.norm(font.name);
            const row = el("div", "list-row", null, { "data-key": key });
            const category = catSelectTpl.cloneNode(true);
            category.value = font.category;
            category.setAttribute("aria-label", `Category of ${font.name}`);

            const remove = el("button", "icon", "\u2715", {
                type: "button", title: "Remove", "aria-label": `Remove ${font.name}`
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

    const manualIndex = () => new Map(settings.manualFonts.map((f, i) => [F.norm(f.name), i]));

    // Adds new fonts and updates the category of known ones
    function applyEntries(entries) {
        const index = manualIndex();
        for (const { name, category } of entries) {
            const key = F.norm(name);
            const i = index.get(key);

            if (i === undefined) {
                index.set(key, settings.manualFonts.length);
                settings.manualFonts.push({ name, category });
            }
            else settings.manualFonts[i].category = category;
        }
        settings.manualFonts = F.cleanManual(settings.manualFonts);
    }

    function bindAddForm() {
        $("newCat").replaceChildren(...CAT_OPTIONS.map(([v, label]) => el("option", "", label, { value: v })));

        $("manualList").onchange = e => {
            const sel = e.target.closest("select");
            const row = sel && sel.closest(".list-row");
            const i = row ? findManual(row.dataset.key) : -1;
            if (i > -1) { settings.manualFonts[i].category = sel.value; save(); }
        };

        $("manualList").onclick = e => {
            const btn = e.target.closest("button.icon");
            const row = btn && btn.closest(".list-row");
            const key = row && row.dataset.key;
            const i = key ? findManual(key) : -1;
            if (i === -1) return;
            const name = settings.manualFonts[i].name;
            const delay = animDelay(160);
            if (!delay) { withUndo(`Removed ${quoted(name)}`, () => removeManual(key)); return; }
            row.classList.add("removing");
            setTimeout(() => withUndo(`Removed ${quoted(name)}`, () => removeManual(key)), delay);
        };

        $("addForm").onsubmit = e => {
            e.preventDefault();

            const [entry] = F.parseFontLines($("newName").value.replace(/[|\t]/g, " "), $("newCat").value).entries;
            if (!entry) return;

            const existed = findManual(F.norm(entry.name)) > -1;
            if (!existed && settings.manualFonts.length >= 500) {
                toast("Font list limit (500) reached");
                return;
            }

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
        const index = manualIndex();

        for (const e of parsed.entries) {
            const i = index.get(F.norm(e.name));
            e.state = i === undefined ? "new" : settings.manualFonts[i].category !== e.category ? "update" : "same";
        }
        return parsed;
    }

    function renderImportPreview() {
        const { entries, invalid } = parseImport();
        const counts = { new: 0, update: 0, same: 0 };
        for (const e of entries) counts[e.state]++;
        const { new: added, update: changed, same } = counts;
        const row = (...children) => { const r = el("div", "list-row static"); r.append(...children); return r; };

        $("impPreview").hidden = !entries.length && !invalid.length;
        $("impPreview").replaceChildren(
            ...entries.slice(0, 200).map(e => row(
                el("span", "name", e.name),
                el("span", `badge${e.category === "ignore" ? "" : " browser"}`, CAT_NAMES[e.category]),
                el("span", `badge${e.state === "update" ? " custom" : ""}`, STATE_LABEL[e.state]))),
            ...invalid.slice(0, 100).map(x => row(
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
        settings.iconPatterns = lines.map(s => s.trim().slice(0, 80)).filter(Boolean).slice(0, 200);
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
            if (file.size > 2 * 1024 * 1024) { toast("Settings file is too large"); return; }

            try {
                const next = F.normalizeSettings(JSON.parse(await file.text()));
                withUndo("Settings imported", () => { settings = next; });
            }
            catch { toast("Invalid settings file"); }
        };

        $("resetAll").onclick = () => withUndo("Settings reset", () => { settings = F.normalizeSettings(null); });
        $("openBrowserFonts").onclick = () => chrome.tabs.create({ url: "chrome://settings/fonts" });
        $("refreshBf").onclick = async () => {
            await syncBrowserFonts();
            toast("Font settings re-read");
        };
    }

    async function syncBrowserFonts() {
        const fresh = await refreshBrowserFonts();
        if (!fresh) return;
        bf = fresh;
        renderBrowserStatus();
        renderFonts();
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
        lastSavedJson = JSON.stringify(settings);

        bindAddForm();
        bindImport();
        bindBackup();
        renderAll();
        loadInstalledFonts();
        bindNav();

        if (!bf) await syncBrowserFonts();
    })();

    // The popup, the learning service worker or another tab may change things while this page is open
    F.storage.onChange(changes => {
        if (changes[F.KEYS.fonts]) {
            bf = changes[F.KEYS.fonts].newValue;
            renderBrowserStatus();
            renderFonts();
        }

        const incoming = changes[F.KEYS.settings];
        if (incoming && !pending && savingCount === 0) {
            const next = F.normalizeSettings(incoming.newValue);
            const nextJson = JSON.stringify(next);

            if (nextJson !== lastSavedJson && nextJson !== JSON.stringify(F.normalizeSettings(settings))) {
                settings = next;
                lastSavedJson = nextJson;
                renderAll();
            }
        }
    });
})();
