import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ root, configFile: false, appType: "custom", optimizeDeps: { noDiscovery: true, include: [] },
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false },
  plugins: [{ name: "scene-lifecycle-painter-probe", enforce: "pre", transform(code, id) {
    if (id.endsWith("/fishing-scene-fish.ts")) return code.slice(0, code.indexOf("export function paintSceneFish(")) +
      'export function paintSceneFish(ctx,point,frame){globalThis.__fishingFishPaints?.push({point:{...point},frame:{...frame}})}';
    if (id.endsWith("/fishing-scene-runtime.ts")) return code.replace('import { fishingSceneGeometry, paintFishingScene } from "./fishing-scene-painter";',
      'import { fishingSceneGeometry } from "./fishing-scene-painter";\nfunction paintFishingScene(ctx,frame,images,viewport,visual){globalThis.__fishingScenePaints.push({frame,images:[...images.keys()],viewport:{...viewport},visual:{...visual}})}');
  } }],
});
after(() => vite.close());
const { fishingBiteMotion } = await vite.ssrLoadModule("/features/economy/ui/boat/scene/fishing-scene-bite.ts");
const { fishingSceneGeometry, paintFishingScene } = await vite.ssrLoadModule("/features/economy/ui/boat/scene/fishing-scene-painter.ts");
const { fishingBoatActorRig, fishingBoatActorPose } = await vite.ssrLoadModule("/features/economy/ui/boat/scene/fishing-scene-actor.ts");
const { fishingSceneFishAppearance, fishingSceneFishMotion } = await vite.ssrLoadModule("/features/economy/ui/boat/scene/fishing-scene-fish.ts");
const { mountFishingScene } = await vite.ssrLoadModule("/features/economy/ui/boat/scene/fishing-scene-runtime.ts");
const { FishingSceneCanvas } = await vite.ssrLoadModule("/features/economy/ui/boat/scene/fishing-scene-canvas.tsx");
const { BOAT_ART_PARTS, BOAT_ASSEMBLY, boatArtworkLayers } = await vite.ssrLoadModule("/features/world/objects/fishing-boat/fishing-boat-artwork.ts");
const { FISHING_WATER_TEXTURE } = await vite.ssrLoadModule("/features/economy/ui/boat/scene/fishing-scene-background.ts");
const frame = () => ({ stage: "reeling", castKey: "cast-one", held: false, reel: { bar: 5000, fish: 5500, progress: 2500, zoneWidth: 3200 },
  boat: { repaired: true, upgrades: ["crate", "oars"] }, rodId: "brook_rod" });
const visual = { elapsed: 2, castElapsed: 2, stageElapsed: 2, still: true };

function environment() {
  const saved = new Map(), frames = new Map(), requests = [], observers = [], paints = [];
  const fishPaints = [];
  let serial = 0, now = 0, rect = { width: 390, height: 844 };
  function install(key, value) { saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value }); }
  function target() {
    const handlers = new Map();
    return { handlers, addEventListener(name, fn) { if (!handlers.has(name)) handlers.set(name, new Set()); handlers.get(name).add(fn); },
      removeEventListener(name, fn) { handlers.get(name)?.delete(fn); }, dispatch(name, event = {}) { for (const fn of handlers.get(name) ?? []) fn(event); } };
  }
  const calls = [], gradient = { addColorStop() {} };
  const context = new Proxy({}, { get(object, key) { if (key in object) return object[key];
    if (key === "createLinearGradient" || key === "createRadialGradient") return () => gradient;
    return (...args) => calls.push({ method: key, args }); } });
  const document = { ...target(), hidden: false, createElement() { return { width: 48, height: 48, getContext: () => context }; } };
  const media = { ...target(), matches: false };
  const window = { ...target(), devicePixelRatio: 3, matchMedia: () => media };
  const canvas = { ...target(), width: 0, height: 0, getContext: () => context, getBoundingClientRect: () => rect };
  install("document", document); install("window", window); install("__fishingScenePaints", paints); install("__fishingFishPaints", fishPaints);
  install("requestAnimationFrame", callback => { frames.set(++serial, callback); return serial; });
  install("cancelAnimationFrame", id => frames.delete(id));
  install("Image", class { naturalWidth = 1536; naturalHeight = 1024; set src(value) { this.path = value; if (value) requests.push(this); } get src() { return this.path; } });
  for (const name of ["ResizeObserver", "IntersectionObserver"]) install(name, class {
    constructor(callback) { this.callback = callback; this.name = name; this.disconnected = false; observers.push(this); }
    observe() {} disconnect() { this.disconnected = true; }
  });
  return { canvas, context, calls, frames, requests, paints, fishPaints, observers, window, document, media,
    step(milliseconds = 34) { now += milliseconds; const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(fn => fn(now)); },
    visibility(hidden) { document.hidden = hidden; document.dispatch("visibilitychange"); },
    intersect(visible) { observers.find(item => item.name === "IntersectionObserver").callback([{ target: canvas, isIntersecting: visible }]); },
    reduced(value) { media.matches = value; media.dispatch("change"); },
    resize(width, height) { rect = { width, height }; observers.find(item => item.name === "ResizeObserver").callback(); },
    finish(path, error = false) { const image = requests.findLast(item => item.path === path); assert.ok(image); if (error) image.onerror?.(); else image.onload?.(); return image; },
    restore() { for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; } },
  };
}

