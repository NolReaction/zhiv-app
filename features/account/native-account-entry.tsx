"use client";

import { useState } from "react";
import { ExternalLink, LogIn } from "lucide-react";
import { getClientPlatform } from "@/lib/client-platform";
import { getMe } from "@/lib/check-in-api";
import type { MeResponse } from "@/lib/check-in-contract";
import { TransientNotice } from "@/components/app-notifications";
import styles from "./account-access.module.css";

export function NativeAccountEntry({ isOnline, onAuthenticated }: {
  isOnline: boolean; onAuthenticated: (me: MeResponse) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function login() {
    const platform = getClientPlatform();
    if (!platform || busy) return;
    setBusy(true); setError("");
    try {
      await platform.login();
      const me = await getMe();
      if (!me) throw new Error("Вход не завершён. Попробуйте ещё раз.");
      onAuthenticated(me);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Не удалось войти. Повторите попытку."); }
    finally { setBusy(false); }
  }
  return <div className={`${styles.entry} ${styles.entryScreen}`}>
    <p className={styles.hint}>Войдите через ВК или почту в защищённом окне браузера. Затем вернитесь в Мохлика — ваш профиль и прогресс сохранятся.</p>
    <button type="button" className={styles.primary} disabled={!isOnline || busy} onClick={() => void login()}>
      <LogIn size={18} aria-hidden />{busy ? "Ожидаем вход…" : "Войти в свой аккаунт"}
    </button>
    {!isOnline && <p className={styles.hint}>Для входа нужен интернет.</p>}
    <TransientNotice message={error} kind="error" />
  </div>;
}

/** Cookie-bound identity proof stays in the system browser, never in the game WebView. */
export function NativeAccountManagement({ isOnline, onRefresh, label = "Открыть управление аккаунтом" }: {
  isOnline: boolean; onRefresh?: () => Promise<void>; label?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [opened, setOpened] = useState(false);
  const [error, setError] = useState("");
  async function open() {
    setBusy(true); setError("");
    try { await getClientPlatform()?.openAccount(); setOpened(true); }
    catch { setError("Не удалось открыть браузер. Попробуйте ещё раз."); }
    finally { setBusy(false); }
  }
  async function refresh() {
    setBusy(true); setError("");
    try { await onRefresh?.(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Не удалось обновить профиль."); }
    finally { setBusy(false); }
  }
  return <div className={styles.entry}>
    <p className={styles.hint}>Привязка способов входа, восстановление и удаление профиля доступны в браузере. При необходимости войдите там в тот же аккаунт.</p>
    <button type="button" className={styles.secondary} disabled={!isOnline || busy} onClick={() => void open()}><ExternalLink size={18} aria-hidden />{label}</button>
    {opened && onRefresh && <button type="button" className={styles.textButton} disabled={!isOnline || busy} onClick={() => void refresh()}>Я вернулся — обновить профиль</button>}
    <TransientNotice message={error} kind="error" />
  </div>;
}
