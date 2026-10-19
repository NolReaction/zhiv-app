import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";
import sharp from "sharp";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } },
  server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { decodeEarthModel, validateEarthModelAssets, createEarthModelLoader } = await vite.ssrLoadModule("/features/earth/landmark-model.ts");
const digest = bytes => createHash("sha256").update(new Uint8Array(bytes)).digest("hex");
const flush = async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)); };
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const kinds = ["baseColor", "normal", "metallicRoughness"];

async function modelFixture(id = "christ-redeemer") {
  const image = await sharp({ create: { width: 2, height: 2, channels: 3, background: "#c5d7e8" } }).webp({ lossless: true }).toBuffer();
  const textures = kinds.map(kind => ({ kind, bytes: image.byteLength, width: 2, height: 2, wrapS: 10497, wrapT: 33071 }));
  const buffer = new ArrayBuffer(88 + 3 * 44 + 3 * 4 + 3 * image.byteLength), header = new DataView(buffer);
  header.setUint32(0, 0x324d4c45, true); header.setUint32(4, 2, true); header.setUint32(8, 3, true); header.setUint32(12, 3, true);
  for (const [i, texture] of textures.entries()) {
    for (const [component, value] of [texture.bytes, texture.width, texture.height, texture.wrapS, texture.wrapT].entries())
      header.setUint32(16 + i * 20 + component * 4, value, true);
  }
  header.setFloat32(76, .2, true); header.setFloat32(80, .7, true); header.setFloat32(84, 1, true);
  new Float32Array(buffer, 88, 33).set([-.2, -.2, 0, 1, 1, 1, 0, -1, 0, 0, 0,
    .2, -.2, 0, 1, 1, 1, 0, -1, 0, 1, 0, 0, .2, 1, 1, 1, 1, 0, -1, 0, .5, 1]);
  new Uint32Array(buffer, 220, 3).set([0, 1, 2]);
  for (let i = 0; i < 3; i++) new Uint8Array(buffer, 232 + i * image.byteLength, image.byteLength).set(image);
  const asset = lod => ({ format: 2, url: `/earth/models/${id}/${lod}.elm`, bytes: buffer.byteLength,
    sha256: digest(buffer), vertexCount: 3, indexCount: 3, textures });
  return { buffer, assets: { version: 1, overview: asset("overview"), detail: asset("detail") } };
}

function loaderFixture(fixture, decodeTexture) {
  let requests = 0;
  const images = [], timers = new Map(); let timer = 0;
  const loader = createEarthModelLoader(fixture.assets, () => {}, {
    fetch: async () => { requests++; return new Response(fixture.buffer.slice(0)); }, sha256: async bytes => digest(bytes),
    decodeTexture: decodeTexture ?? (async texture => { const image = { width: texture.width, height: texture.height, closed: 0,
      close() { this.closed++; } }; images.push(image); return image; }),
    schedule(callback) { const id = ++timer; timers.set(id, callback); return id; }, cancel(id) { timers.delete(id); },
  });
  return { loader, images, timers, get requests() { return requests; } };
}

test("textured ELM2 preserves shared geometry views, linear colors, normals, UVs and exact image slices", async () => {
  const { buffer, assets } = await modelFixture();
  assert.equal(validateEarthModelAssets(assets), assets);
  const model = decodeEarthModel(buffer, assets.detail);
  assert.equal(model.vertexStride, 11); assert.equal(model.vertices.length, 33);
  assert.equal(model.vertices.buffer, buffer); assert.equal(model.indices.buffer, buffer);
  assert.deepEqual(model.encodedMaterial.textures.map(texture => texture.kind), kinds);
  for (const texture of model.encodedMaterial.textures) {
    assert.equal(texture.bytes.buffer, buffer);
    const metadata = await sharp(texture.bytes).metadata(); assert.equal(metadata.width, 2); assert.equal(metadata.height, 2);
  }
});

test("every registered ID is accepted only with matching local overview/detail paths", async () => {
  for (const id of ["eiffel-tower", "christ-redeemer", "colosseum", "giza-pyramids", "great-wall-badaling", "saint-basils", "statue-of-liberty", "sydney-opera", "taj-mahal"])
    assert.ok(validateEarthModelAssets((await modelFixture(id)).assets));
  const { assets } = await modelFixture();
  for (const url of ["/earth/models/unknown/overview.elm", "/earth/models/christ-redeemer/../overview.elm", "/earth/models/christ-redeemer/detail.elm",
    "https://example.invalid/overview.elm", "/earth/models/christ-redeemer/overview.elm?anything"])
    assert.throws(() => validateEarthModelAssets({ ...assets, overview: { ...assets.overview, url } }));
  assert.throws(() => validateEarthModelAssets({ ...assets, detail: { ...assets.detail, url: "/earth/models/colosseum/detail.elm" } }));
});

