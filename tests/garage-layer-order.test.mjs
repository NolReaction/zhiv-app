import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { canMoveGarageLayer, garageLayerStack, garageMovingLayerIds, moveGarageLayer } from "../features/world/dev/boat-garage/garage-layer-order.mjs";
import { changeGarageHistory, redoGarageHistory, undoGarageHistory } from "../features/world/dev/boat-garage/garage-editor-shortcuts.mjs";
import { getGarageNodeMatrix, validateGarageScene } from "../features/world/dev/boat-garage/garage-scene-model.mjs";

const example = validateGarageScene(JSON.parse(await readFile(new URL("../features/world/dev/boat-garage/garage-scene-example.json", import.meta.url), "utf8")));
const ids = scene => garageLayerStack(scene).map(node => node.id);
const node = (scene, id) => scene.nodes.find(item => item.id === id);

test("layer list reflects SVG draw order including equal-depth supports; moving a part changes neither geometry nor attachments", () => {
  assert.deepEqual(ids(example), ["starter-hull", "boat", "starter-motor", "stand-right", "stand-left", "garage"]);
  const next = moveGarageLayer(example, "starter-motor", "starter-hull", "above");
  assert.deepEqual(ids(next), ["starter-motor", "starter-hull", "boat", "stand-right", "stand-left", "garage"]);
  assert.ok(node(next, "starter-motor").zIndex > node(next, "starter-hull").zIndex);
  for (const before of example.nodes) {
    assert.deepEqual(getGarageNodeMatrix(next, before.id), getGarageNodeMatrix(example, before.id));
    if (before.id !== "starter-motor") assert.equal(node(next, before.id), before);
  }
  assert.equal(node(next, "starter-motor").socketId, "engine");
  assert.deepEqual([...garageMovingLayerIds(next, "starter-hull")], ["starter-hull"]);
});

test("dropping a group between tied supports moves all its descendants as one undoable, serializable block", () => {
  const next = moveGarageLayer(example, "boat", "stand-right", "below");
  const expected = ["stand-right", "starter-hull", "boat", "starter-motor", "stand-left", "garage"];
  assert.deepEqual(ids(next), expected);
  assert.deepEqual(ids(validateGarageScene(JSON.parse(JSON.stringify(next)))), expected);
  assert.equal(node(next, "garage"), node(example, "garage"));
  for (const before of example.nodes) assert.deepEqual(getGarageNodeMatrix(next, before.id), getGarageNodeMatrix(example, before.id));
  const history = changeGarageHistory({ past: [], scene: example, future: [] }, next);
  assert.equal(history.past.length, 1);
  assert.equal(undoGarageHistory(history).scene, example);
  assert.equal(redoGarageHistory(undoGarageHistory(history)).scene, next);
});

test("locked sources, groups with locked descendants, stale destinations and existing placements are no-ops", () => {
  const locked = { ...example, nodes: example.nodes.map(item => item.id === "starter-motor" ? { ...item, locked: true } : item) };
  assert.equal(canMoveGarageLayer(locked, "boat"), false);
  assert.equal(moveGarageLayer(locked, "boat", "garage", "below"), locked);
  for (const [source, target, side] of [
    ["garage", "boat", "above"], ["missing", "boat", "above"], ["boat", "missing", "above"],
    ["boat", "starter-motor", "above"], ["starter-motor", "starter-motor", "below"],
    ["boat", "stand-right", "above"], ["stand-right", "stand-left", "above"],
  ]) assert.equal(moveGarageLayer(example, source, target, side), example);
});

test("extreme and densely packed imported depths still allow exact insertion around locked and hidden layers", () => {
  for (const [depth, source, target, side, first] of [
    [100000, "stand-right", "starter-motor", "above", true],
    [-100000, "starter-motor", "garage", "below", false],
  ]) {
    const dense = { ...example, nodes: example.nodes.map(item => ({ ...item, zIndex: depth, visible: false })) };
    const next = moveGarageLayer(dense, source, target, side);
    assert.equal(first ? ids(next)[0] : ids(next).at(-1), source);
    assert.deepEqual(ids(validateGarageScene(JSON.parse(JSON.stringify(next)))), ids(next));
    assert.equal(node(next, "garage"), node(dense, "garage"));
  }
});
