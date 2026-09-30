"use client";

import { useEffect, useId, useRef, useState } from "react";
import { ArrowRight, Check, ChevronRight, CircleHelp, Clock3, Coins, Compass, Fish, Flame, Gem, Hammer, House, Leaf, LockKeyhole, Mountain, Package, RefreshCw, Shell, ShoppingBasket, Sprout, Store, Trees, Wheat } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { EconomyCost, EconomyJob, EconomyMarketListing, EconomyView } from "./model";
import type { EconomyController } from "./use-economy";
import { canAffordEconomy } from "./rules";
import styles from "./economy-panel.module.css";

export type EconomyTab = "overview" | "buildings" | "production" | "exploration" | "market" | "inventory";
type ReadyEconomy = EconomyController & { snapshot: EconomyView };
type Recipe = EconomyView["catalog"]["recipes"][number];
type Item = EconomyView["catalog"]["items"][number];
type Building = EconomyView["catalog"]["buildings"][number];
const tabs: { id: EconomyTab; label: string; Icon: LucideIcon }[] = [
  { id: "overview", label: "Обзор", Icon: Sprout },
  { id: "buildings", label: "Постройки", Icon: House },
  { id: "production", label: "Производство", Icon: Hammer },
  { id: "exploration", label: "Вылазки", Icon: Compass },
  { id: "market", label: "Рынок", Icon: Store },
  { id: "inventory", label: "Склад", Icon: Package },
];
const itemIcons: Record<string, LucideIcon> = { berries: Sprout, wood: Trees, stone: Mountain, ore: Gem, fiber: Wheat, fish: Fish, planks: Trees, rope: Wheat, metal_parts: Hammer, dried_berries: Leaf, smoked_fish: Fish };
const buildingIcons: Record<string, LucideIcon> = { home: House, garden: Sprout, woodlot: Trees, quarry: Mountain, workshop: Hammer, dryer: Flame };
const itemName = (state: EconomyView, id: string) => state.catalog.items.find(item => item.id === id)?.name ?? "Предмет";
const buildingName = (state: EconomyView, id: string) => state.catalog.buildings.find(building => building.id === id)?.name ?? "Постройка";
const number = (value: number) => value.toLocaleString("ru-RU");
const canTrade = (state: EconomyView) => (state.buildings.home ?? 1) >= state.catalog.market.requiredHomeLevel && state.completedExplorations >= state.catalog.market.requiredExplorations;

export function economyDuration(seconds: number) {
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  if (minutes < 60) return `${minutes} мин`;
  const hours = Math.floor(minutes / 60), rest = minutes % 60;
  return `${hours} ч${rest ? ` ${rest} мин` : ""}`;
}

function integer(value: string, maximum: number) {
  if (!/^\d+$/.test(value)) return null;
  const result = Number(value);
  return Number.isSafeInteger(result) && result >= 1 && result <= maximum ? result : null;
}

export function EconomyBalances({ wallet }: { wallet: EconomyView["wallet"] }) {
  return <div className={styles.wallet} aria-label="Кошелёк">
    <span><Coins size={18} aria-hidden /><strong>{number(wallet.coins)}</strong><span className={styles.walletLabel}>монет</span><span className={styles.sr}>Монеты: {number(wallet.coins)}</span></span>
    <span title="Жемчуг — будущая валюта для особого оформления. Покупка пока недоступна."><Shell size={17} aria-hidden /><strong>{number(wallet.pearls)}</strong><span className={styles.walletLabel}>жемчуг</span><span className={styles.sr}>Жемчуг: {number(wallet.pearls)}. Покупка пока недоступна.</span></span>
  </div>;
}

