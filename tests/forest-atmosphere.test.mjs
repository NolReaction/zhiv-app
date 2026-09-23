import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(() => vite.close());
const { FOREST_ATMOSPHERE_LIMITS, FOREST_BIRD_FLIGHT_DURATION, forestAtmosphereState, forestAtmosphereFrame, drawForestAtmosphere }
  = await vite.ssrLoadModule("/features/world/forest-atmosphere.ts");
const { drawForestBird, drawForestButterfly, drawForestFirefly }
  = await vite.ssrLoadModule("/features/world/forest-wildlife.ts");
const { updateForestWetness, isForestGroundClear, forestGroundWeatherFrame, drawForestGroundWeather }
  = await vite.ssrLoadModule("/features/world/forest-ground-weather.ts");

const scene = { schemaVersion: 1, id: "test-forest", width: 960, height: 720,
  focus: { x: 170, y: 210, width: 240, height: 240 }, terrain: [], sites: [], paths: [] };
const options = { elapsed: 12, timestamp: Date.UTC(2026, 8, 20), dusk: 0, reducedMotion: false };
const groups = ["butterflies", "fireflies", "birds", "raindrops"];
const inside = (particle, bounds) => particle.x >= bounds.x && particle.x <= bounds.x + bounds.width
  && particle.y >= bounds.y && particle.y <= bounds.y + bounds.height;

function weatherTimestamp(predicate) {
  for (let seconds = 0; seconds < 3600; seconds += 10) {
    const timestamp = options.timestamp + seconds * 1000;
    if (predicate(forestAtmosphereState(scene, { ...options, timestamp }))) return timestamp;
  }
  assert.fail("the weather schedule must include the requested conditions");
}

const clearTimestamp = weatherTimestamp(state => state.cloudiness === 0);
const rainTimestamp = weatherTimestamp(state => state.rain > .4);

function drawing(width = 360, height = 360) {
  const calls = [], stack = [];
  const ctx = { canvas: { width, height }, globalAlpha: .63, fillStyle: "#123456",
    strokeStyle: "#abcdef", lineWidth: 4, clipped: false, transform: [3, 4, .2] };
  const snapshot = () => ({ globalAlpha: ctx.globalAlpha, fillStyle: ctx.fillStyle,
    strokeStyle: ctx.strokeStyle, lineWidth: ctx.lineWidth, clipped: ctx.clipped,
    transform: [...ctx.transform] });
  const initial = snapshot();
  for (const name of ["beginPath", "closePath", "rect", "moveTo", "lineTo", "ellipse", "bezierCurveTo"])
    ctx[name] = (...args) => calls.push([name, ...args]);
  ctx.createRadialGradient = (...args) => {
    const gradient = { type: "radial", args, stops: [] };
    Object.defineProperty(gradient, "addColorStop", { value: (offset, color) => gradient.stops.push([offset, color]) });
    calls.push(["createRadialGradient", gradient]);
    return gradient;
  };
  for (const name of ["fillRect", "fill", "stroke"])
    ctx[name] = (...args) => { assert.ok(ctx.clipped, "every paint is clipped to the world"); calls.push([name, ...args, snapshot()]); };
  ctx.save = () => { stack.push(snapshot()); calls.push(["save"]); };
  ctx.restore = () => { assert.ok(stack.length, "restore has a matching save"); Object.assign(ctx, stack.pop()); calls.push(["restore"]); };
  ctx.clip = () => { ctx.clipped = true; calls.push(["clip"]); };
  ctx.translate = (x, y) => { ctx.transform[0] += x; ctx.transform[1] += y; calls.push(["translate", x, y]); };
  ctx.rotate = angle => { ctx.transform[2] += angle; calls.push(["rotate", angle]); };
  return { ctx, calls, stack, snapshot, initial };
}

