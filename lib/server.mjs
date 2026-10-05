// Localhost-only HTTP server that hosts the canvas UI and its JSON/SSE API.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join } from "node:path";
import { toMermaid } from "../core/mermaid.mjs";
import { renderSvg } from "../core/render.mjs";
import { sanitizeDocumentId } from "./store.mjs";

const MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
};

const CSP = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
].join("; ");

const MAX_BODY = 20 * 1024 * 1024;

class HttpError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on("data", (chunk) => {
            size += chunk.length;
            if (size > MAX_BODY) {
                reject(new HttpError(413, "Request body too large."));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on("end", () => {
            try {
                const text = Buffer.concat(chunks).toString("utf8");
                resolve(text ? JSON.parse(text) : {});
            } catch {
                reject(new HttpError(400, "Invalid JSON body."));
            }
        });
        req.on("error", reject);
    });
}

function sendJson(res, status, body) {
    const text = JSON.stringify(body);
    res.writeHead(status, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
    });
    res.end(text);
}

export function slugify(value) {
    const slug = String(value ?? "")
        .normalize("NFKC")
        .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "")
        .replace(/\s+/g, "-")
        .replace(/^[-.]+|[-.]+$/g, "")
        .slice(0, 60);
    return slug || "diagram";
}

function timestamp() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

export function exportContent(doc, format) {
    switch (format) {
        case "svg":
            return { ext: "svg", content: renderSvg(doc, { includeStrokes: true }).svg };
        case "json":
            return { ext: "json", content: `${JSON.stringify({ version: doc.version, title: doc.title, elements: doc.elements, strokes: doc.strokes }, null, 2)}\n` };
        case "mermaid":
            return { ext: "mmd", content: toMermaid(doc) };
        default:
            throw new HttpError(400, `Unsupported export format "${format}".`);
    }
}

/**
 * options: {
 *   store: DocumentStore, publicDir, coreDir, exportDirs: string[],
 *   onRefine(request) => Promise<object>, getStatus(documentId) => object, log(message, level)
 * }
 */
