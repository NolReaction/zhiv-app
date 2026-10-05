"use client";

import { useEffect, useId, useRef, useState } from "react";
import { ArrowRight, Check, ChevronRight, CircleHelp, Clock3, Compass, Fish, Flame, Hammer, House, Leaf, LockKeyhole, Mountain, Package, RefreshCw, ShoppingBasket, Sprout, Store, Trees } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { ItemIcon } from "@/features/items/item-icon";
import type { EconomyCost, EconomyJob, EconomyMarketListing, EconomyView } from "./model";
import type { EconomyController } from "./use-economy";
import { canAffordEconomy } from "./rules";
import { economyLocalSellPrice, economyLocalSaleMinimumQuantity, economyLocalSaleLimit } from "./local-sale";
import { ConstructionSpeedup } from "./construction-speedup";
import { useGardenCollection } from "./garden-collection-context";
import { berryCollectionStatus } from "./garden-collection";
import { ProductionActivity, productionIsActive } from "./production-activity";
import { marketItemUnlocked, marketMinimumPrice, marketRequiredHomeLevel } from "./market-rules";
import styles from "./economy-panel.module.css";

export type EconomyTab = "overview" | "buildings" | "production" | "exploration" | "market" | "inventory";
type ReadyEconomy = EconomyController & { snapshot: EconomyView };
type Recipe = EconomyView["catalog"]["recipes"][number];
type Item = EconomyView["catalog"]["items"][number];
type Building = EconomyView["catalog"]["buildings"][number];
type Navigate = (tab: EconomyTab, focusId?: string) => void;
type Requirements = { requiredHomeLevel: number; requiredBuildings: Record<string, number> };
const tabs: { id: EconomyTab; label: string; Icon: LucideIcon }[] = [
  { id: "overview", label: "Обзор", Icon: Sprout },
  { id: "buildings", label: "Постройки", Icon: House },
  { id: "production", label: "Производство", Icon: Hammer },
  { id: "exploration", label: "Вылазки", Icon: Compass },
  { id: "market", label: "Рынок", Icon: Store },
  { id: "inventory", label: "Склад", Icon: Package },
];
const buildingIcons: Record<string, LucideIcon> = { home: House, garden: Sprout, woodlot: Trees, quarry: Mountain, workshop: Hammer, dryer: Flame, warehouse: Package, kiln: Flame };
const categoryNames: Record<string, string> = { produce: "Урожай и рыба", material: "Сырьё", crafted: "Материалы и изделия", provisions: "Припасы", fishing: "Рыболовные товары" };
const itemName = (state: EconomyView, id: string) => state.catalog.items.find(item => item.id === id)?.name ?? "Предмет";
const buildingName = (state: EconomyView, id: string) => state.catalog.buildings.find(building => building.id === id)?.name ?? "Постройка";
const number = (value: number) => value.toLocaleString("ru-RU");
const canTrade = (state: EconomyView) => (state.buildings.home ?? 1) >= state.catalog.market.requiredHomeLevel && state.completedExplorations >= state.catalog.market.requiredExplorations;

export function economyDuration(seconds: number) {
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  if (minutes < 60) return `${minutes} мин`;
  const hours = Math.floor(minutes / 60), rest = minutes % 60;
  if (hours >= 24) return `${Math.floor(hours / 24)} д${hours % 24 ? ` ${hours % 24} ч` : ""}${rest ? ` ${rest} мин` : ""}`;
  return `${hours} ч${rest ? ` ${rest} мин` : ""}`;
}

function requirements(value: Requirements, station?: { buildingId: string; buildingLevel: number }) {
  const result: Record<string, number> = { ...value.requiredBuildings, home: Math.max(value.requiredHomeLevel, value.requiredBuildings?.home ?? 0) };
  if (station) result[station.buildingId] = Math.max(result[station.buildingId] ?? 0, station.buildingLevel);
  return result;
}

function unmetRequirement(state: EconomyView, required: Record<string, number>) {
  const missing = Object.entries(required).find(([id, level]) => (state.buildings[id] ?? 0) < level);
  return missing ? `${buildingName(state, missing[0])}: нужен уровень ${missing[1]}` : null;
}

function RequirementList({ state, required, navigate }: { state: EconomyView; required: Record<string, number>; navigate: Navigate }) {
  return <ul className={styles.requirements} aria-label="Условия открытия">{Object.entries(required).map(([id, level]) => {
    const current = state.buildings[id] ?? 0, complete = current >= level;
    return <li key={id} data-complete={complete}>{complete ? <Check size={14} aria-hidden /> : <LockKeyhole size={14} aria-hidden />}
      {complete ? <span>{buildingName(state, id)}: {current} / {level} ур.</span> : <button className={styles.textButton} onClick={() => navigate("buildings", id)}>{buildingName(state, id)}: {current} / {level} ур.<ChevronRight size={14} aria-hidden /></button>}
    </li>;
  })}</ul>;
}

function StorageStatus({ state, navigate, compact = false, condensed = false }: { state: EconomyView; navigate: Navigate; compact?: boolean; condensed?: boolean }) {
  const { capacity, used, reserved, available, overflow } = state.storage;
  return <div className={styles.storage} data-full={available === 0} data-condensed={condensed || undefined}>
    <div className={styles.actions}><strong><Package size={16} aria-hidden />Склад · ур. {state.buildings.warehouse ?? 1}</strong><span>{number(used + reserved)} / {number(capacity)}</span></div>
    <progress className={styles.progress} value={Math.min(capacity, used + reserved)} max={capacity} aria-label={`Склад: занято ${used + reserved} из ${capacity}`} />
    {condensed ? <p className={styles.storageSummary}><span>Запасы: {number(used)}</span><span>На прилавках: {number(reserved)}</span><span>Свободно: {number(available)}</span></p>
      : <p className={styles.muted}>В запасах: {number(used)} · На прилавках: {number(reserved)} · Свободно: {number(available)}</p>}
    {overflow > 0 && <p className={styles.hint}>Прежние запасы сохранены. Сверх вместимости: {number(overflow)}. Используйте или продайте часть вещей, либо расширьте склад.</p>}
    {!compact && <><p className={styles.muted}>Каждая единица товара занимает одно место. Место для выставленных лотов зарезервировано до продажи — отмена всегда вернёт вещи.</p><button className={styles.textButton} onClick={() => navigate("buildings", "warehouse")}>Расширить склад<ArrowRight size={15} aria-hidden /></button></>}
  </div>;
}

function integer(value: string, maximum: number) {
  if (!/^\d+$/.test(value)) return null;
  const result = Number(value);
  return Number.isSafeInteger(result) && result >= 1 && result <= maximum ? result : null;
}

export function EconomyBalances({ wallet }: { wallet: EconomyView["wallet"] }) {
  return <div className={styles.wallet} aria-label="Кошелёк">
    <span><ItemIcon itemId="coins" size={18} /><strong>{number(wallet.coins)}</strong><span className={styles.walletLabel}>монет</span><span className={styles.sr}>Монеты: {number(wallet.coins)}</span></span>
    <span title="Жемчуг ускоряет строительство. Покупка пока недоступна; особые товары появятся позже."><ItemIcon itemId="pearls" size={18} /><strong>{number(wallet.pearls)}</strong><span className={styles.walletLabel}>жемчуг</span><span className={styles.sr}>Жемчуг: {number(wallet.pearls)}. Можно ускорить строительство. Покупка пока недоступна.</span></span>
  </div>;
}

