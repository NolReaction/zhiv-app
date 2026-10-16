"use client";

import { useEffect, useRef } from "react";
import { Dialog } from "radix-ui";
import { ArrowRight, Check, CircleHelp, Clock3, Compass, Hammer, LockKeyhole, Package, Pickaxe, Pin, RefreshCw, Store, X } from "lucide-react";
import type { WorldHelpContext } from "@/features/world/ui/help/world-help-types";
import { ItemIcon } from "@/features/items/item-icon";
import { FishingRodIcon } from "@/features/world/activities/fishing/fishing-rod-icon";
import { economyCatalog, type EconomyCost, type EconomyView } from "@/features/economy/domain/model";
import type { EconomyController } from "@/features/economy/sync/use-economy";
import type { ConstructionGoalController } from "./use-construction-goal";
import { ConstructionSpeedup } from "./construction-speedup";
import { ConstructionBuildingArt } from "./construction-building-art";
import { ConstructionRequirements } from "./construction-requirements";
import { UpgradeBenefitCarousel, type UpgradeBenefitCard } from "./upgrade-benefit-carousel";
import { WorldMealBoost } from "@/features/economy/ui/food/world-meal-boost";
import { mealDuration, pendingMeal } from "@/features/economy/domain/food";
import { economyBuilderStatus } from "@/features/economy/domain/builder-status";
import { explorationActorId } from "@/features/economy/domain/actor-availability";
import { stageOrderProgress } from "@/features/economy/domain/stage-orders";
import { locked, type ReadyEconomy } from "@/features/economy/sync/controller-state";
import { Work, ProductIcon, itemName, stationName, number, type StationNavigation } from "@/features/economy/ui/shared/world-economy-parts";
import { worldConstructionReason, worldCountdown, worldDuration, worldMaterialSource, worldMissingRequirements, worldRequirements, type WorldBuildingLevel } from "@/features/economy/ui/shared/world-stations";
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
  onCloseAutoFocus?: (event: Event) => void;
};

/** A level satisfies one requirement; other stations may still be needed. */
export function worldUpgradeUnlocks(state: EconomyView, stationId: string, target: WorldBuildingLevel) {
  const usesLevel = (value: Parameters<typeof worldRequirements>[0], recipe?: Parameters<typeof worldRequirements>[1]) => worldRequirements(value, recipe)[stationId] === target.level;
  return {
    recipes: state.catalog.recipes.filter(recipe => usesLevel(recipe, recipe)),
    routes: state.catalog.explorations.filter(route => usesLevel(route)),
    upgrades: state.catalog.buildings.flatMap(building => building.id === stationId ? [] : building.levels.filter(level => usesLevel(level)).map(level => ({ stationId: building.id, name: building.name, level: level.level }))),
    market: stationId === "home" && target.level === state.catalog.market.requiredHomeLevel
      || state.catalog.market.requiredBuildings[stationId] === target.level,
  };
}

