import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(() => vite.close());
const { forestObjectArtwork, harmonizeForestPixels, forestSiteMaterial } = await vite.ssrLoadModule("/features/world/forest-object-appearance.ts");
const { siteGroundMarks, drawBuildingGroundDetails } = await vite.ssrLoadModule("/features/world/building-ground-details.ts");
const { siteImagePoint, drawSiteImage } = await vite.ssrLoadModule("/features/world/tiled/site-image.ts");

function withDocument(document, action) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
  if (document) globalThis.document = document; else delete globalThis.document;
  try { action(); }
  finally { if (previous) Object.defineProperty(globalThis, "document", previous); else delete globalThis.document; }
}

test("material grading preserves every alpha value and invisible RGB without crushing detail", () => {
  const pixels = new Uint8ClampedArray([255, 3, 211, 0, 0, 0, 0, 16, 70, 70, 70, 255,
    230, 180, 120, 128, 255, 255, 255, 255, 34, 119, 65, 240]);
  for (const material of ["wood", "stone", "bark", "foliage"]) {
    const treated = pixels.slice(); harmonizeForestPixels(treated, material);
    assert.deepEqual(treated.slice(0, 4), pixels.slice(0, 4), "invisible RGB must not grow a colored fringe");
    for (let i = 0; i < pixels.length; i++) {
      if (i % 4 === 3) assert.equal(treated[i], pixels[i], "holes and soft translucent edges survive");
      else assert.ok(Math.abs(treated[i] - pixels[i]) < 20, "palette correction stays restrained");
    }
    assert.ok(treated[9] >= treated[8] && treated[9] > treated[10], "neutral shadows pick up green reflected light within integer rounding");
    assert.ok(treated[16] > 240 && treated[17] > 240 && treated[18] > 240, "white remains a highlight");
  }
});

test("each current building uses its material profile, including unknown future woodwork", () => {
  assert.equal(forestSiteMaterial({ id: "home" }), "bark");
  for (const id of ["quarry", "lighthouse"]) assert.equal(forestSiteMaterial({ id }), "stone");
  for (const id of ["bridge", "workshop", "warehouse"]) assert.equal(forestSiteMaterial({ id }), "wood");
});

test("grading is cached across cameras, limits texture size and never mutates the source", () => {
  let allocations = 0, reads = 0, writes = 0;
  const source = { naturalWidth: 4096, naturalHeight: 2048, pixels: new Uint8ClampedArray([70, 70, 70, 180]) };
  const original = source.pixels.slice();
  withDocument({ createElement(tag) {
    assert.equal(tag, "canvas"); allocations++;
    const canvas = { width: 0, height: 0 };
    canvas.getContext = () => ({ drawImage(image, x, y, width, height) { assert.equal(image, source); assert.equal(width, canvas.width); assert.equal(height, canvas.height); },
      getImageData() { reads++; return { data: source.pixels.slice() }; },
      putImageData(pixels) { writes++; canvas.pixels = pixels.data; } });
    return canvas;
  } }, () => {
    const treated = forestObjectArtwork(source, "wood");
    assert.equal(treated.width, 1024); assert.equal(treated.height, 512);
    for (let i = 0; i < 50; i++) assert.equal(forestObjectArtwork(source, "wood"), treated);
    assert.equal(allocations, 1); assert.equal(reads, 1); assert.equal(writes, 1);
    assert.equal(treated.pixels[3], original[3]);
    assert.deepEqual(source.pixels, original);
    assert.notEqual(forestObjectArtwork(source, "stone"), treated, "a distinct material may have a distinct cached treatment");
  });
});

test("unavailable or unreadable canvas preserves the original and is not retried each frame", () => {
  withDocument(undefined, () => {
    const image = { naturalWidth: 100, naturalHeight: 100 };
    assert.equal(forestObjectArtwork(image, "stone"), image);
  });
  for (const failure of ["null", "tainted", "unsupported"]) {
    let attempts = 0;
    withDocument({ createElement() {
      attempts++;
      if (failure === "unsupported") throw new Error("no canvas");
      return { getContext() { return failure === "null" ? null : {
        drawImage() {}, getImageData() { throw new Error("SecurityError"); },
      }; } };
    } }, () => {
      const image = { naturalWidth: 100, naturalHeight: 100 };
      for (let i = 0; i < 10; i++) assert.equal(forestObjectArtwork(image, "stone"), image);
      assert.equal(attempts, 1);
    });
  }
});

function siteFixture(id = "home") {
  return { id, bounds: { x: 0, y: 0, width: 120, height: 120 }, anchor: { x: 60, y: 100 }, entry: { x: 60, y: 99 },
    collision: [{ x: 5, y: 70 }, { x: 115, y: 70 }, { x: 115, y: 110 }, { x: 5, y: 110 }], hitArea: [], states: [], initialLevel: 0 };
}
const samples = Array.from({ length: 21 }, (_, i) => ({ u: (i + 2) / 24, v: .82 }));

test("ground joins stay at actual artwork feet, avoid the entrance and respect water", () => {
  const site = siteFixture(), marks = siteGroundMarks({}, site, samples);
  assert.ok(marks.length > 3);
  assert.ok(marks.every(mark => mark.kind === "grass" && mark.y === .82 * 120));
  assert.ok(marks.every(mark => Math.hypot(mark.x - site.entry.x, mark.y - site.entry.y) >= 8));
  assert.deepEqual(siteGroundMarks({}, site, [{ u: .5, v: .2 }]), [], "roof is never treated as a foundation");
  const water = { surfaces: [{ points: [{ x: 0, y: 0 }, { x: 120, y: 0 }, { x: 120, y: 120 }, { x: 0, y: 120 }] }], exclusions: [] };
  assert.deepEqual(siteGroundMarks({ water }, site, samples), []);
  water.exclusions.push(water.surfaces[0]);
  assert.deepEqual(siteGroundMarks({ water }, site, samples), marks, "authored dry islands can carry details");
});

test("quarry uses stone fragments and workshop uses chips; broken bridge never gets a land patch", () => {
  assert.ok(siteGroundMarks({}, siteFixture("quarry"), samples).some(mark => mark.kind === "stone"));
  assert.ok(siteGroundMarks({}, siteFixture("workshop"), samples).some(mark => mark.kind === "chip"));
  const bridge = { ...siteFixture("bridge"), imagePlacement: { x: 20, y: 30, width: 120, height: 60, rotation: 346.507 } };
  assert.deepEqual(siteGroundMarks({}, bridge, samples), []);
  withDocument({ createElement() { assert.fail("bridge must not allocate soil textures"); } }, () => {
    drawBuildingGroundDetails({ drawImage() { assert.fail("bridge must not cover the river"); } }, {}, bridge, {});
  });
});

test("normalized contacts and artwork share the authored rotation without changing world markers", () => {
  const site = { ...siteFixture(), imagePlacement: { x: 30, y: 40, width: 120, height: 60, rotation: 450 } };
  const original = structuredClone(site), calls = [];
  drawSiteImage({ save() {}, restore() {}, translate(...args) { calls.push(args); }, rotate(angle) { calls.push(angle); }, drawImage(...args) { calls.push(args); } }, site, {});
  assert.deepEqual(calls[0], [30, 40]); assert.equal(calls[1], Math.PI / 2);
  const point = siteImagePoint(site, .25, .75);
  assert.ok(Math.abs(point.x - -15) < 1e-9); assert.ok(Math.abs(point.y - 70) < 1e-9);
  assert.deepEqual(site, original);
});
