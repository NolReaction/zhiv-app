"use client";

import { useEffect, useId, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Check, ChevronDown, CircleHelp, Clock3, Compass, Fish, Hammer, LockKeyhole, Mountain, Package, RefreshCw, Trees, type LucideIcon } from "lucide-react";
import type { WorldHelpContext } from "@/features/world/world-help-types";
import { WorldMealBoost } from "./world-meal-boost";
import { mealDuration, pendingMeal } from "./food";
import { ItemIcon } from "@/features/items/item-icon";
import { FishingRodIcon } from "@/features/world/fishing-rod-icon";
import type { EconomyJob, EconomyView } from "./model";
import type { EconomyController } from "./use-economy";
import { ProductIcon, Work, itemName, locked, number, stationName } from "./world-economy-parts";
import { worldCostShortfalls, worldDuration, worldJobProgress, worldMissingRequirements, worldRequirements } from "./world-stations";
import { fishingState, fishingTripCost } from "./fishing";
import { ExpeditionFishingSummary } from "./expedition-fishing-summary";
import { PleskCatchOdds } from "./plesk-fishing-shop";
import { useFishingCommand } from "./use-fishing-command";
import { economyActorConflict, isQuarryProduction } from "./actor-availability";
import styles from "./world-expeditions-menu.module.css";

export type WorldExpeditionsMenuProps = {
  economy: EconomyController;
  onOpenPantry: () => void;
  onNavigateStation?: (stationId: string, recipeId?: string) => void;
  isOnline?: boolean;
  onOpenMeals?: () => void;
  onOpenFishingShop?: () => void;
  initialSector?: SectorId;
  onUpgradeQuarry?: () => void;
  onOpenHelp?: (context: WorldHelpContext) => void;
  /** The mine shares these routes and active trip controls with the travel menu. */
  embeddedCaves?: boolean;
  activeOnly?: boolean;
  onCancellationComplete?: () => void;
};
type Route = EconomyView["catalog"]["explorations"][number];
export type SectorId = "forest" | "shore" | "caves";
export const expeditionSectors: ReadonlyArray<{ id: SectorId; name: string; icon: LucideIcon }> = [
  { id: "forest", name: "Лес", icon: Trees },
  { id: "shore", name: "Побережье", icon: Fish },
  { id: "caves", name: "Шахта", icon: Mountain },
];
/** Presentation only: progression and rewards always come from the catalog. */
export function expeditionSector(routeId: string): SectorId {
  if (routeId.includes("shore") || routeId.includes("coastal")) return "shore";
  if (routeId.includes("cave") || routeId.includes("quarry")) return "caves";
  return "forest";
}
const countRewards = (rewards: Record<string, number>) => Object.values(rewards).reduce((sum, count) => sum + count, 0);
const routeName = (name: string) => name.replace(/ · \d+ ч$/, "");
const routeIcon = (id: string): LucideIcon => expeditionSectors.find(sector => sector.id === expeditionSector(id))!.icon;
const isFishingRoute = (state: EconomyView, route: Route) => state.catalog.fishing?.routeIds.includes(route.id) ?? false;
const expeditionCost = (state: EconomyView, route: Route) => isFishingRoute(state, route) ? fishingTripCost(route.cost, state) : route.cost;
const canPrepare = (state: EconomyView, route: Route) => worldMissingRequirements(state, worldRequirements(route)).length === 0 && countRewards(route.rewards) <= state.storage.capacity && worldCostShortfalls(state, expeditionCost(state, route)).length === 0;
const sectorRoutes = (state: EconomyView, sectorId: SectorId) => state.catalog.explorations.filter(route => expeditionSector(route.id) === sectorId
  && !(route.id === "quarry_shift" && (state.buildings.quarry ?? 0) >= 4)
  && !(route.id === "quarry_deep_face" && (state.buildings.quarry ?? 0) >= 5));

function Findings({ state, rewards, compact = false, mixedFish = false }: { state: EconomyView; rewards: Record<string, number>; compact?: boolean; mixedFish?: boolean }) {
  return <span className={styles.findings} data-compact={compact || undefined} role="list" aria-label="Находки">{Object.entries(rewards).map(([id, quantity]) => {
    const name = mixedFish && id === "fish" ? "Рыбный улов" : itemName(state, id);
    return <span role="listitem" key={id} title={name}><ProductIcon state={state} itemId={id} size={18} /><span className={styles.resourceName}>{name}</span><strong>×{number(quantity)}</strong></span>;
  })}</span>;
}

