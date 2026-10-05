// shape — Copilot App canvas extension: freehand sketch → AI-refined editable diagram.
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CanvasError, createCanvas, joinSession } from "@github/copilot-sdk/extension";
import { boundsOfPoints, simplifyPoints, strokeBounds } from "./core/geometry.mjs";
import { applyPatch, ELEMENT_TYPES } from "./core/model.mjs";
import { buildDisplayPrompt, buildRefinePrompt } from "./lib/prompt.mjs";
import { exportContent, slugify, startServer } from "./lib/server.mjs";
import { DocumentStore, sanitizeDocumentId } from "./lib/store.mjs";

const ROOT = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(homedir(), ".copilot", "shape-data");
const INSTANCES_FILE = join(DATA_DIR, "instances.json");
const JOB_TIMEOUT_MS = 10 * 60 * 1000;

const store = new DocumentStore(DATA_DIR);
const instances = new Map();
const jobs = new Map();
let session;
let serverPromise;

function log(message, level = "info") {
    try {
        session?.log(`[shape] ${message}`, { level })?.catch?.(() => {});
    } catch {
        // Logging must never throw.
    }
}

async function loadInstances() {
    try {
        const raw = JSON.parse(await readFile(INSTANCES_FILE, "utf8"));
        for (const [instanceId, documentId] of Object.entries(raw)) instances.set(instanceId, sanitizeDocumentId(documentId));
    } catch {
        // First run.
    }
}

async function saveInstances() {
    try {
        await mkdir(DATA_DIR, { recursive: true });
        const entries = [...instances.entries()].slice(-500);
        await writeFile(INSTANCES_FILE, JSON.stringify(Object.fromEntries(entries), null, 2), "utf8");
    } catch (error) {
        log(`Could not save instance map: ${error.message}`, "warning");
    }
}

function documentIdFor(instanceId) {
    return instances.get(instanceId) || sanitizeDocumentId(instanceId);
}

function getServer() {
    serverPromise ??= startServer({
        store,
        publicDir: join(ROOT, "public"),
        coreDir: join(ROOT, "core"),
        exportDirs: [join(homedir(), "Downloads"), join(DATA_DIR, "exports")],
        onRefine: handleRefine,
        log,
    }).catch((error) => {
        serverPromise = undefined;
        throw error;
    });
    return serverPromise;
}

function activeJob(documentId) {
    const job = jobs.get(documentId);
    if (job && Date.now() - job.createdAt > JOB_TIMEOUT_MS) {
        jobs.delete(documentId);
        return undefined;
    }
    return job;
}

async function handleRefine({ documentId, instanceId, image, frame, instruction }) {
    if (!session) throw new Error("Copilot session is not ready yet.");
    const server = await getServer();
    const resolvedInstance = instanceId && documentIdFor(instanceId) === documentId ? instanceId : [...instances].find(([, doc]) => doc === documentId)?.[0];
    if (!resolvedInstance) throw new Error("Unknown canvas instance. Re-open the canvas and try again.");
    const doc = await store.get(documentId);
    const strokes = doc.strokes;
    if (!strokes.length && !instruction.trim()) {
        return { ok: false, message: "手書きのスケッチか指示を入力してください。" };
    }
    if (activeJob(documentId)) {
        return { ok: false, message: "AI が仕上げ中です。完了までお待ちください。" };
    }
    const job = {
        id: `refine-${randomUUID().slice(0, 8)}`,
        documentId,
        instanceId: resolvedInstance,
        strokeIds: strokes.map((stroke) => stroke.id),
        createdAt: Date.now(),
        applied: false,
    };
    jobs.set(documentId, job);
    server.setStatus(documentId, { state: "refining", message: "AI が仕上げ中…", jobId: job.id });

    const prompt = buildRefinePrompt({ instanceId: resolvedInstance, jobId: job.id, doc, strokes, frame, instruction });
    const attachments = [];
    const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(image || "");
    if (match) {
        attachments.push({ type: "blob", data: match[1], mimeType: "image/png", displayName: `${slugify(doc.title)}-sketch.png` });
    }
    try {
        await session.send({
            prompt,
            displayPrompt: buildDisplayPrompt({ strokes, instruction }),
            attachments,
            mode: "enqueue",
        });
    } catch (error) {
        jobs.delete(documentId);
        server.setStatus(documentId, { state: "error", message: `送信に失敗しました: ${error.message}` });
        throw error;
    }
    return { ok: true, jobId: job.id };
}

async function finishJobs(reason) {
    if (!jobs.size) return;
    const server = await getServer();
    for (const [documentId, job] of jobs) {
        jobs.delete(documentId);
        if (job.applied) {
            server.setStatus(documentId, { state: "idle", message: "" });
        } else {
            server.setStatus(documentId, {
                state: "error",
                message: reason === "aborted" ? "AI の処理が中断されました。" : "AI から変更が届きませんでした。もう一度お試しください。",
            });
        }
    }
}

