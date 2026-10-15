"use client";

import { playUiCue } from "@/features/audio/ui/audio-lifecycle";
import { getAudioRuntime } from "@/features/audio/runtime/audio-service";
import { useEffect, useId, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Check, ChevronDown, CircleHelp, Clock3, Compass, Fish, LockKeyhole, Mountain, Package, RefreshCw, Trees, type LucideIcon } from "lucide-react";
import type { WorldHelpContext } from "@/features/world/ui/help/world-help-types";
import { WorldMealBoost } from "@/features/economy/ui/food/world-meal-boost";
import { mealDuration, pendingMeal } from "@/features/economy/domain/food";
import { ItemIcon } from "@/features/items/item-icon";
import type { EconomyJob, EconomyView } from "@/features/economy/domain/model";
import type { EconomyController } from "@/features/economy/sync/use-economy";
import { locked } from "@/features/economy/sync/controller-state";
import { ProductIcon, itemName, number, stationName } from "@/features/economy/ui/shared/world-economy-parts";
import { worldCostShortfalls, worldCountdown, worldDuration, worldJobProgress, worldMissingRequirements, worldRequirements } from "@/features/economy/ui/shared/world-stations";
import { fishClassForItem, fishingBaitCompatible, fishingState, fishingTripCost } from "@/features/economy/domain/fishing";
import { ExpeditionFishingSummary } from "@/features/economy/ui/fishing/expedition-fishing-summary";
import { FishingCatchReport, fishingCatchRevealed } from "@/features/economy/ui/fishing/fishing-catch-report";
import { PleskCatchOdds } from "@/features/economy/ui/fishing/plesk-fishing-shop";
import { useFishingCommand } from "@/features/economy/ui/fishing/use-fishing-command";
import { WorldTacklePicker, fishingTackleChoice } from "@/features/economy/ui/fishing/world-tackle-picker";
import { economyActorConflict, economyMinerConflict, explorationActorId, isMinerJob, isQuarryProduction } from "@/features/economy/domain/actor-availability";
import { ExpeditionActivityArt } from "./expedition-activity-art";
import { miningDurationFilters, miningDurationLabel, miningDurationMatches, miningResourceGroups, type MiningDurationFilter } from "./mining-resource-groups";
import styles from "./world-expeditions-menu.module.css";

export type WorldExpeditionsMenuProps = {
  economy: EconomyController;
  onOpenPantry: () => void;
  onNavigateStation?: (stationId: string, recipeId?: string) => void;
  isOnline?: boolean;
  onOpenFishingShop?: () => void;
  initialSector?: SectorId;
  initialRouteId?: string;
  onUpgradeQuarry?: () => void;
  onOpenHelp?: (context: WorldHelpContext) => void;
  /** Dedicated mine content; independent extraction and saved legacy journeys share the frame. */
  embeddedCaves?: boolean;
  activeOnly?: boolean;
  onCancellationComplete?: () => void;
};
type Route = EconomyView["catalog"]["explorations"][number];
export type SectorId = "forest" | "shore" | "caves";
export const expeditionSectors: ReadonlyArray<{ id: SectorId; name: string; icon: LucideIcon }> = [
  { id: "forest", name: "За припасами", icon: Trees },
  { id: "shore", name: "На рыбалку", icon: Fish },
  { id: "caves", name: "Добыча в шахте", icon: Mountain },
];
/** Presentation only: progression and rewards always come from the catalog. */
export function expeditionSector(routeId: string): SectorId {
  if (routeId.includes("shore")) return "shore";
  if (routeId.includes("cave") || routeId.includes("quarry")) return "caves";
  return "forest";
}
const countRewards = (rewards: Record<string, number>) => Object.values(rewards).reduce((sum, count) => sum + count, 0);
const routeName = (name: string) => name.replace(/ · \d+ ч$/, "");
const routeIcon = (id: string): LucideIcon => expeditionSectors.find(sector => sector.id === expeditionSector(id))!.icon;
const isFishingRoute = (state: EconomyView, route: Route) => state.catalog.fishing?.routeIds.includes(route.id) ?? false;
const expeditionCost = (state: EconomyView, route: Route) => isFishingRoute(state, route) ? fishingTripCost(route.cost, state) : route.cost;
const routeSeconds = (state: EconomyView, route: Route) => explorationActorId(route) === "miner" ? route.seconds : mealDuration(route.seconds, pendingMeal(state, "hero")?.heroSpeedBps ?? 0);
const displayedRouteDuration = (state: EconomyView, route: Route) => expeditionSector(route.id) === "caves" ? miningDurationLabel(routeSeconds(state, route)) : worldDuration(routeSeconds(state, route));
const canPrepare = (state: EconomyView, route: Route) => worldMissingRequirements(state, worldRequirements(route)).length === 0 && countRewards(route.rewards) <= state.storage.capacity && worldCostShortfalls(state, expeditionCost(state, route)).length === 0;
const hasActiveRoute = (state: EconomyView, routeId: string | null) => routeId !== null && state.jobs.some(job =>
  (job.kind === "exploration" && job.targetId === routeId) || (isQuarryProduction(job) && job.recipeId === routeId));
