"use client";

import { Apple, ArrowRight, Blocks, Box, BrickWall, Cable, Check, CircleDot, Clock3, Cog, Coins, Combine, CookingPot, Droplets, Fish, Flame, Gem, Hammer, House, Hourglass, Layers, LockKeyhole, Logs, Package, Pickaxe, RectangleHorizontal, Shirt, Sprout, SquareStack, Trees, Wheat, Wrench, type LucideIcon } from "lucide-react";
import type { EconomyCost, EconomyJob, EconomyView } from "./model";
import type { EconomyController } from "./use-economy";
import { worldDuration, worldJobProgress, worldMaterialSource, worldMissingRequirements } from "./world-stations";
import styles from "./world-object-menu.module.css";

export type ReadyEconomy = EconomyController & { snapshot: EconomyView };
export type StationNavigation = { open: (id: string) => void; canOpen: (id: string) => boolean; explore?: () => void };
export const number = (value: number) => value.toLocaleString("ru-RU");
const itemIcons: Record<string, LucideIcon> = { berries: Apple, wood: Logs, stone: CircleDot, ore: Pickaxe, fiber: Wheat, fish: Fish, planks: Layers, rope: Cable, metal_parts: Cog, dried_berries: Apple, smoked_fish: Fish, clay: CookingPot, sand: Hourglass, charcoal: Flame, iron_ingot: RectangleHorizontal, bricks: BrickWall, glass: Gem, hardwood: Trees, resin: Droplets, cloth: Shirt, beams: Blocks, tools: Wrench, reinforced_parts: Combine, cut_stone: SquareStack };
export const stationIcons: Record<string, LucideIcon> = { home: House, warehouse: Package, garden: Sprout, dryer: CookingPot, workshop: Hammer, kiln: Flame, quarry: Pickaxe, woodlot: Trees };
export const itemName = (state: EconomyView, id: string) => state.catalog.items.find(item => item.id === id)?.name ?? id;
export const stationName = (state: EconomyView, id: string) => state.catalog.buildings.find(building => building.id === id)?.name ?? id;
export const locked = (economy: EconomyController) => economy.busy || economy.uncertain || economy.retryAt > economy.now;

export function ProductIcon({ itemId, size = 24 }: { itemId: string; size?: number }) {
  const Icon = itemIcons[itemId] ?? Box;
  return <Icon size={size} strokeWidth={1.8} aria-hidden="true" />;
}
export function Rewards({ state, rewards, quantity = 1 }: { state: EconomyView; rewards: Record<string, number>; quantity?: number }) {
  return <ul className={styles.rewards} aria-label="Результат">{Object.entries(rewards).map(([id, amount]) => <li key={id}><ProductIcon itemId={id} size={16} /><span>{itemName(state, id)}</span><strong>×{number(amount * quantity)}</strong></li>)}</ul>;
}
export function Cost({ state, cost, quantity = 1, navigation }: { state: EconomyView; cost: EconomyCost; quantity?: number; navigation?: StationNavigation }) {
  if (!cost.coins && !Object.keys(cost.items).length) return <p className={styles.free}><Sprout size={13} aria-hidden="true" />Без затрат</p>;
  return <ul className={styles.cost} aria-label="Стоимость">{cost.coins > 0 && <li data-missing={state.wallet.coins < cost.coins * quantity || undefined}><Coins size={14} aria-hidden="true" /><span>Монеты</span><strong>{number(state.wallet.coins)} / {number(cost.coins * quantity)}</strong></li>}{Object.entries(cost.items).map(([id, amount]) => {
    const missing = (state.inventory[id] ?? 0) < amount * quantity;
    const source = missing ? worldMaterialSource(state, id) : null;
    const openSource = source?.kind === "production" && navigation?.canOpen(source.stationId) ? () => navigation.open(source.stationId) : source?.kind === "exploration" ? navigation?.explore : undefined;
    return <li key={id} data-missing={missing || undefined}><ProductIcon itemId={id} size={14} /><span>{openSource ? <button type="button" className={styles.textButton} aria-label={`Где получить: ${itemName(state, id)}${source?.kind === "exploration" ? ", В путь" : ""}`} onClick={openSource}>{itemName(state, id)}<ArrowRight size={11} aria-hidden="true" /></button> : itemName(state, id)}</span><strong>{number(state.inventory[id] ?? 0)} / {number(amount * quantity)}</strong></li>;
  })}</ul>;
}
export function Requirements({ state, required, navigation }: { state: EconomyView; required: Record<string, number>; navigation?: StationNavigation }) {
  const missing = worldMissingRequirements(state, required);
  if (!missing.length) return null;
  return <ul className={styles.requirements} aria-label="Недостающие условия">{missing.map(({ id, level, current }) => <li key={id}><LockKeyhole size={13} aria-hidden="true" />{navigation?.canOpen(id) ? <button type="button" onClick={() => navigation.open(id)}>{stationName(state, id)} <span>{current}/{level}</span><ArrowRight size={12} aria-hidden="true" /></button> : <span>{stationName(state, id)} · нужен ур. {level} (сейчас {current})</span>}</li>)}</ul>;
}

export function Work({ economy, job, openPantry }: { economy: ReadyEconomy; job: EconomyJob; openPantry?: () => void }) {
  const status = worldJobProgress(economy.snapshot, job, economy.now);
  const title = job.kind === "construction" ? `Обустройство · ур. ${job.targetLevel}` : economy.snapshot.catalog.recipes.find(recipe => recipe.id === job.recipeId)?.name ?? "Производство";
  const itemId = Object.keys(job.rewards)[0];
  return <div className={styles.work} data-ready={status.ready || undefined}>
    <div className={styles.workTop}><span className={styles.workIcon}>{job.kind === "construction" ? <Hammer size={21} aria-hidden="true" /> : <ProductIcon itemId={itemId ?? ""} size={22} />}</span><div><strong>{title}</strong><span>{status.ready ? "Готово к получению" : `Осталось ${status.seconds < 60 ? `${status.seconds} с` : worldDuration(status.seconds)}`}</span></div><button type="button" className={styles.claim} disabled={locked(economy) || !status.ready || status.storageShortfall > 0} onClick={() => void economy.act("claim_job", job.id)} aria-label={`${job.kind === "construction" ? "Завершить" : "Забрать"}: ${title}`}>{status.ready ? <Check size={15} aria-hidden="true" /> : <Clock3 size={15} aria-hidden="true" />}{status.ready ? job.kind === "construction" ? "Завершить" : "Забрать" : "В работе"}</button></div>
    <progress className={styles.progress} value={status.progress} max={1} aria-label={`Готовность: ${title}`} />
    {status.storageShortfall > 0 && status.ready && <p className={styles.hint}>Нужно освободить {number(status.storageShortfall)} мест.{openPantry && <button type="button" className={styles.textButton} onClick={openPantry}>К кладовой<ArrowRight size={12} aria-hidden="true" /></button>}</p>}
  </div>;
}
