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
const countRewards = (rewards: Record<string, number>) => Object.values(rewards).reduce((sum, count) => sum + count, 0);
const routeName = (name: string) => name.replace(/ · \d+ ч$/, "");
const routeIcon = (id: string): LucideIcon => id.includes("cave") || id.includes("quarry") || id === "uplands" ? Mountain : id.includes("shore") || id.includes("coastal") ? Fish : Trees;

function Findings({ state, rewards }: { state: EconomyView; rewards: Record<string, number> }) {
  return <ul className={styles.findings} aria-label="Находки">{Object.entries(rewards).map(([id, quantity]) => <li key={id}><ProductIcon itemId={id} size={14} /><span>{itemName(state, id)}</span><strong>×{number(quantity)}</strong></li>)}</ul>;
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
    <p className={styles.description}>{route.description}</p>
    <Findings state={state} rewards={route.rewards} />
    {missing.length > 0 && <ul className={styles.requirements} aria-label="Условия открытия">{missing.map(({ id, level }) => <li key={id}><LockKeyhole size={12} aria-hidden="true" />{onNavigateStation ? <button type="button" className={styles.link} onClick={() => onNavigateStation(id)}>{stationName(state, id)} · нужен ур. {level}<ArrowRight size={12} aria-hidden="true" /></button> : <span>{stationName(state, id)} · нужен ур. {level}</span>}</li>)}</ul>}
    {route.cost.coins > 0 || Object.keys(route.cost.items).length > 0 ? <div className={styles.provisions}><span className={styles.caption}>На дорогу</span><ul aria-label="Припасы для вылазки">{route.cost.coins > 0 && <li data-missing={state.wallet.coins < route.cost.coins || undefined}><Coins size={13} aria-hidden="true" /><span>Монеты</span><strong>{number(state.wallet.coins)} / {number(route.cost.coins)}</strong></li>}{Object.entries(route.cost.items).map(([id, quantity]) => <li key={id} data-missing={(state.inventory[id] ?? 0) < quantity || undefined}><ProductIcon itemId={id} size={13} /><span>{itemName(state, id)}</span><strong>{number(state.inventory[id] ?? 0)} / {number(quantity)}</strong></li>)}</ul></div> : <p className={styles.free}>Без затрат</p>}
    {tooLarge ? <div className={styles.warning}><p>Находки займут {number(findings)} мест, вместимость — {number(state.storage.capacity)}.</p><button type="button" className={styles.link} onClick={onNavigateStation ? () => onNavigateStation("warehouse") : onOpenPantry}>Расширить кладовую<ArrowRight size={12} aria-hidden="true" /></button></div> : <p className={styles.caption}>Находки: {number(findings)} мест · свободно {number(state.storage.available)}. Место понадобится при получении.</p>}
    {exploring ? <p className={styles.caption}>Следующая вылазка — после получения текущих находок.</p> : <div className={styles.actions}>{shortfalls.length > 0 && <span className={styles.warning}>Не хватает припасов</span>}<button type="button" className={styles.primary} disabled={blocked || locked(economy)} onClick={() => void economy.act("start_exploration", route.id)} aria-label={`Отправиться: ${route.name}`}>Отправиться · {worldDuration(route.seconds)}<ArrowRight size={13} aria-hidden="true" /></button></div>}
  </div>;
}

export function WorldExpeditionsMenu({ economy, onOpenPantry, onNavigateStation }: WorldExpeditionsMenuProps) {
  const [selectedRoute, setSelectedRoute] = useState<string | null>(null);
  const state = economy.snapshot;
  const cooldown = Math.max(0, Math.ceil((economy.retryAt - economy.now) / 1000));
  const jobs = state?.jobs.filter(job => job.kind === "exploration") ?? [];
  const retry = <button type="button" className={styles.link} disabled={economy.busy || cooldown > 0} onClick={() => void economy.retry()}><RefreshCw size={13} aria-hidden="true" />{cooldown ? `Повторить через ${cooldown} с` : economy.uncertain ? "Проверить результат" : "Попробовать ещё раз"}</button>;
  return <div className={styles.content}>
    {!state ? <div className={styles.loading}><Compass size={18} aria-hidden="true" /><p>{economy.error ?? "Открываем маршруты…"}</p>{economy.error && retry}</div> : <>
      {(economy.error || economy.uncertain || cooldown > 0) && <div className={styles.warning} role="alert"><p>{economy.uncertain ? "Проверяем последнее действие. Новая вылазка доступна после подтверждения." : economy.error ?? "Подождите перед следующим действием."}</p>{retry}</div>}
      {jobs.map(job => <ActiveExpedition key={job.id} economy={economy} state={state} job={job} onOpenPantry={onOpenPantry} />)}
      {!jobs.length && <p className={styles.intro}>Куда отправим Мохлика?</p>}
      <div className={styles.routes} aria-label="Маршруты вылазок">{state.catalog.explorations.map(route => {
        const missing = worldMissingRequirements(state, worldRequirements(route));
        const tooLarge = countRewards(route.rewards) > state.storage.capacity;
        const needsProvisions = worldCostShortfalls(state, route.cost).length > 0;
        const Icon = routeIcon(route.id);
        const unavailable = missing.length > 0 || tooLarge || needsProvisions;
        const reason = missing.length ? `${stationName(state, missing[0].id)} · ур. ${missing[0].level}${missing.length > 1 ? ` и ещё ${missing.length - 1}` : ""}` : tooLarge ? "Нужна кладовая вместительнее" : jobs.length ? "Мохлик занят" : needsProvisions ? "Нужны припасы" : "Доступно";
        return <details key={route.id} className={styles.route} open={selectedRoute === route.id} data-route={route.id} data-locked={unavailable || undefined}>
          <summary onClick={event => { event.preventDefault(); setSelectedRoute(value => value === route.id ? null : route.id); }}><Icon size={18} aria-hidden="true" /><span className={styles.routeText}><strong>{routeName(route.name)}</strong><small>{unavailable && <LockKeyhole size={10} aria-hidden="true" />}{reason}</small></span><span className={styles.routeDuration}>{worldDuration(route.seconds)}</span><ChevronDown className={styles.chevron} size={13} aria-hidden="true" /></summary>
          <RouteDetails route={route} state={state} economy={economy} exploring={jobs.length > 0} onOpenPantry={onOpenPantry} onNavigateStation={onNavigateStation} />
        </details>;
      })}</div>
      {!state.catalog.explorations.length && <p className={styles.intro}>Маршруты пока недоступны.</p>}
    </>}
  </div>;
}
