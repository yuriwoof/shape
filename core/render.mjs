// Isomorphic SVG renderer. Produces strings so it works in Node (export) and the browser.
import { arrowPoints, lookupFn, padBounds, polylineMidpoint, sceneBounds } from "./geometry.mjs";
import { getAzureService } from "./azure-icons.mjs";

export const FONT_FAMILY = `system-ui, -apple-system, "Segoe UI", "Hiragino Sans", "Yu Gothic UI", "Noto Sans JP", sans-serif`;

export function escapeXml(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

const WIDE = /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6\u{1f300}-\u{1faff}]/u;

export function charWidth(ch, fontSize) {
    if (WIDE.test(ch)) return fontSize;
    if (ch === " ") return fontSize * 0.3;
    if (/[A-Z0-9MW@#%&]/.test(ch)) return fontSize * 0.64;
    if (/[il.,:;'|!]/.test(ch)) return fontSize * 0.3;
    return fontSize * 0.55;
}

export function textWidth(text, fontSize) {
    let width = 0;
    for (const ch of String(text)) width += charWidth(ch, fontSize);
    return width;
}

// Greedy wrap that breaks on spaces for latin text and anywhere for CJK.
export function wrapText(label, maxWidth, fontSize) {
    const lines = [];
    for (const paragraph of String(label ?? "").split(/\r?\n/)) {
        if (!paragraph) {
            lines.push("");
            continue;
        }
        const tokens = paragraph.match(/[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\uff00-\uffef]|[^\s\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\uff00-\uffef]+|\s+/gu) || [];
        let line = "";
        for (const token of tokens) {
            const candidate = line + token;
            if (line && textWidth(candidate.trimEnd(), fontSize) > maxWidth) {
                lines.push(line.trimEnd());
                line = /^\s+$/.test(token) ? "" : token;
                while (textWidth(line, fontSize) > maxWidth && line.length > 1) {
                    let cut = line.length - 1;
                    while (cut > 1 && textWidth(line.slice(0, cut), fontSize) > maxWidth) cut -= 1;
                    lines.push(line.slice(0, cut));
                    line = line.slice(cut);
                }
            } else {
                line = candidate;
            }
        }
        lines.push(line.trimEnd());
    }
    return lines;
}

function dashAttr(style) {
    if (!style.dashed) return "";
    const unit = Math.max(style.strokeWidth || 1, 1);
    return ` stroke-dasharray="${unit * 4} ${unit * 3}"`;
}

function paintAttrs(style, { fill = true } = {}) {
    const stroke = style.stroke && style.stroke !== "none" && style.strokeWidth > 0 ? style.stroke : "none";
    let attrs = ` stroke="${escapeXml(stroke)}" stroke-width="${style.strokeWidth}" stroke-linejoin="round"`;
    attrs += fill ? ` fill="${escapeXml(style.fill || "none")}"` : ` fill="none"`;
    return attrs + dashAttr(style);
}

function textBlock(lines, cx, cy, style, anchor = "middle") {
    const lineHeight = style.fontSize * 1.25;
    const startY = cy - ((lines.length - 1) * lineHeight) / 2;
    const tspans = lines
        .map((line, i) => `<tspan x="${round(cx)}" y="${round(startY + i * lineHeight)}">${escapeXml(line) || " "}</tspan>`)
        .join("");
    return `<text font-family='${FONT_FAMILY}' font-size="${style.fontSize}" fill="${escapeXml(style.text)}" text-anchor="${anchor}" dominant-baseline="central">${tspans}</text>`;
}

function round(n) {
    return Math.round(n * 10) / 10;
}

export function shapeMarkup(el) {
    const { x, y, w, h, style } = el;
    switch (el.type) {
        case "rounded": {
            const r = Math.min(16, w / 4, h / 4);
            return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" ry="${r}"${paintAttrs(style)}/>`;
        }
        case "ellipse":
            return `<ellipse cx="${round(x + w / 2)}" cy="${round(y + h / 2)}" rx="${round(w / 2)}" ry="${round(h / 2)}"${paintAttrs(style)}/>`;
        case "diamond":
            return `<polygon points="${round(x + w / 2)},${y} ${x + w},${round(y + h / 2)} ${round(x + w / 2)},${y + h} ${x},${round(y + h / 2)}"${paintAttrs(style)}/>`;
        case "cylinder": {
            const ry = Math.min(h * 0.15, 16);
            const rx = w / 2;
            const body = `M${x},${round(y + ry)} A${round(rx)},${round(ry)} 0 0 0 ${x + w},${round(y + ry)} L${x + w},${round(y + h - ry)} A${round(rx)},${round(ry)} 0 0 1 ${x},${round(y + h - ry)} Z`;
            const top = `M${x},${round(y + ry)} A${round(rx)},${round(ry)} 0 0 1 ${x + w},${round(y + ry)}`;
            return `<path d="${body}"${paintAttrs(style)}/><path d="${top}"${paintAttrs(style, { fill: false })}/>`;
        }
        case "text":
            return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${escapeXml(style.fill || "none")}" stroke="${style.stroke !== "none" && style.strokeWidth > 0 ? escapeXml(style.stroke) : "none"}" stroke-width="${style.strokeWidth}"${dashAttr(style)}/>`;
        case "frame":
            return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="8" ry="8"${paintAttrs(style)}/>`;
        case "azure-service":
            return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="8" ry="8"${paintAttrs(style)}/>`;
        default:
            return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="2" ry="2"${paintAttrs(style)}/>`;
    }
}

export function nodeLabelMarkup(el) {
    if (el.type === "azure-service") {
        const service = getAzureService(el.service);
        if (!service) return "";
        const size = Math.min(44, el.w * 0.4, el.h * 0.42);
        const iconX = round(el.x + (el.w - size) / 2);
        const iconY = round(el.y + 8);
        const icon = `<svg x="${iconX}" y="${iconY}" width="${round(size)}" height="${round(size)}" viewBox="0 0 18 18" overflow="visible">${service.svg}</svg>`;
        const label = el.label && el.label !== service.name ? `${service.name}\n${el.label}` : service.name;
        const lines = wrapText(label, Math.max(el.w - 16, 24), el.style.fontSize);
        const labelY = iconY + size + 8 + (lines.length * el.style.fontSize * 1.25) / 2;
        return icon + textBlock(lines, el.x + el.w / 2, labelY, el.style);
    }
    if (!el.label) return "";
    const style = el.style;
    if (el.type === "frame") {
        const lines = wrapText(el.label, Math.max(el.w - 24, 40), style.fontSize);
        const lineHeight = style.fontSize * 1.25;
        return textBlock(lines, el.x + 12, el.y + 12 + style.fontSize / 2 + ((lines.length - 1) * lineHeight) / 2, style, "start");
    }
    let inset = 12;
    if (el.type === "ellipse" || el.type === "diamond") inset = el.w * 0.18;
    if (el.type === "text") inset = 4;
    const lines = wrapText(el.label, Math.max(el.w - inset * 2, 24), style.fontSize);
    let cy = el.y + el.h / 2;
    if (el.type === "cylinder") cy += Math.min(el.h * 0.15, 16) / 2;
    return textBlock(lines, el.x + el.w / 2, cy, style);
}

function headPolygon(tip, from, size, color) {
    const angle = Math.atan2(tip.y - from.y, tip.x - from.x);
    const spread = Math.PI / 7;
    const p1 = { x: tip.x - size * Math.cos(angle - spread), y: tip.y - size * Math.sin(angle - spread) };
    const p2 = { x: tip.x - size * Math.cos(angle + spread), y: tip.y - size * Math.sin(angle + spread) };
    return `<polygon points="${round(tip.x)},${round(tip.y)} ${round(p1.x)},${round(p1.y)} ${round(p2.x)},${round(p2.y)}" fill="${escapeXml(color)}" stroke="${escapeXml(color)}" stroke-width="1" stroke-linejoin="round"/>`;
}

function shorten(tip, from, by) {
    const length = Math.hypot(tip.x - from.x, tip.y - from.y);
    if (length <= by || length === 0) return tip;
    const t = (length - by) / length;
    return { x: from.x + (tip.x - from.x) * t, y: from.y + (tip.y - from.y) * t };
}

export function arrowMarkup(el, lookup, obstacles = []) {
    const style = el.style;
    const points = arrowPoints(el, lookup, obstacles).map((p) => ({ ...p }));
    const size = 9 + style.strokeWidth * 2.5;
    const n = points.length;
    const heads = [];
    const color = style.stroke === "none" ? "#1f2328" : style.stroke;
    const original = points.map((p) => ({ ...p }));
    if (style.head === "end" || style.head === "both") {
        heads.push(headPolygon(original[n - 1], original[n - 2], size, color));
        points[n - 1] = shorten(original[n - 1], original[n - 2], size * 0.8);
    }
    if (style.head === "start" || style.head === "both") {
        heads.push(headPolygon(original[0], original[1], size, color));
        points[0] = shorten(original[0], original[1], size * 0.8);
    }
    const d = points.map((p, i) => `${i ? "L" : "M"}${round(p.x)},${round(p.y)}`).join(" ");
    let markup = `<path d="${d}" fill="none" stroke="${escapeXml(color)}" stroke-width="${style.strokeWidth}" stroke-linecap="round" stroke-linejoin="round"${dashAttr(style)}/>`;
    markup += heads.join("");
    if (el.label) {
        const mid = polylineMidpoint(original);
        const lines = wrapText(el.label, 220, style.fontSize);
        const width = Math.max(...lines.map((line) => textWidth(line, style.fontSize))) + 10;
        const height = lines.length * style.fontSize * 1.25 + 4;
        markup += `<rect x="${round(mid.x - width / 2)}" y="${round(mid.y - height / 2)}" width="${round(width)}" height="${round(height)}" rx="4" fill="#ffffff" fill-opacity="0.92"/>`;
        markup += textBlock(lines, mid.x, mid.y, style);
    }
    return markup;
}

// Smooth path through freehand points using quadratic curves between midpoints.
export function strokePathData(points) {
    if (!points.length) return "";
    const pt = (p) => (Array.isArray(p) ? { x: p[0], y: p[1] } : p);
    const first = pt(points[0]);
    if (points.length === 1) return `M${round(first.x)},${round(first.y)} l0.01,0`;
    if (points.length === 2) {
        const second = pt(points[1]);
        return `M${round(first.x)},${round(first.y)} L${round(second.x)},${round(second.y)}`;
    }
    let d = `M${round(first.x)},${round(first.y)}`;
    for (let i = 1; i < points.length - 1; i += 1) {
        const a = pt(points[i]);
        const b = pt(points[i + 1]);
        d += ` Q${round(a.x)},${round(a.y)} ${round((a.x + b.x) / 2)},${round((a.y + b.y) / 2)}`;
    }
    const last = pt(points[points.length - 1]);
    return `${d} L${round(last.x)},${round(last.y)}`;
}

export function strokeMarkup(stroke, attrs = "") {
    return `<path d="${strokePathData(stroke.points)}" fill="none" stroke="${escapeXml(stroke.color)}" stroke-width="${stroke.width}" stroke-linecap="round" stroke-linejoin="round"${attrs}/>`;
}

export function elementMarkup(el, lookup, obstacles) {
    if (el.type === "arrow") return arrowMarkup(el, lookup, obstacles);
    return shapeMarkup(el) + nodeLabelMarkup(el);
}

function layer(el) {
    if (el.type === "frame") return 0;
    if (el.type === "arrow") return 2;
    if (el.type === "text") return 3;
    return 1;
}

export function orderedElements(elements) {
    return elements
        .map((el, index) => ({ el, index }))
        .sort((a, b) => layer(a.el) - layer(b.el) || a.index - b.index)
        .map(({ el }) => el);
}

function idTag(el, lookup, obstacles) {
    let x;
    let y;
    if (el.type === "arrow") {
        const mid = polylineMidpoint(arrowPoints(el, lookup, obstacles));
        x = mid.x + 6;
        y = mid.y - 10;
    } else {
        x = el.x + 2;
        y = el.y - 5;
    }
    return `<text x="${round(x)}" y="${round(y)}" font-family="ui-monospace, Consolas, monospace" font-size="11" fill="#0969da">#${escapeXml(el.id)}</text>`;
}

/**
 * Renders the elements (and optionally strokes) as SVG groups.
 * options: { includeStrokes, showIds, muted (opacity for elements), dataAttributes }
 */
export function sceneMarkup(doc, options = {}) {
    const lookup = lookupFn(doc.elements);
    const muted = options.muted ? ` opacity="${options.muted}"` : "";
    let out = `<g class="elements"${muted}>`;
    for (const el of orderedElements(doc.elements)) {
        const data = options.dataAttributes ? ` data-id="${escapeXml(el.id)}"` : "";
        out += `<g${data}>${elementMarkup(el, lookup, doc.elements)}</g>`;
    }
    out += "</g>";
    if (options.showIds) {
        out += `<g class="ids">${doc.elements.map((el) => idTag(el, lookup, doc.elements)).join("")}</g>`;
    }
    if (options.includeStrokes && doc.strokes.length) {
        out += `<g class="strokes">${doc.strokes.map((stroke) => strokeMarkup(stroke)).join("")}</g>`;
    }
    return out;
}

function gridMarkup(bounds, step) {
    const startX = Math.ceil(bounds.x / step) * step;
    const startY = Math.ceil(bounds.y / step) * step;
    let lines = "";
    let labels = "";
    for (let x = startX; x <= bounds.x + bounds.w; x += step) {
        lines += `<line x1="${x}" y1="${bounds.y}" x2="${x}" y2="${bounds.y + bounds.h}"/>`;
        labels += `<text x="${x + 2}" y="${round(bounds.y + 10)}">${x}</text>`;
    }
    for (let y = startY; y <= bounds.y + bounds.h; y += step) {
        lines += `<line x1="${bounds.x}" y1="${y}" x2="${bounds.x + bounds.w}" y2="${y}"/>`;
        labels += `<text x="${round(bounds.x + 2)}" y="${y - 2}">${y}</text>`;
    }
    return `<g stroke="#d0d7de" stroke-width="0.6">${lines}</g><g font-family="ui-monospace, Consolas, monospace" font-size="9" fill="#8c959f">${labels}</g>`;
}

/**
 * Standalone SVG document.
 * options: { padding=40, background="#ffffff", includeStrokes=false, showIds=false, muted, grid (step), bounds, scale=1 }
 * Returns { svg, frame: {x, y, w, h, scale}, width, height }.
 */
export function renderSvg(doc, options = {}) {
    const padding = options.padding ?? 40;
    const content = options.bounds || sceneBounds(doc, { includeStrokes: Boolean(options.includeStrokes) }) || { x: 0, y: 0, w: 400, h: 300 };
    const bounds = padBounds(content, padding);
    const scale = options.scale ?? 1;
    const width = Math.max(1, Math.round(bounds.w * scale));
    const height = Math.max(1, Math.round(bounds.h * scale));
    const background = options.background ?? "#ffffff";
    let body = "";
    if (background && background !== "none") {
        body += `<rect x="${round(bounds.x)}" y="${round(bounds.y)}" width="${round(bounds.w)}" height="${round(bounds.h)}" fill="${escapeXml(background)}"/>`;
    }
    if (options.grid) body += gridMarkup(bounds, options.grid);
    body += sceneMarkup(doc, options);
    const title = doc.title ? `<title>${escapeXml(doc.title)}</title>` : "";
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${round(bounds.x)} ${round(bounds.y)} ${round(bounds.w)} ${round(bounds.h)}">${title}${body}</svg>`;
    return { svg, width, height, frame: { x: round(bounds.x), y: round(bounds.y), w: round(bounds.w), h: round(bounds.h), scale } };
}
