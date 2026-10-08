"use client";

import { useMemo, useState } from "react";
import { economyCatalog, type EconomyJob } from "@/features/economy/domain/model";
import { formatPearls } from "@/features/economy/domain/money";
import { economyDevSettlement } from "@/features/economy/dev/dev-presets";
import type { EconomyController } from "@/features/economy/sync/use-economy";
import type { WorldController } from "@/features/world/state/use-world";
import { ItemIcon } from "@/features/items/item-icon";
import { FishingRodIcon } from "@/features/world/activities/fishing/fishing-rod-icon";
import { wardrobeItems } from "@/features/world/domain/wardrobe";
import styles from "./world-dev-panel.module.css";

const format = (value: number) => value.toLocaleString("ru-RU");
const JOB_FILTERS = [["all", "Все задания"], ["construction", "Только стройка"], ["production", "Только производство"], ["exploration", "Вылазки и шахта"]] as const;
type JobFilter = typeof JOB_FILTERS[number][0];
const ITEM_CATEGORIES = [["all", "Все предметы"], ["materials", "Материалы"], ["food", "Еда и урожай"], ["fish", "Рыба"],
  ["rods", "Удочки"], ["hooks", "Крючки"], ["bait", "Наживка"], ["relics", "Реликвии"], ["wardrobe", "Одежда"]] as const;
type ItemCategory = typeof ITEM_CATEGORIES[number][0];


