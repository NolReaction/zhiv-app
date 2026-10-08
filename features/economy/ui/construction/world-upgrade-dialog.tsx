"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Dialog } from "radix-ui";
import { ArrowRight, Check, ChevronDown, CircleHelp, Clock3, Compass, Hammer, House, LockKeyhole, Package, Pin, RefreshCw, Sparkles, Store, X } from "lucide-react";
import type { WorldHelpContext } from "@/features/world/ui/help/world-help-types";
import { ItemIcon } from "@/features/items/item-icon";
import { economyCatalog, type EconomyCost, type EconomyView } from "@/features/economy/domain/model";
import type { EconomyController } from "@/features/economy/sync/use-economy";
import type { ConstructionGoalController } from "./use-construction-goal";
import { ConstructionSpeedup } from "./construction-speedup";
import { WorldMealBoost } from "@/features/economy/ui/food/world-meal-boost";
import { mealDuration, pendingMeal } from "@/features/economy/domain/food";
import { economyBuilderStatus } from "@/features/economy/domain/builder-status";
import { locked, type ReadyEconomy } from "@/features/economy/sync/controller-state";
import { Requirements, Work, ProductIcon, itemName, stationIcons, stationName, number, type StationNavigation } from "@/features/economy/ui/shared/world-economy-parts";
import { worldConstructionReason, worldDuration, worldMaterialSource, worldMissingRequirements, worldRequirements, type WorldBuildingLevel } from "@/features/economy/ui/shared/world-stations";
import menuStyles from "@/features/economy/ui/stations/world-object-menu.module.css";
import styles from "./world-upgrade-dialog.module.css";

export type WorldUpgradeDialogProps = {
  stationId: string | null;
  economy: EconomyController;
  onClose: () => void;
  onCompleted?: () => void;
  navigation?: StationNavigation;
  constructionGoal?: ConstructionGoalController;
  onOpenPantry?: () => void;
  onOpenHelp?: (context: WorldHelpContext) => void;
  isOnline?: boolean;
  onOpenMeals?: () => void;
  onCloseAutoFocus?: (event: Event) => void;
};

/** A level satisfies one requirement; other stations may still be needed. */
export function worldUpgradeUnlocks(state: EconomyView, stationId: string, target: WorldBuildingLevel) {
  const usesLevel = (value: Parameters<typeof worldRequirements>[0], recipe?: Parameters<typeof worldRequirements>[1]) => worldRequirements(value, recipe)[stationId] === target.level;
  return {
    recipes: state.catalog.recipes.filter(recipe => usesLevel(recipe, recipe)),
    routes: state.catalog.explorations.filter(route => usesLevel(route)),
    upgrades: state.catalog.buildings.flatMap(building => building.id === stationId ? [] : building.levels.filter(level => usesLevel(level)).map(level => ({ stationId: building.id, name: building.name, level: level.level }))),
    market: stationId === "home" && target.level === state.catalog.market.requiredHomeLevel,
  };
}

function UpgradeCost({ state, cost, navigation }: { state: EconomyView; cost: EconomyCost; navigation?: StationNavigation }) {
  const entries = [...(cost.coins ? [{ id: "coins", amount: cost.coins }] : []), ...Object.entries(cost.items).map(([id, amount]) => ({ id, amount }))];
  if (!entries.length) return <p className={styles.muted}>Без затрат</p>;
  const relicOnly = entries.every(({ id }) => state.catalog.items.some(item => item.id === id && item.category === "special"));
  const lockedFinds = state.catalog.rareDrops && (state.buildings.home ?? 1) < state.catalog.rareDrops.requiredHomeLevel
    && entries.some(({ id, amount }) => state.catalog.rareDrops!.itemIds.includes(id) && (state.inventory[id] ?? 0) < amount);
  return <><ul className={`${styles.costGrid} ${relicOnly ? styles.relicCostGrid : ""}`} aria-label="Стоимость">{entries.map(({ id, amount }) => {
    const available = id === "coins" ? state.wallet.coins : state.inventory[id] ?? 0;
    const name = id === "coins" ? "Монеты" : itemName(state, id);
    const missing = available < amount;
    const relic = state.catalog.items.some(item => item.id === id && item.category === "special");
    const source = missing && id !== "coins" ? worldMaterialSource(state, id) : null;
    const chanceSource = missing && relic && state.catalog.rareDrops?.itemIds.includes(id)
      && (state.buildings.home ?? 1) >= state.catalog.rareDrops.requiredHomeLevel;
    const openSource = source?.kind === "production" && navigation?.canOpen(source.stationId) ? () => navigation.open(source.stationId) : source?.kind === "exploration" || chanceSource ? navigation?.explore : undefined;
    const content = <><span className={styles.costIcon}><ProductIcon state={state} itemId={id} size={relic ? 34 : 22} />{openSource && <ArrowRight size={10} className={styles.sourceArrow} aria-hidden="true" />}{!missing && relic && <Check size={12} className={styles.costCheck} aria-hidden="true" />}</span><span className={styles.costName}>{name}</span><strong><span>{number(available)}</span><span className={styles.costNeeded}> / {number(amount)}</span></strong></>;
    return <li key={id} data-relic={relic ? id : undefined} data-missing={missing || undefined}>{openSource ? <button type="button" className={styles.costTile} onClick={openSource} title={chanceSource ? "Находки из вылазок; конкретный предмет не гарантирован." : undefined} aria-label={`${chanceSource ? "Где искать" : "Где получить"}: ${name}${source?.kind === "exploration" || chanceSource ? ", В путь" : ""}. Есть ${number(available)}, нужно ${number(amount)}`}>{content}</button> : <div className={styles.costTile}>{content}</div>}</li>;
  })}</ul>{lockedFinds && <p className={styles.muted}>Находки реликвий в вылазках — с домом ур. {state.catalog.rareDrops!.requiredHomeLevel}.</p>}</>;
}