test("authored boat, hands and surface controls fit portrait and landscape above the control HUD", () => {
  for (const [width, height] of [[320, 568], [390, 844], [820, 375], [820, 390], [1280, 720], [1600, 900]]) {
    const value = frame(), before = structuredClone(value), g = fishingSceneGeometry(width, height, value, visual);
    assert.deepEqual(value, before);
    assert.ok(g.boat.x >= 0 && g.boat.x + 1000 * g.boat.scale <= g.width);
    assert.ok(920 * g.boat.scale * g.scale >= Math.min(width * .26, 170), "the modular boat remains legible at 320px");
    assert.ok(g.hook.y >= g.waterTop && g.hook.y <= g.waterBottom);
    assert.ok(g.fish.y >= g.waterTop && g.fish.y <= g.waterBottom);
    const hud = height < 500 && width > height ? 185 : width < 700 ? 280 : 260;
    assert.ok(g.waterBottom * g.scale <= height - hud, "the depth range stays above the floating controls");
    assert.ok(g.actor.foot.y > g.actor.size && g.actor.foot.x < g.grip.x);
    for (const end of [0, 10000]) {
      const endpoint = fishingSceneGeometry(width, height, { ...value, reel: { ...value.reel, bar: end, fish: end } }, visual);
      assert.ok(endpoint.float.y * endpoint.scale <= height - hud - 24 + 1e-8, "low float endpoint clears the full feedback HUD");
      assert.ok(endpoint.fish.y * endpoint.scale >= 68 - 1e-8, "high fish endpoint clears the landscape header");
    }
  }
});

test("the surface bobber reacts to tension and catch distance while tracking stays inside the separate meter", () => {
  const value = frame(), base = fishingSceneGeometry(390, 844, value, visual);
  const raised = fishingSceneGeometry(390, 844, { ...value, held: true, reel: { ...value.reel, bar: 9000, fish: 1000, progress: 8500 } }, visual);
  assert.ok(Math.abs(raised.hook.y - base.hook.y) * base.scale <= 3, "the control zone does not drag the float through an imaginary water column");
  assert.ok(raised.hook.x < base.hook.x);
  const live = { ...visual, still: false };
  const relaxed = fishingSceneGeometry(390, 844, value, live);
  const pulling = fishingSceneGeometry(390, 844, { ...value, held: true }, live);
  assert.ok(pulling.tension > relaxed.tension); assert.notDeepEqual(pulling.tip, relaxed.tip);
  assert.deepEqual(base.float, base.hook, "the line and float share the same water endpoint");
  assert.deepEqual(raised.float, raised.hook);
  assert.ok(Math.hypot(raised.grip.x - base.grip.x, raised.grip.y - base.grip.y) < 2, "the handle follows bounded torso effort, not an independent prop");
  assert.deepEqual(raised.grip, raised.onBoat(raised.actorRig.nearArm.hand), "rod pivot remains the exact gripping hand");
  const stopped = fishingSceneGeometry(390, 844, value, { ...visual, still: true, elapsed: 1000 });
  assert.deepEqual([stopped.boat, stopped.tip, stopped.float, stopped.hook, stopped.fish],
    [base.boat, base.tip, base.float, base.hook, base.fish], "reduced motion retains a stable pose while controls remain public inputs");
  const airborne = fishingSceneGeometry(390, 844, { ...value, stage: "casting" }, { ...visual, still: false, castElapsed: .6 });
  const landed = fishingSceneGeometry(390, 844, { ...value, stage: "soaking" }, { ...visual, still: false, castElapsed: 2 });
  assert.ok(airborne.casting); assert.ok(airborne.float.y < airborne.surface); assert.equal(landed.casting, false);
});

