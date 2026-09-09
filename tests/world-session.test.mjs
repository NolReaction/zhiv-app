import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(() => vite.close());
const { createWorldSession } = await vite.ssrLoadModule("/features/world/session.ts");
const { newWorldState } = await vite.ssrLoadModule("/features/world/model.ts");
const { homeAppearance, journeyLabel } = await vite.ssrLoadModule("/features/mochlik/home-state.ts");
const { createHabitat } = await vite.ssrLoadModule("/features/mochlik/habitat.ts");
const camera = await vite.ssrLoadModule("/features/world/camera.ts");
const now = Date.parse("2026-09-08T12:00:00Z");
const snapshot = (owner = "OWNER", revision = 0) => ({ ownerPublicId: owner, revision, serverTime: new Date(now).toISOString(), state: newWorldState(), gifts: [], dailySparksEarned: 0, catalogVersion: 1 });
const flush = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test("a late response from a previous owner cannot update the active account or lose its session", async () => {
  const oldRead = deferred(); let lost = 0;
  const old = createWorldSession("OLD", { get: () => oldRead.promise, send: async () => { throw Error(); } }, () => lost++);
  const deactivate = old.activate(); const read = old.refresh(); deactivate();
  const current = createWorldSession("NEW", { get: async () => snapshot("NEW"), send: async () => { throw Error(); } }, () => lost++);
  current.activate(); await current.refresh(); oldRead.resolve(snapshot("OLD", 50)); await read;
  assert.equal(old.getSnapshot().snapshot, null); assert.equal(current.getSnapshot().snapshot.ownerPublicId, "NEW"); assert.equal(lost, 0);
});

test("same-revision gifts refresh; older reads cannot undo wardrobe and house upgrades", async () => {
  let result = snapshot();
  const session = createWorldSession("OWNER", { get: async () => structuredClone(result), send: async () => { throw Error(); } }, () => assert.fail("wrong owner"));
  session.activate(); await session.refresh();
  result.gifts = ["flower"]; await session.refresh(); assert.deepEqual(session.getSnapshot().snapshot.gifts, ["flower"]);
  result.revision = 2; result.state.houseLevel = 3; result.state.workshop = true; result.state.equipment.neck = "amber_scarf";
  await session.refresh();
  result = snapshot("OWNER", 1); await session.refresh();
  const visible = session.getSnapshot().snapshot, home = homeAppearance(visible.state, visible.gifts);
  assert.equal(home.houseLevel, 3); assert.equal(home.workshop, true); assert.equal(home.equipment.neck, "amber_scarf"); assert.deepEqual(home.items, ["flower"]);
});

test("closing the map keeps an uncertain receipt and retry uses the identical command", async () => {
  const commands = []; let server = snapshot(); let charged = 0;
  const session = createWorldSession("OWNER", {
    get: async () => structuredClone(server),
    send: async command => {
      commands.push(structuredClone(command));
      if (commands.length === 1) { charged++; server.revision++; server.state.equipment.neck = "amber_scarf"; throw Error("response lost after commit"); }
      return { snapshot: structuredClone(server), message: "Шарф надет" };
    },
  }, () => assert.fail());
  session.activate(); await session.refresh();
  const unsubscribeMap = session.subscribe(() => {}); session.act("equip", "amber_scarf"); unsubscribeMap(); await flush();
  assert.equal(session.getSnapshot().uncertain, true);
  session.act("craft", "berry_scarf"); assert.equal(commands.length, 1);
  await session.retry(); assert.deepEqual(commands[1], commands[0]); assert.equal(charged, 1);
  assert.equal(session.getSnapshot().uncertain, false); assert.equal(session.getSnapshot().snapshot.state.equipment.neck, "amber_scarf");
});

