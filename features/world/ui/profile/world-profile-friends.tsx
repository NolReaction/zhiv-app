"use client";

import { useId, useState } from "react";
import { ChevronRight, Coins, RefreshCw, Search, Sprout, Star, Store, UserRoundPlus, Users, X } from "lucide-react";
import { MochlikPortrait } from "@/features/mochlik/mochlik-portrait";
import { neighborDefaultSettings, type NeighborSettings, type NeighborView } from "@/features/economy/domain/neighbor-model";
import { ItemIcon } from "@/features/items/item-icon";
import { economyCatalog } from "@/features/economy/domain/model";
import { PlayerName } from "@/components/player-name";
import type { PeopleResponse, Person } from "@/lib/check-in-contract";
import { matchesPersonSearch } from "@/lib/people-search";
import { personDisplayName } from "@/lib/person-nickname";
import styles from "./world-profile-friends.module.css";

export type WorldFriendsState = {
  data: PeopleResponse | null;
  loading: boolean;
  error: string | null;
  updatedAt?: number | null;
  isOnline?: boolean;
  onRefresh: () => void | Promise<void>;
};

export type NeighborFriend = { name: string; equipment: NeighborSettings["equipment"] };
export type NeighborMarketState = { shop: NeighborView["shop"] | null; error: boolean; now: number };

type FriendsProps = {
  friends?: WorldFriendsState;
  onOpenPeople?: () => void;
  onVisitFriend?: (person: Person) => void;
  onVisitNeighbor?: () => void;
  neighbor?: NeighborFriend;
  neighborMarket?: NeighborMarketState;
};

function loadedAt(value: number | null | undefined): string | null {
  if (value == null || !Number.isFinite(value)) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return new Intl.DateTimeFormat("ru-RU", {
    day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
  }).format(date);
}

function friendStatus(friends: WorldFriendsState | undefined): string | null {
  if (!friends) return "Список друзей пока недоступен.";
  if (friends.isOnline === false) {
    return friends.data ? "Нет сети. Показан последний загруженный список." : "Нет сети. Подключитесь, чтобы загрузить друзей.";
  }
  if (friends.loading) return friends.data ? "Обновляем список…" : "Загружаем друзей…";
  if (friends.error) {
    return friends.data ? "Не удалось обновить. Показан последний загруженный список." : "Не удалось загрузить друзей. Нажмите «Обновить».";
  }
  if (!friends.data) return "Нажмите «Обновить», чтобы загрузить друзей.";
  const timestamp = loadedAt(friends.updatedAt);
  return timestamp ? `Обновлено: ${timestamp}` : null;
}

export function profileFriends(people: readonly Person[], query: string): Person[] {
  return people.filter(person => matchesPersonSearch(person, query))
    .sort((left, right) => Number(Boolean(right.isFavorite)) - Number(Boolean(left.isFavorite)));
}

type MarketPreviewItem = { id: string; itemId: string; quantity: number; totalPrice: number };
const itemNames = new Map(economyCatalog.items.map(item => [item.id, item.name]));
const number = (value: number) => value.toLocaleString("ru-RU");

function MarketPreview({ id, label, count, items, message }: {
  id: string; label: string; count?: number; items?: readonly MarketPreviewItem[]; message?: string;
}) {
  return <span className={styles.market} id={id} data-friend-market>
    <span className={styles.marketHeader}><Store size={14} aria-hidden="true" /><span>{label}</span>{count !== undefined && <strong>{count}</strong>}</span>
    {items && items.length > 0 ? <span className={styles.offers}>
      {items.slice(0, 3).map(item => <span key={item.id} className={styles.offer} data-friend-offer={item.itemId}
        aria-label={`${itemNames.get(item.itemId) ?? "Предмет"}, ${number(item.quantity)} шт., ${number(item.totalPrice)} монет за лот`}>
        <span className={styles.offerArt}><ItemIcon itemId={item.itemId} size={28} /><span>×{number(item.quantity)}</span></span>
        <span className={styles.offerName}>{itemNames.get(item.itemId) ?? "Предмет"}</span>
        <span className={styles.offerPrice}><Coins size={12} aria-hidden="true" /><span>{number(item.totalPrice)}</span></span>
      </span>)}
    </span> : message && <span className={styles.marketMessage}>{message}</span>}
    {items && items.length > 0 && <span className={styles.marketFootnote}>Цена за лот{count !== undefined && count > 3 ? ` · ещё ${number(count - 3)}` : ""}</span>}
  </span>;
}

