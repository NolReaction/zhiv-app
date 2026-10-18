import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(() => vite.close());
const { createEarthWeatherHandler } = await vite.ssrLoadModule("/lib/server/earth-weather.ts");
const BASE_TIME = Date.parse("2026-10-18T12:20:00Z");
const HOUR = 3_600_000;
const request = (query = "lat=55&lng=38") => new Request(`https://zhiv.example/api/v1/earth/weather?${query}`);
function forecastBody(symbol = "rain_day") {
  return { properties: {
    meta: { updated_at: "2026-10-18T12:00:00Z" },
    timeseries: Array.from({ length: 12 }, (_, hour) => ({
      time: new Date(Date.parse("2026-10-18T12:00:00Z") + hour * HOUR).toISOString(),
      data: {
        instant: { details: { air_temperature: 12 + hour, cloud_area_fraction: 80, wind_speed: 3.2 } },
        next_1_hours: { summary: { symbol_code: symbol }, details: { precipitation_amount: 1.4 } },
        next_6_hours: { summary: { symbol_code: "heavyrain" }, details: { precipitation_amount: 40 } },
      },
    })),
  } };
}
function providerResponse(body = forecastBody(), expires = BASE_TIME + HOUR) {
  return Response.json(body, { headers: { Expires: new Date(expires).toUTCString(), "Last-Modified": "Sun, 18 Oct 2026 12:00:00 GMT" } });
}

test("weather rejects precise, duplicate, unknown and out-of-world coordinates before any network", async () => {
  let calls = 0;
  const handler = createEarthWeatherHandler({ fetch: async () => { calls++; return providerResponse(); }, now: () => BASE_TIME });
  for (const query of ["lat=55.01&lng=38", "lat=55&lng=38.6231", "lat=90&lng=38", "lat=-90&lng=38", "lat=55&lng=180", "lat=55&lng=-181", "lat=&lng=38", "lat=55&lat=54&lng=38", "lat=55&lng=38&userId=private", "lat=1e1&lng=38", "lat=Infinity&lng=38", "lat=055&lng=38"]) {
    assert.equal((await handler(request(query))).status, 400, query);
  }
  assert.equal(calls, 0);
});

test("one coarse request uses a truthful server identity and returns a small cacheable forecast", async () => {
  let call;
  const handler = createEarthWeatherHandler({ fetch: async (...args) => { call = args; return providerResponse(); }, now: () => BASE_TIME });
  const response = await handler(request());
  assert.equal(response.status, 200);
  assert.equal(call[0], "https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=55&lon=38");
  assert.equal(call[1].headers["User-Agent"], "YaZhivoy/0.7.1 (https://github.com/NolReaction/zhiv-app)");
  assert.equal(call[1].credentials, "omit");
  assert.equal(call[1].redirect, "error");
  assert.match(response.headers.get("cache-control"), /public, max-age=900/);
  const text = await response.text(), data = JSON.parse(text);
  assert.ok(Buffer.byteLength(text) < 1024);
  assert.equal(data.condition, "rain");
  assert.equal(data.precipitationNextHourMm, 1.4);
  assert.equal(data.temperatureC, 12);
  assert.equal(data.isDay, true);
  assert.equal(data.stale, false);
  assert.equal(data.forecastAt, "2026-10-18T12:00:00.000Z");
  assert.equal(data.expiresAt, new Date(BASE_TIME + 900_000).toISOString());
  assert.equal("timeseries" in data, false);
});

test("concurrent and F5 requests reuse the provider response until Expires", async () => {
  let calls = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  const handler = createEarthWeatherHandler({ fetch: async () => { calls++; await gate; return providerResponse(); }, now: () => BASE_TIME });
  const first = handler(request()), second = handler(request());
  await Promise.resolve();
  assert.equal(calls, 1);
  release();
  assert.equal((await first).status, 200);
  assert.equal((await second).status, 200);
  assert.equal((await handler(request())).status, 200);
  assert.equal(calls, 1);
});

