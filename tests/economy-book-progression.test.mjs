import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const model = await vite.ssrLoadModule("/features/economy/model.ts");
const progress = await vite.ssrLoadModule("/features/economy/collection-progress.ts");
const identities = await vite.ssrLoadModule("/lib/dev/api-store.ts");
const economy = await vite.ssrLoadModule("/lib/dev/economy-store.ts");
const at = Date.UTC(2026, 9, 5, 15);
beforeEach(() => identities.resetDevStoreForTests());
const account = () => identities.createDevIdentity("Книголюб", crypto.randomUUID());
const read = (player, now = at) => economy.getDevEconomy(player.token, now);
const command = (player, action, targetId, now = at) => ({ requestId: crypto.randomUUID(), ownerPublicId: player.me.user.publicId,
  expectedRevision: read(player, now).revision, action, targetId, quantity: 1, totalPrice: 0 });
const issue = (player, action, targetId, now = at) => economy.commandDevEconomy(player.token, command(player, action, targetId, now), now);
const job = (route, seconds, kind = "exploration", recipeId = null) => ({ id: crypto.randomUUID(), kind, targetId: route, recipeId,
  targetLevel: null, startedAt: new Date(at).toISOString(), finishesAt: new Date(at + seconds * 1000).toISOString(),
  rewards: {}, cost: { coins: 0, items: {} }, catalogVersion: 2 });

test("old snapshots default empty audited counters and contain no consumable rare items", () => {
  const p = account(), view = read(p); delete view.progression;
  const parsed = model.economyViewSchema.parse(view);
  assert.deepEqual(parsed.progression, { routes: {}, recipes: {}, collections: { finds: [], travelSeconds: 0, quarrySeconds: 0 } });
  assert.equal(model.economyCatalog.items.some(item => ["quartz_cluster", "striped_agate", "pyrite_spark", "fern_fossil"].includes(item.id)), false);
});

test("equal completed travel time grants equal missing finds on short and long routes", () => {
  let short = progress.newEconomyProgression();
  for (let i = 0; i < 16; i++) short = progress.advanceEconomyProgression(short, job("forest", 1800));
  const long = progress.advanceEconomyProgression(undefined, job("forest_camp", 28800));
  assert.deepEqual(short.collections, long.collections);
  assert.equal(short.collections.finds.length, 4);
  assert.deepEqual(short.routes, { forest: 16 }); assert.deepEqual(long.routes, { forest_camp: 1 });
});

test("inherited finds are kept and the next interval reveals a missing entry", () => {
  const inherited = progress.inheritEconomyCollection(undefined, ["acorn", "feather", "river_pearl", "unknown", "acorn"]);
  const next = progress.advanceEconomyProgression(inherited, job("forest", 7200));
  assert.deepEqual(inherited.collections.finds, ["acorn", "feather"]);
  assert.deepEqual(next.collections.finds, ["acorn", "feather", "fern_leaf"]);
  assert.deepEqual(inherited.routes, {}); assert.equal(inherited.collections.travelSeconds, 0);
});

test("quarry productions and cave routes use their actual saved durations and keep separate clocks", () => {
  let state = progress.advanceEconomyProgression(undefined, job("quarry", 7200, "production", "extract_stone"));
  state = progress.advanceEconomyProgression(state, job("cave", 7200));
  assert.deepEqual(state.recipes, { extract_stone: 1 }); assert.deepEqual(state.routes, { cave: 1 });
  assert.equal(state.collections.travelSeconds, 0); assert.equal(state.collections.quarrySeconds, 14400);
  assert.deepEqual(state.collections.finds, ["quartz_cluster"]);
  const unrelated = progress.advanceEconomyProgression(state, job("home", 86400, "construction"));
  assert.deepEqual(unrelated, state);
});

