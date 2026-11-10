import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { alignGarageNodeToPoints, alignGarageNodeToSocket, garageNodeContactPoint, getGarageNodeMatrix,
  inverseGaragePoint, moveGaragePivot, reparentGarageNode, transformGaragePoint, validateGarageScene } from "../features/world/dev/boat-garage/garage-scene-model.mjs";

const base = JSON.parse(await readFile(new URL("../features/world/dev/boat-garage/garage-scene-default.json", import.meta.url), "utf8"));
const node = (id, changes = {}) => ({ id, name: id, assetId: null, parentId: null, socketId: null,
  x: 0, y: 0, width: 100, height: 80, scale: 1, rotation: 0, pivotX: .5, pivotY: 1,
  zIndex: 1, visible: true, locked: false, sockets: [], ...changes });
const scene = nodes => validateGarageScene({ ...base, nodes });
function near(actual, expected, message = "coordinates") {
  assert.equal(actual.length, expected.length);
  actual.forEach((value, index) => assert.ok(Math.abs(value - expected[index]) < 1e-7, `${message}[${index}]: ${value} != ${expected[index]}`));
}
const nearPoint = (actual, expected) => near([actual.x, actual.y], [expected.x, expected.y]);
const socketWorld = (value, id, socketId) => transformGaragePoint(getGarageNodeMatrix(value, id),
  garageNodeContactPoint(value.nodes.find(item => item.id === id), socketId));

test("old scenes retain exact JSON and extended fit imports retain only validated geometry", () => {
  assert.deepEqual(validateGarageScene(base), base);
  const value = scene([node("stand", { scaleX: .55, scaleY: 1.2, flipX: true, flipY: false, skewX: 13, arbitraryCode: "no" })]);
  const fitted = value.nodes[0];
  assert.equal(fitted.scaleX, .55); assert.equal(fitted.scaleY, 1.2);
  assert.equal(fitted.flipX, true); assert.equal(fitted.skewX, 13);
  assert.equal("arbitraryCode" in fitted, false);
  assert.deepEqual(validateGarageScene(JSON.parse(JSON.stringify(value))), value);
  for (const changes of [{ scaleX: 0 }, { scaleY: Infinity }, { flipX: 1 }, { flipY: "yes" }, { skewX: 90 }])
    assert.throws(() => scene([node("bad", changes)]));
});

test("independent dimensions and reflection retain pivot placement and invert pointer coordinates", () => {
  const value = scene([node("stand", { x: 420, y: 700, scale: .4, scaleX: 1.5, scaleY: .7, flipX: true, rotation: 23, skewX: -12 })]);
  const matrix = getGarageNodeMatrix(value, "stand");
  nearPoint(transformGaragePoint(matrix, { x: 50, y: 80 }), { x: 420, y: 700 });
  const source = { x: 17, y: 25 };
  nearPoint(inverseGaragePoint(matrix, transformGaragePoint(matrix, source)), source);
  assert.ok(matrix[0] * matrix[3] - matrix[1] * matrix[2] < 0, "horizontal reflection keeps negative orientation");
});

test("nonuniform rotated parents and sockets reparent without moving any corner", () => {
  const original = scene([
    node("hull", { x: 810, y: 500, scale: .7, scaleX: 1.8, scaleY: .65, rotation: 28, skewX: 9, flipX: true,
      sockets: [{ id: "contact", name: "Contact", x: .15, y: .86 }] }),
    node("fixture", { x: 250, y: 680, scale: .35, scaleX: .8, scaleY: 1.3, rotation: -11, skewX: -7, flipY: true }),
    node("nested", { parentId: "fixture", x: 8, y: -9, scale: .4, rotation: 3 }),
  ]);
  const fixture = getGarageNodeMatrix(original, "fixture"), nested = getGarageNodeMatrix(original, "nested");
  const attached = reparentGarageNode(original, "fixture", "hull", "contact");
  near(getGarageNodeMatrix(attached, "fixture"), fixture);
  near(getGarageNodeMatrix(attached, "nested"), nested);
  const detached = reparentGarageNode(attached, "fixture", null);
  near(getGarageNodeMatrix(detached, "fixture"), fixture);
  near(getGarageNodeMatrix(detached, "nested"), nested);
});

