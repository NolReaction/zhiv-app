import type { PixelDirection, PixelPose } from "@/features/mochlik/pixel-sprite";
import type { PleskAction } from "../plesk-resident";
import type { BuilderAction } from "../builder-types";
import type { CookingAction } from "../forest-cooking";
import { TILED_WORLD } from "../presentation";
import { initialPreviewLevels } from "../tiled/preview-state";

export const WORLD_DEV_ENABLED = process.env.NODE_ENV === "development";
export type WorldDevCameraAction = "in" | "out" | "overview" | "pet" | "plesk" | "builder" | "fishing";
export type WorldDevLifeAction = "butterfly" | "firefly" | "mushroom" | "leaf" | "bush" | "home-sleep" | "wake" | "grow-mushrooms" | "water-bush" | "harvest-berries" | "grow-berries" | "watch-birds" | "campfire" | "idle";

export const WORLD_DEV_SCENARIOS = [
  { id: "plesk", label: "Плёска у пирса", description: "Плёска показывает снасти, заброс, ожидание, улов и отдых. Свободное поведение выбирает её внутренний AI." },
  { id: "fishing", label: "Мохлик на рыбалке", description: "Полный тестовый выход: путь к берегу, заброс, поклёвка, улов и возвращение. Без заданий и наград аккаунта." },
  { id: "birds", label: "Птицы на полянке", description: "Ясный день и пара птиц: посадка, реакция на близкие шаги, взлёт." },
  { id: "ground-birds", label: "Птицы на земле", description: "Посадка на свободную землю, короткие прыжки, поиск корма и настороженность рядом с Мохликом." },
  { id: "campfire", label: "Вечер у костра", description: "Сухой очаг и ночь: огонь разгорается, Мохлик подходит и отдыхает рядом." },
  { id: "rain", label: "Дождливый вечер", description: "Ливень и ночь: костёр затухает, обитатели ищут укрытия." },
  { id: "tired", label: "Уставший Мохлик", description: "Тестовая усталость вечером: наблюдаем выбор отдыха и пути домой." },
] as const;
export type WorldDevScenario = typeof WORLD_DEV_SCENARIOS[number]["id"];

export const WORLD_DEV_RESIDENT_ACTIONS = Object.freeze([
  "idle", "walk", "cast", "fish", "bite", "reel", "catch", "pack", "trade", "rest", "greet",
] as const satisfies readonly PleskAction[]);
export type WorldDevResidentPreview = Readonly<{
  id: number; action: "routine" | PleskAction; direction: PixelDirection; repeat: boolean;
}>;
export const WORLD_DEV_BUILDER_ACTIONS = Object.freeze([
  "idle", "walk", "work", "inspect", "finish", "greet",
] as const satisfies readonly BuilderAction[]);
export type WorldDevBuilderPreview = Readonly<{
  id: number; action: BuilderAction; direction: PixelDirection; repeat: boolean;
}>;
export const WORLD_DEV_COOKING_ACTIONS = ["sequence", "prepare", "stir", "taste", "serve"] as const;
export type WorldDevCookingPreview = Readonly<{ id: number; action: "sequence" | CookingAction; repeat: boolean }>;

export const WORLD_DEV_POSES = Object.freeze([
  "idle", "walk", "blink", "sleep", "drowsy", "stretch", "crouch", "jump", "groom", "greet",
  "sniff", "reach", "hold", "chew", "swallow", "scratch", "yawn", "shake", "sneeze", "wonder",
  "carry", "toss", "present", "fish", "fishing-walk",
] as const satisfies readonly PixelPose[]);

export type WorldDevState = Readonly<{
  weather: "auto" | "clear" | "drizzle" | "rain" | "downpour";
  timeOfDay: "auto" | "day" | "night";
  butterflies: "auto" | "on" | "off";
  fireflies: "auto" | "on" | "off";
  birds: "auto" | "on" | "off";
  waterFish: "auto" | "on" | "off";
  waterBreeze: boolean;
  waterSurface: boolean;
  waterWind: "auto" | "calm" | "breeze" | "windy";
  autoLife: boolean;
  navigationMode: "auto" | "routes";
  puddles: boolean;
  paused: boolean;
  reducedMotion: "auto" | "on" | "off";
  pose: "auto" | PixelPose;
  direction: PixelDirection;
  residentDirection: PixelDirection;
  residentPreview: WorldDevResidentPreview | null;
  builderDirection: PixelDirection;
  builderPreview: WorldDevBuilderPreview | null;
  cookingPreview: WorldDevCookingPreview | null;
  heroScale: number;
  showHero: boolean;
  showBuildings: boolean;
  heroShadow: boolean;
  buildingShadow: boolean;
  previewBuildings: boolean;
  debug: boolean;
  debugWater: boolean;
  debugNavigation: boolean;
  debugFauna: boolean;
  levels: Readonly<Record<string, number>>;
  equipment: Readonly<{ palette: string; head: string | null; neck: string | null }> | null;
  animation: Readonly<{ id: number; pose: PixelPose }> | null;
  lifeEvent: Readonly<{ id: number; kind: WorldDevLifeAction }> | null;
  birdEvent: number;
  scenarioEvent: Readonly<{ id: number; kind: WorldDevScenario }> | null;
  cameraEvent: Readonly<{ id: number; action: WorldDevCameraAction }> | null;
  artError: string | null;
}>;

