import assert from "node:assert/strict";
import test from "node:test";
import { browser, flush, modules, options, productionSite, quietClearing } from "./helpers/new-map-scene.mjs";

const sites = () => [productionSite("quarry", 800, [0, 1, 2, 3, 4, 5]),
  productionSite("bridge", 250, [0, 1]), productionSite("market", 400, [0, 1]),
  productionSite("leaftail-caravan", 550, [0, 1])].map(site => ({ ...site, initialLevel: 0 }));

test("all six mine exteriors follow confirmed levels; bridge claim and merchant arrival independently select their exteriors", async () => {
  const { accountSceneLevels, previewWorldScene, TILED_WORLD } = await modules({ sites: sites() });
  const selected = (buildings, merchantArrived = false) => accountSceneLevels(TILED_WORLD, 5, undefined, buildings, { merchantArrived });
  for (let quarry = 0; quarry <= 5; quarry++) {
    const buildings = { home: 3, quarry, bridge: 0, market: 1, "leaftail-caravan": 1 }, before = structuredClone(buildings);
    const levels = selected(buildings);
    assert.deepEqual(levels, { quarry, bridge: 0, market: 0, "leaftail-caravan": 0 });
    const effective = previewWorldScene(TILED_WORLD, levels), mine = effective.sites.find(site => site.id === "quarry");
    assert.deepEqual(mine.collision, TILED_WORLD.sites[0].states[quarry].geometry.collision);
    assert.deepEqual(buildings, before, "visual selection never writes derived levels into account progress");
  }
  assert.equal(selected({ home: 3, bridge: 1 }).market, 1);
  assert.equal(selected({ home: 3, bridge: 0 }, true)["leaftail-caravan"], 1,
    "arriving is independent of the bridge restoration");
  for (const home of [0, 2, NaN, Infinity, undefined]) {
    assert.equal(selected({ home, bridge: 1 }, true)["leaftail-caravan"], 0,
      "a stale seen flag cannot bypass the current account's confirmed house gate");
  }
  for (const bridge of [0, -1, .5, NaN, Infinity, undefined]) assert.equal(selected({ home: 3, bridge }).market, 0);
  assert.equal(selected({ bridge: 1 }, true)["leaftail-caravan"], 0, "legacy house 5 is not a confirmed unlock");
  assert.equal(selected({ quarry: 99 }).quarry, 5, "future levels use the nearest lower authored artwork");
  assert.equal(selected({ home: 3 })["leaftail-caravan"], 0, "house 3 alone does not finish the introduction");
  assert.equal(selected({ home: 3, bridge: 1 }, true)["leaftail-caravan"], 1);
  assert.deepEqual(accountSceneLevels(TILED_WORLD, 5, { previewBuildings: true,
    levels: { quarry: 2, bridge: 0, market: 0, "leaftail-caravan": 0 } }, { home: 5, quarry: 5, bridge: 1 }, { merchantArrived: true }),
  { quarry: 2, bridge: 0, market: 0, "leaftail-caravan": 0 }, "explicit DEV previews retain priority");
});

test("circle, map and read-only visits commit mine, market and tent artwork with the same loaded interaction geometry", async () => {
  const authored = sites(), { mountHabitat, worldDevStore } = await modules({ sites: authored });
  const env = browser(), scenes = [], images = new Map();
  try {
    worldDevStore.patch({ ...quietClearing, autoLife: false });
    const initial = { ...options, presenceKey: "new-building-exteriors", economyBuildings: { home: 2, quarry: 0, bridge: 0 },
      merchantArrival: { seen: false, enabled: false, onComplete: assert.fail } };
    const callback = { activity() {}, ready() {}, failure: assert.fail };
    const circle = mountHabitat(env.surface(), initial, callback), world = mountHabitat(env.surface(), { ...initial, view: "world" }, callback);
    const guest = mountHabitat(env.surface(), { ...initial, view: "world", readOnly: true,
      presenceKey: "visited-new-building-exteriors" }, callback);
    scenes.push(circle, world, guest);
    const finish = (id, level, failed = false) => {
      const url = `/account-${id}-${level}.webp`, image = env.finishPath(url, failed);
      if (!failed) images.set(url, image);
    };
    env.finishPath("/test-ground.webp");
    for (const site of authored) finish(site.id, 0);
    await flush();
    const check = (id, level) => {
      const geometry = authored.find(site => site.id === id).states.find(state => state.level === level).geometry;
      for (const scene of scenes) {
        const surface = env.surface(); scene.paintWorld(surface.context);
        const draw = surface.calls.find(call => call.method === "drawImage" && call.args[0] === images.get(`/account-${id}-${level}.webp`));
        assert.deepEqual(draw?.args, [images.get(`/account-${id}-${level}.webp`), geometry.bounds.x, geometry.bounds.y, 80, 70]);
        assert.deepEqual(scene.siteAnchor(id), geometry.anchor);
        assert.equal(scene.hitSite({ x: geometry.bounds.x + 40, y: geometry.bounds.y + 20 }), id);
      }
    };
    const configure = (buildings, seen = false) => {
      const next = { ...initial, economyBuildings: buildings, merchantArrival: { ...initial.merchantArrival, seen } };
      circle.configure(next); world.configure({ ...next, view: "world" });
      guest.configure({ ...next, view: "world", readOnly: true, presenceKey: "visited-new-building-exteriors" });
    };
    check("market", 0); check("leaftail-caravan", 0);
    for (let quarry = 1; quarry <= 5; quarry++) {
      configure({ home: 3, quarry, bridge: 0 });
      check("quarry", quarry - 1);
      finish("quarry", quarry); await flush();
      check("quarry", quarry); check("market", 0); check("leaftail-caravan", 0);
    }
    configure({ home: 3, quarry: 5, bridge: 1 });
    finish("bridge", 1); await flush();
    check("bridge", 0); check("market", 0);
    finish("market", 1); await flush();
    check("bridge", 1); check("market", 1); check("leaftail-caravan", 0);
    configure({ home: 3, quarry: 5, bridge: 1 }, true);
    check("leaftail-caravan", 0);
    finish("leaftail-caravan", 1, true); await flush(); check("leaftail-caravan", 0);
    configure({ home: 3, quarry: 5, bridge: 1 }, true);
    finish("leaftail-caravan", 1); await flush(); check("leaftail-caravan", 1);
    configure({ home: 2, quarry: 5, bridge: 0 }, true); await flush();
    check("market", 0); check("leaftail-caravan", 0);
  } finally { scenes.forEach(scene => scene.dispose()); worldDevStore.reset(); env.restore(); }
});
