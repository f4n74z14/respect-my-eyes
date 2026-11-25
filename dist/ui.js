/* Respect My Eyes - DOM helpers shared by the options page and the popup (RME.ui) */
(() => {
    "use strict";

    const F = self.RME;
    const $ = id => document.getElementById(id);

    // Properties are assigned, everything else (aria-*, list, type...) goes through attributes
    const PROPS = new Set(["value", "checked", "disabled", "hidden"]);

    // el("button", "primary", "Add", { type: "button", onclick: fn })
    function el(tag, cls, text, attrs) {
        const node = document.createElement(tag);

        if (cls) node.className = cls;
        if (text !== undefined && text !== null) node.textContent = text;

        if (attrs) {
            for (const [key, value] of Object.entries(attrs)) {
                if (key.startsWith("on") || PROPS.has(key)) node[key] = value;
                else node.setAttribute(key, value);
            }
        }
        return node;
    }

    const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

    // select([[value, label], ...], current)
    function select(options, value, attrs) {
        const node = el("select", "", null, attrs);

        for (const [v, label] of options) node.append(el("option", "", label, { value: v }));
        node.value = value;
        return node;
    }

    // Segmented control: buttons with role=radio inside `box`
    function segmented(box, options, value, onChange) {
        box.replaceChildren(...options.map(([v, label]) => el("button", "", label, {
            type: "button",
            role: "radio",
            "aria-checked": String(v === value),
            onclick(e) {
                for (const b of box.children) b.setAttribute("aria-checked", String(b === e.currentTarget));
                onChange(v);
            }
        })));
    }

    const bindSwitch = (id, value, onChange) => {
        $(id).checked = value;
        $(id).onchange = () => onChange($(id).checked);
    };

    const bindNumber = (id, value, fallback, onChange) => {
        $(id).value = value;
        $(id).oninput = () => onChange(parseFloat($(id).value) || fallback);
    };

    // A textarea holding one item per line
    const bindLines = (id, lines, onChange) => {
        $(id).value = lines.join("\n");
        $(id).oninput = () => onChange($(id).value.split(/\r?\n/));
    };

    const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    const animDelay = (ms = 160) => reducedMotion() ? 0 : ms;

    // Short message, optionally with an Undo button, in the #toasts container
    function toast(message, undo) {
        const box = $("toasts");
        const node = el("div", "toast", null, { role: "status" });
        const close = () => {
            clearTimeout(timer);
            const delay = animDelay(160);
            if (!delay) { node.remove(); return; }
            node.classList.add("out");
            setTimeout(() => node.remove(), delay);
        };

        node.append(el("span", "", message));
        if (undo) node.append(el("button", "", "Undo", { type: "button", onclick: () => { undo(); close(); } }));

        while (box.children.length >= 3) box.firstChild.remove();
        box.append(node);

        const timer = setTimeout(close, undo ? 8000 : 2600);
    }

    let uiSheet = null, uiStyleEl = null, lastUiCss = "";

    function setUiFaces(css) {
        if (css === lastUiCss && (uiSheet || uiStyleEl)) return;
        lastUiCss = css;
        if (!uiSheet && !uiStyleEl) {
            try {
                uiSheet = new CSSStyleSheet();
                document.adoptedStyleSheets = [...document.adoptedStyleSheets, uiSheet];
            } catch {
                uiSheet = null;
                uiStyleEl = document.createElement("style");
                uiStyleEl.setAttribute("data-rme-ui", "");
                (document.head || document.documentElement).appendChild(uiStyleEl);
            }
        }
        if (uiSheet) {
            try { uiSheet.replaceSync(css); return; } catch { uiSheet = null; }
        }
        if (uiStyleEl) uiStyleEl.textContent = css;
    }

    /*
     * The extension follows its own rule: its pages use your fonts too. Content scripts do not run on chrome-extension://
     * pages, so the fonts are applied here. Without a browser or custom font the system stack stays.
     */
    function applyFonts(settings, bf) {
        const { fonts } = F.resolveFonts(settings, bf);
        const root = document.documentElement;
        const faces = [];

        for (const [prop, cat, alias, fb] of [
            ["--font-ui", "sans", "__rme_ui_sans", "sans-serif"],
            ["--font-mono", "mono", "__rme_ui_mono", "monospace"]
        ]) {
            if (fonts[cat].source === "default") {
                root.style.removeProperty(prop);
            } else {
                faces.push(F.fontFaceCss(alias, cat, fonts[cat].name, null));
                root.style.setProperty(prop, `${F.cssQuote(fonts[cat].name)}, ${F.cssQuote(alias)}, ${fb}`);
            }
        }
        setUiFaces(faces.join("\n"));
        root.classList.add("ready");
    }

    // Never leave a page invisible if the settings fail to load
    setTimeout(() => document.documentElement.classList.add("ready"), 800);

    const send = msg => chrome.runtime.sendMessage(msg);

    async function refreshBrowserFonts() {
        try {
            const fresh = await send({ type: "rme:refresh" });
            return fresh && typeof fresh === "object" && "available" in fresh ? fresh : null;
        }
        catch { return null; }
    }

    self.RME.ui = { applyFonts, $, el, plural, select, segmented, bindSwitch, bindNumber, bindLines, toast, send, refreshBrowserFonts, animDelay };
})();
