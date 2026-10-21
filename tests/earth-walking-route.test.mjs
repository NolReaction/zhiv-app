import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } },
  server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { createEarthWalkingRouteBinding, canUseEarthWalkingRoute, parseEarthWalkingRoute, fetchEarthWalkingRoute,
  earthWalkingRouteUrl, createEarthWalkingRouteLimiter, EarthWalkingRouteError } = await vite.ssrLoadModule("/features/earth/walking-route.ts");
const { createEarthWalkingRouteController } = await vite.ssrLoadModule("/features/earth/use-earth-walking-route.ts");
const endpoints = { origin: [13.38886, 52.517037], destination: [13.391, 52.518] };
const provider = () => ({ code: "Ok", waypoints: [{ location: [...endpoints.origin], name: "private name", hint: "private hint" }, { location: [...endpoints.destination] }],
  routes: [{ distance: 250, duration: 180, geometry: { type: "LineString", coordinates: [[...endpoints.origin], [13.39, 52.5175], [...endpoints.destination]] }, legs: [{ summary: "not exported" }] }] });
const response = value => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
const isError = code => error => error instanceof EarthWalkingRouteError && error.code === code;
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const wallStart = Date.parse("2026-10-21T12:00:00Z");
function fixture({ limiter = createEarthWalkingRouteLimiter(), owner = "owner-a" } = {}) {
  let wall = wallStart, mono = 10_000, visible = true, online = true;
  const timers = new Set(), callbacks = new Set(), calls = [];
  const context = { foreground: true, allowed: true, online: true,
    position: { longitude: endpoints.origin[0], latitude: endpoints.origin[1], accuracy: 15, timestamp: wall },
    person: { circleId: "friend-circle", user: { publicId: "friend-id", displayName: "Друг" }, longitude: endpoints.destination[0], latitude: endpoints.destination[1], accuracyMeters: 20,
      precision: "PRECISE", updatedAt: new Date(wall).toISOString(), expiresAt: new Date(wall + 60_000).toISOString(), expiresAtMonotonic: mono + 60_000 } };
  const controller = createEarthWalkingRouteController(owner, () => ({ wallNow: () => wall, monotonicNow: () => mono, visible: () => visible, online: () => online,
    limiter, onAvailabilityChange(callback) { callbacks.add(callback); return () => callbacks.delete(callback); },
    schedule(callback, milliseconds) { const timer = { callback, deadline: mono + milliseconds }; timers.add(timer); return () => timers.delete(timer); },
    fetchRoute(binding, signal) { return new Promise((resolve, reject) => calls.push({ binding, signal, resolve, reject })); } }));
  const release = controller.activate(); controller.update(context);
  return { controller, context, calls, release, get wall() { return wall; }, get mono() { return mono; },
    update(change = {}) { Object.assign(context, change); controller.update(context); },
    availability(value) { if ("visible" in value) visible = value.visible; if ("online" in value) online = value.online; callbacks.forEach(callback => callback()); },
    advance(milliseconds, wallMilliseconds = milliseconds) { mono += milliseconds; wall += wallMilliseconds; for (const timer of [...timers]) if (timer.deadline <= mono) { timers.delete(timer); timer.callback(); } },
    resolve(index = calls.length - 1) { calls[index].resolve(parseEarthWalkingRoute(provider(), endpoints)); },
  };
}

test("provider DTO keeps only copied geometry, distance and duration, with fixed pedestrian endpoint and safe request options", async () => {
  let observed;
  const route = await fetchEarthWalkingRoute(endpoints, new AbortController().signal, async (url, options) => { observed = { url, options }; return response(provider()); });
  assert.deepEqual(Object.keys(route).sort(), ["distanceMeters", "durationSeconds", "geometry"]);
  assert.equal(route.distanceMeters, 250); assert.equal(route.durationSeconds, 180);
  const url = new URL(observed.url);
  assert.equal(url.origin, "https://routing.openstreetmap.de");
  assert.equal(url.pathname, "/routed-foot/route/v1/foot/13.388860,52.517037;13.391000,52.518000");
  assert.deepEqual(Object.fromEntries(url.searchParams), { overview: "full", geometries: "geojson", steps: "false", alternatives: "false", generate_hints: "false" });
  for (const [key, value] of Object.entries({ credentials: "omit", cache: "no-store", redirect: "error", mode: "cors", referrerPolicy: "strict-origin" })) assert.equal(observed.options[key], value);
  const input = provider(), parsed = parseEarthWalkingRoute(input, endpoints); input.routes[0].geometry.coordinates[0][0] = 0;
  assert.equal(parsed.geometry.coordinates[0][0], 13.38886, "provider-owned arrays cannot mutate the accepted geometry");
});