function UpgradeUnlocks({ state, stationId, target, navigation }: { state: EconomyView; stationId: string; target: WorldBuildingLevel; navigation?: StationNavigation }) {
  const [selectedRecipe, setSelectedRecipe] = useState<string | null>(null);
  const detailId = useId();
  const unlocks = worldUpgradeUnlocks(state, stationId, target);
  // A recipe belonging to a different station is a dependency in /branch, not a
  // new product of this upgrade. Keep that cascade out of the purchase dialog.
  const recipes = unlocks.recipes.filter(recipe => recipe.buildingId === stationId);
  const recipe = recipes.find(entry => entry.id === selectedRecipe);
  const futureState = { ...state, buildings: { ...state.buildings, [stationId]: target.level } };
  const firstBuildings = stationId === "home" ? unlocks.upgrades.filter(upgrade => upgrade.level === 1) : [];
  const nextBuildingLevel = stationId === "home" ? Math.max(0, ...unlocks.upgrades.map(upgrade => upgrade.level)) : 0;
  const homeExtras = firstBuildings.length + unlocks.routes.length + Number(unlocks.market);
  return <section className={styles.section} aria-label="Что изменится">
    <h3><Sparkles size={15} aria-hidden="true" />После улучшения</h3>
    {Boolean(target.warehouseCapacity) && <div className={styles.capacity}><Package size={30} strokeWidth={1.5} aria-hidden="true" /><div><span>Вместимость кладовой</span><strong>{number(state.storage.capacity)}<ArrowRight size={18} aria-label="увеличится до" />{number(target.warehouseCapacity!)}</strong></div><span className={styles.capacityGain}>+{number(target.warehouseCapacity! - state.storage.capacity)}<small>мест</small></span></div>}
    {stationId === "home" && <>
      <div className={styles.homeResult}><House size={28} strokeWidth={1.5} aria-hidden="true" /><div><strong>Новый облик дома</strong>{nextBuildingLevel > 0 && <span>Можно развивать постройки до ур. {nextBuildingLevel}</span>}</div></div>
      {homeExtras > 0 && <details className={styles.moreUnlocks}><summary><span>Новые возможности <b>{homeExtras}</b></span><ChevronDown size={14} aria-hidden="true" /></summary><div className={styles.homeUnlocks}>
        {firstBuildings.map(upgrade => {
          const Icon = stationIcons[upgrade.stationId] ?? Hammer;
          const level = state.catalog.buildings.find(building => building.id === upgrade.stationId)?.levels.find(level => level.level === 1);
          return <div key={upgrade.stationId}><span><Icon size={18} aria-hidden="true" /><strong>{upgrade.name}</strong><small>Можно обустроить</small></span>{level && <Requirements state={futureState} required={worldRequirements(level)} navigation={navigation} />}</div>;
        })}
        {unlocks.routes.map(route => <div key={route.id}><span><Compass size={18} aria-hidden="true" /><strong>{route.name}</strong><small>Маршрут</small></span><Requirements state={futureState} required={worldRequirements(route)} navigation={navigation} /></div>)}
        {unlocks.market && <div><span><Store size={18} aria-hidden="true" /><strong>Рынок между игроками</strong></span>{state.completedExplorations < state.catalog.market.requiredExplorations && <p className={styles.muted}>Нужно завершить вылазок: {state.completedExplorations} / {state.catalog.market.requiredExplorations}</p>}</div>}
      </div></details>}
    </>}
    {!!recipes.length && <>
      <div className={styles.recipeGrid} aria-label="Новые рецепты">{recipes.map(entry => {
        const rewards = Object.entries(entry.rewards);
        const missing = worldMissingRequirements(futureState, worldRequirements(entry, entry));
        return <button key={entry.id} type="button" className={styles.recipeTile} aria-label={`Рецепт: ${entry.name}`} aria-expanded={selectedRecipe === entry.id} aria-controls={selectedRecipe === entry.id ? detailId : undefined} data-recipe={entry.id} onClick={() => setSelectedRecipe(selectedRecipe === entry.id ? null : entry.id)}><span className={styles.resultIcons}>{rewards.slice(0, 2).map(([id]) => <ProductIcon state={state} key={id} itemId={id} size={25} />)}</span><strong>{rewards.length === 1 ? itemName(state, rewards[0][0]) : `Набор · ${rewards.length} вида`}</strong><span>{rewards.length === 1 ? `×${number(rewards[0][1])} · ` : ""}{worldDuration(entry.seconds)}</span>{missing.length > 0 && <small><LockKeyhole size={10} aria-hidden="true" />Ещё условия</small>}</button>;
      })}</div>
      {recipe && <div id={detailId} className={styles.recipeDetail}><strong>{recipe.name}</strong><ul aria-label="Результат рецепта">{Object.entries(recipe.rewards).map(([id, amount]) => <li key={id}><ProductIcon state={state} itemId={id} size={18} /><span>{itemName(state, id)}</span><b>×{number(amount)}</b></li>)}</ul><p className={styles.recipeInputs}><span>Нужно:</span>{recipe.cost.coins > 0 && <span><ItemIcon itemId="coins" size={16} />{number(recipe.cost.coins)}</span>}{Object.entries(recipe.cost.items).map(([id, amount]) => <span key={id}><ProductIcon state={state} itemId={id} size={16} />{itemName(state, id)} ×{number(amount)}</span>)}{!recipe.cost.coins && !Object.keys(recipe.cost.items).length && <span>без затрат</span>}</p><Requirements state={futureState} required={worldRequirements(recipe, recipe)} navigation={navigation} /></div>}
    </>}
    {stationId !== "home" && !target.warehouseCapacity && !recipes.length && <p className={styles.muted}>Следующий уровень постройки.</p>}
  </section>;
}

