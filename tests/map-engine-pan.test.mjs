import assert from "node:assert/strict";
import test from "node:test";
import { approximately, browser, clearingHome, flush, modules, options, quietClearing } from "./helpers/new-map-scene.mjs";

let sequence = 0;

// Only this integration fixture tracks affine transforms: ordinary scene tests
// deliberately record painter commands without emulating a full Canvas context.
function trackAffine(ctx) {
  let matrix = [1, 0, 0, 1, 0, 0];
  const stack = [], original = Object.fromEntries(["setTransform", "translate", "scale", "rotate", "transform", "save", "restore"].map(key => [key, ctx[key]]));
  const multiply = ([a, b, c, d, e, f]) => {
    const [aa, bb, cc, dd, ee, ff] = matrix;
    matrix = [aa * a + cc * b, bb * a + dd * b, aa * c + cc * d, bb * c + dd * d, aa * e + cc * f + ee, bb * e + dd * f + ff];
  };
  ctx.globalCompositeOperation = "source-over"; ctx.globalAlpha = 1;
  ctx.getTransform = () => Object.fromEntries(["a", "b", "c", "d", "e", "f"].map((key, index) => [key, matrix[index]]));
  ctx.setTransform = (...args) => { matrix = [...args]; original.setTransform(...args); };
  ctx.translate = (x, y) => { multiply([1, 0, 0, 1, x, y]); original.translate(x, y); };
  ctx.scale = (x, y) => { multiply([x, 0, 0, y, 0, 0]); original.scale(x, y); };
  ctx.rotate = angle => { multiply([Math.cos(angle), Math.sin(angle), -Math.sin(angle), Math.cos(angle), 0, 0]); original.rotate(angle); };
  ctx.transform = (...args) => { multiply(args); original.transform(...args); };
  ctx.save = () => { stack.push({ matrix: [...matrix], composite: ctx.globalCompositeOperation, alpha: ctx.globalAlpha }); original.save(); };
  ctx.restore = () => {
    const saved = stack.pop();
    if (saved) { matrix = saved.matrix; ctx.globalCompositeOperation = saved.composite; ctx.globalAlpha = saved.alpha; }
    original.restore();
  };
}

async function setup({ width = 393, height = 665, dpr = 1.5, root = true, speech = true, scene = {}, affine = false } = {}) {
  const { createMapEngine, worldDevStore, worldLightingEditorStore, connectForestSession, TILED_WORLD } = await modules({ sites: [clearingHome], ...scene });
  const env = browser();
  let engine, probe;
  worldDevStore.patch({ ...quietClearing, autoLife: false });
  window.devicePixelRatio = dpr;
  const canvas = env.surface(width, height), viewport = env.surface(width, height), overlay = env.surface(width, height);
  const marker = { dataset: { objectId: "home", kind: "house" }, style: {} };
  const samples = [], selections = [];
  canvas.style = { position: "relative", transform: "", width: "", height: "", left: "", top: "" };
  // Real canvas contexts expose their owning surface. The shared painter fixture
  // does not need it until an expanded viewport checks the physical crop bounds.
  canvas.context.canvas = canvas; overlay.context.canvas = overlay;
  if (affine) trackAffine(canvas.context);
  const initial = { ...options, reducedMotion: false, presenceKey: `map-pan-test-${++sequence}`, serverNow: 100_000 };
  try {
    const loading = createMapEngine(canvas, initial, assert.fail, [marker], undefined, {}, {
      onObjectAnchorsChange: value => samples.push(value), onSelectionChange: value => selections.push(value),
    }, speech ? overlay : undefined, root ? viewport : undefined);
    env.finish(); await flush(); env.finishPath("/test-residence.webp"); engine = await loading;
    engine.control("home"); engine.setSelectedObject("home");
    probe = connectForestSession(initial.presenceKey, TILED_WORLD, "circle", 0, 0, () => {});
  } catch (error) {
    worldDevStore.reset(); env.restore(); throw error;
  }
  const send = (type, x = 190, y = 320, pointerId = 1) => canvas.events.get(type)({
    type, pointerId, pointerType: "touch", button: 0, clientX: x, clientY: y,
  });
  const tick = time => env.tick(time);
  const frames = () => canvas.calls.flatMap((call, index) => {
    const next = canvas.calls[index + 1], center = canvas.calls[index + 2];
    return call.method === "setTransform" && next?.method === "fillRect" && center?.method === "translate"
      && center.args[0] === viewport.clientWidth / 2 && center.args[1] === viewport.clientHeight / 2
      ? [{ transform: call.args, background: next.args }] : [];
  });
  const active = () => canvas.style.position === "absolute";
  const pan = (time, x = 191.25, y = 320.5) => { send("pointerdown"); send("pointermove", x, y); tick(time); assert.equal(active(), true); };
  return { env, canvas, viewport, overlay, marker, samples, selections, initial, engine, probe, send, tick, frames, active, pan, worldLightingEditorStore,
    close() {
      probe.release(); engine.dispose(); worldLightingEditorStore.setEnabled(false); worldDevStore.reset(); env.restore();
    } };
}

