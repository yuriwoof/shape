import assert from "node:assert/strict";
import { test } from "node:test";
import { arrowPoints, lookupFn, sceneBounds } from "../core/geometry.mjs";
import { toMermaid } from "../core/mermaid.mjs";
import { applyPatch, diff, emptyDocument, isEmptyPatch, normalizeDocument, normalizeElement } from "../core/model.mjs";
import { renderSvg } from "../core/render.mjs";

const base = () =>
    applyPatch(emptyDocument("t"), {
        title: "Test",
        add: [
            { id: "web", type: "rect", x: 0, y: 0, w: 100, h: 50, label: "Web" },
            { id: "db", type: "database", x: 300, y: 0, label: "DB" },
            { id: "a1", type: "arrow", from: "web", to: "db", label: "SQL" },
        ],
        addStrokes: [{ id: "s1", points: [[0, 0], [10, 10]] }],
    }).doc;

test("normalizeElement applies aliases, defaults and clamps", () => {
    const warnings = [];
    const el = normalizeElement({ id: "x y", type: "circle", x: "12.345", label: 5 }, warnings, new Map());
    assert.equal(el.id, "x-y");
    assert.equal(el.type, "ellipse");
    assert.equal(el.x, 12.3);
    assert.equal(el.w, 140);
    assert.equal(el.label, "5");
    assert.equal(normalizeElement({ type: "bogus" }, warnings, new Map()), null);
    assert.ok(warnings.length >= 1);
});

test("applyPatch resolves arrow endpoints from bound nodes", () => {
    const doc = base();
    const arrow = doc.elements.find((el) => el.id === "a1");
    assert.equal(arrow.x1, 100);
    assert.ok(arrow.y1 >= 25 && arrow.y1 <= 50);
    assert.equal(doc.elements.find((el) => el.id === "db").type, "cylinder");
    const moved = applyPatch(doc, { update: [{ id: "db", y: 200 }] }).doc;
    const points = arrowPoints(moved.elements.find((el) => el.id === "a1"), lookupFn(moved.elements));
    assert.ok(points[points.length - 1].y > 25);
});

test("deleting a bound node leaves a free arrow endpoint", () => {
    const { doc, warnings } = applyPatch(base(), { delete: ["db"] });
    const arrow = doc.elements.find((el) => el.id === "a1");
    assert.equal(arrow.to, null);
    assert.equal(arrow.from, "web");
    assert.deepEqual(warnings, []);
});

test("unknown references produce warnings", () => {
    const { warnings } = applyPatch(base(), { update: [{ id: "nope", x: 1 }], delete: ["ghost"], add: [{ type: "arrow", from: "zzz", to: "web" }] });
    assert.equal(warnings.length, 3);
});

test("diff/applyPatch round-trips, including strokes and title", () => {
    const a = base();
    const b = applyPatch(a, { title: "B", delete: ["db"], update: [{ id: "web", label: "Front", style: { fill: "#ffe3e3" } }], deleteStrokes: "all" }).doc;
    const forward = diff(a, b);
    const inverse = diff(b, a);
    assert.deepEqual(applyPatch(a, forward, { silentReplace: true }).doc, b);
    assert.deepEqual(applyPatch(b, inverse, { silentReplace: true }).doc, a);
    assert.ok(isEmptyPatch(diff(a, a)));
});

test("partial style updates merge with existing style", () => {
    const doc = applyPatch(base(), { update: [{ id: "web", style: { dashed: true } }] }).doc;
    const web = doc.elements.find((el) => el.id === "web");
    assert.equal(web.style.dashed, true);
    assert.equal(web.style.fill, "#ffffff");
});

test("normalizeDocument tolerates garbage", () => {
    const doc = normalizeDocument({ elements: [null, { type: "rect" }, 5], strokes: "x" }, "id");
    assert.equal(doc.elements.length, 1);
    assert.deepEqual(doc.strokes, []);
});

test("renderSvg escapes labels and reports frame", () => {
    const doc = applyPatch(base(), { add: [{ id: "x", type: "text", label: "<script>&" }] }).doc;
    const out = renderSvg(doc, { includeStrokes: true, showIds: true, grid: 100 });
    assert.ok(out.svg.startsWith("<svg"));
    assert.ok(!out.svg.includes("<script>"));
    assert.ok(out.svg.includes("&lt;script&gt;"));
    const bounds = sceneBounds(doc);
    assert.equal(out.frame.x, bounds.x - 40);
});

test("toMermaid emits nodes and edges", () => {
    const text = toMermaid(base());
    assert.match(text, /^flowchart/);
    assert.match(text, /web/);
    assert.match(text, /-->/);
    assert.match(text, /SQL/);
});
