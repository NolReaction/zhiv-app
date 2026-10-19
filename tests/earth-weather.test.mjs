import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { earthTestCanvasContext } from "./earth-canvas-harness.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { createEarthWeatherProvider, createEarthWeatherController, createEarthWeatherCache, earthWeatherArea,
  EARTH_WEATHER_CACHE_LIMIT, EARTH_WEATHER_CACHE_TTL_MS, EARTH_WEATHER_MAX_STALE_MS, EARTH_WEATHER_MIN_INTERVAL_MS } = await vite.ssrLoadModule("/features/earth/weather.ts");
const { createEarthWeather } = await vite.ssrLoadModule("/features/earth/earth-weather.ts");
const BASE_TIME = Date.parse("2026-10-18T12:20:00Z");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const flush = async () => { for (let index = 0; index < 8; index++) await Promise.resolve(); };
function reading(time = BASE_TIME, values = {}) {
  return { condition: "rain", temperatureC: 12, cloudCoverPercent: 80, precipitationMm: 1.4, windSpeedMps: 3.2,
    forecastAt: time, updatedAt: time, expiresAt: time + EARTH_WEATHER_CACHE_TTL_MS,
    staleUntil: time + EARTH_WEATHER_CACHE_TTL_MS + EARTH_WEATHER_MAX_STALE_MS,
    stale: false, isDay: true, ...values };
}
function responseBody(values = {}) {
  const value = reading();
  return { provider: "met-norway", latitude: 55, longitude: 38, condition: value.condition,
    temperatureC: value.temperatureC, cloudCoverPercent: value.cloudCoverPercent,
    precipitationNextHourMm: value.precipitationMm, windSpeedMps: value.windSpeedMps,
    forecastAt: new Date(value.forecastAt).toISOString(), updatedAt: new Date(value.updatedAt).toISOString(),
    expiresAt: new Date(value.expiresAt).toISOString(), staleUntil: new Date(value.staleUntil).toISOString(),
    stale: false, isDay: true, ...values };
}
function controllerFixture({ cache = createEarthWeatherCache(), provider: suppliedProvider, minimumIntervalMs, fetchWeather } = {}) {
  let time = BASE_TIME, sequence = 0;
  const timers = new Map(), states = [], calls = [];
  const provider = suppliedProvider ?? { id: "test", minimumIntervalMs,
    fetchWeather(area, signal) {
      calls.push({ area, signal, time });
      return fetchWeather ? fetchWeather(area, signal, time) : Promise.resolve(reading(time));
    } };
  const controller = createEarthWeatherController({ provider, cache, onState: value => states.push(value), now: () => time,
    schedule(callback, delay) { const id = ++sequence; timers.set(id, { callback, at: time + delay }); return id; },
    cancel: id => timers.delete(id) });
  return { controller, cache, calls, states, timers, get time() { return time; }, get state() { return states.at(-1); },
    activate(view = { longitude: 37.62, latitude: 55.75, zoom: 3 }) {
      controller.setView(view); controller.setVisible(true); controller.setEnabled(true);
    },
    async advance(duration) {
      const end = time + duration;
      for (;;) {
        const next = [...timers.entries()].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        time = next[1].at; timers.delete(next[0]); next[1].callback(); await flush();
      }
      time = end; await flush();
    } };
}

test("weather areas round the view center, wrap the date line and keep both poles inside the public API", () => {
  assert.deepEqual(earthWeatherArea(37.6231, 55.752), { key: "56:38", longitude: 38, latitude: 56 });
  for (const longitude of [180, -180, 540, 179.7]) assert.equal(earthWeatherArea(longitude, 0).key, "0:-180");
  assert.equal(earthWeatherArea(0, 90).latitude, 89);
  assert.equal(earthWeatherArea(0, -90).latitude, -89);
  assert.equal(Object.is(earthWeatherArea(-0.1, -0.1).longitude, -0), false);
  for (const coordinates of [[0, 90.1], [Infinity, 0], [0, NaN]]) assert.equal(earthWeatherArea(...coordinates), null);
});

