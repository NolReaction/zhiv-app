import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createGarageProjectFiles } from "../lib/dev/boat-garage-project-files.mjs";
import { defaultGarageOcclusion, garageOccludersForNode, garageOcclusionPolygonProblem,
  garageOcclusionTargetIds } from "../features/world/dev/boat-garage/garage-occlusion.mjs";
import { duplicateGarageNode, getGarageNodeMatrix, moveGaragePivot, removeGarageNode, reparentGarageNode,
  transformGaragePoint, validateGarageScene } from "../features/world/dev/boat-garage/garage-scene-model.mjs";

const base = JSON.parse(await readFile(new URL("../features/world/dev/boat-garage/garage-scene-default.json", import.meta.url), "utf8"));
const node = (id, overrides = {}) => ({ id, name: id, assetId: null, parentId: null, socketId: null,
  x: 0, y: 0, width: 100, height: 50, scale: 1, rotation: 0, pivotX: 0, pivotY: 0,
  zIndex: 1, visible: true, locked: false, sockets: [], ...overrides });
const hull = (occlusion = defaultGarageOcclusion(), overrides = {}) => node("hull", { assetId: base.assets[0].id, occlusion, ...overrides });
const scene = (nodes = [hull({ ...defaultGarageOcclusion(), targetIds: ["tank"] }), node("tank")]) => validateGarageScene({ ...structuredClone(base), nodes });
const ids = owners => owners.map(owner => owner.id);
const raw = occlusion => ({ ...structuredClone(base), nodes: [hull(occlusion), node("tank")] });
const pointsInWorld = (value, ownerId) => {
  const owner = value.nodes.find(node => node.id === ownerId), matrix = getGarageNodeMatrix(value, ownerId);
  return owner.occlusion.points.map(point => transformGaragePoint(matrix, { x: point.x * owner.width, y: point.y * owner.height }));
};
const closePoints = (actual, expected) => actual.forEach((point, index) => {
  assert.ok(Math.abs(point.x - expected[index].x) < 1e-8);
  assert.ok(Math.abs(point.y - expected[index].y) < 1e-8);
});

test("legacy scene omits optional occlusions and a default mask has no implicit targets", () => {
  assert.deepEqual(validateGarageScene(base), base);
  const first = defaultGarageOcclusion(), second = defaultGarageOcclusion();
  first.points[0].x = .3; first.targetIds.push("tank");
  assert.equal(second.points[0].x, 0);
  assert.deepEqual(second.targetIds, []);
  assert.equal(garageOcclusionPolygonProblem(second.points), null);
  assert.deepEqual(garageOccludersForNode(scene([hull(), node("tank")]), "tank"), []);
});

test("occlusion configuration round trips as an owned copy without changing its raster", () => {
  const value = scene(), before = JSON.stringify(value), parsed = validateGarageScene(JSON.parse(before));
  assert.deepEqual(parsed, value);
  assert.equal(parsed.assets[0].src, value.assets[0].src);
  assert.equal(parsed.nodes[0].assetId, value.nodes[0].assetId);
  parsed.nodes[0].occlusion.points[0].x = .2;
  parsed.nodes[0].occlusion.targetIds.push("hull-copy");
  assert.equal(JSON.stringify(value), before);
});

test("only selected target and its descendants are clipped, independently of z order", () => {
  const value = scene([hull({ ...defaultGarageOcclusion(), targetIds: ["cargo"] }, { zIndex: -20 }),
    node("cargo"), node("tank", { parentId: "cargo" }), node("cap", { parentId: "tank" }), node("motor", { zIndex: 500 })]);
  assert.deepEqual(ids(garageOccludersForNode(value, "cargo")), ["hull"]);
  assert.deepEqual(ids(garageOccludersForNode(value, "tank")), ["hull"]);
  assert.deepEqual(ids(garageOccludersForNode(value, "cap")), ["hull"]);
  assert.deepEqual(garageOccludersForNode(value, "motor"), []);
  assert.deepEqual(garageOccludersForNode(value, "hull"), []);
  assert.deepEqual(garageOccludersForNode(value, "missing"), []);
});

test("disabled or hidden owner, including hidden parent, does not erase target artwork", () => {
  const baseline = [node("boat"), hull({ ...defaultGarageOcclusion(), targetIds: ["tank"] }, { parentId: "boat" }), node("tank")];
  assert.deepEqual(ids(garageOccludersForNode(scene(baseline), "tank")), ["hull"]);
  for (const mutate of [nodes => { nodes[1].occlusion.enabled = false; }, nodes => { nodes[1].visible = false; }, nodes => { nodes[0].visible = false; }]) {
    const nodes = structuredClone(baseline); mutate(nodes);
    assert.deepEqual(garageOccludersForNode(scene(nodes), "tank"), []);
  }
});

