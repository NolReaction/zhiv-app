import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";
import { once } from "node:events";
import sharp from "sharp";
import { createGarageProjectFiles, garageProjectRequestAllowed, GARAGE_IMAGE_LIMIT, GARAGE_JSON_LIMIT }
  from "../lib/dev/boat-garage-project-files.mjs";
import { boatGarageProjectFilesDev } from "../build/boat-garage-project-files-plugin.mjs";

const repository = fileURLToPath(new URL("..", import.meta.url));
const baseURL = "http://localhost:3002/api/dev/boat-garage";
function request(method = "GET", body, headers = {}) {
  return new Request(baseURL, { method, headers: { host: "localhost:3002",
    ...(method !== "GET" ? { origin: "http://localhost:3002" } : {}),
    ...(method === "POST" ? { "content-type": "application/json" } : {}), ...headers },
  ...(body !== undefined ? { body: method === "POST" && typeof body !== "string" ? JSON.stringify(body) : body } : {}) });
}
async function fixture(t, options = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "garage-project-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const destination = path.join(root, "features/world/dev/boat-garage");
  await mkdir(destination, { recursive: true });
  await writeFile(path.join(destination, "garage-scene-default.json"), await readFile(path.join(repository, "features/world/dev/boat-garage/garage-scene-default.json")));
  const files = createGarageProjectFiles({ root, ...options });
  return { root, files, state: await files.read() };
}
const image = () => sharp({ create: { width: 8, height: 6, channels: 4, background: { r: 120, g: 130, b: 90, alpha: 0.7 } } }).png().toBuffer();

test("garage project access is development-only and writes require same origin, including PUT", async () => {
  for (const method of ["GET", "POST", "PUT"]) {
    const body = method === "GET" ? undefined : "{}";
    assert.equal(garageProjectRequestAllowed(request(method, body), "development"), true);
    for (const environment of ["production", "test", undefined])
      assert.equal(garageProjectRequestAllowed(request(method, body), environment), false);
    assert.equal(garageProjectRequestAllowed(request(method, body, { origin: "https://evil.example" }), "development"), false);
    assert.equal(garageProjectRequestAllowed(request(method, body, { host: "evil.example" }), "development"), false);
    if (method !== "GET") {
      const missingOrigin = request(method, body); missingOrigin.headers.delete("origin");
      assert.equal(garageProjectRequestAllowed(missingOrigin, "development"), false);
    }
  }
  const files = createGarageProjectFiles({ root: "/nonexistent" });
  assert.equal((await files.handle(request(), "production")).status, 404);
  assert.equal((await files.handle(request("PUT", "x", { origin: "https://evil.example" }), "development")).status, 403);
});

test("scene fallback, atomic save, reload and stale revision preserve the first writer", async t => {
  const { files, root, state } = await fixture(t);
  const get = await files.handle(request(), "development");
  assert.equal(get.status, 200); assert.equal(get.headers.get("cache-control"), "no-store");
  assert.deepEqual(await get.json(), state);
  const scene = structuredClone(state.scene); scene.nodes[0].name = "Фон мастерской";
  const writes = await Promise.all(["one", "two"].map(name => {
    const version = structuredClone(scene); version.nodes[0].name = name;
    return files.handle(request("POST", { scene: version, expectedRevision: state.revision }), "development");
  }));
  assert.deepEqual(writes.map(response => response.status), [200, 409]);
  const saved = await writes[0].json();
  assert.notEqual(saved.revision, state.revision);
  assert.equal(saved.scene.nodes[0].name, "one");
  assert.deepEqual(await createGarageProjectFiles({ root }).read(), saved);
  assert.deepEqual(JSON.parse(await readFile(path.join(root, "art/world/boat-garage/scene.json"), "utf8")), saved.scene);
  assert.deepEqual((await readdir(path.join(root, "art/world/boat-garage"))).filter(name => name.endsWith(".tmp")), []);
});

test("invalid scene and malformed JSON cannot replace a saved scene", async t => {
  const { files, root, state } = await fixture(t);
  const malformed = await files.handle(request("POST", "{"), "development");
  assert.equal(malformed.status, 400);
  const scene = structuredClone(state.scene); scene.nodes[0].x = null;
  assert.equal((await files.handle(request("POST", { scene, expectedRevision: state.revision }), "development")).status, 400);
  assert.equal((await files.handle(request("POST", { scene: state.scene, expectedRevision: "bad" }), "development")).status, 400);
  assert.equal((await files.handle(request("POST", "x", { "content-type": "text/plain" }), "development")).status, 415);
  assert.deepEqual(await files.read(), state);
  await assert.rejects(readFile(path.join(root, "art/world/boat-garage/scene.json")), { code: "ENOENT" });
});