test("the public provider sends only coarse coordinates and preserves nullable, unknown and exact stale boundaries", async () => {
  const calls = [], signal = new AbortController().signal;
  const expiresAt = BASE_TIME + MINUTE;
  const staleUntil = BASE_TIME + 2 * MINUTE;
  const provider = createEarthWeatherProvider({ fetch: async (...args) => {
    calls.push(args);
    return Response.json(responseBody({ temperatureC: null, cloudCoverPercent: null, windSpeedMps: null,
      precipitationNextHourMm: null, isDay: null, condition: "unknown", stale: true,
      expiresAt: new Date(expiresAt).toISOString(), staleUntil: new Date(staleUntil).toISOString() }));
  } });
  await assert.rejects(() => provider.fetchWeather({ key: "55:38", latitude: 55.01, longitude: 38 }, signal), /coarse/);
  assert.equal(calls.length, 0);
  const value = await provider.fetchWeather(earthWeatherArea(38, 55), signal);
  assert.equal(calls[0][0], "/api/v1/earth/weather?lat=55&lng=38");
  assert.deepEqual(calls[0][1], { signal, credentials: "same-origin", headers: { Accept: "application/json" } });
  assert.equal(value.condition, "unknown");
  for (const field of ["temperatureC", "cloudCoverPercent", "windSpeedMps", "precipitationMm", "isDay"]) assert.equal(value[field], null);
  assert.equal(value.expiresAt, expiresAt); assert.equal(value.staleUntil, staleUntil); assert.equal(value.stale, true);
});

test("the provider rejects mismatched regions and malformed forecast values", async () => {
  for (const changes of [{ latitude: 56 }, { provider: "other" }, { condition: "invented" }, { temperatureC: 100 },
    { cloudCoverPercent: -1 }, { precipitationNextHourMm: 1001 }, { windSpeedMps: -1 },
    { stale: null }, { expiresAt: "invalid" }, { staleUntil: new Date(BASE_TIME).toISOString() }]) {
    const provider = createEarthWeatherProvider({ fetch: async () => Response.json(responseBody(changes)) });
    await assert.rejects(() => provider.fetchWeather(earthWeatherArea(38, 55), new AbortController().signal));
  }
});

test("disabled, hidden and distant views make zero requests; a settled foreground cell makes one", async () => {
  const s = controllerFixture();
  s.controller.setView({ longitude: 38, latitude: 55, zoom: 5 });
  s.controller.setVisible(true); await s.advance(HOUR); assert.equal(s.calls.length, 0);
  s.controller.setView({ longitude: 38, latitude: 55, zoom: 2.99 });
  s.controller.setEnabled(true); await s.advance(HOUR); assert.equal(s.calls.length, 0); assert.equal(s.state.status, "zoom-in");
  s.controller.setView({ longitude: 38.3, latitude: 55.1, zoom: 3 });
  await s.advance(449); assert.equal(s.calls.length, 0);
  await s.advance(1); assert.equal(s.calls.length, 1); assert.equal(s.state.status, "ready");
  assert.deepEqual(s.calls[0].area, earthWeatherArea(38.3, 55.1));
  s.controller.setVisible(false); assert.equal(s.timers.size, 0);
  await s.advance(HOUR); assert.equal(s.calls.length, 1);
  s.controller.dispose();
});

test("camera movement clears another cell's forecast immediately and shares the request budget across maps", async () => {
  const cache = createEarthWeatherCache();
  const s = controllerFixture({ cache, minimumIntervalMs: 1 });
  s.activate(); await flush(); assert.equal(s.calls.length, 1);
  s.controller.setView({ longitude: 38.4, latitude: 55.7, zoom: 3 });
  await s.advance(1); assert.equal(s.calls.length, 1, "same rounded cell keeps the forecast");
  s.controller.setView({ longitude: 40.3, latitude: 50.1, zoom: 3 });
  assert.equal(s.state.status, "waiting"); assert.equal(s.state.snapshot, null);
  const other = controllerFixture({ cache }); other.activate({ longitude: 0, latitude: 0, zoom: 5 }); await flush();
  assert.equal(other.calls.length, 0, "another map cannot bypass the shared request budget"); other.controller.dispose();
  await s.advance(EARTH_WEATHER_MIN_INTERVAL_MS - 2); assert.equal(s.calls.length, 1);
  await s.advance(1); assert.equal(s.calls.length, 2);
  assert.deepEqual(s.calls[1].area, earthWeatherArea(40.3, 50.1));
  s.controller.dispose();
});