function Cost({ state, cost, quantity = 1 }: { state: EconomyView; cost: EconomyCost; quantity?: number }) {
  const entries = Object.entries(cost.items);
  if (!cost.coins && !entries.length) return <p className={styles.hint}><Leaf size={14} aria-hidden />Без затрат</p>;
  return <div><span className={styles.sectionLabel}>Потребуется</span><ul className={styles.costs} aria-label="Стоимость">
    {cost.coins > 0 && <li data-missing={state.wallet.coins < cost.coins * quantity}><Coins size={14} aria-hidden />{number(cost.coins * quantity)} монет<span className={styles.sr}>; есть {number(state.wallet.coins)}</span></li>}
    {entries.map(([id, amount]) => {
      const Icon = itemIcons[id] ?? Package, available = state.inventory[id] ?? 0, required = amount * quantity;
      return <li key={id} data-missing={available < required}><Icon size={14} aria-hidden />{itemName(state, id)}: {number(available)} / {number(required)}<span className={styles.sr}>{available < required ? "; не хватает" : "; достаточно"}</span></li>;
    })}
  </ul></div>;
}

function Rewards({ state, value, quantity = 1 }: { state: EconomyView; value: Record<string, number>; quantity?: number }) {
  return <ul className={styles.rewards} aria-label="Результат">{Object.entries(value).map(([id, amount]) => {
    const Icon = itemIcons[id] ?? Package;
    return <li key={id}><Icon size={14} aria-hidden />{itemName(state, id)} × {number(amount * quantity)}</li>;
  })}</ul>;
}

function jobTitle(state: EconomyView, job: EconomyJob) {
  if (job.kind === "construction") return `${buildingName(state, job.targetId)} · уровень ${job.targetLevel}`;
  if (job.kind === "exploration") return state.catalog.explorations.find(entry => entry.id === job.targetId)?.name ?? "Вылазка Мохлика";
  return state.catalog.recipes.find(entry => entry.id === job.recipeId)?.name ?? "Производство";
}

function JobCard({ economy, job }: { economy: ReadyEconomy; job: EconomyJob }) {
  const { snapshot: state, now, busy, uncertain } = economy;
  const start = Date.parse(job.startedAt), end = Date.parse(job.finishesAt), ready = now >= end;
  const progress = Math.min(1, Math.max(0, (now - start) / Math.max(1, end - start)));
  const Icon = job.kind === "construction" ? Hammer : job.kind === "exploration" ? Compass : Sprout;
  const caption = job.kind === "construction" ? "Строительство" : job.kind === "exploration" ? "Мохлик в пути" : buildingName(state, job.targetId);
  return <article className={styles.card} data-ready={ready}>
    <div className={styles.cardHeader}><span className={styles.iconTile}><Icon size={21} aria-hidden /></span><div><span className={styles.eyebrow}>{ready ? "Готово" : caption}</span><h3>{jobTitle(state, job)}</h3></div></div>
    {Object.keys(job.rewards).length > 0 && <Rewards state={state} value={job.rewards} />}
    {!ready && <progress className={styles.progress} value={progress} max={1} aria-label={`${jobTitle(state, job)}: выполнено ${Math.floor(progress * 100)}%`} />}
    <div className={styles.jobFooter}>
      <span className={styles.duration}>{ready ? <Check size={15} aria-hidden /> : <Clock3 size={15} aria-hidden />}{ready ? "Можно забрать" : `Ещё ${economyDuration((end - now) / 1000)}`}</span>
      <button className={ready ? styles.primary : undefined} disabled={!ready || busy || uncertain} onClick={() => void economy.act("claim_job", job.id)}>
        {job.kind === "construction" ? "Завершить" : "Забрать"}<span className={styles.sr}>: {jobTitle(state, job)}</span>
      </button>
    </div>
    {job.kind === "construction" && !ready && <p className={styles.muted}>Материалы уже внесены. Прежний уровень продолжает действовать.</p>}
  </article>;
}