const sectorRoutes = (state: EconomyView, sectorId: SectorId) => state.catalog.explorations.filter(route => (isFishingRoute(state, route) ? "shore" : expeditionSector(route.id)) === sectorId
  && worldMissingRequirements(state, worldRequirements(route)).every(requirement => explorationActorId(route) === "miner" && requirement.id === "quarry")
  && !(route.id === "quarry_shift" && (state.buildings.quarry ?? 0) >= 4)
  && !(route.id === "quarry_deep_face" && (state.buildings.quarry ?? 0) >= 5));

function Findings({ state, rewards, compact = false, mixedFish = false }: { state: EconomyView; rewards: Record<string, number>; compact?: boolean; mixedFish?: boolean }) {
  return <span className={styles.findings} data-compact={compact || undefined} role="list" aria-label="Находки">{Object.entries(rewards).map(([id, quantity]) => {
    const name = mixedFish && id === "fish" ? "Рыбный улов" : itemName(state, id);
    return <span role="listitem" key={id} title={name} aria-label={`${name}, ${number(quantity)}`}><ProductIcon state={state} itemId={id} size={18} /><span className={styles.resourceName}>{name}</span>{quantity !== 1 && <strong>×{number(quantity)}</strong>}</span>;
  })}</span>;
}

/** Confirmation belongs to this owner and the exact saved job, not a route or
 * a timer tick. An updated/replaced job needs another deliberate approval. */
export function expeditionCancellationKey(owner: string, job: EconomyJob) {
  const entries = (value: Record<string, number>) => Object.entries(value).sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify([owner, job.id, job.kind, job.targetId, job.recipeId, job.targetLevel, job.startedAt, job.finishesAt,
    entries(job.rewards), job.cost.coins, entries(job.cost.items), job.catalogVersion, job.collection ?? null, job.fishing ?? null, job.meal ?? null, job.actorId ?? null]);
}

