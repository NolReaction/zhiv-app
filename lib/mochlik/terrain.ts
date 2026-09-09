import type { WorldState } from "@/features/world/model";
import { workshopLevel } from "@/features/world/model";
import { loadHabitatImage } from "./assets";
import { loadHouseArt, HOUSE_ART } from "./house-details";
import { loadWorkshopArt } from "./workshop-art";

export const MAP_SIZE = 1536;
export const HOME_AREA = { x: 576, y: 576, size: 384 };
export const WORKSHOP_AREA = { x: 335, y: 875, width: 190, height: 180 };
export const TERRAIN_PATH = "/world/forest-map-v2.webp";
export const habitatPoint = (x: number, y: number) => ({ x: HOME_AREA.x + x / 256 * HOME_AREA.size, y: HOME_AREA.y + y / 256 * HOME_AREA.size });
export const WEATHER_BOUNDS = { x: -HOME_AREA.x * 256 / HOME_AREA.size, y: -HOME_AREA.y * 256 / HOME_AREA.size, width: MAP_SIZE * 256 / HOME_AREA.size, height: MAP_SIZE * 256 / HOME_AREA.size };

export async function loadTerrainArt() {
  const [ground, homes, workshops] = await Promise.all([loadHabitatImage(TERRAIN_PATH), loadHouseArt(), loadWorkshopArt()]);
  return { ground, homes, workshops };
}
export type TerrainArt = Awaited<ReturnType<typeof loadTerrainArt>>;
let cached: { key: string; canvas: HTMLCanvasElement } | null = null;

/** One terrain image for both cameras. No habitat background is pasted onto it. */
export function terrainSurface(art: TerrainArt, state?: WorldState): HTMLCanvasElement {
  const level = Math.max(1, Math.min(5, state?.houseLevel ?? 1));
  const workshop = state?.workshop ? workshopLevel(state) : 0;
  const key = `${level}:${workshop}`;
  if (cached?.key === key) return cached.canvas;
  const canvas = document.createElement("canvas"); canvas.width = canvas.height = MAP_SIZE;
  const ctx = canvas.getContext("2d")!; ctx.imageSmoothingEnabled = false;
  ctx.drawImage(art.ground, 0, 0, MAP_SIZE, MAP_SIZE);
  if (workshop) {
    const sprite = art.workshops[workshop - 1];
    const height = WORKSHOP_AREA.width * sprite.height / sprite.width;
    ctx.drawImage(sprite, WORKSHOP_AREA.x, WORKSHOP_AREA.y + WORKSHOP_AREA.height - height, WORKSHOP_AREA.width, height);
  }
  // Keep the house on the same logical pixel grid as its animated inhabitants.
  const home = document.createElement("canvas"); home.width = home.height = 256;
  const homeContext = home.getContext("2d")!; homeContext.imageSmoothingEnabled = false;
  homeContext.drawImage(art.homes[level - 1], HOUSE_ART.x, HOUSE_ART.y, HOUSE_ART.width, HOUSE_ART.height);
  ctx.drawImage(home, HOME_AREA.x, HOME_AREA.y, HOME_AREA.size, HOME_AREA.size);
  cached = { key, canvas }; return canvas;
}
