import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { duplicateGarageNode, getGarageNodeMatrix, getGarageParentMatrix, getGarageViewport,
  inverseGaragePoint, removeGarageNode, reparentGarageNode, transformGaragePoint,
  validateGarageScene } from "../features/world/dev/boat-garage/garage-scene-model.mjs";

const base = JSON.parse(await readFile(new URL("../features/world/dev/boat-garage/garage-scene-default.json", import.meta.url), "utf8"));
const fresh = () => structuredClone(base);
const node = (id, overrides = {}) => ({ id, name: id, assetId: null, parentId: null, socketId: null,
  x: 0, y: 0, width: 100, height: 50, scale: 1, rotation: 0, pivotX: 0, pivotY: 0,
  zIndex: 1, visible: true, locked: false, sockets: [], ...overrides });
function geometry(nodes) { return validateGarageScene({ ...fresh(), nodes }); }
function close(actual, expected, epsilon = 1e-8) {
  assert.equal(actual.length, expected.length);
  actual.forEach((value, i) => assert.ok(Math.abs(value - expected[i]) < epsilon, `${i}: ${value} != ${expected[i]}`));
}
function closePoint(actual, expected) { close([actual.x, actual.y], [expected.x, expected.y]); }

test("default workshop scene has two independent stands and empty boat sockets", () => {
  const scene = validateGarageScene(base);
  assert.equal(scene.nodes.filter(value => value.assetId === "stand").length, 2);
  assert.equal(scene.nodes.find(value => value.id === "garage").locked, true);
  const boat = scene.nodes.find(value => value.id === "boat");
  assert.equal(boat.assetId, null);
  assert.deepEqual(boat.sockets.map(value => value.id), ["engine", "cargo", "fuel", "actor"]);
  assert.equal(scene.cameras.portrait.y, 470.5);
  assert.deepEqual(scene, base);
  scene.nodes[0].name = "Changed";
  assert.notEqual(scene.nodes[0].name, base.nodes[0].name, "validation owns its objects");
});

test("node pivot, clockwise rotation and uniform scale map image pixels into world space", () => {
  const scene = geometry([node("hull", { x: 400, y: 300, pivotX: .5, pivotY: 1, scale: 2, rotation: 90 })]);
  const matrix = getGarageNodeMatrix(scene, "hull");
  closePoint(transformGaragePoint(matrix, { x: 50, y: 50 }), { x: 400, y: 300 });
  closePoint(transformGaragePoint(matrix, { x: 100, y: 50 }), { x: 400, y: 400 });
  closePoint(transformGaragePoint(matrix, { x: 0, y: 0 }), { x: 500, y: 200 });
  closePoint(inverseGaragePoint(matrix, { x: 500, y: 200 }), { x: 0, y: 0 });
});

test("attached motor inherits hull rotation, scale and normalized socket translation", () => {
  const scene = geometry([
    node("hull", { x: 400, y: 300, scale: 2, rotation: 90, sockets: [{ id: "engine", name: "Engine", x: .25, y: .8 }] }),
    node("motor", { parentId: "hull", socketId: "engine", x: 4, y: -5, width: 20, height: 40, pivotX: .5, pivotY: .5 }),
  ]);
  // Parent image socket=(25,40), child pivot offset=(4,-5): (29,35) -> (330,358).
  closePoint(transformGaragePoint(getGarageNodeMatrix(scene, "motor"), { x: 10, y: 20 }), { x: 330, y: 358 });
  closePoint(transformGaragePoint(getGarageParentMatrix(scene, scene.nodes[1]), { x: 0, y: 0 }), { x: 320, y: 350 });
  closePoint(inverseGaragePoint(getGarageParentMatrix(scene, scene.nodes[1]), { x: 330, y: 358 }), { x: 4, y: -5 });
});

