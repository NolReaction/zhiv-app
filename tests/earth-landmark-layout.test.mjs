import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  server: { middlewareMode: true, hmr: false } });
after(() => vite.close());
const { earthLandmarkView, layoutEarthLandmarks, EARTH_LANDMARK_WIDTH, EARTH_LANDMARK_HEIGHT,
  EARTH_LANDMARK_FULL_SIZE_ZOOM, EARTH_LANDMARK_MAX_ZOOM } = await vite.ssrLoadModule("/features/earth/landmark-layout.ts");
const viewport = { width: 390, height: 844 };
const candidate = (id, x, y, priority = 1, covered = false) => ({ id, x, y, priority, covered });

test("native miniature size stays compact and strongly zoomed-out globes have no objects", () => {
  assert.equal(EARTH_LANDMARK_WIDTH, 48);
  assert.equal(EARTH_LANDMARK_HEIGHT, 48);
  for (const zoom of [-20, -1.5, -0.3, -0.2]) assert.equal(earthLandmarkView(zoom).opacity, 0);
  assert.ok(earthLandmarkView(0.2).opacity > 0 && earthLandmarkView(0.2).opacity < 1);
  assert.equal(earthLandmarkView(0.6).opacity, 1);
  assert.ok(earthLandmarkView(-0.199).opacity < 0.00001, "miniatures appear gradually");
  let previous = 0;
  for (let zoom = -2; zoom <= 6; zoom += 0.1) {
    const view = earthLandmarkView(zoom);
    assert.ok(view.scale >= previous && view.scale >= 0.3 && view.scale <= 1);
    assert.equal(view.width, 48 * view.scale);
    assert.equal(view.height, 48 * view.scale);
    previous = view.scale;
  }
});

test("compact city miniatures remain visible up to the physical street handover and reject invalid zoom", () => {
  assert.equal(EARTH_LANDMARK_FULL_SIZE_ZOOM, 3.8);
  assert.equal(EARTH_LANDMARK_MAX_ZOOM, 15);
  for (const zoom of [3.8, 4.5, 5.2, 8, 10, 12, 14.999]) {
    assert.equal(earthLandmarkView(zoom).opacity, 1);
    assert.equal(earthLandmarkView(zoom).height, 48);
    assert.deepEqual([...layoutEarthLandmarks([candidate("tower", 100, 100)], viewport, earthLandmarkView(zoom))], ["tower"]);
  }
  assert.equal(earthLandmarkView(15).opacity, 0, "the physical renderer takes over at 15");
  for (const zoom of [NaN, Infinity, -Infinity]) {
    const view = earthLandmarkView(zoom);
    assert.equal(view.opacity, 0);
    assert.ok(Object.values(view).every(Number.isFinite));
    assert.deepEqual([...layoutEarthLandmarks([candidate("tower", 100, 100)], viewport, view)], []);
  }
});

test("far Europe gives the higher-priority Eiffel tower room; separating projected points reveals both landmarks", () => {
  const closeEurope = [candidate("colosseum", 160, 220, 20), candidate("eiffel", 130, 205, 30)];
  assert.deepEqual([...layoutEarthLandmarks(closeEurope, viewport, earthLandmarkView(2.1))], ["eiffel"]);
  const zoomedEurope = [candidate("colosseum", 285, 250, 20), candidate("eiffel", 110, 205, 30)];
  assert.deepEqual([...layoutEarthLandmarks(zoomedEurope, viewport, earthLandmarkView(3))], ["eiffel", "colosseum"]);
  assert.deepEqual(closeEurope, [candidate("colosseum", 160, 220, 20), candidate("eiffel", 130, 205, 30)], "decluttering never reorders caller data");
});

test("collision checks use the scaled art rectangles and preserve four pixels of breathing room", () => {
  const view = earthLandmarkView(2.1);
  const separation = view.width + 4;
  assert.equal(layoutEarthLandmarks([candidate("a", 100, 200), candidate("b", 100 + separation - 0.1, 200)], viewport, view).size, 1);
  assert.equal(layoutEarthLandmarks([candidate("a", 100, 200), candidate("b", 100 + separation, 200)], viewport, view).size, 2);
  assert.equal(layoutEarthLandmarks([candidate("a", 100, 200), candidate("b", 100, 200 + view.height + 4)], viewport, view).size, 2);
  assert.equal(layoutEarthLandmarks([candidate("a", 100, 200), candidate("b", 100 + separation, 200)], viewport, earthLandmarkView(3.8)).size, 1,
    "larger illustrations need more spacing at the same projected points");
});

