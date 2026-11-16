import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { attachGarageWaterParts, eligibleGarageWaterParts } from "../features/world/dev/boat-garage/garage-water-assembly.mjs";
import { getGarageNodeMatrix, validateGarageScene } from "../features/world/dev/boat-garage/garage-scene-model.mjs";

const base = JSON.parse(await readFile(new URL("../features/world/dev/boat-garage/garage-scene-default.json", import.meta.url), "utf8"));
const node = (id, changes = {}) => ({ id, name: id, assetId: null, parentId: null, socketId: null,
  x: 0, y: 0, width: 100, height: 80, scale: 1, rotation: 0, pivotX: .5, pivotY: 1,
  zIndex: 1, visible: true, locked: false, sockets: [], ...changes });
const scene = nodes => validateGarageScene({ ...base, nodes });
const ids = rows => rows.map(node => node.id);
const near = (actual, expected) => actual.forEach((value, index) => assert(Math.abs(value - expected[index]) < 1e-7,
  `${index}: ${value} != ${expected[index]}`));

test("water assembly candidates include explicit arbitrary artwork but exclude subtree, ancestors, hidden and locked layers", () => {
  const value = scene([
    node("ancestor"), node("boat", { parentId: "ancestor" }), node("onboard", { parentId: "boat" }),
    node("independent"), node("stand-with-user-name"), node("locked", { locked: true }),
    node("hidden", { visible: false }), node("hidden-child", { parentId: "hidden" }),
  ]);
  assert.deepEqual(ids(eligibleGarageWaterParts(value, "boat")), ["independent", "stand-with-user-name"]);
  assert.throws(() => eligibleGarageWaterParts(value, "missing"), /не найдена/);
  assert.deepEqual(eligibleGarageWaterParts(value, "locked"), []);
});

test("independent uploaded parts join a floating root while every world matrix and zIndex stays unchanged", () => {
  const original = validateGarageScene({ ...scene([
    node("boat", { x: 700, y: 400, rotation: 25, scaleX: 1.7, scaleY: .6, skewX: 10, flipX: true }),
    node("uploaded-hull", { x: 300, y: 260, rotation: -7, scale: .8, zIndex: 21 }),
    node("uploaded-motor", { x: 230, y: 250, scale: .4, rotation: 13, flipY: true, zIndex: 22 }),
  ]), waterPreview: { rootId: "boat", waterlineY: 620, beam: 860, amplitude: 8 } });
  const before = JSON.stringify(original);
  const joined = attachGarageWaterParts(original, "boat", ["uploaded-hull", "uploaded-motor"]);
  for (const part of original.nodes) {
    near(getGarageNodeMatrix(joined, part.id), getGarageNodeMatrix(original, part.id));
    assert.equal(joined.nodes.find(node => node.id === part.id).zIndex, part.zIndex);
  }
  assert.equal(joined.nodes.find(node => node.id === "uploaded-hull").parentId, "boat");
  assert.equal(joined.nodes.find(node => node.id === "uploaded-motor").parentId, "boat");
  assert.deepEqual(joined.waterPreview, original.waterPreview);
  assert.equal(JSON.stringify(original), before);
  assert.deepEqual(eligibleGarageWaterParts(joined, "boat"), []);
});

test("selecting a group and its child moves only the group and retains the child hierarchy and sockets", () => {
  const original = scene([
    node("boat", { x: 500, y: 300, rotation: 19 }),
    node("hull", { x: 100, y: 200, scaleX: .8, scaleY: 1.5, sockets: [{ id: "engine", name: "Engine", x: .1, y: .3 }] }),
    node("motor", { parentId: "hull", socketId: "engine", x: 8, y: 12, rotation: -12 }),
    node("handle", { parentId: "motor", x: 2, y: 4, scale: .2 }),
  ]);
  const joined = attachGarageWaterParts(original, "boat", ["motor", "hull", "hull"]);
  assert.equal(joined.nodes.find(node => node.id === "hull").parentId, "boat");
  assert.deepEqual(joined.nodes.find(node => node.id === "motor"), original.nodes.find(node => node.id === "motor"));
  assert.deepEqual(joined.nodes.find(node => node.id === "handle"), original.nodes.find(node => node.id === "handle"));
  for (const part of original.nodes) near(getGarageNodeMatrix(joined, part.id), getGarageNodeMatrix(original, part.id));
});

test("invalid batch requests reject atomically and an empty checked selection preserves history identity", () => {
  const original = scene([node("ancestor"), node("boat", { parentId: "ancestor" }), node("onboard", { parentId: "boat" }),
    node("part"), node("locked", { locked: true }), node("hidden", { visible: false })]);
  const before = JSON.stringify(original);
  assert.equal(attachGarageWaterParts(original, "boat", []), original);
  for (const request of [["part", "missing"], ["part", "locked"], ["part", "hidden"], ["boat"], ["ancestor"], ["onboard"], [null]])
    assert.throws(() => attachGarageWaterParts(original, "boat", request));
  assert.throws(() => attachGarageWaterParts(original, "missing", ["part"]), /не найдена/);
  assert.throws(() => attachGarageWaterParts(original, "locked", ["part"]), /открепите/);
  assert.throws(() => attachGarageWaterParts(original, "boat", null), /Выберите/);
  assert.equal(JSON.stringify(original), before);
});