function UpgradeCost({ state, cost, navigation }: { state: EconomyView; cost: EconomyCost; navigation?: StationNavigation }) {
  const entries = [...(cost.coins ? [{ id: "coins", amount: cost.coins }] : []), ...Object.entries(cost.items).map(([id, amount]) => ({ id, amount }))];
  if (!entries.length) return <p className={styles.muted}>Без затрат</p>;
  const relicOnly = entries.every(({ id }) => state.catalog.items.some(item => item.id === id && item.category === "special"));
  const lockedFinds = state.catalog.rareDrops && (state.buildings.home ?? 1) < state.catalog.rareDrops.requiredHomeLevel
    && entries.some(({ id, amount }) => state.catalog.rareDrops!.itemIds.includes(id) && (state.inventory[id] ?? 0) < amount);
  const project = state.catalog.stageOrders?.find(course => course.homeLevel === (state.buildings.home ?? 1));
  const projectProgress = stageOrderProgress(state);
  const projectRewards = project && !projectProgress.completed ? projectProgress.completionRewards ?? project.completionRewards : {};
  const guaranteed = entries.filter(({ id, amount }) => amount > (state.inventory[id] ?? 0) && (projectRewards[id] ?? 0) > 0);
  return <><ul className={`${styles.costGrid} ${relicOnly ? styles.relicCostGrid : ""}`} aria-label="Стоимость">{entries.map(({ id, amount }) => {
    const available = id === "coins" ? state.wallet.coins : state.inventory[id] ?? 0;
    const name = id === "coins" ? "Монеты" : itemName(state, id);
    const missing = available < amount;
    const relic = state.catalog.items.some(item => item.id === id && item.category === "special");
    const source = missing && id !== "coins" ? worldMaterialSource(state, id) : null;
    const chanceSource = missing && relic && (projectRewards[id] ?? 0) <= 0 && state.catalog.rareDrops?.itemIds.includes(id)
      && (state.buildings.home ?? 1) >= state.catalog.rareDrops.requiredHomeLevel;
    const mining = source?.kind === "exploration" && state.catalog.explorations.some(route => route.id === source.targetId && explorationActorId(route) === "miner");
    const openSource = source?.kind === "production" && navigation?.canOpen(source.stationId) ? () => navigation.open(source.stationId, source.targetId)
      : mining && navigation?.canOpen("quarry") ? () => navigation.open("quarry") : source?.kind === "exploration" || chanceSource ? navigation?.explore : undefined;
    const content = <><span className={styles.costIcon}><ProductIcon state={state} itemId={id} size={relic ? 34 : 22} />{openSource && <ArrowRight size={10} className={styles.sourceArrow} aria-hidden="true" />}{!missing && relic && <Check size={12} className={styles.costCheck} aria-hidden="true" />}</span><span className={styles.costName}>{name}</span><strong><span>{number(available)}</span><span className={styles.costNeeded}> / {number(amount)}</span></strong></>;
    return <li key={id} data-relic={relic ? id : undefined} data-missing={missing || undefined}>{openSource ? <button type="button" className={styles.costTile} onClick={openSource} title={chanceSource ? "Находки из вылазок; конкретный предмет не гарантирован." : undefined} aria-label={`${chanceSource ? "Где искать" : "Где получить"}: ${name}${source?.kind === "exploration" || chanceSource ? mining ? ", Шахта" : ", В путь" : ""}. Есть ${number(available)}, нужно ${number(amount)}`}>{content}</button> : <div className={styles.costTile}>{content}</div>}</li>;
  })}</ul>{guaranteed.length > 0 && <p className={styles.muted}>Гарантированный источник: завершите проект к дому {(state.buildings.home ?? 1) + 1} на доске жителей. Награда: {guaranteed.map(({ id }) => `${itemName(state, id)} × ${projectRewards[id]}`).join(", ")}. Жемчуг не требуется.</p>}{lockedFinds && <p className={styles.muted}>Находки реликвий в вылазках доступны с домом ур. {state.catalog.rareDrops!.requiredHomeLevel}.</p>}</>;
}

