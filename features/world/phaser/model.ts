import { initialPreviewLevels, previewSiteVisual, previewWorldScene } from "@/features/world/tiled/preview-state";
import type { FixedWorldScene, SiteGeometry, WorldBounds, WorldPoint, WorldVisibilityCondition } from "@/features/world/tiled/types";
import type { PhaserSiteTransform, PhaserTransforms, PhaserWorldOptions } from "./contracts";

export const PHASER_TRANSFORM_LIMITS = { offset: 4096, minScale: 0.25, maxScale: 3 } as const;
export const PHASER_DRAFT_MAX_BYTES = 65_536;

/** Export drops the Buildings/<site>/<site>-ground parent group. Preserve those
 * reviewed Tiled owners here until the exporter provides explicit ownership.
 * The two resident plates are also explicitly associated with their sites. */
export const PHASER_LEGACY_GROUND_OWNERS: Readonly<Record<string, string>> = {
  "builder-home-ground": "builder-home",
  "plesk-shop-ground": "plesk-shop",
  "lighthouse-ground": "lighthouse",
  "terrain-345": "woodlot",
  "terrain-301": "quarry",
  "terrain-329": "quarry",
  "terrain-280": "quarry",
  "terrain-348": "bridge",
  "terrain-349": "bridge",
  "terrain-250": "lighthouse",
  "terrain-251": "lighthouse",
  "terrain-252": "lighthouse",
  "terrain-254": "lighthouse",
  "terrain-240": "workshop",
  "terrain-241": "workshop",
  "terrain-242": "workshop",
  "terrain-243": "workshop",
  "terrain-244": "workshop",
  "terrain-311": "home",
  "terrain-314": "home",
  "terrain-315": "home",
};

export function initialPhaserOptions(scene: FixedWorldScene): PhaserWorldOptions {
  return {
    levels: initialPreviewLevels(scene), transforms: {},
    selectedSiteId: scene.sites.find(site => site.id === "home")?.id ?? scene.sites.find(site => site.id === "workshop")?.id ?? scene.sites[0]?.id ?? null,
    mode: "inspect", grid: false, geometry: false, shadows: true, night: false,
    snap: true, gridSize: 32, reducedMotion: false,
  };
}

/** A level's layout never overwrites another level's differently authored geometry. */
export function transformKey(siteId: string, level: number): string {
  return `${encodeURIComponent(siteId)}:${level}`;
}

function finiteClamp(value: number | undefined, fallback: number, min: number, max: number) {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
}

export function sanitizePhaserTransform(value?: Partial<PhaserSiteTransform> | null): PhaserSiteTransform {
  return {
    dx: finiteClamp(value?.dx, 0, -PHASER_TRANSFORM_LIMITS.offset, PHASER_TRANSFORM_LIMITS.offset),
    dy: finiteClamp(value?.dy, 0, -PHASER_TRANSFORM_LIMITS.offset, PHASER_TRANSFORM_LIMITS.offset),
    scale: finiteClamp(value?.scale, 1, PHASER_TRANSFORM_LIMITS.minScale, PHASER_TRANSFORM_LIMITS.maxScale),
  };
}

export function getSiteTransform(transforms: PhaserTransforms, siteId: string, level: number): PhaserSiteTransform {
  const key = transformKey(siteId, level);
  return sanitizePhaserTransform(Object.hasOwn(transforms, key) ? transforms[key] : undefined);
}

type Placement = { anchor: WorldPoint; transform: PhaserSiteTransform };
function pointAt(point: WorldPoint, { anchor, transform: { dx, dy, scale } }: Placement): WorldPoint {
  return { x: anchor.x + (point.x - anchor.x) * scale + dx, y: anchor.y + (point.y - anchor.y) * scale + dy };
}
function boundsAt<T extends WorldBounds>(bounds: T, placement: Placement): T {
  return { ...bounds, ...pointAt(bounds, placement), width: bounds.width * placement.transform.scale, height: bounds.height * placement.transform.scale };
}
function geometryAt(geometry: SiteGeometry, placement: Placement): SiteGeometry {
  const point = (value: WorldPoint) => pointAt(value, placement);
  return {
    bounds: boundsAt(geometry.bounds, placement),
    ...(geometry.imagePlacement ? { imagePlacement: boundsAt(geometry.imagePlacement, placement) } : {}),
    anchor: point(geometry.anchor), entry: point(geometry.entry),
    hitArea: geometry.hitArea.map(point), collision: geometry.collision.map(point),
    ...(geometry.doorway ? { doorway: point(geometry.doorway) } : {}),
    ...(geometry.light ? { light: point(geometry.light) } : {}),
    ...(geometry.chimney ? { chimney: point(geometry.chimney) } : {}),
    ...(geometry.window ? { window: geometry.window.map(point) } : {}),
  };
}

