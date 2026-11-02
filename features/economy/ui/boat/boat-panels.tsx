import { Check, Clock3, Hammer, Package, Trophy } from "lucide-react";
import type { BoatCatalog, BoatState, BoatUpgradeId } from "@/features/economy/domain/boat-model";
import { boatUpgradeReason } from "@/features/economy/domain/boat-fishing";
import type { EconomyView } from "@/features/economy/domain/model";
import { ItemIcon } from "@/features/items/item-icon";
import { itemName, number } from "@/features/economy/ui/shared/world-economy-parts";
import { worldCountdown, worldDuration } from "@/features/economy/ui/shared/world-stations";
import { BoatCost } from "./boat-cost";
export { BoatCost } from "./boat-cost";
export { BoatBlueprints } from "./boat-blueprints";
import styles from "./boat-fishing.module.css";

export const boatFishWeightLabel = (grams: number) => grams < 1000 ? `${number(grams)} г` : `${(grams / 1000).toLocaleString("ru-RU", { maximumFractionDigits: 3 })} кг`;
type Upgrade = BoatCatalog["upgrades"][number];
type UpgradeProps = { state: EconomyView; boat: BoatState; upgrade: Upgrade; now: number; disabled: boolean; onUpgrade: (id: BoatUpgradeId) => void };

export function BoatUpgradeCard({ state, boat, upgrade, now, disabled, onUpgrade }: UpgradeProps) {
  const owned = upgrade.id === "repair" ? boat.level > 0 : [...boat.upgrades, ...boat.artifacts].some(id => id === upgrade.id);
  const reason = owned ? null : boatUpgradeReason(state, upgrade.id, now);
  return <article className={styles.upgrade} data-boat-upgrade={upgrade.id}>
    <h3>{upgrade.id === "crate" ? <Package size={18} /> : <Hammer size={18} />}{upgrade.name}</h3>
    <p className={styles.muted}>{upgrade.description}</p>
    {owned ? <span className={styles.owned}><Check size={15} />Установлено</span> : <><BoatCost state={state} cost={upgrade.cost} />
      <span className={styles.note}><Clock3 size={12} /> {worldDuration(upgrade.seconds)}</span>
      <button type="button" className={styles.secondary} disabled={disabled || Boolean(reason)} onClick={() => onUpgrade(upgrade.id)}>{upgrade.id === "repair" ? "Восстановить лодку" : "Улучшить лодку"}</button>
      {reason && <p className={styles.note}>{reason}</p>}</>}
  </article>;
}

export function BoatWork({ boat, config, now, disabled, onClaim }: { boat: BoatState; config: BoatCatalog; now: number; disabled: boolean; onClaim: (id: string) => void }) {
  const work = boat.work;
  if (!work) return null;
  const seconds = Math.max(0, Math.ceil((Date.parse(work.finishesAt) - now) / 1000));
  const progress = Math.min(1, Math.max(0, (now - Date.parse(work.startedAt)) / Math.max(1, Date.parse(work.finishesAt) - Date.parse(work.startedAt))));
  const name = config.upgrades.find(upgrade => upgrade.id === work.upgradeId)?.name ?? "Улучшение лодки";
  return <section className={styles.work} data-boat-work={work.id}>
    <div><Hammer size={18} /><strong>{name}</strong><small>{seconds ? worldCountdown(seconds) : "Готово"}</small></div>
    <progress className={styles.progress} value={progress} max={1} aria-label={`Готовность: ${name}`} />
    {!seconds && <button type="button" className={styles.primary} disabled={disabled} onClick={() => onClaim(work.id)}><Check size={16} />Завершить работу</button>}
  </section>;
}

export function BoatRecords({ state, boat }: { state: EconomyView; boat: BoatState }) {
  const records = Object.entries(boat.records).sort((left, right) => itemName(state, left[0]).localeCompare(itemName(state, right[0]), "ru"));
  if (!records.length) return <div className={styles.empty}><Trophy size={40} strokeWidth={1.3} /><strong>Первая большая рыба впереди</strong><p>Здесь останется самый тяжёлый экземпляр каждого вида. Привезите улов домой, чтобы записать свой первый рекорд.</p></div>;
  return <div><p className={styles.muted}>Самая большая рыба каждого вида. Рекорд остаётся с вами, даже если улов продан или приготовлен.</p><div className={styles.records}>{records.map(([id, record]) => <article key={id} className={styles.record} data-boat-record={id}>
    <ItemIcon itemId={id} size={46} /><div><strong>{itemName(state, id)}</strong><small>{new Date(record.caughtAt).toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" })}</small></div><span className={styles.weight}>{boatFishWeightLabel(record.weightGrams)}</span>
  </article>)}</div></div>;
}

export function BoatCatchList({ state, boat }: { state: EconomyView; boat: BoatState }) {
  const catches = boat.voyage?.catches ?? [];
  if (!catches.length) return null;
  return <section className={styles.catches} aria-label="Улов на борту"><h3 className={styles.sectionHeading}>На борту · {catches.length}</h3>{catches.map(caught => {
    const best = boat.records[caught.fishId]?.weightGrams ?? 0;
    return <article className={styles.catch} key={caught.castIndex} data-boat-catch={caught.castIndex}><ItemIcon itemId={caught.fishId} size={37} /><div><strong>{itemName(state, caught.fishId)}</strong><small>{caught.weightGrams > best ? best ? "Больше вашего прежнего рекорда" : "Первый трофей этого вида" : "Поймано на этом выходе"}</small></div><span className={styles.weight}>{boatFishWeightLabel(caught.weightGrams)}</span></article>;
  })}<p className={styles.note}>Улов и рекорды сохранятся после возвращения и разгрузки лодки.</p></section>;
}
