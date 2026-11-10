"use client";

import { useMemo, useRef } from "react";
import { ArrowDown, ArrowRight, Calculator, Clock3, Coins } from "lucide-react";
import { PlayerItemIcon } from "@/features/economy/ui/fishing/fish-discovery";

import { buildingLabels } from "@/features/progression/domain/labels";
import { calculateRecipePlan, type EconomyItem, type EconomyItemSource, type EconomyRecipe } from "@/features/progression/domain/economy-data";
import { useBranchState } from "@/features/progression/ui/shell/branch-session";
import styles from "@/features/progression/ui/shared/economy-reference.module.css";

import { data, byId, recipeById, number, signed, categoryNames, sourceNames, useNames, RecipeDiscovery, time, Ingredients, RecipeFlow } from "@/features/progression/ui/shared/reference-parts";
export function RecipeCalculator({ recipe, onSelect }: { recipe: EconomyRecipe; onSelect: (id: string) => void }) {
  const [quantityText, setQuantityText] = useBranchState(`recipe.${recipe.id}.quantity`, "1");
  const quantity = Number(quantityText);
  const valid = quantityText.trim() !== "" && Number.isSafeInteger(quantity) && quantity >= 1 && quantity <= 999;
  const plan = useMemo(() => valid ? calculateRecipePlan(recipe.id, quantity) : null, [recipe.id, quantity, valid]);
  return <section className={styles.calculator} aria-label="Расчёт рецепта">
    <div className={styles.sectionTitle}><h4><Calculator size={18} aria-hidden="true" />Расчёт производства</h4>
      <label className={styles.quantity}>{recipe.experiment ? "Попытки" : "Количество"}<input type="number" min="1" max="999" step="1" inputMode="numeric" value={quantityText} aria-label={recipe.experiment ? "Количество попыток приготовления" : "Количество готовых предметов"} aria-invalid={!valid || undefined} onChange={event => setQuantityText(event.target.value)} /></label></div>
    {!valid ? <p className={styles.notice} role="alert">Введите целое количество от 1 до 999.</p> : plan && <>
      <RecipeFlow recipe={recipe} runs={quantity} onSelect={onSelect} />
      {recipe.experiment && <div className={styles.notice} data-experiment-odds>
        <p>Необязательный опыт. Базовый шанс удачи {number(recipe.successProbability * 100)}%; навык кулинарии повышает его до 95%. Ниже считается среднее при базовом шансе.</p>
        <p>При промахе вместо нового блюда получится:</p><Ingredients items={recipe.experiment.failureRewards} onSelect={onSelect} />
        <p>Количество попыток не гарантирует столько же удачных блюд. Обычные рецепты готовятся без риска.</p>
      </div>}
      <dl className={styles.calculationStats}>
        <div><dt>Стоимость ингредиентов у NPC</dt><dd>{number(recipe.inputNpcValue * quantity)} монет</dd></div>
        {!!recipe.cost.coins && <div><dt>Монеты на запуск</dt><dd>{number(recipe.cost.coins * quantity)}</dd></div>}
        <div><dt>{recipe.experiment ? "Ожидаемый выкуп с учётом промахов" : "Выкуп готового товара NPC"}</dt><dd>{number(recipe.expectedOutputNpcValue * quantity)} монет</dd></div>
        <div data-positive={recipe.addedNpcValue > 0 || undefined}><dt>Прирост стоимости переработки</dt><dd>{signed(recipe.addedNpcValue * quantity)} монет</dd></div>
        <div><dt>Таймер выбранного производства</dt><dd>{time(recipe.seconds * quantity)}</dd></div>
        {!!recipe.collectionSeconds && <div><dt>Анимации сбора отдельно</dt><dd>{time(recipe.collectionSeconds * quantity)}</dd></div>}
      </dl>
      <p className={styles.hint}>Прирост: {recipe.experiment ? "ожидаемая цена удачного и простого блюда" : "цена результата"} минус цена ингредиентов и монеты на запуск. Для сбора без ингредиентов это полная стоимость урожая. Один запуск занимает одно место; следующий запускается вручную.</p>
      <details className={styles.chain} open><summary>Вся цепочка до сырья</summary>
        <div className={styles.chainBody}>
          <p className={styles.hint}>Базовые рецепты раннего открытия, одно место каждого производства. Количество учитывает все промежуточные ингредиенты.</p>
          {(recipe.collectionSeconds > 0 || plan.queues.some(queue => queue.collectionSeconds > 0)) && <p className={styles.hint}>Время сбора сложено для последовательных запусков на одном месте. Уже созревшие параллельные места собираются за один подход с общей серверной фазой не менее 8 секунд; перезагрузка её сохраняет.</p>}
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
        <p>{number(recipe.unitsPerHour)} {recipe.experiment ? "порций с учётом промахов" : "предметов"} · {number(recipe.grossNpcPerHour)} {recipe.experiment ? "монет в среднем" : "монет"} за час на одном месте.</p>
        <p>Прирост стоимости за час: {signed(recipe.addedNpcValue * 3600 / recipe.seconds)} монет.</p>
        <p className={styles.hint}>Считается только таймер выбранного рецепта при готовых ингредиентах и мгновенном перезапуске. Добыча, сбор урожая, ходьба и простои уменьшают реальный доход; это валовая выручка.</p>
      </div></details>
    </>}
  </section>;
}