test("shared clock produces deterministic world particles regardless of camera and draw order", () => {
  const input = { ...options, timestamp: rainTimestamp, dusk: .4 };
  const first = forestAtmosphereFrame(scene, input);
  const circle = drawing(320, 320), map = drawing(1440, 900);
  drawForestAtmosphere(circle.ctx, scene, input);
  forestAtmosphereFrame({ ...scene, id: "another-forest" }, { ...input, elapsed: 800 });
  drawForestAtmosphere(map.ctx, scene, input);
  assert.deepEqual(map.calls, circle.calls, "camera pixels do not alter world positions or weather");
  assert.deepEqual(forestAtmosphereFrame(scene, input), first, "sampling another scene cannot consume particle state");
  assert.notDeepEqual(forestAtmosphereFrame(scene, { ...input, elapsed: input.elapsed + 5 }).butterflies, first.butterflies);
  assert.deepEqual(scene.focus, { x: 170, y: 210, width: 240, height: 240 });
});

test("weather changes continuously with bounded drizzle and long clear intervals", () => {
  let previous, clearRun = 0, longestClearRun = 0, rainySeconds = 0;
  const seen = new Set();
  for (let seconds = 0; seconds < 3600; seconds++) {
    const state = forestAtmosphereState(scene, { ...options, timestamp: options.timestamp + seconds * 1000 });
    seen.add(state.weather);
    assert.ok(state.rain >= 0 && state.rain <= .45, "rain stays gentle");
    assert.ok(state.cloudiness >= 0 && state.cloudiness <= 1);
    if (previous) {
      assert.ok(Math.abs(state.rain - previous.rain) < .01, "rain never jumps at a phase or cycle boundary");
      assert.ok(Math.abs(state.cloudiness - previous.cloudiness) < .015, "clouds gather and clear gradually");
    }
    clearRun = state.cloudiness === 0 ? clearRun + 1 : 0;
    longestClearRun = Math.max(longestClearRun, clearRun);
    if (state.rain > .04) rainySeconds++;
    previous = state;
  }
  assert.deepEqual([...seen].sort(), ["clear", "cloudy", "drizzle"]);
  assert.ok(longestClearRun >= 8 * 60, "clear skies last several minutes");
  assert.ok(rainySeconds < 3600 / 3, "drizzle leaves most of the hour dry");
  assert.deepEqual(forestAtmosphereState(scene, { ...options, elapsed: 999 }).rain,
    forestAtmosphereState(scene, options).rain, "weather uses the shared timestamp rather than animation elapsed time");
});

test("particles stay in authored world and focus bounds after changing map dimensions", () => {
  const layouts = [
    { width: 61, height: 83, focus: { x: 29, y: 8, width: 25, height: 25 } },
    { width: 2600, height: 1800, focus: { x: 1800, y: 1100, width: 500, height: 500 } },
  ];
  for (const layout of layouts) {
    const edited = { ...scene, ...layout };
    const world = { x: 0, y: 0, width: edited.width, height: edited.height };
    for (let elapsed = 0; elapsed < 300; elapsed += 3) {
      const frame = forestAtmosphereFrame(edited, { ...options, elapsed, timestamp: rainTimestamp, dusk: .5 });
      for (const group of groups) for (const particle of frame[group]) {
        assert.ok(inside(particle, world), `${group} must follow the resized world instead of legacy map coordinates`);
        assert.ok(Number.isFinite(particle.size) && particle.size > 0);
        assert.ok(particle.opacity >= 0 && particle.opacity <= 1);
      }
      for (const group of ["butterflies", "fireflies", "raindrops"])
        assert.ok(frame[group].some(particle => inside(particle, edited.focus)), `${group} remain visible near the authored focus`);
    }
  }
});