test("painting composes real hull modules around Mochlik and never substitutes a procedural boat", () => {
  const env = environment();
  try {
    const value = frame();
    const layers = boatArtworkLayers(value.boat);
    const images = new Map(layers.map(part => [part.src, { id: part.id, naturalWidth: part.source[0], naturalHeight: part.source[1] }]));
    paintFishingScene(env.context, frame(), images, { width: 390, height: 844, dpr: 2 }, visual);
    const isActorOrBoat = call => call.method === "drawImage" &&
      (call.args[0].id || call.args[0].width === 48 && call.args[0].height === 48);
    const draws = env.calls.filter(isActorOrBoat);
    assert.deepEqual(draws.map(call => call.args[0].id ?? "mochlik"), ["repair", "fuel_hose", "engine", "tank", "mochlik", "repair", "oars"]);
    assert.ok(value.boat.upgrades.includes("crate"), "the saved storage upgrade remains owned");
    assert.equal(draws.some(call => call.args[0].id === "crate"), false, "storage has no visible crate or mounting layer");
    assert.deepEqual(draws[0].args.slice(1, 5), [...BOAT_ART_PARTS.repair.crop]);
    assert.ok(env.calls.some(call => call.method === "clip"), "front planks occlude the seated feet");
    env.calls.length = 0; paintFishingScene(env.context, frame(), new Map(), { width: 320, height: 568, dpr: 1 }, visual);
    assert.equal(env.calls.some(isActorOrBoat), false, "missing hull art does not leave a floating actor or drawn replacement hull; cached scenery can still paint");
  } finally { env.restore(); }
});

test("the water float stays near its cast point rather than following vertical meter limits", () => {
  const base = fishingSceneGeometry(390, 844, frame(), visual);
  for (const bar of [0, 700, 5000, 9400, 10000]) for (const fish of [0, 1000, 2000, 5000, 8000, 9000, 10000]) {
    const value = frame(); value.reel.bar = bar; value.reel.fish = fish;
    const g = fishingSceneGeometry(390, 844, value, visual);
    assert.deepEqual(g.float, base.float); assert.deepEqual(g.fish, base.fish);
  }
});

test("the hooked fish remains hidden through the local result and is revealed only for a confirmed landing", () => {
  const env = environment();
  try {
    for (const stage of ["waiting", "casting", "bite", "reeling", "paused", "caught", "pending", "escaped", "expired"]) {
      paintFishingScene(env.context, { ...frame(), stage, fishId: "fish_mooncarp" }, new Map(), { width: 1280, height: 720, dpr: 1 }, visual);
    }
    assert.equal(env.fishPaints.length, 0);
    paintFishingScene(env.context, { ...frame(), stage: "landed" }, new Map(), { width: 1280, height: 720, dpr: 1 }, visual);
    assert.equal(env.fishPaints.length, 0);
    paintFishingScene(env.context, { ...frame(), stage: "landed", fishId: "fish_mooncarp" }, new Map(), { width: 1280, height: 720, dpr: 1 }, visual);
    assert.equal(env.fishPaints.length, 1); assert.equal(env.fishPaints[0].frame.fishId, "fish_mooncarp");
  } finally { env.restore(); }
});

test("a confirmed fish lift keeps its line connected after the completed challenge has been removed", () => {
  const env = environment();
  try {
    const value = { ...frame(), stage: "landed", castKey: undefined, catchKey: "confirmed:0", fishId: "fish_mooncarp" };
    const view = { width: 1280, height: 720, dpr: 1 }, clock = { ...visual, still: false, stageElapsed: .5 };
    const geometry = fishingSceneGeometry(view.width, view.height, value, clock);
    const images = new Map([[BOAT_ART_PARTS.repair.src, { id: "repair", naturalWidth: 1536, naturalHeight: 1024 }]]);
    paintFishingScene(env.context, value, images, view, clock);
    assert.ok(env.calls.some(call => call.method === "quadraticCurveTo" && call.args.at(-2) === geometry.hook.x && call.args.at(-1) === geometry.hook.y));
    assert.equal(env.fishPaints.length, 1);
  } finally { env.restore(); }
});

test("portrait water fills CSS coordinates from one large lake crop before the boat view scale", () => {
  const env = environment();
  try {
    const water = { naturalWidth: 1024, naturalHeight: 1024 };
    paintFishingScene(env.context, frame(), new Map([[FISHING_WATER_TEXTURE, water]]),
      { width: 390, height: 844, dpr: 2 }, visual);
    const covers = env.calls.filter(call => call.method === "drawImage" && call.args[0] === water);
    assert.equal(covers.length, 1, "the raster itself has no repeated tile or fractional strip joins");
    const [, sx, sy, sw, sh, dx, dy, dw, dh] = covers[0].args;
    assert.deepEqual([dx, dy, dw, dh], [0, 0, 390, 844], "the cover is not shrunk by the assembly's logical scale");
    assert.ok(sx >= 0 && sy >= 0 && sx + sw <= 1024 && sy + sh <= 1024);
    assert.ok(Math.abs(sw / sh - 390 / 844) < 1e-8);
  } finally { env.restore(); }
});

