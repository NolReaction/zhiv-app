"use client";

import { useEffect, useId, useRef, useState } from "react";
import { ArrowRight, Check, ChevronDown, Clock3, Compass, Fish, LockKeyhole, Mountain, Package, RefreshCw, Trees, type LucideIcon } from "lucide-react";
import { ItemIcon } from "@/features/items/item-icon";
import { FishingRodIcon } from "@/features/world/fishing-rod-icon";
import type { EconomyJob, EconomyView } from "./model";
import type { EconomyController } from "./use-economy";
import { ProductIcon, itemName, locked, number, stationName } from "./world-economy-parts";
import { worldCostShortfalls, worldDuration, worldJobProgress, worldMissingRequirements, worldRequirements } from "./world-stations";
import { fishingState, fishingTripCost } from "./fishing";
import { useFishingCommand } from "./use-fishing-command";
import styles from "./world-expeditions-menu.module.css";

export type WorldExpeditionsMenuProps = {
  economy: EconomyController;
  onOpenPantry: () => void;
  onNavigateStation?: (stationId: string) => void;
  onOpenFishingShop?: () => void;
  initialSector?: SectorId;
};
type Route = EconomyView["catalog"]["explorations"][number];
export type SectorId = "forest" | "shore" | "caves";
export const expeditionSectors: ReadonlyArray<{ id: SectorId; name: string; icon: LucideIcon }> = [
  { id: "forest", name: "Лес", icon: Trees },
  { id: "shore", name: "Побережье", icon: Fish },
  { id: "caves", name: "Пещеры", icon: Mountain },
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

function Findings({ state, rewards, compact = false, mixedFish = false }: { state: EconomyView; rewards: Record<string, number>; compact?: boolean; mixedFish?: boolean }) {
  return <span className={styles.findings} data-compact={compact || undefined} role="list" aria-label="Находки">{Object.entries(rewards).map(([id, quantity]) => {
    const name = mixedFish && id === "fish" ? "Рыбный улов" : itemName(state, id);
    return <span role="listitem" key={id} title={name}><ProductIcon itemId={id} size={18} /><span className={styles.resourceName}>{name}</span><strong>×{number(quantity)}</strong></span>;
  })}</span>;
}

/** Confirmation belongs to this owner and the exact saved job, not a route or
 * a timer tick. An updated/replaced job needs another deliberate approval. */
export function expeditionCancellationKey(owner: string, job: EconomyJob) {
  const entries = (value: Record<string, number>) => Object.entries(value).sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify([owner, job.id, job.kind, job.targetId, job.recipeId, job.targetLevel, job.startedAt, job.finishesAt,
    entries(job.rewards), job.cost.coins, entries(job.cost.items), job.catalogVersion, job.collection ?? null, job.fishing ?? null]);
}

export function ActiveExpedition({ economy, state, job, onOpenPantry, confirmationKey, onConfirmation, onCancellationSent }: Pick<WorldExpeditionsMenuProps, "economy" | "onOpenPantry"> & {
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

export function ExpeditionRouteDetails({ route, state, economy, exploring, onOpenPantry, onNavigateStation, onOpenFishingShop }: WorldExpeditionsMenuProps & { route: Route; state: EconomyView; exploring: boolean }) {
  const id = useId();
  const command = useFishingCommand({ economy, state });
  const missing = worldMissingRequirements(state, worldRequirements(route));
  const fishing = isFishingRoute(state, route), gear = fishingState(state), cost = expeditionCost(state, route);
  const shortfalls = worldCostShortfalls(state, cost);
  const findings = countRewards(route.rewards);
  const tooLarge = findings > state.storage.capacity;
  const collecting = state.jobs.some(job => job.collection?.startedAt);
  const catalog = state.catalog.fishing;
  const rods = catalog?.rods.filter(rod => gear.ownedRods.includes(rod.id)) ?? [];
  const hooks = catalog?.hooks.filter(hook => gear.ownedHooks.includes(hook.id)) ?? [];
  const invalidGear = fishing && (!rods.some(rod => rod.id === gear.equippedRodId) || !hooks.some(hook => hook.id === gear.equippedHookId)
    || Boolean(gear.equippedBaitId && !catalog?.baits.some(bait => bait.itemId === gear.equippedBaitId)));
  const blocked = missing.length > 0 || shortfalls.length > 0 || tooLarge || exploring || collecting || invalidGear;
  return <div className={styles.detail}>
    {fishing && <div className={styles.fishingGear}>
      <strong>С собой на рыбалку</strong>
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
      <p>{gear.equippedBaitId ? "1 наживка на вылазку. " : ""}Удочка и крючок не расходуются. Снасти меняют шанс одного особого улова, остальные рыбы — обычная рыба.</p>
      {invalidGear && <p className={styles.warning}>Выберите доступную удочку и крючок перед отправлением.</p>}
      {onOpenFishingShop && <button type="button" className={styles.link} onClick={onOpenFishingShop}>Купить снасти у Плёски<ArrowRight size={12} aria-hidden="true" /></button>}
    </div>}
    {missing.length > 0 && <ul className={styles.requirements} aria-label="Условия открытия">{missing.map(({ id, level }) => <li key={id}><LockKeyhole size={12} aria-hidden="true" />{onNavigateStation ? <button type="button" className={styles.link} onClick={() => onNavigateStation(id)}>{stationName(state, id)} · нужен ур. {level}<ArrowRight size={12} aria-hidden="true" /></button> : <span>{stationName(state, id)} · нужен ур. {level}</span>}</li>)}</ul>}
    {cost.coins > 0 || Object.keys(cost.items).length > 0 ? <div className={styles.provisions}><span className={styles.caption}>С собой</span><ul aria-label="Припасы для вылазки">{cost.coins > 0 && <li data-missing={state.wallet.coins < cost.coins || undefined}><ItemIcon itemId="coins" size={16} /><span>Монеты</span><strong>{number(state.wallet.coins)} / {number(cost.coins)}</strong></li>}{Object.entries(cost.items).map(([id, quantity]) => <li key={id} data-missing={(state.inventory[id] ?? 0) < quantity || undefined}><ProductIcon itemId={id} size={18} /><span>{itemName(state, id)}</span><strong>{number(state.inventory[id] ?? 0)} / {number(quantity)}</strong></li>)}</ul></div> : <p className={styles.free}><Check size={12} aria-hidden="true" />Без затрат</p>}
    {tooLarge ? <div className={styles.warning}><p>Находки займут {number(findings)} мест, вместимость — {number(state.storage.capacity)}.</p><button type="button" className={styles.link} onClick={onNavigateStation ? () => onNavigateStation("warehouse") : onOpenPantry}>Расширить кладовую<ArrowRight size={12} aria-hidden="true" /></button></div> : state.storage.available < findings && <button type="button" className={styles.storageHint} onClick={onOpenPantry}><Package size={13} aria-hidden="true" /><span>К возвращению нужно {number(findings)} мест · свободно {number(state.storage.available)}</span><ArrowRight size={12} aria-hidden="true" /></button>}
    {collecting && <p className={styles.caption}>Мохлик собирает урожай. Сначала дождитесь доставки в кладовую.</p>}
    {exploring ? <p className={styles.caption}>Сначала заберите находки или отмените текущую вылазку.</p> : <div className={styles.actions}>{shortfalls.length > 0 && <span className={styles.warning}>Не хватает припасов</span>}<button type="button" className={styles.primary} disabled={blocked || command.blocked} onClick={() => command.send(fishing ? "start_fishing" : "start_exploration", route.id, 1, 0, !blocked)} aria-label={`Отправиться: ${route.name}`}>Отправиться · {worldDuration(route.seconds)}<ArrowRight size={13} aria-hidden="true" /></button></div>}
  </div>;
}

export function WorldExpeditionSector({ sectorId, selectedRoute, onSelectRoute, economy, state, exploring, onOpenPantry, onNavigateStation, onOpenFishingShop }: WorldExpeditionsMenuProps & { sectorId: SectorId; selectedRoute: string | null; onSelectRoute: (id: string) => void; state: EconomyView; exploring: boolean }) {
  const routes = state.catalog.explorations.filter(route => expeditionSector(route.id) === sectorId);
  const readyRoutes = routes.filter(route => canPrepare(state, route));
  const laterRoutes = routes.filter(route => !canPrepare(state, route));
  const sector = expeditionSectors.find(entry => entry.id === sectorId)!;
  return <section className={styles.routes} aria-label={`Маршруты: ${sector.name}`} data-sector={sectorId}>
    {[{ key: "ready", label: exploring ? "Маршруты сектора" : "Можно отправиться", routes: readyRoutes }, { key: "later", label: "Нужно подготовиться", routes: laterRoutes }].filter(group => group.routes.length > 0).map(group => <div className={styles.routeGroup} key={group.key}>
      <p className={styles.groupTitle}>{group.label}<span>{group.routes.length}</span></p>
      {group.routes.map(route => {
        const missing = worldMissingRequirements(state, worldRequirements(route));
        const tooLarge = countRewards(route.rewards) > state.storage.capacity;
        const needsProvisions = worldCostShortfalls(state, expeditionCost(state, route)).length > 0;
        const Icon = routeIcon(route.id);
        const unavailable = missing.length > 0 || tooLarge || needsProvisions;
        const reason = missing.length ? `${stationName(state, missing[0].id)} · ур. ${missing[0].level}${missing.length > 1 ? ` +${missing.length - 1}` : ""}` : tooLarge ? "Расширьте кладовую" : needsProvisions ? "Нужны припасы" : null;
        return <details key={route.id} className={styles.route} open={selectedRoute === route.id} data-route={route.id} data-locked={unavailable || undefined}>
          <summary onClick={event => { event.preventDefault(); onSelectRoute(route.id); }}><span className={styles.routeIcon}><Icon size={19} aria-hidden="true" /></span><span className={styles.routeText}><strong>{routeName(route.name)}</strong>{reason && <small><LockKeyhole size={10} aria-hidden="true" />{reason}</small>}</span><span className={styles.routeDuration}><Clock3 size={10} aria-hidden="true" />{worldDuration(route.seconds)}</span><ChevronDown className={styles.chevron} size={13} aria-hidden="true" /><span className={styles.routeFindings}><Findings state={state} rewards={route.rewards} compact={selectedRoute !== route.id} mixedFish={isFishingRoute(state, route)} /></span></summary>
          <ExpeditionRouteDetails route={route} state={state} economy={economy} exploring={exploring} onOpenPantry={onOpenPantry} onNavigateStation={onNavigateStation} onOpenFishingShop={onOpenFishingShop} />
        </details>;
      })}
    </div>)}
    {!routes.length && <p className={styles.intro}>Маршруты пока недоступны.</p>}
  </section>;
}

export function WorldExpeditionsMenu({ economy, onOpenPantry, onNavigateStation, onOpenFishingShop, initialSector = "forest" }: WorldExpeditionsMenuProps) {
  const [selectedSector, setSelectedSector] = useState<SectorId>(initialSector);
  const [selectedRoute, setSelectedRoute] = useState<string | null>(null);
  const [confirmationKey, setConfirmationKey] = useState<string | null>(null);
  const cancellationSent = useRef<string | null>(null), selectedSectorButton = useRef<HTMLButtonElement>(null);
  const state = economy.snapshot;
  useEffect(() => {
    if (!state || !cancellationSent.current || state.jobs.some(job => job.id === cancellationSent.current)) return;
    cancellationSent.current = null;
    if (document.activeElement === document.body) selectedSectorButton.current?.focus({ preventScroll: true });
  }, [state]);
  const cooldown = Math.max(0, Math.ceil((economy.retryAt - economy.now) / 1000));
  const jobs = state?.jobs.filter(job => job.kind === "exploration") ?? [];
  const retry = <button type="button" className={styles.link} disabled={economy.busy || cooldown > 0} onClick={() => { if (!economy.busy && cooldown <= 0) void economy.retry(); }}><RefreshCw size={13} aria-hidden="true" />{cooldown ? `Повторить через ${cooldown} с` : economy.uncertain ? "Проверить результат" : "Попробовать ещё раз"}</button>;
  return <div className={styles.content}>
    {!state ? <div className={styles.loading}><Compass size={18} aria-hidden="true" /><p>{economy.error ?? "Открываем маршруты…"}</p>{economy.error && retry}</div> : <>
      {(economy.error || economy.uncertain || cooldown > 0) && <div className={styles.warning} role="alert"><p>{economy.uncertain ? "Проверяем последнее действие. Дождитесь подтверждения, прежде чем продолжать." : economy.error ?? "Подождите перед следующим действием."}</p>{retry}</div>}
      {jobs.map(job => <ActiveExpedition key={job.id} economy={economy} state={state} job={job} onOpenPantry={onOpenPantry}
        confirmationKey={confirmationKey} onConfirmation={setConfirmationKey} onCancellationSent={jobId => { cancellationSent.current = jobId; }} />)}
      <div className={styles.sectors} role="group" aria-label="Секторы вылазок">{expeditionSectors.map(({ id, name, icon: Icon }) => <button ref={selectedSector === id ? selectedSectorButton : undefined} type="button" key={id} data-sector-select={id} aria-pressed={selectedSector === id} onClick={() => { setSelectedSector(id); setSelectedRoute(null); setConfirmationKey(null); }}><Icon size={21} aria-hidden="true" /><span>{name}</span></button>)}</div>
      <WorldExpeditionSector sectorId={selectedSector} selectedRoute={selectedRoute} onSelectRoute={id => setSelectedRoute(value => value === id ? null : id)} state={state} economy={economy} exploring={jobs.length > 0} onOpenPantry={onOpenPantry} onNavigateStation={onNavigateStation} onOpenFishingShop={onOpenFishingShop} />
    </>}
  </div>;
}
