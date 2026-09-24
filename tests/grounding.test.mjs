import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
const { pixelSprite } = await vite.ssrLoadModule("/features/mochlik/pixel-sprite.ts");
const { drawGroundedHero, heroSpriteContact, siteContactArea, drawSiteGrounding } = await vite.ssrLoadModule("/features/world/grounding.ts");
const { paintFixedWorld } = await vite.ssrLoadModule("/features/world/tiled/renderer.ts");
const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");

function insidePolygon(x, y, points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[i], b = points[j];
    if ((a.y > y) !== (b.y > y) && x < (b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

// A small alpha-only canvas makes clipping, transparent holes and source-in observable.
function rasterCanvas() {
  const canvas = { width: 0, height: 0, pixels: new Map(), reads: 0 };
  let sx = 1, sy = 1, tx = 0, ty = 0, clips = [], path = [];
  const stack = [], draws = [];
  const transform = (x, y) => ({ x: x * sx + tx, y: y * sy + ty });
  function paint(x, y, width, height, alphaAt) {
    const a = transform(x, y), b = transform(x + width, y + height);
    for (let row = Math.max(0, Math.floor(a.y)); row < Math.min(canvas.height, Math.ceil(b.y)); row++) {
      for (let column = Math.max(0, Math.floor(a.x)); column < Math.min(canvas.width, Math.ceil(b.x)); column++) {
        if (!clips.every(points => insidePolygon(column + .5, row + .5, points))) continue;
        const u = (column + .5 - a.x) / (b.x - a.x), v = (row + .5 - a.y) / (b.y - a.y);
        if (u < 0 || u >= 1 || v < 0 || v >= 1) continue;
        const key = `${column}:${row}`, source = alphaAt(u, v), destination = canvas.pixels.get(key) ?? 0;
        const alpha = ctx.globalCompositeOperation === "source-in" ? source * destination : source + destination * (1 - source);
        if (alpha) canvas.pixels.set(key, alpha); else canvas.pixels.delete(key);
      }
    }
  }
  const ctx = {
    fillStyle: "#000", globalCompositeOperation: "source-over", draws,
    scale(x, y) { sx *= x; sy *= y; },
    translate(x, y) { tx += x * sx; ty += y * sy; },
    beginPath() { path = []; },
    moveTo(x, y) { path.push(transform(x, y)); },
    lineTo(x, y) { path.push(transform(x, y)); },
    closePath() {},
    ellipse(x, y, rx, ry) { path = Array.from({ length: 64 }, (_, i) => transform(x + rx * Math.cos(i * Math.PI / 32), y + ry * Math.sin(i * Math.PI / 32))); },
    rect(x, y, width, height) { path = [transform(x, y), transform(x + width, y), transform(x + width, y + height), transform(x, y + height)]; },
    clip() { clips.push([...path]); },
    save() { stack.push({ sx, sy, tx, ty, clips: [...clips], fillStyle: this.fillStyle, composite: this.globalCompositeOperation }); },
    restore() {
      const state = stack.pop();
      ({ sx, sy, tx, ty, clips } = state); this.fillStyle = state.fillStyle; this.globalCompositeOperation = state.composite;
    },
    fillRect(x, y, width, height) {
      const alpha = this.fillStyle.startsWith("rgba") ? Number(this.fillStyle.match(/,\s*([\d.]+)\)$/)[1]) : 1;
      paint(x, y, width, height, () => alpha);
    },
    drawImage(image, x, y, width, height) {
      draws.push([image, x, y, width, height]);
      paint(x, y, width, height, (u, v) => image.pixels.get(`${Math.floor(u * image.width)}:${Math.floor(v * image.height)}`) ?? 0);
    },
    getImageData(x, y, width, height) {
      canvas.reads++;
      const data = new Uint8ClampedArray(width * height * 4);
      for (let row = 0; row < height; row++) for (let column = 0; column < width; column++) {
        data[(row * width + column) * 4 + 3] = (canvas.pixels.get(`${x + column}:${y + row}`) ?? 0) * 255;
      }
      return { data };
    },
  };
  canvas.getContext = () => ctx;
  return canvas;
}

globalThis.document = { createElement(tag) { assert.equal(tag, "canvas"); return rasterCanvas(); } };
after(async () => {
  if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument); else delete globalThis.document;
  await vite.close();
});

function recordingContext() {
  const draws = [], ellipses = [], stack = [];
  return {
    draws, ellipses, globalAlpha: 1, fillStyle: "original", filter: "none", imageSmoothingEnabled: true, globalCompositeOperation: "source-over",
    save() { stack.push({ globalAlpha: this.globalAlpha, fillStyle: this.fillStyle, filter: this.filter, imageSmoothingEnabled: this.imageSmoothingEnabled }); },
    restore() { Object.assign(this, stack.pop()); },
    beginPath() {}, rect() {}, clip() {}, fill() {},
    ellipse(...args) { ellipses.push({ args, fillStyle: this.fillStyle }); },
    drawImage(...args) { draws.push({ args, filter: this.filter, smoothing: this.imageSmoothingEnabled }); },
  };
}

test("every real pose and direction puts its opaque sole at ground level at any authored size", () => {
  const poses = ["idle", "walk", "blink", "sleep", "drowsy", "stretch", "crouch", "jump", "groom", "greet", "sniff", "reach", "hold", "chew", "swallow", "scratch", "yawn", "shake", "sneeze", "wonder", "carry", "toss", "present", "fish", "fishing-walk"];
  for (const pose of poses) for (const direction of ["front", "back", "left", "right"]) for (let frame = 0; frame < 4; frame++) {
    const sprite = pixelSprite(pose, direction, frame, { palette: "fern", head: "leaf_cap", neck: "berry_scarf" });
    const points = [...sprite.pixels.keys()].map(key => key.split(":").map(Number));
    const bottom = Math.max(...points.map(([, y]) => y)) + 1;
    const sole = points.filter(([, y]) => y >= bottom - 3);
    assert.deepEqual(heroSpriteContact(sprite, pose, frame), {
      bottom, left: Math.min(...sole.map(([x]) => x)), right: Math.max(...sole.map(([x]) => x)) + 1,
    });
    const reads = sprite.reads;
    for (const size of [24, 60, 103.5]) {
      const ctx = recordingContext();
      drawGroundedHero(ctx, { x: 180, y: 220, size, pose, direction, frame, appearance: { palette: "fern", head: "leaf_cap", neck: "berry_scarf" } });
      const [drawn, x, y, width, height] = ctx.draws[0].args;
      assert.equal(drawn, sprite);
      assert.ok(Math.abs(y + bottom / sprite.height * height - 220) < 1e-10);
      assert.equal(x, 180 - size / 2); assert.equal(width, size); assert.equal(height, size);
      assert.equal(ctx.draws[0].smoothing, false);
      assert.equal(ctx.imageSmoothingEnabled, true); assert.equal(ctx.fillStyle, "original");
      assert.equal(ctx.ellipses.length, 2);
      assert.equal(ctx.ellipses[1].args[1], 220);
      assert.ok(ctx.ellipses.every(({ args }) => args[3] <= size * .04));
    }
    assert.equal(sprite.reads, reads, "alpha is scanned only once per cached sprite");
  }
});

test("breathing is bounded and keeps the feet fixed, including nonfinite input", () => {
  for (const breathe of [-1, -.005, 0, .005, 1, Number.NaN, Infinity]) {
    const ctx = recordingContext();
    drawGroundedHero(ctx, { x: 0, y: 100, size: 60, pose: "idle", direction: "front", frame: 0, breathe });
    const [sprite, , y, , height] = ctx.draws[0].args;
    const { bottom } = heroSpriteContact(sprite, "idle", 0);
    assert.ok(height >= 60 * .992 && height <= 60 * 1.008);
    assert.ok(Math.abs(y + height * bottom / 48 - 100) < 1e-10);
  }
});

test("a jump raises the body while its shrinking shadow stays on the ground", () => {
  const ground = recordingContext(), airborne = recordingContext();
  const actor = { x: 100, y: 200, size: 56, pose: "jump", direction: "left", frame: 2 };
  drawGroundedHero(ground, actor); drawGroundedHero(airborne, { ...actor, lift: 14 });
  assert.equal(ground.draws[0].args[2] - airborne.draws[0].args[2], 14);
  assert.equal(airborne.ellipses[1].args[1], actor.y);
  assert.ok(airborne.ellipses[1].args[2] < ground.ellipses[1].args[2]);
  assert.equal(airborne.globalAlpha, 1, "shadow transparency cannot leak to the hero or next effect");
});

test("invalid actor coordinates and size never send nonfinite geometry to canvas", () => {
  for (const patch of [{ x: Number.NaN }, { y: Infinity }, { size: Number.NaN }, { size: 0 }, { size: -1 }]) {
    const ctx = recordingContext();
    drawGroundedHero(ctx, { x: 0, y: 100, size: 60, pose: "idle", direction: "front", frame: 0, ...patch });
    assert.equal(ctx.draws.length, 0); assert.equal(ctx.ellipses.length, 0);
  }
});

test("ducking shrinks the body continuously around its feet without hiding or moving its ground shadow", () => {
  let previousWidth = Infinity, previousHeight = Infinity;
  for (const compression of [0, .25, .5, .75, 1]) {
    const ctx = recordingContext();
    drawGroundedHero(ctx, { x: 100, y: 200, size: 56, pose: "crouch", direction: "back", frame: 0, compression, lift: 6 });
    const [sprite, x, y, width, height] = ctx.draws[0].args;
    assert.equal(x + width / 2, 100);
    assert.ok(Math.abs(y + heroSpriteContact(sprite, "crouch", 0).bottom / 48 * height - 194) < 1e-10);
    assert.ok(width <= previousWidth && height <= previousHeight);
    assert.ok(width >= 56 * .86 && height >= 56 * .65);
    assert.equal(ctx.ellipses[1].args[1], 200);
    assert.equal(ctx.globalAlpha, 1);
    previousWidth = width; previousHeight = height;
  }
  for (const compression of [-4, 4, Number.NaN, Infinity]) {
    const ctx = recordingContext();
    drawGroundedHero(ctx, { x: 0, y: 0, size: 56, pose: "crouch", direction: "back", frame: 0, compression });
    const [, , , width, height] = ctx.draws[0].args;
    assert.ok(Number.isFinite(width) && width >= 56 * .86 && width <= 56);
    assert.ok(Number.isFinite(height) && height >= 56 * .65 && height <= 56);
  }
});

test("an unavailable or empty alpha buffer keeps the rig's safe contact without repeated reads", () => {
  for (const mode of ["missing", "throw", "transparent"]) {
    let reads = 0;
    const sprite = { getContext: () => ({ getImageData() {
      reads++;
      if (mode === "throw") throw new Error("unreadable");
      if (mode === "missing") return undefined;
      return { data: new Uint8ClampedArray(48 * 48 * 4) };
    } }) };
    assert.deepEqual(heroSpriteContact(sprite, "idle", 0), { bottom: 45, left: 12, right: 37 });
    for (const pose of ["walk", "carry", "fishing-walk"]) {
      assert.equal(heroSpriteContact(sprite, pose, 1).bottom, 46);
      assert.equal(heroSpriteContact(sprite, pose, -1).bottom, 46);
      assert.equal(heroSpriteContact(sprite, pose, 2).bottom, 45);
    }
    assert.equal(heroSpriteContact(sprite, "walk", Number.NaN).bottom, 45);
    assert.equal(reads, 1);
  }
});

function fixture() {
  const site = {
    id: "authored-site", label: "Site", bounds: { x: 100, y: 200, width: 100, height: 100 },
    anchor: { x: 150, y: 280 }, entry: { x: 150, y: 295 }, hitArea: [],
    collision: [{ x: 120, y: 240 }, { x: 180, y: 240 }, { x: 180, y: 290 }, { x: 120, y: 290 }],
    initialLevel: 0, states: [],
  };
  const image = rasterCanvas(); image.width = 100; image.height = 100;
  const ctx = image.getContext("2d"); ctx.fillRect(10, 15, 80, 80);
  for (let y = 70; y < 85; y++) for (let x = 45; x < 55; x++) image.pixels.delete(`${x}:${y}`);
  return { site, image };
}

test("site contact follows authored collision and intersects the image bounds", () => {
  const { site } = fixture();
  assert.deepEqual(siteContactArea(site), { x: 120, y: 269, width: 60, height: 21 });
  const translated = { ...site, bounds: { x: 350, y: 500, width: 100, height: 100 },
    anchor: { x: 400, y: 580 }, collision: site.collision.map(p => ({ x: p.x + 250, y: p.y + 300 })) };
  assert.deepEqual(siteContactArea(translated), { x: 370, y: 569, width: 60, height: 21 });
  const clipped = { ...site, collision: [{ x: 50, y: 250 }, { x: 250, y: 250 }, { x: 250, y: 350 }, { x: 50, y: 350 }] };
  assert.deepEqual(siteContactArea(clipped), { x: 100, y: 279, width: 100, height: 21 });
});

test("the small anchor fallback works without collision or for collision outside the image", () => {
  const { site, image } = fixture();
  for (const collision of [[], [{ x: 1, y: 1 }], [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 5 }]]) {
    const unmarked = { ...site, collision }, area = siteContactArea(unmarked);
    assert.ok(area.width < site.bounds.width / 2); assert.ok(area.height < site.bounds.height / 10);
    assert.ok(area.y <= site.anchor.y && area.y + area.height >= site.anchor.y);
    const ctx = recordingContext(); drawSiteGrounding(ctx, unmarked, image);
    assert.ok(ctx.draws[0].args[0].pixels.size > 0);
  }
  assert.deepEqual(siteContactArea({ ...site, collision: [], anchor: { x: Number.NaN, y: Infinity } }), { x: 128, y: 288, width: 44, height: 8 });
  assert.equal(siteContactArea({ ...site, bounds: { ...site.bounds, width: 0 } }), null);
  assert.equal(siteContactArea({ ...site, bounds: { ...site.bounds, y: Number.NaN } }), null);
});