test("provider schema rejects partial, oversized, nonfinite and far-snapped data without leaking provider fields", () => {
  for (const mutate of [
    value => { value.code = "Error with secret coordinates"; },
    value => { delete value.routes; }, value => { value.routes.push(value.routes[0]); },
    value => { value.routes[0].distance = Infinity; }, value => { value.routes[0].distance = -1; },
    value => { value.routes[0].duration = NaN; }, value => { value.routes[0].duration = -1; },
    value => { value.routes[0].geometry.type = "Polygon"; }, value => { value.routes[0].geometry.coordinates = [[NaN, 0], [0, 0]]; },
    value => { value.routes[0].geometry.coordinates = Array.from({ length: 10001 }, () => endpoints.origin); },
    value => { value.routes[0].geometry.coordinates.at(-1)[1] = 80; },
    value => { value.waypoints[1].location = [0, 0]; }, value => { delete value.waypoints; },
  ]) {
    const value = structuredClone(provider()); mutate(value);
    assert.throws(() => parseEarthWalkingRoute(value, endpoints), isError("invalid_response"));
  }
  assert.throws(() => parseEarthWalkingRoute({ code: "NoRoute", message: "secret" }, endpoints), isError("no_route"));
  assert.throws(() => earthWalkingRouteUrl({ ...endpoints, destination: [0, 0] }), isError("invalid_response"));
});

test("provider handles 429, bad status, malformed/oversized bodies and network exceptions with sanitized errors", async () => {
  for (const [fetcher, code] of [
    [async () => new Response("secret", { status: 429 }), "rate_limit"],
    [async () => new Response("secret", { status: 503 }), "unavailable"],
    [async () => new Response(JSON.stringify({ code: "NoRoute", message: "secret" }), { status: 400 }), "no_route"],
    [async () => new Response("invalid private JSON"), "unavailable"],
    [async () => new Response("{}", { headers: { "content-length": String(512 * 1024 + 1) } }), "invalid_response"],
    [async () => new Response(" ".repeat(512 * 1024 + 1)), "invalid_response"],
    [async () => { throw new Error("https://secret.invalid/13.3,52.1"); }, "unavailable"],
  ]) await assert.rejects(fetchEarthWalkingRoute(endpoints, new AbortController().signal, fetcher), error => isError(code)(error) && !/secret|13\.3|52\.1/.test(error.message));
});

test("timeout bounds fetch and streamed body even if the provider ignores cancellation; an explicit abort wins immediately", async () => {
  await assert.rejects(fetchEarthWalkingRoute(endpoints, new AbortController().signal, () => new Promise(() => {}), 5), isError("timeout"));
  await assert.rejects(fetchEarthWalkingRoute(endpoints, new AbortController().signal, async () => new Response(new ReadableStream({ start() {} })), 5), isError("timeout"));
  const abort = new AbortController(), promise = fetchEarthWalkingRoute(endpoints, abort.signal, () => new Promise(() => {}));
  abort.abort(); await assert.rejects(promise, isError("cancelled"));
});

test("binding requires precise fresh points, finite accuracy <=200m and a straight distance <=20km", () => {
  const f = fixture();
  try {
    const { position, person } = f.context;
    assert.ok(createEarthWalkingRouteBinding("owner", position, person, f.mono, f.wall));
    for (const [self, friend] of [[null, person], [position, null], [{ ...position, accuracy: NaN }, person],
      [{ ...position, accuracy: 201 }, person], [position, { ...person, accuracyMeters: 201 }],
      [position, { ...person, precision: "APPROXIMATE" }], [{ ...position, timestamp: f.wall - 60001 }, person],
      [{ ...position, timestamp: f.wall + 10001 }, person], [position, { ...person, updatedAt: new Date(f.wall + 10001).toISOString() }],
      [position, { ...person, updatedAt: new Date(f.wall - 300000).toISOString() }],
      [position, { ...person, longitude: 0, latitude: 0 }], [position, { ...person, expiresAtMonotonic: f.mono }]])
      assert.equal(createEarthWalkingRouteBinding("owner", self, friend, f.mono, f.wall), null);
    assert.equal(createEarthWalkingRouteBinding(null, position, person, f.mono, f.wall), null);
  } finally { f.release(); }
});