function Overview({ economy, navigate }: { economy: ReadyEconomy; navigate: (tab: EconomyTab) => void }) {
  const { snapshot: state, now } = economy;
  const ready = state.jobs.filter(job => Date.parse(job.finishesAt) <= now).length;
  const jobs = [...state.jobs].sort((a, b) => Date.parse(a.finishesAt) - Date.parse(b.finishesAt));
  const owned = Object.values(state.buildings).filter(level => level > 0).length;
  const stock = Object.values(state.inventory).reduce((sum, amount) => sum + amount, 0);
  const migration = state.migration;
  return <div className={styles.stack}>
    <div className={styles.heading}><div><span className={styles.eyebrow}>Своя жизнь в лесу</span><h2>{ready ? "Пора забрать результаты" : "Хозяйство Мохлика"}</h2><p className={styles.muted}>Постройки работают параллельно. Мохлик отправляется в одну вылазку за раз.</p></div></div>
    <div className={styles.shortcuts}>
      <button onClick={() => navigate("production")}><Sprout size={22} aria-hidden /><span><strong>Производство</strong><small>Урожай и материалы</small></span><ChevronRight size={14} aria-hidden /></button>
      <button onClick={() => navigate("exploration")}><Compass size={22} aria-hidden /><span><strong>Вылазки</strong><small>{state.jobs.some(job => job.kind === "exploration") ? "Мохлик занят" : "Можно отправляться"}</small></span><ChevronRight size={14} aria-hidden /></button>
      <button onClick={() => navigate("buildings")}><House size={22} aria-hidden /><span><strong>Постройки</strong><small>Обустроено: {owned}</small></span><ChevronRight size={14} aria-hidden /></button>
      <button onClick={() => navigate("inventory")}><Package size={22} aria-hidden /><span><strong>Склад</strong><small>Предметов: {number(stock)}</small></span><ChevronRight size={14} aria-hidden /></button>
    </div>
    {jobs.length ? <div className={styles.stack} aria-label="Текущие дела">{jobs.map(job => <JobCard key={job.id} economy={economy} job={job} />)}</div>
      : <div className={styles.empty}><Sprout size={32} aria-hidden /><h3>Начните с маленького урожая</h3><p className={styles.muted}>Вырастите ягоды в саду и отправьте Мохлика за материалами. Монеты можно получить за товары на складе.</p><button className={styles.primary} onClick={() => navigate("production")}>Открыть производство<ArrowRight size={16} aria-hidden /></button></div>}
    <p className={styles.hint}><Clock3 size={15} aria-hidden />Дела продолжаются после выхода. Готовые результаты ждут вас и не портятся.</p>
    {(migration.coinsGranted > 0 || migration.woodGranted > 0 || migration.stoneGranted > 0) && <details className={styles.details}><summary>Прежние запасы перенесены</summary><p>Однократно получено: {number(migration.coinsGranted)} монет, {number(migration.woodGranted)} древесины и {number(migration.stoneGranted)} камня. Уже полученные улучшения сохранены.</p></details>}
    <details className={styles.details}><summary>Для чего нужен жемчуг?</summary><p>Готовим особое оформление за жемчуг. Его покупка пока недоступна. Для нынешних построек нужны монеты и материалы.</p></details>
  </div>;
}

function BuildingCard({ economy, building }: { economy: ReadyEconomy; building: Building }) {
  const { snapshot: state, busy, uncertain } = economy;
  const level = state.buildings[building.id] ?? 0, next = building.levels.find(entry => entry.level === level + 1);
  const ownJob = state.jobs.find(job => job.kind === "construction" && job.targetId === building.id);
  const construction = state.jobs.some(job => job.kind === "construction");
  const production = state.jobs.some(job => job.kind === "production" && job.targetId === building.id);
  const homeLevel = state.buildings.home ?? 1;
  const reason = !next ? "Доступные улучшения завершены" : homeLevel < next.requiredHomeLevel ? `Нужен дом уровня ${next.requiredHomeLevel}`
    : construction ? "Сначала завершите текущую стройку" : production ? "Сначала заберите готовую продукцию" : !canAffordEconomy(state, next.cost) ? "Не хватает монет или материалов" : null;
  const Icon = buildingIcons[building.id] ?? House;
  if (ownJob) return <JobCard economy={economy} job={ownJob} />;
  return <article className={styles.card}>
    <div className={styles.cardHeader}><span className={styles.iconTile}><Icon size={22} aria-hidden /></span><div><h3>{building.name}</h3><p className={styles.muted}>{building.description}</p></div><span className={styles.level}>{level ? `Ур. ${level}` : "Проект"}</span></div>
    {next && <Cost state={state} cost={next.cost} />}
    <div className={styles.actions}>{next && <span className={styles.duration}><Clock3 size={14} aria-hidden />{economyDuration(next.seconds)}</span>}
      <button className={styles.primary} disabled={Boolean(reason) || busy || uncertain} onClick={() => void economy.act("start_construction", building.id)}>{next ? level ? `Улучшить до ур. ${next.level}` : "Построить" : "Всё улучшено"}<span className={styles.sr}>: {building.name}</span></button>
    </div>
    {reason && <p className={styles.hint}>{!next ? <Check size={14} aria-hidden /> : <LockKeyhole size={14} aria-hidden />}{reason}</p>}
  </article>;
}

