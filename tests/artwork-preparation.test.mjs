import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } },
  server: { middlewareMode: true, hmr: false, ws: false }, optimizeDeps: { noDiscovery: true, include: [] } });
after(() => vite.close());
const { forestObjectArtwork, harmonizeForestPixels, prepareForestObjectArtwork } = await vite.ssrLoadModule("/features/world/scene/forest-object-appearance.ts");
const { createArtworkPreparation } = await vite.ssrLoadModule("/features/world/scene/artwork-preparation.ts");

function browser(action) {
  const old = new Map(["window", "document"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const calls = { allocations: 0, reads: 0, writes: 0, draws: [] }, idle = new Map(); let serial = 0;
  globalThis.window = { requestIdleCallback(callback) { idle.set(++serial, callback); return serial; }, cancelIdleCallback(id) { idle.delete(id); } };
  globalThis.document = { createElement() {
    calls.allocations++;
    const canvas = { width: 0, height: 0 }; let image;
    const context = { drawImage(source, x, y, width, height) {
      image = source; calls.draws.push({ source, width, height, quality: this.imageSmoothingQuality });
    }, getImageData() {
      calls.reads++;
      if (image.unreadable) throw new Error("tainted");
      return { data: image.pixels?.slice() ?? new Uint8ClampedArray(canvas.width * canvas.height * 4) };
    }, putImageData(pixels) { calls.writes++; canvas.pixels = pixels.data.slice(); } };
    canvas.getContext = () => context; return canvas;
  } };
  const fire = (remaining = 10) => {
    const [id, callback] = idle.entries().next().value ?? [];
    assert.ok(callback, "idle work was scheduled"); idle.delete(id); callback({ timeRemaining: () => remaining });
  };
  try { action({ calls, idle, fire }); }
  finally { for (const [key, descriptor] of old) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; } }
}
function complete(job) {
  let slices = 0;
  while (!job.step()) assert.ok(++slices < 100, "bounded finite preparation");
  return slices + 1;
}
function source(size = 256) { return { naturalWidth: size, naturalHeight: size }; }

test("idle slices produce byte-identical material pixels and the first paint only adopts the completed canvas", () => browser(({ calls }) => {
  for (const material of ["wood", "stone", "bark", "foliage"]) {
    const image = source(), pixels = new Uint8ClampedArray(256 * 256 * 4);
    for (let i = 0; i < pixels.length; i++) pixels[i] = (i * 139 + Math.floor(i / 257)) % 256;
    image.pixels = pixels;
    const expected = pixels.slice(); harmonizeForestPixels(expected, material);
    const job = prepareForestObjectArtwork(image, material), before = { ...calls };
    try {
      assert.equal(complete(job), 7, "allocation, read, four independent 16K pixel slices, then atomic commit");
      const artwork = forestObjectArtwork(image, material);
      assert.deepEqual(artwork.pixels, expected);
      assert.equal(calls.reads - before.reads, 1); assert.equal(calls.writes - before.writes, 1);
      assert.equal(calls.allocations - before.allocations, 1, "no first-paint allocation after idle preparation");
      assert.equal(artwork.width, 256); assert.equal(artwork.height, 256);
      assert.equal(calls.draws.at(-1).quality, "high");
      job.cancel(); assert.equal(forestObjectArtwork(image, material), artwork, "disposing a queue keeps an adopted cache entry");
    } finally { job.cancel(); }
  }
}));

test("a paint during partial preparation synchronously completes its image and a stale job never replaces it", () => browser(({ calls }) => {
  const image = source(), job = prepareForestObjectArtwork(image, "wood");
  assert.equal(job.step(), false); assert.equal(job.step(), false); assert.equal(job.step(), false);
  const result = forestObjectArtwork(image, "wood"), before = calls.allocations;
  assert.ok(result.pixels); assert.equal(job.step(), true);
  job.cancel(); assert.equal(forestObjectArtwork(image, "wood"), result);
  assert.equal(calls.allocations, before, "a stale callback cannot overwrite the first visible paint");
}));

test("cross-camera reservations include ImageData, stop at 8 MiB and release on cancellation or cache adoption", () => browser(({ calls }) => {
  const first = prepareForestObjectArtwork(source(1024), "wood");
  assert.equal(first.step(), false);
  const blocked = prepareForestObjectArtwork(source(32), "stone");
  assert.equal(blocked.step(), true); assert.equal(calls.allocations, 1, "a 4 MiB canvas reserves another 4 MiB for readback");
  first.cancel();
  const image = source(1024), second = prepareForestObjectArtwork(image, "wood");
  complete(second); forestObjectArtwork(image, "wood");
  const next = prepareForestObjectArtwork(source(1024), "wood");
  try { assert.equal(next.step(), false, "a displayed cache is no longer speculative memory"); }
  finally { next.cancel(); second.cancel(); blocked.cancel(); }
}));

test("unused completed work is discarded on disposal and duplicate cameras cannot prepare one image twice", () => browser(({ calls }) => {
  const image = source(), first = prepareForestObjectArtwork(image, "stone"), duplicate = prepareForestObjectArtwork(image, "stone");
  first.step(); assert.equal(duplicate.step(), true); assert.equal(calls.allocations, 1);
  complete(first); first.cancel();
  const before = calls.allocations;
  forestObjectArtwork(image, "stone");
  assert.equal(calls.allocations, before + 1, "an unused cancelled scene does not retain prepared artwork");
}));

test("unreadable background artwork keeps the same cached original-image fallback", () => browser(({ calls }) => {
  const image = { ...source(), unreadable: true }, job = prepareForestObjectArtwork(image, "bark");
  complete(job);
  assert.equal(forestObjectArtwork(image, "bark"), image); assert.equal(calls.reads, 1);
  job.cancel(); assert.equal(forestObjectArtwork(image, "bark"), image);
}));

const scene = { focus: { x: 0, y: 0, width: 100, height: 100 }, terrain: [], bushes: [], sites: [
  { id: "far", anchor: { x: 600, y: 600 } }, { id: "home", anchor: { x: 50, y: 50 } },
] };
const visuals = { home: { image: "/home" }, far: { image: "/far" } };
test("queue yields between every phase, prioritizes nearby art and never runs while paused or after disposal", () => browser(({ calls, idle, fire }) => {
  const home = source(), far = source(), images = new Map([["/home", home], ["/far", far]]); let active = true;
  const queue = createArtworkPreparation(scene, visuals, images, () => active);
  try {
    assert.equal(idle.size, 0); queue.resume(); assert.equal(idle.size, 1);
    fire(0); assert.equal(calls.allocations, 0, "busy frames do no speculative work");
    fire(); assert.equal(calls.allocations, 1); assert.equal(calls.draws[0].source, home);
    assert.equal(calls.reads, 0, "readback waits for another idle callback");
    queue.pause(); assert.equal(idle.size, 0);
    active = false; queue.resume(); assert.equal(idle.size, 0);
    active = true; queue.resume(); fire(); assert.equal(calls.reads, 1);
    active = false; fire(); assert.equal(idle.size, 0, "a queued callback rechecks visibility before work");
    active = true; queue.resume();
    let count = 0; while (idle.size) { fire(); assert.ok(++count < 30); }
    assert.equal(calls.writes, 2); assert.equal(calls.draws[1].source, far);
  } finally { queue.dispose(); }
  queue.resume(); assert.equal(idle.size, 0);
}));

test("without idle callbacks the queue leaves the original synchronous renderer in charge", () => browser(({ calls }) => {
  delete window.requestIdleCallback; delete window.cancelIdleCallback;
  const image = source(), queue = createArtworkPreparation(scene, visuals, new Map([["/home", image]]), () => true);
  queue.resume(); queue.dispose(); assert.equal(calls.allocations, 0);
  assert.notEqual(forestObjectArtwork(image, "bark"), image); assert.equal(calls.allocations, 1);
}));
