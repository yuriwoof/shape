import { arrowPoints, distanceToPolyline, elementBounds, lookupFn, rectContains, rectsIntersect, sceneBounds, strokeBounds } from "/core/geometry.mjs";
import { applyPatch, DEFAULT_SIZE, DEFAULT_STYLE, diff, emptyDocument, isEmptyPatch, makeId } from "/core/model.mjs";
import { orderedElements, renderSvg, sceneMarkup, strokeMarkup, strokePathData, textWidth, wrapText } from "/core/render.mjs";

// ---------- Constants ----------

const params = new URLSearchParams(location.search);
const DOC_ID = params.get("doc") || "default";
const INSTANCE_ID = params.get("instance") || "";
const TOKEN = params.get("token") || "";
const CLIENT_ID = `c-${Math.random().toString(36).slice(2, 10)}`;

const STROKE_COLORS = ["#1f2328", "#868e96", "#e03131", "#e8590c", "#f08c00", "#2f9e44", "#1971c2", "#6741d9"];
const FILL_COLORS = ["none", "#ffffff", "#ffe3e3", "#fff4e6", "#fff9db", "#ebfbee", "#e7f5ff", "#f3f0ff", "#f1f3f5"];
const PEN_COLORS = ["#e8590c", "#1f2328", "#1971c2", "#2f9e44", "#e03131"];
const SHAPE_TOOLS = new Set(["rect", "ellipse", "diamond"]);
const TOOL_KEYS = { v: "select", h: "hand", p: "pen", e: "eraser", r: "rect", o: "ellipse", d: "diamond", a: "arrow", t: "text" };
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 5;

// ---------- DOM ----------

const $ = (id) => document.getElementById(id);
const board = $("board");
const world = $("world");
const sceneLayer = $("scene");
const strokesLayer = $("strokes");
const liveLayer = $("live");
const overlayLayer = $("overlay");
const editor = $("editor");
const titleInput = $("title");
const refineBar = $("refine");
const refineButton = $("refine-button");
const refineStatus = $("refine-status");
const instructionInput = $("instruction");

// ---------- State ----------

let serverDoc = emptyDocument(DOC_ID);
let doc = serverDoc;
let pending = [];
let seq = 0;
let sendChain = Promise.resolve();
let needsRebuild = false;
let loaded = false;

const undoStack = [];
const redoStack = [];

const view = { x: -80, y: -60, zoom: 1 };
let tool = "select";
let penColor = PEN_COLORS[0];
let selection = new Set();
let interaction = null;
let spaceDown = false;
let editing = null;
let refineState = { state: "idle" };
let hoverBind = null;

// ---------- Utilities ----------

function api(path, options = {}) {
    return fetch(path, {
        ...options,
        headers: { "content-type": "application/json", "x-shape-token": TOKEN, ...(options.headers || {}) },
    }).then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
        return body;
    });
}

function toast(message, kind = "info", ms = 3200) {
    const el = document.createElement("div");
    el.className = `toast ${kind}`;
    el.textContent = message;
    $("toasts").appendChild(el);
    setTimeout(() => el.remove(), ms);
}

function current() {
    return interaction?.preview || doc;
}

function byId(d = current()) {
    return new Map(d.elements.map((el) => [el.id, el]));
}

function screenToWorld(clientX, clientY) {
    const rect = board.getBoundingClientRect();
    return { x: view.x + (clientX - rect.left) / view.zoom, y: view.y + (clientY - rect.top) / view.zoom };
}

function worldToScreen(x, y) {
    const rect = board.getBoundingClientRect();
    return { x: rect.left + (x - view.x) * view.zoom, y: rect.top + (y - view.y) * view.zoom };
}

function isTyping(target) {
    return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement;
}

const r1 = (n) => Math.round(n * 10) / 10;

// ---------- Sync ----------

function rebuild() {
    doc = pending.reduce((d, entry) => applyPatch(d, entry.patch, { silentReplace: true }).doc, serverDoc);
    const ids = byId(doc);
    selection = new Set([...selection].filter((id) => ids.has(id)));
}

function send(patch) {
    const entry = { seq: ++seq, patch };
    pending.push(entry);
    sendChain = sendChain
        .then(() => api("/api/patch", { method: "POST", body: JSON.stringify({ documentId: DOC_ID, patch, clientId: CLIENT_ID, seq: entry.seq }) }))
        .then((result) => {
            if (result.warnings?.length) console.warn("shape patch warnings", result.warnings);
        })
        .catch((error) => {
            toast(`保存に失敗しました: ${error.message}`, "error");
            return resync();
        });
}

async function resync() {
    try {
        const { doc: fresh } = await api(`/api/doc?doc=${encodeURIComponent(DOC_ID)}`);
        serverDoc = fresh;
        pending = [];
        rebuild();
        render();
    } catch (error) {
        toast(`再同期に失敗しました: ${error.message}`, "error");
    }
}

function onServerDoc({ doc: incoming, clientId, seq: ackSeq, source }) {
    serverDoc = incoming;
    if (clientId === CLIENT_ID && Number.isInteger(ackSeq)) {
        pending = pending.filter((entry) => entry.seq > ackSeq);
    }
    if (interaction || editing) {
        needsRebuild = { source, own: clientId === CLIENT_ID };
        return;
    }
    applyRemote(source, clientId === CLIENT_ID);
}

