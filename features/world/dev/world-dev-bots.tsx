"use client";

import { useState, type FormEvent } from "react";
import { economyCatalog, type EconomyCatalog } from "@/features/economy/domain/model";
import { ECONOMY_CURRENCY_SCALE, ECONOMY_PEARL_SCALE, formatPearls, PEARL_DISPLAY_DIVISOR } from "@/features/economy/domain/money";
import { economyMarketUnlocked, marketMinimumPrice, marketSameHomeBand } from "@/features/economy/domain/market-rules";
import type { EconomyController } from "@/features/economy/sync/use-economy";
import { ItemIcon } from "@/features/items/item-icon";
import type { GuestWorldTarget } from "@/features/people/guest-world-model";
import { wardrobeItems } from "@/features/world/domain/wardrobe";
import { worldCatalog } from "@/features/world/domain/model";
import type { WorldController } from "@/features/world/state/use-world";
import type { DevBot, DevBotAction, DevBotResult } from "./dev-bot-model";
import { useDevBots, type DevBotsController } from "./use-dev-bots";
import styles from "./world-dev-bots.module.css";

type Navigation = {
  onVisitBot?: (target: GuestWorldTarget) => void;
  onBotsChanged?: () => void;
  onOpenCheats?: () => void;
};
type Props = Navigation & { world: WorldController; economy?: EconomyController; active?: boolean };
type ContentsProps = Navigation & { controller: DevBotsController; permitted: boolean; buyer?: EconomyController };
const format = (value: number) => value.toLocaleString("ru-RU");
const integer = (value: string, minimum = 1, maximum = 1_000_000) => /^\d+$/.test(value)
  && Number.isSafeInteger(Number(value)) && Number(value) >= minimum && Number(value) <= maximum;
function submit(event: FormEvent, action: () => void) { event.preventDefault(); action(); }

/** These are independent local accounts: opening this tab never upgrades the player. */
export function WorldDevBots({ world, economy, active = true, ...navigation }: Props) {
  const owner = world.snapshot?.ownerPublicId ?? economy?.snapshot?.ownerPublicId ?? null;
  const permitted = process.env.NODE_ENV === "development" && world.snapshot?.devTools === true && economy?.devAvailable === true;
  const controller = useDevBots(owner, active && permitted);
  return <WorldDevBotsContent key={owner ?? "signed-out"} controller={controller} permitted={permitted} buyer={economy} {...navigation} />;
}

/** Explain the real trade gates instead of silently changing the visiting player. */
export function devBotTradeHint(bot: DevBot, buyer: EconomyController | undefined, catalog = economyCatalog): string | null {
  if (!buyer?.snapshot) return "Дождитесь загрузки своего хозяйства для проверки торговли.";
  if ((buyer.snapshot.buildings.home ?? 1) < catalog.market.requiredHomeLevel)
    return `Для покупок нужен ваш дом уровня ${catalog.market.requiredHomeLevel}. Откройте «Читы» и выберите готовое поселение.`;
  if (!economyMarketUnlocked(buyer.snapshot, catalog)) return "Откройте свой рынок: восстановите мост и выполните нужные вылазки. Это можно проверить во вкладке «Читы».";
  if ((bot.economy.buildings.home ?? 1) < catalog.market.requiredHomeLevel) return "У бота пока закрыт рынок. Выберите поселение с домом от уровня 2.";
  if (!marketSameHomeBand(buyer.snapshot.buildings.home, bot.economy.buildings.home))
    return "Для торговли выберите боту ту же группу домов, что у вас: 2–3 или 4–5.";
  return null;
}