function Cost({ state, cost, quantity = 1 }: { state: EconomyView; cost: EconomyCost; quantity?: number }) {
  const entries = Object.entries(cost.items);
  if (!cost.coins && !entries.length) return <p className={styles.hint}><Leaf size={14} aria-hidden />Без затрат</p>;
  return <div><span className={styles.sectionLabel}>Потребуется</span><ul className={styles.costs} aria-label="Стоимость">
    {cost.coins > 0 && <li data-missing={state.wallet.coins < cost.coins * quantity}><ItemIcon itemId="coins" size={16} />{number(cost.coins * quantity)} монет<span className={styles.sr}>; есть {number(state.wallet.coins)}</span></li>}
    {entries.map(([id, amount]) => {
      const available = state.inventory[id] ?? 0, required = amount * quantity;
      return <li key={id} data-missing={available < required}><ItemIcon itemId={id} size={18} />{itemName(state, id)}: {number(available)} / {number(required)}<span className={styles.sr}>{available < required ? "; не хватает" : "; достаточно"}</span></li>;
    })}
  </ul></div>;
}

function Rewards({ state, value, quantity = 1 }: { state: EconomyView; value: Record<string, number>; quantity?: number }) {
  return <ul className={styles.rewards} aria-label="Результат">{Object.entries(value).map(([id, amount]) => {
    return <li key={id}><ItemIcon itemId={id} size={18} />{itemName(state, id)} × {number(amount * quantity)}</li>;
  })}</ul>;
}

function jobTitle(state: EconomyView, job: EconomyJob) {
  if (job.kind === "construction") return `${buildingName(state, job.targetId)} · уровень ${job.targetLevel}`;
  if (job.kind === "exploration") return state.catalog.explorations.find(entry => entry.id === job.targetId)?.name ?? "Вылазка Мохлика";
  return state.catalog.recipes.find(entry => entry.id === job.recipeId)?.name ?? "Производство";
}

function JobCard({ economy, job, navigate }: { economy: ReadyEconomy; job: EconomyJob; navigate: Navigate }) {
  const { snapshot: state, now, busy, uncertain } = economy;
  const collection = useGardenCollection();
  const berry = berryCollectionStatus(job, state, now, collection);
  const start = Date.parse(job.startedAt), end = Date.parse(job.finishesAt), ready = now >= end;
  const progress = Math.min(1, Math.max(0, (now - start) / Math.max(1, end - start)));
  const Icon = job.kind === "construction" ? Hammer : job.kind === "exploration" ? Compass : Sprout;
  const caption = job.kind === "construction" ? "Строительство" : job.kind === "exploration" ? "Мохлик в пути" : buildingName(state, job.targetId);
  const rewardCount = Object.values(job.rewards).reduce((sum, amount) => sum + amount, 0);
  const storageBlocked = job.kind !== "construction" && rewardCount > state.storage.available;
  const working = productionIsActive(job, now);
  return <article className={styles.card} data-ready={ready}>
    <div className={styles.cardHeader}><span className={styles.iconTile} data-working={working || undefined}>{working ? <ProductionActivity job={job} now={now} /> : <Icon size={21} aria-hidden />}</span><div><span className={styles.eyebrow}>{ready ? "Готово" : caption}</span><h3>{jobTitle(state, job)}</h3></div></div>
    {Object.keys(job.rewards).length > 0 && <Rewards state={state} value={job.rewards} />}
    {!ready && <progress className={styles.progress} value={progress} max={1} aria-label={`${jobTitle(state, job)}: выполнено ${Math.floor(progress * 100)}%`} />}
    <div className={styles.jobFooter}>
      <span className={styles.duration}>{ready && !berry?.collecting ? <Check size={15} aria-hidden /> : <Clock3 size={15} aria-hidden />}{ready ? berry?.label ?? "Можно забрать" : `Ещё ${economyDuration((end - now) / 1000)}`}</span>
      <button className={ready ? styles.primary : undefined} disabled={!ready || storageBlocked || busy || uncertain || berry?.disabled} onClick={() => {
        if (berry && collection) collection.start(job.id);
        else economy.act(berry && !berry.started ? "start_collection" : "claim_job", job.id);
      }}>
        {berry?.button ?? (job.kind === "construction" ? "Завершить" : "Забрать")}<span className={styles.sr}>: {jobTitle(state, job)}</span>
      </button>
    </div>
    {job.kind === "construction" && <ConstructionSpeedup key={job.id} economy={economy} job={job} />}
    {job.kind === "construction" && !ready && <p className={styles.muted}>Материалы уже внесены. Прежний уровень продолжает действовать.</p>}
    {berry?.away && ready && <p className={styles.muted}>Сначала дождитесь возвращения Мохлика из вылазки.</p>}
    {ready && storageBlocked && <div className={styles.notice}><Package size={18} aria-hidden /><div><p>Для результата нужно {number(rewardCount)} мест, свободно {number(state.storage.available)}. Готовые вещи ждут и не портятся.</p><button onClick={() => navigate(rewardCount > state.storage.capacity ? "buildings" : "inventory", rewardCount > state.storage.capacity ? "warehouse" : undefined)}>{rewardCount > state.storage.capacity ? "Расширить склад" : "Освободить место"}<ArrowRight size={15} aria-hidden /></button></div></div>}
  </article>;
}

