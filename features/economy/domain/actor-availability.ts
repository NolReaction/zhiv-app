import { economyCatalog, type EconomyCatalog, type EconomyCommand, type EconomyJob } from "./model";

export function explorationActorId(route: { activity?: string | null }): "miner" | "mochlik" {
  return route.activity === "mining" ? "miner" : "mochlik";
}
/** Saved ownership is authoritative; missing legacy metadata always belongs to Mochlik. */
export function isMinerJob(job: Pick<EconomyJob, "kind" | "actorId">): boolean {
  return job.kind === "exploration" && job.actorId === "miner";
}
export function jobActorId(job: Pick<EconomyJob, "kind" | "actorId">): "miner" | "mochlik" {
  return isMinerJob(job) ? "miner" : "mochlik";
}
export function economyMinerConflict(jobs: readonly EconomyJob[], now: number) {
  const job = jobs.find(isMinerJob);
  return job ? { code: "ECONOMY_MINER_BUSY" as const, message: now < Date.parse(job.finishesAt)
    ? "Шахтёр ещё добывает материалы. Дождитесь окончания работы" : "Сначала заберите добычу шахтёра", job } : null;
}

export function isQuarryProduction(job: Pick<EconomyJob, "kind" | "targetId">) {
  return job.kind === "production" && job.targetId === "quarry";
}

/** Mining uses exploration commands; retired production is rejected by the domain. */
export function economyCommandUsesActor(command: Pick<EconomyCommand, "action" | "targetId">, catalog: EconomyCatalog = economyCatalog) {
  if (command.action === "start_exploration" && catalog.explorations.some(route => route.id === command.targetId && route.activity === "mining")) return false;
  return ["start_exploration", "start_fishing", "start_collection", "eat_food"].includes(command.action);
}

type ActorConflict = { code: "ECONOMY_EXPLORER_BUSY" | "ECONOMY_COLLECTOR_BUSY" | "ECONOMY_QUARRY_BUSY"; message: string; job: EconomyJob };

/** Departures retain their slot until delivery. A returned hero may gather berries
 * while the earlier findings wait; an accepted harvest owns him until its claim. */
export function economyActorConflict(jobs: readonly EconomyJob[], intent: "departure" | "collection", now: number): ActorConflict | null {
  const collection = jobs.find(job => job.collection?.startedAt);
  if (intent === "departure" && collection)
    return { code: "ECONOMY_COLLECTOR_BUSY", message: "Сначала завершите сбор припасов", job: collection };
  const exploration = jobs.find(job => job.kind === "exploration" && !isMinerJob(job) && (intent === "departure" || now < Date.parse(job.finishesAt)));
  if (exploration) return { code: "ECONOMY_EXPLORER_BUSY", message: now < Date.parse(exploration.finishesAt)
    ? "Мохлик ещё в вылазке. Дождитесь его возвращения" : "Сначала заберите находки Мохлика", job: exploration };
  const quarry = jobs.find(job => isQuarryProduction(job) && (intent === "departure" || now < Date.parse(job.finishesAt)));
  if (quarry) return { code: "ECONOMY_QUARRY_BUSY", message: now < Date.parse(quarry.finishesAt)
    ? "Мохлик работает в каменоломне. Дождитесь окончания добычи" : "Сначала заберите добычу из каменоломни", job: quarry };
  return collection ? { code: "ECONOMY_COLLECTOR_BUSY", message: "Сначала завершите текущий сбор припасов", job: collection } : null;
}
