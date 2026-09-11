import assert from "node:assert/strict";
import test, { after } from "node:test";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import sharp from "sharp";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(() => vite.close());
const { homeBackingSize, homeSourceCrop, prepareHomeDetail, HOME_TEXTURE_SIZE } = await vite.ssrLoadModule("/features/mochlik/home-art.ts");
const { drawLanternLight, drawSceneShade, NIGHT_SHADE } = await vite.ssrLoadModule("/features/mochlik/lantern-light.ts");
const { drawLanternGlass } = await vite.ssrLoadModule("/features/mochlik/lantern-glass.ts");
const { FOREST_MAP } = await vite.ssrLoadModule("/features/world/map-manifest.ts");

test("detail has enough real pixels for retina circles and a bounded detached world canvas", async () => {
  const master = await readFile(`${root}/public/world/maps/home-detail-v1.png`);
  assert.equal(createHash("sha256").update(master).digest("hex"), "f14fba0d71b976ed63530726e3b4a86241ab72a409e8e837a7a5b36fae5ef8bd", "approved editable home master stays unchanged");
  const bytes = await readFile(`${root}/public${FOREST_MAP.homeDetail.image}`), metadata = await sharp(bytes).metadata();
  assert.ok(metadata.width >= HOME_TEXTURE_SIZE);
  assert.equal(metadata.width, 2048); assert.equal(metadata.width, metadata.height);
  assert.ok(bytes.length < 5_200_000, "full quality detail keeps a bounded lossless download");
  assert.equal(homeBackingSize(320, 2), 640);
  assert.equal(homeBackingSize(280, 3), 840);
  assert.equal(homeBackingSize(900, 3), HOME_TEXTURE_SIZE);
  assert.equal(homeBackingSize(0, 2, true), HOME_TEXTURE_SIZE);
  assert.equal(homeBackingSize(NaN, NaN), 256);
  assert.deepEqual(FOREST_MAP.homeCrop, { x: 486, y: 514, size: 256 }, "quality change preserves the accepted scale");
});

test("home texture crops stay registered for previews and higher resolution maps", () => {
  for (const size of [384, 1254, 2048, 4096]) {
    const crop = homeSourceCrop({ naturalWidth: size, naturalHeight: size });
    assert.ok(Math.abs(crop.x / size - 486 / 1254) < 1e-12);
    assert.ok(Math.abs(crop.y / size - 514 / 1254) < 1e-12);
    assert.ok(Math.abs(crop.size / size - 256 / 1254) < 1e-12);
  }
  assert.throws(() => homeSourceCrop({ naturalWidth: 2048, naturalHeight: 1024 }), /square/);
  assert.throws(() => homeSourceCrop({ naturalWidth: NaN, naturalHeight: NaN }), /square/);
});

test("world detail remains transparent at the rim so the current map stays underneath", () => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, "document");
  const draws = [], gradients = [];
  const ctx = {
    drawImage: (...args) => draws.push(args), fillRect() {},
    createLinearGradient(...axis) { const stops = []; gradients.push({ axis, stops }); return { addColorStop: (...stop) => stops.push(stop) }; },
  };
  Object.defineProperty(globalThis, "document", { configurable: true, value: { createElement: () => ({ getContext: () => ctx }) } });
  try {
    const detail = { naturalWidth: 2048, naturalHeight: 2048 };
    const overlay = prepareHomeDetail(detail);
    assert.equal(overlay.width, 2048); assert.equal(overlay.height, 2048);
    assert.deepEqual(draws, [[detail, 0, 0, 2048, 2048]], "no preview is baked into the detailed tile");
    assert.equal(gradients.length, 2);
    for (const { stops } of gradients) assert.deepEqual(stops, [
      [0, "transparent"], [2 / 256, "transparent"], [14 / 256, "#fff"],
      [1 - 14 / 256, "#fff"], [1 - 2 / 256, "transparent"], [1, "transparent"],
    ]);
    assert.equal(prepareHomeDetail(detail), overlay, "the shared detail overlay is prepared once");
  } finally {
    if (saved) Object.defineProperty(globalThis, "document", saved); else delete globalThis.document;
  }
});

