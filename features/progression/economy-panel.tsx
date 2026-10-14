"use client";

import { useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowRight, Calculator, Clock3, Coins, Gem, Package, Search, Sprout } from "lucide-react";
import { PlayerItemIcon } from "@/features/economy/ui/fishing/fish-discovery";
import { recipeResultName } from "@/features/economy/domain/recipe-prerequisites";
import { buildingLabels } from "./graph";
import { calculateRecipePlan, progressionEconomy, type EconomyHomeUnlock, type EconomyItem, type EconomyItemSource, type EconomyRecipe, type EconomyStage } from "./economy-data";
import styles from "./economy-panel.module.css";

const data = progressionEconomy;
const byId = new Map(data.items.map(item => [item.id, item]));
const recipeById = new Map(data.recipes.map(recipe => [recipe.id, recipe]));
const number = (value: number) => value.toLocaleString("ru-RU", { maximumFractionDigits: 2 });
const signed = (value: number) => `${value > 0 ? "+" : ""}${number(value)}`;
const searchWords = (value: string) => value.toLocaleLowerCase("ru-RU").replaceAll("ё", "е").split(/[^\p{L}\p{N}]+/u).filter(Boolean);
const categoryNames: Record<string, string> = { produce: "Урожай", material: "Материалы", crafted: "Переработка", provisions: "Еда и запасы", raw: "Рыба по классам", fishing: "Наживка", special: "Реликвии" };
const sourceNames = { starter: "Старт", recipe: "Производство", exploration: "Добыча", fishing: "Рыбалка", rare: "Находка", daily: "Подарок", project: "Проект дома", shop: "Лавка" };
const useNames = { recipe: "Рецепт", building: "Стройка", order: "Повторяемый заказ", project: "Поставка дома", meal: "Бонус еды", fishing: "Рыбалка", exploration: "Вылазка" };

function time(seconds: number) {
  if (seconds <= 0) return "Мгновенно";
  const days = Math.floor(seconds / 86400), hours = Math.floor(seconds % 86400 / 3600);
  const minutes = Math.floor(seconds % 3600 / 60), rest = Math.round(seconds % 60);
  return [days && `${number(days)} дн.`, hours && `${hours} ч`, minutes && `${minutes} мин`, rest && `${rest} с`].filter(Boolean).join(" ");
}

function ItemAmount({ id, count, onSelect }: { id: string; count: number; onSelect: (id: string) => void }) {
  return <button type="button" className={styles.ingredient} onClick={() => onSelect(id)} title={`Открыть: ${byId.get(id)?.name ?? id}`}>
    <PlayerItemIcon itemId={id} size={23} /><span>{byId.get(id)?.name ?? id}</span><b>×{number(count)}</b>
  </button>;
}

function Ingredients({ items, onSelect }: { items: Record<string, number>; onSelect: (id: string) => void }) {
  return <div className={styles.ingredients}>{Object.entries(items).map(([id, count]) => <ItemAmount key={id} id={id} count={count} onSelect={onSelect} />)}</div>;
}

function RecipeFlow({ recipe, runs = 1, onSelect }: { recipe: EconomyRecipe; runs?: number; onSelect: (id: string) => void }) {
  return <div className={styles.flow}>
    <div>{Object.keys(recipe.cost.items).length ? <Ingredients items={Object.fromEntries(Object.entries(recipe.cost.items).map(([id, count]) => [id, count * runs]))} onSelect={onSelect} /> : <span className={styles.freeInput}><Sprout size={17} aria-hidden="true" />Сбор без ингредиентов</span>}
      {!!recipe.cost.coins && <small>{number(recipe.cost.coins * runs)} монет</small>}</div>
    <ArrowRight className={styles.flowArrow} size={20} aria-label="Получится" />
    <Ingredients items={Object.fromEntries(Object.entries(recipe.rewards).map(([id, count]) => [id, count * runs]))} onSelect={onSelect} />
  </div>;
}