function applyRemote(source, own) {
    const before = doc;
    rebuild();
    if (!own && source === "agent") {
        const forward = diff(before, doc);
        if (!isEmptyPatch(forward)) {
            undoStack.push({ patch: forward, inverse: diff(doc, before), ai: true });
            redoStack.length = 0;
        }
    }
    if (!loaded) {
        loaded = true;
        fitView(false);
    }
    render();
}

function flushDeferred() {
    if (!needsRebuild) return;
    const { source, own } = needsRebuild;
    needsRebuild = false;
    applyRemote(source, own);
}

function connect() {
    const events = new EventSource(`/api/events?doc=${encodeURIComponent(DOC_ID)}&token=${encodeURIComponent(TOKEN)}`);
    events.addEventListener("doc", (event) => onServerDoc(JSON.parse(event.data)));
    events.addEventListener("status", (event) => onStatus(JSON.parse(event.data)));
    events.onerror = () => {
        if (events.readyState === EventSource.CLOSED) setTimeout(connect, 2000);
    };
}

// ---------- Commit / undo ----------

function commit(patch, { record = true } = {}) {
    if (isEmptyPatch(patch)) return;
    const before = doc;
    const after = applyPatch(before, patch, { silentReplace: true }).doc;
    const forward = diff(before, after);
    if (isEmptyPatch(forward)) return;
    doc = after;
    if (record) {
        undoStack.push({ patch: forward, inverse: diff(after, before) });
        if (undoStack.length > 200) undoStack.shift();
        redoStack.length = 0;
    }
    send(forward);
    render();
}

function undo() {
    const entry = undoStack.pop();
    if (!entry) return;
    commit(entry.inverse, { record: false });
    redoStack.push(entry);
    render();
}

function redo() {
    const entry = redoStack.pop();
    if (!entry) return;
    commit(entry.patch, { record: false });
    undoStack.push(entry);
    render();
}

// ---------- Rendering ----------

function applyViewTransform() {
    world.setAttribute("transform", `matrix(${view.zoom},0,0,${view.zoom},${-view.x * view.zoom},${-view.y * view.zoom})`);
    const pattern = document.getElementById("grid-small");
    const step = 20 * view.zoom;
    pattern.setAttribute("width", step);
    pattern.setAttribute("height", step);
    pattern.setAttribute("x", -view.x * view.zoom);
    pattern.setAttribute("y", -view.y * view.zoom);
    pattern.firstElementChild.setAttribute("r", Math.max(0.6, Math.min(1.4, view.zoom)));
    $("zoom").textContent = `${Math.round(view.zoom * 100)}%`;
}

function render() {
    const d = current();
    sceneLayer.innerHTML = sceneMarkup({ ...d, strokes: [] }, { dataAttributes: true });
    const erasing = interaction?.kind === "erase" ? interaction.hits : null;
    strokesLayer.innerHTML = d.strokes
        .map((stroke) => strokeMarkup(stroke, ` data-stroke="${stroke.id}"${erasing?.has(stroke.id) ? ' class="erasing"' : ""}`))
        .join("");
    strokesLayer.classList.toggle("refining", refineState.state === "refining");
    renderOverlay();
    applyViewTransform();
    $("empty").classList.toggle("hidden", Boolean(d.elements.length || d.strokes.length || interaction));
    if (document.activeElement !== titleInput) titleInput.value = d.title;
    $("undo").disabled = !undoStack.length;
    $("redo").disabled = !redoStack.length;
    refineButton.disabled = refineState.state === "refining";
    updateProps();
}

function svgEl(tag, attrs) {
    const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
    return el;
}

function renderOverlay() {
    overlayLayer.replaceChildren();
    const d = current();
    const map = byId(d);
    const lookup = lookupFn(map);
    const hs = 8 / view.zoom;
    const pad = 4 / view.zoom;
    if (hoverBind && map.has(hoverBind)) {
        const b = elementBounds(map.get(hoverBind), lookup);
        overlayLayer.appendChild(svgEl("rect", { class: "bind-hint", x: b.x - pad, y: b.y - pad, width: b.w + pad * 2, height: b.h + pad * 2, rx: 6 / view.zoom }));
    }
    for (const id of selection) {
        const el = map.get(id);
        if (!el) continue;
        if (el.type === "arrow") {
            const points = arrowPoints(el, lookup);
            overlayLayer.appendChild(
                svgEl("polyline", { class: "sel-box", points: points.map((p) => `${p.x},${p.y}`).join(" "), "stroke-width": 1, "stroke-dasharray": "4 3" }),
            );
            if (selection.size === 1) {
                for (const p of [points[0], points[points.length - 1]]) {
                    overlayLayer.appendChild(svgEl("circle", { class: "handle", cx: p.x, cy: p.y, r: hs / 1.6 }));
                }
            }
            continue;
        }
        overlayLayer.appendChild(svgEl("rect", { class: "sel-box", x: el.x - pad, y: el.y - pad, width: el.w + pad * 2, height: el.h + pad * 2 }));
        if (selection.size === 1) {
            for (const [hx, hy] of corners(el)) {
                overlayLayer.appendChild(svgEl("rect", { class: "handle", x: hx - hs / 2, y: hy - hs / 2, width: hs, height: hs, rx: 1.5 / view.zoom }));
            }
        }
    }
    if (interaction?.kind === "marquee") {
        const m = normRect(interaction.start, interaction.point);
        overlayLayer.appendChild(svgEl("rect", { class: "marquee", x: m.x, y: m.y, width: m.w, height: m.h }));
    }
}