export async function startServer(options) {
    const { store, publicDir, coreDir } = options;
    const log = options.log || (() => {});
    const token = randomBytes(24).toString("hex");
    const tokenBuffer = Buffer.from(token);
    const clients = new Map();
    const statuses = new Map();
    const unsubscribers = new Map();
    let port = 0;

    const checkToken = (value) => {
        const candidate = Buffer.from(String(value ?? ""));
        return candidate.length === tokenBuffer.length && timingSafeEqual(candidate, tokenBuffer);
    };

    const ensureSubscribed = (documentId) => {
        if (unsubscribers.has(documentId)) return;
        unsubscribers.set(
            documentId,
            store.subscribe(documentId, (doc, meta) => {
                broadcast(documentId, "doc", { doc, clientId: meta?.clientId ?? null, seq: meta?.seq ?? null, source: meta?.source ?? "unknown" });
            }),
        );
    };

    const broadcast = (documentId, event, data) => {
        const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
        for (const res of clients.get(documentId) || []) res.write(payload);
    };

    const setStatus = (documentId, status) => {
        const id = sanitizeDocumentId(documentId);
        const value = { state: "idle", message: "", ...status, at: Date.now() };
        statuses.set(id, value);
        broadcast(id, "status", value);
    };

    const serveStatic = async (res, file) => {
        const body = await readFile(file);
        res.writeHead(200, {
            "content-type": MIME[extname(file)] || "application/octet-stream",
            "cache-control": "no-store",
            "content-security-policy": CSP,
            "x-content-type-options": "nosniff",
            "referrer-policy": "no-referrer",
        });
        res.end(body);
    };

    const saveExport = async (name, data) => {
        let lastError;
        for (const dir of options.exportDirs || []) {
            try {
                await mkdir(dir, { recursive: true });
                const path = join(dir, name);
                await writeFile(path, data);
                return path;
            } catch (error) {
                lastError = error;
            }
        }
        throw lastError || new Error("No export directory available.");
    };

    const handleApi = async (req, res, url) => {
        if (!checkToken(req.headers["x-shape-token"] || url.searchParams.get("token"))) throw new HttpError(403, "Invalid token.");
        const route = `${req.method} ${url.pathname}`;
        if (route === "GET /api/doc") {
            const documentId = sanitizeDocumentId(url.searchParams.get("doc"));
            const doc = await store.get(documentId);
            return sendJson(res, 200, { doc, status: statuses.get(documentId) || { state: "idle" } });
        }
        if (route === "GET /api/events") {
            const documentId = sanitizeDocumentId(url.searchParams.get("doc"));
            ensureSubscribed(documentId);
            res.writeHead(200, {
                "content-type": "text/event-stream; charset=utf-8",
                "cache-control": "no-store",
                connection: "keep-alive",
                "x-accel-buffering": "no",
            });
            const doc = await store.get(documentId);
            res.write(`retry: 1500\n\n`);
            res.write(`event: doc\ndata: ${JSON.stringify({ doc, clientId: null, seq: null, source: "initial" })}\n\n`);
            res.write(`event: status\ndata: ${JSON.stringify(statuses.get(documentId) || { state: "idle" })}\n\n`);
            if (!clients.has(documentId)) clients.set(documentId, new Set());
            clients.get(documentId).add(res);
            const keepAlive = setInterval(() => res.write(`: keep-alive\n\n`), 20000);
            req.on("close", () => {
                clearInterval(keepAlive);
                clients.get(documentId)?.delete(res);
            });
            return undefined;
        }
        if (route === "POST /api/patch") {
            const body = await readBody(req);
            const documentId = sanitizeDocumentId(body.documentId);
            if (!body.patch || typeof body.patch !== "object") throw new HttpError(400, "Missing patch.");
            const result = await store.apply(documentId, body.patch, {
                source: "client",
                clientId: typeof body.clientId === "string" ? body.clientId.slice(0, 64) : null,
                seq: Number.isInteger(body.seq) ? body.seq : null,
                applyOptions: { silentReplace: true },
            });
            return sendJson(res, 200, { revision: result.doc.revision, warnings: result.warnings });
        }
        if (route === "POST /api/refine") {
            const body = await readBody(req);
            const documentId = sanitizeDocumentId(body.documentId);
            if (!options.onRefine) throw new HttpError(501, "Refine is not available.");
            const result = await options.onRefine({
                documentId,
                instanceId: typeof body.instanceId === "string" ? body.instanceId : "",
                image: typeof body.image === "string" ? body.image : "",
                frame: body.frame && typeof body.frame === "object" ? body.frame : null,
                instruction: typeof body.instruction === "string" ? body.instruction.slice(0, 2000) : "",
            });
            return sendJson(res, 200, result);
        }
        if (route === "POST /api/export") {
            const body = await readBody(req);
            const documentId = sanitizeDocumentId(body.documentId);
            const doc = await store.get(documentId);
            const base = `${slugify(doc.title)}-${timestamp()}`;
            let path;
            if (body.format === "png") {
                const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(body.data || ""));
                if (!match) throw new HttpError(400, "PNG export requires a base64 data URL.");
                path = await saveExport(`${base}.png`, Buffer.from(match[1], "base64"));
            } else {
                const { ext, content } = exportContent(doc, body.format);
                path = await saveExport(`${base}.${ext}`, content);
            }
            log(`Exported ${body.format} to ${path}`);
            return sendJson(res, 200, { path });
        }
        throw new HttpError(404, "Not found.");
    };

    const server = createServer(async (req, res) => {
        try {
            const host = String(req.headers.host || "");
            if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) throw new HttpError(421, "Unexpected host.");
            const url = new URL(req.url || "/", `http://${host}`);
            if (url.pathname.startsWith("/api/")) return await handleApi(req, res, url);
            if (req.method !== "GET") throw new HttpError(405, "Method not allowed.");
            if (url.pathname === "/" || url.pathname === "/index.html") return await serveStatic(res, join(publicDir, "index.html"));
            if (url.pathname === "/app.js" || url.pathname === "/style.css") return await serveStatic(res, join(publicDir, url.pathname.slice(1)));
            const core = /^\/core\/([a-z]+\.mjs)$/.exec(url.pathname);
            if (core && ["geometry.mjs", "model.mjs", "render.mjs", "mermaid.mjs"].includes(core[1])) {
                return await serveStatic(res, join(coreDir, core[1]));
            }
            if (url.pathname === "/favicon.ico") {
                res.writeHead(204);
                return res.end();
            }
            throw new HttpError(404, "Not found.");
        } catch (error) {
            const status = error instanceof HttpError ? error.status : 500;
            if (status >= 500) log(`HTTP ${req.method} ${req.url?.split("?")[0]} failed: ${error?.stack || error}`, "error");
            if (!res.headersSent) sendJson(res, status, { error: error?.message || "Internal error" });
            else res.end();
        }
    });

    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
            server.off("error", reject);
            resolve();
        });
    });
    port = server.address().port;
    log(`shape server listening on http://127.0.0.1:${port}`);

    return {
        port,
        token,
        url(documentId, instanceId) {
            const params = new URLSearchParams({ doc: sanitizeDocumentId(documentId), instance: instanceId || "", token });
            return `http://127.0.0.1:${port}/?${params}`;
        },
        setStatus,
        getStatus: (documentId) => statuses.get(sanitizeDocumentId(documentId)) || { state: "idle" },
        async close() {
            for (const set of clients.values()) for (const res of set) res.end();
            for (const unsubscribe of unsubscribers.values()) unsubscribe();
            await new Promise((resolve) => {
                server.close(() => resolve());
                server.closeAllConnections?.();
            });
        },
    };
}