function Overview({ economy, navigate }: { economy: ReadyEconomy; navigate: Navigate }) {
  const { snapshot: state, now } = economy;
  const ready = state.jobs.filter(job => Date.parse(job.finishesAt) <= now).length;
  const jobs = [...state.jobs].sort((a, b) => Date.parse(a.finishesAt) - Date.parse(b.finishesAt));
  const owned = Object.values(state.buildings).filter(level => level > 0).length;
  const migration = state.migration;
  return <div className={styles.stack}>
    <div className={styles.heading}><div><span className={styles.eyebrow}>Своя жизнь в лесу</span><h2>{ready ? "Пора забрать результаты" : "Хозяйство Мохлика"}</h2><p className={styles.muted}>Постройки работают параллельно. Мохлик отправляется в одну вылазку за раз.</p></div></div>
    <div className={styles.shortcuts}>
      <button onClick={() => navigate("production")}><Sprout size={22} aria-hidden /><span><strong>Производство</strong><small>Урожай и материалы</small></span><ChevronRight size={14} aria-hidden /></button>
      <button onClick={() => navigate("exploration")}><Compass size={22} aria-hidden /><span><strong>Вылазки</strong><small>{state.jobs.some(job => job.kind === "exploration" || job.collection?.startedAt) ? "Мохлик занят" : "Можно отправляться"}</small></span><ChevronRight size={14} aria-hidden /></button>
      <button onClick={() => navigate("buildings")}><House size={22} aria-hidden /><span><strong>Постройки</strong><small>Обустроено: {owned}</small></span><ChevronRight size={14} aria-hidden /></button>
      <button onClick={() => navigate("inventory")}><Package size={22} aria-hidden /><span><strong>Склад</strong><small>Свободно: {number(state.storage.available)}</small></span><ChevronRight size={14} aria-hidden /></button>
    </div>
    <StorageStatus state={state} navigate={navigate} compact />
    {jobs.length ? <div className={styles.stack} aria-label="Текущие дела">{jobs.map(job => <JobCard key={job.id} economy={economy} job={job} navigate={navigate} />)}</div>
      : <div className={styles.empty}><Sprout size={32} aria-hidden /><h3>Начните с маленького урожая</h3><p className={styles.muted}>Вырастите ягоды в саду и отправьте Мохлика за материалами. Монеты можно получить за товары на складе.</p><button className={styles.primary} onClick={() => navigate("production")}>Открыть производство<ArrowRight size={16} aria-hidden /></button></div>}
    <p className={styles.hint}><Clock3 size={15} aria-hidden />Дела продолжаются после выхода. Готовые результаты ждут вас и не портятся.</p>
    {(migration.coinsGranted > 0 || migration.woodGranted > 0 || migration.stoneGranted > 0) && <details className={styles.details}><summary>Прежние запасы перенесены</summary><p>Однократно получено: {number(migration.coinsGranted)} монет, {number(migration.woodGranted)} древесины и {number(migration.stoneGranted)} камня. Уже полученные улучшения сохранены.</p></details>}
    <details className={styles.details}><summary>Для чего нужен жемчуг?</summary><p>Готовим особое оформление за жемчуг. Его покупка пока недоступна. Для нынешних построек нужны монеты и материалы.</p></details>
  </div>;
}

function Unlocks({ state, building, level, navigate }: { state: EconomyView; building: Building; level: Building["levels"][number]; navigate: Navigate }) {
  const usesLevel = (value: Requirements, station?: { buildingId: string; buildingLevel: number }) => requirements(value, station)[building.id] === level.level;
  const recipes = state.catalog.recipes.filter(recipe => usesLevel(recipe, recipe));
  const routes = state.catalog.explorations.filter(route => usesLevel(route));
  const upgrades = state.catalog.buildings.flatMap(other => other.id === building.id ? [] : other.levels.filter(target => usesLevel(target)).map(target => ({ building: other, level: target.level })));
  return <div className={styles.stack}>
    <span className={styles.sectionLabel}>Что даёт этот уровень</span>
    {level.warehouseCapacity && <p className={styles.hint}><Package size={15} aria-hidden />Вместимость склада: {number(level.warehouseCapacity)} предметов.</p>}
    <ul className={styles.unlocks}>
      {recipes.map(recipe => <li key={`recipe:${recipe.id}`}><button className={styles.textButton} onClick={() => navigate("production", recipe.buildingId)}><Hammer size={15} aria-hidden />{recipe.name}<ChevronRight size={14} aria-hidden /></button></li>)}
      {routes.map(route => <li key={`route:${route.id}`}><button className={styles.textButton} onClick={() => navigate("exploration", route.id)}><Compass size={15} aria-hidden />{route.name}<ChevronRight size={14} aria-hidden /></button></li>)}
      {upgrades.map(target => <li key={`building:${target.building.id}:${target.level}`}><button className={styles.textButton} onClick={() => navigate("buildings", target.building.id)}><House size={15} aria-hidden />{target.building.name} · ур. {target.level}<ChevronRight size={14} aria-hidden /></button></li>)}
      {building.id === "home" && level.level === state.catalog.market.requiredHomeLevel && <li><button className={styles.textButton} onClick={() => navigate("market")}><Store size={15} aria-hidden />Торговля с игроками<ChevronRight size={14} aria-hidden /></button></li>}
    </ul>
    {(recipes.length + routes.length + upgrades.length > 0) && <p className={styles.muted}>Откроется, когда выполнены и остальные условия. Нажмите на цель, чтобы посмотреть их.</p>}
    {building.id === "home" && <p className={styles.muted}>Обновляет облик дома на поляне.</p>}
  </div>;
}

function BuildingCard({ economy, building, navigate }: { economy: ReadyEconomy; building: Building; navigate: Navigate }) {
  const { snapshot: state, busy, uncertain } = economy;
  const level = state.buildings[building.id] ?? 0, next = building.levels.find(entry => entry.level === level + 1);
  const [preview, setPreview] = useState<number | null>(null);
  const target = building.levels.find(entry => entry.level === preview) ?? next ?? building.levels.at(-1);
  const ownJob = state.jobs.find(job => job.kind === "construction" && job.targetId === building.id);
  const construction = state.jobs.some(job => job.kind === "construction");
  const production = state.jobs.some(job => job.kind === "production" && job.targetId === building.id);
  const required = target ? requirements(target) : {};
  const reason = !target || target.level <= level ? "Этот уровень уже получен" : target.level !== level + 1 ? `Сначала получите уровень ${target.level - 1}`
    : unmetRequirement(state, required) ?? (construction ? "Сначала завершите текущую стройку" : production ? "Сначала заберите готовую продукцию" : !canAffordEconomy(state, target.cost) ? "Не хватает монет или материалов" : null);
  const Icon = buildingIcons[building.id] ?? House;
  return <div className={styles.stack}>
    {ownJob && <JobCard economy={economy} job={ownJob} navigate={navigate} />}
    <article className={styles.card}>
      <div className={styles.cardHeader}><span className={styles.iconTile}><Icon size={22} aria-hidden /></span><div><h3>{building.name}</h3><p className={styles.muted}>{building.description}</p></div><span className={styles.level}>{level ? `Ур. ${level}` : "Проект"}</span></div>
      <nav className={styles.tiers} aria-label={`Уровни: ${building.name}`}>{building.levels.map(tier => <button key={tier.level} aria-pressed={target?.level === tier.level} onClick={() => setPreview(tier.level)}>{tier.level <= level && <Check size={12} aria-hidden />}Ур. {tier.level}</button>)}</nav>
      {target && <>
        <h3>{target.level <= level ? "Уже обустроено" : target.level === level + 1 ? "Следующий шаг" : "Будущий уровень"} · ур. {target.level}</h3>
        {target.level > level && <><RequirementList state={state} required={required} navigate={navigate} /><Cost state={state} cost={target.cost} /></>}
        <Unlocks state={state} building={building} level={target} navigate={navigate} />
        {target.level > level && <div className={styles.actions}><span className={styles.duration}><Clock3 size={14} aria-hidden />{economyDuration(target.seconds)}</span>
          <button className={styles.primary} disabled={Boolean(reason) || busy || uncertain} onClick={() => void economy.act("start_construction", building.id)}>{level ? `Улучшить до ур. ${target.level}` : "Построить"}<span className={styles.sr}>: {building.name}</span></button>
        </div>}
      </>}
      {reason && <p className={styles.hint}>{target && target.level <= level ? <Check size={14} aria-hidden /> : <LockKeyhole size={14} aria-hidden />}{reason}</p>}
      {target && target.level > level + 1 && <button className={styles.textButton} onClick={() => setPreview(null)}>К ближайшему улучшению<ArrowRight size={15} aria-hidden /></button>}
      {level > 0 && state.catalog.recipes.some(recipe => recipe.buildingId === building.id) && <button className={styles.textButton} onClick={() => navigate("production", building.id)}>{production ? "К текущему заказу" : "Открыть производство"}<ArrowRight size={15} aria-hidden /></button>}
      {target && target.level > level && Object.entries(target.cost.items).some(([id, amount]) => (state.inventory[id] ?? 0) < amount) && <button className={styles.textButton} onClick={() => navigate("inventory", Object.entries(target.cost.items).find(([id, amount]) => (state.inventory[id] ?? 0) < amount)?.[0])}>Где взять недостающие материалы?<ArrowRight size={15} aria-hidden /></button>}
    </article>
  </div>;
}

