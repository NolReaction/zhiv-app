"use client";

import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Mail, Merge, Trash2 } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp";
import { getMe, ApiError } from "@/lib/check-in-api";
import { createUuidV4 } from "@/lib/browser-uuid";
import type { MeResponse } from "@/lib/check-in-contract";
import type { AccountAccess, AuthOptions } from "@/lib/auth-api";
import {
  changeAccountEmail, confirmAccountMerge, currentAccountProved, deleteAccountProfile, emptyLifecycle,
  getAccountLifecycle, previewAccountMerge, startAccountProof, verifyAccountProof,
  type AccountAction, type AccountProofRole, type LifecycleState, type MergePreview, type ProfileSource, type ProviderChoices,
} from "@/lib/account-lifecycle";
import { TransientNotice } from "@/components/app-notifications";
import styles from "./account-access.module.css";

const actionLabels: Record<AccountAction, string> = { email: "Сменить почту", merge: "Объединить профили", delete: "Удалить профиль" };
const actionStorageKey = "zhiv:account-action";
function rememberAction(action: AccountAction | null) {
  try { if (action) sessionStorage.setItem(actionStorageKey, action); else sessionStorage.removeItem(actionStorageKey); } catch { /* Proofs remain on the server if storage is unavailable. */ }
}
function rememberedAction(): AccountAction | null {
  try { const value = sessionStorage.getItem(actionStorageKey); return value === "email" || value === "merge" || value === "delete" ? value : null; } catch { return null; }
}

