import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, cacheDir: "/tmp/zhiv-fish-public-jobs-vite", resolve: { alias: { "@": root } },
  server: { middlewareMode: true, hmr: false, ws: false } });
const { publicEconomyJob } = await vite.ssrLoadModule("/features/economy/domain/public-jobs.ts");
const { economyJobSchema, economyViewSchema } = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const { fishClassInventory } = await vite.ssrLoadModule("/features/economy/domain/fishing.ts");
const identities = await vite.ssrLoadModule("/lib/dev/api-store.ts");
const economy = await vite.ssrLoadModule("/lib/dev/economy-store.ts");
const now = Date.parse("2026-10-06T00:00:00Z");
beforeEach(() => { identities.resetDevStoreForTests(); economy.resetDevEconomyStoreForTests(); });
after(() => vite.close());

const job = () => economyJobSchema.parse({ id: crypto.randomUUID(), kind: "exploration", targetId: "shore_camp",
  recipeId: null, targetLevel: null, startedAt: new Date(now).toISOString(), finishesAt: new Date(now + 28_800_000).toISOString(),
  rewards: { fish: 18, fish_mooncarp: 4, fish_shark: 2, ancient_core: 1 },
  cost: { coins: 0, items: { worm_bait: 1 } }, catalogVersion: 3,
  fishing: { rodId: "river_rod", hookId: "bare_hook", baitId: "worm_bait", fishId: "fish_mooncarp" },
  rareDrop: { version: 1, seconds: 28_800, itemId: "ancient_core" } });

test("unfinished fishing jobs conceal every species while completed jobs show only their saved actual catch", () => {
  const saved = job(), original = structuredClone(saved), projected = publicEconomyJob(saved, now);
  assert.deepEqual(projected.rewards, { fish: 24, ancient_core: 1 });
  assert.deepEqual(projected.fishing, { ...saved.fishing, fishId: "fish" });
  assert.equal(Object.values(projected.rewards).reduce((a, b) => a + b, 0), Object.values(saved.rewards).reduce((a, b) => a + b, 0));
  assert.deepEqual({ ...projected, rewards: saved.rewards, fishing: saved.fishing }, saved);
  assert.deepEqual(saved, original, "projecting must never alter the catch kept by the server");
  assert.deepEqual(publicEconomyJob(projected, now), projected, "repeated projections preserve quantity");
  assert.equal(economyJobSchema.safeParse(projected).success, true);
  const finish = Date.parse(saved.finishesAt);
  const revealed = { ...original, fishing: { ...original.fishing, catchRevealed: true } };
  assert.deepEqual(publicEconomyJob(saved, finish - 1).rewards, projected.rewards, "the final unfinished millisecond is still concealed");
  assert.deepEqual(publicEconomyJob(saved, finish), revealed, "the authoritative deadline reveals the frozen catch without claiming it");
  assert.deepEqual(publicEconomyJob(saved, finish + 1000), revealed);
  assert.equal(economyJobSchema.safeParse(revealed).success, true);
  assert.deepEqual(saved, original, "ready projection cannot mutate the saved delivery");
});

test("other jobs remain unchanged and unfinished retired species are still hidden", () => {
  const ordinary = { ...job(), kind: "production", targetId: "campfire", fishing: null, rareDrop: null, rewards: { smoked_fish: 1 } };
  assert.deepEqual(publicEconomyJob(ordinary, now), ordinary);
  const retired = job(); retired.fishing.fishId = "retired_species"; retired.rewards.retired_species = 2;
  assert.equal(publicEconomyJob(retired, now).rewards.retired_species, undefined);
  assert.equal(publicEconomyJob(retired, now).rewards.fish, 26);
  assert.deepEqual(publicEconomyJob(retired, Date.parse(retired.finishesAt)), { ...retired, fishing: { ...retired.fishing, catchRevealed: true } });
});

