import { Fish, Worm } from "lucide-react";
import { fishingCollectionDraws, fishingState } from "@/features/economy/domain/fishing";
import type { EconomyView } from "@/features/economy/domain/model";
import styles from "./expedition-fishing-summary.module.css";

type ExpeditionFishingSummaryProps = {
  state: EconomyView;
  route: EconomyView["catalog"]["explorations"][number];
};

/** Every catch supplies one class item and records its species in the collection. */
export function ExpeditionFishingSummary({ state, route }: ExpeditionFishingSummaryProps) {
  const spec = state.catalog.fishing;
  if (!spec?.routeIds.includes(route.id)) return null;
  const total = fishingCollectionDraws(route.id, spec);
  const bait = fishingState(state).equippedBaitId;
  return <section className={styles.summary} aria-label="Улов за одну вылазку">
    <dl className={styles.grid}>
      <div className={styles.stat}>
        <dt><Fish aria-hidden="true" />Всего рыб</dt>
        <dd>{total}</dd>
      </div>
      <div className={styles.stat}>
        <dt><Worm aria-hidden="true" />Наживки за поход</dt>
        <dd>{bait ? <>1 <span>шт.</span></> : <span className={styles.withoutBait}>Не нужна</span>}</dd>
      </div>
    </dl>
    <p className={styles.note}>Каждая рыба пополняет запас своего класса. Новые виды навсегда открываются в книге после получения улова.</p>
  </section>;
}