test("moving the authored focus moves its local insects while preserving world-wide insects", () => {
  const moved = { ...scene, focus: { ...scene.focus, x: scene.focus.x + 300, y: scene.focus.y - 150 } };
  const input = { ...options, timestamp: clearTimestamp, dusk: .5 };
  const before = forestAtmosphereFrame(scene, input), after = forestAtmosphereFrame(moved, input);
  for (const group of ["butterflies", "fireflies"]) {
    let relocated = 0, fixed = 0;
    before[group].forEach((particle, index) => {
      const next = after[group][index];
      if (Math.abs(next.x - particle.x) < 1e-8 && Math.abs(next.y - particle.y) < 1e-8) fixed++;
      else {
        relocated++;
        assert.ok(Math.abs(next.x - particle.x - 300) < 1e-8);
        assert.ok(Math.abs(next.y - particle.y + 150) < 1e-8);
        assert.ok(inside(next, moved.focus));
      }
    });
    assert.ok(relocated > 0 && fixed > 0, `${group} inhabit both the clearing and the wider world`);
  }
});

test("day and night swap insect populations and birds visit briefly in small flocks", () => {
  const counts = new Set();
  let birdSeconds = 0;
  for (let elapsed = 0; elapsed < 1200; elapsed++) {
    const day = forestAtmosphereFrame(scene, { ...options, elapsed, timestamp: clearTimestamp });
    const night = forestAtmosphereFrame(scene, { ...options, elapsed, timestamp: clearTimestamp, dusk: true });
    assert.equal(day.butterflies.length, FOREST_ATMOSPHERE_LIMITS.butterflies);
    assert.equal(day.fireflies.length, 0);
    assert.equal(night.butterflies.length, 0);
    assert.equal(night.fireflies.length, FOREST_ATMOSPHERE_LIMITS.fireflies);
    assert.equal(night.birds.length, 0);
    assert.ok(day.birds.length <= 2 && day.birds.length <= FOREST_ATMOSPHERE_LIMITS.birds);
    counts.add(day.birds.length);
    if (day.birds.length) birdSeconds++;
    assert.equal(day.raindrops.length, 0);
  }
  assert.deepEqual([...counts].sort(), [0, 1, 2]);
  assert.ok(birdSeconds < 1200 / 4, "birds are occasional visitors rather than a constant flock");
  assert.ok(forestAtmosphereFrame(scene, { ...options, timestamp: rainTimestamp }).raindrops.length <= 54,
    "automatic drizzle remains bounded and lighter than forced rain");
});

test("weather presets override the clock while auto restores the original weather schedule", () => {
  for (const weather of ["clear", "cloudy", "drizzle", "rain", "downpour"]) {
    const first = forestAtmosphereState(scene, { ...options, weather, timestamp: clearTimestamp });
    const later = forestAtmosphereState(scene, { ...options, weather, timestamp: rainTimestamp });
    assert.equal(first.weather, weather);
    assert.deepEqual(first, later, "a manual preset does not change with the automatic clock");
    assert.ok(first.rain >= 0 && first.rain <= 1);
    assert.ok(first.cloudiness >= 0 && first.cloudiness <= 1);
    if (weather === "clear" || weather === "cloudy") {
      assert.equal(first.rain, 0);
      assert.deepEqual(forestAtmosphereFrame(scene, { ...options, weather }).raindrops, []);
    }
  }
  assert.deepEqual(forestAtmosphereState(scene, { ...options, weather: "auto" }), forestAtmosphereState(scene, options));
  assert.equal(forestAtmosphereState(scene, { ...options, dusk: 0, weather: "downpour" }).dusk, 0);
  assert.equal(forestAtmosphereState(scene, { ...options, dusk: true, weather: "clear" }).dusk, 1);
});