test("start cancel and abandoned finish do not count work or award finds", () => {
  const p = account(), before = read(p).progression;
  const started = issue(p, "start_exploration", "forest_camp").state;
  assert.deepEqual(started.progression, before);
  assert.deepEqual(issue(p, "cancel_exploration", started.jobs[0].id, at + 28800000).state.progression, before);
});

test("successful claim records once and waiting after completion cannot inflate elapsed work", () => {
  const p = account(), started = issue(p, "start_exploration", "forest_camp").state;
  const collectAt = at + 7 * 86400000, claim = command(p, "claim_job", started.jobs[0].id, collectAt);
  const first = economy.commandDevEconomy(p.token, claim, collectAt);
  const replay = economy.commandDevEconomy(p.token, claim, collectAt + 1000);
  assert.equal(replay.replayed, true); assert.deepEqual(replay.state.progression, first.state.progression);
  assert.equal(first.state.progression.collections.travelSeconds, 28800);
  assert.equal(first.state.progression.collections.finds.length, 4);
  assert.deepEqual(first.state.progression.routes, { forest_camp: 1 });
  assert.throws(() => issue(p, "claim_job", started.jobs[0].id, collectAt + 1000), { code: "ECONOMY_JOB_GONE" });
});

test("full warehouse prevents both rewards and collection progress until a successful claim", () => {
  const p = account(), started = issue(p, "start_exploration", "forest_camp").state;
  const row = globalThis.__zhivDevEconomyStore.profiles.get(p.me.user.publicId);
  row.state.inventory = { wood: 200 };
  const finish = Date.parse(started.jobs[0].finishesAt), before = read(p, finish);
  assert.throws(() => issue(p, "claim_job", started.jobs[0].id, finish), { code: "ECONOMY_STORAGE_FULL" });
  assert.deepEqual(read(p, finish).progression, before.progression);
  row.state.inventory = {};
  assert.equal(issue(p, "claim_job", started.jobs[0].id, finish).state.progression.collections.finds.length, 4);
});

test("read-only achievement getter does not initialize a profile or expose a draw seed", () => {
  const p = account(); assert.equal(economy.getDevEconomyAchievementState(p.me.user.publicId), null);
  assert.equal(economy.getDevConfirmedMarketSales(p.me.user.publicId), 0);
  read(p); const verified = economy.getDevEconomyAchievementState(p.me.user.publicId);
  assert.ok(verified); assert.equal(verified.fishingCastSeed, undefined); assert.equal(verified.wallet, undefined);
});

test("merge preserves unique ownership and saturated counters without adding resources", () => {
  const first = progress.advanceEconomyProgression(undefined, job("forest", 7200));
  const second = progress.advanceEconomyProgression(undefined, job("cave", 14400));
  first.routes.forest = model.ECONOMY_MAX_BALANCE;
  second.routes.forest = 1;
  const merged = progress.mergeEconomyProgression(first, second);
  assert.equal(merged.routes.forest, model.ECONOMY_MAX_BALANCE);
  assert.deepEqual(merged.collections.finds, ["acorn", "quartz_cluster"]);
  assert.equal(merged.collections.travelSeconds, 7200); assert.equal(merged.collections.quarrySeconds, 14400);
});

test("merged partial intervals materialize once and never lose earned time", () => {
  const first = progress.advanceEconomyProgression(undefined, job("forest", 3600));
  const second = progress.advanceEconomyProgression(undefined, job("forest", 3600));
  const merged = progress.mergeEconomyProgression(first, second);
  assert.equal(merged.collections.travelSeconds, 7200); assert.deepEqual(merged.collections.finds, ["acorn"]);
  const again = progress.mergeEconomyProgression(merged, progress.newEconomyProgression());
  assert.deepEqual(again, merged);
  const later = progress.advanceEconomyProgression(merged, job("forest", 7200));
  assert.equal(later.collections.travelSeconds, 14400); assert.deepEqual(later.collections.finds, ["acorn", "feather"]);
});
