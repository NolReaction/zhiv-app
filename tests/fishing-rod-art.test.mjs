import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { FISHING_ROD_IDS, fishingRodId, fishingRodAppearance, fishingRodShapes } = await vite.ssrLoadModule("/features/world/activities/fishing/fishing-rod-art.ts");
const { FishingRodIcon } = await vite.ssrLoadModule("/features/world/activities/fishing/fishing-rod-icon.tsx");
const { drawFishingRod } = await vite.ssrLoadModule("/features/world/activities/fishing/fishing-rod-painter.ts");

test("rod identities have different physical sections, grips and reel silhouettes even without color", () => {
  const geometry = new Set(), counts = new Set();
  for (const rodId of FISHING_ROD_IDS) {
    const shapes = fishingRodShapes(rodId);
    geometry.add(JSON.stringify(shapes.map(shape => Object.fromEntries(Object.entries(shape).filter(([key]) => !["fill", "stroke"].includes(key))))));
    counts.add(shapes.length);
    assert.ok(shapes.some(shape => shape.kind === "ellipse"), "every model has its own reel geometry");
    assert.ok(Object.isFrozen(fishingRodAppearance(rodId)));
  }
  assert.equal(geometry.size, FISHING_ROD_IDS.length); assert.equal(counts.size, FISHING_ROD_IDS.length);
  for (const value of [undefined, null, {}, "unknown", "constructor", "__proto__"]) assert.equal(fishingRodId(value), "reed_rod");
  assert.deepEqual(fishingRodShapes("unknown"), fishingRodShapes("reed_rod"));
});

test("river and tide remain different solid silhouettes without decorative wraps, rings or colors", () => {
  const solids = shapes => shapes.filter(shape => shape.fill && !["wrap", "highlight"].includes(shape.fill))
    .map(shape => JSON.stringify(Object.fromEntries(Object.entries(shape).filter(([key]) => !["fill", "stroke", "width"].includes(key)))));
  for (const side of [-1, 1]) for (const detailScale of [.45, 1]) for (const tension of [0, 1]) {
    const options = { length: .82, reel: { x: -.025, y: .06 * side }, side, detailScale, tension };
    const river = solids(fishingRodShapes("river_rod", options)), tide = new Set(solids(fishingRodShapes("tide_rod", options)));
    const different = river.filter(shape => !tide.has(shape));
    assert.ok(different.length / river.length > .5,
      "changing only palette or decorative wraps must not make two models count as distinct");
  }
});

test("all rod models keep the requested tip and finite bounded details through bending and cranking", () => {
  for (const rodId of FISHING_ROD_IDS) for (const length of [.68, 1, 1.35]) for (const side of [-1, 1]) {
    for (const tension of [0, .8, 1.5, NaN, Infinity]) {
      const options = { length, side, tension, crank: NaN, reel: { x: -.025, y: side * .043 } };
      const before = structuredClone(options), shapes = fishingRodShapes(rodId, options);
      const commands = shapes.filter(shape => shape.kind === "path").flatMap(shape => shape.commands);
      assert.ok(commands.some(command => command[0] === "Q" && command[3] === length && command[4] === 0), "the flexible shaft terminates at the same line attachment");
      for (const shape of shapes) {
        const numbers = shape.kind === "ellipse" ? [shape.x, shape.y, shape.rx, shape.ry]
          : shape.commands.flatMap(command => command.slice(1));
        assert.ok(numbers.every(Number.isFinite));
        assert.ok(numbers.every(value => Math.abs(value) < 1.5));
      }
      assert.deepEqual(options, before, "sampling never mutates the tackle rig");
    }
  }
});

test("shore reel details shrink around their real mount while each pole and shop icon retain their geometry", () => {
  for (const rodId of FISHING_ROD_IDS) {
    const reel = { x: -.025, y: .06 }, options = { length: .82, reel, crank: .7, side: 1 };
    const full = fishingRodShapes(rodId, options), small = fishingRodShapes(rodId, { ...options, detailScale: .45 });
    assert.equal(small.length, full.length);
    const shaft = shapes => shapes.find(shape => shape.kind === "path" && shape.commands.some(command =>
      command[0] === "Q" && command[3] === options.length && command[4] === 0));
    assert.deepEqual(shaft(small), shaft(full), "compact cranks cannot shorten or move the pole tip");
    const reelBody = shapes => shapes.find(shape => shape.kind === "ellipse" && shape.x === reel.x && shape.y === reel.y);
    const a = reelBody(full), b = reelBody(small);
    if (a) {
      assert.ok(b); assert.ok(Math.abs(b.rx - a.rx * .45) < 1e-9); assert.ok(Math.abs(b.ry - a.ry * .45) < 1e-9);
    } else {
      const aKnob = full.at(-1), bKnob = small.at(-1);
      assert.equal(aKnob.kind, "ellipse"); assert.equal(bKnob.kind, "ellipse");
      assert.ok(Math.abs(bKnob.rx - aKnob.rx * .45) < 1e-9);
    }
    assert.deepEqual(fishingRodShapes(rodId), fishingRodShapes(rodId, { detailScale: 1 }), "shop defaults retain their established art scale");
  }
});