export function WorldDevBotsContent({ controller, permitted, buyer, onVisitBot, onBotsChanged, onOpenCheats }: ContentsProps) {
  const [selectedId, setSelectedId] = useState("");
  const [name, setName] = useState("Лесной сосед");
  const [home, setHome] = useState("2");
  const snapshot = controller.snapshot;
  const bots = snapshot?.bots ?? [];
  const selected = bots.find(bot => bot.id === selectedId) ?? bots[0];
  const locked = !permitted || !snapshot || controller.busy || controller.loading || controller.uncertain;
  const validName = name.trim().length > 0 && name.trim().length <= 40;
  function applied(result: DevBotResult | null) {
    if (!result) return;
    setSelectedId(result.botId);
    onBotsChanged?.();
  }
  async function act(action: DevBotAction) {
    if (!locked) applied(await controller.command(action));
  }
  return <div className={styles.root} aria-busy={controller.busy || controller.loading}>
    <div className={styles.intro}><h3>Тестовые друзья</h3><p>Отдельные профили с настоящими постройками, одеждой и личной лавкой. Сразу появятся в друзьях. Ваш прогресс сохраняется.</p></div>
    {!permitted && <p className={styles.warning} role="status">Нужен локальный сервер разработки с разрешёнными DEV-командами. На игровом сервере боты недоступны.</p>}
    {controller.error && <p className={styles.error} role="alert">{controller.error}</p>}
    {controller.notice && <p className={styles.notice} role="status">{controller.notice}</p>}
    {controller.loading && <p className={styles.hint} role="status">Загружаем тестовых друзей…</p>}
    {controller.busy && <p className={styles.hint} role="status">Сохраняем изменения бота…</p>}
    {controller.uncertain && <div className={styles.warning}><p>Ответ не получен. Проверьте результат тем же запросом перед следующей командой.</p>
      <button type="button" disabled={controller.busy || !permitted} onClick={() => { if (!controller.busy && permitted) void controller.retry().then(applied); }}>Проверить результат</button></div>}
    <button type="button" disabled={!permitted || controller.busy || controller.loading || controller.uncertain}
      onClick={() => { if (permitted && !controller.busy && !controller.loading && !controller.uncertain) void controller.refresh(); }}>Обновить ботов</button>
    <form className={styles.box} onSubmit={event => submit(event, () => { if (validName && bots.length < (snapshot?.maxBots ?? 5)) void act({ action: "create", displayName: name.trim(), homeLevel: Number(home) }); })}>
      <h4>Новый друг <small>{bots.length} / {snapshot?.maxBots ?? 5}</small></h4>
      <div className={styles.columns}><label><span>Имя нового бота</span><input value={name} maxLength={40} disabled={locked} onChange={event => setName(event.target.value)} autoComplete="off" /></label>
        <label><span>Поселение</span><select value={home} disabled={locked} onChange={event => setHome(event.target.value)}>{[1, 2, 3, 4, 5].map(level => <option key={level} value={level}>Дом {level}</option>)}</select></label></div>
      <p className={styles.hint}>Дом 2 удобен для проверки лавки. Уровни относятся только к новому боту.</p>
      <button type="submit" disabled={locked || !validName || bots.length >= (snapshot?.maxBots ?? 5)}>Создать бота</button>
      {bots.length >= (snapshot?.maxBots ?? 5) && <p className={styles.hint}>Все пять мест заняты. Удалите ненужного тестового друга.</p>}
    </form>
    {bots.length === 0 && snapshot && <p className={styles.hint}>Создайте первого бота, чтобы проверять визиты и покупки без второго аккаунта.</p>}
    {bots.length > 0 && <>
      <label><span>Управлять другом</span><select aria-label="Управлять другом" value={selected?.id ?? ""} disabled={controller.busy || controller.uncertain}
        onChange={event => setSelectedId(event.target.value)}>{bots.map(bot => <option key={bot.id} value={bot.id}>{bot.displayName} · дом {bot.economy.buildings.home ?? 1}</option>)}</select></label>
      {selected && <DevBotEditor key={selected.id} bot={selected} catalog={buyer?.snapshot?.catalog ?? economyCatalog} buyer={buyer} locked={locked}
        act={act} onVisitBot={onVisitBot} onOpenCheats={onOpenCheats} />}
    </>}
  </div>;
}