/** Confirmation belongs to this owner and the exact saved job, not a route or
 * a timer tick. An updated/replaced job needs another deliberate approval. */
export function expeditionCancellationKey(owner: string, job: EconomyJob) {
  const entries = (value: Record<string, number>) => Object.entries(value).sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify([owner, job.id, job.kind, job.targetId, job.recipeId, job.targetLevel, job.startedAt, job.finishesAt,
    entries(job.rewards), job.cost.coins, entries(job.cost.items), job.catalogVersion, job.collection ?? null, job.fishing ?? null, job.meal ?? null]);
}

export function ActiveExpedition({ economy, state, job, onOpenPantry, onOpenHelp, confirmationKey, onConfirmation, onCancellationSent }: Pick<WorldExpeditionsMenuProps, "economy" | "onOpenPantry" | "onOpenHelp"> & {
  state: EconomyView; job: EconomyJob; confirmationKey: string | null; onConfirmation: (key: string | null) => void;
  onCancellationSent: (jobId: string) => void;
}) {
  const id = useId(), recall = useRef<HTMLButtonElement>(null), keep = useRef<HTMLButtonElement>(null), card = useRef<HTMLElement>(null);
  const wasConfirming = useRef(false), sentForKey = useRef<string | null>(null);
  const key = expeditionCancellationKey(state.ownerPublicId, job);
  const confirming = confirmationKey === key;
  const route = state.catalog.explorations.find(entry => entry.id === job.targetId);
  const title = routeName(route?.name ?? "Вылазка Мохлика");
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
  const tripHookId = job.fishing?.hookId ?? "bare_hook";
  const tripHook = state.catalog.fishing?.hooks.find(hook => hook.id === tripHookId);
  function cancel() {
    if (!confirming || blocked || sentForKey.current === key) return;
    sentForKey.current = key;
    onCancellationSent(job.id);
    onConfirmation(null);
    void economy.act("cancel_exploration", job.id);
  }
  return <section ref={card} tabIndex={-1} className={styles.active} aria-label={`Текущая вылазка: ${title}`} aria-busy={economy.busy || undefined} data-ready={status.ready || undefined}>
    <div className={styles.activeTitle}><Compass size={18} aria-hidden="true" /><div><span>{status.ready ? "Мохлик вернулся" : "Мохлик в пути"}</span><strong>{title}</strong></div></div>
    {job.fishing && <p className={styles.savedHook}><ItemIcon itemId={tripHookId} size={20} /><span>Крючок этой вылазки: {tripHook?.name ?? (tripHookId === "bare_hook" ? "Простой крючок" : "Сохранённый крючок")}</span></p>}
    <Findings state={state} rewards={job.rewards} />
    <progress className={styles.progress} value={status.progress} max={1} aria-label={`Готовность вылазки: ${title}`} />
    <div className={styles.actions}><span className={styles.time}>{status.ready ? <Check size={13} aria-hidden="true" /> : <Clock3 size={13} aria-hidden="true" />}{status.ready ? "Находки ждут" : `Ещё ${status.seconds < 60 ? `${status.seconds} с` : worldDuration(status.seconds)}`}</span><button type="button" className={styles.primary} disabled={claimBlocked} onClick={() => { if (!claimBlocked) void economy.act("claim_job", job.id); }} aria-label={`Забрать находки: ${title}`}>Забрать</button></div>
    {status.ready && status.storageShortfall > 0 && <div className={styles.warning}><p>Нужно освободить {number(status.storageShortfall)} мест. Находки сохранятся до получения.</p><button type="button" className={styles.link} onClick={onOpenPantry}><Package size={13} aria-hidden="true" />Открыть кладовую<ArrowRight size={12} aria-hidden="true" /></button></div>}
    {status.ready && (status.storageShortfall > 0 || economy.uncertain || economy.retryAt > economy.now) && onOpenHelp && <button type="button" className={styles.contextHelp} onClick={() => onOpenHelp({ intent: "expedition", routeId: job.targetId })}><CircleHelp size={15} aria-hidden="true" />Как продолжить?</button>}
    <button ref={recall} type="button" className={`${styles.link} ${styles.recall}`} disabled={blocked}
      aria-expanded={confirming} aria-controls={confirming ? `${id}-cancel` : undefined}
      onClick={() => { if (!blocked) onConfirmation(confirming ? null : key); }}>{status.ready ? "Отказаться от находок" : "Вернуть Мохлика"}</button>
    {confirming && <div className={styles.cancelConfirmation} id={`${id}-cancel`} role="group" aria-labelledby={`${id}-cancel-title`} aria-describedby={`${id}-cancel-cost`}>
      <strong id={`${id}-cancel-title`}>{status.ready ? "Отказаться от этой добычи?" : "Прервать вылазку?"}</strong>
      <p id={`${id}-cancel-cost`}>Все награды этой вылазки будут потеряны.{paid ? " Потраченные монеты и припасы не возвращаются." : " Мохлик вернётся без добычи."}</p>
      <div className={styles.cancelActions}>
        <button ref={keep} type="button" className={styles.keepExpedition} onClick={() => onConfirmation(null)}>{status.ready ? "Оставить находки" : "Продолжить вылазку"}</button>
        <button type="button" className={styles.cancelExpedition} disabled={blocked} onClick={cancel}>Вернуться без добычи</button>
      </div>
    </div>}
  </section>;
}

