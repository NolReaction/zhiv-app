import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import sharp from "sharp";
import { createGarageSideProfile, GARAGE_SIDE_ASSETS, GARAGE_SIDE_LEVELS } from "../features/world/dev/boat-garage/garage-side-profile.mjs";
import { garageBranchIds, garageNodeContactPoint, getGarageNodeMatrix, transformGaragePoint, validateGarageScene } from "../features/world/dev/boat-garage/garage-scene-model.mjs";
const root = new URL("../", import.meta.url);
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-7, `${actual} != ${expected}`);

test("studio side-profile library preserves editable boat masters, hose and vector stand", async () => {
  assert.deepEqual(GARAGE_SIDE_LEVELS, [0, 1, 2, 3, 4, 5]);
  assert.equal(GARAGE_SIDE_ASSETS.length, 20);
  assert.equal(new Set(GARAGE_SIDE_ASSETS.map(asset => asset.id)).size, 20);
  for (const asset of GARAGE_SIDE_ASSETS) {
    const publicBytes = await readFile(new URL(`public${asset.src}`, root));
    assert.deepEqual(publicBytes, await readFile(new URL(`art${asset.src}`, root)), `${asset.id}: runtime matches editable master`);
    const xml = publicBytes.toString("utf8");
    assert.doesNotMatch(xml, /<image\b|<script\b|<foreignObject\b|<filter\b|(?:href|xlink:href)\s*=/i);
    const metadata = await sharp(publicBytes).metadata();
    assert.equal(metadata.width, asset.width); assert.equal(metadata.height, asset.height);
  }
});

test("all 216 side-profile combinations retain the same transom and fuel mount", () => {
  for (const hull of GARAGE_SIDE_LEVELS) for (const engine of GARAGE_SIDE_LEVELS) for (const tank of GARAGE_SIDE_LEVELS) {
    const scene = createGarageSideProfile({ hull, engine, tank });
    const engineNode = scene.nodes.find(node => node.id === "side-engine");
    const tankNode = scene.nodes.find(node => node.id === "side-tank");
    const motorAnchor = transformGaragePoint(getGarageNodeMatrix(scene, "side-engine"), { x: 220, y: 235 });
    const fuelAnchor = transformGaragePoint(getGarageNodeMatrix(scene, "side-tank"), { x: 150, y: 230 });
    close(motorAnchor.x, 195.5 + 220 * .8); close(motorAnchor.y, 185 + 290 * .8);
    close(fuelAnchor.x, 195.5 + 500 * .8); close(fuelAnchor.y, 185 + 290 * .8);
    assert.equal(engineNode.assetId, `side-engine-l${engine}`); assert.equal(tankNode.assetId, `side-tank-l${tank}`);
    assert.ok(scene.nodes.every(node => !/crate|cargo|ящик/i.test(`${node.id} ${node.name}`)));
    assert.ok(scene.nodes.flatMap(node => node.sockets).every(socket => !/crate|cargo|ящик/i.test(`${socket.id} ${socket.name}`)));
  }
});

test("side-profile presets are fresh owned scenes and cannot mutate another build", () => {
  const initial = createGarageSideProfile(), before = structuredClone(initial);
  const other = createGarageSideProfile({ hull: 5, engine: 0, tank: 3 });
  other.nodes.find(node => node.id === "side-hull").x += 100; other.assets[2].name = "changed";
  assert.deepEqual(initial, before);
  assert.throws(() => createGarageSideProfile({ hull: 6 }), /L0 до L5/);
});

test("only the shipped modular SVG allowlist extends the raster-only import boundary", () => {
  for (const src of ["/world/boat/modular/custom.svg", "/world/boat/modular/hull_l6.svg", "/world/boat/modular/engine_l0.svg#x",
    "/world/boat/modular/../hull_l0.svg", "/world/boat-garage/custom.svg", "/world/boat-garage/stand-side.svg#x",
    "/world/boat-garage/sub/stand-side.svg", "https://example.com/hull_l0.svg", "data:image/svg+xml,<svg/>"]) {
    const scene = createGarageSideProfile(); scene.assets[1].src = src;
    assert.throws(() => validateGarageScene(scene), /Изображения должны/);
  }
});


test("side-profile garage supports touch the keel and stay outside the floating rig", () => {
  const scene = createGarageSideProfile({ hull: 5, engine: 5, tank: 5 });
  close(scene.waterPreview.waterlineY, 620.2);
  assert.equal(scene.waterPreview.effectsEnabled, true);
  assert.equal(scene.waterPreview.immersionEnabled, true);
  const floating = garageBranchIds(scene, "boat");
  for (const id of ["side-stand-left", "side-stand-right"]) {
    const stand = scene.nodes.find(node => node.id === id), matrix = getGarageNodeMatrix(scene, id);
    const top = transformGaragePoint(matrix, garageNodeContactPoint(stand, "contact"));
    const foot = transformGaragePoint(matrix, garageNodeContactPoint(stand, "foot"));
    close(top.y, 185 + 560 * .8 - 4); close(foot.y, 789);
    close(foot.y - top.y, 160);
    close(matrix[0], matrix[3]); close(matrix[1], 0); close(matrix[2], 0);
    assert.equal(scene.assets.find(asset => asset.id === stand.assetId).src, "/world/boat-garage/stand-side.svg");
    assert.equal(stand.parentId, null); assert.equal(floating.has(id), false);
  }
});