test("invalid job or server timestamps never reveal a private unfinished draw", () => {
  const saved = job(), hidden = publicEconomyJob(saved, now);
  saved.fishing.catchRevealed = true;
  for (const finishesAt of ["invalid", ""]) {
    assert.deepEqual(publicEconomyJob({ ...saved, finishesAt }, now).rewards, hidden.rewards);
  }
  for (const invalidNow of [NaN, Infinity, -Infinity]) assert.deepEqual(publicEconomyJob(saved, invalidNow).rewards, hidden.rewards);
  assert.equal(publicEconomyJob(saved, now).fishing.catchRevealed, undefined, "unfinished projection scrubs a stale reveal marker");
  assert.equal(saved.fishing.catchRevealed, true, "projection does not write into persisted metadata");
});

test("the reveal marker distinguishes a real all river fish catch from an older masked snapshot", () => {
  const saved = job(); saved.rewards = { fish: 3 }; saved.fishing.fishId = "fish"; saved.rareDrop = null;
  const hidden = publicEconomyJob(saved, now), revealed = publicEconomyJob(saved, Date.parse(saved.finishesAt));
  assert.deepEqual(hidden.rewards, revealed.rewards);
  assert.equal(hidden.fishing.catchRevealed, undefined);
  assert.equal(revealed.fishing.catchRevealed, true);
  assert.equal(saved.fishing.catchRevealed, undefined);
});

test("snapshots and replays reveal completed catches without granting goods or opening the collection", () => {
  const player = identities.createDevIdentity("Private catch", crypto.randomUUID());
  const read = (at = now) => economy.getDevEconomy(player.token, at);
  const command = (action, targetId, at = now) => ({ requestId: crypto.randomUUID(), ownerPublicId: player.me.user.publicId,
    expectedRevision: read(at).revision, action, targetId, quantity: 1, totalPrice: 0 });
  const start = command("start_fishing", "shore");
  const started = economy.commandDevEconomy(player.token, start, now);
  assert.deepEqual(started.state.jobs[0].rewards, { fish: 2 });
  assert.equal(started.state.jobs[0].fishing.fishId, "fish");
  const profile = globalThis.__zhivDevEconomyStore.profiles.get(player.me.user.publicId);
  // Force a mixed persisted catch: this check must not pass only because a random draw was common.
  const saved = profile.state.jobs[0];
  saved.rewards = { fish: 1, fish_mooncarp: 1, fish_shark: 2 };
  saved.fishing.fishId = "fish_mooncarp";
  const privateJob = structuredClone(saved), finishedAt = Date.parse(saved.finishesAt);
  for (const snapshot of [read(), read(finishedAt - 1)]) {
    assert.deepEqual(snapshot.jobs[0].rewards, { fish: 4 });
    assert.equal(snapshot.jobs[0].fishing.fishId, "fish");
    assert.notEqual(snapshot.jobs[0].fishing.catchRevealed, true);
    assert.equal(snapshot.fishingCastSeed, undefined);
    assert.equal(economyViewSchema.safeParse(snapshot).success, true);
  }
  for (const snapshot of [read(finishedAt), economy.commandDevEconomy(player.token, start, finishedAt).state]) {
    assert.deepEqual(snapshot.jobs[0].rewards, privateJob.rewards);
    assert.equal(snapshot.jobs[0].fishing.fishId, privateJob.fishing.fishId);
    assert.equal(snapshot.jobs[0].fishing.catchRevealed, true);
    assert.deepEqual(snapshot.fishing.catches, {}, "showing a completed job does not open the personal collection");
    assert.equal(snapshot.fishingCastSeed, undefined);
    assert.equal(economyViewSchema.safeParse(snapshot).success, true);
  }
  assert.deepEqual(profile.state.jobs[0], privateJob);
  const inventory = structuredClone(profile.state.inventory);
  profile.state.inventory = { stone: 299 };
  const claim = command("claim_job", saved.id, finishedAt);
  assert.throws(() => economy.commandDevEconomy(player.token, claim, finishedAt), { code: "ECONOMY_STORAGE_FULL" });
  assert.deepEqual(read(finishedAt).jobs[0].rewards, privateJob.rewards);
  assert.deepEqual(profile.state.jobs[0], privateJob);
  profile.state.inventory = inventory;
  const delivered = economy.commandDevEconomy(player.token, claim, finishedAt);
  const expected = { ...inventory };
  for (const [item, amount] of Object.entries(privateJob.rewards)) expected[item] = (expected[item] ?? 0) + amount;
  assert.deepEqual(delivered.state.inventory, fishClassInventory(expected));
  assert.deepEqual(delivered.state.fishing.catches, privateJob.rewards);
  assert.deepEqual(delivered.state.jobs, []);
  const replay = economy.commandDevEconomy(player.token, claim, finishedAt);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.state.inventory, delivered.state.inventory);
  assert.deepEqual(economy.commandDevEconomy(player.token, start, finishedAt).state.jobs, []);
});