function RecipeCalculator({ recipe, onSelect }: { recipe: EconomyRecipe; onSelect: (id: string) => void }) {
  const [quantityText, setQuantityText] = useState("1");
  const quantity = Number(quantityText);
  const valid = quantityText.trim() !== "" && Number.isSafeInteger(quantity) && quantity >= 1 && quantity <= 999;
  const plan = useMemo(() => valid ? calculateRecipePlan(recipe.id, quantity) : null, [recipe.id, quantity, valid]);
  return <section className={styles.calculator} aria-label="Расчёт рецепта">
    <div className={styles.sectionTitle}><h4><Calculator size={18} aria-hidden="true" />Расчёт производства</h4>
      <label className={styles.quantity}>Количество<input type="number" min="1" max="999" step="1" inputMode="numeric" value={quantityText} aria-label="Количество готовых предметов" aria-invalid={!valid || undefined} onChange={event => setQuantityText(event.target.value)} /></label></div>
    {!valid ? <p className={styles.notice} role="alert">Введите целое количество от 1 до 999.</p> : plan && <>
      <RecipeFlow recipe={recipe} runs={quantity} onSelect={onSelect} />
      <dl className={styles.calculationStats}>
        <div><dt>Стоимость ингредиентов у NPC</dt><dd>{number(recipe.inputNpcValue * quantity)} монет</dd></div>
        {!!recipe.cost.coins && <div><dt>Монеты на запуск</dt><dd>{number(recipe.cost.coins * quantity)}</dd></div>}
        <div><dt>Выкуп готового товара NPC</dt><dd>{number(recipe.outputNpcValue * quantity)} монет</dd></div>
        <div data-positive={recipe.addedNpcValue > 0 || undefined}><dt>Прирост стоимости переработки</dt><dd>{signed(recipe.addedNpcValue * quantity)} монет</dd></div>
        <div><dt>Таймер выбранного производства</dt><dd>{time(recipe.seconds * quantity)}</dd></div>
        {!!recipe.collectionSeconds && <div><dt>Анимации сбора отдельно</dt><dd>{time(recipe.collectionSeconds * quantity)}</dd></div>}
      </dl>
      <p className={styles.hint}>Прирост — цена результата минус цена ингредиентов и монеты на запуск. Для сбора без ингредиентов это полная стоимость урожая. Один запуск занимает одно место; следующий запускается вручную.</p>
      <details className={styles.chain} open><summary>Вся цепочка до сырья</summary>
        <div className={styles.chainBody}>
          <p className={styles.hint}>Базовые рецепты раннего открытия, одно место каждого производства. Количество учитывает все промежуточные ингредиенты.</p>
          <h5>Собрать или добыть</h5><Ingredients items={plan.rawInputs} onSelect={onSelect} />
          {!!plan.miningSteps.length && <p className={styles.hint}>Единичная добыча шахтёра включена в очередь шахты.</p>}
          <h5>Запуски в производственной цепочке</h5>
          <ol className={styles.chainSteps}>{plan.steps.map(step => {
            const source = recipeById.get(step.recipeId);
            return source && <li key={step.recipeId}><div><span>{source.name}</span><small>{number(step.runs)} запусков · {buildingLabels[source.buildingId] ?? source.buildingId}</small></div><RecipeFlow recipe={source} runs={step.runs} onSelect={onSelect} /></li>;
          })}</ol>
          <h5>Занятость отдельных очередей</h5>
          <dl className={styles.queues}>{plan.queues.map(queue => <div key={queue.buildingId}><dt>{buildingLabels[queue.buildingId] ?? queue.buildingId}</dt><dd>{time(queue.seconds)}{!!queue.collectionSeconds && <small>+ {time(queue.collectionSeconds)} сбора</small>}</dd></div>)}</dl>
          {!!plan.coins && <p className={styles.hint}>Монеты на все запуски цепочки: {number(plan.coins)}.</p>}
          {!!plan.uncertainItemIds.length && <p className={styles.notice}>Отдельно получить: {plan.uncertainItemIds.map(id => byId.get(id)?.name ?? id).join(", ")}. Время случайного улова или находки не подставляется в расчёт.</p>}
          <ul className={styles.assumptions}>{plan.warnings.map(warning => <li key={warning}>{warning}</li>)}</ul>
        </div>
      </details>
      <details className={styles.chain}><summary>Теоретический выпуск и выручка за час</summary><div className={styles.chainBody}>
        <p>{number(recipe.unitsPerHour)} предметов · {number(recipe.grossNpcPerHour)} монет за час на одном месте.</p>
        <p>Прирост стоимости за час: {signed(recipe.addedNpcValue * 3600 / recipe.seconds)} монет.</p>
        <p className={styles.hint}>Считается только таймер выбранного рецепта при готовых ингредиентах и мгновенном перезапуске. Добыча, сбор урожая, ходьба и простои уменьшают реальный доход; это валовая выручка.</p>
      </div></details>
    </>}
  </section>;
}