function AccountProofForm({ action, role, methods, options, isOnline, onVerified }: {
  action: AccountAction; role: AccountProofRole; methods: AccountAccess["methods"]; options: AuthOptions; isOnline: boolean; onVerified: () => Promise<void>;
}) {
  const id = useId();
  const [email, setEmail] = useState("");
  const [flow, setFlow] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [verified, setVerified] = useState(false);
  const [error, setError] = useState("");
  const canVk = role !== "new-email" && options.vk && (role !== "current" || methods.some(method => method.provider === "vk"));
  const canEmail = options.email && (role !== "current" || methods.some(method => method.provider === "email"));
  const disabled = busy || !isOnline;

  async function begin(provider: "email" | "vk") {
    setBusy(true); setError("");
    try {
      rememberAction(action);
      const result = await startAccountProof(provider, action, role, provider === "email" ? email : undefined);
      if (provider === "vk") {
        const url = new URL(result.url ?? "");
        if (url.origin !== "https://id.vk.ru" || url.pathname !== "/authorize") throw new Error("Не удалось открыть подтверждение ВК");
        window.location.replace(url.toString());
      } else { setFlow(result.flow); setCode(""); setVerified(false); }
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Не удалось начать подтверждение"); }
    finally { setBusy(false); }
  }
  async function verify(event: FormEvent) {
    event.preventDefault(); if (!flow) return;
    setBusy(true); setError("");
    try {
      if (!verified) {
        await verifyAccountProof(flow, code);
        setVerified(true);
      }
      await onVerified();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Не удалось подтвердить доступ"); }
    finally { setBusy(false); }
  }
  return <div className={styles.entry} aria-busy={busy}>
    {flow ? <form className={styles.entry} onSubmit={event => void verify(event)}>
      <label htmlFor={`${id}-otp`}>Код из письма</label>
      <p className={styles.hint}>Отправили на {email}. Введите код в этом окне.</p>
      <InputOTP id={`${id}-otp`} maxLength={6} pattern="^[0-9]*$" value={code} onChange={setCode} inputMode="numeric" autoComplete="one-time-code" disabled={disabled || verified}>
        <InputOTPGroup>{Array.from({ length: 6 }, (_, index) => <InputOTPSlot className={styles.otpSlot} key={index} index={index} />)}</InputOTPGroup>
      </InputOTP>
      <button type="submit" className={styles.primary} disabled={disabled || (!verified && code.length !== 6)}>{busy ? "Проверяем…" : "Подтвердить"}</button>
      <button type="button" className={styles.textButton} disabled={disabled} onClick={() => { setFlow(null); setCode(""); setVerified(false); }}>Другой адрес или новый код</button>
    </form> : <>
      {canVk && <button type="button" className={styles.primary} disabled={disabled} onClick={() => void begin("vk")}>Подтвердить через ВК</button>}
      {canEmail && <form className={styles.entry} onSubmit={event => { event.preventDefault(); void begin("email"); }}>
        <label htmlFor={`${id}-email`}>{role === "new-email" ? "Новая почта" : role === "other" ? "Почта второго профиля" : "Почта текущего профиля"}</label>
        <input id={`${id}-email`} className={styles.input} type="email" required maxLength={254} autoComplete="email" autoCapitalize="none" spellCheck={false} disabled={disabled} value={email} onChange={event => setEmail(event.target.value)} />
        <button type="submit" className={styles.secondary} disabled={disabled || !email.trim()}>Получить код</button>
      </form>}
      {!canEmail && !canVk && <p className={styles.hint}>Подтверждение сейчас недоступно. Сначала привяжите доступный способ входа в профиле.</p>}
    </>}
    {!isOnline && <p className={styles.hint}>Для подтверждения нужен интернет.</p>}
    <TransientNotice message={error} kind="error" />
  </div>;
}

export function AccountLifecycle({ access, options, isOnline, onChanged, onDeleted }: {
  access: AccountAccess; options: AuthOptions; isOnline: boolean; onChanged: (me: MeResponse) => Promise<void>; onDeleted: () => void;
}) {
  const [action, setAction] = useState<AccountAction | null>(null);
  const [state, setState] = useState<LifecycleState>(emptyLifecycle);
  const [preview, setPreview] = useState<MergePreview | null>(null);
  const [previewCurrent, setPreviewCurrent] = useState(false);
  const [requestedRole, setRequestedRole] = useState<AccountProofRole | null>(null);
  const [displayNameSource, setDisplayNameSource] = useState<ProfileSource>("current");
  const [statusSource, setStatusSource] = useState<ProfileSource>("current");
  const [providerChoices, setProviderChoices] = useState<ProviderChoices>({});
  const [busy, setBusy] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const operationKey = useRef<string | null>(null);
  const refresh = useCallback(async () => { setState(await getAccountLifecycle()); }, []);

  useEffect(() => {
    const remembered = rememberedAction();
    if (!remembered) return;
    let active = true;
    void getAccountLifecycle().then(result => {
      if (active) { setState(result); setAction(remembered); }
    }).catch(cause => { if (active) setError(cause instanceof Error ? cause.message : "Не удалось продолжить действие"); });
    return () => { active = false; };
  }, []);

  async function open(next: AccountAction) {
    setBusy(true); setError(""); setNotice("");
    try {
      await refresh(); setAction(next); rememberAction(next); setPreview(null); setPreviewCurrent(false); setRequestedRole(null);
      setAccepted(false); setProviderChoices({}); setDisplayNameSource("current"); setStatusSource("current"); operationKey.current = null;
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Не удалось загрузить настройки"); }
    finally { setBusy(false); }
  }

  function close() { if (busy) return; setAction(null); rememberAction(null); setAccepted(false); setPreview(null); }
  async function prepareMerge() {
    setBusy(true); setError(""); setAccepted(false); setPreviewCurrent(false);
    try { setPreview(await previewAccountMerge(displayNameSource, statusSource, providerChoices)); setPreviewCurrent(true); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Не удалось проверить объединение"); await refresh().catch(() => {}); }
    finally { setBusy(false); }
  }

  async function confirm() {
    if (!action || !accepted || busy) return;
    setBusy(true); setError("");
    operationKey.current ??= createUuidV4();
    try {
      if (action === "delete") {
        await deleteAccountProfile(operationKey.current);
        rememberAction(null); onDeleted(); return;
      }
      if (action === "email") await changeAccountEmail(operationKey.current);
      else if (previewCurrent && preview && preview.conflicts.length === 0) await confirmAccountMerge(preview.preview);
      else return;
      const me = await getMe();
      if (!me) { rememberAction(null); onDeleted(); return; }
      await onChanged(me);
      setNotice(action === "email" ? "Почта изменена. Другие устройства нужно подключить заново." : "Профили объединены. Проверьте доступ к отметкам в разделе «Люди».");
      setAction(null); rememberAction(null); setPreview(null); operationKey.current = null;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось получить результат. Повторите проверку.");
      if (cause instanceof ApiError && cause.status < 500 && cause.status !== 429) {
        setAccepted(false); setPreview(null); operationKey.current = null;
        await refresh().catch(() => {});
      }
    } finally { setBusy(false); }
  }

  const currentProved = action ? currentAccountProved(state, action) : false;
  const role: AccountProofRole | null = !currentProved ? "current" : requestedRole ?? (action === "email" && !state.newEmail ? "new-email" : action === "merge" && !state.other ? "other" : null);
  const ready = currentProved && !role && (action !== "merge" || Boolean(previewCurrent && preview && preview.conflicts.length === 0));
  return <>
    <div className={styles.accountActions}>
      {options.email && access.methods.some(method => method.provider === "email") && <button type="button" className={styles.secondary} disabled={busy || !isOnline} onClick={() => void open("email")}><Mail size={18} aria-hidden />Сменить почту</button>}
      <button type="button" className={styles.secondary} disabled={busy || !isOnline} onClick={() => void open("merge")}><Merge size={18} aria-hidden />Объединить профили</button>
      <button type="button" className={`${styles.secondary} ${styles.danger}`} disabled={busy || !isOnline} onClick={() => void open("delete")}><Trash2 size={18} aria-hidden />Удалить профиль</button>
    </div>
    <TransientNotice message={error} kind="error" />
    <TransientNotice message={notice} />
    <Dialog open={action !== null} onOpenChange={open => { if (!open) close(); }}>
      <DialogContent className={`${styles.dialog} ${styles.lifecycleDialog}`}>
        <DialogHeader>
          <DialogTitle>{action ? actionLabels[action] : "Управление профилем"}</DialogTitle>
          <DialogDescription className={styles.hint}>{action === "merge" ? "Открытый профиль останется основным. Подтвердите доступ к обоим профилям и проверьте изменения перед объединением." : action === "email" ? "Подтвердите доступ к текущему профилю, затем новую почту." : "Удаление закрывает доступ к профилю на всех устройствах. Сначала подтвердите, что профиль принадлежит вам."}</DialogDescription>
        </DialogHeader>
        {action && role ? <div className={styles.entry}>
          <p className={styles.stepLabel}>{role === "current" ? "1. Подтвердите текущий профиль" : role === "other" ? "2. Подтвердите второй профиль" : "2. Подтвердите новую почту"}</p>
          {role === "other" && <p className={styles.hint}>Выберите ВК или почту, с которыми уже создан второй профиль. Новая регистрация здесь не выполняется.</p>}
          <AccountProofForm key={`${action}:${role}`} action={action} role={role} methods={access.methods} options={options} isOnline={isOnline} onVerified={async () => { operationKey.current = null; await refresh(); setRequestedRole(null); setPreview(null); setAccepted(false); }} />
        </div> : null}
        {action === "merge" && !role && currentProved && state.other && <div className={styles.entry}>
          <p className={styles.hint}>Второй профиль: <strong>{state.other.displayName}</strong> · {state.other.publicId}</p>
          <button type="button" className={styles.textButton} disabled={busy || !isOnline} onClick={() => { operationKey.current = null; setRequestedRole("other"); setPreview(null); setAccepted(false); }}>Выбрать другой профиль</button>
          <label className={styles.choiceLabel}>Имя после объединения
            <select className={styles.input} disabled={busy} value={displayNameSource} onChange={event => { setDisplayNameSource(event.target.value as ProfileSource); setPreview(null); setAccepted(false); }}>
              <option value="current">Из текущего профиля</option><option value="other">Из второго: {state.other.displayName}</option>
            </select>
          </label>
          <label className={styles.choiceLabel}>Статус после объединения
            <select className={styles.input} disabled={busy} value={statusSource} onChange={event => { setStatusSource(event.target.value as ProfileSource); setPreview(null); setAccepted(false); }}>
              <option value="current">Из текущего профиля</option><option value="other">Из второго профиля</option>
            </select>
          </label>
          {preview?.providerConflicts.map(conflict => <label className={styles.choiceLabel} key={conflict.provider}>Оставить способ входа: {conflict.provider === "vk" ? "ВК" : conflict.provider === "email" ? "почта" : "Telegram"}
            <select className={styles.input} disabled={busy} value={providerChoices[conflict.provider] ?? ""} onChange={event => { setProviderChoices(current => ({ ...current, [conflict.provider]: event.target.value as ProfileSource })); setAccepted(false); setPreviewCurrent(false); }}>
              <option value="" disabled>Выберите аккаунт</option><option value="current">Текущий · {conflict.current}</option><option value="other">Второй · {conflict.other}</option>
            </select>
          </label>)}
          <button type="button" className={styles.secondary} disabled={busy || !isOnline} onClick={() => void prepareMerge()}>{busy ? "Проверяем…" : "Проверить изменения"}</button>
          {preview && previewCurrent && <div className={styles.mergeSummary}>
            <p>Останется ID: <strong>{preview.current.publicId}</strong></p>
            <p>Имя: {preview.displayName}</p><p>Статус: {preview.status ?? "Без статуса"}</p>
            <ul>{preview.effects.map(effect => <li key={effect}>{effect}</li>)}</ul>
            {preview.conflicts.length > 0 && <ul className={styles.danger}>{preview.conflicts.map(conflict => <li key={conflict}>{conflict}</li>)}</ul>}
          </div>}
        </div>}
        {action === "email" && !role && currentProved && state.newEmail && <>
          <p className={styles.hint}>Новая почта: <strong>{state.newEmail}</strong>. Старый адрес перестанет подходить для входа. Другие сеансы, резервный код и прежние приглашения будут отозваны.</p>
          <button type="button" className={styles.textButton} disabled={busy || !isOnline} onClick={() => { operationKey.current = null; setRequestedRole("new-email"); setAccepted(false); }}>Указать другую почту</button>
        </>}
        {action === "delete" && currentProved && <p className={styles.hint}>Имя, статус и способы входа будут удалены, личные связи закрыты, ваши группы архивированы. Сеансы, приглашения и резервные коды перестанут работать. Обезличенные записи отметок и прав доступа сохраняются для целостности истории; вернуть профиль через вход будет нельзя.</p>}
        {ready && <>
          <label className={styles.confirmLabel}><input type="checkbox" checked={accepted} disabled={busy} onChange={event => setAccepted(event.target.checked)} />
            <span>{action === "delete" ? "Понимаю последствия и хочу удалить профиль" : action === "merge" ? "Проверил изменения и хочу объединить профили" : "Хочу заменить почту этим адресом"}</span>
          </label>
          <button type="button" className={`${styles.primary} ${action === "delete" ? styles.dangerButton : ""}`} disabled={!accepted || busy || !isOnline} onClick={() => void confirm()}>{busy ? "Выполняем…" : actionLabels[action!]}</button>
        </>}
        <button type="button" className={styles.textButton} disabled={busy} onClick={close}>Отмена</button>
      </DialogContent>
    </Dialog>
  </>;
}
