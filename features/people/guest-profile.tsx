"use client";

import { useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { ApiError } from "@/lib/check-in-api";
import { AchievementMedal } from "@/features/game/achievement-medal";
import { GAME_ACHIEVEMENTS } from "@/features/game/game-rewards";
import { GameLevelIcon } from "@/features/game/game-level-icon";
import { getClickerLevel } from "@/features/game/clicker-story";
import { ProfileFindings } from "./profile-findings";
import { getGuestProfile } from "./guest-profile-api";
import type { GuestProfile } from "./guest-profile-model";
import styles from "./guest-profile.module.css";


export function GuestProfileContents({ profile, section = "overview" }: { profile: GuestProfile; section?: "overview" | "collections" }) {
  const collectionCount = Object.values(profile.collections).reduce((sum, ids) => sum + ids.length, 0);
  const level = profile.tapStats ? getClickerLevel(profile.tapStats.lifetimeTaps) : null;
  return <div className={styles.contents}>
    {section === "overview" && <>
    {level && <div className={styles.playerLevel}><GameLevelIcon level={level.level} size={25} /><strong>Уровень {level.level}</strong><span>{level.title}</span></div>}
    <dl className={styles.stats}>
      <div><dt>Уровень дома</dt><dd>{profile.homeLevel}</dd></div>
      <div><dt>Завершено вылазок</dt><dd>{profile.completedExplorations.toLocaleString("ru-RU")}</dd></div>
      <div><dt>Страниц коллекции</dt><dd>{collectionCount}</dd></div>
    </dl>
    {profile.tapStats ? <dl className={styles.tapStats} aria-label="Рекорды по тапам">
      <div><dt>Всего тапов</dt><dd>{profile.tapStats.lifetimeTaps.toLocaleString("ru-RU")}</dd></div>
      <div><dt>Лучшая серия</dt><dd>×{profile.tapStats.bestSeries.toLocaleString("ru-RU")}</dd></div>
    </dl> : <p className={styles.privateStats}>Уровень и рекорды по тапам скрыты настройкой рейтинга игрока.</p>}
    <section aria-label="Достижения друга">
      <h4>Достижения мира · {profile.achievements.length}</h4>
      {profile.achievements.length === 0 ? <p>Первые игровые медали ещё впереди.</p> : <ul className={styles.awards}>
        {profile.achievements.map(award => {
          const definition = GAME_ACHIEVEMENTS.find(item => item.id === award.id);
          return definition ? <li key={award.id}>
            <AchievementMedal id={definition.id} level={award.level} className={styles.medal} />
            <span>{definition.title}{definition.tiers.length > 1 && <small>Ступень {award.level} из {definition.tiers.length}</small>}</span>
          </li> : null;
        })}
      </ul>}
    </section>
    </>}
    {section === "collections" && <ProfileFindings collections={profile.collections} />}
  </div>;
}

type Props = { ownerPublicId: string; circleId: string; targetPublicId: string; onSessionLost: () => void; section?: "overview" | "collections" };
function LoadedGuestProfile({ ownerPublicId, circleId, targetPublicId, onSessionLost, section = "overview" }: Props) {
  const [view, setView] = useState<{ data: GuestProfile | null; error: string | null; loading: boolean }>({ data: null, error: null, loading: true });
  const [refresh, setRefresh] = useState(0);
  const onLost = useRef(onSessionLost);
  useEffect(() => { onLost.current = onSessionLost; }, [onSessionLost]);
  useEffect(() => {
    let disposed = false, sequence = 0;
    let controller: AbortController | null = null;
    const load = () => {
      controller?.abort();
      controller = new AbortController();
      const request = ++sequence;
      // Hidden/offline views discard the snapshot; visible refreshes preserve
      // the selected chapter, scroll position and keyboard focus until authorization responds.
      if (document.visibilityState === "hidden") {
        setView({ data: null, error: null, loading: true });
        return;
      }
      setView(current => ({ data: current.data, error: null, loading: current.data === null }));
      void getGuestProfile(ownerPublicId, circleId, targetPublicId, controller.signal).then(data => {
        if (!disposed && request === sequence) setView({ data, error: null, loading: false });
      }).catch(error => {
        if (disposed || request !== sequence) return;
        if (error instanceof ApiError && error.status === 401) onLost.current();
        setView({ data: null, error: error instanceof Error ? error.message : "Не удалось открыть профиль", loading: false });
      });
    };
    load();
    const timer = setInterval(load, 30_000);
    document.addEventListener("visibilitychange", load);
    return () => { disposed = true; controller?.abort(); clearInterval(timer); document.removeEventListener("visibilitychange", load); };
  }, [ownerPublicId, circleId, targetPublicId, refresh]);
  return <section className={styles.profile} aria-label="Игровой профиль" aria-busy={view.loading}>
    <header><h3>Игровой профиль</h3><button type="button" aria-label="Обновить игровой профиль" disabled={view.loading} onClick={() => setRefresh(value => value + 1)}><RefreshCw size={16} aria-hidden="true" /></button></header>
    {view.loading ? <p role="status">Открываем профиль…</p> : view.error ? <p role="status">{view.error}</p> : view.data && <GuestProfileContents profile={view.data} section={section} />}
  </section>;
}

/** Profile access follows the current friendship; status and check-in sharing are independent. */
export function GuestProfileSection(props: Props & { isOnline: boolean }) {
  if (!props.isOnline) return <p className={styles.hint}>Подключитесь к интернету, чтобы открыть игровой профиль.</p>;
  return <LoadedGuestProfile key={`${props.ownerPublicId}:${props.circleId}:${props.targetPublicId}`} {...props} />;
}
