"use client";

import { useEffect, useState } from "react";
import { z } from "zod";
import Link from "next/link";
import { AccountEntry } from "./account-entry";
import { authRequest, logout } from "@/lib/auth-api";
import { getMe } from "@/lib/check-in-api";
import type { MeResponse } from "@/lib/check-in-contract";
import { MOBILE_CONNECT_STORAGE_KEY, mobileConnectPath, parseMobileConnect, verifiedMobileCallback, type MobileConnectAttempt } from "./mobile-connect-state";
import styles from "./mobile-connect.module.css";

export function MobileConnect() {
  const [attempt, setAttempt] = useState<MobileConnectAttempt | null>(null);
  const [me, setMe] = useState<MeResponse | null>(null);
  const [ready, setReady] = useState(false);
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [callback, setCallback] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const value = parseMobileConnect(window.location.search);
    if (value) {
      try { sessionStorage.setItem(MOBILE_CONNECT_STORAGE_KEY, JSON.stringify({ path: mobileConnectPath(value), at: Date.now() })); }
      catch { /* Email login can still complete in this page without redirect storage. */ }
    }
    void (async () => {
      if (active) setAttempt(value);
      try {
        const account = value ? await getMe() : null;
        if (active) { setMe(account); setChecked(true); }
      } catch { if (active) setError("Не удалось проверить вход. Обновите страницу и попробуйте ещё раз."); }
      finally { if (active) setReady(true); }
    })();
    return () => { active = false; };
  }, []);

  async function connect() {
    if (!attempt || !me || busy) return;
    setBusy(true); setError("");
    try {
      const response = await authRequest("mobile/authorize", z.object({ url: z.string() }), attempt);
      const target = verifiedMobileCallback(response.url, attempt.state);
      if (!target) throw new Error("Сервер вернул некорректное подтверждение. Начните вход заново из приложения.");
      try { sessionStorage.removeItem(MOBILE_CONNECT_STORAGE_KEY); } catch { /* No account secret is stored here. */ }
      setCallback(target);
      window.location.assign(target);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Не удалось подключить приложение."); }
    finally { setBusy(false); }
  }

  async function changeAccount() {
    setBusy(true); setError("");
    try { await logout(); setMe(null); }
    catch { setError("Не удалось выйти. Проверьте подключение и повторите попытку."); }
    finally { setBusy(false); }
  }

  return <main className={styles.page}><section className={styles.card}>
    <p className={styles.eyebrow}>Мохлик · Мобильное приложение</p>
    <h1>Вход на телефоне</h1>
    {!ready ? <p role="status">Проверяем ваш аккаунт…</p> : !attempt ? <>
      <p>Откройте Мохлика на телефоне и нажмите «Войти». Эта страница открывается из приложения.</p>
      <Link className={styles.secondary} href="/">Открыть веб-версию</Link>
    </> : !checked ? <>
      <p>Не удалось проверить аккаунт. Проверьте интернет и повторите загрузку.</p>
      <button className={styles.primary} onClick={() => window.location.reload()}>Повторить</button>
    </> : callback ? <>
      <p>Подтверждение готово. Вернитесь в приложение, чтобы завершить вход.</p>
      <a className={styles.primary} href={callback}>Вернуться в Мохлика</a>
      <p className={styles.hint}>Ссылка действует недолго. Если вход не завершился, начните его заново в приложении.</p>
    </> : me ? <>
      <p>Войти в приложение как <strong>{me.user.displayName}</strong>?</p>
      <p className={styles.hint}>На телефоне появятся этот профиль и его игровой прогресс. Устройство можно отключить в настройках аккаунта.</p>
      <button className={styles.primary} disabled={busy} onClick={() => void connect()}>{busy ? "Подключаем…" : "Войти в приложение"}</button>
      <button className={styles.secondary} disabled={busy} onClick={() => void changeAccount()}>Другой аккаунт</button>
    </> : <>
      <p>Войдите привычным способом. Затем подтвердите подключение приложения к вашему профилю.</p>
      <AccountEntry isOnline onAuthenticated={setMe} />
    </>}
    {error && <p className={styles.error} role="alert">{error}</p>}
  </section></main>;
}
