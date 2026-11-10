"use client";
import { useEffect, useState } from "react";
import { z } from "zod";
import { adminRequest, getAdminUsers, verifyAdminActor } from "./admin-api";
import { ApiError } from "@/lib/check-in-api";
import styles from "./admin-neighbor-panel.module.css";
const playersSchema = z.object({ players: z.array(z.object({ publicId: z.string(), displayName: z.string() })) });
export function AdminNeighborPlayers({ actorPublicId, local, disabled, onSelect }: {
  actorPublicId: string; local: boolean; disabled: boolean; onSelect: (id: string) => void;
}) {
  const [players, setPlayers] = useState<{ publicId: string; displayName: string }[]>([]);
  const [error, setError] = useState(""), [reload, setReload] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void Promise.resolve().then(async () => {
      try {
        await verifyAdminActor(actorPublicId, controller.signal);
        const rows = local ? (await adminRequest("local/players", playersSchema, controller.signal)).players
          : (await getAdminUsers({ q: "", sort: "created", offset: 0, limit: 100 }, controller.signal)).users;
        await verifyAdminActor(actorPublicId, controller.signal);
        if (!controller.signal.aborted) { setPlayers(rows); setError(""); }
      } catch (cause) {
        if (!controller.signal.aborted) setError(cause instanceof ApiError ? cause.message : "Не удалось загрузить игроков. Можно указать ID ниже.");
      }
    });
    return () => controller.abort();
  }, [actorPublicId, local, reload]);
  return <div className={styles.search}>
    <label className={styles.field}>Выбрать игрока<select aria-label="Выбрать игрока для выкупа" defaultValue="" disabled={disabled}
      onChange={event => { if (!disabled && event.target.value) onSelect(event.target.value); }}>
      <option value="">Выберите из {local ? "локальных профилей" : "последних 100 профилей"}</option>
      {players.map(player => <option key={player.publicId} value={player.publicId}>{player.displayName} · {player.publicId}</option>)}
    </select></label>
    <button type="button" className={styles.button} disabled={disabled} onClick={() => setReload(value => value + 1)}>Обновить игроков</button>
    {error && <p role="status" className={styles.hint}>{error}</p>}
  </div>;
}
