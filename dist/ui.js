/* Respect My Eyes - DOM helpers shared by the options page and the popup (RME.ui) */
(() => {
    "use strict";

    const $ = id => document.getElementById(id);

    // Properties are assigned, everything else (aria-*, list, type...) goes through attributes
    const PROPS = new Set(["value", "checked", "disabled", "hidden"]);

    // el("button", "primary", "Add", { type: "button", onclick: fn })
    function el(tag, cls, text, attrs) {
        const node = document.createElement(tag);

        if (cls) node.className = cls;
        if (text !== undefined && text !== null) node.textContent = text;

        for (const [key, value] of Object.entries(attrs || {})) {
            if (key.startsWith("on") || PROPS.has(key)) node[key] = value;
            else node.setAttribute(key, value);
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

    // Short message, optionally with an Undo button, in the #toasts container
    function toast(message, undo) {
        const box = $("toasts");
        const node = el("div", "toast", null, { role: "status" });
        const close = () => {
            clearTimeout(timer);
            node.classList.add("out");
            setTimeout(() => node.remove(), 200);
        };

        node.append(el("span", "", message));
        if (undo) node.append(el("button", "", "Undo", { type: "button", onclick: () => { undo(); close(); } }));

        while (box.children.length >= 3) box.firstChild.remove();
        box.append(node);

        const timer = setTimeout(close, undo ? 8000 : 2600);
    }

    self.RME.ui = { $, el, plural, select, segmented, bindSwitch, bindNumber, bindLines, toast, send: msg => chrome.runtime.sendMessage(msg) };
})();