export function SourceCalculator({ source, targetId, onSelect }: { source: EconomyItemSource; targetId: string; onSelect: (id: string) => void }) {
  const [quantityText, setQuantityText] = useBranchState(`source.${source.id}.${targetId}.quantity`, "1");
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

export function ItemDetails({ item, home, onSelect }: { item: EconomyItem; home: number; onSelect: (id: string) => void }) {
  const recipes = data.recipes.filter(recipe => !!recipe.rewards[item.id] && (!home || recipe.unlockHomeLevel <= home));
  const routes = item.sources.filter(source => source.kind === "exploration" && source.guaranteed && source.rewards && source.seconds && (!home || source.homeLevel <= home));
  const [recipeId, setRecipeId] = useBranchState(`item.${item.id}.recipe`, "");
  const [routeId, setRouteId] = useBranchState(`item.${item.id}.route`, "");
  const calculationRef = useRef<HTMLElement>(null);
  const recipe = recipes.find(value => value.id === recipeId) ?? recipes[0];
  const route = routes.find(source => source.id === routeId) ?? routes.find(source => Object.keys(source.rewards ?? {}).length === 1 && source.quantity === 1) ?? routes[0];
  return <article id="economy-item-details" tabIndex={-1} className={styles.itemDetail} data-economy-item={item.id}>
    <header className={styles.itemHeading}><PlayerItemIcon itemId={item.id} size={49} /><div><p>{item.kind === "fish-species" ? "Вид рыбы" : categoryNames[item.category] ?? "Предмет"}</p><h3>{item.name}</h3></div><span className={styles.price}>{item.npcSellPrice === null ? "Не продаётся NPC" : <><Coins size={16} aria-hidden="true" />{number(item.npcSellPrice)}<small>выкуп NPC / шт.</small></>}</span></header>
    {item.meal && <div className={styles.guarantee}><strong>Характеристики обеда</strong><p className={styles.hint}>Мохлик: +{number(item.meal.heroSpeedBps / 100)}% скорости{item.meal.heroWorkSeconds ? ` на ${time(item.meal.heroWorkSeconds)} обычного времени вылазок` : " одной вылазки"}. Строитель: +{number(item.meal.builderSpeedBps / 100)}% скорости{item.meal.builderWorkSeconds ? ` на ${time(item.meal.builderWorkSeconds)} обычной работы в одной стройке` : " одной стройки"}. Долгая стройка получает ускорение только на оплаченный запас работы, остаток идёт с обычной скоростью. Запас Мохлика тратится только при отправлении; остаток сохраняется. Шахтёра обед не ускоряет.</p></div>}
    {item.inventoryItemId && <p className={styles.notice}>В обычных рецептах подходит как <button type="button" onClick={() => onSelect(item.inventoryItemId!)}>{byId.get(item.inventoryItemId)?.name ?? item.inventoryItemId}</button>. Для именного блюда нужен именно этот вид в запасе. Покупка рыбы не открывает вид в личной коллекции.</p>}
    <section className={styles.detailSection}><h4>Где получить</h4><div className={styles.sources}>{item.sources.map(source => <div key={source.id} className={styles.source}>
      <div><span className={styles.sourceKind}>{sourceNames[source.kind]} · дом {source.homeLevel}</span><strong>{source.name}</strong><p>{source.detail}</p>
        {!!Object.keys(source.requiredBuildings ?? {}).length && <p>Постройки: {Object.entries(source.requiredBuildings ?? {}).map(([id, level]) => `${buildingLabels[id] ?? id} ${level}`).join(" · ")}</p>}
        <RecipeDiscovery source={source} />
        {source.cost && (source.cost.coins > 0 || Object.keys(source.cost.items).length > 0) && <div className={styles.sourceCosts}><span>На запуск{source.cost.coins > 0 && <> · {number(source.cost.coins)} монет</>}</span><Ingredients items={source.cost.items} onSelect={onSelect} /></div>}
        {source.rewards && Object.keys(source.rewards).length > 1 && <div className={styles.sourceCosts}><span>Весь гарантированный набор маршрута</span><Ingredients items={source.rewards} onSelect={onSelect} /></div>}
      </div>
      <div className={styles.sourceNumbers}>{source.quantity !== undefined && <b>×{number(source.quantity)}</b>}{source.seconds !== undefined && <span><Clock3 size={13} aria-hidden="true" />{time(source.seconds)}</span>}<small data-chance={!source.guaranteed || undefined}>{source.guaranteed ? "Фиксированная выдача" : "Зависит от находки / выбора"}</small>{source.recipeId && recipes.some(value => value.id === source.recipeId) && <button type="button" onClick={() => { setRecipeId(source.recipeId!); calculationRef.current?.scrollIntoView({ block: "start" }); calculationRef.current?.focus({ preventScroll: true }); }}>Рассчитать <ArrowDown size={12} aria-hidden="true" /></button>}</div>
    </div>)}</div>{!item.sources.length && <p className={styles.hint}>Действующий источник этого предмета в каталоге не задан.</p>}</section>
    {recipe && <section ref={calculationRef} tabIndex={-1} className={styles.detailSection}><label className={styles.recipeSelect}>Вариант производства<select aria-label="Вариант рецепта" value={recipe.id} onChange={event => setRecipeId(event.target.value)}>{recipes.map(value => <option key={value.id} value={value.id}>{value.name} · {time(value.seconds)}</option>)}</select></label>
      <p className={styles.hint}>Дом {recipe.requiredHomeLevel} · {buildingLabels[recipe.buildingId] ?? recipe.buildingId} {recipe.buildingLevel}{Object.entries(recipe.requiredBuildings).map(([id, level]) => ` · ${buildingLabels[id] ?? id} ${level}`)}</p>
      <RecipeDiscovery source={recipe} />
      <RecipeCalculator key={recipe.id} recipe={recipe} onSelect={onSelect} /></section>}
    {!recipe && route && <section className={styles.detailSection}><label className={styles.recipeSelect}>Вариант добычи<select aria-label="Маршрут добычи" value={route.id} onChange={event => setRouteId(event.target.value)}>{routes.map(source => <option key={source.id} value={source.id}>{source.name} · {time(source.seconds ?? 0)}</option>)}</select></label><SourceCalculator key={route.id} source={route} targetId={item.id} onSelect={onSelect} /></section>}
    <section className={styles.detailSection}><h4>Куда идёт дальше</h4>{item.uses.length ? <ul className={styles.uses}>{item.uses.map(use => <li key={use.id}><div><small>{useNames[use.kind]} · дом {use.homeLevel}</small>{use.kind === "recipe" && recipeById.has(use.id.replace(/^recipe:/, "")) ? <button type="button" onClick={() => {
        const next = recipeById.get(use.id.replace(/^recipe:/, ""));
        const output = Object.keys(next?.rewards ?? {})[0]; if (output) onSelect(output);
      }}>{use.name}<ArrowRight size={14} aria-hidden="true" /></button> : <span>{use.name}</span>}</div><b>×{number(use.quantity)}</b></li>)}</ul> : <p className={styles.hint}>Следующих рецептов или строительных затрат для предмета сейчас нет.</p>}</section>
  </article>;
}
