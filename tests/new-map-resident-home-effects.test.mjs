import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { browser, finishVillagerArtwork, modules, options, quietClearing, sceneClock } from "./helpers/new-map-scene.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const authored = JSON.parse(await readFile(new URL("../features/world/tiled/forest.generated.json", import.meta.url), "utf8"));
const live = await modules(structuredClone(authored));
const vite = await createServer({ appType: "custom", configFile: false, root, optimizeDeps: { noDiscovery: true, include: [] },
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { residentScenePresentation } = await vite.ssrLoadModule("/features/world/scene/resident-scene-presentation.ts");
const { residentHomeParticles } = await vite.ssrLoadModule("/features/world/characters/resident-home-effects.ts");
const { beginWoodcutterCycle } = await vite.ssrLoadModule("/features/world/characters/villagers/woodcutter-cycle.ts");
const { forestResidentAt } = await vite.ssrLoadModule("/features/world/characters/forest-residents.ts");
const quiet = { ...quietClearing, autoLife: false, lightShadows: false, waterSurface: false, waterFish: false, puddles: false,
  showHero: false, showBuildings: true };
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const rectangle = (x, y, width, height) => [{ x, y }, { x: x + width, y }, { x: x + width, y: y + height }, { x, y: y + height }];

// Independent sampled clip model: assert the portrait's pixels survive actual
// paintNewMap composition, rather than checking that a clip method was called.
function contains(points, point) {
  let winding = 0;
  for (let index = 0; index < points.length; index++) {
    const a = points[index], b = points[(index + 1) % points.length];
    const side = (b.x - a.x) * (point.y - a.y) - (point.x - a.x) * (b.y - a.y);
    if (a.y <= point.y && b.y > point.y && side > 0) winding++;
    if (a.y > point.y && b.y <= point.y && side < 0) winding--;
  }
  return winding;
}
function sampledCanvas(samplePoint) {
  const paints = [], portraits = [], images = [], stack = [];
  let path = [], clips = [];
  const context = { paints, portraits, images, globalAlpha: 1, globalCompositeOperation: "source-over", imageSmoothingEnabled: true,
    fillStyle: "#000000", canvas: { width: 1254, height: 1254 }, getTransform: () => undefined, setTransform: undefined,
    save() { stack.push({ clips: [...clips], globalAlpha: this.globalAlpha, fillStyle: this.fillStyle,
      imageSmoothingEnabled: this.imageSmoothingEnabled, globalCompositeOperation: this.globalCompositeOperation }); },
    restore() { const state = stack.pop(); assert.ok(state); clips = state.clips; delete state.clips; Object.assign(this, state); },
    beginPath() { path = []; }, closePath() {},
    rect(x, y, width, height) { path.push(rectangle(x, y, width, height)); },
    moveTo(x, y) { path.push([{ x, y }]); }, lineTo(x, y) { path.at(-1).push({ x, y }); },
    ellipse(x, y, rx, ry, angle) { path.push({ ellipse: [x, y, rx, ry, angle] }); },
    clip(rule = "nonzero") { clips.push({ path: structuredClone(path), rule }); },
    fillRect(...bounds) { paints.push({ color: this.fillStyle, bounds, alpha: this.globalAlpha }); },
    drawImage(...args) {
      images.push(args);
      if (args.length !== 9 || args.slice(1, 5).join() !== "13,5,29,33") return;
      const visible = clips.every(clip => {
        const winding = clip.path.reduce((sum, item) => {
          if (!item.ellipse) return sum + contains(item, samplePoint);
          const [x, y, rx, ry, angle] = item.ellipse, dx = samplePoint.x - x, dy = samplePoint.y - y;
          return sum + Number(((dx * Math.cos(angle) + dy * Math.sin(angle)) / rx) ** 2
            + ((-dx * Math.sin(angle) + dy * Math.cos(angle)) / ry) ** 2 <= 1);
        }, 0);
        return clip.rule === "evenodd" ? Math.abs(winding) % 2 === 1 : winding !== 0;
      });
      portraits.push({ args, visible });
    },
    createLinearGradient: () => ({ addColorStop() {} }), createRadialGradient: () => ({ addColorStop() {} }),
  };
  return new Proxy(context, { get: (target, key) => key in target ? target[key] : () => {} });
}
function paintPresentation(scene, presentation, elapsed = 2) {
  const ctx = sampledCanvas(presentation.window?.position ?? { x: -1, y: -1 });
  live.paintNewMap(ctx, new Map(), { ...options, view: "world", reducedMotion: false }, elapsed, false, 100_000, 0,
    { scene, state: { ...live.worldDevStore.getSnapshot(), ...quiet }, actorAway: true, residents: [], residentPresentation: presentation });
  return ctx;
}

test("actual Pleska enters home, paints floating fish and has no body, tap or occupied outdoor feet", async () => {
  const env = browser(), key = "home-effects-actual-pleska"; let scene, probe;
  const { mountHabitat, connectForestSession, forgetForestSession, TILED_WORLD, worldDevStore,
    previewWorldScene, accountSceneLevels, requestPleskHome, pleskMindFrame, forestResidentOccupants } = live;
  try {
    worldDevStore.patch(quiet);
    const initial = { ...options, reducedMotion: false, view: "world", serverNow: 100_000, presenceKey: key };
    const canvas = env.surface(), calls = canvas.calls;
    scene = mountHabitat(canvas, initial, { activity() {}, ready() {}, failure: assert.fail }); await finishVillagerArtwork(env);
    const effective = previewWorldScene(TILED_WORLD, accountSceneLevels(TILED_WORLD, undefined, worldDevStore.getSnapshot()));
    probe = connectForestSession(key, effective, "circle", 100_000, 0, () => {});
    const state = probe.state, mind = state.pleskMind, clock = sceneClock(env), initialFeet = { ...mind.position };
    assert.equal(requestPleskHome(mind), true); assert.deepEqual(mind.position, initialFeet);
    let previous = initialFeet;
    clock.until(() => {
      assert.ok(distance(previous, mind.position) <= 16 * .05 + 1e-7, "the fish cue cannot replace the real doorway approach");
      previous = { ...mind.position }; calls.length = 0; return mind.home.phase === "inside";
    }, "Pleska walks through the actual Tiled threshold", 650);
    assert.equal(pleskMindFrame(mind, mind.scene, false), null); assert.equal(scene.inspectPoint("plesk"), null);
    assert.equal(scene.hitResident(mind.position.x, mind.position.y - 18), null);
    assert.equal(forestResidentOccupants(state, mind.scene, { heroVisible: true }).some(actor => actor.id === "plesk"), false);
    const before = { mind: structuredClone(mind), elapsed: state.elapsed, economy: structuredClone(state.economyResidents) };
    const presentation = residentScenePresentation(state, effective), cue = presentation.homes.find(home => home.id === "plesk");
    assert.ok(cue); assert.equal(presentation.homes.filter(home => home.id === "plesk").length, 1);
    const sample = sampledCanvas({ x: -1, y: -1 }); scene.paintWorld(sample);
    const fishEyes = sample.paints.filter(paint => paint.color === "#355c66");
    assert.equal(fishEyes.length, 2, "both floating fish reach the real map painter");
    assert.equal(sample.paints.some(paint => paint.color === "#ecdba7"), false, "the old sleep-letter cue is absent");
    const bodies = sample.images.filter(args => args.length === 5 && args[0]?.width === 48 && args[0]?.height === 48);
    const expectedBodies = [live.builderMindFrame(state.builderMind, mind.scene, false), ...live.forestVillagerFrames(state.villagers)]
      .filter(frame => frame && (frame.opacity ?? 1) > 0);
    assert.equal(bodies.length, expectedBodies.length, "the renderer adds no fallback Pleska body at an old outdoor marker");
    assert.equal(bodies.some(([, x, y, width, height]) => Math.abs(x + width / 2 - mind.position.x) < .1
      && Math.abs(y + height * 45 / 48 - mind.position.y) < 2), false,
    "indoor Pleska draws no body at her concealed threshold; other residents may remain outside");
    const particles = residentHomeParticles(cue, false);
    assert.ok(fishEyes.every(eye => particles.some(particle => Math.abs(eye.bounds[1] - particle.y - particle.unit * 2) < 1e-7)));
    assert.deepEqual(mind, before.mind); assert.equal(state.elapsed, before.elapsed); assert.deepEqual(state.economyResidents, before.economy);
  } finally { scene?.dispose(); probe?.release(); forgetForestSession(key); worldDevStore.reset(); env.restore(); }
});

test("the indoor caravan keeps its home effect without a window face or outdoor duplicate", () => {
  const env = browser();
  try {
    const levels = { ...live.initialPreviewLevels(live.TILED_WORLD), home: 3, quarry: 1 };
    const scene = live.previewWorldScene(live.TILED_WORLD, levels), villagers = live.createForestVillagers(scene);
    live.configureForestVillagers(villagers, scene, { confirmed: true, buildings: levels, arrivalSeen: true, leaftailReady: true });
    const merchant = villagers.residents.leaftail;
    for (let tick = 0; tick < 400 && merchant.doorPhase !== "inside"; tick++) live.advanceForestVillagers(villagers, scene, .1, {});
    assert.equal(merchant.doorPhase, "inside");
    const state = { elapsed: 2, villagers, pleskMind: null, social: { current: { speaker: "leaftail" } } };
    const before = JSON.stringify({ state, scene }), presentation = residentScenePresentation(state, scene);
    assert.equal(presentation.window, null);
    const cue = presentation.homes.find(home => home.id === "leaftail");
    assert.ok(cue); assert.ok(residentHomeParticles(cue, false).length);
    const painted = paintPresentation(scene, presentation);
    assert.equal(painted.portraits.length, 0, "the actual painter does not draw a caravan portrait");
    assert.ok(painted.paints.length > 0, "the existing overhead home effect is still painted");
    assert.equal(live.forestVillagerFrames(villagers).some(frame => frame.id === "leaftail"), false);
    assert.equal(live.forestVillagerOccupants(villagers).some(actor => actor.id === "leaftail"), false);
    assert.equal(JSON.stringify({ state, scene }), before, "presentation never moves feet or edits authored scenery");
  } finally { env.restore(); }
});

test("a real Tiled rabbit unload creates one visible bounded woodpile without rewards, repeated delivery or hit targets", () => {
  const env = browser();
  try {
    const levels = { ...live.initialPreviewLevels(live.TILED_WORLD), home: 3, quarry: 1 };
    const scene = live.previewWorldScene(live.TILED_WORLD, levels), villagers = live.createForestVillagers(scene);
    live.configureForestVillagers(villagers, scene, { confirmed: true, buildings: levels, arrivalSeen: true, leaftailReady: true });
    for (const id of ["kamneshmyg", "leaftail"]) villagers.residents[id].available = false;
    const rabbit = villagers.residents.lopukh, places = live.forestVillagerPlaces(scene, "lopukh");
    const economy = structuredClone(villagers.production), source = JSON.stringify(scene);
    assert.equal(beginWoodcutterCycle(rabbit, places), true);
    for (let tick = 0; tick < 1600 && rabbit.woodwork.phase !== "rest"; tick++) {
      if (rabbit.action === "unload") assert.equal(rabbit.woodwork.lastDelivery, undefined, "an unfinished unload cannot paint a log");
      live.advanceForestVillagers(villagers, scene, .05, {});
    }
    const delivery = rabbit.woodwork.lastDelivery;
    assert.ok(delivery); assert.equal(delivery.sequence, 1); assert.equal(rabbit.action, "rest");
    const state = { elapsed: 2, villagers, pleskMind: null, social: { current: null } }, before = JSON.stringify(state);
    const presentation = residentScenePresentation(state, scene), first = paintPresentation(scene, presentation), again = paintPresentation(scene, presentation);
    const logEnds = ctx => ctx.paints.filter(paint => paint.color === "#d7b57c");
    assert.equal(logEnds(first).length, 1); assert.deepEqual(logEnds(first), logEnds(again));
    assert.equal(forestResidentAt(scene, 2, false, delivery.position, []), null, "decorative logs introduce no resident hit target");
    assert.equal(JSON.stringify(state), before); assert.deepEqual(villagers.production, economy);
    for (let tick = 0; tick < 10; tick++) live.advanceForestVillagers(villagers, scene, .05, {});
    assert.equal(rabbit.woodwork.lastDelivery.sequence, 1, "a rested log is not delivered again on each tick");
    const originalDrop = structuredClone(delivery.position);
    for (let tick = 0; tick < 300 && !rabbit.woodwork.completedCycles; tick++) live.advanceForestVillagers(villagers, scene, .05, {});
    assert.equal(rabbit.woodwork.completedCycles, 1); assert.equal(beginWoodcutterCycle(rabbit, places), true);
    for (let tick = 0; tick < 1600 && rabbit.woodwork.lastDelivery.sequence < 2; tick++) live.advanceForestVillagers(villagers, scene, .05, {});
    assert.equal(rabbit.woodwork.lastDelivery.sequence, 2);
    assert.ok(distance(originalDrop, rabbit.woodwork.lastDelivery.position) > 10, "two ordinary authored targets exercise the former pile jump");
    assert.deepEqual(rabbit.woodwork.deliveries[0].position, originalDrop);
    const secondState = JSON.stringify(state), secondPresentation = residentScenePresentation(state, scene);
    assert.equal(secondPresentation.woodpiles.length, 2);
    const second = paintPresentation(scene, secondPresentation);
    assert.equal(logEnds(second).length, 2);
    assert.ok(logEnds(second).some(log => JSON.stringify(log.bounds) === JSON.stringify(logEnds(first)[0].bounds)),
      "the first log remains drawn at its original world coordinates after the next delivery");
    assert.equal(JSON.stringify(state), secondState); assert.deepEqual(villagers.production, economy);
    assert.equal(JSON.stringify(scene), source, "a visible work result never writes into Tiled or its stock model");
  } finally { env.restore(); }
});
