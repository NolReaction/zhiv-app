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
  hitArea: WorldPoint[];
  collision: WorldPoint[];
  light?: WorldPoint;
  initialLevel: number;
  states: SiteVisual[];
};
export type WorldPath = { id: string; points: WorldPoint[] };
export type WorldWaterPolygon = { id: string; points: WorldPoint[] };
export type WorldWater = {
  surfaces: WorldWaterPolygon[];
  exclusions: WorldWaterPolygon[];
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
};
export type PreviewLevels = Record<string, number>;
