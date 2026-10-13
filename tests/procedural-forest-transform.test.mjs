import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { objectCorners, objectLocalBounds } = await vite.ssrLoadModule("/features/world/dev/procedural-forest/objects.ts");
const { resizeHandlePositions, findResizeHandle, beginResize, resizedObject, MIN_OBJECT_SCALE, MAX_OBJECT_SCALE } = await vite.ssrLoadModule("/features/world/dev/procedural-forest/transform.ts");

const close = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-8, `${message}: expected ${expected}, got ${actual}`);
const closePoint = (actual, expected, message) => { close(actual.x, expected.x, `${message} x`); close(actual.y, expected.y, `${message} y`); };
const object = (kind = "image", patch = {}) => ({ id: `planted:${kind}`, kind, x: 2400, y: 2300, scale: 1.4, variant: 5,
  ...(kind === "image" ? { imageWidth: 200, imageHeight: 120, assetId: "image:test" } : {}), ...patch });
const pointerForScale = (session, scale) => ({
  x: session.fixedCorner.x + session.diagonal.x * scale + session.grabOffset.x,
  y: session.fixedCorner.y + session.diagonal.y * scale + session.grabOffset.y,
});

test("image resize handles follow the bottom-center anchor and clockwise local corner order", () => {
  const image = object("image", { x: 500, y: 400, scale: 2 });
  assert.deepEqual(resizeHandlePositions(image), [
    { x: 300, y: 160 }, { x: 700, y: 160 }, { x: 700, y: 400 }, { x: 300, y: 400 },
  ]);
  const rotated = resizeHandlePositions({ ...image, rotation: 90 });
  for (const [index, expected] of [{ x: 740, y: 200 }, { x: 740, y: 600 }, { x: 500, y: 600 }, { x: 500, y: 200 }].entries()) {
    closePoint(rotated[index], expected, `rotated image corner ${index}`);
  }
});

test("authored bridge handles use its intrinsic angle together with the editor rotation", () => {
  const bridge = object("bridge", { x: 600, y: 500, scale: 1.25, rotation: 30 });
  const angle = Math.PI / 6 + .22, cosine = Math.cos(angle), sine = Math.sin(angle);
  const expected = [[-67, -46], [77, -46], [77, 55], [-67, 55]].map(([x, y]) => ({
    x: bridge.x + (x * cosine - y * sine) * bridge.scale,
    y: bridge.y + (x * sine + y * cosine) * bridge.scale,
  }));
  for (const [index, corner] of resizeHandlePositions(bridge).entries()) closePoint(corner, expected[index], `bridge corner ${index}`);
  const session = beginResize(bridge, 1, expected[1]);
  close(session.angle, angle, "session retains the complete rendering rotation");
  closePoint(objectCorners(resizedObject(session, pointerForScale(session, 2), 3200, 1600))[3], expected[3], "bridge opposite corner");
});

test("resize handle hit radius is constant in CSS pixels and touch may request a larger radius", () => {
  const image = object("image", { x: 600, y: 500, scale: 1 });
  const topLeft = resizeHandlePositions(image)[0];
  for (const zoom of [.25, 1, 4]) {
    assert.equal(findResizeHandle(image, { x: topLeft.x - 13.9 / zoom, y: topLeft.y }, zoom), 0);
    assert.equal(findResizeHandle(image, { x: topLeft.x - 14.1 / zoom, y: topLeft.y }, zoom), null);
    assert.equal(findResizeHandle(image, { x: topLeft.x - 19 / zoom, y: topLeft.y }, zoom, 20), 0);
    assert.equal(findResizeHandle(image, { x: topLeft.x - 21 / zoom, y: topLeft.y }, zoom, 20), null);
  }
  assert.equal(findResizeHandle(image, topLeft, 0), null);
  assert.equal(findResizeHandle(image, topLeft, NaN), null);
  assert.equal(findResizeHandle(image, { x: Infinity, y: 0 }, 1), null);
  assert.equal(findResizeHandle(image, topLeft, 1, -1), null);
  const tiny = object("image", { imageWidth: 40, imageHeight: 20, scale: .1 });
  assert.equal(findResizeHandle(tiny, resizeHandlePositions(tiny)[2], 1), 2, "overlapping hit areas choose the closest handle");
});

