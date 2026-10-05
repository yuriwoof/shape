// Persistent per-document store (one JSON file per document) with change subscriptions.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { applyPatch, emptyDocument, normalizeDocument } from "../core/model.mjs";

export function sanitizeDocumentId(value) {
    const id = String(value ?? "")
        .trim()
        .replace(/[^A-Za-z0-9_-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 80);
    return id || "default";
}

export class DocumentStore {
    constructor(dir, { writeDelayMs = 250 } = {}) {
        this.dir = dir;
        this.writeDelayMs = writeDelayMs;
        this.docs = new Map();
        this.loading = new Map();
        this.queues = new Map();
        this.listeners = new Map();
        this.timers = new Map();
        this.writing = new Map();
    }

    async get(documentId, title) {
        const id = sanitizeDocumentId(documentId);
        if (this.docs.has(id)) return this.docs.get(id);
        if (!this.loading.has(id)) {
            this.loading.set(
                id,
                (async () => {
                    let doc;
                    try {
                        const raw = JSON.parse(await readFile(this.file(id), "utf8"));
                        doc = normalizeDocument(raw, id, title);
                    } catch (error) {
                        if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
                        doc = emptyDocument(id, title || "Untitled diagram");
                    }
                    this.docs.set(id, doc);
                    this.loading.delete(id);
                    return doc;
                })(),
            );
        }
        return this.loading.get(id);
    }

    file(id) {
        return join(this.dir, `${sanitizeDocumentId(id)}.json`);
    }

    /** Serializes mutations per document. fn(doc) returns { doc, ...extra } or null for no change. */
    mutate(documentId, fn, meta = {}) {
        const id = sanitizeDocumentId(documentId);
        const previous = this.queues.get(id) || Promise.resolve();
        const run = previous.then(async () => {
            const current = await this.get(id);
            const result = await fn(current);
            if (!result || !result.doc || result.doc === current) return { doc: current, ...(result || {}), changed: false };
            const next = {
                ...result.doc,
                documentId: id,
                revision: current.revision + 1,
                updatedAt: new Date().toISOString(),
            };
            this.docs.set(id, next);
            this.scheduleWrite(id);
            this.emit(id, next, meta);
            return { ...result, doc: next, changed: true };
        });
        this.queues.set(
            id,
            run.catch(() => undefined),
        );
        return run;
    }

    apply(documentId, patch, meta = {}) {
        return this.mutate(
            documentId,
            (doc) => {
                const result = applyPatch(doc, patch, meta.applyOptions);
                const s = result.summary;
                const unchanged =
                    !s.added.length && !s.updated.length && !s.deleted.length && !s.strokesAdded && !s.strokesDeleted && result.doc.title === doc.title;
                return unchanged ? { ...result, doc } : result;
            },
            meta,
        );
    }

    subscribe(documentId, listener) {
        const id = sanitizeDocumentId(documentId);
        if (!this.listeners.has(id)) this.listeners.set(id, new Set());
        this.listeners.get(id).add(listener);
        return () => this.listeners.get(id)?.delete(listener);
    }

    emit(id, doc, meta) {
        for (const listener of this.listeners.get(id) || []) {
            try {
                listener(doc, meta);
            } catch {
                // Listener failures must not break the store.
            }
        }
    }

    scheduleWrite(id) {
        clearTimeout(this.timers.get(id));
        this.timers.set(
            id,
            setTimeout(() => {
                this.timers.delete(id);
                void this.write(id);
            }, this.writeDelayMs),
        );
    }

    async write(id) {
        const pending = this.writing.get(id) || Promise.resolve();
        const next = pending.then(async () => {
            const doc = this.docs.get(id);
            if (!doc) return;
            await mkdir(this.dir, { recursive: true });
            const target = this.file(id);
            const temp = `${target}.${process.pid}.tmp`;
            await writeFile(temp, JSON.stringify(doc, null, 2), "utf8");
            await rename(temp, target);
        });
        this.writing.set(
            id,
            next.catch(() => undefined),
        );
        return next;
    }

    async flush() {
        const ids = [...this.timers.keys()];
        for (const id of ids) clearTimeout(this.timers.get(id));
        this.timers.clear();
        await Promise.all(ids.map((id) => this.write(id)));
        await Promise.all([...this.writing.values()]);
    }
}