test("building shadows preserve artwork alpha holes, clip to contact, and leave the artwork untouched", () => {
  const { site, image } = fixture(), original = new Map(image.pixels), ctx = recordingContext();
  drawSiteGrounding(ctx, site, image);
  const [mask, x, y, width, height] = ctx.draws[0].args;
  assert.equal(x, 100); assert.equal(width, 100); assert.equal(height, 100);
  assert.ok(y > 200 && y <= 201); assert.equal(ctx.filter, "none");
  assert.ok(Number(ctx.draws[0].filter.match(/[\d.]+/)[0]) <= 1);
  assert.ok(mask.pixels.size > 0);
  for (const [key, alpha] of mask.pixels) {
    const [column, row] = key.split(":").map(Number), wx = 100 + (column + .5) / 2, wy = 200 + (row + .5) / 2;
    assert.ok(wx >= 120 && wx < 180 && wy >= 269 && wy < 290);
    assert.ok(!(wx >= 145 && wx < 155 && wy >= 270 && wy < 285), "transparent doorway remains transparent");
    assert.ok(alpha > 0 && alpha <= .12);
  }
  assert.deepEqual(image.pixels, original);
});

test("a nonrectangular collision clips the lower band instead of darkening its bounding box", () => {
  const { site, image } = fixture();
  site.collision = [{ x: 120, y: 240 }, { x: 180, y: 240 }, { x: 150, y: 290 }];
  const ctx = recordingContext(); drawSiteGrounding(ctx, site, image);
  const mask = ctx.draws[0].args[0];
  assert.ok(mask.pixels.size > 0);
  for (const key of mask.pixels.keys()) {
    const [x, y] = key.split(":").map(Number);
    assert.ok(insidePolygon(100 + (x + .5) / 2, 200 + (y + .5) / 2, site.collision));
  }
});

