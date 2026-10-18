import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { createEarthWeatherProvider, createEarthWeatherController, createEarthWeatherCache, earthWeatherArea,
  EARTH_WEATHER_CACHE_LIMIT, EARTH_WEATHER_CACHE_TTL_MS, EARTH_WEATHER_MAX_STALE_MS } = await vite.ssrLoadModule("/features/earth/weather.ts");
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
  assert.equal(other.calls.length, 0, "another map cannot bypass the one-minute budget"); other.controller.dispose();
  await s.advance(MINUTE - 2); assert.equal(s.calls.length, 1);
  await s.advance(1); assert.equal(s.calls.length, 2);
  assert.deepEqual(s.calls[1].area, earthWeatherArea(40.3, 50.1));
  s.controller.dispose();
});

test("fresh entries expire at the proxy boundary, and stale responses never become fifteen-minute fresh forecasts", async () => {
  const s = controllerFixture({ fetchWeather: async (_area, _signal, time) => reading(time, {
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
  await s.advance(MINUTE); assert.equal(s.calls.length, 2);
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
  await s.advance(MINUTE); pending[1](reading(s.time)); await flush();
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

test("the bounded memory cache keeps recently used cells and never shortens a reserved request budget", () => {
  const cache = createEarthWeatherCache();
  for (let index = 0; index < EARTH_WEATHER_CACHE_LIMIT; index++) cache.put(String(index), reading());
  assert.ok(cache.get("0")); cache.put("last", reading());
  assert.equal(cache.get("1"), undefined); assert.ok(cache.get("0")); assert.ok(cache.get("last"));
  cache.reserve(BASE_TIME + HOUR); cache.reserve(BASE_TIME); assert.equal(cache.nextRequestAt(), BASE_TIME + HOUR);
});

function rendererFixture() {
  let writes = 0;
  const markers = [], listeners = new Map(), camera = { lng: 38, lat: 55, zoom: 5 };
  const ownerDocument = { createElement(tag) {
    return { tag, attributes: {}, children: [], dataset: {}, className: "",
      style: new Proxy({}, { set(target, key, value) { writes++; target[key] = value; return true; } }),
      append(...children) { this.children.push(...children); },
      setAttribute(key, value) { writes++; this.attributes[key] = value; } };
  }, createElementNS(namespace, tag) { assert.equal(namespace, "http://www.w3.org/2000/svg"); return this.createElement(tag); } };
  const map = { getContainer: () => ({ ownerDocument }), getCenter: () => camera, getZoom: () => camera.zoom,
    on(type, callback) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(callback); },
    off(type, callback) { listeners.get(type)?.delete(callback); if (!listeners.get(type)?.size) listeners.delete(type); } };
  class Marker {
    constructor(options) {
      this.options = options; this.positions = []; this.removed = 0; markers.push(this);
      options.element.style.opacity = "0.73"; options.element.style.transform = "translate(12px, 34px)";
    }
    setLngLat(position) { this.positions.push([...position]); return this; }
    addTo(target) { assert.equal(target, map); return this; }
    remove() { this.removed++; }
  }
  const renderer = createEarthWeather(map, Marker);
  const snapshot = values => ({ ...reading(), area: earthWeatherArea(38, 55), fetchedAt: BASE_TIME, ...values });
  return { renderer, markers, listeners, camera, snapshot, get writes() { return writes; },
    move(values) { Object.assign(camera, values); for (const callback of listeners.get("move") ?? []) callback(); },
    get element() { return markers[0]?.options.element; }, get art() { return this.element?.children[0].children; } };
}

test("weather artwork is lazy, non-interactive and never follows an old forecast across cell or zoom boundaries", () => {
  const s = rendererFixture(); s.renderer.setWeather(s.snapshot()); assert.equal(s.markers.length, 0);
  s.renderer.setVisible(true); assert.equal(s.markers.length, 1); assert.equal(s.element.style.display, "");
  assert.equal(s.element.attributes["aria-hidden"], "true"); assert.equal(s.element.style.pointerEvents, "none");
  assert.equal(s.element.style.opacity, "0.73"); assert.equal(s.element.style.transform, "translate(12px, 34px)");
  s.move({ lng: 38.2 }); assert.deepEqual(s.markers[0].positions.at(-1), [38.2, 55]);
  s.move({ lng: 40 }); assert.equal(s.element.style.display, "none"); assert.equal(s.renderer.hasMotion(), false);
  s.move({ lng: 38, zoom: 2.9 }); assert.equal(s.element.style.display, "none");
  s.move({ zoom: 5 }); assert.equal(s.element.style.display, ""); assert.equal(s.markers.length, 1);
  s.renderer.setWeather(s.snapshot({ condition: "unknown" })); assert.equal(s.element.style.display, "none");
  s.renderer.dispose();
});

test("rain and snow use twelve particles on the shared clock; reduced motion is a static drawing", () => {
  const s = rendererFixture(); s.renderer.setVisible(true); s.renderer.setWeather(s.snapshot());
  assert.equal(s.art.length - 5, 12); const particles = s.art.slice(5);
  const initial = particles.map(particle => particle.attributes.transform);
  s.renderer.update(1_000); assert.notDeepEqual(particles.map(particle => particle.attributes.transform), initial);
  s.renderer.setMotionEnabled(false); assert.equal(s.renderer.hasMotion(), false);
  const staticFrame = particles.map(particle => particle.attributes.transform), writes = s.writes;
  s.renderer.update(10_000); assert.equal(s.writes, writes); assert.deepEqual(particles.map(particle => particle.attributes.transform), staticFrame);
  s.renderer.setWeather(s.snapshot({ condition: "snow" }));
  assert.ok(particles.every(particle => particle.attributes.d === "M-2 0h4M0-2v4"));
  assert.ok(particles.every(particle => particle.style.display === ""));
  s.renderer.setMotionEnabled(true); assert.equal(s.renderer.hasMotion(), true);
  s.renderer.update(2_000); assert.notDeepEqual(particles.map(particle => particle.attributes.transform), staticFrame);
  s.renderer.dispose();
});

test("clear night shows a still moon, and hidden/disposed artwork receives no particle updates", () => {
  const s = rendererFixture(); s.renderer.setVisible(true); s.renderer.setWeather(s.snapshot({ condition: "clear", isDay: false }));
  const [sun, moon, cloud, fog, lightning, ...particles] = s.art;
  assert.equal(sun.style.display, "none"); assert.equal(moon.style.display, ""); assert.equal(cloud.style.display, "none");
  assert.equal(fog.style.display, "none"); assert.equal(lightning.style.display, "none");
  assert.ok(particles.every(particle => particle.style.display === "none")); assert.equal(s.renderer.hasMotion(), false);
  s.renderer.setWeather(s.snapshot()); s.renderer.setVisible(false); const hiddenWrites = s.writes;
  s.renderer.update(5_000); assert.equal(s.writes, hiddenWrites);
  s.renderer.dispose(); s.renderer.dispose(); const disposedWrites = s.writes;
  s.renderer.update(10_000); s.move({ lng: 20 }); s.renderer.setVisible(true); s.renderer.setMotionEnabled(true);
  assert.equal(s.writes, disposedWrites); assert.equal(s.listeners.size, 0); assert.equal(s.markers[0].removed, 1);
  assert.equal(s.renderer.hasMotion(), false);
});