test("circle details load without the full forest and world crops upgrade independently", async () => {
  const { mountHabitat } = await vite.ssrLoadModule("/features/mochlik/scene.ts");
  const { WORLD_ART } = await vite.ssrLoadModule("/features/world/art.ts");
  const saved = new Map(), pending = [], requested = [], timers = new Map(); let timerId = 0;
  const install = (key, value) => { saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { value, configurable: true, writable: true }); };
  const surface = () => {
    const draws = [];
    const ctx = new Proxy({
      drawImage: (source, ...rect) => draws.push({ source, rect }),
      getImageData: (_x, _y, width, height) => ({ data: new Uint8ClampedArray(width * height * 4) }),
      createLinearGradient: () => ({ addColorStop() {} }), createRadialGradient: () => ({ addColorStop() {} }),
    }, { get: (target, key) => key in target ? target[key] : () => {} });
    return { width: 256, height: 256, clientWidth: 400, getContext: () => ctx, draws };
  };
  install("Image", class {
    naturalWidth = 0; naturalHeight = 0;
    set src(path) {
      if (!path) return;
      this.naturalWidth = this.naturalHeight = path === WORLD_ART.homePreview ? 256 : 2048;
      requested.push(path); pending.push({ path, image: this });
    }
  });
  install("document", { hidden: false, createElement: surface, addEventListener() {}, removeEventListener() {} });
  install("window", { devicePixelRatio: 3, addEventListener() {}, removeEventListener() {} });
  install("ResizeObserver", class { observe() {} disconnect() {} });
  install("requestAnimationFrame", () => assert.fail("reduced motion should not animate")); install("cancelAnimationFrame", () => {});
  install("setTimeout", (callback, delay) => { timers.set(++timerId, { callback, delay }); return timerId; }); install("clearTimeout", id => timers.delete(id));
  const flush = () => new Promise(resolve => setImmediate(resolve));
  const finish = path => { const at = pending.findIndex(item => item.path === path); assert.ok(at >= 0, path); const { image } = pending.splice(at, 1)[0]; image.onload(); return image; };
  const options = { paused: false, reducedMotion: true, lampOn: false, dusk: false, presenceKey: "quality-home-test" };
  let circle, world;
  try {
    let ready = 0;
    const circleCanvas = surface();
    const callbacks = { activity() {}, ready() { ready++; }, failure(error) { throw error; } };
    circle = mountHabitat(circleCanvas, { ...options, view: "circle" }, callbacks);
    finish(WORLD_ART.homePreview); await flush();
    assert.equal(ready, 1, "preview already gives a usable scene");
    assert.deepEqual(requested, [WORLD_ART.homePreview, WORLD_ART.homeDetail], "the full forest is not a circle dependency");
    const detail = finish(WORLD_ART.homeDetail); await flush();
    assert.equal(circleCanvas.width, 1200, "retina circle is no longer capped at 1024 pixels");
    assert.ok(circleCanvas.draws.some(call => call.source === detail && call.rect.join() === "0,0,256,256"), "the circle draws original decoded detail directly");
    circle.dispose(); circle = null;

    const worldCanvas = surface();
    world = mountHabitat(worldCanvas, { ...options, view: "world" }, callbacks); await flush();
    assert.equal(worldCanvas.width, 2048);
    const overlay = prepareHomeDetail(detail);
    for (const size of [384, 2048]) {
      const ground = { naturalWidth: size, naturalHeight: size };
      worldCanvas.draws.length = 0; world.setGround(ground);
      const baseAt = worldCanvas.draws.findIndex(call => call.source === ground);
      const overlayAt = worldCanvas.draws.findIndex(call => call.source === overlay);
      const crop = homeSourceCrop(ground);
      assert.ok(baseAt >= 0 && overlayAt > baseAt, "current map crop is drawn underneath the feathered details");
      assert.deepEqual(worldCanvas.draws[baseAt].rect, [crop.x, crop.y, crop.size, crop.size, 0, 0, 256, 256]);
    }
    assert.equal(requested.length, 2, "both views share decoded home images");
    world.dispose(); world = null;
    assert.equal(timers.size, 0, "disposed scenes cancel scheduled retries and ecology timers");
  } finally {
    circle?.dispose(); world?.dispose();
    for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; }
  }
});

test("lantern emits only at night, with separate soft clearing and glass falloff", () => {
  const stops = [], fills = [];
  const gradient = { addColorStop: (...stop) => stops.push(stop) };
  const ctx = { save() {}, restore() {}, createRadialGradient: () => gradient, fillRect() { fills.push({ paint: this.fillStyle, mode: this.globalCompositeOperation }); } };
  drawLanternLight(ctx, 0, 0);
  assert.equal(fills.length, 0);
  drawLanternLight(ctx, 1, 0);
  assert.equal(fills.length, 0, "daytime never emits light");
  drawLanternLight(ctx, 1, 1);
  assert.deepEqual(fills, [{ paint: gradient, mode: "screen" }, { paint: gradient, mode: "screen" }]);
  assert.deepEqual(stops.at(-1), [1, "rgba(255,181,65,0)"]);
});


test("daytime glass uses its sampled texture; dark night receives separate cool moonlight", () => {
  const fills = [];
  const glass = { texture: {}, scale: 4 }, panes = [];
  const ctx = new Proxy({ createRadialGradient: () => ({ addColorStop() {} }),
    drawImage(image) { panes.push({ image, mode: this.globalCompositeOperation }); },
    fillRect() { fills.push({ mode: this.globalCompositeOperation, color: this.fillStyle }); } },
    { get: (object, key) => key in object ? object[key] : () => {} });
  drawLanternGlass(ctx, 1, glass); assert.equal(panes.length, 0);
  drawLanternGlass(ctx, 0, glass); assert.equal(fills.length, 0, "no painted spot covers the glass");
  assert.deepEqual(panes, [{ image: glass.texture, mode: "source-over" }]);
  fills.length = 0; drawSceneShade(ctx, 1, 0, 256);
  assert.ok(NIGHT_SHADE >= .5 && NIGHT_SHADE < .65, "night returns to a dark base with lit clearings");
  assert.equal(fills[0].color, `rgba(8,17,37,${NIGHT_SHADE})`);
  assert.ok(fills.some(fill => fill.mode === "screen"), "moonlight opens up the dark base");
});


test("the doorway clips only after the feet cross the threshold, in either direction", async () => {
  const { HOUSE_ANCHORS, isBehindDoorThreshold } = await vite.ssrLoadModule("/features/mochlik/home-layout.ts");
  const { inside, doorstep } = HOUSE_ANCHORS;
  assert.equal(isBehindDoorThreshold(doorstep), false);
  assert.equal(isBehindDoorThreshold({ y: (doorstep.y + inside.y) / 2 }), false);
  assert.equal(isBehindDoorThreshold(inside), true);
  for (let step = 0; step <= 100; step++) {
    const y = doorstep.y + (inside.y - doorstep.y) * step / 100;
    const reverseY = inside.y + (doorstep.y - inside.y) * (100 - step) / 100;
    assert.equal(isBehindDoorThreshold({ y }), isBehindDoorThreshold({ y: reverseY }));
  }
});
