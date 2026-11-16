import assert from "node:assert/strict";
import test, { after, afterEach } from "node:test";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
const { readAdminPageAccess } = await vite.ssrLoadModule("/lib/server/admin-page-access.ts");
const { GET } = await vite.ssrLoadModule("/app/branch/reports/route.ts");
const { BranchAccessGate } = await vite.ssrLoadModule("/features/progression/access/branch-access-gate.tsx");
const identity = await vite.ssrLoadModule("/lib/dev/api-store.ts");
const local = await vite.ssrLoadModule("/lib/dev/admin-access.ts");
const previous = { NODE_ENV: process.env.NODE_ENV, ADMIN_API_ORIGIN: process.env.ADMIN_API_ORIGIN, DEV_ADMIN_PASSWORD: process.env.DEV_ADMIN_PASSWORD };
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
after(() => vite.close());
const actor = "7K3P-2Q9M-W8ZR", token = "a".repeat(43);
const request = (cookie = `__Host-zhiv_session=${token}`, extra = {}) => new Request("https://im-alive.ru/branch/reports", { headers: { cookie, ...extra } });
function production() { process.env.NODE_ENV = "production"; process.env.ADMIN_API_ORIGIN = "http://api:8080"; }

test("branch authorization forwards only the session cookie to a configured fixed backend", async () => {
  production(); let calls = 0;
  globalThis.fetch = async (url, options) => {
    calls++; assert.equal(String(url), "http://api:8080/api/v1/admin/access");
    assert.equal(options.cache, "no-store"); assert.equal(options.redirect, "error");
    assert.equal(new Headers(options.headers).get("cookie"), `__Host-zhiv_session=${token}`);
    assert.equal(new Headers(options.headers).has("authorization"), false);
    return Response.json({ publicId: actor });
  };
  assert.deepEqual(await readAdminPageAccess(request(`unrelated=${crypto.randomUUID()}; __Host-zhiv_session=${token}`, { host: "attacker.example", "x-forwarded-host": "attacker.example", authorization: crypto.randomUUID() })), { status: "allowed", publicId: actor });
  assert.equal(calls, 1);
});

test("anonymous, malformed and duplicate cookies cannot request protected reports", async () => {
  production(); globalThis.fetch = () => { assert.fail("Must not contact the backend without one valid session token"); };
  for (const cookie of ["", "__Host-zhiv_session=x", `__Host-zhiv_session=${token}; __Host-zhiv_session=${token}`, `__Host-zhiv_session=${"a".repeat(129)}`]) {
    const result = await GET(request(cookie)); assert.equal(result.status, 401);
    assert.equal(result.headers.get("cache-control"), "private, no-store");
    const body = await result.json(); assert.equal(body.code, "BRANCH_ACCESS_REQUIRED"); assert.equal(body.scenarios, undefined);
  }
});

test("denied, unavailable and malformed upstream responses fail closed", async () => {
  production();
  for (const [response, status] of [[new Response(null, { status: 401 }), 401], [new Response(null, { status: 403 }), 403],
    [new Response(null, { status: 500 }), 503], [new Response(null, { status: 302 }), 503], [Response.json({ publicId: "bad" }), 503], [Response.json({ allowed: true }), 503]]) {
    globalThis.fetch = async () => response;
    const result = await GET(request()); assert.equal(result.status, status); assert.equal((await result.json()).code, "BRANCH_ACCESS_REQUIRED");
  }
  globalThis.fetch = async () => { throw new Error("Offline"); };
  assert.equal((await GET(request())).status, 503);
});

test("missing or unsafe upstream configuration never falls back to request Host", async () => {
  production(); globalThis.fetch = () => { assert.fail("Invalid upstream must not be fetched"); };
  const credentialed = new URL("http://api:8080"); credentialed.username = crypto.randomUUID(); credentialed.password = crypto.randomUUID();
  for (const value of ["", credentialed.href, "file:///tmp/admin", "http://api:8080/redirect", "http://api:8080/?url=other", "http://api:8080/#admin"]) {
    process.env.ADMIN_API_ORIGIN = value;
    assert.deepEqual(await readAdminPageAccess(request()), { status: "unavailable" });
  }
});

test("allowed administrators receive uncached reports, and the next denied request cannot reuse them", async () => {
  production(); globalThis.fetch = async () => Response.json({ publicId: actor });
  const result = await GET(request()); assert.equal(result.status, 200); assert.equal(result.headers.get("cache-control"), "private, no-store");
  assert.equal((await result.json()).schemaVersion, 1);
  globalThis.fetch = async () => new Response(null, { status: 403 });
  assert.equal((await GET(request())).status, 403);
});

test("local access requires an unlocked real session, expires and refuses public hosts", async () => {
  process.env.NODE_ENV = "test"; process.env.DEV_ADMIN_PASSWORD = crypto.randomUUID();
  identity.resetDevStoreForTests(); local.resetDevAdminAccessForTests();
  const user = identity.createDevIdentity("Админ", crypto.randomUUID());
  const localRequest = (host = "localhost:3000") => new Request(`http://${host}/branch`, { headers: { host, cookie: `zhiv_session_dev=${user.token}` } });
  assert.deepEqual(await readAdminPageAccess(localRequest()), { status: "forbidden" });
  assert.equal(local.unlockDevAdmin(user.token, process.env.DEV_ADMIN_PASSWORD), "ok");
  assert.deepEqual(await readAdminPageAccess(localRequest()), { status: "allowed", publicId: user.me.user.publicId });
  assert.deepEqual(await readAdminPageAccess(localRequest("public.example")), { status: "forbidden" });
  local.unlockDevAdmin(user.token, process.env.DEV_ADMIN_PASSWORD, Date.now() - 9 * 60 * 60_000);
  assert.deepEqual(await readAdminPageAccess(localRequest()), { status: "forbidden" });
});

test("denied server render contains only access guidance, never the workspace or economic report", () => {
  for (const status of ["signed-out", "forbidden", "unavailable"]) {
    const markup = renderToStaticMarkup(createElement(BranchAccessGate, { initial: { status } }));
    assert.match(markup, /\/admin/); assert.doesNotMatch(markup, /sourceSha256|full-max|Карта связей|Смородиновое желе/);
  }
});

test("route, service worker and deployment keep branch dynamic and network-only", async () => {
  const [page, worker, compose] = await Promise.all(["app/branch/page.tsx", "public/sw.js", "deploy/compose.yml"].map(path => readFile(new URL(`../${path}`, import.meta.url), "utf8")));
  assert.match(page, /dynamic = "force-dynamic"/); assert.match(page, /await readAdminPageAccess/);
  assert.match(worker, /url\.pathname === "\/branch"/); assert.match(compose, /ADMIN_API_ORIGIN: http:\/\/api:8080/);
});
