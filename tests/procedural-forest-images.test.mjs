import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { deflateSync } from "node:zlib";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { readPngFile, assertPngDataUrl, validateImageAsset, imageObjectSize, sceneAssetsWithinLimits, MAX_PNG_BYTES, MAX_ASSET_BYTES, MAX_ASSET_PIXELS, MAX_IMAGE_ASSETS } = await vite.ssrLoadModule("/features/world/dev/procedural-forest/image-assets.ts");
const { initialScene, cloneScene, validateScene, parseScene, serializeScene, createSceneHistory, MAX_SCENE_BYTES } = await vite.ssrLoadModule("/features/world/dev/procedural-forest/editor-scene.ts");
const { initialProps, forestObjects, objectLocalBounds, objectCorners, objectAngle, WORLD_HEIGHT } = await vite.ssrLoadModule("/features/world/dev/procedural-forest/objects.ts");

function crc(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) { value ^= byte; for (let i = 0; i < 8; i++) value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1; }
  return (value ^ 0xffffffff) >>> 0;
}
function chunk(type, payload) {
  const body = Buffer.concat([Buffer.from(type), payload]), result = Buffer.alloc(payload.length + 12);
  result.writeUInt32BE(payload.length, 0); body.copy(result, 4); result.writeUInt32BE(crc(body), result.length - 4); return result;
}
function png(width = 4, height = 2, marker = 0) {
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  const pixels = Buffer.alloc((width * 4 + 1) * height, marker);
  for (let y = 0; y < height; y++) pixels[y * (width * 4 + 1)] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(pixels)), chunk("IEND", Buffer.alloc(0))]);
}
const pngUrl = bytes => "data:image/png;base64," + bytes.toString("base64");
function blocks(bytes) {
  const result = [];
  for (let offset = 8; offset < bytes.length;) {
    const length = bytes.readUInt32BE(offset);
    result.push({ type: bytes.toString("ascii", offset + 4, offset + 8), payload: bytes.subarray(offset + 8, offset + 8 + length) });
    offset += length + 12;
  }
  return result;
}
function assemble(parts) { return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), ...parts.map(({ type, payload }) => chunk(type, payload))]); }
function rasterPng(width, height, depth, color, interlace, raster, palette) {
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4);
  header[8] = depth; header[9] = color; header[12] = interlace;
  return assemble([{ type: "IHDR", payload: header }, ...(palette ? [{ type: "PLTE", payload: palette }] : []),
    { type: "IDAT", payload: deflateSync(raster) }, { type: "IEND", payload: Buffer.alloc(0) }]);
}
const original = png();
const asset = await readPngFile(new File([original], "дом 🌿.png", { type: "image/png" }));
function sceneWithImage() {
  const scene = initialScene(); scene.assets.push(asset);
  scene.planted.push({ id: "planted:picture", kind: "image", assetId: asset.id, ...imageObjectSize(asset), x: 800, y: 700, scale: 1, variant: 0, rotation: 0 });
  return scene;
}

test("PNG imports preserve every source byte and deduplicate independently of the UTF filename", async () => {
  assert.equal(asset.width, 4); assert.equal(asset.height, 2); assert.equal(asset.name, "дом 🌿.png");
  assert.deepEqual(Buffer.from(asset.dataUrl.split(",")[1], "base64"), original);
  const same = await readPngFile(new File([original], "C:\\folder\\другой\u0000дом.png"));
  assert.equal(same.id, asset.id); assert.equal(same.dataUrl, asset.dataUrl); assert.equal(same.name, "другойдом.png");
  const changed = await readPngFile(new File([png(4, 2, 1)], "дом 🌿.png"));
  assert.notEqual(changed.id, asset.id, "different PNG bytes are distinct assets");
  assert.deepEqual(validateImageAsset(asset), asset);
});

test("file guards reject spoofed PNGs, oversized files and invalid IHDR dimensions before native decoding", async () => {
  let read = false;
  await assert.rejects(readPngFile({ size: MAX_PNG_BYTES + 1, arrayBuffer() { read = true; throw new Error("read"); } }), /5/);
  assert.equal(read, false, "an oversized file is not read into memory");
  await assert.rejects(readPngFile(new File(["<svg></svg>"], "fake.png", { type: "image/png" })));
  for (const [offset, value] of [[0, 0], [12, 0], [24, 7], [25, 1], [26, 1], [27, 1], [28, 2]]) {
    const invalid = Buffer.from(original); invalid[offset] = value;
    await assert.rejects(readPngFile(new File([invalid], "broken.png")));
  }
  for (const [width, height] of [[0, 1], [4097, 1], [4096, 4096]]) {
    const invalid = Buffer.from(original); invalid.writeUInt32BE(width, 16); invalid.writeUInt32BE(height, 20);
    await assert.rejects(readPngFile(new File([invalid], "size.png")));
  }
});

