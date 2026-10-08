import assert from "node:assert/strict";
import { test } from "node:test";
import { arrowPoints, lookupFn, rectContains, sceneBounds } from "../core/geometry.mjs";
import { toMermaid } from "../core/mermaid.mjs";
import { applyPatch, diff, emptyDocument, isEmptyPatch, normalizeDocument, normalizeElement } from "../core/model.mjs";
import { renderSvg } from "../core/render.mjs";
import { AZURE_SERVICES, AZURE_SERVICE_IDS } from "../core/azure-icons.mjs";
import { buildRefinePrompt } from "../lib/prompt.mjs";

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

test("official Azure services survive normalization, updates, diff and export", () => {
    assert.ok(AZURE_SERVICE_IDS.includes("app-service"));
    const first = applyPatch(emptyDocument("azure"), {
        add: [{ id: "app", type: "azure-service", service: "app-service", x: 0, y: 0 }],
    }).doc;
    const app = first.elements[0];
    assert.equal(app.label, "Azure App Service");
    assert.equal(app.service, "app-service");
    const changed = applyPatch(first, { update: [{ id: "app", x: 100, label: "Customer API" }] }).doc;
    assert.equal(changed.elements[0].service, "app-service");
    assert.deepEqual(applyPatch(first, diff(first, changed)).doc, changed);
    assert.deepEqual(normalizeDocument(JSON.parse(JSON.stringify(changed)), "azure").elements, changed.elements);
    const svg = renderSvg(changed).svg;
    assert.match(svg, /Azure App Service/);
    assert.match(svg, /Customer API/);
    assert.match(svg, /viewBox="0 0 18 18"/);
    assert.match(toMermaid(changed), /Azure App Service<br\/>Customer API/);
});

test("unknown Azure services stay visible as generic nodes with warnings", () => {
    const { doc, warnings } = applyPatch(emptyDocument("unknown"), {
        add: [{ id: "missing", type: "azure-service", service: "not-in-catalog", label: "Azure Example Service" }],
    });
    assert.equal(doc.elements[0].type, "rect");
    assert.equal(doc.elements[0].label, "Azure Example Service");
    assert.match(warnings.join(" "), /unknown service/);
    assert.match(renderSvg(doc).svg, /Azure Example<\/tspan>.*Service<\/tspan>/);
});

test("curated official icon markup has isolated IDs and no remote resources", () => {
    assert.equal(AZURE_SERVICES.length, 10);
    for (const service of AZURE_SERVICES) {
        assert.match(service.svg, /<(?:path|circle|rect|ellipse|g)\b/);
        assert.doesNotMatch(service.svg, /<script\b|<foreignObject\b|https?:|data:/i);
        assert.doesNotMatch(service.svg, /url\(#(?!azure-)/);
    }
});

test("refine prompt gates Azure behavior and documents the official catalog", () => {
    const prompt = buildRefinePrompt({
        instanceId: "i", jobId: "j", doc: base(), strokes: [], instruction: "Web -> DB",
    });
    assert.match(prompt, /generic "web", "DB" or cloud sketches stay generic/);
    assert.match(prompt, /app-service: Azure App Service/);
    assert.match(prompt, /PaaS service reached through a private endpoint is outside/);
});

test("refine prompt maps recognizable concepts to existing semantic shapes", () => {
    const prompt = buildRefinePrompt({
        instanceId: "i",
        jobId: "j",
        doc: base(),
        strokes: [{ id: "s1", points: [[0, 0], [10, 10]], color: "#000000" }],
        instruction: "ユーザーから VM に接続",
    });
    assert.match(prompt, /Meaning takes priority over copying the rough outline literally/);
    assert.match(prompt, /person, stick figure, user, customer, or operator to an ellipse/);
    assert.match(prompt, /VM, virtual machine, 仮想マシン, server, or compute host to a rounded node/);
    assert.match(prompt, /Azure Virtual Machine because it is not in the official icon catalog/);
    assert.match(prompt, /plain unlabeled box alone/);
    assert.match(prompt, /fall back to its geometry/);
});

test("elbow connections avoid unrelated service nodes and remain in export bounds", () => {
    const doc = applyPatch(emptyDocument("routing"), {
        add: [
            { id: "gateway", type: "azure-service", service: "application-gateway", x: 0, y: 0, w: 210, h: 124 },
            { id: "endpoint", type: "azure-service", service: "private-endpoint", x: 300, y: 0, w: 210, h: 124 },
            { id: "app", type: "azure-service", service: "app-service", x: 620, y: 0, w: 210, h: 124 },
            { id: "flow", type: "arrow", from: "gateway", to: "app", style: { route: "elbow" } },
        ],
    }).doc;
    const points = arrowPoints(doc.elements[3], doc.elements, doc.elements);
    assert.ok(points.length >= 4);
    for (let i = 1; i < points.length; i++) {
        const a = points[i - 1];
        const b = points[i];
        const clear = a.y === b.y
            ? a.y <= -10 || a.y >= 134 || Math.max(a.x, b.x) <= 290 || Math.min(a.x, b.x) >= 520
            : a.x <= 290 || a.x >= 520 || Math.max(a.y, b.y) <= -10 || Math.min(a.y, b.y) >= 134;
        assert.ok(clear, `segment ${i} must not cross the endpoint card`);
    }
    const bounds = sceneBounds(doc);
    assert.ok(points.every((point) => point.x >= bounds.x && point.y >= bounds.y && point.x <= bounds.x + bounds.w && point.y <= bounds.y + bounds.h));
});

test("reference Azure layout keeps PaaS resources outside the VNet and endpoints inside", () => {
    const doc = applyPatch(emptyDocument("baseline"), {
        add: [
            { id: "vnet", type: "frame", x: 0, y: 0, w: 800, h: 470, label: "Azure Virtual Network" },
            { id: "subnet", type: "frame", x: 40, y: 70, w: 320, h: 350, label: "Ingress subnet" },
            { id: "pe-subnet", type: "frame", x: 400, y: 70, w: 340, h: 350, label: "Private endpoints subnet" },
            { id: "gateway", type: "azure-service", service: "application-gateway", x: 95, y: 170 },
            { id: "endpoint", type: "azure-service", service: "private-endpoint", x: 460, y: 170 },
            { id: "app", type: "azure-service", service: "app-service", x: 930, y: 60 },
            { id: "sql", type: "azure-service", service: "sql-database", x: 930, y: 310 },
            { id: "app-to-endpoint", type: "arrow", from: "app", to: "endpoint", style: { route: "elbow" } },
            { id: "endpoint-to-sql", type: "arrow", from: "endpoint", to: "sql", style: { route: "elbow" } },
        ],
    }).doc;
    const elements = new Map(doc.elements.map((el) => [el.id, el]));
    assert.ok(rectContains(elements.get("vnet"), elements.get("pe-subnet")));
    assert.ok(rectContains(elements.get("pe-subnet"), elements.get("endpoint")));
    assert.equal(rectContains(elements.get("vnet"), elements.get("app")), false);
    assert.equal(rectContains(elements.get("vnet"), elements.get("sql")), false);
    const svg = renderSvg(doc).svg;
    for (const name of ["Azure App Service", "Azure SQL Database", "Azure Private Endpoint", "Ingress subnet"]) assert.ok(svg.includes(name));
    assert.match(toMermaid(doc), /subgraph pe_subnet/);
});
