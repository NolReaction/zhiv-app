import { pixelSprite, type PixelDirection, type PixelPose } from "@/features/mochlik/pixel-sprite";
import { pleskSprite } from "@/features/world/characters/plesk/plesk-sprite";
import type { PleskAction } from "@/features/world/characters/plesk/plesk-resident";
import { builderSprite } from "@/features/world/characters/builder/builder-sprite";
import type { BuilderAction } from "@/features/world/characters/builder/builder-types";
import { lopukhSprite } from "@/features/world/characters/lopukh/lopukh-sprite";
import { kamneshmygSprite } from "@/features/world/characters/kamneshmyg/kamneshmyg-sprite";
import { leaftailSprite } from "@/features/world/characters/leaftail/leaftail-sprite";
import type { ForestVillagerAction } from "@/features/world/characters/forest-villager-types";
import type { WorldDevSceneActor } from "./forest-scene-preview";

export const RESIDENT_STAND_DIRECTIONS = ["front", "back", "left", "right"] as const satisfies readonly PixelDirection[];
export const RESIDENT_STAND_ACTIONS = {
  mochlik: ["idle", "walk", "blink", "sleep", "stretch", "greet", "sniff", "carry", "fish"],
  plesk: ["idle", "walk", "cast", "fish", "bite", "reel", "catch", "pack", "trade", "rest", "greet"],
  builder: ["idle", "walk", "work", "inspect", "finish", "greet"],
  lopukh: ["idle", "walk", "work", "carry", "unload", "inspect", "greet", "rest"],
  kamneshmyg: ["idle", "walk", "work", "inspect", "greet", "rest"],
  leaftail: ["idle", "walk", "trade", "inspect", "greet", "rest"],
} as const;
export const RESIDENT_STAND_LABELS: Record<string, string> = {
  idle: "Покой", walk: "Ходьба", blink: "Моргание", sleep: "Сон", stretch: "Потянуться", greet: "Приветствие",
  sniff: "Принюхаться", carry: "Переноска", fish: "Рыбалка", cast: "Заброс", bite: "Поклёвка", reel: "Вытягивание",
  catch: "Улов", pack: "Уложить рыбу", trade: "Торговля", rest: "Отдых", work: "Работа", inspect: "Осмотр", finish: "Завершение", unload: "Разгрузка",
};
export const RESIDENT_STAND_FRAMES = 32;

/** A local integer clock makes pause/step exact, independently of the world,
 * request IDs, wall time and the user's account. Hidden time is discarded. */
export function advanceResidentStand(frame: number, delta: number, speed: number, paused: boolean, hidden: boolean): number {
  if (paused || hidden || !Number.isFinite(delta) || delta <= 0 || ![.25, .5, 1].includes(speed)) return frame;
  return (frame + Math.min(.1, delta) * 8 * speed) % RESIDENT_STAND_FRAMES;
}
export function stepResidentStand(frame: number, direction: 1 | -1): number {
  return ((Math.floor(frame) + direction) % RESIDENT_STAND_FRAMES + RESIDENT_STAND_FRAMES) % RESIDENT_STAND_FRAMES;
}

/** The stand calls the very same cached raster rigs as the map. It never
 * edits natural mind state or injects a synthetic route into the world. */
export function residentStandSprite(actor: WorldDevSceneActor, action: string, direction: PixelDirection, frame: number): HTMLCanvasElement {
  const safe = (RESIDENT_STAND_ACTIONS[actor] as readonly string[]).includes(action) ? action : "idle";
  const index = Math.floor(frame) % RESIDENT_STAND_FRAMES, phase = index / (RESIDENT_STAND_FRAMES - 1);
  if (actor === "mochlik") return pixelSprite(safe as PixelPose, direction, Math.floor(index / 2));
  if (actor === "plesk") return pleskSprite(safe as PleskAction, direction, index, phase);
  if (actor === "builder") return builderSprite(safe as BuilderAction, direction, index, phase);
  return { lopukh: lopukhSprite, kamneshmyg: kamneshmygSprite, leaftail: leaftailSprite }[actor](safe as ForestVillagerAction, direction, index, phase);
}
