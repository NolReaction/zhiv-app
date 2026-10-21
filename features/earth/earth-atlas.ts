import biomes from "./data/biomes-illustrated.json";
import { EARTH_LANDMARKS } from "./landmark-catalog";
import placementsDocument from "./data/model-placements.json";
import { EARTH_MODEL_PREVIEW_MIN_ZOOM } from "./landmark-model-view";

export type EarthAtlasView = { center: readonly [number, number]; zoom: number };
export type EarthAtlasKind = "landmark" | "region" | "meeting";
export type EarthAtlasFocus = Readonly<{ kind: "model"; modelId: string }>
  | Readonly<{ kind: "region"; bounds: readonly [number, number, number, number] }>;
export type EarthAtlasEntry = Readonly<{ id: string; title: string; subtitle: string; kind: EarthAtlasKind;
  center: readonly [number, number] | null; zoom: number | null; biome?: string; focus: EarthAtlasFocus | null }>;

const REGION_NAMES: Record<string, string> = {
  "alaska-tundra": "Тундра Аляски", "canadian-arctic": "Канадская Арктика",
  "russian-arctic-west": "Западная тундра", "russian-arctic-east": "Восточная тундра", "chukotka-tundra": "Чукотка",
  "alaska-taiga": "Леса Аляски", "canada-west-taiga": "Западная тайга Канады", "canada-east-taiga": "Восточная тайга Канады",
  "scandinavian-taiga": "Леса Скандинавии", "west-siberian-taiga": "Западносибирская тайга", "east-siberian-taiga": "Восточносибирская тайга",
  "great-plains": "Великие равнины", "patagonian-steppe": "Патагония", pampas: "Пампасы",
  "pontic-kazakh-steppe": "Евразийская степь", "mongolian-steppe": "Степи Монголии", "tibetan-plateau": "Тибетское нагорье",
  sahara: "Сахара", "arabian-desert": "Аравийская пустыня", "iranian-desert": "Пустыни Ирана", "thar-desert": "Тар",
  taklamakan: "Такла-Макан", gobi: "Гоби", "australian-interior": "Центральная Австралия", "namib-kalahari": "Намиб и Калахари",
  atacama: "Атакама", "southwest-deserts": "Пустыни Северной Америки", "amazon-rainforest": "Амазония", "congo-rainforest": "Леса Конго",
  "guinean-rainforest": "Гвинейские леса", "central-american-rainforest": "Леса Центральной Америки",
  "southeast-asian-rainforest": "Леса Индокитая", "indonesian-rainforest": "Леса Индонезии", "new-guinean-rainforest": "Новая Гвинея",
  "sahel-savanna": "Сахель", "east-african-savanna": "Восточноафриканская саванна", "southern-african-savanna": "Южноафриканская саванна",
  "cerrado-savanna": "Серрадо", "llanos-savanna": "Льянос", "northern-australian-savanna": "Саванны Австралии",
};
const BIOME_NAMES: Record<string, string> = { tundra: "Тундра", boreal: "Тайга", steppe: "Степь и нагорья",
  desert: "Пустыня", rainforest: "Тропический лес", savanna: "Саванна" };
type Point = readonly number[];
type Polygon = readonly (readonly Point[])[];

function inRing(point: Point, ring: readonly Point[]) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [x, y] = ring[i], [a, b] = ring[j];
    if ((y > point[1]) !== (b > point[1]) && point[0] < (a - x) * (point[1] - y) / (b - y) + x) inside = !inside;
  }
  return inside;
}
function inPolygon(point: Point, polygon: Polygon) {
  return inRing(point, polygon[0]) && !polygon.slice(1).some(ring => inRing(point, ring));
}
function area(ring: readonly Point[]) {
  return Math.abs(ring.reduce((sum, point, i) => {
    const next = ring[(i + 1) % ring.length];
    return sum + point[0] * next[1] - next[0] * point[1];
  }, 0));
}
function regionBounds(polygons: readonly Polygon[]): readonly [number, number, number, number] {
  const ring = [...polygons].sort((a, b) => area(b[0]) - area(a[0]))[0][0];
  return [Math.min(...ring.map(point => point[0])), Math.min(...ring.map(point => point[1])),
    Math.max(...ring.map(point => point[0])), Math.max(...ring.map(point => point[1]))];
}