test("general exploration commands cannot bypass fishing gear, bait costs, hidden seeds or cancel semantics", () => {
  const player = identities.createDevIdentity("Old fishing client", crypto.randomUUID());
  const read = (at = now) => economy.getDevEconomy(player.token, at);
  const command = (action, targetId, at = now) => ({ requestId: crypto.randomUUID(), ownerPublicId: player.me.user.publicId,
    expectedRevision: read(at).revision, action, targetId, quantity: 1, totalPrice: 0 });
  read();
  const profile = globalThis.__zhivDevEconomyStore.profiles.get(player.me.user.publicId);
  profile.state.inventory.worm_bait = 2;
  profile.state.fishing.equippedBaitId = "worm_bait";
  const start = command("start_exploration", "shore_camp");
  const active = economy.commandDevEconomy(player.token, start, now).state;
  const first = active.jobs[0], seed = profile.state.fishingCastSeed;
  assert.deepEqual(first.rewards, { fish: 8 });
  assert.deepEqual(first.cost.items, { worm_bait: 1 });
  assert.equal(first.fishing.baitId, "worm_bait");
  assert.equal(active.inventory.worm_bait, 1);
  assert.equal(active.fishingCastSeed, undefined);
  assert.notEqual(first.id, start.requestId);
  assert.ok(seed && seed !== start.requestId && seed !== first.id, "the legacy command must also use private server-generated UUIDs");
  assert.equal(economy.commandDevEconomy(player.token, start, now).state.inventory.worm_bait, 1, "retries spend only once");
  economy.commandDevEconomy(player.token, command("cancel_exploration", first.id), now);
  const next = economy.commandDevEconomy(player.token, command("start_fishing", "shore_camp"), now).state.jobs[0];
  assert.equal(profile.state.fishingCastSeed, seed, "switching command names after cancellation cannot reroll");
  assert.notEqual(next.id, first.id);
  economy.commandDevEconomy(player.token, command("cancel_exploration", next.id), now);
  const before = read();
  assert.throws(() => economy.commandDevEconomy(player.token, command("start_exploration", "shore"), now), { code: "ECONOMY_RESOURCES" });
  assert.deepEqual(read(), before);
  profile.state.inventory.worm_bait = 1;
  profile.state.fishing.equippedRodId = "unowned_rod";
  assert.throws(() => economy.commandDevEconomy(player.token, command("start_exploration", "shore"), now), { code: "ECONOMY_FISHING_ROD" });
  profile.state.fishing.equippedRodId = "reed_rod";
  const last = economy.commandDevEconomy(player.token, command("start_exploration", "shore"), now).state.jobs[0];
  const saved = structuredClone(profile.state.jobs[0]), inventory = structuredClone(profile.state.inventory);
  const claimed = economy.commandDevEconomy(player.token, command("claim_job", last.id, Date.parse(last.finishesAt)), Date.parse(last.finishesAt)).state;
  const expected = { ...inventory };
  for (const [item, amount] of Object.entries(saved.rewards)) expected[item] = (expected[item] ?? 0) + amount;
  assert.deepEqual(claimed.inventory, fishClassInventory(expected));
  assert.deepEqual(claimed.fishing.catches, saved.rewards);
  assert.equal(profile.state.fishingCastSeed, null);
});