export function ActiveExpedition({ economy, state, job, onOpenPantry, onOpenHelp, isOnline, confirmationKey, onConfirmation, onCancellationSent }: Pick<WorldExpeditionsMenuProps, "economy" | "onOpenPantry" | "onOpenHelp" | "isOnline"> & {
  state: EconomyView; job: EconomyJob; confirmationKey: string | null; onConfirmation: (key: string | null) => void;
  onCancellationSent: (jobId: string) => void;
}) {
  const id = useId(), recall = useRef<HTMLButtonElement>(null), keep = useRef<HTMLButtonElement>(null), card = useRef<HTMLElement>(null);
  const wasConfirming = useRef(false), sentForKey = useRef<string | null>(null);
  const key = expeditionCancellationKey(state.ownerPublicId, job);
  const confirming = confirmationKey === key;
  const route = state.catalog.explorations.find(entry => entry.id === job.targetId);
  const mining = isMinerJob(job);
  const title = routeName(route?.name ?? (mining ? "Добыча в шахте" : "Вылазка Мохлика"));
  const status = worldJobProgress(state, job, economy.now);
  const current = economy.snapshot?.jobs.find(entry => entry.id === job.id && entry.kind === "exploration");
  const currentJob = Boolean(current && economy.snapshot?.ownerPublicId === state.ownerPublicId
    && expeditionCancellationKey(state.ownerPublicId, current) === key);
  const blocked = locked(economy) || !currentJob;
  useEffect(() => {
    if (confirming && !wasConfirming.current) { sentForKey.current = null; keep.current?.focus({ preventScroll: true }); }
    else if (!confirming && wasConfirming.current) (blocked ? card : recall).current?.focus({ preventScroll: true });
    else if (!confirming && !blocked && document.activeElement === card.current) recall.current?.focus({ preventScroll: true });
    wasConfirming.current = confirming;
  }, [confirming, blocked]);
  const claimBlocked = !status.ready || status.storageShortfall > 0 || blocked || confirming;
  const paid = job.cost.coins > 0 || Object.values(job.cost.items).some(quantity => quantity > 0);
  const fishing = Boolean(state.catalog.fishing && (job.fishing || state.catalog.fishing.routeIds.includes(job.targetId)));
  const catchRevealed = status.ready && fishingCatchRevealed(state, job);
  const catchRefresh = useRef<string | null>(null);
  const refreshCatch = economy.refresh;
  useEffect(() => {
    if (!job.fishing || !status.ready || catchRevealed || blocked || isOnline === false || document.hidden || !navigator.onLine) return;
    const revealKey = JSON.stringify([state.ownerPublicId, job.id, job.finishesAt]);
    if (catchRefresh.current === revealKey) return;
    catchRefresh.current = revealKey;
    // One read at the deadline, never a claim or a loop against an older server snapshot.
    // The controller additionally checks its session's enabled/available state.
    void refreshCatch();
  }, [state.ownerPublicId, job.id, job.finishesAt, job.fishing, status.ready, catchRevealed, blocked, isOnline, economy.now, refreshCatch]);
  const extraRewards = fishing ? Object.fromEntries(Object.entries(job.rewards).filter(([id]) => !fishClassForItem(id, state.catalog.fishing))) : job.rewards;
  function cancel() {
    if (!confirming || blocked || sentForKey.current === key) return;
    sentForKey.current = key;
    onCancellationSent(job.id);
    onConfirmation(null);
    void economy.act("cancel_exploration", job.id);
  }
  const ActivityIcon = mining ? Mountain : Compass;
  return <section ref={card} tabIndex={-1} className={styles.active} aria-label={`${mining ? "Текущая добыча" : "Текущая вылазка"}: ${title}`} aria-busy={economy.busy || undefined} data-mining={mining || undefined} data-ready={status.ready || undefined}>
    <div className={styles.activeTitle}><ActivityIcon size={18} aria-hidden="true" /><div><span>{mining ? status.ready ? "Добыча готова" : "Шахта работает" : status.ready ? "Мохлик вернулся" : "Мохлик в пути"}</span><strong>{title}</strong></div></div>
    {fishing && <FishingCatchReport state={state} rewards={job.rewards} revealed={catchRevealed} />}
    {Object.keys(extraRewards).length > 0 && <Findings state={state} rewards={extraRewards} />}
    <progress className={styles.progress} value={status.progress} max={1} aria-label={`Готовность ${mining ? "добычи" : "вылазки"}: ${title}`} />
    <div className={styles.actions}><span className={styles.time}>{status.ready ? <Check size={13} aria-hidden="true" /> : <Clock3 size={13} aria-hidden="true" />}{status.ready ? "Находки ждут" : worldCountdown(status.seconds)}</span><button type="button" className={styles.primary} disabled={claimBlocked} onClick={() => { if (!claimBlocked) void economy.act("claim_job", job.id); }} aria-label={`Забрать находки: ${title}`}>Забрать</button></div>
    {status.ready && status.storageShortfall > 0 && <div className={styles.warning}><p>Нужно освободить {number(status.storageShortfall)} мест. Находки сохранятся до получения.</p><button type="button" className={styles.link} onClick={onOpenPantry}><Package size={13} aria-hidden="true" />Открыть кладовую<ArrowRight size={12} aria-hidden="true" /></button></div>}
    {status.ready && (status.storageShortfall > 0 || economy.uncertain || economy.retryAt > economy.now) && onOpenHelp && <button type="button" className={styles.contextHelp} onClick={() => onOpenHelp({ intent: "expedition", routeId: job.targetId })}><CircleHelp size={15} aria-hidden="true" />Как продолжить?</button>}
    <button ref={recall} type="button" className={`${styles.link} ${styles.recall}`} disabled={blocked}
      aria-expanded={confirming} aria-controls={confirming ? `${id}-cancel` : undefined}
      onClick={() => { if (!blocked) onConfirmation(confirming ? null : key); }}>{status.ready ? "Отказаться от находок" : mining ? "Остановить добычу" : "Вернуть Мохлика"}</button>
    {confirming && <div className={styles.cancelConfirmation} id={`${id}-cancel`} role="group" aria-labelledby={`${id}-cancel-title`} aria-describedby={`${id}-cancel-cost`}>
      <strong id={`${id}-cancel-title`}>{status.ready ? "Отказаться от этой добычи?" : mining ? "Прервать добычу?" : "Прервать вылазку?"}</strong>
      <p id={`${id}-cancel-cost`}>Все награды этой {mining ? "работы" : "вылазки"} будут потеряны.{mining ? paid ? " Потраченные монеты и припасы вернутся." : " Новую добычу можно будет начать сразу." : paid ? " Потраченные монеты и припасы не возвращаются." : " Мохлик вернётся без добычи."}</p>
      <div className={styles.cancelActions}>
        <button ref={keep} type="button" className={styles.keepExpedition} onClick={() => onConfirmation(null)}>{status.ready ? "Оставить находки" : mining ? "Продолжить добычу" : "Продолжить вылазку"}</button>
        <button type="button" className={styles.cancelExpedition} disabled={blocked} onClick={cancel}>{mining ? "Остановить без результата" : "Вернуться без добычи"}</button>
      </div>
    </div>}
  </section>;
}

