import path from "node:path";
import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import sharp from "sharp";

const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const fail = (at, message) => { throw new Error(`${at}: ${message}`); };
const requireThat = (condition, at, message) => { if (!condition) fail(at, message); };
const record = (value, at) => {
  requireThat(value !== null && typeof value === "object" && !Array.isArray(value), at, "expected an object");
  return value;
};
const array = (value, at) => {
  requireThat(Array.isArray(value), at, "expected an array");
  return value;
};
const number = (value, at, minimum = -Infinity) => {
  requireThat(typeof value === "number" && Number.isFinite(value) && value >= minimum, at, `expected a finite number >= ${minimum}`);
  return value === 0 ? 0 : value;
};
const integer = (value, at, minimum = 0) => {
  number(value, at, minimum);
  requireThat(Number.isSafeInteger(value), at, "expected a safe integer");
  return value;
};
const string = (value, at) => {
  requireThat(typeof value === "string" && value.trim().length > 0, at, "expected a non-empty string");
  return value;
};
const identifier = (value, at) => {
  string(value, at);
  requireThat(/^[a-z][a-z0-9_-]*$/.test(value), at, "expected a lowercase identifier (letters, digits, hyphens, underscores)");
  return value;
};
const exact = (value, expected, at) => requireThat(value === expected, at, `expected ${JSON.stringify(expected)}, received ${JSON.stringify(value)}`);
const absent = (object, keys, at) => {
  for (const key of keys) requireThat(!own(object, key), `${at}.${key}`, "not supported by the fixed-world compiler");
};
const defaultValue = (object, key, expected, at) => {
  if (own(object, key)) exact(object[key], expected, `${at}.${key}`);
};

function properties(object, at, allowed) {
  const result = Object.create(null);
  for (const [index, value] of array(object.properties ?? [], `${at}.properties`).entries()) {
    const where = `${at}.properties[${index}]`;
    record(value, where);
    const name = string(value.name, `${where}.name`);
    requireThat(own(allowed, name), where, `unknown property ${JSON.stringify(name)}`);
    requireThat(!own(result, name), where, `duplicate property ${JSON.stringify(name)}`);
    exact(value.type ?? "string", allowed[name], `${where}.type`);
    if (allowed[name] === "int") integer(value.value, `${where}.value`);
    else string(value.value, `${where}.value`);
    result[name] = value.value;
  }
  return result;
}

function transforms(object, at) {
  for (const key of ["x", "y", "offsetx", "offsety", "parallaxoriginx", "parallaxoriginy"]) defaultValue(object, key, 0, at);
  for (const key of ["opacity", "parallaxx", "parallaxy"]) defaultValue(object, key, 1, at);
  defaultValue(object, "visible", true, at);
  absent(object, ["tintcolor", "mode", "blendmode", "transparentcolor"], at);
}