test("background GET started before a command cannot overwrite its result", async () => {
  const read = deferred(); let count = 0;
  const session = createWorldSession("OWNER", { get: async () => ++count === 1 ? snapshot() : read.promise,
    send: async () => { const value = snapshot("OWNER", 1); value.state.houseLevel = 2; return { snapshot: value, message: "Дом готов" }; } }, () => assert.fail());
  session.activate(); await session.refresh(); const pendingRead = session.refresh(); session.act("upgrade_house"); await flush();
  read.resolve(snapshot()); await pendingRead; assert.equal(session.getSnapshot().snapshot.state.houseLevel, 2);
});

test("journey departure finishes the current bite, then suspends actions and keeps ecology", () => {
  const habitat = createHabitat(); habitat.elapse(130); habitat.invite("mushrooms");
  for (let i = 0; i < 5000 && habitat.state.activity !== "eat"; i++) habitat.update(.025);
  assert.equal(habitat.state.activity, "eat"); const eaten = habitat.state.eaten;
  habitat.setAway(true);
  for (let i = 0; i < 8000; i++) habitat.update(.025);
  assert.equal(habitat.state.eaten, eaten + 1); assert.equal(habitat.state.feedingId, null); assert.equal(habitat.state.prop, null); assert.equal(habitat.state.playing, false);
  assert.ok(habitat.state.mushrooms.every(item => item.growth === 1));
  habitat.restAfterAbsence(); habitat.setAway(false);
  assert.equal(habitat.state.wakeTapsNeeded, 1); assert.equal(habitat.state.resting, false);
  for (let i = 0; i < 1000 && habitat.state.activity !== "greet"; i++) habitat.update(.025);
  assert.equal(habitat.state.activity, "greet");
});

test("home journey status distinguishes travelling, rewards ready, and claimed", () => {
  const state = newWorldState(); state.journeys = [{ finishesAt: new Date(now + 60000).toISOString() }];
  assert.equal(journeyLabel(state, now), "В пути · ещё 1 мин");
  assert.equal(journeyLabel(state, now + 60000), "Вернулся с находками");
  assert.equal(homeAppearance(state).away, true);
  state.journeys = []; assert.equal(journeyLabel(state, now), null); assert.equal(homeAppearance(state).away, false);
});

test("camera zoom keeps the touched terrain point stable and clamps every viewport to map edges", () => {
  assert.deepEqual(camera.viewportPoint({ x: 105, y: 230 }, { left: 5, top: 30, width: 420, height: 840 }, { width: 400, height: 800 }), { x: 100 * 400 / 420, y: 200 * 800 / 840 });
  const view = { width: 393, height: 700 }, initial = { x: 384, y: 384, zoom: 1.6 }, anchor = { x: 155, y: 210 };
  const before = camera.screenToWorld(anchor, initial, view), zoomed = camera.zoomAt(initial, view, anchor, 1.35), afterZoom = camera.screenToWorld(anchor, zoomed, view);
  assert.ok(Math.hypot(before.x - afterZoom.x, before.y - afterZoom.y) < .000001);
  for (const dimensions of [view, { width: 1920, height: 1080 }, { width: 844, height: 390 }]) {
    for (const x of [-1e6, 384, 1e6]) {
      const bounded = camera.clampCamera({ x, y: -x, zoom: .001 }, dimensions);
      const first = camera.screenToWorld({ x: 0, y: 0 }, bounded, dimensions), last = camera.screenToWorld({ x: dimensions.width, y: dimensions.height }, bounded, dimensions);
      assert.ok(first.x >= -1e-6 && first.y >= -1e-6 && last.x <= camera.MAP_SIZE + .000001 && last.y <= camera.MAP_SIZE + .000001);
    }
  }
});

test("drag, pinch, cancellation and lost capture do not become map taps", () => {
  assert.equal(camera.isMapTap(2, false, false), true);
  assert.equal(camera.isMapTap(20, false, false), false);
  assert.equal(camera.isMapTap(0, true, false), false);
  assert.equal(camera.isMapTap(0, false, true), false);
});