test("raster upload preserves exact bytes and alpha in both stores, names never control the path", async t => {
  const { files, root } = await fixture(t), png = await image();
  const response = await files.handle(request("PUT", png, { "content-type": "image/png", "x-asset-name": "..%2F..%2Fevil.png" }), "development");
  assert.equal(response.status, 201);
  const { asset } = await response.json();
  assert.match(asset.id, /^asset-[0-9a-f]{12}$/);
  assert.equal(asset.name, "evil.png");
  assert.equal(asset.width, 8); assert.equal(asset.height, 6);
  assert.match(asset.src, /^\/world\/boat-garage\/asset-[0-9a-f]{64}\.png$/);
  const filename = path.basename(asset.src);
  for (const directory of ["art", "public"])
    assert.deepEqual(await readFile(path.join(root, directory, "world/boat-garage", filename)), png);
  const again = await files.handle(request("PUT", png, { "content-type": "image/png" }), "development");
  assert.equal(again.status, 201); assert.equal((await again.json()).asset.src, asset.src);
  assert.equal((await readdir(path.join(root, "public/world/boat-garage"))).length, 1);
});

test("JPEG and WebP import use dimensions from decoded bytes", async t => {
  const { files } = await fixture(t);
  for (const [format, mime, extension] of [["jpeg", "image/jpeg", "jpg"], ["webp", "image/webp", "webp"]]) {
    const bytes = await sharp(await image())[format]().toBuffer();
    const response = await files.handle(request("PUT", bytes, { "content-type": mime }), "development");
    assert.equal(response.status, 201);
    const { asset } = await response.json(); assert.equal(asset.width, 8); assert.equal(asset.height, 6);
    assert.ok(asset.src.endsWith(`.${extension}`));
  }
});

test("JPEG orientation reports browser-visible dimensions without changing original bytes", async t => {
  const { files, root } = await fixture(t);
  const bytes = await sharp(await image()).withMetadata({ orientation: 6 }).jpeg().toBuffer();
  const response = await files.handle(request("PUT", bytes, { "content-type": "image/jpeg" }), "development");
  assert.equal(response.status, 201);
  const { asset } = await response.json();
  assert.equal(asset.width, 6); assert.equal(asset.height, 8);
  assert.deepEqual(await readFile(path.join(root, "public", asset.src)), bytes);
});

test("symlink directories, scenes and fallback files cannot redirect project reads or writes", async t => {
  for (const target of ["art", "art/world/boat-garage", "public/world/boat-garage", "art/world/boat-garage/scene.json", "features/world/dev/boat-garage",
    "features/world/dev/boat-garage/garage-scene-default.json"]) {
    await t.test(target, async t => {
      const { root, files, state } = await fixture(t), png = await image();
      const outside = await mkdtemp(path.join(tmpdir(), "garage-outside-"));
      t.after(() => rm(outside, { recursive: true, force: true }));
      const link = path.join(root, target), isFile = target.endsWith(".json");
      await mkdir(path.dirname(link), { recursive: true });
      const outsideFile = path.join(outside, "scene.json");
      const original = JSON.stringify(state.scene);
      await writeFile(outsideFile, original);
      await rm(link, { force: true, recursive: true });
      await symlink(isFile ? outsideFile : outside, link, isFile ? "file" : "dir");
      if (target.startsWith("public")) {
        assert.equal((await files.handle(request("PUT", png, { "content-type": "image/png" }), "development")).status, 503);
      } else {
        assert.equal((await files.handle(request(), "development")).status, 503);
        assert.equal((await files.handle(request("POST", { scene: state.scene, expectedRevision: state.revision }), "development")).status, 503);
        if (target.startsWith("art") && !isFile)
          assert.equal((await files.handle(request("PUT", png, { "content-type": "image/png" }), "development")).status, 503);
      }
      assert.equal(await readFile(outsideFile, "utf8"), original);
      assert.deepEqual(await readdir(outside), ["scene.json"]);
    });
  }
});