test("asset validation rejects alternate MIME/base64, forged identity, unsafe names and metadata mismatches", () => {
  for (const patch of [{ dataUrl: asset.dataUrl.replace("image/png", "image/svg+xml") }, { dataUrl: asset.dataUrl + " " },
    { dataUrl: asset.dataUrl.replace("base64,", "base64,_") }, { id: "png:forged" }, { width: 8 }, { height: NaN },
    { name: "../house.png" }, { name: "house\u0000.png" }, { extra: true }]) {
    assert.equal(validateImageAsset({ ...asset, ...patch }), null);
  }
});

test("complete datastream validation rejects broken zlib headers, checksum, termination and filtered row data even with correct chunk CRCs", async () => {
  const parts = blocks(original), compressed = Buffer.from(parts.find(part => part.type === "IDAT").payload);
  const replace = payload => assemble(parts.map(part => part.type === "IDAT" ? { ...part, payload } : part));
  const badHeader = Buffer.from(compressed); badHeader[0] = 0;
  const dictionary = Buffer.from(compressed); dictionary[1] = 32;
  while (((dictionary[0] << 8) + dictionary[1]) % 31) dictionary[1]++;
  const badAdler = Buffer.from(compressed); badAdler[badAdler.length - 1] ^= 1;
  const raster = Buffer.alloc((4 * 4 + 1) * 2);
  const wrongFilter = Buffer.from(raster); wrongFilter[17] = 5;
  const candidates = [replace(badHeader), replace(dictionary), replace(badAdler), replace(compressed.subarray(0, -2)),
    replace(Buffer.concat([compressed, Buffer.from([1, 2, 3])])), replace(deflateSync(raster.subarray(0, -1))),
    replace(deflateSync(Buffer.concat([raster, Buffer.from([0])]))), replace(deflateSync(wrongFilter))];
  for (const [index, candidate] of candidates.entries()) {
    await assert.rejects(assertPngDataUrl(pngUrl(candidate)), /PNG/, `invalid datastream ${index} cannot bypass strict validation`);
    await assert.rejects(readPngFile(new File([candidate], "broken-idat.png")), /PNG/);
  }
  await assertPngDataUrl(asset.dataUrl);
});

test("chunk boundaries, ordering, CRC and indexed palettes are checked before decompression", async () => {
  const parts = blocks(original), data = parts.find(part => part.type === "IDAT").payload;
  const wrongCrc = Buffer.from(original); wrongCrc[original.length - 1] ^= 1;
  const excessiveLength = Buffer.from(original); excessiveLength.writeUInt32BE(0xffffffff, 33);
  const interrupted = assemble([parts[0], { type: "IDAT", payload: data.subarray(0, 3) }, { type: "tEXt", payload: Buffer.from("x\0y") },
    { type: "IDAT", payload: data.subarray(3) }, parts.at(-1)]);
  for (const candidate of [wrongCrc, excessiveLength, original.subarray(0, -12), Buffer.concat([original, Buffer.from([0])]), interrupted,
    assemble([parts[0], parts[0], ...parts.slice(1)]), assemble([parts[0], { type: "FAIL", payload: Buffer.alloc(0) }, ...parts.slice(1)])]) {
    await assert.rejects(assertPngDataUrl(pngUrl(candidate)), /PNG/);
  }
  const palette = Buffer.from([0, 0, 0, 255, 255, 255]);
  const raster = Buffer.from([0, 0x80, 0, 0x40]);
  const indexed = rasterPng(4, 2, 1, 3, 0, raster, palette);
  await assertPngDataUrl(pngUrl(indexed));
  await assert.rejects(assertPngDataUrl(pngUrl(rasterPng(4, 2, 1, 3, 0, raster))), /PNG/);
  await assert.rejects(assertPngDataUrl(pngUrl(rasterPng(4, 2, 1, 3, 0, raster, Buffer.concat([palette, Buffer.from([1, 2, 3])])))), /PNG/);
  const split = assemble([parts[0], ...[...data].map(value => ({ type: "IDAT", payload: Buffer.from([value]) })), parts.at(-1)]);
  await assertPngDataUrl(pngUrl(split), "the zlib header may span legal adjacent IDAT chunks");
});

