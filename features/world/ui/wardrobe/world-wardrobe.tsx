"use client";

import { useEffect, useId, useRef, useState, type CSSProperties } from "react";
import { Check, RotateCcw, Search, Shirt, ShoppingBag } from "lucide-react";
import { ItemIcon } from "@/features/items/item-icon";
import { pixelSprite } from "@/features/mochlik/pixel-sprite";
import type { EconomyController } from "@/features/economy/sync/use-economy";
import { formatPearls } from "@/features/economy/domain/money";
import { number } from "@/features/economy/ui/shared/world-economy-parts";
import type { WorldState } from "@/features/world/domain/model";
import { wardrobeItems as items, wardrobeOwned, wardrobePurchaseTarget, type WardrobeItem } from "@/features/world/domain/wardrobe";
import type { WorldController } from "@/features/world/state/use-world";
import styles from "./world-wardrobe.module.css";

type Slot = "head" | "neck" | "palette";
type Price = NonNullable<WardrobeItem["purchase"]>;
type Section = "owned" | "shop";
const slots = [{ id: "all", name: "Всё" }, { id: "head", name: "Шапки" }, { id: "neck", name: "Шарфы" }, { id: "palette", name: "Мох" }] as const;
const slotName: Record<Slot, string> = { head: "Головной убор", neck: "Шарф", palette: "Оттенок мха" };
const tabs = [{ id: "owned", name: "Мои вещи", icon: Shirt }, { id: "shop", name: "Магазин", icon: ShoppingBag }] as const;

const priceAmount = (price: Price, amount = price.amount) => price.currency === "pearls" ? formatPearls(amount) : number(amount);

function PriceLabel({ price }: { price: Price }) {
  return <span className={styles.price} aria-label={`${priceAmount(price)} ${price.currency === "coins" ? "монет" : "жемчужин"}`}>
    <ItemIcon itemId={price.currency} size={18} />{priceAmount(price)}
  </span>;
}

/** A still native sprite: browsing clothes never starts a second scene or animation loop. */
export function WardrobePreview({ appearance }: { appearance: WorldState["equipment"] }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const { palette, head, neck } = appearance;
  useEffect(() => {
    const context = canvas.current?.getContext("2d");
    if (!context) return;
    context.clearRect(0, 0, 144, 144);
    context.imageSmoothingEnabled = false;
    context.drawImage(pixelSprite("idle", "front", 0, { palette, head, neck }), 0, 0, 144, 144);
  }, [palette, head, neck]);
  return <canvas ref={canvas} width={144} height={144} className={styles.previewCanvas} role="img" aria-label="Мохлик в выбранном образе" />;
}

