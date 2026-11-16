import assert from "node:assert/strict";
import test from "node:test";
import { browser, compactVillagerFixture, confirmedVillagers, dragMap, finishVillagerArtwork,
  flush, mapProjection, modules, options, quietClearing } from "./helpers/new-map-scene.mjs";

let sequence = 0;
async function setup() {
  const api = await modules(compactVillagerFixture()), env = browser();
  const owner = `arrival-camera-${++sequence}`, presenceKey = `zhiv:mochlik:presence:${owner}`;
  api.worldDevStore.patch({ ...quietClearing, autoLife: false });
  const canvas = env.surface(393, 665);
  const initial = { ...options, reducedMotion: false, presenceKey, serverNow: 100_000,
    economyBuildings: { quarry: 1, woodlot: 1 }, economyResidents: confirmedVillagers(owner, 1, 1, [], 1),
    residentArrival: { enabled: true, seen: false, onComplete() {} },
    lopukhArrival: { enabled: false, seen: false, onComplete() {} } };
  const loading = api.createMapEngine(canvas, initial, assert.fail, []);
  env.finish(); await flush(); await finishVillagerArtwork(env);
  const engine = await loading;
  const pointer = (type, x, y, pointerId = 1) => canvas.events.get(type)({
    type, clientX: x, clientY: y, pointerId, pointerType: "touch", button: 0,
  });
  return { api, env, canvas, engine, initial, pointer,
    close() { engine.dispose(); api.forgetForestSession(presenceKey); api.worldDevStore.reset(); env.restore(); } };
}

const gestures = {
  wheel: f => { f.canvas.events.get("wheel")({ clientX: 180, clientY: 300, deltaY: 150, preventDefault() {} }); f.canvas.flushFrame(); },
  drag: f => dragMap(f.canvas, 24, -15),
  pinch: f => {
    f.pointer("pointerdown", 150, 300); f.pointer("pointerdown", 250, 300, 2);
    f.pointer("pointermove", 210, 300, 2); f.canvas.flushFrame();
    f.pointer("pointerup", 210, 300, 2); f.pointer("pointerup", 150, 300); f.canvas.flushFrame();
  },
  keyboard: f => f.canvas.events.get("keydown")({ key: "ArrowDown", preventDefault() {} }),
  overview: f => f.engine.control("overview"),
};

for (const [name, gesture] of Object.entries(gestures)) test(`arrival camera stays released after ${name}, guide reentry and scene suspension`, async () => {
  const f = await setup();
  try {
    const overview = mapProjection(f.canvas);
    f.engine.setGuidePlace("quarry", 180);
    const captured = mapProjection(f.canvas);
    assert.ok(captured.zoom > overview.zoom, "the first arrival still receives its close initial framing");
    gesture(f);
    const manual = mapProjection(f.canvas);
    assert.notDeepEqual(manual, captured, "the real camera accepts the player's gesture");
    for (let i = 0; i < 3; i++) {
      f.engine.setGuidePlace(null);
      f.engine.update({ ...f.initial, backgrounded: true,
        residentArrival: { ...f.initial.residentArrival, enabled: false } });
      f.engine.update(f.initial);
      f.engine.setGuidePlace("quarry", 180 + i * 10);
      f.canvas.flushFrame();
      assert.deepEqual(mapProjection(f.canvas), manual, "the same live arrival cannot recapture after menus, coach changes or suspension");
    }
    f.env.resize(f.canvas);
    assert.deepEqual(mapProjection(f.canvas), manual, "a layout notification does not restore automatic follow");
    f.engine.control("pet");
    assert.notDeepEqual(mapProjection(f.canvas), manual, "an explicit center-on-character action still works");
  } finally { f.close(); }
});

test("releasing one resident leaves the next introduction and ordinary guide focus available", async () => {
  const f = await setup();
  try {
    f.engine.setGuidePlace("quarry", 180); gestures.wheel(f);
    const released = mapProjection(f.canvas);
    f.engine.update({ ...f.initial, residentArrival: { ...f.initial.residentArrival, enabled: false },
      lopukhArrival: { ...f.initial.lopukhArrival, enabled: true } });
    f.engine.setGuidePlace("lopukh-home", 180);
    assert.notDeepEqual(mapProjection(f.canvas), released, "a different newly arriving resident gets its own initial camera capture");
    gestures.overview(f);
    const overview = mapProjection(f.canvas);
    f.engine.setGuidePlace("leaftail-caravan", 180);
    assert.ok(mapProjection(f.canvas).zoom > overview.zoom, "ordinary explicit guide focus is unaffected");
  } finally { f.close(); }
});

test("moving an ordinary station guide before arrival cannot suppress the future introduction", async () => {
  const f = await setup();
  try {
    f.engine.update({ ...f.initial, residentArrival: { ...f.initial.residentArrival, enabled: false } });
    f.engine.setGuidePlace("quarry", 180); gestures.overview(f);
    const manual = mapProjection(f.canvas);
    f.engine.setGuidePlace(null);
    f.engine.update(f.initial);
    f.engine.setGuidePlace("quarry", 180);
    assert.ok(mapProjection(f.canvas).zoom > manual.zoom, "only a gesture during an active introduction can release its follow");
  } finally { f.close(); }
});

for (const releaseDuringGreeting of [false, true]) test(`arrival follow stays released through completion and greeting when gesture is ${releaseDuringGreeting ? "after" : "before"} completion`, async () => {
  const f = await setup();
  try {
    f.engine.setGuidePlace("quarry", 180);
    if (!releaseDuringGreeting) gestures.wheel(f);
    const greeting = { ...f.initial, residentArrival: { ...f.initial.residentArrival, enabled: false, seen: true, open: true } };
    f.engine.update(greeting);
    if (releaseDuringGreeting) gestures.wheel(f);
    const manual = mapProjection(f.canvas);
    for (let i = 0; i < 3; i++) {
      f.engine.setGuidePlace(null);
      f.engine.update({ ...greeting, backgrounded: true });
      f.engine.update(greeting);
      f.engine.setGuidePlace("quarry", 180 + i * 10);
      assert.deepEqual(mapProjection(f.canvas), manual, "the open greeting belongs to the same released arrival");
    }
    f.engine.update({ ...greeting, residentArrival: { ...greeting.residentArrival, open: false } });
    f.engine.setGuidePlace(null);
    f.engine.setGuidePlace("quarry", 180);
    assert.notDeepEqual(mapProjection(f.canvas), manual, "after greeting dismissal an ordinary explicit station guide can focus normally");
  } finally { f.close(); }
});
