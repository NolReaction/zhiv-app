import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { createWorldStudioProjectFiles, worldStudioRequestAllowed, WORLD_STUDIO_BODY_LIMIT,
  WORLD_STUDIO_PENDING_LIMIT } from "../lib/dev/world-studio-project-files.mjs";
import { readTiledWorld, serializeTiledWorld } from "../scripts/lib/tiled-world.mjs";

const repository = fileURLToPath(new URL("..", import.meta.url));
const baseURL = "http://localhost:3002/api/dev/world-studio";
const request = (body, extra = {}) => new Request(baseURL, { method: body ? "POST" : "GET",
  headers: { host: "localhost:3002", ...(body ? { origin: "http://localhost:3002", "content-type": "application/json" } : {}), ...extra },
  ...(body ? { body: JSON.stringify(body) } : {}) });
function stalledUpload({ cancel } = {}) {
  const abort = new AbortController();
  const stream = new ReadableStream({ cancel });
  return { abort, request: new Request(baseURL, { method: "POST", duplex: "half", body: stream, signal: abort.signal,
    headers: { host: "localhost:3002", origin: "http://localhost:3002", "content-type": "application/json" } }) };
}
async function fixture(t, options = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "world-studio-project-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const mapPath = path.join(root, "world/tiled/forest.tmj"), outputPath = path.join(root, "features/world/tiled/forest.generated.json");
  await mkdir(path.dirname(mapPath), { recursive: true });
  await mkdir(path.dirname(outputPath), { recursive: true });
  await symlink(path.join(repository, "public"), path.join(root, "public"), "dir");
  await writeFile(mapPath, await readFile(path.join(repository, "world/tiled/forest.tmj")));
  const world = await readTiledWorld(mapPath, path.join(root, "public"));
  await writeFile(outputPath, serializeTiledWorld(world));
  const files = createWorldStudioProjectFiles({ root, ...options });
  const state = await files.read();
  const makeBody = (current = state, changes = { height: current.scene.shadowCasters[0].height + 1 }, id = "request-0001") => {
    const before = current.scene.shadowCasters[0];
    return { requestId: id, expectedRevision: current.revision, patch: { schemaVersion: 3, sceneId: current.scene.id,
      casters: [{ id: before.id, before, after: { ...before, ...changes } }], receivers: [], lights: [] } };
  };
  return { root, files, state, makeBody, mapPath, outputPath };
}

test("project write capability requires local development, matching Host and same-origin POST", () => {
  assert.equal(worldStudioRequestAllowed(request(), "development"), true);
  assert.equal(worldStudioRequestAllowed(request({}), "development"), true);
  for (const environment of ["production", "test", undefined]) assert.equal(worldStudioRequestAllowed(request({}), environment), false);
  assert.equal(worldStudioRequestAllowed(request({}, { origin: "https://evil.example" }), "development"), false);
  assert.equal(worldStudioRequestAllowed(request({}, { origin: "null" }), "development"), false);
  assert.equal(worldStudioRequestAllowed(request({}, { host: "evil.example" }), "development"), false);
  assert.equal(worldStudioRequestAllowed(request({}, { "sec-fetch-site": "cross-site" }), "development"), false);
  for (const hostname of ["192.168.1.20", "10.20.0.1", "172.20.1.2", "127.0.0.1", "[::1]"]) {
    const url = new URL(`http://${hostname}:3002/api/dev/world-studio`);
    const lan = new Request(url, { method: "POST", headers: { host: url.host, origin: url.origin } });
    assert.equal(worldStudioRequestAllowed(lan, "development"), true);
  }
  for (const hostname of ["im-alive.ru", "127.attacker.example", "192.169.0.1", "172.32.0.1", "8.8.8.8"]) {
    const url = new URL(`https://${hostname}/api/dev/world-studio`);
    assert.equal(worldStudioRequestAllowed(new Request(url, { headers: { host: url.host } }), "development"), false);
  }
  for (const internal of ["http://0.0.0.0:3002/api/dev/world-studio", baseURL]) {
    for (const host of ["192.168.1.20:3002", "127.0.0.1:3002"]) {
      assert.equal(worldStudioRequestAllowed(new Request(internal, { method: "POST", headers: { host, origin: `http://${host}` } }), "development"), true);
    }
  }
  for (const host of ["evil.example", "localhost:3002/path", "localhost:3002@evil.example", "localhost:3002?x=1"]) {
    assert.equal(worldStudioRequestAllowed(new Request(baseURL, { headers: { host } }), "development"), false);
  }
  // Neither a forwarded private host nor same-site status authorizes an evil origin.
  assert.equal(worldStudioRequestAllowed(request({}, { host: "evil.example", "x-forwarded-host": "localhost:3002" }), "development"), false);
  assert.equal(worldStudioRequestAllowed(request({}, { origin: "http://localhost:4000", "sec-fetch-site": "same-site" }), "development"), false);
  const noOrigin = request({}); noOrigin.headers.delete("origin");
  assert.equal(worldStudioRequestAllowed(noOrigin, "development"), false);
});

