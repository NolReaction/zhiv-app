import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
const root = fileURLToPath(new URL("..", import.meta.url)), initialMode = process.env.NODE_ENV;
const cookieModule = "\0progression-rewards-test-cookie";
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root, "next/headers": cookieModule } }, server: { middlewareMode: true, hmr: false, ws: false },
  plugins: [{ name: "progression-rewards-test-cookie", resolveId(id) { if (id === cookieModule) return id; },
    load(id) { if (id === cookieModule) return "export async function cookies() { return { get() { return { value: globalThis.__rewardTestToken }; } }; }"; } }],
});
const identities = await vite.ssrLoadModule("/lib/dev/api-store.ts");
const { commandDevPresence } = await vite.ssrLoadModule("/lib/dev/activity-store.ts");
const activePresence = new Map();
function enterGame(p) {
  const id = crypto.randomUUID();
  commandDevPresence(p.me.user.publicId, { kind: "resume", presenceId: id, sequence: 0, active: true }, Date.now(), p.token);
  activePresence.set(p.token, id);
  return p;
}

const economy = await vite.ssrLoadModule("/lib/dev/economy-store.ts");
const rewards = await vite.ssrLoadModule("/lib/dev/progression-rewards-store.ts");
const api = await vite.ssrLoadModule("/features/game/game-rewards-api.ts");
const { GET } = await vite.ssrLoadModule("/app/api/v1/game/rewards/route.ts");
const { POST } = await vite.ssrLoadModule("/app/api/v1/game/rewards/claims/route.ts");
beforeEach(() => { identities.resetDevStoreForTests(); activePresence.clear(); process.env.NODE_ENV = "test"; delete globalThis.__rewardTestToken; });
after(async () => { delete globalThis.__rewardTestToken; if (initialMode == null) delete process.env.NODE_ENV; else process.env.NODE_ENV = initialMode; await vite.close(); });
const read = (suffix = "") => new Request(`http://localhost:3000/api/v1/game/rewards${suffix}`);
const player = () => { const p = enterGame(identities.createDevIdentity("Мохлик", crypto.randomUUID())); globalThis.__rewardTestToken = p.token; return p; };
const command = p => ({ requestId: crypto.randomUUID(), ownerPublicId: p.me.user.publicId, kind: "daily" });
const post = (body, headers = {}) => new Request("http://localhost:3000/api/v1/game/rewards/claims", { method: "POST",
  headers: { "Content-Type": "application/json", Origin: "http://localhost:3000", ...(activePresence.has(globalThis.__rewardTestToken) ? { "X-Game-Presence": activePresence.get(globalThis.__rewardTestToken) } : {}), ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });

test("rewards require session and expose no-store private state without issuing a gift", async () => {
  assert.equal((await GET(read())).status, 401); assert.equal((await POST(post({}))).status, 401);
  const p = player(), before = economy.getDevEconomy(p.token), response = await GET(read());
  assert.equal(response.status, 200); assert.equal(response.headers.get("Cache-Control"), "no-store");
  const opened = await response.json();
  assert.equal(opened.catalogVersion, 4);
  assert.equal(api.gameRewardsSchema.safeParse(opened).success, true);
  assert.deepEqual(opened.daily.cycle.map(row => row.reward.coins), [30, 30, 40, 40, 50, 50, 80]);
  assert.equal(opened.daily.cycle.reduce((sum, row) => sum + row.reward.pearls, 0), 140);
  assert.equal(opened.achievementRewards.reduce((sum, row) => sum + row.pearls, 0), 3000);
  assert.deepEqual(economy.getDevEconomy(p.token).wallet, before.wallet);
  assert.equal((await GET(read("?step=7"))).status, 400);
});
test("manual HTTP claim echoes its key and a lost-response retry returns the same immutable gift", async () => {
  const p = player(), request = command(p), response = await POST(post(request));
  assert.equal(response.status, 200); assert.equal(response.headers.get("Cache-Control"), "no-store");
  const first = await response.json(); assert.equal(api.gameRewardResultSchema.safeParse(first).success, true);
  assert.equal(first.requestId, request.requestId); assert.equal(first.claim.kind, "daily"); assert.equal(first.claim.step, 1);
  assert.deepEqual(first.claim.reward, { coins: 30, pearls: 10, items: { wood: 2, stone: 1 } });
  const repeat = await (await POST(post(request))).json(); assert.equal(repeat.replayed, true); assert.deepEqual(repeat.claim, first.claim);
  assert.equal(repeat.economy.wallet.coins, first.economy.wallet.coins);
  const duplicate = await POST(post(command(p))); assert.equal(duplicate.status, 409); assert.equal((await duplicate.json()).code, "DAILY_REWARD_COOLDOWN");
});
test("the seventh HTTP gift finishes the chain; replay works and a new request cannot restart it", async () => {
  const p = player(), now = Date.now();
  for (let day = 6; day > 0; day--) rewards.claimDevProgressionReward(p.token, command(p), now - day * 86_400_000);
  const finalRequest = command(p), response = await POST(post(finalRequest));
  assert.equal(response.status, 200);
  const paid = await response.json();
  assert.equal(api.gameRewardResultSchema.safeParse(paid).success, true);
  assert.equal(paid.claim.step, 7);
  assert.equal(paid.rewards.daily.completed, true);
  assert.equal(paid.rewards.daily.claimable, false);
  assert.equal(paid.rewards.daily.nextClaimAt, null);
  const repeat = await (await POST(post(finalRequest))).json();
  assert.equal(repeat.replayed, true); assert.deepEqual(repeat.claim, paid.claim);
  assert.deepEqual(repeat.economy.wallet, paid.economy.wallet);
  const denied = await POST(post(command(p)));
  assert.equal(denied.status, 409); assert.equal((await denied.json()).code, "DAILY_REWARD_COMPLETED");
  assert.equal((await (await GET(read())).json()).daily.completed, true);
  assert.deepEqual(economy.getDevEconomy(p.token).wallet, paid.economy.wallet);
});
test("cross-site wrong content-type forged gift and excessive bodies leave wallet and sequence unchanged", async () => {
  const p = player(), request = command(p), before = economy.getDevEconomy(p.token);
  assert.equal((await POST(post(request, { Origin: "https://evil.example" }))).status, 403);
  assert.equal((await POST(post(request, { "Sec-Fetch-Site": "cross-site" }))).status, 403);
  assert.equal((await POST(post(request, { "Content-Type": "text/plain" }))).status, 415);
  for (const bad of ["{broken", null, [], { ...request, reward: { pearls: 100 } }, { ...request, now: 0 }, { ...request, kind: "buy_pearls" }])
    assert.equal((await POST(post(bad))).status, 400);
  assert.equal((await POST(post(" ".repeat(2049)))).status, 413);
  assert.deepEqual(economy.getDevEconomy(p.token).wallet, before.wallet);
  assert.equal((await (await GET(read())).json()).daily.step, 1);
});

test("intentional onboarding completion credits 10 visible pearls and 100 coins once without consuming daily", async () => {
  const p = player(), initial = economy.getDevEconomy(p.token);
  globalThis.__zhivDevEconomyStore.profiles.get(p.me.user.publicId).state.inventory.berries = 1;
  const before = economy.commandDevEconomy(p.token, { requestId: crypto.randomUUID(), ownerPublicId: p.me.user.publicId,
    expectedRevision: initial.revision, action: "complete_resident_order", targetId: "tutorial_first_order" }).state;
  const request = { ...command(p), kind: "onboarding" };
  for (let visit = 0; visit < 3; visit++) {
    const preview = await (await GET(read())).json();
    assert.deepEqual(preview.onboarding, { claimedAt: null });
    assert.deepEqual(economy.getDevEconomy(p.token).wallet, before.wallet, "opening or restoring the game never awards old local completion");
  }
  const response = await POST(post(request)), first = await response.json();
  assert.equal(response.status, 200);
  assert.equal(api.gameRewardResultSchema.safeParse(first).success, true);
  assert.deepEqual(first.claim.reward, { coins: 100, pearls: 20, items: {} });
  assert.equal(first.economy.wallet.coins - before.wallet.coins, 100);
  assert.equal(first.economy.wallet.pearls - before.wallet.pearls, 20);
  assert.equal(first.rewards.onboarding.claimedAt, first.claim.claimedAt);
  assert.equal(first.rewards.daily.claimable, true);
  assert.equal(first.rewards.daily.step, 1);
  const retry = await (await POST(post(request))).json();
  assert.equal(retry.replayed, true); assert.deepEqual(retry.claim, first.claim);
  assert.deepEqual(retry.economy.wallet, first.economy.wallet);
  const duplicate = await POST(post({ ...request, requestId: crypto.randomUUID() }));
  assert.equal(duplicate.status, 409); assert.equal((await duplicate.json()).code, "ONBOARDING_REWARD_CLAIMED");
  assert.deepEqual(economy.getDevEconomy(p.token).wallet, first.economy.wallet);
});

test("onboarding reward trusts no client sums skipped states clocks or other owner", async () => {
  const p = player(), before = economy.getDevEconomy(p.token), request = { ...command(p), kind: "onboarding" };
  const early = await POST(post(request));
  assert.equal(early.status, 409); assert.equal((await early.json()).code, "ONBOARDING_REWARD_UNAVAILABLE");
  for (const extra of [{ reward: { coins: 100000 } }, { pearls: 100 }, { skipped: true }, { completed: true }, { now: 0 }, { achievementId: "explorer", level: 1 }]) {
    assert.equal((await POST(post({ ...request, ...extra }))).status, 400);
  }
  const other = enterGame(identities.createDevIdentity("Друг", crypto.randomUUID()));
  assert.equal((await POST(post({ ...request, ownerPublicId: other.me.user.publicId }))).status, 409);
  assert.deepEqual(economy.getDevEconomy(p.token).wallet, before.wallet);
  assert.equal((await (await GET(read())).json()).onboarding.claimedAt, null);
});

test("reward reads negotiate new activity rows while cached clients retain their exact catalog", async () => {
  const p = player();
  globalThis.__rewardTestToken = p.token;
  const legacy = await (await GET(read())).json();
  const current = await (await GET(read("?catalog=5"))).json();
  const previous = await (await GET(read("?catalog=6"))).json();
  assert.equal(previous.catalogVersion, 6);
  const latest = await (await GET(read("?catalog=7"))).json();
  assert.equal(latest.catalogVersion, 7);
  assert.equal(latest.achievementRewards.length, 33);
  assert.deepEqual(latest.daily.cycle, current.daily.cycle);
  assert.equal(legacy.catalogVersion, 4); assert.equal(legacy.achievementRewards.length, 21);
  assert.equal(current.catalogVersion, 5); assert.equal(current.achievementRewards.length, 33);
  assert.deepEqual(current.achievementRewards.slice(0, 21), legacy.achievementRewards);
  for (const suffix of ["?catalog=8", "?catalog=5&catalog=5", "?catalog=5&other=1"]) {
    assert.equal((await GET(read(suffix))).status, 400);
  }
});

test("claim reply negotiation preserves one receipt across old and new cached clients", async () => {
  const p = player(), request = command(p);
  const legacy = await (await POST(post(request))).json();
  const nextRequest = new Request("http://localhost:3000/api/v1/game/rewards/claims?catalog=5", post(request));
  const response = await POST(nextRequest), current = await response.json();
  assert.equal(response.status, 200); assert.equal(current.replayed, true);
  assert.deepEqual(current.claim, legacy.claim); assert.deepEqual(current.economy.wallet, legacy.economy.wallet);
  assert.equal(legacy.rewards.achievementRewards.length, 21);
  assert.equal(current.rewards.catalogVersion, 5); assert.equal(current.rewards.achievementRewards.length, 33);
  assert.equal(api.gameRewardResultSchema.safeParse(current).success, true);
  const latest = await (await POST(new Request("http://localhost:3000/api/v1/game/rewards/claims?catalog=6", post(request)))).json();
  assert.equal(latest.rewards.catalogVersion, 6); assert.equal(latest.replayed, true);
  assert.deepEqual(latest.claim, legacy.claim); assert.deepEqual(latest.economy.wallet, legacy.economy.wallet);
  const bad = await POST(new Request("http://localhost:3000/api/v1/game/rewards/claims?catalog=5&catalog=5", post(command(p))));
  assert.equal(bad.status, 400);
});