test("ELM2 rejects hostile sizes, texture slots, material factors, UVs and invalid normals before image allocation", async () => {
  const { buffer, assets } = await modelFixture();
  for (const mutation of [
    value => new DataView(value).setUint32(4, 1, true),
    value => new DataView(value).setUint32(20, 8192, true),
    value => new DataView(value).setUint32(28, 1234, true),
    value => new DataView(value).setFloat32(76, NaN, true),
    value => new DataView(value).setFloat32(80, 1.5, true),
    value => new DataView(value).setFloat32(84, -1, true),
    value => new Float32Array(value, 88, 33)[6] = 2,
    value => new Float32Array(value, 88, 33)[9] = 100,
    value => new Float32Array(value, 88, 33)[10] = Infinity,
    value => new DataView(value).setUint32(232, 0, true),
    value => new DataView(value).setUint32(236, 0, true),
  ]) { const corrupt = buffer.slice(0); mutation(corrupt); assert.throws(() => decodeEarthModel(corrupt, assets.overview)); }
  for (const patch of [{ kind: "unknown" }, { width: 4096 }, { height: 0 }, { bytes: -1 }, { wrapT: 1 }])
    assert.throws(() => validateEarthModelAssets({ ...assets, detail: { ...assets.detail, textures: [{ ...assets.detail.textures[0], ...patch }, ...assets.detail.textures.slice(1)] } }));
  assert.throws(() => validateEarthModelAssets({ ...assets, detail: { ...assets.detail, textures: [...assets.detail.textures].reverse() } }));
});

test("texture loader waits for all images, accounts decoded memory, and closes every bitmap exactly once on release", async () => {
  const fixture = await modelFixture(), f = loaderFixture(fixture);
  f.loader.request("detail"); await flush();
  const model = f.loader.get("detail"); assert.ok(model?.textureMaterial); assert.equal(model.encodedMaterial, undefined);
  assert.equal(model.bytes, fixture.buffer.byteLength + 3 * 2 * 2 * 4);
  assert.equal(f.loader.getSnapshot().bytes, model.bytes); assert.equal(f.images.length, 3);
  f.loader.release("detail"); assert.equal(f.loader.get("detail"), null); assert.equal(f.loader.getSnapshot().bytes, 0);
  assert.deepEqual(f.images.map(image => image.closed), [1, 1, 1]); assert.equal(f.requests, 1, "eviction does not start a background request");
  f.loader.dispose(); assert.deepEqual(f.images.map(image => image.closed), [1, 1, 1]);
});

test("the actual WebP frame cannot allocate more pixels than the pinned manifest before browser decoding", async () => {
  const { buffer, assets } = await modelFixture(), corrupt = buffer.slice(0), bytes = new Uint8Array(corrupt), view = new DataView(corrupt);
  let chunk = 232 + 12, changed = false;
  while (chunk < 232 + assets.detail.textures[0].bytes) {
    const kind = view.getUint32(chunk, false), size = view.getUint32(chunk + 4, true);
    if (kind === 0x5650384c) { view.setUint32(chunk + 9, 0x0fffffff, true); changed = true; break; }
    if (kind === 0x56503820) { view.setUint16(chunk + 14, 16383, true); changed = true; break; }
    chunk += 8 + size + size % 2;
  }
  assert.equal(changed, true); assert.ok(bytes.byteLength < 4096);
  assert.throws(() => decodeEarthModel(corrupt, assets.detail), "oversized frame must be rejected before createImageBitmap");
});

test("hiding during image decoding closes partial and late bitmaps without publishing stale GPU-ready data", async () => {
  const fixture = await modelFixture(), delayed = deferred(), images = [];
  const f = loaderFixture(fixture, async texture => {
    const image = { width: texture.width, height: texture.height, closed: 0, close() { this.closed++; } }; images.push(image);
    return images.length === 2 ? delayed.promise : image;
  });
  f.loader.request("detail"); await flush(); assert.equal(images.length, 2); assert.equal(f.loader.get("detail"), null);
  f.loader.request(null); assert.equal(images[0].closed, 1);
  delayed.resolve(images[1]); await flush(); assert.equal(images[1].closed, 1); assert.equal(f.loader.get("detail"), null);
  assert.equal(f.timers.size, 0); f.loader.dispose();
});

test("wrong decoded dimensions and a rejected normal map free partial texture resources", async () => {
  for (const failure of ["dimensions", "decode"]) {
    const fixture = await modelFixture(), images = [];
    const f = loaderFixture(fixture, async texture => {
      if (failure === "decode" && images.length === 1) throw new Error("invalid image");
      const image = { width: failure === "dimensions" ? 4096 : texture.width, height: texture.height,
        closed: 0, close() { this.closed++; } }; images.push(image); return image;
    });
    f.loader.request("detail"); await flush(); assert.equal(f.loader.getSnapshot().detail, "error");
    assert.equal(f.loader.get("detail"), null); assert.ok(images.every(image => image.closed === 1));
    assert.equal(f.timers.size, 0); f.loader.dispose();
  }
});