const translation = canvas => canvas.style.transform.match(/translate\(([-\d.e+]+)px, ([-\d.e+]+)px\)/u).slice(1).map(Number);

test("fractional DPR pan keeps physical density and root input coordinates while updating markers and speech at 120Hz", async () => {
  const f = await setup();
  try {
    const { canvas, viewport, overlay, marker, samples, selections, probe, engine } = f;
    const width = canvas.width, height = canvas.height, ratioX = width / 393, ratioY = height / 665;
    const padX = Math.ceil(32 * ratioX), padY = Math.ceil(32 * ratioY);
    viewport.getBoundingClientRect = () => ({ left: 40, top: 25, width: 786, height: 1330 });
    canvas.getBoundingClientRect = () => assert.fail("input must measure the stationary viewport root");
    probe.state.social.current = { id: "pan-speech", speaker: "mochlik", text: "Привет!", elapsed: 1, duration: 4 };
    probe.publish();
    f.send("pointerdown", 420, 665); f.send("pointermove", 422.5, 666); f.tick(8);
    assert.equal(f.active(), true);
    assert.equal(canvas.width, width + padX * 2); assert.equal(canvas.height, height + padY * 2);
    assert.equal(overlay.width, width); assert.equal(overlay.height, height, "speech keeps its independent normal backing");
    assert.deepEqual(f.frames().at(-1).transform, [ratioX, 0, 0, ratioY, padX, padY]);
    approximately(parseFloat(canvas.style.left) * ratioX, -padX, "overscan starts on an integer backing pixel");
    approximately(parseFloat(canvas.style.width) * ratioX, canvas.width, "overscan retains horizontal DPR");
    const paintCount = f.frames().length, previousMarker = marker.style.transform, previousAnchor = samples.at(-1)[0], previousSelection = selections.at(-1);
    const text = () => overlay.calls.findLast(call => call.method === "fillText" && call.args[0] === "Привет!");
    const previousText = text().args;
    f.send("pointermove", 429, 668.5); f.tick(16);
    assert.equal(f.frames().length, paintCount, "the next 120Hz input frame reuses the raster");
    const [dx, dy] = translation(canvas);
    approximately(dx, 3.25, "CSS movement uses root CSS coordinates"); approximately(dy, 1.25, "fractional vertical movement");
    assert.notEqual(marker.style.transform, previousMarker);
    assert.ok(Math.abs(samples.at(-1)[0].x - previousAnchor.x - dx) <= 1, "rounded construction anchor follows the current camera");
    assert.ok(Math.abs(samples.at(-1)[0].y - previousAnchor.y - dy) <= 1, "rounded construction anchor y follows the current camera");
    assert.notDeepEqual(selections.at(-1), previousSelection, "selected menu is reprojected between world paints");
    approximately(text().args[1] - previousText[1], 3.25, "speech follows the compositor camera");
    approximately(text().args[2] - previousText[2], 1.25, "speech y follows the compositor camera");
    f.send("pointermove", 440, 674); f.tick(34);
    assert.equal(f.frames().length, paintCount, "the raster clock remains separate from input frames");
    f.tick(42);
    assert.equal(f.frames().length, paintCount + 1, "the normal 30Hz world paint refreshes a held drag");
    assert.deepEqual(translation(canvas), [0, 0]);
    f.send("pointermove", 550, 674); f.tick(50);
    assert.equal(f.frames().length, paintCount + 2, "crossing the spare border paints immediately without exposing an edge");
    assert.deepEqual(translation(canvas), [0, 0]);
    engine.setSelectedObject(null);
  } finally { f.close(); }
});