function SourceCalculator({ source, targetId, onSelect }: { source: EconomyItemSource; targetId: string; onSelect: (id: string) => void }) {
  const [quantityText, setQuantityText] = useState("1");
  const quantity = Number(quantityText);
  const valid = quantityText.trim() !== "" && Number.isSafeInteger(quantity) && quantity >= 1 && quantity <= 999;
  const runs = valid ? Math.ceil(quantity / (source.rewards?.[targetId] ?? 1)) : 0;
  const inputs = Object.fromEntries(Object.entries(source.cost?.items ?? {}).map(([id, count]) => [id, count * runs]));
  const outputs = Object.fromEntries(Object.entries(source.rewards ?? {}).map(([id, count]) => [id, count * runs]));
  const inputValue = Object.entries(inputs).reduce((sum, [id, count]) => sum + (byId.get(id)?.npcSellPrice ?? 0) * count, 0);
  const outputValue = Object.entries(outputs).reduce((sum, [id, count]) => sum + (byId.get(id)?.npcSellPrice ?? 0) * count, 0);
  const coins = (source.cost?.coins ?? 0) * runs;
  return <section className={styles.calculator} aria-label="Расчёт добычи"><div className={styles.sectionTitle}><h4><Calculator size={18} aria-hidden="true" />Расчёт добычи</h4><label className={styles.quantity}>Нужно<input type="number" min="1" max="999" step="1" inputMode="numeric" value={quantityText} aria-label="Нужное количество материала" aria-invalid={!valid || undefined} onChange={event => setQuantityText(event.target.value)} /></label></div>
    {!valid ? <p className={styles.notice} role="alert">Введите целое количество от 1 до 999.</p> : <>
      <p className={styles.hint}>Цель: {byId.get(targetId)?.name ?? targetId} ×{number(quantity)}. Запусков маршрута: {number(runs)}; весь гарантированный набор:</p><Ingredients items={outputs} onSelect={onSelect} />
      {(Object.keys(inputs).length > 0 || coins > 0) && <><h4 className={styles.sourceCosts}>Потребуется</h4><Ingredients items={inputs} onSelect={onSelect} />{!!coins && <p className={styles.hint}>{number(coins)} монет</p>}</>}
      <dl className={styles.calculationStats}><div><dt>Очередь выбранного маршрута</dt><dd>{time((source.seconds ?? 0) * runs)}</dd></div><div><dt>Стоимость затрат у NPC</dt><dd>{number(inputValue + coins)} монет</dd></div><div><dt>Выкуп гарантированного набора NPC</dt><dd>{number(outputValue)} монет</dd></div><div data-positive={outputValue - inputValue - coins > 0 || undefined}><dt>Прирост стоимости</dt><dd>{signed(outputValue - inputValue - coins)} монет</dd></div></dl>
      <p className={styles.hint}>Запуски округлены вверх до целого маршрута; побочные материалы остаются в наборе. Время подготовки и открытия маршрута, ходьба и простои считаются отдельно. Случайные находки и улов не прибавлены.</p>
    </>}
  </section>;
}