test("reparenting to a rotated group, a socket, and back preserves complete world transform", () => {
  const initial = geometry([
    node("hull", { x: 800, y: 500, scale: 1.7, rotation: 27, pivotX: .3, pivotY: .8,
      sockets: [{ id: "engine", name: "Engine", x: .1, y: .6 }] }),
    node("motor", { x: 250, y: 330, scale: .4, rotation: -18, pivotX: .4, pivotY: .7 }),
  ]);
  const world = getGarageNodeMatrix(initial, "motor");
  const grouped = reparentGarageNode(initial, "motor", "hull");
  close(getGarageNodeMatrix(grouped, "motor"), world);
  const attached = reparentGarageNode(grouped, "motor", "hull", "engine");
  close(getGarageNodeMatrix(attached, "motor"), world);
  const detached = reparentGarageNode(attached, "motor", null);
  close(getGarageNodeMatrix(detached, "motor"), world);
  assert.equal(detached.nodes[1].socketId, null);
  assert.equal(initial.nodes[1].parentId, null, "does not mutate source");
});

test("moving a group carries children but leaves root stands in place", () => {
  const scene = geometry([node("boat", { x: 700, y: 300 }), node("engine", { parentId: "boat", x: 10, y: 30 }),
    node("stand", { x: 100, y: 500 })]);
  const engine = getGarageNodeMatrix(scene, "engine"), stand = getGarageNodeMatrix(scene, "stand");
  const moved = { ...scene, nodes: scene.nodes.map(value => value.id === "boat" ? { ...value, x: value.x + 57, y: value.y - 8 } : value) };
  close(getGarageNodeMatrix(moved, "engine"), [...engine.slice(0, 4), engine[4] + 57, engine[5] - 8]);
  close(getGarageNodeMatrix(moved, "stand"), stand);
});

test("reparenting rejects self-parent, descendant cycles and unknown sockets", () => {
  const scene = geometry([node("boat"), node("hull", { parentId: "boat" }), node("motor", { parentId: "hull" })]);
  assert.throws(() => reparentGarageNode(scene, "boat", "boat"), /цикл/);
  assert.throws(() => reparentGarageNode(scene, "boat", "motor"), /цикл/);
  assert.throws(() => reparentGarageNode(scene, "motor", "boat", "missing"), /Крепление/);
  assert.throws(() => reparentGarageNode(scene, "motor", null, "engine"), /Корневой/);
  assert.throws(() => reparentGarageNode(scene, "missing", null), /Слой не найден/);
  assert.throws(() => reparentGarageNode(scene, "motor", "missing"), /Родитель/);
});

test("duplicate creates an independent single node, preserves sockets and does not copy children", () => {
  const scene = geometry([node("boat", { locked: true, sockets: [{ id: "engine", name: "Engine", x: 0, y: .5 }] }),
    node("engine", { parentId: "boat", socketId: "engine" })]);
  const duplicate = duplicateGarageNode(scene, "boat");
  assert.equal(duplicate.nodes.length, 3);
  const copy = duplicate.nodes.at(-1);
  assert.equal(copy.id, "boat-copy");
  assert.equal(copy.locked, false);
  assert.equal(copy.x, 24);
  assert.deepEqual(copy.sockets, scene.nodes[0].sockets);
  copy.sockets[0].x = 1;
  assert.equal(scene.nodes[0].sockets[0].x, 0);
  assert.equal(duplicateGarageNode(duplicate, "boat").nodes.at(-1).id, "boat-copy-2");
  assert.equal(duplicate.nodes[1].parentId, "boat");
});

test("remove deletes descendants even when scene order is reversed", () => {
  const scene = geometry([node("motor", { parentId: "hull" }), node("hull", { parentId: "boat" }), node("boat"), node("stand")]);
  assert.deepEqual(removeGarageNode(scene, "boat").nodes.map(value => value.id), ["stand"]);
  assert.equal(scene.nodes.length, 4);
  assert.equal(removeGarageNode(scene, "missing").nodes.length, 4);
});

