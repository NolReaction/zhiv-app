import type { BoatVisualLevels } from "@/features/world/objects/fishing-boat/fishing-boat-artwork";

/** Presentation-only input. Reel positions use the existing 0..10000 integer scale. */
export type FishingSceneFrame = {
  stage: "waiting" | "casting" | "soaking" | "landed" | "bite" | "reeling" | "paused" | "caught" | "escaped" | "expired" | "pending";
  castKey?: string;
  castPower?: number;
  aiming?: boolean;
  /** Cosmetic composition stays stable for one saved voyage. */
  sceneKey?: string;
  resistance?: "steady" | "sprightly" | "surging" | "stubborn";
  /** Public phase of the deterministic reel, never a second gameplay clock. */
  resistancePhase?: "cruising" | "preparing" | "surging" | "recovering";
  fishRarity?: "common" | "uncommon" | "rare" | "epic" | "legendary";
  /** Exact species is supplied only for a confirmed catch. */
  fishId?: string;
  /** Derived from the confirmed catch's actual weight; never sent for a hidden fish. */
  fishSizeScale?: number;
  catchKey?: string;
  biteLeadSeconds?: number;
  ambience?: { now: number; timeZone: string };
  held: boolean;
  reel?: { bar: number; fish: number; progress: number; zoneWidth: number; velocity?: number };
  boat: { repaired: boolean; modules?: BoatVisualLevels; upgrades: readonly string[] };
  rodId?: string;
  appearance?: { palette: string; head: string | null; neck: string | null };
};

export type FishingSceneViewport = { width: number; height: number; dpr: number };
export type FishingActorPose = { angle: number; effort: number; lean: number };
export type FishingSceneBoatMotion = { bob: number; roll: number; surge: number };
export type FishingSceneVisual = { elapsed: number; castElapsed: number; stageElapsed: number; still: boolean; pose?: FishingActorPose;
  boatMotion?: FishingSceneBoatMotion };
export type FishingScenePoint = { x: number; y: number };

/** Authored in the same 1000×650 assembly space as the replaceable boat parts. */
export const FISHING_SCENE_RIG = {
  reference: { width: 1600, height: 900 },
  boat: { minimumWidth: 570, maximumWidth: 750, marginRatio: .035, surfaceRatio: .43 },
  actor: { foot: { x: 600, y: 384 }, size: 216, pivot: { x: 24, y: 44 } },
  hands: { grip: { x: 515, y: 382 }, reel: { x: 490, y: 408 },
    nearShoulder: { x: 464, y: 396 }, nearElbow: { x: 489, y: 412 },
    farShoulder: { x: 422, y: 402 }, farElbow: { x: 456, y: 425 } },
  rod: { tip: { x: 850, y: 108 }, size: 285 },
  cast: { flightSeconds: 1.2, splashSeconds: .65 },
  layers: ["map-water", "water-life", "water-events", "confirmed-catch", "displacement", "boat-back", "mochlik", "boat-front", "rod", "line", "float"],
} as const;