/**
 * Drawing, picking and pathfinding consume the same effective scene. The source
 * and state geometry remain authored definitions; render the effective site
 * fields, not state.geometry. Unlinked background artwork is never guessed by ID;
 * only the reviewed legacy ground-plate associations below supplement Tiled.
 */
export function applyPhaserOptions(source: FixedWorldScene, options: PhaserWorldOptions): FixedWorldScene {
  const scene = previewWorldScene(source, options.levels);
  const placements = new Map<string, Placement>();
  for (const site of scene.sites) {
    const level = previewSiteVisual(site, options.levels)?.level;
    if (level === undefined) continue;
    const transform = getSiteTransform(options.transforms, site.id, level);
    if (transform.dx !== 0 || transform.dy !== 0 || transform.scale !== 1) placements.set(site.id, { anchor: site.anchor, transform });
  }
  if (placements.size === 0) return scene;
  const attachment = (value: { siteId?: string; when?: WorldVisibilityCondition }) => placements.get(value.siteId ?? value.when?.siteId ?? "");
  const polygon = <T extends { points: WorldPoint[]; when?: WorldVisibilityCondition }>(value: T): T => {
    const placement = attachment(value);
    return placement ? { ...value, points: value.points.map(point => pointAt(point, placement)) } : value;
  };
  return {
    ...scene,
    sites: scene.sites.map(site => {
      const placement = placements.get(site.id);
      return placement ? { ...site, ...geometryAt(site, placement) } : site;
    }),
    terrain: scene.terrain.map(image => {
      const placement = image.when ? attachment(image) : placements.get(PHASER_LEGACY_GROUND_OWNERS[image.id]);
      return placement ? { ...image, bounds: boundsAt(image.bounds, placement),
        ...(image.imagePlacement ? { imagePlacement: boundsAt(image.imagePlacement, placement) } : {}) } : image;
    }),
    paths: scene.paths.map(path => {
      const placement = attachment(path);
      return placement ? { ...path, points: path.points.map(point => pointAt(point, placement)) } : path;
    }),
    ...(scene.navigation ? { navigation: { ...scene.navigation,
      areas: scene.navigation.areas.map(polygon), obstacles: scene.navigation.obstacles.map(polygon),
    } } : {}),
    ...(scene.occluders ? { occluders: scene.occluders.map(occluder => {
      const placement = attachment(occluder);
      return placement ? { ...polygon(occluder), frontY: pointAt({ x: placement.anchor.x, y: occluder.frontY }, placement).y } : occluder;
    }) } : {}),
    ...(scene.destinations ? { destinations: scene.destinations.map(destination => {
      const placement = attachment(destination);
      return placement ? { ...destination, position: pointAt(destination.position, placement) } : destination;
    }) } : {}),
    ...(scene.audio ? { audio: {
      emitters: scene.audio.emitters.map(emitter => {
        const placement = attachment(emitter);
        return placement ? { ...emitter, position: pointAt(emitter.position, placement),
          innerRadius: emitter.innerRadius * placement.transform.scale,
          outerRadius: emitter.outerRadius * placement.transform.scale } : emitter;
      }),
      zones: scene.audio.zones.map(zone => {
        const placement = attachment(zone);
        return placement ? { ...polygon(zone), fadeDistance: zone.fadeDistance * placement.transform.scale } : zone;
      }),
    } } : {}),
  };
}

export type PhaserDraft = {
  kind: "zhiv-phaser-world-layout";
  version: 1;
  map: { id: string; fingerprint: string };
  levels: PhaserWorldOptions["levels"];
  transforms: PhaserTransforms;
};
export type PhaserDraftState = Pick<PhaserWorldOptions, "levels" | "transforms">;

