import assert from "node:assert/strict";
import test, { after, afterEach } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
const api = await vite.ssrLoadModule("/lib/admin-api.ts");
const { ApiError } = await vite.ssrLoadModule("/lib/check-in-api.ts");
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
after(() => vite.close());
const serverTime = "2026-09-07T12:00:00Z";
const publicId = "7K3P-2Q9M-W8ZR";

test("admin requests use same-origin authentication and bypass caches", async () => {
  globalThis.fetch = async (url, options) => {
    assert.equal(url, "/api/v1/admin/access");
    assert.equal(options.credentials, "same-origin");
    assert.equal(options.cache, "no-store");
    assert.equal(options.method, "GET");
    assert.equal(options.headers.Authorization, undefined);
    return Response.json({ publicId, displayName: "Admin", serverTime, secret: "must-be-stripped" });
  };
  assert.deepEqual(await api.getAdminAccess(), { publicId, displayName: "Admin", serverTime });
});
test("401 and 403 remain distinguishable even with an invalid error body", async () => {
  for (const status of [401, 403]) {
    globalThis.fetch = async () => new Response("not JSON", { status, headers: { "X-Request-ID": "trace" } });
    await assert.rejects(api.getAdminAccess(), error => error instanceof ApiError && error.status === status);
  }
});
test("malformed successful responses cannot become an authorized identity", async () => {
  for (const body of [{ publicId: "*", displayName: "Admin", serverTime }, { publicId, displayName: "Admin" }]) {
    globalThis.fetch = async () => Response.json(body);
    await assert.rejects(api.getAdminAccess(), error => error instanceof ApiError && error.status === 502);
  }
});
test("action sends explicit confirmation and preserves an idempotent request when retried", async () => {
  const body = { requestId: "9a272b65-8ada-4b0d-aad8-6a6ef845f41b", confirmationPublicId: publicId, reason: "Lost device reported" };
  const sent = [];
  globalThis.fetch = async (url, options) => {
    assert.equal(url, `/api/v1/admin/users/${publicId}/revoke-sessions`);
    assert.equal(options.method, "POST");
    sent.push(JSON.parse(options.body));
    if (sent.length === 1) throw new TypeError("Response lost");
    return Response.json({ requestId: body.requestId, affectedSessions: 2, createdAt: serverTime });
  };
  await assert.rejects(api.revokeAdminSessions(publicId, body));
  const receipt = await api.revokeAdminSessions(publicId, body);
  assert.equal(receipt.affectedSessions, 2);
  assert.deepEqual(sent, [body, body]);
});
test("cancelled requests abort the underlying fetch", async () => {
  const controller = new AbortController();
  globalThis.fetch = (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
  });
  const pending = api.getAdminAccess(controller.signal);
  controller.abort();
  await assert.rejects(pending, error => error.name === "AbortError");
});

test("reward requests preserve catalog choice and exact retry payload without changing scores", async () => {
  const body = { requestId: "9a272b65-8ada-4b0d-aad8-6a6ef845f41b", confirmationPublicId: publicId,
    kind: "item", rewardId: "leaf_garland", reason: "Help with testing" };
  const sent = [];
  globalThis.fetch = async (url, options) => {
    assert.equal(url, `/api/v1/admin/users/${publicId}/grant-reward`);
    assert.equal(options.method, "POST"); assert.equal(options.cache, "no-store");
    sent.push(JSON.parse(options.body));
    if (sent.length === 1) throw new TypeError("Response lost");
    return Response.json({ requestId: body.requestId, kind: body.kind, rewardId: body.rewardId, granted: true, createdAt: serverTime });
  };
  await assert.rejects(api.grantAdminReward(publicId, body));
  assert.equal((await api.grantAdminReward(publicId, body)).granted, true);
  assert.deepEqual(sent, [body, body]);
  globalThis.fetch = async () => Response.json({ publicId, serverTime, items: ["leaf_garland"], achievements: ["ten_thousand_series"] });
  assert.deepEqual((await api.getAdminRewards(publicId)).items, ["leaf_garland"]);
  globalThis.fetch = async () => Response.json({ publicId, serverTime, items: ["forged"], achievements: [] });
  await assert.rejects(api.getAdminRewards(publicId), error => error.status === 502);
});

test("incident filters encode separately and the summary covers the whole result", async () => {
  globalThis.fetch=async url=>{
    const parsed=new URL(url,'https://example.invalid');
    assert.equal(parsed.searchParams.get('rangeMinutes'),'43200');assert.equal(parsed.searchParams.get('source'),'client');
    assert.equal(parsed.searchParams.get('code'),'WORLD_MAP_TIMEOUT');assert.equal(parsed.searchParams.get('q'),'A & B');
    return Response.json({serverTime,total:52,totalOccurrences:130,affectedUsers:8,offset:25,limit:25,events:[]});
  };
  const result=await api.getAdminIncidents({rangeMinutes:43200,source:'client',code:'WORLD_MAP_TIMEOUT',q:'A & B',offset:25});
  assert.equal(result.affectedUsers,8);assert.equal(result.totalOccurrences,130);
});