test("portrait and landscape cameras preserve geometry and map their center to viewport center", () => {
  const scene = validateGarageScene(base);
  for (const [width, height, mode] of [[390, 292.5, "portrait"], [1024, 768, "landscape"], [844, 270, "landscape"]]) {
    const camera = scene.cameras[mode], viewport = getGarageViewport(scene, width, height, mode);
    closePoint({ x: camera.x * viewport.scale + viewport.x, y: camera.y * viewport.scale + viewport.y }, { x: width / 2, y: height / 2 });
    assert.equal(viewport.scale, width / camera.width);
    close([camera.width * viewport.scale], [width]);
  }
  assert.throws(() => getGarageViewport(scene, 0, 100, "portrait"));
  assert.throws(() => getGarageViewport(scene, 100, Number.NaN, "portrait"));
});

test("imports reject unsafe paths and remote or script images", () => {
  for (const src of ["https://example.com/a.png", "data:image/png;base64,a", "/world/boat-garage/a.svg", "/world/boat-garage/../evil.png",
    "/world/boat-garage/a.png?x=1", "/world/boat-garage/a.png#x", "/world/boat-garage/%2e%2e/a.png", "/world/boat-garage/a\\evil.png"]) {
    const scene = fresh(); scene.assets[0].src = src;
    assert.throws(() => validateGarageScene(scene), /Изображения должны/);
  }
  const scene = fresh(); scene.assets[0].src = "/world/boat-garage/uploads/asset-123.webp";
  assert.equal(validateGarageScene(scene).assets[0].src, scene.assets[0].src);
});

test("imports reject non-finite geometry, bad references, duplicates and impossible hierarchies", () => {
  for (const changes of [{ x: Number.NaN }, { y: Infinity }, { scale: 0 }, { pivotX: -1 }, { width: 0 },
    { zIndex: .5 }, { visible: 1 }, { parentId: "unknown" }, { assetId: "unknown" }, { socketId: "engine" }]) {
    const scene = fresh(); Object.assign(scene.nodes[1], changes);
    assert.throws(() => validateGarageScene(scene));
  }
  const duplicateNode = fresh(); duplicateNode.nodes[1].id = duplicateNode.nodes[0].id;
  assert.throws(() => validateGarageScene(duplicateNode), /уникальны/);
  const duplicateSocket = fresh(); duplicateSocket.nodes[3].sockets.push(duplicateSocket.nodes[3].sockets[0]);
  assert.throws(() => validateGarageScene(duplicateSocket), /уникальны/);
  const duplicateAsset = fresh(); duplicateAsset.assets.push(duplicateAsset.assets[0]);
  assert.throws(() => validateGarageScene(duplicateAsset), /уникальны/);
  assert.throws(() => geometry([node("a", { parentId: "b" }), node("b", { parentId: "a" })]), /цикл/);
  assert.throws(() => geometry([node("a", { scale: .001 }), node("b", { parentId: "a", scale: .001 }), node("c", { parentId: "b", scale: .001 })]), /Суммарный масштаб/);
});

test("import budgets bound layers, images and sockets before geometry work", () => {
  const layers = fresh(); layers.nodes = Array.from({ length: 129 }, (_, index) => node(`node-${index}`));
  assert.throws(() => validateGarageScene(layers), /128/);
  const assets = fresh(); assets.assets = Array.from({ length: 65 }, (_, index) => ({ ...assets.assets[0], id: `asset-${index}` }));
  assert.throws(() => validateGarageScene(assets), /64/);
  const sockets = fresh(); sockets.nodes[0].sockets = Array.from({ length: 33 }, (_, index) => ({ id: `socket-${index}`, name: "Socket", x: 0, y: 0 }));
  assert.throws(() => validateGarageScene(sockets), /32/);
  assert.throws(() => validateGarageScene({ ...fresh(), schemaVersion: 2 }), /версия/);
  assert.throws(() => validateGarageScene(null), /объект/);
});

test("validation strips unknown properties rather than retaining untrusted import payload", () => {
  const scene = fresh(); scene.script = "evil"; scene.nodes[0].html = "<script>evil</script>";
  const parsed = validateGarageScene(scene);
  assert.equal("script" in parsed, false);
  assert.equal("html" in parsed.nodes[0], false);
});
