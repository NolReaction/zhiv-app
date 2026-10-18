import type { Geometry } from "geojson";
import type { Map as LibreMap } from "maplibre-gl";
import { EARTH_TILE_BASE_LAYER } from "./tile-base";
import type { EarthTileId, EarthTileRecoveryStatus } from "./tile-recovery";
import styles from "./tile-loading-overlay.module.css";

type Pixel = { x: number; y: number };
type ProjectionMap = Pick<LibreMap, "getCenter" | "project" | "unproject">;
type TileRecord = { tile: EarthTileId; failed: boolean };
type Footprint = { points: Pixel[]; path: string; area: number };
const maxTracked = 128;
const maxPatches = 16;
const maxBadges = 2;
let overlaySequence = 0;

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : null;
}
function tileId(value: unknown): EarthTileId | null {
  const tile = object(value);
  if (!tile || !Number.isInteger(tile.z) || (tile.z as number) < 0 || (tile.z as number) > 25) return null;
  const size = 2 ** (tile.z as number);
  if (!Number.isInteger(tile.x) || !Number.isInteger(tile.y) || (tile.x as number) < 0 || (tile.y as number) < 0
    || (tile.x as number) >= size || (tile.y as number) >= size) return null;
  return { x: tile.x as number, y: tile.y as number, z: tile.z as number };
}
const key = (tile: EarthTileId) => `${tile.z}/${tile.x}/${tile.y}`;
const latitude = (y: number) => Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180 / Math.PI;
const mercatorY = (lat: number) => (1 - Math.asinh(Math.tan(lat * Math.PI / 180)) / Math.PI) / 2;

/** Infer IDs from the public GeoJSON geometry of our known, tile-sized base layer. */
export function earthLoadedTileCoverage(features: readonly { geometry: Geometry }[]): EarthTileId[] {
  const result = new Map<string, EarthTileId>();
  for (const feature of features) {
    if (feature.geometry?.type !== "Polygon") continue;
    const ring = feature.geometry.coordinates[0];
    if (!ring || ring.length < 4 || ring.some(point => !Number.isFinite(point[0]) || !Number.isFinite(point[1]))) continue;
    const west = Math.min(...ring.map(point => point[0]));
    const east = Math.max(...ring.map(point => point[0]));
    const north = Math.max(...ring.map(point => point[1]));
    const width = east - west;
    if (width <= 0 || width > 360 || Math.abs(north) > 85.052) continue;
    const z = Math.round(Math.log2(360 / width));
    const size = 2 ** z;
    if (Math.abs(360 / size - width) > Math.max(1e-7, width * 1e-8)) continue;
    const tile = tileId({ z, x: Math.round((west + 180) / 360 * size), y: Math.round(mercatorY(north) * size) });
    if (tile) result.set(key(tile), tile);
  }
  return [...result.values()];
}

