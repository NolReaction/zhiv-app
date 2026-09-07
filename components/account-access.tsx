"use client";

import { TransientNotice } from "./app-notifications";
import { useCallback, useEffect, useState } from "react";
import { MonitorSmartphone, ShieldCheck } from "lucide-react";
import { getAccountAccess, getAuthOptions, revokeSession, revokeOtherSessions, logout, type AccountAccess as Access, type AuthOptions } from "@/lib/auth-api";
import { ApiError } from "@/lib/check-in-api";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { LoginForm } from "./account-entry";
import { AccountLifecycle } from "./account-lifecycle";
import type { MeResponse } from "@/lib/check-in-contract";
import styles from "./account-access.module.css";

export function AccountAccess({ isOnline, onSessionLost, onUpdated }: { isOnline: boolean; onSessionLost: () => void; onUpdated: (me: MeResponse) => void }) {
  const [access, setAccess] = useState<Access | null>(null);
  const [options, setOptions] = useState<AuthOptions | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    const [account, available] = await Promise.all([getAccountAccess(), getAuthOptions()]);
    setAccess(account); setOptions(available); setError("");
  }, []);
  useEffect(() => {
    let active = true;
    Promise.all([getAccountAccess(), getAuthOptions()]).then(([account, available]) => {
      if (active) { setAccess(account); setOptions(available); setError(""); }
    }).catch(cause => { if (active) setError(cause instanceof Error ? cause.message : "Не удалось загрузить доступ"); });
    return () => { active = false; };
  }, []);

  async function remove() {
    if (!confirm) return;
    setBusy(true); setError(""); setNotice("");
    try {
      if (confirm === "logout") { await logout(); onSessionLost(); return; }
      if (confirm === "others") await revokeOtherSessions(); else await revokeSession(confirm);
      await refresh(); setNotice("Выбранные сеансы закрыты.");
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) onSessionLost();
      else setError(cause instanceof Error ? cause.message : "Не удалось закрыть сеанс");
    } finally { setConfirm(null); setBusy(false); }
  }

  if (access && options && !options.vk && !options.email && access.sessions.length === 0) return null;

  return <section className={styles.card} aria-labelledby="account-access-title">
    <h2 id="account-access-title"><ShieldCheck size={20} aria-hidden /> Способы входа</h2>
    {access && <>
      <p className={styles.hint}>{access.methods.length ? "Входите в этот профиль в любом браузере. Остальные устройства останутся подключены." : "Привяжите ВК или почту, чтобы возвращаться в этот профиль на других устройствах."}</p>
      {access.methods.map(method => <p key={method.provider} className={styles.method}>{method.label} <span>Привязано</span></p>)}
      {options && <LoginForm link isOnline={isOnline} options={{ ...options, vk: options.vk && !access.methods.some(m => m.provider === "vk"), email: options.email && !access.methods.some(m => m.provider === "email") }} onDone={async () => { await refresh(); setNotice("Почта привязана к этому профилю."); }} />}
      {options && !options.vk && !options.email && <p className={styles.hint}>Новые способы входа пока недоступны. Сохраните резервный код ниже.</p>}
      {options && <AccountLifecycle access={access} options={options} isOnline={isOnline} onDeleted={onSessionLost} onChanged={async me => { onUpdated(me); await refresh(); }} />}
      <h3><MonitorSmartphone size={20} aria-hidden /> Устройства</h3>
      <p className={styles.hint}>Отдельный сеанс для каждого браузера. Название устройства определяется приблизительно.</p>
      <ul className={styles.sessions}>{access.sessions.map(session => <li key={session.id}>
        <div><strong>{session.label}</strong><span>{session.current ? "Этот браузер" : `Последний вход или открытие настроек: ${new Date(session.lastSeenAt).toLocaleString("ru-RU")}`}</span></div>
        {!session.current && <button className={styles.secondary} disabled={!isOnline || busy} onClick={() => setConfirm(session.id)}>Завершить</button>}
      </li>)}</ul>
      {access.sessions.some(s => !s.current) && <button className={styles.secondary} disabled={!isOnline || busy} onClick={() => setConfirm("others")}>Выйти на остальных устройствах</button>}
      <button className={styles.secondary} disabled={!isOnline || busy} onClick={() => setConfirm("logout")}>Выйти в этом браузере</button>
    </>}
    <TransientNotice message={error} kind="error" />
    {error && !access && <button className={styles.secondary} onClick={() => { setError(""); void refresh().catch(cause => setError(cause.message)); }}>Повторить загрузку способов входа</button>}
    <TransientNotice message={notice} kind="success" />
    <Dialog open={confirm !== null} onOpenChange={open => { if (!open && !busy) setConfirm(null); }}>
      <DialogContent className={styles.dialog}>
        <DialogHeader><DialogTitle>Завершить сеанс?</DialogTitle><DialogDescription>{confirm === "logout" ? "Для следующего входа понадобится привязанный ВК, почта или заранее сохранённый резервный код." : "На выбранных устройствах потребуется войти заново. Этот браузер останется подключён."}</DialogDescription></DialogHeader>
        <button className={styles.primary} disabled={busy} onClick={() => void remove()}>{busy ? "Завершаем…" : "Завершить"}</button>
        <button className={styles.secondary} disabled={busy} onClick={() => setConfirm(null)}>Остаться</button>
      </DialogContent>
    </Dialog>
  </section>;
}
