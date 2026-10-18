import type { ForestSessionState } from "@/features/world/state/forest-session";
import type { ForestSocialContext, ForestSocialContextEvent, ForestSocialFollowupRequest } from "@/features/world/characters/social/forest-social";
import { queueForestSocialWelcome } from "@/features/world/characters/social/forest-social-welcome";
import { forestLeaftailWindow } from "@/features/world/characters/social/forest-leaftail-window";
import { requestBuilderVisit, cancelBuilderVisit } from "@/features/world/characters/builder/builder-mind";
import { forestVillagerPlaces } from "@/features/world/characters/villagers/villager-navigation";
import { requestForestVillagerVisit, cancelForestVillagerVisit } from "@/features/world/characters/villagers/villager-mind";
import type { ResidentOccupant } from "@/features/world/navigation/resident-traffic";
import type { FixedWorldScene } from "@/features/world/tiled/types";
import { constructionMapPlace } from "./construction-map-anchor";

export type ResidentSceneFacts = {
  owner?: string; revision: number; buildings: Record<string, number>;
  jobs: Map<string, { finish: number; kind: "wood" | "mining" }>;
  minerWelcomeArmed?: boolean; observedWelcomes?: string[];
  fish: number; wood: number; sequence: number; events: ForestSocialContextEvent[];
};
const factsFor = (state: ForestSessionState): ResidentSceneFacts => state.residentSceneFacts ??= {
  revision: -1, buildings: {}, jobs: new Map(), fish: state.pleskMind?.catchCount ?? 0,
  wood: state.villagers?.residents.lopukh.woodwork?.completedCycles ?? 0, sequence: 0, events: [],
};

/** Observe actual new completions, never reinterpret a loaded inventory as a
 * fresh catch or building. IDs and this bounded history belong to one session. */
export function residentSceneSocialContext(state: ForestSessionState, now: number): ForestSocialContext {
  const facts = factsFor(state), access = state.economyResidents;
  const emit = (event: ForestSocialContextEvent) => { facts.events.push(event); facts.events = facts.events.slice(-8); };
  if (access && Number.isFinite(now)) {
    const first = facts.owner !== access.ownerPublicId;
    if (first) {
      facts.owner = access.ownerPublicId; facts.revision = -1; facts.jobs.clear(); facts.events = [];
      facts.fish = state.pleskMind?.catchCount ?? 0;
      facts.wood = state.villagers?.residents.lopukh.woodwork?.completedCycles ?? 0;
      facts.sequence = 0; facts.minerWelcomeArmed = false; facts.observedWelcomes = [];
    }
    if (access.revision > facts.revision) {
      if (!first) for (const [station, level] of Object.entries(access.buildings)) {
        if (level > (facts.buildings[station] ?? 0)) emit({ id: `build:${access.revision}:${station}:${level}`,
          kind: "construction", siteId: constructionMapPlace(station) ?? station, level });
      }
      facts.buildings = { ...access.buildings }; facts.revision = access.revision;
      for (const job of access.production.jobs) {
        const finish = Date.parse(job.finishesAt), start = Date.parse(job.startedAt);
        if (["woodlot", "quarry"].includes(job.stationId) && Number.isFinite(finish) && start <= now && now < finish)
          facts.jobs.set(job.id, { finish, kind: job.stationId === "woodlot" ? "wood" : "mining" });
      }
    }
    for (const [id, job] of facts.jobs) {
      if (!access.production.jobs.some(current => current.id === id)) { facts.jobs.delete(id); continue; }
      if (now >= job.finish) {
        emit({ id: `work:${id}`, kind: job.kind, speaker: job.kind === "wood" ? "lopukh" : "kamneshmyg" });
        facts.jobs.delete(id);
      }
    }
  }
  // Restore uses `complete` directly. Only an observed physical approach can
  // arm a miner welcome; boat restore has no real route. These session facts
  // survive camera handoffs, and never infer an arrival from house/quarry levels.
  const phase = state.villagers?.arrivalPhase;
  if (phase === "running" || phase === "greeting") facts.minerWelcomeArmed = true;
  const welcomed = facts.observedWelcomes ??= [];
  for (const resident of ["kamneshmyg", "leaftail"] as const) {
    const arrived = resident === "kamneshmyg" ? facts.minerWelcomeArmed && phase === "complete"
      : state.leaftailBoat?.completed && Boolean(state.leaftailBoat.route);
    if (!arrived || welcomed.includes(resident)) continue;
    welcomed.push(resident); queueForestSocialWelcome(state.social, resident);
  }
  const fish = state.pleskMind?.catchCount ?? 0, wood = state.villagers?.residents.lopukh.woodwork?.completedCycles ?? 0;
  if (fish > facts.fish) emit({ id: `catch:${++facts.sequence}`, kind: "fishing", speaker: "plesk" });
  if (wood > facts.wood) emit({ id: `delivery:${++facts.sequence}`, kind: "wood", speaker: "lopukh" });
  facts.fish = fish; facts.wood = wood;
  return { events: facts.events };
}

export function residentSceneFollowups(state: ForestSessionState, scene: FixedWorldScene,
  occupants: readonly ResidentOccupant[]) {
  const activeVisit = (speaker: "builder" | "lopukh") => speaker === "builder"
    ? state.builderMind?.socialVisit : state.villagers?.residents.lopukh.socialVisit;
  const ownsVisit = (speaker: "builder" | "lopukh") => state.social.followup?.speaker === speaker
    && activeVisit(speaker)?.targetId === `followup:${state.social.followup.id}`;
  return {
    requestFollowup(request: ForestSocialFollowupRequest): boolean {
      const id = `followup:${request.id}`;
      if (request.speaker === "builder" && request.kind === "inspect-window") {
        const window = forestLeaftailWindow(scene);
        return Boolean(window && requestBuilderVisit(state.builderMind, scene, { id, ...window }, occupants));
      }
      if (request.speaker === "lopukh" && request.kind === "check-woodpile" && state.villagers) {
        const places = forestVillagerPlaces(scene, "lopukh");
        const point = state.villagers.residents.lopukh.woodwork?.lastDelivery?.position ?? places?.woodcutting?.delivery[0]?.position;
        return Boolean(point && requestForestVillagerVisit(state.villagers, scene, "lopukh", {
          id, position: point, approach: point, size: 24,
        }, occupants));
      }
      return false;
    },
    followupStatus(speaker: "builder" | "lopukh"): "approach" | "arrived" | null {
      if (!ownsVisit(speaker)) return null;
      return (speaker === "builder" ? state.builderMind?.route : state.villagers?.residents.lopukh.route) ? "approach" : "arrived";
    },
    cancelFollowup(speaker: "builder" | "lopukh") {
      if (!ownsVisit(speaker)) return;
      if (speaker === "builder") cancelBuilderVisit(state.builderMind);
      else if (state.villagers) cancelForestVillagerVisit(state.villagers, "lopukh");
    },
  };
}
