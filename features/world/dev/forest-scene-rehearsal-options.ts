import type { SceneOptions } from "@/features/mochlik/scene";
import { normalizeWorldDevSceneRequest, type WorldDevSceneRequest } from "./forest-scene-preview";

const optionTimes = new WeakMap<WorldDevSceneRequest, number>();

/** A separate DEV presence owns synthetic presentation DTOs. No callback,
 * inventory, command transport or real player's worker enters this session. */
export function rehearsalSceneOptions(original: SceneOptions, request: WorldDevSceneRequest): SceneOptions {
  const normalized = normalizeWorldDevSceneRequest(request);
  if (!normalized) return original;
  let now = optionTimes.get(request);
  if (now === undefined) {
    now = Number.isFinite(original.serverNow) ? original.serverNow! : Date.now(); optionTimes.set(request, now);
  }
  const ownerPublicId = `dev-scene-${request.id}`, revision = request.id;
  const buildings = { ...original.economyBuildings, home: Math.max(3, original.economyBuildings?.home ?? 0), quarry: 1, woodlot: Math.max(1, original.economyBuildings?.woodlot ?? 0), workshop: Math.max(1, original.economyBuildings?.workshop ?? 0) };
  const jobs = request.scenario === "work" && (request.actor === "kamneshmyg" || request.actor === "lopukh")
    ? [{ id: `dev-work-${request.id}`, stationId: request.actor === "kamneshmyg" ? "quarry" : "woodlot", stationLevel: 1,
      recipeId: request.actor === "kamneshmyg" ? "quarry_stone" : "woodlot_wood",
      startedAt: new Date(now).toISOString(), finishesAt: new Date(now + 120_000).toISOString() }] : [];
  const production = { ownerPublicId, revision, jobs };
  return { ...original, serverNow: now, presenceKey: `dev:scene:${request.id}`, view: "world", devRehearsal: normalized,
    economyBuildings: buildings, economyProduction: production, economyResidents: { ownerPublicId, revision, buildings, production },
    economyConstruction: { ownerPublicId, revision, jobs: request.scenario === "work" && request.actor === "builder"
      ? [{ id: `dev-build-${request.id}`, stationId: "workshop", targetLevel: 2,
        startedAt: new Date(now).toISOString(), finishesAt: new Date(now + 120_000).toISOString() }] : [] },
    economyJourney: null, cancelledExplorations: [], economyGarden: null, gardenHarvestRequest: null, onGardenHarvestEvent: undefined,
    residentArrival: { seen: true, enabled: false, onComplete() {} },
    lopukhArrival: { seen: true, enabled: false, onComplete() {} },
    merchantArrival: { seen: request.scenario !== "leaftail-arrival", enabled: request.scenario === "leaftail-arrival", onComplete() {} } };
}