test("canvas runtime caps DPR/frame rate, pauses offscreen and cleans up late image completions", () => {
  const env = environment(), value = { ...frame(), stage: "waiting" }, runtime = mountFishingScene(env.canvas, value);
  try {
    assert.equal(env.canvas.width, 780); assert.equal(env.canvas.height, 1688);
    assert.deepEqual(env.requests.map(image => image.path).sort(), [...boatArtworkLayers(value.boat).map(part => part.src), FISHING_WATER_TEXTURE].sort());
    assert.ok(value.boat.upgrades.includes("crate"));
    assert.equal(env.requests.some(image => image.path.includes("module-crate")), false, "owned storage never loads an obsolete visible crate");
    for (let i = 0; i < 61; i++) env.step(1000 / 60);
    assert.ok(env.paints.length >= 28 && env.paints.length <= 32, "visible painting averages at most 30fps rather than following every RAF");
    const age = env.paints.at(-1).visual.castElapsed, count = env.paints.length;
    env.visibility(true); assert.equal(env.frames.size, 0); env.step(5000); assert.equal(env.paints.length, count);
    env.visibility(false); env.step(); assert.ok(Math.abs(env.paints.at(-1).visual.castElapsed - age) <= 1 / 30,
      "hidden time cannot fast-forward a cast; the last unpainted RAF may add one frame");
    env.intersect(false); assert.equal(env.frames.size, 0); env.intersect(true); env.step();
    env.reduced(true); assert.equal(env.frames.size, 0); assert.equal(env.paints.at(-1).visual.still, true);
    const staticCount = env.paints.length; env.finish(BOAT_ART_PARTS.repair.src); assert.ok(env.paints.length > staticCount, "image arrival redraws a static scene");
    env.finish(BOAT_ART_PARTS.tank.src, true); const failedCount = env.requests.length;
    env.window.dispatch("online"); assert.equal(env.requests.length, failedCount + 1, "a failed part retries only on an explicit recovery event");
    env.resize(320, 568); assert.equal(env.canvas.width, 640); assert.equal(env.canvas.height, 1136);
    const late = env.requests.find(image => image.path.endsWith("module-oars.webp")).onload;
    runtime.dispose(); const disposedCount = env.paints.length; late(); env.step(1000);
    assert.equal(env.frames.size, 0); assert.equal(env.paints.length, disposedCount); assert.ok(env.observers.every(observer => observer.disconnected));
    assert.ok([...env.document.handlers.values(), ...env.window.handlers.values(), ...env.canvas.handlers.values(), ...env.media.handlers.values()].every(handlers => handlers.size === 0));
  } finally { runtime.dispose(); env.restore(); }
});

test("a repeated cast key does not replay; paused motion stops while completed outcomes retain living water", () => {
  const env = environment(), value = frame(), runtime = mountFishingScene(env.canvas, value);
  try {
    for (let i = 0; i < 12; i++) env.step(100);
    const age = env.paints.at(-1).visual.castElapsed;
    runtime.update({ ...value, held: true }); env.step(50); assert.ok(env.paints.at(-1).visual.castElapsed >= age);
    runtime.update({ ...value, stage: "paused" }); assert.equal(env.frames.size, 0); const pausedAge = env.paints.at(-1).visual.castElapsed;
    env.step(3000); runtime.update(value); env.step(); assert.equal(env.paints.at(-1).visual.castElapsed, pausedAge);
    runtime.update({ ...value, castKey: "cast-two" }); env.step(34); assert.ok(env.paints.at(-1).visual.castElapsed < .1);
    runtime.update({ ...value, castKey: "cast-one" }); env.step(34); assert.ok(env.paints.at(-1).visual.castElapsed > 0, "an old key remains seen");
    runtime.update({ ...value, stage: "caught" }); for (let i = 0; i < 25; i++) env.step(100); assert.equal(env.frames.size, 1);
    const afterCatch = env.paints.at(-1).visual.elapsed;
    runtime.update({ ...value, stage: "pending" }); env.step(100); assert.equal(env.frames.size, 1);
    runtime.update({ ...value, stage: "expired" }); env.step(100); assert.equal(env.frames.size, 1);
    assert.ok(env.paints.at(-1).visual.elapsed > afterCatch, "the water clock continues after the finite catch effect");
    env.reduced(true); assert.equal(env.frames.size, 0);
    const html = renderToStaticMarkup(createElement(FishingSceneCanvas, { frame: value, className: "fishingViewport" }));
    assert.match(html, /<canvas[^>]+class="fishingViewport"/); assert.match(html, /aria-hidden="true"/);
    assert.doesNotMatch(html, /<button|<img|<svg/);
  } finally { runtime.dispose(); env.restore(); }
});