test("all legal bit depths and Adam7 passes accept correctly sized filtered scanlines", async () => {
  for (const [color, depths, channels] of [[0, [1, 2, 4, 8, 16], 1], [2, [8, 16], 3], [3, [1, 2, 4, 8], 1], [4, [8, 16], 2], [6, [8, 16], 4]]) {
    for (const depth of depths) {
      const rowBytes = Math.ceil(7 * channels * depth / 8) + 1, raster = Buffer.alloc(rowBytes * 3);
      raster[0] = 0; raster[rowBytes] = 2; raster[rowBytes * 2] = 4;
      await assertPngDataUrl(pngUrl(rasterPng(7, 3, depth, color, 0, raster, color === 3 ? Buffer.from([0, 0, 0]) : undefined)));
    }
  }
  const passes = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]];
  for (const [width, height] of [[1, 1], [7, 5], [16, 16]]) {
    const raster = Buffer.concat(passes.flatMap(([x, y, dx, dy]) => {
      const columns = Math.max(0, Math.ceil((width - x) / dx)), rows = Math.max(0, Math.ceil((height - y) / dy));
      return columns && rows ? [Buffer.alloc((1 + columns * 4) * rows)] : [];
    }));
    const interlaced = rasterPng(width, height, 8, 6, 1, raster);
    await assertPngDataUrl(pngUrl(interlaced));
    await assert.rejects(assertPngDataUrl(pngUrl(rasterPng(width, height, 8, 6, 1, raster.subarray(0, -1)))), /PNG/);
  }
});

test("the real full-quality indexed house PNG passes streaming validation without changing its bytes", async () => {
  const bytes = await readFile(new URL("../public/world/prototype/home-level-1.png", import.meta.url));
  const imported = await readPngFile(new File([bytes], "home-level-1.png", { type: "image/png" }));
  assert.deepEqual(Buffer.from(imported.dataUrl.split(",")[1], "base64"), bytes);
  assert.equal(imported.width, 1254); assert.equal(imported.height, 1254);
  await assertPngDataUrl(imported.dataUrl);
});

test("world image dimensions and corner transforms retain native aspect and bottom-center anchors", () => {
  assert.deepEqual(imageObjectSize(asset), { imageWidth: 320, imageHeight: 160 });
  assert.deepEqual(imageObjectSize({ width: 100, height: 400 }), { imageWidth: 80, imageHeight: 320 });
  const object = sceneWithImage().planted[0];
  assert.deepEqual(objectLocalBounds(object), { x: -160, y: -160, width: 320, height: 160 });
  assert.deepEqual(objectCorners(object), [{ x: 640, y: 540 }, { x: 960, y: 540 }, { x: 960, y: 700 }, { x: 640, y: 700 }]);
  const rotated = { ...object, rotation: 90, scale: 2 };
  assert.equal(objectAngle(rotated), Math.PI / 2);
  const corners = objectCorners(rotated);
  assert.ok(Math.abs(corners[0].x - 1120) < 1e-9 && Math.abs(corners[0].y - 380) < 1e-9);
  assert.ok(Math.abs(corners[2].x - 800) < 1e-9 && Math.abs(corners[2].y - 1020) < 1e-9);
});

test("v2 JSON is portable with exact embedded PNG bytes and validates image references, shape and scales", () => {
  const source = sceneWithImage();
  assert.equal(source.version, 2); assert.equal(MAX_SCENE_BYTES, 24 * 1024 * 1024);
  const restored = parseScene(serializeScene(source));
  assert.deepEqual(restored, source); assert.equal(restored.assets[0].dataUrl, asset.dataUrl);
  assert.deepEqual(Buffer.from(restored.assets[0].dataUrl.split(",")[1], "base64"), original);
  for (const patch of [{ assetId: "png:missing" }, { assetId: undefined }, { imageWidth: undefined }, { imageHeight: 0 },
    { imageWidth: 200 }, { imageHeight: Infinity }, { scale: .099 }, { scale: 8.001 }, { kind: "stump-house" }]) {
    assert.equal(validateScene({ ...source, planted: [{ ...source.planted[0], ...patch }] }), null);
  }
  assert.equal(validateScene({ ...source, assets: [asset, asset] }), null);
  assert.equal(validateScene({ ...source, assets: [] }), null);
  assert.equal(validateScene({ ...source, assets: Array(MAX_IMAGE_ASSETS + 1).fill(asset) }), null);
  assert.equal(validateScene({ ...source, planted: [{ ...source.planted[0], kind: "rock" }] }), null, "procedural kinds cannot carry image fields");
  for (const scale of [.1, 8]) assert.ok(validateScene({ ...source, planted: [{ ...source.planted[0], scale }] }));
  assert.deepEqual(source, sceneWithImage(), "rejected imports leave caller records unchanged");
});

