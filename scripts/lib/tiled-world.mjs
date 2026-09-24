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
    const type = value.type ?? "string";
    if (allowed[name] === "float") requireThat(["float", "int"].includes(type), `${where}.type`, "expected float or int");
    else if (allowed[name] === "color") requireThat(["color", "string"].includes(type), `${where}.type`, "expected color or string");
    else exact(type, allowed[name], `${where}.type`);
    if (type === "int") integer(value.value, `${where}.value`);
    else if (type === "float") number(value.value, `${where}.value`);
    else string(value.value, `${where}.value`);
    result[name] = value.value;
  }
  return result;
}

function transforms(object, at) {
  for (const key of ["x", "y", "offsetx", "offsety", "parallaxoriginx", "parallaxoriginy"]) defaultValue(object, key, 0, at);
  for (const key of ["opacity", "parallaxx", "parallaxy"]) defaultValue(object, key, 1, at);
  defaultValue(object, "visible", true, at);
  defaultValue(object, "mode", "normal", at);
  absent(object, ["tintcolor", "blendmode", "transparentcolor"], at);
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
  const width = integer(metadata.width, `${at}.imagewidth`, 1);
  const height = integer(metadata.height, `${at}.imageheight`, 1);
  if (!context.refreshImageMetadata) {
    exact(integer(tile.imagewidth, `${at}.imagewidth`, 1), width, `${at}.imagewidth`);
    exact(integer(tile.imageheight, `${at}.imageheight`, 1), height, `${at}.imageheight`);
  }
  // Header metadata can survive a truncated image; make sure browsers get usable pixels.
  try { await sharp(bytes).raw().toBuffer(); }
  catch { fail(`${at}.image`, `cannot decode image pixels: ${reference}`); }
  if (context.refreshImageMetadata) {
    tile.imagewidth = width;
    tile.imageheight = height;
  }
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

function insidePolygon(p, points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[j], b = points[i];
    if (Math.abs(cross(a, b, p)) < 0.000000001
      && p.x >= Math.min(a.x, b.x) && p.x <= Math.max(a.x, b.x)
      && p.y >= Math.min(a.y, b.y) && p.y <= Math.max(a.y, b.y)) return true;
    if ((a.y > p.y) !== (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
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

function compileLight(object, shape, at, world) {
  exact(shape, "point", `${at} shape`);
  exact(object.point, true, `${at}.point`);
  defaultValue(object, "width", 0, at);
  defaultValue(object, "height", 0, at);
  const props = properties(object, at, { kind: "string", radius: "float", intensity: "float", color: "color", flicker: "float" });
  const kind = props.kind ?? "lantern";
  requireThat(["lantern", "torch", "glow"].includes(kind), `${at}.properties.kind`, "expected lantern, torch or glow");
  const defaults = {
    lantern: { color: "#ffd28a", flicker: 0.04 },
    torch: { color: "#ffb45d", flicker: 0.12 },
    glow: { color: "#8adbd0", flicker: 0 },
  }[kind];
  const radius = props.radius ?? 70, intensity = props.intensity ?? 1, flicker = props.flicker ?? defaults.flicker;
  requireThat(radius > 0 && radius <= 500, `${at}.properties.radius`, "expected a radius > 0 and <= 500 world units");
  requireThat(intensity >= 0 && intensity <= 2, `${at}.properties.intensity`, "expected intensity between 0 and 2");
  requireThat(flicker >= 0 && flicker <= 1, `${at}.properties.flicker`, "expected flicker between 0 and 1");
  const authoredColor = props.color ?? defaults.color;
  requireThat(/^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(authoredColor), `${at}.properties.color`, "expected #RRGGBB or opaque #FFRRGGBB");
  requireThat(authoredColor.length === 7 || authoredColor.slice(1, 3).toLowerCase() === "ff", `${at}.properties.color`, "light color must be opaque; use intensity to change brightness");
  const color = `#${authoredColor.slice(-6).toLowerCase()}`;
  return { id: string(object.name, `${at}.name`), position: point(object, at, world), kind, radius, intensity, color, flicker };
}

async function compileTiledWorldMap(map, { mapPath, publicDir, refreshImageMetadata = false }) {
  record(map, "map");
  exact(map.type, "map", "map.type");
  exact(map.orientation, "orthogonal", "map.orientation");
  defaultValue(map, "infinite", false, "map");
  exact(map.tilewidth, 1, "map.tilewidth");
  exact(map.tileheight, 1, "map.tileheight");
  defaultValue(map, "renderorder", "right-down", "map");
  transforms(map, "map");
  absent(map, ["hexsidelength", "staggeraxis", "staggerindex", "chunks"], "map");
  const mapProperties = properties(map, "map", { worldId: "string", navigationCellSize: "float" });
  const cellSize = mapProperties.navigationCellSize ?? 6;
  requireThat(cellSize > 0 && cellSize <= 64, "map.properties.navigationCellSize", "expected a cell size > 0 and <= 64 world units");
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
  const context = { mapPath: path.resolve(mapPath), publicDir: path.resolve(publicDir), refreshImageMetadata };
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
    requireThat(definitions.length > 0, `${at}.tiles`, "requires at least one image");
    let maxWidth = 0, maxHeight = 0;
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
      maxWidth = Math.max(maxWidth, image.width);
      maxHeight = Math.max(maxHeight, image.height);
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
    if (refreshImageMetadata) {
      tileset.tilewidth = maxWidth;
      tileset.tileheight = maxHeight;
    } else {
      exact(integer(tileset.tilewidth, `${at}.tilewidth`, 1), maxWidth, `${at}.tilewidth`);
      exact(integer(tileset.tileheight, `${at}.tileheight`, 1), maxHeight, `${at}.tileheight`);
    }
  }

  const objects = new Set(), layers = new Set(), sites = new Map(), markers = new Map(), terrainIds = new Set(), pathIds = new Set();
  const waterIds = { surfaces: new Set(), exclusions: new Set() }, lightIds = new Set();
  const mushroomIds = new Set(), bushes = new Map(), bushMarkers = new Map(), bushRoutes = [];
  const navigationIds = new Set(), habitats = new Map(), habitatAnchors = [], anchorIds = new Set();
  const livingKinds = { WalkAreas: "walk-area", Obstacles: "nav-obstacle", PointsOfInterest: "interest", Habitats: "wildlife-habitat", WildlifeAnchors: "wildlife-anchor" };
  const navigation = () => world.navigation ??= { version: 1, cellSize, areas: [], obstacles: [], interests: [] };
  if (own(mapProperties, "navigationCellSize")) navigation();
  // Named metadata groups include every descendant object layer regardless
  // of their organizational names or object draw order. Other layers retain the
  // fixed-world subset's strict placement/order rules.
  function* objectLayers(entries, at, inheritedKind) {
    for (const [layerIndex, layer] of array(entries, at).entries()) {
      const layerAt = `${at}[${layerIndex}]`;
      record(layer, layerAt);
      const namedKind = layer.name === "Water" ? "surfaces" : layer.name === "WaterExclusions" ? "exclusions" : layer.name === "Lights" ? "lights" : own(livingKinds, layer.name) ? livingKinds[layer.name] : undefined;
      requireThat(!namedKind || !inheritedKind || namedKind === inheritedKind, layerAt, "different metadata layers must not be nested inside each other");
      const metadataKind = namedKind ?? inheritedKind;
      const isLifeLayer = !metadataKind && ["Mushrooms", "Bushes"].includes(layer.name);
      const waterKind = ["surfaces", "exclusions"].includes(metadataKind) ? metadataKind : undefined;
      const livingKind = Object.values(livingKinds).includes(metadataKind) ? metadataKind : undefined;
      const isMetadataGroup = metadataKind && layer.type === "group";
      if (!isMetadataGroup) exact(layer.type, "objectgroup", `${layerAt}.type`);
      transforms(layer, layerAt);
      absent(layer, ["data", "chunks", "image", ...(isMetadataGroup ? ["objects", "draworder"] : ["layers"])], layerAt);
      properties(layer, layerAt, {});
      const layerId = integer(layer.id, `${layerAt}.id`, 1);
      requireThat(!layers.has(layerId), `${layerAt}.id`, "duplicate layer ID");
      layers.add(layerId);
      if (waterKind) world.water ??= { surfaces: [], exclusions: [] };
      if (metadataKind === "lights") world.lights ??= [];
      if (["walk-area", "nav-obstacle", "interest"].includes(livingKind)) navigation();
      if (["wildlife-habitat", "wildlife-anchor"].includes(livingKind)) world.habitats ??= [];
      if (isLifeLayer && layer.name === "Mushrooms") world.mushrooms ??= [];
      if (isLifeLayer && layer.name === "Bushes") world.bushes ??= [];
      if (isMetadataGroup) {
        yield* objectLayers(layer.layers, `${layerAt}.layers`, metadataKind);
      } else {
        if (metadataKind || isLifeLayer) requireThat(["index", "topdown"].includes(layer.draworder), `${layerAt}.draworder`, "expected index or topdown for metadata");
        else exact(layer.draworder, "index", `${layerAt}.draworder`);
        yield { layer, layerAt, waterKind, isLightLayer: metadataKind === "lights", livingKind };
      }
    }
  }
  const routeOwners = [];
  let hasSite = false;
  for (const { layer, layerAt, waterKind, isLightLayer, livingKind } of objectLayers(map.layers, "map.layers")) {
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
      const shapes = ["gid", "point", "polygon", "polyline"].filter(key => own(object, key));
      requireThat(shapes.length <= 1, at, "object must have exactly one shape");
      const shape = shapes[0] ?? "rectangle";
      if (isLightLayer) {
        const light = compileLight(object, shape, at, world);
        requireThat(!lightIds.has(light.id), at, `duplicate light ID ${light.id}`);
        lightIds.add(light.id);
        world.lights.push(light);
        continue;
      }
      if (waterKind) {
        const waterAt = `${at} (${object.name || `object ${objectId}`})`;
        properties(object, waterAt, {});
        exact(shape, "polygon", `${waterAt} shape`);
        const id = object.name ? identifier(object.name, `${waterAt}.name`) : `${waterKind === "surfaces" ? "water" : "exclusion"}-${objectId}`;
        requireThat(!waterIds[waterKind].has(id), waterAt, `duplicate water ${waterKind} ID ${id}`);
        waterIds[waterKind].add(id);
        world.water[waterKind].push({ id, points: vertices(object, "polygon", waterAt, world) });
        continue;
      }
      const authoredRole = Array.isArray(object.properties) ? object.properties.find(property => property?.name === "role")?.value : undefined;
      if (livingKind || Object.values(livingKinds).includes(authoredRole)) {
        const livingAt = `${at} (${object.name || `object ${objectId}`})`;
        const role = livingKind ?? authoredRole;
        const allowed = role === "interest" ? { activity: "string" }
          : role === "wildlife-habitat" ? { species: "string", capacity: "int" }
          : role === "wildlife-anchor" ? { habitatId: "string", kind: "string" } : {};
        const props = properties(object, livingAt, { role: "string", ...allowed });
        exact(props.role, role, `${livingAt}.properties.role`);
        const id = identifier(object.name, `${livingAt}.name`);
        defaultValue(object, "width", 0, livingAt);
        defaultValue(object, "height", 0, livingAt);
        if (["walk-area", "nav-obstacle", "interest"].includes(role)) {
          requireThat(!navigationIds.has(id), livingAt, `duplicate navigation ID ${id}`);
          navigationIds.add(id);
          const nav = navigation();
          if (role === "interest") {
            exact(shape, "point", `${livingAt} shape`);
            exact(object.point, true, `${livingAt}.point`);
            requireThat(["look", "sniff", "groom", "rest"].includes(props.activity), `${livingAt}.properties.activity`, "expected look, sniff, groom or rest");
            nav.interests.push({ id, position: point(object, livingAt, world), activity: props.activity });
          } else {
            exact(shape, "polygon", `${livingAt} shape`);
            nav[role === "walk-area" ? "areas" : "obstacles"].push({ id, points: vertices(object, "polygon", livingAt, world) });
          }
        } else if (role === "wildlife-habitat") {
          exact(shape, "polygon", `${livingAt} shape`);
          requireThat(!habitats.has(id), livingAt, `duplicate habitat ID ${id}`);
          requireThat(["butterfly", "firefly"].includes(props.species), `${livingAt}.properties.species`, "expected butterfly or firefly");
          const capacity = integer(props.capacity, `${livingAt}.properties.capacity`, 1);
          requireThat(capacity <= 64, `${livingAt}.properties.capacity`, "expected capacity <= 64");
          habitats.set(id, { id, species: props.species, points: vertices(object, "polygon", livingAt, world), capacity, anchors: [] });
          world.habitats ??= [];
        } else {
          exact(shape, "point", `${livingAt} shape`);
          exact(object.point, true, `${livingAt}.point`);
          requireThat(!anchorIds.has(id), livingAt, `duplicate wildlife anchor ID ${id}`);
          anchorIds.add(id);
          const habitatId = identifier(props.habitatId, `${livingAt}.properties.habitatId`);
          requireThat(["rest", "shelter"].includes(props.kind), `${livingAt}.properties.kind`, "expected rest or shelter");
          habitatAnchors.push({ habitatId, at: livingAt, anchor: { id, position: point(object, livingAt, world), kind: props.kind } });
          world.habitats ??= [];
        }
        continue;
      }
      const props = properties(object, at, { role: "string", siteId: "string", label: "string", initialLevel: "int", size: "float",
        behavior: "string", activity: "string", pauseSeconds: "float", bushId: "string" });
      const role = string(props.role, `${at}.properties.role`);
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
          requireThat(Object.keys(props).every(key => ["role", "siteId", "label", "initialLevel"].includes(key)), at, "site objects only accept role, siteId, label and initialLevel properties");
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
        requireThat(world.focus.width === world.focus.height, at, "focus must be square (equal width and height) so the circular camera does not stretch the world");
      } else if (role === "spawn") {
        exact(shape, "point", `${at} shape`);
        exact(object.point, true, `${at}.point`);
        requireThat(Object.keys(props).every(key => ["role", "size"].includes(key)), at, "spawn only accepts role and size properties");
        requireThat(!world.actor, at, "only one spawn point is allowed");
        const size = number(props.size, `${at}.properties.size`);
        requireThat(size > 0 && size <= Math.min(world.width, world.height), `${at}.properties.size`, "spawn size must be positive and no larger than the smaller world dimension");
        world.actor = { spawn: point(object, at, world), size };
      } else if (role === "mushroom") {
        exact(shape, "point", `${at} shape`);
        exact(object.point, true, `${at}.point`);
        defaultValue(object, "width", 0, at);
        defaultValue(object, "height", 0, at);
        requireThat(Object.keys(props).length === 1, at, "mushrooms only accept the role property");
        const id = identifier(object.name, `${at}.name`);
        requireThat(!mushroomIds.has(id), at, `duplicate mushroom ID ${id}`);
        mushroomIds.add(id);
        world.mushrooms ??= [];
        world.mushrooms.push({ id, position: point(object, at, world) });
      } else if (["bush", "bush-entry", "bush-hide"].includes(role)) {
        requireThat(Object.keys(props).every(key => ["role", "bushId"].includes(key)), at, "bush objects only accept role and bushId properties");
        const id = identifier(props.bushId, `${at}.properties.bushId`);
        if (role === "bush") {
          exact(shape, "polygon", `${at} shape`);
          requireThat(!bushes.has(id), at, `duplicate bush ID ${id}`);
          bushes.set(id, { id, points: vertices(object, "polygon", at, world) });
        } else {
          exact(shape, "point", `${at} shape`);
          exact(object.point, true, `${at}.point`);
          defaultValue(object, "width", 0, at);
          defaultValue(object, "height", 0, at);
          const markers = bushMarkers.get(id) ?? {};
          const key = role === "bush-entry" ? "entry" : "hide";
          requireThat(!own(markers, key), at, `duplicate ${role} for bush ${id}`);
          markers[key] = point(object, at, world);
          bushMarkers.set(id, markers);
        }
      } else if (role === "path") {
        exact(shape, "polyline", `${at} shape`);
        const id = identifier(object.name, `${at}.name`);
        requireThat(!pathIds.has(id), at, `duplicate path ID ${id}`);
        requireThat(Object.keys(props).every(key => ["role", "siteId", "behavior", "activity", "pauseSeconds", "bushId"].includes(key)), at,
          "path only accepts role, siteId, behavior, activity, pauseSeconds and bushId properties");
        pathIds.add(id);
        const route = { id, points: vertices(object, "polyline", at, world) };
        if (own(props, "siteId")) {
          route.siteId = identifier(props.siteId, `${at}.properties.siteId`);
          routeOwners.push({ id: route.siteId, at });
        }
        if (own(props, "behavior")) {
          requireThat(["clearing", "home"].includes(props.behavior), `${at}.properties.behavior`, 'expected "clearing" or "home"');
          route.behavior = props.behavior;
        }
        if (route.behavior === "home") requireThat(own(route, "siteId"), at, "home behavior requires siteId");
        if (own(props, "activity") || own(props, "pauseSeconds")) {
          requireThat(route.behavior === "clearing", at, "activity and pauseSeconds require behavior: clearing");
        }
        if (own(props, "activity")) {
          requireThat(["look", "sniff", "groom", "rest", "bush"].includes(props.activity), `${at}.properties.activity`, "expected look, sniff, groom, rest or bush");
          route.activity = props.activity;
        }
        if (own(props, "pauseSeconds")) {
          requireThat(props.pauseSeconds >= 2 && props.pauseSeconds <= 20, `${at}.properties.pauseSeconds`, "expected a number from 2 to 20 seconds");
          route.pauseSeconds = props.pauseSeconds;
        }
        if (route.activity === "bush") {
          requireThat(!own(props, "siteId"), at, "bush activity uses bushId instead of siteId");
          route.bushId = identifier(props.bushId, `${at}.properties.bushId`);
          bushRoutes.push({ id: route.bushId, at });
        } else requireThat(!own(props, "bushId"), at, "bushId requires activity: bush");
        world.paths.push(route);
      } else {
        requireThat(["anchor", "entry", "doorway", "light", "hitArea", "collision"].includes(role), `${at}.properties.role`, `unknown marker role ${JSON.stringify(role)}`);
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
  for (const id of catalogs.keys()) requireThat(sites.has(id), "map", `state catalog ${id} has no placed site`);
  for (const id of markers.keys()) requireThat(sites.has(id), "map", `markers reference unknown site ${id}`);
  for (const owner of routeOwners) requireThat(sites.has(owner.id), owner.at, `path references unknown site ${owner.id}`);
  for (const id of bushMarkers.keys()) requireThat(bushes.has(id), "map", `markers reference unknown bush ${id}`);
  for (const route of bushRoutes) requireThat(bushes.has(route.id), route.at, `path references unknown bush ${route.id}`);
  if (bushes.size) world.bushes = [...bushes.values()].map(bush => {
    const geometry = bushMarkers.get(bush.id) ?? {};
    for (const role of ["entry", "hide"]) requireThat(own(geometry, role), "map", `bush ${bush.id} is missing ${role}`);
    requireThat(insidePolygon(geometry.hide, bush.points), "map", `bush ${bush.id} hide must be inside its leaf contour`);
    const jumpLimit = world.actor?.size ?? Math.min(world.width, world.height) * 0.1;
    requireThat(Math.hypot(geometry.entry.x - geometry.hide.x, geometry.entry.y - geometry.hide.y) <= jumpLimit,
      "map", `bush ${bush.id} entry and hide must be within one actor size (${jumpLimit} world units)`);
    return { ...bush, entry: geometry.entry, hide: geometry.hide };
  });
  world.sites = [...sites.values()].map(site => {
    const geometry = markers.get(site.id) ?? {};
    for (const role of ["anchor", "entry", "hitArea", "collision"]) requireThat(own(geometry, role), "map", `site ${site.id} is missing ${role}`);
    if (geometry.doorway) {
      const { x, y } = geometry.doorway, rect = site.bounds;
      requireThat(x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height, "map", `site ${site.id} doorway must be inside its image bounds`);
    }
    return { id: site.id, label: site.label, bounds: site.bounds, anchor: geometry.anchor, entry: geometry.entry,
      ...(geometry.doorway ? { doorway: geometry.doorway } : {}), hitArea: geometry.hitArea, collision: geometry.collision,
      ...(geometry.light ? { light: geometry.light } : {}), initialLevel: site.initialLevel, states: site.states };
  });
  for (const { habitatId, at, anchor } of habitatAnchors) {
    const habitat = habitats.get(habitatId);
    requireThat(habitat, at, `wildlife anchor references unknown habitat ${habitatId}`);
    requireThat(insidePolygon(anchor.position, habitat.points), at, `wildlife anchor must be inside habitat ${habitatId}`);
    habitat.anchors.push(anchor);
  }
  if (world.habitats) world.habitats = [...habitats.values()];
  if (world.navigation) {
    const blockers = [...world.navigation.obstacles.map(obstacle => obstacle.points), ...world.sites.map(site => site.collision), ...(world.water?.surfaces ?? []).map(surface => surface.points)];
    const validatePosition = (position, at) => {
      requireThat(world.navigation.areas.some(area => insidePolygon(position, area.points)), at, "position must be inside a walk area");
      requireThat(!blockers.some(polygon => insidePolygon(position, polygon)), at, "position must not overlap an obstacle, site collision or water surface");
    };
    for (const interest of world.navigation.interests) validatePosition(interest.position, `navigation interest ${interest.id}`);
    if (world.navigation.areas.length && world.actor) validatePosition(world.actor.spawn, "navigation spawn");
  }
  return world;
}

/** Compile without modifying authoring data, validating image metadata and pixels. */
export async function compileTiledWorld(map, { mapPath, publicDir }) {
  return compileTiledWorldMap(map, { mapPath, publicDir });
}

async function readTiledMap(mapPath) {
  let map;
  try { map = JSON.parse(await readFile(mapPath, "utf8")); }
  catch (error) { throw new Error(`Cannot read Tiled map: ${error.message}`); }
  return map;
}

export async function readTiledWorld(mapPath, publicDir) {
  return compileTiledWorld(await readTiledMap(mapPath), { mapPath, publicDir });
}

/** Refresh only physical image metadata on a clone, then validate the full scene
 * before the caller writes anything. Logical object geometry is never resized. */
export async function prepareTiledWorldExport(mapPath, publicDir) {
  const original = await readTiledMap(mapPath);
  const map = structuredClone(original);
  const world = await compileTiledWorldMap(map, { mapPath, publicDir, refreshImageMetadata: true });
  return { map, world, changed: JSON.stringify(map) !== JSON.stringify(original) };
}

export const serializeTiledWorld = world => `${JSON.stringify(world, null, 2)}\n`;
