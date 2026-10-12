"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Check, ChevronRight, Coins, Fish, Gift, Hammer, LoaderCircle, Package, Plus, RefreshCw, Search, ShoppingBag, Trash2, UserRound, Warehouse } from "lucide-react";
import { PlayerName } from "@/components/player-name";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ItemIcon } from "@/features/items/item-icon";
import { economyCatalog, type EconomyCatalog, type EconomyView } from "@/features/economy/domain/model";
import { formatPearls } from "@/features/economy/domain/money";
import { ApiError } from "@/lib/check-in-api";
import { createUuidV4 } from "@/lib/browser-uuid";
import { getAdminAccess, getAdminEconomyPlayer, getAdminUsers, type AdminEconomyDetail, type AdminUser } from "./admin-api";
import { grantAdminEconomy, type AdminEconomyGrant } from "./admin-grants-api";
import { entriesFromGrant, pendingGrantTargets, readGrantAttempt, saveGrantAttempt } from "./admin-grants-journal";
import { formatGrantNumber as count, grantAmountLabel, grantBasketIssue, grantBuildingBusy, grantEntryKey, makeEconomyGrant, type GrantEntry, type GrantKind } from "./admin-grants-model";
import { validAdminReason } from "./admin-input";
import styles from "./admin-grants.module.css";

type Category = "currency" | "items" | "upgrades" | "fishing";
type Offer = Omit<GrantEntry, "amount"> & { current: number; description: string; levels?: number[]; disabled?: string };
type Props = {
  actorPublicId: string; target: AdminUser | null; onTargetChange: (target: AdminUser | null) => void;
  onAccessLost: (error: ApiError) => void; onManage: (target: AdminUser) => void; onRewards: (target: AdminUser) => void;
  onEconomy: (target: AdminUser) => void; onLockChange: (locked: boolean) => void;
};
const categories = [
  { id: "currency", label: "Валюта", icon: Coins }, { id: "items", label: "Предметы", icon: Package },
  { id: "upgrades", label: "Улучшения", icon: Hammer }, { id: "fishing", label: "Снасти", icon: Fish },
] as const;
const itemCategories: Record<string, string> = { produce: "Урожай", material: "Материалы", crafted: "Изделия", provisions: "Еда", fishing: "Рыба и наживка", special: "Реликвии" };
const reasons = ["Компенсация за ошибку", "Награда за тестирование", "Награда за событие"];
const isAccessError = (error: unknown): error is ApiError => error instanceof ApiError && [401, 403].includes(error.status);
const message = (error: unknown) => error instanceof Error ? error.message : "Не удалось получить ответ сервера. Повторите запрос.";

async function verifyActor(actorPublicId: string, signal: AbortSignal) {
  const actor = await getAdminAccess(signal);
  if (signal.aborted) throw new DOMException("Запрос отменён", "AbortError");
  if (actor.publicId !== actorPublicId) throw new ApiError("Аккаунт администратора сменился. Откройте панель заново.", 403);
}

function GrantIcon({ kind, id, size = 32 }: { kind: GrantKind; id: string; size?: number }) {
  return kind === "building" ? <Hammer size={size} aria-hidden="true" /> : kind === "slots" ? <Warehouse size={size} aria-hidden="true" /> : <ItemIcon itemId={id} size={size} />;
}