test("fresh entries expire at the proxy boundary, and stale responses never become fifteen-minute fresh forecasts", async () => {
  const s = controllerFixture({ minimumIntervalMs: MINUTE, fetchWeather: async (_area, _signal, time) => reading(time, {
    expiresAt: time + 20_000, staleUntil: time + HOUR, stale: true,
  }) });
  s.activate(); await flush();
  assert.equal(s.state.status, "stale"); assert.equal(s.state.snapshot.expiresAt, BASE_TIME + 20_000);
  await s.advance(20_000); assert.equal(s.state.status, "stale"); assert.equal(s.state.nextRequestAt, BASE_TIME + MINUTE);
  await s.advance(40_000); assert.equal(s.calls.length, 2); assert.equal(s.state.status, "stale");
  s.controller.dispose();
});

test("a fresh reading cannot extend the local fifteen-minute TTL or the six-hour failure-cache limit", async () => {
  const s = controllerFixture({ fetchWeather: async (_area, _signal, time) => reading(time, { expiresAt: time + 24 * HOUR, staleUntil: time + 30 * HOUR }) });
  s.activate(); await flush();
  assert.equal(s.state.snapshot.expiresAt, BASE_TIME + EARTH_WEATHER_CACHE_TTL_MS);
  assert.equal(s.state.snapshot.staleUntil, BASE_TIME + EARTH_WEATHER_CACHE_TTL_MS + EARTH_WEATHER_MAX_STALE_MS);
  s.controller.dispose();
});

test("a long non-JSON Retry-After drops stale artwork at its absolute deadline without requesting early", async () => {
  let calls = 0, s;
  const provider = createEarthWeatherProvider({ now: () => s.time, fetch: async () => {
    calls++;
    return calls === 1 ? Response.json(responseBody({ expiresAt: new Date(BASE_TIME + MINUTE).toISOString(),
      staleUntil: new Date(BASE_TIME + 2 * MINUTE).toISOString() }))
      : new Response("temporarily unavailable", { status: 429, headers: { "Retry-After": "36000" } });
  } });
  s = controllerFixture({ provider }); s.activate({ longitude: 38, latitude: 55, zoom: 4 }); await flush();
  await s.advance(MINUTE); assert.equal(calls, 2); assert.equal(s.state.status, "stale");
  await s.advance(MINUTE); assert.equal(s.state.snapshot, null); assert.equal(s.state.status, "waiting");
  assert.equal(calls, 2); assert.equal(s.state.nextRequestAt, BASE_TIME + MINUTE + 36_000_000);
  s.controller.dispose();
});

test("hidden, disabled and disposed requests abort and late results cannot publish or populate the cache", async () => {
  for (const stop of [controller => controller.setVisible(false), controller => controller.setEnabled(false), controller => controller.dispose()]) {
    let release;
    const s = controllerFixture({ fetchWeather: () => new Promise(resolve => { release = resolve; }) });
    s.activate(); await flush(); assert.equal(s.calls.length, 1);
    stop(s.controller); const stateCount = s.states.length;
    assert.equal(s.calls[0].signal.aborted, true); assert.equal(s.timers.size, 0);
    release(reading()); await flush(); assert.equal(s.states.length, stateCount);
    assert.equal(s.cache.get("test:56:38"), undefined);
    s.controller.dispose();
  }
});

test("returning from a hidden request observes its reserved budget and uses a new abort generation", async () => {
  const pending = [];
  const s = controllerFixture({ fetchWeather: () => new Promise(resolve => pending.push(resolve)) });
  s.activate(); await flush(); s.controller.setVisible(false); s.controller.setVisible(true);
  assert.equal(s.state.status, "waiting"); assert.equal(s.state.snapshot, null);
  await s.advance(EARTH_WEATHER_MIN_INTERVAL_MS); assert.equal(s.calls.length, 2);
  assert.notEqual(s.calls[0].signal, s.calls[1].signal); assert.equal(s.calls[1].signal.aborted, false);
  pending[0](reading()); await flush(); assert.equal(s.state.status, "loading");
  pending[1](reading(s.time)); await flush(); assert.equal(s.state.status, "ready");
  s.controller.dispose();
});

test("a previous cell's pending result is aborted and cannot replace the new forecast", async () => {
  const pending = [];
  const s = controllerFixture({ fetchWeather: () => new Promise(resolve => pending.push(resolve)) });
  s.activate(); await flush();
  s.controller.setView({ longitude: 0, latitude: 10, zoom: 5 });
  assert.equal(s.calls[0].signal.aborted, true); assert.equal(s.state.snapshot, null);
  pending[0](reading()); await flush(); assert.equal(s.state.status, "waiting");
  await s.advance(EARTH_WEATHER_MIN_INTERVAL_MS); pending[1](reading(s.time)); await flush();
  assert.equal(s.state.snapshot.area.key, "10:0"); assert.equal(s.cache.get("test:56:38"), undefined);
  s.controller.dispose();
});

