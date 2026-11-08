"use client";

import { ArrowRight } from "lucide-react";
import releaseFeatures from "@/apps/api/src/main/resources/world/release-features.json";
import { PlayerItemIcon } from "@/features/economy/ui/fishing/fish-discovery";

import { shipOrdersConfig } from "@/features/economy/domain/ship-orders";
import { economyCatalog } from "@/features/economy/domain/model";
import { formatPearls } from "@/features/economy/domain/money";
import { buildingLabels } from "@/features/progression/domain/labels";
import { type EconomyHomeUnlock, type EconomyStage } from "@/features/progression/domain/economy-data";
import styles from "@/features/progression/ui/shared/economy-reference.module.css";

import { data, byId, recipeById, number, signed, RecipeDiscovery, time, Ingredients } from "@/features/progression/ui/shared/reference-parts";
import { useBranchState } from "@/features/progression/ui/shell/branch-session";
export function StageCard({ stage, onSelect }: { stage: EconomyStage; onSelect: (id: string) => void }) {
  const target = stage.buildings.find(building => building.id === "home" && building.level === stage.nextHomeLevel);
  const earlyLandmarks = stage.buildings.filter(building => (building.id === "bridge" || building.id === "lighthouse") && building.availableHomeLevel < stage.homeLevel);
  return <article className={styles.stageCard}>
    <header><h3>Дом {stage.homeLevel} <ArrowRight size={19} aria-hidden="true" /> {stage.nextHomeLevel}</h3><span data-preliminary={stage.preliminary || undefined}>{stage.preliminary ? "Предварительный баланс" : "Текущие требования"}</span></header>
    <dl className={styles.stageStats}><div><dt>Обязательные стройки</dt><dd>{number(stage.buildingCoins)} монет</dd></div><div><dt>Поставки этапа</dt><dd>{stage.orders.length} · +{number(stage.orderCoins)} монет</dd></div><div><dt>Заказы минус стройки</dt><dd>{signed(stage.orderCoins - stage.buildingCoins)} монет</dd></div><div><dt>Очередь одного строителя</dt><dd>{time(stage.buildSeconds)}</dd></div></dl>
    {stage.homeLevel === 1 && <div className={styles.guarantee}><strong>Старт: {number(data.starter.coins)} монет{data.starter.pearls > 0 && <>, {number(data.starter.pearls)} жемчужин</>}</strong><Ingredients items={data.starter.items} onSelect={onSelect} /><p className={styles.hint}>Старт + вводные заказы − стройки: {number(data.starter.coins)} + {number(stage.orderCoins)} − {number(stage.buildingCoins)} = {number(data.starter.coins + stage.orderCoins - stage.buildingCoins)} монет.</p></div>}
    {stage.orderCoins < stage.buildingCoins && <p className={styles.hint}>Для покрытия разницы нужны повторяемые заказы или продажа товаров NPC. Начальные монеты хозяйства здесь не прибавлены.</p>}
    {stage.homeLevel === 4 && <p className={styles.hint}>Поставки дома 5: разовое финансирование развития дальнего берега и хозяйства жителями. Их выплаты включают вклад в проект; обычные повторяемые заказы рассчитываются отдельно.</p>}
    {earlyLandmarks.length > 0 && <p className={styles.gate}>Бюджет включает ещё не восстановленные объекты: {earlyLandmarks.map(building => `${buildingLabels[building.id]} (доступен с дома ${building.availableHomeLevel})`).join(" и ")}. Если восстановить их раньше, на этом этапе нужно на {number(earlyLandmarks.reduce((sum, building) => sum + building.cost.coins, 0))} монет и {time(earlyLandmarks.reduce((sum, building) => sum + building.seconds, 0))} стройки меньше. Повторной оплаты нет.</p>}
    {!!stage.minimumGateSeconds && <p className={styles.gate}>Между поставками: {time(stage.intervalSeconds)}. Всего обязательного ожидания: {time(stage.minimumGateSeconds)}{target && <>; затем стройка дома {time(target.seconds)}</>}. Жемчуг не сокращает интервалы поставок.</p>}
    {stage.preliminary && <p className={styles.hint}>Текущие требования доступны для просмотра, но темп этого этапа ещё предстоит дорабатывать.</p>}
    <details className={styles.chain}><summary>Стоимость каждой стройки</summary><div className={styles.chainBody}>{stage.buildings.map(building => <div className={styles.buildingCost} key={`${building.id}:${building.level}`}><div><strong>{building.name} {building.level}</strong><span>{number(building.cost.coins)} монет · {time(building.seconds)}</span></div><Ingredients items={building.cost.items} onSelect={onSelect} /></div>)}<p className={styles.hint}>Это новые уровни относительно требований предыдущего дома. Уже построенные уровни повторно не оплачиваются. Кладовая не входит в обязательные стройки.</p></div></details>
    <details className={styles.chain}><summary>Общие объёмы материалов этапа</summary><div className={styles.chainBody}><h5>Для всех обязательных строек</h5><Ingredients items={stage.buildingItems} onSelect={onSelect} />{!!Object.keys(stage.orderItems).length && <><h5>Для всех поставок</h5><Ingredients items={stage.orderItems} onSelect={onSelect} /></>}<p className={styles.hint}>Материалы тратятся постепенно. Самый крупный набор для одной стройки: {Math.max(0, ...stage.buildings.map(building => Object.values(building.cost.items).reduce((sum, count) => sum + count, 0)))} предметов. Сырьё для промежуточных изделий раскрывается в их карточках.</p></div></details>
    {!!stage.orders.length && <details className={styles.chain}><summary>Все поставки этапа</summary><ol className={styles.stageOrders}>{stage.orders.map(order => <li key={order.id}><div><strong>{order.name}</strong><span>+{number(order.coins)} монет</span></div><Ingredients items={order.items} onSelect={onSelect} /><small>Цена товаров у NPC: {number(order.inputNpcValue)}; доплата {stage.homeLevel === 4 ? "проекта" : "заказа"}: +{number(order.addedNpcValue)} монет.</small>{Object.keys(order.requiredBuildings).length > 0 && <small>Сначала улучшить: {Object.entries(order.requiredBuildings).map(([id, level]) => `${buildingLabels[id] ?? id} ${level}`).join(" · ")}</small>}{Object.keys(order.requiredExplorations).length > 0 && <small>Получить результат вылазки: {Object.entries(order.requiredExplorations).map(([id, count]) => `${data.items.flatMap(item => item.sources).find(source => source.routeId === id)?.name ?? id} ×${count}`).join(" · ")}. Запуск или отмена не засчитываются.</small>}</li>)}</ol></details>}
    {!!Object.keys(stage.completionRewards).length && <div className={styles.guarantee}><strong>Гарантированная награда за весь проект</strong><Ingredients items={stage.completionRewards} onSelect={onSelect} /></div>}
  </article>;
}