// ---------- Action helpers ----------

const elementSchema = {
    type: "object",
    description:
        "Diagram element. Nodes: {id, type, x, y, w, h, label, style?}. Arrows: {id, type:'arrow', from, to, label?, style?{head, route, dashed}, x1?, y1?, x2?, y2?}.",
    properties: {
        id: { type: "string" },
        type: { type: "string", enum: ELEMENT_TYPES },
        x: { type: "number" },
        y: { type: "number" },
        w: { type: "number" },
        h: { type: "number" },
        label: { type: "string" },
        from: { type: ["string", "null"] },
        to: { type: ["string", "null"] },
        x1: { type: "number" },
        y1: { type: "number" },
        x2: { type: "number" },
        y2: { type: "number" },
        style: {
            type: "object",
            properties: {
                stroke: { type: "string" },
                fill: { type: "string" },
                text: { type: "string" },
                strokeWidth: { type: "number" },
                dashed: { type: "boolean" },
                fontSize: { type: "number" },
                head: { type: "string", enum: ["end", "start", "both", "none"] },
                route: { type: "string", enum: ["straight", "elbow"] },
            },
        },
    },
    required: ["id"],
};

function summarizeStroke(stroke) {
    const b = strokeBounds(stroke);
    const scale = Math.max(b.w, b.h, 1);
    let epsilon = Math.max(1.5, scale / 120);
    let simplified = simplifyPoints(stroke.points, epsilon);
    while (simplified.length > 60) {
        epsilon *= 1.6;
        simplified = simplifyPoints(stroke.points, epsilon);
    }
    return {
        id: stroke.id,
        color: stroke.color,
        bbox: { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.w), h: Math.round(b.h) },
        points: simplified.map(([x, y]) => [Math.round(x), Math.round(y)]),
    };
}

function resolveConsume(consume, documentId, refineId, doc) {
    const job = activeJob(documentId);
    const jobMatches = job && (!refineId || refineId === job.id);
    if (consume === true || consume === "all") return { ids: doc.strokes.map((stroke) => stroke.id), job: jobMatches ? job : undefined };
    if (Array.isArray(consume)) return { ids: consume.map(String), job: jobMatches ? job : undefined };
    if (consume === false) return { ids: [], job: jobMatches ? job : undefined };
    if (jobMatches) return { ids: job.strokeIds, job };
    return { ids: [], job: undefined };
}

async function markApplied(documentId, job) {
    if (!job) return;
    job.applied = true;
    const server = await getServer();
    server.setStatus(documentId, { state: "applied", message: "AI が図を更新しました", jobId: job.id });
}

function resultFor(result, extra = {}) {
    const s = result.summary || {};
    return {
        ok: true,
        revision: result.doc.revision,
        added: s.added,
        updated: s.updated,
        deleted: s.deleted,
        strokesConsumed: s.strokesDeleted,
        elementCount: result.doc.elements.length,
        pendingStrokes: result.doc.strokes.length,
        warnings: result.warnings,
        ...extra,
    };
}

// ---------- Canvas ----------