/** Uses the same account session and receipts as ordinary economy commands. */
export function WorldDevCheats({ world, economy, previewBuildings = false, onShowAccountBuildings }: {
  world: WorldController; economy?: EconomyController; previewBuildings?: boolean; onShowAccountBuildings?: () => void;
}) {
  const [presetLevel, setPresetLevel] = useState(2);
  const [itemId, setItemId] = useState("wood");
  const [itemCategory, setItemCategory] = useState<ItemCategory>("all");
  const [itemSearch, setItemSearch] = useState("");
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
  const items = useMemo(() => {
    const fishIds = new Set(catalog.fishing?.fish.map(fish => fish.itemId));
    return [
      ...catalog.items.map(item => ({ id: item.id, name: item.name, category: fishIds.has(item.id) ? "fish" : item.category === "fishing" ? "bait"
        : item.category === "special" ? "relics" : ["produce", "provisions"].includes(item.category) ? "food" : "materials", action: "grant_item" as const })),
      ...(catalog.fishing?.rods ?? []).map(rod => ({ id: rod.id, name: rod.name, category: "rods", action: "grant_fishing_gear" as const })),
      ...(catalog.fishing?.hooks ?? []).map(hook => ({ id: hook.id, name: hook.name, category: "hooks", action: "grant_fishing_gear" as const })),
      ...wardrobeItems.map(item => ({ id: item.id, name: item.name, category: "wardrobe", action: "grant_wardrobe" as const })),
    ];
  }, [catalog]);
  const search = itemSearch.trim().toLocaleLowerCase("ru-RU");
  const visibleItems = items.filter(item => (itemCategory === "all" || item.category === itemCategory)
    && (!search || `${item.name} ${item.id}`.toLocaleLowerCase("ru-RU").includes(search)));
  const item = visibleItems.find(entry => entry.id === itemId) ?? visibleItems[0];
  const consumable = item?.action === "grant_item";
  const itemOwned = !!item && (item.category === "rods" ? snapshot?.fishing?.ownedRods.includes(item.id)
    : item.category === "hooks" ? snapshot?.fishing?.ownedHooks.includes(item.id) : item.category === "wardrobe" ? snapshot?.wardrobe?.includes(item.id) : false);

  const building = catalog.buildings.find(entry => entry.id === buildingId) ?? catalog.buildings[0];
  const currentLevel = snapshot?.buildings[building.id] ?? 0;
  const levelOptions = [0, ...building.levels.map(entry => entry.level)].filter(value => value > 0 || !["home", "warehouse"].includes(building.id));
  const requestedLevel = level === "" ? Math.min(currentLevel + 1, Math.max(...levelOptions)) : Number(level);
  const nextUpgrade = building.levels.find(entry => entry.level === currentLevel + 1);
  const buildingJobs = snapshot?.jobs.filter(job => job.kind !== "exploration" ? job.targetId === building.id
    : building.id === "quarry" && !!catalog.explorations.find(route => route.id === job.targetId)?.requiredBuildings.quarry) ?? [];
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
      <div><h4>Готовое поселение</h4><p className={styles.hint}>Дом и доступные ему улучшения на карте. Кладовая — того же уровня; расширения до 10 проверяйте отдельно.</p></div>
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
        <div><dt>Жемчуг</dt><dd>{snapshot ? formatPearls(snapshot.wallet.pearls) : "—"}</dd></div>
      </dl>
      <div className={styles.columns}>
        {([["coins", 10000], ["coins", 100000], ["pearls", 5000], ["pearls", 50000]] as const).map(([currency, value]) =>
          <button type="button" key={`${currency}-${value}`} disabled={locked} data-dev-action={`grant-${currency}-${value}`} onClick={() => act("grant_currency", currency, value)}>{currency === "pearls" ? `+${formatPearls(value)} жемчуга` : `+${format(value)} монет`}</button>)}
      </div>
      </div>
    </details>

    <details className={styles.cheatSection}>
      <summary>Предметы и снаряжение</summary>
      <div className={styles.cheatTools}>
      <div className={styles.columns}>
        <label className={styles.field}><span>Категория</span><select value={itemCategory} onChange={event => setItemCategory(event.target.value as ItemCategory)}>
          {ITEM_CATEGORIES.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
        </select></label>
        <label className={styles.field}><span>Найти предмет</span><input type="search" value={itemSearch} placeholder="Название или ID" onChange={event => setItemSearch(event.target.value)} /></label>
      </div>
      <label className={styles.field}><span>Предмет · {visibleItems.length}</span><select value={item?.id ?? ""} disabled={locked || !item} onChange={event => setItemId(event.target.value)}>
        {visibleItems.length ? visibleItems.map(entry => <option key={entry.id} value={entry.id}>{entry.name}</option>) : <option value="">Ничего не найдено</option>}
      </select></label>
      {item && <div className={styles.cheatItemPreview}>
        {item.category === "rods" ? <FishingRodIcon rodId={item.id} size={48} /> : <ItemIcon itemId={item.id} size={44} />}
        <div><strong>{item.name}</strong><span>{item.id}</span><small>{consumable ? `В запасах: ${format(snapshot?.inventory[item.id] ?? 0)}` : itemOwned ? "Уже есть" : "Постоянная вещь"}</small></div>
      </div>}
      <div className={styles.cheatQuantity}>
        {consumable && <label className={styles.field}><span>Количество</span><input type="number" inputMode="numeric" min="1" max="1000000" step="1" value={amount}
          disabled={locked} onChange={event => setAmount(event.target.value)} aria-invalid={!validQuantity} /></label>}
        <button type="button" disabled={locked || !item || (consumable ? !validQuantity : itemOwned)} data-dev-action="grant-item"
          onClick={() => { if (item && (consumable ? validQuantity : !itemOwned)) act(item.action, item.id, consumable ? quantity : 1); }}>{consumable ? "Выдать предмет" : itemOwned ? "Уже есть" : "Выдать вещь"}</button>
      </div>
      {consumable && !validQuantity && <p className={styles.hint}>Введите целое число от 1 до 1 000 000.</p>}
      {item?.category === "fish" && <p className={styles.hint}>Рыба появится в кладовой для продажи и рецептов. Книга открывается после настоящей поимки.</p>}
      {!consumable && item && <p className={styles.hint}>{item.category === "wardrobe" ? "Появится в гардеробе." : "Появится в выборе снастей перед рыбалкой."} Место в кладовой не занимает.</p>}
      {consumable && snapshot && <p className={styles.hint}>Кладовая: {format(snapshot.storage.used)} / {format(snapshot.storage.capacity)}, в продаже: {format(snapshot.storage.reserved)}.</p>}
      {consumable && snapshot && (snapshot.storage.overflow > 0
        ? <p className={styles.cheatWarning}>Сверх вместимости: {format(snapshot.storage.overflow)}. Освободите место или увеличьте уровень кладовой перед получением продукции.</p>
        : validQuantity && quantity > snapshot.storage.available && <p className={styles.hint}>Чит выдаст предметы сверх вместимости. Для получения продукции затем понадобится свободное место в кладовой.</p>)}
      <button type="button" disabled={locked} data-dev-action="grant-all-fishing-gear" onClick={() => act("grant_fishing_gear", "all")}>Выдать все удочки и крючки</button>
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
