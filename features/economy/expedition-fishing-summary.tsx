import { Fish, ShieldCheck, Sparkles, Worm } from "lucide-react";
import { fishingCollectionDraws, fishingState } from "./fishing";
import type { EconomyView } from "./model";
import styles from "./expedition-fishing-summary.module.css";

type ExpeditionFishingSummaryProps = {
  state: EconomyView;
  route: EconomyView["catalog"]["explorations"][number];
};

/** The guaranteed catch and the collection draws share one fixed batch of fish. */
export function ExpeditionFishingSummary({ state, route }: ExpeditionFishingSummaryProps) {
  const spec = state.catalog.fishing;
  if (!spec?.routeIds.includes(route.id)) return null;
  const total = route.rewards.fish ?? 0;
  const draws = fishingCollectionDraws(route.id, spec);
  const bait = fishingState(state).equippedBaitId;
  return <section className={styles.summary} aria-label="Улов за одну вылазку">
    <dl className={styles.grid}>
      <div className={styles.stat}>
        <dt><Fish aria-hidden="true" />Всего рыб</dt>
        <dd>{total}</dd>
      </div>
      <div className={styles.stat}>
        <dt><ShieldCheck aria-hidden="true" />Речных гарантировано</dt>
        <dd>{total - draws}</dd>
      </div>
      <div className={styles.stat}>
        <dt><Sparkles aria-hidden="true" />Попыток особого улова</dt>
        <dd>{draws}</dd>
      </div>
      <div className={styles.stat}>
        <dt><Worm aria-hidden="true" />Наживки за поход</dt>
        <dd>{bait ? <>1 <span>шт.</span></> : <span className={styles.withoutBait}>Не нужна</span>}</dd>
      </div>
    </dl>
    <p className={styles.note}>Особые попытки входят в общий улов и тоже могут дать речную рыбу.</p>
  </section>;
}