function Buildings({ economy }: { economy: ReadyEconomy }) {
  return <div className={styles.stack}><div className={styles.heading}><div><h2>Обустроить поляну</h2><p className={styles.muted}>Монеты, материалы и немного времени. Одновременно идёт одна стройка.</p></div></div>
    {economy.snapshot.catalog.buildings.map(building => <BuildingCard key={building.id} economy={economy} building={building} />)}
  </div>;
}

function RecipeCard({ economy, recipe }: { economy: ReadyEconomy; recipe: Recipe }) {
  const { snapshot: state, busy, uncertain } = economy;
  const [quantity, setQuantity] = useState(1);
  const inputId = useId();
  const homeLevel = state.buildings.home ?? 1, level = state.buildings[recipe.buildingId] ?? 0;
  const occupied = state.jobs.some(job => (job.kind === "production" || job.kind === "construction") && job.targetId === recipe.buildingId);
  const reason = level < recipe.buildingLevel ? `${buildingName(state, recipe.buildingId)}: нужен уровень ${recipe.buildingLevel}`
    : homeLevel < recipe.requiredHomeLevel ? `Нужен дом уровня ${recipe.requiredHomeLevel}` : occupied ? "Здание занято текущим заказом" : !canAffordEconomy(state, recipe.cost, quantity) ? "Не хватает ингредиентов" : null;
  const choices = [...new Set([1, 3, 5, state.catalog.maxBatch])].filter(count => count <= state.catalog.maxBatch).sort((a, b) => a - b);
  return <article className={styles.card}><h3>{recipe.name}</h3>
    <Rewards state={state} value={recipe.rewards} quantity={quantity} />
    <Cost state={state} cost={recipe.cost} quantity={quantity} />
    <label className={styles.field} htmlFor={inputId}>Размер заказа<select id={inputId} value={quantity} disabled={busy || uncertain} onChange={event => setQuantity(Number(event.target.value))}>{choices.map(count => <option key={count} value={count}>{count} {count === 1 ? "партия" : count < 5 ? "партии" : "партий"} · {economyDuration(recipe.seconds * count)}</option>)}</select></label>
    <button className={`${styles.primary} ${styles.wide}`} disabled={Boolean(reason) || busy || uncertain} onClick={() => void economy.act("start_production", recipe.id, quantity)}>Начать · {economyDuration(recipe.seconds * quantity)}<span className={styles.sr}>: {recipe.name}</span></button>
    {reason && <p className={styles.hint}><LockKeyhole size={14} aria-hidden />{reason}</p>}
  </article>;
}

