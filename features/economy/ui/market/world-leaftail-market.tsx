"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Check, Fish, Gem, Leaf, LockKeyhole, Package, RefreshCw, Shirt } from "lucide-react";
import { ItemIcon } from "@/features/items/item-icon";
import { leaftailShopView, leaftailTravelMessage } from "@/features/economy/domain/leaftail-shop";
import type { EconomyView } from "@/features/economy/domain/model";
import { locked } from "@/features/economy/sync/controller-state";
import type { EconomyController } from "@/features/economy/sync/use-economy";
import { wardrobeItems } from "@/features/world/domain/wardrobe";
import type { WorldState } from "@/features/world/domain/model";
import { FishingRodIcon } from "@/features/world/activities/fishing/fishing-rod-icon";
import { marketRefreshAvailable, watchMarketRefreshAvailability } from "@/features/economy/ui/shared/market-refresh-availability";
import { FishingSpeciesFocus } from "@/features/economy/ui/fishing/fishing-species-odds";
import { MarketRefreshProgress } from "@/features/economy/ui/shared/market-refresh-progress";
import { WardrobePreview } from "@/features/world/ui/wardrobe/world-wardrobe";
import styles from "./world-leaftail-market.module.css";

type Offer = NonNullable<ReturnType<typeof leaftailShopView>>["offers"][number];
type Quote = { owner: string; revision: number; targetId: string; itemId: string; kind?: Offer["kind"]; price: number; quantity: number };
type ShopSection = Offer["section"];
const sections: ReadonlyArray<{ id: ShopSection; label: string; hint: string; Icon: typeof Shirt }> = [
  { id: "wardrobe", label: "Одежда", Icon: Shirt, hint: "Примерьте на Мохлика." },
  { id: "tackle", label: "Снасти", Icon: Fish, hint: "Не расходуются. Выбор — перед рыбалкой." },
  { id: "supplies", label: "Припасы", Icon: Package, hint: "По одному набору за поставку." },
  { id: "finds", label: "Находки", Icon: Gem, hint: "В каждой поставке — случайные находки." },
];
const number = (value: number) => value.toLocaleString("ru-RU");
const descriptions: Record<string, string> = {
  ancient_core: "Для больших построек и расширения кладовой.",
  moon_crystal: "Для развития поселения и расширения кладовой.",
  living_resin: "Для улучшения дома и расширения кладовой.",
  wood: "Запас для строительства и мастерской.", stone: "Для построек и каменных изделий.", fiber: "Для верёвок и работы в мастерской.",
  trail_hat: "Широкие поля, потёртая лента и дорожная пряжка.", rain_hood: "Синий капюшон с мягкой светлой окантовкой.",
  sea_neckerchief: "Морской платок с белым кантом и двойным узлом.", sunset_scarf: "Тёплый оттенок заката, светлые полоски и кисточки.",
  dune_moss: "Светлый песочный мох, будто прогретый солнцем.", storm_moss: "Серо-синий мох с прохладными светлыми прядями.",
};
const successMessages = {
  pantry: "Покупка у Листохвоста отправлена в кладовую", wardrobe: "Покупка у Листохвоста добавлена в гардероб",
  rod: "Удочка у Листохвоста добавлена в коллекцию", hook: "Крючок у Листохвоста добавлен в коллекцию",
};
const resetDate = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Moscow" });
function presentation(state: EconomyView, itemId: string, kind: Offer["kind"]) {
  const gear = kind === "rod" ? state.catalog.fishing?.rods.find(item => item.id === itemId)
    : kind === "hook" ? state.catalog.fishing?.hooks.find(item => item.id === itemId)
      : kind === "bait" ? state.catalog.fishing?.baits.find(item => item.itemId === itemId) : null;
  const clothing = kind === "wardrobe" ? wardrobeItems.find(item => item.id === itemId) : null;
  const name = clothing?.name ?? (gear && "name" in gear ? gear.name : undefined)
    ?? state.catalog.items.find(item => item.id === itemId)?.name ?? itemId;
  return { name, description: gear?.description ?? descriptions[itemId] ?? "Для развития поселения.", clothing };
}
// A full stop inside a multiplier (1.3) is not a sentence boundary.
const shortDescription = (description: string) => description.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? description;
const permanent = (kind: Offer["kind"]) => kind === "wardrobe" || kind === "rod" || kind === "hook";