test("masks reuse a level image and regenerate for new level artwork and a different site", () => {
  const { site, image } = fixture(), ctx = recordingContext();
  drawSiteGrounding(ctx, site, image); drawSiteGrounding(ctx, site, image);
  const first = ctx.draws[0].args[0]; assert.equal(ctx.draws[1].args[0], first);
  const next = rasterCanvas(); next.width = 100; next.height = 100;
  next.getContext("2d").fillRect(22, 72, 10, 12);
  drawSiteGrounding(ctx, site, next);
  const changed = ctx.draws[2].args[0];
  assert.notEqual(changed, first); assert.ok(changed.pixels.size < first.pixels.size);
  assert.equal(changed.getContext("2d").draws[0][0], next);
  drawSiteGrounding(ctx, { ...site, anchor: { ...site.anchor } }, next);
  assert.notEqual(ctx.draws[3].args[0], changed);
  const transparent = rasterCanvas(); transparent.width = 100; transparent.height = 100;
  drawSiteGrounding(ctx, site, transparent);
  assert.equal(ctx.draws[4].args[0].pixels.size, 0, "an empty state must not inherit the previous building's shadow");
});

test("mask allocation stays bounded for large future artwork", () => {
  const { site, image } = fixture();
  const large = { ...site, bounds: { x: 0, y: 0, width: 4000, height: 2200 }, anchor: { x: 2000, y: 2000 }, collision: [] };
  const ctx = recordingContext(); drawSiteGrounding(ctx, large, image);
  const mask = ctx.draws[0].args[0];
  assert.ok(mask.width <= 512 && mask.height <= 512);
});