function Production({ economy, navigate }: { economy: ReadyEconomy; navigate: (tab: EconomyTab) => void }) {
  const { snapshot: state } = economy;
  const stations = state.catalog.buildings.filter(building => state.catalog.recipes.some(recipe => recipe.buildingId === building.id));
  const [station, setStation] = useState(() => stations.find(building => (state.buildings[building.id] ?? 0) > 0)?.id ?? stations[0]?.id ?? "");
  const selectId = useId();
  const job = state.jobs.find(entry => entry.kind === "production" && entry.targetId === station);
  return <div className={styles.stack}><div className={styles.heading}><div><h2>Лесное хозяйство</h2><p className={styles.muted}>У каждого здания свой заказ. Все партии забираются вместе после его завершения.</p></div></div>
    <label className={styles.field} htmlFor={selectId}>Выберите место<select id={selectId} value={station} onChange={event => setStation(event.target.value)}>{stations.map(building => <option key={building.id} value={building.id}>{building.name} · {(state.buildings[building.id] ?? 0) > 0 ? `ур. ${state.buildings[building.id]}` : "не построено"}</option>)}</select></label>
    {job && <JobCard economy={economy} job={job} />}
    {!(state.buildings[station] > 0) && <div className={styles.notice}><House size={18} aria-hidden /><div><p>Сначала обустройте это место.</p><button onClick={() => navigate("buildings")}>К постройкам<ArrowRight size={15} aria-hidden /></button></div></div>}
    {state.catalog.recipes.filter(recipe => recipe.buildingId === station).map(recipe => <RecipeCard key={recipe.id} economy={economy} recipe={recipe} />)}
  </div>;
}

function Exploration({ economy }: { economy: ReadyEconomy }) {
  const { snapshot: state, busy, uncertain } = economy;
  const job = state.jobs.find(entry => entry.kind === "exploration");
  return <div className={styles.stack}><div className={styles.heading}><div><h2>Мохлик-исследователь</h2><p className={styles.muted}>Выберите цель вылазки. Производство продолжится, пока Мохлик в пути.</p></div></div>
    {job && <JobCard economy={economy} job={job} />}
    {state.catalog.explorations.map(exploration => {
      const reason = (state.buildings.home ?? 1) < exploration.requiredHomeLevel ? `Нужен дом уровня ${exploration.requiredHomeLevel}` : job ? "Сначала завершите текущую вылазку" : !canAffordEconomy(state, exploration.cost) ? "Не хватает припасов" : null;
      const Icon = exploration.id.includes("cave") ? Mountain : exploration.id === "shore" ? Fish : Compass;
      return <article key={exploration.id} className={styles.card}><div className={styles.cardHeader}><span className={styles.iconTile}><Icon size={22} aria-hidden /></span><div><h3>{exploration.name}</h3><p className={styles.muted}>{exploration.description}</p></div></div>
        <Rewards state={state} value={exploration.rewards} /><Cost state={state} cost={exploration.cost} />
        <div className={styles.actions}><span className={styles.duration}><Clock3 size={14} aria-hidden />{economyDuration(exploration.seconds)}</span><button className={styles.primary} disabled={Boolean(reason) || busy || uncertain} onClick={() => void economy.act("start_exploration", exploration.id)}>Отправиться<span className={styles.sr}>: {exploration.name}</span></button></div>
        {reason && <p className={styles.hint}><LockKeyhole size={14} aria-hidden />{reason}</p>}
      </article>;
    })}
  </div>;
}

function SellForm({ economy, item }: { economy: ReadyEconomy; item: Item }) {
  const { snapshot: state, busy, uncertain } = economy;
  const [value, setValue] = useState("1");
  const inputId = useId(), stock = state.inventory[item.id] ?? 0, maximum = Math.min(10_000, stock), quantity = integer(value, maximum);
  return <div className={styles.card}><h3>Продать торговцу: {item.name.toLocaleLowerCase("ru-RU")}</h3><p className={styles.muted}>Торговец покупает сразу по {number(item.baseSellPrice)} монет за штуку. На прилавке можно предложить свою цену другим игрокам.</p>
    <label className={styles.field} htmlFor={inputId}>Количество · на складе {number(stock)}<input id={inputId} type="number" inputMode="numeric" min={1} max={maximum} step={1} value={value} disabled={busy || uncertain} onChange={event => setValue(event.target.value)} /></label>
    <button className={styles.primary} disabled={!quantity || busy || uncertain} onClick={() => { if (quantity) void economy.act("sell", item.id, quantity); }}><Coins size={16} aria-hidden />Продать {quantity ?? "—"} шт. за {quantity ? number(quantity * item.baseSellPrice) : "—"} монет</button>
    {!quantity && <p className={styles.hint}>Укажите целое количество от 1 до {number(maximum)}.</p>}
  </div>;
}

