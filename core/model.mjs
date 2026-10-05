// Isomorphic document model: schema normalization, patches and diffs.
import { arrowPoints, lookupFn } from "./geometry.mjs";

export const NODE_TYPES = Object.freeze(["rect", "rounded", "ellipse", "diamond", "cylinder", "text", "frame"]);
export const ELEMENT_TYPES = Object.freeze([...NODE_TYPES, "arrow"]);
export const ARROW_HEADS = Object.freeze(["end", "start", "both", "none"]);
export const ARROW_ROUTES = Object.freeze(["straight", "elbow"]);
export const LIMITS = Object.freeze({
    elements: 2000,
    strokes: 3000,
    pointsPerStroke: 5000,
    label: 1000,
    id: 64,
    title: 200,
    coordinate: 1_000_000,
});

const TYPE_ALIASES = {
    rectangle: "rect",
    box: "rect",
    square: "rect",
    process: "rect",
    "rounded-rect": "rounded",
    roundrect: "rounded",
    round: "rounded",
    pill: "rounded",
    circle: "ellipse",
    oval: "ellipse",
    decision: "diamond",
    rhombus: "diamond",
    database: "cylinder",
    db: "cylinder",
    storage: "cylinder",
    label: "text",
    note: "text",
    group: "frame",
    container: "frame",
    boundary: "frame",
    line: "arrow",
    edge: "arrow",
    connector: "arrow",
};

export const DEFAULT_STYLE = Object.freeze({
    node: Object.freeze({ stroke: "#1f2328", fill: "#ffffff", text: "#1f2328", strokeWidth: 2, dashed: false, fontSize: 16 }),
    text: Object.freeze({ stroke: "none", fill: "none", text: "#1f2328", strokeWidth: 0, dashed: false, fontSize: 18 }),
    frame: Object.freeze({ stroke: "#8c959f", fill: "none", text: "#57606a", strokeWidth: 1.5, dashed: true, fontSize: 14 }),
    arrow: Object.freeze({ stroke: "#1f2328", text: "#1f2328", strokeWidth: 2, dashed: false, fontSize: 14, head: "end", route: "straight" }),
});

export const DEFAULT_SIZE = Object.freeze({
    rect: [160, 72],
    rounded: [160, 72],
    ellipse: [140, 80],
    diamond: [160, 100],
    cylinder: [120, 96],
    text: [160, 40],
    frame: [400, 300],
});

const STYLE_KEYS = ["stroke", "fill", "text", "textColor", "color", "strokeWidth", "dashed", "fontSize", "head", "route"];

export function normalizeType(value) {
    const type = String(value ?? "").trim().toLowerCase();
    if (ELEMENT_TYPES.includes(type)) return type;
    return TYPE_ALIASES[type] || null;
}

export function styleKind(type) {
    if (type === "arrow") return "arrow";
    if (type === "text") return "text";
    if (type === "frame") return "frame";
    return "node";
}

export function sanitizeId(value) {
    if (value === undefined || value === null) return "";
    return String(value)
        .trim()
        .replace(/[^\p{L}\p{N}_.:-]+/gu, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, LIMITS.id);
}

export function makeId(prefix, taken) {
    for (;;) {
        const id = `${prefix}-${Math.random().toString(36).slice(2, 7)}`;
        if (!taken || !taken.has(id)) return id;
    }
}

