import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { forestResidentDiagnostics, createResidentDiagnosticsStore } = await vite.ssrLoadModule("/features/world/dev/forest-resident-diagnostics.ts");
function state() {
  return { elapsed: 1, director: { reason: "Осматривает полянку" }, clearing: { position: { x: 100, y: 100 }, size: 40, stage: "home", routes: [], routeIndex: 0 },
    pleskMind: null, builderMind: null, villagers: { residents: Object.fromEntries(["lopukh", "kamneshmyg", "leaftail"].map((id, index) => [id, {
      id, available: index < 2, position: { x: 200 + index * 100, y: 200 }, intent: "wander", action: "walk", doorPhase: "outside", trafficWaiting: false,
      target: { id: `goal-${id}` }, route: { points: [{ x: 200 + index * 100, y: 200 }, { x: 250 + index * 100, y: 200 }], length: 50 }, distance: 10,
    }])) } };
}
test("diagnostics are detached immutable samples and blame only a neighbour intersecting the held path", () => {
  const source = state(), bunny = source.villagers.residents.lopukh;
  bunny.trafficWaiting = true; const before = structuredClone(source);
  const view = forestResidentDiagnostics(source, [
    { id: "plesk", position: { x: 180, y: 220 }, size: 36 },
    { id: "builder", position: { x: 230, y: 200 }, size: 40 },
  ], "dev:scene:1");
  assert.deepEqual(source, before); assert.equal(view.actors.find(item => item.id === "lopukh").blockingNeighbour, "builder");
  assert.equal(view.actors.find(item => item.id === "lopukh").remaining, 40);
  assert.equal(view.actors.find(item => item.id === "leaftail").available, false);
  assert.equal(view.actors.find(item => item.id === "kamneshmyg").blockingNeighbour, null);
  bunny.position.x = 999; assert.equal(view.actors.find(item => item.id === "lopukh").position.x, 200);
  assert.throws(() => { view.actors[0].position.x = 0; }, TypeError);
});
test("an unopened inspector does no sampling, active snapshots throttle and disposal cannot clear a newer scene", () => {
  const store = createResidentDiagnosticsStore(), unread = { get elapsed() { assert.fail("must not inspect natural state without subscribers"); } };
  store.report(unread, [], "account", true); assert.equal(store.getSnapshot(), null);
  let calls = 0; const off = store.subscribe(() => calls++), source = state();
  store.report(source, [], "account", false); assert.equal(calls, 0);
  store.report(source, [], "account", true); const first = store.getSnapshot(); assert.equal(calls, 1);
  store.report(source, [], "account", true); assert.equal(store.getSnapshot(), first); assert.equal(calls, 1);
  source.elapsed += .5; store.report(source, [], "account", true); assert.equal(calls, 2);
  store.report(source, [], "dev:scene:2", true); assert.equal(calls, 3);
  store.clear("account"); assert.equal(calls, 3); assert.equal(store.getSnapshot().source, "dev:scene:2");
  store.clear("dev:scene:2"); assert.equal(store.getSnapshot(), null); assert.equal(calls, 4);
  off(); store.report(unread, [], "account", true); assert.equal(calls, 4);
});
