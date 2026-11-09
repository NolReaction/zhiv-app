"use client";

import { useState } from "react";
import { Dialog } from "radix-ui";
import { X } from "lucide-react";
import { boatModuleUpgrade, boatModules, boatPhase, boatState } from "@/features/economy/domain/boat-fishing";
import type { EconomyController } from "@/features/economy/sync/use-economy";
import { boatModuleIds, type BoatModuleId } from "@/features/economy/domain/boat-model";
import styles from "./boat-dev-controls.module.css";

const moduleNames: Record<BoatModuleId, string> = { engine: "Двигатель", tank: "Бак", hull: "Корпус", storage: "Хранилище" };

export function BoatWorkshopDevButton({ economy }: { economy: EconomyController }) {
  if (process.env.NODE_ENV !== "development" || !economy.devAvailable) return null;
  return <Dialog.Root><Dialog.Trigger className={styles.trigger} aria-label="Открыть DEV лодки">DEV</Dialog.Trigger>
    <Dialog.Portal><Dialog.Overlay className={styles.overlay} /><Dialog.Content className={styles.dialog}
      onEscapeKeyDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()} onPointerDown={event => event.stopPropagation()}>
      <header><Dialog.Title>Проверка лодки</Dialog.Title><Dialog.Close aria-label="Закрыть DEV лодки"><X size={18} /></Dialog.Close></header>
      <Dialog.Description>Изменения применяются к текущему тестовому профилю.</Dialog.Description>
      <BoatDevControls economy={economy} expanded />
    </Dialog.Content></Dialog.Portal></Dialog.Root>;
}

/** Local API capability is checked again by the session and the development-only endpoint. */
export function BoatDevControls({ economy, compact = false, expanded = false }: { economy: EconomyController; compact?: boolean; expanded?: boolean }) {
  const [module, setModule] = useState<BoatModuleId>("engine");
  const state = economy.snapshot, config = state?.catalog.boat;
  if (process.env.NODE_ENV !== "development" || !economy.devAvailable || !state || !config) return null;
  const boat = boatState(state), phase = boatPhase(boat, economy.now), work = boat.work, voyage = boat.voyage;
  const locked = economy.busy || economy.uncertain || !economy.snapshotConfirmed || !economy.directActionsAvailable
    || economy.pendingProductionCount > 0 || economy.retryAt > economy.now;
  const waitingWork = Boolean(work && Date.parse(work.finishesAt) > economy.now);
  const travelling = phase === "outbound" || phase === "returning";
  const levels = boatModules(boat);
  const upgrade = boatModuleUpgrade(boat, module, config);
  const shortfall = upgrade ? Math.max(0, upgrade.cost.coins - state.wallet.coins) : 0;
  const editingModules = !work && !voyage;
  const act = (action: Parameters<EconomyController["actDev"]>[0], targetId: string, quantity = 1) => {
    if (!locked) economy.actDev(action, targetId, quantity);
  };
  const body = <div className={styles.content}>
      <fieldset className={styles.moduleEditor}><legend>Проверка улучшений</legend>
        <label>Узел<select value={module} onChange={event => setModule(event.target.value as BoatModuleId)}>
          {boatModuleIds.map(id => <option key={id} value={id}>{moduleNames[id]}</option>)}
        </select></label>
        <label>Установленный уровень<select data-dev-action="set-boat-module-level" value={levels[module]} disabled={locked || !editingModules}
          onChange={event => act("set_boat_module_level", module, Number(event.target.value))}>
          {config.moduleEffects[module].map((_, tier) => <option key={tier} value={tier}
            disabled={module === "hull" ? tier === 0 && Boolean(levels.engine || levels.tank || levels.storage) : tier > 0 && !levels.hull}>{tier}</option>)}
        </select></label>
        {upgrade && <button type="button" disabled={locked || shortfall === 0} data-dev-action="grant-boat-upgrade-cost"
          onClick={() => act("grant_boat_upgrade_cost", upgrade.id)}>{shortfall ? `Выдать ${shortfall.toLocaleString("ru-RU")} мон. на следующий уровень` : "Монет на следующий уровень хватает"}</button>}
      </fieldset>
      {!editingModules && <p>Уровни доступны у причала после завершения работы или получения улова.</p>}
      <div className={styles.actions}>
        <button type="button" disabled={locked || !waitingWork} data-dev-action="finish-boat-work"
          onClick={() => { if (work) act("finish_boat_work", work.id); }}>{waitingWork ? "Завершить таймер установки" : work ? "Установка готова — получите её" : "Нет работы лодки"}</button>
        <button type="button" disabled={locked || !travelling || !voyage} data-dev-action="finish-boat-travel"
          onClick={() => { if (voyage) act("finish_boat_travel", voyage.id); }}>{phase === "outbound" ? "Прибыть к месту ловли" : phase === "returning" ? "Прибыть домой" : "Убрать ожидание дороги"}</button>
        {!boat.level && <button type="button" disabled={locked || Boolean(work || voyage)} data-dev-action="prepare-boat"
          onClick={() => act("prepare_boat", "boat")}>Готовая лодка для теста</button>}
        <button type="button" disabled={locked} data-dev-action="boat-grant-gear" onClick={() => act("grant_fishing_gear", "all")}>Все удочки и крючки</button>
      </div>
      {phase === "fishing" && <p>Для проверки обратной дороги сначала нажмите «Вернуться с уловом».</p>}
      {!compact && <fieldset className={styles.blueprints}><legend>Фрагменты чертежей</legend>{config.blueprints.map(entry => <label key={entry.id}><span>{entry.name}</span>
        <select aria-label={`Фрагменты: ${entry.name}`} value={boat.blueprints[entry.id]} disabled={locked || work?.upgradeId === entry.id}
          onChange={event => act("set_boat_blueprint", entry.id, Number(event.target.value))}>{[0, 1, 2, 3].map(value => <option key={value} value={value}>{value} / 3</option>)}</select>
      </label>)}</fieldset>}
      {economy.notice && <p className={styles.notice} role="status">{economy.notice}</p>}
      {economy.error && <p className={styles.error} role="alert">{economy.error}</p>}
      {economy.uncertain && <button type="button" disabled={economy.busy || economy.retryAt > economy.now} onClick={() => void economy.retry()}>Проверить результат прежнего запроса</button>}
    </div>;
  if (expanded) return body;
  return <details className={`${styles.panel} ${compact ? styles.compact : ""}`} data-boat-dev>
    <summary><span className={styles.badge}>DEV</span><strong>Лодка · тестовое управление</strong><span className={styles.summaryState}>{work ? "работа" : travelling ? "в пути" : phase === "fishing" ? "рыбалка" : "у причала"}</span></summary>
    {body}
  </details>;
}