test("small rotated objects keep a central body target for dragging without losing their resize corners", () => {
  for (const kind of ["shrub", "image"]) for (const rotation of [0, 37, -83]) for (const radius of [14, 22]) {
    const tiny = object(kind, { x: 500, y: 500, scale: .1, rotation }), zoom = .25;
    const corners = resizeHandlePositions(tiny);
    const center = { x: (corners[0].x + corners[2].x) / 2, y: (corners[0].y + corners[2].y) / 2 };
    assert.equal(findResizeHandle(tiny, center, zoom, radius), null, `${kind} rotated ${rotation} body must remain draggable`);
    const nearCenter = { x: center.x + (corners[1].x - corners[0].x) * .1, y: center.y + (corners[1].y - corners[0].y) * .1 };
    assert.equal(findResizeHandle(tiny, nearCenter, zoom, radius), null, "the central 30% of the local frame has body priority");
    for (const [index, corner] of corners.entries()) assert.equal(findResizeHandle(tiny, corner, zoom, radius), index, "exact corners always resize");
    const angle = rotation * Math.PI / 180;
    const outside = { x: corners[0].x - Math.cos(angle) * radius / zoom / 2, y: corners[0].y - Math.sin(angle) * radius / zoom / 2 };
    assert.equal(findResizeHandle(tiny, outside, zoom, radius), 0, "expanded hit areas outside the frame remain available");
  }
});

test("every corner of every object kind resizes uniformly around its fixed opposite corner without a grab jump", () => {
  for (const kind of ["tree", "shrub", "rock", "ruins", "bridge", "jetty", "image"]) {
    for (const corner of [0, 1, 2, 3]) {
      const original = object(kind, { rotation: -47 }), before = structuredClone(original);
      const handles = resizeHandlePositions(original), grab = { x: handles[corner].x + 7, y: handles[corner].y - 11 };
      const session = beginResize(original, corner, grab);
      const unchanged = resizedObject(session, grab, 6000, 6000);
      close(unchanged.scale, original.scale, `${kind} initial scale`);
      closePoint(unchanged, original, `${kind} initial anchor`);
      const resized = resizedObject(session, pointerForScale(session, 3.25), 6000, 6000);
      close(resized.scale, 3.25, `${kind} corner ${corner} target scale`);
      closePoint(objectCorners(resized)[(corner + 2) % 4], handles[(corner + 2) % 4], `${kind} fixed opposite corner ${corner}`);
      const local = objectLocalBounds(original), newHandles = objectCorners(resized);
      close(Math.hypot(newHandles[1].x - newHandles[0].x, newHandles[1].y - newHandles[0].y) / local.width, resized.scale, `${kind} width scale`);
      close(Math.hypot(newHandles[3].x - newHandles[0].x, newHandles[3].y - newHandles[0].y) / local.height, resized.scale, `${kind} height scale`);
      assert.deepEqual(original, before, "resize is pure and preserves all object metadata");
      assert.equal(resized.id, original.id); assert.equal(resized.kind, original.kind); assert.equal(resized.rotation, original.rotation);
    }
  }
});

test("uniform resize projects pointer motion onto the rotated diagonal rather than measuring radial distance", () => {
  const image = object("image", { rotation: 63 });
  const handles = resizeHandlePositions(image), session = beginResize(image, 0, handles[0]);
  const pointer = pointerForScale(session, 2.75);
  const sideways = { x: pointer.x - session.diagonal.y * 3, y: pointer.y + session.diagonal.x * 3 };
  const resized = resizedObject(session, sideways, 6000, 6000);
  close(resized.scale, 2.75, "perpendicular pointer motion does not change scale");
  closePoint(objectCorners(resized)[2], handles[2], "fixed corner survives diagonal projection");
});