function corners(el) {
    return [
        [el.x, el.y],
        [el.x + el.w, el.y],
        [el.x + el.w, el.y + el.h],
        [el.x, el.y + el.h],
    ];
}

function normRect(a, b) {
    return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
}

// ---------- Hit testing ----------

function hitElement(p, { exclude, nodesOnly = false } = {}) {
    const d = current();
    const lookup = lookupFn(d.elements);
    const tol = 6 / view.zoom;
    const list = orderedElements(d.elements).reverse();
    for (const el of list) {
        if (el.id === exclude) continue;
        if (el.type === "arrow") {
            if (nodesOnly) continue;
            if (distanceToPolyline(p, arrowPoints(el, lookup)) <= tol + el.style.strokeWidth) return el;
            continue;
        }
        const inside = p.x >= el.x - tol && p.x <= el.x + el.w + tol && p.y >= el.y - tol && p.y <= el.y + el.h + tol;
        if (!inside) continue;
        if (el.type === "frame") {
            const nearBorder =
                Math.abs(p.x - el.x) <= tol * 1.5 ||
                Math.abs(p.x - el.x - el.w) <= tol * 1.5 ||
                Math.abs(p.y - el.y) <= tol * 1.5 ||
                Math.abs(p.y - el.y - el.h) <= tol * 1.5 ||
                p.y <= el.y + 26;
            if (!nearBorder) continue;
        }
        return el;
    }
    return null;
}

function hitHandle(p) {
    if (selection.size !== 1) return null;
    const d = current();
    const map = byId(d);
    const el = map.get([...selection][0]);
    if (!el) return null;
    const tol = 9 / view.zoom;
    if (el.type === "arrow") {
        const points = arrowPoints(el, lookupFn(map));
        if (Math.hypot(p.x - points[0].x, p.y - points[0].y) <= tol) return { el, handle: "start" };
        const last = points[points.length - 1];
        if (Math.hypot(p.x - last.x, p.y - last.y) <= tol) return { el, handle: "end" };
        return null;
    }
    const names = ["nw", "ne", "se", "sw"];
    const list = corners(el);
    for (let i = 0; i < list.length; i += 1) {
        if (Math.abs(p.x - list[i][0]) <= tol && Math.abs(p.y - list[i][1]) <= tol) return { el, handle: names[i] };
    }
    return null;
}

function bindTarget(p, exclude) {
    const el = hitElement(p, { exclude, nodesOnly: true });
    return el && el.type !== "text" ? el : null;
}

// ---------- Tools ----------

function setTool(next) {
    tool = next;
    for (const button of document.querySelectorAll("[data-tool]")) button.classList.toggle("active", button.dataset.tool === tool);
    for (const name of [...board.classList]) if (name.startsWith("tool-")) board.classList.remove(name);
    board.classList.add(`tool-${tool}`);
    $("pen-colors").classList.toggle("hidden", tool !== "pen");
    if (tool !== "select") selection.clear();
    render();
}

function startPan(e) {
    interaction = { kind: "pan", sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y };
    board.classList.add("panning");
}

function capture(e) {
    try {
        board.setPointerCapture(e.pointerId);
    } catch {
        // Synthetic or already-released pointers cannot be captured.
    }
}

board.addEventListener("pointerdown", (e) => {
    if (editing) finishEditing();
    board.focus({ preventScroll: true });
    if (e.button === 1 || (e.button === 0 && (spaceDown || tool === "hand"))) {
        e.preventDefault();
        capture(e);
        startPan(e);
        return;
    }
    if (e.button !== 0) return;
    capture(e);
    const p = screenToWorld(e.clientX, e.clientY);

    if (tool === "pen") {
        interaction = { kind: "pen", points: [[r1(p.x), r1(p.y), r1(e.pressure || 0.5)]] };
        drawLive();
        return;
    }
    if (tool === "eraser") {
        interaction = { kind: "erase", hits: new Set() };
        eraseAt(p);
        return;
    }
    if (SHAPE_TOOLS.has(tool)) {
        interaction = { kind: "create", start: p, point: p, preview: null };
        return;
    }
    if (tool === "arrow") {
        const from = bindTarget(p);
        interaction = { kind: "arrow", start: p, from: from?.id || null, preview: null };
        return;
    }
    if (tool === "text") {
        e.preventDefault();
        interaction = null;
        openEditor({ mode: "new", x: p.x, y: p.y });
        setTool("select");
        return;
    }

    // Select tool.
    const handle = hitHandle(p);
    if (handle) {
        interaction = { kind: handle.el.type === "arrow" ? "endpoint" : "resize", id: handle.el.id, handle: handle.handle, start: p, base: doc, preview: null };
        return;
    }
    const hit = hitElement(p);
    if (hit) {
        if (e.shiftKey) {
            if (selection.has(hit.id)) selection.delete(hit.id);
            else selection.add(hit.id);
        } else if (!selection.has(hit.id)) {
            selection = new Set([hit.id]);
        }
        interaction = { kind: "move", start: p, base: doc, preview: null, moved: false, duplicate: e.altKey };
        render();
        return;
    }
    if (!e.shiftKey) selection.clear();
    interaction = { kind: "marquee", start: p, point: p, additive: new Set(selection) };
    render();
});

