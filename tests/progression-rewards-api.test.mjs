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
  assert.equal(api.gameRewardsSchema.safeParse(await response.json()).success, true);
  assert.deepEqual(economy.getDevEconomy(p.token).wallet, before.wallet);
  assert.equal((await GET(read("?step=7"))).status, 400);
});
test("manual HTTP claim echoes its key and a lost-response retry returns the same immutable gift", async () => {
  const p = player(), request = command(p), response = await POST(post(request));
  assert.equal(response.status, 200); assert.equal(response.headers.get("Cache-Control"), "no-store");
  const first = await response.json(); assert.equal(api.gameRewardResultSchema.safeParse(first).success, true);
  assert.equal(first.requestId, request.requestId); assert.equal(first.claim.kind, "daily"); assert.equal(first.claim.step, 1);
  const repeat = await (await POST(post(request))).json(); assert.equal(repeat.replayed, true); assert.deepEqual(repeat.claim, first.claim);
  assert.equal(repeat.economy.wallet.coins, first.economy.wallet.coins);
  const duplicate = await POST(post(command(p))); assert.equal(duplicate.status, 409); assert.equal((await duplicate.json()).code, "DAILY_REWARD_COOLDOWN");
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