/** A visible quote belongs to this account, revision, offer kind and delivery. */
export function leaftailPurchaseReason(economy: EconomyController, quote: Quote, isOnline: boolean): string | null {
  if (!isOnline) return "Для покупки нужно соединение.";
  if (locked(economy) || !economy.snapshotConfirmed) return economy.uncertain ? "Проверяем последнее действие." : "Дождитесь подтверждения действия.";
  const state = economy.snapshot;
  if (!state || state.ownerPublicId !== quote.owner || state.revision !== quote.revision)
    return "Запасы обновились. Выберите предмет ещё раз.";
  const shop = leaftailShopView(state, economy.now, state.catalog);
  if (!shop) return "Листохвост пока не открыл лавку.";
  if (!shop.unlocked) return leaftailTravelMessage(shop.requiredHomeLevel);
  const offer = shop.offers.find(item => item.targetId === quote.targetId && item.itemId === quote.itemId && item.kind === (quote.kind ?? "item"));
  if (!offer || offer.priceCoins !== quote.price || offer.quantity !== quote.quantity) return "Поставка изменилась. Выберите предмет ещё раз.";
  if (offer.owned) return offer.kind === "wardrobe" ? "Уже есть в гардеробе." : "Уже есть среди ваших снастей.";
  if (!offer.unlocked) return `Нужен дом ${offer.requiredHomeLevel}-го уровня.`;
  if (offer.remaining < 1) return "Сегодня уже куплено. Дождитесь новой поставки.";
  if (!permanent(offer.kind) && state.storage.available < offer.quantity) return `Не хватает места в кладовой: ещё ${number(offer.quantity - state.storage.available)}.`;
  if (state.wallet.coins < offer.priceCoins) return `Не хватает ${number(offer.priceCoins - state.wallet.coins)} монет.`;
  return null;
}