test("renderer freshness binds circle+public identity, movement and both monotonic/wall expiry", () => {
  const f = fixture();
  try {
    const { position, person } = f.context, binding = createEarthWalkingRouteBinding("owner", position, person, f.mono, f.wall);
    assert.equal(canUseEarthWalkingRoute(binding, position, person, f.mono, f.wall), true);
    for (const friend of [{ ...person, circleId: "other" }, { ...person, user: { ...person.user, publicId: "other" } }, { ...person, latitude: person.latitude + .0006 }])
      assert.equal(canUseEarthWalkingRoute(binding, position, friend, f.mono, f.wall), false);
    assert.equal(canUseEarthWalkingRoute(binding, { ...position, latitude: position.latitude + .0006 }, person, f.mono, f.wall), false);
    assert.equal(canUseEarthWalkingRoute(binding, position, person, binding.expiresAtMonotonic, f.wall - 1000), false);
    assert.equal(canUseEarthWalkingRoute(binding, position, person, f.mono, binding.expiresAt), false);
    assert.equal(canUseEarthWalkingRoute(binding, position, person, f.mono - 1, f.wall), false);
  } finally { f.release(); }
});

test("passive controller activation, point updates and timers never fetch; only an explicit eligible request does", async () => {
  const f = fixture();
  try {
    assert.equal(f.controller.getSnapshot().canRequest, true); f.advance(1000); f.update(); assert.equal(f.calls.length, 0);
    assert.equal(f.controller.request(), true); assert.equal(f.controller.request(), false); await flush();
    assert.equal(f.calls.length, 1); assert.equal(f.controller.getSnapshot().status, "loading");
    f.resolve(); await flush(); const route = f.controller.getSnapshot().route;
    assert.equal(f.controller.getSnapshot().status, "ready"); assert.equal(route.ownerPublicId, "owner-a");
    assert.equal(route.circleId, f.context.person.circleId); assert.equal(route.friendPublicId, f.context.person.user.publicId);
    f.advance(5000); assert.equal(f.calls.length, 1); assert.equal(f.controller.getSnapshot().canRequest, true);
  } finally { f.release(); }
});

test("clear, friend switch and owner retirement abort in-flight work and reject late success/error without resurrection", async () => {
  for (const change of ["clear", "friend", "public-id", "retire", "hidden", "offline", "privacy", "foreground"]) {
    const f = fixture();
    try {
      f.controller.request(); await flush(); const first = f.calls[0];
      if (change === "clear") f.controller.clear();
      if (change === "friend") f.update({ person: { ...f.context.person, circleId: "replacement" } });
      if (change === "public-id") f.update({ person: { ...f.context.person, user: { ...f.context.person.user, publicId: "replacement" } } });
      if (change === "retire") f.release();
      if (change === "hidden") f.availability({ visible: false });
      if (change === "offline") f.availability({ online: false });
      if (change === "privacy") f.update({ allowed: false });
      if (change === "foreground") f.update({ foreground: false });
      assert.equal(first.signal.aborted, true, change); f.resolve(0); await flush();
      assert.equal(f.controller.getSnapshot().route, null, change); assert.notEqual(f.controller.getSnapshot().status, "ready", change);
    } finally { f.release(); }
  }
});

test("fresh availability is rechecked before accepting a response even before its browser event is delivered", async () => {
  const f = fixture();
  try {
    f.controller.request(); await flush();
    f.context.position.timestamp = f.wall - 59000; f.update(); f.advance(1000); f.resolve(); await flush();
    assert.equal(f.controller.getSnapshot().route, null); assert.equal(f.calls[0].signal.aborted, true);
  } finally { f.release(); }
});

test("movement beyond50m invalidates a ready path with no automatic refresh", async () => {
  for (const endpoint of ["self", "friend"]) {
    const f = fixture();
    try {
      f.controller.request(); await flush(); f.resolve(); await flush();
      if (endpoint === "self") f.update({ position: { ...f.context.position, latitude: f.context.position.latitude + .0006 } });
      else f.update({ person: { ...f.context.person, latitude: f.context.person.latitude + .0006 } });
      assert.equal(f.controller.getSnapshot().route, null); f.advance(5000); assert.equal(f.calls.length, 1);
      assert.equal(f.controller.getSnapshot().canRequest, true);
    } finally { f.release(); }
  }
});