test("expired forecasts revalidate with the exact Last-Modified and advance the model hour on304", async () => {
  let time = BASE_TIME, calls = 0;
  const handler = createEarthWeatherHandler({ now: () => time, fetch: async (_url, init) => {
    calls++;
    if (calls === 1) return providerResponse();
    assert.equal(init.headers["If-Modified-Since"], "Sun, 18 Oct 2026 12:00:00 GMT");
    return new Response(null, { status: 304, headers: { Expires: new Date(time + HOUR).toUTCString() } });
  } });
  await handler(request());
  time += HOUR + 1;
  const data = await (await handler(request())).json();
  assert.equal(calls, 2);
  assert.equal(data.temperatureC, 13);
  assert.equal(data.forecastAt, "2026-10-18T13:00:00.000Z");
  assert.equal(data.stale, false);
});

test("missing hourly precipitation is unknown, never replaced with six-hour precipitation", async () => {
  const body = forecastBody();
  for (const entry of body.properties.timeseries) delete entry.data.next_1_hours;
  const handler = createEarthWeatherHandler({ now: () => BASE_TIME, fetch: async () => providerResponse(body) });
  const data = await (await handler(request())).json();
  assert.equal(data.precipitationNextHourMm, null);
  assert.equal(data.condition, "unknown");
  assert.equal(data.isDay, null);
});

test("different cells share a one-request-per-second process budget", async () => {
  let calls = 0;
  const handler = createEarthWeatherHandler({ now: () => BASE_TIME, fetch: async () => { calls++; return providerResponse(); } });
  await handler(request());
  const response = await handler(request("lat=56&lng=38"));
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "1");
  assert.equal(calls, 1);
});

test("provider throttling is respected across cells and only bounded stale forecasts are served", async () => {
  let time = BASE_TIME, calls = 0;
  const handler = createEarthWeatherHandler({ now: () => time, fetch: async () => {
    calls++;
    return calls === 1 ? providerResponse() : new Response(null, { status: 429, headers: { "Retry-After": "36000" } });
  } });
  await handler(request());
  time += HOUR + 1;
  const staleResponse = await handler(request());
  assert.equal(staleResponse.status, 200);
  assert.equal((await staleResponse.json()).stale, true);
  assert.equal(staleResponse.headers.get("cache-control"), "public, max-age=60, must-revalidate");
  const rejected = await handler(request("lat=56&lng=38"));
  assert.equal(rejected.status, 429);
  assert.equal(rejected.headers.get("retry-after"), "36000");
  time += 6 * HOUR + 1;
  assert.equal((await handler(request())).status, 429);
  assert.equal(calls, 2);
});

test("a full cache keeps fresh cells instead of breaking Expires by re-fetching evicted data", async () => {
  let time = BASE_TIME, calls = 0;
  const handler = createEarthWeatherHandler({ now: () => time, fetch: async () => { calls++; return providerResponse(); } });
  for (let lat = 0; lat < 64; lat++) {
    assert.equal((await handler(request(`lat=${lat}&lng=38`))).status, 200);
    time += 1000;
  }
  assert.equal((await handler(request("lat=64&lng=38"))).status, 429);
  assert.equal((await handler(request("lat=0&lng=38"))).status, 200);
  assert.equal(calls, 64);
  time = BASE_TIME + HOUR + 1;
  assert.equal((await handler(request("lat=64&lng=38"))).status, 200);
  assert.equal(calls, 65);
});

test("oversized, malformed and timed-out upstream bodies fail closed without leaking their contents", async () => {
  for (const response of [new Response("secret: invalid JSON"), new Response("x".repeat(512 * 1024 + 1)), new Response("short", { headers: { "Content-Length": String(512 * 1024 + 1) } })]) {
    const handler = createEarthWeatherHandler({ now: () => BASE_TIME, fetch: async () => response });
    const result = await handler(request());
    assert.equal(result.status, 503);
    assert.equal((await result.json()).error, "weather_unavailable");
  }
  let aborted = false;
  const handler = createEarthWeatherHandler({ now: () => BASE_TIME, timeoutMs: 5, fetch: async (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => { aborted = true; reject(new Error("timeout")); }, { once: true });
  }) });
  assert.equal((await handler(request())).status, 503);
  assert.equal(aborted, true);
});

test("synchronous fetch failures do not leave permanent in-flight entries", async () => {
  let time = BASE_TIME, calls = 0;
  const handler = createEarthWeatherHandler({ now: () => time, fetch: () => { calls++; throw new Error("network"); } });
  assert.equal((await handler(request())).status, 503);
  time += 31_000;
  assert.equal((await handler(request())).status, 503);
  assert.equal(calls, 2);
});