test("an old forecast expires during a hanging refresh, before the request timeout", async () => {
  let calls = 0;
  const s = controllerFixture({ fetchWeather: async (_area, _signal, time) => {
    if (++calls > 1) return new Promise(() => {});
    return reading(time, { expiresAt: time + MINUTE, staleUntil: time + MINUTE + 5_000 });
  } });
  s.activate(); await flush(); await s.advance(MINUTE); assert.equal(s.state.status, "stale");
  await s.advance(5_000); assert.equal(s.state.status, "loading"); assert.equal(s.state.snapshot, null);
  assert.equal(s.calls[1].signal.aborted, false);
  s.controller.dispose();
});

test("huge Retry-After values remain finite and never overflow into a fast retry loop", async () => {
  for (const retryAfter of ["36000000", "1e308"]) {
    let calls = 0, s;
    const provider = createEarthWeatherProvider({ now: () => s.time, fetch: async () => {
      calls++;
      return new Response(null, { status: 429, headers: { "Retry-After": retryAfter } });
    } });
    s = controllerFixture({ provider }); s.activate(); await flush();
    assert.equal(calls, 1); assert.equal(Number.isFinite(s.state.nextRequestAt), true);
    assert.equal([...s.timers.values()][0].at - s.time, 2_147_483_647);
    await s.advance(2_147_483_647);
    assert.equal(calls, 1); assert.equal(s.timers.size, 1);
    assert.equal([...s.timers.values()][0].at - s.time, 2_147_483_647);
    s.controller.dispose();
  }
});

test("request deadlines abort hanging providers and cleanly back off; disposal removes every timer", async () => {
  const s = controllerFixture({ fetchWeather: () => new Promise(() => {}) });
  s.activate(); await flush(); await s.advance(12_000);
  assert.equal(s.calls[0].signal.aborted, true); assert.equal(s.state.status, "error"); assert.equal(s.timers.size, 1);
  s.controller.dispose(); s.controller.dispose(); assert.equal(s.timers.size, 0);
  await s.advance(HOUR); assert.equal(s.calls.length, 1);
});

test("temporary failures retry in fifteen seconds, then back off to thirty and sixty seconds and reset after success", async () => {
  let calls = 0;
  const s = controllerFixture({ fetchWeather: async (_area, _signal, time) => {
    if (++calls <= 3 || calls === 5) throw new Error("network unavailable");
    return reading(time);
  } });
  s.activate(); await flush();
  assert.equal(s.state.nextRequestAt, BASE_TIME + 15_000);
  await s.advance(15_000); assert.equal(calls, 2); assert.equal(s.state.nextRequestAt, BASE_TIME + 45_000);
  await s.advance(30_000); assert.equal(calls, 3); assert.equal(s.state.nextRequestAt, BASE_TIME + 105_000);
  await s.advance(60_000); assert.equal(calls, 4); assert.equal(s.state.status, "ready");
  s.controller.setView({ longitude: 0, latitude: 10, zoom: 10 });
  await s.advance(15_000); assert.equal(calls, 5); assert.equal(s.state.nextRequestAt, BASE_TIME + 135_000);
  s.controller.dispose();
});

test("a short provider throttle obeys the fifteen-second shared budget without adding fifteen minutes", async () => {
  let calls = 0, s;
  const provider = createEarthWeatherProvider({ now: () => s.time, fetch: async () => ++calls === 1
    ? new Response(null, { status: 429, headers: { "Retry-After": "1" } }) : Response.json(responseBody()) });
  s = controllerFixture({ provider }); s.activate({ longitude: 38, latitude: 55, zoom: 5 }); await flush();
  assert.equal(s.state.nextRequestAt, BASE_TIME + 15_000);
  await s.advance(14_999); assert.equal(calls, 1);
  await s.advance(1); assert.equal(calls, 2); assert.equal(s.state.status, "ready");
  s.controller.setView({ longitude: 38, latitude: 55, zoom: 12 }); await s.advance(MINUTE);
  assert.equal(calls, 2, "zooming within the same cell reuses its forecast");
  s.controller.dispose();
});

test("the bounded memory cache keeps recently used cells and never shortens a reserved request budget", () => {
  const cache = createEarthWeatherCache();
  for (let index = 0; index < EARTH_WEATHER_CACHE_LIMIT; index++) cache.put(String(index), reading());
  assert.ok(cache.get("0")); cache.put("last", reading());
  assert.equal(cache.get("1"), undefined); assert.ok(cache.get("0")); assert.ok(cache.get("last"));
  cache.reserve(BASE_TIME + HOUR); cache.reserve(BASE_TIME); assert.equal(cache.nextRequestAt(), BASE_TIME + HOUR);
});