function num(value, fallback) {
    const n = typeof value === "string" && value.trim() === "" ? NaN : Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.round(Math.max(-LIMITS.coordinate, Math.min(LIMITS.coordinate, n)) * 10) / 10;
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

const COLOR_PATTERN = /^(#[0-9a-f]{3}|#[0-9a-f]{4}|#[0-9a-f]{6}|#[0-9a-f]{8}|[a-z]{3,24}|rgba?\([\d\s.,%]+\)|hsla?\([\d\s.,%deg]+\))$/i;

function color(value, fallback, allowNone = false) {
    if (value === undefined || value === null || value === "") return fallback;
    const text = String(value).trim().toLowerCase();
    if (text === "none" || text === "transparent") return allowNone ? "none" : fallback;
    return COLOR_PATTERN.test(text) ? text : fallback;
}

export function normalizeStyle(type, input) {
    const kind = styleKind(type);
    const defaults = DEFAULT_STYLE[kind];
    const s = input && typeof input === "object" ? input : {};
    const style = {
        stroke: color(s.stroke, defaults.stroke, true),
        text: color(s.text ?? s.textColor ?? s.color, defaults.text),
        strokeWidth: clamp(num(s.strokeWidth, defaults.strokeWidth), 0, 16),
        dashed: s.dashed === undefined || s.dashed === null ? defaults.dashed : Boolean(s.dashed),
        fontSize: clamp(num(s.fontSize, defaults.fontSize), 8, 120),
    };
    if (kind === "arrow") {
        style.head = ARROW_HEADS.includes(s.head) ? s.head : defaults.head;
        style.route = ARROW_ROUTES.includes(s.route) ? s.route : defaults.route;
    } else {
        style.fill = color(s.fill, defaults.fill, true);
    }
    return style;
}

// Maps loose / alias keys (width, text, source, top-level style keys...) onto canonical keys.
export function canonicalKeys(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const out = { ...raw };
    const alias = (from, to) => {
        if (out[from] !== undefined && out[to] === undefined) out[to] = out[from];
        delete out[from];
    };
    alias("width", "w");
    alias("height", "h");
    alias("text", "label");
    alias("source", "from");
    alias("target", "to");
    alias("shape", "type");
    if (out.start && typeof out.start === "object") {
        if (out.x1 === undefined) out.x1 = out.start.x;
        if (out.y1 === undefined) out.y1 = out.start.y;
    }
    if (out.end && typeof out.end === "object") {
        if (out.x2 === undefined) out.x2 = out.end.x;
        if (out.y2 === undefined) out.y2 = out.end.y;
    }
    delete out.start;
    delete out.end;
    const style = out.style && typeof out.style === "object" ? { ...out.style } : undefined;
    let movedStyle;
    for (const key of STYLE_KEYS) {
        if (key in out && key !== "text") {
            movedStyle ??= {};
            movedStyle[key] = out[key];
            delete out[key];
        }
    }
    if (style || movedStyle) out.style = { ...(movedStyle || {}), ...(style || {}) };
    return out;
}

export function normalizeElement(rawInput, warnings = [], taken = undefined) {
    const raw = canonicalKeys(rawInput);
    if (!rawInput || typeof rawInput !== "object") {
        warnings.push("Ignored an element that is not an object.");
        return null;
    }
    const type = normalizeType(raw.type ?? "rect");
    if (!type) {
        warnings.push(`Ignored element "${raw.id ?? "?"}": unknown type "${raw.type}". Use one of ${ELEMENT_TYPES.join(", ")}.`);
        return null;
    }
    const id = sanitizeId(raw.id) || makeId(type === "arrow" ? "arrow" : "node", taken);
    const label = raw.label === undefined || raw.label === null ? "" : String(raw.label).slice(0, LIMITS.label);
    const style = normalizeStyle(type, raw.style);
    if (type === "arrow") {
        return {
            id,
            type,
            from: sanitizeId(raw.from) || null,
            to: sanitizeId(raw.to) || null,
            x1: num(raw.x1, 0),
            y1: num(raw.y1, 0),
            x2: num(raw.x2, num(raw.x1, 0) + 120),
            y2: num(raw.y2, num(raw.y1, 0)),
            label,
            style,
        };
    }
    const [dw, dh] = DEFAULT_SIZE[type];
    return {
        id,
        type,
        x: num(raw.x, 0),
        y: num(raw.y, 0),
        w: clamp(num(raw.w, dw), 8, 20000),
        h: clamp(num(raw.h, dh), 8, 20000),
        label,
        style,
    };
}

export function normalizeStroke(raw, taken = undefined) {
    if (!raw || typeof raw !== "object") return null;
    const source = Array.isArray(raw.points) ? raw.points.slice(0, LIMITS.pointsPerStroke) : [];
    const points = [];
    for (const point of source) {
        const x = Array.isArray(point) ? point[0] : point?.x;
        const y = Array.isArray(point) ? point[1] : point?.y;
        const p = Array.isArray(point) ? point[2] : point?.pressure ?? point?.p;
        if (!Number.isFinite(Number(x)) || !Number.isFinite(Number(y))) continue;
        points.push([num(x, 0), num(y, 0), Math.round(clamp(Number.isFinite(Number(p)) ? Number(p) : 0.5, 0, 1) * 100) / 100]);
    }
    if (!points.length) return null;
    return {
        id: sanitizeId(raw.id) || makeId("stroke", taken),
        points,
        color: color(raw.color, "#e8590c"),
        width: clamp(num(raw.width, 3), 0.5, 40),
    };
}

export function emptyDocument(documentId, title = "Untitled diagram") {
    return {
        version: 1,
        documentId,
        title: String(title).slice(0, LIMITS.title),
        revision: 0,
        updatedAt: new Date(0).toISOString(),
        elements: [],
        strokes: [],
    };
}

export function normalizeDocument(raw, documentId, fallbackTitle = "Untitled diagram") {
    const doc = emptyDocument(documentId, raw?.title || fallbackTitle);
    doc.revision = Number.isInteger(raw?.revision) && raw.revision >= 0 ? raw.revision : 0;
    doc.updatedAt = typeof raw?.updatedAt === "string" ? raw.updatedAt : doc.updatedAt;
    const result = applyPatch(doc, {
        add: Array.isArray(raw?.elements) ? raw.elements : [],
        addStrokes: Array.isArray(raw?.strokes) ? raw.strokes : [],
    });
    return { ...result.doc, revision: doc.revision, updatedAt: doc.updatedAt };
}

function asArray(value) {
    if (value === undefined || value === null) return [];
    return Array.isArray(value) ? value : [value];
}

function mergeElement(current, update) {
    const patch = canonicalKeys(update);
    const merged = { ...current, ...patch };
    merged.style = { ...current.style, ...(patch.style || {}) };
    merged.id = current.id;
    return merged;
}

/**
 * Applies a patch to a document without mutating it.
 * patch: { title?, add?: Element[], update?: Partial<Element>[] (by id), delete?: id[],
 *          addStrokes?: Stroke[], deleteStrokes?: id[] | "all" | true,
 *          order?: id[] (z-order; listed ids first, unlisted keep their relative order after) }
 */
export function applyPatch(doc, patch = {}, options = {}) {
    const warnings = [];
    const summary = { added: [], updated: [], deleted: [], strokesAdded: 0, strokesDeleted: 0 };
    const before = new Map(doc.elements.map((element) => [element.id, element]));
    const elements = new Map(before);

    for (const rawId of asArray(patch.delete)) {
        const id = sanitizeId(rawId);
        if (elements.delete(id)) summary.deleted.push(id);
        else warnings.push(`delete: element "${rawId}" does not exist.`);
    }

    for (const raw of asArray(patch.add)) {
        if (elements.size >= LIMITS.elements) {
            warnings.push(`add: element limit (${LIMITS.elements}) reached.`);
            break;
        }
        const element = normalizeElement(raw, warnings, elements);
        if (!element) continue;
        if (elements.has(element.id) && !options.silentReplace) {
            warnings.push(`add: element "${element.id}" already existed and was replaced.`);
        }
        elements.set(element.id, element);
        summary.added.push(element.id);
    }

    for (const raw of asArray(patch.update)) {
        const id = sanitizeId(raw?.id);
        const current = elements.get(id);
        if (!current) {
            warnings.push(`update: element "${raw?.id}" does not exist.`);
            continue;
        }
        const element = normalizeElement(mergeElement(current, raw), warnings, elements);
        if (!element) continue;
        elements.set(id, element);
        summary.updated.push(id);
    }

    if (Array.isArray(patch.order)) reorder(elements, patch.order);

    const strokes = new Map(doc.strokes.map((stroke) => [stroke.id, stroke]));
    if (patch.deleteStrokes === "all" || patch.deleteStrokes === true) {
        summary.strokesDeleted = strokes.size;
        strokes.clear();
    } else {
        for (const rawId of asArray(patch.deleteStrokes)) {
            if (strokes.delete(sanitizeId(rawId))) summary.strokesDeleted += 1;
        }
    }
    for (const raw of asArray(patch.addStrokes)) {
        if (strokes.size >= LIMITS.strokes) {
            warnings.push(`addStrokes: stroke limit (${LIMITS.strokes}) reached.`);
            break;
        }
        const stroke = normalizeStroke(raw, strokes);
        if (!stroke) continue;
        strokes.set(stroke.id, stroke);
        summary.strokesAdded += 1;
    }

    // Keep arrow coordinates in sync with bound nodes; arrows whose bound node disappeared
    // keep their last resolved position as free endpoints.
    const resolve = lookupFn((id) => elements.get(id) ?? before.get(id));
    const r = (n) => Math.round(n * 10) / 10;
    for (const [id, element] of elements) {
        if (element.type !== "arrow" || (!element.from && !element.to)) continue;
        const points = arrowPoints(element, resolve);
        const last = points[points.length - 1];
        const next = { ...element };
        if (element.from) {
            next.x1 = r(points[0].x);
            next.y1 = r(points[0].y);
        }
        if (element.to) {
            next.x2 = r(last.x);
            next.y2 = r(last.y);
        }
        const fromOk = !element.from || (elements.has(element.from) && elements.get(element.from).type !== "arrow");
        const toOk = !element.to || (elements.has(element.to) && elements.get(element.to).type !== "arrow");
        if (!fromOk) {
            if (!before.has(element.from)) warnings.push(`arrow "${id}": from "${element.from}" does not exist; endpoint left unbound.`);
            next.from = null;
        }
        if (!toOk) {
            if (!before.has(element.to)) warnings.push(`arrow "${id}": to "${element.to}" does not exist; endpoint left unbound.`);
            next.to = null;
        }
        if (JSON.stringify(next) !== JSON.stringify(element)) elements.set(id, next);
    }

    const title = typeof patch.title === "string" && patch.title.trim() ? patch.title.trim().slice(0, LIMITS.title) : doc.title;
    return {
        doc: { ...doc, title, elements: [...elements.values()], strokes: [...strokes.values()] },
        warnings,
        summary,
    };
}

/** Minimal patch that turns document a into document b (updates carry full elements). */
export function diff(a, b) {
    const patch = {};
    const aElements = new Map(a.elements.map((element) => [element.id, element]));
    const bElements = new Map(b.elements.map((element) => [element.id, element]));
    const add = [];
    const update = [];
    const del = [];
    for (const [id, element] of bElements) {
        const previous = aElements.get(id);
        if (!previous) add.push(element);
        else if (JSON.stringify(previous) !== JSON.stringify(element)) update.push(element);
    }
    for (const id of aElements.keys()) if (!bElements.has(id)) del.push(id);
    const aStrokes = new Set(a.strokes.map((stroke) => stroke.id));
    const bStrokes = new Set(b.strokes.map((stroke) => stroke.id));
    const addStrokes = b.strokes.filter((stroke) => !aStrokes.has(stroke.id));
    const deleteStrokes = [...aStrokes].filter((id) => !bStrokes.has(id));
    if (del.length) patch.delete = del;
    if (add.length) patch.add = add;
    if (update.length) patch.update = update;
    if (addStrokes.length) patch.addStrokes = addStrokes;
    if (deleteStrokes.length) patch.deleteStrokes = deleteStrokes;
    if (a.title !== b.title) patch.title = b.title;
    const deleted = new Set(del);
    const predicted = [...aElements.keys()].filter((id) => !deleted.has(id)).concat(add.map((element) => element.id));
    const target = [...bElements.keys()];
    if (predicted.some((id, index) => id !== target[index])) patch.order = target;
    return patch;
}

/** Moves the listed ids (in the given order) ahead of any unlisted elements, in place. */
function reorder(elements, order) {
    const entries = [];
    const seen = new Set();
    for (const rawId of order) {
        const id = sanitizeId(rawId);
        if (seen.has(id) || !elements.has(id)) continue;
        seen.add(id);
        entries.push([id, elements.get(id)]);
    }
    for (const entry of elements) if (!seen.has(entry[0])) entries.push(entry);
    elements.clear();
    for (const [id, element] of entries) elements.set(id, element);
}

export function isEmptyPatch(patch) {
    return !patch || Object.keys(patch).length === 0;
}

export function elementMap(doc) {
    return new Map(doc.elements.map((element) => [element.id, element]));
}