test("rain intensities increase density while keeping droplets short and translucent within a mobile budget", () => {
  let previous;
  const average = (particles, key) => particles.reduce((sum, particle) => sum + particle[key], 0) / particles.length;
  for (const weather of ["drizzle", "rain", "downpour"]) {
    const input = { ...options, weather, butterflies: "off", fireflies: "off", birds: "off" };
    const frame = forestAtmosphereFrame(scene, input);
    assert.ok(frame.raindrops.length > 0 && frame.raindrops.length <= FOREST_ATMOSPHERE_LIMITS.raindrops);
    assert.ok(FOREST_ATMOSPHERE_LIMITS.raindrops <= 180);
    assert.ok(frame.raindrops.some(drop => inside(drop, scene.focus) && drop.opacity > .2), "rain is visible in the clearing");
    assert.notDeepEqual(frame.raindrops, forestAtmosphereFrame(scene, { ...input, elapsed: options.elapsed + 1 }).raindrops);
    for (const drop of frame.raindrops) {
      assert.ok(inside(drop, { x: 0, y: 0, width: scene.width, height: scene.height }));
      assert.ok(drop.opacity >= 0 && drop.opacity <= 1 && drop.length > 0);
    }
    if (previous) {
      assert.ok(frame.raindrops.length > previous.raindrops.length);
      assert.ok(average(frame.raindrops, "length") >= average(previous.raindrops, "length"));
    }
    const circle = drawing(320, 320), map = drawing(1440, 900);
    drawForestAtmosphere(circle.ctx, scene, input);
    drawForestAtmosphere(map.ctx, scene, input);
    assert.deepEqual(circle.calls, map.calls, "rain intensity and coordinates agree in both cameras");
    assert.equal(circle.calls.filter(call => call[0] === "fill").length, frame.raindrops.filter(drop => drop.opacity >= .008).length);
    assert.ok(average(frame.raindrops, "length") < 7, "short droplets replace oversized rain bars");
    assert.ok(average(frame.raindrops, "opacity") < .4, "rain does not wash out the artwork");
    previous = frame;
  }
});

test("wildlife overrides are independent of daylight and rain, and explicit off always wins", () => {
  for (const dusk of [0, 1]) {
    for (const enabled of ["on", true]) {
      const frame = forestAtmosphereFrame(scene, { ...options, dusk, weather: "downpour", elapsed: 0,
        butterflies: enabled, fireflies: enabled, birds: enabled });
      for (const group of ["butterflies", "fireflies", "birds"]) {
        assert.equal(frame[group].length, FOREST_ATMOSPHERE_LIMITS[group]);
        assert.ok(frame[group].every(particle => particle.opacity > .2), `${group} are visible when forced on`);
        assert.ok(frame[group].some(particle => inside(particle, scene.focus)));
      }
    }
    for (const disabled of ["off", false]) {
      const frame = forestAtmosphereFrame(scene, { ...options, dusk, weather: "clear", birdElapsed: 0,
        butterflies: disabled, fireflies: disabled, birds: disabled });
      for (const group of ["butterflies", "fireflies", "birds"]) assert.deepEqual(frame[group], []);
    }
  }
  const automatic = forestAtmosphereFrame(scene, options);
  assert.deepEqual(forestAtmosphereFrame(scene, { ...options, weather: "auto", butterflies: "auto", fireflies: "auto", birds: "auto" }), automatic);
  for (const [group, dusk] of [["butterflies", 0], ["fireflies", 1]]) {
    const natural = forestAtmosphereFrame(scene, { ...options, dusk, weather: "clear" });
    const forced = forestAtmosphereFrame(scene, { ...options, dusk, weather: "clear", [group]: "on" });
    assert.deepEqual(forced[group], natural[group], "manual visibility previews the same wildlife appearance as automatic mode");
  }
});

