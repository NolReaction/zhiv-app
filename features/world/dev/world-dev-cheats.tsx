"use client";

import { useState } from "react";
import { economyCatalog, type EconomyJob } from "@/features/economy/model";
import { economyDevSettlement } from "@/features/economy/dev-presets";
import type { EconomyController } from "@/features/economy/use-economy";
import type { WorldController } from "../use-world";
import styles from "./world-dev-panel.module.css";

const format = (value: number) => value.toLocaleString("ru-RU");
const JOB_FILTERS = [["all", "Все задания"], ["construction", "Только стройка"], ["production", "Только производство"], ["exploration", "Только разведка"]] as const;
type JobFilter = typeof JOB_FILTERS[number][0];

/** Uses the same account session and receipts as ordinary economy commands. */
export function WorldDevCheats({ world, economy, previewBuildings = false, onShowAccountBuildings }: {
  world: WorldController; economy?: EconomyController; previewBuildings?: boolean; onShowAccountBuildings?: () => void;
}) {
  const [presetLevel, setPresetLevel] = useState(2);
  const [itemId, setItemId] = useState("wood");
  const [amount, setAmount] = useState("100");
  const [buildingId, setBuildingId] = useState("home");
  const [level, setLevel] = useState("");
  const [jobFilter, setJobFilter] = useState<JobFilter>("all");
  const snapshot = economy?.snapshot;
  const catalog = snapshot?.catalog ?? economyCatalog;
  const preset = economyDevSettlement(presetLevel, catalog);
  const permitted = process.env.NODE_ENV === "development" && world.snapshot?.devTools === true && economy?.devAvailable === true;
  const cooldown = Boolean(economy && economy.retryAt > economy.now);
  const locked = !permitted || !snapshot || !economy || economy.busy || economy.uncertain || cooldown;
  const quantity = Number(amount);
  const validQuantity = /^\d+$/.test(amount) && Number.isSafeInteger(quantity) && quantity >= 1 && quantity <= 1_000_000;
  const item = catalog.items.find(entry => entry.id === itemId);
  const building = catalog.buildings.find(entry => entry.id === buildingId) ?? catalog.buildings[0];
  const currentLevel = snapshot?.buildings[building.id] ?? 0;
  const levelOptions = [0, ...building.levels.map(entry => entry.level)].filter(value => value > 0 || !["home", "warehouse"].includes(building.id));
  const requestedLevel = level === "" ? Math.min(currentLevel + 1, Math.max(...levelOptions)) : Number(level);
  const nextUpgrade = building.levels.find(entry => entry.level === currentLevel + 1);
  const buildingJobs = snapshot?.jobs.filter(job => job.kind !== "exploration" && job.targetId === building.id) ?? [];
  const validLevel = levelOptions.includes(requestedLevel) && requestedLevel !== currentLevel && !buildingJobs.length;
  const matchingJobs = snapshot?.jobs.filter(job => jobFilter === "all" || job.kind === jobFilter) ?? [];
  const unfinished = matchingJobs.filter(job => Date.parse(job.finishesAt) > (economy?.now ?? 0));
  const nextCostMissing = Boolean(snapshot && nextUpgrade && (snapshot.wallet.coins < nextUpgrade.cost.coins
    || Object.entries(nextUpgrade.cost.items).some(([id, needed]) => (snapshot.inventory[id] ?? 0) < needed)));

  function act(action: Parameters<EconomyController["actDev"]>[0], target: string, count = 1) {
    if (!locked) economy?.actDev(action, target, count);
  }
  function jobName(job: EconomyJob) {
    return job.kind === "construction" ? `${catalog.buildings.find(entry => entry.id === job.targetId)?.name ?? job.targetId} · ур. ${job.targetLevel}`
      : job.kind === "production" ? catalog.recipes.find(entry => entry.id === job.recipeId)?.name ?? job.targetId
      : catalog.explorations.find(entry => entry.id === job.targetId)?.name ?? job.targetId;
  }

  return <div className={styles.cheats}>
    <p className={styles.scope}>Меняют локальный тестовый профиль: ресурсы и уровни сохраняются после перезагрузки. «Сброс вида» их не отменяет.</p>
    {!permitted && <p className={styles.error} role="status">{world.snapshot ? "Читы недоступны на этом сервере. Нужен локальный API с разрешёнными DEV-командами." : "Ожидаем загрузку мира и разрешение DEV-команд…"}</p>}
    {!snapshot && <p className={styles.hint} role="status">Хозяйство ещё не загружено.</p>}
    {economy?.error && <p className={styles.error} role="alert">{economy.error}</p>}
    {economy?.notice && <p className={styles.cheatNotice} role="status">{economy.notice}</p>}
    {economy?.busy && <p className={styles.hint} role="status">Применяем команду…</p>}
    {cooldown && <p className={styles.hint} role="status">Следующий запрос через {Math.ceil((economy!.retryAt - economy!.now) / 1000)} с.</p>}
    {economy?.uncertain && <p className={styles.hint}>Ответ не получен. Проверьте результат тем же запросом перед следующим читом.</p>}
    {economy && (economy.uncertain || !snapshot) && <button type="button" disabled={economy.busy || cooldown}
      onClick={() => { if (!economy.busy && !cooldown) void economy.retry(); }}>{economy.uncertain ? "Проверить результат" : "Загрузить хозяйство"}</button>}

    <section className={styles.presetSection} aria-label="Готовое поселение">
      <div><h4>Готовое поселение</h4><p className={styles.hint}>Дом и все доступные ему улучшения на карте — одной командой.</p></div>
      <div className={styles.presetLevels} role="group" aria-label="Уровень дома для сценария">
        {catalog.buildings.find(entry => entry.id === "home")!.levels.map(entry => <button type="button" key={entry.level}
          aria-pressed={presetLevel === entry.level} onClick={() => setPresetLevel(entry.level)}>Дом {entry.level}</button>)}
      </div>
      <dl className={styles.presetBuildings}>{catalog.buildings.map(entry => <div key={entry.id}>
        <dt>{entry.name}</dt><dd>{preset[entry.id] ? `ур. ${preset[entry.id]}` : "закрыто"}</dd>
      </div>)}</dl>
      <p className={styles.hint}>Заменит уровни построек выбранным сценарием. Запасы, деньги и находки сохранятся.</p>
      <button type="button" disabled={locked || Boolean(snapshot?.jobs.length)} data-dev-action="apply-settlement"
        onClick={() => { if (!snapshot?.jobs.length) act("apply_settlement", "home", presetLevel); }}>Применить · полный дом {presetLevel}</button>
      {Boolean(snapshot?.jobs.length) && <p className={styles.cheatWarning}>Сначала завершите или отмените задания и заберите результаты. Таймеры доступны ниже.</p>}
      {previewBuildings && <p className={styles.cheatWarning}>Для проверки результата отключите предпросмотр в «Сцена → Здания».</p>}
    </section>

    <details className={styles.cheatSection}>
      <summary>Валюта</summary>
      <div className={styles.cheatTools}>
      <dl className={styles.cheatBalance}>
        <div><dt>Монеты</dt><dd>{snapshot ? format(snapshot.wallet.coins) : "—"}</dd></div>
        <div><dt>Жемчуг</dt><dd>{snapshot ? format(snapshot.wallet.pearls) : "—"}</dd></div>
      </dl>
      <div className={styles.columns}>
        {([["coins", 10000, "+10 000 монет"], ["coins", 100000, "+100 000 монет"], ["pearls", 5000, "+5 000 жемчуга"], ["pearls", 50000, "+50 000 жемчуга"]] as const).map(([currency, value, label]) =>
          <button type="button" key={`${currency}-${value}`} disabled={locked} data-dev-action={`grant-${currency}-${value}`} onClick={() => act("grant_currency", currency, value)}>{label}</button>)}
      </div>
      </div>
    </details>

    <details className={styles.cheatSection}>
      <summary>Материалы и товары</summary>
      <div className={styles.cheatTools}>
      <label className={styles.field}><span>Предмет</span><select value={itemId} disabled={locked} onChange={event => setItemId(event.target.value)}>
        {catalog.items.map(entry => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
      </select></label>
      <div className={styles.cheatQuantity}>
        <label className={styles.field}><span>Количество</span><input type="number" inputMode="numeric" min="1" max="1000000" step="1" value={amount}
          disabled={locked} onChange={event => setAmount(event.target.value)} aria-invalid={!validQuantity} /></label>
        <button type="button" disabled={locked || !validQuantity || !item} data-dev-action="grant-item"
          onClick={() => { if (validQuantity && item) act("grant_item", item.id, quantity); }}>Выдать предмет</button>
      </div>
      {!validQuantity && <p className={styles.hint}>Введите целое число от 1 до 1 000 000.</p>}
      {snapshot && <p className={styles.hint}>В запасах: {format(snapshot.inventory[itemId] ?? 0)}. Кладовая: {format(snapshot.storage.used)} / {format(snapshot.storage.capacity)}, в продаже: {format(snapshot.storage.reserved)}.</p>}
      {snapshot && (snapshot.storage.overflow > 0
        ? <p className={styles.cheatWarning}>Сверх вместимости: {format(snapshot.storage.overflow)}. Освободите место или увеличьте уровень кладовой перед получением продукции.</p>
        : validQuantity && quantity > snapshot.storage.available && <p className={styles.hint}>Чит выдаст предметы сверх вместимости. Для получения продукции затем понадобится свободное место в кладовой.</p>)}
      </div>
    </details>

    <details className={styles.cheatSection}>
      <summary>Постройки без ожидания</summary>
      <div className={styles.cheatTools}>
      <label className={styles.field}><span>Постройка</span><select value={building.id} disabled={locked}
        onChange={event => { setBuildingId(event.target.value); setLevel(""); }}>
        {catalog.buildings.map(entry => <option key={entry.id} value={entry.id}>{entry.name} · ур. {snapshot?.buildings[entry.id] ?? 0}</option>)}
      </select></label>
      <p className={styles.hint}>Сейчас: {currentLevel ? `уровень ${currentLevel}` : "не построено"}. Применяет уровень бесплатно, без ожидания и требований других зданий.</p>
      <div className={styles.cheatQuantity}>
        <label className={styles.field}><span>Новый уровень</span><select value={requestedLevel} disabled={locked} onChange={event => setLevel(event.target.value)}>
          {levelOptions.map(value => <option key={value} value={value}>{value ? `Уровень ${value}` : "Не построено"}</option>)}
        </select></label>
        <button type="button" disabled={locked || !validLevel} data-dev-action="set-building-level"
          onClick={() => { if (validLevel) act("set_building_level", building.id, requestedLevel); }}>Применить мгновенно</button>
      </div>
      {buildingJobs.length > 0 && <p className={styles.cheatWarning}>У постройки есть задания. Уберите ожидание ниже и заберите результат перед сменой уровня.</p>}
      <button type="button" disabled={locked || !nextUpgrade || !nextCostMissing} data-dev-action="grant-upgrade-cost"
        onClick={() => { if (nextUpgrade && nextCostMissing) act("grant_upgrade_cost", building.id); }}>Ресурсы для следующего улучшения</button>
      <p className={styles.hint}>{!nextUpgrade ? "Достигнут максимальный уровень." : nextCostMissing
        ? "Добавит только недостающие монеты и материалы. Условия и таймер обычной стройки сохранятся."
        : "Для следующего улучшения уже хватает монет и материалов."}</p>
      {previewBuildings && <div className={styles.cheatWarning}><p>Включён визуальный предпросмотр зданий. Он скрывает настоящие уровни на карте.</p>
        {onShowAccountBuildings && <button type="button" onClick={onShowAccountBuildings}>Показывать уровни хозяйства</button>}</div>}
      </div>
    </details>

    <details className={styles.cheatSection}>
      <summary>Таймеры заданий</summary>
      <div className={styles.cheatTools}>
      <label className={styles.field}><span>Какие задания завершить</span><select value={jobFilter} disabled={locked} onChange={event => setJobFilter(event.target.value as JobFilter)}>
        {JOB_FILTERS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select></label>
      <button type="button" disabled={locked || !unfinished.length} data-dev-action="finish-jobs"
        onClick={() => { if (unfinished.length) act("finish_jobs", jobFilter); }}>Убрать ожидание · {unfinished.length}</button>
      <p className={styles.hint}>Результат останется в задании. Заберите его здесь или в обычном меню объекта.</p>
      {matchingJobs.length ? <ul className={styles.cheatJobs}>{matchingJobs.map(job => {
        const ready = Date.parse(job.finishesAt) <= (economy?.now ?? 0);
        return <li key={job.id}><div><strong>{jobName(job)}</strong><span>{ready ? "Готово к получению" : `Осталось ${Math.max(1, Math.ceil((Date.parse(job.finishesAt) - (economy?.now ?? 0)) / 60000))} мин.`}</span></div>
          {ready && <button type="button" disabled={locked} onClick={() => { if (!locked) economy?.act("claim_job", job.id); }}>{job.kind === "construction" ? "Завершить стройку" : "Забрать"}</button>}</li>;
      })}</ul> : <p className={styles.hint}>Таких заданий сейчас нет.</p>}
      </div>
    </details>
  </div>;
}
