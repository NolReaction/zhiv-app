import assert from "node:assert/strict";
import test, { after, afterEach } from "node:test";
import { fileURLToPath } from "node:url";
import { Children, createElement, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { friendWorldScene, friendWorldJobStatus } = await vite.ssrLoadModule("/features/world/ui/visits/friend-world-state.ts");
const { FriendWorldView } = await vite.ssrLoadModule("/features/world/ui/visits/friend-world-view.tsx");
const { WorldScene } = await vite.ssrLoadModule("/features/world/scene/world-scene.tsx");
const { economyCatalog } = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const { connectForestSession, forgetForestSession } = await vite.ssrLoadModule("/features/world/state/forest-session.ts");
const { TILED_WORLD } = await vite.ssrLoadModule("/features/world/scene/presentation.ts");
const { accountSceneLevels } = await vite.ssrLoadModule("/features/world/state/economy/economy-scene-state.ts");
const { economyGardenGrowth } = await vite.ssrLoadModule("/features/world/state/economy/economy-garden-state.ts");
const handles = [];
afterEach(() => { for (const handle of handles.splice(0)) handle.release(); forgetForestSession("own-scene"); });
const now = Date.parse("2026-10-19T00:00:00Z"), iso = value => new Date(value).toISOString();
const berry = economyCatalog.recipes.find(recipe => recipe.buildingId === "garden");
const job = (id, kind, targetId, extra = {}) => ({ id, kind, targetId, recipeId: null, targetLevel: null,
  startedAt: iso(now - 30_000), finishesAt: iso(now + 30_000), collection: null, actorId: null, ...extra });
function fixture() {
  return { ownerPublicId: "1111-2222-3333", circleId: "circle-one", user: { publicId: "4444-5555-6666", displayName: "Лесной друг" }, serverTime: iso(now),
    world: { buildings: { home: 3, workshop: 2, garden: 1, woodlot: 3, quarry: 2, bridge: 1 },
      equipment: { palette: "moss", head: "rain_hood", neck: "amber_scarf", rod: "willow_rod" },
      gifts: ["flower", "leaf_garland"], hiddenGifts: ["flower"], jobs: [
        job("build", "construction", "home", { targetLevel: 4 }),
        job("berry", "production", "garden", { recipeId: berry.id }),
        job("wood", "production", "woodlot", { recipeId: "wood_boards" }),
        job("miner", "exploration", "quarry_work", { actorId: "miner" }),
      ] }, market: { listings: [], available: true, reason: null } };
}
function elements(tree) {
  const found = [];
  const visit = element => { if (isValidElement(element)) { found.push(element); Children.forEach(element.props.children, visit); } };
  visit(tree); return found;
}
function probe(component, props) {
  let tree; function Probe() { tree = component(props); return null; }
  renderToStaticMarkup(createElement(Probe)); return tree;
}

test("friend scene uses only the host equipment, gifts and confirmed levels without adopting private account state", () => {
  const visit = fixture(), before = structuredClone(visit), scene = friendWorldScene(visit);
  assert.deepEqual(scene.state.equipment, visit.world.equipment);
  assert.notEqual(scene.state.equipment, visit.world.equipment);
  assert.deepEqual(scene.gifts, visit.world.gifts); assert.deepEqual(scene.state.hiddenGifts, ["flower"]);
  assert.equal(scene.state.houseLevel, 3); assert.equal(scene.state.workshopLevel, 2);
  assert.deepEqual(scene.state.resources, { sparks: 0, wood: 0, stone: 0 });
  assert.deepEqual(scene.state.inventory, []); assert.deepEqual(scene.state.collection, []);
  const tree = probe(FriendWorldView, { visit, now, timeZone: "UTC", onReturn() {}, onOpenShop() {} });
  const runtime = elements(tree).find(element => element.type === WorldScene).props;
  const levels = accountSceneLevels(TILED_WORLD, scene.state.houseLevel, undefined, scene.buildings,
    { merchantArrived: runtime.merchantArrival?.seen });
  assert.equal(levels.home, 3); assert.equal(levels["lopukh-home"], 2);
  assert.equal(levels["leaftail-caravan"], 1, "the public visit projection matches its settled merchant presentation");
  assert.equal(scene.construction.ownerPublicId, visit.user.publicId);
  assert.notEqual(scene.construction.ownerPublicId, visit.ownerPublicId);
  assert.equal(scene.construction.jobs[0].targetLevel, 4);
  assert.equal(scene.buildings.home, 3, "a running or ready construction must not pre-apply its target level");
  scene.buildings.home = 5; scene.state.equipment.head = null;
  assert.deepEqual(visit, before, "render state and input remain independent");
});

test("production, construction and growth follow host dates, while the miner never sends Mochlik away", () => {
  const visit = fixture(), scene = friendWorldScene(visit);
  assert.equal(scene.journey, null);
  assert.equal(scene.residents.production.jobs.find(entry => entry.id === "miner").stationId, "quarry");
  assert.equal(scene.production.jobs.find(entry => entry.id === "wood").stationLevel, 3);
  assert.equal(economyGardenGrowth(scene.garden, now), .49);
  assert.equal(economyGardenGrowth(scene.garden, now + 29_999) < .98, true);
  assert.equal(economyGardenGrowth(scene.garden, now + 30_000), 1);
  assert.equal(friendWorldJobStatus(visit.world.jobs[0], now + 30_000), "Ожидает хозяина");
  assert.equal(scene.buildings.home, 3, "finishing a timer never claims another player's construction");
  visit.world.jobs.push(job("hero", "exploration", "forest_path", { actorId: "mochlik" }));
  assert.equal(friendWorldScene(visit).journey.id, "hero");
  assert.equal(friendWorldScene(visit).journey.rewards, undefined, "unknown outcomes stay private");
});

test("a newer public snapshot can remove jobs and replace clothing, without stale local work or inventory", () => {
  const visit = fixture();
  assert.equal(friendWorldScene(visit).garden.jobId, "berry");
  visit.serverTime = iso(now + 60_000); visit.world.jobs = []; visit.world.buildings.home = 4;
  visit.world.equipment.head = null; visit.world.equipment.neck = null;
  const scene = friendWorldScene(visit);
  assert.equal(scene.state.houseLevel, 4); assert.equal(scene.state.equipment.head, null);
  assert.equal(scene.state.equipment.neck, null); assert.equal(scene.garden, null);
  assert.deepEqual(scene.production.jobs, []); assert.deepEqual(scene.construction.jobs, []);
});

test("guest map has no economy controller or owner callbacks and routes the shop and return separately", () => {
  const visit = fixture(), calls = [];
  const tree = probe(FriendWorldView, { visit, now, timeZone: "UTC", onReturn: () => calls.push("return"), onOpenShop: () => calls.push("shop"), onRefresh: () => calls.push("refresh") });
  const nodes = elements(tree), scene = nodes.find(element => element.type === WorldScene);
  assert.ok(scene); assert.equal(scene.props.readOnly, true);
  assert.equal(scene.props.owner, visit.user.publicId);
  for (const prop of ["constructionEconomy", "onOpenConstruction", "onOpenProduction", "onResident", "onGardenHarvestEvent"])
    assert.equal(scene.props[prop], undefined, `${prop} cannot leak owner actions into a visit`);
  scene.props.onPlace("market");
  nodes.find(element => element.props.id === "friend-world-return").props.onClick();
  nodes.find(element => element.props["aria-label"] === "Обновить мир друга").props.onClick();
  assert.deepEqual(calls, ["shop", "return", "refresh"]);
  const html = renderToStaticMarkup(tree);
  assert.match(html, /Мир Лесной друг/); assert.match(html, /Лавка игрока/);
  assert.doesNotMatch(html, /Завершить:|Ускорить|Собрать|Купить слот|Выдать/);
});

test("an isolated visit neither borrows nor evicts the parked own forest and has zero storage or remote writes", () => {
  let reads = 0, writes = 0, remote = 0;
  const records = new Map(), environment = { now: () => now,
    storage: { getItem(key) { reads++; return records.get(key) ?? null; }, setItem(key, value) { writes++; records.set(key, value); }, removeItem() { writes++; } } };
  const own = connectForestSession("own-scene", TILED_WORLD, "world", now, 0, () => {}, { environment, sync: false });
  handles.push(own); own.configure("world", true, true); own.state.elapsed = 42; const ownState = own.state;
  own.release({ retain: true }); const before = { reads, writes, records: [...records] };
  const connectGuest = () => connectForestSession("own-scene", TILED_WORLD, "world", now, 0, () => {},
    { isolated: true, environment, persistence: true, sync: { transport: { load() { remote++; throw Error("must not connect"); } } } });
  const guest = connectGuest(), otherGuest = connectGuest(); handles.push(guest, otherGuest);
  guest.configure("world", true); guest.state.elapsed = 900; guest.saveMemory(); guest.publish();
  otherGuest.configure("world", true); otherGuest.saveMemory();
  assert.notEqual(guest.state, ownState); assert.notEqual(otherGuest.state, guest.state);
  assert.equal(guest.state.memory.mode, "ephemeral"); assert.equal(guest.state.memory.sync, undefined);
  assert.equal(reads, before.reads); assert.equal(writes, before.writes); assert.equal(remote, 0);
  assert.deepEqual([...records], before.records);
  guest.release({ retain: true }); otherGuest.release({ retain: true });
  const restored = connectForestSession("own-scene", TILED_WORLD, "world", now, 0, () => {}, { environment, sync: false }); handles.push(restored);
  assert.equal(restored.state, ownState); assert.equal(restored.state.elapsed, 42);
});