function FriendMarketPreview({ person, id }: { person: Person; id: string }) {
  const market = person.gameSummary?.market;
  if (person.theirSharingMode === "OFF") return <MarketPreview id={id} label="Лавка" message="Мир скрыт" />;
  if (!market) return <MarketPreview id={id} label="Лавка" message="Данные игры пока недоступны" />;
  if (!market.available) {
    const message = market.reason === "buyer_locked" ? "Откроется после восстановления моста"
      : market.reason === "home_band" ? "Недоступна на вашем уровне дома"
      : market.reason === "world_hidden" ? "Мир скрыт" : "Лавка пока закрыта";
    return <MarketPreview id={id} label="Лавка" message={message} />;
  }
  return <MarketPreview id={id} label="Предложения" count={market.count} items={market.listings} message="Пока нет предложений" />;
}

function NeighborMarketPreview({ market, online, id }: { market?: NeighborMarketState; online: boolean; id: string }) {
  if (!market) return <MarketPreview id={id} label="Лавка" message="Витрина при посещении" />;
  if (!market.shop) return <MarketPreview id={id} label="Лавка" message={!online ? "Подключитесь, чтобы увидеть товары" : market.error ? "Витрина пока недоступна" : "Загружаем витрину…"} />;
  if (!market.shop.available) return <MarketPreview id={id} label="Лавка" message="Лавка пока закрыта" />;
  if (Date.parse(market.shop.refreshAt) <= market.now) return <MarketPreview id={id} label="Лавка" message={online ? "Ожидаем новую поставку" : "Поставка требует обновления"} />;
  const offers = market.shop.offers.filter(offer => !offer.purchased);
  return <MarketPreview id={id} label={!online || market.error ? "Последняя витрина" : "Сегодня в лавке"} count={offers.length} items={offers} message="Поставка разобрана" />;
}