/** Use an interior point of the largest clipped core; a raw region centroid can fall in the sea. */
function regionCenter(polygons: readonly Polygon[]): readonly [number, number] {
  const polygon = [...polygons].sort((a, b) => area(b[0]) - area(a[0]))[0];
  const ring = polygon[0], xs = ring.map(p => p[0]), ys = ring.map(p => p[1]);
  const west = Math.min(...xs), east = Math.max(...xs), south = Math.min(...ys), north = Math.max(...ys);
  const center: [number, number] = [(west + east) / 2, (south + north) / 2];
  if (inPolygon(center, polygon)) return center;
  const choices: [number, number][] = [];
  for (let y = 1; y < 24; y++) for (let x = 1; x < 24; x++) {
    const point: [number, number] = [west + (east - west) * x / 24, south + (north - south) * y / 24];
    if (inPolygon(point, polygon)) choices.push(point);
  }
  choices.sort((a, b) => Math.hypot(a[0] - center[0], a[1] - center[1]) - Math.hypot(b[0] - center[0], b[1] - center[1]));
  // All current cores contain interior grid points; keep malformed future art safe.
  return choices[0] ?? [ring[0][0], ring[0][1]];
}

const cores = biomes.features.filter(feature => feature.properties.band === 4);
const modelPlacements = new Map(placementsDocument.placements.map(placement => [placement.id, placement]));
export const EARTH_ATLAS_MEETING_ID = "meeting:friend";
export const EARTH_ATLAS_ENTRIES: readonly EarthAtlasEntry[] = [
  ...EARTH_LANDMARKS.map(landmark => {
    const placement = modelPlacements.get(landmark.id);
    return { id: `landmark:${landmark.id}`, title: landmark.nameRussian,
      subtitle: "Достопримечательность", kind: "landmark" as const,
      center: placement ? [placement.longitude, placement.latitude] as const : landmark.location, zoom: 15.6,
      focus: { kind: "model" as const, modelId: landmark.id } };
  }),
  ...cores.map(feature => ({ id: `region:${feature.properties.region}`, title: REGION_NAMES[feature.properties.region] ?? feature.properties.region,
    subtitle: BIOME_NAMES[feature.properties.biome] ?? "Регион", kind: "region" as const,
    center: regionCenter(feature.geometry.coordinates), zoom: 3.5, biome: feature.properties.biome,
    focus: { kind: "region" as const, bounds: regionBounds(feature.geometry.coordinates) } })),
  { id: EARTH_ATLAS_MEETING_ID, title: "Встреча с близким", subtitle: "Отметка по твоему выбору", kind: "meeting", center: null, zoom: null, focus: null },
];
const entriesById = new Map(EARTH_ATLAS_ENTRIES.map(entry => [entry.id, entry]));
export function earthAtlasEntry(id: string) { return entriesById.get(id) ?? null; }

/** A camera candidate is only an offer. Rendering/moving never records an achievement. */
export function earthAtlasCandidate(view: EarthAtlasView | null): EarthAtlasEntry | null {
  if (!view || !Number.isFinite(view.zoom) || view.zoom < 2.2 || view.zoom > 20
    || !view.center.every(Number.isFinite) || Math.abs(view.center[1]) > 90) return null;
  const center: [number, number] = [((view.center[0] + 180) % 360 + 360) % 360 - 180, view.center[1]];
  if (view.zoom >= 4.5) {
    const radius = Math.min(1.25, 360 / (512 * 2 ** view.zoom) * 64);
    const nearest = EARTH_ATLAS_ENTRIES.filter(entry => entry.kind === "landmark" && entry.center).map(entry => {
      const lng = Math.abs(entry.center![0] - center[0]);
      const placement = entry.focus?.kind === "model" ? modelPlacements.get(entry.focus.modelId) : null;
      // A tilted camera frames the raised silhouette, not just its foot. Its
      // ground centre can be one building height away while the model is fully
      // visible. Actual draw/viewport readiness is checked by the preview gate.
      const modelRadius = view.zoom >= EARTH_MODEL_PREVIEW_MIN_ZOOM && placement
        ? Math.max(placement.heightMeters * 1.5, placement.exclusionRadiusMeters) / 111_195 : 0;
      return { entry, radius: Math.max(radius, modelRadius),
        distance: Math.hypot(Math.min(lng, 360 - lng) * Math.cos(center[1] * Math.PI / 180), entry.center![1] - center[1]) };
    }).sort((a, b) => a.distance - b.distance)[0];
    if (nearest && nearest.distance <= nearest.radius) return nearest.entry;
  }
  const region = cores.find(feature => feature.geometry.coordinates.some(polygon => inPolygon(center, polygon)));
  return region ? earthAtlasEntry(`region:${region.properties.region}`) : null;
}
