/** Runtime contract compiled from the deliberately small Tiled authoring subset. */
export type WorldPoint = { x: number; y: number };
export type WorldBounds = WorldPoint & { width: number; height: number };
export type WorldImage = { id: string; image: string; bounds: WorldBounds };
export type SiteGeometry = {
  bounds: WorldBounds;
  anchor: WorldPoint;
  entry: WorldPoint;
  /** Optional foot position on the visible threshold, beyond the outside entry. */
  doorway?: WorldPoint;
  hitArea: WorldPoint[];
  collision: WorldPoint[];
  light?: WorldPoint;
};
export type SiteVisual = { level: number; label: string; image: string; geometry?: SiteGeometry };
export type FixedSite = SiteGeometry & {
  id: string;
  label: string;
  initialLevel: number;
  states: SiteVisual[];
};
export type WorldPath = {
  id: string;
  points: WorldPoint[];
  /** An authored route may belong to a placed site. Required for home approaches. */
  siteId?: string;
  /** Opt-in local life; unmarked paths remain available only to route consumers. */
  behavior?: "clearing" | "home";
  activity?: "look" | "sniff" | "groom" | "rest" | "bush";
  /** Required for a bush activity; references a separately authored leaf contour. */
  bushId?: string;
  /** Time at the outward endpoint, from 2 to 20 seconds. */
  pauseSeconds?: number;
};
export type WorldWaterPolygon = { id: string; points: WorldPoint[] };
export type WorldNavigationPolygon = { id: string; points: WorldPoint[] };
export type WorldInterest = {
  id: string;
  position: WorldPoint;
  activity: "look" | "sniff" | "groom" | "rest";
};
export type WorldNavigation = {
  version: 1;
  /** Search resolution in world units; unrelated to Tiled's drawing grid. */
  cellSize: number;
  areas: WorldNavigationPolygon[];
  obstacles: WorldNavigationPolygon[];
  interests: WorldInterest[];
};
export type WorldHabitat = {
  id: string;
  species: "butterfly" | "firefly";
  points: WorldPoint[];
  /** Raw contours excluded from this territory; referenced exclusions are not recursive. */
  exclusions?: { id: string; points: WorldPoint[] }[];
  capacity: number;
  anchors: { id: string; position: WorldPoint; kind: "rest" | "shelter" }[];
};
export type WorldMushroom = { id: string; position: WorldPoint };
export type WorldBush = {
  id: string;
  /** Contour of the existing bush artwork used for foreground leaves. */
  points: WorldPoint[];
  /** Foot positions outside the leaves and while hiding inside them. */
  entry: WorldPoint;
  hide: WorldPoint;
};
export type WorldWater = {
  surfaces: WorldWaterPolygon[];
  exclusions: WorldWaterPolygon[];
};
export type WorldLight = {
  id: string;
  /** Position of the flame or bulb, in logical world coordinates. */
  position: WorldPoint;
  kind: "lantern" | "torch" | "glow";
  radius: number;
  intensity: number;
  /** Opaque #rrggbb; brightness is controlled by intensity. */
  color: string;
  flicker: number;
};
export type FixedWorldScene = {
  schemaVersion: 1;
  id: string;
  width: number;
  height: number;
  terrain: WorldImage[];
  focus: WorldBounds;
  actor?: { spawn: WorldPoint; size: number };
  sites: FixedSite[];
  paths: WorldPath[];
  mushrooms?: WorldMushroom[];
  bushes?: WorldBush[];
  water?: WorldWater;
  lights?: WorldLight[];
  /** Absent means legacy routes; an explicitly empty area list permits no free walking. */
  navigation?: WorldNavigation;
  /** Absent retains legacy fauna; [] deliberately contains no inhabitants. */
  habitats?: WorldHabitat[];
};
export type PreviewLevels = Record<string, number>;