export function ExpeditionRouteDetails({ route, state, economy, exploring, onOpenPantry, onNavigateStation, onOpenFishingShop, onUpgradeQuarry, onOpenHelp }: WorldExpeditionsMenuProps & { route: Route; state: EconomyView; exploring: boolean }) {
  const id = useId();
  const command = useFishingCommand({ economy, state });
  const missing = worldMissingRequirements(state, worldRequirements(route));
  const fishing = isFishingRoute(state, route), gear = fishingState(state), cost = expeditionCost(state, route);
  const shortfalls = worldCostShortfalls(state, cost);
  const findings = countRewards(route.rewards);
  const tooLarge = findings > state.storage.capacity;
  const actorConflict = economyActorConflict(state.jobs, "departure", economy.now);
  const catalog = state.catalog.fishing;
  const rods = catalog?.rods.filter(rod => gear.ownedRods.includes(rod.id)) ?? [];
  const hooks = catalog?.hooks.filter(hook => gear.ownedHooks.includes(hook.id)) ?? [];
  const invalidGear = fishing && (!rods.some(rod => rod.id === gear.equippedRodId) || !hooks.some(hook => hook.id === gear.equippedHookId)
    || Boolean(gear.equippedBaitId && !catalog?.baits.some(bait => bait.itemId === gear.equippedBaitId)));
  const mineUpgrading = Boolean(route.requiredBuildings.quarry && state.jobs.some(job => job.kind === "construction" && job.targetId === "quarry"));
  const blocked = missing.length > 0 || shortfalls.length > 0 || tooLarge || exploring || Boolean(actorConflict) || invalidGear || mineUpgrading;
  return <div className={styles.detail}>
    {fishing ? <ExpeditionFishingSummary state={state} route={route} /> : <div className={styles.routeRewards}><span className={styles.caption}>Привезёт с собой</span><Findings state={state} rewards={route.rewards} /></div>}
    {fishing && <details className={styles.fishingGear} aria-label="Снасти для вылазки">
      <summary><span className={styles.gearHeading}>Снасти<small>Изменить</small></span><ChevronDown size={14} className={styles.chevron} aria-hidden="true" /><span className={styles.gearPreview}>
        <span title={catalog?.rods.find(rod => rod.id === gear.equippedRodId)?.name}><FishingRodIcon rodId={gear.equippedRodId} size={23} /><span>{catalog?.rods.find(rod => rod.id === gear.equippedRodId)?.name ?? "Удочка"}</span></span>
        <span title={catalog?.hooks.find(hook => hook.id === gear.equippedHookId)?.name}><ItemIcon itemId={gear.equippedHookId} size={20} /><span>{catalog?.hooks.find(hook => hook.id === gear.equippedHookId)?.name ?? "Крючок"}</span></span>
        <span title={gear.equippedBaitId ? itemName(state, gear.equippedBaitId) : "Без наживки"}>{gear.equippedBaitId ? <ItemIcon itemId={gear.equippedBaitId} size={20} /> : <Fish size={18} aria-hidden="true" />}<span>{gear.equippedBaitId ? itemName(state, gear.equippedBaitId) : "Без наживки"}</span></span>
      </span></summary>
      <div className={styles.gearControls}>
      <div className={styles.loadoutRow}><FishingRodIcon rodId={gear.equippedRodId} size={43} /><label htmlFor={`${id}-rod`}>Удочка<select id={`${id}-rod`} value={gear.equippedRodId} disabled={command.blocked || !rods.length} onChange={event => {
        const rodId = event.target.value;
        command.send("equip_fishing_rod", rodId, 1, 0, rodId !== gear.equippedRodId && rods.some(rod => rod.id === rodId));
      }}>{!rods.some(rod => rod.id === gear.equippedRodId) && <option value={gear.equippedRodId} disabled>Выберите удочку</option>}{rods.map(rod => <option key={rod.id} value={rod.id}>{rod.name}</option>)}</select></label></div>
      <div className={styles.loadoutRow}><ItemIcon itemId={gear.equippedHookId} size={36} /><label htmlFor={`${id}-hook`}>Крючок<select id={`${id}-hook`} value={gear.equippedHookId} disabled={command.blocked || !hooks.length} onChange={event => {
        const hookId = event.target.value;
        command.send("equip_fishing_hook", hookId, 1, 0, hookId !== gear.equippedHookId && hooks.some(hook => hook.id === hookId));
      }}>{!hooks.some(hook => hook.id === gear.equippedHookId) && <option value={gear.equippedHookId} disabled>Выберите крючок</option>}{hooks.map(hook => <option key={hook.id} value={hook.id}>{hook.name}</option>)}</select></label></div>
      <div className={styles.loadoutRow}>{gear.equippedBaitId ? <ItemIcon itemId={gear.equippedBaitId} size={32} /> : <Fish size={27} aria-hidden="true" />}<label htmlFor={`${id}-bait`}>Наживка<select id={`${id}-bait`} value={gear.equippedBaitId ?? "none"} disabled={command.blocked} onChange={event => {
        const baitId = event.target.value;
        const owned = baitId === "none" || Boolean(catalog?.baits.some(bait => bait.itemId === baitId) && (state.inventory[baitId] ?? 0) > 0);
        command.send("equip_fishing_bait", baitId, 1, 0, baitId !== (gear.equippedBaitId ?? "none") && owned);
      }}><option value="none">Без наживки</option>{gear.equippedBaitId && !catalog?.baits.some(bait => bait.itemId === gear.equippedBaitId) && <option value={gear.equippedBaitId} disabled>Недоступная наживка</option>}{catalog?.baits.map(bait => <option key={bait.itemId} value={bait.itemId} disabled={(state.inventory[bait.itemId] ?? 0) <= 0}>{itemName(state, bait.itemId)} · {(state.inventory[bait.itemId] ?? 0) > 0 ? `×${number(state.inventory[bait.itemId])}` : "нет в запасе"}</option>)}</select></label></div>
      <p>Удочка и крючок не расходуются.</p>
      <details className={styles.gearDescription}><summary>О выбранных снастях</summary>
        <p>{catalog?.rods.find(rod => rod.id === gear.equippedRodId)?.description}</p>
        <p>{catalog?.hooks.find(hook => hook.id === gear.equippedHookId)?.description}</p>
        {gear.equippedBaitId && <p>{catalog?.baits.find(bait => bait.itemId === gear.equippedBaitId)?.description}</p>}
      </details>
      {onOpenFishingShop && <button type="button" className={styles.link} onClick={onOpenFishingShop}>Купить снасти у Плёски<ArrowRight size={12} aria-hidden="true" /></button>}
      </div>
    </details>}
    <ul className={styles.requirements} aria-label={missing.length ? "Условия открытия" : "Условия маршрута"}>{Object.entries(worldRequirements(route)).map(([id, level]) => {
      const unmet = (state.buildings[id] ?? 0) < level;
      const openRequirement = id === "quarry" && onUpgradeQuarry ? onUpgradeQuarry : onNavigateStation ? () => onNavigateStation(id) : undefined;
      return <li key={id} data-missing={unmet || undefined}>{unmet ? <LockKeyhole size={12} aria-hidden="true" /> : <Check size={12} aria-hidden="true" />}{unmet && openRequirement ? <button type="button" className={styles.link} onClick={openRequirement}>{stationName(state, id)} · нужен ур. {level}<ArrowRight size={12} aria-hidden="true" /></button> : <span>{stationName(state, id)} · {unmet ? "нужен ур." : "ур."} {level}</span>}</li>;
    })}</ul>
    {cost.coins > 0 || Object.keys(cost.items).length > 0 ? <div className={styles.provisions}><span className={styles.caption}>С собой</span><ul aria-label="Припасы для вылазки">{cost.coins > 0 && <li data-missing={state.wallet.coins < cost.coins || undefined}><ItemIcon itemId="coins" size={16} /><span>Монеты</span><strong>{number(state.wallet.coins)} / {number(cost.coins)}</strong></li>}{Object.entries(cost.items).map(([id, quantity]) => <li key={id} data-missing={(state.inventory[id] ?? 0) < quantity || undefined}><ProductIcon state={state} itemId={id} size={18} /><span>{itemName(state, id)}</span><strong>{number(state.inventory[id] ?? 0)} / {number(quantity)}</strong></li>)}</ul></div> : <p className={styles.free}><Check size={12} aria-hidden="true" />Без затрат</p>}
    {tooLarge ? <div className={styles.warning}><p>Находки займут {number(findings)} мест, вместимость — {number(state.storage.capacity)}.</p><button type="button" className={styles.link} onClick={onNavigateStation ? () => onNavigateStation("warehouse") : onOpenPantry}>Расширить кладовую<ArrowRight size={12} aria-hidden="true" /></button></div> : state.storage.available < findings && <button type="button" className={styles.storageHint} onClick={onOpenPantry}><Package size={13} aria-hidden="true" /><span>К возвращению нужно {number(findings)} мест · свободно {number(state.storage.available)}</span><ArrowRight size={12} aria-hidden="true" /></button>}
    {mineUpgrading && <p className={styles.caption}>Дождитесь улучшения шахты и заберите результат.</p>}
    {actorConflict && !exploring && <p className={styles.caption}>{actorConflict.message}</p>}
    {pendingMeal(state, "hero") && !exploring && <p className={styles.caption}>Сыт · скорость следующей вылазки +{pendingMeal(state, "hero")!.heroSpeedBps / 100}%. Время уже учитывает еду.</p>}
    {invalidGear && <p className={styles.warning}>Выберите доступную удочку и крючок перед отправлением.</p>}
    {(blocked || economy.uncertain || economy.retryAt > economy.now) && onOpenHelp && <button type="button" className={styles.contextHelp} onClick={() => onOpenHelp({ intent: "expedition", routeId: route.id })}><CircleHelp size={15} aria-hidden="true" />Как продолжить?</button>}
    {exploring ? <p className={styles.caption}>Сначала заберите находки или отмените текущую вылазку.</p> : <div className={styles.actions}>{shortfalls.length > 0 && <span className={styles.warning}>Не хватает припасов</span>}<button type="button" className={styles.primary} disabled={blocked || command.blocked} onClick={() => command.send(fishing ? "start_fishing" : "start_exploration", route.id, 1, 0, !blocked)} aria-label={`Отправиться: ${route.name}`}>Отправиться · {worldDuration(mealDuration(route.seconds, pendingMeal(state, "hero")?.heroSpeedBps ?? 0))}<ArrowRight size={13} aria-hidden="true" /></button></div>}
    {fishing && catalog && <details className={styles.catchDetails} aria-label="Шансы улова"><summary><Fish size={16} aria-hidden="true" /><span>Шансы и условия улова</span><ChevronDown size={14} className={styles.chevron} aria-hidden="true" /></summary><PleskCatchOdds state={state} catalog={catalog} /></details>}
  </div>;
}