board.addEventListener("pointermove", (e) => {
    const p = screenToWorld(e.clientX, e.clientY);
    if (!interaction) {
        if (tool === "select") {
            const handle = hitHandle(p);
            board.style.cursor = handle
                ? handle.el.type === "arrow"
                    ? "crosshair"
                    : handle.handle === "nw" || handle.handle === "se"
                      ? "nwse-resize"
                      : "nesw-resize"
                : hitElement(p)
                  ? "move"
                  : "";
        } else {
            board.style.cursor = "";
        }
        return;
    }
    const it = interaction;
    switch (it.kind) {
        case "pan":
            view.x = it.vx - (e.clientX - it.sx) / view.zoom;
            view.y = it.vy - (e.clientY - it.sy) / view.zoom;
            applyViewTransform();
            if (editing) positionEditor();
            return;
        case "pen": {
            const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
            for (const ev of events.length ? events : [e]) {
                const q = screenToWorld(ev.clientX, ev.clientY);
                const last = it.points[it.points.length - 1];
                if (Math.hypot(q.x - last[0], q.y - last[1]) * view.zoom < 1.5) continue;
                it.points.push([r1(q.x), r1(q.y), r1(ev.pressure || 0.5)]);
            }
            drawLive();
            return;
        }
        case "erase":
            eraseAt(p);
            return;
        case "create": {
            it.point = p;
            const rect = normRect(it.start, e.shiftKey ? squareEnd(it.start, p) : p);
            it.preview = applyPatch(doc, { add: [{ id: "__new", type: tool, x: rect.x, y: rect.y, w: Math.max(rect.w, 8), h: Math.max(rect.h, 8) }] }).doc;
            render();
            return;
        }
        case "arrow": {
            const target = bindTarget(p);
            const to = target && target.id !== it.from ? target.id : null;
            hoverBind = to;
            it.end = p;
            it.to = to;
            it.preview = applyPatch(doc, { add: [{ id: "__new", type: "arrow", from: it.from, to, x1: it.start.x, y1: it.start.y, x2: p.x, y2: p.y }] }).doc;
            render();
            return;
        }
        case "move": {
            const dx = p.x - it.start.x;
            const dy = p.y - it.start.y;
            if (!it.moved && Math.hypot(dx, dy) * view.zoom < 3) return;
            it.moved = true;
            it.patch = movePatch(it.base, selection, dx, dy);
            it.preview = applyPatch(it.base, it.patch).doc;
            render();
            return;
        }
        case "resize": {
            it.patch = resizePatch(it.base, it.id, it.handle, p, e.shiftKey);
            it.preview = applyPatch(it.base, it.patch).doc;
            render();
            return;
        }
        case "endpoint": {
            const target = bindTarget(p);
            const el = byId(it.base).get(it.id);
            const other = it.handle === "start" ? el.to : el.from;
            const bound = target && target.id !== other ? target.id : null;
            hoverBind = bound;
            const update = it.handle === "start" ? { id: it.id, from: bound, x1: p.x, y1: p.y } : { id: it.id, to: bound, x2: p.x, y2: p.y };
            it.patch = { update: [update] };
            it.preview = applyPatch(it.base, it.patch).doc;
            render();
            return;
        }
        case "marquee": {
            it.point = p;
            const m = normRect(it.start, p);
            const lookup = lookupFn(doc.elements);
            selection = new Set(it.additive);
            for (const el of doc.elements) {
                const b = elementBounds(el, lookup);
                if (b && rectContains(m, b)) selection.add(el.id);
            }
            render();
            return;
        }
        default:
    }
});

function endInteraction(e) {
    const it = interaction;
    if (!it) return;
    interaction = null;
    hoverBind = null;
    board.classList.remove("panning");
    try {
        board.releasePointerCapture(e.pointerId);
    } catch {
        // Already released.
    }
    switch (it.kind) {
        case "pen":
            liveLayer.replaceChildren();
            if (it.points.length) commit({ addStrokes: [{ id: makeId("stroke", new Set(doc.strokes.map((s) => s.id))), points: it.points, color: penColor, width: 3 }] });
            break;
        case "erase":
            if (it.hits.size) commit({ deleteStrokes: [...it.hits] });
            break;
        case "create": {
            const dragged = Math.hypot(it.point.x - it.start.x, it.point.y - it.start.y) * view.zoom > 6;
            const [dw, dh] = DEFAULT_SIZE[tool];
            const rect = dragged
                ? normRect(it.start, e.shiftKey ? squareEnd(it.start, it.point) : it.point)
                : { x: it.start.x - dw / 2, y: it.start.y - dh / 2, w: dw, h: dh };
            const id = newId("node");
            commit({ add: [{ id, type: tool, x: r1(rect.x), y: r1(rect.y), w: r1(Math.max(rect.w, 16)), h: r1(Math.max(rect.h, 16)) }] });
            selection = new Set([id]);
            setTool("select");
            break;
        }
        case "arrow": {
            const end = it.end || it.start;
            if (Math.hypot(end.x - it.start.x, end.y - it.start.y) * view.zoom < 8) {
                render();
                break;
            }
            const id = newId("arrow");
            commit({ add: [{ id, type: "arrow", from: it.from, to: it.to || null, x1: r1(it.start.x), y1: r1(it.start.y), x2: r1(end.x), y2: r1(end.y) }] });
            selection = new Set([id]);
            setTool("select");
            break;
        }
        case "move":
            if (it.moved && it.patch) {
                if (it.duplicate) {
                    commit(duplicatePatch(it.base, selection, it.start, screenToWorld(e.clientX, e.clientY)));
                } else {
                    commit(it.patch);
                }
            }
            break;
        case "resize":
        case "endpoint":
            if (it.patch) commit(it.patch);
            break;
        default:
    }
    flushDeferred();
    render();
}