export const WORLD_DEV_DEFAULTS: WorldDevState = Object.freeze({
  weather: "auto", timeOfDay: "auto", butterflies: "auto", fireflies: "auto", birds: "auto", waterFish: "auto", waterBreeze: true,
  waterSurface: true, waterWind: "auto",
  autoLife: true, navigationMode: "auto", puddles: true,
  paused: false, reducedMotion: "auto", pose: "auto", direction: "front", heroScale: 1,
  residentDirection: "front", residentPreview: null, cookingPreview: null,
  builderDirection: "front", builderPreview: null,
  showHero: true, showBuildings: true, heroShadow: true, buildingShadow: true,
  previewBuildings: false,
  debug: false, debugWater: false, debugNavigation: false, debugFauna: false,
  levels: Object.freeze(initialPreviewLevels(TILED_WORLD)), equipment: null,
  animation: null, lifeEvent: null, birdEvent: 0, scenarioEvent: null, cameraEvent: null, artError: null,
});

const enumValues = {
  weather: ["auto", "clear", "drizzle", "rain", "downpour"],
  timeOfDay: ["auto", "day", "night"],
  butterflies: ["auto", "on", "off"], fireflies: ["auto", "on", "off"], birds: ["auto", "on", "off"],
  waterFish: ["auto", "on", "off"],
  waterWind: ["auto", "calm", "breeze", "windy"],
  reducedMotion: ["auto", "on", "off"], pose: ["auto", ...WORLD_DEV_POSES],
  navigationMode: ["auto", "routes"],
  direction: ["front", "back", "left", "right"],
  residentDirection: ["front", "back", "left", "right"],
  builderDirection: ["front", "back", "left", "right"],
} as const;
const booleanKeys = ["paused", "autoLife", "puddles", "waterBreeze", "waterSurface", "showHero", "showBuildings", "heroShadow", "buildingShadow", "previewBuildings", "debug", "debugWater", "debugNavigation", "debugFauna"] as const;
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const isPose = (value: unknown): value is PixelPose => WORLD_DEV_POSES.some(pose => pose === value);
const isResidentAction = (value: unknown): value is "routine" | PleskAction => value === "routine"
  || WORLD_DEV_RESIDENT_ACTIONS.some(action => action === value);
const isLifeAction = (value: unknown): value is WorldDevLifeAction => ["butterfly", "firefly", "mushroom", "leaf", "bush", "home-sleep", "wake", "grow-mushrooms", "water-bush", "harvest-berries", "grow-berries", "watch-birds", "campfire", "idle"].some(kind => kind === value);