const shapeCanvas = createCanvas({
    id: "shape",
    displayName: "shape",
    description: "AI-powered editable whiteboard: sketch boxes and arrows freehand, then refine them into clean editable diagrams.",
    inputSchema: {
        type: "object",
        properties: {
            documentId: { type: "string", description: "Optional diagram id to open (persists across sessions). Defaults to one per canvas instance." },
            title: { type: "string", description: "Optional title for a new diagram." },
        },
    },
    actions: [
        {
            name: "get_diagram",
            description:
                "Read the current diagram: editable elements (nodes and arrows, world coordinates) and pending freehand strokes not yet converted (bbox + simplified points).",
            inputSchema: { type: "object", properties: { includeStrokePoints: { type: "boolean", description: "Include simplified stroke points (default true)." } } },
            handler: async (ctx) => {
                const documentId = documentIdFor(ctx.instanceId);
                const doc = await store.get(documentId);
                const job = activeJob(documentId);
                const includePoints = ctx.input?.includeStrokePoints !== false;
                return {
                    documentId,
                    title: doc.title,
                    revision: doc.revision,
                    elements: doc.elements,
                    pendingStrokes: doc.strokes.map((stroke) => {
                        const summary = summarizeStroke(stroke);
                        if (!includePoints) delete summary.points;
                        return summary;
                    }),
                    sketchBounds: boundsOfPoints(doc.strokes.flatMap((stroke) => stroke.points)),
                    activeRefine: job ? { refineId: job.id, strokeIds: job.strokeIds } : null,
                };
            },
        },
        {
            name: "apply_changes",
            description:
                "Incrementally edit the diagram. add: new elements; update: partial elements by id (style is merged; null clears from/to); delete: ids. consumeStrokes: true | false | stroke ids to remove (defaults to the strokes of the active refine request). Pass refineId when answering a refine request.",
            inputSchema: {
                type: "object",
                properties: {
                    title: { type: "string" },
                    add: { type: "array", items: elementSchema },
                    update: { type: "array", items: { ...elementSchema, description: "Partial element; id required." } },
                    delete: { type: "array", items: { type: "string" } },
                    consumeStrokes: { anyOf: [{ type: "boolean" }, { type: "array", items: { type: "string" } }] },
                    refineId: { type: "string" },
                },
            },
            handler: async (ctx) => {
                const input = ctx.input || {};
                const documentId = documentIdFor(ctx.instanceId);
                let consumed;
                const result = await store.mutate(
                    documentId,
                    async (doc) => {
                        consumed = resolveConsume(input.consumeStrokes, documentId, input.refineId, doc);
                        return applyPatch(doc, {
                            title: input.title,
                            add: input.add,
                            update: input.update,
                            delete: input.delete,
                            deleteStrokes: consumed.ids,
                        });
                    },
                    { source: "agent" },
                );
                await markApplied(documentId, consumed?.job);
                return resultFor(result);
            },
        },
        {
            name: "replace_diagram",
            description: "Replace all elements with a complete new diagram (use for full re-layouts or generating a diagram from scratch). Pending strokes are consumed unless consumeStrokes is false.",
            inputSchema: {
                type: "object",
                properties: {
                    title: { type: "string" },
                    elements: { type: "array", items: elementSchema },
                    consumeStrokes: { type: "boolean" },
                    refineId: { type: "string" },
                },
                required: ["elements"],
            },
            handler: async (ctx) => {
                const input = ctx.input || {};
                if (!Array.isArray(input.elements)) throw new CanvasError("invalid_input", "elements must be an array.");
                const documentId = documentIdFor(ctx.instanceId);
                let job;
                const result = await store.mutate(
                    documentId,
                    async (doc) => {
                        const consumed = resolveConsume(input.consumeStrokes === false ? false : true, documentId, input.refineId, doc);
                        job = consumed.job;
                        return applyPatch(doc, {
                            title: input.title,
                            delete: doc.elements.map((el) => el.id),
                            add: input.elements,
                            deleteStrokes: consumed.ids,
                        });
                    },
                    { source: "agent" },
                );
                await markApplied(documentId, job);
                return resultFor(result);
            },
        },
        {
            name: "clear_sketch",
            description: "Remove all pending freehand strokes without converting them.",
            inputSchema: { type: "object", properties: {} },
            handler: async (ctx) => {
                const documentId = documentIdFor(ctx.instanceId);
                const result = await store.apply(documentId, { deleteStrokes: "all" }, { source: "agent" });
                return resultFor(result);
            },
        },
        {
            name: "export",
            description: "Export the diagram as svg, json or mermaid text. Set save=true to also write the file to the Downloads folder.",
            inputSchema: {
                type: "object",
                properties: {
                    format: { type: "string", enum: ["svg", "json", "mermaid"] },
                    save: { type: "boolean" },
                },
                required: ["format"],
            },
            handler: async (ctx) => {
                const documentId = documentIdFor(ctx.instanceId);
                const doc = await store.get(documentId);
                let exported;
                try {
                    exported = exportContent(doc, ctx.input?.format);
                } catch (error) {
                    throw new CanvasError("invalid_input", error.message);
                }
                let path = null;
                if (ctx.input?.save) {
                    const dir = join(homedir(), "Downloads");
                    await mkdir(dir, { recursive: true });
                    path = join(dir, `${slugify(doc.title)}-${Date.now()}.${exported.ext}`);
                    await writeFile(path, exported.content, "utf8");
                }
                return { format: ctx.input.format, path, content: exported.content };
            },
        },
    ],
    open: async (ctx) => {
        const input = ctx.input && typeof ctx.input === "object" ? ctx.input : {};
        const documentId = input.documentId ? sanitizeDocumentId(input.documentId) : documentIdFor(ctx.instanceId);
        if (instances.get(ctx.instanceId) !== documentId) {
            instances.set(ctx.instanceId, documentId);
            void saveInstances();
        }
        const server = await getServer();
        let doc = await store.get(documentId, input.title);
        if (input.title && doc.revision === 0 && !doc.elements.length && doc.title !== input.title) {
            doc = (await store.apply(documentId, { title: input.title }, { source: "agent" })).doc;
        }
        return {
            url: server.url(documentId, ctx.instanceId),
            title: `shape — ${doc.title}`,
            status: doc.elements.length ? `${doc.elements.length} elements` : "empty",
        };
    },
    onClose: async () => {
        await store.flush();
    },
});

await loadInstances();
session = await joinSession({ canvases: [shapeCanvas] });
session.on("session.idle", (event) => {
    void finishJobs(event?.data?.aborted ? "aborted" : "idle");
});