function rendererFixture() {
  const elements = [], listeners = new Map(), camera = { lng: 38, lat: 55, zoom: 5 };
  const ownerDocument = { defaultView: { devicePixelRatio: 3 }, createElement(tag) {
    const context = earthTestCanvasContext();
    const element = { tag, attributes: {}, children: [], dataset: {}, className: "", style: {}, hidden: false, width: 0, height: 0, removed: 0,
      append(...children) { this.children.push(...children); }, remove() { this.removed++; },
      setAttribute(key, value) { this.attributes[key] = value; }, getContext: () => context, context };
    elements.push(element); return element;
  } };
  const container = { ownerDocument, clientWidth: 600, clientHeight: 600, children: [], append(...children) { this.children.push(...children); } };
  const mercatorY = latitude => (1 - Math.asinh(Math.tan(latitude * Math.PI / 180)) / Math.PI) / 2;
  const map = { getContainer: () => container, getCanvasContainer: () => container, getCenter: () => camera, getZoom: () => camera.zoom,
    project(position) {
      const [lng, lat] = Array.isArray(position) ? position : [position.lng, position.lat];
      const scale = 512 * 2 ** camera.zoom;
      const delta = ((lng - camera.lng + 540) % 360) - 180;
      return { x: container.clientWidth / 2 + delta / 360 * scale,
        y: container.clientHeight / 2 + (mercatorY(lat) - mercatorY(camera.lat)) * scale };
    },
    unproject(point) {
      const [x, y] = Array.isArray(point) ? point : [point.x, point.y];
      const scale = 512 * 2 ** camera.zoom;
      return { lng: camera.lng + (x - container.clientWidth / 2) / scale * 360,
        lat: Math.atan(Math.sinh(Math.PI * (1 - 2 * (mercatorY(camera.lat) + (y - container.clientHeight / 2) / scale)))) * 180 / Math.PI };
    },
    on(type, callback) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(callback); },
    off(type, callback) { listeners.get(type)?.delete(callback); if (!listeners.get(type)?.size) listeners.delete(type); } };
  class ForbiddenMarker { constructor() { throw new Error("Weather must not create repeated icon markers"); } }
  const renderer = createEarthWeather(map, ForbiddenMarker);
  const snapshot = values => ({ ...reading(), area: earthWeatherArea(38, 55), fetchedAt: BASE_TIME, ...values });
  return { renderer, elements, listeners, camera, snapshot, container, map,
    move(values) { Object.assign(camera, values); for (const callback of listeners.get("move") ?? []) callback(); },
    get field() { return container.children[0]; }, get calls() { return this.field?.context.calls ?? []; } };
}

test("weather is one lazy non-interactive canvas and never carries a forecast into another cell", () => {
  const s = rendererFixture(); s.renderer.setWeather(s.snapshot()); assert.equal(s.container.children.length, 0);
  s.renderer.setVisible(true); assert.equal(s.container.children.length, 1); assert.equal(s.field.hidden, false);
  assert.equal(s.field.tag, "canvas"); assert.equal(s.field.attributes["aria-hidden"], "true"); assert.equal(s.field.style.pointerEvents, "none");
  s.move({ lng: 40 }); assert.equal(s.field.hidden, true); assert.equal(s.renderer.hasMotion(), false);
  const count = s.calls.length; s.renderer.update(1_000); assert.equal(s.calls.length, count);
  s.move({ lng: 38, zoom: 2.9 }); assert.equal(s.field.hidden, true);
  s.move({ zoom: 14 }); assert.equal(s.field.hidden, false); assert.equal(s.container.children.length, 1);
  s.renderer.setWeather(s.snapshot({ condition: "unknown" })); assert.equal(s.field.hidden, true);
  s.renderer.dispose(); assert.equal(s.field.removed, 1); assert.equal(s.listeners.size, 0);
});