/** Ephemeral visual overrides only; this store never touches player progress or storage. */
export function createWorldDevStore(enabled: boolean) {
  let state = WORLD_DEV_DEFAULTS;
  let animationId = 0, lifeEventId = 0, birdEventId = 0, cameraEventId = 0, scenarioEventId = 0, residentEventId = 0, cookingEventId = 0, builderEventId = 0;
  const listeners = new Set<() => void>();
  const publish = (next: WorldDevState) => {
    if (!enabled || next === state) return;
    state = Object.freeze(next);
    for (const listener of [...listeners]) listener();
  };

  return {
    getSnapshot: () => state,
    getServerSnapshot: () => WORLD_DEV_DEFAULTS,
    subscribe(listener: () => void) {
      if (!enabled) return () => {};
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    patch(patch: Partial<WorldDevState>) {
      if (!enabled || !isRecord(patch)) return;
      const next = { ...state };
      for (const key of Object.keys(enumValues) as (keyof typeof enumValues)[]) {
        const value = patch[key];
        if (enumValues[key].some(option => option === value)) Object.assign(next, { [key]: value });
      }
      for (const key of booleanKeys) if (typeof patch[key] === "boolean") next[key] = patch[key];
      if (typeof patch.heroScale === "number" && Number.isFinite(patch.heroScale)) {
        next.heroScale = Math.max(.5, Math.min(2, patch.heroScale));
      }
      // Events may be cancelled here, but only the trigger methods can create them.
      if (patch.animation === null) next.animation = null;
      if (patch.residentPreview === null) next.residentPreview = null;
      if (patch.builderPreview === null) next.builderPreview = null;
      if (patch.cookingPreview === null || isPose(patch.pose)) next.cookingPreview = null;
      if (next.residentPreview && next.residentDirection !== state.residentDirection) {
        next.residentPreview = Object.freeze({ ...next.residentPreview, direction: next.residentDirection });
      }
      if (next.builderPreview && next.builderDirection !== state.builderDirection) {
        next.builderPreview = Object.freeze({ ...next.builderPreview, direction: next.builderDirection });
      }
      if (patch.lifeEvent === null || isPose(patch.pose)) next.lifeEvent = null;
      if (isRecord(patch.levels)) {
        const levels = Object.fromEntries(TILED_WORLD.sites.map(site => {
          const level = patch.levels![site.id];
          return [site.id, site.states.some(visual => visual.level === level) ? level : state.levels[site.id]];
        }));
        if (Object.keys(levels).some(id => levels[id] !== state.levels[id])) {
          next.levels = Object.freeze(levels); next.previewBuildings = true;
        }
      }
      if (patch.previewBuildings === false) { next.previewBuildings = false; next.levels = WORLD_DEV_DEFAULTS.levels; }
      const equipment = patch.equipment;
      if (equipment === null) next.equipment = null;
      else if (isRecord(equipment) && typeof equipment.palette === "string"
        && (equipment.head === null || typeof equipment.head === "string")
        && (equipment.neck === null || typeof equipment.neck === "string")) {
        if (!state.equipment || equipment.palette !== state.equipment.palette || equipment.head !== state.equipment.head
          || equipment.neck !== state.equipment.neck) {
          next.equipment = Object.freeze({ palette: equipment.palette, head: equipment.head, neck: equipment.neck });
        }
      }
      if ((Object.keys(next) as (keyof WorldDevState)[]).some(key => next[key] !== state[key])) publish(next);
    },
    reset() { publish(WORLD_DEV_DEFAULTS); },
    triggerPose(pose: PixelPose) {
      if (enabled && isPose(pose)) publish({ ...state, lifeEvent: null, cookingPreview: null, animation: Object.freeze({ id: ++animationId, pose }) });
    },
    triggerLife(kind: WorldDevLifeAction) {
      if (enabled && isLifeAction(kind)) publish({ ...state, animation: null, pose: "auto", cookingPreview: null,
        autoLife: kind === "idle" ? false : kind === "home-sleep" ? true : state.autoLife,
        lifeEvent: Object.freeze({ id: ++lifeEventId, kind }) });
    },
    triggerScenario(kind: WorldDevScenario) {
      if (!enabled || !WORLD_DEV_SCENARIOS.some(item => item.id === kind)) return;
      if (kind === "plesk") {
        publish({ ...state, paused: false, weather: "clear", timeOfDay: "day",
          residentPreview: Object.freeze({ id: ++residentEventId, action: "routine", direction: state.residentDirection, repeat: true }),
          scenarioEvent: Object.freeze({ id: ++scenarioEventId, kind }),
          cameraEvent: Object.freeze({ id: ++cameraEventId, action: "plesk" }) });
        return;
      }
      publish({ ...state, paused: false, pose: "auto", animation: null, lifeEvent: null, cookingPreview: null,
        autoLife: true, navigationMode: "auto", showHero: true, showBuildings: true,
        weather: kind === "rain" ? "downpour" : "clear", timeOfDay: kind === "birds" || kind === "ground-birds" || kind === "fishing" ? "day" : "night",
        butterflies: "auto", fireflies: "auto", birds: "auto",
        cameraEvent: kind === "fishing" ? Object.freeze({ id: ++cameraEventId, action: "fishing" as const }) : state.cameraEvent,
        scenarioEvent: Object.freeze({ id: ++scenarioEventId, kind }) });
    },
    triggerResident(action: "routine" | PleskAction, repeat = false) {
      if (!enabled || !isResidentAction(action) || typeof repeat !== "boolean") return;
      publish({ ...state,
        residentPreview: Object.freeze({ id: ++residentEventId, action, direction: state.residentDirection, repeat }),
        cameraEvent: Object.freeze({ id: ++cameraEventId, action: "plesk" }) });
    },
    triggerCooking(action: WorldDevCookingPreview["action"], repeat = false) {
      if (!enabled || !WORLD_DEV_COOKING_ACTIONS.some(value => value === action) || typeof repeat !== "boolean") return;
      publish({ ...state, pose: "auto", animation: null, lifeEvent: null, scenarioEvent: null,
        cookingPreview: Object.freeze({ id: ++cookingEventId, action, repeat }),
        cameraEvent: Object.freeze({ id: ++cameraEventId, action: "pet" }) });
    },
    triggerBuilder(action: BuilderAction, repeat = false) {
      if (!enabled || !WORLD_DEV_BUILDER_ACTIONS.some(value => value === action) || typeof repeat !== "boolean") return;
      publish({ ...state,
        builderPreview: Object.freeze({ id: ++builderEventId, action, direction: state.builderDirection, repeat }),
        cameraEvent: Object.freeze({ id: ++cameraEventId, action: "builder" }) });
    },
    triggerBirds() {
      if (enabled) publish({ ...state, birdEvent: ++birdEventId });
    },
    triggerCamera(action: WorldDevCameraAction) {
      if (enabled && ["in", "out", "overview", "pet", "plesk", "builder", "fishing"].some(option => option === action)) {
        publish({ ...state, cameraEvent: Object.freeze({ id: ++cameraEventId, action }) });
      }
    },
    reportArtError(error: string | null) {
      if (enabled && (error === null || typeof error === "string") && error !== state.artError) publish({ ...state, artError: error });
    },
  };
}

export const worldDevStore = createWorldDevStore(WORLD_DEV_ENABLED);
