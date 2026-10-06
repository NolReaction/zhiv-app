"use client";

import { ArrowRight, Check, Clock3, CookingPot, Flame, Hammer, House, LockKeyhole, Package, Pickaxe, Sprout, Trees, type LucideIcon } from "lucide-react";
import { ItemIcon } from "@/features/items/item-icon";
import { PlayerItemIcon } from "./fish-discovery";
import type { EconomyCost, EconomyJob, EconomyView } from "./model";
import type { EconomyController } from "./use-economy";
import { worldDuration, worldJobProgress, worldMaterialSource, worldMissingRequirements } from "./world-stations";
import { useGardenCollection } from "./garden-collection-context";
import { berryCollectionStatus } from "./garden-collection";
import { ProductionActivity, productionIsActive } from "./production-activity";
import styles from "./world-object-menu.module.css";

export type ReadyEconomy = EconomyController & { snapshot: EconomyView };
export type StationNavigation = { open: (id: string) => void; canOpen: (id: string) => boolean; explore?: () => void };
export const number = (value: number) => value.toLocaleString("ru-RU");
export const stationIcons: Record<string, LucideIcon> = { home: House, warehouse: Package, garden: Sprout, dryer: CookingPot, workshop: Hammer, kiln: Flame, quarry: Pickaxe, woodlot: Trees };
export const itemName = (state: EconomyView, id: string) => state.catalog.items.find(item => item.id === id)?.name ?? id;
export const stationName = (state: EconomyView, id: string) => state.catalog.buildings.find(building => building.id === id)?.name ?? id;
export const locked = (economy: EconomyController) => economy.busy || economy.uncertain || economy.retryAt > economy.now;

export function ProductIcon({ itemId, size = 24, state }: { itemId: string; size?: number; state?: EconomyView | null }) {
  return <PlayerItemIcon state={state} itemId={itemId} size={size} />;
}
export function Rewards({ state, rewards, quantity = 1 }: { state: EconomyView; rewards: Record<string, number>; quantity?: number }) {
  return <ul className={styles.rewards} aria-label="Результат">{Object.entries(rewards).map(([id, amount]) => <li key={id}><ProductIcon state={state} itemId={id} size={16} /><span>{itemName(state, id)}</span><strong>×{number(amount * quantity)}</strong></li>)}</ul>;
}
export function Cost({ state, cost, quantity = 1, navigation }: { state: EconomyView; cost: EconomyCost; quantity?: number; navigation?: StationNavigation }) {
  if (!cost.coins && !Object.keys(cost.items).length) return <p className={styles.free}><Sprout size={13} aria-hidden="true" />Без затрат</p>;
  return <ul className={styles.cost} aria-label="Стоимость">{cost.coins > 0 && <li data-missing={state.wallet.coins < cost.coins * quantity || undefined}><ItemIcon itemId="coins" size={18} /><span>Монеты</span><strong>{number(state.wallet.coins)} / {number(cost.coins * quantity)}</strong></li>}{Object.entries(cost.items).map(([id, amount]) => {
    const missing = (state.inventory[id] ?? 0) < amount * quantity;
    const source = missing ? worldMaterialSource(state, id) : null;
    const openSource = source?.kind === "production" && navigation?.canOpen(source.stationId) ? () => navigation.open(source.stationId) : source?.kind === "exploration" ? navigation?.explore : undefined;
    return <li key={id} data-missing={missing || undefined}><ProductIcon state={state} itemId={id} size={18} /><span>{openSource ? <button type="button" className={styles.textButton} aria-label={`Где получить: ${itemName(state, id)}${source?.kind === "exploration" ? ", В путь" : ""}`} onClick={openSource}>{itemName(state, id)}<ArrowRight size={11} aria-hidden="true" /></button> : itemName(state, id)}</span><strong>{number(state.inventory[id] ?? 0)} / {number(amount * quantity)}</strong></li>;
  })}</ul>;
}
export function Requirements({ state, required, navigation }: { state: EconomyView; required: Record<string, number>; navigation?: StationNavigation }) {
  const missing = worldMissingRequirements(state, required);
  if (!missing.length) return null;
  return <ul className={styles.requirements} aria-label="Недостающие условия">{missing.map(({ id, level, current }) => <li key={id}><LockKeyhole size={13} aria-hidden="true" />{navigation?.canOpen(id) ? <button type="button" onClick={() => navigation.open(id)}>{stationName(state, id)} <span>{current}/{level}</span><ArrowRight size={12} aria-hidden="true" /></button> : <span>{stationName(state, id)} · нужен ур. {level} (сейчас {current})</span>}</li>)}</ul>;
}

export function Work({ economy, job, openPantry }: { economy: ReadyEconomy; job: EconomyJob; openPantry?: () => void }) {
  const collection = useGardenCollection();
  const berry = berryCollectionStatus(job, economy.snapshot, economy.now, collection);
  const status = worldJobProgress(economy.snapshot, job, economy.now);
  const title = job.kind === "construction" ? `Обустройство · ур. ${job.targetLevel}` : economy.snapshot.catalog.recipes.find(recipe => recipe.id === job.recipeId)?.name ?? "Производство";
  const itemId = Object.keys(job.rewards)[0];
  const working = productionIsActive(job, economy.now);
  return <div className={styles.work} data-job-id={job.id} data-ready={status.ready || undefined}>
    <div className={styles.workTop}><span className={styles.workIcon} data-working={working || undefined}>{working ? <ProductionActivity job={job} now={economy.now} /> : job.kind === "construction" ? <Hammer size={21} aria-hidden="true" /> : <ProductIcon state={economy.snapshot} itemId={itemId ?? ""} size={22} />}</span><div><strong>{title}</strong><span>{berry && !berry.growing ? berry.label : status.ready ? "Готово к получению" : `Осталось ${status.seconds < 60 ? `${status.seconds} с` : worldDuration(status.seconds)}`}</span></div><button type="button" className={styles.claim} disabled={locked(economy) || !status.ready || status.storageShortfall > 0 || berry?.disabled} onClick={() => {
      if (locked(economy) || !status.ready || status.storageShortfall > 0 || berry?.disabled) return;
      if (berry && collection) collection.start(job.id);
      else economy.act(berry && !berry.started ? "start_collection" : "claim_job", job.id);
    }} aria-label={`${berry?.button ?? (job.kind === "construction" ? "Завершить" : "Забрать")}: ${title}`}>{status.ready && !berry?.collecting ? <Check size={15} aria-hidden="true" /> : <Clock3 size={15} aria-hidden="true" />}{berry?.button ?? (status.ready ? job.kind === "construction" ? "Завершить" : "Забрать" : "В работе")}</button></div>
    <progress className={styles.progress} value={berry?.collecting ? undefined : status.progress} max={1} aria-label={berry?.collecting ? "Сбор урожая" : `Готовность: ${title}`} />
    {berry?.away && status.ready && <p className={styles.hint}>{berry.awayReason}</p>}
    {status.storageShortfall > 0 && status.ready && <p className={styles.hint}>Нужно освободить {number(status.storageShortfall)} мест.{openPantry && <button type="button" className={styles.textButton} onClick={openPantry}>К кладовой<ArrowRight size={12} aria-hidden="true" /></button>}</p>}
  </div>;
}