export function ExpeditionRouteDetails({ route, state, economy, exploring, onOpenPantry, onNavigateStation, onOpenFishingShop, onUpgradeQuarry, onOpenHelp }: WorldExpeditionsMenuProps & { route: Route; state: EconomyView; exploring: boolean }) {
  const command = useFishingCommand({ economy, state });
  const missing = worldMissingRequirements(state, worldRequirements(route));
  const fishing = isFishingRoute(state, route), gear = fishingState(state), cost = expeditionCost(state, route);
  const shortfalls = worldCostShortfalls(state, cost);
  const findings = countRewards(route.rewards);
  const tooLarge = findings > state.storage.capacity;
  const mining = explorationActorId(route) === "miner";
  const actorConflict = mining ? economyMinerConflict(state.jobs, economy.now) : economyActorConflict(state.jobs, "departure", economy.now);
  const actorBusy = mining ? Boolean(actorConflict) : exploring || Boolean(actorConflict);
  const catalog = state.catalog.fishing;
  const rods = catalog?.rods.filter(rod => gear.ownedRods.includes(rod.id)) ?? [];
  const hooks = catalog?.hooks.filter(hook => gear.ownedHooks.includes(hook.id)) ?? [];
  const invalidGear = fishing && (!rods.some(rod => rod.id === gear.equippedRodId) || !hooks.some(hook => hook.id === gear.equippedHookId)
    || Boolean(gear.equippedBaitId && !catalog?.baits.some(bait => bait.itemId === gear.equippedBaitId)));
  const incompatibleBait = fishing && Boolean(gear.equippedBaitId && catalog && !fishingBaitCompatible(gear.equippedRodId, gear.equippedBaitId, catalog));
  const mineUpgrading = Boolean(route.requiredBuildings.quarry && state.jobs.some(job => job.kind === "construction" && job.targetId === "quarry"));
  const blocked = missing.length > 0 || shortfalls.length > 0 || tooLarge || actorBusy || invalidGear || incompatibleBait || mineUpgrading;
  return <div className={styles.detail}>
    {fishing ? <ExpeditionFishingSummary state={state} route={route} /> : <div className={styles.routeRewards}><Findings state={state} rewards={route.rewards} /></div>}
    {fishing && <WorldTacklePicker state={state} economy={economy} disabled={command.blocked} onOpenFishingShop={onOpenFishingShop} onChoose={(kind, itemId) => {
      const action = kind === "rod" ? "equip_fishing_rod" : kind === "hook" ? "equip_fishing_hook" : "equip_fishing_bait";
      return command.send(action, itemId, 1, 0, Boolean(fishingTackleChoice(state, kind, itemId)));
    }} />}
    {missing.length > 0 && <ul className={styles.requirements} aria-label="Условия открытия">{missing.map(({ id, level }) => {
      const openRequirement = id === "quarry" && onUpgradeQuarry ? onUpgradeQuarry : onNavigateStation ? () => onNavigateStation(id) : undefined;
      return <li key={id} data-missing="true"><LockKeyhole size={12} aria-hidden="true" />{openRequirement ? <button type="button" className={styles.link} onClick={openRequirement}>{stationName(state, id)} · нужен ур. {level}<ArrowRight size={12} aria-hidden="true" /></button> : <span>{stationName(state, id)} · нужен ур. {level}</span>}</li>;
    })}</ul>}
    {(cost.coins > 0 || Object.values(cost.items).some(quantity => quantity > 0)) && <div className={styles.provisions}><span className={styles.caption}>{mining ? "Для добычи" : "С собой"}</span><ul aria-label="Припасы для вылазки">{cost.coins > 0 && <li data-missing={state.wallet.coins < cost.coins || undefined}><ItemIcon itemId="coins" size={16} /><span>Монеты</span><strong>{state.wallet.coins < cost.coins ? `${number(state.wallet.coins)} / ${number(cost.coins)}` : `×${number(cost.coins)}`}</strong></li>}{Object.entries(cost.items).filter(([, quantity]) => quantity > 0).map(([id, quantity]) => <li key={id} data-missing={(state.inventory[id] ?? 0) < quantity || undefined}><ProductIcon state={state} itemId={id} size={18} /><span>{itemName(state, id)}</span><strong>{(state.inventory[id] ?? 0) < quantity ? `${number(state.inventory[id] ?? 0)} / ${number(quantity)}` : `×${number(quantity)}`}</strong></li>)}</ul></div>}
    {tooLarge ? <div className={styles.warning}><p>Находки займут {number(findings)} мест, вместимость - {number(state.storage.capacity)}.</p><button type="button" className={styles.link} onClick={onNavigateStation ? () => onNavigateStation("warehouse") : onOpenPantry}>Расширить кладовую<ArrowRight size={12} aria-hidden="true" /></button></div> : state.storage.available < findings && <button type="button" className={styles.storageHint} onClick={onOpenPantry}><Package size={13} aria-hidden="true" /><span>К возвращению нужно {number(findings)} мест · свободно {number(state.storage.available)}</span><ArrowRight size={12} aria-hidden="true" /></button>}
    {mineUpgrading && <p className={styles.caption}>Дождитесь улучшения шахты и заберите результат.</p>}
    {actorConflict && <p className={styles.caption}>{!mining && actorConflict.code === "ECONOMY_QUARRY_BUSY" ? "Завершите предыдущую работу Мохлика на карте." : actorConflict.message}</p>}
    {invalidGear && <p className={styles.warning}>Выберите доступную удочку и крючок перед отправлением.</p>}
    {incompatibleBait && <p className={styles.warning}>Эта наживка не подходит к выбранной удочке. Нужна подходящая удочка или рыбалка без наживки. <button type="button" className={styles.link} disabled={command.blocked} onClick={() => command.send("equip_fishing_bait", "none", 1, 0, Boolean(gear.equippedBaitId))}>Снять наживку</button></p>}
    {(blocked || economy.uncertain || economy.retryAt > economy.now) && onOpenHelp && <button type="button" className={styles.contextHelp} onClick={() => onOpenHelp({ intent: "expedition", routeId: route.id })}><CircleHelp size={15} aria-hidden="true" />Как продолжить?</button>}
    {fishing && catalog && <section className={styles.catchDetails} aria-label="Шансы улова"><PleskCatchOdds state={state} catalog={catalog} /></section>}
    {actorBusy ? <p className={styles.caption}>{mining ? "Заберите результат добычи перед следующим запуском." : "Сначала заберите находки или отмените текущую вылазку."}</p> : <div className={styles.actions}>{shortfalls.length > 0 && <span className={styles.warning}>Не хватает припасов</span>}<button type="button" className={styles.primary} disabled={blocked || command.blocked} onClick={() => command.send(fishing ? "start_fishing" : "start_exploration", route.id, 1, 0, !blocked)} aria-label={`${mining ? "Начать добычу" : "Отправиться"}: ${route.name}`}>{mining ? "Начать добычу" : "Отправиться"} · {displayedRouteDuration(state, route)}<ArrowRight size={13} aria-hidden="true" /></button></div>}
  </div>;
}

