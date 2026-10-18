import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, server: { middlewareMode: true, hmr: false, ws: false } });
const { getEarthErrorResourceUrls } = await vite.ssrLoadModule("/features/earth/resource-recovery.ts");
after(() => vite.close());
const base = "https://tiles.openfreemap.org";
const map = (options = {}) => ({ getSource: () => undefined, getPixelRatio: () => 2, getStyle: () => ({}), ...options });

test("nested protobuf parse errors identify the actual encoded parent URL before a displayed child", () => {
  const url = `${base}/planet/20261018/14/9901/5132.pbf?token=a,b&value=two words`;
  const result = getEarthErrorResourceUrls({
    error: new Error(`Unable to parse the tile at earth-cache://resource?url=${encodeURIComponent(url)}, got error: invalid nested protobuf`),
    sourceId: "openmaptiles", tile: { tileID: { canonical: { url() { throw new Error("Parent diagnostic takes priority"); } } } },
  }, map());
  assert.deepEqual(result, [new URL(url).href]);
});

test("renderer errors repair only the exact canonical tile and preserve source scheme/pixel ratio", () => {
  const url = `${base}/natural_earth/ne2sr/2/1/3.png`;
  const templates = [`${base}/natural_earth/ne2sr/{z}/{x}/{y}.png`];
  const canonical = { url(tiles, ratio, scheme) {
    assert.equal(this, canonical); assert.deepEqual(tiles, templates); assert.equal(ratio, 2); assert.equal(scheme, "tms");
    return url;
  } };
  assert.deepEqual(getEarthErrorResourceUrls({ error: new Error("The source image could not be decoded"), sourceId: "ne2_shaded", tile: { tileID: { canonical } } },
    map({ getSource: id => { assert.equal(id, "ne2_shaded"); return { tiles: templates, scheme: "tms" }; } })), [url]);
});

test("source metadata failures repair its TileJSON without deleting unrelated map data", () => {
  assert.deepEqual(getEarthErrorResourceUrls({ error: new Error("Invalid source metadata"), sourceId: "openmaptiles" },
    map({ getSource: () => ({ url: `${base}/planet` }) })), [`${base}/planet`]);
  assert.deepEqual(getEarthErrorResourceUrls({ error: new Error("Invalid tile"), sourceId: "openmaptiles", tile: {} },
    map({ getSource: () => ({ url: `${base}/planet` }) })), []);
});

test("sprite decode failures target exactly the active retina PNG and JSON pair", () => {
  assert.deepEqual(getEarthErrorResourceUrls({ error: new Error("The source image could not be decoded") },
    map({ getStyle: () => ({ sprite: `${base}/sprites/ofm_123/ofm?v=1` }) })), [
    `${base}/sprites/ofm_123/ofm@2x.png?v=1`, `${base}/sprites/ofm_123/ofm@2x.json?v=1`,
  ]);
  assert.deepEqual(getEarthErrorResourceUrls({ error: new Error("Sprite image failed") }, map({ getPixelRatio: () => 1,
    getStyle: () => ({ sprite: [{ id: "default", url: `${base}/sprites/ofm` }, { id: "duplicate", url: `${base}/sprites/ofm` }] }) })), [
    `${base}/sprites/ofm.png`, `${base}/sprites/ofm.json`,
  ]);
});

test("HTTP errors carrying a resource URL and duplicate encoded diagnostics are deduplicated", () => {
  const url = `${base}/planet`;
  assert.deepEqual(getEarthErrorResourceUrls({ error: { message: `earth-cache://resource?url=${encodeURIComponent(url)} earth-cache://resource?url=${encodeURIComponent(url)}`, url } }, map()), [url]);
});

test("unknown graphics errors, malformed resources and removed maps do not evict unrelated files", () => {
  const context = map({ getStyle: () => ({ sprite: `${base}/sprites/ofm` }) });
  for (const error of [new Error("WebGL context lost"), new Error("Unable to allocate GPU buffer"), null, new Error("earth-cache://resource?url=%ZZ")]) {
    assert.deepEqual(getEarthErrorResourceUrls({ error }, context), []);
  }
  assert.deepEqual(getEarthErrorResourceUrls({ error: new Error("Image decode failed") }, map({ getStyle: () => { throw new Error("Map removed"); } })), []);
  const credentialUrl = new URL(`${base}/file`);
  credentialUrl.username = "fixture"; credentialUrl.password = credentialUrl.username;
  assert.deepEqual(getEarthErrorResourceUrls({ error: { url: credentialUrl.href } }, context), []);
});
