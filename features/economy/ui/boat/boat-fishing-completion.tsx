import { Fish, Scale, Sparkles, Trophy } from "lucide-react";
import { boatFishWeightLabel } from "./boat-panels";
import type { BoatTripReceipt } from "./boat-trip-summary-data";
import styles from "./boat-fishing-completion.module.css";

/** An onboard recap, not a delivery receipt: returning and unloading remain server actions. */
export function BoatFishingCompletion({ receipt, full, onShowCatch }: { receipt: BoatTripReceipt; full: boolean; onShowCatch: () => void }) {
  return <section className={styles.summary} data-fishing-complete={receipt.voyageId} aria-label="Результат рыбалки на воде">
    <div className={styles.heading}><h3>{full ? "Ящик полон — пора домой" : "Все забросы использованы"}</h3>
      {receipt.count > 0 && <button type="button" data-fishing-action="catch-details" onClick={onShowCatch}>Весь улов</button>}</div>
    {receipt.count > 0 ? <>
      <div className={styles.stats}><span><Fish size={15} /><strong>{receipt.count}</strong> на борту</span><span><Scale size={15} /><strong>{boatFishWeightLabel(receipt.totalWeightGrams)}</strong> всего</span></div>
      {receipt.largest && <p className={styles.largest}><Trophy size={13} /><span>Самая крупная: <strong>{receipt.largest.name} · {boatFishWeightLabel(receipt.largest.weightGrams)}</strong></span></p>}
      {(receipt.newSpeciesCount > 0 || receipt.recordSpeciesCount > 0) && <div className={styles.findings}>
        {receipt.newSpeciesCount > 0 && <span><Sparkles size={12} />Новых видов: {receipt.newSpeciesCount}</span>}
        {receipt.recordSpeciesCount > 0 && <span><Trophy size={12} />Рекордов: {receipt.recordSpeciesCount}</span>}
      </div>}
    </> : <p className={styles.empty}>На этот раз без улова. Река подождёт следующего выхода.</p>}
  </section>;
}
