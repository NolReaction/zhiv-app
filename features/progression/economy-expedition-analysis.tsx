"use client";

import { useState } from "react";
import { economyCatalog } from "@/features/economy/domain/model";
import { fishingBaitCompatible } from "@/features/economy/domain/fishing";
import { expeditionExpectedReturns, fishingExpectedReturn } from "./economy-expeditions";
import { economyDuration, economyNumber, EconomyItemButton } from "./economy-workbench-common";
import styles from "./economy-workbench.module.css";

const catalog = economyCatalog, fishing = catalog.fishing;
const itemName = (id: string) => catalog.items.find(item => item.id === id)?.name ?? id;
const percent = (value: number) => `${economyNumber(value * 100)}%`;
const routes = expeditionExpectedReturns();

export function EconomyExpeditionAnalysis({ onSelect }: { onSelect: (id: string) => void }) {
  const [rodId, setRod] = useState(fishing?.rods[0]?.id ?? ""), [hookId, setHook] = useState(fishing?.hooks[0]?.id ?? "");
  const [baitChoice, setBait] = useState<string>(""), [routeId, setRoute] = useState(fishing?.routeIds[0] ?? "");
  const baitId = baitChoice && fishing && fishingBaitCompatible(rodId, baitChoice, fishing) ? baitChoice : null;
  const report = fishingExpectedReturn({ routeId, rodId, hookId, baitId });
  return <div className={styles.expeditionAnalysis}>
    <section aria-label="Ожидаемый результат рыбалки">
      <h3>Рыбалка: ожидаемый результат</h3>
      <p className={styles.note}>Среднее по множеству походов. Конкретный вид и класс случайны: нужная рыба может не попасться за несколько попыток.</p>
      {fishing && <div className={styles.expeditionControls}>
        <label>Маршрут<select aria-label="Маршрут для расчёта рыбалки" value={routeId} onChange={event => setRoute(event.target.value)}>{catalog.explorations.filter(route => !route.retired && fishing.routeIds.includes(route.id)).map(route => <option key={route.id} value={route.id}>{route.name}</option>)}</select></label>
        <label>Удочка<select aria-label="Удочка для расчёта" value={rodId} onChange={event => setRod(event.target.value)}>{fishing.rods.map(rod => <option key={rod.id} value={rod.id}>{rod.name} · дом {rod.requiredHomeLevel}</option>)}</select></label>
        <label>Крючок<select aria-label="Крючок для расчёта" value={hookId} onChange={event => setHook(event.target.value)}>{fishing.hooks.map(hook => <option key={hook.id} value={hook.id}>{hook.name}</option>)}</select></label>
        <label>Наживка<select aria-label="Наживка для расчёта" value={baitId ?? ""} onChange={event => setBait(event.target.value)}><option value="">Без наживки</option>{fishing.baits.filter(bait => fishingBaitCompatible(rodId, bait.itemId, fishing)).map(bait => <option key={bait.itemId} value={bait.itemId}>{itemName(bait.itemId)} · {economyNumber(bait.price)} мон.</option>)}</select></label>
      </div>}
      {report && <>
        <dl className={styles.returnStats}><div><dt>Один поход</dt><dd>{economyDuration(report.seconds)} · {report.draws} рыб</dd></div><div><dt>Средняя продажа улова</dt><dd>{economyNumber(report.expectedGrossCoins)} мон.</dd></div><div><dt>Припасы и наживка</dt><dd>−{economyNumber(report.costCoins)} мон.</dd></div><div><dt>Средний остаток / мин</dt><dd>{economyNumber(report.expectedNetCoinsPerMinute)} мон.</dd></div></dl>
        <p className={styles.note}>Снасти: {economyNumber(report.capitalCoins)} монет однократно, без скидки репутации. Они не вычитаются повторно из каждого похода. Расчёт без еды, дороги и пауз; наживка оценена по цене покупки, остальные припасы — по цене продажи NPC.</p>
        <div className={styles.tableViewport} tabIndex={0} role="region" aria-label="Шансы видов рыб"><table className={styles.balanceTable}><caption>Шанс одной рыбы и хотя бы одной за весь поход</caption><thead><tr><th>Вид</th><th>Одна рыба</th><th>Хотя бы одна за поход</th><th>Среднее количество</th></tr></thead><tbody>{report.species.map(fish => <tr key={fish.itemId}><th><button type="button" onClick={() => onSelect(fish.itemId)}>{itemName(fish.itemId)}</button></th><td>{percent(fish.probability)}</td><td>{percent(fish.atLeastOneProbability)}</td><td>{economyNumber(fish.expectedQuantity)}</td></tr>)}</tbody></table></div>
      </>}
    </section>
    <section aria-label="Гарантированная добыча и случайные находки"><h3>Походы и добыча</h3><p className={styles.note}>Гарантированный набор входит в производственный план. Дополнительная находка повышает ожидаемую отдачу, но её нельзя обещать для выполнения заказа.</p>
      <div className={styles.expeditionCards}>{routes.map(route => <article key={route.id} className={styles.expeditionCard} data-analysis-route={route.id}><header><h4>{route.name}</h4><span>Дом {route.homeLevel} · {economyDuration(route.seconds)} · {route.actor === "miner" ? "Шахтёр" : "Мохлик"}</span></header>
        <strong>Гарантированно</strong><div className={styles.chips}>{Object.entries(route.guaranteed).map(([id, quantity]) => <EconomyItemButton key={id} id={id} name={itemName(id)} quantity={quantity} onSelect={onSelect} />)}</div>
        {route.finds.length > 0 && <><strong>Одна возможная находка</strong><ul>{route.finds.map((find, index) => <li key={`${find.itemId}:${index}`}><button type="button" onClick={() => onSelect(find.itemId)}>{itemName(find.itemId)} ×{find.quantity}</button><span>{percent(find.probability)}</span></li>)}<li><span>Без дополнительной находки</span><span>{percent(route.emptyProbability)}</span></li></ul></>}
        <p>Гарантированная стоимость: {economyNumber(route.guaranteedCoins)} · припасы: {economyNumber(route.costCoins)} мон.</p><p>Средняя добавка от находки: {economyNumber(route.expectedBonusCoins)} мон.</p><p><strong>В среднем после припасов: {economyNumber(route.expectedNetCoinsPerMinute)} мон./мин</strong></p>
      </article>)}</div>
    </section>
  </div>;
}