test("rain and snow use a bounded continuous forecast field; reduced motion freezes every draw", () => {
  const s = rendererFixture(); s.move({ zoom: 14 }); s.renderer.setVisible(true); s.renderer.setWeather(s.snapshot());
  assert.ok(s.calls.some(call => call[0] === "drawImage")); assert.ok(s.calls.some(call => call[0] === "stroke"));
  assert.ok(Number(s.field.dataset.weatherParticles) > 0 && Number(s.field.dataset.weatherParticles) <= 56);
  const initial = s.calls.length;
  s.renderer.update(1_000); assert.ok(s.calls.length > initial);
  s.renderer.setMotionEnabled(false); const still = s.calls.length;
  s.renderer.update(10_000); assert.equal(s.calls.length, still); assert.equal(s.renderer.hasMotion(), false);
  s.renderer.setWeather(s.snapshot({ condition: "snow" }));
  assert.ok(s.calls.slice(still).some(call => call[0] === "arc"));
  assert.ok(Number(s.field.dataset.weatherParticles) > 0 && Number(s.field.dataset.weatherParticles) <= 42);
  s.renderer.setMotionEnabled(true); assert.equal(s.renderer.hasMotion(), true);
  s.renderer.dispose();
});

test("clouds use continuous material without moon/sun stamps, and clear/missing data never invents precipitation", () => {
  const s = rendererFixture(); s.move({ zoom: 14 }); s.renderer.setVisible(true);
  s.renderer.setWeather(s.snapshot({ condition: "partly-cloudy", cloudCoverPercent: 40, precipitationMm: 0, isDay: false }));
  assert.equal(s.field.tag, "canvas"); assert.equal(s.container.children.length, 1);
  assert.equal(s.field.dataset.weatherParticles, "0");
  assert.equal(s.calls.some(call => ["stroke", "arc"].includes(call[0])), false);
  s.renderer.setWeather(s.snapshot({ condition: "clear", cloudCoverPercent: 0 }));
  assert.equal(s.field.hidden, true); assert.equal(s.renderer.hasMotion(), false);
  const clear = s.calls.length; s.renderer.update(10_000); assert.equal(s.calls.length, clear);
  s.renderer.setWeather(null); assert.equal(s.field.hidden, true);
  s.renderer.setWeather(s.snapshot({ condition: "unknown" })); assert.equal(s.field.hidden, true);
  s.renderer.dispose();
});

test("high-DPI weather buffers and cached textures stay bounded during repeated camera changes and disposal frees them", () => {
  const s = rendererFixture(); s.container.clientWidth = 3840; s.container.clientHeight = 2160;
  s.move({ zoom: 14 }); s.renderer.setVisible(true); s.renderer.setWeather(s.snapshot());
  assert.ok(s.field.width * s.field.height <= 1_048_576); assert.ok(Math.max(s.field.width, s.field.height) <= 1536);
  for (let index = 0; index < 12; index++) s.move({ lng: 38 + index / 100, zoom: 12 + index % 4 });
  assert.ok(Number(s.field.dataset.weatherTextures) <= 4);
  const live = s.elements.filter(element => element.tag === "canvas" && element.width > 1);
  assert.ok(live.length <= 5); assert.ok(live.reduce((sum, element) => sum + element.width * element.height * 4, 0) <= 5 * 1024 * 1024);
  s.renderer.setVisible(false); const hidden = s.calls.length;
  s.renderer.update(20_000); s.move({ lng: 38.3 }); assert.equal(s.calls.length, hidden);
  s.renderer.dispose(); s.renderer.dispose(); assert.ok(s.elements.every(element => element.width <= 1));
  const disposed = s.calls.length; s.renderer.setVisible(true); s.renderer.update(30_000); assert.equal(s.calls.length, disposed);
});

test("forecast clipping survives the date line and polar views and rejects an off-planet round trip", () => {
  for (const [longitude, latitude] of [[179.999, 85], [-179.999, -85], [0, 89], [0, -89]]) {
    const s = rendererFixture(); s.move({ zoom: 14, lng: longitude, lat: latitude }); s.renderer.setVisible(true);
    const area = earthWeatherArea(longitude, latitude);
    s.renderer.setWeather(s.snapshot({ area, condition: "snow" }));
    assert.equal(s.field.hidden, false); assert.equal(s.field.dataset.weatherCell, area.key);
    assert.ok(s.calls.some(call => call[0] === "clip"));
    assert.ok(s.calls.filter(call => ["moveTo", "lineTo", "transform"].includes(call[0])).every(call => call.slice(1).every(Number.isFinite)));
    const unproject = s.map.unproject;
    s.map.unproject = point => ({ ...unproject(point), lat: 0 }); s.move({});
    assert.equal(s.field.hidden, true, "a false globe projection cannot paint weather over space");
    s.renderer.dispose();
  }
});