export function WorldExpeditionSector({ sectorId, selectedRoute, onSelectRoute, economy, state, exploring, onOpenPantry, onNavigateStation, onOpenFishingShop, onUpgradeQuarry, onOpenHelp, isOnline }: WorldExpeditionsMenuProps & { sectorId: SectorId; selectedRoute: string | null; onSelectRoute: (id: string | null) => void; state: EconomyView; exploring: boolean }) {
  const descriptionPrefix = useId();
  const [durationFilter, setDurationFilter] = useState<MiningDurationFilter>("all");
  const routes = sectorRoutes(state, sectorId);
  const readyRoutes = routes.filter(route => canPrepare(state, route));
  const laterRoutes = routes.filter(route => !canPrepare(state, route));
  const sector = expeditionSectors.find(entry => entry.id === sectorId)!;
  const selected = routes.find(route => route.id === selectedRoute && !hasActiveRoute(state, route.id));
  const selectedSeconds = selected ? routeSeconds(state, selected) : 0;
  if (selected) return <section className={styles.preparation} data-section-guide-target="expedition-preparation" aria-label={`Подготовка: ${routeName(selected.name)}`} data-sector={sectorId} data-route={selected.id} data-route-preparation="true">
    <button type="button" className={styles.back} onClick={() => { if (sectorId === "caves" && !miningDurationMatches(selectedSeconds, durationFilter)) setDurationFilter("all"); onSelectRoute(null); }}><ArrowLeft size={15} aria-hidden="true" />{sectorId === "caves" ? "Вся добыча" : "Все маршруты"}<span>{sector.name}</span></button>
    <header className={styles.preparationHeading} data-activity={sectorId}><span className={styles.preparationArt}><ExpeditionActivityArt sector={sectorId} /></span><h3 tabIndex={-1} data-route-heading>{routeName(selected.name)}</h3><span className={styles.routeDuration}><Clock3 size={13} aria-hidden="true" />{displayedRouteDuration(state, selected)}</span></header>
    {explorationActorId(selected) !== "miner" && <div className={styles.preparationBoost}><WorldMealBoost key={selected.id} economy={economy} consumer="hero" seconds={selected.seconds} isOnline={isOnline} onNavigateStation={onNavigateStation} /></div>}
    <ExpeditionRouteDetails key={selected.id} route={selected} state={state} economy={economy} exploring={exploring} onOpenPantry={onOpenPantry} onNavigateStation={onNavigateStation} onOpenFishingShop={onOpenFishingShop} onUpgradeQuarry={onUpgradeQuarry} onOpenHelp={onOpenHelp} />
  </section>;
  if (sectorId === "caves") {
    const groups = miningResourceGroups(routes, durationFilter, route => routeSeconds(state, route));
    return <section className={`${styles.routes} ${styles.miningRoutes}`} data-section-guide-target="expedition-routes" aria-label="Добыча по ресурсам" data-sector="caves">
      <div className={styles.miningFilters} role="group" aria-label="Время добычи">{miningDurationFilters.map(filter => <button type="button" key={filter.id} aria-pressed={durationFilter === filter.id} data-mining-duration={filter.id} onClick={() => setDurationFilter(filter.id)}>{filter.label}</button>)}</div>
      {groups.map(group => {
        const mixed = group.itemId === null;
        const title = group.itemId ? itemName(state, group.itemId) : "Смешанная добыча";
        const heading = <>{group.itemId ? <ProductIcon state={state} itemId={group.itemId} size={24} /> : <Package size={19} aria-hidden="true" />}<span>{title}</span>{mixed && <ChevronDown className={styles.miningToggle} size={15} aria-hidden="true" />}</>;
        const cards = <div className={styles.miningCards} data-variants={mixed ? undefined : group.routes.length}>{group.routes.map(route => {
          const missing = worldMissingRequirements(state, worldRequirements(route));
          const tooLarge = countRewards(route.rewards) > state.storage.capacity;
          const needsProvisions = worldCostShortfalls(state, expeditionCost(state, route)).length > 0;
          const reason = missing.length ? `${stationName(state, missing[0].id)} · ур. ${missing[0].level}${missing.length > 1 ? ` +${missing.length - 1}` : ""}` : tooLarge ? "Расширьте кладовую" : needsProvisions ? "Нужны припасы" : null;
          const descriptionId = `${descriptionPrefix}-${route.id}`;
          const findings = <span id={`${descriptionId}-rewards`} className={styles.miningFindings} role="list" aria-label="Добыча" data-mixed={mixed || undefined}>{Object.entries(route.rewards).filter(([, quantity]) => quantity > 0).map(([itemId, quantity]) => <span key={itemId} role="listitem" className={styles.miningYield} data-mining-yield={itemId}>
            {mixed && <ProductIcon state={state} itemId={itemId} size={18} />}<span className={styles.miningResourceName} title={itemName(state, itemId)}>{itemName(state, itemId)}</span>{quantity !== 1 ? <strong>×{number(quantity)}</strong> : !mixed && <span className={styles.miningSingle}>1</span>}
          </span>)}</span>;
          return <button type="button" key={route.id} className={styles.miningCard} data-route={route.id} data-mixed={mixed || undefined} data-locked={Boolean(reason) || undefined} aria-label={`Подготовиться: ${route.name}`} aria-describedby={`${descriptionId}-duration ${descriptionId}-rewards${reason ? ` ${descriptionId}-reason` : ""}`} onClick={() => onSelectRoute(route.id)}>
            {mixed && <strong className={styles.miningName}>{routeName(route.name)}</strong>}
            <span id={`${descriptionId}-duration`} className={styles.routeDuration}><Clock3 size={11} aria-hidden="true" />{displayedRouteDuration(state, route)}</span>
            {mixed && <ArrowRight className={styles.miningChevron} size={13} aria-hidden="true" />}
            {findings}
            {reason && <small id={`${descriptionId}-reason`} className={styles.miningLocked} title={reason}><LockKeyhole size={10} aria-hidden="true" /><span>{reason}</span></small>}
          </button>;
        })}</div>;
        return mixed ? <details className={`${styles.miningGroup} ${styles.miningMixed}`} key={group.id} data-mining-resource={group.id} aria-label={title}>
          <summary className={styles.miningGroupTitle}>{heading}</summary>{cards}
        </details> : <section className={styles.miningGroup} key={group.id} data-mining-resource={group.id} aria-label={title}>
          <h4 className={styles.miningGroupTitle}>{heading}</h4>{cards}
        </section>;
      })}
      {!groups.length && <p className={styles.miningEmpty} role="status">{routes.length ? "Нет добычи с таким временем. Выберите другой фильтр." : "Добыча откроется после улучшения дома."}</p>}
    </section>;
  }
  return <section className={styles.routes} data-section-guide-target="expedition-routes" aria-label={`Маршруты: ${sector.name}`} data-sector={sectorId}>
    {[{ key: "ready", label: "Доступные маршруты", routes: readyRoutes }, { key: "later", label: "Нужно подготовиться", routes: laterRoutes }].filter(group => group.routes.length > 0).map(group => <div className={styles.routeGroup} key={group.key}>
      <p className={styles.groupTitle}>{group.label}<span>{group.routes.length}</span></p>
      {group.routes.map(route => {
        const missing = worldMissingRequirements(state, worldRequirements(route));
        const tooLarge = countRewards(route.rewards) > state.storage.capacity;
        const needsProvisions = worldCostShortfalls(state, expeditionCost(state, route)).length > 0;
        const Icon = routeIcon(route.id);
        const unavailable = missing.length > 0 || tooLarge || needsProvisions;
        const reason = missing.length ? `${stationName(state, missing[0].id)} · ур. ${missing[0].level}${missing.length > 1 ? ` +${missing.length - 1}` : ""}` : tooLarge ? "Расширьте кладовую" : needsProvisions ? "Нужны припасы" : null;
        const descriptionId = `${descriptionPrefix}-${route.id}`;
        return <button type="button" key={route.id} className={styles.route} data-route={route.id} data-locked={unavailable || undefined} aria-label={`Подготовиться: ${route.name}`} aria-describedby={`${descriptionId}-duration ${descriptionId}-rewards${reason ? ` ${descriptionId}-reason` : ""}`} onClick={() => onSelectRoute(route.id)}>
          <span className={styles.routeIcon}><Icon size={19} aria-hidden="true" /></span><span className={styles.routeText}><strong>{routeName(route.name)}</strong>{reason && <small id={`${descriptionId}-reason`}><LockKeyhole size={10} aria-hidden="true" />{reason}</small>}</span><span id={`${descriptionId}-duration`} className={styles.routeDuration}><Clock3 size={11} aria-hidden="true" />{worldDuration(routeSeconds(state, route))}</span><ArrowRight className={styles.chevron} size={14} aria-hidden="true" /><span id={`${descriptionId}-rewards`} className={styles.routeFindings}><Findings state={state} rewards={route.rewards} compact mixedFish={isFishingRoute(state, route)} /></span>
        </button>;
      })}
    </div>)}
    {!routes.length && <p className={styles.intro}>Маршруты пока недоступны.</p>}
  </section>;
}

