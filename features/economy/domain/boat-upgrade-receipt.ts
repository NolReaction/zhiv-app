import type { BoatModuleId } from "./boat-model";
import { boatModules, boatState } from "./boat-fishing";
import type { EconomyCommand, EconomyResult, EconomyView } from "./model";

export type BoatUpgradeReceipt = Readonly<{
  id: string; revision: number; module: BoatModuleId; tier: number; phase: "started" | "installed";
}>;

/** Look for the exact paid work or its installed tier in the accepted command result. */
export function boatUpgradeReceipt(before: EconomyView, result: EconomyResult, command: EconomyCommand): BoatUpgradeReceipt | null {
  if (command.action !== "start_boat_upgrade" && command.action !== "claim_boat_upgrade") return null;
  const after = result.state;
  if (result.replayed || command.ownerPublicId !== before.ownerPublicId || after.ownerPublicId !== before.ownerPublicId
    || command.expectedRevision !== before.revision || result.acceptedRevision !== before.revision + 1 || after.revision !== result.acceptedRevision) return null;
  const previous = boatState(before), current = boatState(after);
  const isStart = command.action === "start_boat_upgrade";
  if (isStart ? previous.work : previous.work?.id !== command.targetId) return null;
  const upgradeId = isStart ? command.targetId : previous.work?.upgradeId;
  const upgrade = after.catalog.boat?.upgrades.find(step => step.id === upgradeId);
  if (!upgrade?.module || !upgrade.tier || boatModules(previous)[upgrade.module] + 1 !== upgrade.tier) return null;
  const started = isStart && current.work?.upgradeId === upgrade.id;
  const installed = !current.work && boatModules(current)[upgrade.module] === upgrade.tier;
  if (!started && !installed) return null;
  return { id: command.requestId, revision: after.revision, module: upgrade.module, tier: upgrade.tier, phase: started ? "started" : "installed" };
}
