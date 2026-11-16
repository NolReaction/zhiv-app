import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { getGarageNodeMatrix, inverseGaragePoint, setGarageNodeWorldMatrix,
  removeGarageNode, transformGaragePoint, validateGarageScene } from "../features/world/dev/boat-garage/garage-scene-model.mjs";

const base = JSON.parse(await readFile(new URL("../features/world/dev/boat-garage/garage-scene-default.json", import.meta.url), "utf8"));
const node = (id, changes = {}) => ({ id, name: id, assetId: null, parentId: null, socketId: null,
  x: 0, y: 0, width: 100, height: 80, scale: 1, rotation: 0, pivotX: .5, pivotY: 1,
  zIndex: 1, visible: true, locked: false, sockets: [], ...changes });
const scene = nodes => validateGarageScene({ ...base, nodes });
const near = (actual, expected) => {
  assert.equal(actual.length, expected.length);
  actual.forEach((value, index) => assert(Math.abs(value - expected[index]) < 1e-7, `${index}: ${value} != ${expected[index]}`));
};
const nearPoint = (actual, expected) => near([actual.x, actual.y], [expected.x, expected.y]);

test("world matrix authoring reaches exact corners through a reflected, sheared parent and socket", () => {
  const original = scene([
    node("hull", { x: 810, y: 500, scale: .7, scaleX: 1.8, scaleY: .65, rotation: 28, skewX: 9, flipX: true,
      sockets: [{ id: "engine", name: "Engine", x: .15, y: .86 }] }),
    node("motor", { parentId: "hull", socketId: "engine", x: 12, y: 30, scale: .35, rotation: -11, skewX: -7,
      sockets: [{ id: "tiller", name: "Tiller", x: .8, y: .1 }] }),
    node("handle", { parentId: "motor", socketId: "tiller", x: 8, y: -9, scale: .4, rotation: 3 }),
  ]);
  const before = JSON.stringify(original);
  for (const target of [[.65, .12, -.17, .42, 550, 260], [-.65, .12, -.17, .42, 550, 260]]) {
    const frozen = Object.freeze(target);
    const changed = setGarageNodeWorldMatrix(original, "motor", frozen);
    near(getGarageNodeMatrix(changed, "motor"), target);
    near(getGarageNodeMatrix(changed, "hull"), getGarageNodeMatrix(original, "hull"));
    for (const point of [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 0, y: 80 }, { x: 100, y: 80 }])
      nearPoint(transformGaragePoint(getGarageNodeMatrix(changed, "motor"), point), transformGaragePoint(target, point));
    const motor = changed.nodes.find(item => item.id === "motor");
    assert.equal(motor.parentId, "hull"); assert.equal(motor.socketId, "engine");
    assert.equal(motor.pivotX, .5); assert.equal(motor.pivotY, 1);
    assert.deepEqual(changed.nodes.find(item => item.id === "handle"), original.nodes.find(item => item.id === "handle"));
    const localHandlePoint = inverseGaragePoint(getGarageNodeMatrix(original, "motor"),
      transformGaragePoint(getGarageNodeMatrix(original, "handle"), { x: 35, y: 25 }));
    nearPoint(transformGaragePoint(getGarageNodeMatrix(changed, "handle"), { x: 35, y: 25 }),
      transformGaragePoint(target, localHandlePoint));
  }
  assert.equal(JSON.stringify(original), before, "editing owns a fresh scene and does not mutate its input");
});

test("an unchanged world matrix preserves the exact authored JSON and history identity", () => {
  const original = scene([node("part", { x: 250, y: 300, rotation: 23, scale: .5 })]);
  assert.equal(setGarageNodeWorldMatrix(original, "part", getGarageNodeMatrix(original, "part")), original);
});

test("invalid or forbidden world edits are rejected without changing the original scene", () => {
  const original = scene([node("part"), node("locked", { locked: true })]);
  const before = JSON.stringify(original);
  for (const matrix of [null, [], [1, 0, 0, 1, 0], [1, 0, 0, 1, 0, 0, 0], [1, 0, 0, 1, NaN, 0],
    [1, 0, 0, 1, 0, Infinity], [1, 0, 0, "1", 0, 0], [0, 0, 0, 0, 0, 0], [1, 2, 2, 4, 0, 0], [1, 0, 0, 1, 1e10, 0]])
    assert.throws(() => setGarageNodeWorldMatrix(original, "part", matrix));
  assert.throws(() => setGarageNodeWorldMatrix(original, "missing", [1, 0, 0, 1, 0, 0]), /не найден/);
  assert.throws(() => setGarageNodeWorldMatrix(original, "locked", [1, 0, 0, 1, 0, 0]), /открепите/);
  assert.equal(JSON.stringify(original), before);
});

test("authored water settings round-trip while old scenes remain byte-equivalent", () => {
  const original = scene([node("boat")]);
  assert.deepEqual(validateGarageScene(original), original);
  assert.equal("waterPreview" in original, false);
  const configured = validateGarageScene({ ...original,
    waterPreview: { rootId: "boat", waterlineY: 620, beam: 860, amplitude: 8, animationTime: 123, playing: true } });
  assert.deepEqual(configured.waterPreview, { rootId: "boat", waterlineY: 620, beam: 860, amplitude: 8 });
  assert.deepEqual(validateGarageScene(JSON.parse(JSON.stringify(configured))), configured);
  assert.equal("waterPreview" in original, false, "new preview settings must not mutate a loaded old scene");
});

test("water configuration rejects missing roots and invalid or unbounded physical inputs", () => {
  const original = scene([node("boat")]);
  const waterPreview = { rootId: "boat", waterlineY: 620, beam: 860, amplitude: 8 };
  for (const changes of [{ rootId: "missing" }, { rootId: null }, { waterlineY: Infinity }, { waterlineY: 200001 },
    { waterlineY: -200001 }, { beam: 0 }, { beam: 40001 }, { amplitude: -1 }, { amplitude: 31 }, { amplitude: NaN }])
    assert.throws(() => validateGarageScene({ ...original, waterPreview: { ...waterPreview, ...changes } }));
  assert.throws(() => validateGarageScene({ ...original, waterPreview: null }));
  const still = validateGarageScene({ ...original, waterPreview: { ...waterPreview, amplitude: 0 } });
  assert.equal(still.waterPreview.amplitude, 0, "a still water view is an authored valid setup");
});

test("deleting a floating rig clears its settings only when that subtree is removed", () => {
  const original = validateGarageScene({ ...scene([node("group"), node("boat", { parentId: "group" }), node("motor", { parentId: "boat" }), node("stand")]),
    waterPreview: { rootId: "boat", waterlineY: 620, beam: 860, amplitude: 8 } });
  assert.deepEqual(removeGarageNode(original, "stand").waterPreview, original.waterPreview);
  const withoutRig = removeGarageNode(original, "boat");
  assert.equal("waterPreview" in withoutRig, false);
  assert.equal(withoutRig.nodes.some(item => item.id === "motor"), false);
  assert.equal("waterPreview" in removeGarageNode(original, "group"), false);
  assert.equal(original.waterPreview.rootId, "boat", "removing a rig must not mutate an undo checkpoint");
  assert.deepEqual(validateGarageScene(withoutRig), withoutRig);
});