function Buildings({ economy, navigate, focusId }: { economy: ReadyEconomy; navigate: Navigate; focusId?: string }) {
  const { snapshot: state } = economy;
  const building = state.catalog.buildings.find(entry => entry.id === focusId) ?? state.catalog.buildings[0];
  return <div className={styles.stack}><div className={styles.heading}><div><h2>Развитие хозяйства</h2><p className={styles.muted}>Выберите постройку и посмотрите её следующий шаг. Одна стройка за раз; остальные здания продолжают работать.</p></div></div>
    <div className={styles.buildingGrid} aria-label="Выбрать постройку">{state.catalog.buildings.map(entry => {
      const Icon = buildingIcons[entry.id] ?? House, level = state.buildings[entry.id] ?? 0;
      return <button key={entry.id} aria-pressed={entry.id === building?.id} onClick={() => navigate("buildings", entry.id)}><Icon size={19} aria-hidden /><span><strong>{entry.name}</strong><small>{level ? `Ур. ${level} / ${entry.levels.length}` : "Не построено"}</small></span></button>;
    })}</div>
    {building && <BuildingCard key={building.id} economy={economy} building={building} navigate={navigate} />}
  </div>;
}

function RecipeCard({ economy, recipe, navigate }: { economy: ReadyEconomy; recipe: Recipe; navigate: Navigate }) {
  const { snapshot: state, busy, uncertain } = economy;
  const [requestedQuantity, setQuantity] = useState(1);
  const inputId = useId();
  const rewardCount = Object.values(recipe.rewards).reduce((sum, amount) => sum + amount, 0);
  const maximum = Math.min(recipe.maxBatch ?? state.catalog.maxBatch, state.catalog.maxBatch, Math.floor(state.storage.capacity / Math.max(1, rewardCount)));
  const quantity = Math.max(1, Math.min(requestedQuantity, maximum));
  const required = requirements(recipe, recipe);
  const occupied = state.jobs.some(job => (job.kind === "production" || job.kind === "construction") && job.targetId === recipe.buildingId);
  const reason = unmetRequirement(state, required) ?? (maximum < 1 ? "Для этого заказа нужно расширить склад" : occupied ? "Здание занято текущим заказом" : !canAffordEconomy(state, recipe.cost, quantity) ? "Не хватает ингредиентов" : null);
  const choices = Array.from({ length: maximum }, (_, index) => index + 1);
  return <article className={styles.card}><div className={styles.cardHeader}><span className={styles.iconTile}><ItemIcon itemId={Object.keys(recipe.rewards)[0] ?? ""} size={28} /></span><div><span className={styles.eyebrow}>{buildingName(state, recipe.buildingId)}</span><h3>{recipe.name}</h3></div></div>
    <Rewards state={state} value={recipe.rewards} quantity={quantity} />
    <RequirementList state={state} required={required} navigate={navigate} />
    <Cost state={state} cost={recipe.cost} quantity={quantity} />
    <label className={styles.field} htmlFor={inputId}>Размер заказа<select id={inputId} value={quantity} disabled={busy || uncertain || maximum < 1} onChange={event => setQuantity(Number(event.target.value))}>{choices.map(count => <option key={count} value={count}>{count} {count === 1 ? "партия" : count < 5 ? "партии" : "партий"} · {economyDuration(recipe.seconds * count)}</option>)}</select></label>
    <p className={styles.muted}>Результат займёт {number(rewardCount * quantity)} мест. Сейчас свободно {number(state.storage.available)}; место понадобится при получении.</p>
    <button className={`${styles.primary} ${styles.wide}`} disabled={Boolean(reason) || busy || uncertain} onClick={() => void economy.act("start_production", recipe.id, quantity)}>Начать · {economyDuration(recipe.seconds * quantity)}<span className={styles.sr}>: {recipe.name}</span></button>
    {reason && <p className={styles.hint}><LockKeyhole size={14} aria-hidden />{reason}</p>}
    {maximum < 1 && <button className={styles.textButton} onClick={() => navigate("buildings", "warehouse")}>Расширить склад<ArrowRight size={15} aria-hidden /></button>}
    {Object.keys(recipe.cost.items).length > 0 && <button className={styles.textButton} onClick={() => navigate("inventory", Object.entries(recipe.cost.items).find(([id, amount]) => (state.inventory[id] ?? 0) < amount * quantity)?.[0] ?? Object.keys(recipe.cost.items)[0])}>Откуда брать ингредиенты?<ChevronRight size={14} aria-hidden /></button>}
  </article>;
}

function Production({ economy, navigate, focusId }: { economy: ReadyEconomy; navigate: Navigate; focusId?: string }) {
  const { snapshot: state } = economy;
  const stations = state.catalog.buildings.filter(building => state.catalog.recipes.some(recipe => recipe.buildingId === building.id));
  const station = stations.find(building => building.id === focusId)?.id ?? stations.find(building => (state.buildings[building.id] ?? 0) > 0)?.id ?? stations[0]?.id ?? "";
  const selectId = useId();
  const job = state.jobs.find(entry => entry.kind === "production" && entry.targetId === station);
  const recipes = state.catalog.recipes.filter(recipe => recipe.buildingId === station);
  const open = recipes.filter(recipe => !unmetRequirement(state, requirements(recipe, recipe)));
  const locked = recipes.filter(recipe => unmetRequirement(state, requirements(recipe, recipe)));
  return <div className={styles.stack}><div className={styles.heading}><div><h2>Лесное хозяйство</h2><p className={styles.muted}>У каждого здания свой заказ. Все партии забираются вместе после его завершения.</p></div></div>
    <label className={styles.field} htmlFor={selectId}>Выберите место<select id={selectId} value={station} onChange={event => navigate("production", event.target.value)}>{stations.map(building => <option key={building.id} value={building.id}>{building.name} · {(state.buildings[building.id] ?? 0) > 0 ? `ур. ${state.buildings[building.id]}` : "не построено"}</option>)}</select></label>
    {state.buildings[station] > 0 && <button className={styles.textButton} onClick={() => navigate("buildings", station)}><House size={16} aria-hidden />Развитие: {buildingName(state, station)}<ArrowRight size={15} aria-hidden /></button>}
    {job && <JobCard economy={economy} job={job} navigate={navigate} />}
    {!(state.buildings[station] > 0) && <div className={styles.notice}><House size={18} aria-hidden /><div><p>Сначала обустройте это место.</p><button onClick={() => navigate("buildings", station)}>К постройке<ArrowRight size={15} aria-hidden /></button></div></div>}
    {open.map(recipe => <RecipeCard key={recipe.id} economy={economy} recipe={recipe} navigate={navigate} />)}
    {locked.length > 0 && <details className={styles.details} open={!open.length}><summary>Будущие рецепты · {locked.length}</summary><div className={styles.stack}>{locked.map(recipe => <RecipeCard key={recipe.id} economy={economy} recipe={recipe} navigate={navigate} />)}</div></details>}
  </div>;
}