/** Kept separate from the portal so loading, locks and paid jobs can be rendered in tests. */
export function WorldUpgradeContent({ stationId, economy, onClose, navigation, onOpenPantry, constructionGoal, onOpenHelp, isOnline, onOpenMeals }: Omit<WorldUpgradeDialogProps, "stationId" | "onCloseAutoFocus"> & { stationId: string }) {
  const state = economy.snapshot;
  const building = (state?.catalog ?? economyCatalog).buildings.find(entry => entry.id === stationId);
  const name = state ? stationName(state, stationId) : building?.name ?? "Улучшение";
  const current = state?.buildings[stationId] ?? 0;
  const target = building?.levels.find(level => level.level === current + 1);
  const goalPinned = constructionGoal?.goal?.buildingId === stationId && constructionGoal.goal.targetLevel === target?.level;
  const production = state?.jobs.filter(entry => entry.targetId === stationId && entry.kind === "production") ?? [];
  const construction = state?.jobs.find(entry => entry.targetId === stationId && entry.kind === "construction");
  const builder = state ? economyBuilderStatus(state, economy.now) : null;
  const meal = state ? pendingMeal(state, "builder") : null;
  const builderElsewhere = !construction && target && builder;
  const readyEconomy: ReadyEconomy | null = state ? { ...economy, snapshot: state } : null;
  const reason = state && target ? worldConstructionReason(state, stationId, target) : null;
  const cooldown = Math.max(0, Math.ceil((economy.retryAt - economy.now) / 1000));
  const pendingReason = economy.uncertain ? "Сначала подтвердите последнее действие." : economy.busy ? "Подтверждаем действие…" : cooldown > 0 ? `Повторная проверка через ${cooldown} с.` : null;
  const required = target ? worldRequirements(target) : {};
  const missing = state ? worldMissingRequirements(state, required) : [];
  const visibleReason = pendingReason ?? (builderElsewhere || missing.length || reason === "Не хватает материалов или монет" ? null : reason);
  const Icon = stationIcons[stationId] ?? House;
  const startConstruction = () => {
    const currentState = economy.snapshot;
    if (!currentState || !target || locked(economy) || worldConstructionReason(currentState, stationId, target)) return;
    void economy.act("start_construction", stationId);
  };

  return <>
    <header className={styles.header}>
      <span className={styles.buildingIcon}><Icon size={22} strokeWidth={1.7} aria-hidden="true" /></span>
      <div className={styles.heading}>
        <Dialog.Title data-upgrade-heading tabIndex={-1}>{name}</Dialog.Title>
        <Dialog.Description className={styles.srOnly}>{!state ? "Уровни, условия и стоимость улучшения." : construction ? "Улучшение уже оплачено. Здесь можно следить за работой и завершить её." : target ? "Следующий уровень: возможности, условия и стоимость." : "Ваш текущий уровень и возможности постройки."}</Dialog.Description>
        {state ? <div className={styles.levels}><span>{current ? `Уровень ${current}` : "Не обустроено"}</span>{target ? <><ArrowRight size={12} aria-hidden="true" /><strong>Уровень {target.level}</strong></> : <strong><Check size={12} aria-hidden="true" />Максимум</strong>}</div> : <span className={styles.muted}>Загружаем хозяйство…</span>}
      </div>
      <button type="button" className={styles.close} aria-label="Закрыть окно улучшения" onClick={onClose}><X size={19} aria-hidden="true" /></button>
    </header>
    <div className={styles.body}>
      {readyEconomy && construction && <section className={styles.activeWork} aria-label="Ход улучшения"><div className={styles.activeWorkTop}><Work economy={readyEconomy} job={construction} openPantry={onOpenPantry} /><WorldMealBoost economy={economy} consumer="builder" jobId={construction.id} isOnline={isOnline} onNavigateStation={navigation?.open} onOpenMeals={onOpenMeals} /></div><ConstructionSpeedup key={construction.id} economy={readyEconomy} job={construction} /><p className={styles.muted}>Материалы оплачены. Работа продолжится после выхода.</p></section>}
      {!state ? <div className={styles.loading} role="status"><RefreshCw size={24} aria-hidden="true" /><p>{economy.error ?? "Открываем ваше хозяйство…"}</p>{economy.error && <button type="button" className={menuStyles.textButton} disabled={economy.busy || cooldown > 0} onClick={() => void economy.retry()}>{cooldown ? `Повторить через ${cooldown} с` : "Попробовать ещё раз"}</button>}</div> : <>
        {(economy.error || economy.uncertain) && <div className={menuStyles.error} role="alert"><p>{economy.uncertain ? "Проверяем последнее действие. Новые улучшения доступны после подтверждения." : economy.error}</p><button type="button" className={menuStyles.textButton} disabled={economy.busy || cooldown > 0} onClick={() => void economy.retry()}><RefreshCw size={13} aria-hidden="true" />{cooldown ? `Повторить через ${cooldown} с` : economy.uncertain ? "Проверить результат" : "Повторить"}</button></div>}
        {builderElsewhere && <section className={styles.builderBusy} data-builder-status={builderElsewhere.ready ? "ready" : "working"} aria-label="Строитель занят">
          <Hammer size={23} aria-hidden="true" />
          <div><strong>Строитель занят</strong><span>{builderElsewhere.stationName} · ур. {builderElsewhere.job.targetLevel}</span><p>{builderElsewhere.ready ? "Работа готова — завершите улучшение" : builderElsewhere.seconds ? `Осталось ${builderElsewhere.seconds < 60 ? `${builderElsewhere.seconds} с` : worldDuration(builderElsewhere.seconds)}` : "Идёт работа"}</p></div>
          {navigation?.canOpen(builderElsewhere.stationId) && <button type="button" onClick={() => navigation.open(builderElsewhere.stationId)} aria-label={`К текущей стройке: ${builderElsewhere.stationName}`}>К постройке<ArrowRight size={13} aria-hidden="true" /></button>}
        </section>}
        {readyEconomy && production.length > 0 && <section className={styles.section} aria-label="Текущие заказы"><h3><Clock3 size={16} aria-hidden="true" />Сначала заберите {production.length === 1 ? "заказ" : "заказы"}</h3>{production.map(job => <Work key={job.id} economy={readyEconomy} job={job} openPantry={onOpenPantry} />)}</section>}
        {target ? <>
          <UpgradeUnlocks state={state} stationId={stationId} target={target} navigation={navigation} />
          {!construction && <section className={`${styles.section} ${styles.costCard}`} aria-label="Подготовка к улучшению">
            <div className={styles.sectionHeading}><h3>Потребуется</h3><span>Есть / нужно</span></div>
            <UpgradeCost state={state} cost={target.cost} navigation={navigation} />
            {constructionGoal && <button type="button" className={styles.pinGoal} aria-pressed={goalPinned} aria-label={`${goalPinned ? "Цель закреплена" : "Закрепить цель"}: ${name} · ур. ${target.level}${goalPinned ? ". Снять цель" : ""}`} onClick={() => { if (goalPinned) constructionGoal.clear(); else constructionGoal.pin(stationId); }}><Pin size={15} aria-hidden="true" />{goalPinned ? "Цель закреплена" : "Закрепить цель"}{goalPinned && <Check size={14} aria-hidden="true" />}</button>}
            {(reason || economy.uncertain || cooldown > 0) && onOpenHelp && <button type="button" className={styles.contextHelp} onClick={() => onOpenHelp({ intent: "construction", stationId })}><CircleHelp size={15} aria-hidden="true" />Как продолжить?</button>}
            {!!missing.length && <div className={styles.conditions}><h4><LockKeyhole size={13} aria-hidden="true" />Нужны улучшения</h4><Requirements state={state} required={required} navigation={navigation} /></div>}
          </section>}
        </> : <section className={`${styles.section} ${styles.complete}`}><span className={styles.completeIcon}><Check size={22} aria-hidden="true" /></span><h3>Все улучшения получены</h3><p>{building?.description ?? "Эта постройка достигла максимального уровня."}</p>{stationId === "warehouse" && <p>Вместимость кладовой — {number(state.storage.capacity)} предметов.</p>}</section>}
      </>}
    </div>
    {!construction && <footer className={styles.footer}>
      {state && target ? <>
        {visibleReason && <p className={styles.reason} role="status"><LockKeyhole size={14} aria-hidden="true" />{visibleReason}</p>}
        <div className={styles.confirmRow}><div className={styles.durationWithMeal}><span className={styles.duration}><Clock3 size={16} aria-hidden="true" /><span>Время улучшения<strong>{worldDuration(mealDuration(target.seconds, meal?.builderSpeedBps ?? 0))}</strong>{meal && <small>{`Сыт · скорость +${meal.builderSpeedBps / 100}%`}</small>}</span></span><WorldMealBoost economy={economy} consumer="builder" stationId={stationId} seconds={target.seconds} isOnline={isOnline} onNavigateStation={navigation?.open} onOpenMeals={onOpenMeals} /></div><button type="button" className={styles.confirm} disabled={Boolean(reason) || locked(economy)} onClick={startConstruction}><Hammer size={17} aria-hidden="true" />{current ? `Улучшить до ур. ${target.level}` : "Начать обустройство"}</button></div>
      </> : <button type="button" className={styles.done} onClick={onClose}>{state ? "Готово" : "Вернуться на карту"}</button>}
    </footer>}
  </>;
}