test("two compact arms remain below the face and share exact grip anchors through cast, wait and lift", () => {
  const waiting = fishingBoatActorRig("soaking", 2, false, 3, false);
  const pulling = fishingBoatActorRig("reeling", 2, true, 3, false);
  assert.ok(waiting.tip.y > waiting.grip.y, "the cast rod points low over the surface while waiting");
  assert.ok(pulling.tip.y < pulling.grip.y, "a real pull raises the same rod around its grip");
  for (const stage of ["waiting", "casting", "soaking", "bite", "reeling", "caught", "landed"]) for (const elapsed of [.1, .4, .8, 1.2, 2]) {
    const rig = fishingBoatActorRig(stage, elapsed, true, 3, false);
    const faceBottom = rig.actor.foot.y - rig.actor.size * .22;
    for (const arm of [rig.nearArm, rig.farArm]) {
      assert.ok(arm.reachable, "hands never stretch a short arm beyond its two bones");
      assert.ok(arm.hand.y > faceBottom && arm.elbow.y > faceBottom, "visible forearms and palms stay below the current face");
      assert.ok(arm.hand.y < rig.actor.foot.y && arm.elbow.y < rig.actor.foot.y, "arms stay on the compact torso above the seated feet");
      assert.ok(Math.hypot(arm.hand.x - arm.shoulder.x, arm.hand.y - arm.shoulder.y) < rig.actor.size * .33);
    }
    assert.ok(rig.actor.foot.y > BOAT_ASSEMBLY.foredeck, "the side hull's front planks occlude the seated feet");
    assert.deepEqual(rig.grip, rig.nearArm.hand);
    assert.ok(Math.hypot(rig.grip.x - waiting.grip.x, rig.grip.y - waiting.grip.y) < 4, "breathing and effort move the same handle only within the compact torso");
  }
});

test("active fish reveal only the public class, while a confirmed landing uses its actual catalog species", () => {
  const classes = ["common", "uncommon", "rare", "epic", "legendary"];
  const appearances = classes.map(fishRarity => fishingSceneFishAppearance({ fishRarity, stage: "reeling", fishId: "fish_shark" }));
  assert.equal(new Set(appearances.map(item => item.colors[0])).size, classes.length);
  for (let index = 0; index < classes.length; index++) {
    assert.equal(appearances[index].species, "fish"); assert.equal(appearances[index].revealed, false);
    if (index) assert.ok(appearances[index].size > appearances[index - 1].size);
  }
  assert.equal(fishingSceneFishAppearance({ stage: "caught", fishId: "fish_shark" }).revealed, false);
  const landed = fishingSceneFishAppearance({ stage: "landed", fishId: "fish_mooncarp", fishRarity: "rare" });
  assert.equal(landed.species, "fish_mooncarp"); assert.equal(landed.revealed, true);
});

test("a restored waiting cast stays landed and server bite cannot restart its flight", () => {
  const env = environment(), value = { ...frame(), stage: "soaking" }, runtime = mountFishingScene(env.canvas, value);
  try {
    env.step(34); assert.ok(env.paints.at(-1).visual.castElapsed >= 1.2);
    runtime.update({ ...value, stage: "bite" }); env.step(34);
    assert.ok(env.paints.at(-1).visual.castElapsed >= 1.2);
    runtime.update({ ...value, stage: "casting", castKey: "new-flight" }); env.step(34);
    assert.ok(env.paints.at(-1).visual.castElapsed < .1);
    runtime.update({ ...value, castKey: "new-flight" }); env.step(34);
    assert.ok(env.paints.at(-1).visual.castElapsed >= 1.2, "authoritative soaking lands even after a delayed response");
    runtime.update({ ...value, stage: "landed", fishId: "fish_mooncarp" });
    for (let i = 0; i < 25; i++) env.step(100);
    assert.equal(env.frames.size, 1, "finite landing effects leave water and buoyancy alive");
    assert.ok(env.paints.at(-1).visual.stageElapsed >= 1.6);
  } finally { runtime.dispose(); env.restore(); }
});

test("pose changes ease through a pull without moving public game coordinates or catching up hidden time", () => {
  const env = environment(), value = { ...frame(), stage: "soaking" }, runtime = mountFishingScene(env.canvas, value);
  try {
    for (let index = 0; index < 12; index++) env.step(34);
    const before = env.paints.at(-1).visual.pose.angle;
    const pulling = { ...value, stage: "reeling", held: true };
    runtime.update(pulling); env.step(34);
    const first = env.paints.at(-1).visual.pose.angle;
    assert.ok(Math.abs(first - before) < .22, "the first pull frame cannot snap the rod to its full raised pose");
    for (let index = 0; index < 14; index++) env.step(34);
    const settled = env.paints.at(-1);
    assert.ok(settled.visual.pose.angle < before - .3, "the pose actually follows through into the pull");
    assert.deepEqual(settled.frame.reel, pulling.reel, "presentation easing cannot alter the hit zone or replay state");
    const previous = settled.visual.pose.angle;
    runtime.update({ ...pulling, stage: "paused", held: false });
    assert.equal(env.frames.size, 0);
    assert.deepEqual(env.paints.at(-1).visual.pose, settled.visual.pose, "pause freezes the visible rig instead of lowering it");
    const pausedClock = env.paints.at(-1).visual.elapsed;
    const pausedBeat = env.paints.at(-1).visual.stageElapsed;
    env.step(1000); runtime.update(pulling); env.step(34);
    assert.equal(env.paints.at(-1).visual.elapsed, pausedClock);
    assert.equal(env.paints.at(-1).visual.stageElapsed, pausedBeat, "resume cannot trigger another strike animation");
    assert.equal(env.paints.at(-1).visual.pose.angle, previous);
    env.visibility(true); env.step(10000); env.visibility(false); env.step(34);
    assert.ok(Math.abs(env.paints.at(-1).visual.pose.angle - previous) < .05, "resuming cannot replay ten seconds of hidden movement");
    env.reduced(true); assert.equal(env.frames.size, 0);
  } finally { runtime.dispose(); env.restore(); }
});


