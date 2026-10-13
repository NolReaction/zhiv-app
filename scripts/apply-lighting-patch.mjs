import path from "node:path";
import { randomUUID } from "node:crypto";
import { open, rename, rm, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { compileTiledWorld } from "./lib/tiled-world.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const defaultMap = path.join(root, "world/tiled/forest.tmj");
const defaultPublicDir = path.join(root, "public");
const PATCH_LIMIT = 2 * 1024 * 1024;
const MAP_LIMIT = 32 * 1024 * 1024;
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const fail = (at, message) => { throw new Error(`${at}: ${message}`); };
const assert = (condition, at, message) => { if (!condition) fail(at, message); };

function object(value, at, required, optional = []) {
  assert(value !== null && typeof value === "object" && !Array.isArray(value), at, "expected an object");
  for (const key of required) assert(own(value, key), at, `missing ${key}`);
  for (const key of Object.keys(value)) assert(required.includes(key) || optional.includes(key), at, `unknown field ${key}`);
  return value;
}

function identifier(value, at) {
  assert(typeof value === "string" && value.length <= 128 && /^[a-z][a-z0-9_-]*$/.test(value), at,
    "expected a lowercase identifier of at most 128 characters");
  return value;
}

function number(value, at, minimum, maximum) {
  assert(typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum, at,
    `expected a finite number between ${minimum} and ${maximum}`);
  return value;
}

function canonicalCaster(value, at, world) {
  object(value, at, ["id", "points", "height", "baseHeight", "opacity", "softness"], ["when"]);
  const id = identifier(value.id, `${at}.id`);
  assert(Array.isArray(value.points) && value.points.length >= 3 && value.points.length <= 64, `${at}.points`,
    "expected 3 to 64 vertices");
  const points = value.points.map((point, index) => {
    const where = `${at}.points[${index}]`;
    object(point, where, ["x", "y"]);
    return { x: number(point.x, `${where}.x`, 0, world.width), y: number(point.y, `${where}.y`, 0, world.height) };
  });
  const height = number(value.height, `${at}.height`, Number.MIN_VALUE, 300);
  const baseHeight = number(value.baseHeight, `${at}.baseHeight`, 0, 400 - height);
  const opacity = number(value.opacity, `${at}.opacity`, 0, 1);
  const softness = number(value.softness, `${at}.softness`, 0, 12);
  let when;
  if (own(value, "when")) {
    object(value.when, `${at}.when`, ["siteId", "level"]);
    const level = number(value.when.level, `${at}.when.level`, 0, Number.MAX_SAFE_INTEGER);
    assert(Number.isSafeInteger(level), `${at}.when.level`, "expected a safe integer");
    when = { siteId: identifier(value.when.siteId, `${at}.when.siteId`), level };
  }
  return { id, points, height, baseHeight, opacity, softness, ...(when ? { when } : {}) };
}

function validatePatch(patch, world) {
  object(patch, "patch", ["schemaVersion", "sceneId", "casters"]);
  assert(patch.schemaVersion === 1, "patch.schemaVersion", "expected 1");
  identifier(patch.sceneId, "patch.sceneId");
  assert(patch.sceneId === world.id, "patch.sceneId", `expected current scene ${world.id}`);
  assert(Array.isArray(patch.casters) && patch.casters.length <= 128, "patch.casters", "expected an array of at most 128 edits");
  const seen = new Set();
  const current = new Map((world.shadowCasters ?? []).map(caster => [caster.id, caster]));
  return patch.casters.map((edit, index) => {
    const at = `patch.casters[${index}]`;
    object(edit, at, ["id", "before", "after"]);
    identifier(edit.id, `${at}.id`);
    assert(!seen.has(edit.id), at, `duplicate caster ${edit.id}`);
    seen.add(edit.id);
    const before = canonicalCaster(edit.before, `${at}.before`, world);
    const after = canonicalCaster(edit.after, `${at}.after`, world);
    assert(before.id === edit.id && after.id === edit.id, at, "caster id cannot change");
    assert(isDeepStrictEqual(before.when, after.when), at, "caster siteId/level condition cannot change");
    const live = current.get(edit.id);
    assert(live, at, `unknown caster ${edit.id}`);
    assert(isDeepStrictEqual(before, canonicalCaster(live, `current caster ${edit.id}`, world)), at,
      `stale caster ${edit.id}; export the current map and rebase the DEV edits before applying`);
    return { id: edit.id, before, after };
  });
}

// Mirror the compiler's inherited metadata meaning and cumulative folder offsets.
// Only ShadowCasters inside the independent Lighting folder can be updated.
function casterObjects(layers, offset = { x: 0, y: 0 }, inLighting = false, inCasters = false, result = new Map()) {
  for (const layer of layers) {
    const shift = { x: offset.x + (layer.offsetx ?? 0), y: offset.y + (layer.offsety ?? 0) };
    const lighting = inLighting || layer.name === "Lighting";
    const casters = inCasters || layer.name === "ShadowCasters";
    if (layer.type === "group") casterObjects(layer.layers, shift, lighting, casters, result);
    else if (lighting && casters) for (const value of layer.objects) result.set(value.name, { object: value, offset: shift });
  }
  return result;
}

function updateObject(target, before, after) {
  const object = target.object;
  if (!isDeepStrictEqual(before.points, after.points)) {
    const angle = ((object.rotation ?? 0) % 360) * Math.PI / 180;
    const snap = value => Math.abs(value) < 1e-12 ? 0 : value;
    const cos = snap(Math.cos(angle)), sin = snap(Math.sin(angle));
    const origin = { x: object.x + target.offset.x, y: object.y + target.offset.y };
    object.polygon = after.points.map(point => {
      const dx = point.x - origin.x, dy = point.y - origin.y;
      return { x: dx * cos + dy * sin, y: -dx * sin + dy * cos };
    });
  }
  for (const name of ["height", "baseHeight", "opacity", "softness"]) {
    if (before[name] === after[name]) continue;
    const property = object.properties?.find(value => value.name === name);
    if (property) {
      property.value = after[name];
      // Tiled int properties must become float when a slider supplies decimals.
      if (property.type === "int" && !Number.isInteger(after[name])) property.type = "float";
    } else {
      object.properties ??= [];
      object.properties.push({ name, type: "float", value: after[name] });
    }
  }
}

async function boundedText(file, limit, label) {
  const handle = await open(file, "r");
  try {
    const info = await handle.stat();
    assert(info.isFile() && info.size <= limit, label, `expected a regular file no larger than ${limit} bytes`);
    const chunks = [];
    let total = 0;
    for (;;) {
      const buffer = Buffer.alloc(Math.min(64 * 1024, limit + 1 - total));
      const { bytesRead } = await handle.read(buffer);
      if (!bytesRead) break;
      total += bytesRead;
      assert(total <= limit, label, `file exceeds ${limit} bytes`);
      chunks.push(buffer.subarray(0, bytesRead));
    }
    return { source: Buffer.concat(chunks).toString("utf8"), mode: info.mode };
  } finally {
    await handle.close();
  }
}

function parseJson(source, label) {
  try { return JSON.parse(source); }
  catch (error) { throw new Error(`${label}: invalid JSON (${error.message})`); }
}

function sameCasterGeometry(actual, expected) {
  return actual.id === expected.id && actual.height === expected.height && actual.baseHeight === expected.baseHeight
    && actual.opacity === expected.opacity && actual.softness === expected.softness && isDeepStrictEqual(actual.when, expected.when)
    && actual.points.length === expected.points.length && actual.points.every((point, index) =>
      Math.abs(point.x - expected.points[index].x) <= 1e-9 && Math.abs(point.y - expected.points[index].y) <= 1e-9);
}

/** Validate all edits and the complete map before atomically replacing only its source. */
export async function applyLightingPatch({ patchPath, mapPath = defaultMap, publicDir = defaultPublicDir, check = false }) {
  const mapFile = path.resolve(mapPath);
  assert(path.extname(mapFile).toLowerCase() === ".tmj", "map", "expected a .tmj Tiled map");
  const { source: patchSource } = await boundedText(path.resolve(patchPath), PATCH_LIMIT, "patch");
  const patch = parseJson(patchSource, "patch");
  // Reject an obviously malformed patch before reading or decoding scene assets.
  object(patch, "patch", ["schemaVersion", "sceneId", "casters"]);
  const { source, mode } = await boundedText(mapFile, MAP_LIMIT, "map");
  const map = parseJson(source, "map");
  const context = { mapPath: mapFile, publicDir: path.resolve(publicDir) };
  const world = await compileTiledWorld(map, context);
  const edits = validatePatch(patch, world);
  const changed = edits.filter(edit => !isDeepStrictEqual(edit.before, edit.after));
  const targets = casterObjects(map.layers);
  for (const edit of edits) assert(targets.has(edit.id), `caster ${edit.id}`, "source object must be inside Lighting/ShadowCasters");
  for (const edit of changed) updateObject(targets.get(edit.id), edit.before, edit.after);
  if (changed.length) {
    // This includes polygon intersections, duplicate vertices, authoring bounds,
    // site conditions and every unrelated layer's ordinary compiler validation.
    const result = await compileTiledWorld(map, context);
    for (const edit of changed) assert(sameCasterGeometry(result.shadowCasters.find(caster => caster.id === edit.id), edit.after),
      `caster ${edit.id}`, "world-to-Tiled geometry roundtrip failed");
  }
  const assertSourceCurrent = async () => {
    if ((await boundedText(mapFile, MAP_LIMIT, "map")).source !== source) {
      throw new Error("Tiled map changed while applying the patch; no edits were written. Save Tiled and retry.");
    }
  };
  await assertSourceCurrent();
  if (!check && changed.length) {
    const temporary = path.join(path.dirname(mapFile), `.${path.basename(mapFile)}.${process.pid}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, `${JSON.stringify(map, null, 2)}\n`, { flag: "wx", mode });
      await assertSourceCurrent();
      await rename(temporary, mapFile);
    } finally {
      await rm(temporary, { force: true });
    }
  }
  return { changed: changed.length, unchanged: edits.length - changed.length, checked: check, mapPath: mapFile };
}

const usage = "Usage: npm run world:lighting:apply -- <lighting-patch.json> [--map world/tiled/forest.tmj] [--check]";

async function main(args) {
  if (args.length === 1 && args[0] === "--help") {
    console.log(`${usage}\n--check validates all edits without writing. Tiled must be saved before applying.`);
    return;
  }
  let patchPath, mapPath, check = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--check" && !check) check = true;
    else if (arg === "--map" && !mapPath && args[index + 1] && !args[index + 1].startsWith("-")) mapPath = args[++index];
    else if (!arg.startsWith("-") && !patchPath) patchPath = arg;
    else throw new Error(usage);
  }
  if (!patchPath) throw new Error(usage);
  const result = await applyLightingPatch({ patchPath, ...(mapPath ? { mapPath } : {}), check });
  console.log(`${check ? "Validated" : "Applied"} ${result.changed} lighting edit(s); ${result.unchanged} unchanged. ${path.relative(process.cwd(), result.mapPath)}`);
  if (check) console.log("Check only; no files were written.");
  else if (result.changed) console.log("Tiled source updated. Run npm run world:export, then npm run world:check. Reload the map in Tiled before saving it again.");
  else console.log("No files were written.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => {
    console.error(`Lighting patch failed: ${error.message}`);
    process.exitCode = 1;
  });
}