test("Canvas uses the palm and line-tip anchors supplied by the character rig and balances its transform", () => {
  const calls = [], context = new Proxy({}, { get: (_target, key) => (...args) => calls.push([key, ...args]), set: () => true });
  for (const rodId of FISHING_ROD_IDS) {
    const frame = { grip: { x: 100, y: 140 }, tip: { x: 130, y: 100 }, reel: { x: 102, y: 143 }, size: 50,
      side: 1, tension: .7, crank: 1.2, rodId }, before = structuredClone(frame);
    calls.length = 0; drawFishingRod(context, frame);
    assert.equal(calls[0][0], "save"); assert.equal(calls.at(-1)[0], "restore");
    assert.deepEqual(calls.find(call => call[0] === "translate"), ["translate", 100, 140]);
    assert.deepEqual(calls.find(call => call[0] === "scale"), ["scale", 50, 50]);
    const angle = calls.find(call => call[0] === "rotate")[1];
    assert.ok(Math.abs(100 + Math.cos(angle) * 50 - frame.tip.x) < 1e-9);
    assert.ok(Math.abs(140 + Math.sin(angle) * 50 - frame.tip.y) < 1e-9);
    assert.ok(calls.flat().filter(value => typeof value === "number").every(Number.isFinite));
    assert.deepEqual(frame, before);
  }
  for (const size of [0, -1, Infinity, NaN]) {
    calls.length = 0; drawFishingRod(context, { grip: { x: 0, y: 0 }, tip: { x: 20, y: 20 }, reel: { x: 1, y: 1 }, size, side: 1, tension: 0, crank: 0 });
    assert.equal(calls.length, 0);
  }
});

test("compact and large SVG previews use each actual model without external assets or shared IDs", () => {
  for (const size of [24, 44, 64, 160]) for (const rodId of FISHING_ROD_IDS) {
    const html = renderToStaticMarkup(createElement(FishingRodIcon, { rodId, size }));
    assert.match(html, new RegExp(`width="${size}" height="${size}"`));
    assert.match(html, new RegExp(`data-fishing-rod="${rodId}"`));
    assert.match(html, /aria-hidden="true"/);
    assert.equal((html.match(/<(?:path|ellipse)\b/g) ?? []).length, fishingRodShapes(rodId).length);
    assert.doesNotMatch(html, /\bid="|<image|<use|<foreignObject|url\(|(?:href|src)=/);
  }
  const named = renderToStaticMarkup(createElement(FishingRodIcon, { rodId: "willow_rod", label: "Ивовая удочка" }));
  assert.match(named, /role="img" aria-label="Ивовая удочка"/); assert.doesNotMatch(named, /aria-hidden/);
});

test("brook has its own short wood-and-lashing model and a shallow spool without changing world anchors", () => {
  const brook = fishingRodShapes("brook_rod"), shaftTip = shapes => shapes.filter(shape => shape.kind === "path")
    .flatMap(shape => shape.commands).find(command => command[0] === "Q" && command[4] === 0);
  assert.equal(fishingRodId("brook_rod"), "brook_rod");
  assert.ok(shaftTip(brook)[3] < shaftTip(fishingRodShapes("river_rod"))[3], "the icon is a shorter bank pole");
  assert.notDeepEqual(fishingRodAppearance("brook_rod"), fishingRodAppearance("river_rod"));
  for (const other of ["reed_rod", "river_rod", "tide_rod"]) {
    const withoutColor = shapes => shapes.map(shape => Object.fromEntries(Object.entries(shape)
      .filter(([key]) => key !== "fill" && key !== "stroke")));
    assert.notDeepEqual(withoutColor(brook), withoutColor(fishingRodShapes(other)), "a new color alone is insufficient");
  }
  const options = { length: .91, reel: { x: -.025, y: .06 }, crank: 1.4 };
  const mounted = fishingRodShapes("brook_rod", options);
  assert.equal(shaftTip(mounted)[3], options.length, "the real line-tip attachment is unchanged");
  const knob = mounted.at(-1);
  assert.equal(knob.kind, "ellipse");
  assert.ok(Math.abs(knob.x - (options.reel.x + Math.cos(options.crank) * .035)) < 1e-10);
  assert.ok(Math.abs(knob.y - (options.reel.y + Math.sin(options.crank) * .025)) < 1e-10,
    "compact spool follows the existing ordinary-reel winding-paw path");
});