test("authored cast has preparation, forward release and calm followthrough with bounded compact poses", () => {
  const start = fishingBoatActorPose("casting", 0, false, 0, false);
  const backswing = fishingBoatActorPose("casting", .25, false, .25, false);
  const release = fishingBoatActorPose("casting", .73, false, .73, false);
  const settled = fishingBoatActorPose("casting", 1.2, false, 1.2, false);
  assert.ok(backswing.angle < start.angle - 1.5);
  assert.ok(release.angle > backswing.angle + 1.5);
  assert.ok(Math.abs(settled.angle - fishingBoatActorPose("soaking", 2, false, 2, false).angle) < .03);
  for (const stage of ["casting", "soaking", "bite", "reeling", "caught", "landed"]) for (let index = 0; index <= 30; index++) {
    const age = index / 10, pose = fishingBoatActorPose(stage, age, index % 2 === 0, age, false, age);
    const rig = fishingBoatActorRig(stage, age, index % 2 === 0, age, false, pose, age);
    const faceBottom = rig.actor.foot.y - rig.actor.size * .22;
    assert.ok(Number.isFinite(pose.angle) && Math.abs(pose.angle) < 2);
    assert.ok(rig.nearArm.reachable && rig.farArm.reachable);
    for (const arm of [rig.nearArm, rig.farArm]) assert.ok(arm.hand.y > faceBottom && arm.elbow.y > faceBottom);
  }
});

test("strike and landing reactions finish while the fish tail rests under reduced motion", () => {
  const strike = fishingBoatActorPose("reeling", 2, false, 0, false, .275);
  const settled = fishingBoatActorPose("reeling", 2, false, 0, false, 2);
  assert.ok(strike.angle < settled.angle - .3);
  assert.deepEqual(fishingBoatActorPose("landed", 2, false, 2, false, 2), fishingBoatActorPose("landed", 2, false, 2, false, 3));
  assert.equal(fishingSceneFishMotion("landed", 4, false, 2).tail, 0);
  assert.equal(fishingSceneFishMotion("reeling", 4, true).tail, 0);
  assert.deepEqual(fishingBoatActorPose("reeling", 2, true, 4, true), fishingBoatActorPose("reeling", 2, true, 40, true));
  assert.ok(fishingBoatActorPose("reeling", 2, true, 4, true).effort > fishingBoatActorPose("reeling", 2, false, 4, true).effort);
});


test("the casting arc keeps its float inside the viewport on medium and short screens", () => {
  for (const [width, height] of [[960,540],[1280,720],[390,844],[820,390]]) for (let tick = 0; tick <= 60; tick++) {
    const age = tick / 50;
    const geometry = fishingSceneGeometry(width, height, { ...frame(), stage: "casting" },
      { elapsed: age, castElapsed: age, stageElapsed: age, still: false });
    assert.ok(geometry.float.y * geometry.scale >= 20, "float glyph clears the top edge throughout the flight");
  }
});

test("confirmed catch identities never replay the finite reveal through polling, reopening or old-key transitions", () => {
  const env = environment(), value = frame(), runtime = mountFishingScene(env.canvas, value);
  const catchFrame = { ...value, stage: "landed", catchKey: "voyage:1", fishId: "fish_mooncarp" };
  try {
    runtime.update(catchFrame); env.step(34);
    assert.ok(env.paints.at(-1).visual.stageElapsed < .1);
    for (let index = 0; index < 18; index++) env.step(100);
    const age = env.paints.at(-1).visual.stageElapsed;
    runtime.update({ ...catchFrame }); env.step(34);
    assert.ok(env.paints.at(-1).visual.stageElapsed >= age);
    runtime.update({ ...value, stage: "waiting" }); env.step(34);
    runtime.update(catchFrame); env.step(34);
    assert.ok(env.paints.at(-1).visual.stageElapsed >= 2, "an already seen receipt has no second glow/droplet flourish");
    runtime.dispose();
    const reopened = mountFishingScene(env.canvas, catchFrame);
    env.step(34); assert.ok(env.paints.at(-1).visual.stageElapsed >= 2);
    reopened.dispose();
  } finally { runtime.dispose(); env.restore(); }
});