board.addEventListener("pointerup", endInteraction);
board.addEventListener("pointercancel", endInteraction);

board.addEventListener("dblclick", (e) => {
    const p = screenToWorld(e.clientX, e.clientY);
    const hit = hitElement(p);
    if (hit) {
        selection = new Set([hit.id]);
        openEditor({ mode: "edit", id: hit.id });
    } else {
        openEditor({ mode: "new", x: p.x, y: p.y });
    }
});

board.addEventListener(
    "wheel",
    (e) => {
        e.preventDefault();
        if (e.ctrlKey || e.metaKey) {
            const factor = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0025));
            zoomAt(e.clientX, e.clientY, view.zoom * factor);
        } else {
            const scale = e.deltaMode === 1 ? 16 : 1;
            view.x += ((e.shiftKey ? e.deltaY : e.deltaX) * scale) / view.zoom;
            view.y += ((e.shiftKey ? 0 : e.deltaY) * scale) / view.zoom;
            applyViewTransform();
        }
        if (editing) positionEditor();
    },
    { passive: false },
);

function zoomAt(clientX, clientY, zoom) {
    const before = screenToWorld(clientX, clientY);
    view.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
    const rect = board.getBoundingClientRect();
    view.x = before.x - (clientX - rect.left) / view.zoom;
    view.y = before.y - (clientY - rect.top) / view.zoom;
    applyViewTransform();
    renderOverlay();
}

function fitView(animate = true) {
    const b = sceneBounds(doc);
    const rect = board.getBoundingClientRect();
    if (!b || !rect.width) {
        view.zoom = 1;
        view.x = -80;
        view.y = -60;
    } else {
        const padX = Math.min(160, rect.width * 0.2);
        const padY = Math.min(180, rect.height * 0.25);
        const zoom = Math.min(1, (rect.width - padX) / Math.max(b.w, 1), (rect.height - padY) / Math.max(b.h, 1));
        view.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
        view.x = b.x + b.w / 2 - rect.width / 2 / view.zoom;
        view.y = b.y + b.h / 2 - (rect.height - 40) / 2 / view.zoom;
    }
    if (animate) render();
}

function squareEnd(start, p) {
    const size = Math.max(Math.abs(p.x - start.x), Math.abs(p.y - start.y));
    return { x: start.x + Math.sign(p.x - start.x || 1) * size, y: start.y + Math.sign(p.y - start.y || 1) * size };
}

function newId(prefix) {
    return makeId(prefix, new Set(doc.elements.map((el) => el.id)));
}

function drawLive() {
    const it = interaction;
    liveLayer.innerHTML = `<path d="${strokePathData(it.points)}" fill="none" stroke="${penColor}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>`;
}

function eraseAt(p) {
    const tol = 8 / view.zoom;
    let changed = false;
    for (const stroke of doc.strokes) {
        if (interaction.hits.has(stroke.id)) continue;
        const b = strokeBounds(stroke);
        if (!b || p.x < b.x - tol || p.x > b.x + b.w + tol || p.y < b.y - tol || p.y > b.y + b.h + tol) continue;
        const points = stroke.points.map(([x, y]) => ({ x, y }));
        if (distanceToPolyline(p, points) <= tol + stroke.width / 2) {
            interaction.hits.add(stroke.id);
            changed = true;
        }
    }
    if (changed) render();
}

// ---------- Patches for interactions ----------

function moveSet(base, ids) {
    const map = byId(base);
    const set = new Set(ids);
    for (const id of ids) {
        const el = map.get(id);
        if (el?.type !== "frame") continue;
        for (const other of base.elements) {
            if (other.type !== "arrow" && other.id !== id && rectContains(el, other)) set.add(other.id);
        }
    }
    return set;
}

function movePatch(base, ids, dx, dy) {
    const map = byId(base);
    const set = moveSet(base, ids);
    const update = [];
    for (const id of set) {
        const el = map.get(id);
        if (!el) continue;
        if (el.type === "arrow") {
            // Bound endpoints follow their nodes; only free endpoints move.
            const u = { id };
            if (!el.from) Object.assign(u, { x1: r1(el.x1 + dx), y1: r1(el.y1 + dy) });
            if (!el.to) Object.assign(u, { x2: r1(el.x2 + dx), y2: r1(el.y2 + dy) });
            if (Object.keys(u).length > 1) update.push(u);
        } else {
            update.push({ id, x: r1(el.x + dx), y: r1(el.y + dy) });
        }
    }
    return { update };
}

