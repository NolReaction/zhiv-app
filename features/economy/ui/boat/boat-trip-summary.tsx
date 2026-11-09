import { Anchor, Check, Fish, FishingRod, Scale, Sparkles, Trophy } from "lucide-react";
import { ItemIcon } from "@/features/items/item-icon";
import { boatFishWeightLabel } from "./boat-panels";
import type { BoatTripReceipt } from "./boat-trip-summary-data";
import styles from "./boat-trip-summary.module.css";

type Props = { receipt: BoatTripReceipt; delivered?: boolean };

/** Before unloading this is an onboard manifest, after acknowledgement a read-only keepsake. */
export function BoatTripSummary({ receipt, delivered = false }: Props) {
  const largest = receipt.largest;
  return <section className={styles.summary} data-boat-trip-summary={receipt.voyageId} data-delivered={delivered} aria-label="Итоги рыбалки">
    <header className={styles.header}>
      <span className={styles.seal}>{delivered ? <Check size={26} /> : <Anchor size={26} />}</span>
      <div><span className={styles.eyebrow}>{receipt.routeName} · {delivered ? "Выход завершён" : "Лодка вернулась"}</span>
        <h3>{receipt.count ? delivered ? "Улов доставлен" : "Улов прибыл домой" : "Снова у причала"}</h3>
        <p>{receipt.count ? delivered ? "Рыба в запасах, находки и рекорды сохранены." : "Ваш речной улов. Осталось разгрузить лодку." : delivered ? "Спокойный выход завершён. Река подождёт следующей встречи." : "На этот раз без улова. Завершите выход и возвращайтесь за новой рыбалкой."}</p>
      </div>
    </header>
    <div className={styles.stats}>
      <div><Fish size={17} /><strong>{receipt.count}</strong><span>рыб за выход</span></div>
      <div><Scale size={17} /><strong>{boatFishWeightLabel(receipt.totalWeightGrams)}</strong><span>общий вес</span></div>
      <div><FishingRod size={17} /><strong>{receipt.castsUsed}</strong><span>забросов сделано</span></div>
    </div>
    {largest && <div className={styles.featured} data-largest-fish={largest.fishId}>
      <span className={styles.fishPortrait} data-rarity={largest.rarity}><ItemIcon itemId={largest.fishId} size={76} /></span>
      <div><span className={styles.eyebrow}><Trophy size={12} /> Самая крупная</span><h4>{largest.name}</h4><p>{largest.rarityLabel} · {largest.sizeLabel}</p></div>
      <strong className={styles.largestWeight}>{boatFishWeightLabel(largest.weightGrams)}</strong>
    </div>}
    {(receipt.newSpeciesCount > 0 || receipt.recordSpeciesCount > 0) && <div className={styles.achievements}>
      {receipt.newSpeciesCount > 0 && <span data-trip-new-species={receipt.newSpeciesCount}><Sparkles size={14} />Новых видов: {receipt.newSpeciesCount}</span>}
      {receipt.recordSpeciesCount > 0 && <span data-trip-records={receipt.recordSpeciesCount}><Trophy size={14} />Рекордов по весу: {receipt.recordSpeciesCount}</span>}
    </div>}
    {receipt.count > 0 && <ol className={styles.catches} aria-label="Весь улов выхода">{receipt.catches.map(caught => <li key={caught.castIndex} data-trip-catch={caught.castIndex}>
      <span className={styles.miniPortrait} data-rarity={caught.rarity}><ItemIcon itemId={caught.fishId} size={35} /></span>
      <div><strong>{caught.name}</strong><small>{caught.isNewSpecies ? "Новый вид" : caught.isRecord ? "Личный рекорд" : caught.rarityLabel}</small></div>
      <span>{boatFishWeightLabel(caught.weightGrams)}</span>
    </li>)}</ol>}
    {receipt.count > 0 && <p className={styles.note} data-trip-delivery-status>{delivered ? "Виды и лучшие веса доступны в альбоме рыбака." : "Улов пока на борту. Разгрузка добавит рыбу в запасы и сохранит рекорды; при полной кладовой рыба останется в лодке."}</p>}
  </section>;
}

/** The boat stays visible while its manifest can be inspected before or after unloading. */
export function BoatDockReceipt({ receipt, delivered = false }: Props) {
  return <div className={styles.dockReceipt}>
    <p role={delivered ? "status" : undefined} data-boat-delivery={delivered || undefined}>
      {delivered ? <Check size={17} aria-hidden="true" /> : <Anchor size={17} aria-hidden="true" />}
      <strong>{delivered ? receipt.count ? "Улов доставлен" : "Выход завершён" : receipt.count ? "Улов на борту" : "Возвращение без улова"}</strong>
      {receipt.count > 0 && <span>Рыб: {receipt.count} · {boatFishWeightLabel(receipt.totalWeightGrams)}</span>}
    </p>
    {receipt.count > 0 && <details><summary>Итоги рыбалки</summary><BoatTripSummary receipt={receipt} delivered={delivered} /></details>}
  </div>;
}