export function WorldExpeditionSector({ sectorId, selectedRoute, onSelectRoute, economy, state, exploring, onOpenPantry, onNavigateStation, onOpenFishingShop, onUpgradeQuarry, onOpenHelp, onOpenMeals, isOnline }: WorldExpeditionsMenuProps & { sectorId: SectorId; selectedRoute: string | null; onSelectRoute: (id: string | null) => void; state: EconomyView; exploring: boolean }) {
  const descriptionPrefix = useId();
  const routes = sectorRoutes(state, sectorId);
  const readyRoutes = routes.filter(route => canPrepare(state, route));
  const laterRoutes = routes.filter(route => !canPrepare(state, route));
  const sector = expeditionSectors.find(entry => entry.id === sectorId)!;
  const selected = routes.find(route => route.id === selectedRoute);
  if (selected) return <section className={styles.preparation} aria-label={`Подготовка: ${routeName(selected.name)}`} data-sector={sectorId} data-route={selected.id} data-route-preparation="true">
    <button type="button" className={styles.back} onClick={() => onSelectRoute(null)}><ArrowLeft size={15} aria-hidden="true" />Все маршруты<span>{sector.name}</span></button>
    <header className={styles.preparationHeading}><h3 tabIndex={-1} data-route-heading>{routeName(selected.name)}</h3><div className={styles.preparationTime}><span className={styles.routeDuration}><Clock3 size={13} aria-hidden="true" />{worldDuration(mealDuration(selected.seconds, pendingMeal(state, "hero")?.heroSpeedBps ?? 0))}</span><WorldMealBoost key={selected.id} economy={economy} consumer="hero" seconds={selected.seconds} isOnline={isOnline} onNavigateStation={onNavigateStation} onOpenMeals={onOpenMeals} /></div></header>
    <ExpeditionRouteDetails key={selected.id} route={selected} state={state} economy={economy} exploring={exploring} onOpenPantry={onOpenPantry} onNavigateStation={onNavigateStation} onOpenFishingShop={onOpenFishingShop} onUpgradeQuarry={onUpgradeQuarry} onOpenHelp={onOpenHelp} />
  </section>;
  return <section className={styles.routes} aria-label={`Маршруты: ${sector.name}`} data-sector={sectorId}>
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
          <span className={styles.routeIcon}><Icon size={19} aria-hidden="true" /></span><span className={styles.routeText}><strong>{routeName(route.name)}</strong>{reason && <small id={`${descriptionId}-reason`}><LockKeyhole size={10} aria-hidden="true" />{reason}</small>}</span><span id={`${descriptionId}-duration`} className={styles.routeDuration}><Clock3 size={11} aria-hidden="true" />{worldDuration(mealDuration(route.seconds, pendingMeal(state, "hero")?.heroSpeedBps ?? 0))}</span><ArrowRight className={styles.chevron} size={14} aria-hidden="true" /><span id={`${descriptionId}-rewards`} className={styles.routeFindings}><Findings state={state} rewards={route.rewards} compact mixedFish={isFishingRoute(state, route)} /></span>
        </button>;
      })}
    </div>)}
    {!routes.length && <p className={styles.intro}>Маршруты пока недоступны.</p>}
  </section>;
}