export function WorldExpeditionsMenu({ economy, onOpenPantry, onNavigateStation, onOpenFishingShop, onUpgradeQuarry, onOpenHelp, isOnline, initialSector = "forest", initialRouteId, embeddedCaves = false, activeOnly = false, onCancellationComplete }: WorldExpeditionsMenuProps) {
  const initialTravelSector = initialSector === "shore" ? "shore" : null;
  const [selectedSector, setSelectedSector] = useState<SectorId | null>(initialTravelSector);
  const routeTarget = embeddedCaves ? initialRouteId ?? null : null;
  const [routeSelection, setRouteSelection] = useState({ target: routeTarget, route: routeTarget });
  // A new help target is a read-only preview; local back/select overrides it
  // until another target is requested. No effect needs to send a command.
  const selectedRoute = routeSelection.target === routeTarget ? routeSelection.route : routeTarget;
  const setSelectedRoute = (route: string | null) => setRouteSelection({ target: routeTarget, route });
  const [confirmationKey, setConfirmationKey] = useState<string | null>(null);
  const previousRoute = useRef<string | null>(null);
  const previousSector = useRef<SectorId | null>(initialTravelSector);
  const lastSector = useRef<SectorId>(initialTravelSector ?? "forest");
  const cancellationSent = useRef<string | null>(null), selectedSectorButton = useRef<HTMLButtonElement>(null), content = useRef<HTMLDivElement>(null);
  const state = economy.snapshot;
  const currentSector = embeddedCaves ? "caves" : selectedSector === "caves" ? null : selectedSector;
  const selectedActive = Boolean(state && hasActiveRoute(state, selectedRoute));
  // A saved trip replaces its preview. Drop that help/selection target once so
  // claiming it cannot unexpectedly reopen the old launch form.
  if (selectedActive && (routeSelection.target !== routeTarget || routeSelection.route !== null)) {
    setRouteSelection({ target: routeTarget, route: null });
  }
  const visibleRoute = state && currentSector && !selectedActive ? sectorRoutes(state, currentSector).find(route => route.id === selectedRoute)?.id ?? null : null;
  useEffect(() => {
    if (currentSector !== previousSector.current) {
      const target = currentSector ? content.current?.querySelector<HTMLElement>("[data-activity-heading]")
        : Array.from(content.current?.querySelectorAll<HTMLButtonElement>("[data-sector-select]") ?? []).find(button => button.dataset.sectorSelect === lastSector.current);
      target?.focus({ preventScroll: true });
    }
    previousSector.current = currentSector;
  }, [currentSector]);
  useEffect(() => {
    if (visibleRoute === previousRoute.current) return;
    if (visibleRoute) content.current?.querySelector<HTMLElement>("[data-route-heading]")?.focus();
    else if (previousRoute.current) {
      // Find by dataset rather than interpolating catalog IDs into CSS selectors.
      const cards = content.current?.querySelectorAll<HTMLButtonElement>("button[data-route]");
      const origin = Array.from(cards ?? []).find(card => card.dataset.route === previousRoute.current);
      const collapsedGroup = origin?.closest<HTMLDetailsElement>("details[data-mining-resource]");
      if (collapsedGroup) collapsedGroup.open = true;
      (origin ?? selectedSectorButton.current ?? content.current)?.focus();
    }
    previousRoute.current = visibleRoute;
  }, [visibleRoute]);
  useEffect(() => {
    if (!state || !cancellationSent.current || state.jobs.some(job => job.id === cancellationSent.current)) return;
    cancellationSent.current = null;
    if (document.activeElement === document.body) {
      const target = selectedSectorButton.current ?? content.current;
      if (target) target.focus({ preventScroll: true });
      else onCancellationComplete?.();
    }
  }, [state, onCancellationComplete]);
  const cooldown = Math.max(0, Math.ceil((economy.retryAt - economy.now) / 1000));
  const allTrips = state?.jobs.filter(job => job.kind === "exploration") ?? [];
  const heroTrips = allTrips.filter(job => !isMinerJob(job));
  const jobs = embeddedCaves ? allTrips.filter(job => isMinerJob(job) || expeditionSector(job.targetId) === "caves")
    : heroTrips.filter(job => expeditionSector(job.targetId) !== "caves");
  function selectSector(id: SectorId | null) {
    if (id === "caves" || id === currentSector) return;
    if (id) lastSector.current = id;
    playUiCue(getAudioRuntime(), "ui.tab");
    setSelectedSector(id);
    setSelectedRoute(null);
    setConfirmationKey(null);
  }
  const retry = <button type="button" className={styles.link} disabled={economy.busy || cooldown > 0} onClick={() => { if (!economy.busy && cooldown <= 0) void economy.retry(); }}><RefreshCw size={13} aria-hidden="true" />{cooldown ? `Повторить через ${cooldown} с` : economy.uncertain ? "Проверить результат" : "Попробовать ещё раз"}</button>;
  if (activeOnly && !jobs.length) return null;
  return <div ref={content} className={styles.content} tabIndex={-1} data-embedded={embeddedCaves || undefined}>
    {!state ? <div className={styles.loading}><Compass size={18} aria-hidden="true" /><p>{economy.error ?? "Открываем маршруты…"}</p>{economy.error && retry}</div> : <>
      {!embeddedCaves && !economy.syncError && (economy.error || economy.uncertain || cooldown > 0) && <div className={styles.warning} role="alert"><p>{economy.uncertain ? "Проверяем последнее действие. Дождитесь подтверждения, прежде чем продолжать." : economy.error ?? "Подождите перед следующим действием."}</p>{retry}</div>}
      {jobs.map(job => <ActiveExpedition key={job.id} economy={economy} state={state} job={job} onOpenPantry={onOpenPantry} onOpenHelp={onOpenHelp} isOnline={isOnline}
        confirmationKey={confirmationKey} onConfirmation={setConfirmationKey} onCancellationSent={jobId => { cancellationSent.current = jobId; }} />)}
      {!embeddedCaves && !activeOnly && !currentSector && <>
        <header className={styles.chooserHeading}><span>Время приключений</span><h3>Чем займёмся?</h3><p>{jobs.length ? "Пока Мохлик в пути, можно выбрать следующий маршрут." : "Небольшая прогулка или целое приключение."}</p></header>
        <div className={styles.activities} role="group" aria-label="Занятия леса" data-section-guide-target="expedition-activities">{expeditionSectors.filter(sector => sector.id !== "caves").map(({ id, name }) => {
          const routes = sectorRoutes(state, id), durations = routes.map(route => routeSeconds(state, route));
          const description = id === "forest" ? "Материалы из леса и с берега" : "Улов и необычные находки";
          return <button type="button" key={id} className={styles.activity} data-sector-select={id} data-activity={id} onClick={() => selectSector(id)}>
            <span className={styles.activityArt}><ExpeditionActivityArt sector={id} /></span>
            <span className={styles.activityText}><strong>{name}</strong><span>{description}</span><small><Clock3 size={12} aria-hidden="true" />{durations.length ? `${worldDuration(Math.min(...durations))} - ${worldDuration(Math.max(...durations))}` : "Скоро"}</small></span>
            <ArrowRight size={18} className={styles.activityArrow} aria-hidden="true" />
          </button>;
        })}</div>
        <p className={styles.activityNote}><Compass size={14} aria-hidden="true" />Мохлик выбирает одну вылазку; находки дождутся получения.</p>
      </>}
      {!embeddedCaves && !activeOnly && currentSector && !visibleRoute && <>
        <button ref={selectedSectorButton} type="button" className={styles.back} onClick={() => selectSector(null)}><ArrowLeft size={15} aria-hidden="true" />Все занятия</button>
        <header className={styles.activityHeading} data-activity={currentSector}><span className={styles.activityArt}><ExpeditionActivityArt sector={currentSector} /></span><h3 data-activity-heading tabIndex={-1}>{expeditionSectors.find(sector => sector.id === currentSector)!.name}</h3><p>{currentSector === "shore" ? "Выбери время у воды. Снасти настроим перед выходом." : "Выбери, что пригодится твоей полянке."}</p></header>
      </>}
      {!activeOnly && currentSector && <WorldExpeditionSector isOnline={isOnline} sectorId={currentSector} selectedRoute={visibleRoute} onSelectRoute={setSelectedRoute} state={state} economy={economy} exploring={heroTrips.length > 0} onOpenPantry={onOpenPantry} onNavigateStation={onNavigateStation} onOpenFishingShop={onOpenFishingShop} onUpgradeQuarry={onUpgradeQuarry} onOpenHelp={onOpenHelp} />}
    </>}
  </div>;
}