test("legacy scenes discard only retired stump houses and their own edits", () => {
  const initial = initialScene();
  const tree = forestObjects(initial.seed, { x: 0, y: 0, width: initial.width, height: WORLD_HEIGHT }).find(object => object.x > 0 && object.x < 1600 && object.y > 0 && object.y < 1600);
  const house = { id: "planted:house", kind: "stump-house", x: 500, y: 500, scale: 1, variant: 0, rotation: 0 };
  const rock = { id: "planted:house-looking-id", kind: "rock", x: 700, y: 600, scale: 1, variant: 1, rotation: 0 };
  const legacy = { version: 1, seed: initial.seed, width: initial.width,
    planted: [house, { ...house, id: "planted:removed-house" }, rock],
    removed: ["planted:removed-house", "prop:jetty"], modified: [{ ...house, x: 600 }, { ...tree, x: 800, y: 600, rotation: 20 }] };
  const migrated = parseScene(JSON.stringify(legacy));
  assert.deepEqual(migrated, { version: 2, seed: legacy.seed, width: legacy.width, assets: [],
    planted: [rock], removed: ["prop:jetty"], modified: [legacy.modified[1]] });
  assert.equal(legacy.planted.length, 3, "migration leaves the source unchanged");
  assert.equal(validateScene({ ...legacy, planted: [{ ...rock, kind: "unknown" }] }), null);
  assert.equal(validateScene({ ...legacy, planted: [{ ...house, unexpected: true }] }), null, "migration does not hide malformed legacy records");
  assert.deepEqual(parseScene(JSON.stringify({ version: 1, seed: initial.seed, width: 1600, planted: [], removed: [], modified: [] })), initial);
  assert.equal(validateScene({ ...initial, planted: [house] }), null, "the retired kind is rejected in new scenes");
  assert.deepEqual(initialProps().map(object => object.kind), ["ruins", "jetty", "bridge"]);
});

test("asset budgets count original bytes and pixels rather than compressed display dimensions", () => {
  const sized = (id, bytes, width = 4, height = 2) => ({ ...asset, id, width, height,
    dataUrl: "data:image/png;base64," + "A".repeat(Math.ceil(bytes / 3) * 4 - (bytes % 3 ? 3 - bytes % 3 : 0)) + "=".repeat(bytes % 3 ? 3 - bytes % 3 : 0) });
  assert.equal(sceneAssetsWithinLimits([asset]), true);
  assert.equal(sceneAssetsWithinLimits([asset, asset]), false);
  assert.equal(sceneAssetsWithinLimits(Array.from({ length: 5 }, (_, i) => sized(`large:${i}`, MAX_PNG_BYTES))), false);
  assert.equal(sceneAssetsWithinLimits([sized("pixels:1", 100, 4000, 4000), sized("pixels:2", 100, 4000, 4000)]), true);
  assert.equal(sceneAssetsWithinLimits([sized("pixels:1", 100, 4000, 4000), sized("pixels:2", 100, 4000, 4000), sized("pixels:3", 100)]), false);
  assert.equal(MAX_ASSET_BYTES, 16 * 1024 * 1024); assert.equal(MAX_ASSET_PIXELS, 32_000_000);
});

test("undo snapshots clone asset records and compare large embedded strings without JSON serialization", () => {
  const source = sceneWithImage(), history = createSceneHistory(source);
  const copied = cloneScene(source); assert.notEqual(copied.assets[0], source.assets[0]); assert.equal(copied.assets[0].dataUrl, source.assets[0].dataUrl);
  const stringify = JSON.stringify;
  try { JSON.stringify = () => { throw new Error("history must not serialize PNG strings"); }; assert.equal(history.commit(copied), false); }
  finally { JSON.stringify = stringify; }
  const moved = history.getScene(); moved.planted[0].x += 40; moved.assets[0].name = "переименован.png";
  assert.equal(history.commit(moved), true); assert.deepEqual(history.undo(), source); assert.deepEqual(history.redo(), moved);
  const returned = history.getScene(); returned.assets[0].name = "corrupted.png"; returned.assets[0].dataUrl = "broken";
  assert.equal(history.getScene().assets[0].name, "переименован.png"); assert.equal(history.getScene().assets[0].dataUrl, asset.dataUrl);
});