test("slow POST body never holds the project queue; abort releases it without writing", { timeout: 15_000 }, async t => {
  const { files, mapPath, outputPath } = await fixture(t);
  const map = await readFile(mapPath, "utf8"), generated = await readFile(outputPath, "utf8");
  const upload = stalledUpload();
  t.after(() => upload.abort.abort());
  const pending = files.handle(upload.request, "development");
  const response = await Promise.race([files.handle(request(), "development"), pending.then(() => {
    assert.fail("A stalled upload must not delay the next GET until its deadline.");
  })]);
  assert.equal(response.status, 200);
  upload.abort.abort();
  assert.equal((await pending).status, 408);
  assert.equal(await readFile(mapPath, "utf8"), map);
  assert.equal(await readFile(outputPath, "utf8"), generated);
});

test("upload deadline responds even if stream cancellation never settles", { timeout: 1_000 }, async () => {
  const files = createWorldStudioProjectFiles({ bodyTimeoutMs: 20 });
  let cancelled = false;
  const upload = stalledUpload({ cancel: () => { cancelled = true; return new Promise(() => {}); } });
  const response = await files.handle(upload.request, "development");
  assert.equal(response.status, 408);
  assert.equal(cancelled, true);
  assert.match((await response.json()).message, /Истекло время/);
});

test("pending request budget rejects bursts and recovers after aborted uploads", async t => {
  const files = createWorldStudioProjectFiles({ root: path.join(tmpdir(), "studio-unread-pending-budget") });
  const uploads = Array.from({ length: WORLD_STUDIO_PENDING_LIMIT }, () => stalledUpload());
  t.after(() => uploads.forEach(upload => upload.abort.abort()));
  const pending = uploads.map(upload => files.handle(upload.request, "development"));
  const busy = await files.handle(request(), "development");
  assert.equal(busy.status, 429);
  assert.equal(busy.headers.get("retry-after"), "1");
  assert.equal((await busy.json()).code, "STUDIO_PROJECT_BUSY");
  uploads.forEach(upload => upload.abort.abort());
  assert.deepEqual((await Promise.all(pending)).map(response => response.status), Array(WORLD_STUDIO_PENDING_LIMIT).fill(408));
  assert.equal((await files.handle(request(), "development")).status, 503, "All upload slots are released before the next request.");
});

test("declared and streamed body limits reject requests without touching the checkout", async () => {
  const files = createWorldStudioProjectFiles({ root: path.join(tmpdir(), "studio-unread-body-budget") });
  const declared = await files.handle(request({}, { "content-length": String(WORLD_STUDIO_BODY_LIMIT + 1) }), "development");
  assert.equal(declared.status, 413);
  let cancelled = false;
  const body = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(WORLD_STUDIO_BODY_LIMIT + 1)); },
    cancel() { cancelled = true; } });
  const streamed = await files.handle(new Request(baseURL, { method: "POST", duplex: "half", body,
    headers: { host: "localhost:3002", origin: "http://localhost:3002", "content-type": "application/json" } }), "development");
  assert.equal(streamed.status, 413);
  assert.equal(cancelled, true);
  for (const headers of [{ "content-type": "application/jsonp" }, { "content-type": "application/json-malicious" }, { "content-encoding": "gzip" }])
    assert.equal((await files.handle(request({}, headers), "development")).status, 415);
});