function ItemDetails({ item, home, onSelect }: { item: EconomyItem; home: number; onSelect: (id: string) => void }) {
  const recipes = data.recipes.filter(recipe => !!recipe.rewards[item.id] && (!home || recipe.unlockHomeLevel <= home));
  const routes = item.sources.filter(source => source.kind === "exploration" && source.guaranteed && source.rewards && source.seconds && (!home || source.homeLevel <= home));
  const [recipeId, setRecipeId] = useState("");
  const [routeId, setRouteId] = useState("");
  const calculationRef = useRef<HTMLElement>(null);
  const recipe = recipes.find(value => value.id === recipeId) ?? recipes[0];
  const route = routes.find(source => source.id === routeId) ?? routes.find(source => Object.keys(source.rewards ?? {}).length === 1 && source.quantity === 1) ?? routes[0];
  return <article id="economy-item-details" tabIndex={-1} className={styles.itemDetail} data-economy-item={item.id}>
    <header className={styles.itemHeading}><PlayerItemIcon itemId={item.id} size={49} /><div><p>{item.kind === "fish-species" ? "Вид рыбы" : categoryNames[item.category] ?? "Предмет"}</p><h3>{item.name}</h3></div><span className={styles.price}>{item.npcSellPrice === null ? "Не продаётся NPC" : <><Coins size={16} aria-hidden="true" />{number(item.npcSellPrice)}<small>выкуп NPC / шт.</small></>}</span></header>
    {item.meal && <div className={styles.guarantee}><strong>Характеристики обеда</strong><p className={styles.hint}>Мохлик: +{number(item.meal.heroSpeedBps / 100)}% скорости одной вылазки. Строитель: +{number(item.meal.builderSpeedBps / 100)}% скорости одной стройки. Одно блюдо расходуется на выбранное занятие; шахтёра обед не ускоряет.</p></div>}
    {item.inventoryItemId && <p className={styles.notice}>В рецептах учитывается как <button type="button" onClick={() => onSelect(item.inventoryItemId!)}>{byId.get(item.inventoryItemId)?.name ?? item.inventoryItemId}</button>. Покупка рыбы не открывает её вид в личной коллекции.</p>}
    <section className={styles.detailSection}><h4>Где получить</h4><div className={styles.sources}>{item.sources.map(source => <div key={source.id} className={styles.source}>
      <div><span className={styles.sourceKind}>{sourceNames[source.kind]} · дом {source.homeLevel}</span><strong>{source.name}</strong><p>{source.detail}</p>
        {!!Object.keys(source.requiredBuildings ?? {}).length && <p>Постройки: {Object.entries(source.requiredBuildings ?? {}).map(([id, level]) => `${buildingLabels[id] ?? id} ${level}`).join(" · ")}</p>}
        {!!Object.keys(source.requiredRecipes ?? {}).length && <p>Сначала получить: {Object.entries(source.requiredRecipes ?? {}).map(([id, count]) => `${recipeResultName(id, data)} ×${count}`).join(" · ")}</p>}
        {source.cost && (source.cost.coins > 0 || Object.keys(source.cost.items).length > 0) && <div className={styles.sourceCosts}><span>На запуск{source.cost.coins > 0 && <> · {number(source.cost.coins)} монет</>}</span><Ingredients items={source.cost.items} onSelect={onSelect} /></div>}
        {source.rewards && Object.keys(source.rewards).length > 1 && <div className={styles.sourceCosts}><span>Весь гарантированный набор маршрута</span><Ingredients items={source.rewards} onSelect={onSelect} /></div>}
      </div>
      <div className={styles.sourceNumbers}>{source.quantity !== undefined && <b>×{number(source.quantity)}</b>}{source.seconds !== undefined && <span><Clock3 size={13} aria-hidden="true" />{time(source.seconds)}</span>}<small data-chance={!source.guaranteed || undefined}>{source.guaranteed ? "Фиксированная выдача" : "Зависит от находки / выбора"}</small>{source.recipeId && recipes.some(value => value.id === source.recipeId) && <button type="button" onClick={() => { setRecipeId(source.recipeId!); calculationRef.current?.scrollIntoView({ block: "start" }); calculationRef.current?.focus({ preventScroll: true }); }}>Рассчитать <ArrowDown size={12} aria-hidden="true" /></button>}</div>
    </div>)}</div>{!item.sources.length && <p className={styles.hint}>Действующий источник этого предмета в каталоге не задан.</p>}</section>
    {recipe && <section ref={calculationRef} tabIndex={-1} className={styles.detailSection}><label className={styles.recipeSelect}>Вариант производства<select aria-label="Вариант рецепта" value={recipe.id} onChange={event => setRecipeId(event.target.value)}>{recipes.map(value => <option key={value.id} value={value.id}>{value.name} · {time(value.seconds)}</option>)}</select></label>
      <p className={styles.hint}>Дом {recipe.requiredHomeLevel} · {buildingLabels[recipe.buildingId] ?? recipe.buildingId} {recipe.buildingLevel}{Object.entries(recipe.requiredBuildings).map(([id, level]) => ` · ${buildingLabels[id] ?? id} ${level}`)}{Object.entries(recipe.requiredRecipes).map(([id, count]) => ` · сначала получить «${recipeResultName(id, data)}» ×${count}`)}</p>
      <RecipeCalculator key={recipe.id} recipe={recipe} onSelect={onSelect} /></section>}
    {!recipe && route && <section className={styles.detailSection}><label className={styles.recipeSelect}>Вариант добычи<select aria-label="Маршрут добычи" value={route.id} onChange={event => setRouteId(event.target.value)}>{routes.map(source => <option key={source.id} value={source.id}>{source.name} · {time(source.seconds ?? 0)}</option>)}</select></label><SourceCalculator key={route.id} source={route} targetId={item.id} onSelect={onSelect} /></section>}
    <section className={styles.detailSection}><h4>Куда идёт дальше</h4>{item.uses.length ? <ul className={styles.uses}>{item.uses.map(use => <li key={use.id}><div><small>{useNames[use.kind]} · дом {use.homeLevel}</small>{use.kind === "recipe" && recipeById.has(use.id.replace(/^recipe:/, "")) ? <button type="button" onClick={() => {
        const next = recipeById.get(use.id.replace(/^recipe:/, ""));
        const output = Object.keys(next?.rewards ?? {})[0]; if (output) onSelect(output);
      }}>{use.name}<ArrowRight size={14} aria-hidden="true" /></button> : <span>{use.name}</span>}</div><b>×{number(use.quantity)}</b></li>)}</ul> : <p className={styles.hint}>Следующих рецептов или строительных затрат для предмета сейчас нет.</p>}</section>
  </article>;
}