test("triggered birds appear promptly near focus, replay deterministically and stop after one flight", () => {
  const input = { ...options, dusk: true, weather: "downpour", birdElapsed: 0 };
  const first = forestAtmosphereFrame(scene, input);
  assert.equal(first.birds.length, FOREST_ATMOSPHERE_LIMITS.birds);
  assert.ok(first.birds.every(bird => bird.opacity > .5 && inside(bird, scene.focus)));
  const middle = forestAtmosphereFrame(scene, { ...input, birdElapsed: FOREST_BIRD_FLIGHT_DURATION / 2 });
  assert.notDeepEqual(middle.birds, first.birds);
  const crossing = forestAtmosphereFrame(scene, { ...input, birdElapsed: FOREST_BIRD_FLIGHT_DURATION * .9 });
  assert.ok(crossing.birds.length > 0, "the flock keeps flying after leaving the clearing");
  assert.ok(crossing.birds.every(bird => !inside(bird, scene.focus) && bird.opacity > .8), "birds leave through a world edge without fading above the clearing");
  assert.ok(Math.abs(crossing.birds[0].x - first.birds[0].x) > scene.width * .5);
  assert.deepEqual(forestAtmosphereFrame(scene, { ...input, elapsed: options.elapsed + 400, timestamp: clearTimestamp }).birds, first.birds,
    "a repeat click replays the same flock without depending on the scene clock");
  for (const birdElapsed of [-1, FOREST_BIRD_FLIGHT_DURATION, FOREST_BIRD_FLIGHT_DURATION + 100, Number.NaN, Infinity]) {
    assert.deepEqual(forestAtmosphereFrame(scene, { ...input, birdElapsed }).birds, [], "the trigger does not silently resume automatic visits");
  }
  const moved = { ...scene, focus: { ...scene.focus, x: scene.focus.x + 300, y: scene.focus.y - 150 } };
  const movedBirds = forestAtmosphereFrame(moved, input).birds;
  first.birds.forEach((bird, index) => {
    assert.equal(movedBirds[index].x - bird.x, 300);
    assert.equal(movedBirds[index].y - bird.y, -150);
  });
});

test("automatic birds cross broad horizontal, vertical and diagonal world corridors", () => {
  const flights = [];
  let current = [];
  for (let elapsed = 0; elapsed < 1200; elapsed += .5) {
    const frame = forestAtmosphereFrame(scene, { ...options, elapsed, weather: "clear" });
    if (frame.birds.length) current.push(frame.birds[0]);
    else if (current.length) { flights.push(current); current = []; }
  }
  const corridors = new Set();
  for (const flight of flights) {
    const first = flight[0], last = flight.at(-1);
    const x = Math.abs(last.x - first.x) / scene.width, y = Math.abs(last.y - first.y) / scene.height;
    if (x > .8 && y < .25) corridors.add("horizontal");
    if (y > .8 && x < .25) corridors.add("vertical");
    if (x > .8 && y > .6) corridors.add("diagonal");
  }
  assert.deepEqual([...corridors].sort(), ["diagonal", "horizontal", "vertical"]);
});

test("wildlife painters use shaped colored wings, a feathered body and soft round light", () => {
  const particle = { x: 40, y: 40, size: 2, opacity: .8, phase: .8 };
  for (const painter of [drawForestButterfly, drawForestFirefly, drawForestBird]) {
    const painted = drawing(); painted.ctx.clipped = true;
    painter(painted.ctx, { ...particle, angle: .4 }, 3);
    assert.equal(painted.calls.some(call => call[0] === "fillRect"), false, "wildlife has no square body or wing blocks");
    assert.ok(painted.calls.filter(call => call[0] === "ellipse").length >= 2);
    assert.equal(painted.stack.length, 0);
    if (painter === drawForestFirefly) {
      const gradient = painted.calls.find(call => call[0] === "createRadialGradient")?.[1];
      assert.ok(gradient, "fireflies have a radial glow");
      assert.match(gradient.stops.at(-1)[1], /,0\)$/u, "the outside of the glow fades to transparent");
    } else {
      assert.ok(painted.calls.some(call => call[0] === "bezierCurveTo"), "wings have filled tapered outlines");
      const colors = new Set(painted.calls.filter(call => call[0] === "fill").map(call => call.at(-1).fillStyle));
      assert.ok(colors.size >= 3, "wing color, feather/body outline and highlights stay distinct");
    }
  }
});

const groundScene = { ...scene, actor: { spawn: { x: 290, y: 330 }, size: 48 } };

