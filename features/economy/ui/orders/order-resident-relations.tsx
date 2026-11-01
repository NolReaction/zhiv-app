import { HeartHandshake, Sparkles } from "lucide-react";
import { number } from "@/features/economy/ui/shared/world-economy-parts";
import { orderResidents, type OrderResidentId } from "./order-residents";
import styles from "./order-resident-relations.module.css";

export type OrderReputationPresentation = {
  xp: number;
  rankName: string;
  rankNumber: number;
  rankStartsAt: number;
  nextRankAt: number | null;
  benefit: string;
  nextBenefit?: string;
  dailyOrderXpRemaining: number;
  dailyOrderXpCap: number;
  activityPercent?: number;
  potentialBenefit?: string;
};

export function OrderResidentRelations({ residentId, reputation }: {
  residentId: OrderResidentId;
  reputation: OrderReputationPresentation;
}) {
  const resident = orderResidents[residentId];
  const span = reputation.nextRankAt === null ? 1 : Math.max(1, reputation.nextRankAt - reputation.rankStartsAt);
  const progress = reputation.nextRankAt === null ? 1 : Math.min(1, Math.max(0, (reputation.xp - reputation.rankStartsAt) / span));
  return <section className={styles.relationship} data-order-relations={residentId} aria-label={`Отношения: ${resident.name}`}>
    <div className={styles.reputation}>
      <div className={styles.progressLabel}><span><HeartHandshake size={13} aria-hidden="true" />{reputation.rankName}<small>Ур. {reputation.rankNumber}</small></span><strong>{number(reputation.xp)}{reputation.nextRankAt !== null && <> / {number(reputation.nextRankAt)}</>}</strong></div>
      <progress value={progress} max={1} aria-label={`Репутация: ${resident.name}, ${number(reputation.xp)}${reputation.nextRankAt === null ? ", высший уровень" : ` из ${number(reputation.nextRankAt)}`}`} />
    </div>
    <div className={styles.benefit}><Sparkles size={13} aria-hidden="true" /><strong>{reputation.benefit}</strong></div>
    <p className={styles.daily} data-order-daily-reputation aria-label={`За обычные просьбы сегодня доступно ${number(reputation.dailyOrderXpRemaining)} из ${number(reputation.dailyOrderXpCap)} репутации`}>Сегодня ещё <strong>{number(reputation.dailyOrderXpRemaining)} / {number(reputation.dailyOrderXpCap)}</strong></p>
  </section>;
}
