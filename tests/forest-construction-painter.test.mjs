import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { browser, modules, options, flush } from "./helpers/new-map-scene.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { forestConstructionProps, drawForestConstructionProp } = await vite.ssrLoadModule("/features/world/scene/forest-construction-painter.ts");
const now = Date.parse("2026-10-18T16:00:00Z"), owner = "confirmed-owner";
const line = siteId => ({ id: `${siteId}-work`, siteId, points: [{ x: 10, y: 50 }, { x: 28, y: 50 }], materials: true });
const scene = { constructionSites: ["home", "workshop", "lopukh-home", "campfire", "garden", "quarry", "bridge", "lighthouse"].map(line) };
const job = (stationId = "home", extra = {}) => ({ id: `job-${stationId}`, stationId, targetLevel: 2,
  startedAt: new Date(now - 1000).toISOString(), finishesAt: new Date(now + 1000).toISOString(), ...extra });
const snapshot = (jobs = [job()]) => ({ ownerPublicId: owner, revision: 2, jobs });

test("only confirmed matching-owner construction reveals props; ready jobs remain until collection", () => {
  for (const [value, key] of [[null, owner], [undefined, owner], [snapshot(), undefined], [snapshot(), "other-owner"],
    [{ ...snapshot(), revision: -1 }, owner]]) assert.deepEqual(forestConstructionProps(scene, value, now, key), []);
  const data = snapshot(), before = structuredClone(data), props = forestConstructionProps(scene, data, now, owner);
  assert.equal(props.filter(p => p.kind === "stake").length, 2);
  assert.equal(props.filter(p => p.kind === "rope").length, 1);
  assert.equal(props.filter(p => p.kind === "materials").length, 1);
  assert.equal(forestConstructionProps(scene, data, now + 1_000_000, owner), props, "ready work is still on site and uses the same prepared props");
  assert.deepEqual(forestConstructionProps(scene, snapshot([]), now + 1_000_000, owner), []);
  assert.deepEqual(data, before);
});

test("interior stations use the real shared host without duplicate fence stacks", () => {
  const one = forestConstructionProps(scene, snapshot([job("home")]), now, owner);
  for (const stations of [["home", "warehouse"], ["workshop", "kiln"], ["woodlot"], ["dryer"], ["garden"], ["quarry"], ["bridge"], ["lighthouse"]]) {
    const props = forestConstructionProps(scene, snapshot(stations.map(stationId => job(stationId))), now, owner);
    assert.equal(props.length, one.length, stations.join("+"));
  }
  assert.equal(forestConstructionProps(scene, snapshot([job("home"), job("kiln")]), now, owner).length, one.length * 2);
});

test("future/invalid jobs do not invent work; start and replacement geometry invalidate only the decoration cache", () => {
  const future = snapshot([job("home", { startedAt: new Date(now + 1000).toISOString(), finishesAt: new Date(now + 2000).toISOString() })]);
  assert.deepEqual(forestConstructionProps(scene, future, now, owner), []);
  const props = forestConstructionProps(scene, future, now + 1000, owner); assert.ok(props.length);
  assert.deepEqual(forestConstructionProps(scene, future, now, owner), [], "clock reversal never reveals a future build");
  for (const changed of [{ startedAt: "bad" }, { finishesAt: "bad" }, { targetLevel: 0 }, { targetLevel: 1.5 },
    { stationId: "__proto__" }, { finishesAt: new Date(now - 2000).toISOString() }]) {
    assert.deepEqual(forestConstructionProps(scene, snapshot([job("home", changed)]), now, owner), []);
  }
  const changed = { ...scene, constructionSites: [line("home")] }; changed.constructionSites[0].points[0].x += 2;
  assert.notEqual(forestConstructionProps(changed, future, now + 1000, owner), props);
});

test("short pieces have bounded foot depth and painter preserves the surrounding canvas state", () => {
  const props = forestConstructionProps(scene, snapshot(), now, owner), calls = [];
  const context = new Proxy({}, { get: (_, name) => (...args) => calls.push([name, ...args]), set: () => true });
  for (const prop of props) {
    assert.ok(Number.isFinite(prop.y)); assert.ok(prop.bounds.width > 0 && prop.bounds.height > 0);
    drawForestConstructionProp(context, prop);
  }
  assert.equal(calls.filter(c => c[0] === "save").length, props.length);
  assert.equal(calls.filter(c => c[0] === "restore").length, props.length);
  assert.equal(calls.some(c => c[0] === "drawImage"), false, "decorations require no image resampling or offscreen artwork");
});

test("mounted scene hides retained owner work while confirmation is absent and removes it after confirmed claim", async () => {
  const { mountHabitat } = await modules({ constructionSites: [{ ...line("home"),
    points: [{ x: 615, y: 660 }, { x: 633, y: 660 }] }] });
  const env = browser(); let mounted;
  try {
    const confirmed = { ...options, serverNow: now, presenceKey: `zhiv:mochlik:presence:${owner}`, economyConstruction: snapshot() };
    mounted = mountHabitat(env.surface(), confirmed, { activity() {}, ready() {}, failure: assert.fail });
    env.finish(); await flush();
    const hasRope = () => {
      const surface = env.surface(); mounted.paintWorld(surface.context);
      return surface.calls.some(call => call.method === "strokeStyle" && call.args[0] === "#a89163");
    };
    assert.equal(hasRope(), true);
    mounted.configure({ ...confirmed, economyConstruction: null });
    assert.equal(hasRope(), false, "accepted state cache does not substitute for the controller's confirmation");
    mounted.configure(confirmed); assert.equal(hasRope(), true, "reconfirming an unchanged revision restores its unclaimed work");
    mounted.configure({ ...confirmed, economyConstruction: { ...snapshot(), ownerPublicId: "other-owner", revision: 99 } });
    assert.equal(hasRope(), false, "a foreign incoming snapshot cannot use the retained local-owner cache");
    mounted.configure(confirmed); assert.equal(hasRope(), true);
    mounted.configure({ ...confirmed, economyConstruction: { ...snapshot([]), revision: 3 } });
    assert.equal(hasRope(), false, "a newer confirmed collection removes work from every repaint");
    mounted.configure({ ...confirmed, economyConstruction: { ...snapshot(), ownerPublicId: "other-owner", revision: 99 } });
    assert.equal(hasRope(), false, "foreign incoming state cannot resurrect another owner's decorations");
  } finally { mounted?.dispose(); env.restore(); }
});
