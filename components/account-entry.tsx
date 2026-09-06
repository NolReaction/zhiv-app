"use client";

import { useEffect, useId, useState, type ReactNode } from "react";
import { Mail, Send } from "lucide-react";
import { getAuthOptions, startAuth, verifyEmailLogin, authReturnMessage, type AuthOptions, type AuthIntent } from "@/lib/auth-api";
import { getMe } from "@/lib/check-in-api";
import { isValidDisplayName, limitDisplayNameInput, normalizeDisplayName } from "@/lib/check-in-presentation";
import type { MeResponse } from "@/lib/check-in-contract";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp";
import styles from "./account-access.module.css";

export function AuthReturnNotice() {
  const [message, setMessage] = useState("");
  useEffect(() => {
    const url = new URL(window.location.href);
    const result = url.searchParams.get("auth");
    if (!result) return;
    setMessage(authReturnMessage(result));
    url.searchParams.delete("auth");
    window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
  }, []);
  return message ? <p className={styles.notice} role="status">{message}</p> : null;
}

export function AccountEntry({ isOnline, onAuthenticated, children }: { isOnline: boolean; onAuthenticated: (me: MeResponse) => void; children?: ReactNode }) {
  const [options, setOptions] = useState<AuthOptions | null>(null);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    getAuthOptions().then(value => { if (active) { setOptions(value); setFailed(false); } }).catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [retry]);
  return <div className={styles.entry}>
    <AuthReturnNotice />
    {options ? (options.telegram || options.email ? <LoginForm options={options} isOnline={isOnline} onDone={async () => {
      const me = await getMe(); if (!me) throw new Error("Не удалось открыть профиль. Повторите вход."); onAuthenticated(me);
    }} /> : children) : failed ? <div role="alert"><p>Не удалось загрузить способы входа.</p><button className={styles.secondary} onClick={() => { setFailed(false); setRetry(value => value + 1); }}>Повторить</button></div> : <p role="status">Загружаем способы входа…</p>}
  </div>;
}

export function LoginForm({ options, isOnline, link = false, onDone }: { options: AuthOptions; isOnline: boolean; link?: boolean; onDone: () => Promise<void> }) {
  const id = useId();
  const [intent, setIntent] = useState<AuthIntent>(link ? "link" : "login");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [emailOpen, setEmailOpen] = useState(false);
  const [flow, setFlow] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const disabled = busy || !isOnline;

  async function begin(provider: "telegram" | "email") {
    if (intent === "register" && !isValidDisplayName(name)) { setError("Введите имя длиной до 50 символов"); return; }
    setBusy(true); setError("");
    try {
      const result = await startAuth(provider, intent, intent === "register" ? normalizeDisplayName(name) : undefined, provider === "email" ? email : undefined);
      if (provider === "telegram") {
        const url = new URL(result.url ?? "");
        if (url.origin !== "https://oauth.telegram.org" || url.pathname !== "/auth") throw new Error("Не удалось открыть вход через Telegram");
        window.location.assign(url.toString());
      } else { setFlow(result.flow); setCode(""); }
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Не удалось начать вход"); }
    finally { setBusy(false); }
  }

  async function verify(event: React.FormEvent) {
    event.preventDefault(); if (!flow) return;
    setBusy(true); setError("");
    try { await verifyEmailLogin(flow, code); await onDone(); setFlow(null); setCode(""); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Не удалось подтвердить код"); }
    finally { setBusy(false); }
  }

  return <div className={styles.entry} aria-busy={busy}>
    {!link && !flow && <div className={styles.mode}>
      <button type="button" className={styles.secondary} aria-pressed={intent === "login"} disabled={disabled} onClick={() => { setIntent("login"); setError(""); }}>Войти</button>
      <button type="button" className={styles.secondary} aria-pressed={intent === "register"} disabled={disabled} onClick={() => { setIntent("register"); setError(""); }}>Создать профиль</button>
    </div>}
    {intent === "register" && !flow && <>
      <p className={styles.hint}>Уже отмечались раньше? Выберите «Войти», чтобы сохранить своих людей и отметки.</p>
      <label htmlFor={`${id}-name`}>Как вас зовут?</label>
      <input id={`${id}-name`} className={styles.input} value={name} onChange={event => setName(limitDisplayNameInput(event.target.value))} autoComplete="name" placeholder="Например, Дима" disabled={disabled} />
    </>}
    {flow ? <form className={styles.entry} onSubmit={event => void verify(event)}>
      <label htmlFor={`${id}-otp`}>Код из письма</label>
      <p className={styles.hint}>Отправили на {email}. Введите код здесь — он действует 10 минут. Проверьте также папку «Спам».</p>
      <InputOTP id={`${id}-otp`} maxLength={6} pattern="^[0-9]*$" value={code} onChange={setCode} inputMode="numeric" autoComplete="one-time-code" disabled={disabled}>
        <InputOTPGroup>{Array.from({ length: 6 }, (_, index) => <InputOTPSlot className={styles.otpSlot} key={index} index={index} />)}</InputOTPGroup>
      </InputOTP>
      <button type="submit" className={styles.primary} disabled={disabled || code.length !== 6}>{busy ? "Проверяем…" : link ? "Привязать почту" : "Продолжить"}</button>
      <button type="button" className={styles.secondary} disabled={disabled} onClick={() => { setFlow(null); setCode(""); setError(""); }}>Другой адрес или новый код</button>
    </form> : <>
      {options.telegram && <button type="button" className={styles.primary} disabled={disabled} onClick={() => void begin("telegram")}><Send size={18} aria-hidden />{link ? "Привязать Telegram" : "Войти через Telegram"}</button>}
      {options.email && (emailOpen ? <form className={styles.entry} onSubmit={event => { event.preventDefault(); void begin("email"); }}>
        <label htmlFor={`${id}-email`}>Ваша почта</label>
        <input id={`${id}-email`} type="email" autoComplete="email" autoCapitalize="none" spellCheck={false} maxLength={254} required className={styles.input} value={email} onChange={event => setEmail(event.target.value)} disabled={disabled} />
        <button type="submit" className={styles.primary} disabled={disabled || !email.trim()}>{busy ? "Отправляем…" : "Получить код"}</button>
      </form> : <button type="button" className={styles.secondary} disabled={disabled} onClick={() => setEmailOpen(true)}><Mail size={18} aria-hidden />{link ? "Привязать почту" : "Войти по почте"}</button>)}
    </>}
    {!isOnline && <p className={styles.hint}>Для входа нужен интернет.</p>}
    {error && <p className={styles.error} role="alert">{error}</p>}
  </div>;
}