test("scale limits prevent corner flips and preserve the fixed corner at both limits", () => {
  for (const corner of [0, 1, 2, 3]) {
    const image = object("image", { rotation: 12 }), handles = resizeHandlePositions(image);
    const session = beginResize(image, corner, handles[corner]);
    for (const [pointerScale, expected] of [[-2, MIN_OBJECT_SCALE], [0, MIN_OBJECT_SCALE], [100, MAX_OBJECT_SCALE]]) {
      const resized = resizedObject(session, pointerForScale(session, pointerScale), 10000, 10000);
      assert.equal(resized.scale, expected);
      closePoint(objectCorners(resized)[(corner + 2) % 4], handles[(corner + 2) % 4], `scale limit opposite corner ${corner}`);
    }
  }
});

test("world limits constrain scale while keeping the opposite corner fixed", () => {
  const fixtures = [
    { x: 20, y: 20, corner: 0, scale: 8, expectedScale: 1.4, expected: { x: 0, y: 20 } },
    { x: 980, y: 20, corner: 1, scale: 8, expectedScale: 1.4, expected: { x: 1000, y: 20 } },
    { x: 500, y: 20, corner: 2, scale: .1, expectedScale: .8, expected: { x: 490, y: 0 } },
    { x: 500, y: 980, corner: 2, scale: 8, expectedScale: 1.2, expected: { x: 510, y: 1000 } },
  ];
  for (const fixture of fixtures) {
    const image = object("image", { x: fixture.x, y: fixture.y, imageWidth: 100, imageHeight: 100, scale: 1 });
    const handles = resizeHandlePositions(image), session = beginResize(image, fixture.corner, handles[fixture.corner]);
    const resized = resizedObject(session, pointerForScale(session, fixture.scale), 1000, 1000);
    closePoint(resized, fixture.expected, "anchor at world edge");
    close(resized.scale, fixture.expectedScale, "admissible scale stops at world edge");
    closePoint(objectCorners(resized)[(fixture.corner + 2) % 4], handles[(fixture.corner + 2) % 4], "world edge preserves the fixed corner");
  }
  const image = object("image"), session = beginResize(image, 0, resizeHandlePositions(image)[0]);
  assert.deepEqual(resizedObject(session, { x: NaN, y: 0 }, 3200, 1600), image);
  assert.deepEqual(resizedObject(session, pointerForScale(session, 2), Infinity, 1600), image);
  assert.deepEqual(resizedObject(session, pointerForScale(session, 2), 3200, -1), image);
});

test("every resize corner preserves its opposite corner for rotated images and props at every world boundary", () => {
  for (const kind of ["image", "bridge", "jetty", "ruins"]) for (const rotation of [-113, 37, 90]) {
    for (const [x, y] of [[0, 0], [1000, 0], [1000, 1000], [0, 1000], [1, 500], [999, 500], [500, 1], [500, 999]]) {
      const original = object(kind, { x, y, rotation, scale: 1 }), handles = resizeHandlePositions(original);
      for (const corner of [0, 1, 2, 3]) {
        const session = beginResize(original, corner, handles[corner]);
        for (const requestedScale of [-100, 100]) {
          const resized = resizedObject(session, pointerForScale(session, requestedScale), 1000, 1000);
          assert.ok(resized.x >= 0 && resized.x <= 1000, `${kind} ${rotation} corner ${corner} x inside world: ${resized.x}`);
          assert.ok(resized.y >= 0 && resized.y <= 1000, `${kind} ${rotation} corner ${corner} y inside world: ${resized.y}`);
          assert.ok(resized.scale >= MIN_OBJECT_SCALE && resized.scale <= MAX_OBJECT_SCALE);
          closePoint(objectCorners(resized)[(corner + 2) % 4], handles[(corner + 2) % 4], `${kind} opposite corner at world boundary`);
        }
      }
    }
  }
});
