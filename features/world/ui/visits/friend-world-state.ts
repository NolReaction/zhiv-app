import type { GuestWorld } from "@/features/people/guest-world-model";
import { economyCatalog } from "@/features/economy/domain/model";
import { newWorldState, type WorldState } from "@/features/world/domain/model";
import type { EconomySceneJourney } from "@/features/world/state/economy/economy-scene-state";
import type { EconomySceneConstruction } from "@/features/world/state/economy/economy-construction-state";
import type { EconomySceneProduction } from "@/features/world/state/economy/economy-production-state";
import type { EconomySceneResidents } from "@/features/world/state/economy/economy-residents-state";
import type { EconomySceneGarden, EconomySceneGardenOrder } from "@/features/world/state/economy/economy-garden-state";

const visibleDecorations = new Set(["flower", "leaf_bed", "keepsakes", "leaf_garland"]);

/** The public visit DTO is projected directly, never adopted as the visitor's account state. */
export function friendWorldScene(visit: GuestWorld) {
  const { world, user } = visit, ownerPublicId = user.publicId;
  const revision = Math.max(0, Date.parse(visit.serverTime));
  const state: WorldState = { ...newWorldState(), houseLevel: Math.max(1, Math.min(5, world.buildings.home ?? 1)),
    workshop: (world.buildings.workshop ?? 0) > 0, workshopLevel: world.buildings.workshop ?? 0,
    equipment: { ...world.equipment },
    hiddenGifts: world.hiddenGifts.filter(id => visibleDecorations.has(id)) as WorldState["hiddenGifts"],
    inventory: [], collection: [], journeys: [] };
  const construction: EconomySceneConstruction = { ownerPublicId, revision, jobs: world.jobs.flatMap(job =>
    job.kind === "construction" && job.targetLevel != null
      ? [{ id: job.id, stationId: job.targetId, targetLevel: job.targetLevel, startedAt: job.startedAt, finishesAt: job.finishesAt }] : []) };
  const production: EconomySceneProduction = { ownerPublicId, revision, jobs: world.jobs.flatMap(job =>
    job.kind === "production" ? [{ id: job.id, stationId: job.targetId, stationLevel: world.buildings[job.targetId] ?? 0,
      recipeId: job.recipeId ?? "quarry_legacy", startedAt: job.startedAt, finishesAt: job.finishesAt }] : []) };
  const residents: EconomySceneResidents = { ownerPublicId, revision, buildings: { ...world.buildings }, production: {
    ...production, jobs: [...production.jobs, ...world.jobs.filter(job => job.kind === "exploration" && job.actorId === "miner")
      .map(job => ({ id: job.id, stationId: "quarry", stationLevel: world.buildings.quarry ?? 0,
        recipeId: job.recipeId ?? job.targetId, startedAt: job.startedAt, finishesAt: job.finishesAt }))],
  } };
  const exploration = world.jobs.find(job => job.kind === "exploration" && job.actorId !== "miner");
  const journey: EconomySceneJourney | null = exploration ? { id: exploration.id, routeId: exploration.targetId,
    startedAt: exploration.startedAt, finishesAt: exploration.finishesAt,
    label: economyCatalog.explorations.find(route => route.id === exploration.targetId)?.name ?? "Вылазка" } : null;
  const crops = world.jobs.filter(job => job.kind === "production" && job.targetId === "garden")
    .sort((left, right) => Date.parse(left.finishesAt) - Date.parse(right.finishesAt) || left.id.localeCompare(right.id))
    .slice(0, 32).map((job): EconomySceneGardenOrder => ({ jobId: job.id,
      itemId: Object.keys(economyCatalog.recipes.find(recipe => recipe.id === job.recipeId)?.rewards ?? {})[0],
      startedAt: job.startedAt, finishesAt: job.finishesAt,
      ...(job.collection ? { collection: { startedAt: job.collection.startedAt, finishesAt: job.collection.finishesAt } } : {}) }));
  const selected = crops.find(crop => crop.collection?.startedAt) ?? crops[0];
  const garden: EconomySceneGarden | null = selected ? { ...selected, orders: crops } : null;
  return { state, gifts: [...world.gifts], buildings: { ...world.buildings }, construction, production, residents, journey, garden };
}

export function friendWorldStation(place: string) {
  return ({ house: "home", garden: "garden", campfire: "dryer", "lopukh-home": "woodlot" } as Record<string, string>)[place] ?? place;
}

/** The kiln lives inside the workshop artwork, so guests inspect both stations. */
export function friendWorldStations(place: string): readonly string[] {
  return place === "workshop" ? ["workshop", "kiln"] : [friendWorldStation(place)];
}

export function friendWorldJobName(job: GuestWorld["world"]["jobs"][number]) {
  if (job.kind === "construction") return `Улучшение до уровня ${job.targetLevel}`;
  return job.kind === "exploration" ? economyCatalog.explorations.find(route => route.id === job.targetId)?.name ?? "Вылазка"
    : economyCatalog.recipes.find(recipe => recipe.id === job.recipeId)?.name ?? "Производство";
}

export function friendWorldJobStatus(job: GuestWorld["world"]["jobs"][number], now: number) {
  const finish = Date.parse(job.collection?.finishesAt ?? job.finishesAt), seconds = Math.max(0, Math.ceil((finish - now) / 1000));
  if (!seconds) return job.kind === "construction" ? "Ожидает хозяина" : "Готово";
  const minutes = Math.ceil(seconds / 60);
  const time = seconds < 60 ? `${seconds} сек` : minutes < 60 ? `${minutes} мин` : `${Math.floor(minutes / 60)} ч${minutes % 60 ? ` ${minutes % 60} мин` : ""}`;
  return `${job.collection?.startedAt ? "Собирает урожай · " : "Осталось · "}${time}`;
}