function StageCard({ stage, onSelect }: { stage: EconomyStage; onSelect: (id: string) => void }) {
  const target = stage.buildings.find(building => building.id === "home" && building.level === stage.nextHomeLevel);
  const earlyLandmarks = stage.buildings.filter(building => (building.id === "bridge" || building.id === "lighthouse") && building.availableHomeLevel < stage.homeLevel);
  return <article className={styles.stageCard}>
    <header><h3>Дом {stage.homeLevel} <ArrowRight size={19} aria-hidden="true" /> {stage.nextHomeLevel}</h3><span data-preliminary={stage.preliminary || undefined}>{stage.preliminary ? "Предварительный баланс" : "Текущие требования"}</span></header>
    <dl className={styles.stageStats}><div><dt>Обязательные стройки</dt><dd>{number(stage.buildingCoins)} монет</dd></div><div><dt>Поставки этапа</dt><dd>{stage.orders.length} · +{number(stage.orderCoins)} монет</dd></div><div><dt>Заказы минус стройки</dt><dd>{signed(stage.orderCoins - stage.buildingCoins)} монет</dd></div><div><dt>Очередь одного строителя</dt><dd>{time(stage.buildSeconds)}</dd></div></dl>
    {stage.homeLevel === 1 && <div className={styles.guarantee}><strong>Старт: {number(data.starter.coins)} монет{data.starter.pearls > 0 && <>, {number(data.starter.pearls)} жемчужин</>}</strong><Ingredients items={data.starter.items} onSelect={onSelect} /><p className={styles.hint}>Старт + вводные заказы − стройки: {number(data.starter.coins)} + {number(stage.orderCoins)} − {number(stage.buildingCoins)} = {number(data.starter.coins + stage.orderCoins - stage.buildingCoins)} монет.</p></div>}
    {stage.orderCoins < stage.buildingCoins && <p className={styles.hint}>Для покрытия разницы нужны повторяемые заказы или продажа товаров NPC. Начальные монеты хозяйства здесь не прибавлены.</p>}
    {stage.homeLevel === 4 && <p className={styles.hint}>Поставки дома 5 — разовое финансирование развития дальнего берега и хозяйства жителями. Их выплаты включают вклад в проект; обычные повторяемые заказы рассчитываются отдельно.</p>}
    {earlyLandmarks.length > 0 && <p className={styles.gate}>Бюджет включает ещё не восстановленные объекты: {earlyLandmarks.map(building => `${buildingLabels[building.id]} (доступен с дома ${building.availableHomeLevel})`).join(" и ")}. Если восстановить их раньше, на этом этапе нужно на {number(earlyLandmarks.reduce((sum, building) => sum + building.cost.coins, 0))} монет и {time(earlyLandmarks.reduce((sum, building) => sum + building.seconds, 0))} стройки меньше. Повторной оплаты нет.</p>}
    {!!stage.minimumGateSeconds && <p className={styles.gate}>Между поставками: {time(stage.intervalSeconds)}. Всего обязательного ожидания: {time(stage.minimumGateSeconds)}{target && <>; затем стройка дома {time(target.seconds)}</>}. Жемчуг не сокращает интервалы поставок.</p>}
    {stage.preliminary && <p className={styles.hint}>Текущие требования доступны для просмотра, но темп этого этапа ещё предстоит дорабатывать.</p>}
    <details className={styles.chain}><summary>Стоимость каждой стройки</summary><div className={styles.chainBody}>{stage.buildings.map(building => <div className={styles.buildingCost} key={`${building.id}:${building.level}`}><div><strong>{building.name} {building.level}</strong><span>{number(building.cost.coins)} монет · {time(building.seconds)}</span></div><Ingredients items={building.cost.items} onSelect={onSelect} /></div>)}<p className={styles.hint}>Это новые уровни относительно требований предыдущего дома. Уже построенные уровни повторно не оплачиваются. Кладовая не входит в обязательные стройки.</p></div></details>
    <details className={styles.chain}><summary>Общие объёмы материалов этапа</summary><div className={styles.chainBody}><h5>Для всех обязательных строек</h5><Ingredients items={stage.buildingItems} onSelect={onSelect} />{!!Object.keys(stage.orderItems).length && <><h5>Для всех поставок</h5><Ingredients items={stage.orderItems} onSelect={onSelect} /></>}<p className={styles.hint}>Материалы тратятся постепенно. Самый крупный набор для одной стройки: {Math.max(0, ...stage.buildings.map(building => Object.values(building.cost.items).reduce((sum, count) => sum + count, 0)))} предметов. Сырьё для промежуточных изделий раскрывается в их карточках.</p></div></details>
    {!!stage.orders.length && <details className={styles.chain}><summary>Все поставки этапа</summary><ol className={styles.stageOrders}>{stage.orders.map(order => <li key={order.id}><div><strong>{order.name}</strong><span>+{number(order.coins)} монет</span></div><Ingredients items={order.items} onSelect={onSelect} /><small>Цена товаров у NPC: {number(order.inputNpcValue)}; доплата {stage.homeLevel === 4 ? "проекта" : "заказа"}: +{number(order.addedNpcValue)} монет.</small>{Object.keys(order.requiredBuildings).length > 0 && <small>Сначала улучшить: {Object.entries(order.requiredBuildings).map(([id, level]) => `${buildingLabels[id] ?? id} ${level}`).join(" · ")}</small>}{Object.keys(order.requiredExplorations).length > 0 && <small>Получить результат вылазки: {Object.entries(order.requiredExplorations).map(([id, count]) => `${data.items.flatMap(item => item.sources).find(source => source.routeId === id)?.name ?? id} ×${count}`).join(" · ")}. Запуск или отмена не засчитываются.</small>}</li>)}</ol></details>}
    {!!Object.keys(stage.completionRewards).length && <div className={styles.guarantee}><strong>Гарантированная награда за весь проект</strong><Ingredients items={stage.completionRewards} onSelect={onSelect} /></div>}
  </article>;
}

