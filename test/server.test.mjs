import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { startServer } from "../lib/server.mjs";
import { DocumentStore } from "../lib/store.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
let dir;
let store;
let server;
let refineCalls = [];

before(async () => {
    dir = await mkdtemp(join(tmpdir(), "shape-test-"));
    store = new DocumentStore(join(dir, "docs"), { writeDelayMs: 10 });
    server = await startServer({
        store,
        publicDir: join(root, "public"),
        coreDir: join(root, "core"),
        exportDirs: [join(dir, "exports")],
        onRefine: async (input) => {
            refineCalls.push(input);
            return { ok: true, jobId: "refine-test" };
        },
    });
});

after(async () => {
    await server.close();
    await store.flush();
    await rm(dir, { recursive: true, force: true });
});

function call(method, path, { body, token = server.token, host } = {}) {
    return new Promise((resolve, reject) => {
        const req = request(
            {
                host: "127.0.0.1",
                port: server.port,
                method,
                path,
                headers: {
                    host: host || `127.0.0.1:${server.port}`,
                    "content-type": "application/json",
                    ...(token ? { "x-shape-token": token } : {}),
                },
            },
            (res) => {
                let data = "";
                res.on("data", (chunk) => (data += chunk));
                res.on("end", () => {
                    let json = null;
                    try {
                        json = JSON.parse(data);
                    } catch {
                        // Not JSON.
                    }
                    resolve({ status: res.statusCode, headers: res.headers, text: data, json });
                });
            },
        );
        req.on("error", reject);
        if (body !== undefined) req.write(JSON.stringify(body));
        req.end();
    });
}

test("serves the UI shell and core modules with CSP", async () => {
    const page = await call("GET", "/");
    assert.equal(page.status, 200);
    assert.match(page.text, /id="board"/);
    assert.match(page.headers["content-security-policy"], /script-src 'self'/);
    const core = await call("GET", "/core/model.mjs");
    assert.equal(core.status, 200);
    assert.match(core.headers["content-type"], /javascript/);
    assert.equal((await call("GET", "/core/../lib/server.mjs")).status, 404);
});

test("rejects bad tokens and unexpected hosts", async () => {
    assert.equal((await call("GET", "/api/doc?doc=a", { token: "nope" })).status, 403);
    assert.equal((await call("GET", "/api/doc?doc=a", { token: null })).status, 403);
    assert.equal((await call("GET", "/", { host: "evil.example" })).status, 421);
});

test("patch, read back, and export", async () => {
    const patch = await call("POST", "/api/patch", {
        body: { documentId: "d1", clientId: "c1", seq: 1, patch: { title: "Hello", add: [{ id: "n1", type: "rect", label: "A" }] } },
    });
    assert.equal(patch.status, 200);
    assert.deepEqual(patch.json.warnings, []);
    const doc = await call("GET", "/api/doc?doc=d1");
    assert.equal(doc.json.doc.title, "Hello");
    assert.equal(doc.json.doc.elements[0].id, "n1");

    const exported = await call("POST", "/api/export", { body: { documentId: "d1", format: "mermaid" } });
    assert.equal(exported.status, 200);
    assert.match(await readFile(exported.json.path, "utf8"), /flowchart/);

    const svg = await call("POST", "/api/export", { body: { documentId: "d1", format: "svg" } });
    assert.match(await readFile(svg.json.path, "utf8"), /^<svg/);

    const badPng = await call("POST", "/api/export", { body: { documentId: "d1", format: "png", data: "data:text/html,hi" } });
    assert.equal(badPng.status, 400);
});

test("refine is forwarded to the handler", async () => {
    refineCalls = [];
    const res = await call("POST", "/api/refine", { body: { documentId: "d1", instanceId: "i1", image: "data:image/png;base64,AA==", instruction: "tidy" } });
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
    assert.equal(refineCalls[0].documentId, "d1");
    assert.equal(refineCalls[0].instruction, "tidy");
});

test("url() embeds doc, instance and token", () => {
    const url = new URL(server.url("my doc", "inst"));
    assert.equal(url.hostname, "127.0.0.1");
    assert.equal(url.searchParams.get("token"), server.token);
    assert.equal(url.searchParams.get("instance"), "inst");
});