export function WorldWardrobe({ world, economy }: { world: WorldController; economy: EconomyController }) {
  const [section, setSection] = useState<Section>("owned"), [slot, setSlot] = useState<(typeof slots)[number]["id"]>("all");
  const [query, setQuery] = useState(""), [currency, setCurrency] = useState<"all" | Price["currency"]>("all");
  const [selection, setSelection] = useState<string | null>(null), [confirmation, setConfirmation] = useState<string | null>(null);
  const [purchasePending, setPurchasePending] = useState<string | null>(null);
  const sent = useRef(false), refreshed = useRef<string | null>(null), tabButtons = useRef<Array<HTMLButtonElement | null>>([]);
  const confirmBox = useRef<HTMLDivElement>(null), purchaseButton = useRef<HTMLButtonElement>(null), wasConfirming = useRef(false);
  const id = useId(), state = world.snapshot?.state, account = economy.snapshot;
  const owner = world.snapshot?.ownerPublicId, sameOwner = !!owner && account?.ownerPublicId === owner;
  const purchases = sameOwner ? account?.wardrobe ?? [] : [];
  const inventory = state?.inventory ?? [], owned = new Set(wardrobeOwned(inventory, purchases));
  const syncing = purchases.some(item => !inventory.includes(item));
  const cooldown = Math.max(0, Math.ceil((economy.retryAt - economy.now) / 1000));
  const blocked = world.busy || world.uncertain || economy.busy || economy.uncertain || cooldown > 0 || !sameOwner || syncing;
  useEffect(() => { if (!economy.busy && !world.busy) sent.current = false; }, [economy.busy, economy.uncertain, economy.error, world.busy, world.error, owner, account?.revision, world.snapshot?.revision]);
  const refreshWorld = world.refreshNow;
  useEffect(() => {
    if (!sameOwner || !syncing || world.busy || economy.busy || economy.uncertain) return;
    const token = `${owner}:${account?.revision}`;
    if (refreshed.current === token) return;
    refreshed.current = token;
    void refreshWorld();
  }, [sameOwner, syncing, world.busy, economy.busy, economy.uncertain, owner, account?.revision, refreshWorld]);
  const list = items.filter(item => section === "owned" ? owned.has(item.id) : !owned.has(item.id) && item.purchase)
    .filter(item => slot === "all" || item.slot === slot)
    .filter(item => section === "owned" || currency === "all" || item.purchase?.currency === currency)
    .filter(item => item.name.toLocaleLowerCase("ru").includes(query.trim().toLocaleLowerCase("ru")));
  // Keep the purchased card selected while both authoritative profiles catch up.
  const purchasedItem = purchasePending && owned.has(purchasePending) ? items.find(item => item.id === purchasePending) : undefined;
  const selected = list.find(item => item.id === selection) ?? purchasedItem ?? list[0];
  const equipped = !!selected && state?.equipment[selected.slot] === selected.id;
  const preview = state ? { ...state.equipment, ...(selected ? { [selected.slot]: selected.id } : {}) } : null;
  const price = selected?.purchase, affordable = !!price && !!account && account.wallet[price.currency] >= price.amount;
  const quote = selected && price ? `${owner}:${selected.id}:${price.currency}:${price.amount}` : null;
  const confirming = confirmation !== null && confirmation === quote && !!selected && !owned.has(selected.id);
  useEffect(() => {
    if (confirming) confirmBox.current?.focus({ preventScroll: true });
    else if (wasConfirming.current) purchaseButton.current?.focus({ preventScroll: true });
    wasConfirming.current = confirming;
  }, [confirming]);
  function changeSection(next: Section) { setSection(next); setSelection(null); setPurchasePending(null); setConfirmation(null); }
  function buy() {
    if (blocked || sent.current || !selected || !price || !affordable || !confirming || owned.has(selected.id)) return;
    sent.current = true; setPurchasePending(selected.id); setConfirmation(null);
    economy.act("buy_wardrobe_item", wardrobePurchaseTarget(selected), 1, price.amount);
  }
  function equip() {
    if (blocked || sent.current || !selected || !inventory.includes(selected.id) || equipped && selected.slot === "palette") return;
    sent.current = true;
    world.act("equip", equipped ? `remove_${selected.slot}` : selected.id);
  }
  if (!state) return <p role="status">Открываем гардероб…</p>;
  return <section className={styles.wardrobe} aria-label="Одежда Мохлика" aria-busy={world.busy || economy.busy || undefined}>
    <div className={styles.tabs} role="tablist" aria-label="Раздел гардероба">{tabs.map((tab, index) => <button type="button" key={tab.id} ref={node => { tabButtons.current[index] = node; }} role="tab" id={`${id}-${tab.id}`} aria-selected={section === tab.id} aria-controls={`${id}-content`} tabIndex={section === tab.id ? 0 : -1} onClick={() => changeSection(tab.id)} onKeyDown={event => {
      let next = index;
      if (event.key === "ArrowRight" || event.key === "ArrowLeft") next = 1 - index;
      else if (event.key === "Home") next = 0;
      else if (event.key === "End") next = 1;
      else return;
      event.preventDefault(); changeSection(tabs[next].id); tabButtons.current[next]?.focus();
    }}><tab.icon size={17} aria-hidden="true" />{tab.name}</button>)}</div>
    {sameOwner && account && <div className={styles.wallet} aria-label="Ваш баланс"><PriceLabel price={{ currency: "coins", amount: account.wallet.coins }} /><PriceLabel price={{ currency: "pearls", amount: account.wallet.pearls }} /></div>}
    <div role="tabpanel" id={`${id}-content`} aria-labelledby={`${id}-${section}`} className={styles.content}>
      <section className={styles.fitting} aria-label="Примерочная">
        <div className={styles.mirror}>{preview && <WardrobePreview appearance={preview} />}<span>{selected && !equipped ? "Примерка" : "Ваш образ"}</span></div>
        <div className={styles.selection}><span className={styles.eyebrow}>{selected ? slotName[selected.slot] : "Примерочная"}</span><h3>{selected?.name ?? "Мохлик"}</h3>
          {selected ? owned.has(selected.id) ? <><p>{equipped ? "Сейчас на Мохлике" : "Есть в гардеробе"}</p><button type="button" className={styles.primary} disabled={blocked || equipped && selected.slot === "palette"} onClick={equip}>{syncing ? "Получаем вещь…" : world.busy ? "Меняем образ…" : equipped ? selected.slot === "palette" ? <><Check size={15} aria-hidden="true" />Выбран</> : "Снять" : selected.slot === "palette" ? "Выбрать оттенок" : "Надеть"}</button></>
            : price ? <><p>Останется в гардеробе</p><button type="button" ref={purchaseButton} className={styles.primary} disabled={blocked || !affordable || confirming} onClick={() => { if (!blocked && affordable) setConfirmation(quote); }} aria-label={`Купить ${selected.name} за ${priceAmount(price)} ${price.currency === "coins" ? "монет" : "жемчужин"}`}><span>Купить</span><PriceLabel price={price} /></button>{!affordable && account && <small className={styles.missing}>Не хватает {priceAmount(price, price.amount - account.wallet[price.currency])} {price.currency === "coins" ? "монет" : "жемчужин"}</small>}</> : <p>Награда путешествий</p>
            : <p>Выберите вещь ниже</p>}
        </div>
        {confirming && selected && price && <div ref={confirmBox} className={styles.confirmation} role="group" aria-label="Подтверждение покупки" tabIndex={-1}><p>Добавить «{selected.name}» за <PriceLabel price={price} />?</p><div><button type="button" onClick={() => setConfirmation(null)}>Отмена</button><button type="button" className={styles.primary} disabled={blocked || !affordable} onClick={buy}>Подтвердить покупку</button></div></div>}
      </section>
      {(economy.error || economy.uncertain || syncing) && <div className={styles.recovery} role={economy.error || economy.uncertain ? "alert" : "status"}><p>{economy.uncertain ? "Проверяем покупку. Вещь появится после подтверждения." : economy.error ?? (world.error ? "Вещь куплена. Обновите гардероб, чтобы её надеть." : "Обновляем гардероб…")}</p>{(economy.error || economy.uncertain) ? <button type="button" disabled={economy.busy || cooldown > 0} onClick={() => void economy.retry()}>{cooldown ? `Повторить через ${cooldown} с` : "Проверить результат"}</button> : world.error && <button type="button" disabled={world.busy} onClick={() => void refreshWorld()}>Обновить гардероб</button>}</div>}
      <div className={styles.filters} role="group" aria-label="Вид одежды">{slots.map(entry => <button type="button" key={entry.id} aria-pressed={slot === entry.id} onClick={() => { setSlot(entry.id); setSelection(null); setPurchasePending(null); setConfirmation(null); }}>{entry.name}</button>)}</div>
      <div className={styles.searchRow}><label className={styles.search}><Search size={16} aria-hidden="true" /><span className={styles.sr}>Найти вещь</span><input type="search" placeholder="Найти вещь" value={query} onChange={event => { setQuery(event.target.value); setPurchasePending(null); setConfirmation(null); }} /></label>{section === "shop" && <label className={styles.currency}><span className={styles.sr}>Валюта покупки</span><select value={currency} onChange={event => { setCurrency(event.target.value as typeof currency); setPurchasePending(null); setConfirmation(null); }}><option value="all">Любая валюта</option><option value="coins">Монеты</option><option value="pearls">Жемчуг</option></select></label>}</div>
      <div className={styles.items} aria-label={section === "owned" ? "Ваши вещи" : "Вещи в магазине"}>{list.map(item => {
        const active = state.equipment[item.slot] === item.id;
        return <button type="button" key={item.id} className={styles.item} aria-pressed={selected?.id === item.id} onClick={() => { setSelection(item.id); setConfirmation(null); setPurchasePending(null); }} style={{ "--item-color": item.color } as CSSProperties}>
          <span className={styles.art}><ItemIcon itemId={item.id} size={52} />{active && <Check size={14} className={styles.equipped} aria-label="Надето" />}</span><strong>{item.name}</strong><span className={styles.itemMeta}>{section === "shop" && item.purchase ? <PriceLabel price={item.purchase} /> : active ? "На Мохлике" : slotName[item.slot]}</span>
        </button>;
      })}</div>
      {!list.length && <div className={styles.empty}><Shirt size={28} aria-hidden="true" /><strong>{query || slot !== "all" || currency !== "all" && section === "shop" ? "Ничего не нашлось" : section === "shop" ? "Все вещи уже у вас" : "Пока пусто"}</strong><p>{section === "owned" ? "Загляните в магазин за новым образом." : "Попробуйте другой раздел или снимите фильтры."}</p>{(query || slot !== "all" || currency !== "all") && <button type="button" onClick={() => { setQuery(""); setSlot("all"); setCurrency("all"); }}><RotateCcw size={14} aria-hidden="true" />Сбросить фильтры</button>}</div>}
    </div>
  </section>;
}
