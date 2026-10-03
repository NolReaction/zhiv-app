"use client";

import { useState } from "react";
import { ArrowRight, Check, ChevronDown, Clock3, Coins, Compass, Fish, LockKeyhole, Mountain, Package, RefreshCw, Trees, type LucideIcon } from "lucide-react";
import type { EconomyJob, EconomyView } from "./model";
import type { EconomyController } from "./use-economy";
import { ProductIcon, itemName, locked, number, stationName } from "./world-economy-parts";
import { worldCostShortfalls, worldDuration, worldJobProgress, worldMissingRequirements, worldRequirements } from "./world-stations";
import styles from "./world-expeditions-menu.module.css";

export type WorldExpeditionsMenuProps = {
  economy: EconomyController;
  onOpenPantry: () => void;
  onNavigateStation?: (stationId: string) => void;
};
type Route = EconomyView["catalog"]["explorations"][number];
type SectorId = "forest" | "shore" | "caves";
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
const canPrepare = (state: EconomyView, route: Route) => worldMissingRequirements(state, worldRequirements(route)).length === 0 && countRewards(route.rewards) <= state.storage.capacity && worldCostShortfalls(state, route.cost).length === 0;

function Findings({ state, rewards, compact = false }: { state: EconomyView; rewards: Record<string, number>; compact?: boolean }) {
  return <span className={styles.findings} data-compact={compact || undefined} role="list" aria-label="Находки">{Object.entries(rewards).map(([id, quantity]) => <span role="listitem" key={id} title={itemName(state, id)}><ProductIcon itemId={id} size={15} /><span className={styles.resourceName}>{itemName(state, id)}</span><strong>×{number(quantity)}</strong></span>)}</span>;
}

function ActiveExpedition({ economy, state, job, onOpenPantry }: Pick<WorldExpeditionsMenuProps, "economy" | "onOpenPantry"> & { state: EconomyView; job: EconomyJob }) {
  const route = state.catalog.explorations.find(entry => entry.id === job.targetId);
  const title = routeName(route?.name ?? "Вылазка Мохлика");
  const status = worldJobProgress(state, job, economy.now);
  return <section className={styles.active} aria-label={`Текущая вылазка: ${title}`} data-ready={status.ready || undefined}>
    <div className={styles.activeTitle}><Compass size={18} aria-hidden="true" /><div><span>{status.ready ? "Мохлик вернулся" : "Мохлик в пути"}</span><strong>{title}</strong></div></div>
    <Findings state={state} rewards={job.rewards} />
    <progress className={styles.progress} value={status.progress} max={1} aria-label={`Готовность вылазки: ${title}`} />
    <div className={styles.actions}><span className={styles.time}>{status.ready ? <Check size={13} aria-hidden="true" /> : <Clock3 size={13} aria-hidden="true" />}{status.ready ? "Находки ждут" : `Ещё ${status.seconds < 60 ? `${status.seconds} с` : worldDuration(status.seconds)}`}</span><button type="button" className={styles.primary} disabled={!status.ready || status.storageShortfall > 0 || locked(economy)} onClick={() => void economy.act("claim_job", job.id)} aria-label={`Забрать находки: ${title}`}>Забрать</button></div>
    {status.ready && status.storageShortfall > 0 && <div className={styles.warning}><p>Нужно освободить {number(status.storageShortfall)} мест. Находки сохранятся до получения.</p><button type="button" className={styles.link} onClick={onOpenPantry}><Package size={13} aria-hidden="true" />Открыть кладовую<ArrowRight size={12} aria-hidden="true" /></button></div>}
  </section>;
}

function RouteDetails({ route, state, economy, exploring, onOpenPantry, onNavigateStation }: WorldExpeditionsMenuProps & { route: Route; state: EconomyView; exploring: boolean }) {
  const missing = worldMissingRequirements(state, worldRequirements(route));
  const shortfalls = worldCostShortfalls(state, route.cost);
  const findings = countRewards(route.rewards);
  const tooLarge = findings > state.storage.capacity;
  const blocked = missing.length > 0 || shortfalls.length > 0 || tooLarge || exploring;
  return <div className={styles.detail}>
    {missing.length > 0 && <ul className={styles.requirements} aria-label="Условия открытия">{missing.map(({ id, level }) => <li key={id}><LockKeyhole size={12} aria-hidden="true" />{onNavigateStation ? <button type="button" className={styles.link} onClick={() => onNavigateStation(id)}>{stationName(state, id)} · нужен ур. {level}<ArrowRight size={12} aria-hidden="true" /></button> : <span>{stationName(state, id)} · нужен ур. {level}</span>}</li>)}</ul>}
    {route.cost.coins > 0 || Object.keys(route.cost.items).length > 0 ? <div className={styles.provisions}><span className={styles.caption}>С собой</span><ul aria-label="Припасы для вылазки">{route.cost.coins > 0 && <li data-missing={state.wallet.coins < route.cost.coins || undefined}><Coins size={15} aria-hidden="true" /><span>Монеты</span><strong>{number(state.wallet.coins)} / {number(route.cost.coins)}</strong></li>}{Object.entries(route.cost.items).map(([id, quantity]) => <li key={id} data-missing={(state.inventory[id] ?? 0) < quantity || undefined}><ProductIcon itemId={id} size={15} /><span>{itemName(state, id)}</span><strong>{number(state.inventory[id] ?? 0)} / {number(quantity)}</strong></li>)}</ul></div> : <p className={styles.free}><Check size={12} aria-hidden="true" />Без затрат</p>}
    {tooLarge ? <div className={styles.warning}><p>Находки займут {number(findings)} мест, вместимость — {number(state.storage.capacity)}.</p><button type="button" className={styles.link} onClick={onNavigateStation ? () => onNavigateStation("warehouse") : onOpenPantry}>Расширить кладовую<ArrowRight size={12} aria-hidden="true" /></button></div> : state.storage.available < findings && <button type="button" className={styles.storageHint} onClick={onOpenPantry}><Package size={13} aria-hidden="true" /><span>К возвращению нужно {number(findings)} мест · свободно {number(state.storage.available)}</span><ArrowRight size={12} aria-hidden="true" /></button>}
    {exploring ? <p className={styles.caption}>Следующая вылазка — после получения находок.</p> : <div className={styles.actions}>{shortfalls.length > 0 && <span className={styles.warning}>Не хватает припасов</span>}<button type="button" className={styles.primary} disabled={blocked || locked(economy)} onClick={() => void economy.act("start_exploration", route.id)} aria-label={`Отправиться: ${route.name}`}>Отправиться · {worldDuration(route.seconds)}<ArrowRight size={13} aria-hidden="true" /></button></div>}
  </div>;
}

