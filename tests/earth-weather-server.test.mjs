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
  assert.equal(data.staleUntil, "2026-10-18T15:00:00.000Z");
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

test("short and already expired provider deadlines stay exact instead of becoming fifteen minutes fresh", async () => {
  for (const expires of [BASE_TIME + 17_000, BASE_TIME - 30_000]) {
    let time = BASE_TIME, calls = 0;
    const handler = createEarthWeatherHandler({ now: () => time, fetch: async () => { calls++; return providerResponse(forecastBody(), expires); } });
    const first = await (await handler(request())).json();
    assert.equal(first.stale, expires <= time);
    assert.equal(first.expiresAt, new Date(expires > time ? expires : time + 60_000).toISOString());
    time += 20_000;
    const second = await (await handler(request())).json();
    assert.equal(second.stale, true);
    assert.equal(second.expiresAt, new Date(time + 60_000).toISOString());
    assert.equal(calls, 1, "revalidation cooldown does not pretend that the old data is fresh");
    time = BASE_TIME + 60_000;
    assert.equal((await (await handler(request())).json()).stale, true);
    assert.equal(calls, 2);
  }
});

test("missing or invalid Expires is stale and revalidates without a hot request loop", async () => {
  for (const expires of [null, "invalid date"]) {
    let time = BASE_TIME, calls = 0;
    const handler = createEarthWeatherHandler({ now: () => time, fetch: async () => {
      calls++;
      return Response.json(forecastBody(), { headers: expires === null ? {} : { Expires: expires } });
    } });
    const initial = await (await handler(request())).json();
    assert.equal(initial.stale, true);
    assert.equal(initial.expiresAt, new Date(time + 60_000).toISOString());
    assert.equal(initial.staleUntil, "2026-10-18T15:00:00.000Z");
    time += 1000;
    assert.equal((await (await handler(request())).json()).stale, true);
    assert.equal(calls, 1);
    time += 59_000;
    await handler(request());
    assert.equal(calls, 2);
  }
});

test("stale expiresAt cannot extend past the absolute provider or model-hour deadline", async () => {
  let time = BASE_TIME, calls = 0;
  const handler = createEarthWeatherHandler({ now: () => time, fetch: async () => {
    calls++;
    return calls === 1 ? providerResponse() : new Response(null, { status: 429, headers: { "Retry-After": "36000" } });
  } });
  await handler(request());
  time += HOUR + 1;
  await handler(request());
  time = BASE_TIME + 7 * HOUR - 15_000;
  const response = await handler(request()), data = await response.json();
  assert.equal(response.status, 200);
  assert.equal(data.staleUntil, new Date(BASE_TIME + 7 * HOUR).toISOString());
  assert.equal(data.expiresAt, data.staleUntil);
  assert.equal(response.headers.get("cache-control"), "public, max-age=15, must-revalidate");
  time += 15_000;
  assert.equal((await handler(request())).status, 429);

  time = BASE_TIME;
  const singleHour = forecastBody();
  singleHour.properties.timeseries.length = 1;
  const single = createEarthWeatherHandler({ now: () => time, fetch: async () => providerResponse(singleHour, BASE_TIME + 12 * HOUR) });
  await single(request());
  time = Date.parse("2026-10-18T14:59:45Z");
  const old = await (await single(request())).json();
  assert.equal(old.staleUntil, "2026-10-18T15:00:00.000Z");
  assert.equal(old.expiresAt, new Date(time).toISOString(), "an old model hour cannot acquire a new future fresh TTL");
  time += 15_000;
  assert.equal((await single(request())).status, 503);
});

test("304 with an expired deadline keeps cached content stale and preserves its validator", async () => {
  let time = BASE_TIME, calls = 0;
  const handler = createEarthWeatherHandler({ now: () => time, fetch: async (_url, init) => {
    calls++;
    if (calls === 1) return providerResponse();
    assert.equal(init.headers["If-Modified-Since"], "Sun, 18 Oct 2026 12:00:00 GMT");
    return new Response(null, { status: 304, headers: { Expires: new Date(time - 1000).toUTCString() } });
  } });
  await handler(request());
  time += HOUR + 1;
  const response = await handler(request()), data = await response.json();
  assert.equal(response.status, 200);
  assert.equal(data.stale, true);
  assert.equal(data.temperatureC, 13);
  assert.equal(data.expiresAt, new Date(time + 60_000).toISOString());
  time += 1000;
  await handler(request());
  assert.equal(calls, 2);
});

test("nullable measurements and unknown model symbols remain explicit at polar and dateline cells", async () => {
  let time = BASE_TIME, calls = 0;
  const body = forecastBody("future_model_symbol");
  for (const entry of body.properties.timeseries) {
    entry.data.instant.details = { air_temperature: 4, cloud_area_fraction: -1, wind_speed: 999 };
    entry.data.next_1_hours.details.precipitation_amount = -1;
  }
  const handler = createEarthWeatherHandler({ now: () => time, fetch: async () => { calls++; return providerResponse(body); } });
  for (const [lat, lng] of [[89, 179], [-89, -180]]) {
    const response = await handler(request(`lat=${lat}&lng=${lng}`)), data = await response.json();
    assert.equal(response.status, 200);
    assert.equal(data.latitude, lat);
    assert.equal(data.longitude, lng);
    assert.equal(data.condition, "unknown");
    assert.equal(data.isDay, null);
    assert.equal(data.cloudCoverPercent, null);
    assert.equal(data.precipitationNextHourMm, null);
    assert.equal(data.windSpeedMps, null);
    time += 1000;
  }
  assert.equal(calls, 2);
});

test("all-in-flight capacity returns a finite retry instead of Infinity or a null JSON value", async () => {
  let time = BASE_TIME, calls = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  const handler = createEarthWeatherHandler({ now: () => time, fetch: async () => {
    calls++;
    await gate;
    return providerResponse();
  } });
  const pending = [];
  try {
    for (let lat = 0; lat < 64; lat++) {
      pending.push(handler(request(`lat=${lat}&lng=38`)));
      await Promise.resolve();
      time += 1000;
    }
    const response = await handler(request("lat=64&lng=38"));
    assert.equal(response.status, 429);
    assert.equal(response.headers.get("retry-after"), "1");
    assert.equal((await response.json()).retryAfterSeconds, 1);
    assert.equal(calls, 64);
  } finally {
    release();
    assert.ok((await Promise.all(pending)).every(response => response.status === 200));
  }
});

test("invalid enormous provider Retry-After cannot publish non-finite retry headers", async () => {
  const handler = createEarthWeatherHandler({ now: () => BASE_TIME, fetch: async () => new Response(null, { status: 429, headers: { "Retry-After": "1e308" } }) });
  const response = await handler(request());
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("retry-after"), "900");
  assert.equal((await response.json()).retryAfterSeconds, 900);
});
