import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { createEarthModelProjectFiles, earthModelRequestAllowed, EARTH_MODEL_BODY_LIMIT,
  EARTH_MODEL_PENDING_LIMIT } from "../lib/dev/earth-model-project-files.mjs";

const baseURL = "http://localhost:3002/api/dev/earth-models";
const document = { version: 1, placements: [{ id: "eiffel-tower", longitude: 2.2945, latitude: 48.8584,
  heightMeters: 330, headingDegrees: 45, elevationMeters: 0, exclusionRadiusMeters: 45, excludeBuildings: true }] };
const encode = input => `${JSON.stringify(input, null, 2)}\n`;
const request = (body, extra = {}, url = baseURL) => new Request(url, { method: body ? "POST" : "GET",
  headers: { host: new URL(url).host, ...(body ? { origin: new URL(url).origin, "content-type": "application/json" } : {}), ...extra },
  ...(body ? { body: JSON.stringify(body) } : {}) });
function stalledUpload({ cancel } = {}) {
  const abort = new AbortController();
  return { abort, request: new Request(baseURL, { method: "POST", duplex: "half", body: new ReadableStream({ cancel }), signal: abort.signal,
    headers: { host: "localhost:3002", origin: "http://localhost:3002", "content-type": "application/json" } }) };
}
async function fixture(t, options = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "earth-model-project-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "features/earth/data/model-placements.json");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, encode(document));
  const files = createEarthModelProjectFiles({ root, ...options });
  const initial = await files.read();
  const body = (state = initial) => ({ revision: state.revision, document: { version: 1,
    placements: state.document.placements.map(placement => ({ ...placement, headingDegrees: placement.headingDegrees + 5 })) } });
  return { root, file, files, initial, body };
}

test("placement file requests require development, a loopback target and matching Host and browser origin", () => {
  assert.equal(earthModelRequestAllowed(request(), "development"), true);
  assert.equal(earthModelRequestAllowed(request({}), "development"), true);
  for (const mode of ["production", "test", "preview", ""]) assert.equal(earthModelRequestAllowed(request({}), mode), false);
  for (const host of ["127.0.0.1", "127.20.0.1", "[::1]"])
    assert.equal(earthModelRequestAllowed(request({}, {}, `http://${host}:3002/api/dev/earth-models`), "development"), true);
  for (const host of ["evil.example", "192.168.1.20", "10.0.0.1", "172.16.0.1", "0.0.0.0", "localhost.evil.example", "127.attacker.example"])
    assert.equal(earthModelRequestAllowed(request({}, {}, `http://${host}:3002/api/dev/earth-models`), "development"), false);
  for (const extra of [{ host: "evil.example" }, { host: "localhost:3002@evil.example" }, { host: "localhost:3002/path" },
    { host: "localhost:3002?query" }, { host: "localhost:3003" }, { origin: "null" }, { origin: "https://evil.example" },
    { origin: "http://localhost:3003" }, { "sec-fetch-site": "cross-site" }, { "sec-fetch-site": "same-site" },
    { host: "evil.example", "x-forwarded-host": "localhost:3002" }])
    assert.equal(earthModelRequestAllowed(request({}, extra), "development"), false, JSON.stringify(extra));
  const missingHost = request({}); missingHost.headers.delete("host");
  assert.equal(earthModelRequestAllowed(missingHost, "development"), false);
  const noOrigin = request({}); noOrigin.headers.delete("origin");
  assert.equal(earthModelRequestAllowed(noOrigin, "development"), false);
  assert.equal(earthModelRequestAllowed(request(undefined, { origin: "https://evil.example" }), "development"), false);
  assert.equal(earthModelRequestAllowed(request({}, { host: "localhost:3002", origin: "http://localhost:3002" }, "http://evil.example/api/dev/earth-models"), "development"), false);
  assert.equal(earthModelRequestAllowed(request({}, { "sec-fetch-site": "same-origin" }), "development"), true);
});

test("GET returns the current authored document and a raw-file SHA-256 revision; saves only the fixed path", async t => {
  const { files, initial, body, file } = await fixture(t);
  const response = await files.handle(request(), "development");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), initial);
  assert.match(initial.revision, /^[0-9a-f]{64}$/);
  const saved = await files.handle(request(body()), "development");
  assert.equal(saved.status, 200);
  const result = await saved.json();
  assert.notEqual(result.revision, initial.revision);
  assert.equal(result.document.placements[0].headingDegrees, 50);
  assert.equal(await readFile(file, "utf8"), encode(result.document));
  assert.deepEqual(await files.read(), result);
  assert.deepEqual(await readdir(path.dirname(file)), ["model-placements.json"]);
});

test("stale saves and concurrent tabs receive 409 without overwriting newer data", async t => {
  const { files, body, file } = await fixture(t);
  const saves = await Promise.all([files.handle(request(body()), "development"), files.handle(request(body()), "development")]);
  assert.deepEqual(saves.map(response => response.status), [200, 409]);
  assert.equal((await saves[1].json()).code, "EARTH_MODELS_CONFLICT");
  const state = await files.read(), edited = `${await readFile(file, "utf8")}\n`;
  await writeFile(file, edited);
  const response = await files.handle(request(body(state)), "development");
  assert.equal(response.status, 409);
  assert.equal(await readFile(file, "utf8"), edited);
});