function duplicatePatch(base, ids, start, end) {
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const map = byId(base);
    const taken = new Set(base.elements.map((el) => el.id));
    const remap = new Map();
    const set = moveSet(base, ids);
    for (const id of set) {
        const el = map.get(id);
        const nid = makeId(el.type === "arrow" ? "arrow" : "node", taken);
        taken.add(nid);
        remap.set(id, nid);
    }
    const add = [];
    for (const id of set) {
        const el = structuredClone(map.get(id));
        el.id = remap.get(id);
        if (el.type === "arrow") {
            el.from = el.from && remap.get(el.from);
            el.to = el.to && remap.get(el.to);
            el.x1 += dx;
            el.y1 += dy;
            el.x2 += dx;
            el.y2 += dy;
        } else {
            el.x += dx;
            el.y += dy;
        }
        add.push(el);
    }
    selection = new Set(add.map((el) => el.id));
    return { add };
}

function resizePatch(base, id, handle, p, keepRatio) {
    const el = byId(base).get(id);
    let x1 = el.x;
    let y1 = el.y;
    let x2 = el.x + el.w;
    let y2 = el.y + el.h;
    if (handle.includes("w")) x1 = p.x;
    if (handle.includes("e")) x2 = p.x;
    if (handle.includes("n")) y1 = p.y;
    if (handle.includes("s")) y2 = p.y;
    let w = Math.max(16, Math.abs(x2 - x1));
    let h = Math.max(16, Math.abs(y2 - y1));
    if (keepRatio) {
        const ratio = el.w / el.h;
        if (w / h > ratio) w = h * ratio;
        else h = w / ratio;
    }
    const x = handle.includes("w") ? Math.min(x2, el.x + el.w) - w : Math.min(x1, x2);
    const y = handle.includes("n") ? Math.min(y2, el.y + el.h) - h : Math.min(y1, y2);
    return { update: [{ id, x: r1(x), y: r1(y), w: r1(w), h: r1(h) }] };
}

// ---------- Label editor ----------

function openEditor(target) {
    if (refineState.state === "refining" && target.mode === "new") {
        // Creating text during refine is fine; just proceed.
    }
    editing = target;
    const el = target.mode === "edit" ? byId(doc).get(target.id) : null;
    editor.value = el ? el.label : "";
    editor.classList.remove("hidden");
    positionEditor();
    editor.focus();
    editor.select();
}

function positionEditor() {
    if (!editing) return;
    const el = editing.mode === "edit" ? byId(doc).get(editing.id) : null;
    let box;
    let fontSize;
    let color = "#1f2328";
    if (!el) {
        fontSize = DEFAULT_STYLE.text.fontSize;
        box = { x: editing.x - 80, y: editing.y - 20, w: 160, h: 40 };
    } else if (el.type === "arrow") {
        const points = arrowPoints(el, lookupFn(doc.elements));
        const a = points[Math.floor((points.length - 1) / 2)];
        const b = points[Math.ceil((points.length - 1) / 2)];
        const mid = points.length === 2 ? { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } : a;
        fontSize = el.style.fontSize;
        box = { x: mid.x - 90, y: mid.y - 20, w: 180, h: 40 };
    } else {
        fontSize = el.style.fontSize;
        color = el.style.text;
        box = el.type === "frame" ? { x: el.x, y: el.y, w: Math.max(el.w, 160), h: 36 } : { x: el.x, y: el.y, w: Math.max(el.w, 60), h: Math.max(el.h, 32) };
    }
    const tl = worldToScreen(box.x, box.y);
    const rect = board.getBoundingClientRect();
    Object.assign(editor.style, {
        left: `${tl.x - rect.left}px`,
        top: `${tl.y - rect.top}px`,
        width: `${box.w * view.zoom}px`,
        height: `${box.h * view.zoom}px`,
        fontSize: `${fontSize * view.zoom}px`,
        color,
    });
}

function finishEditing(cancel = false) {
    if (!editing) return;
    const target = editing;
    editing = null;
    editor.classList.add("hidden");
    const text = editor.value.replace(/\s+$/g, "");
    if (!cancel) {
        if (target.mode === "edit") {
            const el = byId(doc).get(target.id);
            if (el && el.label !== text) {
                const update = { id: target.id, label: text };
                if (el.type === "text") Object.assign(update, textSize(text, el.style.fontSize, el));
                commit({ update: [update] });
            }
        } else if (text.trim()) {
            const id = newId("text");
            const size = textSize(text, DEFAULT_STYLE.text.fontSize);
            commit({ add: [{ id, type: "text", label: text, x: r1(target.x - size.w / 2), y: r1(target.y - size.h / 2), ...size }] });
            selection = new Set([id]);
        }
    }
    board.focus({ preventScroll: true });
    flushDeferred();
    render();
}

function textSize(text, fontSize, el) {
    const lines = text.split("\n").flatMap((line) => wrapText(line, 1e6, fontSize));
    const w = Math.max(40, ...lines.map((line) => textWidth(line, fontSize))) + 16;
    const h = Math.max(1, lines.length) * fontSize * 1.25 + 12;
    if (el) return { w: r1(Math.max(w, 40)), h: r1(Math.max(h, el.h)) };
    return { w: r1(w), h: r1(h) };
}

editor.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Escape") finishEditing(true);
    else if (e.key === "Enter" && (e.ctrlKey || e.metaKey || !e.shiftKey)) {
        e.preventDefault();
        finishEditing();
    }
});
editor.addEventListener("blur", () => finishEditing());

// ---------- Keyboard ----------