function HomeUnlockCard({ unlock, onSelect }: { unlock: EconomyHomeUnlock; onSelect: (id: string) => void }) {
  const berries = new Set(unlock.berries.map(berry => berry.itemId));
  const products = unlock.newItems.filter(id => !berries.has(id));
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
    {unlock.landmarks.map(landmark => <div className={styles.guarantee} key={`${landmark.id}:${landmark.level}`}><strong>{landmark.name}: {number(landmark.cost.coins)} монет · {time(landmark.seconds)}</strong><Ingredients items={landmark.cost.items} onSelect={onSelect} /><p className={styles.hint}>{landmark.id === "bridge" ? "После получения восстановления открывается рынок игроков. Для следующего дома мост необязателен; поздний проект потребует его." : "После получения восстановления включается ночной свет. Пароход с большими заказами запланирован; сейчас его нет. Для следующего дома маяк необязателен."}</p></div>)}
    <details className={styles.chain}><summary>Все новые рецепты: {unlock.recipes.length}</summary><div className={styles.chainBody}><ul className={styles.unlockRecipes}>{unlock.recipes.map(id => {
      const recipe = recipeById.get(id);
      if (!recipe) return null;
      return <li key={id}><button type="button" onClick={() => onSelect(Object.keys(recipe.rewards)[0])}>{recipe.name}<ArrowRight size={13} aria-hidden="true" /></button><small>{buildingLabels[recipe.buildingId]} {recipe.buildingLevel} · {time(recipe.seconds)}</small></li>;
    })}</ul></div></details>
  </article>;
}