test("coarse server-clock updates still show a pre-bite nibble without starting the actual bite", () => {
  const env = environment(), value = { ...frame(), stage: "soaking", biteLeadSeconds: 1 }, runtime = mountFishingScene(env.canvas, value);
  try {
    for (let index = 0; index < 16; index++) env.step(50);
    const paint = env.paints.at(-1);
    assert.equal(paint.frame.stage, "soaking");
    assert.ok(paint.frame.biteLeadSeconds > .1 && paint.frame.biteLeadSeconds < .4);
    assert.ok(paint.visual.pose.lean > 0, "Mochlik can notice the visual nibble between clock updates");
    assert.deepEqual(paint.frame.reel, value.reel);
    assert.ok(fishingBiteMotion(paint.frame.stage, paint.visual.stageElapsed, paint.frame.biteLeadSeconds, false).dip > 1);
    runtime.update({ ...value }); env.step(50);
    assert.ok(env.paints.at(-1).frame.biteLeadSeconds < paint.frame.biteLeadSeconds, "an unchanged parent poll cannot restart the visible nibble clock");
    const lead = env.paints.at(-1).frame.biteLeadSeconds;
    env.visibility(true); env.step(5000); env.visibility(false); env.step(34);
    assert.ok(Math.abs(env.paints.at(-1).frame.biteLeadSeconds - lead) < .05, "hidden time is not replayed as a missed nibble");
  } finally { runtime.dispose(); env.restore(); }
});


test("new visible casts and bites add one inertial response, while repeated keys never replay it", () => {
  function response(action, repeated = false, fresh = true) {
    const env = environment(), value = { ...frame(), stage: action === "bite" ? "soaking" : "waiting", held: false };
    const runtime = mountFishingScene(env.canvas, value);
    try {
      env.step(34);
      const next = { ...value, stage: action === "bite" ? "bite" : "casting", castKey: fresh ? "fresh-action" : value.castKey };
      // A bite belongs to the existing soaked cast, unlike the beginning of a new flight.
      if (action === "bite") next.castKey = value.castKey;
      runtime.update(next); env.step(34);
      if (repeated) {
        if (action === "bite") runtime.update({ ...next, stage: "soaking" });
        runtime.update({ ...next });
      }
      for (let index = 0; index < 8; index++) env.step(34);
      return env.paints.at(-1).visual.boatMotion;
    } finally { runtime.dispose(); env.restore(); }
  }
  for (const action of ["cast", "bite"]) assert.deepEqual(response(action, true), response(action, false));
  const newCast = response("cast"), oldCast = response("cast", false, false);
  assert.ok(Math.abs(newCast.bob - oldCast.bob) > .2, "a genuinely new cast visibly displaces the floating hull");
  assert.ok(Math.abs(newCast.surge - oldCast.surge) > .2, "the cast also has a little horizontal recoil");
});

test("inertial heave, roll and surge freeze on pause and hidden resume; hidden actions cannot leave a delayed kick", () => {
  const env = environment(), value = { ...frame(), held: true }, runtime = mountFishingScene(env.canvas, value);
  try {
    for (let index = 0; index < 20; index++) env.step(34);
    const motion = env.paints.at(-1).visual.boatMotion;
    runtime.update({ ...value, stage: "paused", held: false });
    assert.deepEqual(env.paints.at(-1).visual.boatMotion, motion);
    env.step(5000); runtime.update(value); env.step(34);
    assert.deepEqual(env.paints.at(-1).visual.boatMotion, motion, "resuming starts with zero elapsed delta");
    env.visibility(true); env.step(5000); env.visibility(false); env.step(34);
    assert.deepEqual(env.paints.at(-1).visual.boatMotion, motion, "hidden time never advances or resets the stored spring");
    env.reduced(true);
    assert.deepEqual(env.paints.at(-1).visual.boatMotion, { bob: 0, roll: 0, surge: 0 });
    assert.equal(env.frames.size, 0);
    runtime.update({ ...value, held: false }); env.step(1000);
    assert.deepEqual(env.paints.at(-1).visual.boatMotion, { bob: 0, roll: 0, surge: 0 });
    assert.equal(env.frames.size, 0);
  } finally { runtime.dispose(); env.restore(); }
  function hiddenCast(fresh) {
    const e = environment(), initial = { ...frame(), stage: "waiting", held: false }, mounted = mountFishingScene(e.canvas, initial);
    try {
      for (let tick = 0; tick < 5; tick++) e.step(34);
      e.visibility(true); e.step(5000);
      mounted.update({ ...initial, stage: "casting", castKey: fresh ? "hidden-new" : initial.castKey });
      e.visibility(false);
      for (let tick = 0; tick < 10; tick++) e.step(34);
      return e.paints.at(-1).visual.boatMotion;
    } finally { mounted.dispose(); e.restore(); }
  }
  assert.deepEqual(hiddenCast(true), hiddenCast(false), "a cast observed while hidden is marked seen without injecting a later recoil");
});