window.addEventListener("keydown", (e) => {
    if (isTyping(e.target)) {
        if (e.target === instructionInput && e.key === "Enter") {
            e.preventDefault();
            void refine();
        }
        return;
    }
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    if (e.key === " ") {
        spaceDown = true;
        board.classList.add("panning");
        e.preventDefault();
        return;
    }
    if (mod && key === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
    }
    if (mod && key === "y") {
        e.preventDefault();
        redo();
        return;
    }
    if (mod && key === "a") {
        e.preventDefault();
        setTool("select");
        selection = new Set(doc.elements.map((el) => el.id));
        render();
        return;
    }
    if (mod && key === "d") {
        e.preventDefault();
        if (selection.size) commit(duplicatePatch(doc, selection, { x: 0, y: 0 }, { x: 24, y: 24 }));
        return;
    }
    if (mod && e.key === "Enter") {
        e.preventDefault();
        void refine();
        return;
    }
    if (mod && key === "0") {
        e.preventDefault();
        const rect = board.getBoundingClientRect();
        zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, 1);
        return;
    }
    if (mod && (key === "=" || key === "+" || key === "-")) {
        e.preventDefault();
        const rect = board.getBoundingClientRect();
        zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, view.zoom * (key === "-" ? 1 / 1.2 : 1.2));
        return;
    }
    if (mod) return;
    if (e.key === "!" || (e.shiftKey && e.code === "Digit1")) {
        fitView();
        return;
    }
    if (e.key === "Delete" || e.key === "Backspace") {
        deleteSelection();
        e.preventDefault();
        return;
    }
    if (e.key === "Escape") {
        selection.clear();
        setTool("select");
        return;
    }
    if (e.key === "Enter" && selection.size === 1) {
        e.preventDefault();
        openEditor({ mode: "edit", id: [...selection][0] });
        return;
    }
    if (e.key.startsWith("Arrow") && selection.size) {
        e.preventDefault();
        const step = e.shiftKey ? 10 : 1;
        const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
        const dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
        commit(movePatch(doc, selection, dx, dy));
        return;
    }
    if (TOOL_KEYS[key] && !e.altKey) setTool(TOOL_KEYS[key]);
});

window.addEventListener("keyup", (e) => {
    if (e.key === " ") {
        spaceDown = false;
        if (interaction?.kind !== "pan") board.classList.remove("panning");
    }
});

window.addEventListener("resize", () => {
    applyViewTransform();
    if (editing) positionEditor();
});

function deleteSelection() {
    if (!selection.size) return;
    const ids = [...selection];
    selection.clear();
    commit({ delete: ids });
}

// ---------- Property panel ----------

function buildSwatches(container, colors, onPick) {
    container.replaceChildren(
        ...colors.map((color) => {
            const button = document.createElement("button");
            button.type = "button";
            button.dataset.color = color;
            button.title = color;
            if (color === "none") button.className = "none";
            else button.style.background = color;
            button.addEventListener("click", () => onPick(color));
            return button;
        }),
    );
}

function selectedElements() {
    const map = byId(doc);
    return [...selection].map((id) => map.get(id)).filter(Boolean);
}

function updateSelectedStyle(style) {
    const update = selectedElements().map((el) => ({ id: el.id, style }));
    if (update.length) commit({ update });
}

function updateProps() {
    const els = interaction ? [] : selectedElements();
    const panel = $("props");
    panel.classList.toggle("hidden", !els.length);
    if (!els.length) return;
    const nodes = els.filter((el) => el.type !== "arrow");
    const arrows = els.filter((el) => el.type === "arrow");
    $("prop-type-row").classList.toggle("hidden", !nodes.length || arrows.length > 0);
    $("prop-fill-row").classList.toggle("hidden", !nodes.length);
    $("prop-head-row").classList.toggle("hidden", !arrows.length);
    $("prop-route-row").classList.toggle("hidden", !arrows.length);
    const first = els[0];
    if (nodes.length) $("prop-type").value = nodes[0].type;
    if (arrows.length) {
        $("prop-head").value = arrows[0].style.head;
        $("prop-route").value = arrows[0].style.route;
    }
    $("prop-dashed").checked = Boolean(first.style.dashed);
    for (const button of $("prop-stroke").children) button.classList.toggle("active", button.dataset.color === first.style.stroke);
    for (const button of $("prop-fill").children) button.classList.toggle("active", button.dataset.color === nodes[0]?.style.fill);
}

buildSwatches($("prop-stroke"), STROKE_COLORS, (color) => {
    const update = selectedElements().map((el) => ({ id: el.id, style: el.type === "text" ? { text: color } : { stroke: color, ...(el.type === "frame" ? {} : { text: color }) } }));
    if (update.length) commit({ update });
});
buildSwatches($("prop-fill"), FILL_COLORS, (color) => updateSelectedStyle({ fill: color }));
buildSwatches($("pen-colors"), PEN_COLORS, (color) => {
    penColor = color;
    for (const button of $("pen-colors").children) button.classList.toggle("active", button.dataset.color === color);
});
$("pen-colors").firstElementChild?.classList.add("active");