function UpgradeUnlocks({ state, stationId, target, navigation }: { state: EconomyView; stationId: string; target: WorldBuildingLevel; navigation?: StationNavigation }) {
  const unlocks = worldUpgradeUnlocks(state, stationId, target);
  // The home opens a new tier of crops and dishes. Other station previews show
  // only their own products so their dependency cascade stays in /branch.
  const recipes = unlocks.recipes.filter(recipe => stationId === "home" || recipe.buildingId === stationId);
  const futureState = { ...state, buildings: { ...state.buildings, [stationId]: target.level } };
  const firstBuildings = stationId === "home" ? unlocks.upgrades.filter(upgrade => upgrade.level === 1) : [];
  const nextBuildingLevel = stationId === "home" ? Math.max(0, ...unlocks.upgrades.map(upgrade => upgrade.level)) : 0;
  const cards: UpgradeBenefitCard[] = [];
  const requirements = (required: Record<string, number>) => worldMissingRequirements(futureState, required).length > 0
    ? <span className={styles.benefitLocked}><LockKeyhole size={12} aria-hidden="true" />Ещё условия</span>
    : <span className={styles.benefitReady}><Check size={13} aria-hidden="true" />После этого улучшения</span>;
  const requirementDetails = (required: Record<string, number>, heading = "Для этой возможности") => worldMissingRequirements(futureState, required).length > 0
    ? <div className={styles.recipeDetail}><strong>{heading}</strong><ConstructionRequirements state={futureState} required={required} navigation={navigation} /></div>
    : undefined;

  if (target.warehouseCapacity) cards.push({ id: "capacity", label: "Вместимость кладовой", content: <>
    <span className={styles.benefitArt} data-kind="storage"><Package size={43} strokeWidth={1.4} aria-hidden="true" /></span>
    <span className={styles.benefitKind}>Больше запасов</span><strong className={styles.benefitTitle}>Вместимость кладовой</strong>
    <span className={styles.capacityNumbers}><strong>{number(state.storage.capacity)}</strong><ArrowRight size={18} aria-label="увеличится до" /><strong>{number(target.warehouseCapacity)}</strong></span>
    <span className={styles.benefitGain}>+{number(target.warehouseCapacity - state.storage.capacity)} мест</span>
    <span className={styles.benefitDescription}>Для материалов, урожая и готовых заказов.</span>
  </> });

  if (stationId === "home") {
    cards.push({ id: "home", label: "Новый облик дома", content: <>
      <span className={styles.benefitArt} data-kind="home"><ConstructionBuildingArt stationId="home" level={target.level} /><span>Ур. {target.level}</span></span>
      <span className={styles.benefitKind}>Дом Мохлика</span><strong className={styles.benefitTitle}>Новый облик дома</strong>
      {nextBuildingLevel > 0 && <span className={styles.benefitDescription}>Можно развивать постройки до ур. {nextBuildingLevel}</span>}
      <span className={styles.benefitReady}><Check size={13} aria-hidden="true" />После этого улучшения</span>
    </> });
    for (const upgrade of firstBuildings) {
      const level = state.catalog.buildings.find(building => building.id === upgrade.stationId)?.levels.find(level => level.level === 1);
      cards.push({ id: `building:${upgrade.stationId}`, label: upgrade.name, details: level && requirementDetails(worldRequirements(level), "Для этой постройки"), content: <>
        <span className={styles.benefitArt} data-kind="building"><ConstructionBuildingArt stationId={upgrade.stationId} level={upgrade.level} /></span>
        <span className={styles.benefitKind}>Новая постройка</span><strong className={styles.benefitTitle}>{upgrade.name}</strong><span className={styles.benefitDescription}>Можно обустроить · ур. 1</span>
        {level && requirements(worldRequirements(level))}
      </> });
    }
  }

  // Construction and restoration previews show the routes tied to that building.
  for (const route of ["home", "quarry", "bridge", "lighthouse"].includes(stationId) ? unlocks.routes : []) {
    const rewards = Object.entries(route.rewards);
    const mining = explorationActorId(route) === "miner";
    const ActivityIcon = mining ? Pickaxe : Compass;
    cards.push({ id: `route:${route.id}`, label: route.name, details: requirementDetails(worldRequirements(route), mining ? "Для этой добычи" : "Для этого маршрута"), content: <>
      <span className={styles.benefitArt} data-kind="route">{rewards.slice(0, 3).map(([id]) => <ProductIcon state={state} key={id} itemId={id} size={42} />)}<ActivityIcon size={20} className={styles.benefitArtBadge} aria-hidden="true" /></span>
      <span className={styles.benefitKind}>{mining ? "Новая добыча" : "Новый маршрут"} · {worldDuration(route.seconds)}</span><strong className={styles.benefitTitle}>{route.name.replace(/ · \d+ ч$/, "")}</strong>
      <span className={styles.benefitRewards} role="list" aria-label="Находки маршрута">{rewards.map(([id, amount]) => <span role="listitem" key={id}>{itemName(state, id)} <b>×{number(amount)}</b></span>)}</span>
      {requirements(worldRequirements(route))}
      {mining && <span className={styles.benefitDescription}>Шахта работает независимо от Мохлика.</span>}
    </> });
  }

  for (const entry of recipes) {
    const rewards = Object.entries(entry.rewards);
    const missing = worldMissingRequirements(futureState, worldRequirements(entry, entry));
    const title = rewards.length === 1 ? itemName(state, rewards[0][0]) : `Набор · ${rewards.length} вида`;
    const meal = state.catalog.food?.meals.find(meal => (entry.rewards[meal.itemId] ?? 0) > 0);
    cards.push({ id: `recipe:${entry.id}`, label: entry.name, recipeId: entry.id, detailLabel: "Состав и условия",
      details: <div className={styles.recipeDetail}><strong>{entry.name}</strong><ul aria-label="Результат рецепта">{Object.entries(entry.rewards).map(([id, amount]) => <li key={id}><ProductIcon state={state} itemId={id} size={18} /><span>{itemName(state, id)}</span><b>×{number(amount)}</b></li>)}</ul><p className={styles.recipeInputs}><span>Нужно:</span>{entry.cost.coins > 0 && <span><ItemIcon itemId="coins" size={16} />{number(entry.cost.coins)}</span>}{Object.entries(entry.cost.items).map(([id, amount]) => <span key={id}><ProductIcon state={state} itemId={id} size={16} />{itemName(state, id)} ×{number(amount)}</span>)}{!entry.cost.coins && !Object.keys(entry.cost.items).length && <span>без затрат</span>}</p><ConstructionRequirements state={futureState} required={worldRequirements(entry, entry)} navigation={navigation} /></div>,
      content: <>
      <span className={styles.benefitArt} data-kind="recipe">{rewards.slice(0, 3).map(([id]) => <ProductIcon state={state} key={id} itemId={id} size={44} />)}</span>
      <span className={styles.benefitKind}>Новый рецепт{stationId === "home" ? ` · ${stationName(state, entry.buildingId)}` : ""}</span><strong className={styles.benefitTitle}>{title}</strong>
      <span className={styles.benefitDescription}>{rewards.length === 1 ? `×${number(rewards[0][1])} · ` : ""}{worldDuration(entry.seconds)}</span>
      {meal && <span className={styles.benefitDescription}>Вылазка +{meal.heroSpeedBps / 100}% · стройка +{meal.builderSpeedBps / 100}% скорости</span>}
      {missing.length > 0 && <span className={styles.benefitLocked}><LockKeyhole size={12} aria-hidden="true" />Ещё условия</span>}
    </> });
  }

  if (unlocks.market) cards.push({ id: "market", label: "Рынок между игроками", details: <div className={styles.recipeDetail}><strong>Для открытия рынка</strong><ConstructionRequirements state={futureState} required={worldRequirements(state.catalog.market)} navigation={navigation} />
    {state.completedExplorations < state.catalog.market.requiredExplorations
      ? <p className={styles.muted}>Нужно завершить вылазок: {state.completedExplorations} / {state.catalog.market.requiredExplorations}</p>
      : <p className={styles.muted}>После восстановления моста можно торговать с другими игроками.</p>}
    </div>, content: <>
    <span className={styles.benefitArt} data-kind="market"><Store size={43} strokeWidth={1.4} aria-hidden="true" /><ItemIcon itemId="coins" size={28} /></span>
    <span className={styles.benefitKind}>Торговля</span><strong className={styles.benefitTitle}>Рынок между игроками</strong><span className={styles.benefitDescription}>Покупайте материалы и продавайте свои запасы.</span>
    {requirements(worldRequirements(state.catalog.market))}
  </> });

  if (stationId === "home" && state.catalog.fishing) {
    const fishing = state.catalog.fishing;
    const gear = [
      ...fishing.rods.filter(item => item.requiredHomeLevel === target.level).map(item => ({ ...item, itemId: item.id, kind: "Удочка" })),
      ...fishing.hooks.filter(item => item.requiredHomeLevel === target.level).map(item => ({ ...item, itemId: item.id, kind: "Крючок" })),
      ...fishing.baits.filter(item => item.requiredHomeLevel === target.level).map(item => ({ ...item, name: itemName(state, item.itemId), kind: "Наживка" })),
    ];
    for (const item of gear) cards.push({ id: `fishing:${item.itemId}`, label: item.name, details: <div className={styles.recipeDetail}><strong>{item.name}</strong><p className={styles.muted}>{item.description}</p></div>, content: <>
      <span className={styles.benefitArt} data-kind="fishing">{item.kind === "Удочка" ? <FishingRodIcon rodId={item.itemId} size={60} /> : <ItemIcon itemId={item.itemId} size={52} />}</span>
      <span className={styles.benefitKind}>{item.kind} · у Плёски</span><strong className={styles.benefitTitle}>{item.name}</strong><span className={styles.benefitDescription}>{item.description.match(/^.*?[.!?](?:\s|$)/)?.[0].trim() ?? item.description}</span>
      <span className={styles.benefitShopHint}>Сможет появиться в новых поставках.</span>
    </> });
  }

  if (!cards.length) {
    cards.push({ id: "level", label: `Уровень ${target.level}`, content: <>
      <span className={styles.benefitArt}><ConstructionBuildingArt stationId={stationId} level={target.level} /></span>
      <span className={styles.benefitKind}>Развитие постройки</span><strong className={styles.benefitTitle}>Уровень {target.level}</strong><span className={styles.benefitDescription}>Следующий уровень постройки.</span>
    </> });
  }

  return <UpgradeBenefitCarousel cards={cards} />;
}

