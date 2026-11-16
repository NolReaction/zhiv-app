import type { EconomyView } from "@/features/economy/domain/model";
import { tradeRelationProgress } from "@/features/economy/domain/trade-relations";
import type { OrderReputationPresentation } from "./order-resident-relations";
import type { OrderResidentId } from "./order-residents";

export function orderReputationBenefit(residentId: OrderResidentId, bonusBps: number): string {
  const percent = Math.min(10, Math.max(0, bonusBps / 100)).toLocaleString("ru-RU");
  const benefit = residentId === "builder" ? "Скорость стройки" : residentId === "lopukh" ? "Скорость лесного участка"
    : residentId === "kamneshmyg" ? "Скорость добычи" : residentId === "plesk" ? "Скидка на снасти и наживку" : "Скидка на снасти, наживку и одежду";
  return `${benefit}${residentId === "builder" || residentId === "lopukh" || residentId === "kamneshmyg" ? " +" : " "}${percent}%`;
}

export function orderReputationPresentation(state: EconomyView, residentId: OrderResidentId, now: number): OrderReputationPresentation {
  const value = tradeRelationProgress(state, residentId, state.catalog, now);
  return {
    xp: value.xp, rankName: value.rank.name, rankNumber: value.rankIndex + 1, rankStartsAt: value.rank.requiredXp,
    nextRankAt: value.nextRank?.requiredXp ?? null,
    benefit: orderReputationBenefit(residentId, value.bonusBps),
    nextBenefit: value.nextRank ? orderReputationBenefit(residentId, value.nextRank.bonusBps) : undefined,
    dailyOrderXpRemaining: value.dailyOrderXpRemaining,
    dailyOrderXpCap: state.catalog.tradeRelations?.dailyOrderXpCap ?? 0,
    activityPercent: Math.floor(value.activityBps / 100),
    potentialBenefit: orderReputationBenefit(residentId, value.rankBonusBps),
  };
}
