import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(() => vite.close());
const { forestBushRootContacts, attachForestBushContact, drawForestBushGrounding, drawForestBushRootFringe } =
  await vite.ssrLoadModule("/features/world/forest-bush-grounding.ts");

test("tight contact meets the opaque lower leaf row without filling transparent gaps or high side leaves", () => {
  const width = 12, height = 18, source = new Uint8ClampedArray(width * height * 4);
  const target = new Uint8ClampedArray(source.length), alpha = (data, x, y) => data[(y * width + x) * 4 + 3];
  for (const [x, floor] of [[2, 4], [4, 8], [5, 9], [7, 8], [8, 7]]) {
    for (let y = 0; y <= floor; y++) source[(y * width + x) * 4 + 3] = 255;
  }
  const original = source.slice();
  attachForestBushContact(source, target, width, height, 4, 4);
  assert.ok(alpha(target, 5, 10) > 100, "the very next row under the lowest leaf has a visible tight shadow");
  assert.ok(alpha(target, 5, 10) > alpha(target, 5, 11) && alpha(target, 5, 11) > alpha(target, 5, 12));
  assert.equal(alpha(target, 5, 13), 0, "contact stays short, rather than projecting a second floating crown");
  assert.ok(alpha(target, 4, 9) > 0, "an irregular lower silhouette remains attached too");
  for (let y = 0; y < height; y++) {
    assert.equal(alpha(target, 6, y), 0, "a transparent gap is not bridged by a rectangular strip");
    assert.equal(alpha(target, 2, y), 0, "upper side leaves do not receive a false floating contact line");
  }
  assert.deepEqual(source, original, "the artwork's alpha is not changed");
  const blank = new Uint8ClampedArray(target.length);
  attachForestBushContact(source, blank, width, height, NaN, 4); assert.ok(blank.every(value => value === 0));
});

test("root fringe follows opaque lower leaves, including padding and transparent notches", () => {
  const width = 40, height = 40, pixels = new Uint8ClampedArray(width * height * 4);
  for (let y = 8; y < 33; y++) for (let x = 5; x < 35; x++) pixels[(y * width + x) * 4 + 3] = 255;
  // The middle column has a hole down to its lower tip. Low-alpha padding is not ground.
  for (let y = 20; y < 40; y++) pixels[(y * width + 19) * 4 + 3] = y > 32 ? 45 : 0;
  const bounds = { x: 100, y: 200, width: 80, height: 80 };
  const contacts = forestBushRootContacts(pixels, width, height, bounds);
  assert.ok(contacts.length >= 5 && contacts.length <= 7);
  assert.ok(contacts.every(point => point.y === 265), "tips attach to leaves, not the image bottom at 280");
  assert.ok(contacts.every(point => point.x !== 139), "a transparent notch cannot sprout a floating tuft");
  const translated = forestBushRootContacts(pixels, width, height, { ...bounds, x: 230, y: -100 });
  assert.deepEqual(translated, contacts.map(point => ({ x: point.x + 130, y: point.y - 300 })));
  assert.deepEqual(forestBushRootContacts(new Uint8ClampedArray(pixels.length), width, height, bounds), []);
  assert.deepEqual(forestBushRootContacts(pixels, 0, height, bounds), []);
  assert.deepEqual(forestBushRootContacts(pixels, width, height, { ...bounds, width: NaN }), []);
});

test("bush alpha grounding is cached across cameras and never clips to the interaction polygon", () => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, "document"), canvases = [];
  function context() {
    const calls = [], stack = [];
    const ctx = { calls, globalAlpha: .7, filter: "none",
      save() { stack.push({ globalAlpha: this.globalAlpha, filter: this.filter }); },
      restore() { Object.assign(this, stack.pop()); },
      createRadialGradient() { return { addColorStop() {} }; },
      getImageData(x, y, width, height) { return { data: new Uint8ClampedArray(width * height * 4) }; },
    };
    for (const name of ["scale", "translate", "beginPath", "moveTo", "lineTo", "quadraticCurveTo", "closePath", "clip",
      "drawImage", "fillRect", "fill", "ellipse", "stroke"]) ctx[name] = (...args) => calls.push({ name, args });
    return ctx;
  }
  globalThis.document = { createElement() {
    const ctx = context(), canvas = { width: 0, height: 0, getContext: () => ctx };
    canvases.push(canvas); return canvas;
  } };
  try {
    const terrain = { id: "shrub", image: "/shrub.png", bounds: { x: 10, y: 20, width: 80, height: 80 } };
    const bush = { id: "bush", imageId: "shrub", points: [{ x: 15, y: 25 }, { x: 75, y: 28 }, { x: 52, y: 80 }] };
    const scene = { bushes: [bush], terrain: [terrain] }, image = { naturalWidth: 512, naturalHeight: 512 };
    const ctx = context();
    drawForestBushGrounding(ctx, scene, terrain, image);
    drawForestBushRootFringe(ctx, scene, terrain, image);
    const count = canvases.length;
    assert.equal(count, 6, "four alpha/grounding surfaces and two soil states, baked once");
    assert.ok(canvases.every(canvas => canvas.width <= 384 && canvas.height <= 384));
    assert.ok(!canvases[0].getContext().calls.some(call => call.name === "clip"), "silhouette comes only from PNG alpha");
    drawForestBushGrounding(ctx, scene, terrain, image, 1, 1);
    drawForestBushRootFringe(ctx, scene, terrain, image);
    assert.equal(canvases.length, count, "night, water and another camera reuse the same surfaces");
    assert.equal(ctx.globalAlpha, .7);
    assert.equal(ctx.filter, "none");
    drawForestBushRootFringe(ctx, scene, terrain, { naturalWidth: 512, naturalHeight: 512 });
    assert.equal(canvases.length, count + 4, "replacement artwork invalidates alpha-dependent grounding only");
  } finally {
    if (saved) Object.defineProperty(globalThis, "document", saved); else delete globalThis.document;
  }
});