function Inventory({ economy, navigate }: { economy: ReadyEconomy; navigate: (tab: EconomyTab) => void }) {
  const { snapshot: state } = economy;
  const [selected, setSelected] = useState<string | null>(null);
  const items = state.catalog.items.filter(item => (state.inventory[item.id] ?? 0) > 0);
  const item = items.find(entry => entry.id === selected);
  return <div className={styles.stack}><div className={styles.heading}><div><h2>Ваши запасы</h2><p className={styles.muted}>Материалы пригодятся для строительства и производства. Излишки можно продать.</p></div></div>
    {items.length ? <div className={styles.stockGrid}>{items.map(entry => {
      const Icon = itemIcons[entry.id] ?? Package;
      return <button key={entry.id} aria-pressed={selected === entry.id} onClick={() => setSelected(entry.id)}><Icon size={23} aria-hidden /><span><strong>{entry.name}</strong><small>× {number(state.inventory[entry.id])}</small></span></button>;
    })}</div> : <div className={styles.empty}><Package size={32} aria-hidden /><h3>Здесь будут ваши находки</h3><p className={styles.muted}>Вырастите первый урожай или отправьте Мохлика в бесплатную лесную разведку.</p><button onClick={() => navigate("exploration")}>Выбрать вылазку<ArrowRight size={16} aria-hidden /></button></div>}
    {item ? <SellForm key={item.id} economy={economy} item={item} /> : items.length > 0 && <p className={styles.hint}><CircleHelp size={15} aria-hidden />Выберите предмет, чтобы продать его торговцу.</p>}
    <button className={styles.textButton} onClick={() => navigate("market")}><Store size={16} aria-hidden />Открыть рынок игроков<ArrowRight size={15} aria-hidden /></button>
  </div>;
}

function OfferCard({ economy, offer, owned }: { economy: ReadyEconomy; offer: EconomyMarketListing; owned?: boolean }) {
  const { snapshot: state, busy, uncertain } = economy;
  const [confirm, setConfirm] = useState(false);
  const Icon = itemIcons[offer.itemId] ?? Package, enough = state.wallet.coins >= offer.totalPrice, unlocked = canTrade(state);
  return <article className={styles.card}>
    <div className={styles.cardHeader}><span className={styles.iconTile}><Icon size={22} aria-hidden /></span><div><h3>{itemName(state, offer.itemId)} × {number(offer.quantity)}</h3><p className={styles.muted}>{owned ? "Ваш прилавок" : `Продавец: ${offer.sellerName}`}</p></div></div>
    <div className={styles.offerMeta}><span className={styles.offerPrice}><Coins size={18} aria-hidden />{number(offer.totalPrice)}<span className={styles.sr}>монет за весь лот</span></span><span className={styles.muted}>за весь лот</span></div>
    {confirm ? <div className={styles.confirmation}><p>{owned ? "Снять предложение и вернуть все предметы на склад?" : `Получите ${number(offer.quantity)} шт. за ${number(offer.totalPrice)} монет. Покупается весь лот.`}</p><div className={styles.actions}><button disabled={busy || uncertain} onClick={() => setConfirm(false)}>Назад</button><button className={styles.primary} disabled={busy || uncertain || (!owned && (!enough || !unlocked))} onClick={() => { if (owned) economy.actMarket("cancel_listing", offer.id); else economy.actMarket("buy_listing", offer.id, offer.quantity, offer.totalPrice); }}>{owned ? "Снять с продажи" : "Подтвердить покупку"}</button></div></div>
      : <button disabled={busy || uncertain || (!owned && (!enough || !unlocked))} onClick={() => setConfirm(true)}>{owned ? "Вернуть на склад" : !unlocked ? "Рынок пока закрыт" : enough ? "Купить весь лот" : "Не хватает монет"}</button>}
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
  const valid = Boolean(quantity && totalPrice && totalPrice >= quantity);
  const full = (economy.market?.mine.length ?? 0) >= limits.maxListings;
  return <div className={styles.card}>
    <div className={styles.fields}>
      <label className={styles.field} htmlFor={quantityId}>Количество<input id={quantityId} type="number" inputMode="numeric" min={1} max={Math.min(limits.maxLotQuantity, state.inventory[item.id] ?? 0)} step={1} value={amount} disabled={busy || uncertain} onChange={event => setAmount(event.target.value)} /></label>
      <label className={styles.field} htmlFor={priceId}>Цена всего лота<input id={priceId} type="number" inputMode="numeric" min={quantity ?? 1} max={maximum || undefined} step={1} value={price} disabled={busy || uncertain} onChange={event => setPrice(event.target.value)} /></label>
    </div>
    <p className={styles.muted}>{quantity ? `Допустимая цена: ${number(quantity)}–${number(maximum)} монет за ${number(quantity)} шт.` : `До ${limits.maxLotQuantity} предметов в одном предложении.`}</p>
    <p className={styles.hint}><Package size={15} aria-hidden />Выставленные предметы хранятся на прилавке. Их можно вернуть, пока лот не купили.</p>
    <button className={styles.primary} disabled={!valid || full || busy || uncertain || !canTrade(state)} onClick={() => { if (quantity && totalPrice) void economy.actMarket("create_listing", item.id, quantity, totalPrice); }}><Store size={17} aria-hidden />{full ? `Все ${limits.maxListings} мест заняты` : `Выставить за ${valid ? number(totalPrice!) : "—"} монет`}</button>
  </div>;
}