test("release and cancellation restore a freshly painted normal surface; direct API draws and zoom cannot reuse old pixels", async () => {
  const f = await setup();
  try {
    const normal = [f.canvas.width, f.canvas.height];
    f.pan(8); f.send("pointermove", 195.25, 322); f.tick(16);
    const beforeRelease = f.frames().length;
    f.send("pointerup", 195.25, 322);
    assert.equal(f.active(), false); assert.deepEqual([f.canvas.width, f.canvas.height], normal);
    assert.equal(f.frames().length, beforeRelease + 1, "release synchronously paints the exact camera");
    assert.equal(f.canvas.style.position, "relative"); assert.equal(f.canvas.style.transform, "");
    f.pan(24); const beforeNotice = f.frames().length; f.engine.notice();
    assert.equal(f.active(), false); assert.equal(f.frames().length, beforeNotice + 1, "explicit state changes get a direct world paint");
    f.send("pointermove", 194, 322); f.tick(32); assert.equal(f.active(), true);
    f.canvas.events.get("wheel")({ clientX: 190, clientY: 320, deltaY: -100, preventDefault() {} }); f.tick(40);
    assert.equal(f.active(), false, "a changed zoom rejects the previous raster camera");
    f.send("pointermove", 196, 323); f.tick(48); assert.equal(f.active(), true);
    f.send("pointercancel", 196, 323); assert.equal(f.active(), false);
    assert.deepEqual([f.canvas.width, f.canvas.height], normal);
    f.pan(56); f.engine.control("overview"); assert.equal(f.active(), false, "camera control is an exact direct draw");
    f.send("pointerup", 191.25, 320.5);
  } finally { f.close(); }
});

test("pinch discards the pan raster immediately and remains exact until every touch ends", async () => {
  const f = await setup();
  try {
    f.pan(8); f.send("pointermove", 195, 322); f.tick(16);
    f.send("pointerdown", 280, 320, 2);
    assert.equal(f.active(), false, "the second touch immediately restores a normal canvas");
    const count = f.frames().length;
    f.send("pointermove", 300, 325, 2); f.tick(24);
    assert.equal(f.frames().length, count + 1); assert.equal(f.active(), false);
    f.send("pointerup", 300, 325, 2);
    f.send("pointermove", 198, 324); f.tick(32); assert.equal(f.active(), false, "the remaining finger still belongs to the pinch gesture");
    f.send("pointerup", 198, 324);
    f.pan(40); assert.equal(f.active(), true, "a new one-finger gesture can use compositor pan again");
  } finally { f.close(); }
});

test("resize, guide, reduced motion and editor transitions paint the normal backing before further interaction", async () => {
  const f = await setup();
  try {
    f.pan(8);
    f.viewport.clientWidth = 665; f.viewport.clientHeight = 393; window.devicePixelRatio = 2; f.env.resize(f.viewport);
    assert.equal(f.active(), false); assert.equal(f.canvas.width, 1330); assert.equal(f.canvas.height, 786);
    assert.equal(f.overlay.width, 1330); assert.equal(f.overlay.height, 786);
    f.send("pointermove", 195, 322); f.tick(16); assert.equal(f.active(), true);
    f.engine.setGuidePlace("house", 120); assert.equal(f.active(), false);
    f.send("pointermove", 196, 323); f.tick(24); assert.equal(f.active(), false, "the guide outline always paints on the exact viewport");
    f.engine.setGuidePlace(null); f.send("pointermove", 197, 324); f.tick(32); assert.equal(f.active(), true);
    f.engine.update({ ...f.initial, reducedMotion: true }); assert.equal(f.active(), false);
    f.send("pointermove", 198, 325); f.tick(40); assert.equal(f.active(), false);
    f.engine.update(f.initial); f.send("pointermove", 199, 326); f.tick(48); assert.equal(f.active(), true);
    f.worldLightingEditorStore.setEnabled(true); f.tick(56); assert.equal(f.active(), false);
    assert.equal(f.marker.style.visibility, "hidden");
    f.send("pointerup", 199, 326); f.worldLightingEditorStore.setEnabled(false); f.tick(64);
    assert.equal(f.canvas.style.transform, "");
  } finally { f.close(); }
});