export function WorldExpeditionSector({ sectorId, selectedRoute, onSelectRoute, economy, state, exploring, onOpenPantry, onNavigateStation }: WorldExpeditionsMenuProps & { sectorId: SectorId; selectedRoute: string | null; onSelectRoute: (id: string) => void; state: EconomyView; exploring: boolean }) {
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
        const needsProvisions = worldCostShortfalls(state, route.cost).length > 0;
        const Icon = routeIcon(route.id);
        const unavailable = missing.length > 0 || tooLarge || needsProvisions;
        const reason = missing.length ? `${stationName(state, missing[0].id)} · ур. ${missing[0].level}${missing.length > 1 ? ` +${missing.length - 1}` : ""}` : tooLarge ? "Расширьте кладовую" : needsProvisions ? "Нужны припасы" : null;
        return <details key={route.id} className={styles.route} open={selectedRoute === route.id} data-route={route.id} data-locked={unavailable || undefined}>
          <summary onClick={event => { event.preventDefault(); onSelectRoute(route.id); }}><span className={styles.routeIcon}><Icon size={19} aria-hidden="true" /></span><span className={styles.routeText}><strong>{routeName(route.name)}</strong>{reason && <small><LockKeyhole size={10} aria-hidden="true" />{reason}</small>}</span><span className={styles.routeDuration}><Clock3 size={10} aria-hidden="true" />{worldDuration(route.seconds)}</span><ChevronDown className={styles.chevron} size={13} aria-hidden="true" /><span className={styles.routeFindings}><Findings state={state} rewards={route.rewards} compact={selectedRoute !== route.id} /></span></summary>
          <RouteDetails route={route} state={state} economy={economy} exploring={exploring} onOpenPantry={onOpenPantry} onNavigateStation={onNavigateStation} />
        </details>;
      })}
    </div>)}
    {!routes.length && <p className={styles.intro}>Маршруты пока недоступны.</p>}
  </section>;
}

export function WorldExpeditionsMenu({ economy, onOpenPantry, onNavigateStation }: WorldExpeditionsMenuProps) {
  const [selectedSector, setSelectedSector] = useState<SectorId>("forest");
  const [selectedRoute, setSelectedRoute] = useState<string | null>(null);
  const state = economy.snapshot;
  const cooldown = Math.max(0, Math.ceil((economy.retryAt - economy.now) / 1000));
  const jobs = state?.jobs.filter(job => job.kind === "exploration") ?? [];
  const retry = <button type="button" className={styles.link} disabled={economy.busy || cooldown > 0} onClick={() => void economy.retry()}><RefreshCw size={13} aria-hidden="true" />{cooldown ? `Повторить через ${cooldown} с` : economy.uncertain ? "Проверить результат" : "Попробовать ещё раз"}</button>;
  return <div className={styles.content}>
    {!state ? <div className={styles.loading}><Compass size={18} aria-hidden="true" /><p>{economy.error ?? "Открываем маршруты…"}</p>{economy.error && retry}</div> : <>
      {(economy.error || economy.uncertain || cooldown > 0) && <div className={styles.warning} role="alert"><p>{economy.uncertain ? "Проверяем последнее действие. Новая вылазка доступна после подтверждения." : economy.error ?? "Подождите перед следующим действием."}</p>{retry}</div>}
      {jobs.map(job => <ActiveExpedition key={job.id} economy={economy} state={state} job={job} onOpenPantry={onOpenPantry} />)}
      <div className={styles.sectors} role="group" aria-label="Секторы вылазок">{expeditionSectors.map(({ id, name, icon: Icon }) => <button type="button" key={id} data-sector-select={id} aria-pressed={selectedSector === id} onClick={() => { setSelectedSector(id); setSelectedRoute(null); }}><Icon size={21} aria-hidden="true" /><span>{name}</span></button>)}</div>
      <WorldExpeditionSector sectorId={selectedSector} selectedRoute={selectedRoute} onSelectRoute={id => setSelectedRoute(value => value === id ? null : id)} state={state} economy={economy} exploring={jobs.length > 0} onOpenPantry={onOpenPantry} onNavigateStation={onNavigateStation} />
    </>}
  </div>;
}