export function AdminGrantsPanel(props: Props) {
  const { actorPublicId, target, onTargetChange, onAccessLost } = props;
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<{ query: string; users: AdminUser[]; total: number } | null>(null);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const [loading, setLoading] = useState(true);
  const unfinished = pendingGrantTargets(actorPublicId);
  useEffect(() => {
    if (target) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setLoading(true); setError("");
      void verifyActor(actorPublicId, controller.signal).then(() => getAdminUsers({ q: query.trim(), sort: "created", offset: 0, limit: 8 }, controller.signal)).then(value => {
        if (!controller.signal.aborted) setResult({ query: query.trim(), users: value.users, total: value.total });
      }).catch(cause => {
        if (controller.signal.aborted) return;
        if (isAccessError(cause)) onAccessLost(cause); else setError(message(cause));
      }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    }, query ? 250 : 0);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [actorPublicId, query, reload, target, onAccessLost]);
  if (target) return <GrantWorkspace key={target.publicId} {...props} target={target} />;
  const shown = result?.query === query.trim() ? result : null;
  return <div className={styles.start}>
    <section className={styles.playerSearch}>
      <div className={styles.stepTitle}><span>1</span><div><h2>Кому выдаём?</h2><p>Найдите игрока по имени или вставьте его полный ID.</p></div></div>
      {unfinished.length > 0 && <div className={styles.warning}><p>Есть выдачи без подтверждённого ответа. Откройте получателя, чтобы проверить прежний запрос.</p>{unfinished.map(id => <button className={styles.button} key={id} onClick={() => setQuery(id)}>Найти {id}</button>)}</div>}
      <label className={styles.search}><Search size={20} aria-hidden="true" /><span className={styles.srOnly}>Имя или ID игрока</span><input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Например, Дима или XXXX-XXXX-XXXX" maxLength={100} autoComplete="off" /></label>
      <div className={styles.searchCaption}><span>{query.trim() ? "Результаты поиска" : "Последние зарегистрированные игроки"}</span>{loading && <LoaderCircle size={17} className={styles.spin} aria-label="Поиск" />}</div>
      {error ? <div className={styles.error} role="alert">{error}<button className={styles.button} onClick={() => setReload(value => value + 1)}>Повторить</button></div>
        : shown?.users.length ? <div className={styles.playerResults}>{shown.users.map(user => <button type="button" key={user.publicId} className={styles.playerResult} onClick={() => onTargetChange(user)}>
          <span className={styles.avatar}>{user.displayName.slice(0, 1).toUpperCase()}</span><span className={styles.identity}><strong><PlayerName name={user.displayName} tag={user.tag} /></strong><code>{user.publicId}</code><small>{user.bannedAt ? "Аккаунт заблокирован" : user.isAdmin ? "Администратор" : "Игрок"}</small></span><ChevronRight size={20} aria-hidden="true" />
        </button>)}</div> : <p className={styles.empty} role="status">{loading || !shown ? "Ищем игроков…" : "Никого не нашли. Проверьте имя или полный ID."}</p>}
      {!!shown && shown.total > shown.users.length && <p className={styles.hint}>Показаны первые {shown.users.length} из {count(shown.total)}. Уточните имя или используйте ID.</p>}
    </section>
    <aside className={styles.intro}><span className={styles.introIcon}><Gift size={32} /></span><h2>Всё для быстрой помощи</h2><p>Выберите игрока, соберите выдачу и подтвердите её одним действием.</p><ul><li><Coins size={20} /><div><strong>Монеты и жемчуг</strong><span>Количество сразу в игровых единицах</span></div></li><li><Package size={20} /><div><strong>Предметы и снасти</strong><span>Поиск по каталогу и готовые количества</span></div></li><li><Hammer size={20} /><div><strong>Здания и места производства</strong><span>Текущий и новый уровень рядом</span></div></li></ul><p className={styles.hint}>Перед выдачей вы увидите весь набор и получателя. Каждое действие сохраняется в журнале с причиной.</p></aside>
  </div>;
}

function getOffers(category: Category, catalog: EconomyCatalog, state: EconomyView | null): Offer[] {
  if (category === "currency") return [
    { kind: "coins", id: "coins", name: "Монеты", current: state?.wallet.coins ?? 0, description: "На стройку, покупки и производство" },
    { kind: "pearls", id: "pearls", name: "Жемчуг", current: (state?.wallet.pearls ?? 0) / 2, description: "На ускорения и особые покупки" },
  ];
  if (category === "items") return catalog.items.map(item => ({ kind: "item", id: item.id, name: item.name, current: state?.inventory[item.id] ?? 0, description: itemCategories[item.category] ?? "Предмет" }));
  if (category === "fishing") return [
    ...(catalog.fishing?.rods ?? []).map(item => ({ kind: "rod" as const, id: item.id, name: item.name, current: state?.fishing.ownedRods.includes(item.id) ? 1 : 0, description: `Удочка · дом ур. ${item.requiredHomeLevel}`, disabled: state?.fishing.ownedRods.includes(item.id) ? "Уже есть" : undefined })),
    ...(catalog.fishing?.hooks ?? []).map(item => ({ kind: "hook" as const, id: item.id, name: item.name, current: state?.fishing.ownedHooks.includes(item.id) ? 1 : 0, description: `Крючок · дом ур. ${item.requiredHomeLevel}`, disabled: state?.fishing.ownedHooks.includes(item.id) ? "Уже есть" : undefined })),
  ];
  return [
    ...catalog.buildings.map(building => {
      const current = state?.buildings[building.id] ?? 0;
      const levels = building.levels.filter(level => level.level > current).map(level => level.level);
      return { kind: "building" as const, id: building.id, name: building.name, current, description: "Уровень здания", levels, disabled: grantBuildingBusy(state, catalog, building.id) ? "Идёт работа или стройка" : !levels.length ? "Максимальный уровень" : undefined };
    }),
    ...catalog.buildings.filter(building => building.id !== "quarry" && catalog.recipes.some(recipe => recipe.buildingId === building.id)).map(building => {
      const current = state?.productionSlots?.[building.id] ?? 1;
      const levels = catalog.productionSlots.upgrades.filter(upgrade => upgrade.slots > current).map(upgrade => upgrade.slots);
      return { kind: "slots" as const, id: building.id, name: `${building.name}: места`, current, description: "Параллельное производство", levels, disabled: state?.jobs.some(job => job.kind === "construction" && job.targetId === building.id) ? "Идёт стройка" : !levels.length ? "Все места открыты" : undefined };
    }),
  ];
}

