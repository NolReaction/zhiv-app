import { Check, Clock3, Hammer, Package, Telescope, Trophy } from "lucide-react";
import type { BoatCatalog, BoatState, BoatUpgradeId } from "@/features/economy/domain/boat-model";
import { boatUpgradeReason } from "@/features/economy/domain/boat-fishing";
import type { EconomyCost, EconomyView } from "@/features/economy/domain/model";
import { ItemIcon } from "@/features/items/item-icon";
import { itemName, number, ProductIcon } from "@/features/economy/ui/shared/world-economy-parts";
import { worldCountdown, worldDuration } from "@/features/economy/ui/shared/world-stations";
import { BlueprintArt } from "./boat-art";
import styles from "./boat-fishing.module.css";

export const boatFishWeightLabel = (grams: number) => grams < 1000 ? `${number(grams)} г` : `${(grams / 1000).toLocaleString("ru-RU", { maximumFractionDigits: 3 })} кг`;
type Upgrade = BoatCatalog["upgrades"][number];
type UpgradeProps = { state: EconomyView; boat: BoatState; upgrade: Upgrade; now: number; disabled: boolean; onUpgrade: (id: BoatUpgradeId) => void };

export function BoatCost({ state, cost }: { state: EconomyView; cost: EconomyCost }) {
  return <ul className={styles.cost} aria-label="Стоимость работы">
    {cost.coins > 0 && <li data-missing={state.wallet.coins < cost.coins || undefined}><ItemIcon itemId="coins" size={17} /><strong>{number(cost.coins)}</strong><span className={styles.srOnly}>монет</span></li>}
    {Object.entries(cost.items).map(([id, quantity]) => <li key={id} data-missing={(state.inventory[id] ?? 0) < quantity || undefined} title={itemName(state, id)}><ProductIcon state={state} itemId={id} size={19} /><span>{itemName(state, id)}</span><strong>×{quantity}</strong></li>)}
  </ul>;
}

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

export function BoatBlueprints({ state, boat, config, now, disabled, onUpgrade, onInspect }: Omit<UpgradeProps, "upgrade"> & { config: BoatCatalog; onInspect: () => void }) {
  return <div>
    <p className={styles.muted}>Страницы складываются в чертёж. Соберите его целиком, чтобы изготовить новое снаряжение.</p>
    <div className={styles.blueprints} style={{ marginTop: 15 }}>{config.blueprints.map(blueprint => {
      const count = boat.blueprints[blueprint.id], upgrade = config.upgrades.find(entry => entry.id === blueprint.id)!;
      const owned = boat.artifacts.includes(blueprint.id), reason = boatUpgradeReason(state, blueprint.id, now);
      return <article key={blueprint.id} className={styles.blueprint} data-boat-blueprint={blueprint.id}>
        <div className={styles.blueprintTop}><BlueprintArt kind={blueprint.id} complete={count === 3} /><div><h3>{blueprint.name}</h3><p>{owned ? "Изготовлено и установлено" : count ? `Найдено ${count} из 3 страниц` : "Первая страница ещё впереди"}</p></div></div>
        <p className={styles.muted}>{upgrade.description}</p>
        <div className={styles.sheets} aria-label={`Найдено ${count} из 3 страниц`}>{[1, 2, 3].map(page => <span key={page} className={styles.sheet} data-found={page <= count || undefined} aria-hidden="true">{page <= count ? <Check size={15} /> : page}</span>)}</div>
        {owned ? <><span className={styles.owned}><Check size={15} />Снаряжение готово</span>{blueprint.id === "telescope" && <BoatForecast state={state} disabled={disabled} onInspect={onInspect} />}</> : count === 3 ? <>
          <BoatCost state={state} cost={upgrade.cost} /><button type="button" className={styles.primary} disabled={disabled || Boolean(reason)} onClick={() => onUpgrade(blueprint.id)}><Hammer size={16} />Изготовить</button>
          {reason && <p className={styles.note}>{reason}</p>}
        </> : <p className={styles.note}>Используйте все забросы и привезите хотя бы одну рыбу, чтобы находить страницы чертежей.</p>}
      </article>;
    })}</div>
  </div>;
}

function BoatForecast({ state, disabled, onInspect }: { state: EconomyView; disabled: boolean; onInspect: () => void }) {
  const forecast = state.ship.nextVoyage;
  return <div className={styles.forecast}>
    {!forecast ? <><button type="button" className={styles.secondary} disabled={disabled || !(state.buildings.lighthouse > 0)} onClick={onInspect}><Telescope size={17} />Посмотреть будущий груз</button>{!(state.buildings.lighthouse > 0) && <p className={styles.note}>Сначала восстановите маяк.</p>}</>
      : <><strong>Следующий корабль</strong><p className={styles.note}>Эти товары понадобятся капитану. Можно подготовить их заранее.</p>{forecast.orders.map((order, index) => <details key={order.id} open={index === 0} className={styles.forecastOrder}>
        <summary>Груз {index + 1} · {order.title}</summary><ul className={styles.cost}>{Object.entries(order.items).map(([itemId, quantity]) => <li key={itemId}><ProductIcon state={state} itemId={itemId} size={19} /><span>{itemName(state, itemId)}</span><strong>×{quantity}</strong></li>)}</ul>
      </details>)}</>}
  </div>;
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