export function WorldExpeditionsMenu({ economy, onOpenPantry, onNavigateStation, onOpenFishingShop, onUpgradeQuarry, onOpenHelp, onOpenMeals, isOnline, initialSector = "forest", embeddedCaves = false, activeOnly = false, onCancellationComplete }: WorldExpeditionsMenuProps) {
  const [selectedSector, setSelectedSector] = useState<SectorId>(initialSector);
  const [selectedRoute, setSelectedRoute] = useState<string | null>(null);
  const [confirmationKey, setConfirmationKey] = useState<string | null>(null);
  const previousRoute = useRef<string | null>(null);
  const previousSector = useRef(initialSector);
  const cancellationSent = useRef<string | null>(null), selectedSectorButton = useRef<HTMLButtonElement>(null), content = useRef<HTMLDivElement>(null);
  const state = economy.snapshot;
  const currentSector = embeddedCaves ? "caves" : selectedSector;
  const visibleRoute = state ? sectorRoutes(state, currentSector).find(route => route.id === selectedRoute)?.id ?? null : null;
  useEffect(() => {
    if (currentSector !== previousSector.current) selectedSectorButton.current?.focus({ preventScroll: true });
    previousSector.current = currentSector;
  }, [currentSector]);
  useEffect(() => {
    if (visibleRoute === previousRoute.current) return;
    if (visibleRoute) content.current?.querySelector<HTMLElement>("[data-route-heading]")?.focus();
    else if (previousRoute.current) {
      // Find by dataset rather than interpolating catalog IDs into CSS selectors.
      const cards = content.current?.querySelectorAll<HTMLButtonElement>("button[data-route]");
      const origin = Array.from(cards ?? []).find(card => card.dataset.route === previousRoute.current);
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
  const jobs = state?.jobs.filter(job => job.kind === "exploration") ?? [];
  const quarry = state?.jobs.find(isQuarryProduction);
  const quarryConflict = quarry && state ? economyActorConflict([quarry], "departure", economy.now) : null;
  const mineJobs = state?.jobs.filter(job => (job.kind === "construction" && job.targetId === "quarry") || isQuarryProduction(job)) ?? [];
  const mineBuilding = state?.catalog.buildings.find(building => building.id === "quarry");
  const mineLevel = state?.buildings.quarry ?? 0;
  const mineConstruction = mineJobs.find(job => job.kind === "construction");
  const nextMineLevel = mineBuilding?.levels.find(level => level.level === mineLevel + 1);
  function selectSector(id: SectorId) {
    setSelectedSector(id);
    setSelectedRoute(null);
    setConfirmationKey(null);
  }
  const retry = <button type="button" className={styles.link} disabled={economy.busy || cooldown > 0} onClick={() => { if (!economy.busy && cooldown <= 0) void economy.retry(); }}><RefreshCw size={13} aria-hidden="true" />{cooldown ? `Повторить через ${cooldown} с` : economy.uncertain ? "Проверить результат" : "Попробовать ещё раз"}</button>;
  if (activeOnly && !jobs.length) return null;
  return <div ref={content} className={styles.content} tabIndex={-1} data-embedded={embeddedCaves || undefined}>
    {!state ? <div className={styles.loading}><Compass size={18} aria-hidden="true" /><p>{economy.error ?? "Открываем маршруты…"}</p>{economy.error && retry}</div> : <>
      {!embeddedCaves && (economy.error || economy.uncertain || cooldown > 0) && <div className={styles.warning} role="alert"><p>{economy.uncertain ? "Проверяем последнее действие. Дождитесь подтверждения, прежде чем продолжать." : economy.error ?? "Подождите перед следующим действием."}</p>{retry}</div>}
      {!embeddedCaves && currentSector !== "caves" && quarryConflict && <div className={styles.warning}><p>{quarryConflict.message}</p><button type="button" className={styles.link} onClick={() => selectSector("caves")}><Mountain size={14} aria-hidden="true" />Открыть шахту<ArrowRight size={12} aria-hidden="true" /></button></div>}
      {jobs.map(job => <ActiveExpedition key={job.id} economy={economy} state={state} job={job} onOpenPantry={onOpenPantry} onOpenHelp={onOpenHelp}
        confirmationKey={confirmationKey} onConfirmation={setConfirmationKey} onCancellationSent={jobId => { cancellationSent.current = jobId; }} />)}
      {!embeddedCaves && !visibleRoute && <div className={styles.sectors} role="group" aria-label="Секторы вылазок">{expeditionSectors.map(({ id, name, icon: Icon }) => <button ref={selectedSector === id ? selectedSectorButton : undefined} type="button" key={id} data-sector-select={id} aria-pressed={selectedSector === id} onClick={() => selectSector(id)}><Icon size={16} aria-hidden="true" /><span>{name}</span></button>)}</div>}
      {!embeddedCaves && !activeOnly && currentSector === "caves" && !visibleRoute && <section className={styles.mine} aria-label="Обустройство шахты">
        <div className={styles.mineHeading}><span><Mountain size={17} aria-hidden="true" /><strong>Шахта</strong><small>{mineLevel ? `ур. ${mineLevel}` : "Не открыта"}</small></span>
          {onUpgradeQuarry && (nextMineLevel || mineConstruction) && <button type="button" className={styles.mineUpgrade} aria-haspopup="dialog" aria-label={mineConstruction ? "Ход улучшения шахты" : undefined} onClick={onUpgradeQuarry}><Hammer size={14} aria-hidden="true" />{mineConstruction ? "Стройка" : mineLevel ? "Улучшить" : "Открыть"}</button>}
          {!nextMineLevel && <small className={styles.caption}>Макс. уровень</small>}
        </div>
        {mineJobs.length > 0 && <div className={styles.mineWork}>{mineJobs.map(job => <Work key={job.id} economy={{ ...economy, snapshot: state }} job={job} openPantry={onOpenPantry} />)}</div>}
      </section>}
      {!activeOnly && <WorldExpeditionSector isOnline={isOnline} onOpenMeals={onOpenMeals} sectorId={currentSector} selectedRoute={visibleRoute} onSelectRoute={setSelectedRoute} state={state} economy={economy} exploring={jobs.length > 0} onOpenPantry={onOpenPantry} onNavigateStation={onNavigateStation} onOpenFishingShop={onOpenFishingShop} onUpgradeQuarry={onUpgradeQuarry} onOpenHelp={onOpenHelp} />}
    </>}
  </div>;
}