function Exploration({ economy, navigate, focusId }: { economy: ReadyEconomy; navigate: Navigate; focusId?: string }) {
  const { snapshot: state, busy, uncertain } = economy;
  const job = state.jobs.find(entry => entry.kind === "exploration");
  const routes = [...state.catalog.explorations].sort((a, b) => Number(b.id === focusId) - Number(a.id === focusId));
  return <div className={styles.stack}><div className={styles.heading}><div><h2>Мохлик-исследователь</h2><p className={styles.muted}>Выберите цель вылазки. Производство продолжится, пока Мохлик в пути.</p></div></div>
    {job && <JobCard economy={economy} job={job} navigate={navigate} />}
    {routes.map(exploration => {
      const required = requirements(exploration), rewardCount = Object.values(exploration.rewards).reduce((sum, amount) => sum + amount, 0);
      const tooLarge = rewardCount > state.storage.capacity;
      const reason = unmetRequirement(state, required) ?? (tooLarge ? "Для этих находок нужно расширить склад" : job ? "Сначала завершите текущую вылазку" : state.jobs.some(entry => entry.collection?.startedAt) ? "Сначала завершите сбор урожая" : !canAffordEconomy(state, exploration.cost) ? "Не хватает припасов" : null);
      const Icon = exploration.id.includes("cave") ? Mountain : exploration.id === "shore" ? Fish : Compass;
      return <article key={exploration.id} className={styles.card}><div className={styles.cardHeader}><span className={styles.iconTile}><Icon size={22} aria-hidden /></span><div><h3>{exploration.name}</h3><p className={styles.muted}>{exploration.description}</p></div></div>
        <Rewards state={state} value={exploration.rewards} /><RequirementList state={state} required={required} navigate={navigate} /><Cost state={state} cost={exploration.cost} />
        <p className={styles.muted}>Находки займут {number(rewardCount)} мест на складе.</p>
        <div className={styles.actions}><span className={styles.duration}><Clock3 size={14} aria-hidden />{economyDuration(exploration.seconds)}</span><button className={styles.primary} disabled={Boolean(reason) || busy || uncertain} onClick={() => void economy.act("start_exploration", exploration.id)}>Отправиться<span className={styles.sr}>: {exploration.name}</span></button></div>
        {reason && <p className={styles.hint}><LockKeyhole size={14} aria-hidden />{reason}</p>}
        {tooLarge && <button className={styles.textButton} onClick={() => navigate("buildings", "warehouse")}>Расширить склад<ArrowRight size={15} aria-hidden /></button>}
      </article>;
    })}
  </div>;
}

function SellForm({ economy, item }: { economy: ReadyEconomy; item: Item }) {
  const { snapshot: state } = economy;
  const buyer = state.catalog.localBuyer, minimum = economyLocalSaleMinimumQuantity(item.baseSellPrice, buyer);
  const [value, setValue] = useState(() => String(minimum));
  const inputId = useId(), stock = state.inventory[item.id] ?? 0;
  const maximum = economyLocalSaleLimit(item.baseSellPrice, stock, state.wallet.coins, buyer);
  const parsed = integer(value, maximum), quantity = parsed && parsed >= minimum ? parsed : null;
  const total = quantity ? economyLocalSellPrice(item.baseSellPrice, quantity, buyer) : 0;
  const discount = (10_000 - (buyer?.payoutBps ?? 10_000)) / 100;
  const unavailable = economy.busy || economy.uncertain || economy.retryAt > economy.now;
  return <div className={styles.card}><h3>Продать торговцу: {item.name.toLocaleLowerCase("ru-RU")}</h3>
    <p className={styles.muted}>{discount > 0 ? `Быстрая продажа с уценкой ${number(discount)}%. Итог за всё количество округляется вниз до целой монеты.` : `Торговец покупает сразу по ${number(item.baseSellPrice)} монет за штуку.`} На прилавке можно предложить свою цену другим игрокам.</p>
    {discount > 0 && state.catalog.fishing?.fish.some(fish => fish.itemId === item.id) && <p className={styles.muted}>Плёска купит дороже: {number(item.baseSellPrice)} монет за штуку. Её лавка открывается на карте.</p>}
    <label className={styles.field} htmlFor={inputId}>Количество · на складе {number(stock)}<input id={inputId} type="number" inputMode="numeric" min={minimum} max={Math.max(minimum, maximum)} step={1} value={value} disabled={unavailable || maximum < minimum} onChange={event => setValue(event.target.value)} /></label>
    <button className={styles.primary} disabled={!quantity || unavailable} onClick={() => { if (quantity && !unavailable) void economy.act("sell", item.id, quantity, buyer ? total : 0); }}><ItemIcon itemId="coins" size={16} />Продать {quantity ?? "—"} шт. за {quantity ? number(total) : "—"} монет</button>
    {maximum < minimum ? <p className={styles.hint}>{stock < minimum ? `Для продажи нужно хотя бы ${number(minimum)} шт., чтобы получить целую монету.` : "В кошельке нет места для продажи."}</p>
      : !quantity && <p className={styles.hint}>Укажите целое количество от {number(minimum)} до {number(maximum)}.</p>}
  </div>;
}

