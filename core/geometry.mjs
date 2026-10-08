// Isomorphic geometry helpers shared by the browser and the extension process.

export function lookupFn(lookup) {
    if (typeof lookup === "function") return lookup;
    if (lookup instanceof Map) return (id) => lookup.get(id);
    if (Array.isArray(lookup)) {
        const map = new Map(lookup.map((element) => [element.id, element]));
        return (id) => map.get(id);
    }
    return () => undefined;
}

export function isNode(element) {
    return Boolean(element) && element.type !== "arrow";
}

export function center(node) {
    return { x: node.x + node.w / 2, y: node.y + node.h / 2 };
}

// Point where the ray from the node's center toward (tx, ty) leaves the node outline.
export function boundaryPoint(node, tx, ty) {
    const c = center(node);
    const dx = tx - c.x;
    const dy = ty - c.y;
    if (Math.abs(dx) < 1e-6 && Math.abs(dy) < 1e-6) return c;
    const hw = Math.max(node.w / 2, 1);
    const hh = Math.max(node.h / 2, 1);
    let t;
    if (node.type === "ellipse") {
        t = 1 / Math.sqrt((dx / hw) ** 2 + (dy / hh) ** 2);
    } else if (node.type === "diamond") {
        t = 1 / (Math.abs(dx) / hw + Math.abs(dy) / hh);
    } else {
        t = Math.min(
            Math.abs(dx) < 1e-6 ? Infinity : hw / Math.abs(dx),
            Math.abs(dy) < 1e-6 ? Infinity : hh / Math.abs(dy),
        );
    }
    return { x: c.x + dx * t, y: c.y + dy * t };
}

function endpointRefs(arrow, find) {
    const fromNode = arrow.from ? find(arrow.from) : undefined;
    const toNode = arrow.to ? find(arrow.to) : undefined;
    const from = isNode(fromNode) ? fromNode : undefined;
    const to = isNode(toNode) ? toNode : undefined;
    const startRef = from ? center(from) : { x: arrow.x1, y: arrow.y1 };
    const endRef = to ? center(to) : { x: arrow.x2, y: arrow.y2 };
    return { from, to, startRef, endRef };
}

// Resolved polyline of an arrow (bound endpoints follow their nodes).
export function arrowPoints(arrow, lookup, obstacles = []) {
    const find = lookupFn(lookup);
    const { from, to, startRef, endRef } = endpointRefs(arrow, find);
    if (arrow.style?.route === "elbow") {
        const dx = endRef.x - startRef.x;
        const dy = endRef.y - startRef.y;
        let start;
        let end;
        let points;
        if (Math.abs(dx) >= Math.abs(dy)) {
            const sx = Math.sign(dx) || 1;
            start = from ? { x: startRef.x + (sx * from.w) / 2, y: startRef.y } : startRef;
            end = to ? { x: endRef.x - (sx * to.w) / 2, y: endRef.y } : endRef;
            const mx = (start.x + end.x) / 2;
            points = [start, { x: mx, y: start.y }, { x: mx, y: end.y }, end];
        } else {
            const sy = Math.sign(dy) || 1;
            start = from ? { x: startRef.x, y: startRef.y + (sy * from.h) / 2 } : startRef;
            end = to ? { x: endRef.x, y: endRef.y - (sy * to.h) / 2 } : endRef;
            const my = (start.y + end.y) / 2;
            points = [start, { x: start.x, y: my }, { x: end.x, y: my }, end];
        }
        return avoidNodes(dedupe(points), arrow, obstacles);
    }
    const start = from ? boundaryPoint(from, endRef.x, endRef.y) : startRef;
    const end = to ? boundaryPoint(to, startRef.x, startRef.y) : endRef;
    return [start, end];
}

function avoidNodes(points, arrow, nodes) {
    const a = points[0];
    const b = points[points.length - 1];
    const boxes = nodes
        .filter((node) => node.type !== "arrow" && node.type !== "frame" && node.id !== arrow.from && node.id !== arrow.to)
        .filter((node) => node.x < Math.max(a.x, b.x) + 300 && node.x + node.w > Math.min(a.x, b.x) - 300 &&
            node.y < Math.max(a.y, b.y) + 300 && node.y + node.h > Math.min(a.y, b.y) - 300)
        .map((node) => ({ x: node.x - 10, y: node.y - 10, right: node.x + node.w + 10, bottom: node.y + node.h + 10 }));
    if (!boxes.length) return points;
    const clear = (path) => path.every((p, index) => !index || boxes.every((box) => {
        const prev = path[index - 1];
        if (prev.x === p.x) return prev.x <= box.x || prev.x >= box.right || Math.max(prev.y, p.y) <= box.y || Math.min(prev.y, p.y) >= box.bottom;
        if (prev.y === p.y) return prev.y <= box.y || prev.y >= box.bottom || Math.max(prev.x, p.x) <= box.x || Math.min(prev.x, p.x) >= box.right;
        return false;
    }));
    if (clear(points)) return points;
    const horizontal = Math.abs(b.x - a.x) >= Math.abs(b.y - a.y);
    const sign = Math.sign(horizontal ? b.x - a.x : b.y - a.y) || 1;
    const start = horizontal ? a.x + 20 * sign : a.y + 20 * sign;
    const end = horizontal ? b.x - 20 * sign : b.y - 20 * sign;
    const corridors = horizontal
        ? [a.y, b.y, ...boxes.flatMap((box) => [box.y - 12, box.bottom + 12])]
        : [a.x, b.x, ...boxes.flatMap((box) => [box.x - 12, box.right + 12])];
    const candidates = corridors.map((corridor) => dedupe(horizontal
        ? [a, { x: start, y: a.y }, { x: start, y: corridor }, { x: end, y: corridor }, { x: end, y: b.y }, b]
        : [a, { x: a.x, y: start }, { x: corridor, y: start }, { x: corridor, y: end }, { x: b.x, y: end }, b]));
    const options = candidates.filter(clear);
    if (!options.length) return points;
    options.sort((left, right) => polylineLength(left) + left.length * 20 - polylineLength(right) - right.length * 20);
    return options[0];
}