test("a shared queue grant after hide releases its permit and never starts a stale fetch", async () => {
  const fixture = await modelFixture(), slot = deferred(); let fetches = 0, releases = 0;
  const loader = createEarthModelLoader(fixture.assets, () => {}, { acquire: () => slot.promise,
    fetch: async () => { fetches++; return new Response(fixture.buffer); }, sha256: null, schedule: () => 1, cancel() {} });
  loader.request("detail"); loader.request(null); slot.resolve(() => { releases++; }); await flush();
  assert.equal(fetches, 0); assert.equal(releases, 1); assert.equal(loader.get("detail"), null); loader.dispose();
});

test("hidden non-abortable image decodes retain the shared two-phase limit until late bitmaps settle", async () => {
  const { createEarthLandmarkMeshLayer } = await vite.ssrLoadModule("/features/earth/landmark-mesh-layer.ts");
  const ids = ["christ-redeemer", "colosseum", "giza-pyramids", "taj-mahal"];
  const fixtures = await Promise.all(ids.map(id => modelFixture(id)));
  const definitions = fixtures.map((fixture, index) => ({ id: ids[index], assets: fixture.assets, heightMeters: 40 }));
  const pending = [], images = []; let active = 0, maximumActive = 0, fetches = 0, bufferBytes = 0, deadlines = 0;
  const container = { dataset: {} }, map = { getZoom: () => 1, getContainer: () => container, triggerRepaint() {} };
  const gl = { ARRAY_BUFFER: 1, STATIC_DRAW: 2, BUFFER_SIZE: 3, FLOAT: 4,
    createBuffer: () => ({}), createVertexArray: () => ({}), bindBuffer() {}, bindVertexArray() {},
    bufferData(_target, bytes) { bufferBytes = bytes.byteLength; }, getBufferParameter: () => bufferBytes,
    enableVertexAttribArray() {}, vertexAttribPointer() {}, deleteBuffer() {}, deleteVertexArray() {}, deleteProgram() {} };
  const models = createEarthLandmarkMeshLayer(map, { definitions, environment: {
    fetch: async () => { fetches++; return new Response(fixtures[0].buffer.slice(0)); }, sha256: null,
    schedule: () => ++deadlines, cancel() {}, decodeTexture(texture) {
      const delayed = deferred(), image = { width: texture.width, height: texture.height, closed: 0, close() { this.closed++; } };
      active++; maximumActive = Math.max(maximumActive, active); images.push(image);
      const work = { settled: false, settle() { assert.equal(this.settled, false); this.settled = true; active--; delayed.resolve(image); } };
      pending.push(work); return delayed.promise;
    },
  } });
  try {
    models.layer.onAdd(map, gl); models.setVisible(true, new Set(ids)); await flush();
    assert.equal(fetches, 2); assert.equal(active, 2); assert.equal(deadlines, 2, "queued models do not consume a transfer deadline");
    models.setVisible(false, new Set()); models.setVisible(true, new Set(ids)); await flush();
    assert.equal(fetches, 2, "cancelled createImageBitmap calls still own both permits until their promises settle");
    assert.equal(active, 2); assert.equal(pending.length, 2); assert.equal(deadlines, 2);
    for (const work of pending.slice()) work.settle(); await flush();
    assert.equal(fetches, 4, "only the new visible pair starts when the retired image phases release permits");
    assert.deepEqual(images.slice(0, 2).map(image => image.closed), [1, 1], "late retired bitmaps are closed exactly once");
    for (let round = 0; round < 12 && pending.some(work => !work.settled); round++) {
      for (const work of pending.filter(work => !work.settled)) work.settle();
      await flush();
    }
    assert.equal(maximumActive, 2); assert.equal(active, 0); assert.equal(fetches, 6);
    for (const id of ids) assert.equal(models.getModelSnapshot().models[id].overview, "ready");
  } finally {
    models.dispose();
    for (const work of pending.filter(work => !work.settled)) work.settle();
    await flush();
  }
  assert.ok(images.every(image => image.closed === 1), "retired and cached bitmaps have a single owner through disposal");
});

test("all shipped textured LODs have valid geometry, texture headers and pinned preparation hashes", async () => {
  for (const id of ["christ-redeemer", "colosseum", "giza-pyramids", "great-wall-badaling", "saint-basils", "statue-of-liberty", "sydney-opera", "taj-mahal"]) {
    const manifest = validateEarthModelAssets(JSON.parse(await readFile(new URL(`../features/earth/data/${id}-model.json`, import.meta.url), "utf8")));
    for (const lod of ["overview", "detail"]) {
      const bytes = await readFile(new URL(`../public${manifest[lod].url}`, import.meta.url));
      const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      assert.equal(digest(buffer), manifest[lod].sha256); const decoded = decodeEarthModel(buffer, manifest[lod]);
      assert.equal(decoded.vertexStride, 11); assert.equal(decoded.encodedMaterial.textures.length, 3);
      for (const texture of decoded.encodedMaterial.textures) {
        const metadata = await sharp(texture.bytes).metadata();
        assert.equal(metadata.width, texture.width); assert.equal(metadata.height, texture.height);
      }
    }
  }
});