/** Controlled content keeps all network state and refreshes with the existing People controller. */
export function WorldProfileFriendsContent({ friends, onOpenPeople, onVisitFriend, onVisitNeighbor, neighbor = neighborDefaultSettings, neighborMarket, query, onQueryChange, searchId }: FriendsProps & {
  query: string;
  onQueryChange: (value: string) => void;
  searchId: string;
}) {
  const data = friends?.data;
  const people = data?.people ?? [];
  const filtered = profileFriends(people, query);
  const count = people.length + Number(Boolean(onVisitNeighbor));
  const normalize = (value: string) => value.normalize("NFKC").toLocaleLowerCase("ru-RU").replaceAll("ё", "е").trim();
  const neighborVisible = Boolean(onVisitNeighbor && normalize(query).split(/\s+/).filter(Boolean)
    .every(word => normalize(`${neighbor.name} лесной сосед персонаж мира`).includes(word)));
  const status = friendStatus(friends);
  const incoming = data?.incomingRequests.length ?? 0;
  const outgoing = data?.outgoingRequests.length ?? 0;
  return <section className={styles.friends} aria-label="Друзья">
    <header className={styles.header}>
      <h3><Users size={18} aria-hidden="true" />Друзья{(data || onVisitNeighbor) && <span className={styles.count}>{count}</span>}</h3>
      {friends && <button type="button" className={styles.refresh} disabled={friends.loading || friends.isOnline === false}
        onClick={() => void friends.onRefresh()} aria-label="Обновить список друзей" title="Обновить список друзей">
        <RefreshCw size={17} aria-hidden="true" />
      </button>}
    </header>

    {status && <p className={styles.status} role="status" data-warning={Boolean(friends?.error) || friends?.isOnline === false || undefined}>{status}</p>}

    {((data && people.length > 0) || onVisitNeighbor) && <>
      <div className={styles.search}>
        <label className={styles.searchLabel} htmlFor={searchId}>Поиск по имени или вашей подписи</label>
        <div className={styles.searchField}>
          <Search size={16} aria-hidden="true" />
          <input id={searchId} type="search" value={query} autoComplete="off" placeholder="Найти друга"
            onChange={event => onQueryChange(event.target.value)} />
          {query && <button type="button" className={styles.clear} aria-label="Сбросить поиск друзей" onClick={() => onQueryChange("")}>
            <X size={16} aria-hidden="true" />
          </button>}
        </div>
      </div>
      {filtered.length > 0 || neighborVisible ? <ul className={styles.list} aria-label="Список друзей">
        {neighborVisible && <li className={`${styles.person} ${styles.neighbor}`} data-world-neighbor-friend="berest">
          <button type="button" className={styles.visit} disabled={friends?.isOnline === false}
            aria-label={`В гости к ${neighbor.name}`} aria-describedby={`${searchId}-neighbor-market`}
            onClick={onVisitNeighbor} data-audio-cue="ui.open">
            <span className={styles.identity}>
              <span className={`${styles.avatar} ${styles.neighborAvatar}`}><MochlikPortrait appearance={neighbor.equipment} className={styles.portrait} /></span>
              <span className={styles.names}><strong>{neighbor.name}</strong><span>Персонаж мира · Лесной сосед</span></span>
            </span>
            <NeighborMarketPreview market={neighborMarket} online={friends?.isOnline !== false} id={`${searchId}-neighbor-market`} />
            <span className={styles.visitAction}>{friends?.isOnline === false ? "Нужен интернет" : "В гости"}<ChevronRight size={15} aria-hidden="true" /></span>
          </button>
        </li>}
        {filtered.map((person, index) => {
          const name = personDisplayName(person);
          const hasNickname = Boolean(person.nickname && person.nickname !== person.user.displayName);
          const unavailable = friends?.isOnline === false ? "Нужен интернет" : person.theirSharingMode === "OFF" ? "Мир скрыт" : null;
          const summary = person.gameSummary;
          const summaryId = `${searchId}-friend-${index}`;
          const content = <>
            <span className={styles.identity}>
              <span className={styles.avatar} aria-hidden="true">{Array.from(name.trim())[0]?.toLocaleUpperCase("ru-RU") ?? "Ж"}</span>
              <span className={styles.names}>
                <strong><PlayerName name={name} tag={person.user.tag} /></strong>
                {hasNickname && <span>{person.user.displayName}</span>}
                {summary && <span className={styles.level} id={`${summaryId}-level`} data-friend-level={summary.level}><Sprout size={13} aria-hidden="true" />Уровень {summary.level}</span>}
              </span>
              {person.isFavorite && <Star className={styles.favorite} size={16} role="img" aria-label="В избранном" />}
            </span>
            <FriendMarketPreview person={person} id={summaryId} />
            {onVisitFriend && person.theirSharingMode !== "OFF" && <span className={styles.visitAction}>{unavailable ?? "В гости"}<ChevronRight size={15} aria-hidden="true" /></span>}
          </>;
          return <li key={person.circleId} className={styles.person}>
            {onVisitFriend ? <button type="button" className={styles.visit} disabled={Boolean(unavailable)}
              aria-label={unavailable ? `${name}: ${unavailable.toLocaleLowerCase("ru-RU")}` : `В гости к ${name}`}
              aria-describedby={summary ? `${summaryId}-level ${summaryId}` : summaryId}
              onClick={() => { if (!unavailable) onVisitFriend(person); }} data-audio-cue="ui.open">{content}</button> : <div className={styles.visit}>{content}</div>}
          </li>;
        })}
      </ul> : <p className={styles.empty} role="status">Никого не нашли. Попробуйте имя или вашу подпись.</p>}
    </>}

    {data && people.length === 0 && !onVisitNeighbor && <p className={styles.empty}>Друзей пока нет. Добавьте человека по ID или приглашению в разделе «Люди».</p>}
    {(incoming > 0 || outgoing > 0) && <p className={styles.requests}>
      {incoming > 0 && <span>Входящих заявок: {incoming}</span>}
      {outgoing > 0 && <span>Отправлено заявок: {outgoing}</span>}
    </p>}
    {onOpenPeople && <button type="button" className={styles.manage} onClick={onOpenPeople}>
      <UserRoundPlus size={17} aria-hidden="true" />{incoming > 0 ? "Друзья и заявки" : people.length > 0 ? "Управлять друзьями" : "Найти друзей"}
    </button>}
  </section>;
}

export function WorldProfileFriends(props: FriendsProps) {
  const [query, setQuery] = useState("");
  const searchId = useId();
  return <WorldProfileFriendsContent {...props} query={query} onQueryChange={setQuery} searchId={searchId} />;
}
