import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(() => vite.close());
const { guardDevApi } = await vite.ssrLoadModule("/lib/dev/api-guard.ts");
const { default: TiledWorldPage } = await vite.ssrLoadModule("/app/prototype/tiled-world/page.tsx");
const { TiledWorldPreview } = await vite.ssrLoadModule("/features/world/tiled/tiled-world-preview.tsx");

async function withEnvironment(mode, enableLegacyOverride, run) {
  const saved = { NODE_ENV: process.env.NODE_ENV, ENABLE_DEV_API: process.env.ENABLE_DEV_API };
  try {
    if (mode === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = mode;
    process.env.ENABLE_DEV_API = enableLegacyOverride ? "true" : "false";
    return await run();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

test("the memory API fails closed outside development/test, including the retired production override", async () => {
  const request = new Request("http://localhost:3000/api/v1/me");
  for (const mode of ["production", "preview", undefined]) for (const legacy of [false, true]) {
    await withEnvironment(mode, legacy, async () => {
      const response = guardDevApi(request);
      assert.equal(response?.status, 503, `${mode}, ENABLE_DEV_API=${legacy}`);
      assert.equal((await response.json()).code, "DEV_API_DISABLED");
      assert.equal(response.headers.get("Cache-Control"), "no-store");
    });
  }
  for (const mode of ["development", "test"]) await withEnvironment(mode, false, () => {
    assert.equal(guardDevApi(request), null);
    assert.equal(guardDevApi(new Request(request.url, { headers: { "sec-fetch-site": "cross-site" } })).status, 403,
      "local mode retains the origin guard");
  });
});

test("direct prototype navigation returns framework 404 outside local development", async () => {
  for (const mode of ["production", "test", undefined]) await withEnvironment(mode, true, () => {
    assert.throws(() => TiledWorldPage(), error => error.digest === "NEXT_HTTP_ERROR_FALLBACK;404");
  });
  await withEnvironment("development", false, () => assert.equal(TiledWorldPage().type, TiledWorldPreview));
});

async function apiRoutes(directory = "app/api") {
  const paths = [];
  for (const entry of await readdir(`${root}/${directory}`, { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) paths.push(...await apiRoutes(path));
    else if (entry.name === "route.ts") paths.push(path);
  }
  return paths;
}

test("every standalone web API entrypoint rejects production before accessing local identity or game data", async () => {
  const routes = await Promise.all((await apiRoutes()).map(async path => ({ path, module: await vite.ssrLoadModule(`/${path}`) })));
  let checked = 0;
  await withEnvironment("production", true, async () => {
    for (const { path, module } of routes) for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
      if (typeof module[method] !== "function") continue;
      const request = new Request(`https://example.test/${path.slice(4, -9)}`, {
        method, headers: { "Content-Type": "application/json", Origin: "https://example.test" },
        ...(["POST", "PUT", "PATCH"].includes(method) ? { body: JSON.stringify({ action: "dev_grant_resources" }) } : {}),
      });
      const response = await module[method](request, { params: Promise.resolve({ publicId: "player", path: ["overview"] }) });
      const body = await response.json();
      const retired = path.includes("/account-recovery/"), admin = path.includes("/admin/");
      assert.equal(response.status, retired ? 410 : 503, `${method} ${path}`);
      assert.equal(body.code, retired ? "RECOVERY_RETIRED" : admin ? "ADMIN_UNAVAILABLE" : "DEV_API_DISABLED", `${method} ${path}`);
      assert.equal(response.headers.get("Cache-Control"), "no-store", `${method} ${path}`);
      checked++;
    }
  });
  assert.ok(checked >= 45, "all exported HTTP methods are exercised, not just the shared guard");
});