function DevBotEditor({ bot, catalog, buyer, locked, act, onVisitBot, onOpenCheats }: {
  bot: DevBot; catalog: EconomyCatalog; buyer?: EconomyController; locked: boolean;
  act: (action: DevBotAction) => Promise<void>; onVisitBot?: Navigation["onVisitBot"]; onOpenCheats?: () => void;
}) {
  const [name, setName] = useState(bot.displayName);
  const [home, setHome] = useState(String(bot.economy.buildings.home ?? 1));
  const [buildingId, setBuildingId] = useState("warehouse");
  const [buildingLevel, setBuildingLevel] = useState("");
  const [slot, setSlot] = useState<"palette" | "head" | "neck" | "rod">("head");
  const [outfit, setOutfit] = useState("");
  const [currency, setCurrency] = useState<"coins" | "pearls">("coins");
  const [money, setMoney] = useState("1000");
  const [itemId, setItemId] = useState("wood");
  const [quantity, setQuantity] = useState("10");
  const [lotItemId, setLotItemId] = useState("wood");
  const [lotQuantity, setLotQuantity] = useState("5");
  const [lotPrice, setLotPrice] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [jobKind, setJobKind] = useState<"construction" | "production" | "exploration">("production");
  const [jobTarget, setJobTarget] = useState("");
  const building = catalog.buildings.find(item => item.id === buildingId) ?? catalog.buildings[0];
  const currentLevel = bot.economy.buildings[building.id] ?? 0;
  const levels = [...(!["home", "warehouse"].includes(building.id) ? [0] : []), ...building.levels.map(level => level.level)];
  const requestedLevel = buildingLevel === "" ? currentLevel : Number(buildingLevel);
  const outfits = slot === "rod" ? worldCatalog.items.filter(item => item.slot === "rod").map(item => ({ id: item.id, name: item.name })) : wardrobeItems.filter(item => item.slot === slot);
  const currentOutfit = bot.equipment[slot] ?? "";
  const outfitChoice = outfit === "" ? currentOutfit : outfit === "none" ? "" : outfit;
  const validOutfit = outfitChoice === "" ? slot !== "palette" : outfits.some(item => item.id === outfitChoice);
  const rawMoney = Number(money) * (currency === "pearls" ? PEARL_DISPLAY_DIVISOR : 1);
  const moneyStep = currency === "pearls" ? ECONOMY_PEARL_SCALE / PEARL_DISPLAY_DIVISOR : ECONOMY_CURRENCY_SCALE;
  const validMoney = integer(money, moneyStep) && Number.isSafeInteger(rawMoney)
    && rawMoney % (currency === "pearls" ? ECONOMY_PEARL_SCALE : ECONOMY_CURRENCY_SCALE) === 0;
  const items = catalog.items;
  const lotItem = items.find(item => item.id === lotItemId && item.tradable) ?? items.find(item => item.tradable)!;
  const lotCount = Number(lotQuantity);
  const minimumPrice = marketMinimumPrice(lotItem.id, lotCount, catalog);
  const price = lotPrice === "" ? minimumPrice : Number(lotPrice);
  const maxPrice = minimumPrice * catalog.market.maxPriceMultiplier;
  const validLot = integer(lotQuantity, 1, catalog.market.maxLotQuantity) && Number.isSafeInteger(price) && price >= minimumPrice && price <= maxPrice && price % ECONOMY_CURRENCY_SCALE === 0
    && (bot.economy.inventory[lotItem.id] ?? 0) >= lotCount;
  const tradeHint = devBotTradeHint(bot, buyer, catalog);
  const marketOpen = (bot.economy.buildings.home ?? 1) >= catalog.market.requiredHomeLevel
    && Object.entries(catalog.market.requiredBuildings).every(([id, level]) => (bot.economy.buildings[id] ?? 0) >= level);
  const activeListings = bot.listings.filter(listing => listing.status === "active");
  const jobTargets = jobKind === "construction" ? catalog.buildings.filter(item => item.levels.some(level => level.level === (bot.economy.buildings[item.id] ?? 0) + 1))
    : jobKind === "production" ? catalog.recipes : catalog.explorations;
  const target = jobTargets.find(item => item.id === jobTarget) ?? jobTargets[0];
  const command = (action: DevBotAction) => { if (!locked) void act(action); };
  return <div className={styles.editor}>
    <section className={styles.box} aria-label="Выбранный бот"><div className={styles.identity}><strong>{bot.displayName}</strong><span>Дом {bot.economy.buildings.home ?? 1}</span></div>
      <div className={styles.balance}><span>{format(bot.economy.wallet.coins)} монет</span><span>{formatPearls(bot.economy.wallet.pearls)} жемчуга</span></div>
      <p className={styles.hint}>Кладовая: {format(bot.economy.storage.used)} / {format(bot.economy.storage.capacity)}. Лотов в продаже: {activeListings.length}.</p>
      <button type="button" disabled={locked || !onVisitBot || bot.sharingMode === "OFF"} onClick={() => {
        if (!locked && bot.sharingMode !== "OFF") onVisitBot?.({ circleId: bot.circleId, targetPublicId: bot.publicId, displayName: bot.displayName });
      }}>В гости</button>
      {bot.sharingMode === "OFF" && <p className={styles.hint}>Мир скрыт. Включите доступ ниже, чтобы зайти в гости.</p>}
      {tradeHint && <div className={styles.warning}><p>{tradeHint}</p>{onOpenCheats && <button type="button" onClick={onOpenCheats}>Открыть мои читы</button>}</div>}
    </section>

    <details className={styles.section}><summary>Имя и доступ</summary><div className={styles.tools}>
      <form onSubmit={event => submit(event, () => { if (name.trim() && name.trim().length <= 40) command({ action: "rename", botId: bot.id, displayName: name.trim() }); })}>
        <label><span>Имя бота</span><input value={name} maxLength={40} disabled={locked} onChange={event => setName(event.target.value)} autoComplete="off" /></label>
        <button type="submit" disabled={locked || !name.trim() || name.trim() === bot.displayName}>Сохранить имя</button>
      </form>
      <button type="button" disabled={locked} aria-pressed={bot.sharingMode !== "OFF"} onClick={() => command({ action: "set_sharing", botId: bot.id, sharingMode: bot.sharingMode === "OFF" ? "LATEST_ONLY" : "OFF" })}>
        {bot.sharingMode === "OFF" ? "Открыть мир для визитов" : "Скрыть мир от друзей"}</button>
    </div></details>

    <details className={styles.section}><summary>Поселение и постройки</summary><div className={styles.tools}>
      <form onSubmit={event => submit(event, () => command({ action: "set_home", botId: bot.id, homeLevel: Number(home) }))}>
        <label><span>Готовое поселение бота</span><select value={home} disabled={locked} onChange={event => setHome(event.target.value)}>{[1, 2, 3, 4, 5].map(level => <option key={level} value={level}>Дом {level}</option>)}</select></label>
        <p className={styles.hint}>Применит доступные этому дому постройки только выбранного бота.</p><button type="submit" disabled={locked}>Применить поселение</button>
      </form>
      <div className={styles.buildings}>{catalog.buildings.map(item => <div key={item.id}><span>{item.name}</span><strong>{bot.economy.buildings[item.id] ? `ур. ${bot.economy.buildings[item.id]}` : "закрыто"}</strong></div>)}</div>
      <form onSubmit={event => submit(event, () => { if (levels.includes(requestedLevel)) command({ action: "set_building", botId: bot.id, buildingId: building.id, level: requestedLevel }); })}>
        <label><span>Отдельная постройка</span><select value={building.id} disabled={locked} onChange={event => { setBuildingId(event.target.value); setBuildingLevel(""); }}>{catalog.buildings.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <label><span>Уровень постройки</span><select value={requestedLevel} disabled={locked} onChange={event => setBuildingLevel(event.target.value)}>{levels.map(level => <option key={level} value={level}>{level ? `Уровень ${level}` : "Не построено"}</option>)}</select></label>
        <button type="submit" disabled={locked || requestedLevel === currentLevel || !levels.includes(requestedLevel)}>Изменить постройку</button>
      </form>
    </div></details>

    <details className={styles.section}><summary>Одежда персонажа</summary><form className={styles.tools} onSubmit={event => submit(event, () => { if (validOutfit) command({ action: "equip", botId: bot.id, slot, itemId: outfitChoice || null }); })}>
      <p className={styles.hint}>Сохраняется в профиле бота и видна при настоящем визите.</p>
      <label><span>Часть образа</span><select value={slot} disabled={locked} onChange={event => { setSlot(event.target.value as typeof slot); setOutfit(""); }}>
        <option value="palette">Цвет</option><option value="head">Головной убор</option><option value="neck">Шарф</option><option value="rod">Удочка</option>
      </select></label>
      <label><span>Вещь персонажа</span><select value={outfitChoice || "none"} disabled={locked} onChange={event => setOutfit(event.target.value)}>
        {slot !== "palette" && <option value="none">Без вещи</option>}{outfits.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
      </select></label>
      <button type="submit" disabled={locked || !validOutfit || outfitChoice === currentOutfit}>Сохранить одежду</button>
    </form></details>

    <details className={styles.section}><summary>Валюта и кладовая бота</summary><div className={styles.tools}>
      <form onSubmit={event => submit(event, () => { if (validMoney) command({ action: "grant_currency", botId: bot.id, currency, quantity: rawMoney }); })}>
        <div className={styles.columns}><label><span>Валюта бота</span><select value={currency} disabled={locked} onChange={event => setCurrency(event.target.value as typeof currency)}><option value="coins">Монеты</option><option value="pearls">Жемчуг</option></select></label>
          <label><span>Выдать валюту</span><input type="number" inputMode="numeric" min={moneyStep} max={1_000_000} step={moneyStep} value={money} disabled={locked} onChange={event => setMoney(event.target.value)} /></label></div>
        <p className={styles.hint}>Количество как на экране. Шаг выдачи: {moneyStep} {currency === "pearls" ? "жемчужин" : "монет"}.</p>
        <button type="submit" disabled={locked || !validMoney}>Выдать валюту боту</button>
      </form>
      <form onSubmit={event => submit(event, () => { if (integer(quantity)) command({ action: "grant_item", botId: bot.id, itemId, quantity: Number(quantity) }); })}>
        <label><span>Предмет в кладовую бота</span><select value={itemId} disabled={locked} onChange={event => setItemId(event.target.value)}>{items.map(item => <option key={item.id} value={item.id}>{item.name} · {format(bot.economy.inventory[item.id] ?? 0)}</option>)}</select></label>
        <label><span>Количество предметов</span><input type="number" inputMode="numeric" min={1} max={1_000_000} step={1} value={quantity} disabled={locked} onChange={event => setQuantity(event.target.value)} /></label>
        <button type="submit" disabled={locked || !integer(quantity)}>Выдать предмет боту</button>
      </form>
    </div></details>

    <details className={styles.section} open><summary>Личная лавка бота</summary><div className={styles.tools}>
      <p className={styles.hint}>Настоящие лоты. Покупайте их в мире бота своим персонажем: предметы и деньги перейдут между профилями.</p>
      {!marketOpen && <p className={styles.warning}>Рынок бота пока закрыт. Примените готовое поселение с домом от уровня 2.</p>}
      {activeListings.length === 0 && <p className={styles.hint}>Лавка пуста. Выдайте боту предметы и выставьте партию.</p>}
      <ul className={styles.lots}>{activeListings.map(listing => <li key={listing.id}><ItemIcon itemId={listing.itemId} size={30} />
        <div><strong>{items.find(item => item.id === listing.itemId)?.name ?? listing.itemId} ×{format(listing.quantity)}</strong><span>{format(listing.totalPrice)} монет за партию</span></div>
        <button type="button" disabled={locked} aria-label={`Снять лот: ${items.find(item => item.id === listing.itemId)?.name ?? listing.itemId}`} onClick={() => command({ action: "cancel_listing", botId: bot.id, listingId: listing.id })}>Снять</button>
      </li>)}</ul>
      <form onSubmit={event => submit(event, () => { if (validLot && marketOpen) command({ action: "create_listing", botId: bot.id, itemId: lotItem.id, quantity: lotCount, totalPrice: price }); })}>
        <label><span>Товар для продажи</span><select value={lotItem.id} disabled={locked} onChange={event => { setLotItemId(event.target.value); setLotPrice(""); }}>{items.filter(item => item.tradable).map(item => <option key={item.id} value={item.id}>{item.name} · в запасах {format(bot.economy.inventory[item.id] ?? 0)}</option>)}</select></label>
        <div className={styles.columns}><label><span>Количество в партии</span><input type="number" inputMode="numeric" min={1} max={catalog.market.maxLotQuantity} step={1} value={lotQuantity} disabled={locked} onChange={event => { setLotQuantity(event.target.value); setLotPrice(""); }} /></label>
          <label><span>Цена всей партии</span><input type="number" inputMode="numeric" min={Number.isFinite(minimumPrice) ? minimumPrice : 1} max={Number.isFinite(maxPrice) ? maxPrice : undefined} step={ECONOMY_CURRENCY_SCALE} value={Number.isFinite(price) ? price : ""} disabled={locked} onChange={event => setLotPrice(event.target.value)} /></label></div>
        <p className={styles.hint}>В запасах: {format(bot.economy.inventory[lotItem.id] ?? 0)}. {Number.isFinite(minimumPrice) && `Допустимая цена: ${format(minimumPrice)}–${format(maxPrice)} монет.`}</p>
        {integer(lotQuantity, 1, catalog.market.maxLotQuantity) && (bot.economy.inventory[lotItem.id] ?? 0) < lotCount && <button type="button" disabled={locked} onClick={() => {
          const missing = lotCount - (bot.economy.inventory[lotItem.id] ?? 0);
          if (integer(lotQuantity, 1, catalog.market.maxLotQuantity) && missing > 0) command({ action: "grant_item", botId: bot.id, itemId: lotItem.id, quantity: missing });
        }}>Выдать недостающее для партии</button>}
        <button type="submit" disabled={locked || !marketOpen || !validLot || activeListings.length >= catalog.market.baseSlots}>Выставить лот</button>
      </form>
    </div></details>

    <details className={styles.section}><summary>Задания бота · {bot.economy.jobs.length}</summary><div className={styles.tools}>
      <p className={styles.hint}>Серверные таймеры видны при визите. «Убрать ожидание» завершает таймер, результат забирается отдельно.</p>
      <form onSubmit={event => submit(event, () => { if (target) command({ action: "start_job", botId: bot.id, kind: jobKind, targetId: target.id }); })}>
        <label><span>Занятие бота</span><select value={jobKind} disabled={locked} onChange={event => { setJobKind(event.target.value as typeof jobKind); setJobTarget(""); }}>
          <option value="production">Производство</option><option value="construction">Стройка</option><option value="exploration">Вылазка</option>
        </select></label>
        <label><span>Задание для бота</span><select value={target?.id ?? ""} disabled={locked || !target} onChange={event => setJobTarget(event.target.value)}>
          {jobTargets.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select></label>
        <p className={styles.hint}>Обычные цены и требования. Если ресурсов не хватает, выдайте их боту выше.</p>
        <button type="submit" disabled={locked || !target}>Запустить задание бота</button>
      </form>
      {!bot.economy.jobs.length && <p className={styles.hint}>Активных заданий нет.</p>}
      {bot.economy.jobs.map(job => <div key={job.id} className={styles.job}><span>{job.kind === "construction" ? "Стройка" : job.kind === "production" ? "Производство" : "Вылазка"} · {catalog.buildings.find(item => item.id === job.targetId)?.name ?? catalog.recipes.find(item => item.id === job.recipeId)?.name ?? catalog.explorations.find(item => item.id === job.targetId)?.name ?? job.targetId}</span>
        <button type="button" disabled={locked} onClick={() => command({ action: "claim_job", botId: bot.id, jobId: job.id })}>{job.collection && !job.collection.startedAt ? "Отправить на сбор" : "Забрать результат"}</button></div>)}
      <button type="button" disabled={locked || !bot.economy.jobs.length} onClick={() => command({ action: "finish_jobs", botId: bot.id })}>Убрать ожидание бота</button>
    </div></details>

    <div className={styles.danger}>{!deleting ? <button type="button" disabled={locked} onClick={() => { if (!locked) setDeleting(true); }}>Удалить бота</button> : <>
      <p>Удалить «{bot.displayName}», его прогресс, дружбу и лоты? Ваш профиль сохранится.</p><div className={styles.columns}>
        <button type="button" disabled={locked} onClick={() => command({ action: "delete", botId: bot.id })}>Да, удалить бота</button>
        <button type="button" disabled={locked} onClick={() => setDeleting(false)}>Оставить бота</button>
      </div></>}</div>
  </div>;
}