test("over-budget geometry is rejected before reading or compiling the project", async () => {
  const files = createWorldStudioProjectFiles({ root: path.join(tmpdir(), "studio-unread-patch-budget") });
  const body = patch => ({ expectedRevision: "a".repeat(64), requestId: "request-geometry-budget",
    patch: { schemaVersion: 3, sceneId: "forest", casters: [], receivers: [], lights: [], ...patch } });
  const patches = [
    { casters: Array(129).fill(null) }, { receivers: Array(33).fill(null) }, { lights: Array(129).fill(null) },
    { casters: [{ after: { points: Array(65).fill({ x: 0, y: 0 }) } }] },
    { receivers: [{ before: { holes: Array(17).fill([]) } }] },
    { receivers: [{ after: { holes: [Array(65).fill({ x: 0, y: 0 })] } }] },
  ];
  for (const patch of patches) {
    const response = await files.handle(request(body(patch)), "development");
    assert.equal(response.status, 400);
    assert.match((await response.json()).message, /^patch\./);
  }
});

test("checkout I/O failures do not expose host filesystem paths", async () => {
  const privatePath = path.join(tmpdir(), "studio-missing-private-checkout");
  const files = createWorldStudioProjectFiles({ root: privatePath });
  const response = await files.handle(request(), "development");
  assert.equal(response.status, 503);
  const text = await response.text();
  assert.equal(text.includes(privatePath), false);
  assert.equal(text.includes("ENOENT"), false);
  assert.equal(text.includes("world/tiled/forest.tmj"), false);
});

test("production route is unavailable before reading checkout and accepts no client paths", async t => {
  const { files, mapPath } = await fixture(t);
  const before = await readFile(mapPath, "utf8");
  assert.equal((await files.handle(request(), "production")).status, 404);
  const malformed = { expectedRevision: "a".repeat(64), requestId: "request-0001", patch: {}, mapPath: "/tmp/other.tmj" };
  assert.equal((await files.handle(request(malformed), "development")).status, 400);
  assert.equal(await readFile(mapPath, "utf8"), before);
});

test("saving updates source and complete generated scene; second save and delete/Undo use new disk baseline", async t => {
  const { files, state, makeBody, mapPath, outputPath } = await fixture(t);
  const first = await files.save(makeBody());
  assert.notEqual(first.revision, state.revision);
  const second = await files.save(makeBody(first, { height: first.scene.shadowCasters[0].height + 2 }, "request-0002"));
  assert.equal(second.scene.shadowCasters[0].height, state.scene.shadowCasters[0].height + 3);
  assert.deepEqual(JSON.parse(await readFile(outputPath, "utf8")), second.scene);
  assert.deepEqual(await readTiledWorld(mapPath, path.join(path.dirname(path.dirname(path.dirname(mapPath))), "public")), second.scene);
  const caster = second.scene.shadowCasters[0];
  const deletion = { requestId: "request-delete", expectedRevision: second.revision, patch: { schemaVersion: 3, sceneId: second.scene.id,
    casters: [{ id: caster.id, before: caster, after: null }], receivers: [], lights: [] } };
  const removed = await files.save(deletion);
  assert.equal(removed.scene.shadowCasters.some(value => value.id === caster.id), false);
  const restored = await files.save({ ...deletion, requestId: "request-undo", expectedRevision: removed.revision,
    patch: { ...deletion.patch, casters: [{ id: caster.id, before: null, after: caster }] } });
  assert.deepEqual(restored.scene.shadowCasters.find(value => value.id === caster.id), caster);
});

test("lost acknowledgement retry is idempotent; same key cannot change payload", async t => {
  const { files, makeBody, mapPath, outputPath } = await fixture(t);
  const body = makeBody(), first = await files.save(body);
  const map = await readFile(mapPath, "utf8"), generated = await readFile(outputPath, "utf8");
  const repeated = await files.save(body);
  assert.equal(repeated.revision, first.revision);
  assert.equal(await readFile(mapPath, "utf8"), map);
  assert.equal(await readFile(outputPath, "utf8"), generated);
  await assert.rejects(() => files.save({ ...body, patch: { ...body.patch, lights: [] }, expectedRevision: first.revision }), /Ключ/);
});

