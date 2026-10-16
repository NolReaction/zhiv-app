import type { EconomySceneProduction } from "./economy-production-state";

/** A confirmed owner/revision fence for resident access and worker animation. */
export type EconomySceneResidents = {
  ownerPublicId: string;
  revision: number;
  buildings: Readonly<Record<string, number>>;
  production: EconomySceneProduction;
};

export type ResidentArrivalPresentation = {
  seen: boolean;
  enabled: boolean;
  onComplete: () => void;
};

/** Cached or foreign account levels cannot make an undiscovered miner appear. */
export function syncForestResidentAccess(holder: { economyResidents?: EconomySceneResidents },
  incoming: EconomySceneResidents | null | undefined, expectedOwner?: string): boolean {
  if (!incoming || expectedOwner && incoming.ownerPublicId !== expectedOwner
    || !Number.isSafeInteger(incoming.revision) || incoming.revision < 0
    || incoming.production.ownerPublicId !== incoming.ownerPublicId || incoming.production.revision !== incoming.revision) return false;
  const previous = holder.economyResidents;
  if (previous && (previous.ownerPublicId !== incoming.ownerPublicId && !expectedOwner
    || previous.ownerPublicId === incoming.ownerPublicId && previous.revision >= incoming.revision)) return false;
  holder.economyResidents = { ...incoming, buildings: { ...incoming.buildings },
    production: { ...incoming.production, jobs: incoming.production.jobs.map(job => ({ ...job })) } };
  return true;
}
