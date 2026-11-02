"use client";

import { useState } from "react";
import { boatPhase, boatState } from "@/features/economy/domain/boat-fishing";
import type { EconomyController } from "@/features/economy/sync/use-economy";
import type { BoatUpgradeId } from "@/features/economy/domain/boat-model";
import styles from "./boat-dev-controls.module.css";

/** Local API capability is checked again by the session and the development-only endpoint. */
export function BoatDevControls({ economy, compact = false }: { economy: EconomyController; compact?: boolean }) {
  const [selectedUpgrade, setSelectedUpgrade] = useState<BoatUpgradeId>("repair");
  const state = economy.snapshot, config = state?.catalog.boat;
  if (process.env.NODE_ENV !== "development" || !economy.devAvailable || !state || !config) return null;
  const boat = boatState(state), phase = boatPhase(boat, economy.now), work = boat.work, voyage = boat.voyage;
  const locked = economy.busy || economy.uncertain || !economy.snapshotConfirmed || !economy.directActionsAvailable
    || economy.pendingProductionCount > 0 || economy.retryAt > economy.now;
  const waitingWork = Boolean(work && Date.parse(work.finishesAt) > economy.now);
  const travelling = phase === "outbound" || phase === "returning";
  const upgrades = config.upgrades.filter(entry => !entry.blueprint);
  const upgrade = upgrades.find(entry => entry.id === selectedUpgrade) ?? upgrades[0];
  const missingCost = state.wallet.coins < upgrade.cost.coins || Object.entries(upgrade.cost.items).some(([id, count]) => (state.inventory[id] ?? 0) < count);
  const act = (action: Parameters<EconomyController["actDev"]>[0], targetId: string, quantity = 1) => {
    if (!locked) economy.actDev(action, targetId, quantity);
  };
  return <details className={`${styles.panel} ${compact ? styles.compact : ""}`} data-boat-dev>
    <summary><span className={styles.badge}>DEV</span><strong>Лодка · тестовое управление</strong><span className={styles.summaryState}>{work ? "работа" : travelling ? "в пути" : phase === "fishing" ? "рыбалка" : "у причала"}</span></summary>
    <div className={styles.content}>
      <p>Меняет локальный профиль. Готовые работы и улов получайте обычными кнопками.</p>
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
      <div className={styles.cost}>
        <label>Стоимость модуля<select value={selectedUpgrade} onChange={event => setSelectedUpgrade(event.target.value as BoatUpgradeId)} disabled={locked}>
          {upgrades.map(entry => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
        </select></label>
        <button type="button" disabled={locked || !missingCost} data-dev-action="grant-boat-upgrade-cost" onClick={() => act("grant_boat_upgrade_cost", upgrade.id)}>{missingCost ? "Выдать недостающее" : "Ресурсов хватает"}</button>
      </div>
      {!compact && <fieldset className={styles.blueprints}><legend>Фрагменты чертежей</legend>{config.blueprints.map(entry => <label key={entry.id}><span>{entry.name}</span>
        <select aria-label={`Фрагменты: ${entry.name}`} value={boat.blueprints[entry.id]} disabled={locked || work?.upgradeId === entry.id}
          onChange={event => act("set_boat_blueprint", entry.id, Number(event.target.value))}>{[0, 1, 2, 3].map(value => <option key={value} value={value}>{value} / 3</option>)}</select>
      </label>)}</fieldset>}
      {economy.notice && <p className={styles.notice} role="status">{economy.notice}</p>}
      {economy.error && <p className={styles.error} role="alert">{economy.error}</p>}
      {economy.uncertain && <button type="button" disabled={economy.busy || economy.retryAt > economy.now} onClick={() => void economy.retry()}>Проверить результат прежнего запроса</button>}
    </div>
  </details>;
}