test("Studio metadata is preserved in both project files, save receipts and subsequent clearing", async t => {
  const { files, state, makeBody, mapPath, outputPath } = await fixture(t);
  const original = state.scene.shadowCasters[0];
  const body = makeBody(state, { studioName: "Северная сосна", studioFolder: "custom:Мои объекты/Лес" }, "request-metadata");
  const saved = await files.save(body);
  assert.equal(saved.scene.shadowCasters[0].studioName, "Северная сосна");
  assert.equal(saved.scene.shadowCasters[0].studioFolder, "custom:Мои объекты/Лес");
  assert.deepEqual(saved.scene.shadowCasters[0].points, original.points);
  assert.deepEqual(JSON.parse(await readFile(outputPath, "utf8")), saved.scene);
  const bytes = await readFile(mapPath, "utf8");
  assert.equal((await files.save(body)).revision, saved.revision); assert.equal(await readFile(mapPath, "utf8"), bytes);
  const renamed = saved.scene.shadowCasters[0];
  const cleared = await files.save({ requestId: "request-metadata-clear", expectedRevision: saved.revision,
    patch: { schemaVersion: 3, sceneId: saved.scene.id, casters: [{ id: original.id, before: renamed, after: original }], receivers: [], lights: [] } });
  assert.deepEqual(cleared.scene.shadowCasters[0], original);
  assert.deepEqual(JSON.parse(await readFile(outputPath, "utf8")), cleared.scene);
});

test("external Tiled edits conflict even if unrelated to light edits; concurrent stale save never overwrites", async t => {
  const { files, makeBody, mapPath, outputPath } = await fixture(t);
  const body = makeBody();
  const results = await Promise.allSettled([files.save(body), files.save({ ...body, requestId: "request-concurrent" })]);
  assert.equal(results[0].status, "fulfilled");
  assert.equal(results[1].status, "rejected");
  const saved = await files.read();
  const external = `${await readFile(mapPath, "utf8")}\n`;
  await writeFile(mapPath, external);
  const generated = await readFile(outputPath, "utf8");
  const response = await files.handle(request(makeBody(saved, { height: saved.scene.shadowCasters[0].height + 1 }, "request-external")), "development");
  assert.equal(response.status, 409);
  assert.equal(await readFile(mapPath, "utf8"), external);
  assert.equal(await readFile(outputPath, "utf8"), generated);
});

test("second-file rename failure rolls source back and removes all temporary files", async t => {
  let renames = 0;
  const { files, makeBody, mapPath, outputPath } = await fixture(t, { renameFile: async (from, to) => {
    if (++renames === 2) throw new Error("simulated export rename failure");
    return rename(from, to);
  } });
  const map = await readFile(mapPath, "utf8"), generated = await readFile(outputPath, "utf8");
  await assert.rejects(() => files.save(makeBody()), /simulated/);
  assert.equal(await readFile(mapPath, "utf8"), map);
  assert.equal(await readFile(outputPath, "utf8"), generated);
  assert.deepEqual(await readdir(path.dirname(mapPath)), ["forest.tmj"]);
  assert.deepEqual(await readdir(path.dirname(outputPath)), ["forest.generated.json"]);
});

test("invalid lighting patch fails before either file changes and source revision guards retry after external edit", async t => {
  const { files, makeBody, mapPath, outputPath } = await fixture(t);
  const before = await readFile(mapPath, "utf8"), generated = await readFile(outputPath, "utf8");
  const invalid = makeBody(); invalid.patch.casters[0].after.height = -1;
  const response = await files.handle(request(invalid), "development");
  assert.equal(response.status, 400);
  assert.equal(await readFile(mapPath, "utf8"), before);
  assert.equal(await readFile(outputPath, "utf8"), generated);
  const body = makeBody(); await files.save(body);
  await writeFile(mapPath, `${await readFile(mapPath, "utf8")}\n`);
  await assert.rejects(() => files.save(body), /другом редакторе/);
});