export function HomeUnlockCard({ unlock, onSelect }: { unlock: EconomyHomeUnlock; onSelect: (id: string) => void }) {
  const berries = new Set(unlock.berries.map(berry => berry.itemId));
  const products = unlock.newItems.filter(id => !berries.has(id));
  const boatUpgrades = economyCatalog.boat?.upgrades.filter(upgrade => !upgrade.blueprint && upgrade.requiredHomeLevel === unlock.homeLevel) ?? [];
  return <article className={styles.unlockCard} data-home-unlocks={unlock.homeLevel}>
    <h3>Дом {unlock.homeLevel}</h3>
    <div className={styles.berryUnlocks}>{unlock.berries.map(berry => {
      const recipe = recipeById.get(berry.recipeId), item = byId.get(berry.itemId);
      if (!recipe || !item) return null;
      return <button type="button" key={berry.itemId} data-unlock-item={berry.itemId} onClick={() => onSelect(berry.itemId)}>
        <PlayerItemIcon itemId={berry.itemId} size={30} /><span><strong>{item.name}</strong><small>{time(recipe.seconds)} · {number(item.npcSellPrice ?? 0)} монет NPC</small><small>{buildingLabels[recipe.buildingId]} {recipe.buildingLevel}{recipe.collectionSeconds > 0 && <> · сбор {time(recipe.collectionSeconds)}</>}</small></span>
      </button>;
    })}</div>
    {products.length > 0 && <><h4>Новые товары</h4><Ingredients items={Object.fromEntries(products.map(id => [id, 1]))} onSelect={onSelect} /></>}
    {unlock.landmarks.map(landmark => <div className={styles.guarantee} key={`${landmark.id}:${landmark.level}`}><strong>{landmark.name}: {number(landmark.cost.coins)} монет · {time(landmark.seconds)}</strong><Ingredients items={landmark.cost.items} onSelect={onSelect} /><p className={styles.hint}>{landmark.id === "bridge" ? "После получения восстановления открывается рынок игроков. Для следующего дома мост необязателен; поздний проект потребует его." : `После получения восстановления включается ночной свет и приходит корабль с тремя грузами. Стоянка ${shipOrdersConfig.staySeconds / 3600} ч, следующий рейс через ${shipOrdersConfig.intervalSeconds / 3600} ч после отплытия. За рейс ${shipOrdersConfig.freeReplacements} бесплатные замены нетронутых грузов; досрочное отправление стоит ${formatPearls(shipOrdersConfig.resetPricePearls)} жемчужин. Маяк показывает время прибытия. Для следующего дома маяк необязателен.`}</p></div>)}
    {releaseFeatures.boatFishingEnabled && boatUpgrades.length > 0 && <details className={styles.chain}><summary>Лодка и снаряжение: {boatUpgrades.length}</summary><div className={styles.chainBody}>
      {boatUpgrades.map(upgrade => <div className={styles.buildingCost} key={upgrade.id} data-boat-upgrade={upgrade.id}>
        <div><strong>{upgrade.name}</strong><span>{number(upgrade.cost.coins)} монет · {time(upgrade.seconds)}</span></div>
        <Ingredients items={upgrade.cost.items} onSelect={onSelect} /><p className={styles.hint}>{upgrade.description}</p>
        <small>Нужны: {Object.entries(upgrade.requiredBuildings).map(([id, level]) => `${buildingLabels[id] ?? id} ${level}`).join(" · ")}</small>
      </div>)}
      <p className={styles.hint}>Это отдельное развитие лодки у существующего причала. Работы занимают общего строителя и требуют получения после таймера. Они не входят в обязательный бюджет следующего дома. Чертежи и постоянные предметы относятся к отдельной системе находок.</p>
    </div></details>}
    <details className={styles.chain}><summary>Все новые рецепты: {unlock.recipes.length}</summary><div className={styles.chainBody}><ul className={styles.unlockRecipes}>{unlock.recipes.map(id => {
      const recipe = recipeById.get(id);
      if (!recipe) return null;
      return <li key={id}><button type="button" onClick={() => onSelect(Object.keys(recipe.rewards)[0])}>{recipe.name}<ArrowRight size={13} aria-hidden="true" /></button><small>{buildingLabels[recipe.buildingId]} {recipe.buildingLevel} · {time(recipe.seconds)}</small><RecipeDiscovery source={recipe} /></li>;
    })}</ul></div></details>
  </article>;
}

