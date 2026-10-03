"use client";

import { useRef } from "react";
import { Dialog } from "radix-ui";
import { ArrowRight, Check, Clock3, Compass, Hammer, House, LockKeyhole, Package, RefreshCw, Sparkles, Store, X, type LucideIcon } from "lucide-react";
import { economyCatalog, type EconomyView } from "./model";
import type { EconomyController } from "./use-economy";
import { Cost, Requirements, Work, ProductIcon, stationIcons, stationName, locked, number, type ReadyEconomy, type StationNavigation } from "./world-economy-parts";
import { worldConstructionReason, worldDuration, worldMissingRequirements, worldRequirements, type WorldBuildingLevel } from "./world-stations";
import menuStyles from "./world-object-menu.module.css";
import styles from "./world-upgrade-dialog.module.css";

export type WorldUpgradeDialogProps = {
  stationId: string | null;
  economy: EconomyController;
  onClose: () => void;
  navigation?: StationNavigation;
  onOpenPantry?: () => void;
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

function UnlockLabel({ icon: Icon, children, onClick }: { icon: LucideIcon; children: React.ReactNode; onClick?: () => void }) {
  return onClick ? <button type="button" className={styles.unlockLink} onClick={onClick}><Icon size={16} aria-hidden="true" /><span>{children}</span><ArrowRight size={13} aria-hidden="true" /></button> : <span className={styles.unlockLabel}><Icon size={16} aria-hidden="true" /><span>{children}</span></span>;
}

function UpgradeUnlocks({ state, stationId, target, navigation }: { state: EconomyView; stationId: string; target: WorldBuildingLevel; navigation?: StationNavigation }) {
  const unlocks = worldUpgradeUnlocks(state, stationId, target);
  const hasConditions = unlocks.recipes.length + unlocks.routes.length + unlocks.upgrades.length > 0;
  const groupedUpgrades = unlocks.upgrades.reduce<Array<{ stationId: string; name: string; levels: number[] }>>((groups, upgrade) => {
    const existing = groups.find(group => group.stationId === upgrade.stationId);
    if (existing) existing.levels.push(upgrade.level);
    else groups.push({ stationId: upgrade.stationId, name: upgrade.name, levels: [upgrade.level] });
    return groups;
  }, []);
  const levelLabel = (values: number[]) => {
    const levels = [...values].sort((a, b) => a - b);
    return levels.length > 1 && levels.every((value, index) => !index || value === levels[index - 1] + 1) ? `${levels[0]}–${levels.at(-1)}` : levels.join(", ");
  };
  return <section className={styles.section} aria-label="Что изменится">
    <h3><Sparkles size={16} aria-hidden="true" />Что изменится</h3>
    {(stationId === "home" || Boolean(target.warehouseCapacity)) && <div className={styles.highlights}>
      {stationId === "home" && <p><House size={17} aria-hidden="true" /><span>Новый облик дома на карте</span></p>}
      {Boolean(target.warehouseCapacity) && <p><Package size={17} aria-hidden="true" /><span>Кладовая: <strong>{number(state.storage.capacity)} → {number(target.warehouseCapacity!)}</strong> предметов</span></p>}
    </div>}
    <div className={styles.unlockGroups}>
      {!!groupedUpgrades.length && <div className={styles.unlockGroup} data-wide={stationId === "home" || undefined}><h4>Развитие хозяйства</h4><ul>{groupedUpgrades.map(upgrade => <li key={upgrade.stationId}><UnlockLabel icon={stationIcons[upgrade.stationId] ?? Hammer} onClick={navigation?.canOpen(upgrade.stationId) ? () => navigation.open(upgrade.stationId) : undefined}>{upgrade.name} · ур. {levelLabel(upgrade.levels)}</UnlockLabel></li>)}</ul></div>}
      {!!unlocks.recipes.length && <div className={styles.unlockGroup}><h4>Рецепты</h4>{stationId === "home" ? <><p className={styles.recipeCount}>Новых рецептов: <strong>{unlocks.recipes.length}</strong></p><p className={styles.muted}>По мере обустройства производств.</p></> : <ul>{unlocks.recipes.map(recipe => {
        const itemId = Object.keys(recipe.rewards)[0];
        return <li key={recipe.id}><span className={styles.recipeIcon}><ProductIcon itemId={itemId ?? ""} size={16} /></span><span>{recipe.name}</span></li>;
      })}</ul>}</div>}
      {!!unlocks.routes.length && <div className={styles.unlockGroup}><h4>Исследования</h4><ul>{unlocks.routes.map(route => <li key={route.id}><UnlockLabel icon={Compass} onClick={navigation?.explore}>{route.name}</UnlockLabel></li>)}</ul></div>}
      {unlocks.market && <div className={styles.unlockGroup}><h4>Торговля</h4><ul><li><UnlockLabel icon={Store}>Рынок между игроками</UnlockLabel></li></ul>{state.catalog.market.requiredExplorations > 0 && <p className={styles.muted}>Также нужно полученных исследований: {state.catalog.market.requiredExplorations}.</p>}</div>}
    </div>
    {hasConditions && <p className={styles.muted}>Этот уровень выполняет одно из условий. Для новых рецептов, построек и маршрутов могут понадобиться другие улучшения.</p>}
  </section>;
}

/** Kept separate from the portal so loading, locks and paid jobs can be rendered in tests. */
export function WorldUpgradeContent({ stationId, economy, onClose, navigation, onOpenPantry }: Omit<WorldUpgradeDialogProps, "stationId" | "onCloseAutoFocus"> & { stationId: string }) {
  const state = economy.snapshot;
  const building = (state?.catalog ?? economyCatalog).buildings.find(entry => entry.id === stationId);
  const name = state ? stationName(state, stationId) : building?.name ?? "Развитие хозяйства";
  const current = state?.buildings[stationId] ?? 0;
  const target = building?.levels.find(level => level.level === current + 1);
  const job = state?.jobs.find(entry => entry.targetId === stationId && (entry.kind === "construction" || entry.kind === "production"));
  const construction = job?.kind === "construction" ? job : null;
  const readyEconomy: ReadyEconomy | null = state ? { ...economy, snapshot: state } : null;
  const reason = state && target ? worldConstructionReason(state, stationId, target) : null;
  const cooldown = Math.max(0, Math.ceil((economy.retryAt - economy.now) / 1000));
  const pendingReason = economy.uncertain ? "Сначала подтвердите последнее действие." : economy.busy ? "Подтверждаем действие…" : cooldown > 0 ? `Повторная проверка через ${cooldown} с.` : null;
  const required = target ? worldRequirements(target) : {};
  const missing = state ? worldMissingRequirements(state, required) : [];
  const Icon = stationIcons[stationId] ?? House;

  return <>
    <header className={styles.header}>
      <span className={styles.buildingIcon}><Icon size={27} strokeWidth={1.7} aria-hidden="true" /></span>
      <div className={styles.heading}><span className={styles.eyebrow}>{stationId === "home" ? "Развитие дома" : "Развитие хозяйства"}</span><Dialog.Title data-upgrade-heading tabIndex={-1}>{name}</Dialog.Title><Dialog.Description>{!state ? "Уровни, условия и стоимость улучшения." : construction ? "Улучшение уже оплачено. Здесь можно следить за работой и завершить её." : target ? "Следующий уровень: возможности, условия и стоимость." : "Ваш текущий уровень и возможности постройки."}</Dialog.Description></div>
      <button type="button" className={styles.close} aria-label="Закрыть окно улучшения" onClick={onClose}><X size={19} aria-hidden="true" /></button>
    </header>
    <div className={styles.levelBar}>
      {state ? <div className={styles.levels}><span>{current ? `Уровень ${current}` : "Не обустроено"}</span>{target ? <><ArrowRight size={16} aria-hidden="true" /><strong>Уровень {target.level}</strong></> : <strong><Check size={14} aria-hidden="true" />Максимум</strong>}</div> : <span className={styles.muted}>Загружаем хозяйство…</span>}
      {stationId === "home" && onOpenPantry && <button type="button" className={styles.pantry} onClick={onOpenPantry}><Package size={16} aria-hidden="true" />Кладовая<ArrowRight size={13} aria-hidden="true" /></button>}
    </div>
    <div className={styles.body}>
      {!state ? <div className={styles.loading} role="status"><RefreshCw size={24} aria-hidden="true" /><p>{economy.error ?? "Открываем ваше хозяйство…"}</p>{economy.error && <button type="button" className={menuStyles.textButton} disabled={economy.busy || cooldown > 0} onClick={() => void economy.retry()}>{cooldown ? `Повторить через ${cooldown} с` : "Попробовать ещё раз"}</button>}</div> : <>
        {(economy.error || economy.uncertain) && <div className={menuStyles.error} role="alert"><p>{economy.uncertain ? "Проверяем последнее действие. Новые улучшения доступны после подтверждения." : economy.error}</p><button type="button" className={menuStyles.textButton} disabled={economy.busy || cooldown > 0} onClick={() => void economy.retry()}><RefreshCw size={13} aria-hidden="true" />{cooldown ? `Повторить через ${cooldown} с` : economy.uncertain ? "Проверить результат" : "Повторить"}</button></div>}
        {economy.notice && <p className={menuStyles.notice} role="status"><Check size={14} aria-hidden="true" />{economy.notice}</p>}
        {readyEconomy && job?.kind === "production" && <section className={styles.section} aria-label="Текущий заказ"><h3><Clock3 size={16} aria-hidden="true" />Сначала заберите заказ</h3><Work economy={readyEconomy} job={job} openPantry={onOpenPantry} /></section>}
        {target ? <>
          {!construction && <section className={`${styles.section} ${styles.costCard}`} aria-label="Подготовка к улучшению">
            <div className={styles.sectionHeading}><h3>Стоимость улучшения</h3><span>Есть / нужно</span></div>
            <Cost state={state} cost={target.cost} navigation={navigation} />
            {!!missing.length && <div className={styles.conditions}><h4><LockKeyhole size={14} aria-hidden="true" />Сначала потребуется</h4><Requirements state={state} required={required} navigation={navigation} /></div>}
          </section>}
          <UpgradeUnlocks state={state} stationId={stationId} target={target} navigation={navigation} />
        </> : <section className={`${styles.section} ${styles.complete}`}><span className={styles.completeIcon}><Check size={28} aria-hidden="true" /></span><h3>Все улучшения получены</h3><p>{building?.description ?? "Эта постройка достигла максимального уровня."}</p>{stationId === "warehouse" && <p>Вместимость кладовой — {number(state.storage.capacity)} предметов.</p>}</section>}
      </>}
    </div>
    <footer className={styles.footer}>
      {readyEconomy && construction ? <><Work economy={readyEconomy} job={construction} openPantry={onOpenPantry} /><p className={styles.muted}>Материалы уже списаны. Работа продолжится после выхода.</p></> : state && target ? <>
        {(pendingReason || reason) && <p className={styles.reason} role="status"><LockKeyhole size={14} aria-hidden="true" />{pendingReason ?? reason}</p>}
        <div className={styles.confirmRow}><span className={styles.duration}><Clock3 size={16} aria-hidden="true" /><span>Время улучшения<strong>{worldDuration(target.seconds)}</strong></span></span><button type="button" className={styles.confirm} disabled={Boolean(reason) || locked(economy)} onClick={() => void economy.act("start_construction", stationId)}><Hammer size={17} aria-hidden="true" />{current ? `Улучшить до ур. ${target.level}` : "Начать обустройство"}</button></div>
        {!pendingReason && !reason && <p className={styles.muted}>Монеты и материалы спишутся при запуске.</p>}
      </> : <button type="button" className={styles.done} onClick={onClose}>{state ? "Готово" : "Вернуться на карту"}</button>}
    </footer>
  </>;
}

export function WorldUpgradeDialog({ stationId, onCloseAutoFocus, ...props }: WorldUpgradeDialogProps) {
  const content = useRef<HTMLDivElement>(null);
  return <Dialog.Root open={stationId !== null} onOpenChange={open => { if (!open) props.onClose(); }}>
    <Dialog.Portal>
      <Dialog.Overlay className={styles.overlay} />
      <Dialog.Content ref={content} className={`${menuStyles.menu} ${styles.dialog}`} data-upgrade-station={stationId ?? undefined}
        onOpenAutoFocus={event => { event.preventDefault(); content.current?.querySelector<HTMLElement>("[data-upgrade-heading]")?.focus({ preventScroll: true }); }}
        onCloseAutoFocus={onCloseAutoFocus}
        onEscapeKeyDown={event => event.stopPropagation()}
        onClick={event => event.stopPropagation()} onWheel={event => event.stopPropagation()}>
        {stationId && <WorldUpgradeContent key={stationId} stationId={stationId} {...props} />}
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}