$("prop-dashed").addEventListener("change", (e) => updateSelectedStyle({ dashed: e.target.checked }));
$("prop-head").addEventListener("change", (e) => updateSelectedStyle({ head: e.target.value }));
$("prop-route").addEventListener("change", (e) => updateSelectedStyle({ route: e.target.value }));
$("prop-delete").addEventListener("click", deleteSelection);
$("prop-type").addEventListener("change", (e) => {
    const type = e.target.value;
    const special = type === "text" ? DEFAULT_STYLE.text : type === "frame" ? DEFAULT_STYLE.frame : null;
    const update = selectedElements()
        .filter((el) => el.type !== "arrow")
        .map((el) => {
            const fromSpecial = el.type === "text" || el.type === "frame";
            const style = special ? { ...special } : fromSpecial ? { ...DEFAULT_STYLE.node } : undefined;
            return style ? { id: el.id, type, style } : { id: el.id, type };
        });
    if (update.length) commit({ update });
});

// ---------- Toolbar / top bar ----------

for (const button of document.querySelectorAll("[data-tool]")) button.addEventListener("click", () => setTool(button.dataset.tool));
$("undo").addEventListener("click", undo);
$("redo").addEventListener("click", redo);
$("zoom").addEventListener("click", () => fitView());
titleInput.addEventListener("change", () => {
    const title = titleInput.value.trim();
    if (title && title !== doc.title) commit({ title });
    board.focus({ preventScroll: true });
});
titleInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") titleInput.blur();
});

$("export-button").addEventListener("click", (e) => {
    e.stopPropagation();
    $("export-menu").classList.toggle("hidden");
});
window.addEventListener("click", () => $("export-menu").classList.add("hidden"));
for (const button of document.querySelectorAll("[data-export]")) {
    button.addEventListener("click", () => void exportAs(button.dataset.export));
}

// ---------- Rasterize / export ----------

function rasterize(svg, width, height) {
    return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
        const img = new Image();
        img.onload = () => {
            try {
                const canvas = document.createElement("canvas");
                canvas.width = width;
                canvas.height = height;
                const ctx = canvas.getContext("2d");
                ctx.drawImage(img, 0, 0, width, height);
                resolve(canvas.toDataURL("image/png"));
            } catch (error) {
                reject(error);
            } finally {
                URL.revokeObjectURL(url);
            }
        };
        img.onerror = () => {
            URL.revokeObjectURL(url);
            reject(new Error("SVG の画像化に失敗しました"));
        };
        img.src = url;
    });
}

async function exportAs(format) {
    $("export-menu").classList.add("hidden");
    try {
        await sendChain;
        const body = { documentId: DOC_ID, format };
        if (format === "png") {
            if (!doc.elements.length && !doc.strokes.length) throw new Error("図が空です");
            const probe = renderSvg(doc, { includeStrokes: true });
            const scale = Math.min(2, 4000 / Math.max(probe.width, probe.height));
            const out = renderSvg(doc, { includeStrokes: true, scale });
            body.data = await rasterize(out.svg, out.width, out.height);
        }
        const { path } = await api("/api/export", { method: "POST", body: JSON.stringify(body) });
        toast(`保存しました: ${path}`, "info", 5000);
    } catch (error) {
        toast(`エクスポートに失敗しました: ${error.message}`, "error");
    }
}

// ---------- Refine ----------

async function refine() {
    if (refineState.state === "refining") return;
    finishEditing();
    const instruction = instructionInput.value.trim();
    if (!doc.strokes.length && !instruction) {
        toast("ペン (P) で手書きするか、AI への指示を入力してください。");
        return;
    }
    refineButton.disabled = true;
    setRefineStatus({ state: "refining", message: "送信中…" });
    try {
        await sendChain;
        const options = { includeStrokes: true, showIds: true, muted: 0.55, grid: 100, padding: 40 };
        const probe = renderSvg(doc, options);
        const scale = Math.min(2, 1600 / Math.max(probe.frame.w, probe.frame.h));
        const out = renderSvg(doc, { ...options, scale });
        const image = await rasterize(out.svg, out.width, out.height);
        const result = await api("/api/refine", {
            method: "POST",
            body: JSON.stringify({ documentId: DOC_ID, instanceId: INSTANCE_ID, image, frame: out.frame, instruction }),
        });
        if (!result.ok) {
            setRefineStatus({ state: "idle" });
            toast(result.message || "仕上げを開始できませんでした", "error");
            return;
        }
        instructionInput.value = "";
    } catch (error) {
        setRefineStatus({ state: "idle" });
        toast(`仕上げに失敗しました: ${error.message}`, "error");
    } finally {
        render();
    }
}

function setRefineStatus(status) {
    refineState = status;
    refineBar.classList.toggle("busy", status.state === "refining");
    refineStatus.textContent = status.state === "refining" ? status.message || "AI が仕上げ中…" : "";
    refineButton.disabled = status.state === "refining";
    strokesLayer.classList.toggle("refining", status.state === "refining");
}

function onStatus(status) {
    const previous = refineState.state;
    setRefineStatus(status);
    if (status.state === "applied" && previous !== "applied") toast("✨ AI が図を更新しました");
    if (status.state === "error" && previous !== "error" && status.message) toast(status.message, "error", 5000);
}

refineButton.addEventListener("click", () => void refine());

// ---------- Boot ----------

setTool("select");
applyViewTransform();
render();
if (!TOKEN) {
    toast("トークンがありません。キャンバスを開き直してください。", "error", 10000);
} else {
    connect();
}
