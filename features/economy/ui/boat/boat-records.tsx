"use client";

import { Fish, Trophy } from "lucide-react";
import { Tabs } from "radix-ui";
import { useEffect, useState } from "react";
import type { BoatState } from "@/features/economy/domain/boat-model";
import type { EconomyView } from "@/features/economy/domain/model";
import { getFishingRecords } from "@/features/economy/sync/api";
import type { FishingStandings } from "@/features/economy/sync/boat-records-model";
import type { GameLeaderboardScope } from "@/features/game/game-api";
import { ItemIcon } from "@/features/items/item-icon";
import { boatAlbumEntries } from "./boat-catch-presentation";
import { BoatPersonalRecords, boatFishWeightLabel } from "./boat-panels";
import styles from "./boat-records.module.css";
import boatStyles from "./boat-fishing.module.css";

const scopes = [{ id: "mine", title: "Мои" }, { id: "friends", title: "Друзья" }, { id: "global", title: "Мир" }] as const;

export function FishingRecordLeaders({ state, board }: { state: EconomyView; board: FishingStandings }) {
  const album = new Map(boatAlbumEntries(state).map(row => [row.fishId, row]));
  const rows = board.entries.map(entry => ({ entry, species: album.get(entry.fishId) }))
    .sort((a, b) => Number(Boolean(b.species?.discovered)) - Number(Boolean(a.species?.discovered))
      || (a.species?.discovered && b.species?.discovered ? a.species.name.localeCompare(b.species.name, "ru") : 0));
  if (!rows.length) return <p className={boatStyles.muted}>{board.scope === "friends"
    ? "У вас и ваших друзей пока нет рекордов по весу." : "Пока никто не привёз улов с лодочной рыбалки."}</p>;
  return <div className={boatStyles.records}>{rows.map(({ entry, species }) => <article key={entry.fishId} className={boatStyles.record}>
    {species?.discovered ? <ItemIcon itemId={entry.fishId} size={44} /> : <Fish size={36} aria-hidden="true" className={styles.unknown} />}
    <div><strong>{species?.discovered ? species.name : "Неизвестная рыба"}</strong>
      <small className={styles.holder}>{entry.isMe && <Trophy size={15} className={styles.cup} role="img" aria-label="Ваш рекорд" />}{entry.isMe ? "Вы" : entry.displayName}
        {entry.tiedCount > 1 && <span> · Делят рекорд: {entry.tiedCount}</span>}</small></div>
    <span className={boatStyles.weight}>{boatFishWeightLabel(entry.weightGrams)}</span>
  </article>)}</div>;
}

function SharedRecords({ state, scope, onReload }: { state: EconomyView; scope: GameLeaderboardScope; onReload: () => void }) {
  const owner = state.ownerPublicId;
  const [board, setBoard] = useState<FishingStandings | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void getFishingRecords(owner, scope, controller.signal).then(result => {
      if (!controller.signal.aborted) setBoard(result);
    }, () => { if (!controller.signal.aborted) setFailed(true); });
    return () => controller.abort();
  }, [owner, scope]);

  if (!board) return failed ? <div className={styles.notice} role="status"><span>Не удалось загрузить рекорды.</span>
    <button type="button" className={boatStyles.secondary} onClick={() => onReload()}>Повторить</button></div>
    : <p role="status" className={boatStyles.muted}>Загружаем рекорды…</p>;
  return <FishingRecordLeaders state={state} board={board} />;
}

export function BoatRecords({ state, boat, sharedRecordsAvailable = true }: { state: EconomyView; boat: BoatState; sharedRecordsAvailable?: boolean }) {
  const [version, setVersion] = useState(0);
  const reload = () => setVersion(value => value + 1);
  return <Tabs.Root defaultValue="mine">
    <Tabs.List className={styles.scopes} aria-label="С кем сравнить рекорды">{scopes.map(scope =>
      <Tabs.Trigger key={scope.id} value={scope.id}>{scope.title}</Tabs.Trigger>)}</Tabs.List>
    <Tabs.Content value="mine"><BoatPersonalRecords state={state} boat={boat} /></Tabs.Content>
    {scopes.map(({ id }) => id !== "mine" && <Tabs.Content key={id} value={id}>
      {sharedRecordsAvailable ? <SharedRecords key={`${state.ownerPublicId}.${version}`} state={state} scope={id} onReload={reload} />
        : <p className={boatStyles.muted}>Общие рекорды доступны в игровом профиле. В демонстрации сохраняются личные достижения этого выхода.</p>}
    </Tabs.Content>)}
  </Tabs.Root>;
}