test("existing upload symlinks are rejected even when their target contains identical image bytes", async t => {
  const { root, files } = await fixture(t), png = await image();
  const outside = await mkdtemp(path.join(tmpdir(), "garage-image-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const target = path.join(outside, "image.png"); await writeFile(target, png);
  const hash = createHash("sha256").update(png).digest("hex");
  for (const folder of ["art", "public"]) {
    const directory = path.join(root, folder, "world/boat-garage"); await mkdir(directory, { recursive: true });
    await symlink(target, path.join(directory, `asset-${hash}.png`), "file");
  }
  assert.equal((await files.handle(request("PUT", png, { "content-type": "image/png" }), "development")).status, 503);
  assert.deepEqual(await readFile(target), png);
});

test("wrong MIME, SVG, corrupt raster, oversized dimensions and over-budget bodies are rejected", async t => {
  const { files, root } = await fixture(t), png = await image();
  assert.equal((await files.handle(request("PUT", png, { "content-type": "image/jpeg" }), "development")).status, 415);
  assert.equal((await files.handle(request("PUT", "<svg/>", { "content-type": "image/svg+xml" }), "development")).status, 415);
  assert.equal((await files.handle(request("PUT", "<svg/>", { "content-type": "image/png" }), "development")).status, 415);
  assert.equal((await files.handle(request("PUT", png.subarray(0, 30), { "content-type": "image/png" }), "development")).status, 400);
  const wide = await sharp({ create: { width: 4097, height: 1, channels: 3, background: "red" } }).png().toBuffer();
  assert.equal((await files.handle(request("PUT", wide, { "content-type": "image/png" }), "development")).status, 400);
  for (const [method, limit, mime] of [["PUT", GARAGE_IMAGE_LIMIT, "image/png"], ["POST", GARAGE_JSON_LIMIT, "application/json"]]) {
    assert.equal((await files.handle(request(method, "x", { "content-type": mime, "content-length": String(limit + 1) }), "development")).status, 413);
    assert.equal((await files.handle(request(method, new Uint8Array(limit + 1), { "content-type": mime }), "development")).status, 413);
  }
  await assert.rejects(readdir(path.join(root, "public/world/boat-garage")), { code: "ENOENT" });
});

test("stalled body has a deadline and does not block GET or future uploads", async t => {
  const { files, state } = await fixture(t, { bodyTimeoutMs: 20 });
  let cancelled = false;
  const stalled = new Request(baseURL, { method: "PUT", duplex: "half", body: new ReadableStream({ cancel() { cancelled = true; } }),
    headers: { host: "localhost:3002", origin: "http://localhost:3002", "content-type": "image/png" } });
  const pending = files.handle(stalled, "development");
  assert.deepEqual(await (await files.handle(request(), "development")).json(), state);
  assert.equal((await pending).status, 408); assert.equal(cancelled, true);
  assert.equal((await files.handle(request("PUT", await image(), { "content-type": "image/png" }), "development")).status, 201);
});

test("Vite Node adapter serves localhost save/upload and keeps public Host and cross-origin writes closed", async t => {
  const { root } = await fixture(t);
  const previous = process.env.NODE_ENV; process.env.NODE_ENV = "development";
  t.after(() => { if (previous === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous; });
  let middleware;
  const plugin = boatGarageProjectFilesDev();
  assert.equal(plugin.apply, "serve");
  await plugin.configureServer({ config: { root }, middlewares: { use(handler) { middleware = handler; } } });
  const server = createServer((incoming, outgoing) => middleware(incoming, outgoing, () => { outgoing.writeHead(404); outgoing.end(); }));
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const origin = `http://127.0.0.1:${server.address().port}`, endpoint = `${origin}/api/dev/boat-garage`;
  const read = await fetch(endpoint); assert.equal(read.status, 200);
  const state = await read.json(), scene = structuredClone(state.scene); scene.nodes[0].name = "Через Vite";
  const save = await fetch(endpoint, { method: "POST", headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({ scene, expectedRevision: state.revision }) });
  assert.equal(save.status, 200); assert.equal((await save.json()).scene.nodes[0].name, "Через Vite");
  assert.equal((await fetch(endpoint, { method: "PUT", headers: { origin, "content-type": "image/png" }, body: await image() })).status, 201);
  assert.equal((await fetch(endpoint, { method: "PUT", headers: { "content-type": "image/png" }, body: await image() })).status, 403);
  const forgedHostStatus = await new Promise((resolve, reject) => {
    const call = httpRequest(endpoint, { headers: { host: "evil.example", "x-forwarded-host": new URL(origin).host } }, response => {
      response.resume(); response.once("end", () => resolve(response.statusCode));
    });
    call.on("error", reject); call.end();
  });
  assert.equal(forgedHostStatus, 403);
  assert.equal((await fetch(endpoint, { method: "POST", headers: { origin: "https://evil.example", "content-type": "application/json" }, body: "{}" })).status, 403);
  assert.equal((await fetch(`${origin}/other`)).status, 404);
  // The network peer is checked before Host, origin or proxy headers.
  let status;
  middleware({ url: "/api/dev/boat-garage", socket: { remoteAddress: "8.8.8.8" } }, {
    writeHead(value) { status = value; }, end() {},
  }, () => assert.fail("Public peers must not reach the worker."));
  assert.equal(status, 403);
  process.env.NODE_ENV = "production";
  assert.equal((await fetch(endpoint)).status, 404);
});