test("actual ink bounds keep nearby narrow illustrations visible while rejecting genuine overlaps", () => {
  const view = earthLandmarkView(1.8);
  const points = [candidate("eiffel", 100, 200, 30), candidate("moscow", 128, 200, 20)];
  assert.deepEqual([...layoutEarthLandmarks(points, viewport, view)], ["eiffel"], "full transparent frames would collide");
  const ink = points.map(point => ({ ...point, width: 22, height: 48 }));
  assert.deepEqual([...layoutEarthLandmarks(ink, viewport, view)], ["eiffel", "moscow"], "decluttering uses the visible artwork footprint");
  assert.deepEqual([...layoutEarthLandmarks([ink[0], { ...ink[1], x: 120 }], viewport, view)], ["eiffel"], "true ink overlap still hides the lower priority landmark");
  assert.equal(layoutEarthLandmarks([{ ...points[0], height: 20 }, { ...points[1], x: 100, y: 225, height: 20 }], viewport, view).size, 2,
    "an overridden height also avoids a collision caused only by vertical padding");
  assert.equal(layoutEarthLandmarks([{ ...points[0], width: 22 }, { ...points[1], width: 22 }], viewport, view).size, 2,
    "an omitted dimension still defaults to the common scaled frame");
});

test("invalid per-art bounds never block a valid lower-priority illustration", () => {
  const view = earthLandmarkView(1.8);
  for (const dimension of ["width", "height"]) for (const value of [NaN, Infinity, -Infinity, 0, -1]) {
    const invalid = { ...candidate("invalid", 100, 200, 100), [dimension]: value };
    assert.deepEqual([...layoutEarthLandmarks([invalid, candidate("good", 100, 200)], viewport, view)], ["good"]);
  }
});

test("horizon-covered, nonfinite and fully offscreen art cannot hide visible candidates", () => {
  const candidates = [candidate("behind", 100, 200, 100, true), candidate("good", 100, 200),
    candidate("nan", NaN, 200, 100), candidate("infinite-y", 100, Infinity, 100), candidate("invalid-priority", 100, 200, NaN),
    candidate("left", -100, 100), candidate("right", 500, 100), candidate("above", 200, -1), candidate("below", 200, 1000)];
  assert.deepEqual([...layoutEarthLandmarks(candidates, viewport, earthLandmarkView(1.8))], ["good"]);
  assert.deepEqual([...layoutEarthLandmarks([candidate("partial-left", -15, 100), candidate("partial-bottom", 200, 870)], viewport, earthLandmarkView(1.8))],
    ["partial-left", "partial-bottom"], "partially visible artwork remains visible even when its anchor lies offscreen");
});

test("equal priorities are stable, duplicate ids are harmless and invalid viewports produce an empty set", () => {
  const candidates = Object.freeze([Object.freeze(candidate("first", 100, 200)), Object.freeze(candidate("second", 105, 200)),
    Object.freeze(candidate("first", 250, 200)), Object.freeze(candidate("third", 250, 200))]);
  assert.deepEqual([...layoutEarthLandmarks(candidates, viewport, earthLandmarkView(1.8))], ["first", "third"]);
  for (const invalidViewport of [{ width: 0, height: 844 }, { width: 390, height: -1 }, { width: NaN, height: 844 }, { width: 390, height: Infinity }]) {
    assert.equal(layoutEarthLandmarks(candidates, invalidViewport, earthLandmarkView(1.8)).size, 0);
  }
  for (const property of ["width", "height", "scale", "opacity"]) {
    const view = { ...earthLandmarkView(1.8), [property]: NaN };
    assert.equal(layoutEarthLandmarks(candidates, viewport, view).size, 0);
  }
});

test("all nine separated models remain visible across the former zoom count threshold", () => {
  const candidates = Array.from({ length: 9 }, (_, index) => candidate(String(index), 50 + index * 100, 100));
  for (const zoom of [0.5, 1.499, 1.501, 2.5]) {
    assert.deepEqual([...layoutEarthLandmarks(candidates, { width: 1000, height: 500 }, earthLandmarkView(zoom))],
      candidates.map(point => point.id), `zoom ${zoom} cannot hide an unobstructed monument`);
  }
  assert.ok(earthLandmarkView(0.5).height < 24);
  const excess = [...candidates, candidate("outside-catalogue-budget", 950, 300)];
  assert.equal(layoutEarthLandmarks(excess, { width: 1000, height: 500 }, earthLandmarkView(1.5)).size, 9,
    "the maximum stays bounded even with an unexpected extra candidate");
});