test("changing a fitted pivot preserves the image, its children and the socket positions", () => {
  const original = scene([node("stand", { x: 420, y: 700, scale: .4, scaleX: 1.5, scaleY: .7, flipX: true, rotation: 23, skewX: -12,
    sockets: [{ id: "top", name: "Top", x: .5, y: .1 }] }), node("child", { parentId: "stand", socketId: "top", x: 2, y: 3, scale: .2 })]);
  const changed = moveGaragePivot(original, "stand", { x: .24, y: .39 });
  near(getGarageNodeMatrix(changed, "stand"), getGarageNodeMatrix(original, "stand"));
  near(getGarageNodeMatrix(changed, "child"), getGarageNodeMatrix(original, "child"));
  nearPoint(socketWorld(changed, "stand", "top"), socketWorld(original, "stand", "top"));
  assert.equal(changed.nodes[0].pivotX, .24); assert.equal(original.nodes[0].pivotX, .5);
  assert.throws(() => moveGaragePivot(original, "stand", { x: 2, y: 0 }));
});

test("one-point support contact is exact while leaving fixture independent and maintaining its shape", () => {
  const original = scene([
    node("hull", { x: 810, y: 500, scale: .7, scaleX: 1.8, scaleY: .65, rotation: 28, flipX: true,
      sockets: [{ id: "support", name: "Support", x: .2, y: .8 }] }),
    node("stand", { x: 250, y: 680, scale: .35, scaleX: .8, scaleY: 1.3, rotation: -11, skewX: -7,
      sockets: [{ id: "top", name: "Top", x: .5, y: .12 }] }),
  ]);
  const oldShape = getGarageNodeMatrix(original, "stand").slice(0, 4);
  const aligned = alignGarageNodeToSocket(original, "stand", "top", "hull", "support");
  nearPoint(socketWorld(aligned, "stand", "top"), socketWorld(aligned, "hull", "support"));
  near(getGarageNodeMatrix(aligned, "stand").slice(0, 4), oldShape);
  assert.equal(aligned.nodes[1].parentId, null);
  const movedHull = { ...aligned, nodes: aligned.nodes.map(item => item.id === "hull" ? { ...item, x: item.x + 100 } : item) };
  near(getGarageNodeMatrix(movedHull, "stand"), getGarageNodeMatrix(aligned, "stand"));
});

test("one-point fit works in an existing nonuniform parent without overwriting ownership", () => {
  const original = scene([
    node("group", { scaleX: 1.5, scaleY: .6, rotation: 19 }),
    node("part", { parentId: "group", x: 20, y: 30, scale: .5 }),
    node("target", { x: 700, y: 400, sockets: [{ id: "anchor", name: "Anchor", x: .1, y: .2 }] }),
  ]);
  const aligned = alignGarageNodeToSocket(original, "part", null, "target", "anchor");
  nearPoint(socketWorld(aligned, "part", null), socketWorld(aligned, "target", "anchor"));
  assert.equal(aligned.nodes[1].parentId, "group");
  assert.throws(() => alignGarageNodeToSocket(original, "group", null, "part", null), /потомке/);
  assert.throws(() => alignGarageNodeToSocket(original, "part", null, "part", null), /самом слое/);
  assert.throws(() => alignGarageNodeToSocket(original, "part", "missing", "target", "anchor"), /Крепление/);
});

test("two-point fit places both authored contacts exactly under an affine parent", () => {
  const original = scene([
    node("group", { x: 900, y: 400, scale: .8, rotation: 27, scaleX: 1.4, scaleY: .7, skewX: 9 }),
    node("fixture", { parentId: "group", x: 10, y: 20, scale: .4, flipX: true, scaleY: .8 }),
  ]);
  const source = [{ x: 15, y: 35 }, { x: 85, y: 35 }], target = [{ x: 400, y: 600 }, { x: 615, y: 562 }];
  const fitted = alignGarageNodeToPoints(original, "fixture", source, target);
  source.forEach((point, index) => nearPoint(transformGaragePoint(getGarageNodeMatrix(fitted, "fixture"), point), target[index]));
  assert.equal(fitted.nodes[1].parentId, "group");
  assert.throws(() => alignGarageNodeToPoints(original, "fixture", [source[0], source[0]], target), /две разные/);
  assert.throws(() => alignGarageNodeToPoints(original, "fixture", source, [target[0], target[0]]), /две разные/);
});

test("fitted transforms reject collapsed nested dimensions and locked contact edits", () => {
  assert.throws(() => scene([node("a", { scaleX: .001 }), node("b", { parentId: "a", scaleX: .001 }), node("c", { parentId: "b", scaleX: .001 })]), /Суммарный масштаб/);
  const value = scene([node("stand", { locked: true }), node("target")]);
  assert.throws(() => moveGaragePivot(value, "stand", { x: 0, y: 0 }), /открепите/);
  assert.throws(() => alignGarageNodeToSocket(value, "stand", null, "target", null), /открепите/);
  assert.throws(() => alignGarageNodeToPoints(value, "stand", [{ x: 0, y: 0 }, { x: 1, y: 0 }], [{ x: 0, y: 0 }, { x: 1, y: 0 }]), /открепите/);
});
