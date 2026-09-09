"use client";

import { useEffect, useId, useState, type ReactNode } from "react";
import { Mail } from "lucide-react";
import { getAuthOptions, startAuth, verifyEmailLogin, authReturnMessage, getRegistrationState, completeRegistration, cancelRegistration, type AuthOptions } from "@/lib/auth-api";
import { getMe } from "@/lib/check-in-api";
import { isValidDisplayName, limitDisplayNameInput, normalizeDisplayName } from "@/lib/check-in-presentation";
import type { MeResponse } from "@/lib/check-in-contract";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp";
import styles from "./account-access.module.css";
import { TransientNotice } from "@/components/app-notifications";

export function AuthReturnNotice() {
  const [message, setMessage] = useState("");
  useEffect(() => {
    const url = new URL(window.location.href);
    const result = url.searchParams.get("auth");
    if (!result) return;
    const timer = window.setTimeout(() => {
      setMessage(authReturnMessage(result));
      url.searchParams.delete("auth");
      window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);
  return <TransientNotice message={message} />;
}

export function AccountEntry({ isOnline, onAuthenticated, children }: { isOnline: boolean; onAuthenticated: (me: MeResponse) => void; children?: ReactNode }) {
  const [options, setOptions] = useState<AuthOptions | null>(null);
  const [failed, setFailed] = useState(false);
  const [pending, setPending] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    getAuthOptions().then(async value => {
      const registration = value.legacy ? { pending: false } : await getRegistrationState();
      if (active) { setOptions(value); setPending(registration.pending); setFailed(false); }
    }).catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [retry]);
  return <div className={`${styles.entry} ${styles.entryScreen}`}>
    <AuthReturnNotice />
    {options ? (options.legacy ? children : <LoginForm options={options} pending={pending} isOnline={isOnline} onDone={async () => {
      const me = await getMe(); if (!me) throw new Error("Не удалось открыть профиль. Повторите вход."); onAuthenticated(me);
    }} />) : failed ? <div role="alert"><p>Не удалось загрузить способы входа.</p><button className={styles.secondary} onClick={() => { setFailed(false); setRetry(value => value + 1); }}>Повторить</button></div> : <p role="status">Загружаем способы входа…</p>}
  </div>;
}

export function LoginForm({ options, isOnline, link = false, pending = false, onDone }: { options: AuthOptions; isOnline: boolean; link?: boolean; pending?: boolean; onDone: () => Promise<void> }) {
  const id = useId();
  const [needsName, setNeedsName] = useState(pending);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [emailOpen, setEmailOpen] = useState(false);
  const [flow, setFlow] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [verified, setVerified] = useState(false);
  const [registered, setRegistered] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const disabled = busy || !isOnline;

  async function begin(provider: "vk" | "email") {
    setBusy(true); setError("");
    try {
      const result = await startAuth(provider, link ? "link" : "login", provider === "email" ? email : undefined);
      if (provider === "vk") {
        const url = new URL(result.url ?? "");
        if (url.origin !== "https://id.vk.ru" || url.pathname !== "/authorize") throw new Error("Не удалось открыть вход через ВК");
        window.location.replace(url.toString());
      } else { setFlow(result.flow); setCode(""); setVerified(false); }
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Не удалось начать вход"); }
    finally { setBusy(false); }
  }

  async function verify(event: React.FormEvent) {
    event.preventDefault(); if (!flow) return;
    setBusy(true); setError("");
    try {
      if (!verified) {
        const result = await verifyEmailLogin(flow, code, link);
        if (result.status === "profile-required") { setNeedsName(true); setFlow(null); setCode(""); return; }
        setVerified(true);
      }
      await onDone(); setFlow(null); setCode(""); setVerified(false);
    }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Не удалось подтвердить код"); }
    finally { setBusy(false); }
  }

  async function finishProfile(event: React.FormEvent) {
    event.preventDefault();
    if (!registered && !isValidDisplayName(name)) { setError("Введите имя длиной до 50 символов"); return; }
    setBusy(true); setError("");
    try {
      if (!registered) { await completeRegistration(normalizeDisplayName(name)); setRegistered(true); }
      await onDone();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Не удалось открыть профиль"); }
    finally { setBusy(false); }
  }

  async function chooseAgain() {
    setBusy(true); setError("");
    try { await cancelRegistration(); setNeedsName(false); setName(""); setEmailOpen(false); setVerified(false); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Не удалось вернуться к входу"); }
    finally { setBusy(false); }
  }

  return <div className={styles.entry} aria-busy={busy}>
    {needsName ? <form className={styles.entry} onSubmit={event => void finishProfile(event)}>
      <label htmlFor={`${id}-name`}>Как вас зовут?</label>
      <p className={styles.hint}>Вход подтверждён. Осталось выбрать имя для нового профиля.</p>
      <input id={`${id}-name`} className={styles.input} value={name} onChange={event => setName(limitDisplayNameInput(event.target.value))} autoComplete="name" placeholder="Например, Дима" disabled={disabled || registered} />
      <button type="submit" className={styles.primary} disabled={disabled || (!registered && !isValidDisplayName(name))}>{busy ? "Открываем…" : registered ? "Открыть профиль" : "Продолжить"}</button>
      {!registered && <button type="button" className={styles.textButton} disabled={disabled} onClick={() => void chooseAgain()}>Другой способ входа</button>}
    </form> : flow ? <form className={styles.entry} onSubmit={event => void verify(event)}>
      <label htmlFor={`${id}-otp`}>Код из письма</label>
      <p className={styles.hint}>Отправили на {email}. Введите код здесь — он действует 10 минут. Проверьте также папку «Спам».</p>
      <InputOTP id={`${id}-otp`} maxLength={6} pattern="^[0-9]*$" value={code} onChange={setCode} inputMode="numeric" autoComplete="one-time-code" disabled={disabled}>
        <InputOTPGroup>{Array.from({ length: 6 }, (_, index) => <InputOTPSlot className={styles.otpSlot} key={index} index={index} />)}</InputOTPGroup>
      </InputOTP>
      <button type="submit" className={styles.primary} disabled={disabled || (!verified && code.length !== 6)}>{busy ? "Проверяем…" : link ? "Привязать почту" : "Продолжить"}</button>
      {!verified && <button type="button" className={styles.textButton} disabled={disabled} onClick={() => { setFlow(null); setCode(""); setError(""); }}>Другой адрес или новый код</button>}
    </form> : <>
      {options.vk && <button type="button" className={styles.primary} disabled={disabled} onClick={() => void begin("vk")}><span className={styles.vkMark} aria-hidden>VK</span>{link ? "Привязать ВК" : "Войти через ВК"}</button>}
      {options.email && (emailOpen ? <form className={styles.entry} onSubmit={event => { event.preventDefault(); void begin("email"); }}>
        <label htmlFor={`${id}-email`}>Ваша почта</label>
        <input id={`${id}-email`} type="email" autoComplete="email" autoCapitalize="none" spellCheck={false} maxLength={254} required className={styles.input} value={email} onChange={event => setEmail(event.target.value)} disabled={disabled} />
        <button type="submit" className={styles.primary} disabled={disabled || !email.trim()}>{busy ? "Отправляем…" : "Получить код"}</button>
        <button type="button" className={styles.textButton} disabled={disabled} onClick={() => setEmailOpen(false)}>Назад</button>
      </form> : <button type="button" className={styles.secondary} disabled={disabled} onClick={() => setEmailOpen(true)}><Mail size={18} aria-hidden />{link ? "Привязать почту" : "Войти через почту"}</button>)}
      {!link && !options.vk && !options.email && <p className={styles.hint}>Вход временно недоступен. Попробуйте позже.</p>}
    </>}
    {!isOnline && <p className={styles.hint}>Для входа нужен интернет.</p>}
    <TransientNotice message={error} kind="error" />
  </div>;
}
