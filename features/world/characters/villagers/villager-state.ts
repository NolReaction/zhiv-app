import type { PixelDirection } from "@/features/mochlik/pixel-sprite";
import type { ForestVillagerAction, ForestVillagerId } from "@/features/world/characters/forest-villager-types";
import type { SteeringPath } from "@/features/world/navigation/steering";
import type { ResidentOccupant } from "@/features/world/navigation/resident-traffic";
import type { EconomySceneProduction } from "@/features/world/state/economy/economy-production-state";
import type { FixedWorldScene, WorldPoint } from "@/features/world/tiled/types";
import type { VillagerDoor, VillagerStop } from "./villager-navigation";

export const FOREST_VILLAGER_LIMITS = { maxDelta: .5, greeting: 2.8, arrivalSpeed: 3, decisionSeconds: 9,
  trafficRetry: .8, visitSeconds: 18, movementSteps: 512 } as const;
export const FOREST_VILLAGER_IDS: readonly ForestVillagerId[] = ["lopukh", "kamneshmyg", "leaftail"];
export type ForestVillagerMind = {
  id: ForestVillagerId; available: boolean; initialized: boolean; position: WorldPoint; direction: PixelDirection;
  action: ForestVillagerAction; age: number; elapsed: number; walked: number; wait: number;
  route: SteeringPath | null; distance: number; speed: number; target: VillagerStop | null;
  intent: "work" | "home" | "wander" | "social" | "yield"; afterWalk: ForestVillagerAction;
  fatigue: number; socialNeed: number; workNeed: number; decisions: number; trafficWaiting: boolean; retryAt: number; stalledAt: number | null;
  doorPhase: "outside" | "approach" | "enter" | "inside" | "exit"; doorProgress: number; door: VillagerDoor | null;
  outdoorUntil: number; recentStops: string[];
  job: boolean; jobKey: string; socialVisit: { targetId: string; anchor: WorldPoint } | null; noticePending: boolean;
};
export type ForestVillagersState = {
  scene: FixedWorldScene; confirmed: boolean; buildings: Readonly<Record<string, number>>;
  residents: Record<ForestVillagerId, ForestVillagerMind>; production: EconomySceneProduction | null;
  arrivalPending: boolean; arrivalPhase: "waiting" | "running" | "greeting" | "complete"; arrivalCompleted: boolean;
};
export type ForestVillagerConfiguration = {
  buildings: Readonly<Record<string, number>>; confirmed: boolean; arrivalSeen?: boolean; allowArrival?: boolean;
  production?: EconomySceneProduction | null; now?: number;
};
export type ForestVillagerEnvironment = {
  rain?: boolean | number; dusk?: boolean | number; occupants?: readonly ResidentOccupant[];
  socialHolds?: readonly ForestVillagerId[]; production?: EconomySceneProduction | null; now?: number;
  /** The promised visitor and host never ask one another to clear their meeting. */
  socialPartners?: Partial<Record<ForestVillagerId, string>>;
  /** The map owns this spotlight; closing it pauses only the miner's entrance. */
  arrivalActive?: boolean;
  wildlifeHolds?: readonly ForestVillagerId[];
};

/** Dawn/night blends and the first raindrops do not cancel an outing. */
export const villagerShelterWeather = (env: Pick<ForestVillagerEnvironment, "rain" | "dusk">): boolean =>
  (typeof env.rain === "boolean" ? env.rain : (env.rain ?? 0) >= .24)
  || (typeof env.dusk === "boolean" ? env.dusk : (env.dusk ?? 0) >= .6);
