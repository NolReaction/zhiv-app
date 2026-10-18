import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
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

test("only the public weather GET bypasses dev gates, with coarse coordinates and no account/game dependency", async () => {
  const savedFetch = globalThis.fetch;
  let providerCalls = 0, route;
  try {
    globalThis.fetch = async (url, init) => {
      providerCalls++;
      assert.equal(url, "https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=55&lon=38");
      assert.equal(init.credentials, "omit");
      assert.equal(new Headers(init.headers).has("cookie"), false);
      assert.equal(new Headers(init.headers).has("authorization"), false);
      const currentHour = Math.floor(Date.now() / 3_600_000) * 3_600_000;
      return Response.json({ properties: {
        meta: { updated_at: new Date(currentHour).toISOString() },
        timeseries: [{ time: new Date(currentHour).toISOString(), data: {
          instant: { details: { air_temperature: 12, cloud_area_fraction: 40 } },
          next_1_hours: { summary: { symbol_code: "partlycloudy_day" } },
        } }],
      } }, { headers: { Expires: new Date(Date.now() + 3_600_000).toUTCString() } });
    };
    route = await vite.ssrLoadModule("/app/api/v1/earth/weather/route.ts");
  } finally { globalThis.fetch = savedFetch; }
  const httpMethods = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];
  assert.deepEqual(httpMethods.filter(method => typeof route[method] === "function"), ["GET"],
    "the public exception must not grow additional exported methods");
  for (const legacy of [false, true]) await withEnvironment("production", legacy, async () => {
    const response = await route.GET(new Request("https://example.test/api/v1/earth/weather?lat=55&lng=38", {
      headers: { Cookie: "session=test-account", Authorization: "<test-identity>" },
    }));
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.provider, "met-norway");
    assert.equal(body.temperatureC, 12);
    assert.equal(body.stale, false);
    assert.equal(Number.isFinite(Date.parse(body.staleUntil)), true);
    assert.match(response.headers.get("cache-control"), /^public, max-age=\d+, must-revalidate$/);
    assert.equal(response.headers.has("set-cookie"), false);
    assert.equal("user" in body || "account" in body || "game" in body, false);
    for (const query of ["lat=55.75&lng=38", "lat=55&lng=38&userId=player", "lat=55&lat=54&lng=38", "lat=90&lng=38"]) {
      const invalid = await route.GET(new Request(`https://example.test/api/v1/earth/weather?${query}`));
      assert.equal(invalid.status, 400);
      assert.equal((await invalid.json()).error, "invalid_coordinates");
      assert.equal(invalid.headers.get("cache-control"), "no-store");
    }
  });
  assert.equal(providerCalls, 1, "cache reuse and rejected precision never use local identity or fetch extra data");
  const imports = source => [...source.matchAll(/from\s+["']([^"']+)["']/g)].map(match => match[1]);
  assert.deepEqual(imports(await readFile(`${root}/app/api/v1/earth/weather/route.ts`, "utf8")), ["@/lib/server/earth-weather"]);
  assert.deepEqual(imports(await readFile(`${root}/lib/server/earth-weather.ts`, "utf8")), ["@/lib/earth-weather-contract"],
    "the public adapter must remain independent from account/game/dev modules");
});

test("every account/game API entrypoint still rejects production except the exact public weather GET", async () => {
  const routes = await Promise.all((await apiRoutes()).map(async path => ({ path, module: await vite.ssrLoadModule(`/${path}`) })));
  let checked = 0, publicWeatherGets = 0;
  await withEnvironment("production", true, async () => {
    for (const { path, module } of routes) for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
      if (typeof module[method] !== "function") continue;
      if (path === "app/api/v1/earth/weather/route.ts" && method === "GET") {
        publicWeatherGets++;
        continue;
      }
      const request = new Request(`https://example.test/${path.slice(4, -9)}`, {
        method, headers: { "Content-Type": "application/json", Origin: "https://example.test" },
        ...(["POST", "PUT", "PATCH"].includes(method) ? { body: JSON.stringify({ action: "dev_grant_resources" }) } : {}),
      });
      const response = await module[method](request, { params: Promise.resolve({ publicId: "player", path: ["overview"] }) });
      const body = await response.json();
      const retired = path.includes("/account-recovery/"), admin = path.includes("/admin/"), studio = path === "app/api/dev/world-studio/route.ts";
      assert.equal(response.status, studio ? 404 : retired ? 410 : 503, `${method} ${path}`);
      assert.equal(body.code, studio ? "STUDIO_PROJECT_UNAVAILABLE" : retired ? "RECOVERY_RETIRED" : admin ? "ADMIN_UNAVAILABLE" : "DEV_API_DISABLED", `${method} ${path}`);
      if (studio) assert.equal(body.available, false, `${method} ${path}`);
      assert.equal(response.headers.get("Cache-Control"), "no-store", `${method} ${path}`);
      checked++;
    }
  });
  assert.equal(publicWeatherGets, 1, "exactly the weather GET is excluded from development-only gates");
  assert.ok(checked >= 45, "all exported HTTP methods are exercised, not just the shared guard");
});