test("multiple masks can cover one target without recursive owner evaluation", () => {
  const first = hull({ ...defaultGarageOcclusion(), targetIds: ["tank", "other-hull"] });
  const second = { ...hull({ ...defaultGarageOcclusion(), targetIds: ["tank", "hull"] }), id: "other-hull" };
  const value = scene([first, second, node("tank")]);
  assert.deepEqual(ids(garageOccludersForNode(value, "tank")), ["hull", "other-hull"]);
});

test("owner and owner ancestors are excluded while independent groups and owner children remain targets", () => {
  const value = scene([node("boat"), hull(defaultGarageOcclusion(), { parentId: "boat" }),
    node("tank", { parentId: "hull" }), node("other-group")]);
  assert.deepEqual(garageOcclusionTargetIds(value, "hull"), ["tank", "other-group"]);
  assert.deepEqual(garageOcclusionTargetIds(value, "missing"), []);
  for (const target of ["hull", "boat", "missing"]) {
    const invalid = structuredClone(value); invalid.nodes[1].occlusion.targetIds = [target];
    assert.throws(() => validateGarageScene(invalid), /свой слой|неизвестный предмет/);
  }
});

test("imports reject group owners, duplicate targets, invalid flags and unbounded target lists", () => {
  const noRaster = raw(defaultGarageOcclusion()); noRaster.nodes[0].assetId = null;
  assert.throws(() => validateGarageScene(noRaster), /только слою с изображением/);
  for (const targetIds of [["tank", "tank"], [""], [42], Array.from({length:129}, (_, index) => `node-${index}`)])
    assert.throws(() => validateGarageScene(raw({ ...defaultGarageOcclusion(), targetIds })));
  for (const enabled of [undefined, 1, "true", null])
    assert.throws(() => validateGarageScene(raw({ ...defaultGarageOcclusion(), enabled })), /логическое/);
});

test("concave polygons, reversed winding and a point inserted on a straight edge are supported", () => {
  const concave = [{x:0,y:.4},{x:.5,y:.6},{x:1,y:.4},{x:1,y:1},{x:0,y:1}];
  const straight = [{x:0,y:.5},{x:.5,y:.5},{x:1,y:.5},{x:1,y:1},{x:0,y:1}];
  for (const points of [concave, [...concave].reverse(), straight]) {
    assert.equal(garageOcclusionPolygonProblem(points), null);
    assert.deepEqual(validateGarageScene(raw({ ...defaultGarageOcclusion(), points })).nodes[0].occlusion.points, points);
  }
});

test("malformed, collapsed, crossing and touching contours are rejected before SVG rendering", () => {
  const bad = [null, [], [{x:0,y:0},{x:1,y:1}],
    [{x:0,y:0},{x:1,y:1},{x:0,y:1},{x:1,y:0}],
    [{x:0,y:0},{x:1,y:0},{x:.5,y:0},{x:.5,y:1}],
    [{x:0,y:0},{x:.5,y:.5},{x:1,y:0},{x:.5,y:.5},{x:1,y:1},{x:0,y:1}],
    [{x:0,y:0},{x:1,y:0},{x:1,y:0},{x:0,y:1}],
    [{x:0,y:0},{x:1,y:0},{x:.5,y:0}],
    [{x:0,y:0},{x:1,y:0},{x:.5,y:1e-12}],
    [{x:0,y:0},{x:1.01,y:0},{x:0,y:1}],
    [{x:0,y:0},{x:1,y:NaN},{x:0,y:1}],
    [{x:0,y:0},{x:1,y:0},{x:0,y:Infinity}],
    [{x:0,y:0},{x:"1",y:0},{x:0,y:1}],
    Array.from({length:65}, (_, i) => ({x:.5+.4*Math.cos(i*Math.PI*2/65),y:.5+.4*Math.sin(i*Math.PI*2/65)}))];
  for (const points of bad) {
    assert.equal(typeof garageOcclusionPolygonProblem(points), "string");
    assert.throws(() => validateGarageScene(raw({ ...defaultGarageOcclusion(), points })));
  }
});