function confined(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

async function imageReference(tile, at, context) {
  const reference = string(tile.image, `${at}.image`);
  requireThat(!path.isAbsolute(reference) && !/[:\\?#\u0000]/.test(reference), `${at}.image`, "expected a plain file-relative image path");
  const imagePath = path.resolve(path.dirname(context.mapPath), reference);
  requireThat(confined(context.publicDir, imagePath), `${at}.image`, "image must stay inside public/");
  let resolved;
  try { resolved = await realpath(imagePath); }
  catch { fail(`${at}.image`, `image does not exist: ${reference}`); }
  requireThat(confined(context.realPublicDir, resolved), `${at}.image`, "image symlink must stay inside public/");
  let metadata, bytes;
  try { bytes = await readFile(resolved); metadata = await sharp(bytes).metadata(); }
  catch { fail(`${at}.image`, `cannot decode image: ${reference}`); }
  requireThat(["png", "webp", "jpeg"].includes(metadata.format), `${at}.image`, "only PNG, WebP and JPEG images are supported");
  requireThat((metadata.pages ?? 1) === 1 && (metadata.orientation ?? 1) === 1, `${at}.image`, "animated or EXIF-rotated images are not supported");
  exact(integer(tile.imagewidth, `${at}.imagewidth`, 1), metadata.width, `${at}.imagewidth`);
  exact(integer(tile.imageheight, `${at}.imageheight`, 1), metadata.height, `${at}.imageheight`);
  // Header metadata can survive a truncated image; make sure browsers get usable pixels.
  try { await sharp(bytes).raw().toBuffer(); }
  catch { fail(`${at}.image`, `cannot decode image pixels: ${reference}`); }
  const webPath = path.relative(context.publicDir, imagePath).split(path.sep).map(encodeURIComponent).join("/");
  const version = createHash("sha256").update(bytes).digest("hex").slice(0, 12);
  return { image: `/${webPath}?v=${version}`, width: metadata.width, height: metadata.height };
}

function point(object, at, world) {
  const x = number(object.x, `${at}.x`, 0), y = number(object.y, `${at}.y`, 0);
  requireThat(x <= world.width && y <= world.height, at, "point is outside world bounds");
  return { x, y };
}

function bounds(object, at, world) {
  const origin = point(object, at, world);
  const width = number(object.width, `${at}.width`, Number.EPSILON);
  const height = number(object.height, `${at}.height`, Number.EPSILON);
  requireThat(origin.x + width <= world.width && origin.y + height <= world.height, at, "rectangle is outside world bounds");
  return { ...origin, width, height };
}

const cross = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
function segmentsIntersect(a, b, c, d) {
  const epsilon = 0.000000001;
  const values = [cross(a, b, c), cross(a, b, d), cross(c, d, a), cross(c, d, b)];
  const signs = values.map(value => Math.abs(value) < epsilon ? 0 : Math.sign(value));
  if (signs[0] * signs[1] < 0 && signs[2] * signs[3] < 0) return true;
  const on = (p, q, r) => r.x >= Math.min(p.x, q.x) - epsilon && r.x <= Math.max(p.x, q.x) + epsilon && r.y >= Math.min(p.y, q.y) - epsilon && r.y <= Math.max(p.y, q.y) + epsilon;
  return (!signs[0] && on(a, b, c)) || (!signs[1] && on(a, b, d)) || (!signs[2] && on(c, d, a)) || (!signs[3] && on(c, d, b));
}

function simplePolygon(points, at) {
  const unique = new Set(points.map(p => `${p.x},${p.y}`));
  requireThat(unique.size === points.length, at, "polygon vertices must be unique (closure is implicit)");
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length], c = points[(i + 2) % points.length];
    const doublesBack = Math.abs(cross(a, b, c)) < 0.000000001 && (b.x - a.x) * (c.x - b.x) + (b.y - a.y) * (c.y - b.y) < 0;
    requireThat(!doublesBack, at, "polygon edges must not overlap");
    for (let j = i + 1; j < points.length; j++) {
      if ((i + 1) % points.length === j || (j + 1) % points.length === i) continue;
      requireThat(!segmentsIntersect(a, b, points[j], points[(j + 1) % points.length]), at, "polygon must not self-intersect or have overlapping edges");
    }
  }
}

function vertices(object, kind, at, world) {
  const points = array(object[kind], `${at}.${kind}`);
  requireThat(points.length >= (kind === "polygon" ? 3 : 2), `${at}.${kind}`, `requires at least ${kind === "polygon" ? 3 : 2} points`);
  const origin = point(object, at, world);
  const result = points.map((value, index) => {
    const where = `${at}.${kind}[${index}]`;
    record(value, where);
    return point({ x: origin.x + number(value.x, `${where}.x`), y: origin.y + number(value.y, `${where}.y`) }, where, world);
  });
  for (let index = 1; index < result.length; index++) {
    requireThat(result[index].x !== result[index - 1].x || result[index].y !== result[index - 1].y, at, "adjacent vertices must differ");
  }
  if (kind === "polygon") {
    const area = result.reduce((sum, p, index) => {
      const q = result[(index + 1) % result.length];
      return sum + p.x * q.y - q.x * p.y;
    }, 0);
    requireThat(Math.abs(area) > 0.000001, at, "polygon must enclose a nonzero area");
    simplePolygon(result, at);
  }
  return result;
}

function aspect(image, rect, at) {
  requireThat(Math.abs(image.width / image.height - rect.width / rect.height) < 0.000001, at, "object aspect ratio must match its image (resize width and height together)");
}

/** Compile the supported Tiled subset, validating every referenced asset on disk. */
export async function compileTiledWorld(map, { mapPath, publicDir }) {
  record(map, "map");
  exact(map.type, "map", "map.type");
  exact(map.orientation, "orthogonal", "map.orientation");
  defaultValue(map, "infinite", false, "map");
  exact(map.tilewidth, 1, "map.tilewidth");
  exact(map.tileheight, 1, "map.tileheight");
  defaultValue(map, "renderorder", "right-down", "map");
  transforms(map, "map");
  absent(map, ["hexsidelength", "staggeraxis", "staggerindex", "chunks"], "map");
  const mapProperties = properties(map, "map", { worldId: "string" });
  const world = {
    schemaVersion: 1,
    id: identifier(mapProperties.worldId, "map.properties.worldId"),
    width: integer(map.width, "map.width", 1),
    height: integer(map.height, "map.height", 1),
    terrain: [],
    focus: undefined,
    sites: [],
    paths: [],
  };
  const context = { mapPath: path.resolve(mapPath), publicDir: path.resolve(publicDir) };
  context.realPublicDir = await realpath(context.publicDir);
  const tiles = new Map(), catalogs = new Map();
  const tilesets = array(map.tilesets, "map.tilesets");
  requireThat(tilesets.length > 0, "map.tilesets", "requires an embedded image-collection tileset");
  let lastFirstGid = 0;
  for (const [index, tileset] of tilesets.entries()) {
    const at = `map.tilesets[${index}]`;
    record(tileset, at);
    absent(tileset, ["source", "image", "tileoffset", "transparentcolor", "wangsets", "terrains"], at);
    exact(tileset.objectalignment, "topleft", `${at}.objectalignment`);
    exact(tileset.columns, 0, `${at}.columns`);
    defaultValue(tileset, "fillmode", "stretch", at);
    defaultValue(tileset, "tilerendersize", "tile", at);
    defaultValue(tileset, "margin", 0, at);
    defaultValue(tileset, "spacing", 0, at);
    properties(tileset, at, {});
    if (tileset.transformations) {
      for (const key of ["hflip", "vflip", "rotate"]) defaultValue(tileset.transformations, key, false, `${at}.transformations`);
    }
    const firstgid = integer(tileset.firstgid, `${at}.firstgid`, 1);
    requireThat(firstgid > lastFirstGid && (index !== 0 || firstgid === 1), `${at}.firstgid`, "tilesets must start at 1 and use increasing firstgid values");
    lastFirstGid = firstgid;
    const definitions = array(tileset.tiles, `${at}.tiles`);
    exact(tileset.tilecount, definitions.length, `${at}.tilecount`);
    for (const [tileIndex, tile] of definitions.entries()) {
      const where = `${at}.tiles[${tileIndex}]`;
      record(tile, where);
      absent(tile, ["animation", "objectgroup", "terrain", "width", "height"], where);
      defaultValue(tile, "x", 0, where);
      defaultValue(tile, "y", 0, where);
      const gid = firstgid + integer(tile.id, `${where}.id`);
      requireThat(gid <= 0x0fffffff && !tiles.has(gid), `${where}.id`, "duplicate or out-of-range global tile ID");
      if (tilesets[index + 1]) requireThat(gid < tilesets[index + 1].firstgid, `${where}.id`, "tile ID overlaps the next tileset");
      const props = properties(tile, where, { role: "string", siteId: "string", level: "int", label: "string" });
      requireThat(["terrain", "siteState"].includes(props.role), `${where}.properties.role`, "expected terrain or siteState");
      const image = await imageReference(tile, where, context);
      tiles.set(gid, { ...image, ...props });
      if (props.role === "siteState") {
        const id = identifier(props.siteId, `${where}.properties.siteId`);
        const level = integer(props.level, `${where}.properties.level`);
        const label = string(props.label, `${where}.properties.label`);
        const catalog = catalogs.get(id) ?? [];
        requireThat(!catalog.some(state => state.level === level), where, `duplicate level ${level} for site ${id}`);
        catalog.push({ level, label, image: image.image, width: image.width, height: image.height });
        catalogs.set(id, catalog);
      } else requireThat(!own(props, "siteId") && !own(props, "level") && !own(props, "label"), where, "terrain tiles only accept the role property");
    }
  }

  const objects = new Set(), layers = new Set(), sites = new Map(), markers = new Map(), terrainIds = new Set(), pathIds = new Set();
  const routeOwners = [];
  let hasSite = false;
  for (const [layerIndex, layer] of array(map.layers, "map.layers").entries()) {
    const layerAt = `map.layers[${layerIndex}]`;
    record(layer, layerAt);
    exact(layer.type, "objectgroup", `${layerAt}.type`);
    exact(layer.draworder, "index", `${layerAt}.draworder`);
    transforms(layer, layerAt);
    absent(layer, ["layers", "data", "chunks", "image"], layerAt);
    properties(layer, layerAt, {});
    const layerId = integer(layer.id, `${layerAt}.id`, 1);
    requireThat(!layers.has(layerId), `${layerAt}.id`, "duplicate layer ID");
    layers.add(layerId);
    for (const [objectIndex, object] of array(layer.objects, `${layerAt}.objects`).entries()) {
      const at = `${layerAt}.objects[${objectIndex}]`;
      record(object, at);
      absent(object, ["template", "text", "ellipse", "capsule", "offsetx", "offsety"], at);
      defaultValue(object, "rotation", 0, at);
      defaultValue(object, "opacity", 1, at);
      defaultValue(object, "visible", true, at);
      const objectId = integer(object.id, `${at}.id`, 1);
      requireThat(!objects.has(objectId), `${at}.id`, "duplicate object ID");
      objects.add(objectId);
      const props = properties(object, at, { role: "string", siteId: "string", label: "string", initialLevel: "int" });
      const role = string(props.role, `${at}.properties.role`);
      const shapes = ["gid", "point", "polygon", "polyline"].filter(key => own(object, key));
      requireThat(shapes.length <= 1, at, "object must have exactly one shape");
      const shape = shapes[0] ?? "rectangle";
      if (own(object, "gid")) {
        const gid = integer(object.gid, `${at}.gid`, 1);
        requireThat(gid <= 0x0fffffff, `${at}.gid`, "tile flip/rotation bits are not supported");
        const tile = tiles.get(gid);
        requireThat(tile, `${at}.gid`, `unknown tile ID ${gid}`);
        const rect = bounds(object, at, world);
        aspect(tile, rect, at);
        if (role === "terrain") {
          exact(tile.role, "terrain", `${at}.gid role`);
          requireThat(!hasSite, at, "terrain must precede site objects in layer order");
          requireThat(Object.keys(props).length === 1, at, "terrain objects only accept the role property");
          const id = identifier(object.name, `${at}.name`);
          requireThat(!terrainIds.has(id), at, `duplicate terrain ID ${id}`);
          terrainIds.add(id);
          world.terrain.push({ id, image: tile.image, bounds: rect });
        } else {
          exact(role, "site", `${at}.properties.role`);
          exact(tile.role, "siteState", `${at}.gid role`);
          const id = identifier(props.siteId, `${at}.properties.siteId`);
          exact(tile.siteId, id, `${at}.gid siteId`);
          requireThat(!sites.has(id), at, `site ${id} has more than one preview object`);
          const catalog = catalogs.get(id).sort((a, b) => a.level - b.level);
          const initialLevel = integer(props.initialLevel, `${at}.properties.initialLevel`);
          requireThat(catalog.some(state => state.level === initialLevel), at, `initialLevel ${initialLevel} is missing from site ${id} states`);
          for (const state of catalog) aspect(state, rect, `${at} site ${id}, level ${state.level}`);
          const site = { id, label: string(props.label, `${at}.properties.label`), bounds: rect, initialLevel, states: catalog.map(({ level, label, image }) => ({ level, label, image })) };
          sites.set(id, site);
          hasSite = true;
        }
      } else if (role === "focus") {
        exact(shape, "rectangle", `${at} shape`);
        requireThat(Object.keys(props).length === 1, at, "focus only accepts the role property");
        requireThat(!world.focus, at, "only one focus rectangle is allowed");
        world.focus = bounds(object, at, world);
      } else if (role === "path") {
        exact(shape, "polyline", `${at} shape`);
        const id = identifier(object.name, `${at}.name`);
        requireThat(!pathIds.has(id), at, `duplicate path ID ${id}`);
        requireThat(Object.keys(props).every(key => ["role", "siteId"].includes(key)), at, "path only accepts role and optional siteId properties");
        pathIds.add(id);
        if (own(props, "siteId")) routeOwners.push({ id: identifier(props.siteId, `${at}.properties.siteId`), at });
        world.paths.push({ id, points: vertices(object, "polyline", at, world) });
      } else {
        requireThat(["anchor", "entry", "light", "hitArea", "collision"].includes(role), `${at}.properties.role`, `unknown marker role ${JSON.stringify(role)}`);
        requireThat(Object.keys(props).length === 2, at, "markers only accept role and siteId properties");
        const id = identifier(props.siteId, `${at}.properties.siteId`);
        const siteMarkers = markers.get(id) ?? {};
        requireThat(!own(siteMarkers, role), at, `duplicate ${role} for site ${id}`);
        if (["hitArea", "collision"].includes(role)) {
          exact(shape, "polygon", `${at} shape`);
          siteMarkers[role] = vertices(object, "polygon", at, world);
        } else {
          exact(shape, "point", `${at} shape`);
          exact(object.point, true, `${at}.point`);
          siteMarkers[role] = point(object, at, world);
        }
        markers.set(id, siteMarkers);
      }
    }
  }
  requireThat(world.terrain.length > 0, "map", "requires at least one terrain object");
  requireThat(world.focus, "map", "requires one focus rectangle");
  requireThat(sites.size > 0, "map", "requires at least one fixed site");
  for (const id of catalogs.keys()) requireThat(sites.has(id), "map", `state catalog ${id} has no placed site`);
  for (const id of markers.keys()) requireThat(sites.has(id), "map", `markers reference unknown site ${id}`);
  for (const owner of routeOwners) requireThat(sites.has(owner.id), owner.at, `path references unknown site ${owner.id}`);
  world.sites = [...sites.values()].map(site => {
    const geometry = markers.get(site.id) ?? {};
    for (const role of ["anchor", "entry", "hitArea", "collision"]) requireThat(own(geometry, role), "map", `site ${site.id} is missing ${role}`);
    return { id: site.id, label: site.label, bounds: site.bounds, anchor: geometry.anchor, entry: geometry.entry, hitArea: geometry.hitArea, collision: geometry.collision, ...(geometry.light ? { light: geometry.light } : {}), initialLevel: site.initialLevel, states: site.states };
  });
  return world;
}

export async function readTiledWorld(mapPath, publicDir) {
  let map;
  try { map = JSON.parse(await readFile(mapPath, "utf8")); }
  catch (error) { throw new Error(`Cannot read Tiled map: ${error.message}`); }
  return compileTiledWorld(map, { mapPath, publicDir });
}

export const serializeTiledWorld = world => `${JSON.stringify(world, null, 2)}\n`;