function dedupe(points) {
    const out = [];
    for (const point of points) {
        const last = out[out.length - 1];
        if (last && Math.abs(last.x - point.x) < 0.01 && Math.abs(last.y - point.y) < 0.01) continue;
        out.push(point);
    }
    // Drop collinear middle points.
    for (let i = out.length - 2; i >= 1; i -= 1) {
        const a = out[i - 1];
        const b = out[i];
        const c = out[i + 1];
        const cross = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
        if (Math.abs(cross) < 0.01) out.splice(i, 1);
    }
    return out.length >= 2 ? out : [points[0], points[points.length - 1]];
}

export function polylineLength(points) {
    let length = 0;
    for (let i = 1; i < points.length; i += 1) {
        length += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
    }
    return length;
}

export function polylineMidpoint(points) {
    const half = polylineLength(points) / 2;
    let walked = 0;
    for (let i = 1; i < points.length; i += 1) {
        const a = points[i - 1];
        const b = points[i];
        const segment = Math.hypot(b.x - a.x, b.y - a.y);
        if (walked + segment >= half && segment > 0) {
            const t = (half - walked) / segment;
            return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
        }
        walked += segment;
    }
    return points[0] || { x: 0, y: 0 };
}

export function distanceToSegment(p, a, b) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lengthSq = dx * dx + dy * dy;
    let t = lengthSq === 0 ? 0 : ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t));
}

export function distanceToPolyline(p, points) {
    if (points.length === 1) return Math.hypot(p.x - points[0].x, p.y - points[0].y);
    let best = Infinity;
    for (let i = 1; i < points.length; i += 1) {
        best = Math.min(best, distanceToSegment(p, points[i - 1], points[i]));
    }
    return best;
}

export function boundsOfPoints(points) {
    if (!points.length) return null;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const point of points) {
        const x = Array.isArray(point) ? point[0] : point.x;
        const y = Array.isArray(point) ? point[1] : point.y;
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
    }
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

export function unionBounds(list) {
    const items = list.filter(Boolean);
    if (!items.length) return null;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const b of items) {
        minX = Math.min(minX, b.x);
        minY = Math.min(minY, b.y);
        maxX = Math.max(maxX, b.x + b.w);
        maxY = Math.max(maxY, b.y + b.h);
    }
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

export function padBounds(b, pad) {
    return { x: b.x - pad, y: b.y - pad, w: b.w + pad * 2, h: b.h + pad * 2 };
}

export function elementBounds(element, lookup, obstacles) {
    if (element.type === "arrow") return boundsOfPoints(arrowPoints(element, lookup, obstacles));
    return { x: element.x, y: element.y, w: element.w, h: element.h };
}

export function strokeBounds(stroke) {
    const b = boundsOfPoints(stroke.points);
    return b ? padBounds(b, (stroke.width || 2) / 2) : null;
}

export function sceneBounds(doc, { includeStrokes = true } = {}) {
    const lookup = lookupFn(doc.elements);
    const list = doc.elements.map((element) => elementBounds(element, lookup, doc.elements));
    if (includeStrokes) list.push(...doc.strokes.map(strokeBounds));
    return unionBounds(list);
}

export function rectsIntersect(a, b) {
    return a.x <= b.x + b.w && b.x <= a.x + a.w && a.y <= b.y + b.h && b.y <= a.y + a.h;
}

export function rectContains(outer, inner) {
    return (
        inner.x >= outer.x &&
        inner.y >= outer.y &&
        inner.x + inner.w <= outer.x + outer.w &&
        inner.y + inner.h <= outer.y + outer.h
    );
}

// Ramer–Douglas–Peucker simplification for [x, y, ...] tuples or {x, y} points.
export function simplifyPoints(points, epsilon) {
    if (points.length <= 2) return points.slice();
    const get = (p) => (Array.isArray(p) ? { x: p[0], y: p[1] } : p);
    const keep = new Uint8Array(points.length);
    keep[0] = 1;
    keep[points.length - 1] = 1;
    const stack = [[0, points.length - 1]];
    while (stack.length) {
        const [first, last] = stack.pop();
        let maxDistance = 0;
        let index = -1;
        const a = get(points[first]);
        const b = get(points[last]);
        for (let i = first + 1; i < last; i += 1) {
            const d = distanceToSegment(get(points[i]), a, b);
            if (d > maxDistance) {
                maxDistance = d;
                index = i;
            }
        }
        if (index >= 0 && maxDistance > epsilon) {
            keep[index] = 1;
            stack.push([first, index], [index, last]);
        }
    }
    return points.filter((_, i) => keep[i]);
}
