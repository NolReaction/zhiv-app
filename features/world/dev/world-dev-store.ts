import type { PixelDirection, PixelPose } from "@/features/mochlik/pixel-sprite";
import { TILED_WORLD } from "../presentation";
import { initialPreviewLevels } from "../tiled/preview-state";

export const WORLD_DEV_ENABLED = process.env.NODE_ENV === "development";
export type WorldDevCameraAction = "in" | "out" | "overview" | "pet";
export type WorldDevLifeAction = "butterfly" | "firefly" | "mushroom" | "leaf" | "bush" | "home-sleep" | "wake" | "grow-mushrooms" | "idle";

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
  autoLife: boolean;
  puddles: boolean;
  paused: boolean;
  reducedMotion: "auto" | "on" | "off";
  pose: "auto" | PixelPose;
  direction: PixelDirection;
  heroScale: number;
  showHero: boolean;
  showBuildings: boolean;
  heroShadow: boolean;
  buildingShadow: boolean;
  debug: boolean;
  debugWater: boolean;
  levels: Readonly<Record<string, number>>;
  equipment: Readonly<{ palette: string; head: string | null; neck: string | null }> | null;
  animation: Readonly<{ id: number; pose: PixelPose }> | null;
  lifeEvent: Readonly<{ id: number; kind: WorldDevLifeAction }> | null;
  birdEvent: number;
  cameraEvent: Readonly<{ id: number; action: WorldDevCameraAction }> | null;
  artError: string | null;
}>;

export const WORLD_DEV_DEFAULTS: WorldDevState = Object.freeze({
  weather: "auto", timeOfDay: "auto", butterflies: "auto", fireflies: "auto", birds: "auto",
  autoLife: true, puddles: true,
  paused: false, reducedMotion: "auto", pose: "auto", direction: "front", heroScale: 1,
  showHero: true, showBuildings: true, heroShadow: true, buildingShadow: true, debug: false, debugWater: false,
  levels: Object.freeze(initialPreviewLevels(TILED_WORLD)), equipment: null,
  animation: null, lifeEvent: null, birdEvent: 0, cameraEvent: null, artError: null,
});

const enumValues = {
  weather: ["auto", "clear", "drizzle", "rain", "downpour"],
  timeOfDay: ["auto", "day", "night"],
  butterflies: ["auto", "on", "off"], fireflies: ["auto", "on", "off"], birds: ["auto", "on", "off"],
  reducedMotion: ["auto", "on", "off"], pose: ["auto", ...WORLD_DEV_POSES],
  direction: ["front", "back", "left", "right"],
} as const;
const booleanKeys = ["paused", "autoLife", "puddles", "showHero", "showBuildings", "heroShadow", "buildingShadow", "debug", "debugWater"] as const;
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const isPose = (value: unknown): value is PixelPose => WORLD_DEV_POSES.some(pose => pose === value);
const isLifeAction = (value: unknown): value is WorldDevLifeAction => ["butterfly", "firefly", "mushroom", "leaf", "bush", "home-sleep", "wake", "grow-mushrooms", "idle"].some(kind => kind === value);

/** Ephemeral visual overrides only; this store never touches player progress or storage. */
export function createWorldDevStore(enabled: boolean) {
  let state = WORLD_DEV_DEFAULTS;
  let animationId = 0, lifeEventId = 0, birdEventId = 0, cameraEventId = 0;
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
      if (patch.lifeEvent === null || isPose(patch.pose)) next.lifeEvent = null;
      if (isRecord(patch.levels)) {
        const levels = Object.fromEntries(TILED_WORLD.sites.map(site => {
          const level = patch.levels![site.id];
          return [site.id, site.states.some(visual => visual.level === level) ? level : state.levels[site.id]];
        }));
        if (Object.keys(levels).some(id => levels[id] !== state.levels[id])) next.levels = Object.freeze(levels);
      }
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
      if (enabled && isPose(pose)) publish({ ...state, lifeEvent: null, animation: Object.freeze({ id: ++animationId, pose }) });
    },
    triggerLife(kind: WorldDevLifeAction) {
      if (enabled && isLifeAction(kind)) publish({ ...state, animation: null, pose: "auto",
        autoLife: kind === "idle" ? false : kind === "home-sleep" ? true : state.autoLife,
        lifeEvent: Object.freeze({ id: ++lifeEventId, kind }) });
    },
    triggerBirds() {
      if (enabled) publish({ ...state, birdEvent: ++birdEventId });
    },
    triggerCamera(action: WorldDevCameraAction) {
      if (enabled && ["in", "out", "overview", "pet"].some(option => option === action)) {
        publish({ ...state, cameraEvent: Object.freeze({ id: ++cameraEventId, action }) });
      }
    },
    reportArtError(error: string | null) {
      if (enabled && (error === null || typeof error === "string") && error !== state.artError) publish({ ...state, artError: error });
    },
  };
}

export const worldDevStore = createWorldDevStore(WORLD_DEV_ENABLED);