function ItemGuide({ economy, item, navigate }: { economy: ReadyEconomy; item: Item; navigate: Navigate }) {
  const { snapshot: state } = economy;
  const recipes = state.catalog.recipes.filter(recipe => recipe.rewards[item.id] > 0);
  const routes = state.catalog.explorations.filter(route => route.rewards[item.id] > 0);
  const ingredients = state.catalog.recipes.filter(recipe => recipe.cost.items[item.id] > 0);
  const buildings = state.catalog.buildings.filter(building => building.levels.some(level => level.level > (state.buildings[building.id] ?? 0) && level.cost.items[item.id] > 0));
  const provisions = state.catalog.explorations.filter(route => route.cost.items[item.id] > 0);
  return <div className={styles.card}><h3>{item.name} · на складе {number(state.inventory[item.id] ?? 0)}</h3>
    <div><span className={styles.sectionLabel}>Где получить</span><ul className={styles.unlocks}>
      {recipes.map(recipe => <li key={recipe.id}><button className={styles.textButton} onClick={() => navigate("production", recipe.buildingId)}><Hammer size={15} aria-hidden />{recipe.name} · {buildingName(state, recipe.buildingId)}<ChevronRight size={14} aria-hidden /></button></li>)}
      {routes.map(route => <li key={route.id}><button className={styles.textButton} onClick={() => navigate("exploration", route.id)}><Compass size={15} aria-hidden />{route.name}<ChevronRight size={14} aria-hidden /></button></li>)}
      {item.tradable && <li><button className={styles.textButton} onClick={() => navigate("market")}><Store size={15} aria-hidden />Предложения игроков<ChevronRight size={14} aria-hidden /></button></li>}
    </ul></div>
    <div><span className={styles.sectionLabel}>Для чего пригодится</span><ul className={styles.unlocks}>
      {ingredients.map(recipe => <li key={recipe.id}><button className={styles.textButton} onClick={() => navigate("production", recipe.buildingId)}><Hammer size={15} aria-hidden />{recipe.name} · нужно {number(recipe.cost.items[item.id])}<ChevronRight size={14} aria-hidden /></button></li>)}
      {buildings.map(building => <li key={building.id}><button className={styles.textButton} onClick={() => navigate("buildings", building.id)}><House size={15} aria-hidden />Стройка: {building.name}<ChevronRight size={14} aria-hidden /></button></li>)}
      {provisions.map(route => <li key={route.id}><button className={styles.textButton} onClick={() => navigate("exploration", route.id)}><Compass size={15} aria-hidden />Припасы: {route.name}<ChevronRight size={14} aria-hidden /></button></li>)}
    </ul>{item.tradable && <p className={styles.muted}>{state.catalog.localBuyer && state.catalog.localBuyer.payoutBps < 10_000
      ? `Быстрая продажа торговцу: ${number(state.catalog.localBuyer.payoutBps / 100)}% базовой цены, с округлением итоговой суммы вниз.`
      : `Можно продать торговцу по ${number(item.baseSellPrice)} монет за штуку.`} На рынке игроков вы назначаете цену сами.</p>}</div>
  </div>;
}

function Inventory({ economy, navigate, focusId }: { economy: ReadyEconomy; navigate: Navigate; focusId?: string }) {
  const { snapshot: state } = economy;
  const [selected, setSelected] = useState<string | null>(focusId ?? null);
  const [all, setAll] = useState(Boolean(focusId));
  const [category, setCategory] = useState("all");
  const categoryId = useId();
  const categories = [...new Set(state.catalog.items.map(item => item.category))];
  const owned = state.catalog.items.filter(item => (state.inventory[item.id] ?? 0) > 0);
  const items = (all ? state.catalog.items : owned).filter(item => category === "all" || category === item.category);
  const item = state.catalog.items.find(entry => entry.id === selected);
  return <div className={styles.stack}><div className={styles.heading}><div><h2>Ваши запасы</h2><p className={styles.muted}>Материалы пригодятся для строительства и производства. Выберите товар, чтобы увидеть, где его добывать и использовать.</p></div></div>
    <StorageStatus state={state} navigate={navigate} />
    <div className={styles.subnav} aria-label="Товары на складе"><button aria-pressed={!all} onClick={() => setAll(false)}>В наличии · {owned.length}</button><button aria-pressed={all} onClick={() => setAll(true)}>Все товары · {state.catalog.items.length}</button></div>
    <label className={styles.field} htmlFor={categoryId}>Категория<select id={categoryId} value={category} onChange={event => setCategory(event.target.value)}><option value="all">Все категории</option>{categories.map(value => <option key={value} value={value}>{categoryNames[value] ?? value}</option>)}</select></label>
    {items.length ? <div className={styles.stockGrid}>{items.map(entry => {
      return <button key={entry.id} aria-pressed={selected === entry.id} onClick={() => setSelected(entry.id)}><ItemIcon itemId={entry.id} size={23} /><span><strong>{entry.name}</strong><small>× {number(state.inventory[entry.id] ?? 0)}</small></span></button>;
    })}</div> : <div className={styles.empty}><Package size={32} aria-hidden /><h3>{owned.length ? "В этой категории пока пусто" : "Здесь будут ваши находки"}</h3><p className={styles.muted}>Вырастите урожай, отправьте Мохлика за сырьём или посмотрите источники товаров в каталоге.</p><button onClick={() => navigate("exploration")}>Выбрать вылазку<ArrowRight size={16} aria-hidden /></button><button onClick={() => { setAll(true); setCategory("all"); }}>Посмотреть все товары</button></div>}
    {item && <ItemGuide economy={economy} item={item} navigate={navigate} />}
    {item && item.tradable && (state.inventory[item.id] ?? 0) > 0 && <SellForm key={item.id} economy={economy} item={item} />}
    {item && !item.tradable && <p className={styles.hint}><LockKeyhole size={15} aria-hidden />Этот предмет нельзя продавать.</p>}
    <button className={styles.textButton} onClick={() => navigate("market")}><Store size={16} aria-hidden />Открыть рынок игроков<ArrowRight size={15} aria-hidden /></button>
  </div>;
}

