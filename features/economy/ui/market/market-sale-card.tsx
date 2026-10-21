"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Coins } from "lucide-react";
import { ItemIcon } from "@/features/items/item-icon";
import type { EconomyMarketListing } from "@/features/economy/domain/model";
import { ECONOMY_MAX_BALANCE } from "@/features/economy/domain/money";
import { locked, type ReadyEconomy } from "@/features/economy/sync/controller-state";
import styles from "./player-market.module.css";

const number = (value: number) => value.toLocaleString("ru-RU");

/** Stored avatars are optional; never request a non-HTTPS external image or send the page URL. */
function safeAvatar(url: string | null | undefined): string | null {
  if (!url || url.includes("\\")) return null;
  if (/^\/(?!\/)/.test(url)) return url;
  try { const parsed = new URL(url); return parsed.protocol === "https:" && !parsed.username && !parsed.password ? parsed.href : null; }
  catch { return null; }
}

export function MarketBuyerAvatar({ name, url }: { name: string; url: string | null }) {
  const [failed, setFailed] = useState(false);
  const source = safeAvatar(url);
  const initials = name.trim().split(/\s+/).slice(0, 2).map(part => Array.from(part)[0] ?? "").join("").toLocaleUpperCase("ru-RU") || "?";
  return <span className={styles.avatar} aria-hidden="true">
    {source && !failed
      // Avatars come from the sale receipt; the static Sites build cannot use a Next image proxy.
      // eslint-disable-next-line @next/next/no-img-element
      ? <img src={source} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setFailed(true)} />
      : <span>{initials}</span>}
  </span>;
}

/** A sold lot keeps its stall occupied until this exact server receipt is collected. */
export function MarketSaleCard({ economy, offer }: { economy: ReadyEconomy; offer: EconomyMarketListing }) {
  const latest = useRef({ economy, offer });
  const sent = useRef<{ owner: string; revision: number } | null>(null);
  useEffect(() => { latest.current = { economy, offer }; }, [economy, offer]);
  useEffect(() => {
    if (sent.current && (sent.current.owner !== economy.snapshot.ownerPublicId || sent.current.revision !== economy.snapshot.revision
      || !economy.busy && !economy.uncertain && Boolean(economy.error))) sent.current = null;
  }, [economy.snapshot.ownerPublicId, economy.snapshot.revision, economy.busy, economy.uncertain, economy.error]);
  const sale = offer.sale, state = economy.snapshot;
  const acceptedOwner = state.ownerPublicId, acceptedRevision = state.revision, acceptedProceeds = sale?.proceedsCoins;
  const name = state.catalog.items.find(item => item.id === offer.itemId)?.name ?? "Товар";
  const label = `${name} × ${number(offer.quantity)}`;
  const pending = economy.market?.ownerPublicId === state.ownerPublicId && offer.owned && offer.status === "sold" && sale?.claimedAt === null;
  const overflow = Boolean(sale && state.wallet.coins > ECONOMY_MAX_BALANCE - sale.proceedsCoins);
  const disabled = locked(economy) || !pending || overflow;
  const claim = () => {
    const current = latest.current, snapshot = current.economy.snapshot;
    const fresh = current.economy.market?.mine.find(entry => entry.id === offer.id);
    if (sent.current || locked(current.economy) || snapshot.ownerPublicId !== acceptedOwner || snapshot.revision !== acceptedRevision
      || current.economy.market?.ownerPublicId !== snapshot.ownerPublicId || !sale || !fresh?.owned || fresh.status !== "sold"
      || fresh.sale?.claimedAt !== null || fresh.sale.proceedsCoins !== acceptedProceeds
      || snapshot.wallet.coins > ECONOMY_MAX_BALANCE - fresh.sale.proceedsCoins) return;
    const accepted = current.economy.actMarket("claim_sale", fresh.id, 1, 0);
    if (accepted !== false) sent.current = { owner: snapshot.ownerPublicId, revision: snapshot.revision };
  };
  if (!sale) return null;
  return <article className={`${styles.card} ${styles.offerCard} ${styles.soldCard}`} role="listitem" aria-label={`Продано: ${label}`} data-market-sale={offer.id}>
    <span className={styles.soldStamp}><Check size={12} aria-hidden />Продано</span>
    <div className={styles.cardHeader}><span className={styles.iconTile}><ItemIcon itemId={offer.itemId} size={27} /></span><div><h3>{label}</h3></div></div>
    <div className={styles.buyer}><MarketBuyerAvatar key={`${sale.buyerName}:${sale.buyerAvatarUrl ?? ""}`} name={sale.buyerName} url={sale.buyerAvatarUrl} /><span><small>Покупатель</small><strong>{sale.buyerName}</strong></span></div>
    <p className={styles.saleCoins}><ItemIcon itemId="coins" size={21} /><strong>{number(sale.proceedsCoins)}</strong><span>к сбору</span></p>
    <button type="button" className={styles.collect} disabled={disabled} aria-label={`Забрать ${number(sale.proceedsCoins)} монет за ${label}`} onClick={claim}><Coins size={16} aria-hidden />Забрать монеты</button>
    {overflow && <p className={styles.hint}>Освободите место в кошельке. Продажа сохранена.</p>}
    <p className={styles.saleNote}>Сбор освободит место в лавке</p>
  </article>;
}