function clip(points: Pixel[], width: number, height: number): Pixel[] {
  let output = points;
  for (const [axis, edge, greater] of [["x", 0, true], ["x", width, false], ["y", 0, true], ["y", height, false]] as const) {
    const input = output;
    output = [];
    const inside = (point: Pixel) => greater ? point[axis] >= edge : point[axis] <= edge;
    for (let index = 0; index < input.length; index += 1) {
      const a = input[index]; const b = input[(index + 1) % input.length];
      if (inside(a)) output.push(a);
      if (inside(a) !== inside(b)) {
        const fraction = (edge - a[axis]) / (b[axis] - a[axis]);
        output.push({ x: a.x + (b.x - a.x) * fraction, y: a.y + (b.y - a.y) * fraction });
      }
    }
  }
  return output;
}
function polygonArea(points: Pixel[]): number {
  return Math.abs(points.reduce((area, point, index) => {
    const next = points[(index + 1) % points.length];
    return area + point.x * next.y - point.y * next.x;
  }, 0)) / 2;
}
function insidePolygon(point: Pixel, polygon: Pixel[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]; const b = polygon[j];
    if ((a.y > point.y) !== (b.y > point.y) && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** Conservative globe footprint: never paint a tile projected from behind Earth. */
export function earthLoadingTileFootprint(map: ProjectionMap, tile: EarthTileId, width: number, height: number): Footprint | null {
  const size = 2 ** tile.z;
  const centerLongitude = (tile.x + 0.5) / size * 360 - 180;
  const shift = 360 * Math.round((map.getCenter().lng - centerLongitude) / 360);
  const project = (u: number, v: number): Pixel | null => {
    const lng = (tile.x + u) / size * 360 - 180 + shift;
    const lat = latitude((tile.y + v) / size);
    const point = map.project([lng, lat]);
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
    const back = map.unproject(point);
    const longitudeError = Math.abs(((back.lng - lng + 540) % 360 + 360) % 360 - 180);
    if (!Number.isFinite(back.lat) || longitudeError > 0.0005 || Math.abs(back.lat - lat) > 0.0005) return null;
    return { x: point.x, y: point.y };
  };
  if (!project(0.5, 0.5)) return null;
  const corners = [[0, 0], [1, 0], [1, 1], [0, 1]] as const;
  const points: Pixel[] = [];
  let rejected = false;
  const edge = (a: readonly number[], b: readonly number[], pa: Pixel, pb: Pixel, depth: number) => {
    const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const pm = project(mid[0], mid[1]);
    if (!pm) { rejected = true; return; }
    const length = Math.hypot(pb.x - pa.x, pb.y - pa.y);
    const deviation = length ? Math.abs((pb.x - pa.x) * (pa.y - pm.y) - (pa.x - pm.x) * (pb.y - pa.y)) / length : 0;
    if (deviation > 0.65 && depth < 3) {
      edge(a, mid, pa, pm, depth + 1); edge(mid, b, pm, pb, depth + 1);
    } else points.push(pa);
  };
  for (let index = 0; index < corners.length; index += 1) {
    const a = corners[index]; const b = corners[(index + 1) % corners.length];
    const pa = project(a[0], a[1]); const pb = project(b[0], b[1]);
    if (!pa || !pb) return null;
    edge(a, b, pa, pb, 0);
  }
  if (rejected) return null;
  const clipped = clip(points, width, height);
  const area = polygonArea(clipped);
  if (area < 64) return null;
  return { points: clipped, area, path: `M${clipped.map(point => `${point.x.toFixed(2)},${point.y.toFixed(2)}`).join("L")}Z` };
}

function overlaps(a: EarthTileId, b: EarthTileId): boolean {
  const scale = 2 ** (b.z - a.z);
  return b.z >= a.z && Math.floor(b.x / scale) === a.x && Math.floor(b.y / scale) === a.y;
}
function missingAnchor(footprint: Footprint, covered: Footprint[]): Pixel | null {
  const xs = footprint.points.map(point => point.x); const ys = footprint.points.map(point => point.y);
  const left = Math.min(...xs); const right = Math.max(...xs); const top = Math.min(...ys); const bottom = Math.max(...ys);
  for (const v of [0.5, 0.25, 0.75, 0.1, 0.9]) for (const u of [0.5, 0.25, 0.75, 0.1, 0.9]) {
    const point = { x: left + (right - left) * u, y: top + (bottom - top) * v };
    if (insidePolygon(point, footprint.points) && !covered.some(shape => insidePolygon(point, shape.points))) return point;
  }
  return null;
}

/** SVG lives above the canvas; it never mutates MapLibre's style or worker data. */
export function createEarthTileLoadingOverlay(map: LibreMap, sourceId = "earth-streets") {
  const container = map.getContainer();
  const element = container.ownerDocument.createElementNS("http://www.w3.org/2000/svg", "svg");
  element.setAttribute("class", styles.overlay);
  element.setAttribute("data-earth-tile-loading-overlay", "");
  element.setAttribute("aria-hidden", "true");
  element.style.display = "none";
  map.getCanvasContainer().append(element);
  const prefix = `earth-loading-${++overlaySequence}`;
  const records = new Map<string, TileRecord>();
  let visible = false;
  let disposed = false;
  let status: EarthTileRecoveryStatus = "idle";
  let online = true;
  let previousMarkup = "";

  function refresh() {
    if (disposed) return;
    const width = container.clientWidth; const height = container.clientHeight;
    const candidates = new Map<string, TileRecord>();
    if (visible && width > 0 && height > 0 && map.getZoom() >= 4 && map.getSource(sourceId)) {
      for (const entry of records.values()) {
        const existing = candidates.get(key(entry.tile));
        if (!existing || !entry.failed) candidates.set(key(entry.tile), entry);
      }
    }
    const loaded = candidates.size ? earthLoadedTileCoverage(map.querySourceFeatures(sourceId, { sourceLayer: EARTH_TILE_BASE_LAYER })) : [];
    const projected = new Map<string, Footprint | null>();
    const shape = (tile: EarthTileId) => {
      const id = key(tile);
      if (!projected.has(id)) projected.set(id, earthLoadingTileFootprint(map, tile, width, height));
      return projected.get(id) ?? null;
    };
    const drawn: { tile: EarthTileId; footprint: Footprint }[] = [];
    const groups: string[] = [];
    const badges: Pixel[] = [];
    const ordered = [...candidates.values()].sort((a, b) => b.tile.z - a.tile.z);
    for (const candidate of ordered) {
      if (groups.length >= maxPatches) break;
      if (loaded.some(tile => key(tile) === key(candidate.tile))) continue;
      const footprint = shape(candidate.tile);
      if (!footprint) continue;
      const covered = loaded.filter(tile => overlaps(candidate.tile, tile)).map(shape).filter((value): value is Footprint => !!value);
      covered.push(...drawn.filter(entry => overlaps(candidate.tile, entry.tile)).map(entry => entry.footprint));
      const anchor = missingAnchor(footprint, covered);
      if (!anchor) continue;
      const state = !online ? "offline" : candidate.failed || status === "failed" ? "failed" : "loading";
      const label = state === "offline" ? "Нет сети" : state === "failed" ? "Не загрузилось" : "Загружаем";
      const id = `${prefix}-${groups.length}`;
      const showBadge = footprint.area >= 12_000 && badges.length < maxBadges
        && badges.every(point => Math.hypot(point.x - anchor.x, point.y - anchor.y) > 220);
      if (showBadge) badges.push(anchor);
      groups.push(`<defs><mask id="${id}" maskUnits="userSpaceOnUse" x="0" y="0" width="${width}" height="${height}"><path d="${footprint.path}" fill="white"/>${covered.map(value => `<path d="${value.path}" fill="black"/>`).join("")}</mask></defs>
        <g mask="url(#${id})" class="${styles.patch}" data-loading-tile="${key(candidate.tile)}" data-state="${state}">
          <path d="${footprint.path}" fill="url(#${prefix}-mist)" class="${styles.surface}"/>
          ${showBadge ? `<g data-loading-badge="" transform="translate(${anchor.x.toFixed(2)} ${anchor.y.toFixed(2)})">
            <path d="M-20 5C-29 5-30-7-21-10-20-22-5-25 2-15 12-23 26-15 24-5 34-3 30 6 21 6Z" fill="url(#${prefix}-cloud)" class="${styles.cloud}"/>
            <text y="25" text-anchor="middle" class="${styles.label}">${label}</text>
          </g>` : ""}
        </g>`);
      drawn.push({ tile: candidate.tile, footprint });
    }
    element.setAttribute("viewBox", `0 0 ${width || 1} ${height || 1}`);
    element.setAttribute("data-patch-count", String(groups.length));
    element.setAttribute("data-badge-count", String(badges.length));
    element.style.display = visible && groups.length ? "" : "none";
    const markup = groups.length ? `<defs>
      <linearGradient id="${prefix}-mist" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="${width}" y2="${height}"><stop stop-color="#dce9e8" stop-opacity=".12"/><stop offset=".5" stop-color="#e8eeea" stop-opacity=".20"/><stop offset="1" stop-color="#c4d5dd" stop-opacity=".10"/></linearGradient>
      <linearGradient id="${prefix}-cloud" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#ffffff"/><stop offset="1" stop-color="#c6d7df"/></linearGradient>
    </defs>${groups.join("")}` : "";
    if (markup !== previousMarkup) { element.innerHTML = markup; previousMarkup = markup; }
  }

  return {
    observe(event: unknown) {
      if (disposed) return;
      const value = object(event);
      if (!value || value.sourceId !== sourceId) return;
      if ((value.type === "sourcedata" || value.type === "data") && value.sourceDataType === "metadata") { records.clear(); return; }
      // coord is public MapSourceDataEvent; error events expose the documented tile object.
      const coord = object(value.coord) ?? object(object(value.tile)?.tileID);
      const tile = tileId(coord?.canonical);
      if (!tile) return;
      const instanceKey = `${key(tile)}/${coord?.overscaledZ ?? tile.z}/${coord?.wrap ?? 0}`;
      if (value.type === "sourcedata" || value.type === "data") {
        for (const [id, entry] of records) if (key(entry.tile) === key(tile)) records.delete(id);
      } else if (value.type === "sourcedataabort" || value.type === "dataabort") records.delete(instanceKey);
      else if (value.type === "sourcedataloading" || value.type === "dataloading" || value.type === "error") {
        records.set(instanceKey, { tile, failed: value.type === "error" });
        if (records.size > maxTracked) records.delete(records.keys().next().value!);
      }
    },
    refresh,
    setStatus(value: EarthTileRecoveryStatus, isOnline = true) { status = value; online = isOnline; },
    setVisible(value: boolean) { visible = value; if (!value) element.style.display = "none"; },
    dispose() { if (disposed) return; disposed = true; records.clear(); element.remove(); },
  };
}