function GrantWorkspace({ actorPublicId, target, onTargetChange, onAccessLost, onEconomy, onManage, onRewards, onLockChange }: Props & { target: AdminUser }) {
  const [restored] = useState(() => readGrantAttempt(actorPublicId, target.publicId));
  const [detail, setDetail] = useState<AdminEconomyDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);
  const [category, setCategory] = useState<Category>("currency");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState("coins:coins");
  const [amount, setAmount] = useState("100");
  const [basket, setBasket] = useState<GrantEntry[]>(() => restored ? entriesFromGrant(restored) : []);
  const [reason, setReason] = useState(restored?.reason ?? "");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [review, setReview] = useState(!!restored);
  const [confirmed, setConfirmed] = useState(!!restored);
  const [pending, setPending] = useState<AdminEconomyGrant | null>(restored);
  const [journalUnavailable, setJournalUnavailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [stale, setStale] = useState(false);
  const sending = useRef(false);
  const write = useRef<AbortController | null>(null);
  const reviewTrigger = useRef<HTMLButtonElement>(null);
  const locked = busy || pending !== null;
  const state = detail?.economy ?? null;
  const catalog = state?.catalog ?? economyCatalog;
  const offers = getOffers(category, catalog, state);
  const offer = offers.find(item => grantEntryKey(item) === selected);
  const filtered = offers.filter(item => `${item.name} ${item.description} ${item.id}`.toLocaleLowerCase("ru-RU").includes(search.trim().toLocaleLowerCase("ru-RU")));
  const issue = grantBasketIssue(basket, state, catalog);
  const quantity = Number(amount);
  const canAdd = detail && !stale && offer && !offer.disabled && Number.isSafeInteger(quantity) && quantity > 0
    && quantity <= (offer.kind === "coins" || offer.kind === "pearls" ? 1_000_000_000 : 10_000)
    && (!offer.levels || offer.levels.includes(quantity));

  useEffect(() => {
    const controller = new AbortController();
    Promise.resolve().then(() => {
      if (controller.signal.aborted) return;
      setLoading(true);
      return verifyActor(actorPublicId, controller.signal).then(() => getAdminEconomyPlayer(target.publicId, controller.signal)).then(value => {
        if (!controller.signal.aborted) { setDetail(value); setStale(false); setError(""); }
      }).catch(cause => {
        if (controller.signal.aborted) return;
        if (isAccessError(cause)) onAccessLost(cause); else setError(message(cause));
      }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    });
    return () => controller.abort();
  }, [actorPublicId, target.publicId, reload, onAccessLost]);
  useEffect(() => { onLockChange(locked); return () => onLockChange(false); }, [locked, onLockChange]);
  useEffect(() => () => write.current?.abort(), []);
  useEffect(() => {
    if (!pending) return;
    const guard = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [pending]);

  function choose(next: Offer) { setSelected(grantEntryKey(next)); setAmount(String(next.levels?.[0] ?? (next.kind === "coins" ? 100 : next.kind === "pearls" ? 10 : 1))); }
  function add() {
    if (!canAdd || !offer || locked) return;
    const entry: GrantEntry = { kind: offer.kind, id: offer.id, name: offer.name, amount: quantity };
    setBasket(previous => {
      const existing = previous.find(item => grantEntryKey(item) === selected);
      if (!existing) return [...previous, entry];
      const additive = ["coins", "pearls", "item"].includes(entry.kind);
      return previous.map(item => grantEntryKey(item) === selected ? { ...entry, amount: additive ? item.amount + quantity : quantity } : item);
    });
    setNotice("");
  }
  async function submit() {
    if (sending.current || (!pending && (!detail || !confirmed || !basket.length || issue || !validAdminReason(reason) || stale))) return;
    const request = pending ?? makeEconomyGrant(basket, createUuidV4(), target.publicId, reason);
    if (!saveGrantAttempt(actorPublicId, target.publicId, request)) setJournalUnavailable(true);
    setPending(request); setBusy(true); setError(""); sending.current = true;
    const controller = new AbortController(); write.current = controller;
    try {
      await verifyActor(actorPublicId, controller.signal);
      const receipt = await grantAdminEconomy(target.publicId, request, controller.signal);
      if (controller.signal.aborted) return;
      saveGrantAttempt(actorPublicId, target.publicId, null);
      setPending(null); setReview(false); setConfirmed(false); setBasket([]); setStale(true);
      setNotice(receipt.changed ? `Выдано игроку ${target.displayName}. Запись сохранена в журнале.` : "Выдача уже учтена: у игрока есть выбранные улучшения или снасти.");
      setReload(value => value + 1);
    } catch (cause) {
      if (controller.signal.aborted) return;
      if (isAccessError(cause)) { onAccessLost(cause); return; }
      if (cause instanceof ApiError && [400, 404, 409, 422].includes(cause.status)) {
        saveGrantAttempt(actorPublicId, target.publicId, null); setPending(null);
      }
      setError(message(cause));
    } finally { sending.current = false; if (!controller.signal.aborted) setBusy(false); }
  }
  const unit = offer?.kind === "building" ? "Новый уровень" : offer?.kind === "slots" ? "Всего мест после выдачи" : "Добавить количество";
  return <div className={styles.workspace}>
    <section className={styles.playerCard}>
      <div className={styles.playerTop}><span className={styles.avatar}>{target.displayName.slice(0, 1).toUpperCase()}</span><div className={styles.identity}><span className={styles.eyebrow}>Получатель</span><strong><PlayerName name={detail?.displayName ?? target.displayName} tag={target.tag} /></strong><code>{target.publicId}</code></div><button className={styles.button} disabled={locked} onClick={() => onTargetChange(null)}><ArrowLeft size={16} />Другой игрок</button></div>
      {target.bannedAt && <p className={styles.warning}>Этот аккаунт заблокирован. Выдача сохранит прогресс, но не снимет блокировку.</p>}
      <div className={styles.balances} aria-label="Текущее состояние игрока">
        <div><ItemIcon itemId="coins" size={28} /><span>Монеты<strong>{state ? count(state.wallet.coins) : "—"}</strong></span></div>
        <div><ItemIcon itemId="pearls" size={28} /><span>Жемчуг<strong>{state ? formatPearls(state.wallet.pearls) : "—"}</strong></span></div>
        <div><Hammer size={24} /><span>Дом<strong>{state ? `Ур. ${state.buildings.home ?? 1}` : "—"}</strong></span></div>
        <div><Warehouse size={24} /><span>Свободно на складе<strong>{state ? `${count(state.storage.available)} / ${count(state.storage.capacity)}` : "—"}</strong></span></div>
      </div>
      <div className={styles.playerLinks}><button className={styles.link} disabled={locked || loading} onClick={() => setReload(value => value + 1)}><RefreshCw size={15} className={loading ? styles.spin : undefined} />Обновить состояние</button><button className={styles.link} disabled={locked} onClick={() => onEconomy(target)}>Всё хозяйство</button><button className={styles.link} disabled={locked} onClick={() => onManage(target)}>Одежда, коллекции, аккаунт</button><button className={styles.link} disabled={locked} onClick={() => onRewards(target)}>Награды Мохлика</button></div>
      {detail && !state && <p className={styles.hint}>При первой выдаче хозяйство будет создано с сохранением прежнего прогресса и положенных стартовых припасов.</p>}
    </section>
    {notice && <p className={styles.success} role="status"><Check size={20} />{notice}</p>}
    {error && !review && <div className={styles.error} role="alert">{error}<button className={styles.button} disabled={locked || loading} onClick={() => setReload(value => value + 1)}>Обновить</button></div>}
    <div className={styles.grantColumns}>
      <section className={styles.catalog} aria-busy={loading}>
        <div className={styles.stepTitle}><span>2</span><div><h2>Что добавить?</h2><p>Выберите категорию, предмет и количество.</p></div></div>
        <div className={styles.categories} aria-label="Категория выдачи">{categories.map(item => <button key={item.id} type="button" aria-pressed={category === item.id} disabled={locked} onClick={() => { setCategory(item.id); setSearch(""); const first = getOffers(item.id, catalog, state).find(value => !value.disabled); if (first) choose(first); }}><item.icon size={18} />{item.label}</button>)}</div>
        <label className={styles.search}><Search size={18} aria-hidden="true" /><span className={styles.srOnly}>Поиск в каталоге</span><input type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder={category === "items" ? "Дерево, камень, еда, рыба…" : "Найти в этой категории"} disabled={locked} /></label>
        <div className={styles.offers} aria-label="Каталог выдачи">{filtered.map(item => <button key={grantEntryKey(item)} className={styles.offer} aria-pressed={selected === grantEntryKey(item)} disabled={locked || !!item.disabled || !detail || stale} onClick={() => choose(item)}>
          <span className={styles.offerIcon}><GrantIcon kind={item.kind} id={item.id} /></span><span><strong>{item.name}</strong><small>{item.description}</small><small className={styles.owned}>{item.disabled ?? (!state ? "Хозяйство ещё не создано" : item.kind === "building" ? item.current ? `Сейчас: ур. ${item.current}` : "Ещё не построено" : item.kind === "slots" ? `Сейчас: ${item.current} место/места` : item.kind === "hook" || item.kind === "rod" ? "Пока нет" : `Сейчас: ${count(item.current)}`)}</small></span>{selected === grantEntryKey(item) && <Check size={16} className={styles.offerCheck} />}
        </button>)}</div>
        {!filtered.length && <p className={styles.empty}>Ничего не найдено. Попробуйте другое название.</p>}
        {offer && <fieldset disabled={locked || !detail || stale || !!offer.disabled} className={styles.composer}>
          <div className={styles.composerTitle}><GrantIcon kind={offer.kind} id={offer.id} size={28} /><strong>{offer.name}</strong></div>
          {offer.kind === "rod" || offer.kind === "hook" ? <p className={styles.hint}>Снасть появится у игрока. Он сможет выбрать её в игре.</p> : <>
            <label className={styles.field}>{unit}{offer.levels ? <select value={amount} onChange={event => setAmount(event.target.value)}>{offer.levels.map(level => <option key={level} value={level}>{offer.kind === "building" ? `Уровень ${level}` : `${level} места`}</option>)}</select> : <input type="number" inputMode="numeric" min={1} max={offer.kind === "item" ? 10000 : 1000000000} step={1} value={amount} onChange={event => setAmount(event.target.value)} />}</label>
            {!offer.levels && <div className={styles.presets} aria-label="Быстрое количество">{(offer.kind === "coins" ? [100, 500, 1000, 5000] : offer.kind === "pearls" ? [10, 50, 100, 500] : [1, 5, 10, 50]).map(value => <button key={value} aria-pressed={amount === String(value)} onClick={() => setAmount(String(value))}>{count(value)}</button>)}</div>}
            {(offer.kind === "coins" || offer.kind === "pearls") && <p className={styles.hint}>Игрок получит ровно {Number.isSafeInteger(quantity) && quantity > 0 ? count(quantity) : "указанное количество"} {offer.kind === "coins" ? "монет" : "жемчуга"}. Пересчитывать ничего не нужно.</p>}
            {offer.levels && <p className={styles.hint}>Повышение применяется сразу, без оплаты и таймера. Нужные здания можно добавить в эту же выдачу.</p>}
          </>}
          <button type="button" className={styles.addButton} disabled={!canAdd} onClick={add}><Plus size={18} />Добавить в выдачу</button>
        </fieldset>}
      </section>
      <aside className={styles.basket} aria-label="Подготовленная выдача">
        <div className={styles.stepTitle}><span>3</span><div><h2>Выдача <span className={styles.badge}>{basket.length}</span></h2><p>{target.displayName} · {target.publicId}</p></div></div>
        {!basket.length ? <div className={styles.basketEmpty}><ShoppingBag size={34} /><strong>Пока ничего не добавлено</strong><p>Соберите валюту, предметы и улучшения в один набор.</p></div> : <ul className={styles.basketList}>{basket.map(entry => <li key={grantEntryKey(entry)}><GrantIcon kind={entry.kind} id={entry.id} size={26} /><span><strong>{entry.name}</strong><small>{grantAmountLabel(entry)}</small></span><button className={styles.remove} disabled={locked} onClick={() => setBasket(previous => previous.filter(item => grantEntryKey(item) !== grantEntryKey(entry)))} aria-label={`Убрать: ${entry.name}`}><Trash2 size={17} /></button></li>)}</ul>}
        {issue && <p className={styles.warning} role="status">{issue}</p>}
        <label className={styles.field}>Причина выдачи<textarea rows={3} maxLength={240} minLength={8} placeholder="Например, компенсация за потерянный улов" value={reason} disabled={locked} onChange={event => setReason(event.target.value)} /><small>{reason.trim().length}/240 · от 8 символов, останется в журнале</small>{reason.trim().length >= 8 && !validAdminReason(reason) && <small>Введите причину одной строкой, без табуляции и скрытых символов.</small>}</label>
        <div className={styles.reasonPresets}>{reasons.map(value => <button key={value} disabled={locked} onClick={() => setReason(value)}>{value}</button>)}</div>
        <button ref={reviewTrigger} className={styles.primaryButton} disabled={locked || loading || stale || !detail || !basket.length || !validAdminReason(reason) || !!issue} onClick={() => { setConfirmed(false); setError(""); setReview(true); }}>Проверить и выдать <ArrowRight size={18} /></button>
        <p className={styles.hint}>Весь набор применяется одновременно. При ошибке ни одна его часть не будет выдана.</p>
        {pending && !review && <button className={styles.button} onClick={() => setReview(true)}>Проверить незавершённую выдачу</button>}
      </aside>
    </div>
    <Dialog open={review} onOpenChange={open => { if (!locked) setReview(open); }}>
      <DialogContent className={styles.dialog} showCloseButton={!locked} onEscapeKeyDown={event => { if (locked) event.preventDefault(); }} onInteractOutside={event => { if (locked) event.preventDefault(); }} onCloseAutoFocus={event => { event.preventDefault(); reviewTrigger.current?.focus(); }}>
        <DialogHeader><DialogTitle>Проверка выдачи</DialogTitle><DialogDescription>Весь набор получит один игрок. Изменение сохранится в журнале.</DialogDescription></DialogHeader>
        <div className={styles.reviewPlayer}><UserRound size={24} /><div><strong>{target.displayName}</strong><code>{target.publicId}</code></div></div>
        <ul className={styles.reviewList}>{basket.map(entry => <li key={grantEntryKey(entry)}><span>{entry.name}</span><strong>{grantAmountLabel(entry)}</strong></li>)}</ul>
        <p className={styles.hint}>Причина: {pending?.reason ?? reason.trim()}</p>
        <label className={styles.confirmation}><input type="checkbox" checked={confirmed} disabled={locked} onChange={event => setConfirmed(event.target.checked)} /><span>Получатель и состав верны. Выдать этот набор.</span></label>
        {error && <div className={styles.error} role="alert">{error}{pending && <p>Ответ не подтверждён. Повтор проверит ту же выдачу и не добавит набор второй раз.</p>}</div>}
        {restored && pending && !error && <p className={styles.warning}>Восстановлена незавершённая выдача. Проверьте её тем же запросом — повторная награда не начислится.</p>}
        {journalUnavailable && pending && <p className={styles.warning}>Браузер не разрешил сохранить незавершённую выдачу. Дождитесь подтверждения, не обновляя страницу.</p>}
        <div className={styles.dialogActions}><button className={styles.button} disabled={locked} onClick={() => setReview(false)}>Изменить набор</button><button className={styles.primaryButton} disabled={busy || (!pending && !confirmed)} onClick={() => void submit()}>{busy ? <LoaderCircle size={18} className={styles.spin} /> : <Gift size={18} />}{busy ? "Выдаём…" : pending ? "Проверить ту же выдачу" : "Выдать игроку"}</button></div>
      </DialogContent>
    </Dialog>
  </div>;
}