function Market({ economy, navigate }: { economy: ReadyEconomy; navigate: (tab: EconomyTab) => void }) {
  const [section, setSection] = useState<"browse" | "sell" | "mine">("browse");
  const { snapshot: state, market, marketError, busy, uncertain } = economy;
  const unlocked = canTrade(state), limits = state.catalog.market;
  const refreshMarket = economy.refreshMarket;
  useEffect(() => { void refreshMarket(); }, [refreshMarket]);
  return <div className={styles.stack}><div className={styles.heading}><div><h2>Лесной рынок</h2><p className={styles.muted}>Покупайте у других игроков и выставляйте свои товары за монеты.</p></div><button aria-label="Обновить прилавки" disabled={busy || uncertain} onClick={() => void refreshMarket()}><RefreshCw size={17} aria-hidden /></button></div>
    <nav className={styles.subnav} aria-label="Раздел рынка"><button aria-pressed={section === "browse"} onClick={() => setSection("browse")}>Купить</button><button aria-pressed={section === "sell"} onClick={() => setSection("sell")}>Продать</button><button aria-pressed={section === "mine"} onClick={() => setSection("mine")}>Мои лоты{market?.mine.length ? ` · ${market.mine.length}` : ""}</button></nav>
    {!unlocked && <div className={styles.notice}><LockKeyhole size={18} aria-hidden /><div><p>Торговля с игроками откроется после обустройства дома и первой разведки.</p><p className={styles.muted}>Дом: {state.buildings.home ?? 1} / {limits.requiredHomeLevel} ур. · Завершённые вылазки: {Math.min(state.completedExplorations, limits.requiredExplorations)} / {limits.requiredExplorations}</p><button onClick={() => navigate((state.buildings.home ?? 1) < limits.requiredHomeLevel ? "buildings" : "exploration")}>Продолжить обустройство<ArrowRight size={15} aria-hidden /></button><p className={styles.muted}>Местный торговец уже покупает товары в разделе «Склад».</p></div></div>}
    {marketError && <div role="alert" className={styles.notice} data-kind="error"><CircleHelp size={18} aria-hidden /><div><p>{marketError}</p><button disabled={busy || uncertain} onClick={() => void refreshMarket()}>Обновить рынок</button></div></div>}
    {!market && !marketError && <p className={styles.muted} role="status">Открываем прилавки…</p>}
    {market && section === "browse" && (market.listings.length ? <div className={styles.stack}>{market.listings.map(offer => <OfferCard key={offer.id} economy={economy} offer={offer} />)}{market.nextCursor && <button disabled={busy || uncertain} onClick={() => void refreshMarket(market.nextCursor!)}>Показать ещё</button>}</div>
      : <div className={styles.empty}><Store size={32} aria-hidden /><h3>Прилавки пока свободны</h3><p className={styles.muted}>Здесь появятся предложения других игроков. Вы можете первым выставить свои запасы.</p><button onClick={() => setSection("sell")}>Выставить товар</button></div>)}
    {market && section === "sell" && unlocked && <ListingForm economy={economy} />}
    {market && section === "mine" && (market.mine.length ? <div className={styles.stack}>{market.mine.map(offer => <OfferCard key={offer.id} economy={economy} offer={offer} owned />)}</div>
      : <div className={styles.empty}><ShoppingBasket size={32} aria-hidden /><h3>У вас ещё нет предложений</h3><p className={styles.muted}>Выберите товар и цену. После покупки монеты поступят в кошелёк.</p><button onClick={() => setSection("sell")}>Выставить товар</button></div>)}
  </div>;
}