/** Kept separate from the portal so loading, locks and paid jobs can be rendered in tests. */
export function WorldUpgradeContent({ stationId, economy, onClose, navigation, onOpenPantry, constructionGoal, onOpenHelp, isOnline }: Omit<WorldUpgradeDialogProps, "stationId" | "onCloseAutoFocus"> & { stationId: string }) {
  const state = economy.snapshot;
  const building = (state?.catalog ?? economyCatalog).buildings.find(entry => entry.id === stationId);
  const name = state ? stationName(state, stationId) : building?.name ?? "Улучшение";
  const current = state?.buildings[stationId] ?? 0;
  const restoration = stationId === "bridge" || stationId === "lighthouse";
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
  const startConstruction = () => {
    const currentState = economy.snapshot;
    if (!currentState || !target || locked(economy) || worldConstructionReason(currentState, stationId, target)) return;
    void economy.act("start_construction", stationId);
  };

  return <>
    <header className={styles.header}>
      <span className={styles.buildingIcon}><ConstructionBuildingArt stationId={stationId} level={current || target?.level || 1} /></span>
      <div className={styles.heading}>
        <Dialog.Title data-upgrade-heading tabIndex={-1}>{name}</Dialog.Title>
        <Dialog.Description className={styles.srOnly}>{!state ? "Уровни, условия и стоимость улучшения." : construction ? "Улучшение уже оплачено. Здесь можно следить за работой и завершить её." : target ? "Следующий уровень: возможности, условия и стоимость." : "Ваш текущий уровень и возможности постройки."}</Dialog.Description>
        {state ? <div className={styles.levels}><span>{restoration ? current ? "Восстановлено" : "Разрушено" : current ? `Уровень ${current}` : "Не обустроено"}</span>{target ? <><ArrowRight size={12} aria-hidden="true" /><strong>{restoration ? "Восстановление" : `Уровень ${target.level}`}</strong></> : <strong><Check size={12} aria-hidden="true" />{restoration ? "Готово" : "Максимум"}</strong>}</div> : <span className={styles.muted}>Загружаем хозяйство…</span>}
      </div>
      <button type="button" className={styles.close} aria-label="Закрыть окно улучшения" onClick={onClose}><X size={19} aria-hidden="true" /></button>
    </header>
    <div className={styles.body}>
      {readyEconomy && construction && <section className={styles.activeWork} aria-label="Ход улучшения"><div className={styles.activeWorkTop}><Work economy={readyEconomy} job={construction} openPantry={onOpenPantry} /><WorldMealBoost economy={economy} consumer="builder" jobId={construction.id} isOnline={isOnline} onNavigateStation={navigation?.open} /></div><ConstructionSpeedup key={construction.id} economy={readyEconomy} job={construction} /><p className={styles.muted}>Материалы оплачены. Работа продолжится после выхода.</p></section>}
      {!state ? <div className={styles.loading} role="status"><RefreshCw size={24} aria-hidden="true" /><p>{economy.error ?? "Открываем ваше хозяйство…"}</p>{economy.error && <button type="button" className={menuStyles.textButton} disabled={economy.busy || cooldown > 0} onClick={() => void economy.retry()}>{cooldown ? `Повторить через ${cooldown} с` : "Попробовать ещё раз"}</button>}</div> : <>
        {!economy.syncError && (economy.error || economy.uncertain) && <div className={menuStyles.error} role="alert"><p>{economy.uncertain ? "Проверяем последнее действие. Новые улучшения доступны после подтверждения." : economy.error}</p><button type="button" className={menuStyles.textButton} disabled={economy.busy || cooldown > 0} onClick={() => void economy.retry()}><RefreshCw size={13} aria-hidden="true" />{cooldown ? `Повторить через ${cooldown} с` : economy.uncertain ? "Проверить результат" : "Повторить"}</button></div>}
        {builderElsewhere && <section className={styles.builderBusy} data-builder-status={builderElsewhere.ready ? "ready" : "working"} aria-label="Строитель занят">
          <Hammer size={23} aria-hidden="true" />
          <div><strong>Строитель занят</strong><span>{builderElsewhere.stationName} · ур. {builderElsewhere.job.targetLevel}</span><p>{builderElsewhere.ready ? "Работа готова, завершите улучшение" : worldCountdown(builderElsewhere.seconds)}</p></div>
          {navigation?.canOpen(builderElsewhere.stationId) && <button type="button" onClick={() => navigation.open(builderElsewhere.stationId)} aria-label={`К текущей стройке: ${builderElsewhere.stationName}`}>К постройке<ArrowRight size={13} aria-hidden="true" /></button>}
        </section>}
        {readyEconomy && production.length > 0 && <section className={styles.section} aria-label="Текущие заказы"><h3><Clock3 size={16} aria-hidden="true" />Сначала заберите {production.length === 1 ? "заказ" : "заказы"}</h3>{production.map(job => <Work key={job.id} economy={readyEconomy} job={job} openPantry={onOpenPantry} />)}</section>}
        {target ? <>
          <UpgradeUnlocks key={target.level} state={state} stationId={stationId} target={target} navigation={navigation} />
          {!construction && <section className={`${styles.section} ${styles.costCard}`} aria-label="Подготовка к улучшению">
            <div className={styles.sectionHeading}><h3>Потребуется</h3><span>Есть / нужно</span></div>
            <UpgradeCost state={state} cost={target.cost} navigation={navigation} />
            {constructionGoal && <button type="button" className={styles.pinGoal} aria-pressed={goalPinned} aria-label={`${goalPinned ? "Цель закреплена" : "Закрепить цель"}: ${name} · ур. ${target.level}${goalPinned ? ". Снять цель" : ""}`} onClick={() => { if (goalPinned) constructionGoal.clear(); else constructionGoal.pin(stationId); }}><Pin size={15} aria-hidden="true" />{goalPinned ? "Цель закреплена" : "Закрепить цель"}{goalPinned && <Check size={14} aria-hidden="true" />}</button>}
            {!!missing.length && <div className={styles.conditions}><h4><LockKeyhole size={13} aria-hidden="true" />Нужны улучшения</h4><ConstructionRequirements state={state} required={required} navigation={navigation} /></div>}
            {(reason || economy.uncertain || cooldown > 0) && onOpenHelp && <button type="button" className={styles.contextHelp} onClick={() => onOpenHelp({ intent: "construction", stationId })}><CircleHelp size={15} aria-hidden="true" />Как продолжить?</button>}
          </section>}
        </> : <section className={`${styles.section} ${styles.complete}`}><span className={styles.completeIcon}><Check size={22} aria-hidden="true" /></span><h3>{restoration ? "Восстановление завершено" : "Все улучшения получены"}</h3><p>{building?.description ?? "Эта постройка достигла максимального уровня."}</p>{stationId === "warehouse" && <p>Вместимость кладовой: {number(state.storage.capacity)} предметов.</p>}</section>}
      </>}
    </div>
    {!construction && <footer className={styles.footer}>
      {state && target ? <>
        {visibleReason && <p className={styles.reason} role="status"><LockKeyhole size={14} aria-hidden="true" />{visibleReason}</p>}
        <div className={styles.confirmRow}><div className={styles.durationWithMeal}><span className={styles.duration}><Clock3 size={16} aria-hidden="true" /><span>{restoration ? "Время восстановления" : "Время улучшения"}<strong>{worldDuration(mealDuration(target.seconds, meal?.builderSpeedBps ?? 0))}</strong>{meal && <small>{`Сыт · скорость +${meal.builderSpeedBps / 100}%`}</small>}</span></span><WorldMealBoost economy={economy} consumer="builder" stationId={stationId} seconds={target.seconds} isOnline={isOnline} onNavigateStation={navigation?.open} /></div><button type="button" className={styles.confirm} disabled={Boolean(reason) || locked(economy)} onClick={startConstruction}><Hammer size={17} aria-hidden="true" />{restoration ? "Начать восстановление" : current ? `Улучшить до ур. ${target.level}` : "Начать обустройство"}</button></div>
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