function OfferCard({ economy, offer, owned, navigate }: { economy: ReadyEconomy; offer: EconomyMarketListing; owned?: boolean; navigate: Navigate }) {
  const { snapshot: state, busy, uncertain } = economy;
  const [confirm, setConfirm] = useState(false);
  const confirmation = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null), wasConfirming = useRef(false);
  useEffect(() => {
    if (confirm) confirmation.current?.focus({ preventScroll: true });
    else if (wasConfirming.current) trigger.current?.focus({ preventScroll: true });
    wasConfirming.current = confirm;
  }, [confirm]);
  const enough = state.wallet.coins >= offer.totalPrice, unlocked = canTrade(state), room = offer.quantity <= state.storage.available;
  const requiredHome = marketRequiredHomeLevel(offer.itemId, state.catalog);
  const itemUnlocked = marketItemUnlocked(state, offer.itemId, state.catalog);
  const oldPrice = offer.totalPrice < marketMinimumPrice(offer.itemId, offer.quantity, state.catalog);
  const expired = Boolean(economy.market?.showcase && economy.now >= Date.parse(economy.market.showcase.refreshAt));
  const disabled = busy || uncertain || (!owned && (!enough || !unlocked || !room || !itemUnlocked || oldPrice || expired));
  const label = `${itemName(state, offer.itemId)} × ${number(offer.quantity)}`;
  const actionLabel = owned ? "Вернуть на склад" : !unlocked ? "Рынок пока закрыт" : expired ? "Обновите витрину" : !itemUnlocked ? (Number.isFinite(requiredHome) ? `Нужен дом ${requiredHome} ур.` : "Товар пока недоступен") : oldPrice ? "Предложение недоступно" : !room ? "Не хватает места на складе" : enough ? "Купить весь лот" : "Не хватает монет";
  return <article className={`${styles.card} ${styles.offerCard}`} role="listitem" aria-label={label} data-market-offer={offer.id}>
    <div className={styles.cardHeader}><span className={styles.iconTile}><ItemIcon itemId={offer.itemId} size={22} /></span><div><h3>{label}</h3><p className={styles.offerSeller}>{owned ? "Ваш прилавок" : `Продавец: ${offer.sellerName}`}</p></div></div>
    <div className={styles.offerMeta}><span className={styles.offerPrice}><ItemIcon itemId="coins" size={16} />{number(offer.totalPrice)}<span className={styles.sr}> монет</span></span><span className={styles.offerPriceLabel}>за весь лот</span></div>
    <p className={styles.offerUnit}>{(offer.totalPrice / offer.quantity).toLocaleString("ru-RU", { maximumFractionDigits: 2 })} за шт. · {Number.isFinite(requiredHome) ? `Дом ${requiredHome}+` : "Пока недоступен"}</p>
    {owned && oldPrice && <p className={styles.hint}>Цена ниже нового минимума. Этот лот скрыт от покупателей: верните товар на склад и выставьте заново.</p>}
    {confirm ? <div ref={confirmation} className={styles.confirmation} role="group" tabIndex={-1} aria-label={`${owned ? "Возврат на склад" : "Подтверждение покупки"}: ${label}`}><p>{owned ? "Снять предложение и вернуть все предметы на склад?" : `Получите ${number(offer.quantity)} шт. за ${number(offer.totalPrice)} монет. Покупается весь лот.`}</p><div className={styles.actions}><button disabled={busy || uncertain} onClick={() => setConfirm(false)}>Назад</button><button className={styles.primary} disabled={disabled} aria-label={`${owned ? "Снять с продажи" : "Подтвердить покупку"}: ${label}${owned ? "" : ` за ${number(offer.totalPrice)} монет`}`} onClick={() => { if (disabled) return; if (owned) void economy.actMarket("cancel_listing", offer.id); else void economy.actMarket("buy_listing", offer.id, offer.quantity, offer.totalPrice); }}>{owned ? "Снять с продажи" : "Подтвердить покупку"}</button></div></div>
      : <button ref={trigger} disabled={disabled} aria-label={`${actionLabel}: ${label}${owned ? "" : ` за ${number(offer.totalPrice)} монет`}`} onClick={() => { if (!disabled) setConfirm(true); }}>{actionLabel}</button>}
    {!owned && !room && <div className={styles.hint}><Package size={15} aria-hidden /><div>Лот занимает {number(offer.quantity)} мест, свободно {number(state.storage.available)}.<br /><button className={styles.textButton} onClick={() => navigate("inventory")}>Освободить место<ArrowRight size={15} aria-hidden /></button></div></div>}
  </article>;
}

function ListingForm({ economy }: { economy: ReadyEconomy }) {
  const { snapshot: state, busy, uncertain } = economy;
  const items = state.catalog.items.filter(item => item.tradable && (state.inventory[item.id] ?? 0) > 0);
  const [selected, setSelected] = useState(items[0]?.id ?? "");
  const item = items.find(entry => entry.id === selected) ?? items[0];
  const itemId = useId();
  if (!item) return <div className={styles.empty}><ShoppingBasket size={32} aria-hidden /><h3>Пока нечего выставить</h3><p className={styles.muted}>Сначала заберите урожай или материалы. На прилавок попадут только выбранные вами товары.</p></div>;
  return <div className={styles.stack}><label className={styles.field} htmlFor={itemId}>Товар<select id={itemId} value={item.id} disabled={busy || uncertain} onChange={event => setSelected(event.target.value)}>{items.map(entry => <option key={entry.id} value={entry.id}>{entry.name} · есть {number(state.inventory[entry.id])}</option>)}</select></label>
    <ListingPriceForm key={item.id} economy={economy} item={item} />
  </div>;
}

function ListingPriceForm({ economy, item }: { economy: ReadyEconomy; item: Item }) {
  const { snapshot: state, busy, uncertain } = economy;
  const [amount, setAmount] = useState("1"), [price, setPrice] = useState(String(item.baseSellPrice * 2));
  const quantityId = useId(), priceId = useId();
  const limits = state.catalog.market;
  const quantity = integer(amount, Math.min(limits.maxLotQuantity, state.inventory[item.id] ?? 0));
  const maximum = quantity ? item.baseSellPrice * limits.maxPriceMultiplier * quantity : 0;
  const totalPrice = integer(price, maximum);
  const minimum = quantity ? marketMinimumPrice(item.id, quantity, state.catalog) : item.baseSellPrice;
  const valid = Boolean(quantity && totalPrice && totalPrice >= minimum);
  const full = (economy.market?.mine.length ?? 0) >= limits.maxListings;
  const disabled = !valid || full || busy || uncertain || !canTrade(state);
  return <div className={styles.card}>
    <div className={styles.fields}>
      <label className={styles.field} htmlFor={quantityId}>Количество<input id={quantityId} type="number" inputMode="numeric" min={1} max={Math.min(limits.maxLotQuantity, state.inventory[item.id] ?? 0)} step={1} value={amount} disabled={busy || uncertain} onChange={event => setAmount(event.target.value)} /></label>
      <label className={styles.field} htmlFor={priceId}>Цена всего лота<input id={priceId} type="number" inputMode="numeric" min={minimum} max={maximum || undefined} step={1} value={price} disabled={busy || uncertain} onChange={event => setPrice(event.target.value)} /></label>
    </div>
    <p className={styles.muted}>{quantity ? `Допустимая цена: ${number(minimum)}–${number(maximum)} монет за ${number(quantity)} шт.` : `До ${limits.maxLotQuantity} предметов в одном предложении.`}</p>
    <p className={styles.hint}><Package size={15} aria-hidden />Выставленные предметы сохраняют место на складе до продажи. Отмена вернёт их; выставление лота само по себе не освобождает склад.</p>
    <button className={styles.primary} disabled={disabled} onClick={() => { if (!disabled && quantity && totalPrice) void economy.actMarket("create_listing", item.id, quantity, totalPrice); }}><Store size={17} aria-hidden />{full ? `Все ${limits.maxListings} мест заняты` : `Выставить за ${valid ? number(totalPrice!) : "—"} монет`}</button>
  </div>;
}

