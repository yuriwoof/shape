// Mermaid flowchart export.
import { center, isNode, rectContains } from "./geometry.mjs";

function mermaidLabel(text) {
    return `"${String(text ?? "")
        .replace(/"/g, "#quot;")
        .replace(/\r?\n/g, "<br/>")}"`;
}

function nodeShape(el, id) {
    const label = mermaidLabel(el.label || el.id);
    switch (el.type) {
        case "rounded":
            return `${id}(${label})`;
        case "ellipse":
            return `${id}([${label}])`;
        case "diamond":
            return `${id}{${label}}`;
        case "cylinder":
            return `${id}[(${label})]`;
        default:
            return `${id}[${label}]`;
    }
}

function arrowOperator(style, hasLabel) {
    const dashed = style.dashed;
    const head = style.head;
    let op;
    if (head === "none") op = dashed ? "-.-" : "---";
    else if (head === "both") op = dashed ? "<-.->" : "<-->";
    else op = dashed ? "-.->" : "-->";
    return { op, hasLabel };
}

export function toMermaid(doc) {
    const nodes = doc.elements.filter((el) => isNode(el));
    const frames = nodes.filter((el) => el.type === "frame");
    const arrows = doc.elements.filter((el) => el.type === "arrow");
    const ids = new Map();
    const used = new Set();
    for (const el of nodes) {
        let base = el.id.replace(/[^A-Za-z0-9_]/g, "_").replace(/^(\d)/, "n$1") || "node";
        if (["end", "graph", "subgraph", "style", "class", "click", "flowchart"].includes(base.toLowerCase())) base = `${base}_`;
        let candidate = base;
        let i = 2;
        while (used.has(candidate)) candidate = `${base}_${i++}`;
        used.add(candidate);
        ids.set(el.id, candidate);
    }

    // Each node belongs to the smallest frame that contains it.
    const area = (el) => el.w * el.h;
    const parentOf = new Map();
    for (const el of nodes) {
        const box = el.type === "frame" ? el : { x: center(el).x, y: center(el).y, w: 0, h: 0 };
        let best = null;
        for (const frame of frames) {
            if (frame === el || !rectContains(frame, box)) continue;
            if (el.type === "frame" && area(frame) <= area(el)) continue;
            if (!best || area(frame) < area(best)) best = frame;
        }
        parentOf.set(el.id, best ? best.id : null);
    }

    let dx = 0;
    let dy = 0;
    const byId = new Map(nodes.map((el) => [el.id, el]));
    for (const arrow of arrows) {
        const a = byId.get(arrow.from);
        const b = byId.get(arrow.to);
        if (!a || !b) continue;
        dx += Math.abs(center(b).x - center(a).x);
        dy += Math.abs(center(b).y - center(a).y);
    }
    const lines = [`flowchart ${dx > dy ? "LR" : "TD"}`];

    const emit = (parentId, indent) => {
        for (const el of nodes) {
            if (parentOf.get(el.id) !== parentId) continue;
            if (el.type === "frame") {
                lines.push(`${indent}subgraph ${ids.get(el.id)}[${mermaidLabel(el.label || el.id)}]`);
                emit(el.id, `${indent}    `);
                lines.push(`${indent}end`);
            } else {
                lines.push(`${indent}${nodeShape(el, ids.get(el.id))}`);
            }
        }
    };
    emit(null, "    ");

    const skipped = [];
    for (const arrow of arrows) {
        const from = ids.get(arrow.from);
        const to = ids.get(arrow.to);
        if (!from || !to) {
            skipped.push(arrow.id);
            continue;
        }
        const { op } = arrowOperator(arrow.style, Boolean(arrow.label));
        const label = arrow.label ? `|${mermaidLabel(arrow.label)}|` : "";
        lines.push(`    ${from} ${op}${label} ${to}`);
    }
    if (skipped.length) lines.push(`    %% unconnected arrows omitted: ${skipped.join(", ")}`);
    return `${lines.join("\n")}\n`;
}