/** Ordinary receipt-based economy action; the browser never grants an item. */
export function WorldLeaftailMarket({ economy, isOnline, introduced = false, appearance }: {
  economy: EconomyController; isOnline: boolean; introduced?: boolean; appearance?: WorldState["equipment"];
}) {
  const [quote, setQuote] = useState<Quote | null>(null), [section, setSection] = useState<ShopSection>("wardrobe");
  const tabsId = useId(), tabButtons = useRef<Array<HTMLButtonElement | null>>([]);
  const latest = useRef({ economy, quote, isOnline, introduced }), sent = useRef<Quote | null>(null);
  const shopElement = useRef<HTMLDivElement>(null), triggerItem = useRef<string | null>(null), heading = useRef<HTMLHeadingElement>(null);
  const wasConfirming = useRef(false), headingId = useId();
  useLayoutEffect(() => { latest.current = { economy, quote, isOnline, introduced }; }, [economy, quote, isOnline, introduced]);
  const state = economy.snapshot;
  // Keep the accepted delivery on screen until the next server snapshot arrives.
  const acceptedAt = Date.parse(state?.serverTime ?? "");
  const shop = state ? leaftailShopView(state, Number.isFinite(acceptedAt) ? acceptedAt : economy.now, state.catalog) : null;
  const deliveryExpired = Boolean(shop && economy.now >= shop.refreshAt);
  const requestedDelivery = useRef<string | null>(null);
  const refresh = economy.refresh, refreshBlocked = locked(economy) || !economy.snapshotConfirmed;
  useEffect(() => {
    if (!introduced || !shop?.unlocked) return;
    return watchMarketRefreshAvailability(refresh);
  }, [introduced, shop?.unlocked, refresh]);
  useEffect(() => {
    if (!introduced || !shop?.unlocked || !deliveryExpired || refreshBlocked || !marketRefreshAvailable()) return;
    const key = `${state?.ownerPublicId}:${shop.refreshAt}`;
    if (requestedDelivery.current === key) return;
    requestedDelivery.current = key;
    void refresh();
  }, [introduced, shop?.unlocked, shop?.refreshAt, deliveryExpired, refreshBlocked, state?.ownerPublicId, refresh]);
  const confirming = Boolean(introduced && quote);
  useEffect(() => {
    if (confirming) heading.current?.focus({ preventScroll: true });
    else if (wasConfirming.current) {
      const buttons = Array.from(shopElement.current?.querySelectorAll<HTMLButtonElement>("[data-leaftail-purchase]") ?? []);
      const original = buttons.find(button => button.dataset.leaftailPurchase === triggerItem.current && !button.disabled);
      (original ?? buttons.find(button => !button.disabled) ?? shopElement.current)?.focus({ preventScroll: true });
    }
    wasConfirming.current = confirming;
  }, [confirming]);
  useEffect(() => { if (!economy.busy && !economy.uncertain) sent.current = null; },
    [economy.busy, economy.uncertain, economy.error, state?.ownerPublicId, state?.revision]);
  const cooldown = Math.max(0, Math.ceil((economy.retryAt - economy.now) / 1000));
  function changeSection(next: ShopSection) { wasConfirming.current = false; setQuote(null); setSection(next); }
  const recovery = !economy.syncError && (economy.error || economy.uncertain) && <div className={styles.recovery} role="alert">
    <p>{economy.uncertain ? "Проверяем покупку. Дождитесь подтверждения, прежде чем покупать снова." : economy.error}</p>
    <button type="button" disabled={economy.busy || cooldown > 0} onClick={() => void economy.retry()}><RefreshCw size={13} aria-hidden="true" />{cooldown ? `Повторить через ${cooldown} с` : economy.uncertain ? "Проверить покупку" : "Повторить"}</button>
  </div>;
  function confirm() {
    const current = latest.current;
    if (!current.introduced || !quote || current.quote !== quote || sent.current === quote || leaftailPurchaseReason(current.economy, quote, current.isOnline)) return;
    sent.current = quote;
    if (current.economy.act("buy_leaftail_item", quote.targetId, 1, quote.price) === false) sent.current = null;
    else setQuote(null);
  }
  const reason = quote && confirming ? leaftailPurchaseReason(economy, quote, isOnline) : null;
  const selected = quote && state ? presentation(state, quote.itemId, quote.kind ?? "item") : null;
  const preview = selected?.clothing ? { ...(appearance ?? { palette: "moss", head: null, neck: null }), [selected.clothing.slot]: selected.clothing.id } : null;
  // Cached snapshots are untrusted, including their delivery date.
  const deliveryDate = shop ? new Date(shop.refreshAt) : null;
  const deliveryLabel = deliveryDate && Number.isFinite(deliveryDate.getTime())
    ? `${resetDate.format(deliveryDate)} МСК` : "Проверяем время новой поставки";
  const arrivalMessage = !economy.snapshotConfirmed || !state ? "Проверяем возвращение путника…"
    : !shop?.unlocked ? `Путник в дороге. Он вернётся, когда дом достигнет ${shop?.requiredHomeLevel ?? 3}-го уровня.`
      : "Путник ещё в дороге. Дождитесь прибытия.";
  const purchaseConfirmed = Object.values(successMessages).some(message => economy.notice === message) && !economy.error && !economy.uncertain && !economy.busy;
  const localReceipt = economy.localLeaftailPurchase;
  const receiptMessage = localReceipt?.kind === "wardrobe" ? successMessages.wardrobe : localReceipt?.kind === "rod" ? successMessages.rod
    : localReceipt?.kind === "hook" ? successMessages.hook : successMessages.pantry;
  const receipt = purchaseConfirmed && localReceipt?.ownerPublicId === state?.ownerPublicId && economy.notice === receiptMessage ? localReceipt : null;
  const fallback = economy.notice === successMessages.wardrobe ? "Вещь добавлена в гардероб. Откройте «Ещё» → «Гардероб»."
    : economy.notice === successMessages.rod || economy.notice === successMessages.hook ? "Снасть куплена. Выберите её перед рыбалкой в «В путь»." : "Покупка отправлена в кладовую.";
  return <div ref={shopElement} tabIndex={-1} className={styles.shop} aria-label={introduced ? "Лавка Листохвоста" : "Домик путника"} aria-busy={economy.busy || undefined} data-leaftail-shop>
    {!introduced ? <p className={styles.locked} role="status" data-leaftail-away><LockKeyhole size={18} aria-hidden="true" /><span>{arrivalMessage}</span></p>
      : !state ? <>{recovery}<p role="status">Проверяем ваши запасы…</p></> : !shop ? <p>Листохвост готовит свой прилавок. Обновите игру немного позже.</p>
      : !shop.unlocked ? <p className={styles.locked} role="status" data-leaftail-away><LockKeyhole size={18} aria-hidden="true" /><span>{leaftailTravelMessage(shop.requiredHomeLevel)}</span></p> : <>
      <p className={styles.intro}><Leaf size={18} aria-hidden="true" /><span>«Товар занятный. Только узлы не развязывай.»</span></p>
      {recovery}
      <div className={styles.delivery}>
        <MarketRefreshProgress refreshAt={shop.refreshAt} refreshSeconds={state.catalog.leaftailShop?.refreshSeconds ?? 86400} now={economy.now} label="Новая поставка" pendingLabel="Проверяем новую поставку" />
        <details><summary>{deliveryLabel}</summary><p>Запасы обновляются с поставкой. Купленные вещи и снасти остаются у вас.</p></details>
      </div>
      {purchaseConfirmed && <div className={styles.success} role="status" data-leaftail-receipt={receipt?.id}>
        <Check size={16} aria-hidden="true" /><div>{receipt ? <><p>{receipt.destination === "wardrobe" ? "В гардероб" : receipt.destination === "tackle" ? "В ваши снасти" : "В кладовую"}: {receipt.items.map(item => `${item.name} ×${number(item.quantity)}`).join(", ")}.</p>
          <p>Потрачено {number(receipt.coins)} монет.</p>{receipt.destination !== "pantry" && <p>{receipt.destination === "wardrobe" ? "Надеть можно в «Ещё» → «Гардероб» → «Мои вещи»." : "Выберите снасть перед рыбалкой в «В путь»."}</p>}</> : <p>{fallback}</p>}</div>
      </div>}
      <div className={styles.wallet}><span>Ваши монеты</span><strong><ItemIcon itemId="coins" size={18} />{number(state.wallet.coins)}</strong></div>
      <div className={styles.tabs} role="tablist" aria-label="Товары Листохвоста">{sections.map((entry, index) => <button key={entry.id}
        type="button" role="tab" ref={node => { tabButtons.current[index] = node; }} id={`${tabsId}-${entry.id}`} aria-controls={`${tabsId}-offers`}
        aria-selected={section === entry.id} tabIndex={section === entry.id ? 0 : -1} onClick={() => changeSection(entry.id)} onKeyDown={event => {
          const nextIndex = event.key === "ArrowRight" ? (index + 1) % sections.length : event.key === "ArrowLeft" ? (index + sections.length - 1) % sections.length
            : event.key === "Home" ? 0 : event.key === "End" ? sections.length - 1 : null;
          if (nextIndex === null) return;
          event.preventDefault(); changeSection(sections[nextIndex].id); tabButtons.current[nextIndex]?.focus();
        }}><entry.Icon size={15} aria-hidden="true" />{entry.label}</button>)}</div>
      {confirming && quote ? <section className={styles.confirmation} role="tabpanel" id={`${tabsId}-offers`} aria-labelledby={headingId}>
        <h3 id={headingId} ref={heading} tabIndex={-1}>Купить {selected?.name ?? quote.itemId}?</h3>
        {selected && (quote.kind === "rod" || quote.kind === "hook" || quote.kind === "bait") && <p className={styles.hint}>{selected.description}</p>}
        {preview && <div className={styles.fitting}><WardrobePreview appearance={preview} /><div><strong>Примерка</strong><p>{selected?.description}</p><small>Покупка добавит вещь в гардероб. Образ можно поменять позже.</small></div></div>}
        <p>{quote.kind === "wardrobe" ? "Вещь навсегда в гардероб" : quote.kind === "rod" || quote.kind === "hook" ? "Снасть навсегда в вашу коллекцию" : `${number(quote.quantity)} шт. в кладовую`} за <strong>{number(quote.price)} монет</strong>.</p>
        <p>Монеты: {number(state.wallet.coins)} → {number(Math.max(0, state.wallet.coins - quote.price))}</p>
        {reason && <p className={styles.reason} role="status">{reason}</p>}
        <div className={styles.actions}><button type="button" onClick={() => setQuote(null)}>Назад</button><button className={styles.buy} type="button" disabled={Boolean(reason)} onClick={confirm}>Подтвердить<ItemIcon itemId="coins" size={16} />{number(quote.price)}</button></div>
      </section> : <div role="tabpanel" id={`${tabsId}-offers`} aria-labelledby={`${tabsId}-${section}`} data-leaftail-section={section}>
        <p className={styles.hint}>{sections.find(entry => entry.id === section)?.hint}</p>
        <div className={`${styles.offers} ${section === "wardrobe" ? styles.clothes : ""}`}>{shop.offers.filter(offer => offer.section === section).map(offer => {
          const nextQuote = { owner: state.ownerPublicId, revision: state.revision, targetId: offer.targetId, itemId: offer.itemId, kind: offer.kind, price: offer.priceCoins, quantity: offer.quantity };
          const disabledReason = deliveryExpired ? "Проверяем новую поставку." : leaftailPurchaseReason(economy, nextQuote, isOnline);
          const { name, description } = presentation(state, offer.itemId, offer.kind);
          return <article className={styles.offer} key={offer.id} data-leaftail-item={offer.itemId} data-leaftail-kind={offer.kind} data-leaftail-quantity={offer.quantity}>
            <div className={styles.item}>{offer.kind === "rod" ? <FishingRodIcon rodId={offer.itemId} size={40} /> : <ItemIcon itemId={offer.itemId} size={section === "wardrobe" ? 40 : 36} />}<div><strong>{name}</strong>{section !== "wardrobe" && <small>{section === "tackle" ? shortDescription(description) : description}</small>}</div>{!permanent(offer.kind) && <span className={styles.stock} aria-label={`${offer.quantity} шт. в покупке. Осталось покупок: ${offer.remaining}`}>×{number(offer.quantity)}</span>}</div>
            {offer.kind === "rod" && <FishingSpeciesFocus state={state} override={{ rodId: offer.itemId, hookId: "bare_hook", baitId: null }} />}
            <div className={styles.offerBottom}><small>{offer.kind === "wardrobe" ? offer.owned ? "Уже в гардеробе" : "В гардероб навсегда" : permanent(offer.kind) ? "Не расходуется" : `В кладовой: ${number(state.inventory[offer.itemId] ?? 0)}`}</small><button type="button" className={styles.buy} data-leaftail-purchase={offer.itemId} disabled={offer.kind !== "wardrobe" && Boolean(disabledReason)} aria-label={offer.kind === "wardrobe" ? `Примерить ${name}` : offer.owned ? `${name}: уже есть` : `Купить ${name}: ${number(offer.quantity)} шт. за ${number(offer.priceCoins)} монет`} onClick={() => {
              const current = latest.current;
              if (!current.introduced || offer.kind !== "wardrobe" && leaftailPurchaseReason(current.economy, nextQuote, current.isOnline)) return;
              triggerItem.current = offer.itemId; setQuote(nextQuote);
            }}>{offer.kind === "wardrobe" ? <><span>Примерить</span>{offer.owned ? <Check size={15} aria-label="Уже есть" /> : <><ItemIcon itemId="coins" size={16} />{number(offer.priceCoins)}</>}</> : offer.owned ? <><Check size={15} aria-hidden="true" />Уже есть</> : !offer.unlocked ? <><LockKeyhole size={13} aria-hidden="true" />Дом {offer.requiredHomeLevel}</> : offer.remaining ? <><span>Купить</span><ItemIcon itemId="coins" size={16} />{number(offer.priceCoins)}</> : <><Check size={15} aria-hidden="true" />Сегодня куплено</>}</button></div>
            {disabledReason && !offer.owned && offer.remaining > 0 && <p className={styles.reason}>{disabledReason}</p>}
          </article>;
        })}</div>
      </div>}
    </>}
  </div>;
}
