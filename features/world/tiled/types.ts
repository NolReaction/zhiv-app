/** Runtime contract compiled from the deliberately small Tiled authoring subset. */
export type WorldPoint = { x: number; y: number };
export type WorldBounds = WorldPoint & { width: number; height: number };
export type WorldImage = { id: string; image: string; bounds: WorldBounds };
export type SiteVisual = { level: number; label: string; image: string };
export type FixedSite = {
  id: string;
  label: string;
  bounds: WorldBounds;
  anchor: WorldPoint;
  entry: WorldPoint;
  /** Optional foot position on the visible threshold, beyond the outside entry. */
  doorway?: WorldPoint;
  hitArea: WorldPoint[];
  collision: WorldPoint[];
  light?: WorldPoint;
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
  activity?: "look" | "sniff" | "groom" | "rest";
  /** Time at the outward endpoint, from 2 to 20 seconds. */
  pauseSeconds?: number;
};
export type WorldWaterPolygon = { id: string; points: WorldPoint[] };
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
  water?: WorldWater;
  lights?: WorldLight[];
};
export type PreviewLevels = Record<string, number>;
