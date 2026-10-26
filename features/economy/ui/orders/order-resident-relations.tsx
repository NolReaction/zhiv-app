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
    <div className={styles.person}>
      <span className={styles.portraitFrame}><resident.Portrait className={styles.portrait} /></span>
      <div className={styles.identity}><p>{resident.role}</p><h3>{resident.name}</h3><span><HeartHandshake size={13} aria-hidden="true" />{reputation.rankName}<small>Ур. {reputation.rankNumber}</small></span></div>
    </div>
    <div className={styles.reputation}>
      <div className={styles.progressLabel}><span>Репутация</span><strong>{number(reputation.xp)}{reputation.nextRankAt !== null && <> / {number(reputation.nextRankAt)}</>}</strong></div>
      <progress value={progress} max={1} aria-label={`Репутация: ${resident.name}, ${number(reputation.xp)}${reputation.nextRankAt === null ? ", высший уровень" : ` из ${number(reputation.nextRankAt)}`}`} />
      <p>{reputation.nextRankAt === null ? "Высший уровень. Дружба сохраняется." : `До следующего уровня: ${number(Math.max(0, reputation.nextRankAt - reputation.xp))}.`}</p>
    </div>
    <div className={styles.benefit}><Sparkles size={15} aria-hidden="true" /><div><strong>{reputation.benefit}</strong>{reputation.nextBenefit && <span>Следующий уровень: {reputation.nextBenefit}</span>}</div></div>
    {reputation.activityPercent !== undefined && <p className={styles.daily} data-order-activity>
      Поддержка жителя: <strong>{reputation.activityPercent}%</strong>. {reputation.activityPercent < 100 && <>При полной поддержке: {reputation.potentialBenefit}. </>}
      Сдача просьбы восстанавливает 25% поддержки. Три дня без помощи она сохраняется, затем снижается; полная поддержка угаснет ещё за семь дней. Уровень дружбы и репутация остаются.
    </p>}
    <p className={styles.daily} data-order-daily-reputation>За обычные просьбы сегодня: ещё <strong>{number(reputation.dailyOrderXpRemaining)} / {number(reputation.dailyOrderXpCap)}</strong> репутации.</p>
  </section>;
}