test("deleting a target group cleans mask references and retains the authored contour", () => {
  const value = scene([hull({ ...defaultGarageOcclusion(), targetIds: ["cargo", "tank", "motor"] }),
    node("cargo"), node("tank", { parentId: "cargo" }), node("motor")]);
  const removed = removeGarageNode(value, "cargo");
  assert.deepEqual(removed.nodes.map(node => node.id), ["hull", "motor"]);
  assert.deepEqual(removed.nodes[0].occlusion.targetIds, ["motor"]);
  assert.deepEqual(removed.nodes[0].occlusion.points, value.nodes[0].occlusion.points);
  assert.deepEqual(value.nodes[0].occlusion.targetIds, ["cargo", "tank", "motor"]);
  assert.deepEqual(validateGarageScene(removed), removed);
  const empty = removeGarageNode(removed, "motor");
  assert.deepEqual(empty.nodes[0].occlusion.targetIds, []);
  assert.equal(empty.nodes[0].occlusion.enabled, true);
});

test("duplicating an owner deep copies points and targets and does not retarget existing masks", () => {
  const value = scene(), duplicated = duplicateGarageNode(value, "hull"), copy = duplicated.nodes.at(-1);
  assert.deepEqual(copy.occlusion, value.nodes[0].occlusion);
  copy.occlusion.points[0].y = .2; copy.occlusion.targetIds.push("hull");
  assert.equal(value.nodes[0].occlusion.points[0].y, .58);
  assert.deepEqual(value.nodes[0].occlusion.targetIds, ["tank"]);
  const copiedTank = duplicateGarageNode(value, "tank");
  assert.deepEqual(garageOccludersForNode(copiedTank, "tank-copy"), []);
});

test("normalized contours follow affine hull transforms, pivots and world-preserving reparenting", () => {
  const value = scene([node("group", { x:500,y:300,scale:1.4,scaleX:.8,scaleY:1.2,flipX:true,skewX:12,rotation:30 }),
    hull({ ...defaultGarageOcclusion(), targetIds:["tank"] }, {x:200,y:100,scale:.6,scaleX:1.3,scaleY:.7,rotation:-18,pivotX:.2,pivotY:.8}), node("tank")]);
  const before = pointsInWorld(value,"hull");
  const attached = reparentGarageNode(value,"hull","group");
  closePoints(pointsInWorld(attached,"hull"),before);
  const pivoted = moveGaragePivot(attached,"hull",{x:.9,y:.1});
  closePoints(pointsInWorld(pivoted,"hull"),before);
  assert.deepEqual(pivoted.nodes[1].occlusion,value.nodes[1].occlusion);
  const moved = {...attached,nodes:attached.nodes.map(node => node.id === "group" ? {...node,x:node.x+17,y:node.y-9} : node)};
  closePoints(pointsInWorld(moved,"hull"),before.map(point => ({x:point.x+17,y:point.y-9})));
});

test("reparenting an owner into a selected target cannot make its own mask recursive", () => {
  const value = scene([hull({ ...defaultGarageOcclusion(), targetIds:["group"] }),node("group")]);
  assert.throws(() => reparentGarageNode(value,"hull","group"), /свой слой|родительскую группу/);
});

test("the real local file API saves occlusions, reloads them and rejects invalid replacement contours", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "garage-occlusion-"));
  t.after(() => rm(root, { recursive:true, force:true }));
  const fallback = path.join(root,"features/world/dev/boat-garage");
  await mkdir(fallback,{recursive:true});
  await writeFile(path.join(fallback,"garage-scene-default.json"),JSON.stringify(base));
  const files = createGarageProjectFiles({root}), initial = await files.read();
  const request = (value, revision) => new Request("http://localhost:3002/api/dev/boat-garage", {
    method:"POST",headers:{host:"localhost:3002",origin:"http://localhost:3002","content-type":"application/json"},
    body:JSON.stringify({scene:value,expectedRevision:revision}),
  });
  const value = scene(), savedResponse = await files.handle(request(value,initial.revision),"development");
  assert.equal(savedResponse.status,200);
  const saved = await savedResponse.json();
  assert.deepEqual(saved.scene,value);
  assert.deepEqual(await createGarageProjectFiles({root}).read(),saved);
  const invalid = structuredClone(value);invalid.nodes[0].occlusion.points = [{x:0,y:0},{x:1,y:1},{x:0,y:1},{x:1,y:0}];
  const rejected = await files.handle(request(invalid,saved.revision),"development");
  assert.equal(rejected.status,400);
  assert.deepEqual(await files.read(),saved);
  assert.deepEqual(JSON.parse(await readFile(path.join(root,"art/world/boat-garage/scene.json"),"utf8")),value);
});