test("wet ground builds gradually, retains rain after clearing and dries slowly with active scene time", () => {
  const afterSecond = updateForestWetness(0, 1, 1), afterRain = updateForestWetness(0, 1, 18);
  assert.ok(afterSecond > 0 && afterSecond < .08);
  assert.ok(afterRain > .6 && afterRain < .7);
  assert.ok(updateForestWetness(afterRain, 0, 1) > afterRain * .98, "clear weather cannot erase puddles immediately");
  assert.ok(updateForestWetness(afterRain, 0, 75) > .2);
  assert.ok(updateForestWetness(afterRain, 0, 600) < .001);
  let subdivided = 0;
  for (let i = 0; i < 180; i++) subdivided = updateForestWetness(subdivided, 1, .1);
  assert.ok(Math.abs(subdivided - afterRain) < 1e-10, "frame rate does not change wetting speed");
  for (const dt of [0, -1, Number.NaN, Infinity]) assert.equal(updateForestWetness(.4, 1, dt), .4);
  assert.equal(updateForestWetness(-1, 1, 0), 0);
  assert.equal(updateForestWetness(2, 1, 0), 1);
});

test("puddles grow at stable safe ground locations and survive clear skies", () => {
  const input = { ...options, weather: "rain", wetness: .8 };
  const wet = forestGroundWeatherFrame(groundScene, input);
  const early = forestGroundWeatherFrame(groundScene, { ...input, wetness: .15 });
  assert.ok(wet.puddles.length > 0 && wet.puddles.length <= 4);
  assert.ok(wet.rings.length > 0 && wet.rings.length <= 8);
  assert.deepEqual(forestGroundWeatherFrame(groundScene, input), wet);
  wet.puddles.forEach((puddle, index) => {
    assert.deepEqual([puddle.x, puddle.y], [early.puddles[index].x, early.puddles[index].y]);
    assert.ok(puddle.radiusX > early.puddles[index].radiusX && puddle.opacity > early.puddles[index].opacity);
    assert.ok(isForestGroundClear(groundScene, puddle, puddle.radiusX));
  });
  const clearing = forestGroundWeatherFrame(groundScene, { ...input, weather: "clear" });
  assert.equal(clearing.puddles.length, wet.puddles.length);
  assert.equal(clearing.rings.length, 0);
  assert.deepEqual(forestGroundWeatherFrame(groundScene, { ...input, wetness: 0 }).puddles, []);
  assert.deepEqual(forestGroundWeatherFrame(groundScene, { ...input, wetness: undefined }).puddles, []);
  assert.deepEqual(forestGroundWeatherFrame(scene, input).puddles, [], "map metadata without a spawn cannot prove ground safety");
  const exclusion = { ...groundScene.actor.spawn, radius: 100 };
  assert.deepEqual(forestGroundWeatherFrame(groundScene, { ...input, groundExclusions: [exclusion] }).puddles, []);
});

test("ground effects exclude building art, collision polygons, paths and world boundaries", () => {
  const spawn = groundScene.actor.spawn;
  assert.equal(isForestGroundClear(groundScene, spawn, 2), true);
  assert.equal(isForestGroundClear(groundScene, { x: 500, y: 500 }, 1), false, "uncatalogued woods and water cannot receive effects");
  assert.equal(isForestGroundClear(groundScene, { x: spawn.x + 34, y: spawn.y }, 4), false, "the full footprint must fit in the conservative ellipse");
  assert.equal(isForestGroundClear({ ...groundScene, actor: { spawn: { x: 1, y: 1 }, size: 48 } }, { x: 1, y: 1 }, 2), false);
  const site = { id: "building", bounds: { x: spawn.x - 10, y: spawn.y - 10, width: 20, height: 20 }, collision: [] };
  assert.equal(isForestGroundClear({ ...groundScene, sites: [site] }, spawn, 1), false, "exclude full image bounds, including roof beyond collision");
  const collision = [{ x: spawn.x - 3, y: spawn.y - 3 }, { x: spawn.x + 3, y: spawn.y - 3 }, { x: spawn.x, y: spawn.y + 4 }];
  assert.equal(isForestGroundClear({ ...groundScene, sites: [{ ...site, bounds: { x: 0, y: 0, width: 10, height: 10 }, collision }] }, spawn, 1), false);
  assert.equal(isForestGroundClear({ ...groundScene, paths: [{ id: "route", points: [{ x: spawn.x - 20, y: spawn.y }, { x: spawn.x + 20, y: spawn.y }] }] }, spawn, 1), false);
});