test("self freshness and friend access deadlines bound ready routes and cannot be extended by a wall clock rollback", async () => {
  for (const expiry of ["self", "friend", "clock"]) {
    const f = fixture();
    try {
      if (expiry === "self") f.update({ position: { ...f.context.position, timestamp: f.wall - 59000 } });
      if (expiry === "friend") f.update({ person: { ...f.context.person, expiresAt: new Date(f.wall + 1000).toISOString(), expiresAtMonotonic: f.mono + 1000 } });
      f.controller.request(); await flush(); f.resolve(); await flush(); assert.ok(f.controller.getSnapshot().route);
      f.advance(expiry === "clock" ? 60000 : 1000, expiry === "clock" ? -1000 : 1000);
      assert.equal(f.controller.getSnapshot().route, null, expiry); assert.equal(f.calls.length, 1);
    } finally { f.release(); }
  }
});

test("a stuck provider is retired at timeout and cannot replace a newer explicit request", async () => {
  const f = fixture();
  try {
    f.controller.request(); await flush(); f.advance(10000);
    assert.equal(f.controller.getSnapshot().status, "error"); assert.match(f.controller.getSnapshot().error, /не успел/);
    assert.equal(f.calls[0].signal.aborted, true); assert.equal(f.controller.request(), true); await flush();
    f.calls[0].reject(new Error("private old response")); await flush(); assert.equal(f.controller.getSnapshot().status, "loading");
    f.resolve(1); await flush(); assert.equal(f.controller.getSnapshot().status, "ready");
  } finally { f.release(); }
});

test("clock rollback cannot renew a previously observed self fix through clear, hidden or a new explicit request", async () => {
  const f = fixture();
  try {
    const position = { ...f.context.position }, observedMono = f.mono;
    f.update({ person: { ...f.context.person, expiresAt: new Date(f.wall + 600000).toISOString(), expiresAtMonotonic: f.mono + 600000 } });
    f.advance(55000, 25000); f.controller.clear(); f.availability({ visible: false });
    f.update({ position: null }); f.update({ position }); f.availability({ visible: true });
    assert.equal(f.controller.request(), true); await flush(); f.resolve(); await flush();
    assert.equal(f.controller.getSnapshot().route.expiresAtMonotonic, observedMono + 60000);
    f.advance(5000); assert.equal(f.controller.getSnapshot().route, null); assert.equal(f.controller.request(), false);
    f.update({ position: { ...position, timestamp: f.wall } }); assert.equal(f.controller.getSnapshot().canRequest, true, "a genuinely newer fix remains usable");
  } finally { f.release(); }
});

test("friend freshness derives from the existing monotonic feed deadline despite a rolled-back wall clock and reopened selection", async () => {
  const f = fixture();
  try {
    const originalMono = f.mono;
    f.update({ person: { ...f.context.person, expiresAt: new Date(f.wall + 86400000).toISOString(), expiresAtMonotonic: f.mono + 86400000 } });
    const person = { ...f.context.person };
    f.advance(295000, 265000); f.update({ person: null });
    f.update({ person, position: { ...f.context.position, timestamp: f.wall } });
    assert.equal(f.controller.request(), true); await flush(); f.resolve(); await flush();
    assert.equal(f.controller.getSnapshot().route.expiresAtMonotonic, originalMono + 300000);
    f.advance(5000); assert.equal(f.controller.getSnapshot().route, null); assert.equal(f.controller.request(), false);
  } finally { f.release(); }
});

test("service errors are sanitized, never retried automatically and do not follow a changed friend", async () => {
  const f = fixture();
  try {
    f.controller.request(); await flush(); f.calls[0].reject(new Error("private URL and coordinates")); await flush();
    assert.equal(f.controller.getSnapshot().status, "error"); assert.doesNotMatch(f.controller.getSnapshot().error, /private|URL|coordinates/);
    f.advance(6000); assert.equal(f.calls.length, 1); assert.equal(f.controller.getSnapshot().canRequest, true);
    f.update({ person: { ...f.context.person, circleId: "other" } }); assert.equal(f.controller.getSnapshot().error, null);
  } finally { f.release(); }
});

test("the shared RAM limiter survives cancel, component/controller replacement and account changes", async () => {
  const limiter = createEarthWalkingRouteLimiter(), a = fixture({ limiter }), b = fixture({ limiter, owner: "owner-b" });
  try {
    assert.equal(a.controller.request(), true); await flush(); a.controller.clear(); a.release();
    assert.equal(b.controller.request(), false); assert.equal(b.calls.length, 0);
    b.advance(4999); assert.equal(b.controller.request(), false); b.advance(1); assert.equal(b.controller.request(), true); await flush();
    assert.equal(b.calls.length, 1);
  } finally { a.release(); b.release(); }
});
