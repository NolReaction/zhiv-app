import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { open, rename, rm, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { compileTiledWorld } from "./lib/tiled-world.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
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

function canonicalShadow(value, at, world, caster) {
  object(value, at, ["id", "points", "height", ...(caster ? ["baseHeight", "opacity", "softness"] : [])], ["when"]);
  const id = identifier(value.id, `${at}.id`);
  assert(Array.isArray(value.points) && value.points.length >= 3 && value.points.length <= 64, `${at}.points`,
    "expected 3 to 64 vertices");
  const points = value.points.map((point, index) => {
    const where = `${at}.points[${index}]`;
    object(point, where, ["x", "y"]);
    return { x: number(point.x, `${where}.x`, 0, world.width), y: number(point.y, `${where}.y`, 0, world.height) };
  });
  const height = number(value.height, `${at}.height`, caster ? Number.MIN_VALUE : 0, 300);
  let when;
  if (own(value, "when")) {
    object(value.when, `${at}.when`, ["siteId", "level"]);
    const level = number(value.when.level, `${at}.when.level`, 0, Number.MAX_SAFE_INTEGER);
    assert(Number.isSafeInteger(level), `${at}.when.level`, "expected a safe integer");
    when = { siteId: identifier(value.when.siteId, `${at}.when.siteId`), level };
  }
  const common = { id, points, height, ...(when ? { when } : {}) };
  if (!caster) return common;
  const baseHeight = number(value.baseHeight, `${at}.baseHeight`, 0, 400 - height);
  const opacity = number(value.opacity, `${at}.opacity`, 0, 1);
  const softness = number(value.softness, `${at}.softness`, 0, 12);
  return { ...common, baseHeight, opacity, softness };
}

function lightIdentifier(value, at) {
  assert(typeof value === "string" && value.trim().length > 0 && value.length <= 128
    && !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(value), at,
  "expected a non-empty light name of at most 128 characters without control characters");
  return value;
}

function canonicalLight(value, at, world) {
  object(value, at, ["id", "position", "kind", "radius", "intensity", "color", "flicker"], ["height", "enabled", "manualPosition"]);
  const id = lightIdentifier(value.id, `${at}.id`);
  object(value.position, `${at}.position`, ["x", "y"]);
  const position = { x: number(value.position.x, `${at}.position.x`, 0, world.width),
    y: number(value.position.y, `${at}.position.y`, 0, world.height) };
  assert(["lantern", "torch", "glow"].includes(value.kind), `${at}.kind`, "expected lantern, torch or glow");
  const radius = number(value.radius, `${at}.radius`, Number.MIN_VALUE, 500);
  const intensity = number(value.intensity, `${at}.intensity`, 0, 2);
  const flicker = number(value.flicker, `${at}.flicker`, 0, 1);
  assert(typeof value.color === "string" && /^#[0-9a-f]{6}$/i.test(value.color), `${at}.color`, "expected opaque #RRGGBB");
  const optional = {};
  if (own(value, "height")) optional.height = number(value.height, `${at}.height`, 1, 200);
  for (const key of ["enabled", "manualPosition"]) if (own(value, key)) {
    assert(typeof value[key] === "boolean", `${at}.${key}`, "expected a boolean");
    optional[key] = value[key];
  }
  return { id, position, kind: value.kind, radius, intensity, color: value.color.toLowerCase(), flicker, ...optional };
}

function patchShape(patch) {
  object(patch, "patch", ["schemaVersion", "sceneId", "casters"], ["lights", "receivers"]);
  assert([1, 2, 3].includes(patch.schemaVersion), "patch.schemaVersion", "expected 1, 2 or 3");
  if (patch.schemaVersion === 1) assert(!own(patch, "lights"), "patch.lights", "light edits require schemaVersion 2");
  else assert(own(patch, "lights"), "patch.lights", `schemaVersion ${patch.schemaVersion} requires lights`);
  if (patch.schemaVersion === 3) assert(own(patch, "receivers"), "patch.receivers", "schemaVersion 3 requires receivers");
  else assert(!own(patch, "receivers"), "patch.receivers", "receiver edits require schemaVersion 3");
}

/** Canonical, immutable-baseline validation shared by CLI and local Studio save. */
export function validateLightingPatch(patch, world, { allowAlreadyApplied = true } = {}) {
  patchShape(patch);
  identifier(patch.sceneId, "patch.sceneId");
  assert(patch.sceneId === world.id, "patch.sceneId", `expected current scene ${world.id}`);
  const originalIds = new Set([...(world.shadowCasters ?? []), ...(world.shadowReceivers ?? []), ...(world.lights ?? [])].map(value => value.id));
  const createdIds = new Set();
  const section = (entries, name, kind, currentValues, limit, canonical, idValidator, equal) => {
    assert(Array.isArray(entries) && entries.length <= limit, `patch.${name}`, `expected an array of at most ${limit} edits`);
    const seen = new Set(), current = new Map(currentValues.map(value => [value.id, value]));
    const result = entries.map((edit, index) => {
      const at = `patch.${name}[${index}]`;
      object(edit, at, ["id", "before", "after"]);
      idValidator(edit.id, `${at}.id`);
      assert(!seen.has(edit.id), at, `duplicate ${kind} ${edit.id}`);
      seen.add(edit.id);
      assert(edit.before !== null || edit.after !== null, at, "before and after cannot both be null");
      if (name === "casters" && patch.schemaVersion !== 3) {
        assert(edit.before !== null && edit.after !== null, at, "caster creation and deletion require schemaVersion 3");
      }
      const before = edit.before === null ? null : canonical(edit.before, `${at}.before`, world);
      const after = edit.after === null ? null : canonical(edit.after, `${at}.after`, world);
      assert((before === null || before.id === edit.id) && (after === null || after.id === edit.id), at, `${kind} id cannot change`);
      if (name !== "lights" && before && after) {
        assert(isDeepStrictEqual(before.when, after.when), at, `${kind} siteId/level condition cannot change`);
      }
      const liveValue = current.get(edit.id), live = liveValue ? canonical(liveValue, `current ${kind} ${edit.id}`, world) : null;
      const applied = allowAlreadyApplied && equal(live, after);
      if (before === null && !applied) assert(!live, at, `${kind} ${edit.id} already exists; creation baseline must be empty`);
      if (before !== null && !applied) {
        assert(live, at, name === "lights" ? `unknown authored light ${edit.id}; automatic lights are not Tiled sources` : `unknown ${kind} ${edit.id}`);
        assert(equal(live, before), at, `stale ${kind} ${edit.id}; export the current map and rebase the DEV edits before applying`);
      }
      if (before === null && !applied) {
        assert(!originalIds.has(edit.id) && !createdIds.has(edit.id), at, `new element id ${edit.id} is already used by another lighting element`);
        createdIds.add(edit.id);
      }
      return { id: edit.id, before, after, applied };
    });
    const pending = result.filter(edit => !edit.applied);
    const total = current.size + pending.filter(edit => edit.before === null).length - pending.filter(edit => edit.after === null).length;
    assert(total <= limit, `patch.${name}`, `at most ${limit} ${name === "lights" ? "authored lights" : name} are supported after applying edits`);
    return result;
  };
  const shadow = caster => (value, at, world) => canonicalShadow(value, at, world, caster);
  return {
    casters: section(patch.casters, "casters", "caster", world.shadowCasters ?? [], 128, shadow(true), identifier, sameShadowGeometry),
    receivers: section(patch.schemaVersion === 3 ? patch.receivers : [], "receivers", "receiver", world.shadowReceivers ?? [], 32, shadow(false), identifier, sameShadowGeometry),
    lights: section(patch.schemaVersion >= 2 ? patch.lights : [], "lights", "light", world.lights ?? [], 128, canonicalLight, lightIdentifier, isDeepStrictEqual),
  };
}

// Mirror the compiler's inherited metadata meaning and cumulative folder offsets.
// Only ShadowCasters inside the independent Lighting folder can be updated.
function shadowObjects(layers, kind, offset = { x: 0, y: 0 }, inLighting = false, inKind = false,
  result = { objects: new Map(), leaves: [], groups: [], lightingGroups: [] }) {
  for (const layer of layers) {
    const shift = { x: offset.x + (layer.offsetx ?? 0), y: offset.y + (layer.offsety ?? 0) };
    const lighting = inLighting || layer.name === "Lighting";
    const shadow = inKind || layer.name === kind;
    if (layer.type === "group") {
      if (layer.name === "Lighting") result.lightingGroups.push({ layer, offset: shift });
      if (lighting && shadow) result.groups.push({ layer, offset: shift });
      shadowObjects(layer.layers, kind, shift, lighting, shadow, result);
    } else if (lighting && shadow) {
      result.leaves.push({ layer, offset: shift });
      for (const value of layer.objects) result.objects.set(value.name, { object: value, layer, offset: shift });
    }
  }
  return result;
}

// Names outside an actual Lights layer are never treated as authored lights.
function lightObjects(layers, offset = { x: 0, y: 0 }, inLights = false, result = { objects: new Map(), leaves: [], groups: [] }) {
  for (const layer of layers) {
    const shift = { x: offset.x + (layer.offsetx ?? 0), y: offset.y + (layer.offsety ?? 0) };
    const lights = inLights || layer.name === "Lights";
    if (layer.type === "group") {
      if (lights) result.groups.push({ layer, offset: shift });
      lightObjects(layer.layers, shift, lights, result);
    } else if (lights) {
      result.leaves.push({ layer, offset: shift });
      for (const value of layer.objects) result.objects.set(value.name, { object: value, layer, offset: shift });
    }
  }
  return result;
}

function allocateId(map, kind) {
  const key = kind === "object" ? "nextobjectid" : "nextlayerid";
  let maximum = 0;
  const visit = layers => {
    for (const layer of layers) {
      if (kind === "layer") maximum = Math.max(maximum, layer.id);
      if (layer.type === "group") visit(layer.layers);
      else if (kind === "object") for (const value of layer.objects) maximum = Math.max(maximum, value.id);
    }
  };
  visit(map.layers);
  const next = own(map, key) ? number(map[key], `map.${key}`, 1, Number.MAX_SAFE_INTEGER - 1) : maximum + 1;
  assert(Number.isSafeInteger(next) && Number.isSafeInteger(maximum + 1), `map.${key}`, "expected an available safe integer ID");
  const id = Math.max(next, maximum + 1);
  assert(id < Number.MAX_SAFE_INTEGER, `map.${key}`, "no safe integer IDs remain");
  map[key] = id + 1;
  return id;
}

function creationLightLayer(map, sources) {
  // Appending to the final Lights leaf preserves the compiled order of every
  // original light, matching the editor's appended new sources.
  if (sources.leaves.length) return sources.leaves.at(-1);
  const group = sources.groups[0];
  const layer = { id: allocateId(map, "layer"), name: group ? "Studio" : "Lights", type: "objectgroup", draworder: "index", objects: [] };
  if (group) group.layer.layers.push(layer);
  else map.layers.push(layer);
  const target = { layer, offset: group?.offset ?? { x: 0, y: 0 } };
  sources.leaves.push(target);
  return target;
}

function creationShadowLayer(map, sources, kind) {
  if (sources.leaves.length) return sources.leaves.at(-1);
  const group = sources.groups.at(-1);
  let lighting = sources.lightingGroups.at(-1) ?? shadowObjects(map.layers, kind).lightingGroups.at(-1);
  if (!group && !lighting) {
    const layer = { id: allocateId(map, "layer"), name: "Lighting", type: "group", layers: [] };
    map.layers.push(layer);
    lighting = { layer, offset: { x: 0, y: 0 } };
    sources.lightingGroups.push(lighting);
  }
  const layer = { id: allocateId(map, "layer"), name: group ? "Studio" : kind, type: "objectgroup", draworder: "index", objects: [] };
  const parent = group ?? lighting;
  parent.layer.layers.push(layer);
  const target = { layer, offset: parent.offset };
  sources.leaves.push(target);
  return target;
}

function lightProperty(object, name, value, type) {
  const property = object.properties?.find(value => value.name === name);
  if (value === undefined) {
    if (property) object.properties.splice(object.properties.indexOf(property), 1);
  } else if (property) {
    property.value = value;
    if (property.type === "int" && !Number.isInteger(value)) property.type = "float";
  } else {
    object.properties ??= [];
    object.properties.push({ name, type, value });
  }
}

function updateLightObject(target, before, after) {
  if (before === null || !isDeepStrictEqual(before.position, after.position)) {
    target.object.x = after.position.x - target.offset.x;
    target.object.y = after.position.y - target.offset.y;
  }
  for (const name of ["kind", "radius", "intensity", "color", "flicker", "height", "enabled", "manualPosition"]) {
    // Kind changes can change compiler defaults for absent properties. Make the
    // complete requested light authoritative without altering unchanged markers.
    const defaultChanged = before !== null && before.kind !== after.kind && ["radius", "intensity", "color", "flicker"].includes(name);
    if (before !== null && !defaultChanged && own(before, name) === own(after, name) && before[name] === after[name]) continue;
    const type = ["enabled", "manualPosition"].includes(name) ? "bool" : name === "kind" ? "string" : name === "color" ? "color" : "float";
    lightProperty(target.object, name, after[name], type);
  }
}

function updateObject(target, before, after) {
  const object = target.object;
  if (before === null || !isDeepStrictEqual(before.points, after.points)) {
    const angle = ((object.rotation ?? 0) % 360) * Math.PI / 180;
    const snap = value => Math.abs(value) < 1e-12 ? 0 : value;
    const cos = snap(Math.cos(angle)), sin = snap(Math.sin(angle));
    const origin = { x: object.x + target.offset.x, y: object.y + target.offset.y };
    object.polygon = after.points.map(point => {
      const dx = point.x - origin.x, dy = point.y - origin.y;
      return { x: dx * cos + dy * sin, y: -dx * sin + dy * cos };
    });
  }
  for (const name of ["height", "baseHeight", "opacity", "softness"].filter(name => own(after, name))) {
    if (before !== null && before[name] === after[name]) continue;
    lightProperty(object, name, after[name], "float");
  }
  if (before === null && after.when) {
    lightProperty(object, "siteId", after.when.siteId, "string");
    lightProperty(object, "level", after.when.level, "int");
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

function sameShadowGeometry(actual, expected) {
  if (actual === null || actual === undefined || expected === null || expected === undefined) return (actual ?? null) === (expected ?? null);
  const { points: actualPoints, ...actualProperties } = actual;
  const { points: expectedPoints, ...expectedProperties } = expected;
  return isDeepStrictEqual(actualProperties, expectedProperties) && actualPoints.length === expectedPoints.length
    && actualPoints.every((point, index) => Math.abs(point.x - expectedPoints[index].x) <= 1e-9
      && Math.abs(point.y - expectedPoints[index].y) <= 1e-9);
}

/** Revision of exact source bytes, including external Tiled changes unrelated to lighting. */
export function lightingMapRevision(source) {
  assert(typeof source === "string", "map source", "expected UTF-8 text");
  return createHash("sha256").update(source, "utf8").digest("hex");
}

/** Prepare a fully validated candidate without changing Tiled or its generated export. */
export async function prepareLightingPatch({ patch, mapSource, mapPath = defaultMap, publicDir = defaultPublicDir,
  allowAlreadyApplied = true }) {
  const mapFile = path.resolve(mapPath);
  assert(path.extname(mapFile).toLowerCase() === ".tmj", "map", "expected a .tmj Tiled map");
  // Reject an obviously malformed patch before reading or decoding scene assets.
  patchShape(patch);
  assert(Buffer.byteLength(JSON.stringify(patch), "utf8") <= PATCH_LIMIT, "patch", `expected at most ${PATCH_LIMIT} bytes`);
  assert(typeof mapSource === "string" && Buffer.byteLength(mapSource, "utf8") <= MAP_LIMIT,
    "map source", `expected UTF-8 text no larger than ${MAP_LIMIT} bytes`);
  const map = parseJson(mapSource, "map");
  const context = { mapPath: mapFile, publicDir: path.resolve(publicDir) };
  const beforeWorld = await compileTiledWorld(map, context);
  const edits = validateLightingPatch(patch, beforeWorld, { allowAlreadyApplied });
  const changedCasters = edits.casters.filter(edit => !edit.applied && !sameShadowGeometry(edit.before, edit.after));
  const changedReceivers = edits.receivers.filter(edit => !edit.applied && !sameShadowGeometry(edit.before, edit.after));
  const changedLights = edits.lights.filter(edit => !edit.applied && !isDeepStrictEqual(edit.before, edit.after));
  const changed = [...changedCasters, ...changedReceivers, ...changedLights];
  const targets = shadowObjects(map.layers, "ShadowCasters");
  const receiverTargets = shadowObjects(map.layers, "ShadowReceivers");
  const lightSources = lightObjects(map.layers);
  for (const [name, entries, sources] of [["ShadowCasters", edits.casters, targets], ["ShadowReceivers", edits.receivers, receiverTargets]]) {
    for (const edit of entries) if (edit.before !== null && !edit.applied) {
      assert(sources.objects.has(edit.id), `${name === "ShadowCasters" ? "caster" : "receiver"} ${edit.id}`, `source object must be inside Lighting/${name}`);
    }
  }
  for (const edit of edits.lights) if (edit.before !== null && !edit.applied) {
    assert(lightSources.objects.has(edit.id), `light ${edit.id}`, "source object must be inside Lights");
  }
  const applyShadows = (entries, sources, kind) => {
    for (const edit of entries) {
      if (edit.before === null) {
        const target = creationShadowLayer(map, sources, kind);
        const object = { id: allocateId(map, "object"), name: edit.id, class: kind === "ShadowCasters" ? "ShadowCaster" : "ShadowReceiver",
          x: edit.after.points[0].x - target.offset.x, y: edit.after.points[0].y - target.offset.y, width: 0, height: 0, rotation: 0 };
        target.layer.objects.push(object);
        updateObject({ ...target, object }, null, edit.after);
      } else {
        const target = sources.objects.get(edit.id);
        if (edit.after === null) target.layer.objects.splice(target.layer.objects.indexOf(target.object), 1);
        else updateObject(target, edit.before, edit.after);
      }
    }
  };
  applyShadows(changedCasters, targets, "ShadowCasters");
  applyShadows(changedReceivers, receiverTargets, "ShadowReceivers");
  for (const edit of changedLights) {
    if (edit.before === null) {
      const target = creationLightLayer(map, lightSources);
      const object = { id: allocateId(map, "object"), name: edit.id, point: true, width: 0, height: 0 };
      target.layer.objects.push(object);
      updateLightObject({ ...target, object }, null, edit.after);
    } else {
      const target = lightSources.objects.get(edit.id);
      if (edit.after === null) target.layer.objects.splice(target.layer.objects.indexOf(target.object), 1);
      else updateLightObject(target, edit.before, edit.after);
    }
  }
  let world = beforeWorld;
  if (changed.length) {
    // This includes polygon intersections, duplicate vertices, authoring bounds,
    // site conditions and every unrelated layer's ordinary compiler validation.
    world = await compileTiledWorld(map, context);
    for (const [kind, entries, values] of [["caster", changedCasters, world.shadowCasters ?? []], ["receiver", changedReceivers, world.shadowReceivers ?? []]]) {
      for (const edit of entries) assert(sameShadowGeometry(values.find(value => value.id === edit.id), edit.after),
        `${kind} ${edit.id}`, "world-to-Tiled geometry roundtrip failed");
    }
    for (const edit of changedLights) {
      const actual = world.lights?.find(light => light.id === edit.id);
      assert(edit.after === null ? actual === undefined : actual !== undefined && isDeepStrictEqual(canonicalLight(actual, `result light ${edit.id}`, world), edit.after),
        `light ${edit.id}`, "world-to-Tiled light roundtrip failed");
    }
  }
  const sourceText = changed.length ? `${JSON.stringify(map, null, 2)}\n` : mapSource;
  return { map, world, beforeWorld, changed: changed.length,
    unchanged: edits.casters.length + edits.receivers.length + edits.lights.length - changed.length,
    sourceText, beforeRevision: lightingMapRevision(mapSource), revision: lightingMapRevision(sourceText) };
}

const pendingMaps = new Map();

/** Serialize local requests and atomically replace only a map whose exact source revision still matches. */
export async function applyLightingPatchToFile({ patch, mapPath = defaultMap, publicDir = defaultPublicDir,
  expectedRevision, check = false, allowAlreadyApplied = true }) {
  const mapFile = path.resolve(mapPath);
  const previous = pendingMaps.get(mapFile) ?? Promise.resolve();
  const work = previous.catch(() => {}).then(async () => {
    const { source, mode } = await boundedText(mapFile, MAP_LIMIT, "map");
    const beforeRevision = lightingMapRevision(source);
    if (expectedRevision !== undefined) {
      assert(typeof expectedRevision === "string" && /^[a-f0-9]{64}$/.test(expectedRevision), "expectedRevision", "expected a SHA-256 source revision");
      assert(expectedRevision === beforeRevision, "map", "Tiled map changed since Studio loaded it; no edits were written. Reload the project before saving.");
    }
    const prepared = await prepareLightingPatch({ patch, mapSource: source, mapPath: mapFile, publicDir, allowAlreadyApplied });
    const assertSourceCurrent = async () => {
      if ((await boundedText(mapFile, MAP_LIMIT, "map")).source !== source) {
        throw new Error("Tiled map changed while applying the patch; no edits were written. Save Tiled and retry.");
      }
    };
    await assertSourceCurrent();
    if (!check && prepared.changed) {
      const temporary = path.join(path.dirname(mapFile), `.${path.basename(mapFile)}.${process.pid}.${randomUUID()}.tmp`);
      try {
        await writeFile(temporary, prepared.sourceText, { flag: "wx", mode });
        await assertSourceCurrent();
        await rename(temporary, mapFile);
      } finally {
        await rm(temporary, { force: true });
      }
    }
    return { ...prepared, revision: check ? beforeRevision : prepared.revision, checked: check, mapPath: mapFile };
  });
  pendingMaps.set(mapFile, work);
  try { return await work; }
  finally { if (pendingMaps.get(mapFile) === work) pendingMaps.delete(mapFile); }
}

/** File-based CLI compatibility: legacy v1/v2 keep strict baselines, v3 retries are idempotent. */
export async function applyLightingPatch({ patchPath, mapPath = defaultMap, publicDir = defaultPublicDir, check = false,
  expectedRevision, allowAlreadyApplied }) {
  const { source: patchSource } = await boundedText(path.resolve(patchPath), PATCH_LIMIT, "patch");
  const patch = parseJson(patchSource, "patch");
  patchShape(patch);
  return applyLightingPatchToFile({ patch, mapPath, publicDir, check, expectedRevision,
    allowAlreadyApplied: allowAlreadyApplied ?? patch.schemaVersion === 3 });
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