const fingerprints = new WeakMap<FixedWorldScene, string>();
function sortedJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(sortedJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${sortedJson(item)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
/** Change detection for a trusted static map, not a cryptographic signature. */
export function phaserMapFingerprint(scene: FixedWorldScene): string {
  const cached = fingerprints.get(scene);
  if (cached) return cached;
  const json = sortedJson(scene);
  let hash = 0x811c9dc5;
  for (let index = 0; index < json.length; index++) hash = Math.imul(hash ^ json.charCodeAt(index), 0x01000193);
  const fingerprint = `fnv1a32:${(hash >>> 0).toString(16).padStart(8, "0")}`;
  fingerprints.set(scene, fingerprint);
  return fingerprint;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every(key => keys.includes(key));
}
function knownTransforms(scene: FixedWorldScene): Set<string> {
  return new Set(scene.sites.flatMap(site => site.states.map(state => transformKey(site.id, state.level))));
}

export function createPhaserDraft(scene: FixedWorldScene, options: PhaserDraftState): PhaserDraft {
  const levels = Object.fromEntries(scene.sites.map(site => [site.id, previewSiteVisual(site, options.levels)?.level ?? site.initialLevel]));
  const allowed = knownTransforms(scene);
  const transforms = Object.fromEntries(Object.entries(options.transforms).filter(([key]) => allowed.has(key))
    .map(([key, value]) => [key, sanitizePhaserTransform(value)]));
  return { kind: "zhiv-phaser-world-layout", version: 1, map: { id: scene.id, fingerprint: phaserMapFingerprint(scene) }, levels, transforms };
}

export function serializePhaserDraft(scene: FixedWorldScene, options: PhaserDraftState): string {
  return JSON.stringify(createPhaserDraft(scene, options), null, 2);
}

/** Only a small layout whitelist is imported; image URLs, scripts and game state cannot be imported. */
export function readPhaserDraft(scene: FixedWorldScene, input: unknown): PhaserDraftState {
  let draft = input;
  if (typeof draft === "string") {
    if (draft.length > PHASER_DRAFT_MAX_BYTES || new TextEncoder().encode(draft).byteLength > PHASER_DRAFT_MAX_BYTES) {
      throw new Error("Черновик слишком большой: максимум 64 КиБ.");
    }
    try { draft = JSON.parse(draft); } catch { throw new Error("Не удалось прочитать JSON черновика."); }
  }
  if (!isRecord(draft) || draft.kind !== "zhiv-phaser-world-layout" || draft.version !== 1
    || !onlyKeys(draft, ["kind", "version", "map", "levels", "transforms"])) throw new Error("Неподдерживаемый формат черновика Phaser.");
  if (!isRecord(draft.map) || !onlyKeys(draft.map, ["id", "fingerprint"])
    || draft.map.id !== scene.id || draft.map.fingerprint !== phaserMapFingerprint(scene)) {
    throw new Error("Черновик относится к другой версии карты. Сбросьте его и перенесите нужные изменения вручную.");
  }
  if (!isRecord(draft.levels) || !isRecord(draft.transforms)) throw new Error("В черновике нет уровней или размещения объектов.");
  const sites = new Map(scene.sites.map(site => [site.id, site]));
  const levels = initialPreviewLevels(scene);
  for (const [id, level] of Object.entries(draft.levels)) {
    if (typeof level !== "number" || !sites.get(id)?.states.some(state => state.level === level)) throw new Error("В черновике указан неизвестный объект или уровень.");
    levels[id] = level;
  }
  const allowed = knownTransforms(scene);
  const transforms: PhaserTransforms = {};
  for (const [key, value] of Object.entries(draft.transforms)) {
    if (!allowed.has(key) || !isRecord(value) || !onlyKeys(value, ["dx", "dy", "scale"])) throw new Error("В черновике указано неизвестное размещение объекта.");
    const { dx, dy, scale } = value;
    if (typeof dx !== "number" || !Number.isFinite(dx) || Math.abs(dx) > PHASER_TRANSFORM_LIMITS.offset
      || typeof dy !== "number" || !Number.isFinite(dy) || Math.abs(dy) > PHASER_TRANSFORM_LIMITS.offset
      || typeof scale !== "number" || !Number.isFinite(scale)
      || scale < PHASER_TRANSFORM_LIMITS.minScale || scale > PHASER_TRANSFORM_LIMITS.maxScale) {
      throw new Error("Смещение или масштаб объекта выходят за допустимые пределы.");
    }
    transforms[key] = { dx, dy, scale };
  }
  return { levels, transforms };
}