test("the shared compositor paints each current state over its own mask and grounds the preview actor", () => {
  const { site, image } = fixture(), ctx = recordingContext();
  const scene = { width: 500, height: 500, terrain: [], sites: [site], actor: { size: 60 }, paths: [] };
  const actor = { x: 300, y: 400, direction: "front", frame: 1, walking: true };
  paintFixedWorld(ctx, scene, { images: new Map([["current-level", image]]), visuals: { [site.id]: { image: "current-level", level: 3 } }, actor,
    options: { night: false, selectedSiteId: null, debug: false } });
  assert.equal(ctx.draws[0].args[0].getContext("2d").draws[0][0], image);
  assert.equal(ctx.draws[1].args[0], image);
  assert.deepEqual(ctx.draws[1].args.slice(1), [100, 200, 100, 100]);
  const [sprite, , y, , height] = ctx.draws[2].args;
  assert.ok(Math.abs(y + heroSpriteContact(sprite, "walk", 1).bottom / 48 * height - 400) < 1e-10);
});

test("ground effects paint over terrain, below buildings, without leaking canvas state", () => {
  const { site, image } = fixture(), ctx = recordingContext();
  const terrain = { naturalWidth: 500, naturalHeight: 500 }, effect = {};
  const scene = { width: 500, height: 500, terrain: [{ image: "terrain", bounds: { x: 0, y: 0, width: 500, height: 500 } }], sites: [site], paths: [] };
  paintFixedWorld(ctx, scene, {
    images: new Map([["terrain", terrain], ["building", image]]), visuals: { [site.id]: { image: "building", level: 1 } }, actor: null,
    options: { night: false, selectedSiteId: null, debug: false, buildingShadow: false },
    paintGround(ground) { ground.filter = "blur(5px)"; ground.drawImage(effect, 1, 2, 3, 4); },
  });
  assert.deepEqual(ctx.draws.map(draw => draw.args[0]), [terrain, effect, image]);
  assert.equal(ctx.draws[1].filter, "blur(5px)");
  assert.equal(ctx.draws[2].filter, "none");
  assert.equal(ctx.filter, "none");
});