/** Account-owned controller survives closing this body; the caller owns the accessible dialog. */
export function EconomyPanel({ economy, initialTab = "overview" }: { economy: EconomyController; initialTab?: EconomyTab }) {
  const [tab, setTab] = useState<EconomyTab>(initialTab);
  const panel = useRef<HTMLElement>(null);
  const { snapshot, error, notice, busy, uncertain, now, retryAt } = economy;
  const cooldown = Math.max(0, Math.ceil((retryAt - now) / 1000));
  const controller = snapshot ? { ...economy, snapshot, busy: busy || cooldown > 0 } : null;
  const navigate = (next: EconomyTab) => {
    setTab(next);
    // The dialog supplies the scrolling body; a new section starts at its top.
    const scrollBody = panel.current?.parentElement;
    if (scrollBody && scrollBody.scrollHeight > scrollBody.clientHeight) scrollBody.scrollTop = 0;
  };
  return <section ref={panel} className={styles.panel} aria-label="Хозяйство Мохлика" aria-busy={busy}>
    {snapshot && <EconomyBalances wallet={snapshot.wallet} />}
    <nav className={styles.navigation} aria-label="Разделы хозяйства">{tabs.map(({ id, label, Icon }) => <button key={id} aria-current={tab === id ? "page" : undefined} onClick={() => navigate(id)}><Icon size={16} aria-hidden />{label}</button>)}</nav>
    {(error || uncertain) && <div className={styles.notice} data-kind={uncertain ? "pending" : "error"} role="alert"><CircleHelp size={18} aria-hidden /><div><p>{uncertain ? "Проверяем последнее действие. Новые операции станут доступны после подтверждения." : error}</p><button disabled={busy || cooldown > 0} onClick={() => void economy.retry()}>{cooldown ? `Повторить через ${cooldown} с` : uncertain ? "Проверить результат" : "Попробовать ещё раз"}</button></div></div>}
    {notice && !error && !uncertain && <p role="status" className={styles.notice}><Check size={18} aria-hidden />{notice}</p>}
    {!controller ? !error && <div className={styles.stack} role="status"><p className={styles.muted}>Открываем ваше хозяйство…</p><div className={styles.skeleton} aria-hidden /><div className={styles.skeleton} aria-hidden /></div>
      : <div className={styles.stack} key={tab}>
        {tab === "overview" && <Overview economy={controller} navigate={navigate} />}
        {tab === "buildings" && <Buildings economy={controller} />}
        {tab === "production" && <Production economy={controller} navigate={navigate} />}
        {tab === "exploration" && <Exploration economy={controller} />}
        {tab === "inventory" && <Inventory economy={controller} navigate={navigate} />}
        {tab === "market" && <Market economy={controller} navigate={navigate} />}
      </div>}
  </section>;
}