function Market({ economy, navigate }: { economy: ReadyEconomy; navigate: Navigate }) {
  const [section, setSection] = useState<"browse" | "sell" | "mine">("browse");
  const { snapshot: state, market, marketError, busy, uncertain } = economy;
  const unlocked = canTrade(state), limits = state.catalog.market;
  const showcase = market?.showcase;
  const refreshIn = showcase ? Math.max(0, Math.ceil((Date.parse(showcase.refreshAt) - economy.now) / 1000)) : null;
  const refreshLabel = refreshIn === 0 ? "Обновить витрину" : "Проверить наличие";
  const refreshMarket = economy.refreshMarket;
  useEffect(() => { void refreshMarket(); }, [refreshMarket]);
  return <div className={`${styles.stack} ${styles.market}`} aria-label="Лесной рынок">
    <StorageStatus state={state} navigate={navigate} compact condensed />
    <nav className={styles.subnav} aria-label="Раздел рынка"><button aria-pressed={section === "browse"} onClick={() => setSection("browse")}>Купить</button><button aria-pressed={section === "sell"} onClick={() => setSection("sell")}>Продать</button><button aria-pressed={section === "mine"} onClick={() => setSection("mine")}>Мои лоты{market?.mine.length ? ` · ${market.mine.length}` : ""}</button></nav>
    {!unlocked && <div className={styles.notice}><LockKeyhole size={18} aria-hidden /><div><p>Торговля с игроками откроется после обустройства дома и первой разведки.</p><p className={styles.muted}>Дом: {state.buildings.home ?? 1} / {limits.requiredHomeLevel} ур. · Завершённые вылазки: {Math.min(state.completedExplorations, limits.requiredExplorations)} / {limits.requiredExplorations}</p><button onClick={() => navigate((state.buildings.home ?? 1) < limits.requiredHomeLevel ? "buildings" : "exploration")}>Продолжить обустройство<ArrowRight size={15} aria-hidden /></button><p className={styles.muted}>Местный торговец уже покупает товары в разделе «Склад».</p></div></div>}
    {marketError && <div role="alert" className={styles.notice} data-kind="error"><CircleHelp size={18} aria-hidden /><div><p>{marketError}</p><button disabled={busy || uncertain} onClick={() => void refreshMarket()}>Обновить рынок</button></div></div>}
    {!market && !marketError && <p className={styles.muted} role="status">Открываем прилавки…</p>}
    {market && section === "browse" && <>
      <div className={styles.showcaseInfo}><div><strong>Ваша витрина · {market.listings.length} / {showcase?.slots ?? limits.showcaseSlots}</strong>
        {unlocked && refreshIn !== null && <p className={styles.muted}>{refreshIn > 0 ? `Смена через ${economyDuration(refreshIn)}` : "Доступна новая витрина"}</p>}
      </div><button disabled={busy || uncertain} onClick={() => void refreshMarket()}><RefreshCw size={14} aria-hidden />{refreshLabel}</button></div>
      <details className={styles.marketRules}><summary>Как обновляются предложения</summary><p>До {showcase?.maxPerSeller ?? limits.showcasePerSeller} лотов от одной лавки. Новая подборка раз в {economyDuration(showcase?.refreshSeconds ?? limits.showcaseRefreshSeconds)}. Купленные и снятые лоты до смены не заменяются.</p></details>
      {market.listings.length ? <div className={styles.shopGrid} role="list" aria-label="Предложения игроков">{market.listings.map(offer => <OfferCard key={offer.id} economy={economy} offer={offer} navigate={navigate} />)}</div>
        : <div className={styles.empty}><Store size={32} aria-hidden /><h3>Прилавки пока свободны</h3><p className={styles.muted}>В вашей подборке нет доступных лотов. Предложения могли закончиться или пока не появиться. Новые товары попадут в следующую витрину.</p><button disabled={!unlocked} onClick={() => setSection("sell")}>Выставить товар</button></div>}
    </>}
    {market && (section === "sell" || section === "mine") && <p className={styles.marketNote}><strong>Ваша лавка · {market.mine.length} / {limits.maxListings}</strong><span>Новые лоты появятся у покупателей при смене витрины.</span></p>}
    {market && section === "sell" && unlocked && <ListingForm economy={economy} />}
    {market && section === "mine" && (market.mine.length ? <div className={styles.shopGrid} role="list" aria-label="Ваши предложения">{market.mine.map(offer => <OfferCard key={offer.id} economy={economy} offer={offer} navigate={navigate} owned />)}</div>
      : <div className={styles.empty}><ShoppingBasket size={32} aria-hidden /><h3>У вас ещё нет предложений</h3><p className={styles.muted}>Выберите товар и цену. После покупки монеты поступят в кошелёк.</p><button onClick={() => setSection("sell")}>Выставить товар</button></div>)}
  </div>;
}

/** Account-owned controller survives closing this body; the caller owns the accessible dialog. */
export function EconomyPanel({ economy, initialTab = "overview", initialFocusId, standalone = false, onNavigate }: { economy: EconomyController; initialTab?: EconomyTab; initialFocusId?: string; standalone?: boolean; onNavigate?: Navigate }) {
  const [tab, setTab] = useState<EconomyTab>(initialTab);
  const [focusId, setFocusId] = useState<string | undefined>(initialFocusId);
  const panel = useRef<HTMLElement>(null);
  const { snapshot, error, notice, busy, uncertain, now, retryAt } = economy;
  const cooldown = Math.max(0, Math.ceil((retryAt - now) / 1000));
  const controller = snapshot ? { ...economy, snapshot, busy: busy || cooldown > 0 } : null;
  const navigate: Navigate = (next, target) => {
    if (standalone && next !== initialTab && onNavigate) { onNavigate(next, target); return; }
    setTab(next);
    setFocusId(target);
    // The dialog supplies the scrolling body; a new section starts at its top.
    const scrollBody = panel.current?.parentElement;
    if (scrollBody && scrollBody.scrollHeight > scrollBody.clientHeight) scrollBody.scrollTop = 0;
  };
  return <section ref={panel} className={styles.panel} aria-label={standalone && initialTab === "market" ? "Рынок между игроками" : "Хозяйство Мохлика"} aria-busy={busy}>
    {snapshot && !standalone && <EconomyBalances wallet={snapshot.wallet} />}
    {!standalone && <nav className={styles.navigation} aria-label="Разделы хозяйства">{tabs.map(({ id, label, Icon }) => <button key={id} aria-current={tab === id ? "page" : undefined} onClick={() => navigate(id)}><Icon size={16} aria-hidden />{label}</button>)}</nav>}
    {(error || uncertain) && <div className={styles.notice} data-kind={uncertain ? "pending" : "error"} role="alert"><CircleHelp size={18} aria-hidden /><div><p>{uncertain ? "Проверяем последнее действие. Новые операции станут доступны после подтверждения." : error}</p><button disabled={busy || cooldown > 0} onClick={() => void economy.retry()}>{cooldown ? `Повторить через ${cooldown} с` : uncertain ? "Проверить результат" : "Попробовать ещё раз"}</button></div></div>}
    {!standalone && notice && !error && !uncertain && <p role="status" className={styles.notice}><Check size={18} aria-hidden />{notice}</p>}
    {!controller ? !error && <div className={styles.stack} role="status"><p className={styles.muted}>Открываем ваше хозяйство…</p><div className={styles.skeleton} aria-hidden /><div className={styles.skeleton} aria-hidden /></div>
      : <div className={styles.stack} key={tab}>
        {tab === "overview" && <Overview economy={controller} navigate={navigate} />}
        {tab === "buildings" && <Buildings economy={controller} navigate={navigate} focusId={focusId} />}
        {tab === "production" && <Production economy={controller} navigate={navigate} focusId={focusId} />}
        {tab === "exploration" && <Exploration economy={controller} navigate={navigate} focusId={focusId} />}
        {tab === "inventory" && <Inventory economy={controller} navigate={navigate} focusId={focusId} />}
        {tab === "market" && <Market economy={controller} navigate={navigate} />}
      </div>}
  </section>;
}