test("ground weather is static in reduced motion and preserves the caller canvas state", () => {
  const input = { ...options, weather: "downpour", wetness: .8, reducedMotion: true };
  const later = { ...input, elapsed: 500, timestamp: rainTimestamp };
  assert.deepEqual(forestGroundWeatherFrame(groundScene, later), forestGroundWeatherFrame(groundScene, input));
  const first = drawing(), second = drawing(1400, 900);
  drawForestGroundWeather(first.ctx, groundScene, input);
  drawForestGroundWeather(second.ctx, groundScene, later);
  assert.deepEqual(first.calls, second.calls);
  assert.equal(first.stack.length, 0);
  assert.deepEqual(first.snapshot(), first.initial);
});

test("manual downpour and wildlife respect reduced motion while preserving the selected atmosphere", () => {
  const input = { ...options, weather: "downpour", butterflies: "on", fireflies: "on", birds: "on", birdElapsed: 0, reducedMotion: true };
  const first = forestAtmosphereFrame(scene, input);
  const later = forestAtmosphereFrame(scene, { ...input, elapsed: 800, timestamp: rainTimestamp, birdElapsed: 9 });
  assert.deepEqual(later, first);
  assert.equal(first.weather, "downpour");
  assert.equal(first.rain, 1);
  assert.deepEqual(first.birds, []);
  assert.deepEqual(first.raindrops, []);
  assert.equal(first.butterflies.length, FOREST_ATMOSPHERE_LIMITS.butterflies);
  assert.equal(first.fireflies.length, FOREST_ATMOSPHERE_LIMITS.fireflies);
  const rendered = drawing();
  drawForestAtmosphere(rendered.ctx, scene, input);
  assert.equal(rendered.calls.some(call => call[0] === "stroke"), false);
});

test("reduced motion freezes both clocks and omits all bird and rain strokes", () => {
  for (const dusk of [false, .5, true]) {
    const first = { ...options, elapsed: 0, timestamp: clearTimestamp, dusk, reducedMotion: true };
    const later = { ...first, elapsed: 3600, timestamp: rainTimestamp + 3 * 86400000 };
    const frame = forestAtmosphereFrame(scene, first);
    assert.deepEqual(forestAtmosphereFrame(scene, later), frame);
    assert.deepEqual(frame.birds, []);
    assert.deepEqual(frame.raindrops, []);
    const before = drawing(), after = drawing();
    drawForestAtmosphere(before.ctx, scene, first);
    drawForestAtmosphere(after.ctx, scene, later);
    assert.deepEqual(after.calls, before.calls, "static wings, glows, tint and weather do not advance with either clock");
    assert.equal(before.calls.some(call => call[0] === "stroke"), false);
  }
});

test("drawing clips to scene bounds and restores the caller's canvas state including bird transforms", () => {
  let elapsed = 0;
  while (elapsed < 300 && !forestAtmosphereFrame(scene, { ...options, elapsed, timestamp: rainTimestamp, dusk: .5 }).birds.length) elapsed++;
  assert.ok(elapsed < 300, "exercise a frame containing a bird transform");
  const drawingState = drawing();
  drawForestAtmosphere(drawingState.ctx, scene, { ...options, elapsed, timestamp: rainTimestamp, dusk: .5 });
  assert.deepEqual(drawingState.calls.slice(0, 4), [["save"], ["beginPath"], ["rect", 0, 0, scene.width, scene.height], ["clip"]]);
  assert.ok(drawingState.calls.some(call => call[0] === "translate"));
  assert.ok(drawingState.calls.some(call => call[0] === "ellipse"));
  assert.ok(drawingState.calls.some(call => call[0] === "fill"));
  assert.equal(drawingState.stack.length, 0);
  assert.deepEqual(drawingState.snapshot(), drawingState.initial, "the next scene pass keeps its alpha, styles, clipping and transform");
});