export function WorldUpgradeDialog({ stationId, onCloseAutoFocus, onCompleted, onOpenHelp, ...props }: WorldUpgradeDialogProps) {
  const content = useRef<HTMLDivElement>(null);
  const openingHelp = useRef(false);
  useEffect(() => { if (stationId) openingHelp.current = false; }, [stationId]);
  const onClose = props.onClose;
  const completions = props.economy.completedConstructions;
  const seenCompletions = useRef(new Set(completions?.map(event => event.id)));
  useEffect(() => {
    const newlyCompleted = completions?.filter(event => !seenCompletions.current.has(event.id)) ?? [];
    seenCompletions.current = new Set(completions?.map(event => event.id));
    if (stationId && newlyCompleted.some(event => event.stationId === stationId)) (onCompleted ?? onClose)();
  }, [completions, stationId, onClose, onCompleted]);
  return <Dialog.Root open={stationId !== null} onOpenChange={open => { if (!open) props.onClose(); }}>
    <Dialog.Portal>
      <Dialog.Overlay className={styles.overlay} />
      <Dialog.Content ref={content} className={`${menuStyles.menu} ${styles.dialog}`} data-upgrade-station={stationId ?? undefined}
        onOpenAutoFocus={event => { event.preventDefault(); content.current?.querySelector<HTMLElement>("[data-upgrade-heading]")?.focus({ preventScroll: true }); }}
        onCloseAutoFocus={event => {
          if (openingHelp.current) event.preventDefault();
          else onCloseAutoFocus?.(event);
        }}
        onEscapeKeyDown={event => event.stopPropagation()}
        onClick={event => event.stopPropagation()} onWheel={event => event.stopPropagation()}>
        {stationId && <WorldUpgradeContent key={stationId} stationId={stationId} {...props} onOpenHelp={onOpenHelp ? context => { openingHelp.current = true; onOpenHelp(context); } : undefined} />}
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}
