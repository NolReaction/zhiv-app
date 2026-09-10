import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(() => vite.close());
const { FISH_PATROLS, WATER_RIPPLES, WIND_RIPPLES, RAIN_IMPACTS, fishPose, fishSurfaceEvent, windRipplePose, drawWaterAmbience } = await vite.ssrLoadModule("/features/world/water-ambience.ts");
const { BIRD_FLIGHTS, birdFlightPose, drawBirdAmbience } = await vite.ssrLoadModule("/features/world/bird-ambience.ts");
const { mapPlaceAt } = await vite.ssrLoadModule("/features/world/map-layout.ts");

test("fish bodies and fins stay underwater for their entire patrol", () => {
  for (const patrol of FISH_PATROLS) {
    for (let step = 0; step <= 360; step++) {
      const pose = fishPose(patrol, patrol.period * step / 360);
      for (const x of [-10, 0, 7]) for (const y of [-5, 0, 5]) {
        const point = { x: pose.x + (x * Math.cos(pose.angle) - y * Math.sin(pose.angle)) * patrol.scale,
          y: pose.y + (x * Math.sin(pose.angle) + y * Math.cos(pose.angle)) * patrol.scale };
        assert.equal(mapPlaceAt(point), "fishing", `patrol ${patrol.x},${patrol.y}, step ${step}`);
      }
    }
    const first = fishPose(patrol, 0), last = fishPose(patrol, patrol.period);
    assert.ok(Math.hypot(first.x - last.x, first.y - last.y) < 1e-8, "no teleport at loop boundary");
  }
});

test("expanding ripples remain inside the shoreline", () => {
  for (const ripple of WATER_RIPPLES) for (let step = 0; step < 36; step++) {
    const angle = step * Math.PI / 18;
    assert.equal(mapPlaceAt({ x: ripple.x + Math.cos(angle) * 14, y: ripple.y + Math.sin(angle) * 5 }), "fishing");
  }
});

test("the breeze travels over open water and fades before each calm interval", () => {
  let activeFrames = 0;
  for (let step = 0; step < 280; step++) {
    const seconds = step / 10;
    let active = false;
    for (const ripple of WIND_RIPPLES) {
      const pose = windRipplePose(ripple, seconds);
      if (!pose) continue;
      active = true;
      assert.ok(pose.opacity >= 0 && pose.opacity <= 1);
      for (const x of [-ripple.width / 2 - 3, 0, ripple.width / 2]) for (const y of [-1, 0, 6]) {
        assert.equal(mapPlaceAt({ x: pose.x + x, y: pose.y + y }), "fishing", "the full moving wavelet stays off the bank");
      }
    }
    if (active) activeFrames++;
  }
  assert.ok(activeFrames > 0 && activeFrames < 140, "passing gusts leave the river calm for most of the cycle");
  for (const ripple of WIND_RIPPLES) {
    const start = 3 + ripple.delay;
    const first = windRipplePose(ripple, start + .001);
    const last = windRipplePose(ripple, start + 7.499);
    assert.ok(last.x - first.x > 35 && last.y > first.y, "waves visibly travel with the breeze");
    assert.ok(first.opacity < .001 && last.opacity < .001, "a packet never pops in or teleports at loop boundaries");
  }
});

function drawing() {
  const calls = [];
  const ctx = new Proxy({}, { get: (_, name) => (...args) => { calls.push([name, ...args]); },
    set: (_, name, value) => { calls.push([name, value]); return true; } });
  return { ctx, calls };
}

test("rain impacts stay on water, appear only in rain, and freeze in reduced motion", () => {
  assert.ok(RAIN_IMPACTS.length > 20, "rain reaches the whole open river");
  for (const point of RAIN_IMPACTS) for (let step = 0; step < 36; step++) {
    const angle = step * Math.PI / 18;
    assert.equal(mapPlaceAt({ x: point.x + Math.cos(angle) * 8, y: point.y + Math.sin(angle) * 3 }), "fishing");
  }
  const dry = drawing(), rain = drawing();
  drawWaterAmbience(dry.ctx, 12, false, 0); drawWaterAmbience(rain.ctx, 12, false, 1);
  assert.ok(rain.calls.filter(call => call[0] === "ellipse").length > dry.calls.filter(call => call[0] === "ellipse").length);
  const first = drawing(), later = drawing();
  drawWaterAmbience(first.ctx, 12, true, 1); drawWaterAmbience(later.ctx, 145, true, 1);
  assert.deepEqual(first.calls, later.calls, "reduced motion has no swimming, raindrop or splash animation");
});

test("fish surface separately, land smoothly and leave their splash rings inside water", () => {
  let activeFrames = 0;
  for (let step = 0; step < 2080; step++) {
    const seconds = step / 10;
    const events = FISH_PATROLS.map(patrol => fishSurfaceEvent(patrol, seconds)).filter(Boolean);
    assert.ok(events.length <= 1, "surface jumps must not become constant synchronized splashing");
    if (events.length) activeFrames++;
    for (const event of events) {
      for (const point of [event.takeoff, event.landing]) for (let angle = 0; angle < Math.PI * 2; angle += .25) {
        assert.equal(mapPlaceAt({ x: point.x + Math.cos(angle) * 17, y: point.y + Math.sin(angle) * 6 }), "fishing");
      }
    }
  }
  assert.ok(activeFrames / 2080 < .25, "the river is quiet most of the time");
  for (const patrol of FISH_PATROLS) {
    assert.equal(fishSurfaceEvent(patrol, patrol.surfaceAt).lift, 0);
    assert.ok(fishSurfaceEvent(patrol, patrol.surfaceAt + .525).lift > 8.9);
    assert.ok(fishSurfaceEvent(patrol, patrol.surfaceAt + 1.05).lift < 1e-8);
  }
});

test("birds visit in small daytime flocks and disappear for night, rain and reduced motion", () => {
  const daytime = drawing(); drawBirdAmbience(daytime.ctx, 12, false, 0, 0);
  assert.ok(daytime.calls.some(call => call[0] === "fillRect"));
  for (const [reduced, dusk, rain] of [[true, 0, 0], [false, 1, 0], [false, 0, 1]]) {
    const hidden = drawing(); drawBirdAmbience(hidden.ctx, 12, reduced, dusk, rain);
    assert.equal(hidden.calls.length, 0);
  }
  for (const flight of BIRD_FLIGHTS) {
    assert.equal(birdFlightPose(flight, flight.startsAt - .01, 0), null);
    assert.equal(birdFlightPose(flight, flight.startsAt, 0).opacity, 0);
    assert.ok(birdFlightPose(flight, flight.startsAt + flight.duration - .01, 0).opacity < .01);
    assert.equal(birdFlightPose(flight, flight.startsAt + flight.duration + .01, 0), null);
  }
});