test("suspension finishes a visible pan frame and cancels captures so resume starts a new gesture", async () => {
  const f = await setup();
  try {
    f.pan(8); f.send("pointermove", 195, 322); f.tick(16);
    const count = f.frames().length;
    f.engine.update({ ...f.initial, backgrounded: true });
    assert.equal(f.active(), false);
    assert.equal(f.frames().length, count + 1, "the visible exit animation retains a painted normal surface after backing resize");
    assert.equal(f.canvas.hasPointerCapture(1), false, "suspended input cannot leave a stale held touch");
    assert.equal(f.env.frames.size, 0);
    f.engine.update(f.initial); f.pan(24);
    f.env.visibility(true);
    assert.equal(f.active(), false); assert.equal(f.canvas.hasPointerCapture(1), false); assert.equal(f.env.frames.size, 0);
    f.env.visibility(false); f.pan(32);
  } finally { f.close(); }
});

test("pan stays on the direct raster path without separate speech/root surfaces and above the pixel budget", async () => {
  for (const config of [{ root: false }, { speech: false }, { width: 1100, height: 1100, dpr: 2 }]) {
    const f = await setup(config);
    try {
      const normal = [f.canvas.width, f.canvas.height], count = f.frames().length;
      f.send("pointerdown"); f.send("pointermove", 194, 322); f.tick(8);
      assert.equal(f.active(), false); assert.deepEqual([f.canvas.width, f.canvas.height], normal);
      assert.equal(f.frames().length, count + 1);
      f.send("pointermove", 198, 324); f.tick(16);
      assert.equal(f.frames().length, count + 2, "ordinary input remains responsive when compositor reuse is unavailable");
    } finally { f.close(); }
  }
});


test("an incompatible feather mask retries the normal paint in the same frame and blocks expansion until a new gesture", async () => {
  const giantHome = { ...clearingHome, bounds: { x: 300, y: 300, width: 650, height: 650 }, anchor: { x: 650, y: 950 } };
  const crown = { id: "large-canopy", frontY: 1200, points: [{ x: 300, y: 300 }, { x: 1000, y: 300 }, { x: 1000, y: 1000 }, { x: 300, y: 1000 }] };
  const f = await setup({ width: 512, height: 512, dpr: 2, affine: true, scene: { sites: [giantHome], occluders: [crown] } });
  try {
    assert.deepEqual([f.canvas.width, f.canvas.height], [1024, 1024]);
    const count = f.frames().length;
    f.send("pointerdown"); f.send("pointermove", 194, 322); f.tick(8);
    const attempted = f.frames().slice(count);
    assert.equal(attempted.length, 2, "one input RAF paints expanded then immediately paints normal fallback");
    assert.deepEqual(attempted[0].transform, [2, 0, 0, 2, 64, 64]);
    assert.deepEqual(attempted[1].transform, [2, 0, 0, 2, 0, 0]);
    assert.equal(f.active(), false); assert.deepEqual([f.canvas.width, f.canvas.height], [1024, 1024]);
    const lastFrameStart = f.canvas.calls.findLastIndex(call => call.method === "fillRect" && call.args[2] === 512 && call.args[3] === 512);
    assert.ok(f.canvas.calls.slice(lastFrameStart).some(call => call.method === "drawImage" && call.args.length === 9 && call.args[0].getContext),
      "the replacement frame uses the bounded feathered subject layer, preserving the normal soft mask");
    const blocked = f.frames().length;
    f.send("pointermove", 198, 324); f.tick(16);
    assert.equal(f.frames().length, blocked + 1, "the same gesture does not retry incompatible overscan");
    assert.deepEqual(f.frames().at(-1).transform, [2, 0, 0, 2, 0, 0]);
    f.send("pointerup", 198, 324); f.tick(24);
    const fresh = f.frames().length;
    f.send("pointerdown"); f.send("pointermove", 194, 322); f.tick(32);
    assert.equal(f.frames().length, fresh + 2, "a new gesture retries compatibility instead of retaining a permanent fallback");
    assert.equal(f.active(), false);
  } finally { f.close(); }
});