export function EconomyPanel() {
  const [query, setQuery] = useState("");
  const [home, setHome] = useState(0);
  const [category, setCategory] = useState("all");
  const [selectedId, setSelectedId] = useState("berries");
  const ingredientsRef = useRef<HTMLElement>(null);
  const filtered = useMemo(() => {
    const search = searchWords(query);
    return data.items.filter(item => (category === "all" || (category === "fish" ? item.kind === "fish-species" || item.category === "raw" || item.id === "fish" : item.category === category))
      && (!home || item.sources.some(source => source.homeLevel <= home))
      && (!search.length || search.every(word => searchWords(`${item.name} ${item.id} ${categoryNames[item.category] ?? ""} ${item.sources.map(source => source.name).join(" ")}`).some(candidate => candidate.startsWith(word)))));
  }, [query, home, category]);
  const selected = filtered.find(item => item.id === selectedId) ?? filtered[0];
  function selectItem(id: string) {
    if (!byId.has(id)) return;
    setQuery(""); setCategory("all"); setHome(0); setSelectedId(id);
    if (typeof window !== "undefined") window.requestAnimationFrame(() => {
      const details = document.getElementById("economy-item-details");
      details?.scrollIntoView({ block: "start" });
      details?.focus({ preventScroll: true });
    });
  }
  function selectFromList(id: string) {
    setSelectedId(id);
    if (typeof window !== "undefined" && window.matchMedia?.("(max-width: 780px)").matches) window.requestAnimationFrame(() => document.getElementById("economy-item-details")?.scrollIntoView({ block: "start" }));
  }
  return <section className={styles.panel} aria-label="Ингредиенты и расчёты экономики">
    <div className={styles.intro}><div><p className={styles.eyebrow}>Справочник хозяйства · каталог {data.catalogVersion}</p><h2>Из чего складывается хозяйство</h2><p>От сырья до готового предмета: источники, рецепты, стоимость и очереди производства. Нажмите на ингредиент, чтобы проследить его цепочку.</p></div><dl className={styles.overview}><div><dt>Предметов</dt><dd>{data.items.length}</dd></div><div><dt>Рецептов</dt><dd>{data.recipes.length}</dd></div><div><dt>Предмет за запуск</dt><dd>1</dd></div></dl></div>
    <nav className={styles.contents} aria-label="Разделы экономики"><a href="#economy-unlocks"><Sprout size={16} aria-hidden="true" />Открытия домов</a><a href="#economy-ingredients"><Package size={16} aria-hidden="true" />Ингредиенты</a><a href="#economy-stages"><Calculator size={16} aria-hidden="true" />Этапы домов</a><a href="#economy-pearls"><Gem size={16} aria-hidden="true" />Жемчуг и рынок</a></nav>
    <section id="economy-unlocks" className={styles.unlocks}><div className={styles.sectionHeading}><div><h2>Ради чего улучшать дом</h2><p>Каждый дом открывает новые ягоды и товары. Уровень дома даёт доступ к развитию: рецепту также нужны указанное производство и предыдущие открытия. Одна единица занимает одно место производства до получения.</p></div></div><div className={styles.unlockGrid}>{data.homeUnlocks.map(unlock => <HomeUnlockCard key={unlock.homeLevel} unlock={unlock} onSelect={selectItem} />)}</div></section>
    <section ref={ingredientsRef} id="economy-ingredients" className={styles.library}>
      <div className={styles.sectionHeading}><div><h2>Все ингредиенты и предметы</h2><p>Справочник показывает весь каталог. В игре покупка на рынке доступна после личного открытия предмета.</p></div><span role="status">{filtered.length} из {data.items.length}</span></div>
      <div className={styles.filters}><label className={styles.search}><Search size={17} aria-hidden="true" /><input type="search" value={query} placeholder="Малина, балка, уха…" aria-label="Найти ингредиент" onChange={event => setQuery(event.target.value)} /></label><label>Источники по дому<select aria-label="Уровень дома для справочника" value={home} onChange={event => setHome(Number(event.target.value))}><option value={0}>Все уровни</option>{[1, 2, 3, 4, 5].map(level => <option key={level} value={level}>До дома {level}</option>)}</select></label><label>Категория<select aria-label="Категория ингредиентов" value={category} onChange={event => setCategory(event.target.value)}><option value="all">Все предметы</option><option value="material">Материалы</option><option value="crafted">Переработка</option><option value="provisions">Еда и запасы</option><option value="fish">Вся рыба</option><option value="produce">Урожай и находки</option><option value="fishing">Наживка</option><option value="special">Реликвии</option></select></label></div>
      <div className={styles.libraryGrid}><div className={styles.itemBrowser}>{selected && <a className={styles.detailLink} href="#economy-item-details">К карточке ингредиента →</a>}<ul className={styles.itemList} aria-label="Предметы каталога">{filtered.map(item => <li key={item.id}><button type="button" data-item-id={item.id} aria-pressed={selected?.id === item.id} onClick={() => selectFromList(item.id)}><PlayerItemIcon itemId={item.id} size={32} /><span><strong>{item.name}</strong><small>{item.kind === "fish-species" ? "Вид рыбы" : categoryNames[item.category] ?? "Предмет"}</small></span><span className={styles.listPrice}>{item.npcSellPrice === null ? "—" : number(item.npcSellPrice)}<small>NPC</small></span></button></li>)}</ul>{!filtered.length && <p className={styles.empty}>Ничего не найдено. Измените поиск или фильтры.</p>}</div>{selected ? <ItemDetails key={selected.id} item={selected} home={home} onSelect={selectItem} /> : <div className={styles.empty}>Выберите другой поиск, чтобы увидеть источники и рецепты.</div>}</div>
    </section>
    <section id="economy-stages" className={styles.stages}><div className={styles.sectionHeading}><div><h2>Что нужно для следующего дома</h2><p>Стройки, материалы и обязательные поставки. Сумма строительных таймеров не равна длительности прохождения: производства работают параллельно.</p></div></div><div className={styles.stageGrid}>{data.stages.map(stage => <StageCard key={stage.homeLevel} stage={stage} onSelect={selectItem} />)}</div>
      <div className={styles.boardNote}><h3>Повторяемые заказы работают отдельно</h3><p>{data.orderBoard.templates} шаблонов · {data.orderBoard.slots} активные карточки · обновление каждые {time(data.orderBoard.refreshSeconds)}. После сдачи появляется следующий заказ. Бесплатных замен: {data.orderBoard.freeReplacements}; затем {number(data.orderBoard.replacementPricePearls)} жемчужин за замену.</p></div>
    </section>
    <section id="economy-pearls" className={styles.pearls}><div className={styles.sectionHeading}><div><h2>Жемчуг, рынок и реликвии</h2><p>Все суммы ниже — жемчужины, которые видит игрок.</p></div></div><div className={styles.pearlGrid}>
      <article><h3>Бесплатное получение</h3>
        <dl className={styles.calculationStats}><div><dt>За {data.pearls.dailyCycleLength} полученных подарков</dt><dd>{number(data.pearls.dailyCycle)} <Gem size={15} aria-label="жемчужин" /></dd></div><div><dt>Все достижения однократно</dt><dd>{number(data.pearls.achievementLifetime)} <Gem size={15} aria-label="жемчужин" /></dd></div></dl>
        <table className={styles.priceTable}><caption>Жемчуг за каждый полученный подарок</caption><thead><tr><th scope="col">Подарок</th><th scope="col">Жемчуг</th></tr></thead><tbody>{data.pearls.dailyRewards.map(reward => <tr key={reward.step}><th scope="row">{reward.step}</th><td>{number(reward.pearls)}</td></tr>)}</tbody></table>
        <p className={styles.hint}>Для подарка нужны новая дата UTC и минимум {data.pearls.dailyMinimumHours} часов после предыдущего. Это цикл получений, а не автоматическая календарная неделя.</p>
        <details className={styles.chain}><summary>Награды за достижения</summary><div className={styles.chainBody}><p className={styles.hint}>Размер награды зависит от сложности цели. Каждая выполненная ступень оплачивается один раз; уже полученные награды повторно не выдаются.</p><table className={styles.priceTable}><caption>Цели и жемчуг за каждую ступень</caption><thead><tr><th scope="col">Достижение</th><th scope="col">Цели</th><th scope="col">Жемчуг</th></tr></thead><tbody>{data.pearls.achievementRewards.map(quest => <tr key={quest.id}><th scope="row" title={quest.description}>{quest.title}</th><td>{quest.tiers.map(tier => number(tier.target)).join(" / ")}</td><td>{quest.tiers.map(tier => number(tier.pearls)).join(" / ")}</td></tr>)}</tbody></table></div></details>
      </article>
      <article><h3>Места на рынке</h3><p>Дом {data.market.homeLevel}{Object.entries(data.market.requiredBuildings).map(([id, level]) => ` · ${buildingLabels[id] ?? id} ${level}`)}{data.market.requiredExplorations > 0 && ` · получено вылазок ${data.market.requiredExplorations}`}. Рынок откроется после получения готового восстановления.</p><p>{data.pearls.marketBaseSlots} бесплатных мест, максимум {data.pearls.marketBaseSlots + data.pearls.marketSlotPrices.length}.</p><ol className={styles.slotPrices}>{data.pearls.marketSlotPrices.map((price, index) => <li key={index}><span>Место {data.pearls.marketBaseSlots + index + 1}</span><strong>{number(price)} <Gem size={14} aria-label="жемчужин" /></strong></li>)}</ol><p className={styles.hint}>Покупаются по порядку. Все расширения вместе: {number(data.pearls.marketTotal)} жемчужин. Неизвестные игроку товары скрыты из витрины.</p></article>
      <article><h3>Производства и стройка</h3><ul className={styles.simpleList}>{data.pearls.productionSlots.map(upgrade => <li key={upgrade.slots}>Место производства {upgrade.slots}: <strong>{number(upgrade.pearls)} жемчужин</strong></li>)}</ul><p>Ускорение стройки считается по оставшемуся времени{data.pearls.construction.curved ? " и кривой цен" : ""}. Цена округляется вверх до {number(data.pearls.construction.stepPearls)} жемчужины.</p><table className={styles.priceTable}><caption>Примеры ускорения одной стройки</caption><thead><tr><th scope="col">Осталось</th><th scope="col">Жемчуг</th></tr></thead><tbody>{data.pearls.construction.prices.map(price => <tr key={price.seconds}><th scope="row">{time(price.seconds)}</th><td>{number(price.pearls)}</td></tr>)}</tbody></table><p className={styles.hint}>Это цена каждого отдельного остатка. Таймеры разных строек нельзя складывать для расчёта: каждое завершение оплачивается отдельно. Места покупаются отдельно для каждого производства. Интервалы проектных поставок не ускоряются.</p>{data.fishingShop && <p className={styles.hint}>Обновление лавки Плёски: до {number(data.fishingShop.maximumRefreshPearls)} жемчужин в начале {time(data.fishingShop.refreshSeconds)} ожидания. Цена уменьшается с оставшимся временем; после таймера обновление бесплатно.</p>}</article>
      <article><h3>Внутренний магазин</h3><p>Предпросмотр условий. Покупка жемчуга и обмен на монеты пока недоступны.</p><ul className={styles.simpleList}>{data.currencyShop.pearlPackages.map(pack => <li key={pack.id}>{pack.name}: <strong>{number(pack.pearls)} жемчужин</strong></li>)}</ul><table className={styles.priceTable}><caption>Монеты за жемчуг: бонус дома, без бонуса производств</caption><thead><tr><th scope="col">Дом</th>{data.currencyShop.goldPrices.map(price => <th scope="col" key={price}>{number(price)} жемч.</th>)}</tr></thead><tbody>{data.currencyShop.goldByHome.map(row => <tr key={row.homeLevel}><th scope="row">{row.homeLevel}</th>{row.offers.map(offer => <td key={offer.pearls}>{number(offer.coins)}</td>)}</tr>)}</tbody></table><p className={styles.hint}>Полученные уровни производств добавляют до {data.currencyShop.productionBonusPercent}% к базовой выдаче. Кладовая, мост и маяк на курс не влияют. Максимум: {number(data.currencyShop.maximumGold)} монет за {number(data.currencyShop.goldPrices.at(-1) ?? 0)} жемчужин.</p></article>
      <article><h3>Реликвии без оплаты</h3><p>Находки доступны после открытия дома 3. Два независимых счётчика работают у Мохлика и шахтёра.</p><p>Проект дома 4 гарантирует живую смолу. Проект дома 5 — древнее ядро и лунный кристалл; последний подарок цикла также даёт ядро.</p><p className={styles.hint}>Кладовая растёт с {data.storage[0]?.capacity ?? 0} до {data.storage.at(-1)?.capacity ?? 0} мест. Её улучшение служит удобством и не требуется для перехода к следующему дому.</p><details className={styles.chain}><summary>Все расширения кладовой</summary><div className={styles.chainBody}>{data.storage.map(level => <div className={styles.buildingCost} key={level.level}><div><strong>Уровень {level.level} · {number(level.capacity)} мест</strong><span>Дом {level.homeLevel} · {time(level.seconds)}</span></div>{level.cost.coins > 0 && <p className={styles.hint}>{number(level.cost.coins)} монет</p>}<Ingredients items={level.cost.items} onSelect={selectItem} /></div>)}</div></details></article>
    </div></section>
    <footer className={styles.footer}>Цены, рецепты и требования взяты из действующего каталога; условия магазина валют пока показаны как предпросмотр. Варианты добычи и случайные награды показаны отдельно от гарантированных производств. Очереди работают параллельно; срок прохождения зависит от посещений, запасов и выбранных маршрутов.</footer>
  </section>;
}