test("unknown models, paths, nonfinite or out-of-range values and malformed envelopes never modify disk", async t => {
  const { files, body, file } = await fixture(t);
  const initial = await readFile(file, "utf8");
  for (const [key, value] of [["id", "unknown"], ["longitude", 181], ["latitude", -86], ["heightMeters", 0],
    ["headingDegrees", 361], ["elevationMeters", -101], ["exclusionRadiusMeters", 301], ["excludeBuildings", 1],
    ["longitude", Infinity], ["heightMeters", NaN], ["elevationMeters", "0"]]) {
    const input = body(); input.document.placements[0][key] = value;
    await assert.rejects(files.save(input), undefined, key);
  }
  const invalid = [null, [], {}, { ...body(), path: "/tmp/overwrite.json" }, { ...body(), revision: "invalid" },
    { ...body(), document: { version: 2, placements: [] } },
    { ...body(), document: { version: 1, placements: [{ ...document.placements[0], path: "../../outside" }] } },
    { ...body(), document: { version: 1, placements: [document.placements[0], document.placements[0]] } }];
  for (const input of invalid) await assert.rejects(files.save(input));
  assert.equal(await readFile(file, "utf8"), initial);
});

test("production and untrusted requests fail before reading checkout; I/O errors disclose no path", async () => {
  const root = path.join(tmpdir(), "earth-private-missing-checkout");
  const files = createEarthModelProjectFiles({ root });
  const unavailable = await files.handle(request(), "production");
  assert.equal(unavailable.status, 404);
  assert.equal((await unavailable.json()).code, "EARTH_MODELS_UNAVAILABLE");
  assert.equal((await files.handle(request({}, { origin: "https://evil.example" }), "development")).status, 403);
  const failed = await files.handle(request(), "development");
  assert.equal(failed.status, 503);
  const message = await failed.text();
  assert.equal(message.includes(root), false);
  assert.equal(message.includes("ENOENT"), false);
});

test("failed atomic replacement preserves the existing file and removes its temporary sibling", async t => {
  const { files, file, body } = await fixture(t, { renameFile: async () => { throw new Error("simulated rename failure"); } });
  const initial = await readFile(file, "utf8");
  await assert.rejects(files.save(body()), /simulated/);
  assert.equal(await readFile(file, "utf8"), initial);
  assert.deepEqual(await readdir(path.dirname(file)), ["model-placements.json"]);
});

test("symlinks and oversized authored files cannot become arbitrary project file writes", async t => {
  const { files, file, root, body } = await fixture(t);
  const outside = path.join(root, "outside.json"), initial = await readFile(file, "utf8");
  await writeFile(outside, initial);
  await rm(file);
  await symlink(outside, file);
  await assert.rejects(files.read());
  await assert.rejects(files.save(body()));
  assert.equal(await readFile(outside, "utf8"), initial);
  await rm(file);
  await writeFile(file, " ".repeat(EARTH_MODEL_BODY_LIMIT + 1));
  assert.equal((await files.handle(request(), "development")).status, 503);
});

test("request content type and both declared and streamed byte budgets are enforced before disk access", async () => {
  const files = createEarthModelProjectFiles({ root: path.join(tmpdir(), "earth-unread-body-budget") });
  assert.equal((await files.handle(request({}, { "content-length": String(EARTH_MODEL_BODY_LIMIT + 1) }), "development")).status, 413);
  for (const headers of [{ "content-type": "text/plain" }, { "content-type": "application/json-malicious" }, { "content-encoding": "gzip" }])
    assert.equal((await files.handle(request({}, headers), "development")).status, 415);
  let cancelled = false;
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(EARTH_MODEL_BODY_LIMIT + 1)); }, cancel() { cancelled = true; } });
  const response = await files.handle(new Request(baseURL, { method: "POST", duplex: "half", body: stream,
    headers: { host: "localhost:3002", origin: "http://localhost:3002", "content-type": "application/json" } }), "development");
  assert.equal(response.status, 413);
  assert.equal(cancelled, true);
});

test("a slow uploader cannot lock the disk queue; abort releases its request slot", { timeout: 1000 }, async t => {
  const { files, file } = await fixture(t);
  const initial = await readFile(file, "utf8"), upload = stalledUpload();
  t.after(() => upload.abort.abort());
  const pending = files.handle(upload.request, "development");
  assert.equal((await files.handle(request(), "development")).status, 200);
  upload.abort.abort();
  assert.equal((await pending).status, 408);
  assert.equal(await readFile(file, "utf8"), initial);
});

test("upload timeout responds even when cancellation does not settle", { timeout: 1000 }, async () => {
  const files = createEarthModelProjectFiles({ bodyTimeoutMs: 20 });
  let cancelled = false;
  const upload = stalledUpload({ cancel() { cancelled = true; return new Promise(() => {}); } });
  assert.equal((await files.handle(upload.request, "development")).status, 408);
  assert.equal(cancelled, true);
});

test("pending uploads are bounded and aborted upload slots are reusable", async t => {
  const files = createEarthModelProjectFiles({ root: path.join(tmpdir(), "earth-unread-request-budget") });
  const uploads = Array.from({ length: EARTH_MODEL_PENDING_LIMIT }, () => stalledUpload());
  t.after(() => uploads.forEach(upload => upload.abort.abort()));
  const pending = uploads.map(upload => files.handle(upload.request, "development"));
  const busy = await files.handle(request(), "development");
  assert.equal(busy.status, 429);
  assert.equal(busy.headers.get("retry-after"), "1");
  uploads.forEach(upload => upload.abort.abort());
  assert.deepEqual((await Promise.all(pending)).map(response => response.status), Array(EARTH_MODEL_PENDING_LIMIT).fill(408));
  assert.equal((await files.handle(request(), "development")).status, 503);
});