test("a live mid-cast pause freezes the airborne float through polling and resumes without a new inertial impulse", () => {
  function castRun(pause) {
    const env = environment(), value = { ...frame(), stage: "waiting", held: false }, runtime = mountFishingScene(env.canvas, value);
    try {
      env.resize(820, 390); env.step(34);
      const cast = { ...value, stage: "casting", castKey: "live-flight" };
      runtime.update(cast);
      for (let tick = 0; tick < 8; tick++) env.step(34);
      const before = env.paints.at(-1);
      const geometry = painted => fishingSceneGeometry(painted.viewport.width, painted.viewport.height, painted.frame, painted.visual);
      const airborne = geometry(before);
      assert.ok(before.visual.castElapsed > .1 && before.visual.castElapsed < 1.2);
      assert.ok(Math.hypot(airborne.float.x - airborne.hook.x, airborne.float.y - airborne.hook.y) > 2,
        "the test pauses an actual airborne cast, not an already landed float");
      if (pause) {
        const paused = { ...cast, stage: "paused" };
        runtime.update(paused);
        const first = env.paints.at(-1);
        assert.equal(env.frames.size, 0);
        assert.equal(paused.stage, "paused", "presentation cannot change the controller's paused stage");
        for (const key of ["castElapsed", "stageElapsed", "elapsed"]) assert.equal(first.visual[key], before.visual[key]);
        assert.deepEqual(first.visual.boatMotion, before.visual.boatMotion);
        assert.deepEqual(first.visual.pose, before.visual.pose);
        for (const key of ["boat", "tip", "float", "hook"]) assert.deepEqual(geometry(first)[key], airborne[key], `${key} cannot jump when the cast is paused`);
        env.step(5000); runtime.update({ ...paused });
        assert.deepEqual(env.paints.at(-1).visual, first.visual, "repeated paused polling cannot force castElapsed to the settled pose");
        assert.deepEqual(geometry(env.paints.at(-1)).float, airborne.float);
        runtime.update(cast); env.step(34);
        assert.deepEqual(env.paints.at(-1).visual, before.visual, "the first resumed tick has no catch-up delta or repeated kick");
        assert.deepEqual(geometry(env.paints.at(-1)).float, airborne.float);
      }
      env.step(34);
      const after = env.paints.at(-1);
      return { motion: after.visual.boatMotion, castElapsed: after.visual.castElapsed, stageElapsed: after.visual.stageElapsed,
        pose: after.visual.pose, float: geometry(after).float };
    } finally { runtime.dispose(); env.restore(); }
  }
  assert.deepEqual(castRun(true), castRun(false), "pause/resume continues the original spring velocities and flight clock exactly");
});

test("a restored paused cast or a paused replacement key keeps its line in the water", () => {
  const env = environment(), value = { ...frame(), stage: "paused", held: false, castKey: "restored-pause" };
  const runtime = mountFishingScene(env.canvas, value);
  const geometry = painted => fishingSceneGeometry(painted.viewport.width, painted.viewport.height, painted.frame, painted.visual);
  try {
    let painted = env.paints.at(-1);
    assert.equal(env.frames.size, 0);
    assert.ok(painted.visual.castElapsed >= 2);
    assert.deepEqual(geometry(painted).float, geometry(painted).hook);
    runtime.update({ ...value, stage: "casting", castKey: "visible-flight" });
    for (let tick = 0; tick < 6; tick++) env.step(34);
    painted = env.paints.at(-1);
    assert.ok(painted.visual.castElapsed < 1.2);
    const before = painted.visual.boatMotion;
    const replaced = { ...value, castKey: "different-restored-pause" };
    runtime.update(replaced);
    painted = env.paints.at(-1);
    assert.equal(painted.frame.stage, "paused", "a different key is a restored pause, never the preceding visual flight");
    assert.ok(painted.visual.castElapsed >= 2);
    assert.deepEqual(geometry(painted).float, geometry(painted).hook);
    assert.deepEqual(painted.visual.boatMotion, before, "a paused replacement does not inject an action impulse");
    runtime.update({ ...replaced });
    assert.deepEqual(geometry(env.paints.at(-1)).float, geometry(painted).float);
  } finally { runtime.dispose(); env.restore(); }
});
