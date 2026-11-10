"use client";
import { useRef, useState } from "react";
import { z } from "zod";
import { adminRequest } from "./admin-api";
import { ApiError } from "@/lib/check-in-api";
import styles from "./admin-neighbor-panel.module.css";

export function AdminLocalUnlock({ onUnlocked }: { onUnlocked: () => void }) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const sending = useRef(false);
  return <form className={styles.unlock} onSubmit={async event => {
    event.preventDefault(); if (sending.current || !password) return;
    sending.current = true; setBusy(true); setError("");
    try {
      await adminRequest("local/unlock", z.object({ unlocked: z.literal(true) }), undefined, { password });
      setPassword(""); onUnlocked();
    } catch (cause) { setError(cause instanceof ApiError ? cause.message : "Не удалось открыть панель. Повторите запрос."); }
    finally { sending.current = false; setBusy(false); }
  }}>
    <strong>Локальная панель разработки</strong>
    <p className={styles.hint}>Код показан в терминале после запуска dev:lan или dev:local. Доступ открывается только текущему локальному сеансу; данные относятся к этому серверу разработки.</p>
    <label className={styles.field}>Код из терминала<input type="password" value={password} maxLength={256} autoComplete="off" spellCheck={false}
      disabled={busy} onChange={event => setPassword(event.target.value)} /></label>
    {error && <p role="alert" className={styles.error}>{error}</p>}
    <button type="submit" className={styles.primaryButton} disabled={busy || !password}>{busy ? "Проверяем код…" : "Открыть локальную панель"}</button>
  </form>;
}