export function DevelopmentPanel({ onInspectItem }: { onInspectItem: (id: string) => void }) {
 const [home, setHome] = useBranchState("development.home", 1);
 const unlock = data.homeUnlocks.find(value => value.homeLevel === home);
 const stage = data.stages.find(value => value.homeLevel === home);
 return <section className={styles.panel} aria-label="Развитие хозяйства"><div className={styles.sectionHeading}><div><h2>Развитие хозяйства</h2><p>Открытия выбранного дома и всё необходимое для следующего уровня.</p></div><label>Дом <select aria-label="Уровень дома для развития" value={home} onChange={event => setHome(Number(event.target.value))}>{data.homeUnlocks.map(value => <option key={value.homeLevel} value={value.homeLevel}>Уровень {value.homeLevel}</option>)}</select></label></div>
 <div className={styles.stageGrid}>{unlock && <HomeUnlockCard unlock={unlock} onSelect={onInspectItem} />}{stage && <StageCard stage={stage} onSelect={onInspectItem} />}</div>
 <div className={styles.boardNote}><h3>Повторяемые заказы</h3><p>{data.orderBoard.templates} шаблонов · {data.orderBoard.perResident ? `до ${data.orderBoard.slots} просьб, по одной у жителя` : `до ${data.orderBoard.slots} активных карточек`} · обновление каждые {time(data.orderBoard.refreshSeconds)}. Бесплатных замен: {data.orderBoard.freeReplacements}; затем {number(data.orderBoard.replacementPricePearls)} жемчужин.</p></div></section>;
}
