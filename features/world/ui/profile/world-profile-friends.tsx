"use client";

import { useId, useState } from "react";
import { RefreshCw, Search, Star, UserRoundPlus, Users, X } from "lucide-react";
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

type FriendsProps = {
  friends?: WorldFriendsState;
  onOpenPeople?: () => void;
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

/** Controlled content keeps all network state and refreshes with the existing People controller. */
export function WorldProfileFriendsContent({ friends, onOpenPeople, query, onQueryChange, searchId }: FriendsProps & {
  query: string;
  onQueryChange: (value: string) => void;
  searchId: string;
}) {
  const data = friends?.data;
  const people = data?.people ?? [];
  const filtered = profileFriends(people, query);
  const status = friendStatus(friends);
  const incoming = data?.incomingRequests.length ?? 0;
  const outgoing = data?.outgoingRequests.length ?? 0;
  return <section className={styles.friends} aria-label="Друзья">
    <header className={styles.header}>
      <h3><Users size={18} aria-hidden="true" />Друзья{data && <span className={styles.count}>{people.length}</span>}</h3>
      {friends && <button type="button" className={styles.refresh} disabled={friends.loading || friends.isOnline === false}
        onClick={() => void friends.onRefresh()} aria-label="Обновить список друзей" title="Обновить список друзей">
        <RefreshCw size={17} aria-hidden="true" />
      </button>}
    </header>

    {status && <p className={styles.status} role="status" data-warning={Boolean(friends?.error) || friends?.isOnline === false || undefined}>{status}</p>}

    {data && people.length > 0 && <>
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
      {filtered.length > 0 ? <ul className={styles.list} aria-label="Список друзей">
        {filtered.map(person => {
          const name = personDisplayName(person);
          const hasNickname = Boolean(person.nickname && person.nickname !== person.user.displayName);
          return <li key={person.circleId} className={styles.person}>
            <span className={styles.avatar} aria-hidden="true">{Array.from(name.trim())[0]?.toLocaleUpperCase("ru-RU") ?? "Ж"}</span>
            <div className={styles.names}>
              <strong><PlayerName name={name} tag={person.user.tag} /></strong>
              {hasNickname && <span>{person.user.displayName}</span>}
            </div>
            {person.isFavorite && <Star className={styles.favorite} size={16} role="img" aria-label="В избранном" />}
          </li>;
        })}
      </ul> : <p className={styles.empty} role="status">Никого не нашли. Попробуйте имя или вашу подпись.</p>}
    </>}

    {data && people.length === 0 && <p className={styles.empty}>Друзей пока нет. Добавьте человека по ID или приглашению в разделе «Люди».</p>}
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
